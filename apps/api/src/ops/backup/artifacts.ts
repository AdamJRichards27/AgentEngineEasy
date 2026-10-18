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


// ---------------------------------------------------------------------------------------------
// Tiered retention (Package A). Backups are written under `<destination>/<tier>/<name>`.
// Keys with no tier folder ("legacy" flat layout written before tiering) keep being pruned by
// the original flat `planRetention` so existing backups age out exactly as before.
// ---------------------------------------------------------------------------------------------

export type Tier = "daily" | "weekly" | "monthly";
export const TIERS: readonly Tier[] = ["daily", "weekly", "monthly"];

export interface TierRule {
  /** Newest recoverable backups of this tier that are never pruned. */
  keep: number;
  /** Backups younger than this many days are never pruned. */
  retentionDays: number;
}
export type TierPolicy = Record<Tier, TierRule>;

export const DEFAULT_TIER_POLICY: TierPolicy = {
  daily: { keep: 7, retentionDays: 14 },
  weekly: { keep: 4, retentionDays: 35 },
  monthly: { keep: 12, retentionDays: 395 },
};

/** Tiers a backup taken at `now` belongs to (UTC): always daily, weekly on Sunday, monthly on the 1st. */
export function tiersFor(now: Date): Tier[] {
  const tiers: Tier[] = ["daily"];
  if (now.getUTCDay() === 0) tiers.push("weekly");
  if (now.getUTCDate() === 1) tiers.push("monthly");
  return tiers;
}

const BACKUP_BASENAME = /^aee-protected-\d{8}T\d{6}Z-[a-f0-9]{12}\.tar\.enc(?:\.sha256\.json)?$/;
const TIER_KEY = /^(daily|weekly|monthly)\/(aee-protected-\d{8}T\d{6}Z-[a-f0-9]{12}\.tar\.enc(?:\.sha256\.json)?)$/;

/** Strict parser for tiered object keys. Returns null for anything that is not exactly `<tier>/<backup object name>`. */
export function parseBackupKey(key: string): { tier: Tier; name: string; manifest: boolean } | null {
  const match = TIER_KEY.exec(key);
  if (!match) return null;
  return { tier: match[1] as Tier, name: match[2]!, manifest: match[2]!.endsWith(MANIFEST_SUFFIX) };
}

/**
 * Listing self-check. `recognised` counts listed keys that are exactly `<tier>/<backup object name>`
 * (the layout this code writes) or a legacy flat `aee-protected-*` key. A non-empty listing with
 * zero recognised keys means the list adapter is returning keys in a different shape (bucket-absolute,
 * `s3://...`, wrong prefix, ...); pruning on it would silently delete nothing, so the caller must fail.
 */
export function assessListing(objects: RemoteObject[]): { listed: number; recognised: number; unrecognisedBackupLike: number } {
  const isRecognised = (object: RemoteObject): boolean =>
    parseBackupKey(object.key) !== null || (!object.key.includes("/") && object.key.startsWith(ARTIFACT_PREFIX));
  const recognised = objects.filter(isRecognised).length;
  // "Backup-like but unrecognised": the basename is a backup artifact/manifest name that this code writes,
  // yet the key is not in a recognised shape (absolute, s3://, unknown folder, ...). Foreign objects whose
  // basename is not a backup name are NOT counted, so no assumption is made about what else lives in the destination.
  const unrecognisedBackupLike = objects.filter(
    (object) => !isRecognised(object) && BACKUP_BASENAME.test(object.key.slice(object.key.lastIndexOf("/") + 1)),
  ).length;
  return { listed: objects.length, recognised, unrecognisedBackupLike };
}

/** Strict allowlist check (exact, case-sensitive string match; no coercion, trimming or decoding). */
export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

export function tierKey(tier: Tier, name: string): string {
  if (!isTier(tier)) throw new Error("Invalid backup tier");
  return `${tier}/${name}`;
}

export interface TierRetentionPlan {
  /** Full object keys that may be deleted, artifact before manifest within each backup. */
  delete: RemoteObject[];
  /** Per-tier / legacy retained recoverable artifact names. */
  retained: Record<string, string[]>;
  /** Number of expired candidates kept because of a safeguard. */
  protectedByGuard: number;
}

/**
 * Plans pruning independently per tier (and for legacy flat keys). Guarantees, per group:
 * everything `planRetention` guarantees (newest `keep` recoverable backups survive, nothing is
 * deleted when no recoverable backup exists, the just-uploaded artifact survives, unrelated and
 * bad-timestamp objects are untouched) PLUS: no object is ever deleted because of another tier's
 * contents, and keys in an unknown folder or with a malformed tiered name are never deleted.
 */
export function planTierRetention(
  objects: RemoteObject[],
  now: Date,
  policy: TierPolicy,
  legacy: { retentionDays: number; minRetained: number },
  options: { protectedArtifact?: string } = {},
): TierRetentionPlan {
  const result: RemoteObject[] = [];
  const retained: Record<string, string[]> = {};
  let guarded = 0;
  const cutoffFor = (days: number): Date => new Date(now.valueOf() - days * 86_400_000);
  for (const tier of TIERS) {
    const group: RemoteObject[] = [];
    for (const object of objects) {
      const parsed = parseBackupKey(object.key);
      if (parsed?.tier === tier) group.push({ key: parsed.name, lastModified: object.lastModified });
    }
    const rule = policy[tier];
    const plan = planRetention(group, cutoffFor(rule.retentionDays), {
      minRetained: rule.keep,
      protectedArtifact: options.protectedArtifact,
    });
    retained[tier] = plan.retained;
    guarded += plan.protectedByGuard.length;
    for (const object of plan.delete) result.push({ key: tierKey(tier, object.key), lastModified: object.lastModified });
  }
  const flat = objects.filter((object) => !object.key.includes("/"));
  const legacyPlan = planRetention(flat, cutoffFor(legacy.retentionDays), {
    minRetained: legacy.minRetained,
    protectedArtifact: options.protectedArtifact,
  });
  retained.legacy = legacyPlan.retained;
  guarded += legacyPlan.protectedByGuard.length;
  result.push(...legacyPlan.delete);
  return { delete: result, retained, protectedByGuard: guarded };
}

/**
 * Sanitises provider/command error text before it is placed in an alert: drops anything that could
 * identify a bucket, account, key or request (URIs, ARNs, long ids) and caps the length.
 */
export function sanitizeErrorText(value: string): string {
  return value
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<uri>")
    .replace(/\barn:[^\s,;"']+/gi, "<arn>")
    .replace(/\baee-protected-[A-Za-z0-9._-]+/g, "<backup-object>")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "<id>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
