import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { classify as classifyShared, EXIT_CODES as SHARED_EXIT } from "../verifiers/classifyVersions.mjs";
import { classify as classifyMc, EXIT_CODES as MC_EXIT } from "../verifiers/verifyDeleteMc.mjs";
import { loadProductionBackupConfig } from "../config.js";
import { productionEnv } from "./helpers/productionEnv.js";
import { ALLOWED_REGIONS, ALLOWED_SUBCOMMANDS, buildAwsArgv, parseArgs, resolveEndpoint, VERIFIER_ID } from "../verifiers/verifyDeleteS3.mjs";

// PH-7 R22 / D-9 Stage A: AWS S3 version-aware verifier (pinned AWS CLI approach). EVERY test here uses a fake `aws`
// executable (a deterministic bash script emitting canned JSON). No AWS call, no credential, no network, no MinIO.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.resolve(HERE, "../verifiers/verifyDeleteS3.mjs");
const BUCKET = "aee-d9-sandbox-test";
const KEY = "d/a.tar.enc";
const REGION = "ap-southeast-4";
const ENDPOINT = "http://127.0.0.1:9";
const VERSION = "aws-cli/2.99.9";
const FUTURE = "2999-01-01T00:00:00+00:00";
const PAST = "2001-01-01T00:00:00+00:00";
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "d9-s3-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

type Fixture = Record<string, unknown>; // name -> JSON value | { err: string, rc?: number } | { raw: string }
let counter = 0;
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Builds a fake aws executable. Fixture names: list_<keymarker|start>_<vidmarker|start>, ret_<vid>, hold_<vid>, lockcfg. */
function makeFake(fixtures: Fixture, version = `${VERSION} Python/3.11 Linux/6 exe/x86_64`) {
  const dir = path.join(tmpRoot, `s${++counter}`);
  mkdirSync(dir);
  writeFileSync(path.join(dir, "version.txt"), `${version}\n`);
  for (const [name, value] of Object.entries(fixtures)) {
    const v = value as any;
    if (v && typeof v === "object" && "err" in v) {
      writeFileSync(path.join(dir, `${name}.err`), `${v.err}\n`);
      writeFileSync(path.join(dir, `${name}.rc`), String(v.rc ?? 254));
    } else if (v && typeof v === "object" && "raw" in v) writeFileSync(path.join(dir, `${name}.json`), v.raw);
    else writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value));
  }
  const script = `#!/bin/bash
D='${dir}'
if [ "$1" = "--version" ]; then cat "$D/version.txt"; exit 0; fi
sub="$2"; km=""; vm=""; vid=""; prev=""
for a in "$@"; do
  case "$prev" in --key-marker) km="$a";; --version-id-marker) vm="$a";; --version-id) vid="$a";; esac
  prev="$a"
done
km="\${km//[^A-Za-z0-9._-]/_}"; vm="\${vm//[^A-Za-z0-9._-]/_}"
echo "$sub $*" >> "$D/argv.log"
env | grep -E '^(AWS_|HOME=|PATH=)' | cut -d= -f1 | sort >> "$D/envnames.log"
env | grep -E '^(AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|AWS_EC2_METADATA_DISABLED)=' | sort >> "$D/envfixed.log"
case "$sub" in
  list-object-versions) name="list_\${km:-start}_\${vm:-start}";;
  get-object-retention) name="ret_$vid";;
  get-object-legal-hold) name="hold_$vid";;
  get-object-lock-configuration) name="lockcfg";;
  *) echo "unexpected subcommand $sub" >&2; exit 97;;
esac
if [ -f "$D/$name.err" ]; then cat "$D/$name.err" >&2; exit "$(cat "$D/$name.rc")"; fi
if [ -f "$D/$name.json" ]; then cat "$D/$name.json"; exit 0; fi
echo "missing fixture $name" >&2; exit 98
`;
  const aws = path.join(dir, "aws");
  writeFileSync(aws, script);
  chmodSync(aws, 0o755);
  return { aws, dir, sha: sha(aws) };
}

