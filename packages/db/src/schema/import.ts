import { pgTable, serial, text, integer, boolean, timestamp, jsonb, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { brokerages, users } from "./users";
import { parties, properties } from "./property";
import { growRelationships } from "./grow";

// Stage B - Data Import & Migration Engine.
// SOURCE FILE -> INGEST -> PARSE -> NORMALISE -> MAP -> VALIDATE -> DEDUPLICATE
// -> RESOLVE RELATIONSHIPS -> PREVIEW -> IMPORT -> VERIFY -> AUDIT.
// Every import is a persistent, traceable ImportJob. Every source row is a
// persistent ImportRecord so results are auditable and rollback-capable
// (see docs/stage-b/entity-mapping.md for the canonical entity mapping this
// engine populates - it writes ONLY to existing parties/properties/growRelationships,
// never a parallel "imported record" table).

export const IMPORT_JOB_STATUSES = [
  "UPLOADED",
  "PARSING",
  "MAPPING_REQUIRED",
  "VALIDATING",
  "REVIEW_REQUIRED",
  "READY_TO_IMPORT",
  "IMPORTING",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "ROLLED_BACK",
] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

export const IMPORT_SOURCE_FILE_TYPES = ["csv", "xlsx"] as const;
export type ImportSourceFileType = (typeof IMPORT_SOURCE_FILE_TYPES)[number];

export const importJobs = pgTable("import_jobs", {
  id: serial("id").primaryKey(),
  brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
  initiatedByUserId: integer("initiated_by_user_id").notNull().references(() => users.id),

  filename: text("filename").notNull(),
  sourceFileType: text("source_file_type").notNull(), // csv | xlsx
  detectedSourceSystem: text("detected_source_system"), // best-effort, nullable

  status: text("status").notNull().default("UPLOADED"),
  // column header -> canonical field key, captured at the mapping step and
  // reused verbatim by the pipeline so mapping is never re-guessed.
  mapping: jsonb("mapping"),

  totalRows: integer("total_rows").notNull().default(0),
  processedRows: integer("processed_rows").notNull().default(0),
  validRows: integer("valid_rows").notNull().default(0),
  warningRows: integer("warning_rows").notNull().default(0),
  rejectedRows: integer("rejected_rows").notNull().default(0),
  duplicateCandidates: integer("duplicate_candidates").notNull().default(0),

  contactsCreated: integer("contacts_created").notNull().default(0),
  contactsUpdated: integer("contacts_updated").notNull().default(0),
  propertiesCreated: integer("properties_created").notNull().default(0),
  propertiesUpdated: integer("properties_updated").notNull().default(0),
  relationshipsCreated: integer("relationships_created").notNull().default(0),

  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  failureReason: text("failure_reason"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const IMPORT_RECORD_STATUSES = [
  "pending", // parsed, not yet validated
  "valid",
  "warning",
  "error",
  "imported",
  "skipped", // user chose not to import this row
] as const;
export type ImportRecordStatus = (typeof IMPORT_RECORD_STATUSES)[number];

export const IMPORT_MATCH_TYPES = ["exact", "probable", "possible", "new"] as const;
export type ImportMatchType = (typeof IMPORT_MATCH_TYPES)[number];

export const IMPORT_RESOLUTIONS = ["use_existing", "create_new", "merge", "skip"] as const;
export type ImportResolution = (typeof IMPORT_RESOLUTIONS)[number];

// One row per source spreadsheet row. This is the traceability spine: every
// entity Stage B ever creates or matches is reachable from here, which is
// what makes "which records did import job X create" and safe rollback
// possible without ever touching working data outside what THIS job did.
export const importRecords = pgTable("import_records", {
  id: serial("id").primaryKey(),
  importJobId: integer("import_job_id").notNull().references(() => importJobs.id),
  sourceRowNumber: integer("source_row_number").notNull(),

  rawData: jsonb("raw_data").notNull(), // original row, keyed by source header, preserved verbatim
  normalizedData: jsonb("normalized_data"), // NormalisedImportRecord after normalise+map

  status: text("status").notNull().default("pending"),
  errors: jsonb("errors"), // string[]
  warnings: jsonb("warnings"), // string[]

  contactMatchType: text("contact_match_type"), // exact | probable | possible | new
  contactMatchCandidateId: integer("contact_match_candidate_id").references(() => parties.id),
  contactMatchScore: numeric("contact_match_score"),
  contactResolution: text("contact_resolution"), // use_existing | create_new | merge | skip

  propertyMatchType: text("property_match_type"),
  propertyMatchCandidateId: integer("property_match_candidate_id").references(() => properties.id),
  propertyMatchScore: numeric("property_match_score"),
  propertyResolution: text("property_resolution"),

  relationshipType: text("relationship_type"), // resolved GROW_RELATIONSHIP_TYPES value

  resultPartyId: integer("result_party_id").references(() => parties.id),
  resultPropertyId: integer("result_property_id").references(() => properties.id),
  resultRelationshipId: integer("result_relationship_id").references(() => growRelationships.id),
  partyWasCreated: boolean("party_was_created").notNull().default(false),
  propertyWasCreated: boolean("property_was_created").notNull().default(false),
  relationshipWasCreated: boolean("relationship_was_created").notNull().default(false),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertImportJobSchema = createInsertSchema(importJobs).omit({ id: true, createdAt: true, updatedAt: true });
export const insertImportRecordSchema = createInsertSchema(importRecords).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertImportJob = z.infer<typeof insertImportJobSchema>;
export type InsertImportRecord = z.infer<typeof insertImportRecordSchema>;
export type ImportJob = typeof importJobs.$inferSelect;
export type ImportRecord = typeof importRecords.$inferSelect;
