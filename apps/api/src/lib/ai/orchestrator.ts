import { randomUUID } from "node:crypto";
import { logger } from "@aee/events";
import type { AiActionRequest } from "@aee/db";
import { buildContext } from "./context/contextEngine.js";
import { runAllTools } from "./tools/registry.js";
import { generateWithGateway, loadAiGatewayConfig } from "./gateway.js";
import { getPrompt } from "./prompts.js";
import { isRoleEnabled } from "./featureFlags.js";
import { isRoleEntitled } from "./entitlements.js";
import { logAiInteraction, logAiUsage } from "./audit.js";
import { assertGrowRateLimit, GrowRateLimitError } from "./growRateLimiter.js";
import {
  buildCoachFocusAreas,
  buildCoachHeadline,
  buildCoachLimitations,
  buildCoachPerformanceSummary,
  buildCoachRecommendations,
  buildCoachStrengths,
  buildCoachSuggestedReviewDate,
  buildCoachSupportingMetrics,
  buildCoachObservations,
} from "./coaching/responseBuilder.js";
import type { CoachingPeriodKey } from "./coaching/period.js";
import { resolveCoachingTimeZone, localDateKey } from "./coaching/timezone.js";
import {
  proposeAIAction,
  findOpenActionRequestByResource,
  canActorAccessActionRequest,
  actorHoldsActionEntitlement,
} from "./actionRequests.js";
import { getActionDefinition } from "./actions/registry.js";
import type { PolicyActor } from "./policyEngine.js";
import { AUTO_EXECUTE_CEILING, AiEntitlementError, AiFeatureDisabledError, RISK_LEVEL_DESCRIPTIONS } from "./types.js";
import type {
  AiContextPackage,
  AiRole,
  AiStructuredResponse,
  AiToolResult,
  GrowCommitmentProposalSummary,
  GrowTodayItemView,
  ResponseKind,
  RiskLevel,
} from "./types.js";

export interface AskCopilotInput {
  brokerageId: number;
  userId: number;
  userRole: string;
  question: string;
  // AE GROW Priority 6 Stage B: "grow" is additive - every existing caller
  // (RUN Copilot's routes/ai.ts, orchestrator.test.ts) keeps compiling and
  // behaving identically, since contextType still accepts every value it
  // always did.
  contextType: "property" | "transaction" | "business" | "grow" | null;
  contextId: number | null;
  // Optional (not required) so every existing call site - production and
  // test - that never mentions Grow keeps compiling unchanged. Only
  // meaningful when contextType is "grow"; ignored otherwise, same as
  // contextId is already ignored for contextType "business"/null today.
  growFocusItemId?: string | null;
  // AE GROW Priority 6 Stage C — additive, optional. "coach" switches the
  // read-only Grow Ask AE surface into the read-only Business Coach: a
  // different (business_coach) AI role, a different coaching-metrics
  // context, a different tool registry, and a different structured
  // response shape (headline/performanceSummary/recommendations/...)
  // layered onto the SAME AiStructuredResponse contract. Every existing
  // caller (RUN Copilot, Grow Ask AE) omits this field and is completely
  // unaffected - default is "ask", which behaves exactly as before this
  // stage existed. routes/ai.ts's schema only ever accepts "coach" together
  // with contextType "grow" - there is no other path to the business_coach
  // role from a client request.
  mode?: "ask" | "coach";
  // Coach-mode only; ignored for mode "ask" (or omitted, same as
  // contextId is already ignored for contextType "business"/null today).
  // Defaults to "last7days" in askCopilot() when mode is "coach" and this
  // is omitted.
  period?: CoachingPeriodKey;
  periodStartDate?: string | null;
  periodEndDate?: string | null;
}

export interface AskCopilotResult {
  requestId: string;
  response: AiStructuredResponse;
}

function classifyResponseKind(toolResults: AiToolResult[]): ResponseKind {
  const successful = toolResults.filter((result) => result.ok === true);
  if (successful.length === 0) {
    return "unknown";
  }
  const hasData = successful.some((result) => {
    if (Array.isArray(result.data)) return result.data.length > 0;
    return result.data !== null && result.data !== undefined;
  });
  return hasData ? "fact" : "unknown";
}

