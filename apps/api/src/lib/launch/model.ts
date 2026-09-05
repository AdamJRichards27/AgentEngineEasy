// Agent Engine 2.0 — Property Launch & Campaign Coordination.
//
// State-transition layer over launch_plans / campaign_items /
// portal_destinations / vendor_approvals / launch_plan_transitions. Every
// exported mutation here is the only way any of those five tables is ever
// written — routes never touch them directly. Mirrors the Exception & Risk
// Engine's own domain-service convention function-for-function (compare
// lib/exceptions/model.ts): transitions recorded in an append-only ledger,
// every mutation audit-logged, every named event published best-effort
// after the write it describes has committed.
//
// Deliberately reuses rather than duplicates: resolveDefaultOwner (the
// Exception & Risk Engine's ownership-resolution helper) for default
// campaign-item responsibility, the deterministic Market Ready evaluator
// (marketReady.ts) for readiness, and lib/goLive.ts's single Go Live
// chokepoint for the actual "flip the property live" moment —
// confirmLaunchLive below never flips a property live itself, it only
// decides whether it is allowed to call that shared path, and never
// publishes a second LISTING_LIVE event once goLiveProperty already has.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  launchPlans,
  campaignItems,
  portalDestinations,
  vendorApprovals,
  launchPlanTransitions,
  properties,
  type LaunchPlan,
  type CampaignItem,
  type PortalDestination,
  type VendorApproval,
  type LaunchPlanTransition,
  type Property,
} from "@aee/db";
import { publishDomainEvent, currentCorrelationId } from "@aee/events";
import { logAudit } from "../audit.js";
import { resolveDefaultOwner } from "../exceptions/rules/shared.js";
import { goLiveProperty } from "../goLive.js";
import { evaluateMarketReady, evaluateListingLive } from "./marketReady.js";
import { CAMPAIGN_TEMPLATES, calculateDueDate } from "./templates.js";
import {
  LaunchError,
  LAUNCH_VENDOR_APPROVAL_THRESHOLD_CENTS,
  type ActorRef,
  type LaunchTemplateType,
  type LaunchPlanStatus,
  type CampaignItemType,
  type CampaignItemStatus,
  type VendorApprovalType,
  type LaunchOwnerType,
  type MarketReadyResult,
  type MarketReadyBlocker,
} from "./types.js";

// ---------------------------------------------------------------------
// Small internals: event publication, transition ledger, tenant loaders.
// ---------------------------------------------------------------------

/**
 * Every publishDomainEvent call in this module funnels through here.
 * agentId/actorType/actorId derive from the acting user alone (matching
 * lib/goLive.ts's own convention of `agentId: actor.id`, not a second
 * lookup of the property's assigned agent) — a null actor means this was
 * triggered by the engine itself (the AGENCY_AGREEMENT_SIGNED auto-propose
 * handler in bootstrap.ts), in which case actorType is SYSTEM and agentId
 * is null (domainEvents.agentId is nullable — see exceptions/model.ts's
 * own EXCEPTION_CREATED publish for the precedent).
 */
async function emit(
  eventType: string,
  scope: { propertyId: number; brokerageId: number },
  actor: ActorRef | null,
  source: string,
  payload: Record<string, unknown>,
  idempotencyKey: string | null = null,
): Promise<void> {
  try {
    await publishDomainEvent({
      eventType: eventType as any,
      occurredAt: new Date(),
      propertyId: scope.propertyId,
      transactionId: null,
      partyId: null,
      brokerageId: scope.brokerageId,
      agentId: actor ? actor.id : null,
      actorType: actor ? "USER" : "SYSTEM",
      actorId: actor ? actor.id : null,
      source,
      correlationId: currentCorrelationId(),
      causationId: null,
      idempotencyKey,
      payload,
      metadata: {},
    });
  } catch (err) {
    console.error(`publishDomainEvent(${eventType}) failed`, err);
  }
}

async function recordTransition(
  launchPlanId: string,
  brokerageId: number,
  transitionType: string,
  opts: {
    fromValue?: string | null;
    toValue?: string | null;
    reason?: string | null;
    actorType: "SYSTEM" | "USER";
    actorUserId?: number | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  await db.insert(launchPlanTransitions).values({
    launchPlanId,
    brokerageId,
    transitionType,
    fromValue: opts.fromValue ?? null,
    toValue: opts.toValue ?? null,
    reason: opts.reason ?? null,
    actorType: opts.actorType,
    actorUserId: opts.actorUserId ?? null,
    metadata: opts.metadata ?? null,
  });
}

/** Tenant + property chokepoint, matching the #123/#131/exceptions precedent — a local copy per module, not a shared utility. */
export async function assertPropertyInBrokerage(propertyId: number, brokerageId: number): Promise<Property> {
  const [property] = await db.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.brokerageId, brokerageId)));
  if (!property) throw new LaunchError("NOT_FOUND", `Property ${propertyId} not found`);
  return property;
}

async function loadLaunchPlanInBrokerage(launchPlanId: string, brokerageId: number): Promise<LaunchPlan> {
  const [plan] = await db.select().from(launchPlans).where(eq(launchPlans.id, launchPlanId));
  // Identical NOT_FOUND whether the row doesn't exist or belongs to another
  // tenant — same "never reveal cross-tenant existence" discipline as
  // exceptions/model.ts's assertTenantAndLoad.
  if (!plan || plan.brokerageId !== brokerageId) throw new LaunchError("NOT_FOUND", "Launch plan not found");
  return plan;
}

async function loadCampaignItemInBrokerage(campaignItemId: string, brokerageId: number): Promise<CampaignItem> {
  const [item] = await db.select().from(campaignItems).where(eq(campaignItems.id, campaignItemId));
  if (!item || item.brokerageId !== brokerageId) throw new LaunchError("NOT_FOUND", "Campaign item not found");
  return item;
}

