import { appendFile, lstat, open, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

/**
 * D-5 staging hygiene (PH-7 R13). Backup/restore runs leave a run directory in the staging root. A run that
 * is killed (OOM, power loss) never reaches its `finally`, so plaintext dumps could stay on disk forever.
 *
 * Every run directory carries a `.run.json` marker (runId, kind, pid, host, uid, heartbeat, state). The sweep
 * only removes a directory when ALL of these hold: its name and marker agree, it is owned by this user on this
 * host, its heartbeat is older than the minimum age, its pid is not alive, and it contains nothing unexpected
 * (no symlinks, hardlinks or unknown files). Anything else is reported as `ambiguous` and left alone.
 * A directory holding an encrypted artifact that was NOT verified as uploaded keeps that artifact (it may be
 * the only recoverable copy); only the plaintext beside it is overwritten and removed.
 *
 * Modes: off (default, does nothing) | dry-run (decides and audits, changes nothing) | on (destructive).
 * Limits: overwrite-before-unlink is best effort; it gives no guarantee on SSD wear-levelling, copy-on-write or
 * journalling filesystems, snapshots or backups of the staging volume. Use an encrypted staging volume.
 */

export type SweepMode = "off" | "dry-run" | "on";
export type RunState = "running" | "encrypted" | "uploaded_verified" | "plaintext_swept_artifact_retained" | "sweep_claimed";
const STATES: readonly string[] = ["running", "encrypted", "uploaded_verified", "plaintext_swept_artifact_retained", "sweep_claimed"];

export interface RunMarker {
  version: 1;
  runId: string;
  kind: "backup" | "restore";
  pid: number;
  host: string;
  uid: number | null;
  startedAt: string;
  heartbeatAt: string;
  state: RunState;
}

export const MARKER_NAME = ".run.json";
export const AUDIT_NAME = "sweep-audit.jsonl";
const ARTIFACT_RE = /^aee-protected-\d{8}T\d{6}Z-[a-f0-9]{12}\.tar\.enc$/;
// "retention" holds transient retention-evidence downloads; `<artifact>.verified.json` is the writer's verified marker (R29b).
const KNOWN_TOP_LEVEL = new Set(["database.dump", "inventory.json", "documents.tar", "payload.tar", "documents-src", "verify", "retention", MARKER_NAME, `${MARKER_NAME}.tmp`]);
const DIR_RE = /^(backup|restore)-([a-f0-9]{16})$/;
const CLAIMED_RE = /^sweeping-(backup|restore)-([a-f0-9]{16})$/;

const currentUid = (): number | null => (typeof process.getuid === "function" ? process.getuid() : null);

function knownTopLevel(name: string): boolean {
  return KNOWN_TOP_LEVEL.has(name) || ARTIFACT_RE.test(name) || (name.endsWith(".sha256.json") && ARTIFACT_RE.test(name.slice(0, -".sha256.json".length))) || (name.endsWith(".verified.json") && ARTIFACT_RE.test(name.slice(0, -".verified.json".length))) || /^[a-f0-9-]+\.(intent|outcome)\.json$/.test(name);
}

export function newRunMarker(runId: string, kind: "backup" | "restore", now: Date = new Date()): RunMarker {
  return { version: 1, runId, kind, pid: process.pid, host: hostname(), uid: currentUid(), startedAt: now.toISOString(), heartbeatAt: now.toISOString(), state: "running" };
}

/** Atomic (write temp + rename) so a crash never leaves a half-written marker. */
export async function writeRunMarker(dir: string, marker: RunMarker): Promise<void> {
  const target = path.join(dir, MARKER_NAME);
  const temp = `${target}.tmp`;
  await writeFile(temp, JSON.stringify(marker) + "\n", { mode: 0o600 });
  await rename(temp, target);
}

export async function readRunMarker(dir: string): Promise<RunMarker | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, MARKER_NAME), "utf8")) as Partial<RunMarker>;
    if (parsed.version !== 1 || typeof parsed.runId !== "string" || (parsed.kind !== "backup" && parsed.kind !== "restore")) return null;
    if (typeof parsed.pid !== "number" || typeof parsed.host !== "string" || typeof parsed.startedAt !== "string" || typeof parsed.heartbeatAt !== "string") return null;
    if (parsed.uid !== null && typeof parsed.uid !== "number") return null;
    if (typeof parsed.state !== "string" || !STATES.includes(parsed.state)) return null;
    return parsed as RunMarker;
  } catch {
    return null;
  }
}

export async function updateRunMarker(dir: string, patch: Partial<Pick<RunMarker, "state" | "heartbeatAt">>): Promise<void> {
  const current = await readRunMarker(dir);
  if (!current) return;
  await writeRunMarker(dir, { ...current, ...patch });
}

