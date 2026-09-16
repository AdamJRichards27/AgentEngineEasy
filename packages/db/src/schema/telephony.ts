import { pgTable, serial, text, integer, boolean, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { brokerages, users } from "./users";
import { parties } from "./property";

// AE GROW Priority 6 Stage F1 — Call Foundation, Consent Model and Sandbox
// Telephony.
//
// Authorised scope only: this file establishes the safe, provider-neutral
// FOUNDATION for future contact calling. It never places a real call, never
// records real audio, never transcribes a real phone call, and never
// activates a real telephony provider. See docs/AE_GROW_PRIORITY_6_STAGE_F_
// DISCOVERY_AND_ARCHITECTURE.md (PR #39) for the discovery this build is
// based on, and the Stage F1 completion report for the full list of
// confirmations (no real provider, no real calls, no audio storage, no
// phone transcription, no autonomous CRM writes).
//
// Deliberately does NOT touch `parties.mobile` (property.ts) — that
// remains the raw, user-entered contact field, untouched and unmutated.
// Canonical E.164 normalisation for calling purposes is computed at
// call-session-creation time by apps/api/src/lib/telephony/phoneNumber.ts
// and stored ONLY on grow_call_sessions.destinationNormalized — a snapshot
// of the exact number a specific call session targeted, never written back
// onto the party record itself.
//
// Three new tables, each carrying brokerageId directly (this repository's
// tenant-isolation convention — see apps/api/src/routes/__tests__/
// testSupport.ts's own cleanupBrokerages() doc comment):
//   - growCallRecordingConsents: the technical model for representing
//     call-recording consent (§8 of the governing authorisation). Deliberately
//     does NOT decide what legally valid consent looks like for AU or NZ —
//     it only records what was captured, by whom, under what claimed scope,
//     and whether it has since been withdrawn. Defined BEFORE
//     growCallSessions below so the session's own recordingConsentId can
//     reference it directly, with no circular/self-referencing FK needed
//     between the two tables (see growCallSessions' own column comment for
//     why a consent row does not also carry a callSessionId back-reference).
//   - growCallSessions: the provider-neutral call-session model (§6-7). One
//     row per attempted (always sandbox-only in F1) call. destinationRaw +
//     destinationNormalized together make "the exact number dialled"
//     auditable per the governing instruction's §6 requirement, independent
//     of whatever the party's own contact record says today or later.
//   - growCallWebhookEvents: inbound sandbox-provider event idempotency,
//     mirroring communications.ts's communicationWebhookEvents table
//     structure and unique-index convention exactly (see that file's own
//     header comment) — a provider event id is recognised and skipped if
//     redelivered, never reprocessed.

export const GROW_CALL_RECORDING_CONSENT_SCOPES = ["PER_CALL", "STANDING"] as const;
export type GrowCallRecordingConsentScope = (typeof GROW_CALL_RECORDING_CONSENT_SCOPES)[number];

export const GROW_CALL_RECORDING_CONSENT_SOURCES = ["VERBAL_ON_CALL", "WRITTEN", "ELECTRONIC", "OTHER"] as const;
export type GrowCallRecordingConsentSource = (typeof GROW_CALL_RECORDING_CONSENT_SOURCES)[number];

export const GROW_CALL_RECORDING_CONSENT_STATUSES = ["ACTIVE", "WITHDRAWN", "EXPIRED"] as const;
export type GrowCallRecordingConsentStatus = (typeof GROW_CALL_RECORDING_CONSENT_STATUSES)[number];

// §8 — the technical consent model. Nothing here declares AU/NZ legal
// validity (§20, §18 of the discovery) — that remains an outstanding legal
// review item, tracked in the Stage F1 completion report, never converted
// into a code default. Both PER_CALL and STANDING scopes are supported;
// neither is defaulted to valid — apps/api/src/lib/telephony/consent.ts's
// resolveRecordingPermission() fails closed (§9) regardless of scope.
export const growCallRecordingConsents = pgTable(
  "grow_call_recording_consents",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    partyId: integer("party_id").notNull().references(() => parties.id),

    scope: text("scope").notNull(), // PER_CALL | STANDING
    status: text("status").notNull().default("ACTIVE"), // ACTIVE | WITHDRAWN | EXPIRED
    source: text("source").notNull(), // VERBAL_ON_CALL | WRITTEN | ELECTRONIC | OTHER

    // Free-text, deliberately not an enum — AU/NZ jurisdiction handling is
    // an open legal-review item (§20), not something this schema should
    // constrain to a fixed list before that review lands.
    jurisdiction: text("jurisdiction"),
    // Identifies which consent script/text/version was presented — never
    // the legal adequacy of that text, which is outside this schema's remit.
    consentVersion: text("consent_version"),

    capturedAt: timestamp("captured_at").notNull().defaultNow(),
    capturedByUserId: integer("captured_by_user_id").notNull().references(() => users.id),

    expiresAt: timestamp("expires_at"),

    withdrawnAt: timestamp("withdrawn_at"),
    withdrawnByUserId: integer("withdrawn_by_user_id").references(() => users.id),
    withdrawalReason: text("withdrawal_reason"),

    // Evidence metadata only (e.g. capture method/context) — never audio,
    // never a raw provider payload. See F1's own "no audio storage" rule.
    evidenceMetadata: jsonb("evidence_metadata"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    brokeragePartyIdx: index("grow_call_recording_consents_brokerage_party_idx").on(table.brokerageId, table.partyId),
    brokerageStatusIdx: index("grow_call_recording_consents_brokerage_status_idx").on(table.brokerageId, table.status),
  }),
);