/** Step 5: exported (was module-private) so lib/integrations/launchProof.ts's webhook effect handler can read a destination's current status for its own out-of-order guard — a read-only reuse, never a second writer. */
export async function loadPortalDestinationInBrokerage(portalDestinationId: string, brokerageId: number): Promise<PortalDestination> {
  const [row] = await db.select().from(portalDestinations).where(eq(portalDestinations.id, portalDestinationId));
  if (!row || row.brokerageId !== brokerageId) throw new LaunchError("NOT_FOUND", "Portal destination not found");
  return row;
}

async function loadVendorApprovalInBrokerage(vendorApprovalId: string, brokerageId: number): Promise<VendorApproval> {
  const [row] = await db.select().from(vendorApprovals).where(eq(vendorApprovals.id, vendorApprovalId));
  if (!row || row.brokerageId !== brokerageId) throw new LaunchError("NOT_FOUND", "Vendor approval not found");
  return row;
}

// ---------------------------------------------------------------------
// Post-mutation recompute — the "recompute from live state after every
// mutation" convention lib/workflowSteps.ts already established
// (refreshReadyToListSteps/refreshTransactionSteps), applied here to
// budget, Market Ready, and the plan's own summary status in one place so
// no individual mutation has to remember to do all three itself.
// ---------------------------------------------------------------------

async function recalculateBudget(plan: LaunchPlan, actor: ActorRef | null): Promise<void> {
  const items = await db.select({ costCents: campaignItems.costCents }).from(campaignItems).where(eq(campaignItems.launchPlanId, plan.id));
  const spent = items.reduce((sum, i) => sum + i.costCents, 0);
  if (spent === plan.budgetSpentCents) return;

  const wasExceeded = plan.budgetCents > 0 && plan.budgetSpentCents > plan.budgetCents;
  const nowExceeded = plan.budgetCents > 0 && spent > plan.budgetCents;
  await db.update(launchPlans).set({ budgetSpentCents: spent, updatedAt: new Date() }).where(eq(launchPlans.id, plan.id));

  // Only the crossing edge is logged/published — a plan that stays over
  // budget across several more cost updates doesn't re-fire this on every
  // one of them (Build spec: "not flooding with minor updates").
  if (nowExceeded && !wasExceeded) {
    await logAudit({
      userId: actor?.id,
      action: "launch_budget_exceeded",
      recordType: "launch_plan",
      recordId: plan.id,
      propertyId: plan.propertyId,
      updatedValue: `$${(spent / 100).toFixed(2)} of $${(plan.budgetCents / 100).toFixed(2)}`,
    });
    await emit("LAUNCH_BUDGET_EXCEEDED", plan, actor, "launch-engine:budget", {
      launchPlanId: plan.id,
      budgetCents: plan.budgetCents,
      budgetSpentCents: spent,
    });
  }
}

async function evaluateAndUpdateMarketReadyInternal(plan: LaunchPlan, actor: ActorRef | null): Promise<MarketReadyResult> {
  const result = await evaluateMarketReady(plan);
  const wasReady = plan.marketReadyEvaluatedAt !== null && ((plan.marketReadyBlockers as unknown as MarketReadyBlocker[]) ?? []).length === 0;

  await db
    .update(launchPlans)
    .set({ marketReadyEvaluatedAt: result.evaluatedAt, marketReadyBlockers: result.blockers, updatedAt: new Date() })
    .where(eq(launchPlans.id, plan.id));

  await emit("MARKET_READY_EVALUATED", plan, actor, "launch-engine:market-ready", {
    launchPlanId: plan.id,
    ready: result.ready,
    blockerCodes: result.blockers.map((b) => b.code),
  });

  // Only the false -> true transition is a Timeline-worthy milestone — a
  // re-evaluation that stays ready, or stays blocked, isn't (mirrors the
  // budget-exceeded crossing-edge convention just above).
  if (result.ready && !wasReady) {
    await logAudit({ userId: actor?.id, action: "launch_market_ready_achieved", recordType: "launch_plan", recordId: plan.id, propertyId: plan.propertyId });
    await recordTransition(plan.id, plan.brokerageId, "MARKET_READY_ACHIEVED", {
      toValue: "READY",
      actorType: actor ? "USER" : "SYSTEM",
      actorUserId: actor?.id ?? null,
    });
  }

  return result;
}

/**
 * Deterministic "furthest-relevant stage" computation (schema comment on
 * launchPlans.status) — cancelled/paused/live are sticky and checked
 * first; everything else is re-derived from live state every time, so
 * calling this after any mutation can never leave a stale status behind.
 */
async function computeLaunchPlanStatus(plan: LaunchPlan): Promise<LaunchPlanStatus> {
  if (plan.cancelledAt) return "CANCELLED";
  if (plan.pausedAt) return "PAUSED";
  if (plan.listingLiveConfirmedAt) return "LISTING_LIVE";

  const destinations = await db.select({ status: portalDestinations.status }).from(portalDestinations).where(eq(portalDestinations.launchPlanId, plan.id));
  if (destinations.some((d) => d.status === "SUBMITTED" || d.status === "LIVE" || d.status === "FAILED")) {
    return "PORTAL_SUBMISSION";
  }

  const marketReady = plan.marketReadyEvaluatedAt !== null && ((plan.marketReadyBlockers as unknown as MarketReadyBlocker[]) ?? []).length === 0;
  if (marketReady || plan.marketReadyOverriddenAt) return "MARKET_READY";

  const pendingApprovals = await db
    .select({ id: vendorApprovals.id })
    .from(vendorApprovals)
    .where(and(eq(vendorApprovals.launchPlanId, plan.id), inArray(vendorApprovals.status, ["PENDING", "CHANGES_REQUESTED"])));
  if (pendingApprovals.length > 0) return "VENDOR_APPROVAL";

  const items = await db.select({ id: campaignItems.id }).from(campaignItems).where(eq(campaignItems.launchPlanId, plan.id));
  if (items.length > 0) return "CAMPAIGN_PRODUCTION";

  return "PLANNING";
}

async function refreshLaunchPlanStatus(launchPlanId: string, brokerageId: number): Promise<void> {
  const plan = await loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
  const computed = await computeLaunchPlanStatus(plan);
  if (computed === plan.status) return;
  await db.update(launchPlans).set({ status: computed, updatedAt: new Date() }).where(eq(launchPlans.id, launchPlanId));
  await recordTransition(launchPlanId, brokerageId, "STATUS_RECOMPUTED", { fromValue: plan.status, toValue: computed, actorType: "SYSTEM" });
}

