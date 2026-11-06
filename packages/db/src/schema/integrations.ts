import { pgTable, integer, text, boolean, jsonb, timestamp, uuid, serial, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { brokerages, users } from "./users";

// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
//
// A provider-neutral spine future integrations (portals, accounting,
// banking, email/SMS, calendar, e-signature, AML/identity, conveyancing,
// document services, CRM/migration, marketing, signage/photography,
// utilities, other brokerage services) will all be built against — not a
// single integration. Section 4's non-negotiable rules shape every table
// here: AE stays the sole source of truth (no table below is ever read as
// authoritative domain state — see integrationExternalMappings' own
// comment), a connection is disabled by default and unusable until
// explicitly approved and activated (integrationConnections.status), and no
// real credential is ever stored (integrationCredentials.secretIdentifier
// is an opaque reference, never a secret value — see that table's comment).
//
// Deliberately reuses rather than duplicates: the canonical domain event
// bus (packages/events) is the ONE event system — there is no second
// "integration_events" table, an inbound webhook is transformed and then
// published through publishDomainEvent exactly like Communications'
// webhooks.ts already does; audit_logs (lib/audit.ts's logAudit) is reused
// for the human-readable audit trail rather than a parallel
// integration_audit_events table; a connection's approval is tracked on the
// connection row itself plus integrationConnectionTransitions (its own
// append-only ledger, mirroring risk_exception_transitions/
// launch_plan_transitions) rather than a separate integration_approvals
// table — unlike Launch's vendor_approvals, a connection has at most one
// live approval decision at a time, not a multi-request history a separate
// table would earn its keep for. Capability grants live as a jsonb array on
// the connection itself (integrationConnections.approvedScopes), the same
// "jsonb array of small values" convention risk_exceptions.relatedTaskIds
// and launch_plans.marketReadyBlockers already use, rather than a separate
// integration_capabilities join table for what is, per connection, a short
// list. A reconciliation-run/reconciliation-item framework and named,
// reusable mapping profiles are explicitly OUT of this pass's schema (see
// docs/INTEGRATION_AND_DATA_EXCHANGE_FOUNDATION.md's Deferred section) —
// this build demonstrates reconciliation-mismatch handling through the
// dead-letter path in a mock-adapter test scenario rather than standing up
// a persisted framework for it.

// ---------------------------------------------------------------------
// Provider catalogue.
// ---------------------------------------------------------------------

// Section 3: the provider categories this foundation must be usable by, not
// providers this build connects to. A row existing here is a catalogue
// entry only — see integrationConnections' own comment for what actually
// gates any use of one.
export const INTEGRATION_PROVIDER_CATEGORIES = [
  "PORTAL",
  "ACCOUNTING",
  "BANKING",
  "EMAIL",
  "SMS",
  "CALENDAR",
  "ESIGNATURE",
  "AML_IDENTITY",
  "CONVEYANCING",
  "DOCUMENT_SERVICES",
  "CRM_MIGRATION",
  "MARKETING",
  "SIGNAGE_PHOTOGRAPHY",
  "UTILITIES",
  "OTHER_BROKERAGE_SERVICES",
] as const;
export type IntegrationProviderCategory = (typeof INTEGRATION_PROVIDER_CATEGORIES)[number];

// Section 18 ("do not connect to a live provider"): every provider this
// build ships is environmentClassification "MOCK". "SANDBOX"/"PRODUCTION"
// are schema-ready for a later, individually-approved step — nothing in
// this codebase ever activates a connection against one (see
// apps/api/src/lib/integrations/model.ts's activateConnection, which
// refuses any provider whose environmentClassification isn't "MOCK", as a
// defensive belt-and-suspenders on top of "no such provider row exists
// yet" being true regardless).
export const INTEGRATION_ENVIRONMENT_CLASSIFICATIONS = ["MOCK", "SANDBOX", "PRODUCTION"] as const;
export type IntegrationEnvironmentClassification = (typeof INTEGRATION_ENVIRONMENT_CLASSIFICATIONS)[number];

// Code-defined catalogue rows (apps/api/src/lib/integrations/registry.ts's
// PROVIDER_CATALOGUE) are upserted here at bootstrap — mirrors the
// Exception & Risk Engine's rule registry being code-defined (registry.ts's
// own module comment: "no interpreter for a stored rule payload") while
// still needing a real table for FK integrity from integrationConnections
// and for the admin UI's catalogue list/filter.
export const integrationProviders = pgTable("integration_providers", {
  id: text("id").primaryKey(), // stable slug, e.g. "mock_portal_v1"
  category: text("category").notNull(),
  displayName: text("display_name").notNull(),
  description: text("description").notNull(),
  // Capability verbs this provider declares support for, e.g.
  // ["portal.publishListing","portal.updateListingStatus"] — domain code
  // never references a provider SDK, only these verbs (Section 4).
  capabilities: jsonb("capabilities").notNull().default(sql`'[]'::jsonb`),
  environmentClassification: text("environment_classification").notNull().default("MOCK"),
  isBuiltIn: boolean("is_built_in").notNull().default(true),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------
// Connection lifecycle.
// ---------------------------------------------------------------------

// Section 4 "no connection without approval": DRAFT is the only status a
// newly-created connection can ever start in, and every step from there is
// a deliberate, audited, actor-attributed transition (see
// integrationConnectionTransitions below and model.ts's own transition
// table). REJECTED/REVOKED/EXPIRED are terminal. VALIDATION_FAILED loops
// back to CONFIGURING rather than forward, so a failed
// test-with-mock-adapter can never be silently skipped past.
export const INTEGRATION_CONNECTION_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "REJECTED",
  "APPROVED",
  "CONFIGURING",
  "VALIDATING",
  "VALIDATION_FAILED",
  "ACTIVE",
  "SUSPENDED",
  "REVOKED",
  "EXPIRED",
] as const;
export type IntegrationConnectionStatus = (typeof INTEGRATION_CONNECTION_STATUSES)[number];

// The only status a connection can ever transmit/receive real (mock) data
// in — every other status is, by construction, disabled (Section 4). See
// apps/api/src/lib/integrations/registry.ts's resolveActiveConnection, the
// single fail-closed chokepoint that reads this.
export const INTEGRATION_CONNECTION_USABLE_STATUSES: IntegrationConnectionStatus[] = ["ACTIVE"];

export const INTEGRATION_HEALTH_STATUSES = ["UNKNOWN", "HEALTHY", "DEGRADED", "UNHEALTHY"] as const;
export type IntegrationHealthStatus = (typeof INTEGRATION_HEALTH_STATUSES)[number];

export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    providerId: text("provider_id").notNull().references(() => integrationProviders.id),

    displayName: text("display_name").notNull(),
    status: text("status").notNull().default("DRAFT"),

    // Required before approval can even be requested (Section 4: "purpose").
    purpose: text("purpose").notNull(),
    // Snapshotted from the provider at creation and re-checked at every
    // dispatch (never trusted as static) — see registry.ts's
    // resolveActiveConnection.
    environmentClassification: text("environment_classification").notNull().default("MOCK"),

    requestedScopes: jsonb("requested_scopes").notNull().default(sql`'[]'::jsonb`), // string[] capability verbs
    approvedScopes: jsonb("approved_scopes").notNull().default(sql`'[]'::jsonb`), // string[] — subset of requestedScopes

    requestedBy: integer("requested_by").notNull().references(() => users.id),
    requestedAt: timestamp("requested_at"),

    approvedBy: integer("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at"),
    rejectedBy: integer("rejected_by").references(() => users.id),
    rejectedAt: timestamp("rejected_at"),
    rejectReason: text("reject_reason"),

    // Section 4 "authority": the accountable human for this connection —
    // may differ from whoever clicked approve (mirrors pcFeeAuthorities'
    // own authority/approver split).
    authorityUserId: integer("authority_user_id").references(() => users.id),

    lastValidatedAt: timestamp("last_validated_at"),
    lastValidationResult: jsonb("last_validation_result"), // { ok: boolean, detail: string, at: string }

    activatedAt: timestamp("activated_at"),
    activatedBy: integer("activated_by").references(() => users.id),
    suspendedAt: timestamp("suspended_at"),
    suspendedBy: integer("suspended_by").references(() => users.id),
    suspendReason: text("suspend_reason"),
    revokedAt: timestamp("revoked_at"),
    revokedBy: integer("revoked_by").references(() => users.id),
    revokeReason: text("revoke_reason"),
    expiredAt: timestamp("expired_at"),

    // Separate from lifecycle `status` on purpose (mirrors communication
    // messages' own status vs. delivery-attempt-history split) — a
    // temporarily DEGRADED health reading never itself changes whether the
    // connection is usable; only an explicit SUSPENDED/REVOKED transition does.
    healthStatus: text("health_status").notNull().default("UNKNOWN"),
    healthCheckedAt: timestamp("health_checked_at"),

    // Optimistic concurrency (mirrors communication_messages.version).
    version: integer("version").notNull().default(1),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    brokerageStatusIdx: index("integration_connections_brokerage_status_idx").on(table.brokerageId, table.status),
    providerIdx: index("integration_connections_provider_idx").on(table.providerId),
  }),
);

