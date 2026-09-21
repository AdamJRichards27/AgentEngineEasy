import { and, count, countDistinct, eq, inArray, sql } from "drizzle-orm";
import { db, aiInteractions, aiUsage } from "@aee/db";
import { resolveBrokerageTier } from "./entitlements.js";
import { getEffectiveAiUsageLimits, type ResolvedAiUsageLimits } from "./usageLimits.js";
import type { SubscriptionTier } from "./types.js";

/**
 * AE GROW Pilot Readiness WP1 (P1-3) — durable daily AI request limits.
 * AE GROW post-merge hardening — extended from one per-brokerage cap to TWO independent
 * limits (per user and per brokerage), with the numbers resolved by lib/ai/usageLimits.ts
 * rather than hardcoded here. This module now owns only the DURABLE COUNTING and the refusal;
 * it decides no numbers of its own.
 *
 * Counting is derived from the durable AI Audit Layer (ai_interactions — one row per
 * askCopilot() request, see lib/ai/audit.ts), so it survives restarts and is shared by every
 * API process, unlike the in-memory per-process sliding windows in growRateLimiter.ts /
 * voice/voiceRateLimiter.ts.
 *
 * METERING IS NOT ENFORCEMENT. Every request is recorded by logAiInteraction() regardless of
 * whether any limit is configured or enforced, so the counts below (and getAiUsageSnapshot()'s
 * inspection surface) are correct and queryable in the pilot's mock-provider default, where
 * nothing is throttled at all.
 *
 * What counts: ai_interactions rows for this brokerage, created since 00:00 UTC today, whose
 * status is "success" or "error" — i.e. requests that actually reached the provider gateway
 * (askCopilot() writes "error" only from its provider-call catch). Requests blocked before any
 * provider call (blocked_flag / blocked_permission / blocked_entitlement — including requests
 * refused by these limits themselves) are NOT counted, so being refused never consumes quota.
 *
 * The UTC day boundary is computed inside Postgres: created_at is a timestamp WITHOUT time zone
 * written by defaultNow() in the session time zone, so comparing it against a timestamptz UTC
 * midnight makes Postgres interpret created_at in that same session time zone — correct
 * whatever the server's TimeZone setting is.
 *
 * Known limitation (documented, accepted for the pilot): this is a check-then-act soft limit. N
 * concurrent requests arriving while a count is exactly limit-1 can each pass the check, so a
 * limit can be exceeded by at most the number of in-flight concurrent requests for one
 * brokerage/user (which the in-memory rate limiters already bound further). No table was added
 * for any of this: both scopes are answered from the ai_interactions rows that already exist.
 *
 * The window is wider than "check-then-act" alone suggests, and W2-C could not narrow it from
 * here because the fix belongs in files this slice does not own. The check runs at
 * orchestrator.ts:626, but the row that makes the request countable is not written until
 * orchestrator.ts:805-818 — AFTER the provider round trip — so every concurrent request is
 * uncounted for the whole duration of the provider call, not for a few milliseconds. Worse,
 * audit.ts:58-61 swallows an insert failure and returns null, at which point logAiUsage() is
 * skipped too and a request that has already cost real money is never metered at all, silently.
 * Narrowing this means writing the interaction row BEFORE the provider call and updating it
 * after (orchestrator.ts), and surfacing rather than swallowing the insert failure (audit.ts);
 * both are reported to the Project Owner rather than attempted here.
 *
 * Voice transcription (routes/aiVoice.ts) writes NO durable per-request record (by design — see
 * that route's own header comment), so voice requests are not themselves counted; the voice
 * route instead refuses to transcribe once the user's or the brokerage's durable Ask/Coach count
 * for today has reached its limit (a transcript is only ever useful as input to an Ask/Coach
 * request, which would itself be refused).
 */

export const COUNTED_AI_INTERACTION_STATUSES = ["success", "error"] as const;

/** Which limit a refusal was for. */
export type AiUsageLimitScopeName = "user" | "brokerage";

