#!/usr/bin/env node
// PH-7 D-9 / R22: AWS S3 version-aware delete verifier (command adapter, plain Node: no tsx, no SDK, no repo dependency).
//
// Contract with the backup engine (BACKUP_DELETE_VERIFY_COMMAND) - IDENTICAL to verifyDeleteMc.mjs:
//   node verifyDeleteS3.mjs --aws <abs path> --expected-aws-version aws-cli/X.Y.Z --aws-sha256 <hex>
//        --bucket B --region R [--endpoint-url E] [--expected-owner 123456789012] [--page-size N] [--max-pages N] s3://B/<key>
//   stdout: ONE JSON line {"verifier":"s3api-version-aware/1","class":...,"verified":<bool>,"object","detail","versions","deleteMarkers","pages","region","endpoint","awsCli"}
//   stderr: "verify_class=<class> <detail>" on every verdict.   exit: 0 ONLY for class "absent"; usage error 2.
//   absent 0 | delete_marker_retained 10 | versions_retained 11 | governance_locked 12 | compliance_locked 13 |
//   access_denied_or_incomplete 20 | inconclusive 30. The engine independently requires exit 0 AND {"class":"absent","verified":true}.
//
// READ-ONLY BY CONSTRUCTION. The only AWS CLI commands this file can spawn are in ALLOWED_SUBCOMMANDS:
//   `aws s3api list-object-versions | get-object-retention | get-object-legal-hold | get-object-lock-configuration`.
// buildAwsArgv() rejects any other subcommand and any flag outside a per-subcommand allowlist (no bypass flag, no profile, no
// endpoint override, no CLI-input files) BEFORE a process is spawned. No shell is used (execFile with an argv array).
//
// PINNED CLI INTEGRITY (nothing is downloaded here). Before any s3api call the verifier requires, as arguments:
//   --aws <absolute path>, --expected-aws-version aws-cli/X.Y.Z, --aws-sha256 <64 hex>. It then (1) resolves symlinks,
//   (2) refuses a binary that is not a regular executable or is writable by group/other, (3) streams the file through SHA-256 and
//   compares with the pin, (4) runs `aws --version` and compares the first token EXACTLY with the pin. Any mismatch is a fail-closed
//   verdict (class inconclusive, detail "aws_cli_integrity: ..."), and no s3api command is run. Limits: the hash covers the
//   executable file only (the AWS CLI v2 bundle also has a dist/ directory of libraries); the install directory must be
//   root-owned and read-only (see docs). A hash check and exec are not atomic (TOCTOU) unless the directory is not writable.
//
// ISOLATION. The child gets a minimal environment: PATH=/usr/bin:/bin, the three short-lived credential variables from THIS
// process (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN), AWS_DEFAULT_REGION, and empty config/credentials
// files, IMDS disabled. AWS_PROFILE, role/web-identity variables, HOME and AWS_ENDPOINT_URL are never forwarded: no default
// profile fallback. Region is limited to ALLOWED_REGIONS; the endpoint must be the exact regional S3 endpoint or a loopback
// address (local fixtures). Real AWS use requires --expected-owner. Secrets are never printed.
//
// Errors are classified from the structured AWS error CODE ("An error occurred (<Code>) when calling the <Op> operation"),
// never from free message text, and only when the operation name matches the call made.
// Validated ONLY against a fake `aws` fixture. It makes no claim about real AWS S3 behaviour until the Stage A calibration.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CODES, classify } from "./classifyVersions.mjs";

