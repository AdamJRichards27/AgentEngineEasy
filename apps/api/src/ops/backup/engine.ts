import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertDeleteVerifierForPrune } from "./config.js";
import { DumpArchiveIncompatibleError, assertArchiveReadable, readDumpArchiveVersion } from "./dumpFormat.js";
import {
  ARTIFACT_PREFIX,
  DEFAULT_MIN_RETAINED_BACKUPS,
  DEFAULT_TIER_POLICY,
  MANIFEST_SUFFIX,
  RESTORE_VERIFIED_SUFFIX,
  VERIFIED_SUFFIX,
  artifactName,
  assessListing,
  planTierRetention,
  redactSecrets,
  sanitizeErrorText,
  tierKey,
  isTier,
  tiersFor,
  unitKeyOf,
  verifiedMarkerBody,
  ManifestUnavailableError,
  parseManifest,
  verifyManifest,
  writeManifest,
  type RetentionEvidence,
  type Tier,
  type TierRetentionPlan,
} from "./artifacts.js";
import {
  newRunMarker, safeRemoveRunDirectory, startHeartbeat, sweepStaging, updateRunMarker, writeRunMarker,
} from "./stagingSweep.js";
import { assertRestoreTargetIsEmpty, readDatabaseInventory, validateDatabaseInventory } from "./database.js";
import { stageObjectStorageDocuments, type DocumentObjectReader } from "./objectDocuments.js";
import { compareDocumentKeys, documentInventory, prepareEmptyRestoreDirectory } from "./documents.js";
import type {
  ArtifactManifest,
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
  /**
   * WS4-06: major version of the pg_restore client that will run (the CLI passes the value its preflight read).
   * When set, restore refuses an archive newer than that client can read (manifest check before decrypt, dump header
   * check before pg_restore). When absent (direct engine callers), restore behaves exactly as before.
   */
  pgRestoreMajor?: number;
}

function defaultLog(entry: OperationLog): void {
  const output = JSON.stringify(entry) + "\n";
  (entry.level === "error" ? process.stderr : process.stdout).write(output);
}

function remoteUri(destination: string, name: string): string {
  // Encode each path segment but keep "/" so tier folders (daily/, weekly/, monthly/) stay folders.
  return `${destination}/${name.split("/").map(encodeURIComponent).join("/")}`;
}

async function notify(
  config: BackupConfig,
  run: CommandRunner,
  replacements: Record<string, string>,
): Promise<void> {
  await run(config.alert, replacements, "alert");
}

