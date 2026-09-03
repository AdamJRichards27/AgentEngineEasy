import { Router, type Request, type Response, type NextFunction } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, transactions, properties } from "@aee/db";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import {
  getTransactionByProperty,
  recordContractSigned,
  recordFinanceApproved,
  scheduleSettlement,
  completeSettlement,
  calculateCommission,
  recordFundsReceived,
  recordAgentPaid,
  closeTransaction,
  recordLegalRepresentatives,
  resyncTransactionProjection,
  TransactionClosureBlockedError,
} from "../lib/transactions.js";
import { listConditions, addCondition, rescheduleConditionDueDate, resolveCondition, recordExchange, maybeRecordUnconditional } from "../lib/transactionConditions.js";

export const transactionsRouter = Router();

async function propertyInBrokerage(propertyId: number, brokerageId: number): Promise<boolean> {
  const [property] = await db.select().from(properties).where(eq(properties.id, propertyId));
  return !!property && property.brokerageId === brokerageId;
}

// #123 — tenant scoping. None of this router's :id routes previously
// verified that the transaction's property belonged to the caller's
// brokerage; every action below (including contract-signed,
// settlement-complete, close, etc.) relied on the id alone. This
// middleware closes that gap once, for every route in this file.
async function requireTransactionAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  const [transaction] = await db.select().from(transactions).where(eq(transactions.id, id));
  if (!transaction || !(await propertyInBrokerage(transaction.propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

transactionsRouter.get("/by-property/:propertyId", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const user = req.authedUser!;
  if (!(await propertyInBrokerage(propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const transaction = await getTransactionByProperty(propertyId);
  res.json({ transaction });
});

transactionsRouter.get("/:id", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = Number(req.params.id);
  const [transaction] = await db.select().from(transactions).where(eq(transactions.id, id));
  res.json({ transaction });
});

async function handle(fn: () => Promise<unknown>, res: Response): Promise<void> {
  try {
    const transaction = await fn();
    res.json({ transaction });
  } catch (err) {
    if (err instanceof TransactionClosureBlockedError) {
      res.status(409).json({ error: err.message, blockers: err.blockers });
      return;
    }
    res.status(400).json({ error: (err as Error).message });
  }
}

transactionsRouter.post("/:id/contract-signed", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  await handle(() => recordContractSigned({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res);
});

transactionsRouter.post("/:id/finance-approved", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  await handle(() => recordFinanceApproved({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res);
});

const settlementScheduleSchema = z.object({ settlementDate: z.coerce.date() });

transactionsRouter.post("/:id/settlement-schedule", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = Number(req.params.id);
  const parsed = settlementScheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;
  await handle(
    () =>
      scheduleSettlement({
        transactionId: id,
        userId: user.id,
        brokerageId: user.brokerageId,
        settlementDate: parsed.data.settlementDate,
      }),
    res,
  );
});

transactionsRouter.post("/:id/settlement-complete", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  await handle(() => completeSettlement({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res);
});

transactionsRouter.post("/:id/calculate-commission", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  await handle(
    () => calculateCommission({ transactionId: id, userId: user.id, brokerageId: user.brokerageId, force: req.body?.force === true }),
    res,
  );
});

const fundsReceivedSchema = z.object({ amountCents: z.number().int().positive() });

transactionsRouter.post("/:id/funds-received", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = Number(req.params.id);
  const parsed = fundsReceivedSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;
  await handle(
    () =>
      recordFundsReceived({
        transactionId: id,
        userId: user.id,
        brokerageId: user.brokerageId,
        amountCents: parsed.data.amountCents,
      }),
    res,
  );
});

// Financial disbursement sign-off — restricted to Brokerage Administrators,
// same precedent as refunds (Phase 6) and AML exception resolution (Phase 4).
transactionsRouter.post(
  "/:id/agent-paid",
  requireAuth,
  requireTransactionAccess,
  requireRole(...BROKERAGE_ADMIN_ROLES),
  async (req, res) => {
    const id = Number(req.params.id);
    const user = req.authedUser!;
    await handle(() => recordAgentPaid({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res);
  },
);

// Final sign-off — same Brokerage Administrator gate as agent-paid above.
// #121: closeTransaction now enforces real closure preconditions
// (unconditional, conditions resolved, buyer AML complete, no open
// attention items/active tasks) and throws TransactionClosureBlockedError
// with the specific list when blocked; `force: true` is a deliberate,
// audited override, never the default.
transactionsRouter.post(
  "/:id/close",
  requireAuth,
  requireTransactionAccess,
  requireRole(...BROKERAGE_ADMIN_ROLES),
  async (req, res) => {
    const id = Number(req.params.id);
    const user = req.authedUser!;
    const force = req.body?.force === true;
    await handle(() => closeTransaction({ transactionId: id, userId: user.id, brokerageId: user.brokerageId, force }), res);
  },
);

// Part B Stage 4 — manual remediation surface for
// DC01_TRANSACTION_PROJECTION_DRIFT (lib/exceptions/rules/dataConsistency.ts),
// the recommendedAction that exception's finding points operators at.
// Brokerage Administrator only, same gate as agent-paid/close above — this
// is operational data-repair, not a normal transaction action. Safe to
// call even when nothing has drifted (see resyncTransactionProjection's
// own doc comment in lib/transactions.ts).
transactionsRouter.post(
  "/:id/resync-projection",
  requireAuth,
  requireTransactionAccess,
  requireRole(...BROKERAGE_ADMIN_ROLES),
  async (req, res) => {
    const id = Number(req.params.id);
    const user = req.authedUser!;
    try {
      const result = await resyncTransactionProjection({ transactionId: id, userId: user.id, brokerageId: user.brokerageId });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

// --- Stage E: Contract & Conditions (#118) ---

transactionsRouter.get("/:id/conditions", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = Number(req.params.id);
  const conditions = await listConditions(id);
  res.json({ conditions });
});

const addConditionSchema = z.object({ description: z.string().min(1), dueDate: z.coerce.date().optional() });

transactionsRouter.post("/:id/conditions", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = Number(req.params.id);
  const parsed = addConditionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;
  try {
    const condition = await addCondition({
      transactionId: id,
      userId: user.id,
      brokerageId: user.brokerageId,
      description: parsed.data.description,
      dueDate: parsed.data.dueDate ?? null,
    });
    res.status(201).json({ condition });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

const rescheduleConditionSchema = z.object({ newDueDate: z.coerce.date().nullable() });

// Tenant scoping for these two routes is enforced inside
// lib/transactionConditions.ts (loadTransactionInBrokerage) rather than via
// requireTransactionAccess, since the route param here is a conditionId,
// not a transactionId.
transactionsRouter.post("/conditions/:conditionId/reschedule", requireAuth, async (req, res) => {
  const conditionId = Number(req.params.conditionId);
  const parsed = rescheduleConditionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;
  try {
    const condition = await rescheduleConditionDueDate({
      conditionId,
      userId: user.id,
      brokerageId: user.brokerageId,
      newDueDate: parsed.data.newDueDate,
    });
    res.json({ condition });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

const resolveConditionSchema = z.object({
  status: z.enum(["Satisfied", "Waived", "Failed", "NotApplicable"]),
  notes: z.string().optional(),
});

transactionsRouter.post("/conditions/:conditionId/resolve", requireAuth, async (req, res) => {
  const conditionId = Number(req.params.conditionId);
  const parsed = resolveConditionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;
  try {
    const condition = await resolveCondition({
      conditionId,
      userId: user.id,
      brokerageId: user.brokerageId,
      status: parsed.data.status,
      notes: parsed.data.notes,
    });
    res.json({ condition });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

transactionsRouter.post("/:id/exchange", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  await handle(() => recordExchange({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res);
});

transactionsRouter.post("/:id/unconditional", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  try {
    const transaction = await maybeRecordUnconditional({ transactionId: id, userId: user.id, brokerageId: user.brokerageId });
    if (!transaction.unconditionalAt) {
      const conditions = await listConditions(id);
      const blockers: string[] = [];
      if (!transaction.exchangedAt) blockers.push("Contracts have not been exchanged yet.");
      const unresolved = conditions.filter((c) => c.status === "Pending" || c.status === "Failed");
      if (unresolved.length > 0) {
        blockers.push(`${unresolved.length} condition(s) are not yet Satisfied/Waived/NotApplicable.`);
      }
      res.status(409).json({ error: "Transaction cannot be marked unconditional yet.", blockers });
      return;
    }
    res.json({ transaction });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// --- Stage D/F: legal representatives (#117) ---

const legalRepsSchema = z.object({
  sellerSolicitorPartyId: z.number().int().optional().nullable(),
  buyerSolicitorPartyId: z.number().int().optional().nullable(),
});

transactionsRouter.post("/:id/legal-representatives", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = Number(req.params.id);
  const parsed = legalRepsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;
  await handle(
    () =>
      recordLegalRepresentatives({
        transactionId: id,
        userId: user.id,
        brokerageId: user.brokerageId,
        sellerSolicitorPartyId: parsed.data.sellerSolicitorPartyId,
        buyerSolicitorPartyId: parsed.data.buyerSolicitorPartyId,
      }),
    res,
  );
});
