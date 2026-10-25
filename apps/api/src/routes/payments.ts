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
import {
  collectPitCrewServiceFee,
  settlementStatementGateFor,
  verifyServiceFeeCollection,
  ServiceFeeCollectionError,
  SERVICE_FEE_ERROR_STATUS,
} from "../lib/pitCrewServiceFee.js";
import { listRefundsForPayment, resolveRefundManually } from "../lib/paymentRefunds.js";

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
  SERVICE_ORDER_CHARGE_FORBIDDEN: {
    status: 403,
    error: "Only the listing agent or a Brokerage Administrator can charge this service order.",
  },
};
export function chargeErrorResponse(err: unknown): { status: number; body: { error: string; code: string } } {
  if (err instanceof ServiceOrderChargeError && err.code in CHARGE_ERRORS) {
    const m = CHARGE_ERRORS[err.code];
    return { status: m.status, body: { error: m.error, code: err.code } };
  }
  return { status: 500, body: { error: "Charge failed", code: "SERVICE_ORDER_CHARGE_FAILED" } };
}

// Owner t174u(4) (CC #37): every charge attempt is audited — allowed, denied
// or failed — with the caller, their role, the outcome code and the amount.
// Never card data: no payment-method/customer provider refs, labels or
// last-4; the only provider value recorded is the charge reference on success.
function chargeAttemptValue(fields: Record<string, string | number | boolean | null | undefined>): string {
  return JSON.stringify(fields);
}

// Charges the default stored method for the ServiceOrder's property listing
// agent — idempotent (see lib/payments.ts chargeServiceOrder). Restricted to
// that listing agent or a same-brokerage Brokerage Administrator.
paymentsRouter.post("/service-orders/:id/charge", requireAuth, requiresRunAccess, async (req, res) => {
  const serviceOrderId = Number(req.params.id);
  const user = req.authedUser!;
  try {
    const { payment, serviceOrder, created } = await chargeServiceOrder({
      serviceOrderId,
      userId: user.id,
      role: user.role,
      brokerageId: user.brokerageId,
    });
    await logAudit({
      brokerageId: user.brokerageId,
      userId: user.id,
      action: "service_order_charged",
      recordType: "service_order",
      recordId: String(serviceOrderId),
      propertyId: serviceOrder.propertyId,
      providerReference: payment.providerChargeRef ?? undefined,
      updatedValue: chargeAttemptValue({
        outcome: created ? "charged" : "already_settled",
        callerRole: user.role,
        paymentId: payment.id,
        paymentStatus: payment.status,
        amountCents: payment.amountCents,
      }),
    });
    res.status(created ? 201 : 200).json({ payment, serviceOrder, created });
  } catch (err) {
    const mapped = chargeErrorResponse(err);
    if (mapped.status >= 500) logger.error("service_order_charge_failed", { serviceOrderId, error: err instanceof Error ? err.message : String(err) });
    const denied = mapped.status === 403 || mapped.status === 404;
    await logAudit({
      brokerageId: user.brokerageId,
      userId: user.id,
      action: denied ? "service_order_charge_denied" : "service_order_charge_failed",
      recordType: "service_order",
      recordId: Number.isFinite(serviceOrderId) ? String(serviceOrderId) : String(req.params.id).slice(0, 64),
      propertyId: err instanceof ServiceOrderChargeError ? (err.propertyId ?? null) : null,
      updatedValue: chargeAttemptValue({ outcome: denied ? "denied" : "failed", callerRole: user.role, code: mapped.body.code }),
    });
    res.status(mapped.status).json(mapped.body);
  }
});

