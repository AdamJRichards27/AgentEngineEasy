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