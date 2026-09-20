import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  db,
  brokerages,
  growSignalSweepRuns,
  growSignalSweepCursors,
  growOpportunitySignals,
} from "@aee/db";
import { logger, incrementCounter, observeHistogram, runWithCorrelationId, currentCorrelationId } from "@aee/events";
import { evaluateCandidates, type SignalCandidate } from "./evaluation.js";
import { loadContactabilityFilter } from "./contactability.js";
import { expireSignalsPastExpiry, expireUnsupportedSignals, upsertSignalCandidates } from "./persistence.js";

/**
 * AE GROW "Brokerage-wide Signal Sweep" stage 1 — the sweep orchestrator.
 *
 * WHY THIS EXISTS. Property Intelligence signals were only ever computed
 * when a human opened one property and pressed recalculate. A brokerage's
 * signals were therefore whatever someone happened to refresh, expiry only
 * happened on read, and a contact with no property could never hold a signal
 * at all. This module evaluates every brokerage on a schedule, set-based and
 * bounded.
 *
 * IT FOLLOWS lib/exceptions/engine.ts's PATTERN DELIBERATELY:
 *
 *   SINGLE FLIGHT. A session-level Postgres advisory lock held on ONE
 *   dedicated pooled connection for the whole run and released in `finally`.
 *   pg_try_advisory_lock is atomic, so overlapping sweeps are impossible
 *   across timers, manual invocations and API instances sharing a database —
 *   exactly one caller wins and every other is refused immediately. No
 *   check-then-insert race.
 *
 *   CRASH RECOVERY WITHOUT WALL-CLOCK ARITHMETIC. Postgres releases a
 *   session advisory lock the instant its connection closes, so a crashed
 *   process can never wedge the lock. Any grow_signal_sweep_runs row still
 *   RUNNING when a new sweep successfully TAKES the lock is, by
 *   construction, not running — its holder no longer holds the lock — and is
 *   closed out as FAILED. Nothing compares a stored timestamp against
 *   "now minus N minutes", so a skewed clock, a slow host, or a paused
 *   container cannot cause either a false recovery or a permanently stuck
 *   run.
 *
 *   ITS OWN KEYSPACE. The two-int4 lock below is distinct from the Exception
 *   & Risk Engine's (0x41455245 "AERE"), from exceptions/model.ts's
 *   single-bigint hashtext() dedup locks, and from
 *   lib/consentControlsPersistence.ts's (2076418031) — different namespace
 *   value AND, against the consent locks, a different lock function family,
 *   so no collision is possible in either direction.
 *
 * COST CONTROL — see shouldEvaluateBrokerage() below. Before evaluating a
 * brokerage the sweep probes the max mutation timestamp of each source table
 * and compares it with the high-water marks in grow_signal_sweep_cursors. A
 * brokerage whose sources have not moved, and which has nothing due for
 * expiry or re-review, is skipped entirely. A steady-state sweep therefore
 * touches almost nothing.
 *
 * IT NEVER CONTACTS ANYONE. The sweep reads, writes grow_opportunity_signals
 * rows, and writes its own bookkeeping. It publishes no domain event, sends
 * no message, calls no provider and makes no AI call. A signal is a
 * reviewable indicator; raising one can never reach a customer.
 *
 * TENANT ISOLATION. Every query it issues takes a brokerageId and filters on
 * it; the only cross-tenant read is the page of brokerage IDs it iterates.
 */

/* ---------------------------------------------------------------------
 * Advisory lock.
 * -----------------------------------------------------------------*/

const SWEEP_LOCK_NAMESPACE = 0x41455351; // "AESQ" — Agent Engine Signal sweep. Distinct from 0x41455245 ("AERE").
const SWEEP_LOCK_KEY = 1;

/* ---------------------------------------------------------------------
 * Bounds and tuning. Every one of these is a documented constant with an
 * environment override; an invalid or absent value keeps the constant.
 * -----------------------------------------------------------------*/

/** Brokerage ids fetched per page while iterating tenants. Not a work bound — just the page size. */
export const BROKERAGE_PAGE_SIZE = 50;

