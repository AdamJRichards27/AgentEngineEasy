// Agent Engine 2.0 — Exception & Risk Engine (Priority 4).
//
// HTTP surface over the exception engine. Every handler re-derives
// brokerageId (and, for property-scoped routes, verifies property
// membership) from req.authedUser — never from a client-supplied tenant id
// — mirroring routes/properties.ts's #123 tenant-scoping fix. Financial
// visibility reuses middlewares/auth.ts's own BROKERAGE_ADMIN_ROLES —
// exactly the boolean timeline.ts's own getPropertyTimeline() callers
// already compute from it — rather than a second definition of who counts
// as financially entitled (Build Instructions §4/§20).
//
// Lifecycle mutation routes never accept severity/status/resolution
// directly from the client body beyond the specific, narrow fields each
// action legitimately takes (a note, a reason, a reassignment target) —
// model.ts's own functions are the only place a status transition is
// decided, and they re-validate the current status themselves before
// allowing it (Build Instructions §21: "never trust client-supplied ...
// severity/resolution info").

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db, riskExceptionScanRuns, riskExceptions } from "@aee/db";
import { desc, eq } from "drizzle-orm";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES, type AuthedUser } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { restrictedPropertyIdsFor } from "../lib/propertyVisibility.js";
import {
  acknowledgeException,
  assertPropertyInBrokerage,
  startRemediation,
  markAwaitingExternal,
  resolveExceptionManually,
  dismissException,
  reassignOwner,
  RiskExceptionError,
  type ActorRef,
} from "../lib/exceptions/model.js";
import { getPropertyExceptions, listBrokerageExceptions, getExceptionDetail, type CrossPropertyExceptionFilters } from "../lib/exceptions/queries.js";
import { runScheduledScan } from "../lib/exceptions/engine.js";

// Re-exported so Command Centre and its tests keep importing the same helper
// from this module. The rule itself lives in lib/propertyVisibility.ts.
export { restrictedPropertyIdsFor };

export const exceptionsRouter = Router();

function actorFrom(user: AuthedUser): ActorRef {
  return { id: user.id, role: user.role };
}

export function canViewFinancials(user: AuthedUser): boolean {
  return BROKERAGE_ADMIN_ROLES.includes(user.role);
}

// R-F43 — exception reads and lifecycle mutations are a Run surface, the
// same as Launch, AML, Documents, Ready to List, and Go Live (R-F35b).
// The check is requireEntitlement("run.access"): an unentitled caller gets
// that helper's existing 403 and the handler does not run. Brokerage
// membership is answered first, matching R-F41, so another brokerage stays
// the existing 404 (the same body as a missing id) even when that caller
// has no run.access. Applied inside the handler, not via Router.use() —
// this router is mounted unprefixed. Ops health and the manual scan do
// not operate on a transaction or a property and stay role-gated only.
const requiresRunAccess = requireEntitlement("run.access");

async function callerHasRunAccess(req: Request, res: Response): Promise<boolean> {
  let allowed = false;
  await requiresRunAccess(req, res, () => {
    allowed = true;
  });
  return allowed;
}

type MissingExceptionBody = "detail" | "mutation";

function respondMissingException(res: Response, kind: MissingExceptionBody): void {
  if (kind === "detail") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(404).json({ error: "Exception not found", reason: "NOT_FOUND" });
}

/** False when the response is already sent (404 or the entitlement 403). */
async function allowExceptionInBrokerage(
  req: Request,
  res: Response,
  exceptionId: string,
  brokerageId: number,
  missing: MissingExceptionBody,
): Promise<boolean> {
  // Same lookup as assertTenantAndLoad: id only, then compare brokerage, so
  // a missing id and another brokerage stay indistinguishable.
  const [row] = await db
    .select({ brokerageId: riskExceptions.brokerageId })
    .from(riskExceptions)
    .where(eq(riskExceptions.id, exceptionId));
  if (!row || row.brokerageId !== brokerageId) {
    respondMissingException(res, missing);
    return false;
  }
  return callerHasRunAccess(req, res);
}

/** False when the response is already sent (property 404 or the entitlement 403). */
async function allowPropertyInBrokerage(req: Request, res: Response, propertyId: number, brokerageId: number): Promise<boolean> {
  try {
    await assertPropertyInBrokerage(propertyId, brokerageId);
  } catch (err) {
    if (handleRiskExceptionError(err, res)) return false;
    throw err;
  }
  return callerHasRunAccess(req, res);
}

function statusForRiskExceptionError(reason: string): number {
  switch (reason) {
    case "NOT_FOUND":
      return 404;
    case "INVALID_STATUS":
    case "REQUIRES_AUTHORITATIVE_EVIDENCE":
    case "NOT_DISMISSIBLE":
      return 409;
    default:
      return 400;
  }
}

