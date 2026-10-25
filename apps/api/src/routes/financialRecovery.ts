// Owner t181u (t178-plan slice 7): controlled recovery routes for the AE Pit
// Crew service fee. Brokerage Administrator only (Pit Crew, agents and every
// other role 403 at the role gate; another brokerage's id 404). Each action
// needs a reason and evidence; transitions are audited value-free and written
// to the ledger (shown in the receipt history); replays are idempotent. Never
// calls a payment provider. See lib/financial/recovery.ts.
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import {
  auditRecoveryOutcome,
  listCardChargesForBrokerage,
  RecoveryRefusal,
  resolvePaymentRequestDispute,
  resolveUnknownCardCharge,
  waivePaymentRequest,
  writeOffPaymentRequest,
  type RecoveryAction,
  type RecoveryActor,
  type RecoveryResult,
} from "../lib/financial/recovery.js";

export const financialRecoveryRouter = Router();
const requireBrokerageAdmin = [requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), requireEntitlement("run.access")] as const;

const evidenceShape = {
  reason: z.string().max(2000).nullish(),
  evidenceDocumentId: z.number().int().positive().nullish(),
  evidenceNote: z.string().max(2000).nullish(),
};
const recoverySchema = z.object(evidenceShape);
const disputeSchema = z.object({ ...evidenceShape, outcome: z.enum(["PAYABLE", "WAIVED", "WRITTEN_OFF"]) });
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

financialRecoveryRouter.get("/financial/card-charges", ...requireBrokerageAdmin, async (req, res) => {
  const status = typeof req.query.status === "string" && ["PENDING", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(req.query.status) ? req.query.status : undefined;
  res.json({ cardCharges: await listCardChargesForBrokerage(req.authedUser!.brokerageId, status) });
});

financialRecoveryRouter.post("/financial/card-charges/:id/resolve", ...requireBrokerageAdmin, async (req, res) => {
  const parsed = cardSchema.safeParse(req.body ?? {});
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const id = Number(req.params.id);
  await run(req, res, "resolve_card_charge", id, () => resolveUnknownCardCharge(actorOf(req), id, parsed.data.outcome, parsed.data));
});
