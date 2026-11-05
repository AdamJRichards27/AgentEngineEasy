// Test-only helpers: cross-FILE contention on the signal sweep's
// single-flight advisory lock. Not a test file (no .test.ts suffix), so the
// runner never executes it on its own.
//
// The lock is DATABASE-wide. The test runner gives each test FILE its own
// process, but every process shares one database, and sweep.test.ts,
// sweepRemediation.test.ts, sweepOps.test.ts, sweepScale.test.ts,
// rules.test.ts, contactAnchoredSignals.test.ts and the ops route suite all
// sweep or hold that lock. A sibling file can therefore legitimately hold it
// at the instant a test wants it: the single-flight guarantee working, not a
// defect. Asserting "my sweep ran" or "the lock is free" on the FIRST try made
// these files fail whenever they overlapped.
//
// Each helper waits out a sibling holder. The wait is bounded and fails
// loudly, so a genuinely leaked lock still fails the suite instead of hanging
// it. Same approach sweepOps.test.ts already takes, with a longer bound
// because sweepScale.test.ts can hold the lock for seconds on a loaded box.
import assert from "node:assert/strict";
import { runSignalSweep, tryHoldSignalSweepLockForTests, resetSweepResumePointForTests } from "../sweep.js";

export const LOCK_CONTENTION_DEADLINE_MS = 60_000;
const LOCK_CONTENTION_WAIT_MS = 50;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Takes the sweep lock for a test, waiting out a sibling file that holds it. */
export async function acquireSweepLockForTest(): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_CONTENTION_DEADLINE_MS;
  for (;;) {
    const release = await tryHoldSignalSweepLockForTests();
    if (release) return release;
    if (Date.now() >= deadline) {
      throw new Error(
        `The sweep advisory lock was still held after ${LOCK_CONTENTION_DEADLINE_MS} ms. ` +
          "Either a sibling suite is sweeping for an unusually long time, or the lock has genuinely leaked.",
      );
    }
    await pause(LOCK_CONTENTION_WAIT_MS);
  }
}

export type SweepOptions = NonNullable<Parameters<typeof runSignalSweep>[1]>;
export type SweepRan = Extract<Awaited<ReturnType<typeof runSignalSweep>>, { ok: true }>;

/**
 * Runs a sweep that must actually happen, waiting out "already running"
 * refusals caused by a sibling file. Any other refusal fails immediately.
 * `beforeAttempt` runs before every attempt, to reset per-attempt counters or
 * re-establish state a sibling's sweep could have moved while this one waited.
 *
 * Before each attempt it first waits until the lock is free (take and drop
 * it), so a refusal only happens if a sibling takes the lock in the instant
 * between. A refusal caused by a sibling file is not what any caller is
 * testing, so after one the process's consecutive-orphaned-refusal count is
 * reset: contention retries must not add up to a lock-leak alert that a test
 * in this file then sees.
 */
export async function sweepWhenLockFree(options: SweepOptions, beforeAttempt?: () => Promise<void> | void): Promise<SweepRan> {
  const deadline = Date.now() + LOCK_CONTENTION_DEADLINE_MS;
  for (;;) {
    const probe = await acquireSweepLockForTest();
    await probe();
    if (beforeAttempt) await beforeAttempt();
    const result = await runSignalSweep("MANUAL", options);
    if (result.ok) return result;
    assert.match(result.skippedReason, /already running/i, `sweep was skipped for a reason other than lock contention: ${result.skippedReason}`);
    resetSweepResumePointForTests();
    if (Date.now() >= deadline) assert.fail(`sweep was skipped for ${LOCK_CONTENTION_DEADLINE_MS} ms: ${result.skippedReason}`);
    await pause(LOCK_CONTENTION_WAIT_MS);
  }
}
