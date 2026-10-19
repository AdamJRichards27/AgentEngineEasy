// Backup CLI error handling (PH-7 R29, re-applied on the D-9 chain in R29b) — CLI-SPEC.md §2 exit codes, §3 safe
// output, §4 preflight, §5 alerts. R29b adds: --tier usage, sweep exit 78, isolation-required config refusal, the
// read-only verifier download identity, the verified-marker write, and LOCK_HELD (75) staying reserved.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../artifacts.js";
import { EXIT, runCli } from "../cli.js";
import { runCommand } from "../commands.js";
import type { CommandSpec, OperationLog } from "../types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "../../../..");
const SECRETS = ["synthetic-db-pass-7f3a", "synthetic-restore-pass-91bc", "synthetic-token-55de"];

function syntheticEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  const command = JSON.stringify(["encrypt", "{input}", "{output}", "{kmsProfile}"]);
  return {
    BACKUP_ENVIRONMENT: "production",
    DATABASE_URL: `postgresql://backup_user:${SECRETS[0]}@db.invalid:5432/aee`,
    BACKUP_DOCUMENT_DIRECTORY: path.join(root, "documents"),
    BACKUP_STAGING_DIRECTORY: path.join(root, "staging"),
    BACKUP_DESTINATION: "s3://vault/backups",
    BACKUP_RETENTION_DAYS: "30",
    BACKUP_ENCRYPT_COMMAND: command,
    BACKUP_DECRYPT_COMMAND: JSON.stringify(["decrypt", "{input}", "{output}", "{kmsProfile}"]),
    BACKUP_UPLOAD_COMMAND: JSON.stringify(["upload", "{source}", "{destination}", `--token=${SECRETS[2]}`]),
    BACKUP_DOWNLOAD_COMMAND: JSON.stringify(["download", "{source}", "{destination}"]),
    BACKUP_LIST_COMMAND: JSON.stringify(["list", "{destination}"]),
    BACKUP_DELETE_COMMAND: JSON.stringify(["remove", "{object}"]),
    BACKUP_ALERT_COMMAND: JSON.stringify(["alert", "{operation}", "{error}"]),
    BACKUP_ENCRYPTION_AUTHENTICATED: "true",
    BACKUP_ENCRYPTION_KMS_PROFILE: "kms:production-backup",
    BACKUP_RESTORE_DISPOSABLE: "true",
    BACKUP_RESTORE_ENVIRONMENT_ID: "restore-drill-01",
    BACKUP_RESTORE_ROOT: path.join(root, "restore-root"),
    BACKUP_RESTORE_DOCUMENT_DIRECTORY: path.join(root, "restore-root", "documents"),
    BACKUP_RESTORE_DATABASE_URL: `postgresql://restore_user:${SECRETS[1]}@restore.invalid:5432/aee_restore`,
    ...extra,
  };
}

const TOOLS = ["pg_dump", "pg_restore", "psql", "tar", "encrypt", "decrypt", "upload", "download", "verify-download", "list", "remove", "alert"];
async function fakeBin(root: string, omit: string[] = []): Promise<string> {
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  for (const tool of TOOLS.filter((t) => !omit.includes(t))) {
    await writeFile(path.join(bin, tool), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(bin, tool), 0o755);
  }
  return bin;
}

