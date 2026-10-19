import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TIER_POLICY,
  TIERS,
  parseBackupKey,
  planTierRetention,
  sanitizeErrorText,
  tiersFor,
  type Tier,
  type TierPolicy,
} from "../artifacts.js";
import { loadProductionBackupConfig } from "../config.js";
import { restoreBackup } from "../engine.js";
import { PRUNE_ENABLE_ENV } from "./helpers/productionEnv.js";
import { createFakeRemote } from "./helpers/fakeBackupRemote.js";
import { marked } from "./retentionFixtures.js";
import type { OperationLog, RemoteObject } from "../types.js";

const NOW = new Date("2026-03-01T00:00:00Z");
const hex = (n: number): string => n.toString(16).padStart(12, "0");
const legacy = { retentionDays: 30, minRetained: 7 };

/** Backup number `n` (n days before 2026-01-01 + n) stored in `tier`; always old (Jan 2026) vs NOW. */
function backup(tier: Tier | "", n: number, withManifest = true, when?: string): RemoteObject[] {
  const day = new Date(Date.UTC(2025, 0, 1) + n * 86_400_000);
  const stamp = day.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const name = `aee-protected-${stamp}-${hex(n)}.tar.enc`;
  const prefix = tier ? `${tier}/` : "";
  const lastModified = when ?? day.toISOString();
  return withManifest
    ? [{ key: `${prefix}${name}`, lastModified }, { key: `${prefix}${name}.sha256.json`, lastModified }]
    : [{ key: `${prefix}${name}`, lastModified }];
}
const artifactsOf = (keys: string[]): string[] => keys.filter((k) => k.endsWith(".tar.enc"));
const isMarker = (k: string): boolean => k.endsWith(".verified.json") || k.endsWith(".restore-verified.json");
// R29b: only VERIFIED backups count toward keep and nothing is deleted before a RESTORE_VERIFIED point exists, so the
// planner tests below plan over `marked(...)` listings (a verified marker on every pair, restore-verified on the newest).
const planMarked = (objects: RemoteObject[], now: Date, policy: TierPolicy, lg: typeof legacy, options: { protectedArtifact?: string } = {}) => {
  const listing = marked(objects);
  return { listing, plan: planTierRetention(listing.objects, now, policy, lg, { ...options, evidence: listing.evidence }) };
};

// ---- T1 -------------------------------------------------------------------------------------
test("T1 tiersFor selects daily always, weekly on Sunday and monthly on the 1st (UTC)", () => {
  assert.deepEqual(tiersFor(new Date("2026-10-18T03:00:00Z")), ["daily", "weekly"]); // Sunday
  assert.deepEqual(tiersFor(new Date("2026-11-02T03:00:00Z")), ["daily"]); // Monday the 2nd
  assert.deepEqual(tiersFor(new Date("2026-11-01T03:00:00Z")), ["daily", "weekly", "monthly"]); // Sunday the 1st
  assert.deepEqual(tiersFor(new Date("2026-10-17T03:00:00Z")), ["daily"]); // Saturday
  // UTC boundary: 23:59:59Z Saturday is not weekly, 00:00:00Z Sunday is.
  assert.deepEqual(tiersFor(new Date("2026-10-17T23:59:59Z")), ["daily"]);
  assert.deepEqual(tiersFor(new Date("2026-10-18T00:00:00Z")), ["daily", "weekly"]);
  // Non-UTC input: Sunday 2026-10-18 05:00 in +10:00 is still Saturday 19:00Z, so not weekly.
  assert.deepEqual(tiersFor(new Date("2026-10-18T05:00:00+10:00")), ["daily"]);
  // Leap day / month boundary.
  assert.deepEqual(tiersFor(new Date("2028-02-29T12:00:00Z")), ["daily"]);
  assert.deepEqual(tiersFor(new Date("2028-03-01T00:00:00Z")), ["daily", "monthly"]); // Wednesday the 1st
});