async function afterLaunchMutation(launchPlanId: string, brokerageId: number, actor: ActorRef | null): Promise<void> {
  const plan = await loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
  await recalculateBudget(plan, actor);
  await evaluateAndUpdateMarketReadyInternal(plan, actor);
  await refreshLaunchPlanStatus(launchPlanId, brokerageId);
}

// ---------------------------------------------------------------------
// Launch Plan lifecycle.
// ---------------------------------------------------------------------

export interface GetOrCreateLaunchPlanResult {
  plan: LaunchPlan;
  created: boolean;
}

/**
 * Idempotent create — the unique index on launch_plans.property_id is the
 * real guarantee; a Postgres 23505 unique-violation race here (two
 * concurrent callers) is caught and re-selected rather than surfaced as an
 * error, mirroring the AML-initiation idempotency precedent
 * (initiateAmlIfNeeded). templateType starts as CUSTOM (no campaign
 * items) — this function never guesses a sales method or template on the
 * agent's behalf; applyTemplate is a deliberate, separate step. Called
 * both from the route (an agent explicitly starting a launch) and from
 * bootstrap.ts's AGENCY_AGREEMENT_SIGNED handler (actor null, SYSTEM).
 */
export async function getOrCreateLaunchPlan(propertyId: number, brokerageId: number, actor: ActorRef | null): Promise<GetOrCreateLaunchPlanResult> {
  const property = await assertPropertyInBrokerage(propertyId, brokerageId);
  const [existing] = await db.select().from(launchPlans).where(eq(launchPlans.propertyId, propertyId));
  if (existing) return { plan: existing, created: false };

  let created: LaunchPlan;
  try {
    [created] = await db
      .insert(launchPlans)
      .values({ brokerageId, propertyId, templateType: "CUSTOM", status: "PLANNING", createdBy: actor?.id ?? property.agentId })
      .returning();
  } catch (err: any) {
    if (err?.code === "23505") {
      const [row] = await db.select().from(launchPlans).where(eq(launchPlans.propertyId, propertyId));
      if (row) return { plan: row, created: false };
    }
    throw err;
  }

  await recordTransition(created.id, brokerageId, "CREATED", { toValue: "PLANNING", actorType: actor ? "USER" : "SYSTEM", actorUserId: actor?.id ?? null });
  await logAudit({ userId: actor?.id, action: "launch_plan_created", recordType: "launch_plan", recordId: created.id, propertyId });
  await emit(
    "LAUNCH_PLAN_CREATED",
    created,
    actor,
    actor ? "api:launch:get-or-create" : "launch-engine:auto-propose",
    { launchPlanId: created.id, propertyId },
    `launch-plan-created:${created.id}`,
  );

  return { plan: created, created: true };
}

/**
 * One-time bootstrapping of the campaign item catalogue from a fixed
 * template (templates.ts's CAMPAIGN_TEMPLATES) — refused if items already
 * exist, so re-applying never doubles up the item list; add/remove items
 * individually after the initial choice instead. Each generated item's
 * dueAt is backward-calculated from the plan's target launch date (if
 * already set) and its leadDays is stored so a later target-date change
 * can recompute it (see setTargetLaunchDate/recalcDueDates below).
 */
export async function applyTemplate(launchPlanId: string, brokerageId: number, actor: ActorRef, templateType: LaunchTemplateType): Promise<LaunchPlan> {
  const plan = await loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
  const property = await assertPropertyInBrokerage(plan.propertyId, brokerageId);

  const existingItems = await db.select({ id: campaignItems.id }).from(campaignItems).where(eq(campaignItems.launchPlanId, launchPlanId));
  if (existingItems.length > 0) {
    throw new LaunchError("ALREADY_APPLIED", "A template has already been applied to this launch plan — add or remove campaign items individually instead of reapplying one.");
  }

  await db.update(launchPlans).set({ templateType, updatedAt: new Date() }).where(eq(launchPlans.id, launchPlanId));

  const templateItems = CAMPAIGN_TEMPLATES[templateType];
  const createdItems: CampaignItem[] = [];
  for (const t of templateItems) {
    const owner = resolveDefaultOwner(property, false);
    const dueAt = plan.targetLaunchDate ? calculateDueDate(plan.targetLaunchDate, t.leadDays) : null;
    const [item] = await db
      .insert(campaignItems)
      .values({
        launchPlanId,
        propertyId: plan.propertyId,
        brokerageId,
        itemType: t.itemType,
        title: t.title,
        description: t.description,
        responsibleOwnerType: owner.ownerType,
        responsibleUserId: owner.ownerUserId,
        leadDays: t.leadDays,
        dueAt,
      })
      .returning();
    createdItems.push(item);
  }

  await recordTransition(launchPlanId, brokerageId, "TEMPLATE_APPLIED", { toValue: templateType, actorType: "USER", actorUserId: actor.id });
  await logAudit({ userId: actor.id, action: "launch_template_applied", recordType: "launch_plan", recordId: launchPlanId, propertyId: plan.propertyId, updatedValue: templateType });
  await emit("LAUNCH_TEMPLATE_APPLIED", plan, actor, "api:launch:apply-template", { launchPlanId, templateType, itemCount: createdItems.length });

  for (const item of createdItems) {
    await emit("CAMPAIGN_ITEM_ADDED", plan, actor, "api:launch:apply-template", { launchPlanId, campaignItemId: item.id, itemType: item.itemType });
    if (item.responsibleUserId) {
      await emit("LAUNCH_DEFAULT_RESPONSIBILITY_ASSIGNED", plan, actor, "api:launch:apply-template", {
        campaignItemId: item.id,
        ownerType: item.responsibleOwnerType,
        ownerUserId: item.responsibleUserId,
      });
    }
  }

  await afterLaunchMutation(launchPlanId, brokerageId, actor);
  return loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
}