function handleRiskExceptionError(err: unknown, res: import("express").Response): boolean {
  if (err instanceof RiskExceptionError) {
    res.status(statusForRiskExceptionError(err.reason)).json({ error: err.message, reason: err.reason });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------

const listFiltersSchema = z.object({
  status: z.string().optional(),
  severity: z.string().optional(),
  category: z.string().optional(),
});

exceptionsRouter.get("/properties/:propertyId/exceptions", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const user = req.authedUser!;
  const parsed = listFiltersSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (!(await allowPropertyInBrokerage(req, res, propertyId, user.brokerageId))) return;
  try {
    const result = await getPropertyExceptions(propertyId, user.brokerageId, canViewFinancials(user), {
      status: parsed.data.status?.split(","),
      severity: parsed.data.severity?.split(","),
      category: parsed.data.category?.split(","),
    });
    res.json(result);
  } catch (err) {
    if (handleRiskExceptionError(err, res)) return;
    throw err;
  }
});

const crossPropertyQuerySchema = z.object({
  status: z.string().optional(),
  severity: z.string().optional(),
  category: z.string().optional(),
  ownerUserId: z.coerce.number().int().optional(),
  propertyId: z.coerce.number().int().optional(),
  overdueOnly: z.coerce.boolean().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

// Cross-property operational view (§18) — a foundation for, and explicitly
// NOT itself, the future Agent Daily Command Centre / Brokerage Dashboard.
exceptionsRouter.get("/exceptions", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const parsed = crossPropertyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (!(await callerHasRunAccess(req, res))) return;
  const restrictTo = await restrictedPropertyIdsFor(user);
  const filters: CrossPropertyExceptionFilters = {
    status: parsed.data.status?.split(","),
    severity: parsed.data.severity?.split(","),
    category: parsed.data.category?.split(","),
    ownerUserId: parsed.data.ownerUserId,
    propertyId: parsed.data.propertyId,
    overdueOnly: parsed.data.overdueOnly,
    search: parsed.data.search,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
  };
  const result = await listBrokerageExceptions(user.brokerageId, canViewFinancials(user), restrictTo, filters);
  res.json(result);
});

exceptionsRouter.get("/exceptions/:id", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  if (!(await allowExceptionInBrokerage(req, res, req.params.id, user.brokerageId, "detail"))) return;
  const result = await getExceptionDetail(req.params.id, user.brokerageId, canViewFinancials(user));
  // Deliberately identical 404 whether the row doesn't exist, belongs to
  // another tenant, or is financially redacted (Build Instructions §21:
  // "cross-tenant requests must not reveal whether the exception exists").
  if (!result) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(result);
});

// ---------------------------------------------------------------------
// Lifecycle mutations.
// ---------------------------------------------------------------------

exceptionsRouter.post("/exceptions/:id/acknowledge", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  if (!(await allowExceptionInBrokerage(req, res, req.params.id, user.brokerageId, "mutation"))) return;
  try {
    const exception = await acknowledgeException(req.params.id, user.brokerageId, actorFrom(user));
    res.json({ exception });
  } catch (err) {
    if (handleRiskExceptionError(err, res)) return;
    throw err;
  }
});

exceptionsRouter.post("/exceptions/:id/start-remediation", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  if (!(await allowExceptionInBrokerage(req, res, req.params.id, user.brokerageId, "mutation"))) return;
  try {
    const exception = await startRemediation(req.params.id, user.brokerageId, actorFrom(user));
    res.json({ exception });
  } catch (err) {
    if (handleRiskExceptionError(err, res)) return;
    throw err;
  }
});

const noteSchema = z.object({ note: z.string().min(1).max(2000) });

exceptionsRouter.post("/exceptions/:id/awaiting-external", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  if (!(await allowExceptionInBrokerage(req, res, req.params.id, user.brokerageId, "mutation"))) return;
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const exception = await markAwaitingExternal(req.params.id, user.brokerageId, actorFrom(user), parsed.data.note);
    res.json({ exception });
  } catch (err) {
    if (handleRiskExceptionError(err, res)) return;
    throw err;
  }
});

exceptionsRouter.post("/exceptions/:id/resolve", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  if (!(await allowExceptionInBrokerage(req, res, req.params.id, user.brokerageId, "mutation"))) return;
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const exception = await resolveExceptionManually(req.params.id, user.brokerageId, actorFrom(user), parsed.data.note);
    res.json({ exception });
  } catch (err) {
    if (handleRiskExceptionError(err, res)) return;
    throw err;
  }
});

const dismissSchema = z.object({ reason: z.string().min(1).max(2000) });

exceptionsRouter.post("/exceptions/:id/dismiss", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  if (!(await allowExceptionInBrokerage(req, res, req.params.id, user.brokerageId, "mutation"))) return;
  const parsed = dismissSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const exception = await dismissException(req.params.id, user.brokerageId, actorFrom(user), parsed.data.reason);
    res.json({ exception });
  } catch (err) {
    if (handleRiskExceptionError(err, res)) return;
    throw err;
  }
});

const reassignSchema = z.object({
  ownerType: z.enum(["LISTING_AGENT", "TRANSACTION_OWNER", "BROKERAGE_ADMINISTRATOR", "PIT_CREW", "UNASSIGNED_QUEUE"]),
  ownerUserId: z.number().int().nullable(),
  reason: z.string().min(1).max(2000),
});

exceptionsRouter.post("/exceptions/:id/reassign", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  if (!(await allowExceptionInBrokerage(req, res, req.params.id, user.brokerageId, "mutation"))) return;
  const parsed = reassignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const exception = await reassignOwner(req.params.id, user.brokerageId, actorFrom(user), parsed.data.ownerType, parsed.data.ownerUserId, parsed.data.reason);
    res.json({ exception });
  } catch (err) {
    if (handleRiskExceptionError(err, res)) return;
    throw err;
  }
});

// ---------------------------------------------------------------------
// Ops — health + manual scan trigger, mirroring automationOps.ts's own
// admin-gated pattern (requireRole, same as that router). Brokerage
// Administrator only: this is operational tooling for the engine itself,
// not a per-property action.
// ---------------------------------------------------------------------

exceptionsRouter.get("/exceptions/ops/health", requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), async (_req, res) => {
  const recentRuns = await db.select().from(riskExceptionScanRuns).orderBy(desc(riskExceptionScanRuns.startedAt)).limit(5);
  res.json({ recentRuns });
});

exceptionsRouter.post("/exceptions/ops/scan", requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), async (_req, res) => {
  const result = await runScheduledScan("MANUAL");
  if (!result.ok) {
    res.status(409).json({ error: result.skippedReason });
    return;
  }
  res.json({ summary: result.summary });
});
