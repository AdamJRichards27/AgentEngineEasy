import { pgTable, integer, text, boolean, jsonb, timestamp, uuid, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { brokerages, users } from "./users";
import { properties } from "./property";
import { transactions } from "./transaction";

// Agent Engine 2.0 — Exception & Risk Engine (Priority 4).
//
// This is the authoritative record type for "what is not happening that
// should be happening" — deterministic risk detection, never a second
// workflow engine. It is deliberately a NEW table, not an extension of
// automation_attention_items (packages/db/src/schema/automation.ts):
// automationAttentionItems is documented on that table itself as "Stage
// 2's minimal, compatible interface onto the future Exception & Risk
// Engine ... not the full exception-routing/escalation/ownership system a
// real Exception & Risk Engine would eventually own" and explicitly names
// the two integration points this build honours instead of duplicating:
// (1) publish the EXCEPTION_CREATED/EXCEPTION_RESOLVED domain events that
// packages/events/src/types.ts already reserves with zero publishers, and
// (2) read/absorb automation_attention_items as one INPUT signal among
// several (see apps/api/src/lib/exceptions/rules/workflowOperational.ts)
// rather than replacing it — existing RAISE_ATTENTION_ITEM call sites in
// the WAE action registry are untouched by this migration.
export const RISK_EXCEPTION_SEVERITIES = ["INFORMATION", "ATTENTION", "AT_RISK", "CRITICAL"] as const;
export type RiskExceptionSeverity = (typeof RISK_EXCEPTION_SEVERITIES)[number];

// OPEN -> ACKNOWLEDGED -> IN_PROGRESS -> RESOLVED is the common path;
// AWAITING_EXTERNAL and REOPENED are visited as needed. DISMISSED is a
// terminal alternative to RESOLVED, only reachable when the rule that
// raised the exception marked it dismissible (see riskExceptions.dismissible
// below) — never for a mandatory compliance/safety rule.
export const RISK_EXCEPTION_STATUSES = [
  "OPEN",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "AWAITING_EXTERNAL",
  "RESOLVED",
  "DISMISSED",
  "REOPENED",
] as const;
export type RiskExceptionStatus = (typeof RISK_EXCEPTION_STATUSES)[number];

// Statuses that count as "the underlying problem is still open" for
// deduplication purposes (Build Instructions §11). REOPENED is included —
// a reopened exception is still an open occurrence of the same problem.
export const OPEN_RISK_EXCEPTION_STATUSES: RiskExceptionStatus[] = [
  "OPEN",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "AWAITING_EXTERNAL",
  "REOPENED",
];

export const RISK_EXCEPTION_CATEGORIES = [
  "APPRAISAL_AGREEMENT",
  "LISTING",
  "OFFERS",
  "CONTRACT_CONDITIONS",
  "AML_CTF",
  "SETTLEMENT_CLOSURE",
  "WORKFLOW_OPERATIONAL",
  // Agent Engine 2.0 — Property Launch & Campaign Coordination. No existing
  // category cleanly means "launch/campaign readiness" — LISTING is
  // specifically the live-listing record's own fields (see rules/listing.ts),
  // WORKFLOW_OPERATIONAL is stalled-automation signals. Additive: this
  // column is `text`, not a Postgres enum (see riskExceptions below), so
  // adding a value here is a one-line, non-breaking change — no migration
  // required for this column itself.
  "LAUNCH_CAMPAIGN",
] as const;
export type RiskExceptionCategory = (typeof RISK_EXCEPTION_CATEGORIES)[number];

// Mapped onto this app's actual 3-role model (users.ts's USER_ROLES —
// deliberately small, Build Brief §22) rather than inventing "compliance"/
// "operations" roles the merged baseline does not have. PIT_CREW is kept
// in the vocabulary for forward-compatibility (Build Instructions §12
// names it explicitly) but the initial rule catalogue never assigns it —
// see docs/exception-risk-engine/ARCHITECTURE.md's "deferred" section: Pit
// Crew ownership requires a service-assignment record this baseline does
// not have.
export const RISK_EXCEPTION_OWNER_TYPES = [
  "LISTING_AGENT",
  "TRANSACTION_OWNER",
  "BROKERAGE_ADMINISTRATOR",
  "PIT_CREW",
  "UNASSIGNED_QUEUE",
] as const;
export type RiskExceptionOwnerType = (typeof RISK_EXCEPTION_OWNER_TYPES)[number];

// One row per detected risk. Dedup key + isOpenOccurrence together enforce
// "never more than one OPEN-family exception per (rule, source record)" as
// a real database constraint, not just an app-layer read-then-write check
// (Build Instructions §23: "concurrency-safe creation ... no duplicate
// exceptions under concurrent evaluation").
//
// The mechanism: openDedupKey equals dedupKey while the row is in an
// OPEN_RISK_EXCEPTION_STATUSES status, and is rewritten to
// `${dedupKey}:closed:${id}` (always unique — id is a uuid) the moment the
// row is RESOLVED or DISMISSED. A unique index on openDedupKey then means
// at most one row can ever hold the "live" key at a time, while every
// historical resolved/dismissed occurrence keeps its own distinct value
// and is never deleted (Build Instructions §7: "history must remain
// immutable and auditable — never delete resolved/dismissed exceptions").
// Writers still take a Postgres advisory transaction lock keyed on the
// dedup key before the read-check-write (see
// apps/api/src/lib/exceptions/model.ts's withDedupLock) so two concurrent
// evaluations can never both pass the SELECT before either INSERTs — the
// unique index is the backstop, the advisory lock is what avoids a 500 on
// the losing side of a race.
export const riskExceptions = pgTable(
  "risk_exceptions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    transactionId: integer("transaction_id").references(() => transactions.id),

    ruleId: text("rule_id").notNull(),
    ruleVersion: integer("rule_version").notNull().default(1),
    category: text("category").notNull(),
    severity: text("severity").notNull(),

    title: text("title").notNull(),
    problemDescription: text("problem_description").notNull(),
    businessImpact: text("business_impact").notNull(),
    detectedCause: text("detected_cause").notNull(),

    ownerType: text("owner_type").notNull().default("UNASSIGNED_QUEUE"),
    ownerUserId: integer("owner_user_id").references(() => users.id),
    // Immutable history of who has owned this exception and why they were
    // (re)assigned — Build Instructions §12: "preserve assignment history".
    // Individual entries also live in riskExceptionTransitions below; this
    // column is a denormalised "how many times has ownership moved"
    // convenience, not a second source of truth.
    reassignmentCount: integer("reassignment_count").notNull().default(0),

    detectedAt: timestamp("detected_at").notNull().defaultNow(),
    dueAt: timestamp("due_at"),
    escalatesAt: timestamp("escalates_at"),

    status: text("status").notNull().default("OPEN"),

    recommendedAction: text("recommended_action").notNull(),
    resolutionRequirements: text("resolution_requirements").notNull(),
    // Whether the rule that raised this exception permits manual dismissal
    // (Build Instructions §7/§14) — snapshotted at creation time from the
    // rule registry so a later rule-catalogue edit can never retroactively
    // change what an already-open exception permits.
    dismissible: boolean("dismissible").notNull().default(false),

    // Evidence recorded at resolution — either an auto-resolution snapshot
    // (which authoritative field/record proved the issue gone) or a manual
    // resolution's supporting evidence. Never free-form: always one of the
    // shapes documented in apps/api/src/lib/exceptions/types.ts's
    // ResolutionEvidence union.
    resolutionEvidence: jsonb("resolution_evidence"),
    resolvedAt: timestamp("resolved_at"),
    resolvedByUserId: integer("resolved_by_user_id").references(() => users.id),
    resolutionMethod: text("resolution_method"), // AUTO | MANUAL
    dismissalReason: text("dismissal_reason"),

    // Traceability (Build Instructions §5, §22).
    sourceRecordType: text("source_record_type").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    causationId: uuid("causation_id"),
    relatedTaskIds: jsonb("related_task_ids").notNull().default(sql`'[]'::jsonb`), // string[] (automationTasks.id)
    relatedExecutionIds: jsonb("related_execution_ids").notNull().default(sql`'[]'::jsonb`), // string[] (automationExecutions.id)

    // Deduplication / recurrence (Build Instructions §11).
    dedupKey: text("dedup_key").notNull(),
    openDedupKey: text("open_dedup_key").notNull(),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    lastDetectedAt: timestamp("last_detected_at").notNull().defaultNow(),
    lastEvaluatedAt: timestamp("last_evaluated_at").notNull().defaultNow(),
    // Set when a resolved/dismissed exception's condition recurred and a
    // fresh linked occurrence was created rather than reopening the same
    // row (rule-dependent — see types.ts's RECURRENCE_MODE per rule).
    previousOccurrenceId: uuid("previous_occurrence_id"),

    // Allow-listed only (Build Instructions §5: "Do NOT store unrestricted
    // rule payloads or sensitive domain data in generic metadata fields") —
    // apps/api/src/lib/exceptions/model.ts's sanitizeMetadata() strips any
    // key not in METADATA_ALLOW_LIST before this column is ever written.
    metadata: jsonb("metadata"),

    // Financial/commission-related exceptions must stay hidden from a
    // non-Brokerage-Administrator viewer even though the row itself is
    // tenant-visible (Build Instructions §20/§21) — mirrors timeline.ts's
    // canViewFinancials boundary rather than inventing a second one.
    requiresFinancialEntitlement: boolean("requires_financial_entitlement").notNull().default(false),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    openDedupKeyIdx: uniqueIndex("risk_exceptions_open_dedup_key_idx").on(table.openDedupKey),
    brokerageStatusIdx: index("risk_exceptions_brokerage_status_idx").on(table.brokerageId, table.status),
    propertyStatusIdx: index("risk_exceptions_property_status_idx").on(table.propertyId, table.status),
    transactionStatusIdx: index("risk_exceptions_transaction_status_idx").on(table.transactionId, table.status),
    brokerageSeverityIdx: index("risk_exceptions_brokerage_severity_idx").on(table.brokerageId, table.severity, table.status),
    dueAtIdx: index("risk_exceptions_due_at_idx").on(table.dueAt),
  }),
);

