import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactManifest, RemoteObject } from "./types.js";

export const ARTIFACT_PREFIX = "aee-protected-";

export function artifactName(now = new Date(), nonce = randomBytes(6).toString("hex")): string {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  if (!/^[a-f0-9]{12}$/.test(nonce)) throw new Error("Artifact nonce must be 12 lowercase hexadecimal characters");
  return `${ARTIFACT_PREFIX}${timestamp}-${nonce}.tar.enc`;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", resolve);
  });
  return hash.digest("hex");
}

export async function writeManifest(artifactPath: string, createdAt: string): Promise<string> {
  const info = await stat(artifactPath);
  const manifest: ArtifactManifest = {
    version: 1,
    artifact: path.basename(artifactPath),
    createdAt,
    sha256: await sha256File(artifactPath),
    bytes: info.size,
  };
  const manifestPath = `${artifactPath}.sha256.json`;
  await writeFile(manifestPath, JSON.stringify(manifest) + "\n", { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  return manifestPath;
}

export async function verifyManifest(artifactPath: string, manifestPath: string): Promise<ArtifactManifest> {
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Partial<ArtifactManifest>;
  if (
    parsed.version !== 1 ||
    parsed.artifact !== path.basename(artifactPath) ||
    typeof parsed.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.sha256) ||
    typeof parsed.bytes !== "number"
  ) {
    throw new Error("Artifact integrity manifest is malformed or names a different artifact");
  }
  const info = await stat(artifactPath);
  const actual = await sha256File(artifactPath);
  if (info.size !== parsed.bytes || actual !== parsed.sha256) {
    throw new Error("Artifact SHA-256 or byte length does not match its integrity manifest");
  }
  return parsed as ArtifactManifest;
}

export function retentionCandidates(objects: RemoteObject[], cutoff: Date): RemoteObject[] {
  return objects.filter((object) => {
    const name = path.posix.basename(object.key);
    const modified = new Date(object.lastModified);
    return name.startsWith(ARTIFACT_PREFIX) && !Number.isNaN(modified.valueOf()) && modified < cutoff;
  });
}

export const MANIFEST_SUFFIX = ".sha256.json";
export const DEFAULT_MIN_RETAINED_BACKUPS = 7;

export interface RetentionPlan {
  /** Objects that may be deleted, artifacts before their manifests. */
  delete: RemoteObject[];
  /** Artifact names that are retained as recoverable backups (newest first). */
  retained: string[];
  /** Candidates that were old enough but kept because of a safeguard. */
  protectedByGuard: string[];
}

/**
 * Safe retention planning. A backup is "recoverable" only when BOTH the encrypted
 * artifact and its integrity manifest are present remotely. Guarantees:
 *  - the newest `minRetained` recoverable backups are never deleted, whatever their age;
 *  - the artifact just uploaded by this run (`protectedArtifact`) is never deleted;
 *  - if no recoverable backup exists, nothing is deleted;
 *  - an artifact and its manifest are pruned together (artifact first), and an
 *    orphan manifest/artifact is only pruned while at least one recoverable backup is retained;
 *  - objects with unparseable timestamps and unrelated objects are never deleted.
 */
export function planRetention(
  objects: RemoteObject[],
  cutoff: Date,
  options: { minRetained?: number; protectedArtifact?: string } = {},
): RetentionPlan {
  const minRetained = Math.max(1, options.minRetained ?? DEFAULT_MIN_RETAINED_BACKUPS);
  const artifacts = new Map<string, RemoteObject>();
  const manifests = new Map<string, RemoteObject>();
  for (const object of objects) {
    const name = path.posix.basename(object.key);
    if (!name.startsWith(ARTIFACT_PREFIX)) continue;
    if (name.endsWith(MANIFEST_SUFFIX)) manifests.set(name.slice(0, -MANIFEST_SUFFIX.length), object);
    else artifacts.set(name, object);
  }
  const time = (object: RemoteObject): number => new Date(object.lastModified).valueOf();
  const recoverable = [...artifacts.entries()]
    .filter(([name, object]) => manifests.has(name) && !Number.isNaN(time(object)))
    .sort((a, b) => time(b[1]) - time(a[1]) || (a[0] < b[0] ? 1 : -1))
    .map(([name]) => name);
  const keep = new Set(recoverable.slice(0, minRetained));
  if (options.protectedArtifact) keep.add(options.protectedArtifact);
  const retained = recoverable.filter((name) => keep.has(name));
  const old = (object: RemoteObject): boolean => !Number.isNaN(time(object)) && new Date(object.lastModified) < cutoff;
  const result: RemoteObject[] = [];
  const guarded: string[] = [];
  if (recoverable.length === 0) return { delete: [], retained: [], protectedByGuard: [] };
  for (const [name, artifact] of artifacts) {
    const manifest = manifests.get(name);
    const eligible = old(artifact) && (!manifest || old(manifest));
    if (!eligible) continue;
    if (keep.has(name)) {
      guarded.push(name);
      continue;
    }
    result.push(artifact);
    if (manifest) result.push(manifest);
  }
  for (const [name, manifest] of manifests) {
    if (!artifacts.has(name) && old(manifest)) result.push(manifest);
  }
  return { delete: result, retained, protectedByGuard: guarded.sort() };
}
