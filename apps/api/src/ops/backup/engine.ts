import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_MIN_RETAINED_BACKUPS,
  DEFAULT_TIER_POLICY,
  MANIFEST_SUFFIX,
  artifactName,
  assessListing,
  planTierRetention,
  sanitizeErrorText,
  tierKey,
  tiersFor,
  verifyManifest,
  writeManifest,
  type Tier,
} from "./artifacts.js";
import {
  newRunMarker, safeRemoveRunDirectory, startHeartbeat, sweepStaging, updateRunMarker, writeRunMarker,
} from "./stagingSweep.js";
import { assertRestoreTargetIsEmpty, readDatabaseInventory, validateDatabaseInventory } from "./database.js";
import { stageObjectStorageDocuments, type DocumentObjectReader } from "./objectDocuments.js";
import { compareDocumentKeys, documentInventory, prepareEmptyRestoreDirectory } from "./documents.js";
import type {
  BackupConfig,
  CommandRunner,
  DatabaseInventory,
  OperationLog,
  RemoteObject,
} from "./types.js";

export interface EngineDependencies {
  run: CommandRunner;
  now?: () => Date;
  log?: (entry: OperationLog) => void;
  /** Required when config.documentSource is "object-storage". */
  documentProvider?: DocumentObjectReader;
}

function defaultLog(entry: OperationLog): void {
  const output = JSON.stringify(entry) + "\n";
  (entry.level === "error" ? process.stderr : process.stdout).write(output);
}

function remoteUri(destination: string, name: string): string {
  // Encode each path segment but keep "/" so tier folders (daily/, weekly/, monthly/) stay folders.
  return `${destination}/${name.split("/").map(encodeURIComponent).join("/")}`;
}

async function notify(
  config: BackupConfig,
  run: CommandRunner,
  replacements: Record<string, string>,
): Promise<void> {
  await run(config.alert, replacements, "alert");
}

/** Alert payloads carry a fixed reason code and counts only (never object keys, provider text or identifiers). */
async function safeAlert(
  config: BackupConfig,
  run: CommandRunner,
  log: (entry: OperationLog) => void,
  runId: string,
  status: string,
  error: string,
): Promise<void> {
  try {
    await notify(config, run, { operation: "backup", status, error, runId });
  } catch (alertError) {
    log({
      timestamp: new Date().toISOString(),
      level: "error",
      operation: "backup",
      event: "alert_failed",
      runId,
      error: sanitizeErrorText(alertError instanceof Error ? alertError.message : String(alertError)),
    });
  }
}

/**
 * Re-reads what is actually stored remotely, for EVERY tier copy written by this run: downloads the
 * artifact and its manifest through the configured download command, requires the downloaded manifest
 * to be byte-identical to the one written locally, and re-checks the artifact SHA-256 and byte length
 * against it. Throws (failing the run loudly) on any mismatch.
 */