function spawnCli(script: "backup.ts" | "restore.ts" | "sweep.ts", env: Record<string, string>, args: string[] = []) {
  const result = spawnSync(process.execPath, ["--import", "tsx", path.join("src/ops/backup", script), ...args], {
    cwd: apiRoot,
    env: { ...env, NODE_PATH: process.env.NODE_PATH ?? "" },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}`, stdout: result.stdout, stderr: result.stderr };
}
const jsonLines = (text: string): Array<Record<string, unknown>> =>
  text.split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
const STACK = /\n\s+at\s+\S+/;
const assertNoSecrets = (text: string) => {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), "synthetic secret leaked into CLI output");
};

test("exit codes are the CLI-SPEC values", () => {
  assert.deepEqual(EXIT, { OK: 0, FAILED: 1, USAGE: 64, PREFLIGHT: 69, INTERNAL: 70, LOCK_HELD: 75, CONFIG: 78 });
});

test("spawned: empty environment exits 78 with one backup_config_refused line, no stack, names no values", () => {
  const r = spawnCli("backup.ts", { PATH: process.env.PATH ?? "" });
  assert.equal(r.status, 78, r.out);
  const lines = jsonLines(r.out).filter((l) => l.event === "backup_config_refused");
  assert.equal(lines.length, 1);
  assert.match(String(lines[0]?.error), /BACKUP_ENVIRONMENT/);
  assert.ok(!STACK.test(r.out), "no raw stack trace by default");
  assert.ok(jsonLines(r.out).some((l) => l.event === "alert_unavailable_config_refused"));
});

test("spawned: unknown restore flag exits 64 (usage) before reading config", () => {
  const r = spawnCli("restore.ts", { PATH: process.env.PATH ?? "" }, ["--artifact=x", "--bogus"]);
  assert.equal(r.status, 64, r.out);
  assert.ok(jsonLines(r.out).some((l) => l.event === "backup_usage_error"));
  assert.ok(!STACK.test(r.out));
  const missing = spawnCli("restore.ts", { PATH: process.env.PATH ?? "" }, ["--confirm-disposable"]);
  assert.equal(missing.status, 64, missing.out);
  const backupArgs = spawnCli("backup.ts", { PATH: process.env.PATH ?? "" }, ["--now"]);
  assert.equal(backupArgs.status, 64, backupArgs.out);
});

test("spawned: PATH without pg_dump exits 69 with backup_preflight_failed{tool,found,required} and leaks no secret", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-cli-"));
  try {
    const bin = await fakeBin(root, ["pg_dump"]);
    const r = spawnCli("backup.ts", syntheticEnv(root, { PATH: bin }));
    assert.equal(r.status, 69, r.out);
    const line = jsonLines(r.out).find((l) => l.event === "backup_preflight_failed");
    assert.deepEqual([line?.tool, line?.found, line?.required], ["pg_dump", "missing", "present"]);
    assert.ok(!STACK.test(r.out));
    assertNoSecrets(r.out);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("BACKUP_DEBUG_STACK=1 is the only way to get a stack, and it is sanitised", async () => {
  const boom = () => {
    throw new Error(`provider init failed for postgresql://u:${SECRETS[0]}@h/db`);
  };
  for (const debug of [undefined, "1"]) {
    const root = await mkdtemp(path.join(tmpdir(), "aee-cli-"));
    const h = await inProcess(root, { BACKUP_DOCUMENT_SOURCE: "object-storage", OBJECT_STORAGE_PROVIDER: "s3", ...(debug ? { BACKUP_DEBUG_STACK: debug } : {}) }, { documentProvider: boom });
    assert.equal(h.code, EXIT.INTERNAL);
    assert.equal(h.logs.filter((l) => l.event === "backup_internal_error").length, 1);
    assert.equal(STACK.test(h.stderr), debug === "1", `stack only with BACKUP_DEBUG_STACK=1 (debug=${debug})`);
    assertNoSecrets(JSON.stringify(h.logs) + h.stderr);
    await rm(root, { recursive: true, force: true });
  }
});

test("preflight: pg_dump major older than the server major exits 69", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-cli-"));
  const h = await inProcess(root, {}, { pgDumpVersion: "pg_dump (PostgreSQL) 16.4", serverVersionNum: "170010" });
  assert.equal(h.code, EXIT.PREFLIGHT);
  const line = h.logs.find((l) => l.event === "backup_preflight_failed");
  assert.deepEqual([line?.tool, line?.found, line?.required], ["pg_dump", "16", ">=17"]);
  assert.ok(!h.calls.includes("upload"), "preflight runs before any backup work");
  await rm(root, { recursive: true, force: true });
});

