// Owner t181u(B): notice-period collection scheduler for the AE Pit Crew
// service fee.
//
// A system-initiated tick that finds fees which have become due — a request
// in NOTICE_SENT whose contractual notice period has passed, or a stored-card
// request in RETRY_SCHEDULED whose backoff (next_attempt_at, t181u(C)) is
// due — and hands each one to collectPitCrewServiceFee with trigger
// "scheduler". That workflow RE-GATES EVERYTHING at run time (issued
// itemised statement to the authorised payer, settlement, both written
// confirmations, finalised fee, valid authority, notice period, retry
// backoff, single in-flight/succeeded charge under a row lock). Nothing is
// collected here directly.
//
// Safety:
//   * OFF by default: registerServiceFeeCollectionScheduler() starts a timer
//     only when NODE_ENV !== "test" AND PC_FEE_COLLECTION_SCHEDULER_ENABLED
//     === "true"; that flag is enabled nowhere. Registration is not activation.
//   * Mock/sandbox providers only: the whole tick is skipped (fail closed)
//     unless the card provider is the MockPaymentProvider and the mandate
//     provider is the sandbox adapter.
//   * Idempotent and concurrency safe: one tick at a time across processes
//     (session advisory try-lock; a busy lock skips the tick), plus the
//     existing row locks and partial unique indexes on each payment request.
//   * PROCESSING / UNKNOWN requests are never picked: an UNKNOWN card charge
//     is never retried automatically (a Brokerage Administrator resolves it).
//   * No HTTP route: Pit Crew (or anyone) cannot trigger a payment through it.
//   * Every attempt and refusal is audited (system actor, value-free).
import { and, asc, eq, inArray, isNotNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db, financialPaymentRequests, pcFeeAuthorities, pool } from "@aee/db";
import { logger } from "@aee/events";
import { cardProviderPermitted } from "./pcFeeCardCharges.js";
import { mandatePaymentProvider } from "./provider.js";
import { collectPitCrewServiceFee, ServiceFeeCollectionError, type ServiceFeeCollectionCode, type ServiceFeeCollectionOutcome } from "../pitCrewServiceFee.js";

/** Advisory lock key pair (namespace, id) for the tick. */
const LOCK_NS = 181;
const LOCK_ID = 2;

export interface SchedulerItemResult {
  paymentRequestId: number;
  transactionId: number;
  outcome?: ServiceFeeCollectionOutcome;
  code?: ServiceFeeCollectionCode | "SERVICE_FEE_COLLECTION_FAILED";
}
export interface SchedulerTickResult {
  skipped?: "LOCKED" | "PROVIDER_NOT_PERMITTED";
  results: SchedulerItemResult[];
}

/** Fail closed: only the mock card provider and the sandbox mandate provider. */
export function schedulerProvidersPermitted(): boolean {
  return cardProviderPermitted() && mandatePaymentProvider.name === "sandbox";
}

async function dueCandidates(now: Date, limit: number, brokerageIds?: number[]) {
  const noticeElapsed = and(
    eq(financialPaymentRequests.status, "NOTICE_SENT"),
    isNotNull(financialPaymentRequests.noticeSentAt),
    sql`${financialPaymentRequests.noticeSentAt} + make_interval(days => ${pcFeeAuthorities.noticeRequiredDays}) <= ${now}`,
  );
  const retryDue = and(
    eq(financialPaymentRequests.status, "RETRY_SCHEDULED"),
    eq(pcFeeAuthorities.authorisedPaymentMethod, "STORED_CARD"),
    isNotNull(financialPaymentRequests.nextAttemptAt),
    lte(financialPaymentRequests.nextAttemptAt, now),
  );
  const conds: SQL[] = [eq(financialPaymentRequests.kind, "PC_SUCCESS_FEE"), or(noticeElapsed, retryDue)!];
  if (brokerageIds) conds.push(inArray(financialPaymentRequests.brokerageId, brokerageIds.length ? brokerageIds : [-1]));
  return db
    .select({ id: financialPaymentRequests.id, brokerageId: financialPaymentRequests.brokerageId, transactionId: financialPaymentRequests.transactionId, status: financialPaymentRequests.status })
    .from(financialPaymentRequests)
    .innerJoin(pcFeeAuthorities, eq(pcFeeAuthorities.id, financialPaymentRequests.pcFeeAuthorityId))
    .where(and(...conds))
    .orderBy(asc(financialPaymentRequests.id))
    .limit(limit);
}

