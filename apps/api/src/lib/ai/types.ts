// Shared types for the Contextual AI Architecture (apps/api/src/lib/ai/*).
// See ARCHITECTURE.md "Phase 9: Contextual AI Architecture" for the full design
// and CLAUDE_AI_COMPLETION_REPORT.md for what is and is not implemented.

// Five architected AI roles (Build Instructions "Five-Role AI Capability
// Architecture"). Only "copilot" has a real implementation in this build; the
// rest exist as typed interfaces so a future build slots in without redesigning
// the gateway/context/tool/orchestration layers.
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
// four kinds it is so the UI never presents a guess with the confidence of a
// fact. "unknown" is a first-class, expected outcome, not an error.
export type ResponseKind = "fact" | "inference" | "recommendation" | "unknown" | "action_proposal";

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

// Placeholder interfaces only, per the Build Instructions' explicit stop point:
// architect the shape, do not implement. Always null in this build's responses -
// see context/growContext.ts and context/pitCrewContext.ts.
export interface GrowContext {
  leadCount: number;
}
export interface PitCrewContext {
  openServiceOrderCount: number;
}

export interface AiContextPackage {
  requestId: string;
  brokerageId: number;
  userId: number;
  userRole: string;
  tier: SubscriptionTier;
  role: AiRole;
  contextType: "property" | "transaction" | "business" | null;
  contextId: number | null;
  user: UserContext;
  brokerage: BrokerageContext;
  business: BusinessContext;
  property: PropertyContext | null;
  transaction: TransactionSummary | null;
  grow: GrowContext | null;
  pitCrew: PitCrewContext | null;
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
