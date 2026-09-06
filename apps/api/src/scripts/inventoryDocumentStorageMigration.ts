#!/usr/bin/env node
/**
 * Read-only inventory for planning migration of legacy documents.objectStorageKey
 * pointers to document_object_versions. This command deliberately has no apply
 * mode: it does not write database rows or storage objects and never deletes
 * source files.
 *
 * Usage:
 *   pnpm --filter @aee/api run documents:inventory -- \
 *     [--batch-size=100] [--cursor=<last-document-id>] [--brokerage-id=<id>] \
 *     [--legacy-local-dir=<absolute-or-relative-directory>] \
 *     [--resume-report=<report.json>] [--report=<new-report.json>]
 *
 * The report's continuationCursor can be passed to --cursor (or supplied via
 * --resume-report) to continue from the next legacy document pointer.
 */
import { createHash } from "node:crypto";
import { constants, createReadStream, type Dirent } from "node:fs";
import { lstat, open, readdir, readFile, realpath, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  db,
  documentObjectVersions,
  documents,
  properties,
} from "@aee/db";
import {
  createObjectStorageProvider,
  type ObjectStorageProvider,
} from "@aee/integration-object-storage";
import { and, asc, eq, gt, inArray, isNotNull } from "drizzle-orm";

const MAX_BATCH_SIZE = 500;
const DEFAULT_BATCH_SIZE = 100;
const STORAGE_CONCURRENCY = 4;

export interface InventoryOptions {
  batchSize: number;
  cursor: number;
  brokerageId?: number;
  reportPath?: string;
  legacyLocalDir?: string;
}

interface VersionRow {
  id: number;
  documentId: number;
  storageObjectKey: string;
  version: number;
  byteSize: number;
  contentSha256: string;
  objectStatus: string;
}

interface StorageCheck {
  key: string;
  head: "present" | "missing" | "error";
  integrity: "valid" | "invalid" | "not-checked" | "error";
  size?: number;
  checksumSha256?: string;
  error?: string;
}

interface LocalSourceFile {
  key: string;
  size: number;
  sha256: string;
}

interface LocalSourceCheck {
  state: "not-configured" | "present" | "missing" | "unsafe-or-error";
  size?: number;
  sha256?: string;
  error?: string;
}

interface LocalSourceInventory {
  root: string;
  files: Map<string, LocalSourceFile>;
  skippedSymlinks: string[];
  scanErrors: Map<string, string>;
}

function positiveInteger(value: string | undefined, name: string, maximum?: number): number {
  if (!value || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (maximum !== undefined && parsed > maximum)) {
    throw new Error(`${name} must be a positive integer${maximum ? ` no greater than ${maximum}` : ""}`);
  }
  return parsed;
}

