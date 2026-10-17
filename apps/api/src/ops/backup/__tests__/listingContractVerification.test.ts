import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TIER_POLICY } from "../artifacts.js";
import { createFakeRemote } from "./helpers/fakeBackupRemote.js";
import type { RemoteObject } from "../types.js";

/**
 * Integrated-only (needs #225 post-upload verification): the listing safeguard must not bypass or
 * reorder verification-before-prune, and a failed verification must still win over a bad listing.
 */
const NOW = new Date("2026-03-01T00:00:00Z"); // Sunday + 1st: daily, weekly and monthly copies
function seed(prefix: string): RemoteObject[] {
  return [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => {
    const name = `aee-protected-2025010${n}T000000Z-${n.toString(16).padStart(12, "0")}.tar.enc`;
    const lastModified = `2025-01-0${n}T00:00:00Z`;
    return [{ key: `${prefix}${name}`, lastModified }, { key: `${prefix}${name}.sha256.json`, lastModified }];
  });
}

test("V1 unexpected listing: every tier copy is verified (downloaded) before the list is requested, and nothing is removed", async () => {
  const remote = await createFakeRemote({ prune: true, seed: seed("s3://my-bucket/ae-backups/daily/"), now: NOW, configOverrides: { tierPolicy: DEFAULT_TIER_POLICY } });
  try {
    await assert.rejects(remote.createBackup(), /prune_list_unexpected/);
    const listAt = remote.calls.indexOf("list");
    assert.ok(listAt > 0);
    const downloads = remote.calls.map((c, i) => [c, i] as const).filter(([c]) => c.startsWith("download:"));
    assert.equal(downloads.length, 6, "artifact + manifest for each of the 3 tier copies");
    assert.ok(downloads.every(([, i]) => i < listAt), "all verification downloads precede the list");
    assert.ok(!remote.calls.some((c) => c.startsWith("remove")));
    assert.equal(remote.alerts.length, 1);
    assert.match(remote.alerts[0]!.error!, /^prune_list_unexpected: listing had 16 entries, 0 recognised$/);
  } finally {
    await remote.cleanup();
  }
});

test("V2 failed verification still wins: no list, no remove, verify_failed alert (not prune_list_unexpected)", async () => {
  const remote = await createFakeRemote({ prune: true,
    seed: seed("s3://my-bucket/ae-backups/daily/"), now: NOW, configOverrides: { tierPolicy: DEFAULT_TIER_POLICY },
    afterUpload: (uploaded, object) => {
      if (object.startsWith("daily/") && object.endsWith(".tar.enc")) uploaded.set(object, Buffer.from("tampered"));
    },
  });
  try {
    await assert.rejects(remote.createBackup(), /Post-upload verification failed/);
    assert.ok(!remote.calls.includes("list"));
    assert.ok(!remote.calls.some((c) => c.startsWith("remove")));
    assert.equal(remote.alerts.length, 1);
    assert.match(remote.alerts[0]!.error!, /^verify_failed: /);
  } finally {
    await remote.cleanup();
  }
});

test("V3 expected listing on the integrated base still prunes only after verification", async () => {
  const remote = await createFakeRemote({ prune: true, seed: seed("daily/"), now: NOW, configOverrides: { tierPolicy: DEFAULT_TIER_POLICY } });
  try {
    await remote.createBackup();
    const firstRemove = remote.calls.findIndex((c) => c.startsWith("remove:"));
    const lastDownload = remote.calls.map((c, i) => (c.startsWith("download:") ? i : -1)).reduce((a, b) => Math.max(a, b));
    assert.ok(firstRemove > lastDownload, "first remove after last verification download");
    assert.ok(remote.removed.length > 0);
    assert.equal(remote.alerts.length, 0);
  } finally {
    await remote.cleanup();
  }
});
