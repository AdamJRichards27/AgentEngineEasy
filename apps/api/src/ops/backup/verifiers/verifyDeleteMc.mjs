#!/usr/bin/env node
// PH-7 D-9 version-aware delete verifier (command adapter, plain Node: no tsx, no provider SDK).
//
// Contract with the backup engine (BACKUP_DELETE_VERIFY_COMMAND):
//   node verifyDeleteMc.mjs [--mc <mc binary>] [--alias <mc alias>] <s3://bucket/key>
//   stdout: ONE JSON line {"verifier":"mc-version-aware/1","class":"<class>","verified":<bool>,...}
//   stderr: "verify_class=<class>" on every outcome (the engine reads it when the exit code is non-zero)
//   exit:   0 ONLY for class "absent". Everything else is non-zero and means NOT verified.
// The engine independently requires exit 0 AND stdout {"class":"absent","verified":true}; anything else
// (empty output, malformed JSON, another class) is treated as not verified.
//
// Classes (exit code): absent (0) | delete_marker_retained (10) | versions_retained (11) | governance_locked (12) |
// compliance_locked (13) | access_denied_or_incomplete (20) | inconclusive (30) | usage error (2).
// "versions_retained" is the one class beyond the six required: data versions remain with neither a delete marker
// nor a lock (e.g. the delete command did nothing). It is also NOT verified.
// Read-only: only `mc ls --versions`, `mc retention info` and `mc legalhold info` are run. Validated against
// local MinIO only; it makes no claim about AWS S3 behaviour.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export const VERIFIER_ID = "mc-version-aware/1";
export const EXIT_CODES = Object.freeze({
  absent: 0,
  delete_marker_retained: 10,
  versions_retained: 11,
  governance_locked: 12,
  compliance_locked: 13,
  access_denied_or_incomplete: 20,
  inconclusive: 30,
});
const DENIED = /AccessDenied|Access Denied|Forbidden|\b403\b|not authorized|InvalidAccessKeyId|SignatureDoesNotMatch|ExpiredToken/i;
const NO_LOCK = /ObjectLockConfigurationNotFound|NoSuchObjectLockConfiguration|object lock configuration does not exist|does not have (?:a )?(?:retention|object lock)|no (?:retention|legal ?hold|object lock)|not set|bucket is missing Object Lock|does not support locking|lock needs to be enabled/i;

/**
 * Pure classification. Input is provider-neutral:
 *   listing: { complete: boolean, error?: { message: string }, entries: [{ versionId, isDeleteMarker }] } (exact key only)
 *   locks:   { [versionId]: { status: "ok"|"denied"|"error", mode?: "GOVERNANCE"|"COMPLIANCE"|null, until?: ISO, legalHold?: boolean, message?: string } }
 * Only the "absent" result qualifies as verified permanent deletion.
 */
export function classify({ listing, locks = {}, now = new Date() }) {
  const result = (cls, detail, extra = {}) => ({ class: cls, verified: cls === "absent", exitCode: EXIT_CODES[cls], detail, ...extra });
  if (!listing || typeof listing !== "object") return result("inconclusive", "no listing result");
  if (listing.error) {
    return DENIED.test(listing.error.message ?? "")
      ? result("access_denied_or_incomplete", "listing refused: permission denied")
      : result("inconclusive", `listing failed: ${String(listing.error.message ?? "unknown").slice(0, 200)}`);
  }
  if (listing.complete !== true) return result("access_denied_or_incomplete", "listing is truncated or incomplete; absence cannot be established");
  if (!Array.isArray(listing.entries)) return result("inconclusive", "listing entries missing");
  const entries = listing.entries;
  const markers = entries.filter((e) => e.isDeleteMarker === true).length;
  const versions = entries.length - markers;
  const counts = { versions, deleteMarkers: markers };
  if (entries.length === 0) return result("absent", "no version and no delete marker remains", counts);
  // Something is retained. Establish why (locks) so the operator gets an actionable class.
  let governance = 0;
  let compliance = 0;
  let legalHold = 0;
  for (const entry of entries) {
    if (entry.isDeleteMarker === true) continue;
    const lock = locks[entry.versionId];
    if (!lock) return result("inconclusive", `lock state of retained version ${entry.versionId} was not determined`, counts);
    if (lock.status === "denied") return result("access_denied_or_incomplete", `lock state of version ${entry.versionId} unreadable: permission denied`, counts);
    if (lock.status !== "ok") return result("inconclusive", `lock state of version ${entry.versionId} inconclusive: ${String(lock.message ?? "").slice(0, 160)}`, counts);
    const until = lock.until ? new Date(lock.until) : undefined;
    if (lock.mode && until !== undefined && Number.isNaN(until.getTime())) return result("inconclusive", "retention date malformed", counts);
    const active = lock.mode && (until === undefined || until > now);
    if (active && lock.mode === "COMPLIANCE") compliance += 1;
    else if (active && lock.mode === "GOVERNANCE") governance += 1;
    else if (lock.mode && lock.mode !== "COMPLIANCE" && lock.mode !== "GOVERNANCE") return result("inconclusive", `unknown retention mode ${String(lock.mode).slice(0, 20)}`, counts);
    if (lock.legalHold === true) legalHold += 1;
  }
  const flags = { governanceLockedVersions: governance, complianceLockedVersions: compliance, legalHoldVersions: legalHold, ...counts };
  if (compliance > 0) return result("compliance_locked", `${compliance} version(s) under an active COMPLIANCE lock; cannot be deleted before expiry`, flags);
  if (governance > 0) return result("governance_locked", `${governance} version(s) under an active GOVERNANCE lock; needs bypass permission or expiry`, flags);
  if (markers > 0) return result("delete_marker_retained", `${markers} delete marker(s) and ${versions} version(s) retained: the object is hidden, not deleted`, flags);
  return result("versions_retained", `${versions} version(s) retained${legalHold > 0 ? ` (${legalHold} under legal hold)` : ""}`, flags);
}