// Append-only lifecycle ledger — mirrors risk_exception_transitions /
// launch_plan_transitions exactly. This is the primary evidence trail
// Section 14's audit/traceability acceptance scenarios read from.
export const integrationConnectionTransitions = pgTable(
  "integration_connection_transitions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    connectionId: uuid("connection_id").notNull().references(() => integrationConnections.id),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),

    transitionType: text("transition_type").notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    reason: text("reason"),

    actorType: text("actor_type").notNull(), // SYSTEM | USER
    actorUserId: integer("actor_user_id").references(() => users.id),
    metadata: jsonb("metadata"),

    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  },
  (table) => ({
    connectionOccurredIdx: index("integration_connection_transitions_connection_occurred_idx").on(table.connectionId, table.occurredAt),
  }),
);

// ---------------------------------------------------------------------
// Transactional outbox — every outbound command an active connection
// issues, queued durably before dispatch (Section 5's "transactional
// outbox pattern"). Mirrors financial_payment_outbox /
// communications' own outbox flow.
// ---------------------------------------------------------------------

export const INTEGRATION_OUTBOX_STATUSES = ["PENDING", "DISPATCHING", "SENT", "FAILED", "RETRY_SCHEDULED", "DEAD_LETTERED", "CANCELLED", "MANUAL_REVIEW"] as const;
export type IntegrationOutboxStatus = (typeof INTEGRATION_OUTBOX_STATUSES)[number];