function cursorInteger(value: string | undefined, name: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

export async function parseInventoryOptions(argv: string[]): Promise<InventoryOptions> {
  let batchSize = DEFAULT_BATCH_SIZE;
  let cursor = 0;
  let brokerageId: number | undefined;
  let reportPath: string | undefined;
  let resumeReport: string | undefined;
  let legacyLocalDir: string | undefined;

  for (const arg of argv) {
    if (arg === "--") {
      continue;
    } else if (arg.startsWith("--batch-size=")) {
      batchSize = positiveInteger(arg.slice("--batch-size=".length), "--batch-size", MAX_BATCH_SIZE);
    } else if (arg.startsWith("--cursor=")) {
      cursor = cursorInteger(arg.slice("--cursor=".length), "--cursor");
    } else if (arg.startsWith("--brokerage-id=")) {
      brokerageId = positiveInteger(arg.slice("--brokerage-id=".length), "--brokerage-id");
    } else if (arg.startsWith("--report=")) {
      reportPath = arg.slice("--report=".length);
      if (!reportPath) throw new Error("--report requires a path");
    } else if (arg.startsWith("--resume-report=")) {
      resumeReport = arg.slice("--resume-report=".length);
      if (!resumeReport) throw new Error("--resume-report requires a path");
    } else if (arg.startsWith("--legacy-local-dir=")) {
      legacyLocalDir = arg.slice("--legacy-local-dir=".length);
      if (!legacyLocalDir) throw new Error("--legacy-local-dir requires a directory");
    } else if (arg === "--help") {
      throw new Error("Usage: documents:inventory [--batch-size=1..500] [--cursor=<id>] [--brokerage-id=<id>] [--legacy-local-dir=<directory>] [--resume-report=<report.json>] [--report=<new-report.json>]");
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (resumeReport) {
    if (cursor !== 0) throw new Error("Use either --cursor or --resume-report, not both");
    const report = JSON.parse(await readFile(resumeReport, "utf8")) as {
      continuationCursor?: unknown;
      scope?: { brokerageId?: unknown };
    };
    if (typeof report.continuationCursor !== "number" || !Number.isSafeInteger(report.continuationCursor) || report.continuationCursor < 0) {
      throw new Error("--resume-report does not contain a valid continuationCursor");
    }
    cursor = report.continuationCursor;
    if (report.scope?.brokerageId !== undefined) {
      if (!Number.isSafeInteger(report.scope.brokerageId) || (report.scope.brokerageId as number) < 1) {
        throw new Error("--resume-report contains an invalid brokerage scope");
      }
      if (brokerageId !== undefined && brokerageId !== report.scope.brokerageId) {
        throw new Error("--brokerage-id does not match the brokerage scope in --resume-report");
      }
      brokerageId ??= report.scope.brokerageId as number;
    }
  }
  return {
    batchSize,
    cursor,
    ...(brokerageId ? { brokerageId } : {}),
    ...(reportPath ? { reportPath } : {}),
    ...(legacyLocalDir ? { legacyLocalDir } : {}),
  };
}

function storageErrorState(error: unknown): "missing" | "error" {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(ENOENT|404|not found)\b/i.test(message) ? "missing" : "error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function inspectStorageKey(provider: ObjectStorageProvider, key: string): Promise<StorageCheck> {
  try {
    const head = await provider.headObject(key);
    try {
      const integrity = await provider.verifyIntegrity(key);
      return {
        key,
        head: "present",
        integrity: integrity.valid ? "valid" : "invalid",
        size: head.size,
        checksumSha256: head.checksumSha256,
        ...(!integrity.valid ? { error: `checksum mismatch (expected ${integrity.expectedChecksum}, got ${integrity.actualChecksum})` } : {}),
      };
    } catch (error) {
      return { key, head: "present", integrity: "error", size: head.size, checksumSha256: head.checksumSha256, error: errorMessage(error) };
    }
  } catch (error) {
    const head = storageErrorState(error);
    return { key, head, integrity: "not-checked", error: errorMessage(error) };
  }
}

async function inspectKeys(provider: ObjectStorageProvider, keys: string[]): Promise<StorageCheck[]> {
  const results: StorageCheck[] = [];
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const index = next++;
      results[index] = await inspectStorageKey(provider, keys[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(STORAGE_CONCURRENCY, keys.length) }, worker));
  return results;
}

function isTemporaryLegacyFile(name: string): boolean {
  return name.endsWith(".tmp") || name.endsWith(".partial") || name.endsWith("~");
}

function sourcePath(root: string, key: string): string {
  if (
    !key ||
    key.startsWith("/") ||
    key.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(key) ||
    key.split("/").some((part) => !part || part === "." || part === ".." || part === ".object-storage-metadata")
  ) {
    throw new Error("legacy key is not a safe relative path");
  }
  const resolved = path.resolve(root, ...key.split("/"));
  if (!resolved.startsWith(root + path.sep)) throw new Error("legacy key escapes source directory");
  return resolved;
}

async function hashLegacyFile(
  canonicalPath: string,
  initial: Awaited<ReturnType<typeof lstat>>,
): Promise<{ size: number; sha256: string }> {
  let handle: FileHandle | undefined;
  try {
    // O_NOFOLLOW closes the final-component symlink race between lstat,
    // realpath and open. The descriptor, rather than the path, is streamed.
    handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== initial.dev ||
      before.ino !== initial.ino
    ) {
      throw new Error("source file changed identity before hashing");
    }
    const digest = createHash("sha256");
    let bytesRead = 0;
    const stream = createReadStream(canonicalPath, {
      fd: handle.fd,
      autoClose: false,
      highWaterMark: 64 * 1024,
    });
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += bytes.length;
      digest.update(bytes);
    }
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      bytesRead !== before.size
    ) {
      throw new Error("source file changed while hashing");
    }
    return { size: bytesRead, sha256: digest.digest("hex") };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function inventoryLegacyLocalDirectory(directory: string): Promise<LocalSourceInventory> {
  const requestedRoot = path.resolve(directory);
  const rootInfo = await lstat(requestedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("--legacy-local-dir must be an existing non-symbolic-link directory");
  }
  const root = await realpath(requestedRoot);
  const files = new Map<string, LocalSourceFile>();
  const skippedSymlinks: string[] = [];
  const scanErrors = new Map<string, string>();

  const walk = async (current: string, relative = ""): Promise<void> => {
    let canonicalCurrent: string;
    try {
      canonicalCurrent = await realpath(current);
      if (canonicalCurrent !== root && !canonicalCurrent.startsWith(root + path.sep)) {
        throw new Error(`legacy source directory escapes source directory: ${relative}`);
      }
    } catch (error) {
      scanErrors.set(relative || ".", errorMessage(error));
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(canonicalCurrent, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      scanErrors.set(relative || ".", errorMessage(error));
      return;
    }
    for (const entry of entries) {
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === ".object-storage-metadata" || isTemporaryLegacyFile(entry.name)) continue;
      const target = path.join(canonicalCurrent, entry.name);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(target);
      } catch (error) {
        scanErrors.set(nextRelative, errorMessage(error));
        continue;
      }
      if (info.isSymbolicLink()) {
        skippedSymlinks.push(nextRelative);
      } else if (info.isDirectory()) {
        await walk(target, nextRelative);
      } else if (info.isFile()) {
        try {
          const canonical = await realpath(target);
          if (!canonical.startsWith(root + path.sep)) {
            throw new Error(`legacy source file escapes source directory: ${nextRelative}`);
          }
          const hashed = await hashLegacyFile(canonical, info);
          files.set(nextRelative, { key: nextRelative, ...hashed });
        } catch (error) {
          scanErrors.set(nextRelative, errorMessage(error));
        }
      }
    }
  };
  await walk(root);
  return { root, files, skippedSymlinks, scanErrors };
}

