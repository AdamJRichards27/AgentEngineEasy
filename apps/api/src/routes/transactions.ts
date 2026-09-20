import { Router, type Request, type Response, type NextFunction } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, transactions, properties } from "@aee/db";
import { logger } from "@aee/events";
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
  TransactionClosureBlockedError,
} from "../lib/transactions.js";
import { listConditions, addCondition, rescheduleConditionDueDate, resolveCondition, recordExchange, maybeRecordUnconditional } from "../lib/transactionConditions.js";

export const transactionsRouter = Router();

// AE GROW Pilot Readiness WP9 — route-id validation, the same bounded guard
// routes/grow.ts, routes/communications.ts, routes/growAppraisals.ts and
// routes/propertyIntelligence.ts already use (each keeps its own local copy;
// this is deliberately not a shared module). Every route below took a raw
// `Number(req.params...)` straight into a `where(eq(..., ...))` bind, so
// "abc" reached Postgres as NaN and an id past int4 as an unbindable value —
// and the resulting driver error was then answered as a 400 carrying its own
// "Failed query: select ..." text. Bounded by MAX_SIGNED_INT4 because
// transactions.id, properties.id and transactionConditions.id are `serial`
// columns, i.e. int4.
const MAX_SIGNED_INT4 = 2_147_483_647;

function parsePositiveId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 && n <= MAX_SIGNED_INT4 ? n : null;
}

/** Resolves a route id, answering 400 itself and returning null when malformed. */
function readIdParam(res: Response, value: unknown, label: "transaction" | "property" | "condition"): number | null {
  const id = parsePositiveId(value);
  if (id === null) {
    res.status(400).json({ error: `Invalid ${label} id` });
    return null;
  }
  return id;
}

/**
 * The :id of a route mounted behind requireTransactionAccess, which has
 * already answered 400 for anything this could not parse and 404 for anything
 * outside the caller's brokerage — so the assertion here is about middleware
 * ordering, not about trusting the input.
 */
function accessCheckedTransactionId(req: Request): number {
  return parsePositiveId(req.params.id)!;
}

/** What an unrecognised error is allowed to tell a client. */
const GENERIC_TRANSACTION_ERROR = "An unexpected error occurred. Please try again or contact support if the problem persists.";

/** Driver/ORM text, as a second line of defence behind the prototype test below. */
const DRIVER_TEXT = /failed query|\bselect\b[\s\S]*\bfrom\b|\bparams:\s/i;

/**
 * True only for a plain `new Error("...")` — the shape lib/transactions.ts
 * and lib/transactionConditions.ts use for their operator-authored,
 * caller-facing messages ("Transaction 7 cannot be exchanged before the
 * contract is signed.", "Agency agreement terms have not been captured for
 * this property — cannot calculate commission.", "Transaction 7 has already
 * settled — cannot reschedule."), which are deliberately kept with this
 * router's existing 400.
 *
 * Every driver/ORM/system error is a SUBCLASS of Error and therefore fails
 * this prototype-identity test: drizzle's DrizzleQueryError (whose message is
 * the `Failed query: select "id", "brokerage_id" ... from ...` text live
 * smoke testing found in real response bodies), pg's DatabaseError, and
 * RangeError/TypeError/SyntaxError. DrizzleQueryError notably does NOT
 * override `name` — it reports "Error" — so a name check alone would let the
 * leak straight through; only the prototype identity separates them.
 */
function isOperatorAuthoredError(err: unknown): err is Error {
  return err instanceof Error && Object.getPrototypeOf(err) === Error.prototype && !DRIVER_TEXT.test(err.message);
}

/**
 * Expected domain errors keep this router's existing 400 and their own
 * messages; anything else is an unrecognised server fault, logged in full
 * server-side (the structured logger attaches the ambient correlationId
 * itself — see packages/events/src/logger.ts) and answered generically.
 * Mirrors handleGrowAppraisalError / handlePropertyIntelligenceError.
 * TransactionClosureBlockedError, this router's one typed error class, keeps
 * its own 409 in handle() below.
 */