function runMc(bin, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr), spawnError: error && typeof error.code === "string" ? error.code : undefined });
    });
  });
}

function parseLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { return undefined; }
  }
  return out;
}
const errMessage = (obj) => [obj?.error?.message, obj?.error?.cause?.message, obj?.error?.cause?.error?.Code].filter(Boolean).join(": ");

/** mc `ls --versions` for the exact key. A stream error line, parse failure or non-zero exit is NOT a complete listing. */
export async function listExactKey(bin, target) {
  const slash = target.lastIndexOf("/");
  const base = target.slice(slash + 1);
  const res = await runMc(bin, ["ls", "--versions", "--json", target]);
  const lines = parseLines(res.stdout);
  if (lines === undefined) return { complete: false, error: { message: `unparseable listing output: ${res.stderr.slice(0, 120)}` }, entries: [] };
  const errorLine = lines.find((l) => l.status === "error");
  if (errorLine) return { complete: false, error: { message: errMessage(errorLine) || "listing error" }, entries: [] };
  if (!res.ok) return { complete: false, error: { message: res.stderr.slice(0, 200) || `mc exited ${res.code}` }, entries: [] };
  const entries = lines.filter((l) => l.status === "success" && l.key === base).map((l) => ({ versionId: l.versionId ?? "null", isDeleteMarker: l.isDeleteMarker === true }));
  return { complete: true, entries };
}

async function lockFor(bin, target, versionId) {
  const vid = versionId === "null" ? [] : ["--version-id", versionId];
  const ret = await runMc(bin, ["retention", "info", "--json", ...vid, target]);
  const retLines = parseLines(ret.stdout);
  const retObj = retLines?.[0];
  let mode = null;
  let until;
  if (retLines === undefined || (!ret.ok && !retObj)) {
    if (DENIED.test(ret.stderr)) return { status: "denied" };
    if (NO_LOCK.test(ret.stderr)) { /* no lock configured */ } else return { status: "error", message: ret.stderr || "retention output unparseable" };
  } else if (retObj.status === "error" || retObj.error) {
    const message = errMessage(retObj) || JSON.stringify(retObj.error ?? "");
    if (DENIED.test(message)) return { status: "denied" };
    if (!NO_LOCK.test(message)) return { status: "error", message };
  } else if (retObj.mode) {
    mode = String(retObj.mode).toUpperCase();
    until = retObj.until;
  }
  const lh = await runMc(bin, ["legalhold", "info", "--json", ...vid, target]);
  const lhObj = parseLines(lh.stdout)?.[0];
  let legalHold = false;
  if (!lhObj || lhObj.status === "error") {
    const message = lhObj ? errMessage(lhObj) : lh.stderr;
    if (DENIED.test(message)) return { status: "denied" };
    if (!NO_LOCK.test(message)) return { status: "error", message: message || "legal hold output unparseable" };
  } else legalHold = String(lhObj.legalhold ?? "").toUpperCase() === "ON";
  return { status: "ok", mode, ...(until ? { until } : {}), legalHold };
}

export async function verifyWithMc({ mc = "mc", alias, remote, now = new Date() }) {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(remote ?? "");
  if (!m || !alias) throw new Error("usage: verifyDeleteMc.mjs [--mc BIN] --alias ALIAS s3://bucket/key");
  const target = `${alias}/${m[1]}/${m[2]}`;
  const listing = await listExactKey(mc, target);
  const locks = {};
  if (listing.complete) {
    for (const entry of listing.entries) {
      if (!entry.isDeleteMarker) locks[entry.versionId] = await lockFor(mc, target, entry.versionId);
    }
  }
  return classify({ listing, locks, now });
}

async function main(argv) {
  let mc = "mc";
  let alias;
  let remote;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--mc") mc = argv[++i];
    else if (argv[i] === "--alias") alias = argv[++i];
    else remote = argv[i];
  }
  let out;
  try {
    out = await verifyWithMc({ mc, alias, remote });
  } catch (error) {
    process.stderr.write(`usage error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ verifier: VERIFIER_ID, class: out.class, verified: out.verified, object: remote, detail: out.detail, versions: out.versions, deleteMarkers: out.deleteMarkers }) + "\n");
  process.stderr.write(`verify_class=${out.class} ${out.detail}\n`);
  process.exit(out.exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2));
