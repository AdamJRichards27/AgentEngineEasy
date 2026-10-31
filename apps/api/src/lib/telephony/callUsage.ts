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
 * Owner t225u: METERING ONLY. The t222u configuration-only caps (AE_CALL_USAGE_LIMITS) were removed: no
 * code path refuses a call, a recording or a transcription for usage, and no configuration can switch a
 * cap on. Caps return only with an approved commercial policy, as reviewed code. No allowance, no charge.
 */
export const CALL_USAGE_METRICS = ["calls", "minutes", "recordings", "transcriptions"] as const;
export type CallUsageMetric = (typeof CALL_USAGE_METRICS)[number];

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
