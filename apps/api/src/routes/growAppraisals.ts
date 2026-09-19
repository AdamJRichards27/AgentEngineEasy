import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
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

export const growAppraisalsRouter = Router();

/** Maps this feature's typed errors to the same shape/status style the
 * rest of the API already uses (see routes/appraisals.ts, routes/ai.ts). */
function handleGrowAppraisalError(err: unknown, res: import("express").Response): void {
  if (err instanceof AppraisalAccessError) {
    res.status(404).json({ error: err.message });
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
  // market-position/generate goes through askCopilot(), so it shares the daily AI cap.
  if (err instanceof AiDailyCapExceededError) {
    res.status(429).json({ error: err.message });
    return;
  }
  res.status(400).json({ error: (err as Error).message });
}

const requiresRunAccess = requireEntitlement("run.access");
// WP1 P1-1: every Appraisal Workspace route is a Grow surface, so every route requires
// grow.access (checked before any work). Every mutating route additionally requires
// grow.opportunities.manage -- the same "manage" key Grow uses for its own opportunity
// pipeline writes (routes/grow.ts). /:id/run-handoff keeps run.access AND requires
// grow.access, because the Grow -> Run handoff originates in Grow.
const requiresGrowAccess = requireEntitlement("grow.access");
const requiresGrowManage = requireEntitlement("grow.opportunities.manage");

/* ---------------------------------------------------------------------
 * Sec 7/8 -- Create from Contact 360 or from a Grow Opportunity.
 * -----------------------------------------------------------------*/
const createFromContactSchema = z.object({
  partyId: z.coerce.number().int().positive(),
  propertyId: z.coerce.number().int().positive(),
});

growAppraisalsRouter.post("/from-contact", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const user = req.authedUser!;
  const parsed = createFromContactSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
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
  const appraisalId = Number(req.params.id);
  try {
    const workspace = await getAppraisalWorkspace(appraisalId, user.brokerageId);
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
  const appraisalId = Number(req.params.id);
  const parsed = updateWorkspaceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
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
  const appraisalId = Number(req.params.id);
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
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
  const appraisalId = Number(req.params.id);
  const parsed = outcomeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
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
  const appraisalId = Number(req.params.id);
  const parsed = followUpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
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
  const appraisalId = Number(req.params.id);
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
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
  const appraisalId = Number(req.params.id);
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
  const appraisalId = Number(req.params.id);
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
  const appraisalId = Number(req.params.id);
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
  const appraisalId = Number(req.params.id);
  const parsed = comparableSaleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
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
  const appraisalId = Number(req.params.id);
  const saleId = Number(req.params.saleId);
  const parsed = comparableSaleSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
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
  const appraisalId = Number(req.params.id);
  const saleId = Number(req.params.saleId);
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
  const appraisalId = Number(req.params.id);
  const parsed = marketCompetitionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const row = await addMarketCompetitionItem(appraisalId, user.brokerageId, parsed.data as MarketCompetitionInput);
    res.status(201).json({ marketCompetition: row });
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

growAppraisalsRouter.patch("/:id/market-competition/:itemId", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const user = req.authedUser!;
  const appraisalId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const parsed = marketCompetitionSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const row = await updateMarketCompetitionItem(appraisalId, user.brokerageId, itemId, parsed.data as Partial<MarketCompetitionInput>);
    res.json({ marketCompetition: row });
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});

growAppraisalsRouter.delete("/:id/market-competition/:itemId", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const user = req.authedUser!;
  const appraisalId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  try {
    await deleteMarketCompetitionItem(appraisalId, user.brokerageId, itemId);
    res.status(204).send();
  } catch (err) {
    handleGrowAppraisalError(err, res);
  }
});
