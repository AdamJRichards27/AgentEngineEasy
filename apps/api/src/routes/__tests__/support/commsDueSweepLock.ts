// Test-only cross-process coordination for the communications due-message
// sweep (lib/communications/outbox.ts dispatchDueMessages).
//
// WHY. dispatchDueMessages() selects QUEUED / RETRY_SCHEDULED rows with
// scheduledAt <= its `now` across EVERY brokerage. The test runner gives each
// test FILE its own process, and all of them share one database. A suite that
// sweeps with a `now` in the future (communicationsDispatchConsentRecheck)
// therefore also picks up another file's message in the instant between that
// file's /send moving it to QUEUED (scheduledAt = now) and the route's own
// inline dispatch. The sibling's sweep moves it to SENDING first, and the
// route then answers 409 ("changed by someone else") or 422 ("this one is
// SENDING"): the flake seen in communicationsGrowThreadEntitlement.
//
// HOW. One Postgres advisory lock, taken on a dedicated pooled connection:
//   * a test that sweeps holds it EXCLUSIVE around each dispatchDueMessages();
//   * a test whose /send is expected to dispatch inline holds it SHARED
//     around that request.
// Shared holders never wait for each other, so suites that send in parallel
// are not serialised; only a sweep waits for in-flight sends to finish, and
// a send waits for an in-progress sweep. The key is used by no production
// code. Production behaviour is not changed by this file.
import { db } from "@aee/db";

/** "TEST" / "CDSW" — a test-only advisory-lock key pair no production code takes. */
const LOCK_NAMESPACE = 0x54455354;
const LOCK_KEY = 0x43445357;

async function withAdvisoryLock<T>(mode: "shared" | "exclusive", fn: () => Promise<T>): Promise<T> {
  const client = await db.$client.connect();
  const lockFn = mode === "shared" ? "pg_advisory_lock_shared" : "pg_advisory_lock";
  const unlockFn = mode === "shared" ? "pg_advisory_unlock_shared" : "pg_advisory_unlock";
  try {
    await client.query(`select ${lockFn}($1::int4, $2::int4)`, [LOCK_NAMESPACE, LOCK_KEY]);
  } catch (err) {
    client.release(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
  try {
    return await fn();
  } finally {
    try {
      await client.query(`select ${unlockFn}($1::int4, $2::int4)`, [LOCK_NAMESPACE, LOCK_KEY]);
      client.release();
    } catch (err) {
      // Destroying the connection drops a session advisory lock, so a failed
      // unlock can never leave the lock held.
      client.release(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/** Wrap a dispatchDueMessages() call: no other file's inline send is mid-flight while it selects and dispatches. */
export function withExclusiveDueSweep<T>(fn: () => Promise<T>): Promise<T> {
  return withAdvisoryLock("exclusive", fn);
}

/** Wrap a request whose message is expected to be queued and dispatched inline by the route itself. */
export function withInlineDispatch<T>(fn: () => Promise<T>): Promise<T> {
  return withAdvisoryLock("shared", fn);
}
