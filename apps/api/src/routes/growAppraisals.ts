import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, growOpportunities, parties, properties, propertyParties } from "@aee/db";
import { selectAppraisalForBrokerageProperty } from "../lib/appraisals.js";
import { logger } from "@aee/events";
import { requireAuth, type AuthedUser } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { AppraisalLifecycleClosedError, AppraisalPricingLockedError } from "../lib/appraisalFinaliseGuard.js";
import {
  AppraisalAccessError,
  AppraisalTransitionError,
  createAppraisalFromContact,
  createAppraisalFromOpportunity,
  getAppraisalWorkspace,
  updateAppraisalWorkspace,
  transitionAppraisalStatus,
  recordAppraisalOutcome,
  scheduleAppraisalFollowUp,
  listAppraisalPipeline,
} from "../lib/growAppraisals.js";
import {
  sendAppraisal,
  generateMarketPositionDraft,
  generateAppraisalPresentation,
  prepareAppraisalRunHandoff,
  addComparableSale,
  updateComparableSale,
  deleteComparableSale,
  addMarketCompetitionItem,
  updateMarketCompetitionItem,
  deleteMarketCompetitionItem,
} from "../lib/growAppraisalIntegrations.js";
import type { ComparableSaleInput, MarketCompetitionInput } from "../lib/growAppraisalIntegrations.js";
import { AiFeatureDisabledError, AiEntitlementError } from "../lib/ai/types.js";
import { AiDailyCapExceededError } from "../lib/ai/dailyUsage.js";
import { AiUsageLimitsNotConfiguredError } from "../lib/ai/usageLimits.js";
import { OutboundConsentRefused } from "../lib/communications/outboundConsent.js";
import {
  assertOwnedOrPropertyVisibleForWrite,
  assertPropertyVisibleForWrite,
  propertyHiddenFromCaller,
  restrictedPropertyIdsFor,
} from "../lib/propertyVisibility.js";

export const growAppraisalsRouter = Router();

// Route-id validation, the same bounded guard routes/grow.ts and
// routes/communications.ts already use (deliberately duplicated locally, as
// they duplicate it from each other, rather than introduced as a shared
// module). Every route below took a raw `Number(req.params.id)` and handed
// the result straight to a Drizzle bind, so a non-numeric id reached Postgres
// as NaN and an id past int4 reached it as an unbindable value — both a 500
// for what is an ordinary client error. Bounded by MAX_SIGNED_INT4 because
// every id these routes resolve is a `serial` column, i.e. int4.
const MAX_SIGNED_INT4 = 2_147_483_647;

function parsePositiveId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 && n <= MAX_SIGNED_INT4 ? n : null;
}

/**
 * Resolves a route id, answering 400 itself (in this router's existing
 * `{ error }` shape) and returning null when it is malformed — so each
 * handler's guard stays a single early-return line.
 */
function readIdParam(
  res: import("express").Response,
  value: unknown,
  label: "appraisal" | "comparable sale" | "market competition entry",
): number | null {
  const id = parsePositiveId(value);
  if (id === null) {
    res.status(400).json({ error: `Invalid ${label} id` });
    return null;
  }
  return id;
}

/** What an unrecognised error is allowed to tell a client. */
const GENERIC_APPRAISAL_ERROR = "An unexpected error occurred. Please try again or contact support if the problem persists.";

/** Maps this feature's typed errors to the same shape/status style the
 * rest of the API already uses (see routes/appraisals.ts, routes/ai.ts). */
