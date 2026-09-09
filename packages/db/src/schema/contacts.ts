import { pgTable, serial, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { brokerages, users } from "./users";
import { parties, properties } from "./property";
import { growOpportunities } from "./grow";

// AE GROW Priority 2 — Contact Intelligence & Relationship Timeline.
//
// Deliberately does NOT introduce a competing Grow-only contact/person table.
// `parties` (property.ts) remains the single canonical identity record — the
// same one RUN's propertyParties and Grow's own growRelationships already key
// off of via partyId. `growRelationships` (grow.ts) already fully satisfies
// spec §6 (Contact<->Property relationships: type, validFrom/validTo,
// status, sourceType/sourceId/sourceEvidence) when queried/grouped by
// partyId instead of propertyId, so it is reused as-is here rather than
// duplicated. `growActivities` already covers free-text Notes (activityType
// "note") and is reused as-is for the Timeline and Contact 360's activity
// feed. What this file adds is genuinely new, additive Grow schema for the
// three Priority 2 concepts that have no existing home:
//   - growContactRoles: structured, multi-valued relationship classification
//     (§4) — a party can hold several roles simultaneously (e.g. both
//     CurrentClient and ReferralSource), which a single status column on
//     `parties` could not express without narrowing every other consumer of
//     that table.
//   - growContactRelationships: person-to-person relationships (§5) — e.g.
//     spouse/partner, family, co-owner — kept as a separate, non-merging
//     join so household context is recorded without ever collapsing two
//     `parties` rows into one.
//   - growCommitments: future-dated promises (§8) — e.g. "Call next month",
//     "Prepare appraisal". `automationTasks` (automation.ts) was considered
//     and rejected as the base for this: it requires a NOT NULL propertyId
//     and carries RUN/automation-engine execution lineage (attempt counts,
//     handler wiring) that doesn't fit a person-first, property-optional
//     commitment. Completing or cancelling a commitment also inserts a
//     growActivities row (activityType "task_completion") so the
//     Relationship Timeline picks it up without any special-casing.
//
// Contact Intelligence Summary (§9) and the Relationship Timeline (§7) are
// deterministic read-side aggregations over these tables plus the existing
// growRelationships / growActivities / growOpportunities tables — see
// apps/api/src/lib/contactIntelligence.ts and
// apps/api/src/lib/relationshipTimeline.ts. No new "score" or predictive
// field is introduced anywhere in this file, per §9's explicit prohibition.

export const GROW_CONTACT_ROLES = [
  "Prospect",
  "PastClient",
  "CurrentClient",
  "Seller",
  "Buyer",
  "Landlord",
  "Tenant",
  "Investor",
  "PropertyOwner",
  "AppraisalProspect",
  "ReferralSource",
  "ProfessionalPartner",
  "Other",
] as const;
export type GrowContactRoleType = (typeof GROW_CONTACT_ROLES)[number];

// Multi-valued: a party may hold several roles at once (unique per
// party+role pair so the same role can't be assigned twice, but nothing
// stops CurrentClient + ReferralSource + Landlord co-existing on one party).
export const growContactRoles = pgTable(
  "grow_contact_roles",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    partyId: integer("party_id").notNull().references(() => parties.id),
    role: text("role").notNull(),
    assignedByUserId: integer("assigned_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    partyRoleUnique: uniqueIndex("grow_contact_roles_party_role_unique").on(table.partyId, table.role),
    brokeragePartyIdx: index("grow_contact_roles_brokerage_party_idx").on(table.brokerageId, table.partyId),
  }),
);

export const GROW_CONTACT_RELATIONSHIP_TYPES = [
  "spouse_partner",
  "family",
  "co_owner",
  "business_partner",
  "related_contact",
  "other",
] as const;
export type GrowContactRelationshipType = (typeof GROW_CONTACT_RELATIONSHIP_TYPES)[number];

// Person-to-person relationships (§5). Directional storage (partyId ->
// relatedPartyId) with app-layer dedup checked in both directions — no
// DB-level bidirectional constraint, since "A related_contact of B" and "B
// related_contact of A" are the same fact but the two rows are not
// duplicates of each other at the schema level (asymmetric relationship
// types like "business_partner" from a referral context may legitimately
// want a one-directional note). Records a relationship WITHOUT ever merging
// the two `parties` rows, and this priority does not auto-infer any
// relationship — every row here is created explicitly by a user (§5).
export const growContactRelationships = pgTable(
  "grow_contact_relationships",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    partyId: integer("party_id").notNull().references(() => parties.id),
    relatedPartyId: integer("related_party_id").notNull().references(() => parties.id),
    relationshipType: text("relationship_type").notNull(),
    note: text("note"),
    createdBy: integer("created_by").notNull().references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    brokeragePartyIdx: index("grow_contact_relationships_brokerage_party_idx").on(table.brokerageId, table.partyId),
    relatedPartyIdx: index("grow_contact_relationships_related_party_idx").on(table.relatedPartyId),
  }),
);

export const GROW_COMMITMENT_STATUSES = ["Open", "Completed", "Cancelled"] as const;
export type GrowCommitmentStatus = (typeof GROW_COMMITMENT_STATUSES)[number];

// Future-dated promises (§8) — "Call next month", "Send market report",
// "Prepare appraisal", "Follow up after holiday", "Contact after lease
// expiry". Person-first: partyId is required, propertyId/opportunityId are
// optional context. Reuses growActivities (activityType "task_completion")
// as the Timeline-facing record of completion rather than duplicating a
// second task/event system.
export const growCommitments = pgTable(
  "grow_commitments",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    partyId: integer("party_id").notNull().references(() => parties.id),
    propertyId: integer("property_id").references(() => properties.id),
    opportunityId: integer("opportunity_id").references(() => growOpportunities.id),
    description: text("description").notNull(),
    dueAt: timestamp("due_at").notNull(),
    status: text("status").notNull().default("Open"),
    completedAt: timestamp("completed_at"),
    completedByUserId: integer("completed_by_user_id").references(() => users.id),
    cancelledAt: timestamp("cancelled_at"),
    cancelReason: text("cancel_reason"),
    createdBy: integer("created_by").notNull().references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    brokeragePartyIdx: index("grow_commitments_brokerage_party_idx").on(table.brokerageId, table.partyId),
    brokerageStatusDueIdx: index("grow_commitments_brokerage_status_due_idx").on(table.brokerageId, table.status, table.dueAt),
    propertyIdx: index("grow_commitments_property_idx").on(table.propertyId),
    opportunityIdx: index("grow_commitments_opportunity_idx").on(table.opportunityId),
  }),
);

export const insertGrowContactRoleSchema = createInsertSchema(growContactRoles).omit({ id: true, createdAt: true });
export const insertGrowContactRelationshipSchema = createInsertSchema(growContactRelationships).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertGrowCommitmentSchema = createInsertSchema(growCommitments).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertGrowContactRole = z.infer<typeof insertGrowContactRoleSchema>;
export type InsertGrowContactRelationship = z.infer<typeof insertGrowContactRelationshipSchema>;
export type InsertGrowCommitment = z.infer<typeof insertGrowCommitmentSchema>;

export type GrowContactRole = typeof growContactRoles.$inferSelect;
export type GrowContactRelationship = typeof growContactRelationships.$inferSelect;
export type GrowCommitment = typeof growCommitments.$inferSelect;
