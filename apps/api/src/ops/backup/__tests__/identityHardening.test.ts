import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildChildEnv, createScopedRunner } from "../commands.js";
import { loadProductionBackupConfig } from "../config.js";
import { createBackup, restoreBackup } from "../engine.js";
import type { BackupOperation, CommandSpec } from "../types.js";
import { PRUNE_ENABLE_ENV } from "./helpers/productionEnv.js";
import { createFakeRemote } from "./helpers/fakeBackupRemote.js";

// PH-7 R12 P3 identity hardening. ENVIRONMENT-VARIABLE scope only: none of this isolates files,
// IAM roles, object-store policies or instance metadata. All names/values are inert sentinels.

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const c = JSON.stringify(["tool", "{input}", "{output}", "{kmsProfile}"]);
  return {
    BACKUP_ENVIRONMENT: "production", DATABASE_URL: "postgresql://db.invalid/aee",
    BACKUP_DOCUMENT_DIRECTORY: "/tmp/x/documents", BACKUP_STAGING_DIRECTORY: "/tmp/x/staging",
    BACKUP_DESTINATION: "s3://vault/backups", BACKUP_RETENTION_DAYS: "30",
    BACKUP_ENCRYPT_COMMAND: c, BACKUP_DECRYPT_COMMAND: c,
    BACKUP_UPLOAD_COMMAND: JSON.stringify(["put", "{source}", "{destination}"]),
    BACKUP_DOWNLOAD_COMMAND: JSON.stringify(["get", "{source}", "{destination}"]),
    BACKUP_LIST_COMMAND: JSON.stringify(["ls", "{destination}"]),
    BACKUP_DELETE_COMMAND: JSON.stringify(["rm", "{object}"]),
    BACKUP_ALERT_COMMAND: JSON.stringify(["a", "{operation}", "{error}"]),
    BACKUP_ENCRYPTION_AUTHENTICATED: "true", BACKUP_ENCRYPTION_KMS_PROFILE: "kms:production-backup",
    BACKUP_RESTORE_DISPOSABLE: "true", BACKUP_RESTORE_ENVIRONMENT_ID: "restore-drill-01",
    BACKUP_RESTORE_ROOT: "/tmp/x/restore-root", BACKUP_RESTORE_DOCUMENT_DIRECTORY: "/tmp/x/restore-root/documents",
    BACKUP_RESTORE_DATABASE_URL: "postgresql://restore.invalid/aee_restore", ...extra,
  };
}

const iso = {
  BACKUP_ENV_ISOLATION: "true",
  BACKUP_ENV_COMMON_ALLOW: "SENTINEL_REGION",
  BACKUP_ENV_UPLOAD_ALLOW: "SENTINEL_WRITE_KEY",
  BACKUP_ENV_ENCRYPT_ALLOW: "SENTINEL_ENCRYPT_KEY",
  BACKUP_ENV_VERIFY_DOWNLOAD_ALLOW: "SENTINEL_VERIFY_KEY",
  BACKUP_ENV_RESTORE_DOWNLOAD_ALLOW: "SENTINEL_RESTORE_KEY",
  BACKUP_ENV_DECRYPT_ALLOW: "SENTINEL_DECRYPT_KEY",
  BACKUP_ENV_DATABASE_ALLOW: "SENTINEL_DB_BACKUP_CONF",
  BACKUP_ENV_RESTORE_DATABASE_ALLOW: "SENTINEL_DB_RESTORE_CONF",
  BACKUP_ENV_ALERT_ALLOW: "SENTINEL_ALERT_ACCESS",
};
const requiredExtras = {
  BACKUP_ENV_ISOLATION_REQUIRED: "true",
  BACKUP_PRUNE: "off", // explicit so this file is independent of the pruning default (D-2 is a separate branch)
  BACKUP_ENV_HOME: "/var/empty/aee-backup-home",
  BACKUP_VERIFY_DOWNLOAD_COMMAND: JSON.stringify(["vget", "{source}", "{destination}"]),
  BACKUP_RESTORE_DOWNLOAD_COMMAND: JSON.stringify(["rget", "{source}", "{destination}"]),
};
const load = (...extras: Array<Record<string, string>>) => () => loadProductionBackupConfig(baseEnv(Object.assign({}, ...extras)));
const loadWithPrune = (extra: Record<string, string> = {}) => load(iso, requiredExtras, { ...PRUNE_ENABLE_ENV, BACKUP_ENV_LIST_ALLOW: "SENTINEL_LIST_KEY", BACKUP_ENV_DELETE_ALLOW: "SENTINEL_DELETE_KEY" }, extra);
const ALL_OPS: BackupOperation[] = ["database", "restore_database", "archive", "encrypt", "upload", "verify_download", "list", "delete", "alert", "decrypt", "restore_download"];

