import { Router, type Request, type Response, type NextFunction } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, transactions, properties, type Transaction } from "@aee/db";
import { incrementCounter, logger } from "@aee/events";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import { logAudit } from "../lib/audit.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
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
  readTransactionClosureBlockers,
  recordLegalRepresentatives,
  TransactionClosureBlockedError,
} from "../lib/transactions.js";
import { listConditions, addCondition, rescheduleConditionDueDate, resolveCondition, recordExchange, maybeRecordUnconditional } from "../lib/transactionConditions.js";
import { computeFundsReconciliation } from "../lib/transactionFunds.js";
import { transactionViewFor } from "../lib/transactionPriceAccess.js";
import { propertyHiddenFromCaller } from "../lib/propertyVisibility.js";
import type { AuthedUser } from "../middlewares/auth.js";

export const transactionsRouter = Router();

// R-F2 — Run entitlement consistency. Transactions are part of the RUN product.
// Every route below requires run.access alongside the existing auth, tenant, and
// role gates, never instead of them. Same shape as Pit Crew (routes/pitCrew.ts):
// a named requiresRunAccess middleware, applied on the route, not via Router.use()
// (financial.ts explains why a blanket use() is unsafe on an unprefixed sibling;
// this router is prefixed, but per-route gates stay the established convention).
//
// Ordering: requireAuth, then requiresRunAccess, then requireTransactionAccess
// (and requireRole, where that gate already exists). The product check runs
// before the transaction-row lookup so an unentitled caller is refused without
// a same-brokerage existence oracle. requireTransactionAccess still runs for
// every entitled caller, so a malformed id stays 400 and a cross-tenant id
// stays 404 — the handler's accessCheckedTransactionId assumption is unchanged,
// and requireRole stays after the tenant gate so an entitled non-admin naming
// another brokerage's id still sees 404 rather than a role 403. Existing
// brokerages keep access via the run.access backfill
// (lib/billing/runAccessBackfill.ts) and the dev-login auto-grant (routes/auth.ts).
const requiresRunAccess = requireEntitlement("run.access");

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

