import { pgTable, serial, integer, text, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { properties } from "./property";

// A package is what gets sent as one signature envelope (Build Brief §10) —
// e.g. "Ready to List package" = agency agreement + disclosures + AML consent.
export const documentPackages = pgTable("document_packages", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull().references(() => properties.id),
  purpose: text("purpose").notNull(), // e.g. "ReadyToList", "Contract"
  state: text("state"), // AU state/territory the package rules were resolved for
  status: text("status").notNull().default("Preparing"), // Preparing | Ready | Sent | Completed
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

export const insertDocumentPackageSchema = createInsertSchema(documentPackages).omit({ id: true, createdAt: true, updatedAt: true });
export const insertDocumentSchema = createInsertSchema(documents).omit({ id: true, createdAt: true, updatedAt: true });
export const insertSignatureRequestSchema = createInsertSchema(signatureRequests).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertDocumentPackage = z.infer<typeof insertDocumentPackageSchema>;
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type InsertSignatureRequest = z.infer<typeof insertSignatureRequestSchema>;
export type DocumentPackage = typeof documentPackages.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type SignatureRequest = typeof signatureRequests.$inferSelect;