const page = (o: { versions?: any[]; markers?: any[]; truncated?: boolean; km?: string; vm?: string; name?: string; prefix?: string; extra?: object } = {}) => {
  const p: any = { IsTruncated: o.truncated ?? false, Name: o.name ?? BUCKET, Prefix: o.prefix ?? KEY, MaxKeys: 1000 };
  if (o.versions) p.Versions = o.versions;
  if (o.markers) p.DeleteMarkers = o.markers;
  if (o.km) p.NextKeyMarker = o.km;
  if (o.vm) p.NextVersionIdMarker = o.vm;
  return { ...p, ...(o.extra ?? {}) };
};
const V = (id: string, key = KEY) => ({ Key: key, VersionId: id, IsLatest: false, Size: 10 });
const M = (id: string, key = KEY) => ({ Key: key, VersionId: id, IsLatest: true });
const START = "list_start_start";
const ret = (mode: string, until: string, extra: object = {}) => ({ Retention: { Mode: mode, RetainUntilDate: until, ...extra } });
const hold = (s: string) => ({ LegalHold: { Status: s } });
const ERR = (code: string, op: string, rc = 254) => ({ err: `\nAn error occurred (${code}) when calling the ${op} operation: some message text`, rc });
const LOCK_ENABLED = { ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" } };
const LOCK_NONE = ERR("ObjectLockConfigurationNotFoundError", "GetObjectLockConfiguration");

interface RunOpts { fake: ReturnType<typeof makeFake>; extra?: string[]; omit?: string[]; env?: Record<string, string>; remote?: string; sha?: string; version?: string }
async function run(o: RunOpts): Promise<{ code: number; out: any; stdout: string; stderr: string; argv: string[] }> {
  const base: Record<string, string> = {
    "--aws": o.fake.aws, "--expected-aws-version": o.version ?? VERSION, "--aws-sha256": o.sha ?? o.fake.sha,
    "--bucket": BUCKET, "--region": REGION, "--endpoint-url": ENDPOINT,
  };
  const args: string[] = [];
  for (const [k, v] of Object.entries(base)) if (!(o.omit ?? []).includes(k)) args.push(k, v);
  args.push(...(o.extra ?? []), o.remote ?? `s3://${BUCKET}/${KEY}`);
  const env = { PATH: process.env.PATH ?? "", AWS_ACCESS_KEY_ID: "test-not-a-real-key", AWS_SECRET_ACCESS_KEY: "test-not-a-real-secret", AWS_PROFILE: "must-not-be-forwarded", AWS_SESSION_TOKEN: "test-token", ...(o.env ?? {}) };
  return new Promise((resolve) => {
    execFile(process.execPath, [ADAPTER, ...args], { env }, (error, stdout, stderr) => {
      const code = error ? ((error as any).code as number) : 0;
      let out: any = null;
      try { out = JSON.parse(String(stdout).trim().split("\n").pop() ?? ""); } catch { /* no verdict */ }
      const logPath = path.join(o.fake.dir, "argv.log");
      const argv = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean) : [];
      resolve({ code, out, stdout: String(stdout), stderr: String(stderr), argv });
    });
  });
}
/** Every spawned aws call must be a read-only allowlisted subcommand with no bypass flag. */
function assertReadOnly(argv: string[]) {
  for (const line of argv) {
    const sub = line.split(" ")[0]!;
    assert.ok((ALLOWED_SUBCOMMANDS as ReadonlySet<string>).has(sub), `non-allowlisted subcommand spawned: ${sub}`);
    assert.doesNotMatch(line, /bypass|--delete|put-|delete-/i);
  }
}
async function expectClass(fixtures: Fixture, cls: keyof typeof SHARED_EXIT, extra: string[] = [], opts: Partial<RunOpts> = {}) {
  const fake = makeFake(fixtures);
  const r = await run({ fake, extra, ...opts });
  assert.equal(r.out?.class, cls, `class (stderr: ${r.stderr})`);
  assert.equal(r.code, SHARED_EXIT[cls], "exit code");
  assert.equal(r.out.verified, cls === "absent");
  assert.equal(r.out.verifier, VERIFIER_ID);
  assert.match(r.stderr, new RegExp(`verify_class=${cls}`));
  assertReadOnly(r.argv);
  return { r, fake };
}

test("S0 shared classifier: both adapters use the same classify and the same exit codes", () => {
  assert.equal(classifyMc, classifyShared);
  assert.deepEqual(MC_EXIT, SHARED_EXIT);
  assert.deepEqual({ ...SHARED_EXIT }, { absent: 0, delete_marker_retained: 10, versions_retained: 11, governance_locked: 12, compliance_locked: 13, access_denied_or_incomplete: 20, inconclusive: 30 });
  assert.equal(VERIFIER_ID, "s3api-version-aware/1");
});

