import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCommand } from "../commands.js";
import { createBackup } from "../engine.js";
import type { BackupConfig, CommandSpec, OperationLog } from "../types.js";

function config(root: string): BackupConfig {
  const spec = (executable: string): CommandSpec => ({ executable, args: [] });
  return {
    databaseUrl: "postgresql://source.invalid/aee",
    documentDirectory: path.join(root, "documents"),
    restoreDatabaseUrl: "postgresql://restore.invalid/aee_restore",
    restoreDocumentDirectory: path.join(root, "restore-root", "documents"),
    restoreRoot: path.join(root, "restore-root"),
    restoreEnvironmentId: "restore-drill-01",
    encryptionKmsProfile: "kms:production-backup",
    stagingDirectory: path.join(root, "staging"),
    destination: "durable://vault/backups",
    retentionDays: 30,
    prune: true,
    encryption: spec("encrypt"), decryption: spec("decrypt"), upload: spec("upload"),
    download: spec("download"), list: spec("list"), remove: spec("remove"), alert: spec("alert"),
  };
}

interface Harness {
  calls: string[];
  logs: OperationLog[];
  alerts: Array<Record<string, string>>;
  remote: Map<string, Buffer>;
  run: () => Promise<string>;
  cleanup: () => Promise<void>;
}

/** `mutate` can corrupt the "remote store" after an upload command returned success. */
async function harness(mutate: (remote: Map<string, Buffer>, destination: string) => void, failDownload?: RegExp): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "aee-verify-"));
  await mkdir(path.join(root, "documents"), { recursive: true });
  const calls: string[] = [];
  const logs: OperationLog[] = [];
  const alerts: Array<Record<string, string>> = [];
  const remote = new Map<string, Buffer>();
  const run = async (command: CommandSpec, replacements: Record<string, string> = {}) => {
    calls.push(command.executable);
    switch (command.executable) {
      case "pg_dump":
        await writeFile(command.args[command.args.indexOf("--file") + 1]!, "dump");
        return { stdout: "", stderr: "" };
      case "psql":
        return { stdout: JSON.stringify({ tenantCount: 1, recordCounts: {}, documentKeys: [] }), stderr: "" };
      case "tar":
        return runCommand(command);
      case "encrypt":
        await copyFile(replacements.input!, replacements.output!);
        return { stdout: "", stderr: "" };
      case "upload":
        remote.set(replacements.destination!, await readFile(replacements.source!));
        mutate(remote, replacements.destination!);
        return { stdout: "", stderr: "" };
      case "download": {
        if (failDownload?.test(replacements.source!)) throw new Error("NoSuchKey");
        const content = remote.get(replacements.source!);
        if (!content) throw new Error(`missing remote object ${replacements.source}`);
        await writeFile(replacements.destination!, content);
        return { stdout: "", stderr: "" };
      }
      case "alert":
        alerts.push(replacements);
        return { stdout: "", stderr: "" };
      case "list":
        return { stdout: "[]", stderr: "" };
      default:
        throw new Error(`unexpected ${command.executable}`);
    }
  };
  return {
    calls, logs, alerts, remote,
    run: () => createBackup(config(root), { run, now: () => new Date("2026-02-03T04:05:06Z"), log: (e) => logs.push(e) }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("a verified upload re-downloads artifact and manifest before pruning and logs verification", async () => {
  const h = await harness(() => undefined);
  try {
    await h.run();
    const afterUploads = h.calls.slice(h.calls.lastIndexOf("upload") + 1);
    assert.deepEqual(afterUploads, ["download", "download", "list"]);
    const done = h.logs.find((l) => l.event === "completed");
    assert.equal(done?.verified, true);
    assert.match(String(done?.sha256), /^[a-f0-9]{64}$/);
    assert.equal(h.alerts.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("a remote artifact that no longer matches its manifest fails the run, alerts, and never prunes", async () => {
  const h = await harness((remote, destination) => {
    if (destination.endsWith(".tar.enc")) remote.set(destination, Buffer.from("truncated-or-corrupted"));
  });
  try {
    await assert.rejects(h.run(), /Post-upload verification failed .*SHA-256 or byte length/);
    assert.ok(!h.calls.includes("list"), "prune must not run after a failed verification");
    assert.ok(!h.calls.includes("remove"));
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0]?.status, "failed");
    assert.match(h.alerts[0]?.error ?? "", /Post-upload verification failed/);
    const failed = h.logs.find((l) => l.event === "failed");
    assert.equal(failed?.level, "error");
    assert.ok(!h.logs.some((l) => l.event === "completed"));
  } finally {
    await h.cleanup();
  }
});

test("a manifest altered remotely is detected even when the artifact is intact", async () => {
  const h = await harness((remote, destination) => {
    if (destination.endsWith(".sha256.json")) {
      const parsed = JSON.parse(remote.get(destination)!.toString("utf8")) as Record<string, unknown>;
      parsed.sha256 = "0".repeat(64);
      remote.set(destination, Buffer.from(JSON.stringify(parsed) + "\n"));
    }
  });
  try {
    await assert.rejects(h.run(), /Post-upload verification failed .*manifest stored remotely differs/);
    assert.ok(!h.calls.includes("list"));
  } finally {
    await h.cleanup();
  }
});

test("an object that cannot be read back after upload fails the run", async () => {
  const h = await harness(() => undefined, /\.sha256\.json$/);
  try {
    await assert.rejects(h.run(), /Post-upload verification failed .*NoSuchKey/);
    assert.ok(!h.calls.includes("list"));
    assert.equal(h.alerts.length, 1);
  } finally {
    await h.cleanup();
  }
});
