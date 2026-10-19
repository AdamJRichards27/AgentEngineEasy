import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { redactSecrets, sanitizeErrorText } from "./artifacts.js";
import { loadAlertCommand, loadProductionBackupConfig } from "./config.js";
import { createBackup, restoreBackup, type EngineDependencies } from "./engine.js";
import type { DocumentObjectReader } from "./objectDocuments.js";
import { parseRestoreArgs, type RestoreArgs } from "./restoreArgs.js";
import type { BackupConfig, BackupOperation, CommandRunner, CommandSpec, OperationLog } from "./types.js";

/**
 * CLI-SPEC §2 (R28), on the D-9 chain (PH-7 R29b). No process.exit(): callers set process.exitCode so output flushes.
 * LOCK_HELD (75) is RESERVED: this base has no backup/restore lock (R26 overlap design not implemented), so it is
 * never returned.
 */
export const EXIT = { OK: 0, FAILED: 1, USAGE: 64, PREFLIGHT: 69, INTERNAL: 70, LOCK_HELD: 75, CONFIG: 78 } as const;
export type CliKind = "backup" | "restore";

class UsageError extends Error {}
export class PreflightError extends Error {
  constructor(readonly tool: string, readonly found: string, readonly required: string) {
    super(`Preflight failed for ${tool}: found ${found}, required ${required}`);
  }
}

export interface CliDependencies {
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** Fixed runner (tests). Exactly one of `run` / `runFor` is used; `runFor` wins. */
  run?: CommandRunner;
  /** Runner for a loaded config: production returns the scoped (environment-isolated) runner when the config has a policy. */
  runFor?: (config: BackupConfig) => CommandRunner;
  /** Runner used before any config exists (config-refused alert only). Defaults to `run`. */
  bootstrapRun?: CommandRunner;
  log?: (entry: OperationLog) => void;
  /** Debug stack sink (stderr by default); used only with BACKUP_DEBUG_STACK=1. */
  stderr?: (text: string) => void;
  nodeVersion?: string;
  /** Object-storage document reader factory (backup with BACKUP_DOCUMENT_SOURCE=object-storage). */
  documentProvider?: () => DocumentObjectReader;
}

const RESTORE_FLAGS = /^(?:--artifact=.*|--tier=.*|--confirm-disposable)$/;