// Owner t177u(1) (CC #37): AE Pit Crew service-fee collection after verified
// settlement. Assigned Pit Crew (and Brokerage Administrators) may advance the
// existing PC_SUCCESS_FEE workflow one step at a time: start the notice
// period, then schedule the debit through AE's processor once it elapses.
// Every gate is re-verified server-side (lib/pitCrewServiceFee.ts). This is
// the ONLY payment Pit Crew can initiate; service-order (saved-card) charges
// stay 403 for Pit Crew above, and no mandate/card reference is ever returned
// or audited.
const SERVICE_FEE_MESSAGES: Record<string, string> = {
  SERVICE_FEE_NOT_FOUND: "Not found",
  SERVICE_FEE_COLLECTION_FORBIDDEN: "You can't collect this fee.",
  PIT_CREW_NOT_ASSIGNED: "Only Pit Crew assigned to this transaction can collect its service fee.",
  SETTLEMENT_NOT_VERIFIED: "The service fee can be collected only after settlement is recorded as complete.",
  SERVICE_FEE_NOT_VERIFIED: "The service fee could not be verified against the agreed Pit Crew service terms.",
  SERVICE_FEE_AUTHORITY_INVALID: "There is no valid payment authority covering this service fee.",
  SERVICE_FEE_NOT_COLLECTABLE: "This service fee is not in a state that can be collected. A Brokerage Administrator handles recovery.",
  SERVICE_FEE_NOTICE_PERIOD_RUNNING: "The notice period for this service fee has not finished yet.",
  SETTLEMENT_STATEMENT_NOT_ISSUED: "The service fee can be collected only after a final, itemised settlement statement has been issued to the payer.",
  SETTLEMENT_STATEMENT_PAYER_MISMATCH: "The issued settlement statement is not addressed to the authorised payer.",
  SETTLEMENT_STATEMENT_FEE_MISMATCH: "The issued settlement statement does not itemise this service fee at the amount to be debited.",
};
function serviceFeeErrorResponse(err: unknown): { status: number; body: { error: string; code: string } } {
  if (err instanceof ServiceFeeCollectionError) {
    return { status: SERVICE_FEE_ERROR_STATUS[err.code], body: { error: SERVICE_FEE_MESSAGES[err.code] ?? "Not allowed", code: err.code } };
  }
  return { status: 500, body: { error: "Service fee collection failed", code: "SERVICE_FEE_COLLECTION_FAILED" } };
}
function serviceFeeView(v: Awaited<ReturnType<typeof verifyServiceFeeCollection>>, paymentRequest = v.paymentRequest) {
  return {
    transactionId: v.transactionId,
    paymentRequestId: paymentRequest.id,
    status: paymentRequest.status,
    currency: paymentRequest.currency,
    grossFeeCents: v.grossFeeCents,
    gstCents: v.gstCents,
    totalFeeCents: v.totalFeeCents,
    capCents: v.capCents,
    noticeSentAt: paymentRequest.noticeSentAt,
    noticeElapsesAt: v.noticeElapsesAt,
    scheduledAt: paymentRequest.scheduledAt,
    paidAt: paymentRequest.paidAt,
  };
}

paymentsRouter.get("/pit-crew-service-fee/:transactionId", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  try {
    const v = await verifyServiceFeeCollection(user, Number(req.params.transactionId));
    const gate = await settlementStatementGateFor(v, user.brokerageId);
    const statusCollectable = ["CALCULATED", "READY_TO_INVOICE", "INVOICED", "NOTICE_SENT"].includes(v.paymentRequest.status);
    // t178u(1): preview stays available; collection waits for an issued statement.
    res.json({
      serviceFee: serviceFeeView(v),
      collectable: statusCollectable && gate.ok,
      settlementStatement: gate.ok ? { issued: true, statementId: gate.statementId } : { issued: false, code: gate.code },
    });
  } catch (err) {
    const mapped = serviceFeeErrorResponse(err);
    if (mapped.status >= 500) logger.error("service_fee_status_failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(mapped.status).json(mapped.body);
  }
});

