import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, paymentMethods } from "@aee/db";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import { logAudit } from "../lib/audit.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { logger } from "@aee/events";
import {
  addPaymentMethod,
  listPaymentMethods,
  deactivatePaymentMethod,
  chargeServiceOrder,
  processPaymentWebhook,
  refundPayment,
  listPaymentsForServiceOrder,
  getServiceOrderForBrokerage,
  ServiceOrderChargeError,
  PaymentRefundError,
  type PaymentRefundErrorCode,
  type ServiceOrderChargeErrorCode,
} from "../lib/payments.js";

// Phase 6 (ARCHITECTURE.md §10): stored payment methods, ServiceOrder
// charging, receipts, idempotency. The ServiceOrder rows themselves are
// created by lib/aml.ts (and, later, other paid-service flows) — this
// router is what actually charges a stored payment method against them.
export const paymentsRouter = Router();

// S-1 (transaction-services spec): service orders are a Run surface; checked after auth, before any id lookup.
const requiresRunAccess = requireEntitlement("run.access");

const addPaymentMethodSchema = z.object({
  scope: z.enum(["Mine", "Brokerage"]).default("Mine"),
  providerCustomerRef: z.string().min(1),
  providerPaymentMethodRef: z.string().min(1),
  label: z.string().optional(),
  isDefault: z.boolean().optional(),
});

// Never trust a client-supplied payerId — an Agent can only ever attach a
// method to their own record; a Brokerage-scoped method requires Brokerage
// Administrator and is scoped to the caller's own brokerage. This prevents
// one agent from attaching (or worse, viewing) another agent's stored card.
paymentsRouter.post("/payment-methods", requireAuth, async (req, res) => {
  const parsed = addPaymentMethodSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;

  if (parsed.data.scope === "Brokerage" && user.role !== "Brokerage Administrator") {
    res.status(403).json({ error: "Only a Brokerage Administrator can add a brokerage-level payment method." });
    return;
  }

  const payerType = parsed.data.scope === "Brokerage" ? "Brokerage" : "Agent";
  const payerId = parsed.data.scope === "Brokerage" ? user.brokerageId : user.id;

  const method = await addPaymentMethod({
    payerType,
    payerId,
    providerCustomerRef: parsed.data.providerCustomerRef,
    providerPaymentMethodRef: parsed.data.providerPaymentMethodRef,
    label: parsed.data.label,
    isDefault: parsed.data.isDefault,
  });

  await logAudit({
    userId: user.id,
    action: "payment_method_added",
    recordType: "payment_method",
    recordId: String(method.id),
  });

  res.status(201).json({ paymentMethod: method });
});

// Returns both the caller's own methods and their brokerage's — the agent
// needs to see both to know what a ServiceOrder will actually charge
// (lib/payments.ts currently always resolves to the agent's own default;
// brokerage-level charging is modelled in the schema for later use).
paymentsRouter.get("/payment-methods", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const [mine, brokerage] = await Promise.all([
    listPaymentMethods("Agent", user.id),
    listPaymentMethods("Brokerage", user.brokerageId),
  ]);
  res.json({ mine, brokerage });
});

paymentsRouter.delete("/payment-methods/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;

  const [method] = await db.select().from(paymentMethods).where(eq(paymentMethods.id, id));
  if (!method) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const ownsAsAgent = method.payerType === "Agent" && method.payerId === user.id;
  const ownsAsBrokerageAdmin =
    method.payerType === "Brokerage" && method.payerId === user.brokerageId && user.role === "Brokerage Administrator";
  if (!ownsAsAgent && !ownsAsBrokerageAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const updated = await deactivatePaymentMethod(id);
  await logAudit({
    userId: user.id,
    action: "payment_method_removed",
    recordType: "payment_method",
    recordId: String(id),
  });
  res.json({ paymentMethod: updated });
});

// S-1b: stable { error, code } for charge failures (same shape as other routes' `code`).
const CHARGE_ERRORS: Record<ServiceOrderChargeErrorCode, { status: number; error: string }> = {
  SERVICE_ORDER_NOT_FOUND: { status: 404, error: "Not found" },
  SERVICE_ORDER_PROPERTY_MISSING: { status: 409, error: "This service order can't be charged because its property record is unavailable." },
  PAYMENT_METHOD_REQUIRED: { status: 409, error: "No default payment method on file for this agent. Add one before charging." },
};
export function chargeErrorResponse(err: unknown): { status: number; body: { error: string; code: string } } {
  if (err instanceof ServiceOrderChargeError && err.code in CHARGE_ERRORS) {
    const m = CHARGE_ERRORS[err.code];
    return { status: m.status, body: { error: m.error, code: err.code } };
  }
  return { status: 500, body: { error: "Charge failed", code: "SERVICE_ORDER_CHARGE_FAILED" } };
}

