import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { DEFAULT_TIER_POLICY } from "../artifacts.js";
import { buildChildEnv, createScopedRunner, patternsOverlap } from "../commands.js";
import { loadProductionBackupConfig } from "../config.js";
import { createBackup, restoreBackup } from "../engine.js";
import type { BackupOperation, CommandSpec, EnvIsolationPolicy } from "../types.js";
import { createFakeRemote } from "./helpers/fakeBackupRemote.js";

// PH-7 env isolation (LOCAL, unpublished). All variable names/values below are inert test sentinels;
// no real credential is read, logged or required.

function envFor(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const command = JSON.stringify(["tool", "{input}", "{output}", "{kmsProfile}"]);
  return {
    BACKUP_ENVIRONMENT: "production", DATABASE_URL: "postgresql://db.invalid/aee",
    BACKUP_DOCUMENT_DIRECTORY: "/tmp/x/documents", BACKUP_STAGING_DIRECTORY: "/tmp/x/staging",
    BACKUP_DESTINATION: "s3://vault/backups", BACKUP_RETENTION_DAYS: "30",
    BACKUP_ENCRYPT_COMMAND: command, BACKUP_DECRYPT_COMMAND: command,
    BACKUP_UPLOAD_COMMAND: JSON.stringify(["u", "{source}", "{destination}"]),
    BACKUP_DOWNLOAD_COMMAND: JSON.stringify(["d", "{source}", "{destination}"]),
    BACKUP_LIST_COMMAND: JSON.stringify(["l", "{destination}"]),
    BACKUP_DELETE_COMMAND: JSON.stringify(["r", "{object}"]),
    BACKUP_ALERT_COMMAND: JSON.stringify(["a", "{operation}", "{error}"]),
    BACKUP_ENCRYPTION_AUTHENTICATED: "true", BACKUP_ENCRYPTION_KMS_PROFILE: "kms:production-backup",
    BACKUP_RESTORE_DISPOSABLE: "true", BACKUP_RESTORE_ENVIRONMENT_ID: "restore-drill-01",
    BACKUP_RESTORE_ROOT: "/tmp/x/restore-root", BACKUP_RESTORE_DOCUMENT_DIRECTORY: "/tmp/x/restore-root/documents",
    BACKUP_RESTORE_DATABASE_URL: "postgresql://restore.invalid/aee_restore", ...extra,
  };
}

const isolationEnv = {
  BACKUP_ENV_ISOLATION: "true",
  BACKUP_ENV_COMMON_ALLOW: "SENTINEL_REGION",
  BACKUP_ENV_UPLOAD_ALLOW: "SENTINEL_WRITE_KEY",
  BACKUP_ENV_DELETE_ALLOW: "SENTINEL_DELETE_KEY",
  BACKUP_ENV_LIST_ALLOW: "SENTINEL_LIST_KEY",
  BACKUP_ENV_ENCRYPT_ALLOW: "SENTINEL_ENCRYPT_KEY",
  BACKUP_ENV_VERIFY_DOWNLOAD_ALLOW: "SENTINEL_VERIFY_KEY",
  BACKUP_ENV_RESTORE_DOWNLOAD_ALLOW: "SENTINEL_RESTORE_*",
  BACKUP_ENV_DECRYPT_ALLOW: "SENTINEL_DECRYPT_KEY",
  BACKUP_ENV_DATABASE_ALLOW: "PGSSLROOTCERT",
  BACKUP_ENV_ALERT_ALLOW: "SENTINEL_ALERT_TOKEN",
};

const ambient: NodeJS.ProcessEnv = {
  PATH: "/usr/bin", HOME: "/home/x", TMPDIR: "/tmp", LANG: "C", LC_ALL: "C", TZ: "UTC",
  SENTINEL_REGION: "r",
  SENTINEL_WRITE_KEY: "w", SENTINEL_DELETE_KEY: "d", SENTINEL_LIST_KEY: "l", SENTINEL_ENCRYPT_KEY: "e",
  SENTINEL_VERIFY_KEY: "v", SENTINEL_RESTORE_KEY: "rk", SENTINEL_DECRYPT_KEY: "dk", PGSSLROOTCERT: "c",
  SENTINEL_ALERT_TOKEN: "a",
  DATABASE_URL: "postgresql://never-in-children.invalid/x", UNRELATED_SECRET: "u", AWS_SECRET_ACCESS_KEY: "inert",
};