test("S1 absent is the ONLY verified class: a complete well-formed empty listing", async () => {
  const { r } = await expectClass({ [START]: page() }, "absent");
  assert.equal(r.out.versions, 0); assert.equal(r.out.deleteMarkers, 0); assert.equal(r.out.pages, 1);
  assert.equal(r.out.region, REGION);
  assert.equal(r.stdout.trim().split("\n").length, 1, "exactly one stdout JSON line (engine contract)");
  assert.equal(r.argv.length, 1, "no lock reads for an absent object");
  assert.match(r.argv[0]!, new RegExp(`--prefix ${KEY.replace("/", "\\/")}`));
  assert.match(r.argv[0]!, /--region ap-southeast-4/);
  assert.match(r.argv[0]!, /--endpoint-url http:\/\/127\.0\.0\.1:9/);
});

test("S1b prefix siblings (e.g. the .sha256.json manifest) never count for or against the exact key", async () => {
  await expectClass({ [START]: page({ versions: [V("s1", `${KEY}.sha256.json`)], markers: [M("s2", `${KEY}.sha256.json`)] }) }, "absent");
});

test("S2 delete marker alone or on top of retained versions is never absent", async () => {
  await expectClass({ [START]: page({ markers: [M("m1")] }) }, "delete_marker_retained");
  const { r } = await expectClass({ [START]: page({ markers: [M("m1")], versions: [V("v1")] }), lockcfg: LOCK_NONE }, "delete_marker_retained");
  assert.equal(r.out.versions, 1); assert.equal(r.out.deleteMarkers, 1);
  assert.ok(!r.argv.some((l) => /version-id m1/.test(l)), "delete markers are never lock-queried");
});

test("S3 retained unlocked version (delete did nothing) is versions_retained", async () => {
  await expectClass({ [START]: page({ versions: [V("v1")] }), lockcfg: LOCK_NONE }, "versions_retained");
  await expectClass({ [START]: page({ versions: [V("v1")] }), lockcfg: LOCK_ENABLED, ret_v1: ERR("NoSuchObjectLockConfiguration", "GetObjectRetention", 254), hold_v1: hold("OFF") }, "versions_retained");
  await expectClass({ [START]: page({ versions: [V("v1")] }), lockcfg: LOCK_ENABLED, ret_v1: ret("GOVERNANCE", PAST), hold_v1: hold("OFF") }, "versions_retained");
});

test("S4 governance and compliance locks (even under a delete marker); compliance outranks governance", async () => {
  await expectClass({ [START]: page({ markers: [M("m1")], versions: [V("v1")] }), lockcfg: LOCK_ENABLED, ret_v1: ret("GOVERNANCE", FUTURE), hold_v1: hold("OFF") }, "governance_locked");
  await expectClass({ [START]: page({ versions: [V("v1")] }), lockcfg: LOCK_ENABLED, ret_v1: ret("COMPLIANCE", FUTURE), hold_v1: hold("OFF") }, "compliance_locked");
  await expectClass({ [START]: page({ versions: [V("v1"), V("v2")] }), lockcfg: LOCK_ENABLED, ret_v1: ret("GOVERNANCE", FUTURE), hold_v1: hold("OFF"), ret_v2: ret("COMPLIANCE", FUTURE), hold_v2: hold("OFF") }, "compliance_locked");
});

test("S4b legal hold ON is reported (versions_retained) and never absent; EventHold ON keeps a lock active past its date", async () => {
  const { r } = await expectClass({ [START]: page({ versions: [V("v1")] }), lockcfg: LOCK_ENABLED, ret_v1: ERR("NoSuchObjectLockConfiguration", "GetObjectRetention"), hold_v1: hold("ON") }, "versions_retained");
  assert.match(r.out.detail, /legal hold/);
  await expectClass({ [START]: page({ versions: [V("v1")] }), lockcfg: LOCK_ENABLED, ret_v1: ret("COMPLIANCE", PAST, { EventHold: "ON" }), hold_v1: hold("OFF") }, "compliance_locked");
  await expectClass({ [START]: page({ versions: [V("v1")] }), lockcfg: LOCK_ENABLED, ret_v1: ret("GOVERNANCE", PAST, { EventHold: "OFF" }), hold_v1: hold("OFF") }, "versions_retained");
});