// R-F8 — the transaction boundary of tenant_isolation_rejection_total.
// The property row is already loaded here, so a missing property and a
// property in another brokerage stay distinguishable without a second
// query. Increment only for the latter. The other brokerage's id is not
// logged or returned; the caller still answers 404 either way.
async function propertyInBrokerage(propertyId: number, brokerageId: number): Promise<boolean> {
  const [property] = await db.select().from(properties).where(eq(properties.id, propertyId));
  if (!property) return false;
  if (property.brokerageId !== brokerageId) {
    incrementCounter("tenant_isolation_rejection_total", { boundary: "transaction" });
    return false;
  }
  return true;
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
  // Owner t170u (3): transaction-level permissions. An Agent who is not this
  // property's listing agent gets the same 404 as the property and offer
  // routes (lib/propertyVisibility own-property rule). Brokerage
  // Administrator and Pit Crew pass; the purchase price is then shaped per
  // caller by lib/transactionPriceAccess.
  if (await propertyHiddenFromCaller(user, transaction.propertyId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

transactionsRouter.get("/by-property/:propertyId", requireAuth, requiresRunAccess, async (req, res) => {
  const propertyId = readIdParam(res, req.params.propertyId, "property");
  if (propertyId === null) return;
  const user = req.authedUser!;
  if (!(await propertyInBrokerage(propertyId, user.brokerageId)) || (await propertyHiddenFromCaller(user, propertyId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const transaction = await getTransactionByProperty(propertyId);
  res.json(await transactionRead(transaction, user, "GET /transactions/by-property/:propertyId"));
});

transactionsRouter.get("/:id", requireAuth, requiresRunAccess, requireTransactionAccess, async (req, res) => {
  const id = accessCheckedTransactionId(req);
  const [transaction] = await db.select().from(transactions).where(eq(transactions.id, id));
  res.json(await transactionRead(transaction, user_(req), "GET /transactions/:id"));
});

/**
 * R-F37 funds sibling, plus the R-F42 closure blockers `closeTransaction`
 * would report. `closureBlockers` is null when there is no transaction.
 * `closureBlockerDetails` is the same list with stable codes and ids.
 * The transaction object itself is unchanged. Close still returns the
 * string list on 409 and does not return the details. This read does not close.
 */
async function transactionRead(transaction: Transaction | null | undefined, user: AuthedUser, surface: string) {
  const closure = transaction ? await readTransactionClosureBlockers(transaction) : null;
  const view = transaction ? await transactionViewFor(user, transaction, surface) : transaction;
  return {
    // Owner t170u/t172u: never the raw row; confidential financial groups
    // only for the listing agent, Brokerage Administrators and Pit Crew with
    // an active assignment on this transaction (lib/transactionPriceAccess).
    transaction: view,
    // t171u/t172u: the reconciliation is derived from commission + GST and funds,
    // so it is withheld whenever the funds group is.
    fundsReconciliation: transaction && view && view.financialVisibility.funds ? computeFundsReconciliation(transaction) : null,
    closureBlockers: closure ? closure.closureBlockers : null,
    closureBlockerDetails: closure ? closure.closureBlockerDetails : null,
  };
}

function user_(req: Request): AuthedUser {
  return req.authedUser!;
}

async function handle(fn: () => Promise<Transaction>, res: Response, req: Request): Promise<void> {
  try {
    const transaction = await fn();
    res.json({ transaction: await transactionViewFor(user_(req), transaction, `${req.method} ${req.baseUrl}${req.route?.path ?? ""}`) });
  } catch (err) {
    if (err instanceof TransactionClosureBlockedError) {
      res.status(409).json({ error: err.message, blockers: err.blockers });
      return;
    }
    handleTransactionError(err, res);
  }
}

transactionsRouter.post("/:id/contract-signed", requireAuth, requiresRunAccess, requireTransactionAccess, async (req, res) => {
  const id = accessCheckedTransactionId(req);
  const user = req.authedUser!;
  await handle(() => recordContractSigned({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res, req);
});

transactionsRouter.post("/:id/finance-approved", requireAuth, requiresRunAccess, requireTransactionAccess, async (req, res) => {
  const id = accessCheckedTransactionId(req);
  const user = req.authedUser!;
  await handle(() => recordFinanceApproved({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res, req);
});

const settlementScheduleSchema = z.object({ settlementDate: z.coerce.date() });

transactionsRouter.post("/:id/settlement-schedule", requireAuth, requiresRunAccess, requireTransactionAccess, async (req, res) => {
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
    req,
  );
});

// Settlement completion, commission calculation (including force) and
// funds-received recording are Brokerage Administrator sign-off, same
// precedent as agent-paid and close below. The role gate stays after
// requireTransactionAccess so another brokerage is still 404, and after
// requiresRunAccess so a missing run.access is still the entitlement 403.
// No new force flag: completeSettlement's existing prerequisites still
// run, and the automatic commission calculation inside that function is
// unchanged (it runs as part of the administrator's settlement action).
//
// Denial audit is local to these three routes. requireRole itself is
// unchanged, so agent-paid and close keep their existing bare 403.
// Action names follow the snake_case `*_denied` audit convention
// (grow_call_destination_binding_denied and the rest). There is no role
// or reason column on audit_logs; actorRole and ROLE_NOT_PERMITTED live
// in updatedValue, the same JSON-context slot those denial rows use.
// Cross-brokerage writes nothing: requireTransactionAccess has already
// answered 404, and a denial row that stored the foreign transaction id
// would confirm that the row exists.
const ROLE_NOT_PERMITTED = "ROLE_NOT_PERMITTED";

function requireSettlementFundsAdmin(actionFor: (req: Request) => string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.authedUser;
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (BROKERAGE_ADMIN_ROLES.includes(user.role)) {
      next();
      return;
    }
    // logAudit's default path is best-effort: a failed insert is logged as
    // log_audit_failed and not rethrown. Strict mode is for consent writes
    // that must roll a source row back with the audit. A refusal has no
    // source write, so an audit failure must stay a 403 and must not call
    // next(). That is fail-closed on the action without turning the
    // refusal into a 500.
    await logAudit({
      brokerageId: user.brokerageId,
      userId: user.id,
      action: actionFor(req),
      recordType: "transaction",
      recordId: String(accessCheckedTransactionId(req)),
      updatedValue: JSON.stringify({ actorRole: user.role, reason: ROLE_NOT_PERMITTED }),
    });
    res.status(403).json({ error: "Forbidden" });
  };
}

function commissionDenialAction(req: Request): string {
  // Classify the attempt only. The request body, including any amount, is
  // not stored.
  return req.body?.force === true ? "commission_calculation_force_denied" : "commission_calculation_denied";
}

transactionsRouter.post(
  "/:id/settlement-complete",
  requireAuth,
  requiresRunAccess,
  requireTransactionAccess,
  requireSettlementFundsAdmin(() => "settlement_complete_denied"),
  async (req, res) => {
    const id = accessCheckedTransactionId(req);
    const user = req.authedUser!;
    await handle(() => completeSettlement({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res, req);
  },
);

transactionsRouter.post(
  "/:id/calculate-commission",
  requireAuth,
  requiresRunAccess,
  requireTransactionAccess,
  requireSettlementFundsAdmin(commissionDenialAction),
  async (req, res) => {
    const id = accessCheckedTransactionId(req);
    const user = req.authedUser!;
    await handle(
      () => calculateCommission({ transactionId: id, userId: user.id, brokerageId: user.brokerageId, force: req.body?.force === true }),
      res,
      req,
    );
  },
);

const fundsReceivedSchema = z.object({ amountCents: z.number().int().positive() });

transactionsRouter.post(
  "/:id/funds-received",
  requireAuth,
  requiresRunAccess,
  requireTransactionAccess,
  requireSettlementFundsAdmin(() => "funds_received_denied"),
  async (req, res) => {
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
      req,
    );
  },
);

// Financial disbursement sign-off — restricted to Brokerage Administrators,
// same precedent as refunds (Phase 6) and AML exception resolution (Phase 4).
transactionsRouter.post(
  "/:id/agent-paid",
  requireAuth,
  requiresRunAccess,
  requireTransactionAccess,
  requireRole(...BROKERAGE_ADMIN_ROLES),
  async (req, res) => {
    const id = accessCheckedTransactionId(req);
    const user = req.authedUser!;
    await handle(() => recordAgentPaid({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res, req);
  },
);

// Final sign-off — same Brokerage Administrator gate as agent-paid above.
// #121 / R-F42: closeTransaction enforces unconditional status, resolved
// conditions, buyer and seller AML, no open attention items, and the
// must-finish automation tasks, plus commission, funds, FIN02, and a
// detectable commission discrepancy. `force: true` stays a deliberate,
// audited override, never the default.
transactionsRouter.post(
  "/:id/close",
  requireAuth,
  requiresRunAccess,
  requireTransactionAccess,
  requireRole(...BROKERAGE_ADMIN_ROLES),
  async (req, res) => {
    const id = accessCheckedTransactionId(req);
    const user = req.authedUser!;
    const force = req.body?.force === true;
    await handle(() => closeTransaction({ transactionId: id, userId: user.id, brokerageId: user.brokerageId, force }), res, req);
  },
);

// --- Stage E: Contract & Conditions (#118) ---

transactionsRouter.get("/:id/conditions", requireAuth, requiresRunAccess, requireTransactionAccess, async (req, res) => {
  const id = accessCheckedTransactionId(req);
  const conditions = await listConditions(id);
  res.json({ conditions });
});

const addConditionSchema = z.object({ description: z.string().min(1), dueDate: z.coerce.date().optional() });

transactionsRouter.post("/:id/conditions", requireAuth, requiresRunAccess, requireTransactionAccess, async (req, res) => {
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
transactionsRouter.post("/conditions/:conditionId/reschedule", requireAuth, requiresRunAccess, async (req, res) => {
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

transactionsRouter.post("/conditions/:conditionId/resolve", requireAuth, requiresRunAccess, async (req, res) => {
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

transactionsRouter.post("/:id/exchange", requireAuth, requiresRunAccess, requireTransactionAccess, async (req, res) => {
  const id = accessCheckedTransactionId(req);
  const user = req.authedUser!;
  await handle(() => recordExchange({ transactionId: id, userId: user.id, brokerageId: user.brokerageId }), res, req);
});

transactionsRouter.post("/:id/unconditional", requireAuth, requiresRunAccess, requireTransactionAccess, async (req, res) => {
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
    res.json({ transaction: await transactionViewFor(user, transaction, "POST /transactions/:id/unconditional") });
  } catch (err) {
    handleTransactionError(err, res);
  }
});

// --- Stage D/F: legal representatives (#117) ---

const legalRepsSchema = z.object({
  sellerSolicitorPartyId: z.number().int().optional().nullable(),
  buyerSolicitorPartyId: z.number().int().optional().nullable(),
});

transactionsRouter.post("/:id/legal-representatives", requireAuth, requiresRunAccess, requireTransactionAccess, async (req, res) => {
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
    req,
  );
});