test("preflight: node older than 24 exits 69", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-cli-"));
  const h = await inProcess(root, {}, { nodeVersion: "v20.19.0" });
  assert.equal(h.code, EXIT.PREFLIGHT);
  assert.deepEqual(h.logs.find((l) => l.event === "backup_preflight_failed")?.tool, "node");
  await rm(root, { recursive: true, force: true });
});

test("a fake upload failure exits 1 with the engine's single failed record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-cli-"));
  const h = await inProcess(root, {}, { failUpload: true });
  assert.equal(h.code, EXIT.FAILED);
  assert.equal(h.logs.filter((l) => l.event === "failed").length, 1);
  assert.equal(h.logs.find((l) => l.event === "failed")?.alertDelivered, true);
  assertNoSecrets(JSON.stringify(h.logs) + h.stderr);
  assert.ok(!STACK.test(h.stderr));
  await rm(root, { recursive: true, force: true });
});

test("an alert-command failure never masks the original failure: exit 1, alert_failed, alertDelivered:false", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-cli-"));
  const h = await inProcess(root, {}, { failUpload: true, failAlert: true });
  assert.equal(h.code, EXIT.FAILED);
  assert.ok(h.logs.some((l) => l.event === "alert_failed"));
  assert.equal(h.logs.find((l) => l.event === "failed")?.alertDelivered, false);
  await rm(root, { recursive: true, force: true });
});

test("config refused: the alert is attempted only when BACKUP_ALERT_COMMAND parses on its own", async () => {
  const alerts: Array<Record<string, string>> = [];
  const logs: OperationLog[] = [];
  const run = async (c: CommandSpec, r: Record<string, string> = {}) => {
    if (c.executable === "alert") alerts.push(r);
    return { stdout: "", stderr: "" };
  };
  const code = await runCli("backup", { argv: [], env: { BACKUP_ALERT_COMMAND: JSON.stringify(["alert", "{operation}", "{error}"]) }, run, log: (e) => logs.push(e) });
  assert.equal(code, EXIT.CONFIG);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.error, "backup_config_refused");
  const none = await runCli("backup", { argv: [], env: {}, run, log: (e) => logs.push(e) });
  assert.equal(none, EXIT.CONFIG);
  assert.equal(alerts.length, 1);
  assert.ok(logs.some((l) => l.event === "alert_unavailable_config_refused"));
});

test("success exits 0 with exactly one completed record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-cli-"));
  const h = await inProcess(root, {}, {});
  assert.equal(h.code, EXIT.OK, JSON.stringify(h.logs));
  assert.equal(h.logs.filter((l) => l.event === "completed").length, 1);
  assertNoSecrets(JSON.stringify(h.logs) + h.stderr);
  await rm(root, { recursive: true, force: true });
});

test("restore refusal before the engine's own logging still yields one backup_failed line and exit 1", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-cli-"));
  const env = syntheticEnv(root, { PATH: await fakeBin(root) });
  env.BACKUP_RESTORE_DATABASE_URL = env.DATABASE_URL!; // same identity -> engine refuses before its try block
  const logs: OperationLog[] = [];
  const code = await runCli("restore", {
    argv: ["--artifact=aee-protected-20260101T000000Z-000000000001.tar.enc", "--confirm-disposable"],
    env,
    run: fakeRunner({ calls: [], pgDumpVersion: "17.1", serverVersionNum: "170010" }),
    log: (e) => logs.push(e),
    nodeVersion: "v24.1.0",
  });
  assert.equal(code, EXIT.FAILED);
  assert.equal(logs.filter((l) => l.event === "backup_failed").length, 1);
  assertNoSecrets(JSON.stringify(logs));
  await rm(root, { recursive: true, force: true });
});

