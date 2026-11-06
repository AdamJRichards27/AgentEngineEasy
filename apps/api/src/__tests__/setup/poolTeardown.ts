// TEST-ONLY. Preloaded into every API test file's process via `--import` in the package.json
// "test" script. Once a file's tests and after() hooks have all finished, it ends the shared
// @aee/db pool, so the process exits straight away instead of waiting out pg-pool's 10 s idle
// timer (the idleTimeoutMillis default) on each idle client.
//
// The order matters. A root after() registered here runs BEFORE the test file's own after()
// hooks: node:test runs root hooks in registration order, and this module loads first. Ending the
// pool there would break any file that still queries in its own teardown. So this hook only stops
// the pool from holding the process open (releasePoolForExit, poolInternals.ts). The real
// pool.end() runs on 'beforeExit', once nothing else keeps the event loop alive, which is after
// every hook.
//
// It is idempotent with files that end the pool themselves (pool.ended is checked). Files with
// their own pools or child processes are not touched. Production pool code (createSafePool,
// idleTimeoutMillis) is unchanged. It does nothing in the test-runner parent process
// (NODE_TEST_CONTEXT unset). If pg-pool's internals change, it throws a named error (the file's
// tests fail); poolTeardownGuard.test.ts catches the same thing on its own.
import { after } from "node:test";
import { releasePoolForExit } from "./poolInternals.js";

if (process.env.NODE_TEST_CONTEXT) {
  after(async () => {
    let pool: { ended: boolean; end(): Promise<void> };
    try {
      // Lazy import: loading @aee/db up front would create the pool before a test file sets
      // DATABASE_URL, PG_POOL_MAX and similar. A file that never touched the DB gets a fresh pool
      // that never connected, so ending it costs nothing.
      pool = (await import("@aee/db")).pool as unknown as typeof pool;
    } catch {
      return;
    }
    if (pool.ended) return;
    releasePoolForExit(pool);
    process.once("beforeExit", () => {
      if (!pool.ended) pool.end().catch(() => {});
    });
  });
}
