import { pgTable, serial, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { brokerages, users } from "./users.js";

// The property progresses through this stage list; each stage is what
// determines "what needs to happen next" on the Property Workspace.
export const WORKFLOW_STAGES = [
  "Appraisal",
  "Ready to List",
  "Listed",
  "Under Offer",
  "Contract",
  "Settlement",
  "Closed",
] as const;

export const properties = pgTable("properties", {
  id: serial("id").primaryKey(),
  brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
  agentId: integer("agent_id").notNull().references(() => users.id),

  // Address — captured once at Start Property (Build Brief §3).
  formattedAddress: text("formatted_address").notNull(),
  placeId: text("place_id"), // Google Places id, if resolved via provider
  suburb: text("suburb"),
  state: text("state"), // AU state/territory — drives document rules (§9)
  postcode: text("postcode"),
  isManualAddress: boolean("is_manual_address").notNull().default(false),

  workflowStage: text("workflow_stage").notNull().default("Appraisal"),

  // Denormalised status summaries for fast "what's next" reads —
  // source of truth remains the linked AMLVerification / DocumentPackage rows.
  amlStatusSummary: text("aml_status_summary").notNull().default("Not Started"),
  listingStatus: text("listing_status").notNull().default("Not Listed"),

  // Ownership data from the property-data provider, compared against sellers
  // entered (Build Brief §8) — mismatch shown as a review prompt, not a hard block.
  ownershipData: jsonb("ownership_data"),
  ownershipReviewRequired: boolean("ownership_review_required").notNull().default(false),
  ownershipReviewedBy: integer("ownership_reviewed_by").references(() => users.id),
  ownershipReviewedAt: timestamp("ownership_reviewed_at"),
  ownershipReviewNotes: text("ownership_review_notes"),

  isDraft: boolean("is_draft").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Person / Organisation / Trust / Estate / Other — initial workflow stays
// simple; entity-specific fields requested only when partyType !== "Person" (§4).
export const PARTY_TYPES = ["Person", "Organisation", "Trust", "Estate", "Other"] as const;

export const parties = pgTable("parties", {
  id: serial("id").primaryKey(),
  brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
  partyType: text("party_type").notNull().default("Person"),

  firstName: text("first_name"),
  middleName: text("middle_name"),
  lastName: text("last_name"),
  organisationName: text("organisation_name"), // used when partyType !== "Person"

  mobile: text("mobile"),
  email: text("email"),
  residentialAddress: text("residential_address"),

  // Populated only when the entity structure requires it (trust deed, ACN, etc.)
  entityDetails: jsonb("entity_details"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// The join that makes "enter once, reuse everywhere" real. A seller entered
// against a property is never re-entered for AML, agency agreement, or contract.
export const PROPERTY_PARTY_ROLES = [
  "Seller",
  "Buyer",
  "Solicitor",
  "PowerOfAttorney",
  "Other",
] as const;

export const propertyParties = pgTable("property_parties", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull().references(() => properties.id),
  partyId: integer("party_id").notNull().references(() => parties.id),
  role: text("role").notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertPropertySchema = createInsertSchema(properties).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPartySchema = createInsertSchema(parties).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPropertyPartySchema = createInsertSchema(propertyParties).omit({ id: true, createdAt: true });

export type InsertProperty = z.infer<typeof insertPropertySchema>;
export type InsertParty = z.infer<typeof insertPartySchema>;
export type InsertPropertyParty = z.infer<typeof insertPropertyPartySchema>;
export type Property = typeof properties.$inferSelect;
export type Party = typeof parties.$inferSelect;
export type PropertyPartyLink = typeof propertyParties.$inferSelect;