// Actually charges the default stored method for the ServiceOrder's
// property agent — idempotent (see lib/payments.ts chargeServiceOrder).
paymentsRouter.post("/service-orders/:id/charge", requireAuth, requiresRunAccess, async (req, res) => {
  const serviceOrderId = Number(req.params.id);
  const user = req.authedUser!;
  try {
    const { payment, serviceOrder, created } = await chargeServiceOrder({ serviceOrderId, userId: user.id, brokerageId: user.brokerageId });
    await logAudit({
      userId: user.id,
      action: "service_order_charged",
      recordType: "service_order",
      recordId: String(serviceOrderId),
      propertyId: serviceOrder.propertyId,
      providerReference: payment.providerChargeRef ?? undefined,
    });
    res.status(created ? 201 : 200).json({ payment, serviceOrder, created });
  } catch (err) {
    const mapped = chargeErrorResponse(err);
    if (mapped.status >= 500) logger.error("service_order_charge_failed", { serviceOrderId, error: err instanceof Error ? err.message : String(err) });
    res.status(mapped.status).json(mapped.body);
  }
});

paymentsRouter.get("/service-orders/:id/payments", requireAuth, requiresRunAccess, async (req, res) => {
  const serviceOrderId = Number(req.params.id);
  const user = req.authedUser!;
  const rows = await listPaymentsForServiceOrder(serviceOrderId, user.brokerageId);
  res.json({ payments: rows });
});

// Provider webhook — same shape as POST /aml/webhook and POST
// /documents/webhook: unauthenticated, authenticity comes from the HMAC
// signature verified against req.rawBody (captured by app.ts).
paymentsRouter.post("/webhook", async (req, res) => {
  const signature = String(req.header("stripe-signature") ?? req.header("x-webhook-signature") ?? "");
  const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));

  const result = await processPaymentWebhook(rawBody, signature, req.body);

  if (result.reason === "invalid_signature") {
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }
  if (result.reason === "payment_not_found") {
    res.status(200).json({ received: true, processed: false, reason: result.reason });
    return;
  }

  res.status(200).json({ received: true, processed: result.processed, reason: result.reason });
});

// S-1c: stable { error, code } for refund failures.
const REFUND_ERRORS: Record<PaymentRefundErrorCode, { status: number; error: string }> = {
  PAYMENT_NOT_FOUND: { status: 404, error: "Not found" },
  PAYMENT_NOT_REFUNDABLE: { status: 409, error: "This payment can't be refunded because it isn't a completed charge." },
  PAYMENT_NO_CHARGE_REFERENCE: { status: 409, error: "This payment can't be refunded because it has no provider charge on record." },
  REFUND_AMOUNT_INVALID: { status: 400, error: "Refund amount must be a positive whole number of cents." },
  REFUND_AMOUNT_EXCEEDS_REMAINING: { status: 409, error: "Refund amount is more than the amount left to refund on this payment." },
};
export function refundErrorResponse(err: unknown): { status: number; body: { error: string; code: string } } {
  if (err instanceof PaymentRefundError && err.code in REFUND_ERRORS) {
    const m = REFUND_ERRORS[err.code];
    return { status: m.status, body: { error: m.error, code: err.code } };
  }
  return { status: 500, body: { error: "Refund failed", code: "PAYMENT_REFUND_FAILED" } };
}

// Refund — restricted to Brokerage Administrators, matching the AML
// exception-resolution precedent for anything that reverses a recorded
// financial outcome.
paymentsRouter.post("/:paymentId/refund", requireAuth, requiresRunAccess, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const paymentId = Number(req.params.paymentId);
  // S-1d: passed through raw; refundPayment validates it (strings are rejected, no longer silently ignored).
  const amountCents: unknown = req.body?.amountCents;
  const user = req.authedUser!;
  try {
    const payment = await refundPayment({ paymentId, amountCents, brokerageId: user.brokerageId });
    await logAudit({
      userId: user.id,
      action: "payment_refunded",
      recordType: "payment",
      recordId: String(paymentId),
      providerReference: payment.providerChargeRef ?? undefined,
    });
    res.json({ payment });
  } catch (err) {
    const mapped = refundErrorResponse(err);
    if (mapped.status >= 500) logger.error("payment_refund_failed", { paymentId, error: err instanceof Error ? err.message : String(err) });
    res.status(mapped.status).json(mapped.body);
  }
});

// Read-only, mirrors GET /aml/service-orders/by-property/:propertyId's
// shape for a single order (used by the workspace to refresh one row after
// charging without refetching the whole property's list).
paymentsRouter.get("/service-orders/:id", requireAuth, requiresRunAccess, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  const serviceOrder = await getServiceOrderForBrokerage(id, user.brokerageId);
  if (!serviceOrder) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ serviceOrder });
});
