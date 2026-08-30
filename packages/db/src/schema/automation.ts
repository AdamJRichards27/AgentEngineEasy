import { pgTable, serial, integer, text, boolean, jsonb, timestamp, uuid, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { brokerages, users } from "./users";
import { properties } from "./property";
import { transactions } from "./transaction";
import { domainEvents } from "./events";
import { aiActionRequests } from "./ai";

// Agent Engine 2.0 — Workflow Automation Engine (Stage 2: core persistence
// foundation). Named "AutomationRule"/"AutomationRuleVersion"/
// "AutomationExecution"/"AutomationAction" — deliberately NOT "Workflow" — to
// avoid the confirmed naming collision with the existing, unrelated
// per-property checklist engine in ./workflow.ts (see
// docs/stage-wf/WF1_DISCOVERY.md §2). This is business-critical infrastructure:
// every table here is tenant-scoped, versioned, and append-only where the
// spec requires an immutable audit trail (Build Instructions §"Idempotency
// and safe retries", §"Complete auditability").

// A stable, named automation rule container for one brokerage. The rule
// itself never carries executable logic — that lives in a versioned
// AutomationRuleVersion row (§ below) so an in-flight execution can always be
// traced back to the exact WHEN/IF/THEN it ran against, even if the rule is
// edited later. Mirrors the DRAFT→...→ARCHIVED versioning shape already
// proven by workflowChangeProposals (./workflow.ts).
export const automationRules = pgTable("automation_rules", {
  id: serial("id").primaryKey(),
  brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),

  name: text("name").notNull(),
  description: text("description"),

  // The canonical AgentEngineEasyEventType (packages/events) this rule
  // listens for. Validated against EVENT_TYPE_REGISTRY at the service layer,
  // not enforced as a DB constraint (the registry can grow without a
  // migration).
  triggerEventType: text("trigger_event_type").notNull(),

  // DRAFT: no version has ever been activated for this rule.
  // ACTIVE: the rule has a currently-active version and will evaluate on
  //         matching events.
  // PAUSED: the rule has an active version but is temporarily not evaluated
  //         (does not delete or supersede the version).
  // ARCHIVED: retired; never evaluated again.
  status: text("status").notNull().default("DRAFT"), // DRAFT | ACTIVE | PAUSED | ARCHIVED

  // Stage 6 templates (Agency Agreement Signed, Offer Accepted, Settlement
  // Completed, Task Overdue) are created with isSystemTemplate = true so the
  // management UI can label them distinctly. They are still ordinary,
  // single-brokerage rows — this build does not implement cross-tenant
  // workflow sharing or a public marketplace (explicitly out of scope,
  // Build Instructions §"Scope exclusions").
  isSystemTemplate: boolean("is_system_template").notNull().default(false),
  templateKey: text("template_key"), // e.g. "AGENCY_AGREEMENT_SIGNED"; null for tenant-authored rules

  createdByUserId: integer("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// One versioned body of WHEN/IF/THEN logic for a rule. Executions bind to a
// specific ruleVersionId, never to the mutable "current" rule, so editing a
// rule can never silently rewrite the definition an in-flight or historical
// execution ran against (Build Instructions: "must never silently rewrite
// historical definitions used by earlier executions").
export const automationRuleVersions = pgTable(
  "automation_rule_versions",
  {
    id: serial("id").primaryKey(),
    ruleId: integer("rule_id").notNull().references(() => automationRules.id),
    version: integer("version").notNull(),

    // DRAFT | PROPOSED | APPROVED | ACTIVE | SUPERSEDED | ARCHIVED — mirrors
    // workflowChangeProposals's lifecycle. Only one version per rule may be
    // ACTIVE at a time; enforced at the service layer (activation is a
    // transaction: supersede the previous ACTIVE version, then activate this
    // one).
    status: text("status").notNull().default("DRAFT"),

    // Deterministic condition tree: { operator: "ALL" | "ANY", conditions: [...] }.
    // Field/operator vocabulary is validated against the Stage 3 field/
    // operator registry at write time — this column stores the already-
    // validated tree, not free-form user input.
    conditionGroup: jsonb("condition_group").notNull(),

    // Ordered list of { actionKey, params } referencing the Stage 4 Action
    // Registry. Never executable code — every actionKey must resolve to a
    // registered action or publication is rejected.
    actions: jsonb("actions").notNull(),

    createdByUserId: integer("created_by_user_id").references(() => users.id),
    // Build Instructions §"AI boundaries": "All AI-generated workflow
    // suggestions must enter as drafts and be reviewed before activation."
    // This flag lets the activation path enforce that an AI-authored version
    // can never self-activate.
    createdByAi: boolean("created_by_ai").notNull().default(false),
    changeReason: text("change_reason"),

    approvedByUserId: integer("approved_by_user_id").references(() => users.id),
    approvedAt: timestamp("approved_at"),
    activatedAt: timestamp("activated_at"),
    supersededAt: timestamp("superseded_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    ruleVersionUniqueIdx: uniqueIndex("automation_rule_versions_rule_version_idx").on(
      table.ruleId,
      table.version,
    ),
  }),
);

// One run of one rule version, triggered by one domain event. This is the
// idempotency boundary the spec requires ("never permit duplicate event
// delivery to cause duplicate consequential actions"): the unique index on
// (ruleVersionId, triggeringEventId) means the same event can never create
// more than one execution against the same rule version, no matter how many
// times delivery is retried.
export const automationExecutions = pgTable(
  "automation_executions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),

    ruleId: integer("rule_id").notNull().references(() => automationRules.id),
    ruleVersionId: integer("rule_version_id").notNull().references(() => automationRuleVersions.id),

    triggeringEventId: uuid("triggering_event_id").notNull().references(() => domainEvents.id),
    // Carried from the triggering event so a chain of workflow-triggered
    // events/executions can be traced end to end, and so the Stage 5 worker
    // can enforce a maximum causation depth (recursion protection).
    correlationId: uuid("correlation_id").notNull(),
    causationDepth: integer("causation_depth").notNull().default(0),

    // Pending | Evaluating | Skipped | Awaiting approval | Running |
    // Partially completed | Completed | Failed | Blocked | Cancelled — the
    // spec's 10 execution states verbatim. "Do not report a workflow as
    // completed if a required action failed or remains unresolved": COMPLETED
    // is only ever set once every action's terminal state has been checked.
    status: text("status").notNull().default("PENDING"),
    // PENDING | EVALUATING | SKIPPED | AWAITING_APPROVAL | RUNNING |
    // PARTIALLY_COMPLETED | COMPLETED | FAILED | BLOCKED | CANCELLED

    // Snapshot of the evaluated condition tree (which branches matched, on
    // what field values) for audit, independent of the live data those
    // fields came from.
    conditionResult: jsonb("condition_result"),

    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    errorMessage: text("error_message"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    idempotencyIdx: uniqueIndex("automation_executions_rule_version_event_idx").on(
      table.ruleVersionId,
      table.triggeringEventId,
    ),
  }),
);

// One action attempt within an execution. Ordering within the execution is
// enforced by the (executionId, sequence) unique index, and retries reuse
// the same row (attemptCount increments) rather than inserting a new one, so
// a retried action can never appear to have run twice.
export const automationActions = pgTable(
  "automation_actions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    executionId: uuid("execution_id").notNull().references(() => automationExecutions.id),
    sequence: integer("sequence").notNull(),

    actionKey: text("action_key").notNull(),
    params: jsonb("params").notNull(),

    // The Stage 4 central authority decision for this action, produced by
    // the existing AI Governance policyEngine.evaluateAIAction() —
    // ALLOW | ALLOW_WITH_APPROVAL | DENY | BLOCK_MISSING_CONTEXT |
    // BLOCK_MISSING_ENTITLEMENT | BLOCK_POLICY_CONFLICT. Null until
    // evaluated. This table never makes its own authority decision.
    authorityDecision: text("authority_decision"),

    // Pending | Skipped | Awaiting approval | Approved | Rejected | Running |
    // Succeeded | Failed | Blocked | Compensated — the spec's 10 action
    // states verbatim.
    status: text("status").notNull().default("PENDING"),

    // When authorityDecision is ALLOW_WITH_APPROVAL, this action's human
    // approval is delegated to the existing AI Governance approval flow
    // (aiActionRequests) rather than a second, parallel approval mechanism.
    aiActionRequestId: integer("ai_action_request_id").references(() => aiActionRequests.id),

    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),

    result: jsonb("result"),
    errorMessage: text("error_message"),

    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    executionSequenceIdx: uniqueIndex("automation_actions_execution_sequence_idx").on(
      table.executionId,
      table.sequence,
    ),
  }),
);