/** Refreshes the marker heartbeat; the timer never keeps the process alive. Returns a stop function. */
export function startHeartbeat(dir: string, intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    void updateRunMarker(dir, { heartbeatAt: new Date().toISOString() }).catch(() => undefined);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export interface RemoveOptions {
  /** Top-level names that are left untouched (e.g. the encrypted artifact and its manifest). */
  keep?: string[];
  /** Test hook: called with each regular file after it was overwritten and before it is unlinked. */
  beforeUnlink?: (file: string) => Promise<void>;
}

async function overwriteWithZeros(file: string, size: number): Promise<void> {
  const handle = await open(file, "r+");
  try {
    const chunk = Buffer.alloc(Math.min(Math.max(size, 1), 1 << 20));
    let written = 0;
    while (written < size) {
      const n = Math.min(chunk.length, size - written);
      await handle.write(chunk, 0, n, written);
      written += n;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function shredTree(target: string, options: RemoveOptions): Promise<void> {
  const info = await lstat(target);
  if (info.isSymbolicLink()) {
    await unlink(target); // remove the link itself, never follow it
    return;
  }
  if (info.isDirectory()) {
    for (const entry of await readdir(target)) await shredTree(path.join(target, entry), options);
    await rmdir(target);
    return;
  }
  if (info.isFile()) {
    if (info.nlink <= 1) await overwriteWithZeros(target, info.size).catch(() => undefined);
    if (options.beforeUnlink) await options.beforeUnlink(target);
  }
  await unlink(target);
}

/** Overwrites (best effort) and removes everything in `dir` except `keep`; removes `dir` itself when nothing is kept. */
export async function removeRunDirectory(dir: string, options: RemoveOptions = {}): Promise<void> {
  const keep = new Set(options.keep ?? []);
  for (const entry of await readdir(dir)) {
    if (keep.has(entry)) continue;
    await shredTree(path.join(dir, entry), options);
  }
  if (keep.size === 0) await rmdir(dir);
}

/** Never throws: used on the failure path so a cleanup problem cannot mask the original error. */
export async function safeRemoveRunDirectory(dir: string): Promise<void> {
  try {
    await removeRunDirectory(dir);
  } catch {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export type SweepDecision =
  | "removed" | "would_remove" | "artifact_retained" | "would_retain_artifact"
  | "active" | "too_recent" | "ambiguous" | "foreign_ignored" | "error";

export interface SweepEntry { name: string; decision: SweepDecision; reason: string }
export interface SweepReport { mode: SweepMode; stagingDirectory: string; minAgeMs: number; entries: SweepEntry[]; counts: Record<string, number> }

export interface SweepOptions {
  stagingDirectory: string;
  mode: SweepMode;
  /** Minimum heartbeat age before a directory can be considered stale. */
  minAgeMs: number;
  now?: () => Date;
  isPidAlive?: (pid: number) => boolean;
  hostName?: string;
  beforeUnlink?: (file: string) => Promise<void>;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface Inspection { ok: boolean; reason: string; files: string[]; hasArtifact: boolean }

async function inspectTree(dir: string, top: boolean): Promise<Inspection> {
  const files: string[] = [];
  let hasArtifact = false;
  for (const entry of await readdir(dir)) {
    const full = path.join(dir, entry);
    const info = await lstat(full);
    if (info.isSymbolicLink()) return { ok: false, reason: `symlink inside run directory: ${entry}`, files, hasArtifact };
    if (top && !knownTopLevel(entry)) return { ok: false, reason: `unrecognised file in run directory: ${entry}`, files, hasArtifact };
    if (info.isDirectory()) {
      const inner = await inspectTree(full, false);
      if (!inner.ok) return inner;
      continue;
    }
    if (!info.isFile()) return { ok: false, reason: `special file in run directory: ${entry}`, files, hasArtifact };
    if (info.nlink > 1) return { ok: false, reason: `hardlinked file in run directory: ${entry}`, files, hasArtifact };
    if (top && ARTIFACT_RE.test(entry)) hasArtifact = true;
    files.push(entry);
  }
  return { ok: true, reason: "", files, hasArtifact };
}

export async function sweepStaging(options: SweepOptions): Promise<SweepReport> {
  const report: SweepReport = { mode: options.mode, stagingDirectory: options.stagingDirectory, minAgeMs: options.minAgeMs, entries: [], counts: {} };
  if (options.mode === "off") return report;
  if (!Number.isFinite(options.minAgeMs) || options.minAgeMs < 3_600_000) throw new Error("Staging sweep minimum age must be at least one hour");
  const now = (options.now ?? (() => new Date()))();
  const alive = options.isPidAlive ?? pidAlive;
  const host = options.hostName ?? hostname();
  const dryRun = options.mode === "dry-run";
  let names: string[];
  try {
    names = (await readdir(options.stagingDirectory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
    throw error;
  }
  const record = async (entry: SweepEntry): Promise<void> => {
    report.entries.push(entry);
    report.counts[entry.decision] = (report.counts[entry.decision] ?? 0) + 1;
    const line = { timestamp: new Date().toISOString(), dryRun, minAgeHours: options.minAgeMs / 3_600_000, ...entry };
    await appendFile(path.join(options.stagingDirectory, AUDIT_NAME), JSON.stringify(line) + "\n", { mode: 0o600 });
  };

  // Fail closed: if the audit trail cannot be written, nothing is deleted.
  if (!dryRun || names.length > 0) {
    await appendFile(path.join(options.stagingDirectory, AUDIT_NAME), JSON.stringify({ timestamp: new Date().toISOString(), event: "sweep_started", mode: options.mode, minAgeHours: options.minAgeMs / 3_600_000 }) + "\n", { mode: 0o600 });
  }
  for (const name of names) {
    if (name === AUDIT_NAME) continue;
    const dir = path.join(options.stagingDirectory, name);
    const match = DIR_RE.exec(name) ?? CLAIMED_RE.exec(name);
    if (!match) {
      await record({ name, decision: "foreign_ignored", reason: "name is not a backup/restore run directory" });
      continue;
    }
    const claimed = name.startsWith("sweeping-");
    const [, kind, runId] = match;
    try {
      const info = await lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        await record({ name, decision: "ambiguous", reason: info.isSymbolicLink() ? "run directory is a symlink" : "run directory is not a directory" });
        continue;
      }
      const me = currentUid();
      if (me !== null && info.uid !== me) {
        await record({ name, decision: "ambiguous", reason: "directory is not owned by the current user" });
        continue;
      }
      const marker = await readRunMarker(dir);
      if (!marker) { await record({ name, decision: "ambiguous", reason: "missing or invalid run marker" }); continue; }
      if (marker.runId !== runId || marker.kind !== kind) { await record({ name, decision: "ambiguous", reason: "run marker does not match directory name" }); continue; }
      if (marker.host !== host) { await record({ name, decision: "ambiguous", reason: "run marker belongs to another host" }); continue; }
      if (me !== null && marker.uid !== me) { await record({ name, decision: "ambiguous", reason: "run marker owner does not match current user" }); continue; }
      const heartbeat = Date.parse(marker.heartbeatAt);
      if (!Number.isFinite(heartbeat) || heartbeat > now.getTime() + 3_600_000) { await record({ name, decision: "ambiguous", reason: "heartbeat is invalid or in the future" }); continue; }
      if (claimed && marker.state !== "sweep_claimed") { await record({ name, decision: "ambiguous", reason: "claimed directory without sweep_claimed marker" }); continue; }
      if (!claimed && marker.state === "sweep_claimed") { await record({ name, decision: "ambiguous", reason: "sweep_claimed marker on an unclaimed directory name" }); continue; }
      if (alive(marker.pid) && !claimed) {
        await record({ name, decision: "active", reason: `pid ${marker.pid} is alive` });
        continue;
      }
      if (!claimed && now.getTime() - heartbeat < options.minAgeMs) {
        await record({ name, decision: "too_recent", reason: "heartbeat is younger than the minimum age" });
        continue;
      }
      const inspection = await inspectTree(dir, true);
      if (!inspection.ok) { await record({ name, decision: "ambiguous", reason: inspection.reason }); continue; }

      // Only recoverable artifact: a backup whose upload was not verified keeps its encrypted artifact + manifest.
      const retainArtifact = marker.kind === "backup" && inspection.hasArtifact && marker.state !== "uploaded_verified" && !claimed;
      if (retainArtifact) {
        const keep = inspection.files.filter((f) => ARTIFACT_RE.test(f) || (f.endsWith(".sha256.json") && ARTIFACT_RE.test(f.slice(0, -".sha256.json".length))));
        const alreadyClean = marker.state === "plaintext_swept_artifact_retained" && inspection.files.every((f) => keep.includes(f) || f === MARKER_NAME);
        if (dryRun) {
          await record({ name, decision: "would_retain_artifact", reason: "encrypted artifact is not verified as uploaded; it would be kept, plaintext overwritten and removed" });
        } else {
          if (!alreadyClean) {
            await removeRunDirectory(dir, { keep: [...keep, MARKER_NAME], ...(options.beforeUnlink ? { beforeUnlink: options.beforeUnlink } : {}) });
            await writeRunMarker(dir, { ...marker, state: "plaintext_swept_artifact_retained" });
          }
          await record({ name, decision: "artifact_retained", reason: "encrypted artifact is not verified as uploaded; kept as possibly the only recoverable copy (operator decision required)" });
        }
        continue;
      }
      if (dryRun) { await record({ name, decision: "would_remove", reason: "stale, owned, marker-verified, no live pid" }); continue; }
      // Claim atomically (rename) so a racing writer cannot resume in a directory being deleted.
      let target = dir;
      if (!claimed) {
        target = path.join(options.stagingDirectory, `sweeping-${kind}-${runId}`);
        await rename(dir, target);
        await writeRunMarker(target, { ...marker, state: "sweep_claimed" });
      }
      await removeRunDirectory(target, options.beforeUnlink ? { beforeUnlink: options.beforeUnlink } : {});
      await record({ name, decision: "removed", reason: "stale run directory overwritten and removed" });
    } catch (error) {
      await record({ name, decision: "error", reason: error instanceof Error ? error.message.slice(0, 200) : "unknown error" });
    }
  }
  return report;
}