/** Internal — recomputes dueAt for every item that carries a leadDays (template-generated items); manually-added items with no leadDays are left untouched. Returns the count recalculated, so callers know whether LAUNCH_DUE_DATES_CALCULATED is worth publishing. */
async function recalcDueDates(plan: LaunchPlan): Promise<number> {
  if (!plan.targetLaunchDate) return 0;
  const items = await db
    .select()
    .from(campaignItems)
    .where(and(eq(campaignItems.launchPlanId, plan.id), sql`${campaignItems.leadDays} is not null`));
  for (const item of items) {
    const dueAt = calculateDueDate(plan.targetLaunchDate, item.leadDays!);
    await db.update(campaignItems).set({ dueAt, updatedAt: new Date() }).where(eq(campaignItems.id, item.id));
  }
  return items.length;
}

export async function setTargetLaunchDate(launchPlanId: string, brokerageId: number, actor: ActorRef, targetLaunchDate: Date): Promise<LaunchPlan> {
  const plan = await loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
  const previous = plan.targetLaunchDate;

  await db.update(launchPlans).set({ targetLaunchDate, updatedAt: new Date() }).where(eq(launchPlans.id, launchPlanId));

  await recordTransition(launchPlanId, brokerageId, "TARGET_DATE_CHANGED", {
    fromValue: previous ? previous.toISOString() : null,
    toValue: targetLaunchDate.toISOString(),
    actorType: "USER",
    actorUserId: actor.id,
  });
  await logAudit({
    userId: actor.id,
    action: "launch_target_date_changed",
    recordType: "launch_plan",
    recordId: launchPlanId,
    propertyId: plan.propertyId,
    previousValue: previous ? previous.toISOString() : undefined,
    updatedValue: targetLaunchDate.toISOString(),
  });
  await emit("LAUNCH_TARGET_DATE_CHANGED", plan, actor, "api:launch:set-target-date", { launchPlanId, targetLaunchDate: targetLaunchDate.toISOString() });

  const refreshed = await loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
  const recalculated = await recalcDueDates(refreshed);
  if (recalculated > 0) {
    await emit("LAUNCH_DUE_DATES_CALCULATED", plan, actor, "api:launch:set-target-date", { launchPlanId, itemsRecalculated: recalculated });
  }

  await afterLaunchMutation(launchPlanId, brokerageId, actor);
  return loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
}

// ---------------------------------------------------------------------
// Campaign items.
// ---------------------------------------------------------------------

export interface AddCampaignItemInput {
  itemType: CampaignItemType;
  title: string;
  description?: string | null;
  leadDays?: number | null;
  dueAt?: Date | null;
  responsibleOwnerType?: LaunchOwnerType;
  responsibleUserId?: number | null;
}

export async function addCampaignItem(launchPlanId: string, brokerageId: number, actor: ActorRef, input: AddCampaignItemInput): Promise<CampaignItem> {
  const plan = await loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
  const property = await assertPropertyInBrokerage(plan.propertyId, brokerageId);

  let ownerType = input.responsibleOwnerType ?? null;
  let ownerUserId = input.responsibleUserId ?? null;
  let defaultAssigned = false;
  if (!ownerType) {
    const owner = resolveDefaultOwner(property, false);
    ownerType = owner.ownerType;
    ownerUserId = owner.ownerUserId;
    defaultAssigned = true;
  }

  const dueAt = input.dueAt ?? (input.leadDays != null && plan.targetLaunchDate ? calculateDueDate(plan.targetLaunchDate, input.leadDays) : null);

  const [item] = await db
    .insert(campaignItems)
    .values({
      launchPlanId,
      propertyId: plan.propertyId,
      brokerageId,
      itemType: input.itemType,
      title: input.title,
      description: input.description ?? null,
      responsibleOwnerType: ownerType,
      responsibleUserId: ownerUserId,
      leadDays: input.leadDays ?? null,
      dueAt,
    })
    .returning();

  await logAudit({ userId: actor.id, action: "campaign_item_added", recordType: "campaign_item", recordId: item.id, propertyId: plan.propertyId, updatedValue: item.title });
  await emit("CAMPAIGN_ITEM_ADDED", plan, actor, "api:launch:add-campaign-item", { launchPlanId, campaignItemId: item.id, itemType: item.itemType });
  if (defaultAssigned) {
    await emit("LAUNCH_DEFAULT_RESPONSIBILITY_ASSIGNED", plan, actor, "api:launch:add-campaign-item", { campaignItemId: item.id, ownerType, ownerUserId });
  }

  await afterLaunchMutation(launchPlanId, brokerageId, actor);
  return item;
}

export async function updateCampaignItemStatus(campaignItemId: string, brokerageId: number, actor: ActorRef, status: CampaignItemStatus, blockedReason?: string): Promise<CampaignItem> {
  const item = await loadCampaignItemInBrokerage(campaignItemId, brokerageId);
  if (status === "BLOCKED" && !blockedReason) {
    throw new LaunchError("VALIDATION", "blockedReason is required when marking a campaign item BLOCKED.");
  }
  const now = new Date();
  const [updated] = await db
    .update(campaignItems)
    .set({
      status,
      blockedAt: status === "BLOCKED" ? now : null,
      blockedReason: status === "BLOCKED" ? blockedReason ?? null : null,
      completedAt: status === "COMPLETE" ? now : status === "TO_ORGANISE" || status === "IN_PROGRESS" ? null : item.completedAt,
      updatedAt: now,
    })
    .where(eq(campaignItems.id, campaignItemId))
    .returning();

  const scope = { propertyId: item.propertyId, brokerageId };
  await logAudit({
    userId: actor.id,
    action: "campaign_item_status_changed",
    recordType: "campaign_item",
    recordId: campaignItemId,
    propertyId: item.propertyId,
    previousValue: item.status,
    updatedValue: status,
  });
  await emit("CAMPAIGN_ITEM_STATUS_CHANGED", scope, actor, "api:launch:update-campaign-item-status", { campaignItemId, fromStatus: item.status, toStatus: status });
  if (status === "BLOCKED") {
    await emit("CAMPAIGN_ITEM_BLOCKED", scope, actor, "api:launch:update-campaign-item-status", { campaignItemId, reason: blockedReason });
  }
  if (status === "COMPLETE") {
    await emit("CAMPAIGN_ITEM_COMPLETED", scope, actor, "api:launch:update-campaign-item-status", { campaignItemId, itemType: item.itemType });
  }

  await afterLaunchMutation(item.launchPlanId, brokerageId, actor);
  return updated;
}

