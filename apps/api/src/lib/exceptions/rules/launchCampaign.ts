// Agent Engine 2.0 — Property Launch & Campaign Coordination.
// Category: LAUNCH_CAMPAIGN (packages/db/src/schema/exceptions.ts). Reuses
// the Exception & Risk Engine outright rather than building a parallel
// Launch-specific warning system — these 13 rules are ordinary entries in
// the same RISK_RULES registry every other category uses, so auto-
// resolution/dedup/the periodic scan/the event-driven re-scan all apply
// unchanged (see registry.ts's own module comment). Every rule filters to
// OPEN_LAUNCH_PLAN_STATUSES (or, for L11, specifically PAUSED) so a
// paused/cancelled/already-live plan's exceptions auto-resolve the moment
// it leaves the scan's result set, rather than needing a special case.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, launchPlans, campaignItems, portalDestinations, vendorApprovals, properties, OPEN_LAUNCH_PLAN_STATUSES } from "@aee/db";
import type { RiskRule } from "../registry.js";
import type { RiskFinding } from "../types.js";
import { dedupKey, daysBetween, escalatesAtFor, resolveDefaultOwner, severityForDeadline } from "./shared.js";

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

const L01_TARGET_DATE_NOT_SET: RiskRule = {
  ruleId: "L01_LAUNCH_PLAN_TARGET_DATE_NOT_SET",
  version: 1,
  category: "LAUNCH_CAMPAIGN",
  name: "Launch plan has no target launch date",
  description: "A Launch Plan has sat in Planning without a target launch date being set for longer than the expected window.",
  triggerEventTypes: ["LAUNCH_PLAN_CREATED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ plan: launchPlans, property: properties })
      .from(launchPlans)
      .innerJoin(properties, eq(launchPlans.propertyId, properties.id))
      .where(and(eq(launchPlans.brokerageId, brokerageId), isNull(launchPlans.targetLaunchDate), inArray(launchPlans.status, OPEN_LAUNCH_PLAN_STATUSES)));

    const findings: RiskFinding[] = [];
    for (const { plan, property } of rows) {
      const dueDate = addDays(plan.createdAt, 5);
      const severity = severityForDeadline(now, dueDate, 2, 7);
      if (severity === "INFORMATION") continue;
      const owner = resolveDefaultOwner(property, false);
      findings.push({
        ruleId: L01_TARGET_DATE_NOT_SET.ruleId,
        ruleVersion: L01_TARGET_DATE_NOT_SET.version,
        category: "LAUNCH_CAMPAIGN",
        severity,
        title: "Launch plan is missing a target launch date",
        problemDescription: `This launch plan was created on ${plan.createdAt.toDateString()} and still has no target launch date.`,
        businessImpact: "Without a target date, campaign due dates cannot be calculated and the vendor cannot plan production.",
        detectedCause: "launch_plans.target_launch_date is null beyond the expected planning window.",
        ...owner,
        propertyId: plan.propertyId,
        transactionId: null,
        dueAt: dueDate,
        escalatesAt: escalatesAtFor(dueDate, 7),
        recommendedAction: "Set a target launch date for this property.",
        resolutionRequirements: "launch_plans.target_launch_date is set.",
        dismissible: false,
        sourceRecordType: "launch_plan",
        sourceRecordId: plan.id,
        dedupKey: dedupKey(L01_TARGET_DATE_NOT_SET.ruleId, brokerageId, plan.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
      });
    }
    return findings;
  },
};

const L02_NO_CAMPAIGN_ITEMS_NEAR_DATE: RiskRule = {
  ruleId: "L02_LAUNCH_PLAN_NO_CAMPAIGN_ITEMS_NEAR_DATE",
  version: 1,
  category: "LAUNCH_CAMPAIGN",
  name: "No campaign items as the target launch date approaches",
  description: "A target launch date is set but no campaign items (photography, copy, etc.) have been added yet, and the date is close or has passed.",
  triggerEventTypes: ["LAUNCH_TARGET_DATE_CHANGED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ plan: launchPlans, property: properties })
      .from(launchPlans)
      .innerJoin(properties, eq(launchPlans.propertyId, properties.id))
      .where(and(eq(launchPlans.brokerageId, brokerageId), inArray(launchPlans.status, OPEN_LAUNCH_PLAN_STATUSES)));

    const findings: RiskFinding[] = [];
    for (const { plan, property } of rows) {
      if (!plan.targetLaunchDate) continue;
      const existingItems = await db.select({ id: campaignItems.id }).from(campaignItems).where(eq(campaignItems.launchPlanId, plan.id)).limit(1);
      if (existingItems.length > 0) continue;
      const severity = severityForDeadline(now, plan.targetLaunchDate, 14, 0);
      if (severity === "INFORMATION") continue;
      const owner = resolveDefaultOwner(property, false);
      findings.push({
        ruleId: L02_NO_CAMPAIGN_ITEMS_NEAR_DATE.ruleId,
        ruleVersion: L02_NO_CAMPAIGN_ITEMS_NEAR_DATE.version,
        category: "LAUNCH_CAMPAIGN",
        severity,
        title: "No campaign items yet with the launch date approaching",
        problemDescription: `The target launch date (${plan.targetLaunchDate.toDateString()}) is approaching or has passed and no campaign items have been added.`,
        businessImpact: "Photography, copy, and other campaign production has not started — the launch date is at risk of being missed.",
        detectedCause: "No campaign_items rows exist for this launch plan while target_launch_date is near or past.",
        ...owner,
        propertyId: plan.propertyId,
        transactionId: null,
        dueAt: plan.targetLaunchDate,
        escalatesAt: escalatesAtFor(plan.targetLaunchDate, 3),
        recommendedAction: "Apply a campaign template or add campaign items immediately.",
        resolutionRequirements: "At least one campaign_items row exists for this launch plan.",
        dismissible: false,
        sourceRecordType: "launch_plan",
        sourceRecordId: plan.id,
        dedupKey: dedupKey(L02_NO_CAMPAIGN_ITEMS_NEAR_DATE.ruleId, brokerageId, plan.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
      });
    }
    return findings;
  },
};

const L03_CAMPAIGN_ITEM_OVERDUE: RiskRule = {
  ruleId: "L03_CAMPAIGN_ITEM_OVERDUE",
  version: 1,
  category: "LAUNCH_CAMPAIGN",
  name: "Campaign item overdue",
  description: "A campaign item's due date has passed without it being marked complete.",
  triggerEventTypes: ["CAMPAIGN_ITEM_STATUS_CHANGED", "LAUNCH_DUE_DATES_CALCULATED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ item: campaignItems, property: properties })
      .from(campaignItems)
      .innerJoin(launchPlans, eq(campaignItems.launchPlanId, launchPlans.id))
      .innerJoin(properties, eq(campaignItems.propertyId, properties.id))
      .where(and(eq(campaignItems.brokerageId, brokerageId), inArray(launchPlans.status, OPEN_LAUNCH_PLAN_STATUSES)));

    const findings: RiskFinding[] = [];
    for (const { item, property } of rows) {
      if (!item.dueAt || item.status === "COMPLETE") continue;
      const severity = severityForDeadline(now, item.dueAt, 3, 7);
      if (severity === "INFORMATION") continue;
      const owner = item.responsibleUserId
        ? { ownerType: item.responsibleOwnerType as RiskFinding["ownerType"], ownerUserId: item.responsibleUserId }
        : resolveDefaultOwner(property, false);
      findings.push({
        ruleId: L03_CAMPAIGN_ITEM_OVERDUE.ruleId,
        ruleVersion: L03_CAMPAIGN_ITEM_OVERDUE.version,
        category: "LAUNCH_CAMPAIGN",
        severity,
        title: `Campaign item overdue: ${item.title}`,
        problemDescription: `"${item.title}" was due ${item.dueAt.toDateString()} and is still ${item.status}.`,
        businessImpact: "An overdue campaign item delays every downstream Launch stage (Market Ready, portal submission).",
        detectedCause: "campaign_items.due_at has passed and status is not COMPLETE.",
        ...owner,
        propertyId: item.propertyId,
        transactionId: null,
        dueAt: item.dueAt,
        escalatesAt: escalatesAtFor(item.dueAt, 7),
        recommendedAction: "Complete this campaign item or update its status/owner.",
        resolutionRequirements: "campaign_items.status becomes COMPLETE (or the due date is moved out).",
        dismissible: false,
        sourceRecordType: "campaign_item",
        sourceRecordId: item.id,
        dedupKey: dedupKey(L03_CAMPAIGN_ITEM_OVERDUE.ruleId, brokerageId, item.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
      });
    }
    return findings;
  },
};

const L04_CAMPAIGN_ITEM_BLOCKED_TOO_LONG: RiskRule = {
  ruleId: "L04_CAMPAIGN_ITEM_BLOCKED_TOO_LONG",
  version: 1,
  category: "LAUNCH_CAMPAIGN",
  name: "Campaign item blocked for an extended period",
  description: "A campaign item has been BLOCKED for longer than the expected resolution window.",
  triggerEventTypes: ["CAMPAIGN_ITEM_BLOCKED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ item: campaignItems, property: properties })
      .from(campaignItems)
      .innerJoin(launchPlans, eq(campaignItems.launchPlanId, launchPlans.id))
      .innerJoin(properties, eq(campaignItems.propertyId, properties.id))
      .where(and(eq(campaignItems.brokerageId, brokerageId), eq(campaignItems.status, "BLOCKED"), inArray(launchPlans.status, OPEN_LAUNCH_PLAN_STATUSES)));

    const findings: RiskFinding[] = [];
    for (const { item, property } of rows) {
      if (!item.blockedAt) continue;
      const daysBlocked = daysBetween(now, item.blockedAt);
      const severity = daysBlocked >= 10 ? "CRITICAL" : daysBlocked >= 5 ? "AT_RISK" : daysBlocked >= 2 ? "ATTENTION" : null;
      if (!severity) continue;
      const owner = item.responsibleUserId
        ? { ownerType: item.responsibleOwnerType as RiskFinding["ownerType"], ownerUserId: item.responsibleUserId }
        : resolveDefaultOwner(property, false);
      findings.push({
        ruleId: L04_CAMPAIGN_ITEM_BLOCKED_TOO_LONG.ruleId,
        ruleVersion: L04_CAMPAIGN_ITEM_BLOCKED_TOO_LONG.version,
        category: "LAUNCH_CAMPAIGN",
        severity,
        title: `Campaign item blocked: ${item.title}`,
        problemDescription: `"${item.title}" has been blocked since ${item.blockedAt.toDateString()}${item.blockedReason ? ` (${item.blockedReason})` : ""}.`,
        businessImpact: "A long-blocked campaign item stalls the whole launch — nothing downstream of it can proceed.",
        detectedCause: "campaign_items.status = BLOCKED beyond the expected resolution window.",
        ...owner,
        propertyId: item.propertyId,
        transactionId: null,
        dueAt: item.blockedAt,
        escalatesAt: escalatesAtFor(item.blockedAt, 10),
        recommendedAction: "Resolve whatever is blocking this campaign item, or reassign it.",
        resolutionRequirements: "campaign_items.status moves away from BLOCKED.",
        dismissible: false,
        sourceRecordType: "campaign_item",
        sourceRecordId: item.id,
        dedupKey: dedupKey(L04_CAMPAIGN_ITEM_BLOCKED_TOO_LONG.ruleId, brokerageId, item.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { daysOverdue: Math.floor(daysBlocked) },
      });
    }
    return findings;
  },
};

const L05_VENDOR_APPROVAL_PENDING_TOO_LONG: RiskRule = {
  ruleId: "L05_VENDOR_APPROVAL_PENDING_TOO_LONG",
  version: 1,
  category: "LAUNCH_CAMPAIGN",
  name: "Vendor/budget approval pending too long",
  description: "A vendor or budget approval has been PENDING or CHANGES_REQUESTED for longer than expected.",
  triggerEventTypes: ["VENDOR_APPROVAL_REQUESTED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ approval: vendorApprovals, property: properties })
      .from(vendorApprovals)
      .innerJoin(launchPlans, eq(vendorApprovals.launchPlanId, launchPlans.id))
      .innerJoin(properties, eq(vendorApprovals.propertyId, properties.id))
      .where(
        and(
          eq(vendorApprovals.brokerageId, brokerageId),
          inArray(vendorApprovals.status, ["PENDING", "CHANGES_REQUESTED"]),
          inArray(launchPlans.status, OPEN_LAUNCH_PLAN_STATUSES),
        ),
      );

    const findings: RiskFinding[] = [];
    for (const { approval, property } of rows) {
      const dueDate = addDays(approval.requestedAt, 3);
      const severity = severityForDeadline(now, dueDate, 0, 7);
      if (severity === "INFORMATION") continue;
      const owner = resolveDefaultOwner(property, false);
      findings.push({
        ruleId: L05_VENDOR_APPROVAL_PENDING_TOO_LONG.ruleId,
        ruleVersion: L05_VENDOR_APPROVAL_PENDING_TOO_LONG.version,
        category: "LAUNCH_CAMPAIGN",
        severity,
        title: "Vendor/budget approval awaiting decision",
        problemDescription: `A ${approval.approvalType} approval for $${(approval.requestedAmountCents / 100).toFixed(2)} has been awaiting a decision since ${approval.requestedAt.toDateString()}.`,
        businessImpact: "An undecided approval blocks Market Ready and stalls campaign production for anything waiting on this vendor/budget decision.",
        detectedCause: "vendor_approvals.status is PENDING or CHANGES_REQUESTED beyond the expected decision window.",
        ...owner,
        propertyId: approval.propertyId,
        transactionId: null,
        dueAt: dueDate,
        escalatesAt: escalatesAtFor(dueDate, 7),
        recommendedAction: "A Brokerage Administrator should approve, reject, or request changes on this approval.",
        resolutionRequirements: "vendor_approvals.status becomes APPROVED or REJECTED.",
        dismissible: false,
        sourceRecordType: "vendor_approval",
        sourceRecordId: approval.id,
        dedupKey: dedupKey(L05_VENDOR_APPROVAL_PENDING_TOO_LONG.ruleId, brokerageId, approval.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: true,
      });
    }
    return findings;
  },
};

const L06_COST_APPROVAL_GAP: RiskRule = {
  ruleId: "L06_CAMPAIGN_ITEM_COST_APPROVAL_GAP",
  version: 1,
  category: "LAUNCH_CAMPAIGN",
  name: "Campaign item cost requires approval but none was raised",
  description: "A campaign item's cost is above the approval threshold, is not yet approved, and has no vendor_approvals row at all — an integrity gap rather than an ordinary pending approval (see L05).",
  triggerEventTypes: ["VENDOR_COST_RECORDED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ item: campaignItems, property: properties })
      .from(campaignItems)
      .innerJoin(launchPlans, eq(campaignItems.launchPlanId, launchPlans.id))
      .innerJoin(properties, eq(campaignItems.propertyId, properties.id))
      .where(
        and(
          eq(campaignItems.brokerageId, brokerageId),
          eq(campaignItems.costApprovalRequired, true),
          isNull(campaignItems.costApprovedAt),
          inArray(launchPlans.status, OPEN_LAUNCH_PLAN_STATUSES),
        ),
      );

    const findings: RiskFinding[] = [];
    for (const { item, property } of rows) {
      const [existingApproval] = await db.select({ id: vendorApprovals.id }).from(vendorApprovals).where(eq(vendorApprovals.campaignItemId, item.id)).limit(1);
      if (existingApproval) continue; // L05 covers "approval exists but is slow"
      const owner = resolveDefaultOwner(property, false);
      findings.push({
        ruleId: L06_COST_APPROVAL_GAP.ruleId,
        ruleVersion: L06_COST_APPROVAL_GAP.version,
        category: "LAUNCH_CAMPAIGN",
        severity: "CRITICAL",
        title: `Cost above approval threshold with no approval on record: ${item.title}`,
        problemDescription: `"${item.title}" carries a cost of $${(item.costCents / 100).toFixed(2)}, above the approval threshold, but no vendor_approvals record exists for it.`,
        businessImpact: "A campaign spend above the brokerage's approval threshold with no approval record is a financial control gap.",
        detectedCause: "campaign_items.cost_approval_required = true, cost_approved_at is null, and no linked vendor_approvals row exists.",
        ...owner,
        propertyId: item.propertyId,
        transactionId: null,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Request a vendor approval for this campaign item's cost immediately.",
        resolutionRequirements: "A vendor_approvals row exists for this campaign item and is decided.",
        dismissible: false,
        sourceRecordType: "campaign_item",
        sourceRecordId: item.id,
        dedupKey: dedupKey(L06_COST_APPROVAL_GAP.ruleId, brokerageId, item.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: true,
      });
    }
    return findings;
  },
};

const L07_BUDGET_EXCEEDED_UNRESOLVED: RiskRule = {
  ruleId: "L07_LAUNCH_BUDGET_EXCEEDED_UNRESOLVED",
  version: 1,
  category: "LAUNCH_CAMPAIGN",
  name: "Launch plan budget exceeded",
  description: "A launch plan's recorded campaign spend exceeds its approved budget.",
  triggerEventTypes: ["LAUNCH_BUDGET_EXCEEDED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ plan: launchPlans, property: properties })
      .from(launchPlans)
      .innerJoin(properties, eq(launchPlans.propertyId, properties.id))
      .where(and(eq(launchPlans.brokerageId, brokerageId), inArray(launchPlans.status, OPEN_LAUNCH_PLAN_STATUSES)));

    const findings: RiskFinding[] = [];
    for (const { plan, property } of rows) {
      if (plan.budgetCents <= 0 || plan.budgetSpentCents <= plan.budgetCents) continue;
      const ratio = plan.budgetSpentCents / plan.budgetCents;
      const severity = ratio >= 1.5 ? "CRITICAL" : ratio >= 1.1 ? "AT_RISK" : "ATTENTION";
      const owner = resolveDefaultOwner(property, false);
      findings.push({
        ruleId: L07_BUDGET_EXCEEDED_UNRESOLVED.ruleId,
        ruleVersion: L07_BUDGET_EXCEEDED_UNRESOLVED.version,
        category: "LAUNCH_CAMPAIGN",
        severity,
        title: "Launch plan budget exceeded",
        problemDescription: `Recorded spend ($${(plan.budgetSpentCents / 100).toFixed(2)}) exceeds the approved budget ($${(plan.budgetCents / 100).toFixed(2)}).`,
        businessImpact: "Spend beyond the approved budget without a revised approval is a direct cost overrun.",
        detectedCause: "launch_plans.budget_spent_cents > launch_plans.budget_cents.",
        ...owner,
        propertyId: plan.propertyId,
        transactionId: null,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Increase the approved budget, or bring campaign spend back within it.",
        resolutionRequirements: "launch_plans.budget_spent_cents no longer exceeds launch_plans.budget_cents.",
        dismissible: false,
        sourceRecordType: "launch_plan",
        sourceRecordId: plan.id,
        dedupKey: dedupKey(L07_BUDGET_EXCEEDED_UNRESOLVED.ruleId, brokerageId, plan.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: true,
      });
    }
    return findings;
  },
};

const L08_MARKET_READY_BLOCKED_NEAR_DATE: RiskRule = {
  ruleId: "L08_MARKET_READY_BLOCKED_NEAR_DATE",
  version: 1,
  category: "LAUNCH_CAMPAIGN",
  name: "Market Ready still blocked as the target date approaches",
  description: "Market Ready has not been achieved (or overridden) and the target launch date is close or has passed.",
  triggerEventTypes: ["MARKET_READY_EVALUATED", "LAUNCH_TARGET_DATE_CHANGED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ plan: launchPlans, property: properties })
      .from(launchPlans)
      .innerJoin(properties, eq(launchPlans.propertyId, properties.id))
      .where(and(eq(launchPlans.brokerageId, brokerageId), inArray(launchPlans.status, OPEN_LAUNCH_PLAN_STATUSES)));

    const findings: RiskFinding[] = [];
    for (const { plan, property } of rows) {
      if (!plan.targetLaunchDate || plan.marketReadyOverriddenAt) continue;
      const blockers = (plan.marketReadyBlockers as unknown as unknown[]) ?? [];
      if (blockers.length === 0) continue;
      const severity = severityForDeadline(now, plan.targetLaunchDate, 10, 0);
      if (severity === "INFORMATION") continue;
      const owner = resolveDefaultOwner(property, false);
      findings.push({
        ruleId: L08_MARKET_READY_BLOCKED_NEAR_DATE.ruleId,
        ruleVersion: L08_MARKET_READY_BLOCKED_NEAR_DATE.version,
        category: "LAUNCH_CAMPAIGN",
        severity,
        title: "Market Ready is still blocked with the launch date approaching",
        problemDescription: `The target launch date (${plan.targetLaunchDate.toDateString()}) is near or past and ${blockers.length} Market Ready blocker(s) remain.`,
        businessImpact: "A property that is not Market Ready by its target date will miss its planned launch.",
        detectedCause: "launch_plans.market_ready_blockers is non-empty and market_ready_overridden_at is null while target_launch_date is near or past.",
        ...owner,
        propertyId: plan.propertyId,
        transactionId: null,
        dueAt: plan.targetLaunchDate,
        escalatesAt: escalatesAtFor(plan.targetLaunchDate, 3),
        recommendedAction: "Resolve the remaining Market Ready blockers, or move the target launch date.",
        resolutionRequirements: "Market Ready is achieved (or explicitly overridden).",
        dismissible: false,
        sourceRecordType: "launch_plan",
        sourceRecordId: plan.id,
        dedupKey: dedupKey(L08_MARKET_READY_BLOCKED_NEAR_DATE.ruleId, brokerageId, plan.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
      });
    }
    return findings;
  },
};

const L09_PORTAL_SUBMISSION_FAILED_UNRESOLVED: RiskRule = {
  ruleId: "L09_PORTAL_SUBMISSION_FAILED_UNRESOLVED",
  version: 1,
  category: "LAUNCH_CAMPAIGN",
  name: "Portal submission failed and has not been retried",
  description: "A portal destination is in FAILED status and has stayed there without being resubmitted.",
  triggerEventTypes: ["PORTAL_SUBMISSION_FAILED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ dest: portalDestinations, property: properties })
      .from(portalDestinations)
      .innerJoin(launchPlans, eq(portalDestinations.launchPlanId, launchPlans.id))
      .innerJoin(properties, eq(portalDestinations.propertyId, properties.id))
      .where(and(eq(portalDestinations.brokerageId, brokerageId), eq(portalDestinations.status, "FAILED"), inArray(launchPlans.status, OPEN_LAUNCH_PLAN_STATUSES)));

    const findings: RiskFinding[] = [];
    for (const { dest, property } of rows) {
      const daysSinceFailure = daysBetween(now, dest.updatedAt);
      const severity = daysSinceFailure >= 7 ? "CRITICAL" : daysSinceFailure >= 3 ? "AT_RISK" : daysSinceFailure >= 1 ? "ATTENTION" : null;
      if (!severity) continue;
      const owner = resolveDefaultOwner(property, false);
      findings.push({
        ruleId: L09_PORTAL_SUBMISSION_FAILED_UNRESOLVED.ruleId,
        ruleVersion: L09_PORTAL_SUBMISSION_FAILED_UNRESOLVED.version,
        category: "LAUNCH_CAMPAIGN",
        severity,
        title: `Portal submission failed: ${dest.portalName}`,
        problemDescription: `Submission to ${dest.portalName} failed${dest.failureReason ? ` (${dest.failureReason})` : ""} and has not been resubmitted.`,
        businessImpact: "A listing missing from a portal reduces buyer reach for as long as the failure goes unresolved.",
        detectedCause: "portal_destinations.status = FAILED beyond the expected retry window.",
        ...owner,
        propertyId: dest.propertyId,
        transactionId: null,
        dueAt: dest.updatedAt,
        escalatesAt: escalatesAtFor(dest.updatedAt, 7),
        recommendedAction: "Resolve the submission failure and resubmit to this portal.",
        resolutionRequirements: "portal_destinations.status moves away from FAILED.",
        dismissible: false,
        sourceRecordType: "portal_destination",
        sourceRecordId: dest.id,
        dedupKey: dedupKey(L09_PORTAL_SUBMISSION_FAILED_UNRESOLVED.ruleId, brokerageId, dest.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
      });
    }
    return findings;
  },
};

const L10_MARKET_READY_NO_PORTAL_SUBMISSION: RiskRule = {
  ruleId: "L10_MARKET_READY_NO_PORTAL_SUBMISSION",
  version: 1,
  category: "LAUNCH_CAMPAIGN",
  name: "Market Ready achieved but no portal submission started",
  description: "The plan is Market Ready (or overridden) but no portal destination has moved past NOT_STARTED for longer than the expected handoff window — the Launch equivalent of B6's signed-agreement-to-listed gap.",
  triggerEventTypes: ["MARKET_READY_EVALUATED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ plan: launchPlans, property: properties })
      .from(launchPlans)
      .innerJoin(properties, eq(launchPlans.propertyId, properties.id))
      .where(and(eq(launchPlans.brokerageId, brokerageId), inArray(launchPlans.status, OPEN_LAUNCH_PLAN_STATUSES)));

    const findings: RiskFinding[] = [];
    for (const { plan, property } of rows) {
      if (!plan.marketReadyEvaluatedAt) continue;
      const blockers = (plan.marketReadyBlockers as unknown as unknown[]) ?? [];
      const isReady = blockers.length === 0 || !!plan.marketReadyOverriddenAt;
      if (!isReady) continue;
      const destinations = await db.select({ status: portalDestinations.status }).from(portalDestinations).where(eq(portalDestinations.launchPlanId, plan.id));
      const anySubmitted = destinations.some((d) => d.status !== "NOT_STARTED");
      if (anySubmitted) continue;
      const dueDate = addDays(plan.marketReadyEvaluatedAt, 3);
      const severity = severityForDeadline(now, dueDate, 2, 7);
      if (severity === "INFORMATION") continue;
      const owner = resolveDefaultOwner(property, false);
      findings.push({
        ruleId: L10_MARKET_READY_NO_PORTAL_SUBMISSION.ruleId,
        ruleVersion: L10_MARKET_READY_NO_PORTAL_SUBMISSION.version,
        category: "LAUNCH_CAMPAIGN",
        severity,
        title: "Market Ready but no portal submission has started",
        problemDescription: `This plan became Market Ready on ${plan.marketReadyEvaluatedAt.toDateString()} but no portal destination has been submitted yet.`,
        businessImpact: "A stalled handoff between Market Ready and portal submission delays the listing going live.",
        detectedCause: "launch_plans market-ready with zero portal_destinations rows past NOT_STARTED, beyond the expected handoff window.",
        ...owner,
        propertyId: plan.propertyId,
        transactionId: null,
        dueAt: dueDate,
        escalatesAt: escalatesAtFor(dueDate, 7),
        recommendedAction: "Submit the listing to at least one portal destination.",
        resolutionRequirements: "At least one portal_destinations row moves past NOT_STARTED.",
        dismissible: false,
        sourceRecordType: "launch_plan",
        sourceRecordId: plan.id,
        dedupKey: dedupKey(L10_MARKET_READY_NO_PORTAL_SUBMISSION.ruleId, brokerageId, plan.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
      });
    }
    return findings;
  },
};

const L11_LAUNCH_PLAN_PAUSED_TOO_LONG: RiskRule = {
  ruleId: "L11_LAUNCH_PLAN_PAUSED_TOO_LONG",
  version: 1,
  category: "LAUNCH_CAMPAIGN",
  name: "Launch plan paused for an extended period",
  description: "A launch plan has stayed PAUSED longer than a paused campaign would normally sit idle — a signal it may have been forgotten rather than deliberately held.",
  triggerEventTypes: ["LAUNCH_PAUSED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ plan: launchPlans, property: properties })
      .from(launchPlans)
      .innerJoin(properties, eq(launchPlans.propertyId, properties.id))
      .where(and(eq(launchPlans.brokerageId, brokerageId), eq(launchPlans.status, "PAUSED")));

    const findings: RiskFinding[] = [];
    for (const { plan, property } of rows) {
      if (!plan.pausedAt) continue;
      const daysPaused = daysBetween(now, plan.pausedAt);
      const severity = daysPaused >= 45 ? "CRITICAL" : daysPaused >= 21 ? "AT_RISK" : daysPaused >= 7 ? "ATTENTION" : null;
      if (!severity) continue;
      const owner = resolveDefaultOwner(property, false);
      findings.push({
        ruleId: L11_LAUNCH_PLAN_PAUSED_TOO_LONG.ruleId,
        ruleVersion: L11_LAUNCH_PLAN_PAUSED_TOO_LONG.version,
        category: "LAUNCH_CAMPAIGN",
        severity,
        title: "Launch plan has been paused for a long time",
        problemDescription: `This launch plan has been paused since ${plan.pausedAt.toDateString()}${plan.pauseReason ? ` (${plan.pauseReason})` : ""}.`,
        businessImpact: "A long-paused launch may have been forgotten rather than deliberately held, leaving the vendor without an active campaign.",
        detectedCause: "launch_plans.status = PAUSED beyond the expected review window.",
        ...owner,
        propertyId: plan.propertyId,
        transactionId: null,
        dueAt: plan.pausedAt,
        escalatesAt: escalatesAtFor(plan.pausedAt, 45),
        recommendedAction: "Confirm this pause is still intentional, or resume the launch.",
        resolutionRequirements: "launch_plans.status moves away from PAUSED.",
        dismissible: true,
        sourceRecordType: "launch_plan",
        sourceRecordId: plan.id,
        dedupKey: dedupKey(L11_LAUNCH_PLAN_PAUSED_TOO_LONG.ruleId, brokerageId, plan.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { daysOverdue: Math.floor(daysPaused) },
      });
    }
    return findings;
  },
};

const L12_TARGET_DATE_PASSED_NOT_LIVE: RiskRule = {
  ruleId: "L12_LAUNCH_TARGET_DATE_PASSED_NOT_LIVE",
  version: 1,
  category: "LAUNCH_CAMPAIGN",
  name: "Target launch date passed without going live",
  description: "The target launch date has passed and the listing still has not been confirmed live.",
  triggerEventTypes: [],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ plan: launchPlans, property: properties })
      .from(launchPlans)
      .innerJoin(properties, eq(launchPlans.propertyId, properties.id))
      .where(and(eq(launchPlans.brokerageId, brokerageId), inArray(launchPlans.status, OPEN_LAUNCH_PLAN_STATUSES)));

    const findings: RiskFinding[] = [];
    for (const { plan, property } of rows) {
      if (!plan.targetLaunchDate) continue;
      const severity = severityForDeadline(now, plan.targetLaunchDate, 0, 5);
      if (severity === "INFORMATION") continue;
      const owner = resolveDefaultOwner(property, false);
      findings.push({
        ruleId: L12_TARGET_DATE_PASSED_NOT_LIVE.ruleId,
        ruleVersion: L12_TARGET_DATE_PASSED_NOT_LIVE.version,
        category: "LAUNCH_CAMPAIGN",
        severity,
        title: "Target launch date has passed",
        problemDescription: `The target launch date (${plan.targetLaunchDate.toDateString()}) has passed and this listing is not yet live.`,
        businessImpact: "A missed launch date directly delays the vendor's campaign and the brokerage's pipeline.",
        detectedCause: "launch_plans.target_launch_date is in the past and launch_plans.status has not reached LISTING_LIVE.",
        ...owner,
        propertyId: plan.propertyId,
        transactionId: null,
        dueAt: plan.targetLaunchDate,
        escalatesAt: escalatesAtFor(plan.targetLaunchDate, 5),
        recommendedAction: "Confirm the listing live, or set a revised target launch date.",
        resolutionRequirements: "launch_plans.status reaches LISTING_LIVE (or the target date is revised forward).",
        dismissible: false,
        sourceRecordType: "launch_plan",
        sourceRecordId: plan.id,
        dedupKey: dedupKey(L12_TARGET_DATE_PASSED_NOT_LIVE.ruleId, brokerageId, plan.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
      });
    }
    return findings;
  },
};

const L13_REJECTED_APPROVAL_ITEM_UNCHANGED: RiskRule = {
  ruleId: "L13_REJECTED_VENDOR_APPROVAL_ITEM_UNCHANGED",
  version: 1,
  category: "LAUNCH_CAMPAIGN",
  name: "Rejected vendor cost has not been revised",
  description: "A vendor/cost approval was REJECTED and the linked campaign item has not been updated (new vendor or cost) since the rejection.",
  triggerEventTypes: ["VENDOR_APPROVAL_DECIDED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ approval: vendorApprovals, item: campaignItems, property: properties })
      .from(vendorApprovals)
      .innerJoin(campaignItems, eq(vendorApprovals.campaignItemId, campaignItems.id))
      .innerJoin(launchPlans, eq(vendorApprovals.launchPlanId, launchPlans.id))
      .innerJoin(properties, eq(vendorApprovals.propertyId, properties.id))
      .where(and(eq(vendorApprovals.brokerageId, brokerageId), eq(vendorApprovals.status, "REJECTED"), inArray(launchPlans.status, OPEN_LAUNCH_PLAN_STATUSES)));

    const findings: RiskFinding[] = [];
    for (const { approval, item, property } of rows) {
      if (!approval.decidedAt || item.updatedAt > approval.decidedAt) continue; // already revised since rejection
      const dueDate = addDays(approval.decidedAt, 2);
      const severity = severityForDeadline(now, dueDate, 2, 5);
      if (severity === "INFORMATION") continue;
      const owner = item.responsibleUserId
        ? { ownerType: item.responsibleOwnerType as RiskFinding["ownerType"], ownerUserId: item.responsibleUserId }
        : resolveDefaultOwner(property, false);
      findings.push({
        ruleId: L13_REJECTED_APPROVAL_ITEM_UNCHANGED.ruleId,
        ruleVersion: L13_REJECTED_APPROVAL_ITEM_UNCHANGED.version,
        category: "LAUNCH_CAMPAIGN",
        severity,
        title: `Rejected cost not yet revised: ${item.title}`,
        problemDescription: `The vendor/cost approval for "${item.title}" was rejected on ${approval.decidedAt.toDateString()}${approval.decisionNotes ? ` (${approval.decisionNotes})` : ""} and the item has not been updated since.`,
        businessImpact: "A rejected cost left unrevised silently blocks Market Ready for this campaign item.",
        detectedCause: "vendor_approvals.status = REJECTED and the linked campaign_items row has not been updated since decided_at.",
        ...owner,
        propertyId: item.propertyId,
        transactionId: null,
        dueAt: dueDate,
        escalatesAt: escalatesAtFor(dueDate, 5),
        recommendedAction: "Record a revised vendor and/or cost for this campaign item and request approval again.",
        resolutionRequirements: "campaign_items row is updated (new vendor/cost) after the rejection.",
        dismissible: false,
        sourceRecordType: "campaign_item",
        sourceRecordId: item.id,
        dedupKey: dedupKey(L13_REJECTED_APPROVAL_ITEM_UNCHANGED.ruleId, brokerageId, item.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: true,
      });
    }
    return findings;
  },
};

export const LAUNCH_CAMPAIGN_RULES: RiskRule[] = [
  L01_TARGET_DATE_NOT_SET,
  L02_NO_CAMPAIGN_ITEMS_NEAR_DATE,
  L03_CAMPAIGN_ITEM_OVERDUE,
  L04_CAMPAIGN_ITEM_BLOCKED_TOO_LONG,
  L05_VENDOR_APPROVAL_PENDING_TOO_LONG,
  L06_COST_APPROVAL_GAP,
  L07_BUDGET_EXCEEDED_UNRESOLVED,
  L08_MARKET_READY_BLOCKED_NEAR_DATE,
  L09_PORTAL_SUBMISSION_FAILED_UNRESOLVED,
  L10_MARKET_READY_NO_PORTAL_SUBMISSION,
  L11_LAUNCH_PLAN_PAUSED_TOO_LONG,
  L12_TARGET_DATE_PASSED_NOT_LIVE,
  L13_REJECTED_APPROVAL_ITEM_UNCHANGED,
];