test("R29b: LOCK_HELD (75) is reserved on this base — no code path in cli.ts returns it", async () => {
  assert.equal(EXIT.LOCK_HELD, 75);
  const source = await readFile(path.join(here, "..", "cli.ts"), "utf8");
  assert.ok(!/return\s+EXIT\.LOCK_HELD|return\s+75\b/.test(source), "exit 75 must stay reserved until a backup lock exists");
});

test("R29b: --tier is validated as a usage error (64) before config; a valid --tier parses", async () => {
  const logs: OperationLog[] = [];
  const run = async () => ({ stdout: "", stderr: "" });
  const bad = await runCli("restore", { argv: ["--artifact=aee-protected-20260101T000000Z-000000000001.tar.enc", "--tier=yearly", "--confirm-disposable"], env: {}, run, log: (e) => logs.push(e) });
  assert.equal(bad, EXIT.USAGE);
  assert.match(String(logs.find((l) => l.event === "backup_usage_error")?.error), /--tier must be daily, weekly or monthly/);
  assert.ok(!logs.some((l) => l.event === "backup_config_refused"), "usage is checked before config");
  const good = await runCli("restore", { argv: ["--artifact=aee-protected-20260101T000000Z-000000000001.tar.enc", "--tier=weekly", "--confirm-disposable"], env: {}, run, log: (e) => logs.push(e) });
  assert.equal(good, EXIT.CONFIG, "a valid --tier gets past usage and is refused only for the empty config");
});

test("R29b spawned: sweep with an empty environment exits 78 with one staging_sweep_config_refused line, no stack", () => {
  const r = spawnCli("sweep.ts", { PATH: process.env.PATH ?? "" });
  assert.equal(r.status, 78, r.out);
  const lines = jsonLines(r.out).filter((l) => l.event === "staging_sweep_config_refused");
  assert.equal(lines.length, 1);
  assert.ok(!STACK.test(r.out));
  assert.ok(!jsonLines(r.out).some((l) => l.event === "staging_sweep_failed"));
});

test("R29b: isolation required without a policy is a config refusal (78) and no unscoped alert is attempted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-cli-"));
  const calls: string[] = [];
  const logs: OperationLog[] = [];
  const env = syntheticEnv(root, { PATH: await fakeBin(root), BACKUP_ENV_ISOLATION_REQUIRED: "true" });
  const code = await runCli("backup", { argv: [], env, run: fakeRunner({ calls }), log: (e) => logs.push(e), nodeVersion: "v24.1.0" });
  assert.equal(code, EXIT.CONFIG);
  assert.equal(logs.filter((l) => l.event === "backup_config_refused").length, 1);
  assert.ok(!calls.includes("alert"), "no alert through an unscoped runner when isolation is required");
  assert.equal(logs.find((l) => l.event === "backup_config_refused_alert")?.alertDelivered, false);
  assertNoSecrets(JSON.stringify(logs));
  await rm(root, { recursive: true, force: true });
});

test("R29b: success reads back through the verifier download identity and writes the per-tier verified marker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-cli-"));
  const h = await inProcess(root, { BACKUP_VERIFY_DOWNLOAD_COMMAND: JSON.stringify(["verify-download", "{source}", "{destination}"]) }, {});
  assert.equal(h.code, EXIT.OK, JSON.stringify(h.logs));
  assert.ok(h.calls.includes("verify-download"), "post-upload verification uses the read-only verifier identity");
  assert.ok(!h.calls.includes("remove") && !h.calls.includes("list"), "prune stays OFF by default (D-2)");
  const markers = [...h.remote.keys()].filter((k) => k.endsWith(".verified.json"));
  assert.ok(markers.length >= 1, `a verified marker is written: ${[...h.remote.keys()].join(",")}`);
  assert.ok(![...h.remote.keys()].some((k) => k.endsWith(".restore-verified.json")), "backup never writes a restore-verified marker");
  await rm(root, { recursive: true, force: true });
});