export function toolResultHasUsableData(result: AiToolResult): boolean {
  if (Array.isArray(result.data)) return result.data.length > 0;
  return result.data !== null && result.data !== undefined;
}

// AE GROW Priority 6 Stage B — Grow-scoped response kind classification.
// Distinct from classifyResponseKind above (RUN Copilot's existing
// fact/unknown-only classifier, untouched by this function and still used
// for every non-Grow contextType): the Grow Response Contract requires
// Fact/Summary/Indicator/Recommendation/Unknown, because Grow's tool results
// are qualitatively different from Copilot's property/business results:
//   - indicator: a Property Intelligence signal came back with data - it
//                already self-carries its own confidence band, which is a
//                stronger and more specific claim than a plain "fact", so it
//                takes priority when present.
//   - summary:   an aggregated/calculated tool (relationship breakdown or
//                opportunity pipeline) came back with data - a genuine
//                computed figure, not one record's detail.
//   - fact:      some other Grow tool (today items, due commitments,
//                appraisal follow-ups, recent activity, the focused item)
//                came back with data - a directly-recorded detail.
//   - unknown:   no Grow tool returned any usable data.
//   - recommendation is never produced by this function: it is reserved for
//                the model's own explicit "I suggest..." framing, which
//                cannot be detected from tool results alone. Kept in the
//                shared ResponseKind union only because AiStructuredResponse
//                is shared with RUN Copilot.
export function classifyGrowResponseKind(toolResults: AiToolResult[]): ResponseKind {
  const successful = toolResults.filter((result) => result.ok === true);
  if (successful.length === 0) {
    return "unknown";
  }
  const signalResult = successful.find((result) => result.tool === "get_property_intelligence_signals");
  if (signalResult !== undefined && toolResultHasUsableData(signalResult)) {
    return "indicator";
  }
  const summaryToolNames = new Set(["get_contact_relationship_summary", "get_grow_opportunity_pipeline"]);
  // Checks every summary-tool result for usable data, not just whichever
  // one happens to run first in GROW_TOOL_REGISTRY order - a brokerage with
  // open opportunities but zero active relationships (or vice versa) must
  // still classify as "summary", not silently fall through to "fact"
  // because the first summary tool by array position happened to come back
  // empty while a later one had real data.
  const summaryResult = successful.find((result) => summaryToolNames.has(result.tool) && toolResultHasUsableData(result));
  if (summaryResult !== undefined) {
    return "summary";
  }
  return successful.some(toolResultHasUsableData) ? "fact" : "unknown";
}

const MAX_GROW_SUPPORTING_RECORDS = 5;

// AE GROW Priority 6 Stage B — Deep Links / Response Contract supportingRecords.
//
// apps/web/src/App.tsx's route table is deliberately shallow (see that
// file's own header comment: "almost everything lives inside the Property
// Workspace"). The only per-record detail route that exists today is
// /properties/:id - there is no dedicated party/opportunity/appraisal detail
// route to link to. Rather than fabricate a URL that would 404, this
// returns deepLink: null for record types with no real route - a missing
// link is honest; a broken one is not.
//
// Tenant/existence re-check: every id used here came from ctx.grow, which
// growContext.ts already built by querying ONLY this same request's own
// brokerageId (see that file's own header comment) - it was never possible
// for a foreign-brokerage record to reach this function, so no separate
// re-query is needed before returning these ids, unlike a route handler that
// receives an id from client input.
export function buildGrowSupportingRecords(context: AiContextPackage): AiStructuredResponse["supportingRecords"] {
  const grow = context.grow;
  if (grow === null) {
    return undefined;
  }
  const items = grow.focusedItem !== null ? [grow.focusedItem] : grow.todayItems.slice(0, MAX_GROW_SUPPORTING_RECORDS);
  const records: NonNullable<AiStructuredResponse["supportingRecords"]> = [];
  for (const item of items) {
    if (item.propertyId !== null) {
      records.push({
        recordType: "property",
        recordId: item.propertyId,
        label: item.propertyLabel ?? `Property #${item.propertyId}`,
        deepLink: `/properties/${item.propertyId}`,
      });
    } else if (item.opportunityId !== null) {
      records.push({ recordType: "opportunity", recordId: item.opportunityId, label: item.contactName, deepLink: null });
    } else if (item.appraisalId !== null) {
      records.push({ recordType: "appraisal", recordId: item.appraisalId, label: item.contactName, deepLink: null });
    } else {
      records.push({ recordType: "party", recordId: item.partyId, label: item.contactName, deepLink: null });
    }
    if (records.length >= MAX_GROW_SUPPORTING_RECORDS) {
      break;
    }
  }
  return records.length > 0 ? records : undefined;
}

