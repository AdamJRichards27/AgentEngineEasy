import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_MIN_RETAINED_BACKUPS,
  DEFAULT_TIER_POLICY,
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
import { assertRestoreTargetIsEmpty, readDatabaseInventory, validateDatabaseInventory } from "./database.js";
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
  await run(config.alert, replacements);
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
  ) {
    super("prune_list_unexpected: backup listing contains no recognisable backup keys");
    this.name = "PruneListUnexpectedError";
  }
}

export interface PruneResult {
  deleted: number;
  failed: number;
  protectedByGuard: number;
}

async function prune(
  config: BackupConfig,
  run: CommandRunner,
  now: Date,
  protectedArtifact: string,
  log: (entry: OperationLog) => void,
  runId: string,
): Promise<PruneResult> {
  const listing = await run(config.list, { destination: config.destination });
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
  if (assessment.listed > 0 && assessment.recognised === 0) {
    log({
      timestamp: new Date().toISOString(),
      level: "error",
      operation: "backup",
      event: "prune_list_unexpected",
      runId,
      listed: assessment.listed,
      recognised: assessment.recognised,
    });
    throw new PruneListUnexpectedError(assessment.listed, assessment.recognised);
  }
  const plan = planTierRetention(
    valid,
    now,
    config.tierPolicy ?? DEFAULT_TIER_POLICY,
    { retentionDays: config.retentionDays, minRetained: config.minRetainedBackups ?? DEFAULT_MIN_RETAINED_BACKUPS },
    { protectedArtifact },
  );
  let deleted = 0;
  let failed = 0;
  for (const object of plan.delete) {
    try {
      await run(config.remove, {
        destination: config.destination,
        object: object.key,
        remote: remoteUri(config.destination, object.key),
      });
      deleted += 1;
    } catch (error) {
      // A delete refused by Object Lock / retention policy is expected and must not
      // fail a backup that was stored successfully; it is logged loudly instead.
      failed += 1;
      log({
        timestamp: new Date().toISOString(),
        level: "error",
        operation: "backup",
        event: "prune_delete_failed",
        runId,
        object: object.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { deleted, failed, protectedByGuard: plan.protectedByGuard };
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
  try {
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    // Vault mode forbids pruning: refuse before doing any work rather than discover it at prune time.
    stage = "preflight";
    if (config.vaultMode && config.prune !== false) {
      throw new Error("Pruning is prohibited in vault mode (BACKUP_PRUNE must be off)");
    }
    stage = "prepare";
    const dump = path.join(runDirectory, "database.dump");
    await dependencies.run({
      executable: "pg_dump",
      args: ["--format=custom", "--no-owner", "--no-privileges", "--file", dump, config.databaseUrl],
    });
    await chmod(dump, 0o600);

    const inventory = await readDatabaseInventory(dependencies.run, config.databaseUrl);
    const files = await documentInventory(config.documentDirectory);
    const documentComparison = compareDocumentKeys(inventory.documentKeys, files);
    if (documentComparison.missing.length || documentComparison.orphaned.length) {
      throw new Error(
        `Document integrity failed before backup: ${documentComparison.missing.length} missing, ${documentComparison.orphaned.length} orphaned`,
      );
    }
    const inventoryPath = path.join(runDirectory, "inventory.json");
    await writeFile(inventoryPath, JSON.stringify(inventory) + "\n", { mode: 0o600 });
    const documentsArchive = path.join(runDirectory, "documents.tar");
    await dependencies.run({
      executable: "tar",
      args: ["--create", "--file", documentsArchive, "--directory", config.documentDirectory, "."],
    });
    await chmod(documentsArchive, 0o600);
    const payload = path.join(runDirectory, "payload.tar");
    await dependencies.run({
      executable: "tar",
      args: ["--create", "--file", payload, "--directory", runDirectory, "database.dump", "inventory.json", "documents.tar"],
    });
    await chmod(payload, 0o600);
    await dependencies.run(config.encryption, { input: payload, output: artifact, kmsProfile: config.encryptionKmsProfile });
    await chmod(artifact, 0o600);
    const manifest = await writeManifest(artifact, now.toISOString());

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
      });
      await dependencies.run(config.upload, {
        source: manifest,
        destination: remoteUri(config.destination, target.manifest),
        object: target.manifest,
      });
    }
    stage = "prune";
    const pruneEnabled = config.prune !== false;
    const pruneResult = pruneEnabled
      ? await prune(config, dependencies.run, now, name, log, runId)
      : { deleted: 0, failed: 0, protectedByGuard: 0 };
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
      tiersWritten: tiers,
      prune: pruneEnabled ? "on" : "off",
      pruned: pruneResult.deleted,
      pruneFailed: pruneResult.failed,
      pruneProtected: pruneResult.protectedByGuard,
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
        ? `prune_list_unexpected: listing had ${error.listed} entries, ${error.recognised} recognised`
        : (ALERT_REASONS[stage] ?? "backup_failed: backup failed");
    await safeAlert(config, dependencies.run, log, runId, "failed", reason);
    throw error;
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
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

export async function restoreBackup(
  config: BackupConfig,
  request: RestoreRequest,
  dependencies: EngineDependencies,
): Promise<void> {
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
  try {
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const artifact = path.join(runDirectory, name);
    const manifest = `${artifact}.sha256.json`;
    const remoteName = request.tier ? tierKey(request.tier, name) : name;
    stage = "download";
    try {
      await dependencies.run(config.download, {
        source: remoteUri(config.destination, remoteName),
        destination: artifact,
        object: remoteName,
      });
      await dependencies.run(config.download, {
        source: remoteUri(config.destination, `${remoteName}.sha256.json`),
        destination: manifest,
        object: `${remoteName}.sha256.json`,
      });
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
    await dependencies.run(config.decryption, { input: artifact, output: payload, kmsProfile: config.encryptionKmsProfile });
    await assertRestoreTargetIsEmpty(dependencies.run, config.restoreDatabaseUrl);
    await dependencies.run({
      executable: "tar",
      args: ["--extract", "--file", payload, "--directory", runDirectory],
    });
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
    });
    const actual = await readDatabaseInventory(dependencies.run, config.restoreDatabaseUrl);
    validateDatabaseInventory(expected, actual);

    const targetDocuments = path.resolve(config.restoreDocumentDirectory);
    if (targetDocuments === path.resolve(config.documentDirectory)) {
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
    });
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