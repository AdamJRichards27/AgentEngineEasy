import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeObjectKey, type ObjectStorageProvider } from "@aee/integration-object-storage";

/** The only part of the existing storage abstraction the backup needs. */
export type DocumentObjectReader = Pick<ObjectStorageProvider, "getObject">;

export interface StagedDocuments {
  count: number;
  bytes: number;
}

const MAX_REPORTED_KEYS = 3;

/**
 * Copies every document object referenced by the database (`documents.object_storage_key`)
 * out of S3-compatible object storage into `targetDirectory`, preserving the key layout so the
 * existing `documents.tar` / restore / key-reconciliation path is reused unchanged.
 *
 * The provider's `getObject` already verifies size + SHA-256 against the stored object
 * metadata, so a corrupt object surfaces as an error here rather than being archived.
 * Missing/corrupt objects are all collected and reported together (counts, a few keys).
 * Orphan detection is not possible without a list operation and is deliberately skipped.
 */
export async function stageObjectStorageDocuments(
  provider: DocumentObjectReader,
  keys: readonly string[],
  targetDirectory: string,
  concurrency = 4,
): Promise<StagedDocuments> {
  const root = path.resolve(targetDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const unique = [...new Set(keys)].sort();
  const failures: Array<{ key: string; reason: string }> = [];
  let bytes = 0;
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < unique.length) {
      const key = unique[cursor++]!;
      try {
        assertSafeObjectKey(key);
        const destination = path.resolve(root, ...key.split("/"));
        if (!destination.startsWith(root + path.sep)) throw new Error("Unsafe object storage key");
        const content = await provider.getObject(key);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, content, { mode: 0o600 });
        bytes += content.length;
      } catch (error) {
        failures.push({ key, reason: error instanceof Error ? error.name + ": " + error.message : String(error) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, unique.length || 1)) }, () => worker()));
  if (failures.length) {
    failures.sort((a, b) => (a.key < b.key ? -1 : 1));
    const sample = failures
      .slice(0, MAX_REPORTED_KEYS)
      .map((failure) => `${failure.key} (${failure.reason})`)
      .join("; ");
    throw new Error(
      `Document integrity failed before backup: ${failures.length} of ${unique.length} referenced objects missing, unreadable or corrupt in object storage; first: ${sample}`,
    );
  }
  return { count: unique.length, bytes };
}