function handleGrowAppraisalError(err: unknown, res: import("express").Response): void {
  if (err instanceof OutboundConsentRefused) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof AppraisalAccessError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof AppraisalPricingLockedError || err instanceof AppraisalLifecycleClosedError) {
    res.status(409).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof AppraisalTransitionError) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof AiFeatureDisabledError || err instanceof AiEntitlementError) {
    res.status(403).json({ error: err.message });
    return;
  }
  // market-position/generate goes through askCopilot(), so it shares the daily AI limits.
  if (err instanceof AiDailyCapExceededError) {
    res.status(429).json({ error: err.message });
    return;
  }
  // ... and the same fail-closed operator fault when a live AI provider is approved with no
  // configured allowance (lib/ai/usageLimits.ts). 503, not 500: the service is unavailable
  // until an operator configures it, and nothing about this request is wrong.
  if (err instanceof AiUsageLimitsNotConfiguredError) {
    logger.error("grow_appraisal_ai_usage_limits_unconfigured", { missing: err.missing, detail: err.message });
    res.status(503).json({ error: "AI is not available right now. An administrator has been notified.", code: "AI_USAGE_LIMITS_NOT_CONFIGURED" });
    return;
  }
  // Anything reaching here is NOT one of this feature's expected, typed,
  // client-facing errors — it is an unrecognised server fault (a bug, a
  // database error, a failing dependency). Returning `(err as Error).message`
  // both leaked internal detail (constraint names, SQL fragments, provider
  // messages) to any authenticated caller and mislabelled a server fault as a
  // client error. The typed branches above keep their own messages, which are
  // written for users; this one does not.
  logger.error("grow_appraisal_route_unhandled_error", {
    error: err instanceof Error ? err.message : String(err),
    errorName: err instanceof Error ? err.name : typeof err,
  });
  res.status(500).json({ error: GENERIC_APPRAISAL_ERROR });
}

const requiresRunAccess = requireEntitlement("run.access");
// WP1 P1-1: every Appraisal Workspace route is a Grow surface, so every route requires
// grow.access (checked before any work). Every mutating route additionally requires
// grow.opportunities.manage -- the same "manage" key Grow uses for its own opportunity
// pipeline writes (routes/grow.ts). /:id/run-handoff keeps run.access AND requires
// grow.access, because the Grow -> Run handoff originates in Grow.
const requiresGrowAccess = requireEntitlement("grow.access");
const requiresGrowManage = requireEntitlement("grow.opportunities.manage");

/**
 * True when this response has already been sent. A missing appraisal is left
 * to the mutation, which already 404s and records isolation. A same-brokerage
 * appraisal on a property the caller cannot see is that same 404, before any
 * write. Appraisal property ids are required, so there is no contact-level row.
 */
async function appraisalWriteBlocked(user: AuthedUser, appraisalId: number, res: import("express").Response): Promise<boolean> {
  try {
    const workspace = await getAppraisalWorkspace(appraisalId, user.brokerageId);
    if (!(await assertPropertyVisibleForWrite(user, workspace.appraisal.propertyId))) {
      res.status(404).json({ error: "Appraisal not found" });
      return true;
    }
    return false;
  } catch (err) {
    if (err instanceof AppraisalAccessError) return false;
    handleGrowAppraisalError(err, res);
    return true;
  }
}

/* ---------------------------------------------------------------------
 * Sec 7/8 -- Create from Contact 360 or from a Grow Opportunity.
 * -----------------------------------------------------------------*/
const createFromContactSchema = z.object({
  partyId: z.coerce.number().int().positive(),
  propertyId: z.coerce.number().int().positive(),
  /** D8 (SPEC-03, AB-5): "property" = started from a property via its
   * linked contact (AE Minimal). Opt-in so the existing Contact 360 path is
   * unchanged. */
  entry: z.enum(["property"]).optional(),
});

/** D8 server validation for property-entry creates. Returns true when it has
 * already answered. Order: tenant (404, no existence leak) -> link (422) ->
 * existing appraisal (409 with its id). */
