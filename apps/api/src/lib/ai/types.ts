// Shared types for the Contextual AI Architecture (apps/api/src/lib/ai/*).
// See ARCHITECTURE.md "Phase 9: Contextual AI Architecture" for the full design
// and CLAUDE_AI_COMPLETION_REPORT.md for what is and is not implemented.

// AE GROW Priority 6 Stage C — Business Coach. Both imports below are
// `import type` only, so they are fully erased at compile time and add no
// runtime dependency: this file stays what it has always been, a pure types
// module with zero runtime imports. coaching/metrics.ts (in turn) imports
// `GrowContext` from THIS file as `import type` too, so the two files form a
// type-only cycle that TypeScript resolves safely (neither module actually
// executes the other at runtime - see coaching/metrics.ts's own header
// comment).
import type {
  ActivityConsistencyMetric,
  AppraisalMomentumMetric,
  CommitmentPerformanceMetric,
  GrowTodayPatternsMetric,
  OpportunityPipelineHealthMetric,
  PeriodComparisonMetric,
  RelationshipEngagementMetric,
} from "./coaching/metrics.js";
import type { PeriodView } from "./coaching/period.js";

// Five architected AI roles (Build Instructions "Five-Role AI Capability
// Architecture"). Only "copilot" has a real implementation in this build; the
// rest exist as typed interfaces so a future build slots in without redesigning
// the gateway/context/tool/orchestration layers.
//
// AE GROW Priority 6 Stage C — "business_coach" is the second role to gain a
// real implementation (orchestrator.ts's askCopilot, mode: "coach"). This is
// still the SAME AiRole union Priority 0.5 already defined - no new role name
// is introduced, matching the Minimal Role Routing Authorisation's "invoke
// the EXISTING business_coach role" instruction exactly.
export type AiRole =
  | "copilot"
  | "proactive_intelligence"
  | "business_coach"
  | "workflow_ai"
  | "pitcrew_ai";

export const AI_ROLES: readonly AiRole[] = [
  "copilot",
  "proactive_intelligence",
  "business_coach",
  "workflow_ai",
  "pitcrew_ai",
];

// Structured Response Framework: every AI answer self-declares which of these
// kinds it is so the UI never presents a guess with the confidence of a
// fact. "unknown" is a first-class, expected outcome, not an error.
//
// AE GROW Priority 6 Stage B (Grow-Scoped Ask AE) additive extension: "summary"
// and "indicator" are new alongside the original five. Both are backward
// compatible additions (a wider union, not a narrower one) — every existing
// consumer that matched on "fact" | "inference" | "recommendation" | "unknown"
// | "action_proposal" (RUN Copilot's AskAgentEngine.tsx KIND_LABEL map, and
// every existing AI test) still compiles and still behaves identically, since
// no existing code path ever produces "summary" or "indicator" and no existing
// value is removed or renamed. Only Stage B's own Grow-scoped orchestration
// path (see orchestrator.ts's classifyGrowResponseKind) ever returns one:
//   - summary:    an aggregated/calculated figure (e.g. "6 open opportunities
//                 across 3 stages") — a genuine number Stage B computed, not a
//                 single verified record.
//   - indicator:  a system-generated signal already carrying its own
//                 confidence band (e.g. a Property Intelligence signal) —
//                 distinct from "fact" (a directly-recorded record) and from
//                 "inference" (something the model itself derived).
//
// AE GROW Priority 6 Stage C reuses "recommendation" (unchanged) for every
// Business Coach response rather than adding a new kind — a coaching answer
// always closes with prioritised suggestions, which is exactly what
// "recommendation" already means in this union.
export type ResponseKind = "fact" | "inference" | "recommendation" | "unknown" | "action_proposal" | "summary" | "indicator";

// Action-risk-level framework, Level 0 (read-only) through Level 4 (compliance/
// financial). This build only ever produces Level 0 responses; Levels 1-4 are
// defined now so permission/entitlement/orchestration code has a real ceiling to
// enforce against rather than an implicit one added later under time pressure.
export const RISK_LEVEL_DESCRIPTIONS: Record<number, string> = {
  0: "Read-only - retrieving or summarizing existing data. No side effects.",
  1: "Draft/suggestion - text or a plan proposed for a human to review and send or apply themselves.",
  2: "Reversible write - a low-stakes record change the AI could apply, always behind explicit human confirmation.",
  3: "Hard-to-reverse action - e.g. an outbound communication to a third party, or a workflow-stage transition.",
  4: "Compliance/financial - AML, trust-account, settlement, or contract actions. The AI must never independently execute this level.",
};
export type RiskLevel = 0 | 1 | 2 | 3 | 4;

// This build never lets the orchestrator carry out anything above this level
// automatically - see orchestrator.ts `assertWithinAutoExecuteCeiling`.
export const AUTO_EXECUTE_CEILING: RiskLevel = 0;

export type SubscriptionTier = "STARTER" | "GROW" | "PRO";

export interface UserContext {
  id: number;
  firstName: string;
  lastName: string;
  role: string;
}

