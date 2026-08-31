// Agent Engine 2.0 — Property Launch & Campaign Coordination.
//
// The deterministic Market Ready evaluator. Same discipline as the
// Exception & Risk Engine's rules (exceptions/rules/*.ts): reads live
// domain state and returns a complete, reproducible result — no manual
// judgement calls, no partial credit, no "looks close enough". Calling
// this twice against the same unchanged state always returns the same
// blockers.

import { eq, and, inArray } from "drizzle-orm";
import {
  db,
  campaignItems,
  portalDestinations,
  vendorApprovals,
  workflows,
  workflowSteps,
  type LaunchPlan,
} from "@aee/db";
import {
  REQUIRED_CAMPAIGN_ITEM_TYPES,
  type MarketReadyBlocker,
  type MarketReadyResult,
} from "./types.js";

/**
 * Evaluate whether a Launch Plan is Market Ready. Reads campaign items,
 * portal destinations, and vendor approvals directly (never trusts a
 * cached/denormalised field) so the result is always derived from current
 * truth — the same "complete, authoritative set" discipline the Exception
 * & Risk Engine's scanBrokerage() methods already follow, which is what
 * lets this function's result double as the input to the ERX Launch rules
 * (exceptions/rules/launchCampaign.ts) without a second implementation.
 */
export async function evaluateMarketReady(plan: LaunchPlan): Promise<MarketReadyResult> {
  const blockers: MarketReadyBlocker[] = [];
  const now = new Date();

  // Agency agreement must actually be signed — the property must have
  // passed the same AgencyAgreement workflow step Go Live itself gates on
  // (see lib/goLive.ts), checked directly rather than assumed from the
  // Launch Plan merely existing.
  const [readyToListWorkflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.propertyId, plan.propertyId), eq(workflows.workflowType, "ReadyToList")));
  let agencyAgreementSigned = false;
  if (readyToListWorkflow) {
    const [agencyStep] = await db
      .select()
      .from(workflowSteps)
      .where(and(eq(workflowSteps.workflowId, readyToListWorkflow.id), eq(workflowSteps.stepKey, "AgencyAgreement")));
    agencyAgreementSigned = agencyStep?.status === "Complete";
  }
  if (!agencyAgreementSigned) {
    blockers.push({ code: "AGENCY_AGREEMENT_NOT_SIGNED", message: "The Agency Agreement has not been signed yet." });
  }

  if (!plan.targetLaunchDate) {
    blockers.push({ code: "TARGET_LAUNCH_DATE_MISSING", message: "No target launch date has been set." });
  }

  const items = await db.select().from(campaignItems).where(eq(campaignItems.launchPlanId, plan.id));

  const missingRequiredTypes = REQUIRED_CAMPAIGN_ITEM_TYPES.filter((type) => {
    const matching = items.filter((i) => i.itemType === type);
    return matching.length === 0 || !matching.some((i) => i.status === "COMPLETE");
  });
  if (missingRequiredTypes.length > 0) {
    blockers.push({
      code: "MISSING_REQUIRED_CAMPAIGN_ITEMS",
      message: `The following required campaign items are not yet complete: ${missingRequiredTypes.join(", ")}.`,
      refs: missingRequiredTypes.map((t) => ({ recordType: "campaign_item_type", recordId: t })),
    });
  }

  const blockedItems = items.filter((i) => i.status === "BLOCKED");
  if (blockedItems.length > 0) {
    blockers.push({
      code: "CAMPAIGN_ITEMS_BLOCKED",
      message: `${blockedItems.length} campaign item(s) are currently blocked.`,
      refs: blockedItems.map((i) => ({ recordType: "campaign_item", recordId: i.id })),
    });
  }

  const pendingApprovals = await db
    .select()
    .from(vendorApprovals)
    .where(and(eq(vendorApprovals.launchPlanId, plan.id), inArray(vendorApprovals.status, ["PENDING", "CHANGES_REQUESTED"])));
  if (pendingApprovals.length > 0) {
    blockers.push({
      code: "PENDING_VENDOR_APPROVALS",
      message: `${pendingApprovals.length} vendor/budget approval(s) are still pending.`,
      refs: pendingApprovals.map((a) => ({ recordType: "vendor_approval", recordId: a.id })),
    });
  }

  if (plan.budgetCents > 0 && plan.budgetSpentCents > plan.budgetCents) {
    blockers.push({
      code: "BUDGET_EXCEEDED",
      message: `Recorded spend ($${(plan.budgetSpentCents / 100).toFixed(2)}) exceeds the approved budget ($${(plan.budgetCents / 100).toFixed(2)}).`,
    });
  }

  const destinations = await db.select().from(portalDestinations).where(eq(portalDestinations.launchPlanId, plan.id));
  if (destinations.length === 0) {
    blockers.push({ code: "NO_PORTAL_DESTINATIONS_CONFIGURED", message: "No portal destinations have been added to this launch plan." });
  }

  return { ready: blockers.length === 0, blockers, evaluatedAt: now };
}

/**
 * Listing Live evaluation — deliberately distinct from Market Ready (the
 * governing spec calls for both). Market Ready asks "is the campaign
 * itself ready"; this asks "has the listing actually gone live" —
 * requiring Market Ready to have passed AND at least one portal
 * destination confirmed LIVE. It does not itself flip anything live; see
 * lib/launch/model.ts's confirmLaunchLive(), which calls this then the
 * shared lib/goLive.ts chokepoint.
 */
export async function evaluateListingLive(plan: LaunchPlan): Promise<{ ready: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  const marketReady = await evaluateMarketReady(plan);
  if (!marketReady.ready && !plan.marketReadyOverriddenAt) {
    reasons.push("Market Ready has not been confirmed (and no override is on record).");
  }
  const liveDestinations = await db
    .select()
    .from(portalDestinations)
    .where(and(eq(portalDestinations.launchPlanId, plan.id), eq(portalDestinations.status, "LIVE")));
  if (liveDestinations.length === 0) {
    reasons.push("No portal destination has been confirmed live yet.");
  }
  return { ready: reasons.length === 0, reasons };
}