async function rejectInvalidPropertyEntry(
  user: AuthedUser,
  input: { partyId: number; propertyId: number },
  res: import("express").Response,
): Promise<boolean> {
  const [property] = await db
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, input.propertyId), eq(properties.brokerageId, user.brokerageId)))
    .limit(1);
  if (!property || !(await assertPropertyVisibleForWrite(user, input.propertyId))) {
    res.status(404).json({ error: "Property not found" });
    return true;
  }
  const [party] = await db
    .select({ id: parties.id })
    .from(parties)
    .where(and(eq(parties.id, input.partyId), eq(parties.brokerageId, user.brokerageId)))
    .limit(1);
  if (!party) {
    res.status(404).json({ error: "Contact not found" });
    return true;
  }
  const [link] = await db
    .select({ id: propertyParties.id })
    .from(propertyParties)
    .where(and(eq(propertyParties.propertyId, input.propertyId), eq(propertyParties.partyId, input.partyId)))
    .limit(1);
  if (!link) {
    res.status(422).json({ error: "This contact is not linked to the property", code: "PROPERTY_CONTACT_NOT_LINKED" });
    return true;
  }
  const existing = await selectAppraisalForBrokerageProperty(input.propertyId, user.brokerageId);
  if (existing) {
    res.status(409).json({ error: "An appraisal already exists for this property", code: "APPRAISAL_EXISTS", appraisalId: existing.id });
    return true;
  }
  return false;
}