export const GROW_CALL_SESSION_STATUSES = [
  "DRAFT",
  "READY",
  "DIAL_REQUESTED",
  "RINGING",
  "CONNECTED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type GrowCallSessionStatus = (typeof GROW_CALL_SESSION_STATUSES)[number];

export const GROW_CALL_DESTINATION_COUNTRIES = ["AU", "NZ"] as const;
export type GrowCallDestinationCountry = (typeof GROW_CALL_DESTINATION_COUNTRIES)[number];

// §9 — recording is a SEPARATE axis from call state (never "call exists"
// implying "recording authorised"). PERMITTED_NOT_CAPTURED is deliberately
// named to make F1's own §17 "no audio storage" rule visible in the data
// itself: even when a valid consent makes recording technically permitted,
// F1 never actually captures/stores anything, so no status here ever means
// "recorded".
export const GROW_CALL_RECORDING_STATUSES = ["NOT_REQUESTED", "DENIED", "PERMITTED_NOT_CAPTURED"] as const;
export type GrowCallRecordingStatus = (typeof GROW_CALL_RECORDING_STATUSES)[number];

// §18 — schema-ready only. F1 never transitions this away from
// NOT_APPLICABLE; no sandbox call is ever fed into Stage E transcription.
export const GROW_CALL_TRANSCRIPTION_STATUSES = ["NOT_APPLICABLE", "PENDING", "COMPLETED", "FAILED"] as const;
export type GrowCallTranscriptionStatus = (typeof GROW_CALL_TRANSCRIPTION_STATUSES)[number];

// §6-7 — the provider-neutral call-session model and its explicit state
// machine (apps/api/src/lib/telephony/stateMachine.ts owns the validated
// transition table; this column only stores the current value).
export const growCallSessions = pgTable(
  "grow_call_sessions",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    partyId: integer("party_id").notNull().references(() => parties.id),
    initiatedByUserId: integer("initiated_by_user_id").notNull().references(() => users.id),

    // The exact number dialled is auditable independent of the party's own
    // (mutable) contact record — see this file's own header comment.
    destinationRaw: text("destination_raw").notNull(),
    destinationNormalized: text("destination_normalized").notNull(),
    destinationCountry: text("destination_country").notNull(), // AU | NZ

    provider: text("provider").notNull().default("sandbox"),
    // Deterministic once dial is requested (see SandboxTelephonyProvider) —
    // null until then. Nullable, so the uniqueness of (provider,
    // providerCallId) below tolerates multiple DRAFT/READY rows that never
    // reached dialling (Postgres treats each NULL as distinct).
    providerCallId: text("provider_call_id"),

    status: text("status").notNull().default("DRAFT"),

    recordingRequested: boolean("recording_requested").notNull().default(false),
    // §9 — fail-closed. Only ever true when an explicit, valid,
    // non-withdrawn, non-expired consent record was resolved server-side;
    // never set from a client-supplied boolean.
    recordingPermitted: boolean("recording_permitted").notNull().default(false),
    recordingConsentId: integer("recording_consent_id").references(() => growCallRecordingConsents.id),
    recordingStatus: text("recording_status").notNull().default("NOT_REQUESTED"),
    transcriptionStatus: text("transcription_status").notNull().default("NOT_APPLICABLE"),

    confirmedAt: timestamp("confirmed_at"), // §13 — explicit user confirmation before the sandbox call begins
    startedAt: timestamp("started_at"),
    answeredAt: timestamp("answered_at"),
    endedAt: timestamp("ended_at"),
    durationSeconds: integer("duration_seconds"),

    failureReason: text("failure_reason"),
    cancelledReason: text("cancelled_reason"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    brokeragePartyIdx: index("grow_call_sessions_brokerage_party_idx").on(table.brokerageId, table.partyId),
    brokerageStatusIdx: index("grow_call_sessions_brokerage_status_idx").on(table.brokerageId, table.status),
    providerCallIdUnique: uniqueIndex("grow_call_sessions_provider_call_id_unique").on(table.provider, table.providerCallId),
  }),
);

