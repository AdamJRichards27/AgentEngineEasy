import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreBackup } from "../engine.js";
import { parseRestoreArgs } from "../restoreArgs.js";
import { createFakeRemote } from "./helpers/fakeBackupRemote.js";
import type { OperationLog } from "../types.js";

const ARTIFACT = "aee-protected-20260101T000000Z-0123456789ab.tar.enc";

// ---- R1 CLI parser ----------------------------------------------------------------------------
test("R1 parseRestoreArgs: --tier is optional, validated, and does not change the other arguments", () => {
  assert.deepEqual(parseRestoreArgs([`--artifact=${ARTIFACT}`, "--confirm-disposable"]), { artifact: ARTIFACT, confirmDisposable: true });
  for (const tier of ["daily", "weekly", "monthly"] as const) {
    assert.deepEqual(parseRestoreArgs([`--artifact=${ARTIFACT}`, `--tier=${tier}`, "--confirm-disposable"]), {
      artifact: ARTIFACT, confirmDisposable: true, tier,
    });
  }
  assert.equal(parseRestoreArgs([`--artifact=${ARTIFACT}`]).confirmDisposable, false);
  assert.ok(!("tier" in parseRestoreArgs([`--artifact=${ARTIFACT}`])), "no tier key without --tier (legacy flat behaviour)");
  assert.throws(() => parseRestoreArgs([`--artifact=${ARTIFACT}`, "--tier=yearly"]), /--tier must be daily, weekly or monthly/);
  assert.throws(() => parseRestoreArgs([`--artifact=${ARTIFACT}`, "--tier="]), /--tier must be daily, weekly or monthly/);
  assert.throws(() => parseRestoreArgs(["--tier=daily"]), /--artifact=.*missing/);
});

async function failingRestore(tier: "weekly" | undefined, downloadError: string) {
  const remote = await createFakeRemote({});
  const alerts: Array<Record<string, string>> = [];
  const logs: OperationLog[] = [];
  const run = async (command: { executable: string }, replacements: Record<string, string> = {}) => {
    if (command.executable === "download") throw new Error(downloadError);
    if (command.executable === "alert") {
      alerts.push(replacements);
      return { stdout: "", stderr: "" };
    }
    throw new Error("unexpected");
  };
  const cfg = { ...remote.config, restoreDatabaseUrl: "postgresql://restore.invalid/other" };
  try {
    const error = await restoreBackup(cfg, { artifact: ARTIFACT, confirmDisposable: true, ...(tier ? { tier } : {}) }, {
      run: run as never, log: (entry) => logs.push(entry),
    }).then(() => undefined, (e: unknown) => e as Error);
    return { error, alerts, logs };
  } finally {
    await remote.cleanup();
  }
}

test("R2 restore with --tier: a failed download gives a clear tier-specific message that keeps the cause", async () => {
  const { error } = await failingRestore("weekly", "NoSuchKey");
  assert.ok(error);
  assert.match(error.message, /from the "weekly" tier/);
  assert.match(error.message, /--tier=weekly/);
  assert.match(error.message, /omitting --tier \(legacy flat layout\)/);
  assert.match(error.message, /Underlying error: NoSuchKey/);
  assert.equal((error.cause as Error).message, "NoSuchKey");
});

test("R3 restore without --tier: the download error is propagated unchanged (no-tier behaviour preserved)", async () => {
  const { error } = await failingRestore(undefined, "NoSuchKey");
  assert.equal(error?.message, "NoSuchKey");
});

test("R4 restore failure alert carries a fixed reason code and stage, never raw error text; the local log keeps the full text", async () => {
  const raw = "AccessDenied s3://my-bucket/ae-backups/prod/weekly/x arn:aws:kms:ap-southeast-2:123456789012:key/abcdef0123456789abcdef";
  for (const tier of ["weekly", undefined] as const) {
    const { alerts, logs } = await failingRestore(tier, raw);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.operation, "restore");
    assert.equal(alerts[0]!.status, "failed");
    assert.equal(alerts[0]!.error, "restore_failed: restore failed during download");
    assert.doesNotMatch(JSON.stringify(alerts), /my-bucket|arn:aws|AccessDenied|ae-backups/);
    assert.match(logs.find((l) => l.event === "failed")?.error ?? "", /AccessDenied/, "full text stays in the local log");
  }
});

test("R5 a failing alert transport during restore is logged sanitised", async () => {
  const remote = await createFakeRemote({});
  const logs: OperationLog[] = [];
  const run = async (command: { executable: string }) => {
    if (command.executable === "alert") throw new Error("transport s3://secret-bucket/path down");
    throw new Error("download refused");
  };
  try {
    const cfg = { ...remote.config, restoreDatabaseUrl: "postgresql://restore.invalid/other" };
    await assert.rejects(restoreBackup(cfg, { artifact: ARTIFACT, confirmDisposable: true }, { run: run as never, log: (e) => logs.push(e) }), /download refused/);
    const alertFailed = logs.find((l) => l.event === "alert_failed");
    assert.ok(alertFailed);
    assert.doesNotMatch(JSON.stringify(alertFailed), /secret-bucket/);
  } finally {
    await remote.cleanup();
  }
});
