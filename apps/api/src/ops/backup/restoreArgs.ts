import type { Tier } from "./artifacts.js";

export interface RestoreArgs {
  artifact: string;
  confirmDisposable: boolean;
  /** Omitted = legacy flat layout (backups written before tiering). */
  tier?: Tier;
  /** WS4-13: `--require-archive-version` — refuse a manifest that records no dumpArchiveVersion. Present only when set. */
  requireArchiveVersion?: true;
}

/**
 * WS4-13 strict mode, env form. Name: BACKUP_ (every backup/restore CLI variable) + RESTORE_ (read by restore only;
 * backup ignores it) + REQUIRE_ARCHIVE_VERSION (what it enforces: the manifest must record dumpArchiveVersion). Same
 * words as the CLI flag `--require-archive-version`.
 */
export const STRICT_ARCHIVE_VERSION_ENV = "BACKUP_RESTORE_REQUIRE_ARCHIVE_VERSION";

/**
 * Unset -> false (legacy manifests stay accepted). Exactly "true"/"false" otherwise; any other value, including an
 * empty string or different case, throws (fail closed: a typo must not silently mean "not strict").
 */
export function restoreStrictFromEnv(env: Record<string, string | undefined>): boolean {
  const value = env[STRICT_ARCHIVE_VERSION_ENV];
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${STRICT_ARCHIVE_VERSION_ENV} must be exactly "true" or "false" when set`);
}

function valueOf(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

/** Parses `backup:restore` CLI arguments (argv excludes node and the script path). Pure; throws on invalid input. */
export function parseRestoreArgs(argv: string[]): RestoreArgs {
  const artifact = valueOf(argv, "artifact");
  if (!artifact) throw new Error("Required argument --artifact=... is missing");
  const tier = valueOf(argv, "tier");
  if (tier !== undefined && tier !== "daily" && tier !== "weekly" && tier !== "monthly") {
    throw new Error("--tier must be daily, weekly or monthly");
  }
  return {
    artifact,
    confirmDisposable: argv.includes("--confirm-disposable"),
    ...(tier === undefined ? {} : { tier }),
    ...(argv.includes("--require-archive-version") ? { requireArchiveVersion: true as const } : {}),
  };
}