test("S5 pagination: every page is read; a later page can reveal retained data (no early stop)", async () => {
  const { r } = await expectClass({
    [START]: page({ truncated: true, km: KEY, vm: "p1", extra: {} }),
    [`list_d_a.tar.enc_p1`]: page({ versions: [V("v9")] }),
    lockcfg: LOCK_NONE,
  }, "versions_retained", ["--page-size", "1"]);
  assert.equal(r.out.pages, 2);
  assert.match(r.argv[1]!, /--key-marker d\/a\.tar\.enc --version-id-marker p1/);
  assert.match(r.argv[0]!, /--max-keys 1\b/);
  assert.match(r.argv[0]!, /--no-paginate/);
  // an absent object across two pages is still verified only after the LAST page
  const two = await expectClass({ [START]: page({ truncated: true, km: KEY, vm: "p1" }), [`list_d_a.tar.enc_p1`]: page() }, "absent");
  assert.equal(two.r.out.pages, 2);
});

test("S6 incomplete listings fail closed: truncated without markers, one marker only, loop, page cap, bad IsTruncated, NextToken", async () => {
  await expectClass({ [START]: page({ truncated: true }) }, "access_denied_or_incomplete");
  await expectClass({ [START]: page({ truncated: true, km: KEY }) }, "access_denied_or_incomplete");
  await expectClass({ [START]: page({ truncated: true, vm: "p1" }) }, "access_denied_or_incomplete");
  const loop = await expectClass({ [START]: page({ truncated: true, km: KEY, vm: "p1" }), [`list_d_a.tar.enc_p1`]: page({ truncated: true, km: KEY, vm: "p1" }) }, "access_denied_or_incomplete");
  assert.equal(loop.r.out.pages, 2, "the repeated-marker guard must stop the loop at once, not at the page cap");
  await expectClass({ [START]: page({ truncated: true, km: KEY, vm: "p1" }), [`list_d_a.tar.enc_p1`]: page({ truncated: true, km: KEY, vm: "p2" }), [`list_d_a.tar.enc_p2`]: page({ truncated: true, km: KEY, vm: "p3" }) }, "access_denied_or_incomplete", ["--max-pages", "2"]);
  const noFlag: any = page(); delete noFlag.IsTruncated;
  await expectClass({ [START]: noFlag }, "access_denied_or_incomplete");
  await expectClass({ [START]: { ...page(), IsTruncated: "false" } }, "access_denied_or_incomplete");
  await expectClass({ [START]: page({ extra: { NextToken: "abc" } }) }, "access_denied_or_incomplete");
  // a truncated listing whose visible page already shows a version is still incomplete-or-retained, never absent
  const { r } = await expectClass({ [START]: page({ truncated: true, versions: [V("v1")] }) }, "access_denied_or_incomplete");
  assert.equal(r.out.verified, false);
});

test("S7 listing errors are classified from the structured error CODE, not message text", async () => {
  await expectClass({ [START]: ERR("AccessDenied", "ListObjectVersions") }, "access_denied_or_incomplete");
  for (const code of ["InvalidAccessKeyId", "SignatureDoesNotMatch", "ExpiredToken", "AllAccessDisabled"]) {
    await expectClass({ [START]: ERR(code, "ListObjectVersions") }, "access_denied_or_incomplete");
  }
  // message text that merely MENTIONS AccessDenied under another code is not a permission verdict
  await expectClass({ [START]: { err: "An error occurred (InternalError) when calling the ListObjectVersions operation: AccessDenied Access Denied 403 Forbidden", rc: 254 } }, "inconclusive");
  await expectClass({ [START]: ERR("NoSuchBucket", "ListObjectVersions") }, "inconclusive");
  await expectClass({ [START]: ERR("SlowDown", "ListObjectVersions") }, "inconclusive");
  await expectClass({ [START]: ERR("TotallyUnknownCode", "ListObjectVersions") }, "inconclusive");
  await expectClass({ [START]: ERR("AccessDenied", "PutObject") }, "inconclusive");
  await expectClass({ [START]: { err: "Could not connect to the endpoint URL", rc: 255 } }, "inconclusive");
  await expectClass({ [START]: { err: "Access Denied", rc: 254 } }, "inconclusive");
  await expectClass({ [START]: { err: "", rc: 1 } }, "inconclusive");
  // exit 0 with an error code in stderr is still judged on stdout, which here is absent a verdict -> not verified
  const r = await expectClass({ [START]: { raw: "" } }, "inconclusive");
  assert.equal(r.r.out.verified, false);
});