export class AiDailyCapExceededError extends Error {
  readonly tier: SubscriptionTier;
  readonly limit: number;
  readonly scope: AiUsageLimitScopeName;
  constructor(tier: SubscriptionTier, limit: number, scope: AiUsageLimitScopeName = "brokerage") {
    super(
      scope === "user"
        ? `You have reached your daily limit of ${limit} AI requests. The limit resets at 00:00 UTC.`
        : `Your brokerage has reached its daily limit of ${limit} AI requests on the ${tier} plan. ` +
          "The limit resets at 00:00 UTC.",
    );
    this.name = "AiDailyCapExceededError";
    this.tier = tier;
    this.limit = limit;
    this.scope = scope;
  }
}

/** See the module comment: created_at compared against today's 00:00 UTC, computed in Postgres. */
const SINCE_UTC_MIDNIGHT = sql`${aiInteractions.createdAt} >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

export interface AiRequestCountsToday {
  /** Provider-reaching AI requests recorded for this brokerage since 00:00 UTC today. */
  brokerage: number;
  /** The same, narrowed to one user — null when no user was asked about. */
  user: number | null;
}

/**
 * Both counts in ONE round trip (a filtered aggregate), rather than two COUNT queries on the
 * same rows: every AI request runs this on its hot path.
 *
 * Tenant scoping: the userId predicate is applied IN ADDITION to the brokerageId predicate, so a
 * user id belonging to another brokerage can only ever count zero — it can never read another
 * tenant's rows, whatever the caller passes.
 */
export async function countAiRequestsToday(brokerageId: number, userId?: number): Promise<AiRequestCountsToday> {
  const [row] = await db
    .select({
      // Not keyed "user": drizzle aliases a selected expression with its key, and `user` is a
      // reserved word in Postgres.
      brokerageCount: count(),
      userCount:
        userId === undefined
          ? sql<number>`0`
          : sql<number>`count(*) filter (where ${aiInteractions.userId} = ${userId})`,
    })
    .from(aiInteractions)
    .where(
      and(
        eq(aiInteractions.brokerageId, brokerageId),
        inArray(aiInteractions.status, [...COUNTED_AI_INTERACTION_STATUSES]),
        SINCE_UTC_MIDNIGHT,
      ),
    );
  return {
    brokerage: Number(row?.brokerageCount ?? 0),
    user: userId === undefined ? null : Number(row?.userCount ?? 0),
  };
}

/** Provider-reaching AI requests recorded for this brokerage since 00:00 UTC today. */
export async function countBrokerageAiRequestsToday(brokerageId: number): Promise<number> {
  return (await countAiRequestsToday(brokerageId)).brokerage;
}

/** The same, for one user inside that brokerage (always scoped by BOTH ids — see above). */
export async function countUserAiRequestsToday(brokerageId: number, userId: number): Promise<number> {
  return (await countAiRequestsToday(brokerageId, userId)).user ?? 0;
}

// ---------------------------------------------------------------------------
// AE GROW W2-C — reading ai_usage back (C-10).
//
// ai_usage (packages/db/src/schema/ai.ts) has been written on every successful
// request since the AI Audit Layer landed and had NO readers anywhere, so the
// only question the platform could answer about AI consumption was "how many
// requests?" — under which one Business Coach call carrying a 14-query JSON
// context costs exactly as much as a one-word question. Everything below is
// READ-ONLY reporting. It deliberately changes nothing about enforcement:
// assertDailyAiLimitsNotReached() still counts requests and only requests.
// Whether a ceiling should be denominated in tokens or dollars, and at what
// number, is a commercial decision the Project Owner has reserved for pilot
// evidence — the point of this code is to produce that evidence.
//
// Cost caveat, stated wherever the number is: estimatedCostUsd is whatever the
// provider adapter estimated at call time (providers/anthropicProvider.ts
// applies a hardcoded Sonnet-class rate; mockProvider reports 0). It is
// telemetry for sizing exposure, never a billing figure and never a
// reconciliation against a provider invoice.
//
// Cost of reading: one extra aggregate and, for administrators, two extra
// grouped aggregates, all over the SAME same-day ai_interactions rows the
// request counts already scan. Selecting those rows uses the
// (brokerage_id, created_at) index on ai_interactions added by PR #50's
// batched migration (0028).
//
// Each of those three reads then JOINS TO ai_usage ON ai_usage.interaction_id
// — a foreign key, not a primary key, and Postgres creates no index for a
// foreign key. Before this slice the only index on ai_usage was its primary
// key on `id`, which nothing here joins to, so every one of these reads
// sequentially scanned the whole tenant-mixed table to reach the few hundred
// rows belonging to today. That matters more on this table than most:
// ai_usage gains a row per successful AI request forever with no retention
// policy, so the cost grew with lifetime platform usage rather than with
// today's traffic, and an administrator's snapshot paid it three times.
//
// So this slice DOES add a migration: 0029 creates
// ai_usage_interaction_idx on ai_usage (interaction_id), declared on the
// table in packages/db/src/schema/ai.ts. The plan is asserted at a fixture
// size where a sequential scan would otherwise be chosen, in
// routes/__tests__/aiUsageQueryPlan.test.ts.
// ---------------------------------------------------------------------------

/** Token and cost totals for a set of same-day interactions. */
export interface AiTokenUsageTotals {
  /**
   * Interactions in scope that carry an ai_usage row. Lower than the request
   * count by design: usage is only written when a provider actually answered,
   * so `requests - meteredRequests` is the number of same-day requests whose
   * token cost is unknown (errors, and — see logAiUsage's catch in audit.ts —
   * any row whose insert failed).
   */
  meteredRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Provider-estimated, telemetry only — see the section comment above. */
  estimatedCostUsd: number;
}

const ZERO_TOKENS: AiTokenUsageTotals = {
  meteredRequests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: 0,
};

/**
 * numeric/bigint aggregates arrive from pg as strings (and as null when no row
 * matched), so every one of them is normalised here rather than at each use.
 */
function toNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Selected columns shared by the brokerage-wide and per-user token aggregates. */
const tokenSums = {
  promptTokens: sql<string>`coalesce(sum(${aiUsage.promptTokens}), 0)`,
  completionTokens: sql<string>`coalesce(sum(${aiUsage.completionTokens}), 0)`,
  totalTokens: sql<string>`coalesce(sum(${aiUsage.totalTokens}), 0)`,
  estimatedCostUsd: sql<string>`coalesce(sum(${aiUsage.estimatedCostUsd}), 0)`,
};

function totalsFrom(row: { metered: unknown; promptTokens: unknown; completionTokens: unknown; totalTokens: unknown; estimatedCostUsd: unknown } | undefined): AiTokenUsageTotals {
  if (row === undefined) return { ...ZERO_TOKENS };
  return {
    meteredRequests: toNumber(row.metered),
    promptTokens: toNumber(row.promptTokens),
    completionTokens: toNumber(row.completionTokens),
    totalTokens: toNumber(row.totalTokens),
    estimatedCostUsd: toNumber(row.estimatedCostUsd),
  };
}

export interface AiTokenUsageToday {
  brokerage: AiTokenUsageTotals;
  /** null when no user was asked about. */
  user: AiTokenUsageTotals | null;
}

/**
 * Both scopes in one round trip, exactly like countAiRequestsToday(): a
 * filtered aggregate over the inner join rather than two passes.
 *
 * Tenant scoping is identical to the request counts — the userId predicate is
 * applied IN ADDITION to brokerageId, so a user id from another brokerage can
 * only ever total zero. The day boundary and the counted statuses are the same
 * expressions the ceilings use, so tokens and requests always describe exactly
 * the same set of interactions.
 */
export async function sumAiTokenUsageToday(brokerageId: number, userId?: number): Promise<AiTokenUsageToday> {
  // `0` rather than the filtered aggregate when no user was asked about, so the
  // selected shape stays constant and this function has exactly one query form.
  const onlyThisUser = userId === undefined ? undefined : sql`(where ${aiInteractions.userId} = ${userId})`;
  const forUser = (expression: ReturnType<typeof sql>) => (onlyThisUser === undefined ? sql<string>`0` : sql<string>`coalesce(${expression} filter ${onlyThisUser}, 0)`);

  const [row] = await db
    .select({
      metered: count(),
      ...tokenSums,
      userMetered: onlyThisUser === undefined ? sql<string>`0` : sql<string>`count(*) filter ${onlyThisUser}`,
      userPromptTokens: forUser(sql`sum(${aiUsage.promptTokens})`),
      userCompletionTokens: forUser(sql`sum(${aiUsage.completionTokens})`),
      userTotalTokens: forUser(sql`sum(${aiUsage.totalTokens})`),
      userEstimatedCostUsd: forUser(sql`sum(${aiUsage.estimatedCostUsd})`),
    })
    .from(aiUsage)
    .innerJoin(aiInteractions, eq(aiUsage.interactionId, aiInteractions.id))
    .where(
      and(
        eq(aiInteractions.brokerageId, brokerageId),
        inArray(aiInteractions.status, [...COUNTED_AI_INTERACTION_STATUSES]),
        SINCE_UTC_MIDNIGHT,
      ),
    );

  if (userId === undefined) return { brokerage: totalsFrom(row), user: null };
  return {
    brokerage: totalsFrom(row),
    user:
      row === undefined
        ? { ...ZERO_TOKENS }
        : totalsFrom({
            metered: row.userMetered,
            promptTokens: row.userPromptTokens,
            completionTokens: row.userCompletionTokens,
            totalTokens: row.userTotalTokens,
            estimatedCostUsd: row.userEstimatedCostUsd,
          }),
  };
}

export { isDailyAiCapEnforced } from "./usageLimits.js";

export interface AssertDailyAiLimitsInput {
  brokerageId: number;
  userId: number;
  /** May be passed when the caller already resolved it; otherwise it is resolved here. */
  tier?: SubscriptionTier;
}

/**
 * Throws AiDailyCapExceededError when this request would exceed EITHER the per-user daily limit
 * or the brokerage-level daily safety ceiling. Must be called before any provider call.
 *
 * Throws AiUsageLimitsNotConfiguredError (usageLimits.ts) instead if a live AI provider is
 * approved while either limit is unconfigured — failing closed rather than quietly applying a
 * provisional technical number as if it were a commercial allowance.
 *
 * The per-user limit is checked first: when both are breached, "you have used your own
 * allowance" is the more actionable of the two messages.
 */
export async function assertDailyAiLimitsNotReached(input: AssertDailyAiLimitsInput): Promise<void> {
  const tier = input.tier ?? (await resolveBrokerageTier(input.brokerageId));
  // Throws when a live provider is approved while either limit is unconfigured; a no-op in the
  // pilot's mock-provider default, where nothing is enforced (see usageLimits.ts).
  const limits = getEffectiveAiUsageLimits(tier);
  if (!limits.enforced) return;
  if (limits.perUser.limit === null && limits.perBrokerage.limit === null) return;

  const counts = await countAiRequestsToday(input.brokerageId, limits.perUser.limit === null ? undefined : input.userId);

  if (limits.perUser.limit !== null && (counts.user ?? 0) >= limits.perUser.limit) {
    throw new AiDailyCapExceededError(tier, limits.perUser.limit, "user");
  }
  if (limits.perBrokerage.limit !== null && counts.brokerage >= limits.perBrokerage.limit) {
    throw new AiDailyCapExceededError(tier, limits.perBrokerage.limit, "brokerage");
  }
}

export interface AiUsageScopeView {
  used: number;
  /** null when no limit applies to this scope (unset, or explicitly disabled). */
  limit: number | null;
  /** null when there is no limit; otherwise how many requests are left today (never negative). */
  remaining: number | null;
}

/**
 * Shape of consumption across the brokerage's active users today. "Active"
 * means "made at least one provider-reaching AI request today" — a user who
 * asked nothing is not a zero in this distribution, they are absent from it,
 * because the question the pilot needs answered is about the people actually
 * using the feature.
 *
 * Computed alongside the per-user breakdown and gated the same way: these are
 * brokerage-oversight numbers, not something an individual agent needs.
 */
export interface AiUsageDistribution {
  activeUsers: number;
  /** Requests per active user today: the middle value (mean of the two middle values when even). */
  medianRequestsPerActiveUser: number;
  /** Nearest-rank p90 — the "heaviest realistic user" number for sizing. */
  p90RequestsPerActiveUser: number;
  maxRequestsPerActiveUser: number;
  /** Same three, for tokens rather than requests. Zero while the mock provider is in use. */
  medianTotalTokensPerActiveUser: number;
  p90TotalTokensPerActiveUser: number;
  maxTotalTokensPerActiveUser: number;
}

/** One AI capability (aiInteractions.aiRole, e.g. "copilot" / "business_coach"). */
export interface AiUsageByRole {
  aiRole: string;
  requests: number;
  tokens: AiTokenUsageTotals;
}

export interface AiUsageSnapshot {
  brokerageId: number;
  tier: SubscriptionTier;
  /** Whether a breached limit actually refuses requests right now. */
  enforced: boolean;
  /** True while the brokerage ceiling is the provisional TIER_CAPABILITIES number. */
  usesProvisionalBrokerageCeiling: boolean;
  brokerage: AiUsageScopeView;
  user: (AiUsageScopeView & { userId: number }) | null;
  /**
   * Tokens and estimated cost for exactly the same interactions `brokerage`/`user`
   * count as requests. Additive: the request-counting fields above are unchanged,
   * and NOTHING here is enforced against — see the ai_usage section comment.
   */
  tokens: AiTokenUsageToday;
  /** Always present next to a cost figure so it is never mistaken for a bill. */
  costEstimateBasis: string;
  /** Per-user counts inside this brokerage; only populated when the caller asks for it. */
  users?: { userId: number; used: number; tokens: AiTokenUsageTotals }[];
  /** Per-capability split; populated with `users`. */
  byRole?: AiUsageByRole[];
  /** Median/p90/max across active users; populated with `users`. */
  distribution?: AiUsageDistribution;
}

export const AI_COST_ESTIMATE_BASIS =
  "Provider-estimated at call time (the mock provider reports 0); telemetry for sizing exposure only, not a billing figure.";

/** Nearest-rank percentile over an ascending-sorted array; 0 for an empty one. */
function percentile(sortedAscending: number[], fraction: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.ceil(fraction * sortedAscending.length);
  return sortedAscending[Math.min(sortedAscending.length, Math.max(1, rank)) - 1] ?? 0;
}

function median(sortedAscending: number[]): number {
  const n = sortedAscending.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? (sortedAscending[mid] ?? 0) : ((sortedAscending[mid - 1] ?? 0) + (sortedAscending[mid] ?? 0)) / 2;
}

function distributionOf(users: { used: number; tokens: AiTokenUsageTotals }[]): AiUsageDistribution {
  const active = users.filter((u) => u.used > 0);
  const requests = active.map((u) => u.used).sort((a, b) => a - b);
  const tokens = active.map((u) => u.tokens.totalTokens).sort((a, b) => a - b);
  return {
    activeUsers: active.length,
    medianRequestsPerActiveUser: median(requests),
    p90RequestsPerActiveUser: percentile(requests, 0.9),
    maxRequestsPerActiveUser: requests[requests.length - 1] ?? 0,
    medianTotalTokensPerActiveUser: median(tokens),
    p90TotalTokensPerActiveUser: percentile(tokens, 0.9),
    maxTotalTokensPerActiveUser: tokens[tokens.length - 1] ?? 0,
  };
}

function scopeView(used: number, limit: number | null): AiUsageScopeView {
  return { used, limit, remaining: limit === null ? null : Math.max(0, limit - used) };
}

export interface AiUsageSnapshotInput {
  brokerageId: number;
  /** Include this user's own usage. Always counted within brokerageId — never across tenants. */
  userId?: number;
  tier?: SubscriptionTier;
  /** Per-user breakdown for the whole brokerage (ids and counts only — no PII). */
  includeUserBreakdown?: boolean;
  /** Pre-resolved limits, when the caller already has them. */
  limits?: ResolvedAiUsageLimits;
}

/**
 * Read-only inspection of today's AI usage, for one brokerage and optionally one of its users.
 *
 * Always tenant-scoped by brokerageId, including the per-user breakdown, so there is no shape of
 * this call that can read another brokerage's usage. Returns ids and counts only — never a
 * question, a response, an email address or any other PII.
 *
 * Correct regardless of enforcement: the counts come from the durable audit rows, which are
 * written whether or not any limit is configured (see the module comment on metering).
 */
export async function getAiUsageSnapshot(input: AiUsageSnapshotInput): Promise<AiUsageSnapshot> {
  const tier = input.tier ?? (await resolveBrokerageTier(input.brokerageId));
  // Deliberately resolveAiUsageLimits-via-getEffective: an inspection call in a
  // misconfigured live process should report the same fail-closed fault the AI routes do,
  // rather than display a limit that is not actually in force.
  const limits = input.limits ?? getEffectiveAiUsageLimits(tier);
  const [counts, tokens] = await Promise.all([
    countAiRequestsToday(input.brokerageId, input.userId),
    sumAiTokenUsageToday(input.brokerageId, input.userId),
  ]);

  const snapshot: AiUsageSnapshot = {
    brokerageId: input.brokerageId,
    tier,
    enforced: limits.enforced,
    usesProvisionalBrokerageCeiling: limits.perBrokerage.provisionalFallback,
    brokerage: scopeView(counts.brokerage, limits.perBrokerage.limit),
    user:
      input.userId === undefined
        ? null
        : { userId: input.userId, ...scopeView(counts.user ?? 0, limits.perUser.limit) },
    tokens,
    costEstimateBasis: AI_COST_ESTIMATE_BASIS,
  };

  if (input.includeUserBreakdown === true) {
    // LEFT join, not inner: a user whose requests all errored has interactions
    // but no ai_usage rows, and must still appear with used > 0 and zero
    // tokens rather than vanish from the breakdown. countDistinct on the
    // interaction id keeps `used` identical to countAiRequestsToday()'s number
    // even if an interaction ever gained a second usage row.
    const scope = and(
      eq(aiInteractions.brokerageId, input.brokerageId),
      inArray(aiInteractions.status, [...COUNTED_AI_INTERACTION_STATUSES]),
      SINCE_UTC_MIDNIGHT,
    );
    const [userRows, roleRows] = await Promise.all([
      db
        .select({ userId: aiInteractions.userId, used: countDistinct(aiInteractions.id), metered: count(aiUsage.id), ...tokenSums })
        .from(aiInteractions)
        .leftJoin(aiUsage, eq(aiUsage.interactionId, aiInteractions.id))
        .where(scope)
        .groupBy(aiInteractions.userId),
      db
        .select({ aiRole: aiInteractions.aiRole, used: countDistinct(aiInteractions.id), metered: count(aiUsage.id), ...tokenSums })
        .from(aiInteractions)
        .leftJoin(aiUsage, eq(aiUsage.interactionId, aiInteractions.id))
        .where(scope)
        .groupBy(aiInteractions.aiRole),
    ]);

    snapshot.users = userRows
      .map((row) => ({ userId: row.userId, used: toNumber(row.used), tokens: totalsFrom(row) }))
      .sort((a, b) => b.used - a.used || a.userId - b.userId);
    snapshot.byRole = roleRows
      .map((row) => ({ aiRole: row.aiRole, requests: toNumber(row.used), tokens: totalsFrom(row) }))
      .sort((a, b) => b.requests - a.requests || a.aiRole.localeCompare(b.aiRole));
    snapshot.distribution = distributionOf(snapshot.users);
  }

  return snapshot;
}
