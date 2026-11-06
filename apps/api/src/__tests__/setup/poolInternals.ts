// TEST-ONLY. The pg-pool private internals that the shared test pool teardown (poolTeardown.ts)
// relies on, checked in one place. Written against pg-pool 3.14.0 (pg 8.23.0). The guard test
// (src/lib/__tests__/poolTeardownGuard.test.ts) runs this against a real pool, so an upgrade that
// moves any of these fails the suite by name instead of silently bringing back the ~10 s exit
// wait per DB test file.

/** The preload flag in apps/api's `test` script. */
export const POOL_TEARDOWN_PRELOAD = "--import ./src/__tests__/setup/poolTeardown.ts";

type Unrefable = { unref(): unknown };
export type PoolTeardownInternals = {
  ended: boolean;
  end(): Promise<void>;
  options: { allowExitOnIdle: boolean };
  _idle: Array<{ client: Unrefable; timeoutId?: Unrefable }>;
};

const isFn = (v: unknown): boolean => typeof v === "function";

/** Throws one Error that names every missing or reshaped field. */
export function assertPoolTeardownInternals(pool: unknown): asserts pool is PoolTeardownInternals {
  const p = pool as Record<string, unknown> | null;
  const bad: string[] = [];
  if (!p || typeof p !== "object") bad.push("pool is not an object");
  else {
    if (typeof p.ended !== "boolean") bad.push(`pool.ended must be a boolean (got ${typeof p.ended})`);
    if (!isFn(p.end)) bad.push("pool.end() must be a function");
    const o = p.options as Record<string, unknown> | undefined;
    if (!o || typeof o !== "object") bad.push("pool.options must be an object");
    else if (typeof o.allowExitOnIdle !== "boolean") bad.push(`pool.options.allowExitOnIdle must be a boolean (got ${typeof o.allowExitOnIdle})`);
    if (!Array.isArray(p._idle)) bad.push(`pool._idle must be an array of idle items (got ${typeof p._idle})`);
    else
      p._idle.forEach((item: unknown, i: number) => {
        const it = item as { client?: { unref?: unknown }; timeoutId?: { unref?: unknown } } | null;
        if (!it || !it.client || !isFn(it.client.unref)) bad.push(`pool._idle[${i}].client.unref() must be a function`);
        if (it && it.timeoutId !== undefined && !(it.timeoutId && isFn((it.timeoutId as { unref?: unknown }).unref)))
          bad.push(`pool._idle[${i}].timeoutId must be a timer with unref()`);
      });
  }
  if (bad.length)
    throw new Error(
      `pg-pool internals used by the test pool teardown changed (written for pg-pool 3.14.0): ${bad.join("; ")}. ` +
        "Update apps/api/src/__tests__/setup/poolInternals.ts, or every DB test file will again wait ~10 s to exit.",
    );
}

/** Stops the pool from holding the process open: unrefs idle clients and their idle timers, and
 *  makes pg-pool unref clients released from now on. Does not end the pool. */
export function releasePoolForExit(pool: unknown): void {
  assertPoolTeardownInternals(pool);
  pool.options.allowExitOnIdle = true;
  for (const item of pool._idle) {
    item.timeoutId?.unref();
    item.client.unref();
  }
}
