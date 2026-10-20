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

/**
 * Tenant chokepoint for ServiceOrder loads — every ServiceOrder lookup by
 * raw numeric id in this file funnels through here rather than querying
 * `serviceOrders` directly, matching the assertTenantAndLoad /
 * loadLaunchPlanInBrokerage precedent (lib/exceptions/model.ts,
 * lib/launch/model.ts). serviceOrders itself carries no brokerageId column
 * (see packages/db/src/schema/commerce.ts), so tenancy is derived via its
 * propertyId -> properties.brokerageId, joined in the SAME query as the id
 * lookup — never a separate post-fetch check, so there is no window where a
 * row is read before its tenant is known. Returns null identically whether
 * the id doesn't exist at all or belongs to another brokerage — callers
 * must never be able to distinguish the two.
 */
async function selectServiceOrderInBrokerage(serviceOrderId: number, brokerageId: number): Promise<ServiceOrder | null> {
  const [row] = await db
    .select({ serviceOrder: serviceOrders })
    .from(serviceOrders)
    .innerJoin(properties, eq(properties.id, serviceOrders.propertyId))
    .where(and(eq(serviceOrders.id, serviceOrderId), eq(properties.brokerageId, brokerageId)));
  return row?.serviceOrder ?? null;
}

/**
 * Read-only tenant-scoped ServiceOrder fetch — backs GET
 * /service-orders/:id. Exported (rather than kept module-private like
 * selectServiceOrderInBrokerage) because the route itself owns the
 * not-found -> 404 translation, same shape as every other "load in
 * brokerage" read in this app.
 */
export async function getServiceOrderForBrokerage(serviceOrderId: number, brokerageId: number): Promise<ServiceOrder | null> {
  return selectServiceOrderInBrokerage(serviceOrderId, brokerageId);
}

/**
 * Tenant chokepoint for Payment loads — mirrors
 * selectServiceOrderInBrokerage above, one join further out: payments has
 * no brokerageId of its own either, so tenancy is derived via
 * payments.serviceOrderId -> serviceOrders.propertyId ->
 * properties.brokerageId, all in the one query.
 */
async function selectPaymentInBrokerage(paymentId: number, brokerageId: number): Promise<Payment | null> {
  const [row] = await db
    .select({ payment: payments })
    .from(payments)
    .innerJoin(serviceOrders, eq(serviceOrders.id, payments.serviceOrderId))
    .innerJoin(properties, eq(properties.id, serviceOrders.propertyId))
    .where(and(eq(payments.id, paymentId), eq(properties.brokerageId, brokerageId)));
  return row?.payment ?? null;
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
 *
 * brokerageId is the authenticated caller's OWN brokerage (never a
 * client-supplied tenant id — see routes/payments.ts) and scopes the
 * ServiceOrder load below so brokerage B can never charge, by guessing or
 * incrementing a serviceOrderId, a stored payment method belonging to
 * brokerage A.
 */
// S-1b: stable, client-safe codes for chargeServiceOrder failures. The route maps
// each to a status and an agent-facing sentence (routes/payments.ts chargeErrorResponse);
// internal detail (ids, driver text) stays server-side.
export type ServiceOrderChargeErrorCode = "SERVICE_ORDER_NOT_FOUND" | "SERVICE_ORDER_PROPERTY_MISSING" | "PAYMENT_METHOD_REQUIRED";
export class ServiceOrderChargeError extends Error {
  constructor(public readonly code: ServiceOrderChargeErrorCode, detail?: string) {
    super(detail ?? code);
    this.name = "ServiceOrderChargeError";
  }
}

export async function chargeServiceOrder(input: {
  serviceOrderId: number;
  userId: number;
  brokerageId: number;
}): Promise<ChargeServiceOrderResult> {
  const serviceOrder = await selectServiceOrderInBrokerage(input.serviceOrderId, input.brokerageId);
  if (!serviceOrder) {
    throw new ServiceOrderChargeError("SERVICE_ORDER_NOT_FOUND", `ServiceOrder ${input.serviceOrderId} not found`);
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
    throw new ServiceOrderChargeError("SERVICE_ORDER_PROPERTY_MISSING", `Property ${serviceOrder.propertyId} not found`);
  }

  // Payer resolution (Section 12): the listing agent's own stored method is
  // the default payer for a property's service charges. Team/brokerage
  // billing arrangements are real future scope (paymentMethods.payerType
  // already models Brokerage/Team/etc. for that), not built here.
  const paymentMethod = await defaultPaymentMethodFor("Agent", property.agentId);
  if (!paymentMethod) {
    throw new ServiceOrderChargeError("PAYMENT_METHOD_REQUIRED");
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
 *
 * brokerageId is the authenticated caller's OWN brokerage, scoping the
 * Payment load below (selectPaymentInBrokerage) so a Brokerage
 * Administrator can never refund another brokerage's payment by guessing or
 * incrementing a paymentId.
 */
// S-1c: stable, client-safe codes for refundPayment failures (mapped in routes/payments.ts refundErrorResponse).
export type PaymentRefundErrorCode = "PAYMENT_NOT_FOUND" | "PAYMENT_NOT_REFUNDABLE" | "PAYMENT_NO_CHARGE_REFERENCE";
export class PaymentRefundError extends Error {
  constructor(public readonly code: PaymentRefundErrorCode, detail?: string) {
    super(detail ?? code);
    this.name = "PaymentRefundError";
  }
}

export async function refundPayment(input: { paymentId: number; amountCents?: number; brokerageId: number }): Promise<Payment> {
  const payment = await selectPaymentInBrokerage(input.paymentId, input.brokerageId);
  if (!payment) {
    throw new PaymentRefundError("PAYMENT_NOT_FOUND", `Payment ${input.paymentId} not found`);
  }
  if (payment.status !== "Succeeded") {
    throw new PaymentRefundError("PAYMENT_NOT_REFUNDABLE", `Payment ${input.paymentId} is not in a refundable state (status: ${payment.status})`);
  }
  if (!payment.providerChargeRef) {
    throw new PaymentRefundError("PAYMENT_NO_CHARGE_REFERENCE", `Payment ${input.paymentId} has no provider charge reference to refund`);
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

/**
 * brokerageId scopes the join back through serviceOrders -> properties (see
 * selectPaymentInBrokerage above), so brokerage B listing payments for
 * brokerage A's serviceOrderId gets the same empty list it would for a
 * serviceOrderId that doesn't exist at all — never a peek at another
 * brokerage's payment rows.
 */
export async function listPaymentsForServiceOrder(serviceOrderId: number, brokerageId: number): Promise<Payment[]> {
  const rows = await db
    .select({ payment: payments })
    .from(payments)
    .innerJoin(serviceOrders, eq(serviceOrders.id, payments.serviceOrderId))
    .innerJoin(properties, eq(properties.id, serviceOrders.propertyId))
    .where(and(eq(payments.serviceOrderId, serviceOrderId), eq(properties.brokerageId, brokerageId)))
    .orderBy(desc(payments.id));
  return rows.map((r) => r.payment);
}
