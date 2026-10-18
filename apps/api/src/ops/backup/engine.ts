import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MIN_RETAINED_BACKUPS, artifactName, planRetention, verifyManifest, writeManifest } from "./artifacts.js";
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
  return `${destination}/${encodeURIComponent(name)}`;
}

async function notify(
  config: BackupConfig,
  run: CommandRunner,
  replacements: Record<string, string>,
): Promise<void> {
  await run(config.alert, replacements);
}

/**
 * Re-reads what is actually stored remotely: downloads the artifact and its manifest
 * through the configured download command, requires the downloaded manifest to be
 * byte-identical to the one written locally, and re-checks the artifact SHA-256 and
 * byte length against it. Throws (failing the run loudly) on any mismatch.
 */
async function verifyUploadedBackup(
  config: BackupConfig,
  run: CommandRunner,
  runDirectory: string,
  name: string,
  localManifestPath: string,
): Promise<{ bytes: number; sha256: string }> {
  const verifyDirectory = path.join(runDirectory, "verify");
  await mkdir(verifyDirectory, { recursive: true, mode: 0o700 });
  const artifact = path.join(verifyDirectory, name);
  const manifest = `${artifact}.sha256.json`;
  try {
    await run(config.download, { source: remoteUri(config.destination, name), destination: artifact, object: name });
    await run(config.download, {
      source: remoteUri(config.destination, `${name}.sha256.json`),
      destination: manifest,
      object: `${name}.sha256.json`,
    });
    const [remoteManifest, localManifest] = await Promise.all([readFile(manifest), readFile(localManifestPath)]);
    if (!remoteManifest.equals(localManifest)) {
      throw new Error("manifest stored remotely differs from the manifest written for this run");
    }
    const verified = await verifyManifest(artifact, manifest);
    return { bytes: verified.bytes, sha256: verified.sha256 };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Post-upload verification failed for ${name}: ${reason}`, { cause: error });
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
  const cutoff = new Date(now.valueOf() - config.retentionDays * 86_400_000);
  const plan = planRetention(valid, cutoff, {
    minRetained: config.minRetainedBackups ?? DEFAULT_MIN_RETAINED_BACKUPS,
    protectedArtifact,
  });
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
  return { deleted, failed, protectedByGuard: plan.protectedByGuard.length };
}

export async function createBackup(config: BackupConfig, dependencies: EngineDependencies): Promise<string> {
  const now = dependencies.now?.() ?? new Date();
  const runId = randomBytes(8).toString("hex");
  const log = dependencies.log ?? defaultLog;
  const started = Date.now();
  const runDirectory = path.join(config.stagingDirectory, `backup-${runId}`);
  const name = artifactName(now);
  const artifact = path.join(runDirectory, name);
  try {
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const dump = path.join(runDirectory, "database.dump");
    await dependencies.run({
      executable: "pg_dump",
      args: ["--format=custom", "--no-owner", "--no-privileges", "--file", dump, config.databaseUrl],
    });
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

    await dependencies.run(config.upload, {
      source: artifact,
      destination: remoteUri(config.destination, name),
      object: name,
    });
    await dependencies.run(config.upload, {
      source: manifest,
      destination: remoteUri(config.destination, path.basename(manifest)),
      object: path.basename(manifest),
    });
    // Never prune (or report success) on the strength of an upload command's exit code alone.
    const verified = await verifyUploadedBackup(config, dependencies.run, runDirectory, name, manifest);
    const pruneResult = await prune(config, dependencies.run, now, name, log, runId);
    log({
      timestamp: new Date().toISOString(),
      level: "info",
      operation: "backup",
      event: "completed",
      runId,
      artifact: name,
      verified: true,
      verifiedBytes: verified.bytes,
      sha256: verified.sha256,
      pruned: pruneResult.deleted,
      pruneFailed: pruneResult.failed,
      pruneProtected: pruneResult.protectedByGuard,
      documentSource: config.documentSource ?? "directory",
      documents: documentCount,
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
    try {
      await notify(config, dependencies.run, { operation: "backup", status: "failed", error: message, runId });
    } catch (alertError) {
      log({
        timestamp: new Date().toISOString(),
        level: "error",
        operation: "backup",
        event: "alert_failed",
        runId,
        error: alertError instanceof Error ? alertError.message : String(alertError),
      });
    }
    throw error;
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
}

export interface RestoreRequest { artifact: string; confirmDisposable: boolean; }

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
  try {
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const artifact = path.join(runDirectory, name);
    const manifest = `${artifact}.sha256.json`;
    await dependencies.run(config.download, {
      source: remoteUri(config.destination, name),
      destination: artifact,
      object: name,
    });
    await dependencies.run(config.download, {
      source: remoteUri(config.destination, `${name}.sha256.json`),
      destination: manifest,
      object: `${name}.sha256.json`,
    });
    await verifyManifest(artifact, manifest);
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
      await notify(config, dependencies.run, { operation: "restore", status: "failed", error: message, runId });
    } catch (alertError) {
      log({
        timestamp: new Date().toISOString(),
        level: "error",
        operation: "restore",
        event: "alert_failed",
        runId,
        error: alertError instanceof Error ? alertError.message : String(alertError),
      });
    }
    throw error;
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
}