const DISCOVERY = {
  XDG_CONFIG_HOME: "/home/x/.config", XDG_DATA_HOME: "/x", XDG_CACHE_HOME: "/x", AWS_CONFIG_FILE: "/home/x/.aws/config",
  AWS_SHARED_CREDENTIALS_FILE: "/home/x/.aws/credentials", AWS_PROFILE: "prod", AWS_WEB_IDENTITY_TOKEN_FILE: "/x", AWS_ROLE_ARN: "arn:inert",
  PGPASSFILE: "/home/x/.pgpass", PGSERVICEFILE: "/x", GOOGLE_APPLICATION_CREDENTIALS: "/x", KUBECONFIG: "/x", SSH_AUTH_SOCK: "/x",
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/x", AWS_EC2_METADATA_SERVICE_ENDPOINT: "http://x", NETRC: "/x", APPDATA: "C:\\x", HOMEDRIVE: "Z:", HOMEPATH: "\\ambient-sentinel",
};
const ambient: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin", HOME: "/home/ambient-user", USERPROFILE: "C:\\Users\\ambient", TMPDIR: "/tmp", SENTINEL_REGION: "r",
  SENTINEL_WRITE_KEY: "w", SENTINEL_VERIFY_KEY: "v", SENTINEL_DELETE_KEY: "d", ...DISCOVERY,
};

test("H1 isolated children get NO inherited HOME/USERPROFILE unless an explicit BACKUP_ENV_HOME is configured", () => {
  const p = load(iso)().envIsolation!;
  for (const op of ALL_OPS) {
    const env = buildChildEnv(op, p, ambient);
    assert.ok(!("HOME" in env) && !("USERPROFILE" in env), `${op}: no inherited HOME/USERPROFILE`);
  }
});

test("H2 explicit BACKUP_ENV_HOME is the ONLY home a child sees (real child processes); the ambient home never appears", async () => {
  const p = load(iso, { BACKUP_ENV_HOME: "/var/empty/aee-backup-home" })().envIsolation!;
  const run = createScopedRunner(p, ambient);
  const dump: CommandSpec = { executable: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({H:process.env.HOME,U:process.env.USERPROFILE}))"] };
  for (const op of ALL_OPS) {
    const seen = JSON.parse((await run(dump, {}, op)).stdout) as { H?: string; U?: string };
    assert.equal(seen.H, "/var/empty/aee-backup-home", op);
    assert.equal(seen.U, "/var/empty/aee-backup-home", op);
  }
  assert.throws(load(iso, { BACKUP_ENV_HOME: "relative/home" }), /BACKUP_ENV_HOME must be an absolute path/);
});