/**
 * One scheduler pass. `brokerageIds` scopes the pass (tests only; the
 * registered timer passes none). Never throws for a single item.
 */
export async function runServiceFeeCollectionTick(input: { now?: Date; limit?: number; brokerageIds?: number[] } = {}): Promise<SchedulerTickResult> {
  if (!schedulerProvidersPermitted()) {
    logger.warn("pc_fee_scheduler_skipped", { reason: "PROVIDER_NOT_PERMITTED" });
    return { skipped: "PROVIDER_NOT_PERMITTED", results: [] };
  }
  const client = await pool.connect();
  let locked = false;
  try {
    const got = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1, $2) as ok", [LOCK_NS, LOCK_ID]);
    locked = got.rows[0]?.ok === true;
    if (!locked) return { skipped: "LOCKED", results: [] };
    const now = input.now ?? new Date();
    const limit = Math.min(Math.max(1, input.limit ?? 50), 500);
    const candidates = await dueCandidates(now, limit, input.brokerageIds);
    const results: SchedulerItemResult[] = [];
    for (const cand of candidates) results.push(await collectOne(cand));
    return { results };
  } finally {
    if (locked) await client.query("select pg_advisory_unlock($1, $2)", [LOCK_NS, LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

async function collectOne(cand: { id: number; brokerageId: number; transactionId: number; status: string }): Promise<SchedulerItemResult> {
  const { logAudit } = await import("../audit.js");
  const base = { paymentRequestId: cand.id, transactionId: cand.transactionId };
  let result: SchedulerItemResult;
  let propertyId: number | null = null;
  let extra: Record<string, unknown> = {};
  try {
    // System caller: no user, no role-based shortcut beyond the documented system trigger; every gate re-checked.
    const r = await collectPitCrewServiceFee({ id: 0, role: "System", brokerageId: cand.brokerageId }, cand.transactionId, { trigger: "scheduler" });
    propertyId = r.verified.propertyId;
    result = { ...base, paymentRequestId: r.paymentRequest.id, outcome: r.outcome };
    extra = { statusBefore: cand.status, statusAfter: r.paymentRequest.status, settlementStatementId: r.settlementStatementId, timingRule: r.verified.timing.rule, noticeReason: r.verified.timing.noticeReason ?? null };
  } catch (err) {
    if (err instanceof ServiceFeeCollectionError) {
      propertyId = err.propertyId ?? null;
      result = { ...base, code: err.code };
    } else {
      logger.error("pc_fee_scheduler_item_failed", { paymentRequestId: cand.id });
      result = { ...base, code: "SERVICE_FEE_COLLECTION_FAILED" };
    }
  }
  await logAudit({
    brokerageId: cand.brokerageId,
    userId: null,
    action: result.outcome ? "pit_crew_service_fee_scheduler_collection" : "pit_crew_service_fee_scheduler_collection_refused",
    recordType: "transaction",
    recordId: String(cand.transactionId),
    propertyId,
    updatedValue: JSON.stringify({
      trigger: "scheduler",
      paymentRequestId: cand.id,
      ...(result.outcome ? { outcome: result.outcome } : { code: result.code }),
      ...extra,
      policy: "t181u",
    }),
  });
  return result;
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let running = false;

/** OFF by default (see header). Registration alone never collects anything. */
export function registerServiceFeeCollectionScheduler(options: { startScheduler?: boolean; intervalMs?: number } = {}): void {
  const start = options.startScheduler ?? (process.env.NODE_ENV !== "test" && process.env.PC_FEE_COLLECTION_SCHEDULER_ENABLED === "true");
  if (!start || intervalHandle) return;
  intervalHandle = setInterval(() => {
    if (running) return;
    running = true;
    runServiceFeeCollectionTick()
      .catch((error) => logger.error("pc_fee_scheduler_tick_failed", { error: error instanceof Error ? error.name : "unknown" }))
      .finally(() => {
        running = false;
      });
  }, options.intervalMs ?? 15 * 60_000);
  intervalHandle.unref?.();
}
export function stopServiceFeeCollectionScheduler(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
export function serviceFeeCollectionSchedulerActive(): boolean {
  return intervalHandle !== null;
}