export { EXIT_CODES, classify };
export const VERIFIER_ID = "s3api-version-aware/1";
export const ALLOWED_REGIONS = Object.freeze(["ap-southeast-4", "ap-southeast-2"]);
export const ALLOWED_SUBCOMMANDS = Object.freeze(new Set(["list-object-versions", "get-object-retention", "get-object-legal-hold", "get-object-lock-configuration"]));
// Per-subcommand flag allowlist: flag -> takes a value. Anything else (including every bypass flag) is rejected.
const ALLOWED_FLAGS = Object.freeze({
  "list-object-versions": { "--prefix": true, "--max-keys": true, "--no-paginate": false, "--key-marker": true, "--version-id-marker": true },
  "get-object-retention": { "--key": true, "--version-id": true },
  "get-object-legal-hold": { "--key": true, "--version-id": true },
  "get-object-lock-configuration": {},
});
const OPERATION = Object.freeze({ "list-object-versions": "ListObjectVersions", "get-object-retention": "GetObjectRetention", "get-object-legal-hold": "GetObjectLegalHold", "get-object-lock-configuration": "GetObjectLockConfiguration" });
const DENIED_CODES = new Set(["AccessDenied", "AllAccessDisabled", "InvalidAccessKeyId", "SignatureDoesNotMatch", "ExpiredToken", "InvalidToken", "TokenRefreshRequired", "AccountProblem", "NotSignedUp", "Forbidden"]);
const KEY_RE = /^[A-Za-z0-9/._=-]{1,1024}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const CALL_TIMEOUT_MS = 60_000;

export class UsageError extends Error {}
export class IntegrityError extends Error {}

export function resolveEndpoint(region, endpoint) {
  if (!ALLOWED_REGIONS.includes(region)) throw new UsageError(`region ${JSON.stringify(String(region).slice(0, 40))} is not allowed (allowed: ${ALLOWED_REGIONS.join(", ")})`);
  const regional = `https://s3.${region}.amazonaws.com`;
  if (endpoint === undefined) return regional;
  if (endpoint === regional) return regional;
  let url;
  try { url = new URL(endpoint); } catch { throw new UsageError("endpoint is not a valid URL"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol === "http:" || url.protocol === "https:") && loopback && !url.username && !url.password && (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash) return `${url.protocol}//${url.host}`;
  throw new UsageError(`endpoint must be exactly ${regional} or a loopback address`);
}
const isLoopback = (endpoint) => /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(endpoint);

export function parseArgs(argv) {
  const valued = ["--aws", "--expected-aws-version", "--aws-sha256", "--bucket", "--region", "--endpoint-url", "--expected-owner", "--page-size", "--max-pages"];
  const given = {};
  let remote;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (!valued.includes(a)) throw new UsageError(`unknown option ${a.slice(0, 40)}`);
      if (a in given) throw new UsageError(`${a} was given more than once`);
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      given[a] = argv[++i];
    } else if (remote === undefined) remote = a;
    else throw new UsageError("exactly one s3://bucket/key argument is required");
  }
  for (const required of ["--aws", "--expected-aws-version", "--aws-sha256", "--bucket", "--region"]) if (given[required] === undefined) throw new UsageError(`${required} is required`);
  if (!path.isAbsolute(given["--aws"])) throw new UsageError("--aws must be an absolute path (no PATH lookup)");
  if (!/^aws-cli\/\d+\.\d+\.\d+$/.test(given["--expected-aws-version"])) throw new UsageError("--expected-aws-version must look like aws-cli/2.15.30");
  if (!/^[0-9a-fA-F]{64}$/.test(given["--aws-sha256"])) throw new UsageError("--aws-sha256 must be 64 hex characters");
  if (!BUCKET_RE.test(given["--bucket"])) throw new UsageError("--bucket is not a valid bucket name");
  const endpoint = resolveEndpoint(given["--region"], given["--endpoint-url"]);
  const owner = given["--expected-owner"];
  if (owner !== undefined && !/^\d{12}$/.test(owner)) throw new UsageError("--expected-owner must be a 12-digit AWS account id");
  if (owner === undefined && !isLoopback(endpoint)) throw new UsageError("--expected-owner is required for a real AWS endpoint");
  const intArg = (name, def, max) => {
    if (given[name] === undefined) return def;
    if (!/^\d+$/.test(given[name]) || Number(given[name]) < 1 || Number(given[name]) > max) throw new UsageError(`${name} must be an integer 1..${max}`);
    return Number(given[name]);
  };
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(remote ?? "");
  if (!m) throw new UsageError("usage: verifyDeleteS3.mjs [options] s3://bucket/key");
  if (m[1] !== given["--bucket"]) throw new UsageError("the bucket in the s3:// URI must equal --bucket");
  if (!KEY_RE.test(m[2])) throw new UsageError("key contains characters outside [A-Za-z0-9/._=-] or is too long");
  return {
    aws: given["--aws"], expectedVersion: given["--expected-aws-version"], sha256: given["--aws-sha256"].toLowerCase(), bucket: m[1], region: given["--region"], endpoint,
    ...(owner ? { owner } : {}), pageSize: intArg("--page-size", 1000, 1000), maxPages: intArg("--max-pages", 100, 1000), key: m[2], remote,
  };
}

