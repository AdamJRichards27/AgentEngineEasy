// Owner t225u / t249u: Run access is never granted automatically on a shared environment.
//
// 1. Dev-login: grants run.access ONLY under NODE_ENV=test (automated suites on throwaway/CI
//    databases, which build their Run fixtures through dev-login). A deployed environment runs
//    with NODE_ENV=production (and ALLOW_DEV_AUTH off, so dev-login itself is unavailable), so this
//    branch cannot be reached there. There is no flag or allowlist that re-enables the grant.
// 2. Boot backfill (lib/billing/runAccessBackfill.ts): SAFE BY DEFAULT. It runs only when
//    AE_RUN_ACCESS_BOOT_BACKFILL is the literal string "true". Unset, empty, "false" or anything
//    else disables it, so Grow-only, unsubscribed and newly created brokerages do not receive
//    run.access merely because the application started. Disabling it revokes nothing: grants the
//    backfill already wrote stay as they are.
import { ensureRunAccessBackfilled } from "./runAccessBackfill.js";

type Env = Record<string, string | undefined>;

export function devLoginGrantsRunAccess(_brokerageName: string, env: Env = process.env): { grant: boolean; reason: string } {
  if (env.NODE_ENV === "test") return { grant: true, reason: "NODE_ENV_TEST" };
  return { grant: false, reason: "NOT_AUTHORISED" };
}

export function runAccessBootBackfillEnabled(env: Env = process.env): boolean {
  return env.AE_RUN_ACCESS_BOOT_BACKFILL === "true";
}

/** Boot hook used by index.ts. Returns whether the backfill ran. */
export async function maybeRunAccessBootBackfill(env: Env = process.env, backfill: () => Promise<void> = ensureRunAccessBackfilled): Promise<boolean> {
  if (!runAccessBootBackfillEnabled(env)) return false;
  await backfill();
  return true;
}