// Append-only lifecycle ledger — every status transition, severity change,
// and ownership change, immutable and auditable (Build Instructions §7,
// §15: "preserve severity history", §22: audit events for the full
// lifecycle). This is what both GET /exceptions/:id's history view and the
// Property Timeline integration read from; nothing here is ever updated or
// deleted once written.
export const riskExceptionTransitions = pgTable(
  "risk_exception_transitions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    exceptionId: uuid("exception_id").notNull().references(() => riskExceptions.id),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),

    transitionType: text("transition_type").notNull(),
    // OPENED | SEVERITY_CHANGED | OWNER_ASSIGNED | ACKNOWLEDGED |
    // REMEDIATION_STARTED | AWAITING_EXTERNAL | RESOLUTION_ATTEMPTED |
    // RESOLVED | DISMISSED | REOPENED | ESCALATED | EVALUATION_FAILED

    fromValue: text("from_value"),
    toValue: text("to_value"),
    reason: text("reason"),

    actorType: text("actor_type").notNull(), // SYSTEM | USER
    actorUserId: integer("actor_user_id").references(() => users.id),

    ruleVersion: integer("rule_version"),
    metadata: jsonb("metadata"),

    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  },
  (table) => ({
    exceptionOccurredIdx: index("risk_exception_transitions_exception_occurred_idx").on(table.exceptionId, table.occurredAt),
    brokerageOccurredIdx: index("risk_exception_transitions_brokerage_occurred_idx").on(table.brokerageId, table.occurredAt),
  }),
);

