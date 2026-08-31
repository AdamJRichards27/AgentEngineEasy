import { pgTable, integer, text, boolean, jsonb, timestamp, uuid, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { brokerages, users } from "./users";
import { properties } from "./property";
import { workflows } from "./workflow";

// Agent Engine 2.0 — Property Launch & Campaign Coordination (vertical
// slice). Moves a property from AGENCY AGREEMENT SIGNED through LAUNCH
// PLANNING -> CAMPAIGN PRODUCTION -> VENDOR APPROVAL -> MARKET READY ->
// PORTAL SUBMISSION -> LISTING LIVE.
//
// Deliberately reuses rather than duplicates: ownership vocabulary is
// RISK_EXCEPTION_OWNER_TYPES verbatim (see below) rather than a parallel
// "who is responsible" enum; the Launch Plan is additionally represented
// as a `workflows` row with `workflowType: "Launch"` (see workflow.ts) so
// the existing "what needs to happen next" workflowSteps machinery and the
// AI-governance workflowChangeProposals mechanism both apply to Launch the
// same way they already apply to ReadyToList/Transaction — the tables
// below hold the richer entities that workflowSteps has no room for
// (campaign items, portal destinations, budget, vendor approvals), not a
// second workflow engine. Money is integer cents throughout, matching
// commerce.ts/transaction.ts's existing convention — never a float.
// Listing Live itself is NOT a separate concept from the existing
// LISTING_LIVE event/properties.listingStatus="Listed" — confirmLaunchLive
// (lib/launch/model.ts) calls the existing go-live path rather than
// inventing a parallel "live" flag.

export const LAUNCH_TEMPLATE_TYPES = ["STANDARD_PRIVATE_TREATY", "AUCTION", "OFF_MARKET", "CUSTOM"] as const;
export type LaunchTemplateType = (typeof LAUNCH_TEMPLATE_TYPES)[number];

// PLANNING -> CAMPAIGN_PRODUCTION -> VENDOR_APPROVAL -> MARKET_READY ->
// PORTAL_SUBMISSION -> LISTING_LIVE is the common path (stages can overlap
// in practice — e.g. a vendor approval can be requested mid-production —
// so `status` is a computed "furthest-relevant stage" summary, not a
// strict linear gate; see lib/launch/model.ts's computeLaunchPlanStatus()).
// PAUSED/CANCELLED are manual side-branches reachable from any non-terminal
// status.
export const LAUNCH_PLAN_STATUSES = [
  "PLANNING",
  "CAMPAIGN_PRODUCTION",
  "VENDOR_APPROVAL",
  "MARKET_READY",
  "PORTAL_SUBMISSION",
  "LISTING_LIVE",
  "PAUSED",
  "CANCELLED",
] as const;
export type LaunchPlanStatus = (typeof LAUNCH_PLAN_STATUSES)[number];

export const OPEN_LAUNCH_PLAN_STATUSES: LaunchPlanStatus[] = [
  "PLANNING",
  "CAMPAIGN_PRODUCTION",
  "VENDOR_APPROVAL",
  "MARKET_READY",
  "PORTAL_SUBMISSION",
];

export const CAMPAIGN_ITEM_TYPES = [
  "PHOTOGRAPHY",
  "FLOOR_PLAN",
  "COPYWRITING",
  "SIGNAGE",
  "BROCHURE",
  "DIGITAL_AD",
  "SOCIAL_MEDIA",
  "VIDEO",
  "OTHER",
] as const;
export type CampaignItemType = (typeof CAMPAIGN_ITEM_TYPES)[number];

export const CAMPAIGN_ITEM_STATUSES = ["TO_ORGANISE", "IN_PROGRESS", "AWAITING_APPROVAL", "BLOCKED", "COMPLETE"] as const;
export type CampaignItemStatus = (typeof CAMPAIGN_ITEM_STATUSES)[number];

export const PORTAL_DESTINATION_STATUSES = ["NOT_STARTED", "READY_TO_SUBMIT", "SUBMITTED", "LIVE", "FAILED", "WITHDRAWN"] as const;
export type PortalDestinationStatus = (typeof PORTAL_DESTINATION_STATUSES)[number];

export const VENDOR_APPROVAL_TYPES = ["BUDGET", "VENDOR_SELECTION", "CAMPAIGN_ITEM_COST"] as const;
export type VendorApprovalType = (typeof VENDOR_APPROVAL_TYPES)[number];

export const VENDOR_APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED", "CHANGES_REQUESTED"] as const;
export type VendorApprovalStatus = (typeof VENDOR_APPROVAL_STATUSES)[number];

// Reused verbatim from the Exception & Risk Engine (packages/db/src/schema/exceptions.ts)
// rather than a parallel "who is responsible" vocabulary — see that file's
// own comment on RISK_EXCEPTION_OWNER_TYPES for why this is the app's one
// safe ownership model (mapped onto the real 3-role model, plus an
// UNASSIGNED_QUEUE fallback).
export { RISK_EXCEPTION_OWNER_TYPES as LAUNCH_OWNER_TYPES } from "./exceptions";

// One row per property, ever — a property gets exactly one Launch Plan
// (the unique index below enforces this at the database level, not just in
// application code). A cancelled plan is a terminal state; starting a
// property's launch over is out of scope for this build (see the
// completion report's Deferred Scope).
export const launchPlans = pgTable(
  "launch_plans",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    workflowId: integer("workflow_id").references(() => workflows.id),

    templateType: text("template_type").notNull(),
    status: text("status").notNull().default("PLANNING"),

    targetLaunchDate: timestamp("target_launch_date"),
    actualLaunchDate: timestamp("actual_launch_date"),

    // Integer cents throughout (commerce.ts/transaction.ts convention) —
    // budgetCents is the Brokerage-Administrator-approved envelope;
    // budgetSpentCents is recomputed from campaignItems.costCents whenever
    // an item's cost changes (lib/launch/model.ts's recalculateBudget()) —
    // never entered directly.
    budgetCents: integer("budget_cents").notNull().default(0),
    budgetSpentCents: integer("budget_spent_cents").notNull().default(0),
    budgetSetAt: timestamp("budget_set_at"),
    budgetSetBy: integer("budget_set_by").references(() => users.id),

    // Deterministic Market Ready evaluator's last result (lib/launch/marketReady.ts)
    // — recomputed on demand, this is a cache of the last evaluation for
    // display, never the source of truth (re-evaluated live on every read
    // that needs a current answer).
    marketReadyEvaluatedAt: timestamp("market_ready_evaluated_at"),
    marketReadyBlockers: jsonb("market_ready_blockers").notNull().default(sql`'[]'::jsonb`), // MarketReadyBlocker[]
    marketReadyOverriddenAt: timestamp("market_ready_overridden_at"),
    marketReadyOverriddenBy: integer("market_ready_overridden_by").references(() => users.id),
    marketReadyOverrideReason: text("market_ready_override_reason"),

    listingLiveConfirmedAt: timestamp("listing_live_confirmed_at"),
    listingLiveConfirmedBy: integer("listing_live_confirmed_by").references(() => users.id),

    pausedAt: timestamp("paused_at"),
    pausedBy: integer("paused_by").references(() => users.id),
    pauseReason: text("pause_reason"),
    cancelledAt: timestamp("cancelled_at"),
    cancelledBy: integer("cancelled_by").references(() => users.id),
    cancelReason: text("cancel_reason"),

    createdBy: integer("created_by").notNull().references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    propertyIdx: uniqueIndex("launch_plans_property_idx").on(table.propertyId),
    brokerageStatusIdx: index("launch_plans_brokerage_status_idx").on(table.brokerageId, table.status),
  }),
);