test("S8 malformed or ambiguous listing responses are inconclusive and never absent", async () => {
  await expectClass({ [START]: { raw: "{not json" } }, "inconclusive");
  await expectClass({ [START]: { raw: "[]" } }, "inconclusive");
  await expectClass({ [START]: { raw: "null" } }, "inconclusive");
  await expectClass({ [START]: { raw: "{}" } }, "inconclusive");
  await expectClass({ [START]: page({ name: "some-other-bucket" }) }, "inconclusive");
  await expectClass({ [START]: page({ prefix: "other/prefix" }) }, "inconclusive");
  await expectClass({ [START]: page({ extra: { Versions: "oops" } }) }, "inconclusive");
  await expectClass({ [START]: page({ extra: { DeleteMarkers: { a: 1 } } }) }, "inconclusive");
  await expectClass({ [START]: page({ versions: [{ Key: KEY }] }) }, "inconclusive");
  await expectClass({ [START]: page({ versions: [{ VersionId: "v1" }] }) }, "inconclusive");
  await expectClass({ [START]: page({ versions: [V("v1")], markers: [M("v1")] }) }, "inconclusive");
  await expectClass({ [START]: page({ truncated: true, km: KEY, vm: "p1", versions: [V("v1")] }), [`list_d_a.tar.enc_p1`]: page({ versions: [V("v1")] }) }, "inconclusive");
  const p: any = page(); delete p.Name;
  await expectClass({ [START]: p }, "inconclusive");
});

test("S9 lock reads fail closed: denied -> 20; error, malformed, unknown mode, bad date -> 30", async () => {
  const L = { [START]: page({ versions: [V("v1")] }) };
  await expectClass({ ...L, lockcfg: ERR("AccessDenied", "GetObjectLockConfiguration") }, "access_denied_or_incomplete");
  await expectClass({ ...L, lockcfg: ERR("InternalError", "GetObjectLockConfiguration") }, "inconclusive");
  await expectClass({ ...L, lockcfg: { raw: "garbage" } }, "inconclusive");
  await expectClass({ ...L, lockcfg: { ObjectLockConfiguration: { ObjectLockEnabled: "Suspended" } } }, "inconclusive");
  await expectClass({ ...L, lockcfg: {} }, "inconclusive");
  const E = { ...L, lockcfg: LOCK_ENABLED, hold_v1: hold("OFF") };
  await expectClass({ ...E, ret_v1: ERR("AccessDenied", "GetObjectRetention") }, "access_denied_or_incomplete");
  await expectClass({ ...E, ret_v1: ERR("InvalidRequest", "GetObjectRetention") }, "inconclusive");
  await expectClass({ ...E, ret_v1: { raw: "<xml/>" } }, "inconclusive");
  await expectClass({ ...E, ret_v1: {} }, "inconclusive");
  await expectClass({ ...E, ret_v1: { Retention: {} } }, "inconclusive");
  await expectClass({ ...E, ret_v1: ret("WEIRD", FUTURE) }, "inconclusive");
  await expectClass({ ...E, ret_v1: ret("GOVERNANCE", "garbage") }, "inconclusive");
  await expectClass({ ...E, ret_v1: { Retention: { Mode: "GOVERNANCE" } } }, "inconclusive");
  const R = { ...L, lockcfg: LOCK_ENABLED, ret_v1: ERR("NoSuchObjectLockConfiguration", "GetObjectRetention") };
  await expectClass({ ...R, hold_v1: ERR("AccessDenied", "GetObjectLegalHold") }, "access_denied_or_incomplete");
  await expectClass({ ...R, hold_v1: ERR("InternalError", "GetObjectLegalHold") }, "inconclusive");
  await expectClass({ ...R, hold_v1: { LegalHold: { Status: "MAYBE" } } }, "inconclusive");
  await expectClass({ ...R, hold_v1: {} }, "inconclusive");
  await expectClass({ ...R, hold_v1: ERR("NoSuchObjectLockConfiguration", "GetObjectLegalHold") }, "versions_retained");
  // a version-less fixture (missing lock fixture -> fake exits 98 with no code) is inconclusive
  await expectClass({ ...L, lockcfg: LOCK_ENABLED }, "inconclusive");
});

