// Agent Engine 2.0 — Communications Hub (Priority 8).
//
// A property-centred communication record: WHO needs to hear WHAT, from
// WHOM, by WHEN — and did it happen. This is deliberately not a CRM, not a
// bulk-marketing platform, and not an unrestricted AI messaging agent (see
// the governing spec's Section 5 "DO NOT BUILD NOW" list). Every table
// below exists to answer one of: what was sent/received, to/from whom,
// through which channel, under what consent basis, did it deliver, and
// what happened when it didn't.
//
// Recipient identity is deliberately NOT duplicated here — every message
// that has a real party as its counterpart references `parties`/
// `propertyParties` (packages/db/src/schema/property.ts), the existing
// "enter once, reuse everywhere" contact model. A manual, one-off
// recipient (a supplier, a non-party contact) is recorded on
// communicationParticipants with partyId left null and isManualEntry set,
// per the spec's Section 11 manual-entry fallback — no new Supplier/CRM
// contact table is introduced.
//
// History is append-only where it matters: communicationDeliveryAttempts
// is never updated or deleted once written (mirrors risk_exception_
// transitions' own "immutable ledger" convention), and communication_
// messages' own status field always reflects the latest attempt without
// requiring a join for the common case.

import { pgTable, serial, integer, text, boolean, jsonb, timestamp, uuid, uniqueIndex, index, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { brokerages, users } from "./users";
import { properties, parties } from "./property";
import { transactions } from "./transaction";

// Section 6: the channel vocabulary. PHONE_CALL records an outcome only —
// nothing here ever places a call. INTERNAL_NOTE is never sent externally
// and is filtered out of every external-facing read (routes/communications.ts).
export const COMMUNICATION_CHANNELS = ["EMAIL", "SMS", "PHONE_CALL", "EXTERNAL_MESSAGE", "INTERNAL_NOTE"] as const;
export type CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];

export const COMMUNICATION_DIRECTIONS = ["OUTBOUND", "INBOUND"] as const;
export type CommunicationDirection = (typeof COMMUNICATION_DIRECTIONS)[number];

// Section 7: every external communication is classified so consent/opt-out
// rules (Section 16) can be applied per channel+classification.
export const COMMUNICATION_CLASSIFICATIONS = ["TRANSACTIONAL", "SERVICE", "MARKETING"] as const;
export type CommunicationClassification = (typeof COMMUNICATION_CLASSIFICATIONS)[number];

// Section 9: the message status model. SENT != DELIVERED. Validated
// transitions live in apps/api/src/lib/communications/types.ts (mirrors
// pit_crew_assignments' own schema-owns-the-enum / lib-owns-the-transitions
// split).
export const COMMUNICATION_MESSAGE_STATUSES = [
  "DRAFT",
  "AWAITING_APPROVAL",
  "APPROVED",
  "QUEUED",
  "SENDING",
  "SENT",
  "DELIVERED",
  "RECEIVED",
  "FAILED",
  "RETRY_SCHEDULED",
  "BOUNCED",
  "UNDELIVERABLE",
  "CANCELLED",
  "BLOCKED_BY_CONSENT",
  "BLOCKED_BY_COST_CONTROL",
] as const;
export type CommunicationMessageStatus = (typeof COMMUNICATION_MESSAGE_STATUSES)[number];

// Section 11: who a participant is, resolved from the existing property
// party model wherever possible. Vendor/Internal cover the two cases the
// existing PROPERTY_PARTY_ROLES vocabulary (property.ts) doesn't: a
// supplier reached via manual entry (Section 5 explicitly forbids a new
// Supplier CRM table), and an internal-only recipient for INTERNAL_NOTE
// threads.
export const COMMUNICATION_PARTICIPANT_ROLES = [
  "Seller",
  "Buyer",
  "Solicitor",
  "PowerOfAttorney",
  "Vendor",
  "Internal",
  "Other",
] as const;
export type CommunicationParticipantRole = (typeof COMMUNICATION_PARTICIPANT_ROLES)[number];

