import assert from "node:assert/strict";
import { test } from "node:test";
import { assessListing, DEFAULT_TIER_POLICY } from "../artifacts.js";
import { createFakeRemote } from "./helpers/fakeBackupRemote.js";
import type { RemoteObject } from "../types.js";

const NOW = new Date("2026-03-01T00:00:00Z");

/** Backup number n (old: January 2025) under `prefix`, artifact + manifest. */
function old(prefix: string, n: number): RemoteObject[] {
  const hex = n.toString(16).padStart(12, "0");
  const name = `aee-protected-2025010${n}T000000Z-${hex}.tar.enc`;
  const lastModified = `2025-01-0${n}T00:00:00Z`;
  return [
    { key: `${prefix}${name}`, lastModified },
    { key: `${prefix}${name}.sha256.json`, lastModified },
  ];
}
const eight = (prefix: string): RemoteObject[] => [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => old(prefix, n));

const LEAKY = [/ae-backups/, /prod\//, /s3:\/\//, /aee-protected/, /my-bucket/];

// ---- L1 unit: assessListing -------------------------------------------------------------------
test("L1 assessListing counts destination-relative tier keys and legacy flat keys as recognised", () => {
  assert.deepEqual(assessListing([]), { listed: 0, recognised: 0 });
  assert.deepEqual(assessListing(old("daily/", 1)), { listed: 2, recognised: 2 });
  assert.deepEqual(assessListing(old("", 1)), { listed: 2, recognised: 2 });
  assert.deepEqual(assessListing([...old("weekly/", 1), ...old("monthly/", 2)]), { listed: 4, recognised: 4 });
});

test("L2 assessListing does not recognise absolute, s3://, wrongly-prefixed or unknown-tier keys", () => {
  for (const prefix of ["ae-backups/prod/daily/", "/daily/", "s3://my-bucket/ae-backups/prod/daily/", "durable://vault/backups/daily/", "yearly/", "daily/sub/"]) {
    assert.deepEqual(assessListing(old(prefix, 1)), { listed: 2, recognised: 0 }, prefix);
  }
  assert.deepEqual(assessListing([{ key: "notes.txt", lastModified: "2025-01-01T00:00:00Z" }]), { listed: 1, recognised: 0 });
});

// ---- L3 positive: documented contract is pruned normally --------------------------------------
test("L3 destination-relative listing (documented contract) is accepted and pruned as before", async () => {
  const remote = await createFakeRemote({ seed: eight("daily/"), now: NOW, configOverrides: { tierPolicy: DEFAULT_TIER_POLICY } });
  try {
    await remote.createBackup();
    assert.equal(remote.removed.length, 2, "oldest of 8 daily backups (artifact + manifest) is pruned");
    assert.ok(remote.removed[0]!.startsWith("daily/") && !remote.removed[0]!.endsWith(".sha256.json"), "artifact first");
    assert.equal(remote.alerts.length, 0);
    assert.ok(!remote.logs.some((l) => l.event === "prune_list_unexpected"));
  } finally {
    await remote.cleanup();
  }
});

test("L3b an empty listing is not 'unexpected' (fresh destination) and a legacy flat listing is accepted", async () => {
  const empty = await createFakeRemote({ seed: [], now: NOW, configOverrides: { tierPolicy: DEFAULT_TIER_POLICY } });
  const flat = await createFakeRemote({ seed: eight(""), now: NOW, configOverrides: { tierPolicy: DEFAULT_TIER_POLICY } });
  try {
    await empty.createBackup();
    assert.equal(empty.removed.length, 0);
    assert.equal(empty.alerts.length, 0);
    await flat.createBackup();
    assert.equal(flat.alerts.length, 0);
    assert.equal(flat.removed.length, 2, "legacy flat keys still age out to the floor of 7");
  } finally {
    await empty.cleanup();
    await flat.cleanup();
  }
});

// ---- L4 negative: unexpected formats fail visibly, delete nothing ------------------------------
for (const [label, prefix] of [
  ["bucket-absolute key", "ae-backups/prod/daily/"],
  ["s3:// URI", "s3://my-bucket/ae-backups/prod/daily/"],
  ["leading-slash key", "/daily/"],
] as const) {
  test(`L4 ${label} listing fails the run visibly, deletes nothing, alerts with code and counts only`, async () => {
    const remote = await createFakeRemote({ seed: eight(prefix), now: NOW, configOverrides: { tierPolicy: DEFAULT_TIER_POLICY } });
    try {
      await assert.rejects(remote.createBackup(), /prune_list_unexpected/);
      assert.deepEqual(remote.removed, [], "nothing deleted");
      assert.ok(remote.calls.some((c) => c === "list"), "listing was requested");
      assert.ok(!remote.calls.some((c) => c.startsWith("remove")), "remove never ran");
      // The new backup itself was stored before prune (the failure is in retention, not in the upload).
      assert.ok([...remote.uploaded.keys()].some((k) => k.startsWith("daily/")));
      assert.equal(remote.alerts.length, 1, "exactly one alert");
      assert.equal(remote.alerts[0]!.status, "failed");
      assert.equal(remote.alerts[0]!.error, "prune_list_unexpected: listing had 16 entries, 0 recognised");
      for (const pattern of LEAKY) assert.doesNotMatch(JSON.stringify(remote.alerts), pattern);
      const failed = remote.logs.find((l) => l.event === "failed");
      assert.equal(failed?.level, "error");
      assert.ok(!remote.logs.some((l) => l.event === "completed"), "run is never reported as completed");
      const unexpected = remote.logs.find((l) => l.event === "prune_list_unexpected");
      assert.equal(unexpected?.listed, 16);
      assert.equal(unexpected?.recognised, 0);
      for (const pattern of LEAKY) assert.doesNotMatch(JSON.stringify(unexpected), pattern);
    } finally {
      await remote.cleanup();
    }
  });
}

test("L5 with prune off the listing is never inspected (no list, no unexpected-format failure)", async () => {
  const remote = await createFakeRemote({
    seed: eight("s3://my-bucket/"), now: NOW, configOverrides: { tierPolicy: DEFAULT_TIER_POLICY, prune: false },
  });
  try {
    await remote.createBackup();
    assert.ok(!remote.calls.includes("list"));
    assert.equal(remote.alerts.length, 0);
  } finally {
    await remote.cleanup();
  }
});

test("L6 last-recoverable-backup protection is preserved: one recoverable backup, or none, deletes nothing", async () => {
  const one = await createFakeRemote({ seed: old("daily/", 1), now: NOW, configOverrides: { tierPolicy: DEFAULT_TIER_POLICY } });
  // Only an orphan artifact (no manifest) is listed: zero recoverable backups in the listing.
  const none = await createFakeRemote({ seed: old("daily/", 2).slice(0, 1), now: NOW, configOverrides: { tierPolicy: DEFAULT_TIER_POLICY } });
  try {
    await one.createBackup();
    assert.deepEqual(one.removed, []);
    await none.createBackup();
    assert.deepEqual(none.removed, []);
  } finally {
    await one.cleanup();
    await none.cleanup();
  }
});

test("L7 mixed listing (some recognised keys, some absolute) is NOT flagged (documented limitation); absolute keys are never deleted", async () => {
  const seed = [...eight("daily/"), ...eight("ae-backups/prod/daily/")];
  const remote = await createFakeRemote({ seed, now: NOW, configOverrides: { tierPolicy: DEFAULT_TIER_POLICY } });
  try {
    await remote.createBackup();
    assert.equal(remote.alerts.length, 0);
    assert.ok(remote.removed.length > 0);
    assert.ok(remote.removed.every((k) => k.startsWith("daily/")), "only recognised destination-relative keys are deleted");
  } finally {
    await remote.cleanup();
  }
});

test("L8 a non-empty listing of only unrelated keys is treated as unexpected (documented contract: list returns the destination's backup objects)", async () => {
  const remote = await createFakeRemote({
    seed: [{ key: "notes.txt", lastModified: "2025-01-01T00:00:00Z" }], now: NOW, configOverrides: { tierPolicy: DEFAULT_TIER_POLICY },
  });
  try {
    await assert.rejects(remote.createBackup(), /prune_list_unexpected/);
    assert.deepEqual(remote.removed, []);
  } finally {
    await remote.cleanup();
  }
});
