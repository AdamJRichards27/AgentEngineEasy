// Agent Engine 2.0 — Property Launch & Campaign Coordination.
//
// HTTP surface over the Launch engine. Every handler re-derives
// brokerageId from req.authedUser — never from a client-supplied tenant id
// — and every model.ts function does its own tenant check before writing
// anything, mirroring routes/exceptions.ts's own precedent exactly.
// Financial decisions (deciding a vendor/budget approval, setting the
// budget, overriding Market Ready) are gated to Brokerage Administrator at
// the ROUTE level via requireRole — never re-checked inside model.ts,
// matching this app's established role-gating convention (AML-exception-
// resolution/refund/agent-paid/close).

import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { campaignItems, db } from "@aee/db";
import { logAudit } from "../lib/audit.js";
import {
  amendmentAuditInput,
  auditWriterFor,
  denyFinancialAmendment,
  hiddenAgent,
  loadPropertyFinancialScope,
  resolveAmendmentAuthority,
} from "../lib/financialAmendments.js";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES, type AuthedUser } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import {
  CAMPAIGN_ITEM_TYPES,
  CAMPAIGN_ITEM_STATUSES,
  LAUNCH_TEMPLATE_TYPES,
  VENDOR_APPROVAL_TYPES,
  LAUNCH_OWNER_TYPES,
  LaunchError,
  type ActorRef,
} from "../lib/launch/types.js";
import {
  getOrCreateLaunchPlan,
  getLaunchPlanDetail,
  getLaunchPlanTransitions,
  applyTemplate,
  setTargetLaunchDate,
  addCampaignItem,
  updateCampaignItemStatus,
  assignResponsibility,
  recordVendorAndCost,
  attachCampaignItemEvidence,
  requestVendorApproval,
  decideVendorApproval,
  setBudget,
  addPortalDestination,
  recordPortalSubmission,
  recordPortalFailure,
  confirmPortalLive,
  evaluateAndUpdateMarketReady,
  overrideMarketReady,
  confirmLaunchLive,
  pauseLaunchPlan,
  resumeLaunchPlan,
  cancelLaunchPlan,
} from "../lib/launch/model.js";

export const launchRouter = Router();

// R-F35b — Launch is a Run surface. Every route below requires run.access
// after requireAuth and before the handler's tenant check (and before
// requireRole, where that gate already exists), matching
// routes/transactions.ts: an unentitled caller is refused without a
// same-brokerage existence oracle, and the denial is requireEntitlement's
// existing 403. Applied per route, not via Router.use() — this router is
// mounted unprefixed, and a blanket use() would intercept requests that
// only pass through it on the way to a later sibling. There is no
// provider webhook on this router.
const requiresRunAccess = requireEntitlement("run.access");

function actorFrom(user: AuthedUser): ActorRef {
  return { id: user.id, role: user.role };
}

function statusForLaunchError(reason: string): number {
  switch (reason) {
    case "NOT_FOUND":
      return 404;
    case "INVALID_STATUS":
    case "ALREADY_APPLIED":
    case "NOT_READY":
      return 409;
    default:
      return 400;
  }
}