/** Default ceiling on brokerages evaluated in one run. A run that hits it stops cleanly and the NEXT run resumes after the last brokerage id it reached (see the resume cursor below). */
export const DEFAULT_MAX_BROKERAGES_PER_RUN = 200;

/** Default ceiling on candidates evaluated for ONE brokerage. Hitting it marks the run truncated and suppresses that brokerage's "no longer supported -> Expired" pass, because a truncated candidate set is not authoritative. */
export const DEFAULT_MAX_CANDIDATES_PER_BROKERAGE = 5000;

/** Default scheduler interval. */
export const DEFAULT_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/** Default period after which a brokerage is evaluated even if its change-detection probe says nothing moved. Guards against a source whose mutation timestamp is not maintained, and bounds how stale a time-derived band (tenure years, overdue days) can get. */
export const DEFAULT_FULL_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * ENVIRONMENT VARIABLES INTRODUCED BY THIS MODULE (all optional; an absent or
 * invalid value keeps the documented default):
 *
 *   GROW_SIGNAL_SWEEP_ENABLED=false
 *       Hard off switch. The scheduler does not start and, because
 *       bootstrap.ts is the only production caller, no sweep runs at all.
 *       An explicit runSignalSweep() call (the ops/test path) still works.
 *   GROW_SIGNAL_SWEEP_INTERVAL_MS
 *       Scheduler period. Default 1,800,000 (30 minutes).
 *   GROW_SIGNAL_SWEEP_MAX_BROKERAGES
 *       Brokerages per run. Default 200.
 *   GROW_SIGNAL_SWEEP_MAX_CANDIDATES
 *       Candidates per brokerage. Default 5,000.
 *   GROW_SIGNAL_SWEEP_FULL_INTERVAL_MS
 *       Force a full evaluation of a brokerage at least this often, even
 *       when change detection says nothing moved. Default 86,400,000 (24h).
 */
export function sweepConfig(): {
  enabled: boolean;
  intervalMs: number;
  maxBrokerages: number;
  maxCandidatesPerBrokerage: number;
  fullSweepIntervalMs: number;
} {
  return {
    enabled: process.env.GROW_SIGNAL_SWEEP_ENABLED !== "false",
    intervalMs: envInt("GROW_SIGNAL_SWEEP_INTERVAL_MS", DEFAULT_SWEEP_INTERVAL_MS),
    maxBrokerages: envInt("GROW_SIGNAL_SWEEP_MAX_BROKERAGES", DEFAULT_MAX_BROKERAGES_PER_RUN),
    maxCandidatesPerBrokerage: envInt("GROW_SIGNAL_SWEEP_MAX_CANDIDATES", DEFAULT_MAX_CANDIDATES_PER_BROKERAGE),
    fullSweepIntervalMs: envInt("GROW_SIGNAL_SWEEP_FULL_INTERVAL_MS", DEFAULT_FULL_SWEEP_INTERVAL_MS),
  };
}

export interface SweepSummary {
  sweepRunId: string;
  brokeragesConsidered: number;
  brokeragesEvaluated: number;
  brokeragesSkippedUnchanged: number;
  candidatesEvaluated: number;
  signalsCreated: number;
  signalsUpdated: number;
  signalsReRaised: number;
  signalsExpired: number;
  candidatesSuppressed: number;
  truncated: boolean;
  errors: number;
  /** The highest brokerage id this run reached. The next run resumes after it when the run was bounded out. */
  lastBrokerageId: number;
  /** True when the run stopped because it hit maxBrokerages rather than because it ran out of brokerages. */
  boundedOut: boolean;
}

export type RunSignalSweepResult = { ok: true; summary: SweepSummary } | { ok: false; skippedReason: string };

export interface RunSignalSweepOptions {
  /**
   * Restrict the sweep to these brokerages. Omitted (the production default)
   * means every brokerage. Exists so a test file sharing one database sweeps
   * only its own tenants — the single-flight lock is still global either way.
   */
  brokerageIds?: number[];
  /** Resume after this brokerage id. Defaults to 0 for a scoped run, and for an unscoped run to the resume point the last bounded-out run recorded. */
  afterBrokerageId?: number;
  /** Overrides for this call only (tests, ops). */
  maxBrokerages?: number;
  maxCandidatesPerBrokerage?: number;
  /** Evaluate every brokerage in scope regardless of its change-detection cursor. */
  force?: boolean;
}

