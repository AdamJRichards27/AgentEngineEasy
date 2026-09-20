import { and, count, eq, inArray, sql } from "drizzle-orm";
import { db, aiInteractions } from "@aee/db";
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

export interface AiUsageSnapshot {
  brokerageId: number;
  tier: SubscriptionTier;
  /** Whether a breached limit actually refuses requests right now. */
  enforced: boolean;
  /** True while the brokerage ceiling is the provisional TIER_CAPABILITIES number. */
  usesProvisionalBrokerageCeiling: boolean;
  brokerage: AiUsageScopeView;
  user: (AiUsageScopeView & { userId: number }) | null;
  /** Per-user counts inside this brokerage; only populated when the caller asks for it. */
  users?: { userId: number; used: number }[];
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
  const counts = await countAiRequestsToday(input.brokerageId, input.userId);

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
  };

  if (input.includeUserBreakdown === true) {
    const rows = await db
      .select({ userId: aiInteractions.userId, used: count() })
      .from(aiInteractions)
      .where(
        and(
          eq(aiInteractions.brokerageId, input.brokerageId),
          inArray(aiInteractions.status, [...COUNTED_AI_INTERACTION_STATUSES]),
          SINCE_UTC_MIDNIGHT,
        ),
      )
      .groupBy(aiInteractions.userId);
    snapshot.users = rows
      .map((row) => ({ userId: row.userId, used: Number(row.used) }))
      .sort((a, b) => b.used - a.used || a.userId - b.userId);
  }

  return snapshot;
}
