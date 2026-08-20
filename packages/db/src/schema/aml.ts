import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { properties, parties } from "./property";
import { users } from "./users";
import { serviceOrders } from "./commerce";

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
  // Billing container for this verification (Section 11 — Phase 4 creates
  // the ServiceOrder record at request time; actually charging a stored
  // payment method for it is Phase 6's job, not this one).
  serviceOrderId: integer("service_order_id").references(() => serviceOrders.id),
  // Exception handling (Phase 4, ARCHITECTURE.md §10): a "Review Required"
  // or "Failed" outcome is never silently reinterpreted as verified — this
  // is an audit trail for a human compliance decision made alongside the
  // system (e.g. a Brokerage Administrator who reviewed evidence directly
  // with the provider), mirroring the ownership review-not-block pattern.
  // Mandatory notes are enforced at the route layer, not here.
  exceptionResolvedBy: integer("exception_resolved_by").references(() => users.id),
  exceptionResolvedAt: timestamp("exception_resolved_at"),
  exceptionNotes: text("exception_notes"),
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