/**
 * Where an unscoped bounded-out run left off, so the next run continues
 * rather than restarting at brokerage 1 and starving the tail of the tenant
 * list. Held in memory deliberately: it is an optimisation, not state whose
 * loss can corrupt anything — a fresh process simply starts from the
 * beginning, and each brokerage's own cursor still prevents redundant work.
 */
let unscopedResumeAfterBrokerageId = 0;

/** Test-only: resets the in-memory resume point so one test file cannot influence another. */
export function resetSweepResumePointForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("resetSweepResumePointForTests is a test-only seam and is unavailable outside tests.");
  }
  unscopedResumeAfterBrokerageId = 0;
}

export async function runSignalSweep(trigger: "SCHEDULED" | "MANUAL" = "SCHEDULED", options: RunSignalSweepOptions = {}): Promise<RunSignalSweepResult> {
  const startedAtMs = Date.now();
  const lockClient = await db.$client.connect();
  let lockHeld = false;
  let releaseError: Error | undefined;
  try {
    const lockResult = await lockClient.query<{ locked: boolean }>("select pg_try_advisory_lock($1::int4, $2::int4) as locked", [SWEEP_LOCK_NAMESPACE, SWEEP_LOCK_KEY]);
    lockHeld = lockResult.rows[0]?.locked === true;
    if (!lockHeld) {
      const [running] = await db
        .select({ id: growSignalSweepRuns.id })
        .from(growSignalSweepRuns)
        .where(eq(growSignalSweepRuns.status, "RUNNING"))
        .orderBy(desc(growSignalSweepRuns.startedAt))
        .limit(1);
      incrementCounter("property_signal_sweep_total", { trigger, outcome: "skipped_locked" });
      return { ok: false, skippedReason: running ? `A signal sweep (${running.id}) is already running.` : "A signal sweep is already running." };
    }
    const result = await runSweepWhileLocked(trigger, options);
    incrementCounter("property_signal_sweep_total", { trigger, outcome: "completed" });
    observeHistogram("property_signal_sweep_duration_ms", Date.now() - startedAtMs, { trigger });
    return result;
  } catch (err) {
    incrementCounter("property_signal_sweep_total", { trigger, outcome: "failed" });
    observeHistogram("property_signal_sweep_duration_ms", Date.now() - startedAtMs, { trigger });
    throw err;
  } finally {
    if (lockHeld) {
      try {
        await lockClient.query("select pg_advisory_unlock($1::int4, $2::int4)", [SWEEP_LOCK_NAMESPACE, SWEEP_LOCK_KEY]);
      } catch (err) {
        // Could not unlock cleanly — destroy the connection instead of
        // returning it to the pool, which releases the session lock
        // server-side and guarantees it can never leak to a later borrower.
        releaseError = err instanceof Error ? err : new Error(String(err));
        logger.error("property_signal_sweep_lock_unlock_failed", { error: releaseError.message });
      }
    }
    lockClient.release(releaseError);
  }
}

/**
 * Test-only: takes the global sweep lock on its own dedicated connection, as
 * a running sweep would, WITHOUT sweeping anything. Returns a release
 * function, or null if a sweep currently holds the lock. Gated on
 * NODE_ENV === "test" for the same reason lib/exceptions/engine.ts gates its
 * equivalent: an exported "hold the global lock indefinitely" helper is a
 * denial of service against the scheduled sweep for anything that can reach it.
 */
export async function tryHoldSignalSweepLockForTests(): Promise<(() => Promise<void>) | null> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("tryHoldSignalSweepLockForTests is a test-only seam and is unavailable outside tests.");
  }
  const client = await db.$client.connect();
  try {
    const result = await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1::int4, $2::int4) as locked", [SWEEP_LOCK_NAMESPACE, SWEEP_LOCK_KEY]);
    if (result.rows[0]?.locked !== true) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query("select pg_advisory_unlock($1::int4, $2::int4)", [SWEEP_LOCK_NAMESPACE, SWEEP_LOCK_KEY]);
      client.release();
    } catch (err) {
      client.release(err instanceof Error ? err : new Error(String(err)));
    }
  };
}