export const integrationOutbox = pgTable(
  "integration_outbox",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    connectionId: uuid("connection_id").notNull().references(() => integrationConnections.id),

    // The AE capability verb being invoked (Section 4: "domain code depends
    // on capability verbs, never a named provider SDK") — never a raw
    // provider endpoint/method name.
    capability: text("capability").notNull(),
    // Already capability-shaped, never a raw provider payload (Section 4:
    // "provider payloads are not canonical models").
    commandPayload: jsonb("command_payload").notNull(),

    status: text("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    dispatchedAt: timestamp("dispatched_at"),

    idempotencyKey: text("idempotency_key").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    causationId: uuid("causation_id"),

    // What domain record this command concerns, e.g. "portal_destination" /
    // the destination's own uuid — traceability only, never a second FK
    // graph (Section: "correlation/causation/provenance visible end-to-end").
    sourceRecordType: text("source_record_type").notNull(),
    sourceRecordId: text("source_record_id").notNull(),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    idempotencyKeyIdx: uniqueIndex("integration_outbox_idempotency_key_idx").on(table.idempotencyKey),
    statusNextAttemptIdx: index("integration_outbox_status_next_attempt_idx").on(table.status, table.nextAttemptAt),
    connectionIdx: index("integration_outbox_connection_idx").on(table.connectionId, table.status),
  }),
);

// Append-only attempt history — mirrors communication_delivery_attempts.
export const integrationOutboxAttempts = pgTable(
  "integration_outbox_attempts",
  {
    id: serial("id").primaryKey(),
    outboxId: uuid("outbox_id").notNull().references(() => integrationOutbox.id),
    attemptNumber: integer("attempt_number").notNull(),
    attemptedAt: timestamp("attempted_at").notNull().defaultNow(),
    status: text("status").notNull(), // SENT | FAILED
    // Short, redacted summary only — never the full raw provider payload
    // (mirrors communication_delivery_attempts.providerResponseSummary).
    providerResponseSummary: text("provider_response_summary"),
    errorDetail: text("error_detail"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    outboxIdx: index("integration_outbox_attempts_outbox_idx").on(table.outboxId, table.attemptedAt),
  }),
);

// ---------------------------------------------------------------------
// Inbound webhook gateway — idempotency + raw-payload audit (Section 6:
// "signature verification, replay protection, idempotency"). Mirrors
// communication_webhook_events, generalised across every provider category
// and connection-scoped (not just provider-scoped) for defence in depth —
// a redelivery can only ever collide within its own connection, never
// across a brokerage boundary even under a hypothetical id collision.
// ---------------------------------------------------------------------

