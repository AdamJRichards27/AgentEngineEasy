import { pgTable, serial, integer, text, boolean, timestamp, jsonb, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { properties } from "./property";
import { users } from "./users";

// A package is what gets sent as one signature envelope (Build Brief §10) —
// e.g. "Ready to List package" = agency agreement + disclosures + AML consent.
export const documentPackages = pgTable("document_packages", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull().references(() => properties.id),
  purpose: text("purpose").notNull(), // e.g. "ReadyToList", "Contract"
  state: text("state"), // AU state/territory the package rules were resolved for
  status: text("status").notNull().default("Preparing"), // Preparing | Ready | Sent | Completed
  // Which version of determineRequiredDocuments()'s rule set produced this
  // package (Phase 5 "state rule engine") — so a package created before a
  // rule change is traceable, not silently reinterpreted under new rules.
  ruleSetVersion: integer("rule_set_version").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull().references(() => properties.id),
  packageId: integer("package_id").references(() => documentPackages.id),
  documentType: text("document_type").notNull(), // e.g. AgencyAgreement, Disclosure, Form
  title: text("title").notNull(),
  status: text("status").notNull().default("Draft"), // Draft | Generated | Signed
  objectStorageKey: text("object_storage_key"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const signatureRequests = pgTable("signature_requests", {
  id: serial("id").primaryKey(),
  packageId: integer("package_id").notNull().references(() => documentPackages.id),
  provider: text("provider").notNull(),
  providerReference: text("provider_reference"),
  signatories: jsonb("signatories"), // [{ partyId, name, email, status }]
  status: text("status").notNull().default("Draft"), // Draft | Sent | PartiallySigned | Completed | Voided
  sentAt: timestamp("sent_at"),
  completedAt: timestamp("completed_at"),
  completedDocumentKey: text("completed_document_key"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Real structured agency-agreement terms (ARCHITECTURE.md §3 — explicitly
// NOT the legacy app's opaque-JSON commission storage). One active row per
// property; changes are updated in place with an AuditLog entry (matching
// the ownership-review precedent) rather than versioned here — real
// negotiation/version history belongs to the Transaction once one exists
// (Phase 7), this is pre-listing terms capture only.
export const agencyAgreementTerms = pgTable(
  "agency_agreement_terms",
  {
    id: serial("id").primaryKey(),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    commissionType: text("commission_type").notNull().default("Percentage"), // Percentage | FlatFee
    commissionRateBps: integer("commission_rate_bps"), // basis points, e.g. 220 = 2.20%
    flatFeeCents: integer("flat_fee_cents"),
    marketingFeeCents: integer("marketing_fee_cents"),
    agreementTermDays: integer("agreement_term_days").notNull().default(90),
    createdBy: integer("created_by").references(() => users.id),
    updatedBy: integer("updated_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ onePerProperty: unique().on(t.propertyId) }),
);

export const insertDocumentPackageSchema = createInsertSchema(documentPackages).omit({ id: true, createdAt: true, updatedAt: true });
export const insertDocumentSchema = createInsertSchema(documents).omit({ id: true, createdAt: true, updatedAt: true });
export const insertSignatureRequestSchema = createInsertSchema(signatureRequests).omit({ id: true, createdAt: true, updatedAt: true });
export const insertAgencyAgreementTermsSchema = createInsertSchema(agencyAgreementTerms).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDocumentPackage = z.infer<typeof insertDocumentPackageSchema>;
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type InsertSignatureRequest = z.infer<typeof insertSignatureRequestSchema>;
export type InsertAgencyAgreementTerms = z.infer<typeof insertAgencyAgreementTermsSchema>;
export type DocumentPackage = typeof documentPackages.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type SignatureRequest = typeof signatureRequests.$inferSelect;
export type AgencyAgreementTerms = typeof agencyAgreementTerms.$inferSelect;
