import { and, count, eq, inArray, sql } from "drizzle-orm";
import { db, aiInteractions } from "@aee/db";
import { resolveBrokerageTier, TIER_CAPABILITIES } from "./entitlements.js";
import type { SubscriptionTier } from "./types.js";

/**
 * AE GROW Pilot Readiness WP1 (P1-3) — durable, per-brokerage daily AI request cap.
 *
 * TIER_CAPABILITIES.maxAiRequestsPerDay (entitlements.ts) was previously defined but never
 * enforced; the only limits in force were the in-memory, per-process sliding windows in
 * growRateLimiter.ts / voice/voiceRateLimiter.ts, which reset on every restart and are not
 * shared across processes. This cap is instead derived from the durable AI Audit Layer
 * (ai_interactions — one row per askCopilot() request, see lib/ai/audit.ts), so it survives
 * restarts and is shared by every API process.
 *
 * What counts: ai_interactions rows for this brokerage, created since 00:00 UTC today, whose
 * status is "success" or "error" — i.e. requests that actually reached the provider gateway
 * (askCopilot() writes "error" only from its provider-call catch). Requests blocked before any
 * provider call (blocked_flag / blocked_permission / blocked_entitlement — including requests
 * refused by this cap itself) are NOT counted, so being refused never consumes quota.
 *
 * The UTC day boundary is computed inside Postgres: created_at is a timestamp WITHOUT time zone
 * written by defaultNow() in the session time zone, so comparing it against a timestamptz UTC
 * midnight makes Postgres interpret created_at in that same session time zone — correct
 * whatever the server's TimeZone setting is.
 *
 * Known limitation (documented, accepted for the pilot): this is a check-then-act soft cap. N
 * concurrent requests arriving while the count is exactly cap-1 can each pass the check, so the
 * cap can be exceeded by at most the number of in-flight concurrent requests for one brokerage
 * (which the in-memory per-brokerage rate limiters already bound further). No table was added.
 *
 * Voice transcription (routes/aiVoice.ts) writes NO durable per-request record (by design — see
 * that route's own header comment), so voice requests are not themselves counted; the voice
 * route instead refuses to transcribe once the brokerage's durable Ask/Coach count for today has
 * reached the cap (a transcript is only ever useful as input to an Ask/Coach request, which
 * would itself be refused).
 */

export const COUNTED_AI_INTERACTION_STATUSES = ["success", "error"] as const;

export class AiDailyCapExceededError extends Error {
  readonly tier: SubscriptionTier;
  readonly limit: number;
  constructor(tier: SubscriptionTier, limit: number) {
    super(
      `Your brokerage has reached its daily limit of ${limit} AI requests on the ${tier} plan. ` +
        "The limit resets at 00:00 UTC.",
    );
    this.name = "AiDailyCapExceededError";
    this.tier = tier;
    this.limit = limit;
  }
}

/** Provider-reaching AI requests recorded for this brokerage since 00:00 UTC today. */
export async function countBrokerageAiRequestsToday(brokerageId: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(aiInteractions)
    .where(
      and(
        eq(aiInteractions.brokerageId, brokerageId),
        inArray(aiInteractions.status, [...COUNTED_AI_INTERACTION_STATUSES]),
        sql`${aiInteractions.createdAt} >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
      ),
    );
  return Number(row?.value ?? 0);
}

/**
 * Throws AiDailyCapExceededError when the brokerage has already used its tier's daily quota.
 * Must be called before any provider call. `tier` may be passed when the caller already
 * resolved it (it is always resolved via resolveBrokerageTier()); otherwise it is resolved here.
 */
export async function assertDailyAiCapNotReached(brokerageId: number, tier?: SubscriptionTier): Promise<void> {
  const resolvedTier = tier ?? (await resolveBrokerageTier(brokerageId));
  const limit = TIER_CAPABILITIES[resolvedTier].maxAiRequestsPerDay;
  const used = await countBrokerageAiRequestsToday(brokerageId);
  if (used >= limit) {
    throw new AiDailyCapExceededError(resolvedTier, limit);
  }
}
