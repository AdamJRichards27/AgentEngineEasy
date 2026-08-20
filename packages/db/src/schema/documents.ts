import { pgTable, serial, integer, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { properties } from "./property.js";
import { users } from "./users.js";

export const documentPackages = pgTable("document_packages", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull().references(() => properties.id),
  purpose: text("purpose").notNull(),
  state: text("state"),
  status: text("status").notNull().default("Preparing"),
  ruleSetVersion: integer("rule_set_version").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull().references(() => properties.id),
  packageId: integer("package_id").notNull().references(() => documentPackages.id),
  documentType: text("document_type").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull().default("Draft"),
  objectStorageKey: text("object_storage_key"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const signatureRequests = pgTable("signature_requests", {
  id: serial("id").primaryKey(),
  packageId: integer("package_id").notNull().references(() => documentPackages.id),
  provider: text("provider").notNull().default("mock"),
  providerReference: text("provider_reference"),
  status: text("status").notNull().default("Draft"),
  sentAt: timestamp("sent_at"),
  completedAt: timestamp("completed_at"),
  completedDocumentKey: text("completed_document_key"),
  lastWebhookOutcome: text("last_webhook_outcome"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Phase 5: real structured agency-agreement commission terms — explicitly
// not the legacy app's opaque-JSON commission storage (ARCHITECTURE.md §3).
export const agencyAgreementTerms = pgTable(
  "agency_agreement_terms",
  {
    id: serial("id").primaryKey(),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    commissionType: text("commission_type").notNull().default("Percentage"),
    commissionRateBps: integer("commission_rate_bps"),
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

export const insertDocumentPackageSchema = createInsertSchema(documentPackages);
export const insertDocumentSchema = createInsertSchema(documents);
export const insertSignatureRequestSchema = createInsertSchema(signatureRequests);
export const insertAgencyAgreementTermsSchema = createInsertSchema(agencyAgreementTerms);

export type DocumentPackage = typeof documentPackages.$inferSelect;
export type InsertDocumentPackage = typeof documentPackages.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type InsertDocument = typeof documents.$inferInsert;
export type SignatureRequest = typeof signatureRequests.$inferSelect;
export type InsertSignatureRequest = typeof signatureRequests.$inferInsert;
export type AgencyAgreementTerms = typeof agencyAgreementTerms.$inferSelect;
export type InsertAgencyAgreementTerms = typeof agencyAgreementTerms.$inferInsert;