// One thread per property + topic. A thread is the unit the property-
// centred UI (Section 10) renders — every message belongs to exactly one.
export const communicationThreads = pgTable(
  "communication_threads",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    transactionId: integer("transaction_id").references(() => transactions.id),

    subject: text("subject").notNull(),
    status: text("status").notNull().default("OPEN"), // OPEN | CLOSED — closing is archival only, never deletes history

    createdByUserId: integer("created_by_user_id").references(() => users.id),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at").notNull().defaultNow(),
  },
  (table) => ({
    propertyIdx: index("communication_threads_property_idx").on(table.propertyId, table.lastActivityAt),
    brokerageIdx: index("communication_threads_brokerage_idx").on(table.brokerageId, table.lastActivityAt),
  }),
);

// Section 11: a thread's recipients/participants, each resolved from an
// existing party wherever one exists. isManualEntry + manualEntryReason
// implement the spec's manual-entry fallback (a name/role/destination/
// reason captured and audited, never a silent free-text send).
export const communicationParticipants = pgTable(
  "communication_participants",
  {
    id: serial("id").primaryKey(),
    threadId: integer("thread_id").notNull().references(() => communicationThreads.id),
    partyId: integer("party_id").references(() => parties.id),

    role: text("role").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    mobile: text("mobile"),

    isManualEntry: boolean("is_manual_entry").notNull().default(false),
    manualEntryReason: text("manual_entry_reason"),

    addedByUserId: integer("added_by_user_id").references(() => users.id),
    addedAt: timestamp("added_at").notNull().defaultNow(),
  },
  (table) => ({
    threadIdx: index("communication_participants_thread_idx").on(table.threadId),
  }),
);

// The core record. One row per message (draft, sent, or received).
export const communicationMessages = pgTable(
  "communication_messages",
  {
    id: serial("id").primaryKey(),
    threadId: integer("thread_id").notNull().references(() => communicationThreads.id),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    transactionId: integer("transaction_id").references(() => transactions.id),

    direction: text("direction").notNull(),
    channel: text("channel").notNull(),
    classification: text("classification").notNull(),
    status: text("status").notNull().default("DRAFT"),

    subject: text("subject"),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),

    // Section 12: sender identity. senderUserId is who authored/is
    // accountable; sendOnBehalfOfUserId is set only when a Pit Crew member
    // sends as (on behalf of) an agent — the recipient-facing identity is
    // always the agent's, never Pit Crew's own (Section 12).
    senderUserId: integer("sender_user_id").references(() => users.id),
    sendOnBehalfOfUserId: integer("send_on_behalf_of_user_id").references(() => users.id),

    recipientParticipantId: integer("recipient_participant_id").references(() => communicationParticipants.id),
    recipientDisplayName: text("recipient_display_name"),
    // The exact email/phone actually used for this send — snapshotted at
    // send time so a later edit to the party's contact details never
    // rewrites what a historical message says it was sent to.
    recipientDestination: text("recipient_destination"),

    templateId: integer("template_id").references(() => communicationTemplates.id),
    templateVersion: integer("template_version"),

    // Provider-neutral (Sections 17-18): "sandbox_email" / "sandbox_sms"
    // until real credentials are configured — never fabricated as a real
    // provider name.
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),

    // Durable-outbox idempotency (Section 20). Unique but nullable — a
    // DRAFT has none yet; one is minted the moment a message is queued.
    idempotencyKey: text("idempotency_key"),

    // Self-referencing FK: needs the lazy-arrow + explicit AnyPgColumn
    // return-type form (rather than the usual `() => table.column`) because
    // communicationMessages is still being defined at this point — Drizzle
    // can't infer the column type from a table that doesn't exist yet
    // without the annotation breaking the circularity.
    replyToMessageId: integer("reply_to_message_id").references((): AnyPgColumn => communicationMessages.id),

    scheduledAt: timestamp("scheduled_at"),
    sentAt: timestamp("sent_at"),
    deliveredAt: timestamp("delivered_at"),
    failedAt: timestamp("failed_at"),

    failureCategory: text("failure_category"),
    failureDetail: text("failure_detail"),
    retryCount: integer("retry_count").notNull().default(0),
    maxRetries: integer("max_retries").notNull().default(3),

    costEstimateCents: integer("cost_estimate_cents"),
    costActualCents: integer("cost_actual_cents"),

    correlationId: uuid("correlation_id"),
    causationId: uuid("causation_id"),

    createdByUserId: integer("created_by_user_id").references(() => users.id),

    // Optimistic concurrency (mirrors pit_crew_assignments.version) — the
    // approval/cancel/send-now surface all pass expectedVersion back.
    version: integer("version").notNull().default(1),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    threadIdx: index("communication_messages_thread_idx").on(table.threadId, table.createdAt),
    propertyIdx: index("communication_messages_property_idx").on(table.propertyId, table.status),
    brokerageStatusIdx: index("communication_messages_brokerage_status_idx").on(table.brokerageId, table.status),
    idempotencyKeyIdx: uniqueIndex("communication_messages_idempotency_key_idx").on(table.idempotencyKey),
  }),
);