export const campaignItems = pgTable(
  "campaign_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    launchPlanId: uuid("launch_plan_id").notNull().references(() => launchPlans.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),

    itemType: text("item_type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("TO_ORGANISE"),

    responsibleOwnerType: text("responsible_owner_type").notNull().default("UNASSIGNED_QUEUE"),
    responsibleUserId: integer("responsible_user_id").references(() => users.id),

    vendorName: text("vendor_name"),
    costCents: integer("cost_cents").notNull().default(0),
    // Set true at creation for any item whose costCents exceeds
    // LAUNCH_VENDOR_APPROVAL_THRESHOLD_CENTS (lib/launch/model.ts) — a
    // snapshot, not recomputed, so a later threshold change never
    // retroactively invalidates an already-approved item's approval.
    costApprovalRequired: boolean("cost_approval_required").notNull().default(false),
    costApprovedAt: timestamp("cost_approved_at"),
    costApprovedBy: integer("cost_approved_by").references(() => users.id),

    dueAt: timestamp("due_at"), // backward-calculated from launchPlans.targetLaunchDate at template application
    completedAt: timestamp("completed_at"),
    blockedAt: timestamp("blocked_at"),
    blockedReason: text("blocked_reason"),

    sequence: integer("sequence").notNull().default(0),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    launchPlanIdx: index("campaign_items_launch_plan_idx").on(table.launchPlanId),
    propertyStatusIdx: index("campaign_items_property_status_idx").on(table.propertyId, table.status),
    dueAtIdx: index("campaign_items_due_at_idx").on(table.dueAt),
  }),
);

