import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { properties, parties } from "./property.js";
import { users } from "./users.js";

// Agent-facing status only (Build Brief §6) — provider-side complexity
// (18-value pipelines etc.) stays behind the AMLProvider adapter, never
// surfaced directly to the UI.
export const AML_STATUSES = [
  "Not Started",
  "Awaiting Seller",
  "In Progress",
  "Complete",
  "Review Required",
  "Failed",
] as const;

// Exact field list from Build Brief §7.
export const amlVerifications = pgTable("aml_verifications", {
  id: serial("id").primaryKey(), // verification_id
  propertyId: integer("property_id").notNull().references(() => properties.id),
  partyId: integer("party_id").notNull().references(() => parties.id),
  provider: text("provider").notNull(),
  providerReference: text("provider_reference"),
  verificationType: text("verification_type").notNull().default("Individual"),
  status: text("status").notNull().default("Not Started"),
  requestedAt: timestamp("requested_at"),
  completedAt: timestamp("completed_at"),
  outcome: text("outcome"),
  riskLevel: text("risk_level"),
  reviewRequired: boolean("review_required").notNull().default(false),
  // Reference only — the AML provider remains the secure source of the
  // underlying identity documents (Build Brief §7 explicit instruction).
  evidenceReference: text("evidence_reference"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAmlVerificationSchema = createInsertSchema(amlVerifications).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAmlVerification = z.infer<typeof insertAmlVerificationSchema>;
export type AmlVerification = typeof amlVerifications.$inferSelect;