export const integrationInbox = pgTable(
  "integration_inbox",
  {
    id: serial("id").primaryKey(),
    connectionId: uuid("connection_id").notNull().references(() => integrationConnections.id),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),

    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    // Raw inbound payload, kept ONLY for audit/replay/reconciliation
    // (Section 4: "store raw payloads only for audit/replay/reconciliation
    // /regulatory ... transform before entering domain workflows") — never
    // read directly by a domain service; see webhooks.ts's own transform step.
    payload: jsonb("payload").notNull(),
    signatureValid: boolean("signature_valid").notNull(),

    receivedAt: timestamp("received_at").notNull().defaultNow(),
    processedAt: timestamp("processed_at"),
    processingStatus: text("processing_status").notNull().default("PENDING"), // PENDING | PROCESSED | DUPLICATE | REJECTED | FAILED
    processingError: text("processing_error"),
    relatedOutboxId: uuid("related_outbox_id").references(() => integrationOutbox.id),
  },
  (table) => ({
    dedupIdx: uniqueIndex("integration_inbox_dedup_idx").on(table.connectionId, table.provider, table.providerEventId),
    connectionReceivedIdx: index("integration_inbox_connection_received_idx").on(table.connectionId, table.receivedAt),
  }),
);

// ---------------------------------------------------------------------
// External identity mapping (Section 5). NEVER read as authoritative
// domain state — AE remains sole source of truth (Section 4) — this table
// only answers "what external id, if any, corresponds to this internal
// record on this connection", nothing more.
// ---------------------------------------------------------------------

export const integrationExternalMappings = pgTable(
  "integration_external_mappings",
  {
    id: serial("id").primaryKey(),
    connectionId: uuid("connection_id").notNull().references(() => integrationConnections.id),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),

    entityType: text("entity_type").notNull(), // e.g. "PROPERTY" | "CONTACT" | "TRANSACTION" — additive, not a Postgres enum
    internalId: text("internal_id").notNull(), // stringified internal PK (ids vary int/uuid across domains)
    externalId: text("external_id").notNull(),
    // Minimal, non-sensitive provider-side reference detail only — never a
    // full raw payload (that lives in integrationInbox for audit).
    externalRef: jsonb("external_ref"),

    syncCursor: text("sync_cursor"),
    lastSyncedAt: timestamp("last_synced_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    // Both directions unique per connection+entityType: a second attempt to
    // map an already-mapped internal record, or an already-mapped external
    // id, to something else hits this constraint rather than silently
    // overwriting — the DB-level half of Section 14's "ambiguous mapping ->
    // manual review" scenario (mapping.ts's own service layer is the other half).
    internalIdx: uniqueIndex("integration_external_mappings_internal_idx").on(table.connectionId, table.entityType, table.internalId),
    externalIdx: uniqueIndex("integration_external_mappings_external_idx").on(table.connectionId, table.entityType, table.externalId),
  }),
);

// ---------------------------------------------------------------------
// Dead-letter + controlled replay (Section 7).
// ---------------------------------------------------------------------

export const integrationDeadLetters = pgTable(
  "integration_dead_letters",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    connectionId: uuid("connection_id").notNull().references(() => integrationConnections.id),

    sourceType: text("source_type").notNull(), // OUTBOX | INBOX
    sourceId: text("source_id").notNull(), // integrationOutbox.id or integrationInbox.id, as text
    reason: text("reason").notNull(),
    payloadSnapshot: jsonb("payload_snapshot").notNull(),

    occurredAt: timestamp("occurred_at").notNull().defaultNow(),

    // Replay requires explicit authority (Brokerage Administrator — route-
    // gated, see routes/integrations.ts) and re-enters the EXACT SAME code
    // path the original attempt used (deadLetters.ts's own module comment)
    // — never a shortcut.
    replayedAt: timestamp("replayed_at"),
    replayedBy: integer("replayed_by").references(() => users.id),
    replayResult: text("replay_result"), // SUCCESS | FAILED
    replayError: text("replay_error"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    brokerageOccurredIdx: index("integration_dead_letters_brokerage_occurred_idx").on(table.brokerageId, table.occurredAt),
    connectionIdx: index("integration_dead_letters_connection_idx").on(table.connectionId),
  }),
);