test("S10 output is deterministic and credentials/profile never reach the AWS CLI", async () => {
  const fx = { [START]: page({ markers: [M("m2"), M("m1")], versions: [V("v2"), V("v1")] }), lockcfg: LOCK_ENABLED, ret_v1: ret("GOVERNANCE", FUTURE), hold_v1: hold("OFF"), ret_v2: ret("GOVERNANCE", FUTURE), hold_v2: hold("OFF") };
  const a = await run({ fake: makeFake(fx) });
  const b = await run({ fake: makeFake({ ...fx, [START]: page({ markers: [M("m1"), M("m2")], versions: [V("v1"), V("v2")] }) }) });
  assert.equal(a.stdout, b.stdout, "entry order must not change the verdict output");
  assert.equal(a.stderr, b.stderr);
  const fake = makeFake(fx);
  const r = await run({ fake, env: { AWS_PROFILE: "prod-admin", AWS_DEFAULT_PROFILE: "x", AWS_ROLE_ARN: "arn:aws:iam::1:role/x", AWS_WEB_IDENTITY_TOKEN_FILE: "/etc/x", AWS_ENDPOINT_URL: "https://evil.example.com" } });
  assert.equal(r.out.class, "governance_locked");
  const names = readFileSync(path.join(fake.dir, "envnames.log"), "utf8").split("\n").filter(Boolean);
  for (const forbidden of ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ENDPOINT_URL", "HOME"]) assert.ok(!names.includes(forbidden), `${forbidden} must not be forwarded`);
  for (const wanted of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) assert.ok(names.includes(wanted));
  const fixed = readFileSync(path.join(fake.dir, "envfixed.log"), "utf8");
  assert.match(fixed, /AWS_CONFIG_FILE=\/dev\/null/); assert.match(fixed, /AWS_SHARED_CREDENTIALS_FILE=\/dev\/null/); assert.match(fixed, /AWS_EC2_METADATA_DISABLED=true/);
  assert.doesNotMatch(r.stdout + r.stderr, /test-not-a-real|test-token/, "secrets are never printed");
});

test("S11 read-only allowlist: destructive and unknown subcommands/flags cannot be built or spawned", () => {
  assert.deepEqual([...ALLOWED_SUBCOMMANDS].sort(), ["get-object-legal-hold", "get-object-lock-configuration", "get-object-retention", "list-object-versions"]);
  const ok = { region: REGION, endpoint: ENDPOINT, bucket: BUCKET };
  for (const sub of ["put-object", "delete-object", "delete-objects", "delete-object-version", "put-object-retention", "put-object-legal-hold", "put-bucket-versioning", "put-object-lock-configuration", "delete-bucket", "create-bucket", "copy-object", "restore-object", "head-object", "get-object", "list-objects-v2", "", "LIST-OBJECT-VERSIONS", "list-object-versions ", "list-object-versions;rm"]) {
    assert.throws(() => buildAwsArgv(sub, { ...ok, extra: ["--key", KEY] }), /not allowed|allowlist/i, `subcommand ${JSON.stringify(sub)}`);
  }
  for (const flag of ["--bypass-governance-retention", "--bypass-governance-retention=true", "--debug", "--profile", "--endpoint-url", "--delete", "--cli-input-json", "--cli-input-yaml", "--generate-cli-skeleton", "--query", "--ca-bundle", "--no-verify-ssl"]) {
    assert.throws(() => buildAwsArgv("list-object-versions", { ...ok, extra: [flag, "x"] }), /not allowed|allowlist/i, `flag ${flag}`);
  }
  const argv = buildAwsArgv("list-object-versions", { ...ok, owner: "123456789012", extra: ["--prefix", KEY, "--max-keys", "5", "--no-paginate"] });
  assert.deepEqual(argv.slice(0, 2), ["s3api", "list-object-versions"]);
  assert.ok(argv.includes("--expected-bucket-owner") && argv.includes("123456789012") && argv.includes("--no-cli-pager") && argv.includes("--output"));
  assert.ok(!argv.some((a) => /bypass|put-|delete-/.test(a)));
  assert.throws(() => buildAwsArgv("list-object-versions", { region: "us-east-1", endpoint: ENDPOINT, bucket: BUCKET, extra: [] }), /region/i);
});

test("S12 every scenario above spawned only allowlisted read subcommands, and a spawn attempt with a destructive subcommand never reaches the binary", async () => {
  const fake = makeFake({ [START]: page() });
  const mod = await import("../verifiers/verifyDeleteS3.mjs");
  await assert.rejects(mod.runAws({ aws: fake.aws, sub: "delete-object-version", params: { region: REGION, endpoint: ENDPOINT, bucket: BUCKET, extra: ["--key", KEY, "--version-id", "v1", "--bypass-governance-retention"] } }), /not allowed|allowlist/i);
  assert.ok(!existsSync(path.join(fake.dir, "argv.log")), "the fake aws must not have been executed");
});

test("S13 pinned AWS CLI integrity: wrong hash / version / writable binary / bad path all fail closed BEFORE any aws call", async () => {
  const f1 = makeFake({ [START]: page() });
  const bad = await run({ fake: f1, sha: "0".repeat(64) });
  assert.equal(bad.out.class, "inconclusive"); assert.equal(bad.code, 30); assert.equal(bad.out.verified, false);
  assert.match(bad.out.detail, /aws_cli_integrity/); assert.match(bad.out.detail, /sha256/);
  assert.equal(bad.argv.length, 0, "binary must not be invoked on hash mismatch");
  const f2 = makeFake({ [START]: page() });
  const v = await run({ fake: f2, version: "aws-cli/2.0.1" });
  assert.equal(v.out.class, "inconclusive"); assert.match(v.out.detail, /version/);
  assert.deepEqual(v.argv, [], "only --version may have run (not logged); no s3api call");
  const f3 = makeFake({ [START]: page() }, "aws-cli/2.99.90 Python/3");
  const prefix = await run({ fake: f3 });
  assert.equal(prefix.out.class, "inconclusive", "version must match exactly, not by prefix");
  const f4 = makeFake({ [START]: page() }, "not an aws cli");
  assert.equal((await run({ fake: f4 })).out.class, "inconclusive");
  const f5 = makeFake({ [START]: page() }); chmodSync(f5.aws, 0o775);
  const w = await run({ fake: f5 });
  assert.equal(w.out.class, "inconclusive"); assert.match(w.out.detail, /writable/);
  assert.equal(w.argv.length, 0);
  const f6 = makeFake({ [START]: page() }); chmodSync(f6.aws, 0o757);
  assert.equal((await run({ fake: f6 })).out.class, "inconclusive");
  const f7 = makeFake({ [START]: page() }); chmodSync(f7.aws, 0o644);
  assert.equal((await run({ fake: f7 })).out.class, "inconclusive", "non-executable binary");
  const missing = await run({ fake: { ...f1, aws: path.join(f1.dir, "nope") } });
  assert.equal(missing.out.class, "inconclusive");
  const good = await run({ fake: makeFake({ [START]: page() }) });
  assert.equal(good.out.class, "absent");
});

test("S14 usage errors exit 2 with no aws call: missing/relative/duplicate/unknown args, bucket mismatch, region/endpoint/key/page limits", async () => {
  const f = makeFake({ [START]: page() });
  const usage = async (o: Partial<RunOpts>) => { const r = await run({ fake: f, ...o }); assert.equal(r.code, 2, JSON.stringify(o) + r.stderr); assert.equal(r.argv.length, 0); return r; };
  for (const k of ["--aws", "--expected-aws-version", "--aws-sha256", "--bucket", "--region"]) await usage({ omit: [k] });
  await usage({ remote: "not-a-uri" });
  await usage({ remote: `s3://other-bucket/${KEY}` });
  await usage({ remote: `s3://${BUCKET}/` });
  await usage({ remote: `s3://${BUCKET}/a b` });
  await usage({ remote: `s3://${BUCKET}/a?x=1` });
  await usage({ remote: `s3://${BUCKET}/../x\n` });
  await usage({ extra: ["--region", "ap-southeast-2"] });
  await usage({ extra: ["--bogus", "1"] });
  await usage({ extra: ["--page-size", "0"] });
  await usage({ extra: ["--page-size", "1001"] });
  await usage({ extra: ["--page-size", "abc"] });
  await usage({ extra: ["--max-pages", "0"] });
  await usage({ extra: ["--max-pages", "1001"] });
  await usage({ extra: ["--expected-owner", "123"] });
  await usage({ sha: "xyz" });
  await usage({ fake: { ...f, aws: "aws" } });
  const r = await run({ fake: f, extra: ["--region", "us-east-1"], omit: ["--region"] });
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(JSON.stringify(r.out ?? null)), null, "usage errors print no verdict");
});

