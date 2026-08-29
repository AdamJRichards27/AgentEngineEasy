import { eq, and, desc } from "drizzle-orm";
import { db, paymentMethods, serviceOrders, payments, properties } from "@aee/db";
import type { PaymentMethod, ServiceOrder, Payment } from "@aee/db";
import { createPaymentProvider, type PaymentWebhookResult } from "@aee/integration-payments";

const paymentProvider = createPaymentProvider();

/**
 * Attaches an already-tokenized stored payment method (Phase 6). Real card
 * capture happens client-side via Stripe Elements/PaymentSheet — this only
 * ever receives the resulting customer/payment-method references, never raw
 * card data. Setting isDefault clears any other default for the same payer
 * so "the" default is always unambiguous.
 */
export async function addPaymentMethod(input: {
  payerType: "Agent" | "Brokerage";
  payerId: number;
  providerCustomerRef: string;
  providerPaymentMethodRef: string;
  label?: string;
  isDefault?: boolean;
}): Promise<PaymentMethod> {
  const providerName = process.env.PAYMENT_PROVIDER ?? "mock";

  const existing = await db
    .select()
    .from(paymentMethods)
    .where(and(eq(paymentMethods.payerType, input.payerType), eq(paymentMethods.payerId, input.payerId), eq(paymentMethods.isActive, true)));

  const makeDefault = input.isDefault ?? existing.length === 0; // first method for a payer defaults automatically

  if (makeDefault && existing.length > 0) {
    await db
      .update(paymentMethods)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(eq(paymentMethods.payerType, input.payerType), eq(paymentMethods.payerId, input.payerId)));
  }

  const [created] = await db
    .insert(paymentMethods)
    .values({
      payerType: input.payerType,
      payerId: input.payerId,
      provider: providerName,
      providerCustomerRef: input.providerCustomerRef,
      providerPaymentMethodRef: input.providerPaymentMethodRef,
      label: input.label,
      isDefault: makeDefault,
      isActive: true,
    })
    .returning();
  return created;
}

export async function listPaymentMethods(payerType: "Agent" | "Brokerage", payerId: number): Promise<PaymentMethod[]> {
  return db
    .select()
    .from(paymentMethods)
    .where(and(eq(paymentMethods.payerType, payerType), eq(paymentMethods.payerId, payerId), eq(paymentMethods.isActive, true)));
}

/** Soft-delete — payments keep referencing the row (see schema comment). */
export async function deactivatePaymentMethod(id: number): Promise<PaymentMethod | null> {
  const [updated] = await db
    .update(paymentMethods)
    .set({ isActive: false, isDefault: false, updatedAt: new Date() })
    .where(eq(paymentMethods.id, id))
    .returning();
  return updated ?? null;
}

async function defaultPaymentMethodFor(payerType: "Agent" | "Brokerage", payerId: number): Promise<PaymentMethod | null> {
  const [pm] = await db
    .select()
    .from(paymentMethods)
    .where(
      and(
        eq(paymentMethods.payerType, payerType),
        eq(paymentMethods.payerId, payerId),
        eq(paymentMethods.isActive, true),
        eq(paymentMethods.isDefault, true),
      ),
    );
  return pm ?? null;
}

export interface ChargeServiceOrderResult {
  payment: Payment;
  serviceOrder: ServiceOrder;
  created: boolean;
}

/**
 * Idempotent chokepoint for actually charging a ServiceOrder (Build Brief
 * §21 — "repeated button clicks must never charge twice"). Mirrors the
 * initiateAmlIfNeeded/sendPackageForSignature pattern: an existing
 * Succeeded or still-Pending payment for this ServiceOrder is returned
 * as-is rather than charging again. A prior Failed attempt does NOT block a
 * new one — that's a deliberate difference from "never twice", since a
 * declined card must be retryable, not a decision that once-failed always
 * stays failed. Each attempt gets its own idempotencyKey
 * (`service-order-charge:<id>:<attempt>`) so distinct attempts are never
 * conflated at the provider level either.
 *
 * The Payment row is inserted as "Pending" *before* calling the provider —
 * if the process crashes between the provider call succeeding and this
 * function returning, the Pending row is still a durable record that a
 * charge may have gone through, rather than nothing at all.
 */