function handleLaunchError(err: unknown, res: import("express").Response): boolean {
  if (err instanceof LaunchError) {
    res.status(statusForLaunchError(err.reason)).json({ error: err.message, reason: err.reason });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// Launch Plan lifecycle.
// ---------------------------------------------------------------------

// Null (not 404) when the property exists but hasn't started a launch yet
// — a property before AGENCY_AGREEMENT_SIGNED is a normal state, and the
// Property Card's progressive-disclosure UI reads this to decide whether
// to show "Start Launch" or the full Launch panel.
launchRouter.get("/properties/:propertyId/launch", requireAuth, requiresRunAccess, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const user = req.authedUser!;
  try {
    const detail = await getLaunchPlanDetail(propertyId, user.brokerageId);
    res.json({ launch: detail });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

launchRouter.post("/properties/:propertyId/launch", requireAuth, requiresRunAccess, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const user = req.authedUser!;
  try {
    const { plan, created } = await getOrCreateLaunchPlan(propertyId, user.brokerageId, actorFrom(user));
    res.status(created ? 201 : 200).json({ plan });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

launchRouter.get("/launch/:id/transitions", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  try {
    const transitions = await getLaunchPlanTransitions(req.params.id, user.brokerageId);
    res.json({ transitions });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

const applyTemplateSchema = z.object({ templateType: z.enum(LAUNCH_TEMPLATE_TYPES) });

launchRouter.post("/launch/:id/template", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const parsed = applyTemplateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const plan = await applyTemplate(req.params.id, user.brokerageId, actorFrom(user), parsed.data.templateType);
    res.json({ plan });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

const targetDateSchema = z.object({ targetLaunchDate: z.coerce.date() });

launchRouter.post("/launch/:id/target-date", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const parsed = targetDateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const plan = await setTargetLaunchDate(req.params.id, user.brokerageId, actorFrom(user), parsed.data.targetLaunchDate);
    res.json({ plan });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

launchRouter.post("/launch/:id/pause", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const parsed = z.object({ reason: z.string().min(1).max(2000) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const plan = await pauseLaunchPlan(req.params.id, user.brokerageId, actorFrom(user), parsed.data.reason);
    res.json({ plan });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

launchRouter.post("/launch/:id/resume", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  try {
    const plan = await resumeLaunchPlan(req.params.id, user.brokerageId, actorFrom(user));
    res.json({ plan });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

launchRouter.post("/launch/:id/cancel", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const parsed = z.object({ reason: z.string().min(1).max(2000) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const plan = await cancelLaunchPlan(req.params.id, user.brokerageId, actorFrom(user), parsed.data.reason);
    res.json({ plan });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

// ---------------------------------------------------------------------
// Campaign items.
// ---------------------------------------------------------------------

const addCampaignItemSchema = z.object({
  itemType: z.enum(CAMPAIGN_ITEM_TYPES),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  leadDays: z.number().int().min(0).max(365).optional(),
  dueAt: z.coerce.date().optional(),
  responsibleOwnerType: z.enum(LAUNCH_OWNER_TYPES).optional(),
  responsibleUserId: z.number().int().nullable().optional(),
});

launchRouter.post("/launch/:id/campaign-items", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const parsed = addCampaignItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const item = await addCampaignItem(req.params.id, user.brokerageId, actorFrom(user), parsed.data);
    res.status(201).json({ item });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

const updateStatusSchema = z.object({ status: z.enum(CAMPAIGN_ITEM_STATUSES), blockedReason: z.string().max(2000).optional() });

launchRouter.post("/launch/campaign-items/:itemId/status", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const parsed = updateStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const item = await updateCampaignItemStatus(req.params.itemId, user.brokerageId, actorFrom(user), parsed.data.status, parsed.data.blockedReason);
    res.json({ item });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

const assignResponsibilitySchema = z.object({ ownerType: z.enum(LAUNCH_OWNER_TYPES), ownerUserId: z.number().int().nullable() });

launchRouter.post("/launch/campaign-items/:itemId/responsibility", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const parsed = assignResponsibilitySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const item = await assignResponsibility(req.params.itemId, user.brokerageId, actorFrom(user), parsed.data.ownerType, parsed.data.ownerUserId);
    res.json({ item });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

const vendorCostSchema = z.object({ vendorName: z.string().max(200).nullable(), costCents: z.number().int().min(0) });

// Owner t173u: a campaign item's vendor cost is a marketing charge. Amending
// it needs authority: the listing agent or a Brokerage Administrator (own
// authority). Pit Crew: 403 until a documented-authority record exists
// (lib/financialAmendments.ts). Another Agent: 404 (own-property rule).
// The cost update and its before/after audit row commit together.
launchRouter.post("/launch/campaign-items/:itemId/vendor-cost", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const itemId = req.params.itemId;
  const [item] = z.string().uuid().safeParse(itemId).success
    ? await db
        .select({ propertyId: campaignItems.propertyId })
        .from(campaignItems)
        .where(and(eq(campaignItems.id, itemId), eq(campaignItems.brokerageId, user.brokerageId)))
    : [];
  const scope = item ? await loadPropertyFinancialScope(user, item.propertyId) : null;
  if (!scope || hiddenAgent(user, scope)) {
    res.status(404).json({ error: "Campaign item not found", reason: "NOT_FOUND" });
    return;
  }
  const authority = resolveAmendmentAuthority(user, scope);
  if (!authority.allowed) {
    await denyFinancialAmendment(res, user, scope, "campaign_item", itemId, "POST /launch/campaign-items/:itemId/vendor-cost");
    return;
  }
  const parsed = vendorCostSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const updated = await recordVendorAndCost(itemId, user.brokerageId, actorFrom(user), parsed.data.vendorName, parsed.data.costCents, async (before, after, tx) => {
      await logAudit(
        amendmentAuditInput({
          user,
          authority,
          scope,
          recordType: "campaign_item",
          recordId: itemId,
          before: { vendorName: before.vendorName, costCents: before.costCents },
          after: { vendorName: after.vendorName, costCents: after.costCents },
          surface: "POST /launch/campaign-items/:itemId/vendor-cost",
        }),
        { strict: true, write: auditWriterFor(tx) },
      );
    });
    res.json({ item: updated });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

const evidenceSchema = z.object({ label: z.string().min(1).max(200), url: z.string().min(1).max(2000) });

launchRouter.post("/launch/campaign-items/:itemId/evidence", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const parsed = evidenceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const item = await attachCampaignItemEvidence(req.params.itemId, user.brokerageId, actorFrom(user), parsed.data.label, parsed.data.url);
    res.json({ item });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

// ---------------------------------------------------------------------
// Vendor / budget approvals — decide is Brokerage Administrator only.
// ---------------------------------------------------------------------

const requestApprovalSchema = z.object({
  approvalType: z.enum(VENDOR_APPROVAL_TYPES),
  campaignItemId: z.string().uuid().nullable().optional(),
  requestedAmountCents: z.number().int().min(0),
});

launchRouter.post("/launch/:id/vendor-approvals", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const parsed = requestApprovalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const approval = await requestVendorApproval(req.params.id, user.brokerageId, actorFrom(user), parsed.data);
    res.status(201).json({ approval });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

const decideApprovalSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED", "CHANGES_REQUESTED"]),
  approvedAmountCents: z.number().int().min(0).nullable().optional(),
  decisionNotes: z.string().max(2000).nullable().optional(),
});

launchRouter.post("/launch/vendor-approvals/:approvalId/decide", requireAuth, requiresRunAccess, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const user = req.authedUser!;
  const parsed = decideApprovalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const approval = await decideVendorApproval(
      req.params.approvalId,
      user.brokerageId,
      actorFrom(user),
      parsed.data.decision,
      parsed.data.approvedAmountCents ?? null,
      parsed.data.decisionNotes ?? null,
    );
    res.json({ approval });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

const budgetSchema = z.object({ budgetCents: z.number().int().min(0) });

launchRouter.post("/launch/:id/budget", requireAuth, requiresRunAccess, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const user = req.authedUser!;
  const parsed = budgetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const plan = await setBudget(req.params.id, user.brokerageId, actorFrom(user), parsed.data.budgetCents);
    res.json({ plan });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

// ---------------------------------------------------------------------
// Portal destinations.
// ---------------------------------------------------------------------

launchRouter.post("/launch/:id/portal-destinations", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const parsed = z.object({ portalName: z.string().min(1).max(200) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const destination = await addPortalDestination(req.params.id, user.brokerageId, actorFrom(user), parsed.data.portalName);
    res.status(201).json({ destination });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

launchRouter.post("/launch/portal-destinations/:destId/submit", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const parsed = z.object({ listingUrl: z.string().max(2000).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const destination = await recordPortalSubmission(req.params.destId, user.brokerageId, actorFrom(user), parsed.data.listingUrl);
    res.json({ destination });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

launchRouter.post("/launch/portal-destinations/:destId/fail", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const parsed = z.object({ failureReason: z.string().min(1).max(2000) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const destination = await recordPortalFailure(req.params.destId, user.brokerageId, actorFrom(user), parsed.data.failureReason);
    res.json({ destination });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

launchRouter.post("/launch/portal-destinations/:destId/live", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const parsed = z.object({ listingUrl: z.string().max(2000).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const destination = await confirmPortalLive(req.params.destId, user.brokerageId, actorFrom(user), parsed.data.listingUrl);
    res.json({ destination });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

// ---------------------------------------------------------------------
// Market Ready / Listing Live.
// ---------------------------------------------------------------------

launchRouter.post("/launch/:id/market-ready/evaluate", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  try {
    const result = await evaluateAndUpdateMarketReady(req.params.id, user.brokerageId, actorFrom(user));
    res.json({ marketReady: result });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

launchRouter.post("/launch/:id/market-ready/override", requireAuth, requiresRunAccess, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const user = req.authedUser!;
  const parsed = z.object({ reason: z.string().min(1).max(2000) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const plan = await overrideMarketReady(req.params.id, user.brokerageId, actorFrom(user), parsed.data.reason);
    res.json({ plan });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});

launchRouter.post("/launch/:id/confirm-live", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  try {
    const plan = await confirmLaunchLive(req.params.id, user.brokerageId, actorFrom(user));
    res.json({ plan });
  } catch (err) {
    if (handleLaunchError(err, res)) return;
    throw err;
  }
});