test("H3 credential-discovery variables in the parent never reach any child, for every operation (real child processes)", async () => {
  const p = load(iso, { BACKUP_ENV_HOME: "/var/empty/aee-backup-home" })().envIsolation!;
  const run = createScopedRunner(p, ambient);
  const dump: CommandSpec = { executable: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"] };
  for (const op of ALL_OPS) {
    const names = JSON.parse((await run(dump, {}, op)).stdout) as string[];
    for (const n of Object.keys(DISCOVERY)) {
      // Windows injects its own HOMEDRIVE/HOMEPATH into every child whatever the parent passes (observed on NITRO), so
      // there the assertion is that the AMBIENT sentinel never arrives, not that the name is absent.
      if (process.platform === "win32" && (n === "HOMEDRIVE" || n === "HOMEPATH")) continue;
      assert.ok(!names.includes(n), `${op} child lacks ${n}`);
    }
  }
  if (process.platform === "win32") {
    const seen = JSON.parse((await run({ executable: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify([process.env.HOMEDRIVE,process.env.HOMEPATH]))"] }, {}, "upload")).stdout) as string[];
    assert.ok(seen[0] !== "Z:" && seen[1] !== "\\ambient-sentinel", "ambient HOMEDRIVE/HOMEPATH sentinels never reach the child");
  }
});

test("H4 credential-discovery names cannot be put on the shared allowlist; HOME/XDG never on any list; prefixes that would admit them are refused", () => {
  for (const name of ["AWS_PROFILE", "AWS_CONFIG_FILE", "XDG_CONFIG_HOME", "HOME", "PGPASSFILE", "AWS_EC2_METADATA_SERVICE_ENDPOINT", "KUBECONFIG"]) {
    assert.throws(load(iso, { BACKUP_ENV_COMMON_ALLOW: name }), /credential-discovery|shared/, `common ${name}`);
  }
  for (const name of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "APPDATA"]) {
    assert.throws(load(iso, { BACKUP_ENV_UPLOAD_ALLOW: name }), /BACKUP_ENV_HOME|credential-discovery/, `upload ${name}`);
  }
  assert.throws(load(iso, { BACKUP_ENV_UPLOAD_ALLOW: "AWS_*" }), /credential-discovery/, "AWS_* prefix could admit config/credential file paths");
  assert.throws(load(iso, { BACKUP_ENV_UPLOAD_ALLOW: "XDG_*" }), /credential-discovery|BACKUP_ENV_HOME/);
  // An exact, deliberate per-operation name is still allowed (e.g. a writer-only profile name).
  assert.deepEqual(load(iso, { BACKUP_ENV_UPLOAD_ALLOW: "AWS_PROFILE" })().envIsolation!.operations.upload, ["AWS_PROFILE"]);
});

test("H5 shared (common) allowlist is restricted to exact, uppercase, non-secret-looking names", () => {
  for (const bad of ["SENTINEL_*", "sentinel_region", "SENTINEL_API_TOKEN", "FOO_SECRET", "X_PASSWORD", "DB_PASSWD", "MY_ACCESS_KEY", "CLOUD_CREDENTIALS", "SESSION_ID", "PRIVATE_THING", "DATABASE_URL"]) {
    assert.throws(load(iso, { BACKUP_ENV_COMMON_ALLOW: bad }), /shared allowlist|COMMON_ALLOW/, bad);
  }
  assert.deepEqual(load(iso, { BACKUP_ENV_COMMON_ALLOW: "AWS_REGION,AWS_DEFAULT_REGION" })().envIsolation!.common, ["AWS_REGION", "AWS_DEFAULT_REGION"]);
});

test("H6 REQUIRED mode is fail-closed: refuses to load when isolation is off or incomplete, naming what is missing", () => {
  assert.throws(load({ BACKUP_ENV_ISOLATION_REQUIRED: "true" }), /BACKUP_ENV_ISOLATION=true is required/);
  assert.throws(load({ BACKUP_ENV_ISOLATION_REQUIRED: "true", BACKUP_ENV_ISOLATION: "false" }), /BACKUP_ENV_ISOLATION=true is required/);
  assert.throws(load({ BACKUP_ENV_ISOLATION_REQUIRED: "maybe" }), /BACKUP_ENV_ISOLATION_REQUIRED must be exactly true or false/);
  assert.throws(load(iso, { ...requiredExtras, BACKUP_ENV_HOME: "" }), /BACKUP_ENV_HOME/);
  for (const [name, re] of [
    ["BACKUP_ENV_UPLOAD_ALLOW", /upload/], ["BACKUP_ENV_ENCRYPT_ALLOW", /encrypt/], ["BACKUP_ENV_VERIFY_DOWNLOAD_ALLOW", /verify_download/],
    ["BACKUP_ENV_RESTORE_DOWNLOAD_ALLOW", /restore_download/], ["BACKUP_ENV_DECRYPT_ALLOW", /decrypt/], ["BACKUP_ENV_DATABASE_ALLOW", /database/],
    ["BACKUP_ENV_RESTORE_DATABASE_ALLOW", /restore_database/], ["BACKUP_ENV_ALERT_ALLOW", /alert/],
  ] as Array<[string, RegExp]>) {
    assert.throws(load({ ...iso, [name]: "" }, requiredExtras), (e: Error) => /isolation is required but incomplete/.test(e.message) && re.test(e.message), `missing ${name}`);
  }
  const ok = load(iso, requiredExtras)();
  assert.equal(ok.envIsolationRequired, true);
  assert.equal(ok.envIsolation!.homeDirectory, "/var/empty/aee-backup-home");
});

test("H7 REQUIRED mode: list/delete credentials exist only when pruning is on, and must exist then", () => {
  // pruning off: any list/delete allowlist is refused -> no delete-capable credential is provisioned to the backup process
  assert.throws(load(iso, requiredExtras, { BACKUP_ENV_DELETE_ALLOW: "SENTINEL_DELETE_KEY" }), /pruning is off.*delete/);
  assert.throws(load(iso, requiredExtras, { BACKUP_ENV_LIST_ALLOW: "SENTINEL_LIST_KEY" }), /pruning is off.*list/);
  // pruning on: both required
  assert.throws(load(iso, requiredExtras, { ...PRUNE_ENABLE_ENV, BACKUP_ENV_LIST_ALLOW: "SENTINEL_LIST_KEY" }), /incomplete[\s\S]*delete/);
  assert.throws(load(iso, requiredExtras, { ...PRUNE_ENABLE_ENV, BACKUP_ENV_DELETE_ALLOW: "SENTINEL_DELETE_KEY" }), /incomplete[\s\S]*list/);
  assert.equal(loadWithPrune()().prune, true);
});

test("H8 REQUIRED mode: the verifier must have its own download command, distinct from the writer, delete and restore commands", () => {
  const { BACKUP_VERIFY_DOWNLOAD_COMMAND: _v, ...noVerify } = requiredExtras;
  assert.throws(load(iso, noVerify), /BACKUP_VERIFY_DOWNLOAD_COMMAND/);
  const { BACKUP_RESTORE_DOWNLOAD_COMMAND: _r, ...noRestore } = requiredExtras;
  assert.throws(load(iso, noRestore), /BACKUP_RESTORE_DOWNLOAD_COMMAND/);
  assert.throws(load(iso, requiredExtras, { BACKUP_VERIFY_DOWNLOAD_COMMAND: JSON.stringify(["get", "{source}", "{destination}"]) }), /verifier command must differ/);
  assert.throws(load(iso, requiredExtras, { BACKUP_RESTORE_DOWNLOAD_COMMAND: requiredExtras.BACKUP_VERIFY_DOWNLOAD_COMMAND }), /restore command must differ/);
});

test("H9 engine fails closed: createBackup and restoreBackup refuse to run any command when isolation is required but the runner is unscoped", async () => {
  const remote = await createFakeRemote({ configOverrides: { envIsolationRequired: true } });
  try {
    await assert.rejects(remote.createBackup(), /isolation is required/);
    assert.deepEqual(remote.calls.filter((c) => c !== "alert" && !c.startsWith("alert")), [], "no command ran before the refusal");
    await assert.rejects(
      restoreBackup(remote.config, { artifact: "aee-protected-20260101T000000Z-0123456789ab.tar.enc", confirmDisposable: true, tier: "daily" }, { run: remote.run, log: () => undefined }),
      /isolation is required/,
    );
    assert.ok(!remote.calls.some((c) => c.startsWith("download") || c === "decrypt"));
  } finally { await remote.cleanup(); }
});

test("H10 verifier cannot exercise delete: a delete-capable command run as verify_download fails with its assigned env; same command succeeds only under delete", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aee-h10-"));
  try {
    const target = path.join(dir, "protected-object");
    await writeFile(target, "x");
    // Inert stand-in for a delete-capable tool: it only deletes when it holds the delete credential sentinel.
    const deleter: CommandSpec = { executable: process.execPath, args: ["-e", `if(!process.env.SENTINEL_DELETE_KEY){console.error("AccessDenied: no delete credential");process.exit(7)}require("fs").unlinkSync(${JSON.stringify(target)})`] };
    const p = load(iso, { BACKUP_ENV_DELETE_ALLOW: "SENTINEL_DELETE_KEY", BACKUP_ENV_LIST_ALLOW: "SENTINEL_LIST_KEY" })().envIsolation!;
    const run = createScopedRunner(p, { ...ambient, SENTINEL_DELETE_KEY: "d" });
    for (const op of ["verify_download", "restore_download", "upload", "encrypt", "decrypt", "alert", "database", "restore_database"] as BackupOperation[]) {
      await assert.rejects(run(deleter, {}, op), /AccessDenied|failed/, `${op} must not be able to delete`);
      await access(target); // still exists
    }
    assert.equal(await readFile(target, "utf8"), "x");
    await run(deleter, {}, "delete");
    await assert.rejects(access(target), "only the delete operation (holding the delete credential) removed it");
    // Config can never hand the delete credential to the verifier:
    assert.throws(load(iso, { BACKUP_ENV_DELETE_ALLOW: "SENTINEL_DELETE_KEY", BACKUP_ENV_VERIFY_DOWNLOAD_ALLOW: "SENTINEL_DELETE_KEY" }), /verify_download and delete allowlists overlap/);
    assert.throws(load(iso, { BACKUP_ENV_DELETE_ALLOW: "SENTINEL_DEL_*", BACKUP_ENV_VERIFY_DOWNLOAD_ALLOW: "SENTINEL_DEL_X" }), /overlap/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("H11 (combined with D-2) REQUIRED mode with BACKUP_PRUNE unset needs no list/delete credentials and refuses them", () => {
  const { BACKUP_PRUNE: _p, ...noPrune } = requiredExtras;
  const cfg = load(iso, noPrune)();
  assert.equal(cfg.prune, false);
  assert.equal(cfg.envIsolationRequired, true);
  assert.throws(load(iso, noPrune, { BACKUP_ENV_DELETE_ALLOW: "SENTINEL_DELETE_KEY" }), /pruning is off.*delete/);
});

test("H12 a Windows-style BACKUP_ENV_HOME also sets HOMEDRIVE/HOMEPATH (pure; platform independent)", () => {
  const p = load(iso)().envIsolation!;
  const env = buildChildEnv("upload", { ...p, homeDirectory: "C:\\aee\\home" }, ambient);
  assert.equal(env.HOMEDRIVE, "C:");
  assert.equal(env.HOMEPATH, "\\aee\\home");
  assert.equal(env.USERPROFILE, "C:\\aee\\home");
  const posix = buildChildEnv("upload", { ...p, homeDirectory: "/var/empty/h" }, ambient);
  assert.ok(!("HOMEDRIVE" in posix) && !("HOMEPATH" in posix));
});