// Append-only delivery/status history — never updated or deleted (Section
// 8). Every status transition a message goes through (queued, sent,
// delivered, failed, retried) gets one row here; communicationMessages.status
// is always the latest, kept denormalised so the common "what's this
// message's status" read never needs a join.
export const communicationDeliveryAttempts = pgTable(
  "communication_delivery_attempts",
  {
    id: serial("id").primaryKey(),
    messageId: integer("message_id").notNull().references(() => communicationMessages.id),
    attemptNumber: integer("attempt_number").notNull(),
    attemptedAt: timestamp("attempted_at").notNull().defaultNow(),
    status: text("status").notNull(),
    providerResponseCode: text("provider_response_code"),
    // A short, redacted summary only — never the full raw provider payload
    // (Agent Engine 2.0's dataClassification convention, domain_events.ts).
    providerResponseSummary: text("provider_response_summary"),
    errorDetail: text("error_detail"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    messageIdx: index("communication_delivery_attempts_message_idx").on(table.messageId, table.attemptedAt),
  }),
);

// Section 14: versioned templates for Launch/Transaction/PC events, with
// approved placeholders. brokerageId null = a system-wide default template
// available to every tenant; a brokerage may layer its own on top.
export const communicationTemplates = pgTable(
  "communication_templates",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").references(() => brokerages.id),
    templateKey: text("template_key").notNull(),
    name: text("name").notNull(),
    channel: text("channel").notNull(),
    classification: text("classification").notNull(),
    category: text("category").notNull(), // LAUNCH | TRANSACTION | PC_EVENT | GENERAL
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("DRAFT"), // DRAFT | ACTIVE | ARCHIVED

    subject: text("subject"),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    // Allow-listed placeholder keys this version may use, e.g.
    // ["property.address","agent.firstName"] — rendering (templates.ts)
    // refuses any placeholder not declared here, mirroring the exception
    // engine's metadata allow-list convention.
    placeholders: jsonb("placeholders").notNull().default(sql`'[]'::jsonb`),

    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    activatedAt: timestamp("activated_at"),
  },
  (table) => ({
    keyVersionIdx: index("communication_templates_key_version_idx").on(table.templateKey, table.version),
    brokerageStatusIdx: index("communication_templates_brokerage_status_idx").on(table.brokerageId, table.status),
  }),
);

// Section 16: consent/opt-out, per (brokerage, destination, channel).
// Transactional/service messages are implicitly permitted unless
// transactionalOptOut is set (a configurable exemption — see
// communicationSettings.transactionalOptOutAllowed — never hardcoded);
// marketing requires marketingOptIn = true.
export const communicationConsent = pgTable(
  "communication_consent",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    partyId: integer("party_id").references(() => parties.id),
    destination: text("destination").notNull(), // normalised email or phone
    channel: text("channel").notNull(), // EMAIL | SMS

    marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
    transactionalOptOut: boolean("transactional_opt_out").notNull().default(false),

    source: text("source").notNull(), // MANUAL | WEBHOOK_REPLY_STOP | INITIAL_CAPTURE | IMPORTED
    recordedByUserId: integer("recorded_by_user_id").references(() => users.id),
    notes: text("notes"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    destinationIdx: uniqueIndex("communication_consent_destination_idx").on(table.brokerageId, table.destination, table.channel),
  }),
);

// Section 21: SMS/usage cost control, independent of AI allowances,
// metered per (brokerage, scope, period, channel). scopeType BROKERAGE
// uses the brokerageId itself as scopeId so both scopes share one row shape.
export const communicationCostLedger = pgTable(
  "communication_cost_ledger",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    scopeType: text("scope_type").notNull(), // BROKERAGE | USER
    scopeId: integer("scope_id").notNull(),
    periodKey: text("period_key").notNull(), // "YYYY-MM"
    channel: text("channel").notNull(),

    messageCount: integer("message_count").notNull().default(0),
    costEstimateCents: integer("cost_estimate_cents").notNull().default(0),

    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    scopeIdx: uniqueIndex("communication_cost_ledger_scope_idx").on(
      table.brokerageId,
      table.scopeType,
      table.scopeId,
      table.periodKey,
      table.channel,
    ),
  }),
);