paymentsRouter.post("/pit-crew-service-fee/:transactionId/collect", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const transactionId = Number(req.params.transactionId);
  const recordId = Number.isFinite(transactionId) ? String(transactionId) : String(req.params.transactionId).slice(0, 64);
  try {
    const result = await collectPitCrewServiceFee(user, transactionId);
    await logAudit({
      brokerageId: user.brokerageId,
      userId: user.id,
      action: "pit_crew_service_fee_collection",
      recordType: "transaction",
      recordId,
      propertyId: result.verified.propertyId,
      updatedValue: JSON.stringify({
        outcome: result.outcome,
        callerRole: user.role,
        paymentRequestId: result.paymentRequest.id,
        statusBefore: result.verified.paymentRequest.status,
        statusAfter: result.paymentRequest.status,
        grossFeeCents: result.verified.grossFeeCents,
        gstCents: result.verified.gstCents,
        totalFeeCents: result.verified.totalFeeCents,
        capCents: result.verified.capCents,
        pitCrewAssignmentIds: result.verified.pitCrewAssignmentIds,
        settlementStatementId: result.settlementStatementId,
        policy: "t177u+t178u",
      }),
    });
    const status = result.outcome === "debit_queued" ? 202 : 200;
    res.status(status).json({ outcome: result.outcome, serviceFee: serviceFeeView(result.verified, result.paymentRequest) });
  } catch (err) {
    const mapped = serviceFeeErrorResponse(err);
    if (mapped.status >= 500) logger.error("service_fee_collection_failed", { error: err instanceof Error ? err.message : String(err) });
    await logAudit({
      brokerageId: user.brokerageId,
      userId: user.id,
      action: mapped.status === 403 || mapped.status === 404 ? "pit_crew_service_fee_collection_denied" : "pit_crew_service_fee_collection_failed",
      recordType: "transaction",
      recordId,
      propertyId: err instanceof ServiceFeeCollectionError ? (err.propertyId ?? null) : null,
      updatedValue: JSON.stringify({ outcome: "refused", callerRole: user.role, code: mapped.body.code, policy: "t177u+t178u" }),
    });
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
  REFUND_NOT_FOUND: { status: 404, error: "Not found" },
  REFUND_ALREADY_RESOLVED: { status: 409, error: "This refund is not awaiting review." },
  REFUND_IN_REVIEW: { status: 409, error: "The rest of this payment is held by refunds still in progress or awaiting review." },
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
// Refund ledger (t429u): an optional Idempotency-Key header makes a repeat submit return the same
// refund instead of a second one. Status by ledger outcome: SUCCEEDED 200; SUBMITTED (provider pending)
// 202 REFUND_PENDING; UNKNOWN 202 REFUND_OUTCOME_UNKNOWN (reconciler resolves it, never a blind retry);
// FAILED 502 REFUND_REJECTED (the reservation is released).
const REFUND_OUTCOME_HTTP: Record<string, { status: number; code?: string }> = {
  SUCCEEDED: { status: 200 },
  SUBMITTED: { status: 202, code: "REFUND_PENDING" },
  PENDING: { status: 202, code: "REFUND_PENDING" },
  UNKNOWN: { status: 202, code: "REFUND_OUTCOME_UNKNOWN" },
  MANUAL_REVIEW: { status: 202, code: "REFUND_IN_REVIEW" },
  FAILED: { status: 502, code: "REFUND_REJECTED" },
};
const idempotencyHeader = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);

paymentsRouter.post("/:paymentId/refund", requireAuth, requiresRunAccess, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const paymentId = Number(req.params.paymentId);
  // S-1d: passed through raw; refundPayment validates it (strings are rejected, no longer silently ignored).
  const amountCents: unknown = req.body?.amountCents;
  const rawKey = req.header("idempotency-key");
  let clientIdempotencyKey: string | undefined;
  if (rawKey !== undefined) {
    const k = idempotencyHeader.safeParse(rawKey);
    if (!k.success) {
      res.status(400).json({ error: "Idempotency-Key must be 1-200 characters of letters, digits, . _ : -", code: "IDEMPOTENCY_KEY_INVALID" });
      return;
    }
    clientIdempotencyKey = k.data;
  }
  const user = req.authedUser!;
  try {
    const result = await refundPayment({ paymentId, amountCents, brokerageId: user.brokerageId, userId: user.id, clientIdempotencyKey });
    const { refund, replayed, ...payment } = result;
    if (!replayed && refund?.status === "SUCCEEDED") {
      await logAudit({
        brokerageId: user.brokerageId,
        userId: user.id,
        action: "payment_refunded",
        recordType: "payment",
        recordId: String(paymentId),
        providerReference: refund.providerRefundRef ?? payment.providerChargeRef ?? undefined,
        updatedValue: JSON.stringify({ refundId: refund.id, amountCents: refund.amountCents, status: payment.status }),
      });
    }
    const http = REFUND_OUTCOME_HTTP[refund?.status ?? "SUCCEEDED"] ?? { status: 202, code: "REFUND_PENDING" };
    res.status(http.status).json({ payment, refund, replayed: Boolean(replayed), ...(http.code ? { code: http.code } : {}) });
  } catch (err) {
    const mapped = refundErrorResponse(err);
    if (mapped.status >= 500) logger.error("payment_refund_failed", { paymentId, error: err instanceof Error ? err.message : String(err) });
    res.status(mapped.status).json(mapped.body);
  }
});

// Refund ledger reads and operator actions (Brokerage Administrator + run.access, brokerage-scoped;
// a foreign id answers exactly like a missing one).
paymentsRouter.get("/:paymentId/refunds", requireAuth, requiresRunAccess, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const paymentId = Number(req.params.paymentId);
  const user = req.authedUser!;
  res.json({ refunds: Number.isSafeInteger(paymentId) ? await listRefundsForPayment(paymentId, user.brokerageId) : [] });
});

const resolveSchema = z.object({
  action: z.enum(["mark_succeeded", "mark_failed"]),
  providerRefundRef: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().min(1).max(1000),
});
paymentsRouter.post("/refunds/:refundId/resolve", requireAuth, requiresRunAccess, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const refundId = Number(req.params.refundId);
  if (!Number.isSafeInteger(refundId) || refundId <= 0) {
    res.status(404).json({ error: "Not found", code: "REFUND_NOT_FOUND" });
    return;
  }
  const parsed = resolveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "action and note are required", code: "REFUND_RESOLVE_INVALID" });
    return;
  }
  if (parsed.data.action === "mark_succeeded" && !parsed.data.providerRefundRef) {
    res.status(400).json({ error: "providerRefundRef is required to mark a refund succeeded", code: "REFUND_RESOLVE_INVALID" });
    return;
  }
  const user = req.authedUser!;
  try {
    const refund = await resolveRefundManually({ refundId, brokerageId: user.brokerageId, userId: user.id, ...parsed.data });
    res.json({ refund });
  } catch (err) {
    const mapped = refundErrorResponse(err);
    if (mapped.status >= 500) logger.error("payment_refund_resolve_failed", { refundId, error: err instanceof Error ? err.message : String(err) });
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