// Static, deliberately conservative - restates in the response payload itself
// (not just the system prompt) the two constraints most likely to matter if a
// consumer of this API ever renders `summary` without also rendering the
// system prompt's constraints: never a live check of anything beyond Grow
// Today, never a claim about a contact's private intentions.
export const GROW_LIMITATIONS: string[] = [
  "This answer only reflects data already visible in your own Grow Today list - it is not a live check of any external source.",
  "AE has no information about a contact's private plans or motivations; any pattern mentioned here is a reason to review, not a prediction about that person.",
];

export function buildGrowSuggestedNextStep(context: AiContextPackage): string | undefined {
  const grow = context.grow;
  if (grow === null) {
    return undefined;
  }
  if (grow.focusedItem !== null) {
    return grow.focusedItem.recommendedAction;
  }
  if (grow.todayItems.length > 0) {
    return "Review your Grow Today list for prioritized follow-ups.";
  }
  return undefined;
}

// ---------------------------------------------------------------------
// AE GROW Priority 6 Stage D — AI-Proposed, Human-Approved Follow-Up
// Actions.
//
// Deliberately grounded ONLY in context.grow — the same already-tenant-
// scoped Grow Today data buildGrowSupportingRecords/buildGrowSuggestedNextStep
// above already surface in the response — never in generation.response.text
// (the model's own free-text output). This is what makes "insufficient
// evidence must remain ordinary text, not become an actionable proposal"
// true by construction: if context.grow has no qualifying item, no
// proposal is attempted at all, regardless of what the model's prose says.
// It is also what makes this immune to prompt injection via supporting
// records/evidence text: nothing the model generates, and nothing stored in
// a contact's notes/activities, is ever read back into the proposal's
// partyId/dueAt/propertyId/opportunityId fields — those come only from
// GrowTodayItemView fields Grow Today's own deterministic computation
// (lib/growToday.ts) already resolved against this request's own
// brokerageId before context.grow was ever built.
//
// selectGrowCommitmentCandidate/isReasonableCommitmentDueDate/
// proposeGrowCommitmentIfGrounded are exported for direct unit testing
// (see __tests__/growCommitmentAction.test.ts), mirroring how
// classifyGrowResponseKind/buildGrowSupportingRecords/
// buildGrowSuggestedNextStep above are already exported from this same
// file for growOrchestrator.test.ts.
// ---------------------------------------------------------------------

// A broad sanity bound, not a "must be in the future" rule: Grow Today
// deliberately surfaces OVERDUE follow-ups (a due date in the past is the
// expected, common case for exactly the kind of "you're behind on this"
// item this feature exists to help catch up on), so rejecting every past
// date would defeat the feature. What this bound actually catches is a
// stale or malformed date far outside any plausible follow-up window in
// either direction. Same order of magnitude as coaching/period.ts's own
// CUSTOM_PERIOD_MAX_LOOKBACK_DAYS, for the same "document the bound rather
// than leave it implicit" reason.
const GROW_COMMITMENT_MAX_DATE_SKEW_DAYS = 730;