/** Manual reassignment — mirrors exceptions/model.ts's reassignOwner: audit-logged only, no domain event (LAUNCH_DEFAULT_RESPONSIBILITY_ASSIGNED covers the system-default case, not a human override of it). */
export async function assignResponsibility(campaignItemId: string, brokerageId: number, actor: ActorRef, ownerType: LaunchOwnerType, ownerUserId: number | null): Promise<CampaignItem> {
  const item = await loadCampaignItemInBrokerage(campaignItemId, brokerageId);
  const [updated] = await db
    .update(campaignItems)
    .set({ responsibleOwnerType: ownerType, responsibleUserId: ownerUserId, updatedAt: new Date() })
    .where(eq(campaignItems.id, campaignItemId))
    .returning();
  await logAudit({
    userId: actor.id,
    action: "campaign_item_responsibility_assigned",
    recordType: "campaign_item",
    recordId: campaignItemId,
    propertyId: item.propertyId,
    previousValue: `${item.responsibleOwnerType}:${item.responsibleUserId ?? ""}`,
    updatedValue: `${ownerType}:${ownerUserId ?? ""}`,
  });
  return updated;
}

export async function recordVendorAndCost(campaignItemId: string, brokerageId: number, actor: ActorRef, vendorName: string | null, costCents: number): Promise<CampaignItem> {
  const item = await loadCampaignItemInBrokerage(campaignItemId, brokerageId);
  const costApprovalRequired = costCents >= LAUNCH_VENDOR_APPROVAL_THRESHOLD_CENTS;

  const [updated] = await db
    .update(campaignItems)
    .set({ vendorName, costCents, costApprovalRequired, updatedAt: new Date() })
    .where(eq(campaignItems.id, campaignItemId))
    .returning();

  const scope = { propertyId: item.propertyId, brokerageId };
  await logAudit({
    userId: actor.id,
    action: "campaign_item_vendor_cost_recorded",
    recordType: "campaign_item",
    recordId: campaignItemId,
    propertyId: item.propertyId,
    updatedValue: `${vendorName ?? "unnamed vendor"}: $${(costCents / 100).toFixed(2)}`,
  });

  if (vendorName && vendorName !== item.vendorName) {
    await emit("VENDOR_SELECTED", scope, actor, "api:launch:record-vendor-cost", { campaignItemId, vendorName });
  }
  await emit("VENDOR_COST_RECORDED", scope, actor, "api:launch:record-vendor-cost", { campaignItemId, costCents });

  // Crossing into approval-required territory raises the approval
  // automatically rather than leaving an unapproved cost silently sitting
  // on the item — but only if one isn't already open for this item.
  if (costApprovalRequired && !item.costApprovalRequired) {
    const [existingApproval] = await db
      .select({ id: vendorApprovals.id })
      .from(vendorApprovals)
      .where(and(eq(vendorApprovals.campaignItemId, campaignItemId), inArray(vendorApprovals.status, ["PENDING", "CHANGES_REQUESTED"])));
    if (!existingApproval) {
      await requestVendorApprovalInternal(item.launchPlanId, brokerageId, actor, {
        approvalType: "CAMPAIGN_ITEM_COST",
        campaignItemId,
        requestedAmountCents: costCents,
      }, "launch-engine:vendor-cost-threshold");
    }
  }

  await afterLaunchMutation(item.launchPlanId, brokerageId, actor);
  return updated;
}

export interface EvidenceRef {
  label: string;
  url: string;
  attachedAt: string;
  attachedByUserId: number;
}

export async function attachCampaignItemEvidence(campaignItemId: string, brokerageId: number, actor: ActorRef, label: string, url: string): Promise<CampaignItem> {
  const item = await loadCampaignItemInBrokerage(campaignItemId, brokerageId);
  const entry: EvidenceRef = { label, url, attachedAt: new Date().toISOString(), attachedByUserId: actor.id };
  const [updated] = await db
    .update(campaignItems)
    .set({ evidence: sql`${campaignItems.evidence} || ${JSON.stringify([entry])}::jsonb`, updatedAt: new Date() })
    .where(eq(campaignItems.id, campaignItemId))
    .returning();
  await logAudit({ userId: actor.id, action: "campaign_item_evidence_attached", recordType: "campaign_item", recordId: campaignItemId, propertyId: item.propertyId, updatedValue: label });
  await emit("CAMPAIGN_ITEM_EVIDENCE_ATTACHED", { propertyId: item.propertyId, brokerageId }, actor, "api:launch:attach-evidence", { campaignItemId, label });
  return updated;
}

// ---------------------------------------------------------------------
// Vendor / budget approvals.
// ---------------------------------------------------------------------

export interface RequestVendorApprovalInput {
  approvalType: VendorApprovalType;
  campaignItemId?: string | null;
  requestedAmountCents: number;
}

async function requestVendorApprovalInternal(
  launchPlanId: string,
  brokerageId: number,
  actor: ActorRef,
  input: RequestVendorApprovalInput,
  source: string,
): Promise<VendorApproval> {
  const plan = await loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
  const [approval] = await db
    .insert(vendorApprovals)
    .values({
      launchPlanId,
      campaignItemId: input.campaignItemId ?? null,
      propertyId: plan.propertyId,
      brokerageId,
      approvalType: input.approvalType,
      requestedAmountCents: input.requestedAmountCents,
      requestedBy: actor.id,
    })
    .returning();
  await logAudit({
    userId: actor.id,
    action: "vendor_approval_requested",
    recordType: "vendor_approval",
    recordId: approval.id,
    propertyId: plan.propertyId,
    updatedValue: `$${(input.requestedAmountCents / 100).toFixed(2)}`,
  });
  await emit("VENDOR_APPROVAL_REQUESTED", plan, actor, source, {
    launchPlanId,
    vendorApprovalId: approval.id,
    approvalType: input.approvalType,
    requestedAmountCents: input.requestedAmountCents,
  });
  return approval;
}