// §15 — inbound sandbox-webhook idempotency, mirroring
// communications.ts's communicationWebhookEvents exactly (same shape, same
// unique-index convention). F1 only ever populates this with
// provider = "sandbox" events; see routes/growCallsWebhooks.ts.
export const growCallWebhookEvents = pgTable(
  "grow_call_webhook_events",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    relatedCallSessionId: integer("related_call_session_id").references(() => growCallSessions.id),

    receivedAt: timestamp("received_at").notNull().defaultNow(),
    processedAt: timestamp("processed_at"),
    processingStatus: text("processing_status").notNull().default("PENDING"), // PENDING | PROCESSED | FAILED
    processingError: text("processing_error"),
  },
  (table) => ({
    dedupIdx: uniqueIndex("grow_call_webhook_events_dedup_idx").on(table.provider, table.providerEventId),
    relatedCallSessionIdx: index("grow_call_webhook_events_related_call_session_idx").on(table.relatedCallSessionId),
  }),
);

export const insertGrowCallRecordingConsentSchema = createInsertSchema(growCallRecordingConsents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertGrowCallSessionSchema = createInsertSchema(growCallSessions).omit({ id: true, createdAt: true, updatedAt: true });
export const insertGrowCallWebhookEventSchema = createInsertSchema(growCallWebhookEvents).omit({ id: true, receivedAt: true });

export type InsertGrowCallRecordingConsent = z.infer<typeof insertGrowCallRecordingConsentSchema>;
export type InsertGrowCallSession = z.infer<typeof insertGrowCallSessionSchema>;
export type InsertGrowCallWebhookEvent = z.infer<typeof insertGrowCallWebhookEventSchema>;

export type GrowCallRecordingConsent = typeof growCallRecordingConsents.$inferSelect;
export type GrowCallSession = typeof growCallSessions.$inferSelect;
export type GrowCallWebhookEvent = typeof growCallWebhookEvents.$inferSelect;