const owner: Record<string, BackupOperation[]> = {
  SENTINEL_WRITE_KEY: ["upload"], SENTINEL_DELETE_KEY: ["delete"], SENTINEL_LIST_KEY: ["list"],
  SENTINEL_ENCRYPT_KEY: ["encrypt"], SENTINEL_VERIFY_KEY: ["verify_download"], SENTINEL_RESTORE_KEY: ["restore_download"],
  SENTINEL_DECRYPT_KEY: ["decrypt"], PGSSLROOTCERT: ["database"], SENTINEL_ALERT_TOKEN: ["alert"],
};
const operations: BackupOperation[] = ["database", "archive", "encrypt", "upload", "verify_download", "list", "delete", "alert", "decrypt", "restore_download"];

function policy(): EnvIsolationPolicy {
  const cfg = loadProductionBackupConfig(envFor(isolationEnv));
  assert.ok(cfg.envIsolation);
  return cfg.envIsolation;
}

test("E1 config: isolation is OFF by default (legacy) and absent from the config object", () => {
  const cfg = loadProductionBackupConfig(envFor());
  assert.equal(cfg.envIsolation, undefined);
  assert.ok(!("envIsolation" in cfg));
  assert.equal(loadProductionBackupConfig(envFor({ BACKUP_ENV_ISOLATION: "false" })).envIsolation, undefined);
  assert.throws(() => loadProductionBackupConfig(envFor({ BACKUP_ENV_ISOLATION: "maybe" })));
});

test("E2 config: per-operation allowlists are parsed and overlapping/invalid entries are rejected", () => {
  const p = policy();
  assert.deepEqual(p.operations.upload, ["SENTINEL_WRITE_KEY"]);
  assert.deepEqual(p.operations.restore_download, ["SENTINEL_RESTORE_*"]);
  assert.deepEqual(p.common, ["SENTINEL_REGION"]);
  const on = (extra: Record<string, string>) => () => loadProductionBackupConfig(envFor({ ...isolationEnv, ...extra }));
  assert.throws(on({ BACKUP_ENV_DECRYPT_ALLOW: "SENTINEL_WRITE_KEY" }), /upload and decrypt allowlists overlap/);
  assert.throws(on({ BACKUP_ENV_VERIFY_DOWNLOAD_ALLOW: "SENTINEL_WRITE_KEY" }), /upload and verify_download allowlists overlap/);
  assert.throws(on({ BACKUP_ENV_VERIFY_DOWNLOAD_ALLOW: "SENTINEL_DELETE_KEY" }), /verify_download and delete allowlists overlap/);
  assert.throws(on({ BACKUP_ENV_UPLOAD_ALLOW: "SENTINEL_*" }), /overlap/, "a prefix that swallows another operation's variable");
  assert.throws(on({ BACKUP_ENV_UPLOAD_ALLOW: "*" }), /every variable/);
  assert.throws(on({ BACKUP_ENV_UPLOAD_ALLOW: "BAD NAME" }), /environment variable names/);
  assert.throws(on({ BACKUP_ENV_UPLOAD_ALLOW: "SENTINEL_REGION" }), /COMMON_ALLOW/);
  assert.ok(patternsOverlap("AWS_*", "AWS_X") && patternsOverlap("A*", "AB*") && !patternsOverlap("A_*", "B_*") && !patternsOverlap("X", "Y"));
});