export async function requestVendorApproval(launchPlanId: string, brokerageId: number, actor: ActorRef, input: RequestVendorApprovalInput): Promise<VendorApproval> {
  const approval = await requestVendorApprovalInternal(launchPlanId, brokerageId, actor, input, "api:launch:request-vendor-approval");
  await afterLaunchMutation(launchPlanId, brokerageId, actor);
  return approval;
}

export type VendorApprovalDecision = "APPROVED" | "REJECTED" | "CHANGES_REQUESTED";

/** Route-gated to Brokerage Administrator only — mirrors the existing refund/agent-paid/AML-exception-resolution precedent for anything finalising a financial outcome (role check happens at the route level, never re-checked here). */
export async function decideVendorApproval(
  vendorApprovalId: string,
  brokerageId: number,
  actor: ActorRef,
  decision: VendorApprovalDecision,
  approvedAmountCents: number | null,
  decisionNotes: string | null,
): Promise<VendorApproval> {
  const approval = await loadVendorApprovalInBrokerage(vendorApprovalId, brokerageId);
  if (approval.status !== "PENDING" && approval.status !== "CHANGES_REQUESTED") {
    throw new LaunchError("INVALID_STATUS", `Cannot decide a vendor approval in status ${approval.status}`);
  }

  const [updated] = await db
    .update(vendorApprovals)
    .set({
      status: decision,
      approvedAmountCents: decision === "APPROVED" ? approvedAmountCents ?? approval.requestedAmountCents : null,
      decidedBy: actor.id,
      decidedAt: new Date(),
      decisionNotes,
      updatedAt: new Date(),
    })
    .where(eq(vendorApprovals.id, vendorApprovalId))
    .returning();

  if (decision === "APPROVED" && approval.campaignItemId) {
    await db.update(campaignItems).set({ costApprovedAt: new Date(), costApprovedBy: actor.id, updatedAt: new Date() }).where(eq(campaignItems.id, approval.campaignItemId));
  }

  await logAudit({
    userId: actor.id,
    action: "vendor_approval_decided",
    recordType: "vendor_approval",
    recordId: vendorApprovalId,
    propertyId: approval.propertyId,
    previousValue: approval.status,
    updatedValue: decision,
  });
  await emit("VENDOR_APPROVAL_DECIDED", { propertyId: approval.propertyId, brokerageId }, actor, "api:launch:decide-vendor-approval", { vendorApprovalId, decision });

  await afterLaunchMutation(approval.launchPlanId, brokerageId, actor);
  return updated;
}

/** Route-gated to Brokerage Administrator only — same financial-action precedent as decideVendorApproval. */
export async function setBudget(launchPlanId: string, brokerageId: number, actor: ActorRef, budgetCents: number): Promise<LaunchPlan> {
  const plan = await loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
  await db.update(launchPlans).set({ budgetCents, budgetSetAt: new Date(), budgetSetBy: actor.id, updatedAt: new Date() }).where(eq(launchPlans.id, launchPlanId));
  await recordTransition(launchPlanId, brokerageId, "BUDGET_SET", { fromValue: String(plan.budgetCents), toValue: String(budgetCents), actorType: "USER", actorUserId: actor.id });
  await logAudit({
    userId: actor.id,
    action: "launch_budget_set",
    recordType: "launch_plan",
    recordId: launchPlanId,
    propertyId: plan.propertyId,
    previousValue: String(plan.budgetCents),
    updatedValue: String(budgetCents),
  });
  await emit("LAUNCH_BUDGET_SET", plan, actor, "api:launch:set-budget", { launchPlanId, budgetCents });

  await afterLaunchMutation(launchPlanId, brokerageId, actor);
  return loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
}

// ---------------------------------------------------------------------
// Portal destinations.
// ---------------------------------------------------------------------

export async function addPortalDestination(launchPlanId: string, brokerageId: number, actor: ActorRef, portalName: string): Promise<PortalDestination> {
  const plan = await loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
  const [dest] = await db.insert(portalDestinations).values({ launchPlanId, propertyId: plan.propertyId, brokerageId, portalName }).returning();
  await logAudit({ userId: actor.id, action: "portal_destination_added", recordType: "portal_destination", recordId: dest.id, propertyId: plan.propertyId, updatedValue: portalName });
  await emit("PORTAL_DESTINATION_ADDED", plan, actor, "api:launch:add-portal-destination", { launchPlanId, portalDestinationId: dest.id, portalName });

  await afterLaunchMutation(launchPlanId, brokerageId, actor);
  return dest;
}

/**
 * Step 5 (Integration and Data Exchange Foundation): actor is now
 * ActorRef | null, widened from the original agent-only ActorRef, so
 * lib/integrations/launchProof.ts's webhook-driven effect handler can call
 * this exact function (never a parallel copy of it) when a mock portal
 * confirms a submission asynchronously — mirroring how getOrCreateLaunchPlan
 * above already accepts a null actor for its own system-triggered caller
 * (the AGENCY_AGREEMENT_SIGNED handler). A null actor records
 * actorType "SYSTEM" throughout (emit/afterLaunchMutation already handle
 * this), and submittedBy/logAudit's userId are simply omitted rather than
 * fabricating a human attribution for a system-driven event. This is purely
 * a widening (no existing caller passes null today), so no existing route
 * is affected.
 */
export async function recordPortalSubmission(portalDestinationId: string, brokerageId: number, actor: ActorRef | null, listingUrl?: string): Promise<PortalDestination> {
  const dest = await loadPortalDestinationInBrokerage(portalDestinationId, brokerageId);
  const [updated] = await db
    .update(portalDestinations)
    .set({ status: "SUBMITTED", submittedAt: new Date(), submittedBy: actor?.id ?? null, listingUrl: listingUrl ?? dest.listingUrl, failureReason: null, updatedAt: new Date() })
    .where(eq(portalDestinations.id, portalDestinationId))
    .returning();
  await logAudit({ userId: actor?.id, action: "portal_submission_recorded", recordType: "portal_destination", recordId: portalDestinationId, propertyId: dest.propertyId, updatedValue: dest.portalName });
  await emit("PORTAL_SUBMISSION_RECORDED", { propertyId: dest.propertyId, brokerageId }, actor, "api:launch:record-portal-submission", { portalDestinationId, portalName: dest.portalName });

  await afterLaunchMutation(dest.launchPlanId, brokerageId, actor);
  return updated;
}

