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

export async function writeManifest(artifactPath: string, createdAt: string, extra: { dumpArchiveVersion?: string } = {}): Promise<string> {
  const info = await stat(artifactPath);
  const manifest: ArtifactManifest = {
    version: 1,
    artifact: path.basename(artifactPath),
    createdAt,
    sha256: await sha256File(artifactPath),
    bytes: info.size,
    // WS4-06: only written when the dump header was readable, so manifests of non-custom dumps keep their old shape.
    ...(extra.dumpArchiveVersion ? { dumpArchiveVersion: extra.dumpArchiveVersion } : {}),
  };
  const manifestPath = `${artifactPath}.sha256.json`;
  await writeFile(manifestPath, JSON.stringify(manifest) + "\n", { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  return manifestPath;
}

/**
 * WS4-10: why a restore stopped before downloading the dump. "missing" = the manifest could not be downloaded (or the
 * download wrote nothing); "unreadable" = it is not a valid integrity manifest for this artifact.
 */
export class ManifestUnavailableError extends Error {
  constructor(readonly reason: "missing" | "unreadable", message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ManifestUnavailableError";
  }
}

/**
 * Structural validation of an integrity manifest body, without the artifact (WS4-10: run before the artifact is
 * downloaded). Same rules verifyManifest() has always applied, plus: an optional dumpArchiveVersion must be a
 * "major.minor.rev" string, so a corrupt version field can never silently skip the WS4-06 check.
 */
export function parseManifest(body: string, artifactName: string): ArtifactManifest {
  let parsed: Partial<ArtifactManifest> | null;
  try {
    parsed = JSON.parse(body) as Partial<ArtifactManifest> | null;
  } catch {
    throw new Error("Artifact integrity manifest is not valid JSON");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.version !== 1 ||
    parsed.artifact !== artifactName ||
    typeof parsed.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.sha256) ||
    typeof parsed.bytes !== "number" ||
    ("dumpArchiveVersion" in parsed && (typeof parsed.dumpArchiveVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(parsed.dumpArchiveVersion)))
  ) {
    throw new Error("Artifact integrity manifest is malformed or names a different artifact");
  }
  return parsed as ArtifactManifest;
}

export async function verifyManifest(artifactPath: string, manifestPath: string): Promise<ArtifactManifest> {
  const parsed = parseManifest(await readFile(manifestPath, "utf8"), path.basename(artifactPath));
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
/** Written by the backup writer after post-upload verification of that tier copy succeeded (RETENTION-SAFEGUARD-SPEC R6). */
export const VERIFIED_SUFFIX = ".verified.json";
/** Written by the restore-drill procedure (R27 marker plan); never written by this engine. */
export const RESTORE_VERIFIED_SUFFIX = ".restore-verified.json";
export const DEFAULT_MIN_RETAINED_BACKUPS = 7;

export type BackupState = "PRESENT" | "VERIFIED" | "RESTORE_VERIFIED";
export interface StateCounts {
  present: number;
  verified: number;
  restoreVerified: number;
  invalid: number;
}
/** Small remote bodies read for retention decisions, keyed by the artifact's object key. */
export interface MarkerEvidence {
  manifest?: string;
  verified?: string;
  restoreVerified?: string;
}
export type RetentionEvidence = Record<string, MarkerEvidence>;
export interface VerifiedMarker {
  version: 1;
  kind: "verified" | "restore-verified";
  artifact: string;
  sha256: string;
  verifiedAt: string;
}

export interface RetentionPlan {
  /** Objects that may be deleted: per unit the artifact first, then its manifest, then its markers. */
  delete: RemoteObject[];
  /** Artifact keys protected as recoverable backups (newest first). */
  retained: string[];
  /** Candidates that were old enough but kept because of a safeguard. */
  protectedByGuard: string[];
  /** Per key directory ("" for the group root): counts per state. No keys. */
  states: Record<string, StateCounts>;
  /** Alert event names (never object keys): retention_marker_orphan / retention_marker_mismatch. */
  alerts: string[];
}

const SUFFIXES = [MANIFEST_SUFFIX, VERIFIED_SUFFIX, RESTORE_VERIFIED_SUFFIX] as const;
type Companion = (typeof SUFFIXES)[number];

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** sha256 of the manifest body if it is well formed and names this artifact, else undefined. */
function manifestSha(artifactKey: string, body: string | undefined): string | undefined {
  const parsed = parseJson(body) as Partial<ArtifactManifest> | null | undefined;
  if (!parsed || parsed.version !== 1 || parsed.artifact !== path.posix.basename(artifactKey)) return undefined;
  return typeof parsed.sha256 === "string" && /^[a-f0-9]{64}$/.test(parsed.sha256) ? parsed.sha256 : undefined;
}

/** A marker is valid only if it parses, names the artifact and carries exactly the manifest sha256. */
export function markerMatches(artifactKey: string, kind: VerifiedMarker["kind"], body: string | undefined, sha: string | undefined): boolean {
  const parsed = parseJson(body) as Partial<VerifiedMarker> | null | undefined;
  return (
    !!parsed &&
    sha !== undefined &&
    parsed.version === 1 &&
    parsed.kind === kind &&
    parsed.artifact === path.posix.basename(artifactKey) &&
    parsed.sha256 === sha
  );
}

export function verifiedMarkerBody(artifact: string, sha256: string, verifiedAt: string): string {
  const marker: VerifiedMarker = { version: 1, kind: "verified", artifact, sha256, verifiedAt };
  return JSON.stringify(marker) + "\n";
}

/** Strips a manifest/marker suffix; returns the artifact key the object belongs to. */
export function unitKeyOf(key: string): string {
  const suffix = SUFFIXES.find((s) => key.endsWith(s));
  return suffix ? key.slice(0, -suffix.length) : key;
}

interface Unit {
  key: string;
  tier: string;
  artifact?: RemoteObject;
  companions: Map<Companion, RemoteObject>;
  state?: BackupState;
}

interface Classified {
  units: Unit[];
  states: Record<string, StateCounts>;
  alerts: Set<string>;
  time: (object: RemoteObject) => number;
  sane: (object: RemoteObject) => boolean;
}

const tierOf = (key: string): string => (path.posix.dirname(key) === "." ? "" : path.posix.dirname(key));

/** Groups backup objects into units and assigns each a state (spec §2). Pure. */
function classifyUnits(objects: RemoteObject[], evidence: RetentionEvidence, nowMs: number): Classified {
  const time = (object: RemoteObject): number => new Date(object.lastModified).valueOf();
  const sane = (object: RemoteObject): boolean => !Number.isNaN(time(object)) && time(object) <= nowMs;
  const byKey = new Map<string, Unit>();
  const unit = (key: string): Unit => {
    let found = byKey.get(key);
    if (!found) byKey.set(key, (found = { key, tier: tierOf(key), companions: new Map() }));
    return found;
  };
  for (const object of objects) {
    const name = path.posix.basename(object.key);
    if (!name.startsWith(ARTIFACT_PREFIX)) continue;
    const suffix = SUFFIXES.find((s) => name.endsWith(s));
    if (suffix) unit(object.key.slice(0, -suffix.length)).companions.set(suffix, object);
    else unit(object.key).artifact = object;
  }
  const states: Record<string, StateCounts> = {};
  const counts = (tier: string): StateCounts => (states[tier] ??= { present: 0, verified: 0, restoreVerified: 0, invalid: 0 });
  const alerts = new Set<string>();
  const units = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const u of units) {
    const c = counts(u.tier);
    const ev = evidence[u.key] ?? {};
    const hasVerifiedMarker = u.companions.has(VERIFIED_SUFFIX);
    const hasRestoreMarker = u.companions.has(RESTORE_VERIFIED_SUFFIX);
    if (!u.artifact) {
      // orphan manifest / marker: INVALID, never counted (S3, S7)
      c.invalid += 1;
      if (hasVerifiedMarker || hasRestoreMarker) alerts.add("retention_marker_orphan");
      continue;
    }
    const sha = u.companions.has(MANIFEST_SUFFIX) ? manifestSha(u.key, ev.manifest) : undefined;
    const verifiedOk = hasVerifiedMarker && markerMatches(u.key, "verified", ev.verified, sha);
    const restoreOk = verifiedOk && hasRestoreMarker && markerMatches(u.key, "restore-verified", ev.restoreVerified, sha);
    if ((hasVerifiedMarker && !verifiedOk) || (hasRestoreMarker && verifiedOk && !restoreOk)) {
      c.invalid += 1;
      alerts.add("retention_marker_mismatch");
    }
    if (!sane(u.artifact)) {
      u.state = "PRESENT";
      c.present += 1;
    } else if (restoreOk) {
      u.state = "RESTORE_VERIFIED";
      c.restoreVerified += 1;
    } else if (verifiedOk) {
      u.state = "VERIFIED";
      c.verified += 1;
    } else {
      u.state = "PRESENT";
      c.present += 1;
    }
  }
  return { units, states, alerts, time, sane };
}

/** Newest RESTORE_VERIFIED backup of a group (artifact key and time), if any. */
export function newestRestoreVerified(
  objects: RemoteObject[],
  options: { evidence?: RetentionEvidence; now?: Date } = {},
): { key: string; time: number } | undefined {
  const c = classifyUnits(objects, options.evidence ?? {}, (options.now ?? new Date()).valueOf());
  const best = c.units
    .filter((u) => u.state === "RESTORE_VERIFIED" && u.artifact && c.sane(u.artifact))
    .sort((a, b) => c.time(b.artifact!) - c.time(a.artifact!) || (a.key < b.key ? 1 : -1))[0];
  return best ? { key: best.key, time: c.time(best.artifact!) } : undefined;
}

/**
 * Safe retention planning for ONE group (a tier folder, or the legacy flat layout), RETENTION-SAFEGUARD-SPEC
 * (PH-7 R29b). Only VERIFIED backups (artifact + manifest + a `.verified.json` marker whose sha256 equals the
 * manifest sha256) count toward keep.
 *  - the newest `minRetained` VERIFIED backups of the group are protected, whatever their age (AC1);
 *  - the newest RESTORE_VERIFIED backup across ALL groups is protected (R2). Pass `globalRestore` to
 *    supply it when planning tier by tier; omitted = computed from this group alone;
 *  - the run's own artifact (`protectedArtifact`) is protected (R4);
 *  - a group with 0 VERIFIED deletes nothing (R1); a group with fewer than `minRetained` VERIFIED deletes
 *    no backup unit (spec §2 table); with no RESTORE_VERIFIED anywhere no backup unit is deleted, only
 *    INVALID orphans by age (R3, stricter reading);
 *  - a backup unit is deletable only if it is past the age floor AND strictly older than every
 *    protected backup of its group and than the newest RESTORE_VERIFIED, so removing or forging a
 *    marker can only reduce deletions (AC4);
 *  - future or unparseable timestamps and unrelated objects are never deleted or counted (S10).
 */
export function planRetention(
  objects: RemoteObject[],
  cutoff: Date,
  options: {
    minRetained?: number;
    protectedArtifact?: string;
    evidence?: RetentionEvidence;
    now?: Date;
    /** Newest RESTORE_VERIFIED across all groups. `null` = none anywhere. Its `key` is group-relative when it lives in this group. */
    globalRestore?: { key: string; time: number } | null;
  } = {},
): RetentionPlan {
  const minRetained = Math.max(1, options.minRetained ?? DEFAULT_MIN_RETAINED_BACKUPS);
  const nowMs = (options.now ?? new Date()).valueOf();
  const { units: sorted, states, alerts, time, sane } = classifyUnits(objects, options.evidence ?? {}, nowMs);
  const newestFirst = (a: Unit, b: Unit): number => time(b.artifact!) - time(a.artifact!) || (a.key < b.key ? 1 : -1);
  const backups = sorted.filter((u) => u.artifact && sane(u.artifact));
  // Only VERIFIED/RESTORE_VERIFIED copies count toward keep (AC3). Mutation check AC8 removes this filter.
  const counted = backups.filter((u) => u.state === "VERIFIED" || u.state === "RESTORE_VERIFIED");
  const localRestore = counted.filter((u) => u.state === "RESTORE_VERIFIED").sort(newestFirst)[0];
  const restore =
    options.globalRestore === undefined
      ? localRestore
        ? { key: localRestore.key, time: time(localRestore.artifact!) }
        : undefined
      : (options.globalRestore ?? undefined);
  const protectedKeys = new Set<string>();
  const floorByTier = new Map<string, number>();
  const fullTiers = new Set<string>();
  for (const tier of new Set(sorted.map((u) => u.tier))) {
    const top = counted.filter((u) => u.tier === tier).sort(newestFirst).slice(0, minRetained);
    for (const u of top) protectedKeys.add(u.key);
    if (top.length) floorByTier.set(tier, Math.min(...top.map((u) => time(u.artifact!))));
    if (top.length >= minRetained) fullTiers.add(tier);
  }
  if (restore && sorted.some((u) => u.key === restore.key)) protectedKeys.add(restore.key);
  const protectedUnit = options.protectedArtifact
    ? sorted.find((u) => u.key === options.protectedArtifact || path.posix.basename(u.key) === options.protectedArtifact)
    : undefined;
  if (protectedUnit) protectedKeys.add(protectedUnit.key);
  const old = (object: RemoteObject): boolean => sane(object) && new Date(object.lastModified) < cutoff;
  const result: RemoteObject[] = [];
  const guarded: string[] = [];
  for (const u of sorted) {
    const floor = floorByTier.get(u.tier);
    if (floor === undefined) continue; // R1: no VERIFIED in this group, delete nothing here
    const parts = [u.artifact, ...SUFFIXES.map((s) => u.companions.get(s))].filter((o): o is RemoteObject => !!o);
    if (!parts.every(old)) continue;
    if (!u.artifact) {
      // INVALID orphan (manifest/marker without artifact): only by age (spec §2)
      result.push(...parts);
      continue;
    }
    if (!restore) continue; // R3: never delete a backup unit until a RESTORE_VERIFIED exists
    if (!fullTiers.has(u.tier)) continue; // spec §2: backup units only while >= keep VERIFIED remain
    if (protectedKeys.has(u.key)) {
      guarded.push(u.key);
      continue;
    }
    const t = time(u.artifact);
    if (!(t < floor && t < restore.time)) continue;
    result.push(...parts);
  }
  const retained = sorted.filter((u) => protectedKeys.has(u.key) && u.artifact).sort(newestFirst).map((u) => u.key);
  return { delete: result, retained, protectedByGuard: guarded.sort(), states, alerts: [...alerts].sort() };
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

// Companion objects of a backup: integrity manifest, writer's verified marker, restore-drill marker (R29b).
const BACKUP_BASENAME = /^aee-protected-\d{8}T\d{6}Z-[a-f0-9]{12}\.tar\.enc(?:\.sha256\.json|\.verified\.json|\.restore-verified\.json)?$/;
const TIER_KEY = /^(daily|weekly|monthly)\/(aee-protected-\d{8}T\d{6}Z-[a-f0-9]{12}\.tar\.enc(?:\.sha256\.json|\.verified\.json|\.restore-verified\.json)?)$/;

/**
 * Strict parser for tiered object keys. Returns null for anything that is not exactly `<tier>/<backup object name>`.
 * `manifest` is true only for the integrity manifest; `.verified.json` / `.restore-verified.json` markers parse with
 * `manifest: false` and `marker` set.
 */
export function parseBackupKey(key: string): { tier: Tier; name: string; manifest: boolean; marker?: "verified" | "restore-verified" } | null {
  const match = TIER_KEY.exec(key);
  if (!match) return null;
  const name = match[2]!;
  const marker = name.endsWith(RESTORE_VERIFIED_SUFFIX) ? "restore-verified" : name.endsWith(VERIFIED_SUFFIX) ? "verified" : undefined;
  return { tier: match[1] as Tier, name, manifest: name.endsWith(MANIFEST_SUFFIX), ...(marker ? { marker } : {}) };
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
  /** Full object keys that may be deleted, per backup unit: artifact, then manifest, then markers. */
  delete: RemoteObject[];
  /** Per-tier / legacy retained (protected) artifact names. */
  retained: Record<string, string[]>;
  /** Number of expired candidates kept because of a safeguard. */
  protectedByGuard: number;
  /** Counts per state per tier / "legacy" (AC7). No keys. */
  states: Record<string, StateCounts>;
  /** Alert event names (never object keys). */
  alerts: string[];
}

/**
 * Plans pruning independently per tier (and for legacy flat keys). Guarantees, per group:
 * everything `planRetention` guarantees (only VERIFIED backups count toward keep, the newest `keep`
 * VERIFIED backups survive, a group with too few VERIFIED backups loses no backup unit, the just-uploaded
 * artifact survives, unrelated and bad-timestamp objects are untouched) PLUS: the newest RESTORE_VERIFIED
 * backup across ALL tiers and the legacy layout is protected and bounds every deletion (R2/R3), no object is
 * otherwise deleted because of another tier's contents, and keys in an unknown folder or with a malformed
 * tiered name are never deleted. `evidence` is keyed by full object key (e.g. `daily/<artifact>`).
 */
export function planTierRetention(
  objects: RemoteObject[],
  now: Date,
  policy: TierPolicy,
  legacy: { retentionDays: number; minRetained: number },
  options: { protectedArtifact?: string; evidence?: RetentionEvidence } = {},
): TierRetentionPlan {
  const result: RemoteObject[] = [];
  const retained: Record<string, string[]> = {};
  const states: Record<string, StateCounts> = {};
  const alerts = new Set<string>();
  let guarded = 0;
  const evidence = options.evidence ?? {};
  const cutoffFor = (days: number): Date => new Date(now.valueOf() - days * 86_400_000);
  const groups: Array<{ id: string; prefix: string; objects: RemoteObject[]; evidence: RetentionEvidence }> = [];
  for (const tier of TIERS) {
    const group: RemoteObject[] = [];
    const groupEvidence: RetentionEvidence = {};
    for (const object of objects) {
      const parsed = parseBackupKey(object.key);
      if (parsed?.tier !== tier) continue;
      group.push({ key: parsed.name, lastModified: object.lastModified });
      const unitName = unitKeyOf(parsed.name);
      const ev = evidence[tierKey(tier, unitName)];
      if (ev) groupEvidence[unitName] = ev;
    }
    groups.push({ id: tier, prefix: `${tier}/`, objects: group, evidence: groupEvidence });
  }
  const flat = objects.filter((object) => !object.key.includes("/"));
  const flatEvidence: RetentionEvidence = {};
  for (const object of flat) if (evidence[unitKeyOf(object.key)]) flatEvidence[unitKeyOf(object.key)] = evidence[unitKeyOf(object.key)]!;
  groups.push({ id: "legacy", prefix: "", objects: flat, evidence: flatEvidence });
  // R2: the newest RESTORE_VERIFIED backup is chosen across every group (full key, tie-break by key).
  let global: { group: string; key: string; full: string; time: number } | undefined;
  for (const g of groups) {
    const best = newestRestoreVerified(g.objects, { evidence: g.evidence, now });
    if (!best) continue;
    const full = `${g.prefix}${best.key}`;
    if (!global || best.time > global.time || (best.time === global.time && full > global.full)) {
      global = { group: g.id, key: best.key, full, time: best.time };
    }
  }
  for (const g of groups) {
    const rule = g.id === "legacy" ? { keep: legacy.minRetained, retentionDays: legacy.retentionDays } : policy[g.id as Tier];
    const plan = planRetention(g.objects, cutoffFor(rule.retentionDays), {
      minRetained: rule.keep,
      protectedArtifact: options.protectedArtifact,
      evidence: g.evidence,
      now,
      globalRestore: global ? { key: global.group === g.id ? global.key : "", time: global.time } : null,
    });
    retained[g.id] = plan.retained;
    guarded += plan.protectedByGuard.length;
    const counts = plan.states[""] ?? { present: 0, verified: 0, restoreVerified: 0, invalid: 0 };
    states[g.id] = counts;
    for (const alert of plan.alerts) alerts.add(alert);
    for (const object of plan.delete) {
      result.push(g.id === "legacy" ? object : { key: tierKey(g.id as Tier, object.key), lastModified: object.lastModified });
    }
  }
  return { delete: result, retained, protectedByGuard: guarded, states, alerts: [...alerts].sort() };
}

/**
 * Local-log / CLI redaction (CLI-SPEC §3, R29b): strips credentials embedded in URLs and `password=` / `secret=` /
 * `token=` values, keeps line structure (so an opt-in debug stack stays readable) and bounds the length. Unlike
 * `sanitizeErrorText` it keeps variable names, so config errors still name the variable (never its value).
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[credentials-redacted]@")
    .replace(/((?:pass(?:word)?|secret|token|api[_-]?key)=)([^\s&"']+)/gi, "$1[redacted]")
    .slice(0, 4_000);
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