/** The only place an AWS CLI argv is built. Rejects anything outside the read-only allowlist before any spawn. */
export function buildAwsArgv(sub, { region, endpoint, bucket, owner, extra = [] }) {
  if (typeof sub !== "string" || !ALLOWED_SUBCOMMANDS.has(sub)) throw new UsageError(`aws s3api subcommand ${JSON.stringify(String(sub).slice(0, 40))} is not allowed (read-only allowlist)`);
  const flags = ALLOWED_FLAGS[sub];
  const ep = resolveEndpoint(region, endpoint);
  if (!BUCKET_RE.test(bucket ?? "")) throw new UsageError("invalid bucket");
  const tail = [];
  for (let i = 0; i < extra.length; i += 1) {
    const flag = extra[i];
    if (!Object.prototype.hasOwnProperty.call(flags, flag)) throw new UsageError(`flag ${JSON.stringify(String(flag).slice(0, 40))} is not allowed for ${sub} (flag allowlist)`);
    tail.push(flag);
    if (flags[flag]) {
      const value = extra[++i];
      if (typeof value !== "string" || value === "" || value.startsWith("-")) throw new UsageError(`flag ${flag} needs a plain value`);
      tail.push(value);
    }
  }
  return ["s3api", sub, "--bucket", bucket, ...tail, "--region", region, "--endpoint-url", ep, ...(owner ? ["--expected-bucket-owner", owner] : []), "--output", "json", "--no-cli-pager"];
}

function childEnv(region) {
  const env = { PATH: "/usr/bin:/bin", AWS_DEFAULT_REGION: region, AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null", AWS_EC2_METADATA_DISABLED: "true", AWS_PAGER: "" };
  for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) if (process.env[name]) env[name] = process.env[name];
  return env;
}

function exec(bin, args, region) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: CALL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: childEnv(region), shell: false }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr), timedOut: Boolean(error && (error.killed || error.signal === "SIGTERM")) });
    });
  });
}

export async function runAws({ aws, sub, params }) {
  const argv = buildAwsArgv(sub, params); // throws before any process exists
  return exec(aws, argv, params.region);
}

export async function verifyAwsCli({ aws, expectedVersion, sha256 }) {
  let real;
  try {
    real = await realpath(aws);
    const st = await stat(real);
    if (!st.isFile()) throw new IntegrityError("aws_cli_integrity: binary is not a regular file");
    if ((st.mode & 0o111) === 0) throw new IntegrityError("aws_cli_integrity: binary is not executable");
    if ((st.mode & 0o022) !== 0) throw new IntegrityError("aws_cli_integrity: binary is writable by group or other");
  } catch (error) {
    if (error instanceof IntegrityError) throw error;
    throw new IntegrityError("aws_cli_integrity: binary cannot be inspected");
  }
  const actual = await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(real).on("data", (c) => hash.update(c)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  }).catch(() => undefined);
  if (actual !== sha256.toLowerCase()) throw new IntegrityError("aws_cli_integrity: binary sha256 does not match the pinned hash");
  const v = await exec(real, ["--version"], "ap-southeast-4");
  const token = (v.stdout || v.stderr).trim().split(/\s+/)[0];
  if (v.code !== 0 || token !== expectedVersion) throw new IntegrityError("aws_cli_integrity: reported version does not match the pinned version");
  return token;
}

