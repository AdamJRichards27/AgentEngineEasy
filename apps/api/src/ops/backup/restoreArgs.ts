import type { Tier } from "./artifacts.js";

export interface RestoreArgs {
  artifact: string;
  confirmDisposable: boolean;
  /** Omitted = legacy flat layout (backups written before tiering). */
  tier?: Tier;
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
  };
}