// ---------------------------------------------------------------------
// Credential-REFERENCE boundary (Section 4/18): this table is schema-
// enforced to be incapable of holding a real secret. There is no "value"
// column of any kind — only an opaque secretIdentifier string and a
// referenceType. This build's own auth flow (credentials.ts) only ever
// mints referenceType "MOCK_AUTH_FLOW" identifiers shaped like
// "mock-secret-ref:<uuid>" — never anything that looks like or could be
// mistaken for a real API key/token/password (a dedicated test asserts this).
// ---------------------------------------------------------------------

export const INTEGRATION_CREDENTIAL_REFERENCE_TYPES = ["MOCK_AUTH_FLOW", "SECRET_MANAGER_REFERENCE"] as const;
export type IntegrationCredentialReferenceType = (typeof INTEGRATION_CREDENTIAL_REFERENCE_TYPES)[number];

export const integrationCredentials = pgTable(
  "integration_credentials",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    connectionId: uuid("connection_id").notNull().references(() => integrationConnections.id).unique(),

    referenceType: text("reference_type").notNull(),
    // An OPAQUE pointer only — e.g. "mock-secret-ref:<uuid>" in this build,
    // or (a later, real step) a secrets-manager path/ARN. Never parseable
    // back into a credential value; never logged in full outside this table.
    secretIdentifier: text("secret_identifier").notNull(),
    status: text("status").notNull().default("ACTIVE"), // ACTIVE | ROTATED | REVOKED

    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: integer("created_by").references(() => users.id),
    revokedAt: timestamp("revoked_at"),
    revokedBy: integer("revoked_by").references(() => users.id),
  },
);

// ---------------------------------------------------------------------
// Per-brokerage configuration (Section 4: "brokerage enablement" is one of
// the mandatory preconditions before any connection can be used). Created
// lazily on first read — see apps/api/src/lib/integrations/settings.ts,
// which follows the exact getOrCreateXSettings(brokerageId) convention
// lib/communications/settings.ts already established for this codebase's
// real "configuration engine" (a repeated per-domain pattern rather than
// one unified class — documented in Section 2's verification note).
// ---------------------------------------------------------------------

export const integrationSettings = pgTable("integration_settings", {
  id: serial("id").primaryKey(),
  brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id).unique(),

  // Master switch — checked before anything else in registry.ts's
  // resolveActiveConnection. A brokerage that has never explicitly turned
  // integrations on cannot use one no matter how many ACTIVE connections
  // it has (fail-closed default: false).
  enabled: boolean("enabled").notNull().default(false),
  maxActiveConnections: integer("max_active_connections").notNull().default(10),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertIntegrationProviderSchema = createInsertSchema(integrationProviders).omit({ createdAt: true, updatedAt: true });
export const insertIntegrationConnectionSchema = createInsertSchema(integrationConnections).omit({ id: true, createdAt: true, updatedAt: true });
export const insertIntegrationOutboxSchema = createInsertSchema(integrationOutbox).omit({ id: true, createdAt: true, updatedAt: true });
export const insertIntegrationInboxSchema = createInsertSchema(integrationInbox).omit({ id: true });

export type InsertIntegrationProvider = z.infer<typeof insertIntegrationProviderSchema>;
export type InsertIntegrationConnection = z.infer<typeof insertIntegrationConnectionSchema>;
export type InsertIntegrationOutbox = z.infer<typeof insertIntegrationOutboxSchema>;
export type InsertIntegrationInbox = z.infer<typeof insertIntegrationInboxSchema>;

export type IntegrationProvider = typeof integrationProviders.$inferSelect;
export type IntegrationConnection = typeof integrationConnections.$inferSelect;
export type IntegrationConnectionTransition = typeof integrationConnectionTransitions.$inferSelect;
export type IntegrationOutboxRow = typeof integrationOutbox.$inferSelect;
export type IntegrationOutboxAttempt = typeof integrationOutboxAttempts.$inferSelect;
export type IntegrationInboxRow = typeof integrationInbox.$inferSelect;
export type IntegrationExternalMapping = typeof integrationExternalMappings.$inferSelect;
export type IntegrationDeadLetter = typeof integrationDeadLetters.$inferSelect;
export type IntegrationCredential = typeof integrationCredentials.$inferSelect;
export type IntegrationSettings = typeof integrationSettings.$inferSelect;
