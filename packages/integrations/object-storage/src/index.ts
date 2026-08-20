import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

export interface ObjectStorageProvider {
  putObject(key: string, content: string | Buffer, contentType?: string): Promise<{ key: string }>;
  getObject(key: string): Promise<Buffer>;
}

/**
 * Default provider — writes to a local directory. Unlike the Mock*Provider
 * convention used elsewhere (packages/integrations/aml, /esign), this is a
 * genuinely functional store, not a fake: `documents.objectStorageKey` and
 * `signatureRequests.completedDocumentKey` need something real behind them
 * for template population / completed-document storage (Phase 5) to be
 * more than a placeholder. Swapping in S3/GCS later is a second class
 * implementing the same interface, same as every other provider category.
 */
export class LocalObjectStorageProvider implements ObjectStorageProvider {
  constructor(private readonly baseDir: string) {}

  private resolveKey(key: string): string {
    // Keys are server-generated (propertyId/packageId/documentType), never
    // raw user input, but normalise + reject traversal defensively anyway.
    const normalised = path.normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
    const resolved = path.join(this.baseDir, normalised);
    if (!resolved.startsWith(path.resolve(this.baseDir))) {
      throw new Error(`Refusing to write object storage key outside baseDir: ${key}`);
    }
    return resolved;
  }

  async putObject(key: string, content: string | Buffer): Promise<{ key: string }> {
    const resolved = this.resolveKey(key);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, content);
    return { key };
  }

  async getObject(key: string): Promise<Buffer> {
    return readFile(this.resolveKey(key));
  }
}

export function createObjectStorageProvider(): ObjectStorageProvider {
  const provider = process.env.OBJECT_STORAGE_PROVIDER ?? "local";
  switch (provider) {
    case "local":
    default:
      return new LocalObjectStorageProvider(process.env.OBJECT_STORAGE_LOCAL_DIR ?? "./storage");
  }
}