/** Alert payloads carry a fixed reason code and counts only (never object keys, provider text or identifiers). */
async function safeAlert(
  config: BackupConfig,
  run: CommandRunner,
  log: (entry: OperationLog) => void,
  runId: string,
  status: string,
  error: string,
): Promise<boolean> {
  try {
    await notify(config, run, { operation: "backup", status, error, runId });
    return true;
  } catch (alertError) {
    log({
      timestamp: new Date().toISOString(),
      level: "error",
      operation: "backup",
      event: "alert_failed",
      runId,
      error: sanitizeErrorText(alertError instanceof Error ? alertError.message : String(alertError)),
    });
    return false;
  }
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
  let result: { bytes: number; sha256: string } | undefined;
  for (const [index, target] of targets.entries()) {
    const verifyDirectory = path.join(runDirectory, "verify", String(index));
    await mkdir(verifyDirectory, { recursive: true, mode: 0o700 });
    const name = path.posix.basename(target.artifact);
    const artifact = path.join(verifyDirectory, name);
    const manifest = `${artifact}.sha256.json`;
    try {
      await run(config.verifyDownload ?? config.download, { source: remoteUri(config.destination, target.artifact), destination: artifact, object: target.artifact }, "verify_download");
      await run(config.verifyDownload ?? config.download, { source: remoteUri(config.destination, target.manifest), destination: manifest, object: target.manifest }, "verify_download");
      const [remoteManifest, localManifest] = await Promise.all([readFile(manifest), readFile(localManifestPath)]);
      if (!remoteManifest.equals(localManifest)) {
        throw new Error("manifest stored remotely differs from the manifest written for this run");
      }
      const verified = await verifyManifest(artifact, manifest);
      result = { bytes: verified.bytes, sha256: verified.sha256 };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Post-upload verification failed for ${target.artifact}: ${reason}`, { cause: error });
    }
  }
  if (!result) throw new Error("Post-upload verification failed: no uploaded copy was verified");
  return result;
}

/** Fixed (non-dynamic) alert text per failing stage: a reason code plus a constant label. */
const ALERT_REASONS: Record<string, string> = {
  preflight: "preflight_failed: backup configuration refused",
  prepare: "prepare_failed: backup could not be prepared",
  tier_upload: "tier_upload_failed: upload to a backup tier failed",
  verify: "verify_failed: Post-upload verification failed",
  marker_write: "marker_write_failed: verified marker could not be written",
  prune: "prune_failed: retention pruning failed",
};

/** Thrown when a non-empty backup listing contains no recognisable backup key (see `assessListing`). */
export class PruneListUnexpectedError extends Error {
  constructor(
    readonly listed: number,
    readonly recognised: number,
    readonly unrecognisedBackupLike: number = 0,
  ) {
    super("prune_list_unexpected: backup listing contains no recognisable backup keys, or backup-named keys in an unrecognised shape");
    this.name = "PruneListUnexpectedError";
  }
}

export interface PruneResult {
  deleted: number;
  failed: number;
  protectedByGuard: number;
  /** True when pruning halted after a delete failed or was uncertain. */
  stopped: boolean;
  /** Manifests deliberately kept because their artifact could not be confirmed deleted. */
  manifestsPreserved: number;
  /** Deletes the delete command reported done AND the verifier confirmed permanently absent (class "absent"). */
  verified: number;
  /** Delete commands that exited 0, verified or not. NOT proof of deletion; operator context only. */
  accepted: number;
  /** Verifier classes of failed verifications this run (for the alert). */
  failureClasses?: string[];
  /** S9: the fresh listing changed the plan, so nothing was deleted. */
  aborted?: boolean;
}

interface PruneUnit {
  artifact?: RemoteObject;
  manifest?: RemoteObject;
  /** `.verified.json` / `.restore-verified.json` markers of the unit (R29b); deleted last. */
  markers: RemoteObject[];
}

type PruneUnitStatus =
  /** Every delete in the unit was confirmed permanent by the verification command. */
  | "deleted_verified"
  /** LEGACY (R18 outcome records, version 2, written when no verifier was configured). Never emitted since R19: with pruning on a verifier is mandatory. Kept so old records still parse. */
  | "deleted_unverified"
  | "artifact_delete_failed_manifest_preserved"
  /** The artifact delete command exited 0 but verification failed: the artifact may still exist, so the manifest is kept. */
  | "artifact_delete_not_verified_manifest_preserved"
  | "manifest_delete_failed_artifact_deleted"
  | "manifest_delete_not_verified_artifact_deleted"
  /** R29b: artifact and manifest confirmed deleted, a marker delete was refused / not verified (an orphan marker is INVALID, never counted). */
  | "marker_delete_failed_backup_deleted"
  | "marker_delete_not_verified_backup_deleted"
  | "not_attempted_pruning_stopped";

interface PruneUnitOutcome {
  artifact: string | null;
  manifest: string | null;
  /** Additive (R29b): marker keys of the unit. */
  markers?: string[];
  status: PruneUnitStatus;
  error?: string;
  /** Verifier class (e.g. delete_marker_retained, governance_locked, malformed_output) when verification failed. Additive field. */
  verifierClass?: string;
}

/**
 * Groups planned deletions into recoverability units: an artifact together with its own manifest (same folder,
 * name + ".sha256.json") and its markers (name + ".verified.json" / ".restore-verified.json"). A manifest or marker
 * with no planned artifact is part of an artifact-less unit (orphan, nothing to protect).
 * The just-uploaded artifact and its companions are never part of a unit (defence in depth over the planner).
 */
function buildPruneUnits(objects: RemoteObject[], protectedArtifact: string): PruneUnit[] {
  const units = new Map<string, PruneUnit>();
  const order: string[] = [];
  for (const object of objects) {
    const base = unitKeyOf(object.key);
    const basename = base.slice(base.lastIndexOf("/") + 1);
    if (basename === protectedArtifact) continue;
    let unit = units.get(base);
    if (!unit) {
      unit = { markers: [] };
      units.set(base, unit);
      order.push(base);
    }
    if (object.key.endsWith(MANIFEST_SUFFIX)) unit.manifest = object;
    else if (object.key.endsWith(VERIFIED_SUFFIX) || object.key.endsWith(RESTORE_VERIFIED_SUFFIX)) unit.markers.push(object);
    else unit.artifact = object;
  }
  return order.map((key) => units.get(key)!);
}

/** The delete command exited 0 but the verification command did not confirm permanent deletion (or could not run). */
class DeleteNotVerifiedError extends Error {
  constructor(message: string, readonly verifierClass: string) {
    super(`delete not verified (verifier class ${verifierClass}): ${message}`);
    this.name = "DeleteNotVerifiedError";
  }
}

const VERIFIER_CLASS = /verify_class=([a-z_]+)/;

/**
 * The verifier contract: exit 0 AND a stdout JSON line {"class":"absent","verified":true} (any version / delete-marker
 * count present must be 0). Anything else - empty or malformed output, another class, contradictory fields - is NOT a
 * verified deletion. Returns undefined when the output confirms permanent absence, otherwise the reason.
 */
function verifierRejection(stdout: string): { verifierClass: string; reason: string } | undefined {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { verifierClass: "malformed_output", reason: "verifier exited 0 but printed no verdict" };
  let verdict: unknown;
  try {
    verdict = JSON.parse(lines[lines.length - 1]!);
  } catch {
    return { verifierClass: "malformed_output", reason: "verifier verdict is not JSON" };
  }
  if (typeof verdict !== "object" || verdict === null || Array.isArray(verdict)) return { verifierClass: "malformed_output", reason: "verifier verdict is not a JSON object" };
  const v = verdict as Record<string, unknown>;
  if (v.class !== "absent") return { verifierClass: typeof v.class === "string" && /^[a-z_]+$/.test(v.class) ? v.class : "malformed_output", reason: `verifier reported class ${JSON.stringify(v.class)}, not absent` };
  if (v.verified !== true) return { verifierClass: "malformed_output", reason: "verifier verdict is class absent without verified=true" };
  if ((v.versions !== undefined && v.versions !== 0) || (v.deleteMarkers !== undefined && v.deleteMarkers !== 0)) {
    return { verifierClass: "malformed_output", reason: "verifier verdict claims absent but reports retained versions or delete markers" };
  }
  return undefined;
}

/**
 * Runs the delete command, then the mandatory verifier. A delete command's success is only "the provider accepted the
 * request": on a versioned or Object Lock bucket it may just add a delete marker. There is no unverified outcome: the
 * verifier must be configured BEFORE the delete command runs, and only a verifier verdict of "absent" returns.
 * Throws the delete command's own error when refused, or DeleteNotVerifiedError for every other outcome (including a
 * missing verifier, a failing verifier and malformed output).
 */
async function deleteObject(config: BackupConfig, run: CommandRunner, key: string, counters: { accepted: number }): Promise<void> {
  if (!config.deleteVerify) throw new DeleteNotVerifiedError("no BACKUP_DELETE_VERIFY_COMMAND configured; refusing to delete", "no_verifier");
  const replacements = { destination: config.destination, object: key, remote: remoteUri(config.destination, key) };
  await run(config.remove, replacements, "delete");
  counters.accepted += 1;
  let stdout: string;
  try {
    ({ stdout } = await run(config.deleteVerify, replacements, "list"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DeleteNotVerifiedError(message, VERIFIER_CLASS.exec(message)?.[1] ?? "verifier_failed");
  }
  const rejection = verifierRejection(stdout ?? "");
  if (rejection) throw new DeleteNotVerifiedError(rejection.reason, rejection.verifierClass);
}

async function storeDeletionRecord(
  config: BackupConfig,
  run: CommandRunner,
  runDirectory: string,
  key: string,
  record: Record<string, unknown>,
): Promise<void> {
  const local = path.join(runDirectory, path.posix.basename(key));
  await writeFile(local, JSON.stringify(record) + "\n", { mode: 0o600 });
  await run(config.upload, { source: local, destination: remoteUri(config.destination, key), object: key }, "upload");
}

function parseListing(stdout: string, log: (entry: OperationLog) => void, runId: string): RemoteObject[] {
  let objects: unknown;
  try {
    objects = JSON.parse(stdout);
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
  // Fail visibly (never silently prune nothing) when the adapter's key format is not the documented
  // destination-relative contract. Nothing has been deleted at this point.
  const assessment = assessListing(valid);
  // A listing that mixes recognised keys with backup-named keys in another shape would make the planner
  // under-count (e.g. a hidden manifest turns a recoverable backup into an "orphan artifact"), so it is
  // refused too. Unrelated foreign objects (non-backup names) are not counted and do not trigger this.
  if ((assessment.listed > 0 && assessment.recognised === 0) || assessment.unrecognisedBackupLike > 0) {
    log({
      timestamp: new Date().toISOString(),
      level: "error",
      operation: "backup",
      event: "prune_list_unexpected",
      runId,
      listed: assessment.listed,
      recognised: assessment.recognised,
      unrecognisedBackupLike: assessment.unrecognisedBackupLike,
    });
    throw new PruneListUnexpectedError(assessment.listed, assessment.recognised, assessment.unrecognisedBackupLike);
  }
  return valid;
}

/**
 * Reads the small manifest/marker bodies the planner needs (RETENTION-SAFEGUARD-SPEC §5.1), only for artifacts
 * that have a manifest AND a marker, through the read-only verifier download identity (falls back to `download`).
 * An unreadable body is simply absent evidence, which can only reduce deletions.
 */
async function readRetentionEvidence(
  config: BackupConfig,
  run: CommandRunner,
  objects: RemoteObject[],
  directory: string,
): Promise<{ evidence: RetentionEvidence; unreadable: number }> {
  const present = new Set(objects.map((o) => o.key));
  const evidence: RetentionEvidence = {};
  let unreadable = 0;
  let index = 0;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const read = async (key: string): Promise<string | undefined> => {
    const file = path.join(directory, `evidence-${index++}.json`);
    try {
      await run(config.verifyDownload ?? config.download, { source: remoteUri(config.destination, key), destination: file, object: key }, "verify_download");
      return await readFile(file, "utf8");
    } catch {
      unreadable += 1;
      return undefined;
    } finally {
      await rm(file, { force: true });
    }
  };
  for (const object of objects) {
    const key = object.key;
    const name = path.posix.basename(key);
    if (!name.startsWith(ARTIFACT_PREFIX) || unitKeyOf(key) !== key) continue;
    const hasVerified = present.has(`${key}${VERIFIED_SUFFIX}`);
    const hasRestore = present.has(`${key}${RESTORE_VERIFIED_SUFFIX}`);
    if (!present.has(`${key}${MANIFEST_SUFFIX}`) || (!hasVerified && !hasRestore)) continue;
    evidence[key] = {
      manifest: await read(`${key}${MANIFEST_SUFFIX}`),
      ...(hasVerified ? { verified: await read(`${key}${VERIFIED_SUFFIX}`) } : {}),
      ...(hasRestore ? { restoreVerified: await read(`${key}${RESTORE_VERIFIED_SUFFIX}`) } : {}),
    };
  }
  return { evidence, unreadable };
}

const planKeys = (plan: TierRetentionPlan): string => JSON.stringify(plan.delete.map((o) => o.key));

async function prune(
  config: BackupConfig,
  run: CommandRunner,
  now: Date,
  protectedArtifact: string,
  log: (entry: OperationLog) => void,
  runId: string,
  runDirectory: string,
): Promise<PruneResult> {
  const computePlan = async (): Promise<TierRetentionPlan & { unreadable: number }> => {
    const listing = await run(config.list, { destination: config.destination }, "list");
    const valid = parseListing(listing.stdout, log, runId);
    const { evidence, unreadable } = await readRetentionEvidence(config, run, valid, path.join(runDirectory, "retention"));
    const plan = planTierRetention(
      valid,
      now,
      config.tierPolicy ?? DEFAULT_TIER_POLICY,
      { retentionDays: config.retentionDays, minRetained: config.minRetainedBackups ?? DEFAULT_MIN_RETAINED_BACKUPS },
      { protectedArtifact, evidence },
    );
    return { ...plan, unreadable };
  };
  const plan = await computePlan();
  // AC7: counts per state per tier; alert event names only (never object keys).
  log({
    timestamp: new Date().toISOString(),
    level: plan.alerts.length ? "warn" : "info",
    operation: "backup",
    event: "retention_plan",
    runId,
    states: plan.states,
    deletions: plan.delete.length,
    protectedByGuard: plan.protectedByGuard,
    evidenceUnreadable: plan.unreadable,
    alerts: plan.alerts,
  });
  for (const alert of plan.alerts) await safeAlert(config, run, log, runId, "warning", alert);
  if (plan.delete.length > 0) {
    // S9: re-validate against a fresh listing immediately before any destructive step (and before the intent
    // record); abort the prune when the plan changed. Nothing has been deleted at this point.
    const fresh = await computePlan();
    if (planKeys(fresh) !== planKeys(plan)) {
      log({
        timestamp: new Date().toISOString(),
        level: "warn",
        operation: "backup",
        event: "prune_aborted_listing_changed",
        runId,
        deletionsPlanned: plan.delete.length,
        deletionsAfterRelist: fresh.delete.length,
      });
      return { deleted: 0, failed: 0, protectedByGuard: plan.protectedByGuard, stopped: false, manifestsPreserved: 0, verified: 0, accepted: 0, aborted: true };
    }
  }
  // D-3: an artifact and its manifest are ONE recoverability unit. Group the plan into units (artifact first)
  // and never touch a manifest unless its own artifact delete was confirmed in this run.
  const units = buildPruneUnits(plan.delete, protectedArtifact);
  if (units.length === 0) return { deleted: 0, failed: 0, protectedByGuard: plan.protectedByGuard, stopped: false, manifestsPreserved: 0, verified: 0, accepted: 0 };
  // Durable intent BEFORE any destructive operation. If it cannot be stored, nothing is deleted (fail closed).
  const recordPrefix = `deletion-records/${runId}`;
  await storeDeletionRecord(config, run, runDirectory, `${recordPrefix}.intent.json`, {
    version: 1,
    kind: "prune-intent",
    runId,
    createdAt: new Date().toISOString(),
    protectedArtifact,
    units: units.map((u) => ({ artifact: u.artifact?.key ?? null, manifest: u.manifest?.key ?? null, ...(u.markers.length ? { markers: u.markers.map((m) => m.key) } : {}) })),
  });
  const outcomes: PruneUnitOutcome[] = units.map((u) => ({ artifact: u.artifact?.key ?? null, manifest: u.manifest?.key ?? null, ...(u.markers.length ? { markers: u.markers.map((m) => m.key) } : {}), status: "not_attempted_pruning_stopped" }));
  let deleted = 0;
  const counters = { accepted: 0 };
  let failed = 0;
  let manifestsPreserved = 0;
  let verified = 0;
  let stopped = false;
  const fail = (object: string, error: unknown, event: string): void => {
    failed += 1;
    log({
      timestamp: new Date().toISOString(),
      level: "error",
      operation: "backup",
      event,
      runId,
      object,
      error: error instanceof Error ? error.message : String(error),
    });
  };
  // One delete. Returns true when the object counts as deleted; false after recording a refusal or an
  // unverified delete (the caller then stops pruning and sets the unit status).
  const attempt = async (key: string): Promise<{ ok: true } | { ok: false; notVerified: boolean }> => {
    try {
      await deleteObject(config, run, key, counters);
      deleted += 1;
      verified += 1;
      return { ok: true };
    } catch (error) {
      const notVerified = error instanceof DeleteNotVerifiedError;
      fail(key, error, notVerified ? "prune_delete_not_verified" : "prune_delete_failed");
      outcomes[currentIndex]!.error = sanitizeErrorText(error instanceof Error ? error.message : String(error));
      if (error instanceof DeleteNotVerifiedError) outcomes[currentIndex]!.verifierClass = error.verifierClass;
      return { ok: false, notVerified };
    }
  };
  let currentIndex = 0;
  for (let index = 0; index < units.length && !stopped; index += 1) {
    currentIndex = index;
    const unit = units[index]!;
    const outcome = outcomes[index]!;
    // Artifact first. Any throw (refused by Object Lock/retention, timeout, ambiguous) or an unverified delete
    // means the artifact may still exist, so its manifest MUST be preserved and pruning stops.
    if (unit.artifact) {
      const result = await attempt(unit.artifact.key);
      if (!result.ok) {
        outcome.status = result.notVerified ? "artifact_delete_not_verified_manifest_preserved" : "artifact_delete_failed_manifest_preserved";
        if (unit.manifest) manifestsPreserved += 1;
        stopped = true;
        break;
      }
    }
    if (unit.manifest) {
      const result = await attempt(unit.manifest.key);
      if (!result.ok) {
        outcome.status = result.notVerified ? "manifest_delete_not_verified_artifact_deleted" : "manifest_delete_failed_artifact_deleted";
        stopped = true;
        break;
      }
    }
    // Markers last: a marker left behind without its artifact is INVALID and never counted toward keep.
    for (const marker of unit.markers) {
      const result = await attempt(marker.key);
      if (!result.ok) {
        outcome.status = result.notVerified ? "marker_delete_not_verified_backup_deleted" : "marker_delete_failed_backup_deleted";
        stopped = true;
        break;
      }
    }
    if (stopped) break;
    outcome.status = "deleted_verified";
  }
  if (stopped) {
    log({
      timestamp: new Date().toISOString(),
      level: "error",
      operation: "backup",
      event: "prune_stopped",
      runId,
      deleted,
      failed,
      manifestsPreserved,
      unitsNotAttempted: outcomes.filter((o) => o.status === "not_attempted_pruning_stopped").length,
    });
  }
  // Outcome record after the last destructive operation. A failure to store it is itself a visible failure
  // (counted and logged) but cannot undo deletions that already happened; the intent record remains.
  try {
    await storeDeletionRecord(config, run, runDirectory, `${recordPrefix}.outcome.json`, {
      version: 2,
      kind: "prune-outcome",
      runId,
      completedAt: new Date().toISOString(),
      deleteVerification: "command",
      stopped,
      units: outcomes,
    });
  } catch (error) {
    fail(`${recordPrefix}.outcome.json`, error, "prune_outcome_record_failed");
  }
  return { deleted, failed, protectedByGuard: plan.protectedByGuard, stopped, manifestsPreserved, verified, accepted: counters.accepted, failureClasses: outcomes.flatMap((o) => (o.verifierClass ? [o.verifierClass] : [])) };
}

async function runStagingSweep(config: BackupConfig, log: (entry: OperationLog) => void, runId: string): Promise<void> {
  const mode = config.stagingSweep ?? "off";
  if (mode === "off") return;
  try {
    const report = await sweepStaging({
      stagingDirectory: config.stagingDirectory,
      mode,
      minAgeMs: (config.stagingSweepMinAgeHours ?? 24) * 3_600_000,
    });
    log({
      timestamp: new Date().toISOString(), level: "info", operation: "backup", event: "staging_sweep", runId,
      mode, counts: report.counts,
      ambiguous: report.entries.filter((e) => e.decision === "ambiguous").map((e) => `${e.name}: ${e.reason}`),
      artifactsRetained: report.entries.filter((e) => e.decision === "artifact_retained" || e.decision === "would_retain_artifact").map((e) => e.name),
    });
  } catch (error) {
    log({
      timestamp: new Date().toISOString(), level: "error", operation: "backup", event: "staging_sweep_failed", runId,
      mode, error: sanitizeErrorText(error instanceof Error ? error.message : String(error)),
    });
  }
}

export async function createBackup(config: BackupConfig, dependencies: EngineDependencies): Promise<string> {
  const now = dependencies.now?.() ?? new Date();
  const runId = randomBytes(8).toString("hex");
  const log = dependencies.log ?? defaultLog;
  const started = Date.now();
  const runDirectory = path.join(config.stagingDirectory, `backup-${runId}`);
  const name = artifactName(now);
  const artifact = path.join(runDirectory, name);
  let stage = "prepare";
  let stopHeartbeat: () => void = () => undefined;
  try {
    // D-5: optional stale-staging sweep BEFORE this run's own directory exists (off by default). Never fatal.
    await runStagingSweep(config, log, runId);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    await writeRunMarker(runDirectory, newRunMarker(runId, "backup", new Date()));
    stopHeartbeat = startHeartbeat(runDirectory);
    // Vault mode forbids pruning: refuse before doing any work rather than discover it at prune time.
    stage = "preflight";
    assertIsolationNotBypassed(config);
    if (config.vaultMode && config.prune === true) {
      throw new Error("Pruning is prohibited in vault mode (BACKUP_PRUNE must not be on)");
    }
    // D-9: pruning needs a configured, distinct verifier. Refuse before any pg_dump, upload, list or delete.
    assertDeleteVerifierForPrune(config);
    stage = "prepare";
    const dump = path.join(runDirectory, "database.dump");
    await dependencies.run({
      executable: "pg_dump",
      args: ["--format=custom", "--no-owner", "--no-privileges", "--file", dump, config.databaseUrl],
    }, undefined, "database");
    await chmod(dump, 0o600);
    // WS4-06: record the archive format version so a restore can refuse an unreadable archive before decrypting it.
    const dumpArchiveVersion = await readDumpArchiveVersion(dump);

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
    }, undefined, "archive");
    await chmod(payload, 0o600);
    await dependencies.run(config.encryption, { input: payload, output: artifact, kmsProfile: config.encryptionKmsProfile }, "encrypt");
    await chmod(artifact, 0o600);
    const manifest = await writeManifest(artifact, now.toISOString(), dumpArchiveVersion ? { dumpArchiveVersion } : {});
    await updateRunMarker(runDirectory, { state: "encrypted" });

    // Tiered layout is active when a tier policy is configured (the production loader always sets one):
    // the same bytes are written once per applicable tier (daily always, weekly on Sunday, monthly on the
    // 1st; UTC). A config without a tier policy keeps the original flat layout.
    stage = "tier_upload";
    const tiers: Tier[] = config.tierPolicy ? tiersFor(now) : [];
    const manifestName = path.basename(manifest);
    const targets = tiers.length
      ? tiers.map((tier) => ({ artifact: tierKey(tier, name), manifest: tierKey(tier, manifestName) }))
      : [{ artifact: name, manifest: manifestName }];
    for (const target of targets) {
      await dependencies.run(config.upload, {
        source: artifact,
        destination: remoteUri(config.destination, target.artifact),
        object: target.artifact,
      }, "upload");
      await dependencies.run(config.upload, {
        source: manifest,
        destination: remoteUri(config.destination, target.manifest),
        object: target.manifest,
      }, "upload");
    }
    // Never prune (or report success) on the strength of an upload command's exit code alone: every
    // tier copy is re-downloaded and verified BEFORE the first list/remove can run.
    stage = "verify";
    const verified = await verifyUploadedBackup(config, dependencies.run, runDirectory, targets, manifest);
    await updateRunMarker(runDirectory, { state: "uploaded_verified" });
    // R6 (RETENTION-SAFEGUARD-SPEC): the WRITER records, per tier copy, that the copy passed post-upload
    // verification. Only verified copies count toward retention; a failed marker PUT fails the run before any
    // list/delete (S8). Every copy was verified above, so a marker is written for each target.
    stage = "marker_write";
    const markerPath = `${artifact}${VERIFIED_SUFFIX}`;
    await writeFile(markerPath, verifiedMarkerBody(name, verified.sha256, new Date().toISOString()), { mode: 0o600 });
    for (const target of targets) {
      const object = `${target.artifact}${VERIFIED_SUFFIX}`;
      try {
        await dependencies.run(config.upload, { source: markerPath, destination: remoteUri(config.destination, object), object }, "upload");
      } catch (error) {
        throw new Error(`marker_write_failed: verified marker upload failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    stage = "prune";
    // D-2: default OFF. Only an explicit `true` may reach any list/delete operation.
    const pruneEnabled = config.prune === true;
    const pruneStatus = pruneEnabled ? "enabled" : config.pruneSource === "explicit" ? "disabled_explicit" : "disabled_default";
    log({
      timestamp: new Date().toISOString(),
      level: "info",
      operation: "backup",
      event: pruneEnabled ? "prune_enabled" : "prune_disabled",
      runId,
      pruneStatus,
      source: config.pruneSource ?? (config.prune === undefined ? "default" : "explicit"),
      message: pruneEnabled
        ? "pruning is ENABLED (BACKUP_PRUNE=on): expired backups will be deleted after verification, artifact first"
        : "pruning is DISABLED: no backup is listed or deleted by this run; set BACKUP_PRUNE=on to enable retention pruning (not valid with BACKUP_VAULT_MODE=true)",
    });
    const pruneResult = pruneEnabled
      ? await prune(config, dependencies.run, now, name, log, runId, runDirectory)
      : { deleted: 0, failed: 0, protectedByGuard: 0, stopped: false, manifestsPreserved: 0, verified: 0, accepted: 0, aborted: false };
    if (pruneResult.failed > 0) {
      await safeAlert(
        config,
        dependencies.run,
        log,
        runId,
        "prune_delete_refused",
        `prune_delete_refused: ${pruneResult.failed} delete(s) refused or not verified${pruneResult.failureClasses?.length ? ` (class: ${[...new Set(pruneResult.failureClasses)].join(",")})` : ""}`,
      );
    }
    log({
      timestamp: new Date().toISOString(),
      level: "info",
      operation: "backup",
      event: "completed",
      runId,
      artifact: name,
      documentSource: config.documentSource ?? "directory",
      documents: documentCount,
      tiersWritten: tiers,
      prune: pruneEnabled ? "on" : "off",
      pruneStatus,
      verified: true,
      verifiedBytes: verified.bytes,
      sha256: verified.sha256,
      // DEPRECATED alias of prunedVerified: counts ONLY deletions the verifier confirmed permanently absent (R19). It can
      // under-count but never over-count. deleteCommandsAccepted = delete commands that exited 0 (NOT proof of deletion).
      pruned: pruneResult.verified,
      prunedVerified: pruneResult.verified,
      deleteCommandsAccepted: pruneResult.accepted,
      pruneFailed: pruneResult.failed,
      pruneProtected: pruneResult.protectedByGuard,
      pruneStopped: pruneResult.stopped,
      manifestsPreserved: pruneResult.manifestsPreserved,
      pruneAborted: pruneResult.aborted === true,
      durationMs: Date.now() - started,
    });
    return name;
  } catch (error) {
    // Local log keeps the full text with credentials redacted (CLI-SPEC §3, R29b); the alert carries only a fixed
    // reason code. The alert is attempted first so the failed record can say whether it was delivered.
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    const reason =
      error instanceof PruneListUnexpectedError
        ? `prune_list_unexpected: listing had ${error.listed} entries, ${error.recognised} recognised${error.recognised > 0 ? `, ${error.unrecognisedBackupLike} backup-named unrecognised` : ""}`
        : (ALERT_REASONS[stage] ?? "backup_failed: backup failed");
    const alertDelivered = await safeAlert(config, dependencies.run, log, runId, "failed", reason);
    log({
      timestamp: new Date().toISOString(),
      level: "error",
      operation: "backup",
      event: "failed",
      runId,
      stage,
      error: message,
      alertDelivered,
      durationMs: Date.now() - started,
    });
    throw error;
  } finally {
    stopHeartbeat();
    await safeRemoveRunDirectory(runDirectory);
  }
}

export interface RestoreRequest {
  artifact: string;
  confirmDisposable: boolean;
  /** Tier folder to restore from. Omitted = legacy flat layout (backups written before tiering). */
  tier?: Tier;
}

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

/** Fail closed: when isolation is required the config must carry a policy (so the scoped runner is used). */
function assertIsolationNotBypassed(config: BackupConfig): void {
  if (config.envIsolationRequired && !config.envIsolation) {
    throw new Error("Environment isolation is required (BACKUP_ENV_ISOLATION_REQUIRED=true) but no isolation policy is configured; refusing to run any command");
  }
}

export async function restoreBackup(
  config: BackupConfig,
  request: RestoreRequest,
  dependencies: EngineDependencies,
): Promise<void> {
  assertIsolationNotBypassed(config);
  if (!request.confirmDisposable) throw new Error("Restore requires explicit disposable-database confirmation");
  if (databaseIdentity(config.restoreDatabaseUrl) === databaseIdentity(config.databaseUrl)) {
    throw new Error("Refusing restore because configured source and target database identities are equivalent");
  }
  // Independent of CLI validation: only an absent tier (legacy flat layout) or an exact allowlisted tier is accepted.
  if (request.tier !== undefined && !isTier(request.tier)) throw new Error("Restore tier must be daily, weekly or monthly");
  const name = safeRemoteArtifact(request.artifact);
  const runId = randomBytes(8).toString("hex");
  const log = dependencies.log ?? defaultLog;
  const started = Date.now();
  const runDirectory = path.join(config.stagingDirectory, `restore-${runId}`);
  let stage = "prepare";
  let stopHeartbeat: () => void = () => undefined;
  try {
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    await writeRunMarker(runDirectory, newRunMarker(runId, "restore", new Date()));
    stopHeartbeat = startHeartbeat(runDirectory);
    const artifact = path.join(runDirectory, name);
    const manifest = `${artifact}.sha256.json`;
    const remoteName = request.tier !== undefined ? tierKey(request.tier, name) : name;
    const manifestKey = `${remoteName}.sha256.json`;
    const tierHint = request.tier !== undefined
      ? ` from the "${request.tier}" tier. Check that the artifact name is correct and was written to that tier (--tier=${request.tier}); the manifest lives inside the tier folder, so a different tier or omitting --tier (legacy flat layout) will not find it`
      : " (missing or unreachable)";
    // WS4-10 (1/3): the small integrity manifest is downloaded FIRST, so a missing, unreadable or incompatible backup
    // is refused before the (large) dump is ever requested. Fail closed with a clear message.
    stage = "manifest_download";
    try {
      await dependencies.run(config.restoreDownload ?? config.download, {
        source: remoteUri(config.destination, manifestKey),
        destination: manifest,
        object: manifestKey,
      }, "restore_download");
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new ManifestUnavailableError(
        "missing",
        `Restore aborted before downloading the dump: the integrity manifest "${manifestKey}" could not be downloaded${tierHint}. Underlying error: ${cause}`,
        { cause: error },
      );
    }
    stage = "manifest_check";
    let manifestBody: string;
    try {
      manifestBody = await readFile(manifest, "utf8");
    } catch (error) {
      throw new ManifestUnavailableError(
        "missing",
        `Restore aborted before downloading the dump: the integrity manifest "${manifestKey}" could not be downloaded${tierHint}. Underlying error: the download command wrote no file`,
        { cause: error },
      );
    }
    let earlyManifest: ArtifactManifest;
    try {
      earlyManifest = parseManifest(manifestBody, name);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new ManifestUnavailableError(
        "unreadable",
        `Restore aborted before downloading the dump: the integrity manifest "${manifestKey}" is unreadable (${cause}). Nothing was downloaded beyond the manifest.`,
        { cause: error },
      );
    }
    // WS4-10 (2/3) = WS4-06 (1/2): refuse an archive newer than this pg_restore BEFORE the dump download.
    if (dependencies.pgRestoreMajor !== undefined) {
      if (typeof earlyManifest.dumpArchiveVersion === "string") {
        stage = "archive_version_check";
        assertArchiveReadable(earlyManifest.dumpArchiveVersion, dependencies.pgRestoreMajor, "manifest");
      } else {
        // Legacy (pre-WS4-06) manifest: the early check cannot run; the dump header is still checked before pg_restore.
        log({
          timestamp: new Date().toISOString(),
          level: "warn",
          operation: "restore",
          event: "manifest_without_archive_version",
          runId,
          artifact: name,
          detail: "manifest records no dumpArchiveVersion; the dump will be downloaded and its header checked before pg_restore",
        });
      }
    }
    // WS4-10 (3/3): only now download the dump artifact.
    stage = "download";
    try {
      await dependencies.run(config.restoreDownload ?? config.download, {
        source: remoteUri(config.destination, remoteName),
        destination: artifact,
        object: remoteName,
      }, "restore_download");
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      if (request.tier === undefined) throw error; // no-tier artifact download error is propagated unchanged
      throw new Error(
        `Restore could not download the artifact from the "${request.tier}" tier (its manifest was found there). Underlying error: ${cause}`,
        { cause: error },
      );
    }
    stage = "verify";
    // Integrity: the downloaded dump must match the SAME manifest file checked above (sha256 + byte length).
    await verifyManifest(artifact, manifest);
    stage = "decrypt_and_restore";
    const payload = path.join(runDirectory, "payload.tar");
    await dependencies.run(config.decryption, { input: artifact, output: payload, kmsProfile: config.encryptionKmsProfile }, "decrypt");
    await assertRestoreTargetIsEmpty(dependencies.run, config.restoreDatabaseUrl, "restore_database");
    await dependencies.run({
      executable: "tar",
      args: ["--extract", "--file", payload, "--directory", runDirectory],
    }, undefined, "archive");
    const expected = JSON.parse(await readFile(path.join(runDirectory, "inventory.json"), "utf8")) as DatabaseInventory;
    // WS4-06 (2/2): always re-read the real dump header (legacy manifests carry no version) before pg_restore runs.
    if (dependencies.pgRestoreMajor !== undefined) {
      stage = "archive_version_check";
      const headerVersion = await readDumpArchiveVersion(path.join(runDirectory, "database.dump"));
      if (!headerVersion) {
        throw new DumpArchiveIncompatibleError("archive unreadable", "a pg_dump custom-format archive (PGDMP header)", "header");
      }
      assertArchiveReadable(headerVersion, dependencies.pgRestoreMajor, "header");
      stage = "decrypt_and_restore";
    }
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
    }, undefined, "restore_database");
    const actual = await readDatabaseInventory(dependencies.run, config.restoreDatabaseUrl, "restore_database");
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
    }, undefined, "archive");
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
    // Local log keeps the full text with credentials redacted (R29b); the alert carries only a fixed reason code and
    // stage, and is attempted first so the failed record can say whether it was delivered.
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    let alertDelivered = false;
    try {
      await notify(config, dependencies.run, {
        operation: "restore",
        status: "failed",
        error: `restore_failed: restore failed during ${stage}`,
        runId,
      });
      alertDelivered = true;
    } catch (alertError) {
      log({
        timestamp: new Date().toISOString(),
        level: "error",
        operation: "restore",
        event: "alert_failed",
        runId,
        error: sanitizeErrorText(alertError instanceof Error ? alertError.message : String(alertError)),
      });
    }
    log({
      timestamp: new Date().toISOString(),
      level: "error",
      operation: "restore",
      event: "failed",
      runId,
      stage,
      error: message,
      alertDelivered,
      durationMs: Date.now() - started,
    });
    throw error;
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
}