// ---- T2 -------------------------------------------------------------------------------------
test("T2 parseBackupKey accepts only <tier>/<backup object name>", () => {
  const name = "aee-protected-20260101T000000Z-0123456789ab.tar.enc";
  for (const tier of TIERS) {
    assert.deepEqual(parseBackupKey(`${tier}/${name}`), { tier, name, manifest: false });
    assert.deepEqual(parseBackupKey(`${tier}/${name}.sha256.json`), { tier, name: `${name}.sha256.json`, manifest: true });
  }
  for (const bad of [
    name,
    `yearly/${name}`,
    "customer-data.csv",
    `daily/customer-data.csv`,
    `../daily/${name}`,
    `daily/../${name}`,
    `daily/daily/${name}`,
    `daily/sub/${name}`,
    `/daily/${name}`,
    `daily/${name}.bak`,
    `daily/aee-protected-bad.tar.enc`,
    `Daily/${name}`,
    "",
  ]) {
    assert.equal(parseBackupKey(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
});

// ---- T3 -------------------------------------------------------------------------------------
test("T3 7 daily / 4 weekly / 12 monthly survive independently when everything is expired", () => {
  const { listing, plan } = planMarked([
    ...Array.from({ length: 20 }, (_, i) => backup("daily", i + 1)).flat(),
    ...Array.from({ length: 8 }, (_, i) => backup("weekly", i + 101)).flat(),
    ...Array.from({ length: 20 }, (_, i) => backup("monthly", i + 201)).flat(),
  ], new Date("2030-01-01T00:00:00Z"), DEFAULT_TIER_POLICY, legacy); // every fixture is far older than every tier window
  const objects = listing.objects;
  const deleted = new Set(plan.delete.map((o) => o.key));
  for (const [tier, total, expected] of [["daily", 20, 7], ["weekly", 8, 4], ["monthly", 20, 12]] as const) {
    const survivors = objects.filter((o) => o.key.startsWith(`${tier}/`) && !deleted.has(o.key));
    assert.equal(artifactsOf(survivors.map((o) => o.key)).length, expected, `${tier} survivors`);
    assert.equal(survivors.filter((o) => !isMarker(o.key)).length, expected * 2, `${tier} manifests survive with their artifacts`);
    assert.equal(survivors.filter((o) => o.key.endsWith(".verified.json")).length, expected, `${tier} verified markers survive with their backups`);
    assert.equal(plan.retained[tier]!.length, expected);
    assert.equal((total - expected) * 3, [...deleted].filter((k) => k.startsWith(`${tier}/`)).length, "artifact + manifest + verified marker per deleted unit");
  }
  // The survivors are the newest ones.
  assert.ok(plan.retained.daily![0]!.includes(hex(20)));
  assert.ok(!deleted.has(`daily/aee-protected-${new Date(Date.UTC(2025, 0, 1) + 20 * 86_400_000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${hex(20)}.tar.enc`));
});

// ---- T4 -------------------------------------------------------------------------------------
test("T4 the same artifact name in two tiers is planned independently (no basename collision)", () => {
  const shared = (tier: Tier) => backup(tier, 1);
  const objects = [...shared("daily"), ...shared("weekly"), ...[2, 3].flatMap((n) => backup("daily", n))];
  const policy: TierPolicy = {
    daily: { keep: 1, retentionDays: 1 },
    weekly: { keep: 1, retentionDays: 1 },
    monthly: { keep: 1, retentionDays: 1 },
  };
  const { plan } = planMarked(objects, NOW, policy, legacy);
  const deleted = plan.delete.map((o) => o.key);
  // weekly has only one backup (kept as its own newest recoverable); daily #1 is deleted.
  assert.ok(deleted.every((k) => k.startsWith("daily/")), "nothing is deleted from weekly");
  assert.ok(deleted.some((k) => k.includes(hex(1))));
  assert.ok(!objects.filter((o) => o.key.startsWith("weekly/")).some((o) => deleted.includes(o.key)));
});

// ---- T5 -------------------------------------------------------------------------------------
test("T5 a tier at or below its minimum deletes nothing; zero recoverable deletes nothing anywhere", () => {
  const sevenDaily = Array.from({ length: 7 }, (_, i) => backup("daily", i + 1)).flat();
  const { plan } = planMarked(sevenDaily, NOW, DEFAULT_TIER_POLICY, legacy);
  assert.deepEqual(plan.delete, []);
  assert.equal(plan.retained.daily!.length, 7);
  const none = [
    ...backup("daily", 1, false),
    ...backup("weekly", 2, false),
    { key: `monthly/aee-protected-20250103T000000Z-${hex(3)}.tar.enc.sha256.json`, lastModified: "2025-01-03T00:00:00Z" },
    ...backup("", 4, false),
  ];
  assert.deepEqual(planMarked(none, NOW, DEFAULT_TIER_POLICY, legacy).plan.delete, []);
  // R29b: marker-less (legacy) pairs are PRESENT only, so even far more than `keep` of them deletes nothing.
  const unmarked = Array.from({ length: 20 }, (_, i) => backup("daily", i + 1)).flat();
  assert.deepEqual(planTierRetention(unmarked, new Date("2030-01-01T00:00:00Z"), DEFAULT_TIER_POLICY, legacy).delete, []);
});

// ---- T6 -------------------------------------------------------------------------------------
test("T6 the just-uploaded artifact survives in every tier it appears in", () => {
  const objects = [1, 2, 3].flatMap((n) => [...backup("daily", n), ...backup("weekly", n), ...backup("monthly", n)]);
  const protectedArtifact = backup("", 1)[0]!.key;
  const policy: TierPolicy = { daily: { keep: 1, retentionDays: 1 }, weekly: { keep: 1, retentionDays: 1 }, monthly: { keep: 1, retentionDays: 1 } };
  const { plan } = planMarked(objects, NOW, policy, legacy, { protectedArtifact });
  const deleted = plan.delete.map((o) => o.key);
  for (const tier of TIERS) {
    assert.ok(!deleted.includes(`${tier}/${protectedArtifact}`));
    assert.ok(!deleted.includes(`${tier}/${protectedArtifact}.sha256.json`));
    assert.ok(deleted.length > 0);
  }
});

// ---- T7 -------------------------------------------------------------------------------------
test("T7 unknown-folder, malformed and unrelated keys are never planned for deletion", () => {
  const name = backup("", 1)[0]!.key;
  const strangers: RemoteObject[] = [
    { key: `yearly/${name}`, lastModified: "2000-01-01T00:00:00Z" },
    { key: `daily/sub/${name}`, lastModified: "2000-01-01T00:00:00Z" },
    { key: `daily/${name}.bak`, lastModified: "2000-01-01T00:00:00Z" },
    { key: "daily/customer-data.csv", lastModified: "2000-01-01T00:00:00Z" },
    { key: "customer-data.csv", lastModified: "2000-01-01T00:00:00Z" },
    { key: `daily/aee-protected-bad.tar.enc`, lastModified: "2000-01-01T00:00:00Z" },
  ];
  const real = Array.from({ length: 10 }, (_, i) => backup("daily", i + 1)).flat();
  const { plan } = planMarked([...strangers, ...real], NOW, DEFAULT_TIER_POLICY, legacy);
  assert.ok(plan.delete.length > 0);
  for (const stranger of strangers) assert.ok(!plan.delete.some((o) => o.key === stranger.key), stranger.key);
});

// ---- T8 -------------------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("T8 randomised invariants hold across 600 generated remote listings (seeded)", () => {
  const rand = mulberry32(0x224a);
  const int = (n: number): number => Math.floor(rand() * n);
  for (let round = 0; round < 600; round += 1) {
    const objects: RemoteObject[] = [];
    const groups = ["daily", "weekly", "monthly", ""] as const;
    for (const group of groups) {
      const count = int(25);
      for (let i = 0; i < count; i += 1) {
        const n = 1 + int(400);
        const items = backup(group, n, rand() > 0.2, rand() > 0.9 ? "garbage" : new Date(Date.UTC(2025, 0, 1) + int(430) * 86_400_000).toISOString());
        objects.push(...items.filter(() => rand() > 0.05));
      }
    }
    objects.push({ key: "customer-data.csv", lastModified: "2000-01-01T00:00:00Z" }, { key: `yearly/${backup("", 1)[0]!.key}`, lastModified: "2000-01-01T00:00:00Z" });
    const unique = [...new Map(objects.map((o) => [o.key, o])).values()];
    const protectedArtifact = rand() > 0.5 ? unique.find((o) => parseBackupKey(o.key)?.manifest === false)?.key.split("/").pop() : undefined;
    const policy: TierPolicy = {
      daily: { keep: 1 + int(8), retentionDays: 1 + int(30) },
      weekly: { keep: 1 + int(5), retentionDays: 1 + int(60) },
      monthly: { keep: 1 + int(13), retentionDays: 1 + int(400) },
    };
    const lg = { retentionDays: 1 + int(60), minRetained: 1 + int(8) };
    // R29b: plan over the marked listing (markers + evidence) so deletions are actually exercised.
    const markedListing = marked(unique);
    const plan = planTierRetention(markedListing.objects, NOW, policy, lg, { protectedArtifact, evidence: markedListing.evidence });
    const deleted = plan.delete.map((o) => o.key);
    assert.equal(new Set(deleted).size, deleted.length, "no duplicate deletions");
    for (const group of groups) {
      const inGroup = (key: string): boolean => (group ? key.startsWith(`${group}/`) : !key.includes("/"));
      const rule = group ? policy[group] : { keep: lg.minRetained, retentionDays: lg.retentionDays };
      const names = unique.filter((o) => inGroup(o.key)).map((o) => ({ ...o, base: o.key.split("/").pop()! }));
      const artifacts = names.filter((o) => o.base.startsWith("aee-protected-") && !o.base.endsWith(".sha256.json"));
      const manifests = new Set(names.filter((o) => o.base.endsWith(".sha256.json")).map((o) => o.base.slice(0, -".sha256.json".length)));
      const recoverable = artifacts
        .filter((o) => manifests.has(o.base) && !Number.isNaN(new Date(o.lastModified).valueOf()))
        .sort((a, b) => new Date(b.lastModified).valueOf() - new Date(a.lastModified).valueOf() || (a.base < b.base ? 1 : -1));
      const groupDeleted = deleted.filter(inGroup);
      if (recoverable.length === 0) assert.deepEqual(groupDeleted, [], `${group || "legacy"}: nothing deleted without a recoverable backup`);
      for (const kept of recoverable.slice(0, rule.keep)) assert.ok(!groupDeleted.includes(kept.key), "newest keep recoverable survive");
      if (protectedArtifact) {
        assert.ok(!groupDeleted.includes(group ? `${group}/${protectedArtifact}` : protectedArtifact), "protected artifact survives");
      }
      for (const key of groupDeleted) {
        const base = key.split("/").pop()!;
        if (base.endsWith(".sha256.json")) {
          const art = key.slice(0, -".sha256.json".length);
          const artifactStillThere = unique.some((o) => o.key === art) && !groupDeleted.includes(art);
          assert.ok(!artifactStillThere, "manifest never deleted while its artifact remains");
          if (groupDeleted.includes(art)) assert.ok(groupDeleted.indexOf(art) < groupDeleted.indexOf(key), "artifact before manifest");
        }
      }
    }
    for (const key of deleted) {
      assert.ok(parseBackupKey(key) !== null || (!key.includes("/") && key.startsWith("aee-protected-")), `only known keys deleted: ${key}`);
    }
  }
});

// ---- T9 -------------------------------------------------------------------------------------
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

test("T9 config: tier defaults 7/4/12, validation, BACKUP_PRUNE and vault-mode rules", () => {
  const base = loadProductionBackupConfig(envFor());
  assert.deepEqual(
    TIERS.map((t) => base.tierPolicy![t].keep),
    [7, 4, 12],
  );
  assert.equal(base.prune, false, "D-2: pruning is default OFF; BACKUP_PRUNE=on is required");
  assert.equal(base.vaultMode, false);
  const custom = loadProductionBackupConfig(envFor({ BACKUP_TIER_DAILY_KEEP: "9", BACKUP_TIER_MONTHLY_DAYS: "400" }));
  assert.equal(custom.tierPolicy!.daily.keep, 9);
  assert.equal(custom.tierPolicy!.monthly.retentionDays, 400);
  for (const bad of ["0", "-1", "1.5", "abc", "1e2"]) {
    assert.throws(() => loadProductionBackupConfig(envFor({ BACKUP_TIER_WEEKLY_KEEP: bad })), /BACKUP_TIER_WEEKLY_KEEP/);
    assert.throws(() => loadProductionBackupConfig(envFor({ BACKUP_TIER_DAILY_DAYS: bad })), /BACKUP_TIER_DAILY_DAYS/);
  }
  assert.equal(loadProductionBackupConfig(envFor({ BACKUP_PRUNE: "off" })).prune, false);
  assert.equal(loadProductionBackupConfig(envFor({ ...PRUNE_ENABLE_ENV, BACKUP_PRUNE: "ON" })).prune, true);
  assert.throws(() => loadProductionBackupConfig(envFor({ BACKUP_PRUNE: "maybe" })), /BACKUP_PRUNE must be exactly on or off/);
  assert.throws(() => loadProductionBackupConfig(envFor({ BACKUP_VAULT_MODE: "yes" })), /BACKUP_VAULT_MODE must be exactly true or false/);
  // Vault mode: explicit on is rejected; unset is fine now that pruning defaults off (D-2).
  assert.throws(() => loadProductionBackupConfig(envFor({ BACKUP_VAULT_MODE: "true", BACKUP_PRUNE: "on" })), /prohibited in vault mode/);
  assert.equal(loadProductionBackupConfig(envFor({ BACKUP_VAULT_MODE: "true" })).prune, false);
  const vault = loadProductionBackupConfig(envFor({ BACKUP_VAULT_MODE: "true", BACKUP_PRUNE: "off" }));
  assert.equal(vault.vaultMode, true);
  assert.equal(vault.prune, false);
});

// ---- T10 ------------------------------------------------------------------------------------
test("T10 engine: prune off never runs list or remove, and uploads to all three tiers on a Sunday-the-1st", async () => {
  const remote = await createFakeRemote({ prune: true,
    seed: [1, 2, 3].flatMap((n) => backup("daily", n)),
    now: NOW,
    configOverrides: { tierPolicy: { daily: { keep: 1, retentionDays: 1 }, weekly: { keep: 1, retentionDays: 1 }, monthly: { keep: 1, retentionDays: 1 } }, prune: false },
  });
  try {
    const name = await remote.createBackup();
    assert.ok(!remote.calls.some((c) => c === "list" || c.startsWith("remove")));
    assert.deepEqual(remote.removed, []);
    const done = remote.logs.find((l) => l.event === "completed");
    assert.equal(done?.prune, "off");
    assert.deepEqual(done?.tiersWritten, ["daily", "weekly", "monthly"]);
    assert.deepEqual(
      [...remote.uploaded.keys()].sort(),
      TIERS.flatMap((t) => [`${t}/${name}`, `${t}/${name}.sha256.json`, `${t}/${name}.verified.json`]).sort(),
    );
  } finally {
    await remote.cleanup();
  }
});

test("T10b engine: vault mode with pruning enabled is refused before any command runs; with prune off it works", async () => {
  const refused = await createFakeRemote({ prune: true, now: NOW, configOverrides: { vaultMode: true, prune: true, tierPolicy: DEFAULT_TIER_POLICY } });
  try {
    await assert.rejects(refused.createBackup(), /prohibited in vault mode/);
    assert.ok(!refused.calls.some((c) => c === "upload" || c.startsWith("upload:") || c === "list" || c.startsWith("remove")));
    assert.equal(refused.alerts.length, 1);
    assert.match(refused.alerts[0]!.error!, /^preflight_failed: /);
  } finally {
    await refused.cleanup();
  }
  const implicit = await createFakeRemote({ prune: true, now: NOW, configOverrides: { vaultMode: true, tierPolicy: DEFAULT_TIER_POLICY } });
  try {
    await assert.rejects(implicit.createBackup(), /prohibited in vault mode/);
  } finally {
    await implicit.cleanup();
  }
  const ok = await createFakeRemote({ prune: true, now: NOW, configOverrides: { vaultMode: true, prune: false, tierPolicy: DEFAULT_TIER_POLICY } });
  try {
    await ok.createBackup();
    assert.ok(!ok.calls.some((c) => c === "list" || c.startsWith("remove")));
  } finally {
    await ok.cleanup();
  }
});

// ---- T13 ------------------------------------------------------------------------------------
const SENTINEL = "signed/SECRET-CUSTOMER-ACME-contract.pdf";
function assertNoIdentifiers(payload: unknown): void {
  const text = JSON.stringify(payload);
  for (const forbidden of [SENTINEL, "SECRET-CUSTOMER", "arn:", "s3://", "secret-bucket", "source.invalid", "123456789012", "aee-protected-"]) {
    assert.ok(!text.includes(forbidden), `alert payload must not contain ${forbidden}: ${text}`);
  }
}

test("T13 alert payloads carry only reason codes and counts, never identifiers or raw provider text", async () => {
  // (a) a document inventory failure names a customer document key in its local error message.
  const doc = await createFakeRemote({ prune: true, now: NOW, documentKeys: [SENTINEL], configOverrides: { tierPolicy: DEFAULT_TIER_POLICY } });
  try {
    await assert.rejects(doc.createBackup(), /Document integrity failed/);
    assert.equal(doc.alerts.length, 1);
    assert.match(doc.alerts[0]!.error!, /^prepare_failed: /);
    assertNoIdentifiers(doc.alerts);
  } finally {
    await doc.cleanup();
  }
  // (b) a refused delete whose provider message carries a bucket name, an ARN and an S3 URI.
  const refused = await createFakeRemote({ prune: true,
    seed: [1, 2, 3].flatMap((n) => backup("daily", n)),
    now: NOW,
    failRemove: true,
    removeError: "AccessDenied: arn:aws:s3:::secret-bucket/daily/x acct 123456789012 s3://secret-bucket/daily/x",
    configOverrides: { tierPolicy: { daily: { keep: 1, retentionDays: 1 }, weekly: DEFAULT_TIER_POLICY.weekly, monthly: DEFAULT_TIER_POLICY.monthly } },
  });
  try {
    await refused.createBackup();
    assert.equal(refused.alerts.length, 1, "one alert per run, not per object");
    assert.equal(refused.alerts[0]!.status, "prune_delete_refused");
    assert.match(refused.alerts[0]!.error!, /^prune_delete_refused: \d+ delete\(s\) refused or not verified( \(class: [a-z_]+\))?$/);
    assertNoIdentifiers(refused.alerts);
  } finally {
    await refused.cleanup();
  }
  // (c) the sanitiser itself redacts URIs, ARNs, long ids and backup object names.
  const cleaned = sanitizeErrorText("fail s3://secret-bucket/k arn:aws:iam::123456789012:role/x aee-protected-20260101T000000Z-0123456789ab.tar.enc AKIAIOSFODNN7EXAMPLE1234");
  assert.ok(!/secret-bucket|arn:|aee-protected|AKIA/.test(cleaned), cleaned);
});

// ---- T14 ------------------------------------------------------------------------------------
test("T14 a refused artifact delete fails nothing, is counted once, preserves the manifest and stops pruning (D-3)", async () => {
  const remote = await createFakeRemote({ prune: true,
    seed: [1, 2].flatMap((n) => backup("daily", n)),
    now: NOW,
    failRemove: true,
    configOverrides: { tierPolicy: { daily: { keep: 1, retentionDays: 1 }, weekly: DEFAULT_TIER_POLICY.weekly, monthly: DEFAULT_TIER_POLICY.monthly } },
  });
  try {
    await remote.createBackup();
    const failures = remote.logs.filter((l: OperationLog) => l.event === "prune_delete_failed");
    assert.equal(failures.length, 1, "only the artifact delete is attempted; its manifest is preserved and pruning stops (D-3)");
    assert.ok(!(failures[0]!.object as string).endsWith(".sha256.json"));
    assert.ok((failures[0]!.object as string).startsWith("daily/"));
    assert.equal(remote.logs.find((l) => l.event === "completed")?.pruneFailed, 1);
    assert.deepEqual(remote.removed, []);
  } finally {
    await remote.cleanup();
  }
});

// ---- T15 ------------------------------------------------------------------------------------
test("T15 a weekly upload failure after the daily upload succeeded fails loudly, alerts once and prunes nothing", async () => {
  const remote = await createFakeRemote({ prune: true,
    seed: [1, 2, 3].flatMap((n) => backup("daily", n)),
    now: NOW,
    failUpload: /^weekly\//,
    configOverrides: { tierPolicy: { daily: { keep: 1, retentionDays: 1 }, weekly: DEFAULT_TIER_POLICY.weekly, monthly: DEFAULT_TIER_POLICY.monthly } },
  });
  try {
    await assert.rejects(remote.createBackup(), /upload refused/);
    assert.ok([...remote.uploaded.keys()].some((k) => k.startsWith("daily/")), "daily copy was stored");
    assert.ok(!remote.calls.includes("list"));
    assert.deepEqual(remote.removed, []);
    assert.equal(remote.alerts.length, 1);
    assert.match(remote.alerts[0]!.error!, /^tier_upload_failed: /);
    assert.equal(remote.logs.find((l) => l.event === "failed")?.level, "error");
  } finally {
    await remote.cleanup();
  }
});

// ---- restore tier path -----------------------------------------------------------------------
test("restore reads from the tier folder when --tier is given and from the legacy root otherwise", async () => {
  const remote = await createFakeRemote({ prune: true, now: NOW });
  try {
    const seen: string[] = [];
    const run = async (command: { executable: string }, replacements: Record<string, string> = {}) => {
      if (command.executable === "download") {
        seen.push(replacements.source!);
        throw new Error("stop");
      }
      throw new Error("unexpected");
    };
    const artifact = "aee-protected-20260101T000000Z-0123456789ab.tar.enc";
    const cfg = { ...remote.config, restoreDatabaseUrl: "postgresql://restore.invalid/other" };
    await assert.rejects(restoreBackup(cfg, { artifact, confirmDisposable: true, tier: "weekly" }, { run: run as never, log: () => undefined }), /stop/);
    await assert.rejects(restoreBackup(cfg, { artifact, confirmDisposable: true }, { run: run as never, log: () => undefined }), /stop/);
    assert.deepEqual(seen, [`durable://vault/backups/weekly/${artifact}`, `durable://vault/backups/${artifact}`]);
  } finally {
    await remote.cleanup();
  }
});
