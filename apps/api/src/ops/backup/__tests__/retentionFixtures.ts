// Test fixtures for the retention safeguard (PH-7 R29, carried to the D-9 chain in R29b). Not a test file itself.
import { createHash } from "node:crypto";
import type { RemoteObject } from "../types.js";
import { withSeedMarkers } from "./helpers/fakeBackupRemote.js";

export type MarkerKind = "ok" | "mismatch" | "garbage" | false;
export interface Evidence {
  manifest?: string;
  verified?: string;
  restoreVerified?: string;
}
export type EvidenceMap = Record<string, Evidence>;
export interface Listing {
  objects: RemoteObject[];
  evidence: EvidenceMap;
}

export const sha = (seed: string): string => createHash("sha256").update(seed).digest("hex");
const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

export function artifactKey(day: number, tier = "", hour = 0): string {
  const name = `aee-protected-2026${pad(1 + Math.floor((day - 1) / 28))}${pad(((day - 1) % 28) + 1)}T${pad(hour)}0000Z-${(day * 100 + hour).toString(16).padStart(12, "0")}.tar.enc`;
  return tier ? `${tier}/${name}` : name;
}
export function isoFor(day: number, hour = 0): string {
  return `2026-${pad(1 + Math.floor((day - 1) / 28))}-${pad(((day - 1) % 28) + 1)}T${pad(hour)}:00:00Z`;
}
export const basename = (key: string): string => key.slice(key.lastIndexOf("/") + 1);

export function markerBody(key: string, kind: "verified" | "restore-verified", marker: MarkerKind): string | undefined {
  if (marker === false) return undefined;
  if (marker === "garbage") return "{not json";
  const digest = marker === "ok" ? sha(key) : sha(`${key}-forged`);
  return JSON.stringify({ version: 1, kind, artifact: basename(key), sha256: digest, verifiedAt: "2026-01-01T00:00:00Z" }) + "\n";
}

export interface BackupOptions {
  tier?: string;
  hour?: number;
  artifact?: boolean;
  manifest?: boolean;
  verified?: MarkerKind;
  restore?: MarkerKind;
  lastModified?: string;
}

/** One backup unit with optional manifest and markers; evidence holds the marker/manifest bodies a download would return. */
export function bk(day: number, options: BackupOptions = {}): Listing {
  const key = artifactKey(day, options.tier, options.hour ?? 0);
  const when = options.lastModified ?? isoFor(day, options.hour ?? 0);
  const objects: RemoteObject[] = [];
  const evidence: Evidence = {};
  if (options.artifact !== false) objects.push({ key, lastModified: when });
  if (options.manifest !== false) {
    objects.push({ key: `${key}.sha256.json`, lastModified: when });
    evidence.manifest = JSON.stringify({ version: 1, artifact: basename(key), createdAt: when, sha256: sha(key), bytes: 4 }) + "\n";
  }
  const verified = markerBody(key, "verified", options.verified ?? false);
  if (verified !== undefined) {
    objects.push({ key: `${key}.verified.json`, lastModified: when });
    evidence.verified = verified;
  }
  const restore = markerBody(key, "restore-verified", options.restore ?? false);
  if (restore !== undefined) {
    objects.push({ key: `${key}.restore-verified.json`, lastModified: when });
    evidence.restoreVerified = restore;
  }
  return { objects, evidence: { [key]: evidence } };
}

export const verified = (day: number, options: BackupOptions = {}): Listing => bk(day, { verified: "ok", ...options });
export const restoreVerified = (day: number, options: BackupOptions = {}): Listing =>
  bk(day, { verified: "ok", restore: "ok", ...options });

export function merge(...parts: Listing[]): Listing {
  return {
    objects: parts.flatMap((p) => p.objects),
    evidence: Object.assign({}, ...parts.map((p) => p.evidence)) as EvidenceMap,
  };
}
export const keys = (objects: RemoteObject[]): string[] => objects.map((o) => o.key);

/** Deterministic PRNG (mulberry32) so the property test is reproducible from its seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * R29b: gives a pre-R29b fixture listing (artifact + manifest pairs) the markers a real writer/restore drill would
 * have left: a matching `.verified.json` on every pair and a `.restore-verified.json` on the newest pair (default),
 * plus the evidence bodies the engine would download. Same rules as the fake remote's `seedMarkers` default.
 */
export function marked(objects: RemoteObject[], mode: "verified+restore" | "verified" | "none" = "verified+restore"): Listing {
  const { seed, bodies } = withSeedMarkers(objects, mode);
  const evidence: EvidenceMap = {};
  for (const o of seed) {
    if (!/\.tar\.enc$/.test(o.key)) continue;
    const e: Evidence = {};
    if (bodies.has(`${o.key}.sha256.json`)) e.manifest = bodies.get(`${o.key}.sha256.json`);
    if (bodies.has(`${o.key}.verified.json`)) e.verified = bodies.get(`${o.key}.verified.json`);
    if (bodies.has(`${o.key}.restore-verified.json`)) e.restoreVerified = bodies.get(`${o.key}.restore-verified.json`);
    if (Object.keys(e).length) evidence[o.key] = e;
  }
  return { objects: seed, evidence };
}
