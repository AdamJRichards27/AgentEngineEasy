// Owner t181u (t178-plan slice 7): controlled recovery routes for the AE Pit
// Crew service fee. Brokerage Administrator only (Pit Crew, agents and every
// other role 403 at the role gate; another brokerage's id 404). Each action
// needs a reason and evidence; transitions are audited value-free and written
// to the ledger (shown in the receipt history); replays are idempotent. Never
// charges: card-charge resolution only reads the (mock) provider status and
// must match it (t181u D); the charge initiator never resolves it. See lib/financial/recovery.ts.
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import {
  auditRecoveryOutcome,
  cardChargeProviderStatusFor,
  listCardChargesForBrokerage,
  RecoveryRefusal,
  resolvePaymentRequestDispute,
  resolveUnknownCardCharge,
  waivePaymentRequest,
  listAdjustmentRecords,
  writeOffPaymentRequest,
  type RecoveryAction,
  type RecoveryActor,
  type RecoveryResult,
} from "../lib/financial/recovery.js";
import { HeldDebitRefusal, listHeldDebitDispatches, resolveHeldDebit } from "../lib/financial/paymentOutbox.js";
import { cardRefundProviderStatusFor, listCardRefunds, listCardRefundsForBrokerage, refundCardCharge, resolveUnknownCardRefund } from "../lib/financial/cardRefunds.js";

export const financialRecoveryRouter = Router();
const requireBrokerageAdmin = [requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), requireEntitlement("run.access")] as const;

const evidenceShape = {
  reason: z.string().max(2000).nullish(),
  evidenceDocumentId: z.number().int().positive().nullish(),
  evidenceNote: z.string().max(2000).nullish(),
};
const recoverySchema = z.object(evidenceShape);
const disputeSchema = z.object({ ...evidenceShape, outcome: z.enum(["PAYABLE", "WAIVED", "WRITTEN_OFF"]) });
// t181u phase 2a: strict, so no destination, payment method or charge reference can ever be supplied.
const refundSchema = z
  .object({
    ...evidenceShape,
    amountCents: z.number().int().positive().max(100_000_000),
    requestKey: z.string().min(8).max(100).regex(/^[A-Za-z0-9_.:-]+$/),
  })
  .strict();
const cardSchema = z.object({ ...evidenceShape, outcome: z.enum(["SUCCEEDED", "FAILED"]), providerChargeRef: z.string().max(200).nullish() });

function actorOf(req: Request): RecoveryActor {
  const u = req.authedUser!;
  return { id: u.id, role: u.role, brokerageId: u.brokerageId };
}

async function run(req: Request, res: Response, action: RecoveryAction, targetId: number, fn: () => Promise<RecoveryResult>) {
  const actor = actorOf(req);
  try {
    const result = await fn();
    if (result.idempotent) await auditRecoveryOutcome(actor, action, { replayed: result }, targetId);
    res.json({ idempotent: result.idempotent, statusBefore: result.statusBefore, paymentRequest: result.paymentRequest, ...(result.cardCharge ? { cardCharge: redactCharge(result.cardCharge) } : {}) });
  } catch (err) {
    if (!(err instanceof RecoveryRefusal)) throw err;
    await auditRecoveryOutcome(actor, action, { refused: err }, targetId);
    res.status(err.status).json(err.status === 404 ? { error: "Not found." } : { error: err.message, code: err.code });
  }
}

function redactCharge(c: NonNullable<RecoveryResult["cardCharge"]>) {
  const { paymentMethodId: _pm, pcFeeAuthorityId: _a, idempotencyKey: _k, ...rest } = c;
  return rest;
}

financialRecoveryRouter.post("/financial/payment-requests/:id/waive", ...requireBrokerageAdmin, async (req, res) => {
  const parsed = recoverySchema.safeParse(req.body ?? {});
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const id = Number(req.params.id);
  await run(req, res, "waive", id, () => waivePaymentRequest(actorOf(req), id, parsed.data));
});

financialRecoveryRouter.post("/financial/payment-requests/:id/write-off", ...requireBrokerageAdmin, async (req, res) => {
  const parsed = recoverySchema.safeParse(req.body ?? {});
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const id = Number(req.params.id);
  await run(req, res, "write_off", id, () => writeOffPaymentRequest(actorOf(req), id, parsed.data));
});

financialRecoveryRouter.post("/financial/payment-requests/:id/resolve-dispute", ...requireBrokerageAdmin, async (req, res) => {
  const parsed = disputeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const id = Number(req.params.id);
  await run(req, res, "resolve_dispute", id, () => resolvePaymentRequestDispute(actorOf(req), id, parsed.data.outcome, parsed.data));
});

// Owner t183u item 2: formal waiver / write-off adjustment records (read-only; never receipts).
financialRecoveryRouter.get("/financial/payment-requests/:id/adjustments", ...requireBrokerageAdmin, async (req, res) => {
  try {
    res.json({ adjustments: await listAdjustmentRecords(actorOf(req), Number(req.params.id)) });
  } catch (err) {
    if (!(err instanceof RecoveryRefusal)) throw err;
    res.status(err.status).json(err.status === 404 ? { error: "Not found." } : { error: err.message, code: err.code });
  }
});

// Owner t210u: uncertain debit dispatches held for manual review (read-only; nothing is resent).
financialRecoveryRouter.get("/financial/payment-outbox/held", ...requireBrokerageAdmin, async (req, res) => {
  res.json({ held: await listHeldDebitDispatches(req.authedUser!.brokerageId) });
});