async function inspectLocalSource(
  inventory: LocalSourceInventory | undefined,
  key: string,
): Promise<LocalSourceCheck> {
  if (!inventory) return { state: "not-configured" };
  try {
    sourcePath(inventory.root, key);
  } catch (error) {
    return { state: "unsafe-or-error", error: errorMessage(error) };
  }
  if (inventory.skippedSymlinks.some((symlink) => key === symlink || key.startsWith(`${symlink}/`))) {
    return { state: "unsafe-or-error", error: "legacy source path is a symbolic link and was not followed" };
  }
  const scanFailure = [...inventory.scanErrors].find(
    ([failedPath]) => failedPath === "." || key === failedPath || key.startsWith(`${failedPath}/`),
  );
  if (scanFailure) {
    return { state: "unsafe-or-error", error: `legacy source could not be hashed safely: ${scanFailure[1]}` };
  }
  const source = inventory.files.get(key);
  return source
    ? { state: "present", size: source.size, sha256: source.sha256 }
    : { state: "missing" };
}

function reconciliationAction(
  matchingVersion: VersionRow | undefined,
  local: LocalSourceCheck,
  destination: StorageCheck,
): string {
  if (matchingVersion) {
    if (
      matchingVersion.objectStatus !== "Active" ||
      destination.head !== "present" ||
      destination.integrity !== "valid" ||
      destination.size !== matchingVersion.byteSize ||
      destination.checksumSha256 !== matchingVersion.contentSha256 ||
      (local.state === "present" &&
        (local.size !== matchingVersion.byteSize || local.sha256 !== matchingVersion.contentSha256))
    ) {
      return "integrity/quarantine investigation";
    }
    return "already-versioned/no-action";
  }
  if (local.state === "unsafe-or-error" || local.state === "missing") return "missing-source blocker";
  if (local.state === "not-configured") return "source-unknown/manual-review blocker";
  if (
    destination.head === "present" &&
    (destination.integrity !== "valid" ||
      (local.state === "present" &&
        (destination.size !== local.size || destination.checksumSha256 !== local.sha256)))
  ) {
    return "integrity/quarantine investigation";
  }
  return "copy-and-create-version plan";
}

