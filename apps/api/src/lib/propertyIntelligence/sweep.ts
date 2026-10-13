import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  db,
  brokerages,
  growSignalSweepRuns,
  growSignalSweepCursors,
  growOpportunitySignals,
} from "@aee/db";
import { logger, incrementCounter, observeHistogram, runWithCorrelationId, currentCorrelationId } from "@aee/events";
import { dispatchOperationalAlert } from "../operationalAlerts.js";
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
 *   NO PER-PROCESS ITERATION STATE. Which tenants a scheduled run picks up
 *   is derived from grow_signal_sweep_cursors.last_evaluated_at — least
 *   recently evaluated first, a brokerage with no cursor row first of all —
 *   so the resume point is in the DATABASE, exactly like the single-flight
 *   lock and the stale-run recovery. Two API instances sharing a database
 *   therefore take turns through the whole tenant list instead of each
 *   keeping a private cursor and re-sweeping the head of it, and a restart
 *   loses nothing. See listBrokeragesDueForSweep().
 *
 *   ONE BAD TENANT IS NOT A DEAD SWEEP. A brokerage whose pass throws is
 *   counted, logged by id, has its cursor stamped so it cannot starve the
 *   tenants behind it, and the run CONTINUES — the run is recorded COMPLETED
 *   with errors > 0. Only a failure of the run's own bookkeeping is fatal.
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
  /** Brokerages whose pass threw. The run still swept every other brokerage and is recorded COMPLETED; see considerBrokerage(). */
  errors: number;
  /** The last brokerage id this run reached. On the explicit-cursor path a caller may pass it back as afterBrokerageId; the production path resumes from grow_signal_sweep_cursors instead and does not need it. */
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
  /**
   * Resume after this brokerage id, iterating in ascending id order.
   *
   * Supplying it (at any value, including 0) selects the explicit-cursor
   * path. OMITTING it on an UNSCOPED run selects the production path, which
   * takes its order from grow_signal_sweep_cursors.last_evaluated_at — least
   * recently evaluated first — and therefore needs no caller-held cursor at
   * all. See listBrokeragesDueForSweep().
   */
  afterBrokerageId?: number;
  /** Overrides for this call only (tests, ops). */
  maxBrokerages?: number;
  maxCandidatesPerBrokerage?: number;
  /** Evaluate every brokerage in scope regardless of its change-detection cursor. */
  force?: boolean;
}

/**
 * DURABLE RESUME POINT (independent-review remediation P1-4).
 *
 * The resume point used to be a module-level integer, which is per PROCESS.
 * With two API instances sharing one database and more tenants than
 * maxBrokerages, each process kept its own idea of where it had got to, so
 * both repeatedly swept the head of the id-ordered tenant list and the tail
 * was only ever reached by accident — while every skipped brokerage still
 * consumed a slot against maxBrokerages, so the cheap change-detection path
 * could not let a run get further either.
 *
 * There is now no in-process resume state at all. An unscoped production run
 * asks the DATABASE which tenants are most overdue, ordering by
 * grow_signal_sweep_cursors.last_evaluated_at (a brokerage with no cursor row
 * has never been evaluated and therefore sorts first). Every considered
 * brokerage — evaluated, skipped-unchanged, or failed — writes
 * last_evaluated_at before the run ends, so it moves to the BACK of the
 * ordering and the next run, in this process or any other, continues with
 * whatever is now most overdue. That is durable across processes and
 * restarts, and it gives round-robin fairness for free.
 *
 * The explicit-cursor path is kept for scoped runs and for a caller that
 * passes afterBrokerageId (tests and ops), where deterministic ascending-id
 * iteration is what the caller is actually asking for.
 */

/**
 * Consecutive "already running" refusals seen with NO RUNNING run row before
 * the sweep reports a suspected advisory-lock leak. A single occurrence is
 * an ordinary race (the holder inserts its run row a moment after taking the
 * lock); a run of them means somebody holds (0x41455351, 1) and is not
 * sweeping, which silently disables sweeping entirely and must be alertable
 * rather than reported as the expected `skipped_locked` outcome.
 */
export const LOCK_LEAK_ALERT_AFTER_CONSECUTIVE_ORPHANED_SKIPS = 3;

let consecutiveOrphanedLockSkips = 0;