growAppraisalsRouter.post("/from-contact", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const user = req.authedUser!;
  const parsed = createFromContactSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  if (parsed.data.entry === "property" && (await rejectInvalidPropertyEntry(user, parsed.data, res))) return;
  const [property] = await db
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, parsed.data.propertyId), eq(properties.brokerageId, user.brokerageId)))
    .limit(1);
  // A property outside this brokerage keeps the existing create path (and its
  // isolation note). A same-brokerage property the caller cannot see is 404
  // before an appraisal is created or reused.
  if (property && !(await assertPropertyVisibleForWrite(user, parsed.data.propertyId))) {
    res.status(404).json({ error: "Property not found" });
    return;
  }
  try {
    const appraisal = await createAppraisalFromContact({
      partyId: parsed.data.partyId,
      propertyId: parsed.data.propertyId,
      brokerageId: user.brokerageId,
      userId: user.id,
    });
    res.status(201).json({ appraisal });
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

const createFromOpportunitySchema = z.object({
  opportunityId: z.coerce.number().int().positive(),
});

growAppraisalsRouter.post("/from-opportunity", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const user = req.authedUser!;
  const parsed = createFromOpportunitySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const [opportunity] = await db
    .select({ propertyId: growOpportunities.propertyId, ownerUserId: growOpportunities.ownerUserId })
    .from(growOpportunities)
    .where(and(eq(growOpportunities.id, parsed.data.opportunityId), eq(growOpportunities.brokerageId, user.brokerageId)))
    .limit(1);
  // Missing opportunities keep the existing 404 and isolation note. An
  // opportunity the caller owns that has no property stays on the existing
  // 409. One they cannot see — another agent's unlinked opportunity, or one
  // tied to a property outside their own-property set — is the same 404 as
  // a missing opportunity.
  if (opportunity && !(await assertOwnedOrPropertyVisibleForWrite(user, opportunity.propertyId, opportunity.ownerUserId))) {
    res.status(404).json({ error: "Opportunity not found" });
    return;
  }
  try {
    const appraisal = await createAppraisalFromOpportunity({
      opportunityId: parsed.data.opportunityId,
      brokerageId: user.brokerageId,
      userId: user.id,
    });
    res.status(201).json({ appraisal });
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

/* ---------------------------------------------------------------------
 * Sec 21 -- pipeline overview.
 * -----------------------------------------------------------------*/
const pipelineQuerySchema = z.object({
  filter: z.enum(["active", "follow_up", "won", "lost", "deferred"]).optional(),
  ownerUserId: z.coerce.number().int().positive().optional(),
});

growAppraisalsRouter.get("/pipeline", requireAuth, requiresGrowAccess, async (req, res) => {
  const user = req.authedUser!;
  const parsed = pipelineQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const rows = await listAppraisalPipeline({
      brokerageId: user.brokerageId,
      filter: parsed.data.filter,
      ownerUserId: parsed.data.ownerUserId,
      restrictToPropertyIds: await restrictedPropertyIdsFor(user),
    });
    res.json({ appraisals: rows });
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

/* ---------------------------------------------------------------------
 * Sec 9 -- the Appraisal Workspace itself.
 * -----------------------------------------------------------------*/
growAppraisalsRouter.get("/:id", requireAuth, requiresGrowAccess, async (req, res) => {
  const user = req.authedUser!;
  const appraisalId = readIdParam(res, req.params.id, "appraisal");
  if (appraisalId === null) return;
  try {
    const workspace = await getAppraisalWorkspace(appraisalId, user.brokerageId);
    // Same 404 a cross-tenant appraisal already returns. Checked after the
    // brokerage join inside getAppraisalWorkspace, so a foreign-tenant id
    // still records the isolation rejection before this returns.
    if (await propertyHiddenFromCaller(user, workspace.appraisal.propertyId)) {
      res.status(404).json({ error: "Appraisal not found" });
      return;
    }
    res.json(workspace);
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

const updateWorkspaceSchema = z.object({
  priceRangeLow: z.string().nullable().optional(),
  priceRangeHigh: z.string().nullable().optional(),
  priceRangeCurrency: z.string().optional(),
  pricingCommentary: z.string().nullable().optional(),
  marketPositionNarrative: z.string().nullable().optional(),
  sellingStrategy: z.string().nullable().optional(),
  marketingProposal: z.string().nullable().optional(),
  commissionRatePercent: z.string().nullable().optional(),
  commissionProposal: z.string().nullable().optional(),
  recommendedNextSteps: z.string().nullable().optional(),
  appointmentAt: z.string().nullable().optional(),
  presentationAt: z.string().nullable().optional(),
  ownerUserId: z.coerce.number().int().positive().nullable().optional(),
});

growAppraisalsRouter.patch("/:id", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const user = req.authedUser!;
  const appraisalId = readIdParam(res, req.params.id, "appraisal");
  if (appraisalId === null) return;
  const parsed = updateWorkspaceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  if (await appraisalWriteBlocked(user, appraisalId, res)) return;
  try {
    const appraisal = await updateAppraisalWorkspace({
      appraisalId,
      brokerageId: user.brokerageId,
      userId: user.id,
      ...parsed.data,
    });
    res.json({ appraisal });
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

/* ---------------------------------------------------------------------
 * Sec 6 -- explicit status transitions, distinct from outcome (Sec 18).
 * -----------------------------------------------------------------*/
const statusSchema = z.object({ toStatus: z.string().min(1) });

growAppraisalsRouter.post("/:id/status", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const user = req.authedUser!;
  const appraisalId = readIdParam(res, req.params.id, "appraisal");
  if (appraisalId === null) return;
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  if (await appraisalWriteBlocked(user, appraisalId, res)) return;
  try {
    const appraisal = await transitionAppraisalStatus({
      appraisalId,
      brokerageId: user.brokerageId,
      userId: user.id,
      toStatus: parsed.data.toStatus,
    });
    res.json({ appraisal });
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

/* ---------------------------------------------------------------------
 * Sec 18 -- outcome.
 * -----------------------------------------------------------------*/
const outcomeSchema = z.object({
  outcome: z.enum(["WON", "LOST", "DEFERRED"]),
  outcomeReason: z.string().nullable().optional(),
  outcomeNotes: z.string().nullable().optional(),
});

growAppraisalsRouter.post("/:id/outcome", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const user = req.authedUser!;
  const appraisalId = readIdParam(res, req.params.id, "appraisal");
  if (appraisalId === null) return;
  const parsed = outcomeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  if (await appraisalWriteBlocked(user, appraisalId, res)) return;
  try {
    const appraisal = await recordAppraisalOutcome({
      appraisalId,
      brokerageId: user.brokerageId,
      userId: user.id,
      outcome: parsed.data.outcome,
      outcomeReason: parsed.data.outcomeReason,
      outcomeNotes: parsed.data.outcomeNotes,
    });
    res.json({ appraisal });
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

/* ---------------------------------------------------------------------
 * Sec 17 -- follow-up.
 * -----------------------------------------------------------------*/
const followUpSchema = z.object({
  followUpAt: z.string().min(1),
  followUpNotes: z.string().nullable().optional(),
});

growAppraisalsRouter.post("/:id/follow-up", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const user = req.authedUser!;
  const appraisalId = readIdParam(res, req.params.id, "appraisal");
  if (appraisalId === null) return;
  const parsed = followUpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  if (await appraisalWriteBlocked(user, appraisalId, res)) return;
  try {
    const appraisal = await scheduleAppraisalFollowUp({
      appraisalId,
      brokerageId: user.brokerageId,
      userId: user.id,
      followUpAt: parsed.data.followUpAt,
      followUpNotes: parsed.data.followUpNotes,
    });
    res.json({ appraisal });
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

/* ---------------------------------------------------------------------
 * Sec 15 -- Send Appraisal via the Communications Hub.
 * -----------------------------------------------------------------*/
const sendSchema = z.object({
  subject: z.string().optional(),
  bodyText: z.string().optional(),
});

growAppraisalsRouter.post("/:id/send", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const user = req.authedUser!;
  const appraisalId = readIdParam(res, req.params.id, "appraisal");
  if (appraisalId === null) return;
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  if (await appraisalWriteBlocked(user, appraisalId, res)) return;
  try {
    const result = await sendAppraisal({
      appraisalId,
      brokerageId: user.brokerageId,
      userId: user.id,
      subject: parsed.data.subject,
      bodyText: parsed.data.bodyText,
    });
    res.json(result);
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

/* ---------------------------------------------------------------------
 * Sec 12 -- AI Market Position draft.
 * -----------------------------------------------------------------*/
growAppraisalsRouter.post("/:id/market-position/generate", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const user = req.authedUser!;
  const appraisalId = readIdParam(res, req.params.id, "appraisal");
  if (appraisalId === null) return;
  if (await appraisalWriteBlocked(user, appraisalId, res)) return;
  try {
    const result = await generateMarketPositionDraft({
      appraisalId,
      brokerageId: user.brokerageId,
      userId: user.id,
      userRole: user.role,
    });
    res.json(result);
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

/* ---------------------------------------------------------------------
 * Sec 13/14 -- presentation document generation.
 * -----------------------------------------------------------------*/
growAppraisalsRouter.post("/:id/presentation/generate", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const user = req.authedUser!;
  const appraisalId = readIdParam(res, req.params.id, "appraisal");
  if (appraisalId === null) return;
  if (await appraisalWriteBlocked(user, appraisalId, res)) return;
  try {
    const result = await generateAppraisalPresentation({
      appraisalId,
      brokerageId: user.brokerageId,
      userId: user.id,
    });
    res.json(result);
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

/* ---------------------------------------------------------------------
 * Sec 19/20 -- Grow -> Run handoff, gated behind the same run.access
 * entitlement Run uses everywhere else.
 * -----------------------------------------------------------------*/
growAppraisalsRouter.post("/:id/run-handoff", requireAuth, requiresGrowAccess, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const appraisalId = readIdParam(res, req.params.id, "appraisal");
  if (appraisalId === null) return;
  if (await appraisalWriteBlocked(user, appraisalId, res)) return;
  try {
    const result = await prepareAppraisalRunHandoff({
      appraisalId,
      brokerageId: user.brokerageId,
      userId: user.id,
    });
    res.json(result);
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

/* ---------------------------------------------------------------------
 * Sec 9/10 -- comparable sales and market competition, manual entry.
 * -----------------------------------------------------------------*/
const comparableSaleSchema = z.object({
  address: z.string().min(1),
  salePrice: z.string().nullable().optional(),
  saleDate: z.string().nullable().optional(),
  bedrooms: z.coerce.number().int().nullable().optional(),
  bathrooms: z.coerce.number().int().nullable().optional(),
  carSpaces: z.coerce.number().int().nullable().optional(),
  landSizeSqm: z.string().nullable().optional(),
  propertyType: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  source: z.string().optional(),
  sourceProvenance: z.string().nullable().optional(),
  displayOrder: z.coerce.number().int().optional(),
});

function normalizeSaleDate(saleDate: string | null | undefined): Date | null | undefined {
  if (saleDate === undefined) return undefined;
  return saleDate ? new Date(saleDate) : null;
}

growAppraisalsRouter.post("/:id/comparable-sales", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const user = req.authedUser!;
  const appraisalId = readIdParam(res, req.params.id, "appraisal");
  if (appraisalId === null) return;
  const parsed = comparableSaleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  if (await appraisalWriteBlocked(user, appraisalId, res)) return;
  try {
    const row = await addComparableSale(appraisalId, user.brokerageId, {
      ...parsed.data,
      saleDate: normalizeSaleDate(parsed.data.saleDate),
    } as ComparableSaleInput);
    res.status(201).json({ comparableSale: row });
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

growAppraisalsRouter.patch("/:id/comparable-sales/:saleId", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const user = req.authedUser!;
  const appraisalId = readIdParam(res, req.params.id, "appraisal");
  if (appraisalId === null) return;
  const saleId = readIdParam(res, req.params.saleId, "comparable sale");
  if (saleId === null) return;
  const parsed = comparableSaleSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  if (await appraisalWriteBlocked(user, appraisalId, res)) return;
  try {
    const row = await updateComparableSale(appraisalId, user.brokerageId, saleId, {
      ...parsed.data,
      saleDate: normalizeSaleDate(parsed.data.saleDate),
    } as Partial<ComparableSaleInput>);
    res.json({ comparableSale: row });
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

growAppraisalsRouter.delete("/:id/comparable-sales/:saleId", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const user = req.authedUser!;
  const appraisalId = readIdParam(res, req.params.id, "appraisal");
  if (appraisalId === null) return;
  const saleId = readIdParam(res, req.params.saleId, "comparable sale");
  if (saleId === null) return;
  if (await appraisalWriteBlocked(user, appraisalId, res)) return;
  try {
    await deleteComparableSale(appraisalId, user.brokerageId, saleId);
    res.status(204).send();
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

const marketCompetitionSchema = z.object({
  address: z.string().min(1),
  askingPriceDisplay: z.string().nullable().optional(),
  askingPriceLow: z.string().nullable().optional(),
  askingPriceHigh: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  daysOnMarket: z.coerce.number().int().nullable().optional(),
  attributesSummary: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  source: z.string().optional(),
  sourceProvenance: z.string().nullable().optional(),
  displayOrder: z.coerce.number().int().optional(),
});

growAppraisalsRouter.post("/:id/market-competition", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const user = req.authedUser!;
  const appraisalId = readIdParam(res, req.params.id, "appraisal");
  if (appraisalId === null) return;
  const parsed = marketCompetitionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  if (await appraisalWriteBlocked(user, appraisalId, res)) return;
  try {
    const row = await addMarketCompetitionItem(appraisalId, user.brokerageId, parsed.data as MarketCompetitionInput);
    res.status(201).json({ marketCompetition: row });
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

growAppraisalsRouter.patch("/:id/market-competition/:itemId", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const user = req.authedUser!;
  const appraisalId = readIdParam(res, req.params.id, "appraisal");
  if (appraisalId === null) return;
  const itemId = readIdParam(res, req.params.itemId, "market competition entry");
  if (itemId === null) return;
  const parsed = marketCompetitionSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  if (await appraisalWriteBlocked(user, appraisalId, res)) return;
  try {
    const row = await updateMarketCompetitionItem(appraisalId, user.brokerageId, itemId, parsed.data as Partial<MarketCompetitionInput>);
    res.json({ marketCompetition: row });
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

growAppraisalsRouter.delete("/:id/market-competition/:itemId", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const user = req.authedUser!;
  const appraisalId = readIdParam(res, req.params.id, "appraisal");
  if (appraisalId === null) return;
  const itemId = readIdParam(res, req.params.itemId, "market competition entry");
  if (itemId === null) return;
  if (await appraisalWriteBlocked(user, appraisalId, res)) return;
  try {
    await deleteMarketCompetitionItem(appraisalId, user.brokerageId, itemId);
    res.status(204).send();
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});