export interface BrokerageContext {
  id: number;
  name: string;
  tier: SubscriptionTier;
}

export interface PropertyContext {
  id: number;
  address: string;
  workflowStage: string;
}

export interface TransactionSummary {
  id: number;
  propertyId: number;
  status: string;
}

export interface BusinessContext {
  activePropertyCount: number;
  upcomingSettlementCount: number;
}

// AE GROW Priority 6 Stage B — one bounded, already-tenant-scoped Grow Today
// item, shaped for the AI prompt/tool-result surface rather than the full
// GrowTodayAction the Grow Today UI itself uses (lib/growToday.ts): no
// contact email/mobile/availableActions here (Stage B is read-only and never
// renders an action button from AI output), so nothing PII-adjacent beyond a
// display name and the ids needed for a safe deep link travels through the
// model's context that the Grow Today API response didn't already expose to
// this same authenticated user.
export interface GrowTodayItemView {
  id: string;
  type: string;
  priority: string;
  partyId: number;
  contactName: string;
  propertyId: number | null;
  propertyLabel: string | null;
  opportunityId: number | null;
  appraisalId: number | null;
  reason: string;
  recommendedAction: string;
  dueAt: string | null;
  lastActivityAt: string | null;
}

export interface GrowOpportunityStageSummary {
  stage: string;
  count: number;
}

export interface GrowRelationshipTypeCount {
  relationshipType: string;
  count: number;
}

export interface GrowRecentActivityView {
  id: number;
  partyId: number | null;
  propertyId: number | null;
  activityType: string;
  occurredAt: string;
  summary: string;
}

// AE GROW Priority 6 Stage B — the Grow context builder's real output
// (context/growContext.ts). Replaces the Priority-0.5-era placeholder shape
// ({ leadCount: number }) that was never populated (buildGrowContext always
// returned null) and that nothing in this codebase ever read a value out of —
// safe to redefine outright rather than extend. Every list below is already
// bounded (see growContext.ts's own *_LIMIT constants) before it reaches this
// package, so nothing here can grow the prompt or a tool result unboundedly
// regardless of how much Grow data a brokerage holds.
export interface GrowContext {
  generatedAt: string;
  hasAnyGrowData: boolean;
  counts: {
    priorityActions: number;
    followUpsDue: number;
    openOpportunities: number;
    contactsNeedingAttention: number;
  };
  relationshipBreakdown: GrowRelationshipTypeCount[];
  todayItems: GrowTodayItemView[];
  focusedItem: GrowTodayItemView | null;
  dueFollowUps: GrowTodayItemView[];
  appraisalFollowUps: GrowTodayItemView[];
  activeSignals: GrowTodayItemView[];
  opportunityPipeline: GrowOpportunityStageSummary[];
  recentActivity: GrowRecentActivityView[];
}
export interface PitCrewContext {
  openServiceOrderCount: number;
}

// AE GROW Priority 6 Stage C — Business Coach's own coaching-metrics
// context, built by context/businessCoachContext.ts ONLY when a request is
// mode "coach" (see contextEngine.ts). Every field here is one of
// coaching/metrics.ts's already-deterministic, already-bounded compute
// outputs — this file adds no new figures of its own, it only names the
// shape that carries them from the context builder to the response builder
// (coaching/responseBuilder.ts) and the coach tool registry
// (tools/registry.ts's COACH_TOOL_REGISTRY).
export interface BusinessCoachContext {
  // When these metrics were computed, independent of any one metric's own
  // period — the single "as of" timestamp a coaching response's
  // dataFreshness field reports.
  asOf: string;
  period: PeriodView;
  previousPeriod: PeriodView;
  activity: ActivityConsistencyMetric;
  commitments: CommitmentPerformanceMetric;
  appraisals: AppraisalMomentumMetric;
  opportunities: OpportunityPipelineHealthMetric;
  relationships: RelationshipEngagementMetric;
  growToday: GrowTodayPatternsMetric;
  comparison: PeriodComparisonMetric;
}

// AE GROW Priority 6 Stage C — a coaching-specific evidence-strength label.
// Deliberately a NEW, separate vocabulary from Property Intelligence's
// PROPERTY_SIGNAL_CONFIDENCE_BANDS (packages/db/src/schema/propertyIntelligence.ts):
// that vocabulary describes confidence in a system-generated selling-opportunity
// signal about a property, a different domain from "how strong is the evidence
// behind this coaching recommendation" — conflating the two would let a
// coaching recommendation borrow the visual/semantic weight of a Property
// Intelligence signal it has nothing to do with.
export type CoachingEvidenceStrength = "Preliminary" | "Moderate" | "Strong";