// The outbox-consumer worker's claim/idempotent-processing ledger. Distinct
// from domainEvents.processingStatus (which only ever reflects the
// publisher's own synchronous, best-effort dispatch attempt, see
// docs/stage-wf/WF1_DISCOVERY.md §1): this table is what makes delivery to
// the automation engine specifically reliable and retryable, independent of
// whatever else is listening on the same event. The unique index on
// (eventId, handlerName) is the outbox idempotency guarantee — no matter how
// many times an event is picked up, at most one receipt row exists per
// (event, handler).
export const eventProcessingReceipts = pgTable(
  "event_processing_receipts",
  {
    id: serial("id").primaryKey(),
    eventId: uuid("event_id").notNull().references(() => domainEvents.id),
    handlerName: text("handler_name").notNull(), // e.g. "automation-engine"

    status: text("status").notNull().default("PENDING"), // PENDING | PROCESSING | PROCESSED | FAILED | DEAD_LETTER
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastError: text("last_error"),

    // Set when a worker claims this receipt; used to detect and recover a
    // stale claim from a worker that crashed mid-processing.
    claimedAt: timestamp("claimed_at"),
    processedAt: timestamp("processed_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    eventHandlerUniqueIdx: uniqueIndex("event_processing_receipts_event_handler_idx").on(
      table.eventId,
      table.handlerName,
    ),
  }),
);

