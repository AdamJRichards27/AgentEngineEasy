import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

// Critical Blocker Remediation, Phase 8 — application privacy controls.
// See docs/legal/PILOT_PRIVACY_POLICY.md and
// docs/legal/DATA_ACCESS_CORRECTION_DELETION_PROCESS.md for the
// participant-facing documents this schema supports.

export const CONSENT_TYPES = ["terms_of_use", "privacy_policy"] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

// One row per (user, document, version) acceptance — capturing the exact
// version and moment accepted, per Phase 8's "version+timestamp acceptance
// capture" requirement. Never deleted, even if the user is later removed —
// this is evidence of what was agreed to and when, not the user's current
// membership state.
export const consentRecords = pgTable("consent_records", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  consentType: text("consent_type").notNull(),
  documentVersion: text("document_version").notNull(),
  acceptedAt: timestamp("accepted_at").notNull().defaultNow(),
});

export type ConsentRecord = typeof consentRecords.$inferSelect;

export const PRIVACY_REQUEST_TYPES = ["export", "deletion"] as const;
export type PrivacyRequestType = (typeof PRIVACY_REQUEST_TYPES)[number];

export const PRIVACY_REQUEST_STATUSES = ["pending", "completed", "declined"] as const;
export type PrivacyRequestStatus = (typeof PRIVACY_REQUEST_STATUSES)[number];

// A tracked request, not an automated action. Critical Blocker
// Remediation instruction: "never auto-delete regulated/AML records —
// route through approved retention process." This table is that routing
// mechanism — creating a request never itself exports or deletes
// anything; an admin reviews and marks it handled through whatever
// process is appropriate for the data involved (see
// docs/legal/DATA_ACCESS_CORRECTION_DELETION_PROCESS.md).
export const privacyRequests = pgTable("privacy_requests", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  brokerageId: integer("brokerage_id"),
  type: text("type").notNull(),
  status: text("status").notNull().default("pending"),
  notes: text("notes"),
  requestedAt: timestamp("requested_at").notNull().defaultNow(),
  handledAt: timestamp("handled_at"),
  handledByUserId: integer("handled_by_user_id").references(() => users.id),
});

export type PrivacyRequest = typeof privacyRequests.$inferSelect;