async function verifyUploadedBackup(
  config: BackupConfig,
  run: CommandRunner,
  runDirectory: string,
  targets: Array<{ artifact: string; manifest: string }>,
  localManifestPath: string,
): Promise<{ bytes: number; sha256: string }> {
  let result: { bytes: number; sha256: string } | undefined;
  for (const [index, target] of targets.entries()) {
    const verifyDirectory = path.join(runDirectory, "verify", String(index));
    await mkdir(verifyDirectory, { recursive: true, mode: 0o700 });
    const name = path.posix.basename(target.artifact);
    const artifact = path.join(verifyDirectory, name);
    const manifest = `${artifact}.sha256.json`;
    try {
      await run(config.verifyDownload ?? config.download, { source: remoteUri(config.destination, target.artifact), destination: artifact, object: target.artifact }, "verify_download");
      await run(config.verifyDownload ?? config.download, { source: remoteUri(config.destination, target.manifest), destination: manifest, object: target.manifest }, "verify_download");
      const [remoteManifest, localManifest] = await Promise.all([readFile(manifest), readFile(localManifestPath)]);
      if (!remoteManifest.equals(localManifest)) {
        throw new Error("manifest stored remotely differs from the manifest written for this run");
      }
      const verified = await verifyManifest(artifact, manifest);
      result = { bytes: verified.bytes, sha256: verified.sha256 };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Post-upload verification failed for ${target.artifact}: ${reason}`, { cause: error });
    }
  }
  if (!result) throw new Error("Post-upload verification failed: no uploaded copy was verified");
  return result;
}

/** Fixed (non-dynamic) alert text per failing stage: a reason code plus a constant label. */
const ALERT_REASONS: Record<string, string> = {
  preflight: "preflight_failed: backup configuration refused",
  prepare: "prepare_failed: backup could not be prepared",
  tier_upload: "tier_upload_failed: upload to a backup tier failed",
  verify: "verify_failed: Post-upload verification failed",
  prune: "prune_failed: retention pruning failed",
};

/** Thrown when a non-empty backup listing contains no recognisable backup key (see `assessListing`). */
export class PruneListUnexpectedError extends Error {
  constructor(
    readonly listed: number,
    readonly recognised: number,
    readonly unrecognisedBackupLike: number = 0,
  ) {
    super("prune_list_unexpected: backup listing contains no recognisable backup keys, or backup-named keys in an unrecognised shape");
    this.name = "PruneListUnexpectedError";
  }
}

export interface PruneResult {
  deleted: number;
  failed: number;
  protectedByGuard: number;
  /** True when pruning halted after a delete failed or was uncertain. */
  stopped: boolean;
  /** Manifests deliberately kept because their artifact could not be confirmed deleted. */
  manifestsPreserved: number;
}

interface PruneUnit {
  artifact?: RemoteObject;
  manifest?: RemoteObject;
}

type PruneUnitStatus =
  | "deleted"
  | "artifact_delete_failed_manifest_preserved"
  | "manifest_delete_failed_artifact_deleted"
  | "not_attempted_pruning_stopped";

interface PruneUnitOutcome {
  artifact: string | null;
  manifest: string | null;
  status: PruneUnitStatus;
  error?: string;
}

/**
 * Groups planned deletions into recoverability units: an artifact together with its own manifest (same folder,
 * name + ".sha256.json"). A manifest with no planned artifact is its own unit (orphan manifest, nothing to protect).
 * The just-uploaded artifact and its manifest are never part of a unit (defence in depth over the planner).
 */
function buildPruneUnits(objects: RemoteObject[], protectedArtifact: string): PruneUnit[] {
  const units = new Map<string, PruneUnit>();
  const order: string[] = [];
  for (const object of objects) {
    const base = object.key.endsWith(MANIFEST_SUFFIX) ? object.key.slice(0, -MANIFEST_SUFFIX.length) : object.key;
    const basename = base.slice(base.lastIndexOf("/") + 1);
    if (basename === protectedArtifact) continue;
    let unit = units.get(base);
    if (!unit) {
      unit = {};
      units.set(base, unit);
      order.push(base);
    }
    if (object.key.endsWith(MANIFEST_SUFFIX)) unit.manifest = object;
    else unit.artifact = object;
  }
  return order.map((key) => units.get(key)!);
}

async function storeDeletionRecord(
  config: BackupConfig,
  run: CommandRunner,
  runDirectory: string,
  key: string,
  record: Record<string, unknown>,
): Promise<void> {
  const local = path.join(runDirectory, path.posix.basename(key));
  await writeFile(local, JSON.stringify(record) + "\n", { mode: 0o600 });
  await run(config.upload, { source: local, destination: remoteUri(config.destination, key), object: key }, "upload");
}

async function prune(
  config: BackupConfig,
  run: CommandRunner,
  now: Date,
  protectedArtifact: string,
  log: (entry: OperationLog) => void,
  runId: string,
  runDirectory: string,
): Promise<PruneResult> {
  const listing = await run(config.list, { destination: config.destination }, "list");
  let objects: unknown;
  try {
    objects = JSON.parse(listing.stdout);
  } catch {
    throw new Error("Backup list command must return a JSON array");
  }
  if (!Array.isArray(objects)) throw new Error("Backup list command must return a JSON array");
  const valid = objects.filter(
    (item): item is RemoteObject =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as RemoteObject).key === "string" &&
      typeof (item as RemoteObject).lastModified === "string",
  );
  if (valid.length !== objects.length) throw new Error("Backup list command returned malformed objects");
  // Fail visibly (never silently prune nothing) when the adapter's key format is not the documented
  // destination-relative contract. Nothing has been deleted at this point.
  const assessment = assessListing(valid);
  // A listing that mixes recognised keys with backup-named keys in another shape would make the planner
  // under-count (e.g. a hidden manifest turns a recoverable backup into an "orphan artifact"), so it is
  // refused too. Unrelated foreign objects (non-backup names) are not counted and do not trigger this.
  if ((assessment.listed > 0 && assessment.recognised === 0) || assessment.unrecognisedBackupLike > 0) {
    log({
      timestamp: new Date().toISOString(),
      level: "error",
      operation: "backup",
      event: "prune_list_unexpected",
      runId,
      listed: assessment.listed,
      recognised: assessment.recognised,
      unrecognisedBackupLike: assessment.unrecognisedBackupLike,
    });
    throw new PruneListUnexpectedError(assessment.listed, assessment.recognised, assessment.unrecognisedBackupLike);
  }
  const plan = planTierRetention(
    valid,
    now,
    config.tierPolicy ?? DEFAULT_TIER_POLICY,
    { retentionDays: config.retentionDays, minRetained: config.minRetainedBackups ?? DEFAULT_MIN_RETAINED_BACKUPS },
    { protectedArtifact },
  );
  // D-3: an artifact and its manifest are ONE recoverability unit. Group the plan into units (artifact first)
  // and never touch a manifest unless its own artifact delete was confirmed in this run.
  const units = buildPruneUnits(plan.delete, protectedArtifact);
  if (units.length === 0) return { deleted: 0, failed: 0, protectedByGuard: plan.protectedByGuard, stopped: false, manifestsPreserved: 0 };
  // Durable intent BEFORE any destructive operation. If it cannot be stored, nothing is deleted (fail closed).
  const recordPrefix = `deletion-records/${runId}`;
  await storeDeletionRecord(config, run, runDirectory, `${recordPrefix}.intent.json`, {
    version: 1,
    kind: "prune-intent",
    runId,
    createdAt: new Date().toISOString(),
    protectedArtifact,
    units: units.map((u) => ({ artifact: u.artifact?.key ?? null, manifest: u.manifest?.key ?? null })),
  });
  const outcomes: PruneUnitOutcome[] = units.map((u) => ({ artifact: u.artifact?.key ?? null, manifest: u.manifest?.key ?? null, status: "not_attempted_pruning_stopped" }));
  let deleted = 0;
  let failed = 0;
  let manifestsPreserved = 0;
  let stopped = false;
  const fail = (object: string, error: unknown, event: string): void => {
    failed += 1;
    log({
      timestamp: new Date().toISOString(),
      level: "error",
      operation: "backup",
      event,
      runId,
      object,
      error: error instanceof Error ? error.message : String(error),
    });
  };
  for (let index = 0; index < units.length && !stopped; index += 1) {
    const unit = units[index]!;
    const outcome = outcomes[index]!;
    // Artifact first. Any throw (refused by Object Lock/retention, timeout, ambiguous) means the artifact may
    // still exist, so its manifest MUST be preserved and pruning stops: the result is not trustworthy.
    if (unit.artifact) {
      try {
        await run(config.remove, {
          destination: config.destination,
          object: unit.artifact.key,
          remote: remoteUri(config.destination, unit.artifact.key),
        }, "delete");
      } catch (error) {
        fail(unit.artifact.key, error, "prune_delete_failed");
        outcome.status = "artifact_delete_failed_manifest_preserved";
        outcome.error = sanitizeErrorText(error instanceof Error ? error.message : String(error));
        if (unit.manifest) manifestsPreserved += 1;
        stopped = true;
        break;
      }
      deleted += 1;
    }
    if (unit.manifest) {
      try {
        await run(config.remove, {
          destination: config.destination,
          object: unit.manifest.key,
          remote: remoteUri(config.destination, unit.manifest.key),
        }, "delete");
        deleted += 1;
      } catch (error) {
        fail(unit.manifest.key, error, "prune_delete_failed");
        outcome.status = "manifest_delete_failed_artifact_deleted";
        outcome.error = sanitizeErrorText(error instanceof Error ? error.message : String(error));
        stopped = true;
        break;
      }
    }
    outcome.status = "deleted";
  }
  if (stopped) {
    log({
      timestamp: new Date().toISOString(),
      level: "error",
      operation: "backup",
      event: "prune_stopped",
      runId,
      deleted,
      failed,
      manifestsPreserved,
      unitsNotAttempted: outcomes.filter((o) => o.status === "not_attempted_pruning_stopped").length,
    });
  }
  // Outcome record after the last destructive operation. A failure to store it is itself a visible failure
  // (counted and logged) but cannot undo deletions that already happened; the intent record remains.
  try {
    await storeDeletionRecord(config, run, runDirectory, `${recordPrefix}.outcome.json`, {
      version: 1,
      kind: "prune-outcome",
      runId,
      completedAt: new Date().toISOString(),
      stopped,
      units: outcomes,
    });
  } catch (error) {
    fail(`${recordPrefix}.outcome.json`, error, "prune_outcome_record_failed");
  }
  return { deleted, failed, protectedByGuard: plan.protectedByGuard, stopped, manifestsPreserved };
}

async function runStagingSweep(config: BackupConfig, log: (entry: OperationLog) => void, runId: string): Promise<void> {
  const mode = config.stagingSweep ?? "off";
  if (mode === "off") return;
  try {
    const report = await sweepStaging({
      stagingDirectory: config.stagingDirectory,
      mode,
      minAgeMs: (config.stagingSweepMinAgeHours ?? 24) * 3_600_000,
    });
    log({
      timestamp: new Date().toISOString(), level: "info", operation: "backup", event: "staging_sweep", runId,
      mode, counts: report.counts,
      ambiguous: report.entries.filter((e) => e.decision === "ambiguous").map((e) => `${e.name}: ${e.reason}`),
      artifactsRetained: report.entries.filter((e) => e.decision === "artifact_retained" || e.decision === "would_retain_artifact").map((e) => e.name),
    });
  } catch (error) {
    log({
      timestamp: new Date().toISOString(), level: "error", operation: "backup", event: "staging_sweep_failed", runId,
      mode, error: sanitizeErrorText(error instanceof Error ? error.message : String(error)),
    });
  }
}

export async function createBackup(config: BackupConfig, dependencies: EngineDependencies): Promise<string> {
  const now = dependencies.now?.() ?? new Date();
  const runId = randomBytes(8).toString("hex");
  const log = dependencies.log ?? defaultLog;
  const started = Date.now();
  const runDirectory = path.join(config.stagingDirectory, `backup-${runId}`);
  const name = artifactName(now);
  const artifact = path.join(runDirectory, name);
  let stage = "prepare";
  let stopHeartbeat: () => void = () => undefined;
  try {
    // D-5: optional stale-staging sweep BEFORE this run's own directory exists (off by default). Never fatal.
    await runStagingSweep(config, log, runId);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    await writeRunMarker(runDirectory, newRunMarker(runId, "backup", new Date()));
    stopHeartbeat = startHeartbeat(runDirectory);
    // Vault mode forbids pruning: refuse before doing any work rather than discover it at prune time.
    stage = "preflight";
    assertIsolationNotBypassed(config);
    if (config.vaultMode && config.prune === true) {
      throw new Error("Pruning is prohibited in vault mode (BACKUP_PRUNE must not be on)");
    }
    stage = "prepare";
    const dump = path.join(runDirectory, "database.dump");
    await dependencies.run({
      executable: "pg_dump",
      args: ["--format=custom", "--no-owner", "--no-privileges", "--file", dump, config.databaseUrl],
    }, undefined, "database");
    await chmod(dump, 0o600);

    const inventory = await readDatabaseInventory(dependencies.run, config.databaseUrl);
    let documentSourceDirectory: string;
    let documentCount: number;
    if (config.documentSource === "object-storage") {
      if (!dependencies.documentProvider) {
        throw new Error("Object-storage document backup requires a configured object storage provider");
      }
      // Every database-referenced key must be readable and checksum-valid; orphans cannot be
      // enumerated without a list operation and are not part of this check.
      documentSourceDirectory = path.join(runDirectory, "documents-src");
      const staged = await stageObjectStorageDocuments(
        dependencies.documentProvider,
        inventory.documentKeys,
        documentSourceDirectory,
      );
      documentCount = staged.count;
    } else {
      if (!config.documentDirectory) throw new Error("BACKUP_DOCUMENT_DIRECTORY is required for directory document backups");
      documentSourceDirectory = config.documentDirectory;
      const files = await documentInventory(documentSourceDirectory);
      const documentComparison = compareDocumentKeys(inventory.documentKeys, files);
      if (documentComparison.missing.length || documentComparison.orphaned.length) {
        throw new Error(
          `Document integrity failed before backup: ${documentComparison.missing.length} missing, ${documentComparison.orphaned.length} orphaned`,
        );
      }
      documentCount = files.length;
    }
    const inventoryPath = path.join(runDirectory, "inventory.json");
    await writeFile(inventoryPath, JSON.stringify(inventory) + "\n", { mode: 0o600 });
    const documentsArchive = path.join(runDirectory, "documents.tar");
    await dependencies.run({
      executable: "tar",
      args: ["--create", "--file", documentsArchive, "--directory", documentSourceDirectory, "."],
    }, undefined, "archive");
    await chmod(documentsArchive, 0o600);
    const payload = path.join(runDirectory, "payload.tar");
    await dependencies.run({
      executable: "tar",
      args: ["--create", "--file", payload, "--directory", runDirectory, "database.dump", "inventory.json", "documents.tar"],
    }, undefined, "archive");
    await chmod(payload, 0o600);
    await dependencies.run(config.encryption, { input: payload, output: artifact, kmsProfile: config.encryptionKmsProfile }, "encrypt");
    await chmod(artifact, 0o600);
    const manifest = await writeManifest(artifact, now.toISOString());
    await updateRunMarker(runDirectory, { state: "encrypted" });

    // Tiered layout is active when a tier policy is configured (the production loader always sets one):
    // the same bytes are written once per applicable tier (daily always, weekly on Sunday, monthly on the
    // 1st; UTC). A config without a tier policy keeps the original flat layout.
    stage = "tier_upload";
    const tiers: Tier[] = config.tierPolicy ? tiersFor(now) : [];
    const manifestName = path.basename(manifest);
    const targets = tiers.length
      ? tiers.map((tier) => ({ artifact: tierKey(tier, name), manifest: tierKey(tier, manifestName) }))
      : [{ artifact: name, manifest: manifestName }];
    for (const target of targets) {
      await dependencies.run(config.upload, {
        source: artifact,
        destination: remoteUri(config.destination, target.artifact),
        object: target.artifact,
      }, "upload");
      await dependencies.run(config.upload, {
        source: manifest,
        destination: remoteUri(config.destination, target.manifest),
        object: target.manifest,
      }, "upload");
    }
    // Never prune (or report success) on the strength of an upload command's exit code alone: every
    // tier copy is re-downloaded and verified BEFORE the first list/remove can run.
    stage = "verify";
    const verified = await verifyUploadedBackup(config, dependencies.run, runDirectory, targets, manifest);
    await updateRunMarker(runDirectory, { state: "uploaded_verified" });
    stage = "prune";
    // D-2: default OFF. Only an explicit `true` may reach any list/delete operation.
    const pruneEnabled = config.prune === true;
    const pruneStatus = pruneEnabled ? "enabled" : config.pruneSource === "explicit" ? "disabled_explicit" : "disabled_default";
    log({
      timestamp: new Date().toISOString(),
      level: "info",
      operation: "backup",
      event: pruneEnabled ? "prune_enabled" : "prune_disabled",
      runId,
      pruneStatus,
      source: config.pruneSource ?? (config.prune === undefined ? "default" : "explicit"),
      message: pruneEnabled
        ? "pruning is ENABLED (BACKUP_PRUNE=on): expired backups will be deleted after verification, artifact first"
        : "pruning is DISABLED: no backup is listed or deleted by this run; set BACKUP_PRUNE=on to enable retention pruning (not valid with BACKUP_VAULT_MODE=true)",
    });
    const pruneResult = pruneEnabled
      ? await prune(config, dependencies.run, now, name, log, runId, runDirectory)
      : { deleted: 0, failed: 0, protectedByGuard: 0, stopped: false, manifestsPreserved: 0 };
    if (pruneResult.failed > 0) {
      await safeAlert(
        config,
        dependencies.run,
        log,
        runId,
        "prune_delete_refused",
        `prune_delete_refused: ${pruneResult.failed} delete(s) refused`,
      );
    }
    log({
      timestamp: new Date().toISOString(),
      level: "info",
      operation: "backup",
      event: "completed",
      runId,
      artifact: name,
      documentSource: config.documentSource ?? "directory",
      documents: documentCount,
      tiersWritten: tiers,
      prune: pruneEnabled ? "on" : "off",
      pruneStatus,
      verified: true,
      verifiedBytes: verified.bytes,
      sha256: verified.sha256,
      pruned: pruneResult.deleted,
      pruneFailed: pruneResult.failed,
      pruneProtected: pruneResult.protectedByGuard,
      pruneStopped: pruneResult.stopped,
      manifestsPreserved: pruneResult.manifestsPreserved,
      durationMs: Date.now() - started,
    });
    return name;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log({
      timestamp: new Date().toISOString(),
      level: "error",
      operation: "backup",
      event: "failed",
      runId,
      error: message,
      durationMs: Date.now() - started,
    });
    // Local log keeps the full text; the alert carries only a fixed reason code.
    const reason =
      error instanceof PruneListUnexpectedError
        ? `prune_list_unexpected: listing had ${error.listed} entries, ${error.recognised} recognised${error.recognised > 0 ? `, ${error.unrecognisedBackupLike} backup-named unrecognised` : ""}`
        : (ALERT_REASONS[stage] ?? "backup_failed: backup failed");
    await safeAlert(config, dependencies.run, log, runId, "failed", reason);
    throw error;
  } finally {
    stopHeartbeat();
    await safeRemoveRunDirectory(runDirectory);
  }
}

export interface RestoreRequest {
  artifact: string;
  confirmDisposable: boolean;
  /** Tier folder to restore from. Omitted = legacy flat layout (backups written before tiering). */
  tier?: Tier;
}

function databaseIdentity(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Configured database URL is invalid");
  }
  const port = parsed.port || (parsed.protocol === "postgresql:" || parsed.protocol === "postgres:" ? "5432" : "");
  const protocol = parsed.protocol === "postgres:" ? "postgresql:" : parsed.protocol;
  return `${protocol}//${parsed.hostname.toLowerCase()}:${port}${parsed.pathname.replace(/\/+$/, "")}`;
}

function safeRemoteArtifact(value: string): string {
  if (value !== path.posix.basename(value) || !/^aee-protected-\d{8}T\d{6}Z-[a-f0-9]{12}\.tar\.enc$/.test(value)) {
    throw new Error("Restore artifact name is not a protected backup artifact");
  }
  return value;
}

/** Fail closed: when isolation is required the config must carry a policy (so the scoped runner is used). */
function assertIsolationNotBypassed(config: BackupConfig): void {
  if (config.envIsolationRequired && !config.envIsolation) {
    throw new Error("Environment isolation is required (BACKUP_ENV_ISOLATION_REQUIRED=true) but no isolation policy is configured; refusing to run any command");
  }
}

export async function restoreBackup(
  config: BackupConfig,
  request: RestoreRequest,
  dependencies: EngineDependencies,
): Promise<void> {
  assertIsolationNotBypassed(config);
  if (!request.confirmDisposable) throw new Error("Restore requires explicit disposable-database confirmation");
  if (databaseIdentity(config.restoreDatabaseUrl) === databaseIdentity(config.databaseUrl)) {
    throw new Error("Refusing restore because configured source and target database identities are equivalent");
  }
  const name = safeRemoteArtifact(request.artifact);
  const runId = randomBytes(8).toString("hex");
  const log = dependencies.log ?? defaultLog;
  const started = Date.now();
  const runDirectory = path.join(config.stagingDirectory, `restore-${runId}`);
  let stage = "prepare";
  let stopHeartbeat: () => void = () => undefined;
  try {
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    await writeRunMarker(runDirectory, newRunMarker(runId, "restore", new Date()));
    stopHeartbeat = startHeartbeat(runDirectory);
    const artifact = path.join(runDirectory, name);
    const manifest = `${artifact}.sha256.json`;
    const remoteName = request.tier ? tierKey(request.tier, name) : name;
    stage = "download";
    try {
      await dependencies.run(config.restoreDownload ?? config.download, {
        source: remoteUri(config.destination, remoteName),
        destination: artifact,
        object: remoteName,
      }, "restore_download");
      await dependencies.run(config.restoreDownload ?? config.download, {
        source: remoteUri(config.destination, `${remoteName}.sha256.json`),
        destination: manifest,
        object: `${remoteName}.sha256.json`,
      }, "restore_download");
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      if (!request.tier) throw error; // no-tier restore behaviour is unchanged
      throw new Error(
        `Restore could not download the artifact and manifest from the "${request.tier}" tier. Check that the artifact name is correct and was written to that tier (--tier=${request.tier}); the manifest lives inside the tier folder, so a different tier or omitting --tier (legacy flat layout) will not find it. Underlying error: ${cause}`,
        { cause: error },
      );
    }
    stage = "verify";
    await verifyManifest(artifact, manifest);
    stage = "decrypt_and_restore";
    const payload = path.join(runDirectory, "payload.tar");
    await dependencies.run(config.decryption, { input: artifact, output: payload, kmsProfile: config.encryptionKmsProfile }, "decrypt");
    await assertRestoreTargetIsEmpty(dependencies.run, config.restoreDatabaseUrl, "restore_database");
    await dependencies.run({
      executable: "tar",
      args: ["--extract", "--file", payload, "--directory", runDirectory],
    }, undefined, "archive");
    const expected = JSON.parse(await readFile(path.join(runDirectory, "inventory.json"), "utf8")) as DatabaseInventory;
    await dependencies.run({
      executable: "pg_restore",
      args: [
        "--exit-on-error",
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "--dbname",
        config.restoreDatabaseUrl,
        path.join(runDirectory, "database.dump"),
      ],
    }, undefined, "restore_database");
    const actual = await readDatabaseInventory(dependencies.run, config.restoreDatabaseUrl, "restore_database");
    validateDatabaseInventory(expected, actual);

    const targetDocuments = path.resolve(config.restoreDocumentDirectory);
    if (config.documentDirectory && targetDocuments === path.resolve(config.documentDirectory)) {
      throw new Error("Refusing to restore documents over the live document directory");
    }
    const staging = path.resolve(config.stagingDirectory);
    if (
      targetDocuments === staging ||
      targetDocuments.startsWith(staging + path.sep) ||
      !targetDocuments.startsWith(path.resolve(config.restoreRoot) + path.sep)
    ) {
      throw new Error("Refusing to restore documents into transient backup staging");
    }
    await prepareEmptyRestoreDirectory(targetDocuments);
    await dependencies.run({
      executable: "tar",
      args: ["--extract", "--file", path.join(runDirectory, "documents.tar"), "--directory", targetDocuments],
    }, undefined, "archive");
    const documentComparison = compareDocumentKeys(actual.documentKeys, await documentInventory(targetDocuments));
    if (documentComparison.missing.length || documentComparison.orphaned.length) {
      throw new Error(
        `Restored document validation failed: ${documentComparison.missing.length} missing, ${documentComparison.orphaned.length} orphaned`,
      );
    }
    log({
      timestamp: new Date().toISOString(),
      level: "info",
      operation: "restore",
      event: "completed",
      runId,
      artifact: name,
      tenants: actual.tenantCount,
      tables: Object.keys(actual.recordCounts).length,
      documents: actual.documentKeys.length,
      restoreEnvironmentId: config.restoreEnvironmentId,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log({
      timestamp: new Date().toISOString(),
      level: "error",
      operation: "restore",
      event: "failed",
      runId,
      error: message,
      durationMs: Date.now() - started,
    });
    try {
      // Local log keeps the full text; the alert carries only a fixed reason code and stage.
      await notify(config, dependencies.run, {
        operation: "restore",
        status: "failed",
        error: `restore_failed: restore failed during ${stage}`,
        runId,
      });
    } catch (alertError) {
      log({
        timestamp: new Date().toISOString(),
        level: "error",
        operation: "restore",
        event: "alert_failed",
        runId,
        error: sanitizeErrorText(alertError instanceof Error ? alertError.message : String(alertError)),
      });
    }
    throw error;
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
}