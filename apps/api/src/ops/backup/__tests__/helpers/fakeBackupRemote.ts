import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand } from "../../commands.js";
import { createBackup } from "../../engine.js";
import type { BackupConfig, CommandRunner, CommandSpec, OperationLog, RemoteObject } from "../../types.js";

/**
 * Shared engine test harness (UNTESTED proposal, PH-7 post-R-1).
 *
 * A single fake "remote" that implements upload, download, list and delete so that retention
 * (prune) and post-upload verification (download + manifest/SHA-256 re-check) are exercised
 * together through the REAL createBackup(). Nothing in the engine is stubbed or bypassed:
 * verification-before-prune is enforced by the engine and observable through `calls`.
 *
 * Remote model:
 *  - `uploaded` holds the real bytes of objects the engine uploaded (keyed by object name).
 *  - `seed` are pre-existing remote objects (listing metadata only, no bytes). Downloading a seeded
 *    object fails loudly instead of silently succeeding.
 *  - list returns `seed` by default (matches the original prune tests' fixed listing). With
 *    `listIncludesUploads: true` it also returns objects the run uploaded, like a real bucket.
 */
export interface FakeRemoteOptions {
  seed?: RemoteObject[];
  retentionDays?: number;
  minRetainedBackups?: number;
  now?: Date;
  /** Delete refused (e.g. Object Lock AccessDenied). */
  failRemove?: boolean;
  listIncludesUploads?: boolean;
  /** Called after each successful upload; may mutate `uploaded` to simulate remote corruption. */
  afterUpload?: (uploaded: Map<string, Buffer>, object: string) => void;
  /** Make downloads of matching object names fail. */
  failDownload?: RegExp;
  /** Document keys reported by the database inventory (psql). */
  documentKeys?: string[];
  /** Make uploads of matching object keys fail (simulates a tier upload outage). */
  failUpload?: RegExp;
  /** Make the list command fail. */
  failList?: boolean;
  /** Make the alert command fail. */
  failAlert?: boolean;
  /** Refuse (throw on) deletes only for object keys matching this pattern (e.g. artifacts but not manifests). */
  failRemovePattern?: RegExp;
  /** Ambiguous delete: the object IS removed remotely but the command still reports failure (e.g. timeout after the request landed). */
  removeThenThrow?: RegExp;
  /** Make `list` reflect removals (a real bucket). Default false keeps the original fixed-listing behaviour. */
  applyRemovals?: boolean;
  /** Message thrown by refused deletes (default "AccessDenied: object lock"). */
  removeError?: string;
  /** Enable pruning (production default is OFF since D-2; tests that exercise pruning opt in explicitly). */
  prune?: boolean;
  /**
   * D-9: configure a post-delete verification command. A verify of an object passes only if the delete command
   * removed it AND it does not match `verifyStillPresent` (models a delete marker / surviving version on a
   * versioned or Object Lock bucket, where the delete command exits 0 but the data is still there).
   * `verifyFails` makes the verifier itself fail (transport error / no permission).
   */
  verifyDelete?: { stillPresent?: RegExp; fails?: boolean; /** raw stdout the verifier prints on exit 0 (default: the verified-absent JSON line) */ stdout?: string; /** verify_class= text carried by the failure message */ errorClass?: string };
  /** R19: do NOT auto-install a verifier when pruning is on (to prove the engine fails closed without one). */
  omitVerifier?: boolean;
  /** Extra BackupConfig fields (tier policy, prune switch, vault mode, ...). */
  configOverrides?: Partial<BackupConfig>;
}

export interface FakeRemote {
  /** Ordered `executable[:object]` trail of every command the engine ran. */
  calls: string[];
  logs: OperationLog[];
  alerts: Array<Record<string, string>>;
  uploaded: Map<string, Buffer>;
  /** Objects removed through the delete command. */
  removed: string[];
  /** Backup operation (scoped-environment selector) passed with every command, in order. */
  operations: string[];
  /** Mutable delete-fault controls (initialised from the options); lets a test lift a refusal between runs. */
  controls: { failRemove?: boolean; failRemovePattern?: RegExp; removeThenThrow?: RegExp };
  config: BackupConfig;
  run: CommandRunner;
  /** Run the real createBackup() against this fake remote. */
  createBackup: () => Promise<string>;
  cleanup: () => Promise<void>;
}