// ---------------------------------------------------------------------
// Agent Engine 2.0 — WAE Stage 2: Controlled Production Workflows.
//
// Two new tables backing the six-action Stage 2 registry (CREATE_INTERNAL_TASK,
// CREATE_REMINDER, ASSIGN_TASK_OWNER, PROPERTY_NOTE_ADD [reused],
// RAISE_ATTENTION_ITEM, REQUEST_ACTION_APPROVAL — see
// apps/api/src/lib/ai/actions/registry.ts). Both are deliberately NEW tables,
// not additions to the pre-existing ./workflow.ts workflows/workflowSteps —
// that table is a fixed, wholesale-recomputed-from-live-state checklist
// (apps/api/src/lib/workflowSteps.ts's refreshReadyToListSteps /
// refreshTransactionSteps overwrite its rows entirely on every call) and
// inserting dynamic, workflow-generated rows into it would both risk
// corrupting that recompute and repeat the exact "Workflow" naming collision
// this package's automation_* tables were named to avoid in the first place
// (see the module comment above and docs/stage-wf/WF1_DISCOVERY.md §2).
// ---------------------------------------------------------------------

// automation_tasks — the durable record behind CREATE_INTERNAL_TASK and
// CREATE_REMINDER (kind distinguishes the two; a reminder is simply a task
// with an authoritative dueAt). Rows are never deleted or overwritten in
// place: a workflow re-run whose underlying date/content materially changed
// (e.g. a settlement reschedule) SUPERSEDES the prior ACTIVE row and inserts
// a fresh one, so the superseded instance survives as historical evidence
// (Build Instructions §6, "retain evidence of superseded dates/tasks rather
// than silently overwriting history").
export const automationTasks = pgTable(
  "automation_tasks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    transactionId: integer("transaction_id").references(() => transactions.id),

    // Closed vocabulary — AUTOMATION_TASK_KEYS
    // (apps/api/src/lib/automation/types.ts). Never a free-form string a
    // rule author could invent; CREATE_INTERNAL_TASK/CREATE_REMINDER's zod
    // inputSchema validates against exactly this list before a row is ever
    // written here.
    taskKey: text("task_key").notNull(),
    kind: text("kind").notNull().default("TASK"), // TASK | REMINDER
    title: text("title").notNull(),
    detail: text("detail"),

    // One of USER_ROLES (packages/db/src/schema/users.ts), or null =
    // unassigned. Re-assignable at any time via ASSIGN_TASK_OWNER.
    assignedRole: text("assigned_role"),
    dueAt: timestamp("due_at"),

    // ACTIVE | COMPLETED | SUPERSEDED | CANCELLED.
    status: text("status").notNull().default("ACTIVE"),
    supersededByTaskId: uuid("superseded_by_task_id"),

    // Traceability back to exactly what created this row (component:
    // "traceable through correlation/causation identifiers", "preserve the
    // originating event and field"). originatingExecutionId is populated
    // only when the caller has a concrete execution id available directly
    // (e.g. a future admin/back-fill path) — the templated action-params
    // path (resolveActionParams, ./automation's templating.ts) cannot supply
    // it, because the automation_executions row is only assigned an id
    // AFTER the engine has already built the event facts an action's params
    // are resolved against; for a workflow-created row the authoritative
    // trace is instead automationActions.result.taskId (this row's id) ->
    // automationActions.executionId -> automationExecutions, which is a
    // complete, genuine chain without needing a direct FK here.
    originatingEventId: uuid("originating_event_id").references(() => domainEvents.id),
    originatingExecutionId: uuid("originating_execution_id").references(() => automationExecutions.id),
    // The specific event field this row's dueAt/content was derived from,
    // e.g. "payload.settlementDate" — component: "preserve the originating
    // event and field".
    originatingField: text("originating_field"),

    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    // Query-performance index for the (transaction, taskKey, status) lookup
    // createAutomationTask/assignAutomationTaskToRole perform on every call
    // — deliberately NOT a unique constraint: idempotency and the
    // supersede-on-material-change decision are business logic evaluated in
    // apps/api/src/lib/automation/tasks.ts (read-then-write), the same
    // established convention every other domain service in this codebase
    // already uses for business-rule idempotency (see acceptOffer's
        // sibling-offer handling, scheduleSettlement's reschedule handling) —
    // duplicate-EVENT-delivery protection (the security-relevant idempotency
    // boundary) is already fully owned by automation_executions/
    // event_processing_receipts above, not by this table.
    transactionTaskKeyIdx: index("automation_tasks_transaction_task_key_idx").on(
      table.transactionId,
      table.taskKey,
      table.status,
    ),
    propertyTaskKeyIdx: index("automation_tasks_property_task_key_idx").on(
      table.propertyId,
      table.taskKey,
      table.status,
    ),
  }),
);