// Section 19: inbound webhook idempotency/dedup. One row per provider
// event id — a redelivered webhook (every provider's documented behaviour)
// is recognised and skipped rather than double-processed.
export const communicationWebhookEvents = pgTable(
  "communication_webhook_events",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(), // DELIVERY_RECEIPT | INBOUND_MESSAGE | BOUNCE | OPT_OUT
    payload: jsonb("payload").notNull(),
    relatedMessageId: integer("related_message_id").references(() => communicationMessages.id),

    receivedAt: timestamp("received_at").notNull().defaultNow(),
    processedAt: timestamp("processed_at"),
    processingStatus: text("processing_status").notNull().default("PENDING"), // PENDING | PROCESSED | FAILED
    processingError: text("processing_error"),
  },
  (table) => ({
    dedupIdx: uniqueIndex("communication_webhook_events_dedup_idx").on(table.provider, table.providerEventId),
  }),
);

// Section 21/22/16: per-brokerage configuration — cost thresholds, quiet
// hours, and the transactional opt-out exemption knob. One row per
// brokerage, created lazily on first read (see lib/communications/settings.ts)
// rather than requiring a migration-time seed for every existing brokerage.
export const communicationSettings = pgTable("communication_settings", {
  id: serial("id").primaryKey(),
  brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id).unique(),

  // Section 22: configurable, never hardcoded to a single timezone — null
  // means "fall back to the same resolveTimeZone() default the Command
  // Centre already uses" (commandCentre/timezone.ts), not a silent AU
  // assumption baked into this module.
  timeZone: text("time_zone"),
  quietHoursStart: text("quiet_hours_start"), // "HH:MM", local to timeZone
  quietHoursEnd: text("quiet_hours_end"),

  smsSoftThresholdCents: integer("sms_soft_threshold_cents").notNull().default(5000),
  smsHardThresholdCents: integer("sms_hard_threshold_cents").notNull().default(20000),

  // Section 16: whether a transactional/service message can be opted out
  // of at all in this jurisdiction — configurable, not a hardcoded legal
  // exemption.
  transactionalOptOutAllowed: boolean("transactional_opt_out_allowed").notNull().default(true),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertCommunicationThreadSchema = createInsertSchema(communicationThreads).omit({ id: true, createdAt: true, updatedAt: true, lastActivityAt: true });
export const insertCommunicationParticipantSchema = createInsertSchema(communicationParticipants).omit({ id: true, addedAt: true });
export const insertCommunicationMessageSchema = createInsertSchema(communicationMessages).omit({ id: true, createdAt: true, updatedAt: true });
export const insertCommunicationTemplateSchema = createInsertSchema(communicationTemplates).omit({ id: true, createdAt: true, updatedAt: true });
export const insertCommunicationConsentSchema = createInsertSchema(communicationConsent).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertCommunicationThread = z.infer<typeof insertCommunicationThreadSchema>;
export type InsertCommunicationParticipant = z.infer<typeof insertCommunicationParticipantSchema>;
export type InsertCommunicationMessage = z.infer<typeof insertCommunicationMessageSchema>;
export type InsertCommunicationTemplate = z.infer<typeof insertCommunicationTemplateSchema>;
export type InsertCommunicationConsent = z.infer<typeof insertCommunicationConsentSchema>;

export type CommunicationThread = typeof communicationThreads.$inferSelect;
export type CommunicationParticipant = typeof communicationParticipants.$inferSelect;
export type CommunicationMessage = typeof communicationMessages.$inferSelect;
export type CommunicationDeliveryAttempt = typeof communicationDeliveryAttempts.$inferSelect;
export type CommunicationTemplate = typeof communicationTemplates.$inferSelect;
export type CommunicationConsent = typeof communicationConsent.$inferSelect;
export type CommunicationCostLedgerRow = typeof communicationCostLedger.$inferSelect;
export type CommunicationWebhookEvent = typeof communicationWebhookEvents.$inferSelect;
export type CommunicationSettings = typeof communicationSettings.$inferSelect;