export async function createFakeRemote(options: FakeRemoteOptions = {}): Promise<FakeRemote> {
  const root = await mkdtemp(path.join(tmpdir(), "aee-engine-"));
  await mkdir(path.join(root, "documents"), { recursive: true });
  const spec = (executable: string): CommandSpec => ({ executable, args: [] });
  const config: BackupConfig = {
    databaseUrl: "postgresql://source.invalid/aee",
    documentDirectory: path.join(root, "documents"),
    restoreDatabaseUrl: "postgresql://restore.invalid/aee_restore",
    restoreDocumentDirectory: path.join(root, "restore-root", "documents"),
    restoreRoot: path.join(root, "restore-root"),
    restoreEnvironmentId: "restore-drill-01",
    encryptionKmsProfile: "kms:production-backup",
    stagingDirectory: path.join(root, "staging"),
    destination: "durable://vault/backups",
    retentionDays: options.retentionDays ?? 30,
    ...(options.minRetainedBackups === undefined ? {} : { minRetainedBackups: options.minRetainedBackups }),
    encryption: spec("encrypt"), decryption: spec("decrypt"), upload: spec("upload"),
    download: spec("download"), list: spec("list"), remove: spec("remove"), alert: spec("alert"),
    ...(options.prune === undefined ? {} : { prune: options.prune }),
    ...(options.verifyDelete ? { deleteVerify: spec("verify-delete") } : {}),
    ...(options.configOverrides ?? {}),
  };
  // R19: pruning needs a verifier. Tests that merely exercise pruning get an implicit one that is NOT recorded in the
  // call trail (so their expectations are unchanged); tests of the verifier itself pass `verifyDelete` explicitly.
  const implicitVerifier = config.prune === true && !config.deleteVerify && !options.omitVerifier;
  if (implicitVerifier) config.deleteVerify = spec("verify-delete");
  const calls: string[] = [];
  const logs: OperationLog[] = [];
  const alerts: Array<Record<string, string>> = [];
  const uploaded = new Map<string, Buffer>();
  const removed: string[] = [];
  const seed = options.seed ?? [];
  const controls: FakeRemote["controls"] = {
    failRemove: options.failRemove,
    failRemovePattern: options.failRemovePattern,
    removeThenThrow: options.removeThenThrow,
  };

  const operations: string[] = [];
  const run: CommandRunner = async (command, replacements = {}, operation) => {
    const object = replacements.object;
    if (!(implicitVerifier && command.executable === "verify-delete")) {
      operations.push(`${command.executable}:${operation ?? "-"}`);
      calls.push(object ? `${command.executable}:${object}` : command.executable);
    }
    switch (command.executable) {
      case "pg_dump":
        await writeFile(command.args[command.args.indexOf("--file") + 1]!, "dump");
        return { stdout: "", stderr: "" };
      case "psql":
        return {
          stdout: JSON.stringify({ tenantCount: 1, recordCounts: {}, documentKeys: options.documentKeys ?? [] }),
          stderr: "",
        };
      case "tar":
        return runCommand(command);
      case "encrypt":
        await copyFile(replacements.input!, replacements.output!);
        return { stdout: "", stderr: "" };
      case "upload":
        if (options.failUpload?.test(object!)) throw new Error("upload refused");
        uploaded.set(object!, await readFile(replacements.source!));
        options.afterUpload?.(uploaded, object!);
        return { stdout: "", stderr: "" };
      case "download":
      case "verify-download":
      case "restore-download": {
        if (options.failDownload?.test(object!)) throw new Error("NoSuchKey");
        const content = uploaded.get(object!);
        if (!content) throw new Error(`missing remote object ${object}`);
        await writeFile(replacements.destination!, content);
        return { stdout: "", stderr: "" };
      }
      case "list": {
        if (options.failList) throw new Error("list refused");
        const live: RemoteObject[] = options.listIncludesUploads
          ? [...uploaded.keys()].map((key) => ({ key, lastModified: (options.now ?? new Date("2026-03-01T00:00:00Z")).toISOString() }))
          : [];
        const all = [...seed, ...live];
        const visible = options.applyRemovals ? all.filter((o) => !removed.includes(o.key)) : all;
        return { stdout: JSON.stringify(visible), stderr: "" };
      }
      case "remove":
        if (controls.failRemove) throw new Error(options.removeError ?? "AccessDenied: object lock");
        if (controls.failRemovePattern?.test(object!)) throw new Error(options.removeError ?? "AccessDenied: object lock");
        removed.push(object!);
        if (controls.removeThenThrow?.test(object!)) throw new Error("RequestTimeout: delete outcome unknown");
        return { stdout: "", stderr: "" };
      case "verify-delete":
        if (options.verifyDelete?.fails) throw new Error(`verifier unavailable verify_class=${options.verifyDelete.errorClass ?? "inconclusive"}`);
        if (!removed.includes(object!) || options.verifyDelete?.stillPresent?.test(object!)) {
          throw new Error(`still present: version or delete marker remains verify_class=${options.verifyDelete?.errorClass ?? "delete_marker_retained"}`);
        }
        return { stdout: options.verifyDelete?.stdout ?? '{"verifier":"fake","class":"absent","verified":true,"versions":0,"deleteMarkers":0}\n', stderr: "" };
      case "alert":
        alerts.push(replacements);
        if (options.failAlert) throw new Error("alert transport down");
        return { stdout: "", stderr: "" };
      default:
        throw new Error(`unexpected ${command.executable}`);
    }
  };

  return {
    calls, logs, alerts, uploaded, removed, operations, controls, config, run,
    createBackup: async () => {
      return createBackup(config, {
        run,
        now: () => options.now ?? new Date("2026-03-01T00:00:00Z"),
        log: (entry) => logs.push(entry),
      });
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
