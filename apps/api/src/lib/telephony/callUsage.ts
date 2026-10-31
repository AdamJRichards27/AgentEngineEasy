import { and, count, eq, gte, lt, sql, sum } from "drizzle-orm";
import { db, documents, growCallSessions, growCallTranscriptions } from "@aee/db";

/**
 * Owner t222u (2026-10-31): configurable calling usage metering and limits.
 *
 * Metering needs NO new table: usage is derived per brokerage from rows that already exist:
 *   calls           grow_call_sessions created in the period
 *   minutes         sum(grow_call_sessions.duration_seconds), each call rounded UP to whole minutes
 *   recordings      documents with documentType "CallRecording" (logical owner "telephony-call") created in the period
 *   transcriptions  grow_call_transcriptions created in the period
 * Period: the current calendar month (UTC), [start of month, start of next month).
 *
 * Limits are CONFIGURATION, not a commercial schedule: AE_CALL_USAGE_LIMITS is a JSON object such as
 * {"calls":500,"minutes":2000}. Unset, empty, invalid, or a non-positive value means UNLIMITED for that
 * metric, which is the default for every metric until an approved commercial schedule exists. There is
 * no allowance and no charge anywhere in this module.
 */
export const CALL_USAGE_METRICS = ["calls", "minutes", "recordings", "transcriptions"] as const;
export type CallUsageMetric = (typeof CALL_USAGE_METRICS)[number];
export type CallUsageLimits = Record<CallUsageMetric, number | null>;

export interface CallUsage extends Record<CallUsageMetric, number> {
  brokerageId: number;
  periodStart: Date;
  periodEnd: Date;
}

export function callUsagePeriod(now: Date = new Date()): { periodStart: Date; periodEnd: Date } {
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { periodStart, periodEnd };
}

export function resolveCallUsageLimits(env: Record<string, string | undefined> = process.env): CallUsageLimits {
  const limits: CallUsageLimits = { calls: null, minutes: null, recordings: null, transcriptions: null };
  const raw = env.AE_CALL_USAGE_LIMITS;
  if (!raw || raw.trim() === "") return limits;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return limits; }
  if (!parsed || typeof parsed !== "object") return limits;
  for (const m of CALL_USAGE_METRICS) {
    const v = (parsed as Record<string, unknown>)[m];
    if (typeof v === "number" && Number.isInteger(v) && v > 0) limits[m] = v;
  }
  return limits;
}

export async function getCallUsage(brokerageId: number, now: Date = new Date()): Promise<CallUsage> {
  const { periodStart, periodEnd } = callUsagePeriod(now);
  const inSessions = and(eq(growCallSessions.brokerageId, brokerageId), gte(growCallSessions.createdAt, periodStart), lt(growCallSessions.createdAt, periodEnd));
  const [calls] = await db.select({ n: count() }).from(growCallSessions).where(inSessions);
  const [mins] = await db
    .select({ m: sum(sqlCeilMinutes()) })
    .from(growCallSessions)
    .where(inSessions);
  const [recs] = await db.select({ n: count() }).from(documents).where(and(
    eq(documents.brokerageId, brokerageId), eq(documents.documentType, "CallRecording"), eq(documents.logicalOwnerType, "telephony-call"),
    gte(documents.createdAt, periodStart), lt(documents.createdAt, periodEnd),
  ));
  const [trans] = await db.select({ n: count() }).from(growCallTranscriptions).where(and(
    eq(growCallTranscriptions.brokerageId, brokerageId), gte(growCallTranscriptions.createdAt, periodStart), lt(growCallTranscriptions.createdAt, periodEnd),
  ));
  return {
    brokerageId, periodStart, periodEnd,
    calls: Number(calls?.n ?? 0),
    minutes: Number(mins?.m ?? 0),
    recordings: Number(recs?.n ?? 0),
    transcriptions: Number(trans?.n ?? 0),
  };
}

function sqlCeilMinutes() {
  return sql<number>`ceil(coalesce(${growCallSessions.durationSeconds}, 0) / 60.0)`;
}

export interface CallUsageDecision { allowed: boolean; metric: CallUsageMetric; used: number; limit: number | null }

/** Allowed unless a limit is configured for the metric and the brokerage's usage this period has reached it. */
export async function checkCallUsage(
  brokerageId: number,
  metric: CallUsageMetric,
  limits: Partial<CallUsageLimits> = resolveCallUsageLimits(),
): Promise<CallUsageDecision> {
  const limit = limits[metric] ?? null;
  if (limit === null) return { allowed: true, metric, used: 0, limit: null };
  const usage = await getCallUsage(brokerageId);
  return { allowed: usage[metric] < limit, metric, used: usage[metric], limit };
}