export async function runDocumentStorageInventory(options: InventoryOptions, provider = createObjectStorageProvider()) {
  const conditions = [isNotNull(documents.objectStorageKey), gt(documents.id, options.cursor)];
  if (options.brokerageId) conditions.push(eq(properties.brokerageId, options.brokerageId));
  const localSource = options.legacyLocalDir
    ? await inventoryLegacyLocalDirectory(options.legacyLocalDir)
    : undefined;
  const legacyDocuments = await db
    .select({
      documentId: documents.id,
      propertyId: documents.propertyId,
      brokerageId: properties.brokerageId,
      legacyObjectKey: documents.objectStorageKey,
    })
    .from(documents)
    .innerJoin(properties, eq(documents.propertyId, properties.id))
    .where(and(...conditions))
    .orderBy(asc(documents.id))
    .limit(options.batchSize);

  const ids = legacyDocuments.map((document) => document.documentId);
  const versions: VersionRow[] = ids.length
    ? await db
        .select({
          id: documentObjectVersions.id,
          documentId: documentObjectVersions.documentId,
          storageObjectKey: documentObjectVersions.storageObjectKey,
          version: documentObjectVersions.version,
          byteSize: documentObjectVersions.byteSize,
          contentSha256: documentObjectVersions.contentSha256,
          objectStatus: documentObjectVersions.objectStatus,
        })
        .from(documentObjectVersions)
        .where(inArray(documentObjectVersions.documentId, ids))
        .orderBy(asc(documentObjectVersions.documentId), asc(documentObjectVersions.version))
    : [];

  const versionsByDocument = new Map<number, VersionRow[]>();
  for (const version of versions) {
    const rows = versionsByDocument.get(version.documentId) ?? [];
    rows.push(version);
    versionsByDocument.set(version.documentId, rows);
  }
  const keys = [...new Set([...legacyDocuments.map((row) => row.legacyObjectKey!), ...versions.map((row) => row.storageObjectKey)])].sort();
  const storage = await inspectKeys(provider, keys);
  const storageByKey = new Map(storage.map((check) => [check.key, check]));

  const records = await Promise.all(legacyDocuments.map(async (document) => {
    const documentVersions = versionsByDocument.get(document.documentId) ?? [];
    const matchingVersion = documentVersions.find((version) => version.storageObjectKey === document.legacyObjectKey);
    const localSourceState = await inspectLocalSource(localSource, document.legacyObjectKey!);
    const destination = storageByKey.get(document.legacyObjectKey!)!;
    return {
      documentId: document.documentId,
      propertyId: document.propertyId,
      brokerageId: document.brokerageId,
      legacyObjectKey: document.legacyObjectKey,
      versionInventory: {
        count: documentVersions.length,
        legacyKeyVersionId: matchingVersion?.id ?? null,
        legacyKeyVersion: matchingVersion?.version ?? null,
        status: matchingVersion ? "versioned" : "missing-version-record",
        versions: documentVersions.map((version) => ({
          ...version,
          storage: storageByKey.get(version.storageObjectKey)!,
        })),
      },
      localSource: localSourceState,
      configuredDestination: destination,
      reconciliationAction: reconciliationAction(matchingVersion, localSourceState, destination),
    };
  }));
  const lastDocumentId = legacyDocuments.at(-1)?.documentId ?? options.cursor;
  let localFileInventory:
    | {
        root: string;
        filesScanned: number;
        referencedFiles: number;
        referenced: LocalSourceFile[];
        orphanCandidates: LocalSourceFile[];
        skippedSymlinks: string[];
        scanErrors: Array<{ path: string; error: string }>;
        duplicateSourceContent: Array<{ sha256: string; keys: string[] }>;
      }
    | undefined;
  if (localSource) {
    const referenceConditions = [isNotNull(documents.objectStorageKey)];
    if (options.brokerageId) referenceConditions.push(eq(properties.brokerageId, options.brokerageId));
    const references = await db
      .select({ key: documents.objectStorageKey })
      .from(documents)
      .innerJoin(properties, eq(documents.propertyId, properties.id))
      .where(and(...referenceConditions));
    const referencedKeys = new Set(references.map((reference) => reference.key!));
    const hashes = new Map<string, string[]>();
    for (const file of localSource.files.values()) {
      const sameContent = hashes.get(file.sha256) ?? [];
      sameContent.push(file.key);
      hashes.set(file.sha256, sameContent);
    }
    const orphanCandidates = [...localSource.files.values()]
      .filter((file) => !referencedKeys.has(file.key))
      .sort((a, b) => a.key.localeCompare(b.key));
    const referenced = [...localSource.files.values()]
      .filter((file) => referencedKeys.has(file.key))
      .sort((a, b) => a.key.localeCompare(b.key));
    localFileInventory = {
      root: localSource.root,
      filesScanned: localSource.files.size,
      referencedFiles: referenced.length,
      referenced,
      orphanCandidates,
      skippedSymlinks: localSource.skippedSymlinks.sort(),
      scanErrors: [...localSource.scanErrors]
        .map(([failedPath, error]) => ({ path: failedPath, error }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      duplicateSourceContent: [...hashes.entries()]
        .filter(([, fileKeys]) => fileKeys.length > 1)
        .map(([sha256, fileKeys]) => ({ sha256, keys: fileKeys.sort() }))
        .sort((a, b) => a.sha256.localeCompare(b.sha256)),
    };
  }
  const summary = {
    legacyDocuments: records.length,
    missingVersionRecords: records.filter((record) => record.versionInventory.status === "missing-version-record").length,
    storagePresent: storage.filter((check) => check.head === "present").length,
    storageMissing: storage.filter((check) => check.head === "missing").length,
    storageErrors: storage.filter((check) => check.head === "error").length,
    integrityInvalidOrError: storage.filter((check) => check.integrity === "invalid" || check.integrity === "error").length,
    sourceUnknownManualReview: records.filter((record) => record.reconciliationAction === "source-unknown/manual-review blocker").length,
    missingSourceBlockers: records.filter((record) => record.reconciliationAction === "missing-source blocker").length,
    ...(localSource
      ? {
          localSourcePresent: records.filter((record) => record.localSource.state === "present").length,
          localSourceMissingOrUnsafe: records.filter((record) => record.localSource.state === "missing" || record.localSource.state === "unsafe-or-error").length,
          migrationPlans: records.filter((record) => record.reconciliationAction === "copy-and-create-version plan").length,
          investigationRequired: records.filter((record) => record.reconciliationAction === "integrity/quarantine investigation").length,
        }
      : {}),
  };
  return {
    command: "document-storage-migration-inventory",
    dryRun: true,
    destructiveOperations: false,
    sourceDeletion: false,
    generatedAt: new Date().toISOString(),
    scope: {
      cursor: options.cursor,
      batchSize: options.batchSize,
      ...(options.brokerageId ? { brokerageId: options.brokerageId } : {}),
      ...(localSource ? { legacyLocalDir: localSource.root } : {}),
    },
    continuationCursor: lastDocumentId,
    hasMore: legacyDocuments.length === options.batchSize,
    configuredStorageProvider: (process.env.OBJECT_STORAGE_PROVIDER ?? "local").toLowerCase(),
    summary,
    storage,
    ...(localFileInventory ? { legacyLocalFileInventory: localFileInventory } : {}),
    records,
  };
}

async function main(): Promise<void> {
  const options = await parseInventoryOptions(process.argv.slice(2));
  const report = await runDocumentStorageInventory(options);
  const output = JSON.stringify(report, null, 2) + "\n";
  if (options.reportPath) {
    await writeFile(options.reportPath, output, { encoding: "utf8", mode: 0o600, flag: "wx" });
    process.stdout.write(`Wrote read-only inventory report to ${options.reportPath}; continuation cursor: ${report.continuationCursor}.\n`);
  } else {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(output, (error) => (error ? reject(error) : resolve()));
    });
  }
  // @aee/db does not export its pool. End explicitly so this one-shot CLI
  // cannot remain alive due to the pool's idle connection timer.
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Document storage migration inventory failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}