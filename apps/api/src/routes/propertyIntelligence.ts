import { Router } from "express";
import { z } from "zod";
import { logger } from "@aee/events";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { countActiveSignals, getSweepOpsHealth, runSignalSweep } from "../lib/propertyIntelligence/sweep.js";
import {
  PropertyIntelligenceAccessError,
  PropertyIntelligenceTransitionError,
  getPropertyIntelligenceSummary,
  getContactPropertyIntelligenceSummary,
  listMatchesForProperty,
  confirmMatch,
  rejectMatch,
  listSignalsForProperty,
  reviewSignal,
  dismissSignal,
  promoteSignal,
  recalculateSignalsForProperty,
} from "../lib/propertyIntelligence/service.js";

/**
 * AE GROW Priority 5 Remediation — the Property Intelligence API the
 * merged Priority 5 report described but never actually shipped (see
 * docs/AE_GROW_PRIORITY_5_APPLICATION_LAYER_REMEDIATION.md). Follows the
 * exact conventions established by routes/growAppraisals.ts: requireAuth
 * on every route, requireEntitlement("grow.propertyIntelligence.read") for
 * every GET, requireEntitlement("grow.propertyIntelligence.manage") for
 * every state-changing POST, tenant re-scoping inside the service layer
 * itself (never trusted from req params alone), and a shared typed-error
 * mapper mirroring handleGrowAppraisalError.
 */
export const propertyIntelligenceRouter = Router();

const requireRead = requireEntitlement("grow.propertyIntelligence.read");
const requireManage = requireEntitlement("grow.propertyIntelligence.manage");

// Route-id validation, the same bounded guard routes/grow.ts,
// routes/communications.ts and routes/growAppraisals.ts use (each keeps its
// own local copy; this is deliberately not a shared module). Every route
// below took a raw `Number(req.params...)` and handed it straight to a
// Drizzle bind, so `GET /grow/property-intelligence/contact/abc` reached
// Postgres as NaN and came back as a 400 whose body was the driver's own
// "Failed query: select ..." text — internal schema detail returned to any
// authenticated caller. Bounded by MAX_SIGNED_INT4 because every id these
// routes resolve is a `serial` column, i.e. int4.
const MAX_SIGNED_INT4 = 2_147_483_647;

function parsePositiveId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 && n <= MAX_SIGNED_INT4 ? n : null;
}

/** Resolves a route id, answering 400 itself and returning null when malformed. */
function readIdParam(
  res: import("express").Response,
  value: unknown,
  label: "property" | "contact" | "match" | "signal",
): number | null {
  const id = parsePositiveId(value);
  if (id === null) {
    res.status(400).json({ error: `Invalid ${label} id` });
    return null;
  }
  return id;
}

/** What an unrecognised error is allowed to tell a client. */
const GENERIC_PROPERTY_INTELLIGENCE_ERROR =
  "An unexpected error occurred. Please try again or contact support if the problem persists.";

function handlePropertyIntelligenceError(err: unknown, res: import("express").Response): void {
  if (err instanceof PropertyIntelligenceAccessError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof PropertyIntelligenceTransitionError) {
    res.status(409).json({ error: err.message });
    return;
  }
  // Anything else is an unrecognised server fault, not one of this feature's
  // expected client-facing errors. `(err as Error).message` was returning the
  // Postgres driver's "Failed query: select ..." text (table and column names
  // included) to the caller, as a 400. The typed branches above keep their own
  // user-facing messages; this one never does.
  logger.error("property_intelligence_route_unhandled_error", {
    error: err instanceof Error ? err.message : String(err),
    errorName: err instanceof Error ? err.name : typeof err,
  });
  res.status(500).json({ error: GENERIC_PROPERTY_INTELLIGENCE_ERROR });
}

/* ---------------------------------------------------------------------
 * Reads.
 * -----------------------------------------------------------------*/

