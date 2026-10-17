import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeRemote } from "./helpers/fakeBackupRemote.js";
import type { RemoteObject } from "../types.js";

const hex = (n: number): string => n.toString(16).padStart(12, "0");
function backup(day: number, withManifest = true): RemoteObject[] {
  const stamp = `202601${String(day).padStart(2, "0")}T000000Z`;
  const name = `aee-protected-${stamp}-${hex(day)}.tar.enc`;
  const when = `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`;
  return withManifest
    ? [{ key: name, lastModified: when }, { key: `${name}.sha256.json`, lastModified: when }]
    : [{ key: name, lastModified: when }];
}

/**
 * Verification-before-prune tests (Patch A "NEW" tests, unchanged). They exercise #225's post-upload
 * verification, so they can ONLY pass on an integrated base that contains #225. They are deliberately
 * not on the #224-based Package A branch. Flat (legacy) layout: configs here carry no tierPolicy.
 */

test("NEW: verification (download artifact + manifest) completes before the first list/remove", async () => {
  const remote = await createFakeRemote({ prune: true, seed: [1, 2, 3, 4].flatMap((d) => backup(d)), retentionDays: 1, minRetainedBackups: 1 });
  try {
    const name = await remote.createBackup();
    const after = remote.calls.slice(remote.calls.lastIndexOf(`upload:${name}.sha256.json`) + 1);
    assert.deepEqual(after.slice(0, 3), [`download:${name}`, `download:${name}.sha256.json`, "list"]);
    // D-3: the durable deletion-intent/outcome records are uploaded around the removes; nothing else may follow the list.
    assert.ok(after.slice(3).every((c) => c.startsWith("remove:") || c.startsWith("upload:deletion-records/")), "only removes (and deletion records) follow the list");
    assert.ok(after[3]!.startsWith("upload:deletion-records/") && after[3]!.endsWith(".intent.json"), "intent record precedes the first remove");
    assert.ok(remote.removed.length > 0, "expired backups are actually pruned after a verified upload");
  } finally {
    await remote.cleanup();
  }
});

test("NEW: a failed verification never prunes even when every older backup is expired", async () => {
  const remote = await createFakeRemote({ prune: true,
    seed: [1, 2, 3, 4].flatMap((d) => backup(d)),
    retentionDays: 1,
    minRetainedBackups: 1,
    afterUpload: (uploaded, object) => {
      if (object.endsWith(".tar.enc")) uploaded.set(object, Buffer.from("corrupted-after-upload"));
    },
  });
  try {
    await assert.rejects(remote.createBackup(), /Post-upload verification failed/);
    assert.ok(!remote.calls.includes("list"));
    assert.deepEqual(remote.removed, []);
    assert.equal(remote.alerts.length, 1);
  } finally {
    await remote.cleanup();
  }
});

test("NEW: the just-uploaded backup is never pruned when the live listing includes it", async () => {
  const remote = await createFakeRemote({ prune: true,
    seed: [1, 2, 3].flatMap((d) => backup(d)),
    retentionDays: 1,
    minRetainedBackups: 1,
    listIncludesUploads: true,
  });
  try {
    const name = await remote.createBackup();
    assert.ok(!remote.removed.includes(name));
    assert.ok(!remote.removed.includes(`${name}.sha256.json`));
  } finally {
    await remote.cleanup();
  }
});

test("NEW: a refused delete fails nothing, stops pruning after the first uncertain result and the run still reports verified: true", async () => {
  const remote = await createFakeRemote({ prune: true, seed: [1, 2].flatMap((d) => backup(d)), retentionDays: 1, minRetainedBackups: 1, failRemove: true });
  try {
    await remote.createBackup();
    const done = remote.logs.find((l) => l.event === "completed");
    assert.equal(done?.verified, true);
    assert.equal(done?.pruneFailed, 1, "D-3: pruning stops at the first refused delete (was: every object attempted)");
    assert.equal(done?.pruneStopped, true);
  } finally {
    await remote.cleanup();
  }
});

// ---- Package A tiered ordering (T11, T12) ----------------------------------------------------
import { TIERS } from "../artifacts.js";

const tiered = { tierPolicy: { daily: { keep: 1, retentionDays: 1 }, weekly: { keep: 1, retentionDays: 1 }, monthly: { keep: 1, retentionDays: 1 } } };
function tierBackup(tier: string, day: number): RemoteObject[] {
  return backup(day).map((o) => ({ ...o, key: `${tier}/${o.key}` }));
}

test("T11 tiered: every tier copy is downloaded and verified before the first list, and only removes follow the list", async () => {
  const remote = await createFakeRemote({ prune: true,
    seed: [1, 2, 3, 4].flatMap((d) => tierBackup("daily", d)),
    now: new Date("2026-03-01T00:00:00Z"), // Sunday the 1st: daily + weekly + monthly
    configOverrides: tiered,
  });
  try {
    const name = await remote.createBackup();
    const lastUpload = remote.calls.lastIndexOf(`upload:monthly/${name}.sha256.json`);
    const after = remote.calls.slice(lastUpload + 1);
    const listAt = after.indexOf("list");
    assert.ok(listAt > 0);
    const before = after.slice(0, listAt);
    const expectedDownloads = TIERS.flatMap((t) => [`download:${t}/${name}`, `download:${t}/${name}.sha256.json`]);
    assert.deepEqual(before, expectedDownloads, "all 3 tier copies verified (artifact + manifest) before list");
    assert.ok(after.slice(listAt + 1).every((c) => c.startsWith("remove:") || c.startsWith("upload:deletion-records/")));
    assert.ok(after[listAt + 1]!.startsWith("upload:deletion-records/") && after[listAt + 1]!.endsWith(".intent.json"), "intent record precedes the first remove");
    assert.ok(remote.removed.length > 0 && remote.removed.every((k) => k.startsWith("daily/")));
  } finally {
    await remote.cleanup();
  }
});

test("T12 tiered negative: a corrupted copy in ANY tier prevents list and remove and raises exactly one verify_failed alert", async () => {
  for (const bad of TIERS) {
    const remote = await createFakeRemote({ prune: true,
      seed: [1, 2, 3, 4].flatMap((d) => tierBackup("daily", d)),
      now: new Date("2026-03-01T00:00:00Z"),
      configOverrides: tiered,
      afterUpload: (uploaded, object) => {
        if (object.startsWith(`${bad}/`) && object.endsWith(".tar.enc")) uploaded.set(object, Buffer.from("corrupted-after-upload"));
      },
    });
    try {
      await assert.rejects(remote.createBackup(), /Post-upload verification failed/);
      assert.ok(!remote.calls.includes("list"), `${bad}: no list`);
      assert.deepEqual(remote.removed, [], `${bad}: no remove`);
      assert.equal(remote.alerts.length, 1);
      assert.match(remote.alerts[0]!.error!, /^verify_failed: /);
    } finally {
      await remote.cleanup();
    }
  }
});
