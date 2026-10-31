// Owner t225u (31 Oct 2026): dev-login must NOT auto-grant run.access on shared environments.
// Granted only when explicitly authorised:
//   * NODE_ENV=test (automated suites on throwaway/CI databases), or
//   * AE_DEV_LOGIN_GRANTS_RUN_ACCESS=true (explicit opt-in for a non-shared dev box), or
//   * the brokerage name matches AE_DEV_LOGIN_RUN_ACCESS_ALLOWLIST (comma-separated exact names or
//     "prefix*" entries) — named, Owner-authorised test tenants on a shared environment.
// Anything else (staging, pilot, production, an unset flag) gets no grant. Note: the boot backfill
// (AE_RUN_ACCESS_BOOT_BACKFILL) still grants run.access to grant-less brokerages until it is switched off.
export function devLoginGrantsRunAccess(brokerageName: string, env: Record<string, string | undefined> = process.env): { grant: boolean; reason: string } {
  if (env.NODE_ENV === "test") return { grant: true, reason: "NODE_ENV_TEST" };
  if ((env.AE_DEV_LOGIN_GRANTS_RUN_ACCESS ?? "").trim().toLowerCase() === "true") return { grant: true, reason: "EXPLICIT_FLAG" };
  const entries = (env.AE_DEV_LOGIN_RUN_ACCESS_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const e of entries) {
    if (e.endsWith("*") ? e.length > 1 && brokerageName.startsWith(e.slice(0, -1)) : brokerageName === e) return { grant: true, reason: "ALLOWLIST" };
  }
  return { grant: false, reason: "NOT_AUTHORISED" };
}
