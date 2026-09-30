import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, growOpportunitySignals, properties, propertyExternalIdentifiers } from "@aee/db";
import { logger } from "@aee/events";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES, type AuthedUser } from "../middlewares/auth.js";
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
import { assertPropertyVisibleForWrite, propertyHiddenFromCaller, restrictedPropertyIdsFor } from "../lib/propertyVisibility.js";

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

/** A row already known to be in this brokerage, linked to a property the
 * caller cannot see. Null property ids (contact-anchored signals) are not
 * hidden. A missing row is left to the service, which already 404s. */
async function linkedWriteHidden(user: AuthedUser, propertyId: number | null): Promise<boolean> {
  return !(await assertPropertyVisibleForWrite(user, propertyId));
}

async function signalWriteHidden(user: AuthedUser, signalId: number): Promise<boolean> {
  const [row] = await db
    .select({ propertyId: growOpportunitySignals.propertyId })
    .from(growOpportunitySignals)
    .where(and(eq(growOpportunitySignals.id, signalId), eq(growOpportunitySignals.brokerageId, user.brokerageId)))
    .limit(1);
  if (!row) return false;
  return linkedWriteHidden(user, row.propertyId);
}

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
    // After the brokerage check inside the summary, so a foreign-tenant id
    // still 404s as "Property not found" and records the isolation rejection.
    // A same-brokerage property the caller cannot see uses that same 404.
    if (await propertyHiddenFromCaller(user, propertyId)) {
      res.status(404).json({ error: "Property not found" });
      return;
    }
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
    // W2-D: the response gained `contactAnchoredSignals`,
    // `unusableSignalCount` and `outreachRestriction` alongside the existing
    // `properties` key, which is unchanged — so an older client keeps reading
    // exactly what it read before and simply does not render the new sections.
    //
    // AN OLDER CLIENT IGNORING `outreachRestriction` IS SAFE, and that is a
    // property of the payload rather than a hope about clients: this response
    // contains no email address, no phone number, no destination and no
    // channel action for ANY contact, restricted or not. There is nothing in
    // it a client could turn into outreach whether it honours the field or
    // not. The restriction is for HONEST DISPLAY; the actual enforcement is
    // that no affordance exists here to enforce against, plus promoteSignal()
    // refusing below. See __tests__/contactabilityOutreachPathway.test.ts,
    // which asserts the payload shape field by field.
    const summary = await getContactPropertyIntelligenceSummary(partyId, user.brokerageId);
    // The contact stays. Property entries (relationship or signal-only) for
    // a property this caller cannot see are left out. Contact-anchored
    // signals have no property and stay.
    const restrictTo = await restrictedPropertyIdsFor(user);
    if (restrictTo !== null) {
      const allowed = new Set(restrictTo);
      summary.properties = summary.properties.filter((entry) => allowed.has(entry.propertyId));
    }
    res.json(summary);
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
    // listMatchesForProperty 404s a foreign property (and records the
    // isolation rejection) before this. A same-brokerage property the
    // caller cannot see uses that same 404 and returns no matches.
    if (await propertyHiddenFromCaller(user, propertyId)) {
      res.status(404).json({ error: "Property not found" });
      return;
    }
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
    if (await propertyHiddenFromCaller(user, propertyId)) {
      res.status(404).json({ error: "Property not found" });
      return;
    }
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
  const [matchRow] = await db
    .select({ propertyId: propertyExternalIdentifiers.propertyId })
    .from(propertyExternalIdentifiers)
    .where(and(eq(propertyExternalIdentifiers.id, identifierId), eq(propertyExternalIdentifiers.brokerageId, user.brokerageId)))
    .limit(1);
  if (matchRow && (await linkedWriteHidden(user, matchRow.propertyId))) {
    res.status(404).json({ error: "Match not found" });
    return;
  }
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
  const [matchRow] = await db
    .select({ propertyId: propertyExternalIdentifiers.propertyId })
    .from(propertyExternalIdentifiers)
    .where(and(eq(propertyExternalIdentifiers.id, identifierId), eq(propertyExternalIdentifiers.brokerageId, user.brokerageId)))
    .limit(1);
  if (matchRow && (await linkedWriteHidden(user, matchRow.propertyId))) {
    res.status(404).json({ error: "Match not found" });
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
  if (await signalWriteHidden(user, signalId)) {
    res.status(404).json({ error: "Signal not found" });
    return;
  }
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
  if (await signalWriteHidden(user, signalId)) {
    res.status(404).json({ error: "Signal not found" });
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
  if (await signalWriteHidden(user, signalId)) {
    res.status(404).json({ error: "Signal not found" });
    return;
  }
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
  // A property outside this brokerage is left to recalculate, which already
  // 404s. A same-brokerage property the caller cannot see is that same 404
  // and is not recalculated.
  if (!(await assertPropertyVisibleForWrite(user, propertyId))) {
    const [property] = await db
      .select({ id: properties.id })
      .from(properties)
      .where(and(eq(properties.id, propertyId), eq(properties.brokerageId, user.brokerageId)))
      .limit(1);
    if (property) {
      res.status(404).json({ error: "Property not found" });
      return;
    }
  }
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