function handleTransactionError(err: unknown, res: Response): void {
  if (isOperatorAuthoredError(err)) {
    res.status(400).json({ error: err.message });
    return;
  }
  logger.error("transaction_route_unhandled_error", {
    error: err instanceof Error ? err.message : String(err),
    errorName: err instanceof Error ? (err.constructor?.name ?? err.name) : typeof err,
  });
  res.status(500).json({ error: GENERIC_TRANSACTION_ERROR });
}

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
  const id = readIdParam(res, req.params.id, "transaction");
  if (id === null) return;
  const user = req.authedUser!;
  const [transaction] = await db.select().from(transactions).where(eq(transactions.id, id));
  if (!transaction || !(await propertyInBrokerage(transaction.propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

transactionsRouter.get("/by-property/:propertyId", requireAuth, async (req, res) => {
  const propertyId = readIdParam(res, req.params.propertyId, "property");
  if (propertyId === null) return;
  const user = req.authedUser!;
  if (!(await propertyInBrokerage(propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const transaction = await getTransactionByProperty(propertyId);
  res.json({ transaction });
});

transactionsRouter.get("/:id", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = accessCheckedTransactionId(req);
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
    handleTransactionError(err, res);
  }
}

transactionsRouter.post("/:id/contract-signed", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = accessCheckedTransactionId(req);
  const user = req.authedUser!;
  await handle(() => recordContractSigned({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res);
});

transactionsRouter.post("/:id/finance-approved", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = accessCheckedTransactionId(req);
  const user = req.authedUser!;
  await handle(() => recordFinanceApproved({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res);
});

const settlementScheduleSchema = z.object({ settlementDate: z.coerce.date() });

transactionsRouter.post("/:id/settlement-schedule", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = accessCheckedTransactionId(req);
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
  const id = accessCheckedTransactionId(req);
  const user = req.authedUser!;
  await handle(() => completeSettlement({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res);
});

transactionsRouter.post("/:id/calculate-commission", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = accessCheckedTransactionId(req);
  const user = req.authedUser!;
  await handle(
    () => calculateCommission({ transactionId: id, userId: user.id, brokerageId: user.brokerageId, force: req.body?.force === true }),
    res,
  );
});

const fundsReceivedSchema = z.object({ amountCents: z.number().int().positive() });

transactionsRouter.post("/:id/funds-received", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = accessCheckedTransactionId(req);
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
    const id = accessCheckedTransactionId(req);
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
    const id = accessCheckedTransactionId(req);
    const user = req.authedUser!;
    const force = req.body?.force === true;
    await handle(() => closeTransaction({ transactionId: id, userId: user.id, brokerageId: user.brokerageId, force }), res);
  },
);

// --- Stage E: Contract & Conditions (#118) ---

transactionsRouter.get("/:id/conditions", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = accessCheckedTransactionId(req);
  const conditions = await listConditions(id);
  res.json({ conditions });
});

const addConditionSchema = z.object({ description: z.string().min(1), dueDate: z.coerce.date().optional() });

transactionsRouter.post("/:id/conditions", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = accessCheckedTransactionId(req);
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
    handleTransactionError(err, res);
  }
});

const rescheduleConditionSchema = z.object({ newDueDate: z.coerce.date().nullable() });

// Tenant scoping for these two routes is enforced inside
// lib/transactionConditions.ts (loadTransactionInBrokerage) rather than via
// requireTransactionAccess, since the route param here is a conditionId,
// not a transactionId.
transactionsRouter.post("/conditions/:conditionId/reschedule", requireAuth, async (req, res) => {
  const conditionId = readIdParam(res, req.params.conditionId, "condition");
  if (conditionId === null) return;
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
    handleTransactionError(err, res);
  }
});

const resolveConditionSchema = z.object({
  status: z.enum(["Satisfied", "Waived", "Failed", "NotApplicable"]),
  notes: z.string().optional(),
});

transactionsRouter.post("/conditions/:conditionId/resolve", requireAuth, async (req, res) => {
  const conditionId = readIdParam(res, req.params.conditionId, "condition");
  if (conditionId === null) return;
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
    handleTransactionError(err, res);
  }
});

transactionsRouter.post("/:id/exchange", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = accessCheckedTransactionId(req);
  const user = req.authedUser!;
  await handle(() => recordExchange({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res);
});

transactionsRouter.post("/:id/unconditional", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = accessCheckedTransactionId(req);
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
    handleTransactionError(err, res);
  }
});

// --- Stage D/F: legal representatives (#117) ---

const legalRepsSchema = z.object({
  sellerSolicitorPartyId: z.number().int().optional().nullable(),
  buyerSolicitorPartyId: z.number().int().optional().nullable(),
});

transactionsRouter.post("/:id/legal-representatives", requireAuth, requireTransactionAccess, async (req, res) => {
  const id = accessCheckedTransactionId(req);
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
