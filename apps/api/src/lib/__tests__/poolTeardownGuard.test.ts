// Q-01e GUARD for the test-only shared pool teardown (src/__tests__/setup/poolTeardown.ts).
//
// The teardown relies on private pg-pool internals (pinned pg-pool 3.14.0 via pg 8.23.0):
// pool._idle (an array of { client, timeoutId }), the per-item client.unref() and
// timeoutId.unref(), the pool.options.allowExitOnIdle flag (read on each release), plus the
// public pool.ended and pool.end(). If a pg/pg-pool upgrade renames or reshapes any of these,
// the teardown can no longer release the pool and every DB test file goes back to waiting out
// pg-pool's 10 s idle timer before it exits. Nothing would fail; the suite would just get about
// 4x slower again. These tests turn that into a loud, named failure.
//
// They also check the wiring the teardown depends on: the apps/api `test` script must preload it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createSafePool } from "@aee/db";
import { assertPoolTeardownInternals, releasePoolForExit, POOL_TEARDOWN_PRELOAD } from "../../__tests__/setup/poolInternals.js";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("pool teardown wiring: the apps/api `test` script preloads the teardown, and the module exists", () => {
  const script: string = JSON.parse(readFileSync(join(apiDir, "package.json"), "utf8")).scripts.test;
  assert.ok(
    script.startsWith(`tsx --test ${POOL_TEARDOWN_PRELOAD} `),
    `apps/api "test" script must start with "tsx --test ${POOL_TEARDOWN_PRELOAD}"; without the preload every DB test file waits about 10 s to exit. Got: ${script.slice(0, 120)}`,
  );
  assert.ok(existsSync(join(apiDir, POOL_TEARDOWN_PRELOAD.replace("--import ./", ""))), "src/__tests__/setup/poolTeardown.ts is missing");
});

test("pool teardown guard: a real pool (the installed pg-pool) still has every private field the teardown uses, and unref'ing really releases it", async () => {
  const pool = createSafePool(process.env.DATABASE_URL!);
  try {
    const client = await pool.connect();
    await client.query("select 1");
    client.release(); // now idle: pg-pool has armed its idle timer for it
    assertPoolTeardownInternals(pool); // throws with a named field if anything moved
    const idle = (pool as unknown as { _idle: Array<{ timeoutId: NodeJS.Timeout }> })._idle;
    assert.equal(idle.length, 1, "expected exactly one idle client after a single release");
    assert.equal(idle[0].timeoutId.hasRef(), true, "precondition: pg-pool's idle timer holds the process open");
    releasePoolForExit(pool);
    assert.equal(idle[0].timeoutId.hasRef(), false, "after releasePoolForExit the idle timer must no longer hold the process open");
    assert.equal((pool as unknown as { options: { allowExitOnIdle: boolean } }).options.allowExitOnIdle, true);
    // A client released after the switch must be unref'd by pg-pool itself (it reads options.allowExitOnIdle on release).
    const again = await pool.connect();
    again.release();
    const idle2 = (pool as unknown as { _idle: Array<{ timeoutId: NodeJS.Timeout }> })._idle;
    assert.equal(idle2.at(-1)!.timeoutId.hasRef(), false, "pg-pool no longer honours options.allowExitOnIdle on release");
  } finally {
    await pool.end();
  }
});

test("pool teardown guard: a pool missing or reshaping those fields fails loudly, naming the field", () => {
  const good = () => ({ ended: false, end: async () => {}, options: { allowExitOnIdle: false }, _idle: [{ client: { unref() {} }, timeoutId: setTimeout(() => {}, 0) }] });
  const cases: Array<[string, (p: ReturnType<typeof good>) => unknown, RegExp]> = [
    ["no _idle", (p) => { delete (p as Partial<typeof p>)._idle; }, /_idle/],
    ["_idle not an array", (p) => { (p as unknown as { _idle: unknown })._idle = {}; }, /_idle/],
    ["no options", (p) => { delete (p as Partial<typeof p>).options; }, /options/],
    ["allowExitOnIdle not boolean", (p) => { (p.options as unknown as { allowExitOnIdle: unknown }).allowExitOnIdle = "no"; }, /allowExitOnIdle/],
    ["ended not boolean", (p) => { (p as unknown as { ended: unknown }).ended = undefined; }, /ended/],
    ["end not a function", (p) => { (p as unknown as { end: unknown }).end = null; }, /end\(\)/],
    ["idle client without unref()", (p) => { p._idle[0].client = {} as { unref(): void }; }, /client\.unref/],
    ["idle timer without unref()", (p) => { (p._idle[0] as unknown as { timeoutId: unknown }).timeoutId = 42; }, /timeoutId/],
  ];
  for (const [name, mutate, field] of cases) {
    const p = good(); mutate(p);
    assert.throws(() => assertPoolTeardownInternals(p), (err: Error) => {
      assert.match(err.message, /pg-pool internals used by the test pool teardown changed/, name);
      assert.match(err.message, field, name);
      return true;
    }, `stub "${name}" must be rejected`);
  }
  assert.doesNotThrow(() => assertPoolTeardownInternals(good()));
  for (const p of [good()]) clearTimeout(p._idle[0].timeoutId);
});