// #245 S5: resolve a held debit against the sandbox provider's record (never sends).
const resolveHeldSchema = z.object({ outcome: z.enum(["SCHEDULED", "FAILED"]), reason: z.string().trim().min(1).max(2000) }).strict();
financialRecoveryRouter.post("/financial/payment-outbox/:id/resolve-held", ...requireBrokerageAdmin, async (req, res) => {
  const parsed = resolveHeldSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const user = req.authedUser!;
  try {
    res.json(await resolveHeldDebit({ brokerageId: user.brokerageId, actorUserId: user.id, outboxEntryId: Number(req.params.id), ...parsed.data }));
  } catch (err) {
    if (!(err instanceof HeldDebitRefusal)) throw err;
    res.status(err.status).json(err.status === 404 ? { error: "Not found." } : { error: err.message, code: err.code });
  }
});

financialRecoveryRouter.get("/financial/card-charges", ...requireBrokerageAdmin, async (req, res) => {
  const status = typeof req.query.status === "string" && ["PENDING", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(req.query.status) ? req.query.status : undefined;
  res.json({ cardCharges: await listCardChargesForBrokerage(req.authedUser!.brokerageId, status) });
});

// t181u(D): read-only provider status (mock provider only; anything else answers Unavailable and resolution fails closed).
financialRecoveryRouter.get("/financial/card-charges/:id/provider-status", ...requireBrokerageAdmin, async (req, res) => {
  try {
    res.json(await cardChargeProviderStatusFor(actorOf(req), Number(req.params.id)));
  } catch (err) {
    if (!(err instanceof RecoveryRefusal)) throw err;
    res.status(err.status).json(err.status === 404 ? { error: "Not found." } : { error: err.message, code: err.code });
  }
});

financialRecoveryRouter.post("/financial/card-charges/:id/resolve", ...requireBrokerageAdmin, async (req, res) => {
  const parsed = cardSchema.safeParse(req.body ?? {});
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const id = Number(req.params.id);
  await run(req, res, "resolve_card_charge", id, () => resolveUnknownCardCharge(actorOf(req), id, parsed.data.outcome, parsed.data));
});

// t181u phase 2a item 3: controlled card refunds (BA only; original charge only; mock provider only).
financialRecoveryRouter.get("/financial/card-charges/:id/refunds", ...requireBrokerageAdmin, async (req, res) => {
  try {
    res.json(await listCardRefunds(actorOf(req), Number(req.params.id)));
  } catch (err) {
    if (!(err instanceof RecoveryRefusal)) throw err;
    res.status(err.status).json(err.status === 404 ? { error: "Not found." } : { error: err.message, code: err.code });
  }
});

financialRecoveryRouter.post("/financial/card-charges/:id/refunds", ...requireBrokerageAdmin, async (req, res) => {
  const parsed = refundSchema.safeParse(req.body ?? {});
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const id = Number(req.params.id);
  const actor = actorOf(req);
  try {
    const result = await refundCardCharge(actor, id, parsed.data);
    res.status(result.idempotent ? 200 : 201).json(result);
  } catch (err) {
    if (!(err instanceof RecoveryRefusal)) throw err;
    await auditRecoveryOutcome(actor, "refund_card_charge", { refused: err }, id);
    res.status(err.status).json(err.status === 404 ? { error: "Not found." } : { error: err.message, code: err.code });
  }
});

// t181u phase 2b (G15): BA resolution of UNKNOWN card refunds (mock provider status only; requester never resolves).
const refundResolveSchema = z.object({ ...evidenceShape, outcome: z.enum(["SUCCEEDED", "FAILED"]) }).strict();

financialRecoveryRouter.get("/financial/card-refunds", ...requireBrokerageAdmin, async (req, res) => {
  const status = typeof req.query.status === "string" && ["PENDING", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(req.query.status) ? req.query.status : undefined;
  res.json({ cardRefunds: await listCardRefundsForBrokerage(req.authedUser!.brokerageId, status) });
});

financialRecoveryRouter.get("/financial/card-refunds/:id/provider-status", ...requireBrokerageAdmin, async (req, res) => {
  try {
    res.json(await cardRefundProviderStatusFor(actorOf(req), Number(req.params.id)));
  } catch (err) {
    if (!(err instanceof RecoveryRefusal)) throw err;
    res.status(err.status).json(err.status === 404 ? { error: "Not found." } : { error: err.message, code: err.code });
  }
});

financialRecoveryRouter.post("/financial/card-refunds/:id/resolve", ...requireBrokerageAdmin, async (req, res) => {
  const parsed = refundResolveSchema.safeParse(req.body ?? {});
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const id = Number(req.params.id);
  const actor = actorOf(req);
  try {
    const result = await resolveUnknownCardRefund(actor, id, parsed.data.outcome, parsed.data);
    if (result.idempotent) {
      await auditRecoveryOutcome(actor, "resolve_card_refund", { replayed: { idempotent: true, paymentRequest: { id: result.paymentRequestId, status: result.refund.status, propertyId: null } as never, statusBefore: result.refund.status } }, id);
    }
    res.json(result);
  } catch (err) {
    if (!(err instanceof RecoveryRefusal)) throw err;
    await auditRecoveryOutcome(actor, "resolve_card_refund", { refused: err }, id);
    res.status(err.status).json(err.status === 404 ? { error: "Not found." } : { error: err.message, code: err.code });
  }
});