async function runSweepWhileLocked(trigger: "SCHEDULED" | "MANUAL", options: RunSignalSweepOptions): Promise<RunSignalSweepResult> {
  const config = sweepConfig();
  const scopedBrokerageIds = options.brokerageIds ? [...new Set(options.brokerageIds)] : null;
  const maxBrokerages = options.maxBrokerages ?? config.maxBrokerages;
  const maxCandidatesPerBrokerage = options.maxCandidatesPerBrokerage ?? config.maxCandidatesPerBrokerage;

  // STALE-RUN RECOVERY. We hold the global lock, so no other sweep is
  // running: any row still RUNNING belongs to a process that died mid-sweep.
  // Purely lock-based — no wall-clock arithmetic anywhere.
  //
  // Done ONLY for an unscoped run (the production path), for the same reason
  // lib/exceptions/engine.ts scopes its equivalent: grow_signal_sweep_runs
  // has no scope column, so for a scoped run "every RUNNING row" is strictly
  // wider than that run's own scope and would stamp FAILED onto an unrelated
  // tenant's in-flight bookkeeping in a shared test database.
  if (!scopedBrokerageIds) {
    await db
      .update(growSignalSweepRuns)
      .set({ status: "FAILED", completedAt: new Date(), errorMessage: "Abandoned: the sweep did not complete (its process stopped while running)." })
      .where(eq(growSignalSweepRuns.status, "RUNNING"));
  }

  const [sweepRun] = await db.insert(growSignalSweepRuns).values({ status: "RUNNING", trigger }).returning();

  const startAfter = options.afterBrokerageId ?? (scopedBrokerageIds ? 0 : unscopedResumeAfterBrokerageId);
  const summary: SweepSummary = {
    sweepRunId: sweepRun.id,
    brokeragesConsidered: 0,
    brokeragesEvaluated: 0,
    brokeragesSkippedUnchanged: 0,
    candidatesEvaluated: 0,
    signalsCreated: 0,
    signalsUpdated: 0,
    signalsReRaised: 0,
    signalsExpired: 0,
    candidatesSuppressed: 0,
    truncated: false,
    errors: 0,
    lastBrokerageId: startAfter,
    boundedOut: false,
  };

  try {
    let lastId = startAfter;
    let exhausted = false;
    while (summary.brokeragesConsidered < maxBrokerages) {
      if (scopedBrokerageIds && scopedBrokerageIds.length === 0) {
        exhausted = true;
        break;
      }
      const page = await db
        .select({ id: brokerages.id })
        .from(brokerages)
        .where(scopedBrokerageIds ? and(gt(brokerages.id, lastId), inArray(brokerages.id, scopedBrokerageIds)) : gt(brokerages.id, lastId))
        .orderBy(asc(brokerages.id))
        .limit(Math.min(BROKERAGE_PAGE_SIZE, maxBrokerages - summary.brokeragesConsidered));
      if (page.length === 0) {
        exhausted = true;
        break;
      }
      for (const { id: brokerageId } of page) {
        await sweepBrokerage(brokerageId, sweepRun.id, summary, { maxCandidatesPerBrokerage, fullSweepIntervalMs: config.fullSweepIntervalMs, force: options.force === true });
        summary.brokeragesConsidered += 1;
        summary.lastBrokerageId = brokerageId;
        lastId = brokerageId;
      }
    }

    summary.boundedOut = !exhausted;
    if (!scopedBrokerageIds) {
      // Resume after the last brokerage reached, or start again from the top
      // once the tenant list is exhausted.
      unscopedResumeAfterBrokerageId = summary.boundedOut ? summary.lastBrokerageId : 0;
    }

    await db
      .update(growSignalSweepRuns)
      .set({
        status: "COMPLETED",
        completedAt: new Date(),
        brokeragesConsidered: summary.brokeragesConsidered,
        brokeragesEvaluated: summary.brokeragesEvaluated,
        brokeragesSkippedUnchanged: summary.brokeragesSkippedUnchanged,
        candidatesEvaluated: summary.candidatesEvaluated,
        signalsCreated: summary.signalsCreated,
        signalsUpdated: summary.signalsUpdated,
        signalsReRaised: summary.signalsReRaised,
        signalsExpired: summary.signalsExpired,
        candidatesSuppressed: summary.candidatesSuppressed,
        truncated: summary.truncated,
        errors: summary.errors,
      })
      .where(eq(growSignalSweepRuns.id, sweepRun.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(growSignalSweepRuns)
      .set({
        status: "FAILED",
        completedAt: new Date(),
        errorMessage: message,
        brokeragesConsidered: summary.brokeragesConsidered,
        brokeragesEvaluated: summary.brokeragesEvaluated,
        brokeragesSkippedUnchanged: summary.brokeragesSkippedUnchanged,
        candidatesEvaluated: summary.candidatesEvaluated,
        signalsCreated: summary.signalsCreated,
        signalsUpdated: summary.signalsUpdated,
        signalsReRaised: summary.signalsReRaised,
        signalsExpired: summary.signalsExpired,
        candidatesSuppressed: summary.candidatesSuppressed,
        truncated: summary.truncated,
        errors: summary.errors,
      })
      .where(eq(growSignalSweepRuns.id, sweepRun.id));
    throw err;
  }

  logger.info("property_signal_sweep_completed", {
    sweepRunId: summary.sweepRunId,
    trigger,
    brokeragesConsidered: summary.brokeragesConsidered,
    brokeragesEvaluated: summary.brokeragesEvaluated,
    brokeragesSkippedUnchanged: summary.brokeragesSkippedUnchanged,
    candidatesEvaluated: summary.candidatesEvaluated,
    signalsCreated: summary.signalsCreated,
    signalsUpdated: summary.signalsUpdated,
    signalsReRaised: summary.signalsReRaised,
    signalsExpired: summary.signalsExpired,
    candidatesSuppressed: summary.candidatesSuppressed,
    truncated: summary.truncated,
    errors: summary.errors,
    boundedOut: summary.boundedOut,
  });

  return { ok: true, summary };
}

interface BrokerageSweepOptions {
  maxCandidatesPerBrokerage: number;
  fullSweepIntervalMs: number;
  force: boolean;
}

/** One brokerage, under its own fresh ambient correlation context so every log line this pass emits carries one consistent id (matching lib/exceptions/engine.ts's scanBrokerageForExceptions). */
async function sweepBrokerage(brokerageId: number, sweepRunId: string, summary: SweepSummary, options: BrokerageSweepOptions): Promise<void> {
  return runWithCorrelationId(currentCorrelationId(), () => sweepBrokerageInner(brokerageId, sweepRunId, summary, options));
}

/**
 * CHANGE DETECTION — the per-brokerage high-water mark.
 *
 * One statement returns the max mutation timestamp of every source table
 * this brokerage's rules read, plus two "is there anything due?" probes. If
 * no source has moved past its recorded high-water mark, no Active signal is
 * past its expiry, and no decided signal has reached its next_review_at, the
 * brokerage's candidate evaluation is skipped entirely. This is what makes a
 * steady-state sweep cheap: a tenant nobody touched costs ONE statement.
 *
 * The probe is deliberately conservative in the safe direction: it can only
 * cause EXTRA work (a source whose timestamp moved for an unrelated reason),
 * never missed work, because every mutation to any of these tables moves the
 * corresponding timestamp. And FULL_SWEEP_INTERVAL_MS forces a full
 * evaluation periodically regardless, which also catches the one class of
 * change no source timestamp can express: time itself passing, which is what
 * moves a tenure or overdue band.
 */
async function probeBrokerage(brokerageId: number, now: Date): Promise<{
  marks: Record<string, string | null>;
  hasDueExpiry: boolean;
}> {
  const nowIso = now.toISOString();
  const probe = await db.execute<{
    grow_relationships: string | null;
    grow_opportunities: string | null;
    grow_activities: string | null;
    appraisals: string | null;
    property_provider_observations: string | null;
    due_expiry: number;
  }>(sql`
    select
      (select max(updated_at) from grow_relationships where brokerage_id = ${brokerageId})::text as grow_relationships,
      (select max(updated_at) from grow_opportunities where brokerage_id = ${brokerageId})::text as grow_opportunities,
      (select max(recorded_at) from grow_activities where brokerage_id = ${brokerageId})::text as grow_activities,
      (select max(a.updated_at) from appraisals a join properties p on p.id = a.property_id where p.brokerage_id = ${brokerageId})::text as appraisals,
      (select max(retrieved_at) from property_provider_observations where brokerage_id = ${brokerageId})::text as property_provider_observations,
      (select count(*) from grow_opportunity_signals
        where brokerage_id = ${brokerageId} and status = 'Active' and expires_at is not null and expires_at < ${nowIso})::int as due_expiry
  `);
  const row = probe.rows[0];
  return {
    marks: {
      growRelationships: row?.grow_relationships ?? null,
      growOpportunities: row?.grow_opportunities ?? null,
      growActivities: row?.grow_activities ?? null,
      appraisals: row?.appraisals ?? null,
      propertyProviderObservations: row?.property_provider_observations ?? null,
    },
    hasDueExpiry: Number(row?.due_expiry ?? 0) > 0,
  };
}

function marksUnchanged(previous: unknown, current: Record<string, string | null>): boolean {
  if (previous === null || typeof previous !== "object") return false;
  const prev = previous as Record<string, unknown>;
  const keys = Object.keys(current);
  if (keys.length === 0) return false;
  for (const key of keys) {
    if ((prev[key] ?? null) !== (current[key] ?? null)) return false;
  }
  return true;
}

async function sweepBrokerageInner(brokerageId: number, sweepRunId: string, summary: SweepSummary, options: BrokerageSweepOptions): Promise<void> {
  const now = new Date();

  const [cursor] = await db.select().from(growSignalSweepCursors).where(eq(growSignalSweepCursors.brokerageId, brokerageId));
  const probe = await probeBrokerage(brokerageId, now);

  const dueForFullEvaluation =
    options.force ||
    !cursor ||
    cursor.lastFullEvaluationAt === null ||
    now.getTime() - cursor.lastFullEvaluationAt.getTime() >= options.fullSweepIntervalMs;

  // NOTE ON RE-REVIEW AND THE SKIP DECISION. An elapsed next_review_at is
  // deliberately NOT part of this condition, and that is a correctness
  // argument rather than an omission. Re-raising requires a MATERIAL evidence
  // change, and every material change is one of exactly two kinds:
  //   - a source row changed -> that source's high-water mark moved, so the
  //     brokerage is evaluated by the check below;
  //   - time itself passed (a tenure crossing a band, an overdue period
  //     lengthening) -> caught by the periodic full evaluation above.
  // Including it would also leak cost permanently: a signal dismissed long
  // ago whose evidence never changes keeps an elapsed next_review_at
  // forever, so its brokerage could never be skipped again.
  const skip =
    !dueForFullEvaluation &&
    !probe.hasDueExpiry &&
    marksUnchanged(cursor?.sourceHighWaterMarks ?? null, probe.marks);

  if (skip) {
    summary.brokeragesSkippedUnchanged += 1;
    await writeCursor(brokerageId, sweepRunId, probe.marks, now, false);
    return;
  }

  // 1. Brokerage-wide, sweep-driven expiry — replaces the lazy read-time,
  //    per-property version as the mechanism the system relies on.
  const expired = await expireSignalsPastExpiry(brokerageId, now);
  summary.signalsExpired += expired;

  // 2. Set-based evaluation of every rule.
  const { candidates, truncated } = await evaluateCandidates({ brokerageId, now, maxCandidates: options.maxCandidatesPerBrokerage });
  summary.candidatesEvaluated += candidates.length;
  if (truncated) summary.truncated = true;

  // 3. Contactability — a pure read, minimum dependency, never a write. A
  //    candidate for a suppressed contact is dropped BEFORE any write, so it
  //    is never raised, never surfaced, and can never reach anyone.
  const filter = await loadContactabilityFilter(brokerageId, candidates.map((c) => c.partyId));
  const allowed: SignalCandidate[] = [];
  let suppressedCount = 0;
  for (const candidate of candidates) {
    if (filter.isSuppressed(candidate.partyId)) {
      suppressedCount += 1;
      continue;
    }
    allowed.push(candidate);
  }
  summary.candidatesSuppressed += suppressedCount;

  // 4. Batched upserts under the re-review policy.
  const upsert = await upsertSignalCandidates(brokerageId, allowed, now);
  summary.signalsCreated += upsert.created;
  summary.signalsUpdated += upsert.updated;
  summary.signalsReRaised += upsert.reRaised;

  // 5. "No longer supported -> Expired", brokerage-wide, ONLY on an
  //    authoritative pass. A truncated candidate set says nothing about what
  //    is currently true, so expiring against it would retire live signals.
  //
  //    Suppressed candidates ARE included in the supported set even though
  //    they were not written: they are genuinely still supported by evidence,
  //    and the contactability filter must hide a contact, never silently
  //    retire their history.
  if (!truncated) {
    const supported = candidates.map((c) => c.dedupeKey);
    summary.signalsExpired += await expireUnsupportedSignals(brokerageId, supported, now);
  }

  summary.brokeragesEvaluated += 1;

  incrementCounter("property_signal_outcome_total", { outcome: "created" }, upsert.created);
  incrementCounter("property_signal_outcome_total", { outcome: "updated" }, upsert.updated);
  incrementCounter("property_signal_outcome_total", { outcome: "re_raised" }, upsert.reRaised);
  incrementCounter("property_signal_outcome_total", { outcome: "suppressed" }, suppressedCount);

  logger.debug("property_signal_sweep_brokerage_evaluated", {
    brokerageId,
    sweepRunId,
    candidates: candidates.length,
    suppressed: suppressedCount,
    created: upsert.created,
    updated: upsert.updated,
    reRaised: upsert.reRaised,
    leftDecided: upsert.leftDecided,
    truncated,
  });

  await writeCursor(brokerageId, sweepRunId, probe.marks, now, !truncated);
}

/** One idempotent upsert per brokerage per pass. */
async function writeCursor(brokerageId: number, sweepRunId: string, marks: Record<string, string | null>, now: Date, fullEvaluation: boolean): Promise<void> {
  await db
    .insert(growSignalSweepCursors)
    .values({
      brokerageId,
      sourceHighWaterMarks: marks,
      lastEvaluatedAt: now,
      lastFullEvaluationAt: fullEvaluation ? now : null,
      lastSweepRunId: sweepRunId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: growSignalSweepCursors.brokerageId,
      set: {
        sourceHighWaterMarks: sql`excluded.source_high_water_marks`,
        lastEvaluatedAt: sql`excluded.last_evaluated_at`,
        // A skipped pass must not advance the full-evaluation anchor, or the
        // FULL_SWEEP_INTERVAL_MS safety net would never fire.
        lastFullEvaluationAt: sql`coalesce(excluded.last_full_evaluation_at, ${growSignalSweepCursors.lastFullEvaluationAt})`,
        lastSweepRunId: sql`excluded.last_sweep_run_id`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

/** Ops/diagnostics: the most recent sweep run rows, newest first. Never tenant data. */
export async function listRecentSweepRuns(limit = 10) {
  return db.select().from(growSignalSweepRuns).orderBy(desc(growSignalSweepRuns.startedAt)).limit(limit);
}

/** Ops/diagnostics: count of Active signals for one brokerage. Brokerage-scoped like everything else here. */
export async function countActiveSignals(brokerageId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(growOpportunitySignals)
    .where(and(eq(growOpportunitySignals.brokerageId, brokerageId), eq(growOpportunitySignals.status, "Active")));
  return Number(row?.count ?? 0);
}