// automation_attention_items — Stage 2's minimal, compatible interface onto
// the future Exception & Risk Engine (EXCEPTION_CREATED/EXCEPTION_RESOLVED,
// packages/events/src/types.ts, zero call sites before this change). This
// table is deliberately narrow: it records that a workflow could not
// proceed and why, in a durable, auditable, tenant-scoped place, without
// building the full exception-routing/escalation/ownership system the
// future Exception & Risk Engine is expected to own (Build Instructions §7:
// "use the smallest compatible interface and document the future
// integration point" — see docs/stage-wf/WF3_STAGE2_CONTROLLED_WORKFLOWS.md).
export const automationAttentionItems = pgTable(
  "automation_attention_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    transactionId: integer("transaction_id").references(() => transactions.id),

    // Closed vocabulary — AUTOMATION_ATTENTION_REASON_CODES
    // (apps/api/src/lib/automation/types.ts).
    reasonCode: text("reason_code").notNull(),
    summary: text("summary").notNull(),
    detail: jsonb("detail"),

    status: text("status").notNull().default("OPEN"), // OPEN | RESOLVED
    resolvedByUserId: integer("resolved_by_user_id").references(() => users.id),
    resolvedAt: timestamp("resolved_at"),
    resolutionNote: text("resolution_note"),

    originatingEventId: uuid("originating_event_id").references(() => domainEvents.id),
    originatingExecutionId: uuid("originating_execution_id").references(() => automationExecutions.id),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    // Same "index, not unique constraint" reasoning as automation_tasks
    // above — raiseAttentionItem() (apps/api/src/lib/automation/attentionItems.ts)
    // reads-then-writes to avoid re-raising a fresh row for an
    // already-OPEN condition of the same reasonCode.
    transactionReasonIdx: index("automation_attention_items_transaction_reason_idx").on(
      table.transactionId,
      table.reasonCode,
      table.status,
    ),
    propertyReasonIdx: index("automation_attention_items_property_reason_idx").on(
      table.propertyId,
      table.reasonCode,
      table.status,
    ),
  }),
);

export const insertAutomationRuleSchema = createInsertSchema(automationRules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertAutomationRuleVersionSchema = createInsertSchema(automationRuleVersions).omit({
  id: true,
  createdAt: true,
});
export const insertAutomationExecutionSchema = createInsertSchema(automationExecutions).omit({
  id: true,
  createdAt: true,
});
export const insertAutomationActionSchema = createInsertSchema(automationActions).omit({
  id: true,
  createdAt: true,
});
export const insertAutomationTaskSchema = createInsertSchema(automationTasks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertAutomationAttentionItemSchema = createInsertSchema(automationAttentionItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAutomationRule = z.infer<typeof insertAutomationRuleSchema>;
export type InsertAutomationRuleVersion = z.infer<typeof insertAutomationRuleVersionSchema>;
export type InsertAutomationExecution = z.infer<typeof insertAutomationExecutionSchema>;
export type InsertAutomationAction = z.infer<typeof insertAutomationActionSchema>;
export type InsertAutomationTask = z.infer<typeof insertAutomationTaskSchema>;
export type InsertAutomationAttentionItem = z.infer<typeof insertAutomationAttentionItemSchema>;

export type AutomationRule = typeof automationRules.$inferSelect;
export type AutomationRuleVersion = typeof automationRuleVersions.$inferSelect;
export type AutomationExecution = typeof automationExecutions.$inferSelect;
export type AutomationAction = typeof automationActions.$inferSelect;
export type EventProcessingReceipt = typeof eventProcessingReceipts.$inferSelect;
export type AutomationTask = typeof automationTasks.$inferSelect;
export type AutomationAttentionItem = typeof automationAttentionItems.$inferSelect;