/** Structured error code from the AWS CLI's stderr, only if it names the operation we called. */
function awsErrorCode(stderr, sub) {
  const m = /An error occurred \(([A-Za-z0-9_.]+)\) when calling the ([A-Za-z0-9]+) operation/.exec(stderr);
  return m && m[2] === OPERATION[sub] ? m[1] : undefined;
}
function describeFailure(res, sub) {
  if (res.timedOut) return { code: undefined, denied: false, message: "aws call timed out" };
  const code = awsErrorCode(res.stderr, sub);
  if (!code) return { code: undefined, denied: false, message: `aws exited ${res.code} without a recognised error code` };
  return { code, denied: DENIED_CODES.has(code), message: DENIED_CODES.has(code) ? `permission denied (code ${code})` : `aws error code ${code}` };
}
function parseJson(text) { try { return JSON.parse(text); } catch { return undefined; } }
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads EVERY page of list-object-versions for the exact key. Anything not provably complete is not complete. */
async function listExactKey(cfg) {
  const entries = [];
  const seenIds = new Set();
  const seenMarkers = new Set();
  let keyMarker;
  let versionMarker;
  for (let pages = 1; pages <= cfg.maxPages; pages += 1) {
    const extra = ["--prefix", cfg.key, "--max-keys", String(cfg.pageSize), "--no-paginate"];
    if (keyMarker !== undefined) extra.push("--key-marker", keyMarker, "--version-id-marker", versionMarker);
    const res = await runAws({ aws: cfg.aws, sub: "list-object-versions", params: { region: cfg.region, endpoint: cfg.endpoint, bucket: cfg.bucket, owner: cfg.owner, extra } });
    if (res.code !== 0) { const f = describeFailure(res, "list-object-versions"); return { complete: false, error: { message: f.message, denied: f.denied }, entries: [], pages }; }
    const body = parseJson(res.stdout);
    const bad = (message) => ({ complete: false, error: { message, denied: false }, entries: [], pages });
    if (!isObj(body)) return bad("listing response is not a JSON object");
    if (body.Name !== cfg.bucket) return bad("listing response Name does not match the bucket");
    if (body.Prefix !== cfg.key) return bad("listing response Prefix does not match the requested key");
    for (const field of ["Versions", "DeleteMarkers"]) {
      if (body[field] === undefined) continue;
      if (!Array.isArray(body[field])) return bad(`listing response ${field} is not an array`);
      for (const e of body[field]) {
        if (!isObj(e) || typeof e.Key !== "string" || typeof e.VersionId !== "string" || e.VersionId === "") return bad(`listing response has a malformed ${field} entry`);
        if (e.Key !== cfg.key) continue; // prefix siblings are not the object
        if (seenIds.has(e.VersionId)) return bad("listing response repeats a version id");
        seenIds.add(e.VersionId);
        entries.push({ versionId: e.VersionId, isDeleteMarker: field === "DeleteMarkers" });
      }
    }
    const incomplete = { complete: false, entries, pages };
    if (typeof body.IsTruncated !== "boolean") return incomplete;
    if (body.NextToken !== undefined) return incomplete;
    if (!body.IsTruncated) { entries.sort((a, b) => (a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0)); return { complete: true, entries, pages }; }
    if (typeof body.NextKeyMarker !== "string" || body.NextKeyMarker === "" || typeof body.NextVersionIdMarker !== "string" || body.NextVersionIdMarker === "") return incomplete;
    const pair = `${body.NextKeyMarker}\0${body.NextVersionIdMarker}`;
    if (seenMarkers.has(pair)) return incomplete; // loop guard
    seenMarkers.add(pair);
    keyMarker = body.NextKeyMarker;
    versionMarker = body.NextVersionIdMarker;
  }
  return { complete: false, entries, pages: cfg.maxPages }; // page cap reached while still truncated
}

async function bucketLockState(cfg) {
  const res = await runAws({ aws: cfg.aws, sub: "get-object-lock-configuration", params: { region: cfg.region, endpoint: cfg.endpoint, bucket: cfg.bucket, owner: cfg.owner } });
  if (res.code !== 0) {
    const f = describeFailure(res, "get-object-lock-configuration");
    if (f.code === "ObjectLockConfigurationNotFoundError") return { kind: "none" };
    return f.denied ? { kind: "denied" } : { kind: "error", message: f.message };
  }
  const body = parseJson(res.stdout);
  if (isObj(body) && isObj(body.ObjectLockConfiguration) && body.ObjectLockConfiguration.ObjectLockEnabled === "Enabled") return { kind: "enabled" };
  return { kind: "error", message: "object lock configuration response is not Enabled or is malformed" };
}