test("S15 region allowlist, endpoint rules and owner requirement (pure functions; no network)", () => {
  assert.deepEqual([...ALLOWED_REGIONS], ["ap-southeast-4", "ap-southeast-2"]);
  assert.equal(resolveEndpoint("ap-southeast-4", undefined), "https://s3.ap-southeast-4.amazonaws.com");
  assert.equal(resolveEndpoint("ap-southeast-2", "https://s3.ap-southeast-2.amazonaws.com"), "https://s3.ap-southeast-2.amazonaws.com");
  assert.equal(resolveEndpoint("ap-southeast-4", "http://localhost:9000"), "http://localhost:9000");
  assert.equal(resolveEndpoint("ap-southeast-4", "http://127.0.0.1:9000"), "http://127.0.0.1:9000");
  for (const bad of ["https://s3.amazonaws.com", "https://s3.us-east-1.amazonaws.com", "https://evil.example.com", "http://169.254.169.254", "https://s3.ap-southeast-4.amazonaws.com.evil.com", "https://s3.ap-southeast-2.amazonaws.com", "http://127.0.0.1:9000/path", "http://user@127.0.0.1:9000", "ftp://127.0.0.1", "http://localhost.evil.com", ""]) {
    assert.throws(() => resolveEndpoint("ap-southeast-4", bad), /endpoint/i, bad);
  }
  assert.throws(() => resolveEndpoint("us-east-1", undefined), /region/i);
  const base = ["--aws", "/x/aws", "--expected-aws-version", VERSION, "--aws-sha256", "a".repeat(64), "--bucket", BUCKET, "--region", REGION];
  assert.throws(() => parseArgs([...base, `s3://${BUCKET}/${KEY}`]), /expected-owner/i, "a real AWS endpoint requires --expected-owner");
  assert.doesNotThrow(() => parseArgs([...base, "--expected-owner", "123456789012", `s3://${BUCKET}/${KEY}`]));
  assert.doesNotThrow(() => parseArgs([...base, "--endpoint-url", ENDPOINT, `s3://${BUCKET}/${KEY}`]));
  assert.throws(() => parseArgs([...base, "--expected-owner", "123456789012", "--expected-owner", "123456789012", `s3://${BUCKET}/${KEY}`]), /duplicate|more than once/i);
});