// One row per time-driven scan attempt (Build Instructions §9: "restart-
// safe, idempotent, observable"; §22: "scheduled scan completed" audit
// event; §23: "stale-evaluation observability"). This is deliberately a
// durable table, not just a log line — GET /exceptions/ops/health (mirrors
// automationOps.ts's GET /automation/ops/health) reads the most recent
// rows here to answer "is scheduled evaluation actually running".
export const riskExceptionScanRuns = pgTable("risk_exception_scan_runs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  status: text("status").notNull().default("RUNNING"), // RUNNING | COMPLETED | FAILED
  trigger: text("trigger").notNull().default("SCHEDULED"), // SCHEDULED | MANUAL
  brokeragesScanned: integer("brokerages_scanned").notNull().default(0),
  rulesEvaluated: integer("rules_evaluated").notNull().default(0),
  exceptionsCreated: integer("exceptions_created").notNull().default(0),
  exceptionsUpdated: integer("exceptions_updated").notNull().default(0),
  exceptionsAutoResolved: integer("exceptions_auto_resolved").notNull().default(0),
  errorMessage: text("error_message"),
});

export const insertRiskExceptionSchema = createInsertSchema(riskExceptions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertRiskExceptionTransitionSchema = createInsertSchema(riskExceptionTransitions).omit({ id: true });

export type InsertRiskException = z.infer<typeof insertRiskExceptionSchema>;
export type InsertRiskExceptionTransition = z.infer<typeof insertRiskExceptionTransitionSchema>;
export type RiskException = typeof riskExceptions.$inferSelect;
export type RiskExceptionTransition = typeof riskExceptionTransitions.$inferSelect;
export type RiskExceptionScanRun = typeof riskExceptionScanRuns.$inferSelect;
