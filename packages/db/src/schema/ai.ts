import { pgTable, serial, integer, text, boolean, timestamp, jsonb, numeric, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { brokerages, users } from "./users";

// Contextual AI Architecture — see ARCHITECTURE.md "Phase 9: Contextual AI
// Architecture" for the full design. These five tables are deliberately minimal:
// they reference existing users/brokerages by id rather than duplicating any
// business data, matching every other domain schema file in this package.

// One row per brokerage is an override of the env-var defaults (AI_PROVIDER etc,
// see .env.example); a null brokerageId row is reserved for a future platform-wide
// default and is not required for the app to function. Absence of a row for a
// brokerage just means "use the env defaults" (see services/ai/gateway.ts).
export const aiConfigurations = pgTable("ai_configurations", {
  id: serial("id").primaryKey(),
  brokerageId: integer("brokerage_id").references(() => brokerages.id),
  provider: text("provider").notNull().default("mock"),
  model: text("model"),
  temperature: numeric("temperature"),
  maxOutputTokens: integer("max_output_tokens"),
  timeoutMs: integer("timeout_ms"),
  retryLimit: integer("retry_limit"),
  fallbackProvider: text("fallback_provider"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Centralized prompt management (Build Instructions §"Prompt Management") — every
// prompt sent to a provider is built from a named, versioned template here rather
// than an inline string scattered through route/service code.
export const aiPromptVersions = pgTable("ai_prompt_versions", {
  id: serial("id").primaryKey(),
  key: text("key").notNull(),
  version: integer("version").notNull(),
  template: text("template").notNull(),
  defaultRiskLevel: integer("default_risk_level").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// One row per AI request/response, the spine of the AI Audit Layer. Every call
// that reaches services/ai/orchestrator.ts writes exactly one row here — including
// requests blocked by permissions, entitlements, or feature flags before any
// provider call is made — mirroring lib/audit.ts's "log everything, fire and
// forget" convention.
export const aiInteractions = pgTable("ai_interactions", {
  id: serial("id").primaryKey(),
  requestId: text("request_id").notNull().unique(),
  brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
  userId: integer("user_id").notNull().references(() => users.id),
  aiRole: text("ai_role").notNull(),
  contextType: text("context_type"),
  contextId: integer("context_id"),
  promptKey: text("prompt_key"),
  promptVersion: integer("prompt_version"),
  question: text("question"),
  responseKind: text("response_kind"),
  riskLevel: integer("risk_level").notNull().default(0),
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Provider + token + cost + latency telemetry for one interaction. Split from
// aiInteractions so a provider error (no usage row) is distinguishable from a
// zero-token response.
export const aiUsage = pgTable("ai_usage", {
  id: serial("id").primaryKey(),
  interactionId: integer("interaction_id").notNull().references(() => aiInteractions.id),
  provider: text("provider").notNull(),
  model: text("model"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  totalTokens: integer("total_tokens"),
  estimatedCostUsd: numeric("estimated_cost_usd"),
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Scaffolding for the action-risk-level framework (Build Instructions §"Action
// Risk Levels", Level 0-4). Nothing in this build writes an "executed" row: nothing
// implemented here lets the AI independently execute Level 2+ actions. The table
// exists so a future Grow/Workflow AI build has a durable place to request and
// record human-approved actions instead of inventing one under time pressure.
export const aiActionRequests = pgTable("ai_action_requests", {
  id: serial("id").primaryKey(),
  brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
  userId: integer("user_id").notNull().references(() => users.id),
  // Actor-type axis (Build Instructions Part 18): who actually initiated this request.
  actorType: text("actor_type").notNull().default("USER"), // USER | AI | PIT_CREW | ADMIN | SYSTEM
  interactionId: integer("interaction_id").references(() => aiInteractions.id),
  sessionId: text("session_id"),
  conversationId: text("conversation_id"),
  // Registered AIActionDefinition.actionKey (apps/api/src/lib/ai/actions/registry.ts), e.g. "PROPERTY_NOTE_ADD".
  actionKey: text("action_key").notNull(),
  actionDefinitionVersion: integer("action_definition_version").notNull().default(1),
  authorityLevel: integer("authority_level").notNull(), // 1 OBSERVE .. 5 SYSTEM_CHANGE
  riskLevel: integer("risk_level").notNull(), // 0-4, mirrors ai/types.ts RiskLevel
  policyVersion: integer("policy_version").notNull().default(1),
  resourceType: text("resource_type"),
  resourceId: text("resource_id"),
  inputPayload: jsonb("input_payload").notNull(),
  // Approval binds to this hash of inputPayload; a changed payload invalidates the approval (Build Instructions Part 25).
  inputPayloadHash: text("input_payload_hash").notNull(),
  proposedChanges: jsonb("proposed_changes"),
  humanReadableSummary: text("human_readable_summary").notNull(),
  // PROPOSED | AWAITING_APPROVAL | APPROVED | REJECTED | EXECUTING | COMPLETED | FAILED | CANCELLED | EXPIRED
  status: text("status").notNull().default("PROPOSED"),
  requiresApproval: boolean("requires_approval").notNull().default(true),
  approvedByUserId: integer("approved_by_user_id").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  rejectedByUserId: integer("rejected_by_user_id").references(() => users.id),
  rejectedAt: timestamp("rejected_at"),
  rejectionReason: text("rejection_reason"),
  expiresAt: timestamp("expires_at"),
  executedAt: timestamp("executed_at"),
  executionResult: jsonb("execution_result"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  // AE GROW Priority 6 Stage F4.0 — DB-level backstop for the Grow
  // follow-up-commitment dedup (actionRequests.ts's
  // findOpenActionRequestByResource + proposeAIAction's unique-violation
  // handling): at most one OPEN CREATE_GROW_COMMITMENT request per
  // (brokerage, deterministic resourceId). Deliberately scoped to that one
  // action: every other action either proposes with a null resourceId
  // (automation) or accepts a client-supplied resourceId via
  // POST /ai/actions/:actionKey/propose, where several open requests for
  // the same resource are legitimate. The status list must match
  // OPEN_ACTION_REQUEST_STATUSES in actionRequests.ts.
  openGrowCommitmentResourceUnique: uniqueIndex("ai_action_requests_open_grow_commitment_resource_uidx")
    .on(table.actionKey, table.brokerageId, table.resourceId)
    .where(
      sql`${table.actionKey} = 'CREATE_GROW_COMMITMENT' AND ${table.resourceId} IS NOT NULL AND ${table.status} IN ('AWAITING_APPROVAL', 'APPROVED', 'EXECUTING')`,
    ),
}));

export const insertAiConfigurationSchema = createInsertSchema(aiConfigurations).omit({ id: true, createdAt: true, updatedAt: true });
export const insertAiPromptVersionSchema = createInsertSchema(aiPromptVersions).omit({ id: true, createdAt: true });
export const insertAiActionRequestSchema = createInsertSchema(aiActionRequests).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertAiConfiguration = z.infer<typeof insertAiConfigurationSchema>;
export type InsertAiPromptVersion = z.infer<typeof insertAiPromptVersionSchema>;
export type InsertAiActionRequest = z.infer<typeof insertAiActionRequestSchema>;
export type AiConfiguration = typeof aiConfigurations.$inferSelect;
export type AiPromptVersion = typeof aiPromptVersions.$inferSelect;
export type AiInteraction = typeof aiInteractions.$inferSelect;
export type AiUsage = typeof aiUsage.$inferSelect;
export type AiActionRequest = typeof aiActionRequests.$inferSelect;