test("R29b: local failed record redacts URL credentials and token= values", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-cli-"));
  const h = await inProcess(root, {}, { failUpload: true });
  const failed = h.logs.find((l) => l.event === "failed");
  assert.match(String(failed?.error), /token=\[redacted\]/);
  assert.equal(failed?.stage, "tier_upload");
  assertNoSecrets(JSON.stringify(h.logs));
  await rm(root, { recursive: true, force: true });
  const text = redactSecrets(`connect postgresql://u:${SECRETS[0]}@h/db failed\n  at x (y.ts:1:1) password=${SECRETS[1]}`);
  assertNoSecrets(text);
  assert.match(text, /postgresql:\/\/\[credentials-redacted\]@h\/db/);
  assert.match(text, /\n  at x/, "line structure kept for the opt-in debug stack");
  assert.match(redactSecrets("BACKUP_ENCRYPTION_KMS_PROFILE is required"), /BACKUP_ENCRYPTION_KMS_PROFILE/, "variable names survive");
});

// ---------------------------------------------------------------------------------------------
interface FakeOptions {
  calls: string[];
  pgDumpVersion?: string;
  serverVersionNum?: string;
  failUpload?: boolean;
  failAlert?: boolean;
  remote?: Map<string, Buffer>;
}
function fakeRunner(o: FakeOptions) {
  const remote = o.remote ?? new Map<string, Buffer>();
  return async (command: CommandSpec, r: Record<string, string> = {}) => {
    o.calls.push(command.executable);
    if (command.args.includes("--version")) return { stdout: `${command.executable} (PostgreSQL) ${o.pgDumpVersion ?? "17.11"}\n`, stderr: "" };
    if (command.executable === "psql" && command.args.some((a) => a.includes("server_version_num"))) return { stdout: `${o.serverVersionNum ?? "170010"}\n`, stderr: "" };
    switch (command.executable) {
      case "pg_dump":
        await writeFile(command.args[command.args.indexOf("--file") + 1]!, "dump");
        return { stdout: "", stderr: "" };
      case "psql":
        return { stdout: JSON.stringify({ tenantCount: 1, recordCounts: {}, documentKeys: [] }), stderr: "" };
      case "tar":
        return runCommand(command);
      case "encrypt":
        await copyFile(r.input!, r.output!);
        return { stdout: "", stderr: "" };
      case "upload":
        if (o.failUpload) throw new Error(`Command upload failed: QuotaExceeded (token=${SECRETS[2]})`);
        remote.set(r.destination!, await readFile(r.source!));
        return { stdout: "", stderr: "" };
      case "verify-download":
      case "download": {
        const content = remote.get(r.source!);
        if (!content) throw new Error("NoSuchKey");
        await writeFile(r.destination!, content);
        return { stdout: "", stderr: "" };
      }
      case "list":
        return { stdout: "[]", stderr: "" };
      case "alert":
        if (o.failAlert) throw new Error("alert webhook unreachable");
        return { stdout: "", stderr: "" };
      default:
        throw new Error(`unexpected ${command.executable}`);
    }
  };
}

async function inProcess(
  root: string,
  extra: Record<string, string>,
  o: Omit<FakeOptions, "calls" | "remote"> & { nodeVersion?: string; documentProvider?: () => never },
) {
  await mkdir(path.join(root, "documents"), { recursive: true });
  const env = syntheticEnv(root, { PATH: await fakeBin(root), ...extra });
  const calls: string[] = [];
  const logs: OperationLog[] = [];
  const remote = new Map<string, Buffer>();
  let stderr = "";
  const code = await runCli("backup", {
    argv: [],
    env,
    run: fakeRunner({ ...o, calls, remote }),
    log: (e) => logs.push(e),
    stderr: (text) => {
      stderr += text;
    },
    nodeVersion: o.nodeVersion ?? "v24.1.0",
    ...(o.documentProvider ? { documentProvider: o.documentProvider } : {}),
  });
  return { code, logs, calls, stderr, remote };
}