export async function chargeServiceOrder(input: {
  serviceOrderId: number;
  userId: number;
}): Promise<ChargeServiceOrderResult> {
  const [serviceOrder] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, input.serviceOrderId));
  if (!serviceOrder) {
    throw new Error(`ServiceOrder ${input.serviceOrderId} not found`);
  }

  const existingAttempts = await db
    .select()
    .from(payments)
    .where(eq(payments.serviceOrderId, input.serviceOrderId))
    .orderBy(desc(payments.id));

  const settled = existingAttempts.find((p) => p.status === "Succeeded" || p.status === "Pending");
  if (settled) {
    return { payment: settled, serviceOrder, created: false };
  }

  const [property] = await db.select().from(properties).where(eq(properties.id, serviceOrder.propertyId));
  if (!property) {
    throw new Error(`Property ${serviceOrder.propertyId} not found`);
  }

  // Payer resolution (Section 12): the listing agent's own stored method is
  // the default payer for a property's service charges. Team/brokerage
  // billing arrangements are real future scope (paymentMethods.payerType
  // already models Brokerage/Team/etc. for that), not built here.
  const paymentMethod = await defaultPaymentMethodFor("Agent", property.agentId);
  if (!paymentMethod) {
    throw new Error("No default payment method on file for this agent. Add one before charging.");
  }

  const attemptNumber = existingAttempts.length + 1;
  const idempotencyKey = `service-order-charge:${serviceOrder.id}:${attemptNumber}`;
  const amountCents = serviceOrder.customerPriceCents + serviceOrder.gstCents;

  const [pendingPayment] = await db
    .insert(payments)
    .values({
      serviceOrderId: serviceOrder.id,
      paymentMethodId: paymentMethod.id,
      provider: paymentMethod.provider,
      amountCents,
      status: "Pending",
      idempotencyKey,
      metadata: { attempt: attemptNumber },
    })
    .returning();

  try {
    const result = await paymentProvider.chargeStoredMethod({
      paymentMethodProviderRef: paymentMethod.providerPaymentMethodRef,
      providerCustomerRef: paymentMethod.providerCustomerRef,
      amountCents,
      currency: "AUD",
      idempotencyKey,
      description: `${serviceOrder.serviceType} — Property #${serviceOrder.propertyId}`,
    });

    const [updatedPayment] = await db
      .update(payments)
      .set({
        status: result.status,
        providerChargeRef: result.providerChargeRef,
        receiptUrl: result.receiptUrl ?? null,
        failureReason: result.failureReason ?? null,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, pendingPayment.id))
      .returning();

    const [updatedServiceOrder] = await db
      .update(serviceOrders)
      .set({ paymentStatus: result.status === "Succeeded" ? "Charged" : "Failed" })
      .where(eq(serviceOrders.id, serviceOrder.id))
      .returning();

    return { payment: updatedPayment, serviceOrder: updatedServiceOrder, created: true };
  } catch (err) {
    const [failedPayment] = await db
      .update(payments)
      .set({ status: "Failed", failureReason: (err as Error).message, updatedAt: new Date() })
      .where(eq(payments.id, pendingPayment.id))
      .returning();

    const [updatedServiceOrder] = await db
      .update(serviceOrders)
      .set({ paymentStatus: "Failed" })
      .where(eq(serviceOrders.id, serviceOrder.id))
      .returning();

    return { payment: failedPayment, serviceOrder: updatedServiceOrder, created: true };
  }
}

export interface ProcessPaymentWebhookResult {
  processed: boolean;
  reason?: "invalid_signature" | "payment_not_found" | "duplicate_delivery";
  payment?: Payment;
}

/**
 * Payment webhook processing (Phase 6) — same outcome-aware idempotency
 * shape as lib/aml.ts's processAmlWebhook and lib/documents.ts's
 * processEsignWebhook: a redelivery of the exact same status is skipped, a
 * real transition (e.g. a later async confirmation, or a refund) still
 * processes. Exists because a synchronous chargeStoredMethod() response
 * isn't the only way a real charge's final state is known — Stripe (and
 * most processors) can resolve or update a charge asynchronously.
 */
export async function processPaymentWebhook(
  rawBody: Buffer | string,
  signature: string,
  payload: unknown,
): Promise<ProcessPaymentWebhookResult> {
  if (!paymentProvider.verifyWebhookSignature(rawBody, signature)) {
    return { processed: false, reason: "invalid_signature" };
  }

  const result: PaymentWebhookResult = paymentProvider.parseWebhook(payload);

  const [payment] = await db.select().from(payments).where(eq(payments.providerChargeRef, result.providerChargeRef));
  if (!payment) {
    return { processed: false, reason: "payment_not_found" };
  }

  if (payment.status === result.status) {
    return { processed: false, reason: "duplicate_delivery", payment };
  }

  const [updated] = await db
    .update(payments)
    .set({
      status: result.status,
      receiptUrl: result.receiptUrl ?? payment.receiptUrl,
      failureReason: result.failureReason ?? payment.failureReason,
      updatedAt: new Date(),
    })
    .where(eq(payments.id, payment.id))
    .returning();

  const paymentStatusMap: Record<PaymentWebhookResult["status"], string> = {
    Succeeded: "Charged",
    Failed: "Failed",
    Refunded: "Refunded",
  };
  await db
    .update(serviceOrders)
    .set({ paymentStatus: paymentStatusMap[result.status] })
    .where(eq(serviceOrders.id, updated.serviceOrderId));

  return { processed: true, payment: updated };
}

/**
 * Refund (Phase 6 "receipts" scope naturally implies the reverse action
 * exists too) — role-gated at the route layer to Brokerage Administrators,
 * matching the AML exception-resolution precedent for anything that reverses
 * a recorded financial/compliance outcome.
 */
export async function refundPayment(input: { paymentId: number; amountCents?: number }): Promise<Payment> {
  const [payment] = await db.select().from(payments).where(eq(payments.id, input.paymentId));
  if (!payment) {
    throw new Error(`Payment ${input.paymentId} not found`);
  }
  if (payment.status !== "Succeeded") {
    throw new Error(`Payment ${input.paymentId} is not in a refundable state (status: ${payment.status})`);
  }
  if (!payment.providerChargeRef) {
    throw new Error(`Payment ${input.paymentId} has no provider charge reference to refund`);
  }

  const refundAmount = input.amountCents ?? payment.amountCents;
  await paymentProvider.refund(payment.providerChargeRef, refundAmount);

  const [updated] = await db
    .update(payments)
    .set({ status: "Refunded", updatedAt: new Date() })
    .where(eq(payments.id, payment.id))
    .returning();

  await db.update(serviceOrders).set({ paymentStatus: "Refunded" }).where(eq(serviceOrders.id, payment.serviceOrderId));

  return updated;
}

export async function listPaymentsForServiceOrder(serviceOrderId: number): Promise<Payment[]> {
  return db.select().from(payments).where(eq(payments.serviceOrderId, serviceOrderId)).orderBy(desc(payments.id));
}