/** Step 5: actor is ActorRef | null — see recordPortalSubmission's own comment above for why. */
export async function recordPortalFailure(portalDestinationId: string, brokerageId: number, actor: ActorRef | null, failureReason: string): Promise<PortalDestination> {
  const dest = await loadPortalDestinationInBrokerage(portalDestinationId, brokerageId);
  const [updated] = await db
    .update(portalDestinations)
    .set({ status: "FAILED", failureReason, updatedAt: new Date() })
    .where(eq(portalDestinations.id, portalDestinationId))
    .returning();
  await logAudit({ userId: actor?.id, action: "portal_submission_failed", recordType: "portal_destination", recordId: portalDestinationId, propertyId: dest.propertyId, updatedValue: failureReason });
  await emit("PORTAL_SUBMISSION_FAILED", { propertyId: dest.propertyId, brokerageId }, actor, "api:launch:record-portal-failure", { portalDestinationId, portalName: dest.portalName, failureReason });

  await afterLaunchMutation(dest.launchPlanId, brokerageId, actor);
  return updated;
}

/**
 * Not itself one of the 23 named WAE events — a per-portal "confirmed live"
 * is an internal operational detail; the property-level moment that
 * matters (LISTING_LIVE) is published once, by confirmLaunchLive ->
 * goLiveProperty, never duplicated here. Step 5: actor is ActorRef | null
 * (see recordPortalSubmission's own comment) — deliberately this function,
 * and ONLY this function, is what a mock portal's "listing is live"
 * webhook is allowed to call. It flips this one destination's own record
 * to LIVE and nothing else: it never calls confirmLaunchLive, never
 * touches launchPlans.status's LISTING_LIVE value, and never bypasses
 * evaluateListingLive's Market Ready / at-least-one-LIVE-destination gate
 * that confirmLaunchLive still enforces on its own, separate, human-
 * or-explicit-action-only path — see
 * apps/api/src/lib/integrations/__tests__/launchProof.test.ts's own
 * "cannot bypass Market Ready" assertion.
 */
export async function confirmPortalLive(portalDestinationId: string, brokerageId: number, actor: ActorRef | null, listingUrl?: string): Promise<PortalDestination> {
  const dest = await loadPortalDestinationInBrokerage(portalDestinationId, brokerageId);
  const [updated] = await db
    .update(portalDestinations)
    .set({ status: "LIVE", liveConfirmedAt: new Date(), liveConfirmedBy: actor?.id ?? null, listingUrl: listingUrl ?? dest.listingUrl, updatedAt: new Date() })
    .where(eq(portalDestinations.id, portalDestinationId))
    .returning();
  await logAudit({ userId: actor?.id, action: "portal_confirmed_live", recordType: "portal_destination", recordId: portalDestinationId, propertyId: dest.propertyId, updatedValue: dest.portalName });

  await afterLaunchMutation(dest.launchPlanId, brokerageId, actor);
  return updated;
}

// ---------------------------------------------------------------------
// Market Ready / Listing Live.
// ---------------------------------------------------------------------

export async function evaluateAndUpdateMarketReady(launchPlanId: string, brokerageId: number, actor: ActorRef | null): Promise<MarketReadyResult> {
  const plan = await loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
  const result = await evaluateAndUpdateMarketReadyInternal(plan, actor);
  await refreshLaunchPlanStatus(launchPlanId, brokerageId);
  return result;
}

/** Route-gated to Brokerage Administrator only — a human override of the deterministic blockers is a financial/compliance-adjacent judgement call, same weight class as the AML manual-resolution precedent. */
export async function overrideMarketReady(launchPlanId: string, brokerageId: number, actor: ActorRef, reason: string): Promise<LaunchPlan> {
  const plan = await loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
  await db
    .update(launchPlans)
    .set({ marketReadyOverriddenAt: new Date(), marketReadyOverriddenBy: actor.id, marketReadyOverrideReason: reason, updatedAt: new Date() })
    .where(eq(launchPlans.id, launchPlanId));
  await recordTransition(launchPlanId, brokerageId, "MARKET_READY_OVERRIDDEN", { toValue: "OVERRIDDEN", actorType: "USER", actorUserId: actor.id, reason });
  await logAudit({ userId: actor.id, action: "market_ready_overridden", recordType: "launch_plan", recordId: launchPlanId, propertyId: plan.propertyId, updatedValue: reason });
  await emit("MARKET_READY_OVERRIDDEN", plan, actor, "api:launch:override-market-ready", { launchPlanId, reason });

  await refreshLaunchPlanStatus(launchPlanId, brokerageId);
  return loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
}

/**
 * Confirms Listing Live. Never flips the property live itself — delegates
 * entirely to lib/goLive.ts's goLiveProperty(), the single existing
 * chokepoint (also used by routes/properties.ts's own go-live endpoint),
 * so there is exactly one place a property ever becomes Listed and exactly
 * one LISTING_LIVE publish for it. Requires evaluateListingLive() to be
 * satisfied first (Market Ready achieved-or-overridden, at least one
 * portal destination LIVE) — a Launch-specific gate on top of goLive's own
 * Ready to List gate, not a replacement for it.
 */