/** Usage errors are checked before any config is read. Restore reuses parseRestoreArgs (incl. --tier). */
export function parseCliArgs(kind: CliKind, argv: string[]): RestoreArgs | Record<string, never> {
  if (kind === "backup") {
    if (argv.length) throw new UsageError("backup:run takes no arguments");
    return {};
  }
  if (argv.some((value) => !RESTORE_FLAGS.test(value))) {
    throw new UsageError("Unknown restore argument; allowed: --artifact=<name> [--tier=daily|weekly|monthly] --confirm-disposable");
  }
  try {
    return parseRestoreArgs(argv);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function defaultLog(entry: OperationLog): void {
  (entry.level === "error" ? process.stderr : process.stdout).write(JSON.stringify(entry) + "\n");
}

async function resolveExecutable(executable: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const candidates = executable.includes("/")
    ? [executable]
    : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

const major = (text: string): number | undefined => {
  const match = /(\d+)(?:\.\d+)?/.exec(text.replace(/^[^\d]*\(PostgreSQL\)\s*/, ""));
  return match ? Number(match[1]) : undefined;
};

/** CLI-SPEC §4: before any staging directory is created. Read-only (version probes only). */
export async function preflight(kind: CliKind, config: BackupConfig, run: CommandRunner, deps: Pick<CliDependencies, "env" | "nodeVersion">): Promise<void> {
  const nodeMajor = major(deps.nodeVersion ?? process.version);
  if (!nodeMajor || nodeMajor < 24) throw new PreflightError("node", String(nodeMajor ?? "unknown"), ">=24");
  const pgTools = kind === "backup" ? ["pg_dump", "psql"] : ["pg_restore", "psql"];
  // Only commands this invocation can actually run are required to resolve.
  const configured: Array<CommandSpec | undefined> =
    kind === "backup"
      ? [config.encryption, config.upload, config.download, config.verifyDownload, config.alert,
        ...(config.prune === true ? [config.list, config.remove, config.deleteVerify] : [])]
      : [config.decryption, config.restoreDownload ?? config.download, config.alert];
  const tools = [...pgTools, "tar", ...configured.flatMap((c) => (c ? [c.executable] : [])).filter((e) => !e.includes("{"))];
  for (const tool of [...new Set(tools)]) {
    if (!(await resolveExecutable(tool, deps.env))) throw new PreflightError(tool, "missing", "present");
  }
  const operation: BackupOperation = kind === "backup" ? "database" : "restore_database";
  const target = kind === "backup" ? config.databaseUrl : config.restoreDatabaseUrl;
  let serverMajor: number | undefined;
  try {
    const out = await run({ executable: "psql", args: ["--no-psqlrc", "-At", "-c", "select current_setting('server_version_num')", target] }, undefined, operation);
    const num = Number(out.stdout.trim());
    serverMajor = Number.isInteger(num) && num > 0 ? Math.floor(num / 10_000) : undefined;
  } catch {
    throw new PreflightError("postgresql-server", "unreachable", "reachable");
  }
  if (!serverMajor) throw new PreflightError("postgresql-server", "unknown", "server_version_num");
  for (const tool of pgTools) {
    const out = await run({ executable: tool, args: ["--version"] }, undefined, operation).catch(() => ({ stdout: "" }));
    const clientMajor = major(out.stdout);
    if (!clientMajor || clientMajor < serverMajor) {
      throw new PreflightError(tool, String(clientMajor ?? "unknown"), `>=${serverMajor}`);
    }
  }
}

const isolationRequested = (env: NodeJS.ProcessEnv): boolean =>
  /^(?:true|1|on)$/i.test(env.BACKUP_ENV_ISOLATION ?? "") || /^(?:true|1|on)$/i.test(env.BACKUP_ENV_ISOLATION_REQUIRED ?? "");

/**
 * Runs one backup/restore CLI invocation and returns its exit code (CLI-SPEC §2). Emits exactly one terminal
 * structured line (the engine's completed/failed, or a backup_* line from here); raw stacks only with
 * BACKUP_DEBUG_STACK=1, sanitised.
 */
export async function runCli(kind: CliKind, deps: CliDependencies): Promise<number> {
  const sink = deps.log ?? defaultLog;
  let terminal = false;
  const log = (entry: OperationLog): void => {
    if (entry.event === "completed" || entry.event === "failed") terminal = true;
    sink(entry);
  };
  const line = (level: OperationLog["level"], event: string, fields: Record<string, unknown> = {}): void =>
    log({ timestamp: new Date().toISOString(), level, operation: kind, event, runId: "cli", ...fields });
  const runnerFor = (config: BackupConfig): CommandRunner => {
    const run = deps.runFor ? deps.runFor(config) : deps.run;
    if (!run) throw new Error("runCli needs run or runFor");
    return run;
  };
  const alert = async (config: BackupConfig | undefined, event: string): Promise<boolean> => {
    let spec: CommandSpec;
    let run: CommandRunner | undefined;
    if (config) {
      spec = config.alert;
      run = runnerFor(config);
    } else {
      // No config: no isolation policy can be applied, so an isolation-required deployment gets no alert from here.
      run = deps.bootstrapRun ?? deps.run;
      try {
        if (isolationRequested(deps.env) || !run) throw new Error("unavailable");
        spec = loadAlertCommand(deps.env);
      } catch {
        line("warn", "alert_unavailable_config_refused");
        return false;
      }
    }
    try {
      await run(spec, { operation: kind, status: "failed", error: event, runId: "cli" }, "alert");
      return true;
    } catch (error) {
      line("error", "alert_failed", { error: sanitizeErrorText(error instanceof Error ? error.message : String(error)) });
      return false;
    }
  };
  try {
    let args: RestoreArgs | Record<string, never>;
    try {
      args = parseCliArgs(kind, deps.argv);
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      line("error", "backup_usage_error", { error: redactSecrets(error.message) });
      return EXIT.USAGE;
    }
    let config: BackupConfig;
    try {
      config = loadProductionBackupConfig(deps.env);
      if (config.envIsolationRequired && !config.envIsolation) {
        throw new Error("Environment isolation is required (BACKUP_ENV_ISOLATION_REQUIRED=true) but no isolation policy is configured");
      }
    } catch (error) {
      // Config errors name variables, never values.
      line("error", "backup_config_refused", { error: redactSecrets(error instanceof Error ? error.message : String(error)) });
      const delivered = await alert(undefined, "backup_config_refused");
      line("info", "backup_config_refused_alert", { alertDelivered: delivered });
      return EXIT.CONFIG;
    }
    const run = runnerFor(config);
    try {
      await preflight(kind, config, run, deps);
    } catch (error) {
      if (!(error instanceof PreflightError)) throw error;
      line("error", "backup_preflight_failed", { tool: error.tool, found: error.found, required: error.required });
      await alert(config, "backup_preflight_failed");
      return EXIT.PREFLIGHT;
    }
    const engineDeps: EngineDependencies = {
      run,
      log,
      ...(kind === "backup" && config.documentSource === "object-storage"
        ? { documentProvider: (deps.documentProvider ?? missingProvider)() }
        : {}),
    };
    try {
      if (kind === "backup") await createBackup(config, engineDeps);
      else await restoreBackup(config, args as RestoreArgs, engineDeps);
      return EXIT.OK;
    } catch (error) {
      // The engine logs + alerts its own failures; refusals raised before its try block do not.
      if (!terminal) line("error", "backup_failed", { error: redactSecrets(error instanceof Error ? error.message : String(error)) });
      return EXIT.FAILED;
    }
  } catch (error) {
    line("error", "backup_internal_error", { error: redactSecrets(error instanceof Error ? error.message : String(error)) });
    if (deps.env.BACKUP_DEBUG_STACK === "1" && error instanceof Error && error.stack) {
      (deps.stderr ?? ((text: string) => process.stderr.write(text)))(redactSecrets(error.stack) + "\n");
    }
    return EXIT.INTERNAL;
  }
}

function missingProvider(): never {
  throw new Error("Object-storage document backup requires a configured object storage provider");
}