// Operational tracking only — never a direct portal publish/API
// integration (explicitly excluded from this build). A row here records
// that an agent submitted/withdrew/confirmed-live a listing on a named
// portal; it never calls a portal's API.
export const portalDestinations = pgTable(
  "portal_destinations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    launchPlanId: uuid("launch_plan_id").notNull().references(() => launchPlans.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),

    portalName: text("portal_name").notNull(), // free text — e.g. "realestate.com.au", "Domain", "Agency website"
    status: text("status").notNull().default("NOT_STARTED"),

    submittedAt: timestamp("submitted_at"),
    submittedBy: integer("submitted_by").references(() => users.id),
    liveConfirmedAt: timestamp("live_confirmed_at"),
    liveConfirmedBy: integer("live_confirmed_by").references(() => users.id),
    failureReason: text("failure_reason"),
    listingUrl: text("listing_url"), // manually recorded, never fetched/scraped

    notes: text("notes"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    launchPlanIdx: index("portal_destinations_launch_plan_idx").on(table.launchPlanId),
    propertyStatusIdx: index("portal_destinations_property_status_idx").on(table.propertyId, table.status),
  }),
);

// Financial/vendor sign-off — distinct from campaignItems.costApprovedAt
// (a lightweight per-item stamp) when a formal, reviewable approval record
// is needed: whole-plan budget approval, a vendor selection, or a specific
// campaign item's cost above the approval threshold. Brokerage
// Administrator decides (lib/launch/model.ts), mirroring the existing
// refund/agent-paid/AML-exception-resolution precedent for anything that
// finalises a financial outcome.
export const vendorApprovals = pgTable(
  "vendor_approvals",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    launchPlanId: uuid("launch_plan_id").notNull().references(() => launchPlans.id),
    campaignItemId: uuid("campaign_item_id").references(() => campaignItems.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),

    approvalType: text("approval_type").notNull(),
    requestedAmountCents: integer("requested_amount_cents").notNull().default(0),
    approvedAmountCents: integer("approved_amount_cents"),
    status: text("status").notNull().default("PENDING"),

    requestedBy: integer("requested_by").notNull().references(() => users.id),
    requestedAt: timestamp("requested_at").notNull().defaultNow(),
    decidedBy: integer("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at"),
    decisionNotes: text("decision_notes"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    launchPlanIdx: index("vendor_approvals_launch_plan_idx").on(table.launchPlanId),
    brokerageStatusIdx: index("vendor_approvals_brokerage_status_idx").on(table.brokerageId, table.status),
  }),
);

// Immutable audit trail — mirrors risk_exception_transitions exactly
// (append-only, one row per status change, actor + reason). Feeds the
// Property Timeline's material-milestone entries and the completion
// report's lifecycle evidence.
export const launchPlanTransitions = pgTable(
  "launch_plan_transitions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    launchPlanId: uuid("launch_plan_id").notNull().references(() => launchPlans.id),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),

    transitionType: text("transition_type").notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    reason: text("reason"),

    actorType: text("actor_type").notNull(), // SYSTEM | USER
    actorUserId: integer("actor_user_id").references(() => users.id),
    metadata: jsonb("metadata"),

    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  },
  (table) => ({
    launchPlanOccurredIdx: index("launch_plan_transitions_launch_plan_occurred_idx").on(table.launchPlanId, table.occurredAt),
  }),
);

export const insertLaunchPlanSchema = createInsertSchema(launchPlans).omit({ id: true, createdAt: true, updatedAt: true });
export const insertCampaignItemSchema = createInsertSchema(campaignItems).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPortalDestinationSchema = createInsertSchema(portalDestinations).omit({ id: true, createdAt: true, updatedAt: true });
export const insertVendorApprovalSchema = createInsertSchema(vendorApprovals).omit({ id: true, createdAt: true, updatedAt: true });
export const insertLaunchPlanTransitionSchema = createInsertSchema(launchPlanTransitions).omit({ id: true });

export type InsertLaunchPlan = z.infer<typeof insertLaunchPlanSchema>;
export type InsertCampaignItem = z.infer<typeof insertCampaignItemSchema>;
export type InsertPortalDestination = z.infer<typeof insertPortalDestinationSchema>;
export type InsertVendorApproval = z.infer<typeof insertVendorApprovalSchema>;
export type InsertLaunchPlanTransition = z.infer<typeof insertLaunchPlanTransitionSchema>;

export type LaunchPlan = typeof launchPlans.$inferSelect;
export type CampaignItem = typeof campaignItems.$inferSelect;
export type PortalDestination = typeof portalDestinations.$inferSelect;
export type VendorApproval = typeof vendorApprovals.$inferSelect;
export type LaunchPlanTransition = typeof launchPlanTransitions.$inferSelect;