export async function confirmLaunchLive(launchPlanId: string, brokerageId: number, actor: ActorRef): Promise<LaunchPlan> {
  const plan = await loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
  const readiness = await evaluateListingLive(plan);
  if (!readiness.ready) {
    throw new LaunchError("NOT_READY", `Cannot confirm listing live: ${readiness.reasons.join(" ")}`);
  }

  const result = await goLiveProperty(plan.propertyId, brokerageId, { id: actor.id }, "api:launch:confirm-live");
  if (!result.ok) {
    const message = result.reason === "NO_READY_TO_LIST_WORKFLOW" ? "This property has not completed Ready to List." : "Ready to List has incomplete steps.";
    throw new LaunchError("NOT_READY", message);
  }

  const [updated] = await db
    .update(launchPlans)
    .set({ status: "LISTING_LIVE", listingLiveConfirmedAt: new Date(), listingLiveConfirmedBy: actor.id, actualLaunchDate: new Date(), updatedAt: new Date() })
    .where(eq(launchPlans.id, launchPlanId))
    .returning();
  await recordTransition(launchPlanId, brokerageId, "LISTING_LIVE_CONFIRMED", { fromValue: plan.status, toValue: "LISTING_LIVE", actorType: "USER", actorUserId: actor.id });
  await logAudit({ userId: actor.id, action: "launch_listing_live_confirmed", recordType: "launch_plan", recordId: launchPlanId, propertyId: plan.propertyId });

  return updated;
}

// ---------------------------------------------------------------------
// Pause / resume / cancel — manual side-branches reachable from any
// non-terminal status (schema comment on LAUNCH_PLAN_STATUSES).
// ---------------------------------------------------------------------

export async function pauseLaunchPlan(launchPlanId: string, brokerageId: number, actor: ActorRef, reason: string): Promise<LaunchPlan> {
  const plan = await loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
  if (plan.status === "CANCELLED" || plan.status === "LISTING_LIVE" || plan.status === "PAUSED") {
    throw new LaunchError("INVALID_STATUS", `Cannot pause a launch plan in status ${plan.status}`);
  }
  const [updated] = await db
    .update(launchPlans)
    .set({ status: "PAUSED", pausedAt: new Date(), pausedBy: actor.id, pauseReason: reason, updatedAt: new Date() })
    .where(eq(launchPlans.id, launchPlanId))
    .returning();
  await recordTransition(launchPlanId, brokerageId, "PAUSED", { fromValue: plan.status, toValue: "PAUSED", actorType: "USER", actorUserId: actor.id, reason });
  await logAudit({ userId: actor.id, action: "launch_paused", recordType: "launch_plan", recordId: launchPlanId, propertyId: plan.propertyId, updatedValue: reason });
  await emit("LAUNCH_PAUSED", plan, actor, "api:launch:pause", { launchPlanId, reason });
  return updated;
}

/** No dedicated WAE event — only PAUSED/CANCELLED are named in the governing spec's event list; resuming re-derives the plan's real status live rather than restoring a stored "previous" value, so no extra column was needed to make this safe. */
export async function resumeLaunchPlan(launchPlanId: string, brokerageId: number, actor: ActorRef): Promise<LaunchPlan> {
  const plan = await loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
  if (plan.status !== "PAUSED") {
    throw new LaunchError("INVALID_STATUS", "This launch plan is not paused.");
  }
  await db.update(launchPlans).set({ pausedAt: null, pausedBy: null, pauseReason: null, updatedAt: new Date() }).where(eq(launchPlans.id, launchPlanId));
  await recordTransition(launchPlanId, brokerageId, "RESUMED", { fromValue: "PAUSED", toValue: null, actorType: "USER", actorUserId: actor.id });
  await logAudit({ userId: actor.id, action: "launch_resumed", recordType: "launch_plan", recordId: launchPlanId, propertyId: plan.propertyId });

  await afterLaunchMutation(launchPlanId, brokerageId, actor);
  return loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
}

export async function cancelLaunchPlan(launchPlanId: string, brokerageId: number, actor: ActorRef, reason: string): Promise<LaunchPlan> {
  const plan = await loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
  if (plan.status === "LISTING_LIVE") {
    throw new LaunchError("INVALID_STATUS", "Cannot cancel a launch plan whose listing is already live.");
  }
  if (plan.status === "CANCELLED") return plan;
  const [updated] = await db
    .update(launchPlans)
    .set({ status: "CANCELLED", cancelledAt: new Date(), cancelledBy: actor.id, cancelReason: reason, updatedAt: new Date() })
    .where(eq(launchPlans.id, launchPlanId))
    .returning();
  await recordTransition(launchPlanId, brokerageId, "CANCELLED", { fromValue: plan.status, toValue: "CANCELLED", actorType: "USER", actorUserId: actor.id, reason });
  await logAudit({ userId: actor.id, action: "launch_cancelled", recordType: "launch_plan", recordId: launchPlanId, propertyId: plan.propertyId, updatedValue: reason });
  await emit("LAUNCH_CANCELLED", plan, actor, "api:launch:cancel", { launchPlanId, reason });
  return updated;
}

// ---------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------

export interface LaunchPlanDetail {
  plan: LaunchPlan;
  items: CampaignItem[];
  destinations: PortalDestination[];
  approvals: VendorApproval[];
}

/** Returns null (not a thrown NOT_FOUND) when the property exists but has no launch plan yet — a property that hasn't reached AGENCY_AGREEMENT_SIGNED is a normal, expected state, not an error. */
export async function getLaunchPlanDetail(propertyId: number, brokerageId: number): Promise<LaunchPlanDetail | null> {
  await assertPropertyInBrokerage(propertyId, brokerageId);
  const [plan] = await db.select().from(launchPlans).where(eq(launchPlans.propertyId, propertyId));
  if (!plan) return null;

  const [items, destinations, approvals] = await Promise.all([
    db.select().from(campaignItems).where(eq(campaignItems.launchPlanId, plan.id)),
    db.select().from(portalDestinations).where(eq(portalDestinations.launchPlanId, plan.id)),
    db.select().from(vendorApprovals).where(eq(vendorApprovals.launchPlanId, plan.id)),
  ]);

  return { plan, items, destinations, approvals };
}

export async function getLaunchPlanTransitions(launchPlanId: string, brokerageId: number): Promise<LaunchPlanTransition[]> {
  await loadLaunchPlanInBrokerage(launchPlanId, brokerageId);
  return db.select().from(launchPlanTransitions).where(eq(launchPlanTransitions.launchPlanId, launchPlanId)).orderBy(asc(launchPlanTransitions.occurredAt));
}