test("S16 the adapter code contains no destructive command names and no network/shell/SDK imports", () => {
  const code = readFileSync(ADAPTER, "utf8").split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  const hit = (re: RegExp) => (re.exec(code)?.[0] ?? "none");
  assert.equal(hit(/["'`](?:put|delete|create|copy|restore|upload|abort|complete)-[a-z-]+["'`]/i), "none", "no destructive s3api subcommand literal");
  assert.equal(hit(/["'`](?:rm|rb|mb|cp|mv|sync|presign)["'`]/), "none", "no high-level s3 destructive command literal");
  assert.equal(hit(/bypass-governance-retention/), "none");
  assert.equal(hit(/\bspawnSync\b|\bexecSync\b|shell:\s*true|require\(|@aws-sdk|node:https?\b|node:net\b|\bfetch\(/), "none");
});

// A real AWS CLI against a loopback S3 endpoint is intentionally NOT exercised in R22: the AWS CLI is not installed on the
// build box and no AWS access is authorised. Stage A calibration (separately approved) is where real CLI behaviour is observed.
test.skip("S17 real AWS CLI against a fully local S3 endpoint (not run: AWS CLI not installed; no AWS access authorised)", () => {});

test("S18 the exact pruning-enabling configuration with the S3 adapter loads, and the verifier command is placeholder-bound; default stays OFF", () => {
  const spec = JSON.stringify([process.execPath, ADAPTER, "--aws", "/opt/aee-backup/aws-cli/2.99.9/aws", "--expected-aws-version", VERSION, "--aws-sha256", "a".repeat(64), "--bucket", BUCKET, "--region", REGION, "--expected-owner", "123456789012", "{remote}"]);
  const on = loadProductionBackupConfig(productionEnv({ BACKUP_PRUNE: "on", BACKUP_DELETE_VERIFY_COMMAND: spec }));
  assert.equal(on.deleteVerify?.executable, process.execPath);
  assert.equal(on.deleteVerify?.args.at(-1), "{remote}");
  assert.throws(() => loadProductionBackupConfig(productionEnv({ BACKUP_PRUNE: "on" })), /BACKUP_DELETE_VERIFY_COMMAND/);
  assert.equal(loadProductionBackupConfig(productionEnv()).deleteVerify, undefined);
  // the adapter arguments the engine would pass parse under the adapter's own strict parser (engine substitutes the s3:// URI for {remote})
  const args = (JSON.parse(spec) as string[]).slice(2).map((a) => (a === "{remote}" ? `s3://${BUCKET}/${KEY}` : a));
  assert.equal(parseArgs(args).key, KEY);
});