export function isReasonableCommitmentDueDate(dueAt: Date, now: Date): boolean {
  const skewDays = Math.abs(dueAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
  return skewDays <= GROW_COMMITMENT_MAX_DATE_SKEW_DAYS;
}

// The single, deterministic candidate for this request, if any: the
// focused item the agent asked about, else the first due follow-up, else
// the first appraisal follow-up — the same priority Grow Today itself
// already uses to decide what to surface first. Returns null (no
// proposal) whenever there is nothing concrete and dated to ground one
// in, which is the ordinary case for most questions ("insufficient
// evidence... remains ordinary text").
export function selectGrowCommitmentCandidate(context: AiContextPackage): GrowTodayItemView | null {
  const grow = context.grow;
  if (grow === null) {
    return null;
  }
  const candidate = grow.focusedItem ?? grow.dueFollowUps[0] ?? grow.appraisalFollowUps[0] ?? null;
  if (candidate === null || candidate.dueAt === null) {
    return null;
  }
  return candidate;
}

function summarizeGrowCommitmentProposal(
  request: AiActionRequest,
  candidate: GrowTodayItemView,
  timeZone: string,
): GrowCommitmentProposalSummary {
  const payload = request.inputPayload as {
    dueAt: string;
    reason: string;
    evidenceSummary?: string | null;
    propertyId?: number | null;
    opportunityId?: number | null;
  };
  return {
    actionRequestId: request.id,
    actionKey: "CREATE_GROW_COMMITMENT",
    humanReadableSummary: request.humanReadableSummary,
    contactName: candidate.contactName,
    partyId: candidate.partyId,
    dueAt: payload.dueAt,
    timeZone,
    relatedPropertyId: payload.propertyId ?? null,
    relatedOpportunityId: payload.opportunityId ?? null,
    reason: payload.reason,
    evidenceSummary: payload.evidenceSummary ?? null,
    // CREATE_GROW_COMMITMENT's authorityLevel/riskLevel combination makes
    // isAutoExecuteEligible() always false today (see authority.ts), so
    // decision.requiresApproval is always true and this branch is in
    // practice always "AWAITING_APPROVAL" — the APPROVED case is kept only
    // so a future, deliberate policy change cannot silently make this
    // function report a stale/wrong status.
    status: request.status === "APPROVED" ? "APPROVED" : "AWAITING_APPROVAL",
    expiresAt: request.expiresAt ? request.expiresAt.toISOString() : null,
    reviewUrl: "/grow",
  };
}

// Attempts to propose exactly one CREATE_GROW_COMMITMENT action for this
// request, and returns a safe summary of it — or undefined if there was
// nothing grounded to propose, the policy engine denied it, or a
// duplicate is already open. Never throws: askCopilot() wraps this call in
// its own try/catch and a failure here must never be the reason a chat
// answer fails (see the call site's own comment below).
export async function proposeGrowCommitmentIfGrounded(
  context: AiContextPackage,
  actor: PolicyActor,
  interactionId: number | null,
): Promise<GrowCommitmentProposalSummary | undefined> {
  const candidate = selectGrowCommitmentCandidate(context);
  if (candidate === null || candidate.dueAt === null) {
    return undefined;
  }

  const dueAt = new Date(candidate.dueAt);
  if (Number.isNaN(dueAt.getTime()) || !isReasonableCommitmentDueDate(dueAt, new Date())) {
    return undefined;
  }

  // F4.0 D1: never surface an existing proposal to someone who does not
  // currently hold the action's entitlement (the new-proposal path below
  // is gated by the same entitlement inside evaluateAIAction()).
  const definition = getActionDefinition("CREATE_GROW_COMMITMENT");
  if (!definition || !(await actorHoldsActionEntitlement(definition, actor))) {
    return undefined;
  }

  const { timeZone } = await resolveCoachingTimeZone(actor.brokerageId);
  // A deterministic key derived only from already-tenant-scoped ids/dates
  // this same server-side computation produced — never from client or
  // model input — so a repeat Ask AE/Coach call for the same underlying
  // follow-up cannot be tricked into a different dedup bucket. F4.0 D1:
  // the requesting user is part of the key, so dedup (and the partial
  // unique index behind it) is per user: two agents asking about the same
  // contact/due date each get their own proposal, never each other's.
  const resourceId = `user:${actor.id}:party:${candidate.partyId}:due:${localDateKey(dueAt, timeZone)}`;

  const existing = await findOpenActionRequestByResource("CREATE_GROW_COMMITMENT", actor.brokerageId, resourceId);
  if (existing !== null) {
    // Defence in depth: the per-user key already scopes this lookup, but an
    // existing request is only ever summarised for someone allowed to see it.
    if (!canActorAccessActionRequest(existing, actor)) return undefined;
    return summarizeGrowCommitmentProposal(existing, candidate, timeZone);
  }

  const rawInput = {
    partyId: candidate.partyId,
    description: candidate.recommendedAction,
    dueAt: dueAt.toISOString(),
    propertyId: candidate.propertyId,
    opportunityId: candidate.opportunityId,
    reason: candidate.reason,
    evidenceSummary: candidate.lastActivityAt ? `Last activity: ${candidate.lastActivityAt}` : null,
    originatingInteractionId: interactionId,
    dedupeKey: resourceId,
  };

  const { request, decision } = await proposeAIAction({
    actionKey: "CREATE_GROW_COMMITMENT",
    actor,
    actorType: "AI",
    rawInput,
    resourceId,
    interactionId,
  });

  if (decision.allowed === false || request === null) {
    return undefined;
  }

  return summarizeGrowCommitmentProposal(request, candidate, timeZone);
}

// Nothing in this build calls this with anything but Level 0 - it exists so the
// ceiling is a real, enforced check rather than an implicit assumption a future
// higher-risk-level build could quietly slip past.
function assertWithinAutoExecuteCeiling(riskLevel: RiskLevel): void {
  if (riskLevel > AUTO_EXECUTE_CEILING) {
    throw new Error(
      `Refusing to auto-execute a Level ${riskLevel} action (${RISK_LEVEL_DESCRIPTIONS[riskLevel]}). ` +
        "This build never lets the AI carry out anything above Level 0 without a human."
    );
  }
}

// Orchestration Layer: context -> permissions -> entitlements -> tools ->
// provider -> structured response -> audit, in that order, for every request.
// routes/ai.ts has already run requireAuth before calling this; the checks here
// (feature flag, entitlement) are AI-specific and run again server-side even
// though the UI also hides disabled/unentitled capabilities - never UI-only.
export async function askCopilot(input: AskCopilotInput): Promise<AskCopilotResult> {
  const requestId = randomUUID();
  const mode = input.mode ?? "ask";
  const isCoachRequest = mode === "coach";
  const isGrowRequest = input.contextType === "grow";
  // AE GROW Priority 6 Stage C — the Minimal Role Routing Authorisation's
  // entire "server maps mode -> role" boundary lives in this single line: a
  // client can never send a raw role name (AskCopilotInput/askSchema have no
  // such field at all), and the only two possible values of `role` this
  // function can ever compute are the two roles this build actually
  // implements. There is no dynamic role registration and no client-
  // controlled risk level or tenant anywhere in this function.
  const role: AiRole = isCoachRequest ? "business_coach" : "copilot";

  if (isRoleEnabled(role) === false) {
    await logAiInteraction({
      requestId,
      brokerageId: input.brokerageId,
      userId: input.userId,
      aiRole: role,
      riskLevel: 0,
      status: "blocked_flag",
      question: input.question,
    });
    throw new AiFeatureDisabledError(
      role === "business_coach"
        ? "The AI Business Coach is currently disabled for this environment."
        : "The AI Copilot is currently disabled for this environment."
    );
  }

  // AE GROW Priority 6 Stage B — Performance/Cost Controls: rate limiting.
  // Checked before any context/database work, and scoped to Grow only (see
  // growRateLimiter.ts's own header comment for the full rationale and its
  // documented single-process limitation). AE GROW Priority 6 Stage C reuses
  // this SAME limiter, unchanged, for Business Coach requests rather than
  // adding a second one - every coach request is also a Grow request
  // (isGrowRequest is true whenever isCoachRequest is), so this check already
  // covers both without any modification.
  if (isGrowRequest) {
    try {
      assertGrowRateLimit(input.brokerageId);
    } catch (err) {
      if (err instanceof GrowRateLimitError) {
        await logAiInteraction({
          requestId,
          brokerageId: input.brokerageId,
          userId: input.userId,
          aiRole: role,
          contextType: input.contextType ?? undefined,
          question: input.question,
          riskLevel: 0,
          status: "blocked_flag",
          errorMessage: err.message,
        });
      }
      throw err;
    }
  }

  const context = await buildContext({
    requestId,
    brokerageId: input.brokerageId,
    userId: input.userId,
    userRole: input.userRole,
    role,
    contextType: input.contextType,
    contextId: input.contextId,
    growFocusItemId: input.growFocusItemId ?? null,
    mode,
    period: input.period,
    periodStartDate: input.periodStartDate ?? null,
    periodEndDate: input.periodEndDate ?? null,
  });

  // Defense in depth: routes/ai.ts's schema refuses mode "coach" unless
  // contextType is "grow", and contextEngine.ts only builds ctx.coach inside
  // its "grow" branch when mode is "coach" - so this should be unreachable
  // in practice. It stays a hard failure rather than a silent fallback to
  // the Ask AE path, so a future change to either of those guards fails
  // loudly here instead of quietly serving a coach-mode request with no
  // coaching data.
  if (isCoachRequest && context.coach === null) {
    throw new Error("Business Coach context was not built for a coach-mode request.");
  }

  if (isRoleEntitled(context.tier, role) === false) {
    await logAiInteraction({
      requestId,
      brokerageId: input.brokerageId,
      userId: input.userId,
      aiRole: role,
      riskLevel: 0,
      status: "blocked_entitlement",
      question: input.question,
    });
    throw new AiEntitlementError(
      `The ${context.tier} plan does not include ${role === "business_coach" ? "the AI Business Coach" : "the AI Copilot"}.`
    );
  }

  // AE GROW Priority 6 Stage B — Grow-specific entitlement gate. The check
  // above (isRoleEntitled(tier, role)) already fully gates Business Coach
  // (TIER_CAPABILITIES.*.roles.business_coach is false on STARTER and true
  // on GROW/PRO - see entitlements.ts), but for the "copilot" role it is
  // true for every tier today (copilot: true on STARTER, GROW, and PRO
  // alike), so it does NOT gate Grow Ask AE access on its own: a STARTER
  // brokerage (no grow.access) would otherwise sail through it.
  // resolveBrokerageTier() already derives tier from grow.access
  // specifically (grow.access && run.access -> PRO; grow.access only ->
  // GROW; neither/run-only -> STARTER), so "tier !== STARTER" here is
  // exactly "this brokerage holds grow.access" - the Stage B requirement
  // ("require auth + grow.access + existing AI entitlement") without a
  // second, parallel entitlement lookup.
  if (isGrowRequest && context.tier === "STARTER") {
    await logAiInteraction({
      requestId,
      brokerageId: input.brokerageId,
      userId: input.userId,
      aiRole: role,
      contextType: input.contextType ?? undefined,
      question: input.question,
      riskLevel: 0,
      status: "blocked_entitlement",
    });
    throw new AiEntitlementError("Grow-scoped Ask AE requires a Grow or Pro plan.");
  }

  // Stage G9 note (Ask Agent Engine Action Interface / AI Context Security
  // Controls): askCopilot() is intentionally kept at the OBSERVE ceiling
  // (0 = read-only) below. Everything fed into the prompt above
  // (context.brokerage/business/property/transaction/...) is plain,
  // already-tenant-scoped data -- none of it is or contains a callable
  // tool, an action reference, or an authority claim, so nothing in the
  // retrieved context can grant itself execution rights no matter what
  // the model does with it (the classic prompt-injection failure mode:
  // "the document says to approve this" carries no authority here because
  // there is no path from prompt/context content to executeAIAction()).
  // The AI Action Registry (registry.ts) and Execution Gateway
  // (executionGateway.ts) are reachable only via the authenticated human
  // routes in routes/ai-actions.ts, OR (AE GROW Priority 6 Stage D) via
  // this function's own narrow, additive call into proposeAIAction() near
  // the end of askCopilot() -- never automatically from anything the model
  // itself produced. That call is scoped to exactly one action
  // (CREATE_GROW_COMMITMENT), is built entirely from context.grow (the
  // same already-tenant-scoped data this ceiling already covers, never
  // from generation.response.text), and only ever PROPOSES -- it cannot
  // execute anything itself, since CREATE_GROW_COMMITMENT's own
  // authorityLevel/riskLevel combination makes isAutoExecuteEligible()
  // always false (authority.ts) and its allowedActorTypes excludes every
  // caller but the orchestrator's own internal one. This ceiling assertion
  // itself is unchanged and still enforced exactly as before: it governs
  // THIS response's own riskLevel (always 0, a read-only chat answer),
  // which is a different thing from the separate action request's own
  // riskLevel (2) -- proposing a Level-2 action alongside a Level-0 answer
  // does not raise the answer's own level, and nothing below raises this
  // ceiling's argument above 0. Raising this ceiling further, or wiring
  // AiStructuredResponse.actionProposals (a different, broader mechanism,
  // untouched by Stage D) into an automatic proposeAIAction() call, remains
  // future work explicitly deferred by Build Instructions Part 15/30. This
  // still applies to every other respect of Grow and the Business Coach:
  // ctx.grow/ctx.coach remain plain, already-tenant-scoped data, never a
  // callable tool or authority claim in their own right.
  assertWithinAutoExecuteCeiling(0);

  const toolResults = await runAllTools(context);
  // AE GROW Priority 6: a coach-mode ask uses the Business Coach prompt; a
  // Grow-scoped (but not coach) ask uses the Grow Ask AE prompt (five-way
  // classification + wording hard constraints); every other contextType
  // keeps using copilot.ask.v1 exactly as before Stage B or Stage C existed.
  const promptKey = isCoachRequest ? "business.coach.grow.v1" : isGrowRequest ? "copilot.ask.grow.v1" : "copilot.ask.v1";
  const prompt = getPrompt(promptKey);
  const config = loadAiGatewayConfig();

  // AE GROW Priority 6: the non-Grow payload shape below
  // (brokerage/business/property/transaction/toolResults) is byte-for-byte
  // identical to what this function has always sent - RUN Copilot's prompt
  // payload is unchanged. A Grow-scoped (non-coach) ask sends
  // brokerage/grow/toolResults instead: property/transaction are always
  // null for contextType "grow" (contextEngine.ts) and would only add
  // noise, and business's activePropertyCount/upcomingSettlementCount
  // figures aren't part of Grow's own subject matter. A coach-mode ask
  // sends brokerage/coach/toolResults - ctx.coach already carries every
  // deterministic figure the model may reference; ctx.grow is deliberately
  // left out of the coach payload so the model is never handed two
  // different shapes of "the same underlying data" to reconcile itself.
  const contextPayload = isCoachRequest
    ? { brokerage: context.brokerage, coach: context.coach, toolResults }
    : isGrowRequest
    ? { brokerage: context.brokerage, grow: context.grow, toolResults }
    : { brokerage: context.brokerage, business: context.business, property: context.property, transaction: context.transaction, toolResults };

  const userPrompt = [
    `Agent question: ${input.question}`,
    "",
    "CONTEXT (JSON, already scoped to this agent's brokerage and permissions):",
    JSON.stringify(contextPayload, null, 2),
  ].join("\n");

  let generation;
  try {
    generation = await generateWithGateway(
      {
        systemPrompt: prompt.systemPrompt,
        userPrompt,
        model: config.model,
        temperature: config.temperature,
        maxOutputTokens: config.maxOutputTokens,
        timeoutMs: config.timeoutMs,
      },
      config
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI provider call failed";
    await logAiInteraction({
      requestId,
      brokerageId: input.brokerageId,
      userId: input.userId,
      aiRole: role,
      contextType: input.contextType ?? undefined,
      contextId: input.contextId ?? undefined,
      promptKey: prompt.key,
      promptVersion: prompt.version,
      question: input.question,
      riskLevel: 0,
      status: "error",
      errorMessage: message,
    });
    throw err;
  }

  const toolsUsed = toolResults.filter((result) => result.ok === true).map((result) => result.tool);

  let response: AiStructuredResponse;
  if (isCoachRequest && context.coach !== null) {
    const coach = context.coach;
    // Every field below (other than `summary`, the model's own narrative
    // text) is DETERMINISTIC - produced by coaching/responseBuilder.ts from
    // ctx.coach, never parsed out of or overridden by the model's response.
    // This is what makes the "no model-arithmetic" / "never let the model
    // recompute a metric" requirement true by construction rather than by
    // asking the model nicely in the prompt.
    response = {
      kind: "recommendation",
      summary: generation.response.text,
      details: toolResults.map((result) => (result.ok === true ? `${result.tool}: ok` : `${result.tool}: ${result.error ?? "no data"}`)),
      toolsUsed,
      riskLevel: 0,
      disclaimer:
        generation.usedFallback === true
          ? `Answered by the fallback AI provider (${generation.response.provider}) after the primary provider failed.`
          : undefined,
      headline: buildCoachHeadline(coach),
      period: coach.period,
      performanceSummary: buildCoachPerformanceSummary(coach),
      observations: buildCoachObservations(coach),
      strengths: buildCoachStrengths(coach),
      focusAreas: buildCoachFocusAreas(coach),
      recommendations: buildCoachRecommendations(coach),
      supportingMetrics: buildCoachSupportingMetrics(coach),
      dataFreshness: coach.asOf,
      limitations: buildCoachLimitations(coach),
      suggestedReviewDate: buildCoachSuggestedReviewDate(coach, new Date()),
    };
  } else {
    const kind = isGrowRequest ? classifyGrowResponseKind(toolResults) : classifyResponseKind(toolResults);
    response = {
      kind,
      summary: generation.response.text,
      details: toolResults.map((result) => (result.ok === true ? `${result.tool}: ok` : `${result.tool}: ${result.error ?? "no data"}`)),
      toolsUsed,
      riskLevel: 0,
      disclaimer:
        generation.usedFallback === true
          ? `Answered by the fallback AI provider (${generation.response.provider}) after the primary provider failed.`
          : undefined,
      // AE GROW Priority 6 Stage B — Response Contract additions. Left
      // undefined for every non-Grow request, exactly as before this stage
      // (these fields did not exist until this branch's types.ts commit, and
      // RUN Copilot never sets them).
      supportingRecords: isGrowRequest ? buildGrowSupportingRecords(context) : undefined,
      dataFreshness: isGrowRequest ? context.grow?.generatedAt : undefined,
      limitations: isGrowRequest ? GROW_LIMITATIONS : undefined,
      suggestedNextStep: isGrowRequest ? buildGrowSuggestedNextStep(context) : undefined,
    };
  }

  const responseKindForAudit = response.kind;

  const interactionId = await logAiInteraction({
    requestId,
    brokerageId: input.brokerageId,
    userId: input.userId,
    aiRole: role,
    contextType: input.contextType ?? undefined,
    contextId: input.contextId ?? undefined,
    promptKey: prompt.key,
    promptVersion: prompt.version,
    question: input.question,
    responseKind: responseKindForAudit,
    riskLevel: 0,
    status: "success",
  });

  if (interactionId !== null) {
    await logAiUsage({
      interactionId,
      provider: generation.response.provider,
      model: generation.response.model,
      promptTokens: generation.response.usage.promptTokens,
      completionTokens: generation.response.usage.completionTokens,
      totalTokens: generation.response.usage.totalTokens,
      estimatedCostUsd: generation.response.usage.estimatedCostUsd,
      latencyMs: generation.response.latencyMs,
    });
  }

  // AE GROW Priority 6 Stage D — additive only, and only for Grow-scoped
  // requests (ask or coach). See proposeGrowCommitmentIfGrounded's own
  // header comment for why this cannot be influenced by the model's own
  // text or by anything an untrusted third party wrote into a contact's
  // notes/activities. Wrapped in try/catch so that any failure here -- a
  // transient DB error, an unexpected policy denial -- is logged and
  // swallowed rather than turning a successful chat answer into a 500.
  if (isGrowRequest) {
    try {
      const proposal = await proposeGrowCommitmentIfGrounded(
        context,
        { id: input.userId, role: input.userRole, brokerageId: input.brokerageId },
        interactionId,
      );
      if (proposal !== undefined) {
        response.proposedCommitment = proposal;
      }
    } catch (err) {
      logger.error("grow_commitment_proposal_failed", { error: err, brokerageId: input.brokerageId, userId: input.userId });
    }
  }

  return { requestId, response };
}