async function lockFor(cfg, versionId) {
  const common = { region: cfg.region, endpoint: cfg.endpoint, bucket: cfg.bucket, owner: cfg.owner };
  const ref = ["--key", cfg.key, "--version-id", versionId];
  const r = await runAws({ aws: cfg.aws, sub: "get-object-retention", params: { ...common, extra: ref } });
  let mode = null;
  let until;
  if (r.code !== 0) {
    const f = describeFailure(r, "get-object-retention");
    if (f.denied) return { status: "denied" };
    if (f.code !== "NoSuchObjectLockConfiguration") return { status: "error", message: f.message };
  } else {
    const body = parseJson(r.stdout);
    const ret = isObj(body) ? body.Retention : undefined;
    if (!isObj(ret) || typeof ret.Mode !== "string" || ret.Mode === "") return { status: "error", message: "retention response malformed" };
    if (typeof ret.RetainUntilDate !== "string" || Number.isNaN(new Date(ret.RetainUntilDate).getTime())) return { status: "error", message: "retention date missing or malformed" };
    const event = ret.EventHold ?? body.EventHold;
    if (event !== undefined && event !== "ON" && event !== "OFF") return { status: "error", message: "event hold value malformed" };
    mode = ret.Mode;
    until = event === "ON" ? undefined : new Date(ret.RetainUntilDate).toISOString(); // an event hold keeps the lock active regardless of date
  }
  const h = await runAws({ aws: cfg.aws, sub: "get-object-legal-hold", params: { ...common, extra: ref } });
  let legalHold = false;
  if (h.code !== 0) {
    const f = describeFailure(h, "get-object-legal-hold");
    if (f.denied) return { status: "denied" };
    if (f.code !== "NoSuchObjectLockConfiguration") return { status: "error", message: f.message };
  } else {
    const body = parseJson(h.stdout);
    const status = isObj(body) && isObj(body.LegalHold) ? body.LegalHold.Status : undefined;
    if (status !== "ON" && status !== "OFF") return { status: "error", message: "legal hold response malformed" };
    legalHold = status === "ON";
  }
  return { status: "ok", mode, ...(until ? { until } : {}), legalHold };
}

export async function verifyWithS3(cfg) {
  const listing = await listExactKey(cfg);
  const locks = {};
  const dataVersions = listing.complete ? listing.entries.filter((e) => !e.isDeleteMarker) : [];
  if (dataVersions.length > 0) {
    const bucket = await bucketLockState(cfg);
    for (const entry of dataVersions) { // sorted, so call order is deterministic
      if (bucket.kind === "none") locks[entry.versionId] = { status: "ok", mode: null, legalHold: false };
      else if (bucket.kind === "denied") locks[entry.versionId] = { status: "denied" };
      else if (bucket.kind === "error") locks[entry.versionId] = { status: "error", message: bucket.message };
      else locks[entry.versionId] = await lockFor(cfg, entry.versionId);
    }
  }
  return { ...classify({ listing, locks, now: cfg.now ?? new Date() }), pages: listing.pages };
}

function emit(out, extra) {
  process.stdout.write(JSON.stringify({ verifier: VERIFIER_ID, class: out.class, verified: out.verified, ...extra, detail: out.detail, versions: out.versions, deleteMarkers: out.deleteMarkers, ...(out.pages !== undefined ? { pages: out.pages } : {}) }) + "\n");
  process.stderr.write(`verify_class=${out.class} ${out.detail}\n`);
  process.exitCode = EXIT_CODES[out.class];
}

async function main(argv) {
  let cfg;
  try { cfg = parseArgs(argv); } catch (error) {
    process.stderr.write(`usage error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  const base = { object: cfg.remote, region: cfg.region, endpoint: cfg.endpoint };
  try {
    const version = await verifyAwsCli({ aws: cfg.aws, expectedVersion: cfg.expectedVersion, sha256: cfg.sha256 });
    const out = await verifyWithS3(cfg);
    emit({ ...out, class: out.class }, { ...base, awsCli: version });
  } catch (error) {
    const detail = error instanceof IntegrityError ? error.message : "verifier internal error; fail closed";
    emit({ class: "inconclusive", verified: false, detail }, base);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2));