propertyIntelligenceRouter.get("/property/:propertyId", requireAuth, requireRead, async (req, res) => {
  const user = req.authedUser!;
  const propertyId = readIdParam(res, req.params.propertyId, "property");
  if (propertyId === null) return;
  try {
    const summary = await getPropertyIntelligenceSummary(propertyId, user.brokerageId);
    res.json(summary);
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

propertyIntelligenceRouter.get("/contact/:partyId", requireAuth, requireRead, async (req, res) => {
  const user = req.authedUser!;
  const partyId = readIdParam(res, req.params.partyId, "contact");
  if (partyId === null) return;
  try {
    const entries = await getContactPropertyIntelligenceSummary(partyId, user.brokerageId);
    res.json({ properties: entries });
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

const matchQuerySchema = z.object({ status: z.enum(["PendingReview", "Confirmed", "Rejected"]).optional() });

propertyIntelligenceRouter.get("/property/:propertyId/matches", requireAuth, requireRead, async (req, res) => {
  const user = req.authedUser!;
  const propertyId = readIdParam(res, req.params.propertyId, "property");
  if (propertyId === null) return;
  const parsed = matchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const matches = await listMatchesForProperty(propertyId, user.brokerageId, parsed.data.status);
    res.json({ matches });
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

const signalQuerySchema = z.object({ status: z.enum(["Active", "Reviewed", "Dismissed", "Expired", "Superseded"]).optional() });

propertyIntelligenceRouter.get("/property/:propertyId/signals", requireAuth, requireRead, async (req, res) => {
  const user = req.authedUser!;
  const propertyId = readIdParam(res, req.params.propertyId, "property");
  if (propertyId === null) return;
  const parsed = signalQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const signals = await listSignalsForProperty(propertyId, user.brokerageId, parsed.data.status);
    res.json({ signals });
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

/* ---------------------------------------------------------------------
 * Match review — requires grow.propertyIntelligence.manage.
 * -----------------------------------------------------------------*/

propertyIntelligenceRouter.post("/matches/:identifierId/confirm", requireAuth, requireManage, async (req, res) => {
  const user = req.authedUser!;
  const identifierId = readIdParam(res, req.params.identifierId, "match");
  if (identifierId === null) return;
  try {
    const match = await confirmMatch({ identifierId, brokerageId: user.brokerageId, userId: user.id });
    res.json({ match });
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

const rejectMatchSchema = z.object({ rejectedReason: z.string().nullable().optional() });

propertyIntelligenceRouter.post("/matches/:identifierId/reject", requireAuth, requireManage, async (req, res) => {
  const user = req.authedUser!;
  const identifierId = readIdParam(res, req.params.identifierId, "match");
  if (identifierId === null) return;
  const parsed = rejectMatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const match = await rejectMatch({ identifierId, brokerageId: user.brokerageId, userId: user.id, rejectedReason: parsed.data.rejectedReason });
    res.json({ match });
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

/* ---------------------------------------------------------------------
 * Signal review/dismiss/promote — requires grow.propertyIntelligence.manage.
 * -----------------------------------------------------------------*/

propertyIntelligenceRouter.post("/signals/:signalId/review", requireAuth, requireManage, async (req, res) => {
  const user = req.authedUser!;
  const signalId = readIdParam(res, req.params.signalId, "signal");
  if (signalId === null) return;
  try {
    const signal = await reviewSignal({ signalId, brokerageId: user.brokerageId, userId: user.id });
    res.json({ signal });
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

const dismissSignalSchema = z.object({ dismissedReason: z.string().min(1) });

propertyIntelligenceRouter.post("/signals/:signalId/dismiss", requireAuth, requireManage, async (req, res) => {
  const user = req.authedUser!;
  const signalId = readIdParam(res, req.params.signalId, "signal");
  if (signalId === null) return;
  const parsed = dismissSignalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const signal = await dismissSignal({ signalId, brokerageId: user.brokerageId, userId: user.id, dismissedReason: parsed.data.dismissedReason });
    res.json({ signal });
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

propertyIntelligenceRouter.post("/signals/:signalId/promote", requireAuth, requireManage, async (req, res) => {
  const user = req.authedUser!;
  const signalId = readIdParam(res, req.params.signalId, "signal");
  if (signalId === null) return;
  try {
    const result = await promoteSignal({ signalId, brokerageId: user.brokerageId, userId: user.id });
    res.json(result);
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

/* ---------------------------------------------------------------------
 * Recalculation — safe to call repeatedly (idempotent, mock-only, no
 * external provider call of its own). Requires manage, matching every
 * other state-changing route above.
 * -----------------------------------------------------------------*/

propertyIntelligenceRouter.post("/property/:propertyId/recalculate", requireAuth, requireManage, async (req, res) => {
  const user = req.authedUser!;
  const propertyId = readIdParam(res, req.params.propertyId, "property");
  if (propertyId === null) return;
  try {
    const signals = await recalculateSignalsForProperty(propertyId, user.brokerageId);
    res.json({ signals });
  } catch (err) {
    handlePropertyIntelligenceError(err, res);
  }
});

/* ---------------------------------------------------------------------
 * Ops — Brokerage-wide Signal Sweep operability (AE GROW Completion W1-D,
 * H-2/H-3). Mirrors routes/exceptions.ts's `/exceptions/ops/*` pair and
 * automationOps.ts, verbatim in shape.
 *
 * WHY requireRole AND NOT requireEntitlement, when every other route in this
 * file uses entitlements. Entitlements gate a per-brokerage PRODUCT
 * capability ("does this tenant's plan include Property Intelligence?"). This
 * is ENGINE OPERATIONS: whether a background job on this deployment is alive.
 * Two consequences follow, and both are the point:
 *   - The health payload is engine-wide, not tenant-scoped. Run rows carry
 *     counters and ids only, never tenant data, but an Agent still has no
 *     business reading another brokerage's run bookkeeping — so this is
 *     Brokerage Administrator only and an Agent gets 403.
 *   - Pit Crew is deliberately excluded. Pit Crew is DELEGATED TRANSACTION
 *     operations, not platform operations; BROKERAGE_ADMIN_ROLES does not
 *     include it, so Pit Crew gets 403 too.
 * This is proceeding BA-only with the Project Owner informed, and may be
 * reversed to an entitlement later without changing anything below except
 * these two middlewares.
 *
 * No admin UI ships with this — an authenticated API surface is sufficient,
 * exactly as the Project Owner directed.
 * -----------------------------------------------------------------*/

const requireOps = [requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES)] as const;

/**
 * Last run, success/failure, `truncated`, `errors`, staleness, how many
 * brokerages are due, and whether the scheduler is switched on at all. Before
 * this endpoint every one of those existed as a durable row that nothing could
 * read over HTTP, and GROW_SIGNAL_SWEEP_ENABLED=false was indistinguishable
 * from a healthy-but-idle system after the single boot log line.
 */
propertyIntelligenceRouter.get("/ops/health", ...requireOps, async (_req, res) => {
  const health = await getSweepOpsHealth();
  res.json(health);
});

/**
 * Manual trigger. This is what lets an operator recover from a stale or
 * wedged sweep without a deploy — the gap that made the ops surface a P1.
 *
 * 409 + skippedReason when the single-flight advisory lock is held, matching
 * POST /exceptions/ops/scan exactly. That refusal is the production contract
 * for an overlapping trigger, not an error: the sweep is already running.
 */
propertyIntelligenceRouter.post("/ops/sweep", ...requireOps, async (_req, res) => {
  const result = await runSignalSweep("MANUAL");
  if (!result.ok) {
    res.status(409).json({ error: result.skippedReason, skippedReason: result.skippedReason });
    return;
  }
  res.json({ summary: result.summary });
});

/**
 * Active signal count for the CALLER'S OWN brokerage. The brokerage id is
 * taken from the session and is never a route or query parameter, so this
 * route cannot be pointed at another tenant however it is called.
 */
propertyIntelligenceRouter.get("/ops/signals/count", ...requireOps, async (req, res) => {
  const user = req.authedUser!;
  const activeSignals = await countActiveSignals(user.brokerageId);
  res.json({ brokerageId: user.brokerageId, activeSignals });
});