// AE GROW Priority 6 Stage C — one coaching recommendation. Every field
// beyond `action`/`reason` is optional because not every recommendation
// candidate has a natural relatedMetric (e.g. the "no attention items,
// keep doing what you're doing" fallback) — never because a figure was
// omitted to save space. Deliberately has NO execution payload of any kind
// (contrast with AiStructuredResponse.actionProposals, Stage G9's Level 1+
// action-proposal shape) — this is Level 0 only, a suggestion for the agent
// to act on themselves, never something AE could carry out.
export interface CoachingRecommendation {
  action: string;
  reason: string;
  relatedMetric?: string;
  relatedRecordLabel?: string;
  suggestedTimeframe?: string;
  progressMeasure?: string;
  evidenceStrength?: CoachingEvidenceStrength;
}

// AE GROW Priority 6 Stage C — one supporting metric shown alongside a
// coaching response, always pre-formatted (`value` is already a display
// string, e.g. "62%" or "3 of 5") so the model is never asked to reformat or
// restate a number itself.
export interface CoachingSupportingMetric {
  key: string;
  label: string;
  value: string;
  definition: string;
}

export interface AiContextPackage {
  requestId: string;
  brokerageId: number;
  userId: number;
  userRole: string;
  tier: SubscriptionTier;
  role: AiRole;
  // AE GROW Priority 6 Stage B: "grow" is additive. contextId is unused for
  // "grow" (Grow's Ask AE is brokerage-wide, not scoped to one property/
  // transaction) — a specific Grow Today item to explain is instead threaded
  // through growFocusItemId (see AskCopilotInput below), because a Grow
  // Today item id is a string (e.g. "opportunity:123"), not the number this
  // field's existing property/transaction usage already commits it to.
  contextType: "property" | "transaction" | "business" | "grow" | null;
  contextId: number | null;
  user: UserContext;
  brokerage: BrokerageContext;
  business: BusinessContext;
  property: PropertyContext | null;
  transaction: TransactionSummary | null;
  grow: GrowContext | null;
  pitCrew: PitCrewContext | null;
  // AE GROW Priority 6 Stage C — additive, mirrors grow/pitCrew's own
  // "always present, null unless this request actually needed it" shape.
  // Only ever non-null when role === "business_coach" (mode "coach") — see
  // context/contextEngine.ts's buildContext().
  coach: BusinessCoachContext | null;
}

export interface AiToolDefinition {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  run: (ctx: AiContextPackage, args: Record<string, unknown>) => Promise<AiToolResult>;
}

export interface AiToolResult {
  tool: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface AiStructuredResponse {
  kind: ResponseKind;
  summary: string;
  details: string[];
  toolsUsed: string[];
  riskLevel: RiskLevel;
  disclaimer?: string;
  // Stage G9 (Ask Agent Engine Action Interface): when kind is
  // "action_proposal", the model is suggesting the human consider a
  // registered AI action -- never a claim that anything ran. This field
  // is data only. Nothing in the orchestrator reads it to call
  // proposeAIAction() automatically: askCopilot() stays OBSERVE-ceiling
  // (assertWithinAutoExecuteCeiling(0), read-only) by deliberate design,
  // per Build Instructions Part 15/30 ("do not proceed into autonomous AI
  // agents ... at this stage"). Turning a suggestion here into an actual
  // AIActionRequest is a human action: they call
  // POST /ai/actions/:actionKey/propose themselves, through their own
  // authenticated session, same as any other actor -- the Golden Rule
  // applies to this path exactly like every other one. Wiring an
  // automatic propose-on-suggestion loop is future work, not this stage.
  actionProposals?: Array<{ actionKey: string; proposedInput: unknown; rationale: string }>;
  // AE GROW Priority 6 Stage B — Response Contract additions. Optional so
  // every existing (non-Grow) AiStructuredResponse producer/consumer is
  // completely unaffected: RUN Copilot never sets these fields today and
  // never will unless a future stage decides to.
  supportingRecords?: Array<{ recordType: "party" | "property" | "opportunity" | "appraisal"; recordId: number; label: string; deepLink: string | null }>;
  dataFreshness?: string;
  limitations?: string[];
  suggestedNextStep?: string;
  // AE GROW Priority 6 Stage C — Business Coach Response Contract
  // additions. Optional so every existing (RUN Copilot and Grow Ask AE)
  // producer/consumer is completely unaffected — neither one sets these
  // fields today and neither will unless a future stage decides to. Only
  // orchestrator.ts's askCopilot() sets these, only when mode is "coach".
  headline?: string;
  period?: PeriodView;
  performanceSummary?: string;
  observations?: string[];
  strengths?: string[];
  focusAreas?: string[];
  recommendations?: CoachingRecommendation[];
  supportingMetrics?: CoachingSupportingMetric[];
  suggestedReviewDate?: string;
}

export interface AiProviderRequest {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface AiProviderUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface AiProviderResponse {
  provider: string;
  model: string;
  text: string;
  usage: AiProviderUsage;
  latencyMs: number;
}

export class AiProviderError extends Error {
  provider: string;
  constructor(provider: string, message: string) {
    super(message);
    this.name = "AiProviderError";
    this.provider = provider;
  }
}

export class AiPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiPermissionError";
  }
}

export class AiEntitlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiEntitlementError";
  }
}

export class AiFeatureDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiFeatureDisabledError";
  }
}