/**
 * Test-only: resets the per-process sweep counters so one test file cannot
 * influence another.
 *
 * The resume point itself is no longer per-process state (see the block
 * comment above) — it lives in grow_signal_sweep_cursors.last_evaluated_at —
 * so there is nothing to reset for it. What remains is the orphaned-lock
 * alert counter, which is genuinely per-process. The export is kept, with
 * the same test-only gate, so existing suites keep one obvious isolation
 * call site.
 */
export function resetSweepResumePointForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("resetSweepResumePointForTests is a test-only seam and is unavailable outside tests.");
  }
  consecutiveOrphanedLockSkips = 0;
}

export async function runSignalSweep(trigger: "SCHEDULED" | "MANUAL" = "SCHEDULED", options: RunSignalSweepOptions = {}): Promise<RunSignalSweepResult> {
  const startedAtMs = Date.now();
  const lockClient = await db.$client.connect();
  let lockHeld = false;

  // LOCK ACQUISITION IS ITS OWN try (independent-review remediation P1-1).
  //
  // A session-level advisory lock is NOT transactional: it survives statement
  // rollback and cancellation. So if pg_try_advisory_lock executed
  // server-side and the statement then failed anyway (statement_timeout, a
  // cancelled query, a read error after the function ran), the lock may be
  // HELD by this connection even though we never saw the result. Returning
  // that connection to the pool would leave (0x41455351, 1) held forever by a
  // pooled client: every later run would be refused with skipped_locked, no
  // RUNNING row would exist, and sweeping would be silently dead until the
  // process restarted.
  //
  // Passing the error to release() DESTROYS the connection instead of
  // returning it, and Postgres releases a session advisory lock the instant
  // its connection closes. Same reasoning as the unlock-failure path below.
  try {
    const lockResult = await lockClient.query<{ locked: boolean }>("select pg_try_advisory_lock($1::int4, $2::int4) as locked", [SWEEP_LOCK_NAMESPACE, SWEEP_LOCK_KEY]);
    lockHeld = lockResult.rows[0]?.locked === true;
  } catch (err) {
    const acquireError = err instanceof Error ? err : new Error(String(err));
    lockClient.release(acquireError);
    logger.error("property_signal_sweep_lock_acquire_failed", { error: acquireError.message });
    // The declared outcome label set is closed (packages/events/src/metrics.ts)
    // and a failed acquisition genuinely is a failed sweep attempt.
    incrementCounter("property_signal_sweep_total", { trigger, outcome: "failed" });
    observeHistogram("property_signal_sweep_duration_ms", Date.now() - startedAtMs, { trigger });
    throw acquireError;
  }

  let releaseError: Error | undefined;
  try {
    if (!lockHeld) {
      const [running] = await db
        .select({ id: growSignalSweepRuns.id })
        .from(growSignalSweepRuns)
        .where(eq(growSignalSweepRuns.status, "RUNNING"))
        .orderBy(desc(growSignalSweepRuns.startedAt))
        .limit(1);
      incrementCounter("property_signal_sweep_total", { trigger, outcome: "skipped_locked" });
      if (running) {
        // Someone really is sweeping. This is the documented, expected case.
        consecutiveOrphanedLockSkips = 0;
        return { ok: false, skippedReason: `A signal sweep (${running.id}) is already running.` };
      }
      // The lock is held but nothing is running. Once is a race; repeatedly is
      // a leaked lock, which is indistinguishable from "sweeping is dead"
      // unless it is said out loud.
      //
      // METRIC (AE GROW Completion W1-D, H-6).
      // property_signal_sweep_lock_orphaned_total is now registered and is
      // incremented here ALONGSIDE the log lines below, never instead of
      // them. It is deliberately separate from property_signal_sweep_total:
      // `skipped_locked` there must keep counting only EXPECTED refusals, and
      // reusing `failed` would corrupt the completed/failed ratio with
      // refusals that are usually an ordinary race.
      //
      // ALERT (AE GROW Completion W1-D, H-1 — the P0).
      // logger.error is never bridged to dispatchOperationalAlert (logger.ts
      // only writes JSON to stderr), so before this the suspected-leak branch
      // was entirely silent: sweeping was dead while the metric read
      // skipped_locked, which looks healthy. The threshold branch now raises
      // GROW_SIGNAL_SWEEP_UNHEALTHY. The ordinary race (below the threshold)
      // deliberately raises nothing.
      consecutiveOrphanedLockSkips += 1;
      const detail = {
        trigger,
        consecutiveOrphanedSkips: consecutiveOrphanedLockSkips,
        lockNamespace: SWEEP_LOCK_NAMESPACE,
        lockKey: SWEEP_LOCK_KEY,
      };
      const suspectedLeak = consecutiveOrphanedLockSkips >= LOCK_LEAK_ALERT_AFTER_CONSECUTIVE_ORPHANED_SKIPS;
      incrementCounter("property_signal_sweep_lock_orphaned_total", { trigger, kind: suspectedLeak ? "suspected_leak" : "race" });
      if (suspectedLeak) {
        logger.error("property_signal_sweep_lock_suspected_leak", detail);
        // Fire-and-forget on purpose. Alert delivery is best-effort with its
        // own in-process retry and dedup cooldown (see operationalAlerts.ts);
        // it must never turn a refused sweep into a thrown one, and the
        // caller is already returning a refusal either way.
        void dispatchOperationalAlert({
          type: "GROW_SIGNAL_SWEEP_UNHEALTHY",
          summary: `The Property Intelligence signal sweep has been refused the single-flight lock ${consecutiveOrphanedLockSkips} consecutive times with no run in progress — the advisory lock is suspected leaked and sweeping is not happening.`,
          dedupKey: "grow-signal-sweep:lock-leak",
          details: detail,
        }).catch((err) => logger.error("property_signal_sweep_alert_dispatch_failed", { error: err instanceof Error ? err.message : String(err) }));
      } else {
        logger.warn("property_signal_sweep_lock_held_with_no_running_row", detail);
      }
      return { ok: false, skippedReason: "A signal sweep is already running." };
    }
    consecutiveOrphanedLockSkips = 0;
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

  // An unscoped run with no caller-supplied cursor is the PRODUCTION path and
  // takes the durable least-recently-evaluated ordering. A scoped run, or one
  // where the caller named a resume point, keeps deterministic ascending-id
  // iteration, which is exactly what those callers ask for.
  const useDurableOrder = !scopedBrokerageIds && options.afterBrokerageId === undefined;
  const startAfter = options.afterBrokerageId ?? 0;
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

  const brokerageOptions: BrokerageSweepOptions = {
    maxCandidatesPerBrokerage,
    fullSweepIntervalMs: config.fullSweepIntervalMs,
    force: options.force === true,
  };

  /**
   * ONE BROKERAGE, NEVER FATAL (independent-review remediation P1-2).
   *
   * A throw from one tenant used to fail the whole run and, because the
   * resume point only advanced after the loop completed, every later run
   * restarted at the same place, hit the same poisoned tenant, and died
   * again — so every brokerage after it was never swept again. It is the
   * same failure shape lib/exceptions/engine.ts already guards against: an
   * error is counted, logged with ids only, and the scan CONTINUES, because
   * absence of evidence from a failed evaluation is never proof of anything.
   *
   * The failing brokerage's cursor still gets its last_evaluated_at stamped
   * (and only that — no high-water marks, no full-evaluation anchor), so it
   * moves to the back of the durable ordering and cannot starve the tenants
   * behind it, while the next pass still does a full evaluation of it.
   */
  const considerBrokerage = async (brokerageId: number): Promise<void> => {
    try {
      await sweepBrokerage(brokerageId, sweepRun.id, summary, brokerageOptions);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.errors += 1;
      // AE GROW Completion W1-D (H-6): property_signal_sweep_brokerage_failure_total
      // distinguishes "one tenant is broken" from "the sweep is broken" without
      // reading logs. WHICH brokerage failed stays in the structured log line
      // below, on the run row's `errors` count, and in the alert details —
      // never a metric label, per the metrics catalogue's own rule.
      //
      // AE GROW Completion H-4. logger.error is not bridged to
      // dispatchOperationalAlert (logger.ts only writes JSON to stderr), so
      // before this a brokerage that failed on every scheduled pass never
      // paged. H-1's GROW_SIGNAL_SWEEP_UNHEALTHY stays reserved for a leaked
      // lock and a scheduled tick that throws: those mean the sweep as a whole
      // is not running. One tenant's pass failing while the run continues is
      // GROW_SIGNAL_SWEEP_BROKERAGE_FAILED. Dedup is per brokerage, so a
      // permanently broken tenant pages once per cooldown rather than once per
      // tick, and a second tenant is not hidden behind the first tenant's
      // cooldown. Fire-and-forget, same as H-1: alert delivery must never turn
      // this isolated failure into a thrown sweep.
      incrementCounter("property_signal_sweep_brokerage_failure_total", { kind: "evaluation" });
      // Ids only — never candidate, party or property content.
      logger.error("property_signal_sweep_brokerage_failed", { brokerageId, sweepRunId: sweepRun.id, error: message });
      void dispatchOperationalAlert({
        type: "GROW_SIGNAL_SWEEP_BROKERAGE_FAILED",
        summary: `A Property Intelligence signal sweep pass failed for brokerage ${brokerageId} and the run continued (sweep run ${sweepRun.id}): ${message}`,
        dedupKey: `grow-signal-sweep:brokerage-evaluation-failed:${brokerageId}`,
        details: { brokerageId, sweepRunId: sweepRun.id, kind: "evaluation", error: message },
      }).catch((alertErr) =>
        logger.error("property_signal_sweep_alert_dispatch_failed", { error: alertErr instanceof Error ? alertErr.message : String(alertErr) }),
      );
      await touchBrokerageCursor(brokerageId, sweepRun.id, new Date()).catch((cursorErr) => {
        const cursorMessage = cursorErr instanceof Error ? cursorErr.message : String(cursorErr);
        // Strictly worse than the evaluation failure above: without its
        // last_evaluated_at stamp this brokerage keeps sorting first in the
        // durable ordering and can starve every tenant behind it on later
        // scheduled runs. Own alert type, same policy shape as H-1. The dedup
        // key differs from the evaluation alert, so both page for this pass.
        incrementCounter("property_signal_sweep_brokerage_failure_total", { kind: "cursor_touch" });
        logger.error("property_signal_sweep_cursor_touch_failed", {
          brokerageId,
          sweepRunId: sweepRun.id,
          error: cursorMessage,
        });
        void dispatchOperationalAlert({
          type: "GROW_SIGNAL_SWEEP_CURSOR_TOUCH_FAILED",
          summary: `A Property Intelligence signal sweep could not stamp last_evaluated_at for brokerage ${brokerageId} after a failed pass (sweep run ${sweepRun.id}). That brokerage keeps sorting first and can starve every tenant behind it: ${cursorMessage}`,
          dedupKey: `grow-signal-sweep:cursor-touch-failed:${brokerageId}`,
          details: { brokerageId, sweepRunId: sweepRun.id, kind: "cursor_touch", error: cursorMessage },
        }).catch((alertErr) =>
          logger.error("property_signal_sweep_alert_dispatch_failed", { error: alertErr instanceof Error ? alertErr.message : String(alertErr) }),
        );
      });
    }
    summary.brokeragesConsidered += 1;
    summary.lastBrokerageId = brokerageId;
  };

  try {
    if (useDurableOrder) {
      const due = await listBrokeragesDueForSweep(maxBrokerages);
      for (const brokerageId of due) await considerBrokerage(brokerageId);
      // A run that filled its whole bound has, by construction, nothing to
      // prove about what is left; the next run simply asks the database
      // again. There is no id to carry forward.
      summary.boundedOut = due.length >= maxBrokerages;
    } else {
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
          await considerBrokerage(brokerageId);
          lastId = brokerageId;
        }
      }
      summary.boundedOut = !exhausted;
    }

    await db
      .update(growSignalSweepRuns)
      .set({
        // COMPLETED-WITH-ERRORS. GROW_SIGNAL_SWEEP_RUN_STATUSES has no fourth
        // value and this change may not alter the schema, so a partially
        // failed run is COMPLETED with errors > 0 and a summary line in
        // error_message — the run really did finish and really did sweep
        // every other tenant; only FAILED means "this run did not run".
        status: "COMPLETED",
        completedAt: new Date(),
        errorMessage: summary.errors > 0 ? `Completed with ${summary.errors} failed brokerage(s); see property_signal_sweep_brokerage_failed for the ids.` : null,
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

  // A run that swept everything it could but lost a tenant on the way is not
  // an ordinary completion, and must not read like one in the log stream.
  const completionLog = summary.errors > 0 ? logger.warn : logger.info;
  completionLog("property_signal_sweep_completed", {
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

/**
 * THE DURABLE RESUME POINT (independent-review remediation P1-4).
 *
 * The brokerages most overdue for a sweep, most overdue first, bounded by
 * `limit`. "Overdue" is grow_signal_sweep_cursors.last_evaluated_at, which is
 * written for EVERY brokerage a run considers — evaluated, skipped-unchanged,
 * or failed — so a considered brokerage moves to the back of this ordering
 * and the next run continues with whatever is now most overdue, in this
 * process or any other. That is what makes the resume point survive a
 * restart and work across API instances sharing a database, which a
 * module-level integer could never do.
 *
 * A brokerage with no cursor row has never been evaluated, so it is treated
 * as last evaluated at the epoch and sweeps first. coalesce() rather than
 * NULLS FIRST deliberately: it makes "no cursor" an ordinary comparable
 * value, so the ordering is total and testable rather than a special case.
 *
 * Exported because it is also the honest answer to "what is this sweep going
 * to do next?" for ops — ids only, never tenant data.
 */
export async function listBrokeragesDueForSweep(limit: number): Promise<number[]> {
  const rows = await db
    .select({ id: brokerages.id })
    .from(brokerages)
    .leftJoin(growSignalSweepCursors, eq(growSignalSweepCursors.brokerageId, brokerages.id))
    .orderBy(sql`coalesce(${growSignalSweepCursors.lastEvaluatedAt}, timestamp 'epoch') asc`, asc(brokerages.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Stamps ONLY last_evaluated_at (plus the run id) for a brokerage whose pass
 * threw, so the failing tenant advances past itself in the durable ordering
 * and cannot starve every brokerage behind it.
 *
 * Deliberately does not touch source_high_water_marks or
 * last_full_evaluation_at: a failed pass proves nothing about what this
 * brokerage's sources contain, so the next pass must still do a full
 * evaluation rather than skip it as unchanged.
 */
async function touchBrokerageCursor(brokerageId: number, sweepRunId: string, now: Date): Promise<void> {
  await db
    .insert(growSignalSweepCursors)
    .values({ brokerageId, lastEvaluatedAt: now, lastFullEvaluationAt: null, lastSweepRunId: sweepRunId, updatedAt: now })
    .onConflictDoUpdate({
      target: growSignalSweepCursors.brokerageId,
      set: {
        lastEvaluatedAt: sql`excluded.last_evaluated_at`,
        lastSweepRunId: sql`excluded.last_sweep_run_id`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
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
export async function probeBrokerage(brokerageId: number, now: Date): Promise<{
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
      (select max(a.updated_at) from appraisals a join properties p on p.id = a.property_id where p.brokerage_id = ${brokerageId} and a.brokerage_id = ${brokerageId})::text as appraisals,
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
  // Both expiry passes below feed ONE counter increment at the end of this
  // function, so property_signal_outcome_total{outcome="expired"} matches what
  // this pass actually retired. Before W1-D that label was declared and never
  // incremented — the number was computed here and discarded.
  let expiredThisPass = expired;

  // 2. Set-based evaluation of every rule.
  //
  //    STAGE 2: `ruleCursors` in / `nextRuleCursors` out is the per-rule
  //    continuation. Each rule gets a fair share of maxCandidates and, if it
  //    fills it, records where it stopped so the NEXT run resumes after that
  //    point instead of re-reading the same head of the table forever. See
  //    evaluation.ts's "PER-RULE BUDGETING" block for why this exists.
  const { candidates, truncated, nextRuleCursors } = await evaluateCandidates({
    brokerageId,
    now,
    maxCandidates: options.maxCandidatesPerBrokerage,
    ruleCursors: (cursor?.ruleCursors as Record<string, number> | null) ?? {},
  });
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
    const unsupported = await expireUnsupportedSignals(brokerageId, supported, now);
    summary.signalsExpired += unsupported;
    expiredThisPass += unsupported;
  }

  summary.brokeragesEvaluated += 1;

  incrementCounter("property_signal_outcome_total", { outcome: "created" }, upsert.created);
  incrementCounter("property_signal_outcome_total", { outcome: "updated" }, upsert.updated);
  incrementCounter("property_signal_outcome_total", { outcome: "re_raised" }, upsert.reRaised);
  incrementCounter("property_signal_outcome_total", { outcome: "expired" }, expiredThisPass);
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

  await writeCursor(brokerageId, sweepRunId, probe.marks, now, !truncated, nextRuleCursors);
}

/** One idempotent upsert per brokerage per pass. */
async function writeCursor(
  brokerageId: number,
  sweepRunId: string,
  marks: Record<string, string | null>,
  now: Date,
  fullEvaluation: boolean,
  // Stage 2: omitted by the SKIPPED path below, which evaluated no rule and
  // therefore has nothing to say about where any rule should resume — a
  // skipped pass must never reset a continuation another pass set.
  ruleCursors?: Record<string, number>,
): Promise<void> {
  await db
    .insert(growSignalSweepCursors)
    .values({
      brokerageId,
      sourceHighWaterMarks: marks,
      ruleCursors: ruleCursors ?? {},
      lastEvaluatedAt: now,
      lastFullEvaluationAt: fullEvaluation ? now : null,
      lastSweepRunId: sweepRunId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: growSignalSweepCursors.brokerageId,
      set: {
        sourceHighWaterMarks: sql`excluded.source_high_water_marks`,
        ruleCursors: ruleCursors === undefined ? sql`${growSignalSweepCursors.ruleCursors}` : sql`excluded.rule_cursors`,
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

/* ---------------------------------------------------------------------
 * OPS HEALTH (AE GROW Completion W1-D, H-2/H-3).
 *
 * Everything below already existed as durable rows and was unreachable over
 * HTTP by any means: last-run time, success/failure, `truncated`, `errors`,
 * per-brokerage staleness, and whether the scheduler is running at all.
 * GROW_SIGNAL_SWEEP_ENABLED=false logged once at boot and thereafter looked
 * exactly like a healthy-but-idle system.
 *
 * This is the whole answer in one call, so the route stays a thin handler and
 * the SQL stays in the module that owns these tables. It is engine-wide, NOT
 * tenant-scoped, which is precisely why the route above it is gated on
 * requireRole(BROKERAGE_ADMIN_ROLES) rather than an entitlement — see the
 * route. Run rows contain counters and ids only; no tenant data ever appears
 * in this payload.
 * -----------------------------------------------------------------*/

export interface SweepOpsHealth {
  scheduler: { enabled: boolean; intervalMs: number; maxBrokerages: number; maxCandidatesPerBrokerage: number };
  recentRuns: Awaited<ReturnType<typeof listRecentSweepRuns>>;
  /** When a run last reached COMPLETED. null means no sweep has EVER completed — not "recently". */
  lastCompletedAt: Date | null;
  staleBy: {
    /** Milliseconds since lastCompletedAt, or null when nothing has ever completed. */
    ageMs: number | null;
    /** 3 × the scheduler interval: two ticks may be missed before this is called stale. */
    thresholdMs: number;
    stale: boolean;
  };
  /** How many brokerages the NEXT run would consider, bounded by maxBrokerages — the same ordering the sweep itself uses. */
  brokeragesDue: number;
  /** The id of a run currently marked RUNNING, or null. A non-null value here with a very old startedAt is the shape of a crashed sweep. */
  runningRunId: string | null;
}

export async function getSweepOpsHealth(now: Date = new Date()): Promise<SweepOpsHealth> {
  const config = sweepConfig();
  const [recentRuns, lastCompleted, running, due] = await Promise.all([
    listRecentSweepRuns(5),
    db
      .select({ completedAt: growSignalSweepRuns.completedAt })
      .from(growSignalSweepRuns)
      .where(eq(growSignalSweepRuns.status, "COMPLETED"))
      .orderBy(desc(growSignalSweepRuns.completedAt))
      .limit(1),
    db
      .select({ id: growSignalSweepRuns.id })
      .from(growSignalSweepRuns)
      .where(eq(growSignalSweepRuns.status, "RUNNING"))
      .orderBy(desc(growSignalSweepRuns.startedAt))
      .limit(1),
    listBrokeragesDueForSweep(config.maxBrokerages),
  ]);

  // Deliberately NOT derived from `recentRuns`: the five most recent runs can
  // all be RUNNING or FAILED, and reporting "never completed" in that case
  // would be a lie of exactly the kind this endpoint exists to prevent.
  const lastCompletedAt = lastCompleted[0]?.completedAt ?? null;
  const thresholdMs = config.intervalMs * 3;
  const ageMs = lastCompletedAt === null ? null : now.getTime() - lastCompletedAt.getTime();
  return {
    scheduler: {
      enabled: config.enabled,
      intervalMs: config.intervalMs,
      maxBrokerages: config.maxBrokerages,
      maxCandidatesPerBrokerage: config.maxCandidatesPerBrokerage,
    },
    recentRuns,
    lastCompletedAt,
    staleBy: {
      ageMs,
      thresholdMs,
      // A system that has never completed a sweep IS stale — nothing has ever
      // been swept. Paired with scheduler.enabled an operator can tell
      // "deliberately switched off" from "switched on and broken", which is
      // the distinction that did not exist before this endpoint.
      stale: ageMs === null || ageMs > thresholdMs,
    },
    brokeragesDue: due.length,
    runningRunId: running[0]?.id ?? null,
  };
}