test("E3 pure: each operation's child env contains its own sentinel, base vars and common vars, and nothing else", () => {
  const p = policy();
  for (const op of operations) {
    const env = buildChildEnv(op, p, ambient);
    for (const base of ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ", "SENTINEL_REGION"]) assert.ok(base in env, `${op} keeps ${base}`);
    assert.ok(!("HOME" in env) && !("USERPROFILE" in env), `${op}: HOME is no longer inherited (explicit BACKUP_ENV_HOME only)`);
    for (const [name, owners] of Object.entries(owner)) {
      assert.equal(name in env, owners.includes(op), `${op}: ${name} ${owners.includes(op) ? "present" : "absent"}`);
    }
    for (const name of ["DATABASE_URL", "UNRELATED_SECRET", "AWS_SECRET_ACCESS_KEY"]) assert.ok(!(name in env), `${op} never receives ${name}`);
  }
  // Prefix entries admit matching names only.
  assert.ok("SENTINEL_RESTORE_KEY" in buildChildEnv("restore_download", p, { ...ambient, SENTINEL_RESTORE_OTHER: "x" }));
  assert.ok("SENTINEL_RESTORE_OTHER" in buildChildEnv("restore_download", p, { ...ambient, SENTINEL_RESTORE_OTHER: "x" }));
});

test("E4 negative: writers never see restore/decrypt credentials; the verifier never sees write/delete credentials", () => {
  const p = policy();
  for (const writer of ["upload", "encrypt", "delete", "list"] as BackupOperation[]) {
    const env = buildChildEnv(writer, p, ambient);
    assert.ok(!("SENTINEL_DECRYPT_KEY" in env) && !("SENTINEL_RESTORE_KEY" in env), `${writer} lacks restore/decrypt credentials`);
  }
  const verifier = buildChildEnv("verify_download", p, ambient);
  for (const name of ["SENTINEL_WRITE_KEY", "SENTINEL_DELETE_KEY", "SENTINEL_ENCRYPT_KEY", "SENTINEL_DECRYPT_KEY", "SENTINEL_RESTORE_KEY"]) {
    assert.ok(!(name in verifier), `verifier lacks ${name}`);
  }
  const restoreDownload = buildChildEnv("restore_download", p, ambient);
  for (const name of ["SENTINEL_WRITE_KEY", "SENTINEL_DELETE_KEY", "SENTINEL_VERIFY_KEY"]) assert.ok(!(name in restoreDownload));
});

test("E5 real child processes: the environment the OS gives each child matches its scope (names only are inspected)", async () => {
  const run = createScopedRunner(policy(), ambient);
  const dump: CommandSpec = { executable: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"] };
  for (const op of operations) {
    const names = JSON.parse((await run(dump, {}, op)).stdout) as string[];
    for (const [name, owners] of Object.entries(owner)) assert.equal(names.includes(name), owners.includes(op), `${op}/${name}`);
    for (const name of ["DATABASE_URL", "UNRELATED_SECRET", "AWS_SECRET_ACCESS_KEY"]) assert.ok(!names.includes(name), `${op} child lacks ${name}`);
  }
  // An untagged call fails closed to base-only rather than inheriting anything.
  const untagged = JSON.parse((await run(dump)).stdout) as string[];
  assert.ok(!untagged.some((n) => n.startsWith("SENTINEL_") && n !== "SENTINEL_REGION"));
});

test("E6 engine: every backup child process is tagged with the right operation (no untagged calls)", async () => {
  const remote = await createFakeRemote({ seed: [], listIncludesUploads: true, prune: true, configOverrides: { verifyDownload: { executable: "verify-download", args: [] } } });
  const seen: Array<[string, BackupOperation | undefined]> = [];
  try {
    await createBackup(remote.config, {
      run: (command, replacements, operation) => { seen.push([command.executable, operation]); return remote.run(command, replacements, operation); },
      now: () => new Date("2026-03-01T00:00:00Z"),
      log: () => undefined,
    });
    assert.ok(seen.length > 0 && seen.every(([, op]) => op !== undefined), "no untagged child process");
    const expected: Record<string, BackupOperation> = {
      pg_dump: "database", psql: "database", tar: "archive", encrypt: "encrypt", upload: "upload",
      "verify-download": "verify_download", list: "list", remove: "delete",
    };
    for (const [executable, op] of seen) assert.equal(op, expected[executable], `${executable} -> ${op}`);
    for (const executable of Object.keys(expected)) assert.ok(seen.some(([e]) => e === executable) || executable === "remove", `${executable} ran`);
    assert.ok(!seen.some(([e]) => e === "download" || e === "decrypt"), "writer run uses no restore/decrypt operation");
  } finally {
    await remote.cleanup();
  }
});

test("E7 engine: restore children are tagged restore_download then decrypt, never a writer operation", async () => {
  const remote = await createFakeRemote({ seed: [], listIncludesUploads: true, prune: true, configOverrides: { tierPolicy: DEFAULT_TIER_POLICY, restoreDownload: { executable: "restore-download", args: [] } } });
  const seen: Array<[string, BackupOperation | undefined]> = [];
  try {
    await remote.createBackup();
    const artifact = [...remote.uploaded.keys()].find((k) => k.startsWith("daily/") && k.endsWith(".tar.enc"))!.slice("daily/".length);
    const stop = new Error("stop at decrypt");
    await assert.rejects(
      restoreBackup(remote.config, { artifact, confirmDisposable: true, tier: "daily" }, {
        run: async (command, replacements, operation) => {
          seen.push([command.executable, operation]);
          if (command.executable === "decrypt") throw stop;
          if (command.executable === "alert") return { stdout: "", stderr: "" };
          const content = remote.uploaded.get(replacements!.object!)!;
          await writeFile(replacements!.destination!, content);
          return { stdout: "", stderr: "" };
        },
        log: () => undefined,
      }),
      /stop at decrypt/,
    );
    const ops = seen.filter(([e]) => e !== "alert").map(([, op]) => op);
    assert.deepEqual(ops, ["restore_download", "restore_download", "decrypt"]);
  } finally {
    await remote.cleanup();
  }
});
