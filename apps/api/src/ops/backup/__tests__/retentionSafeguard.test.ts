// Retention safeguard (PH-7 R29, rebased onto the D-9 chain in R29b) — RETENTION-SAFEGUARD-SPEC.md §3 acceptance
// criteria and §4 scenarios S1–S12. Planner tests of one group (planRetention) are unchanged from R29; tiered
// planning (planTierRetention: per-tier keep, global R2), engine integration (writer marker per tier copy, D-9
// verified deletes, deletion records, read-only evidence reads, S9 re-list) and the staging sweep are R29b.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assessListing, parseBackupKey, planRetention, planTierRetention, RESTORE_VERIFIED_SUFFIX, VERIFIED_SUFFIX,
  type TierPolicy,
} from "../artifacts.js";
import { newRunMarker, sweepStaging, writeRunMarker } from "../stagingSweep.js";
import type { RemoteObject } from "../types.js";
import { createFakeRemote, type FakeRemote, type FakeRemoteOptions } from "./helpers/fakeBackupRemote.js";
import {
  artifactKey, basename, bk, isoFor, keys, merge, restoreVerified, rng, sha, verified,
  type EvidenceMap, type Listing, type MarkerKind,
} from "./retentionFixtures.js";

const FAR_FUTURE_CUTOFF = new Date("2030-01-01T00:00:00Z");
const NOW = new Date("2030-01-02T00:00:00Z");
const plan = (l: Listing, minRetained: number, extra: { protectedArtifact?: string; cutoff?: Date; now?: Date } = {}) =>
  planRetention(l.objects, extra.cutoff ?? FAR_FUTURE_CUTOFF, {
    minRetained,
    evidence: l.evidence,
    now: extra.now ?? NOW,
    ...(extra.protectedArtifact ? { protectedArtifact: extra.protectedArtifact } : {}),
  });

test("marker suffixes are exported", () => {
  assert.equal(VERIFIED_SUFFIX, ".verified.json");
  assert.equal(RESTORE_VERIFIED_SUFFIX, ".restore-verified.json");
});

test("S1: ten failed-verification uploads never displace an older VERIFIED backup", () => {
  const presents = Array.from({ length: 10 }, (_, i) => bk(20 + i)); // artifact + manifest, verify failed: no marker
  const listing = merge(restoreVerified(5, { tier: "weekly" }), verified(10), ...presents);
  const p = plan(listing, 1);
  assert.ok(p.retained.includes(artifactKey(10)), "the older VERIFIED backup is the retained one");
  for (const present of presents) assert.ok(!p.retained.includes(present.objects[0]!.key), "PRESENT never counts toward keep");
  assert.ok(!keys(p.delete).includes(artifactKey(10)));
  // PRESENT units newer than the oldest protected backup are not deletable even though they are past the age floor.
  assert.deepEqual(keys(p.delete).filter((k) => !k.startsWith("weekly/")), []);
  assert.equal(p.states[""]?.present, 10);
  assert.equal(p.states[""]?.verified, 1);
});

test("S1b: PRESENT units older than every protected backup are deletable by age", () => {
  const listing = merge(bk(1), bk(2), verified(10), restoreVerified(11));
  const p = plan(listing, 2);
  assert.deepEqual(keys(p.delete).sort(), [
    artifactKey(1), `${artifactKey(1)}.sha256.json`, artifactKey(2), `${artifactKey(2)}.sha256.json`,
  ].sort());
  const withinFloor = plan(listing, 2, { cutoff: new Date(isoFor(2)) });
  assert.deepEqual(keys(withinFloor.delete), [artifactKey(1), `${artifactKey(1)}.sha256.json`]);
});

test("S3: incomplete uploads (artifact without manifest, manifest without artifact) are never counted", () => {
  const listing = merge(bk(30, { manifest: false }), bk(31, { artifact: false }), verified(10), restoreVerified(9));
  const p = plan(listing, 1);
  assert.deepEqual(p.retained, [artifactKey(10), artifactKey(9)]);
  assert.equal(p.states[""]?.present, 1);
  assert.equal(p.states[""]?.invalid, 1);
  // the artifact-only unit is newer than the protected set and stays; the orphan manifest is INVALID and goes by age only
  assert.deepEqual(keys(p.delete), [`${artifactKey(31)}.sha256.json`]);
  assert.deepEqual(keys(plan(listing, 1, { cutoff: new Date(isoFor(31)) }).delete), []);
});

test("S4: the last VERIFIED backup is retained even when older than every age floor", () => {
  const listing = merge(
    verified(1),
    bk(40), bk(41), bk(42), // newer PRESENT pairs, all past the age floor
    restoreVerified(2, { tier: "weekly" }), // a RESTORE_VERIFIED exists elsewhere (R2 global)
  );
  const p = plan(listing, 1);
  assert.ok(p.retained.includes(artifactKey(1)));
  assert.ok(!keys(p.delete).includes(artifactKey(1)));
  assert.ok(!keys(p.delete).includes(`${artifactKey(1)}.sha256.json`));
  assert.ok(!keys(p.delete).includes(`${artifactKey(1)}${VERIFIED_SUFFIX}`));
});

test("S5: no verified point at all (new bucket or legacy-only) deletes nothing", () => {
  assert.deepEqual(keys(plan(merge(bk(1), bk(2), bk(3)), 1).delete), []);
  assert.deepEqual(keys(plan({ objects: [], evidence: {} }, 1).delete), []);
  // legacy pairs without markers, evidence absent entirely
  const legacy = merge(bk(1), bk(2));
  assert.deepEqual(keys(planRetention(legacy.objects, FAR_FUTURE_CUTOFF, { minRetained: 1 }).delete), []);
});

test("R3: without any RESTORE_VERIFIED, no backup unit is deleted (only INVALID orphans by age)", () => {
  const listing = merge(verified(1), verified(2), verified(3), bk(4, { artifact: false }));
  const p = plan(listing, 1);
  assert.deepEqual(keys(p.delete), [`${artifactKey(4)}.sha256.json`]);
});

test("S6: interrupted verification (no marker yet) is PRESENT and not counted by the next run", () => {
  const listing = merge(restoreVerified(1), bk(2)); // day 2 was killed after download, before the marker
  const p = plan(listing, 1);
  assert.deepEqual(p.retained, [artifactKey(1)]);
  assert.equal(p.states[""]?.present, 1);
});

test("S7: a marker whose artifact was deleted out of band is INVALID, alerts retention_marker_orphan, and is not counted", () => {
  const orphan = verified(20, { artifact: false });
  const listing = merge(orphan, restoreVerified(5), verified(6));
  const p = plan(listing, 1);
  assert.deepEqual(p.retained, [artifactKey(6), artifactKey(5)]);
  assert.ok(p.alerts.includes("retention_marker_orphan"));
  assert.ok(!p.alerts.some((a) => a.includes("aee-protected")), "alerts never carry object keys");
  assert.ok(p.states[""]!.invalid >= 1);
});

test("S9b: two runs planning from overlapping (growing) listings never jointly delete a protected backup", () => {
  const l1 = merge(restoreVerified(3), verified(4), verified(5), verified(1), verified(2));
  const l2 = merge(l1, verified(6), verified(7));
  const p1 = plan(l1, 2, { protectedArtifact: artifactKey(5) });
  const p2 = plan(l2, 2, { protectedArtifact: artifactKey(7) });
  const union = new Set([...keys(p1.delete), ...keys(p2.delete)]);
  for (const k of [artifactKey(7), artifactKey(6), artifactKey(5), artifactKey(3)]) assert.ok(!union.has(k), `${k} protected`);
});

test("S10: a future lastModified is never deleted and never displaces or deletes other backups", () => {
  const future = verified(1, { lastModified: "2099-01-01T00:00:00Z" });
  const listing = merge(future, verified(8), restoreVerified(7), verified(2));
  const p = plan(listing, 1);
  assert.ok(!p.retained.includes(artifactKey(1)), "future-dated backup does not count toward keep");
  assert.ok(p.retained.includes(artifactKey(8)));
  assert.ok(!keys(p.delete).some((k) => k.startsWith(artifactKey(1))));
  assert.deepEqual(keys(p.delete), [artifactKey(2), `${artifactKey(2)}.sha256.json`, `${artifactKey(2)}${VERIFIED_SUFFIX}`]);
  const garbled = merge(bk(3, { lastModified: "garbage", verified: "ok" }), restoreVerified(9));
  assert.ok(!keys(plan(garbled, 1).delete).some((k) => k.startsWith(artifactKey(3))));
});

test("S11: per-tier state — daily copy VERIFIED, weekly copy of the same run PRESENT", () => {
  const listing = merge(restoreVerified(5, { tier: "daily" }), bk(5, { tier: "weekly" }), bk(1, { tier: "weekly" }));
  const p = plan(listing, 1);
  assert.equal(p.states.daily?.restoreVerified, 1);
  assert.equal(p.states.weekly?.present, 2);
  assert.equal(p.states.weekly?.verified ?? 0, 0);
  assert.deepEqual(keys(p.delete).filter((k) => k.startsWith("weekly/")), [], "R1: weekly has 0 VERIFIED, so nothing is deleted there");
});

test("S12: marker sha256 differing from the manifest sha256 is INVALID and alerts retention_marker_mismatch", () => {
  const listing = merge(bk(9, { verified: "mismatch" }), bk(8, { verified: "garbage" }), restoreVerified(2));
  const p = plan(listing, 1);
  assert.deepEqual(p.retained, [artifactKey(2)]);
  assert.ok(p.alerts.includes("retention_marker_mismatch"));
  assert.equal(p.states[""]?.present, 2);
  assert.equal(p.states[""]?.invalid, 2);
  const restoreForged = merge(bk(9, { verified: "ok", restore: "mismatch" }), restoreVerified(2), bk(1));
  assert.ok(plan(restoreForged, 2).retained.includes(artifactKey(2)), "forged restore marker does not move the R2 point");
});

test("R4/AC6: the run's own artifact, unrelated objects and unrecognised keys are never deleted", () => {
  const listing = merge(restoreVerified(9), verified(8), verified(1), verified(2));
  listing.objects.push({ key: "customer-data.csv", lastModified: "2000-01-01T00:00:00Z" });
  listing.objects.push({ key: "aee-protected-bad.tar.enc", lastModified: "garbage" });
  const p = plan(listing, 1, { protectedArtifact: artifactKey(1) });
  const deleted = keys(p.delete);
  assert.ok(!deleted.some((k) => k.startsWith(artifactKey(1))));
  assert.ok(!deleted.includes("customer-data.csv"));
  assert.ok(!deleted.includes("aee-protected-bad.tar.enc"));
});

test("AC6: a unit is deleted artifact first, then manifest, then markers", () => {
  const p = plan(merge(restoreVerified(9), bk(1, { verified: "ok", restore: "ok" })), 1);
  assert.deepEqual(keys(p.delete), [
    artifactKey(1), `${artifactKey(1)}.sha256.json`, `${artifactKey(1)}${VERIFIED_SUFFIX}`, `${artifactKey(1)}${RESTORE_VERIFIED_SUFFIX}`,
  ]);
});

// ---------------------------------------------------------------------------------------------
// AC5: property test over >= 1,000 random listings asserting AC1–AC4 against an independent oracle.
interface Truth { key: string; tier: string; time: number; state: "PRESENT" | "VERIFIED" | "RESTORE_VERIFIED" | "NONE" }

function randomListing(r: () => number): { listing: Listing; truth: Truth[]; minRetained: number; cutoff: Date } {
  const tiers = ["", "daily", "weekly"].slice(0, 1 + Math.floor(r() * 3));
  const parts: Listing[] = [];
  const truth: Truth[] = [];
  const used = new Set<string>();
  const count = Math.floor(r() * 14);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  for (let i = 0; i < count; i++) {
    const tier = pick(tiers);
    const day = 1 + Math.floor(r() * 200);
    const hour = Math.floor(r() * 24);
    const key = artifactKey(day, tier, hour);
    if (used.has(key)) continue;
    used.add(key);
    const artifact = r() > 0.1;
    const manifest = r() > 0.15;
    const vm: MarkerKind = pick(["ok", "ok", "ok", "mismatch", "garbage", false, false]);
    const rm: MarkerKind = pick(["ok", "mismatch", false, false, false, false]);
    const timeMode = r();
    const lastModified = timeMode < 0.04 ? "garbage" : timeMode < 0.08 ? "2099-06-01T00:00:00Z" : isoFor(day, hour);
    parts.push(bk(day, { tier, hour, artifact, manifest, verified: vm, restore: rm, lastModified }));
    const time = new Date(lastModified).valueOf();
    const valid = artifact && !Number.isNaN(time) && time <= NOW.valueOf();
    const isVerified = valid && manifest && vm === "ok";
    truth.push({ key, tier, time, state: !artifact ? "NONE" : isVerified ? (rm === "ok" ? "RESTORE_VERIFIED" : "VERIFIED") : "PRESENT" });
  }
  if (r() < 0.2) parts.push({ objects: [{ key: "unrelated/report.csv", lastModified: "2000-01-01T00:00:00Z" }], evidence: {} });
  const listing = merge(...parts);
  // random order: the planner must not depend on listing order
  listing.objects.sort(() => r() - 0.5);
  return { listing, truth, minRetained: 1 + Math.floor(r() * 4), cutoff: new Date(isoFor(1 + Math.floor(r() * 220))) };
}

const isVerifiedState = (t: Truth) => t.state === "VERIFIED" || t.state === "RESTORE_VERIFIED";
const artifactDeletions = (objects: RemoteObject[]) =>
  new Set(keys(objects).filter((k) => !k.endsWith(VERIFIED_SUFFIX) && !k.endsWith(RESTORE_VERIFIED_SUFFIX)));
const subset = (a: Set<string>, b: Set<string>) => [...a].every((x) => b.has(x));

test("AC5 property: >= 1,000 random listings satisfy AC1–AC4, are deterministic and order-independent", () => {
  const SEED = 0x29c0ffee;
  const r = rng(SEED);
  let withDeletions = 0;
  for (let i = 0; i < 1200; i++) {
    const { listing, truth, minRetained, cutoff } = randomListing(r);
    const ctx = `seed=${SEED} case=${i}`;
    const opts = { minRetained, evidence: listing.evidence, now: NOW };
    const p = planRetention(listing.objects, cutoff, opts);
    const deleted = new Set(keys(p.delete));
    if (deleted.size) withDeletions += 1;

    // AC5 determinism and order independence
    assert.deepEqual(planRetention(listing.objects, cutoff, opts), p, ctx);
    const reversed = planRetention([...listing.objects].reverse(), cutoff, opts);
    assert.deepEqual(new Set(keys(reversed.delete)), deleted, ctx);

    // AC1: newest `keep` VERIFIED per tier and the newest RESTORE_VERIFIED (global) are never deleted
    for (const tier of new Set(truth.map((t) => t.tier))) {
      const top = truth.filter((t) => t.tier === tier && isVerifiedState(t)).sort((a, b) => b.time - a.time).slice(0, minRetained);
      for (const t of top) assert.ok(!deleted.has(t.key), `${ctx} AC1 top-keep ${t.key}`);
      // AC2: a tier with 0 VERIFIED yields 0 deletions in that tier
      if (!truth.some((t) => t.tier === tier && isVerifiedState(t))) {
        const inTier = [...deleted].filter((k) => (k.includes("/") ? k.slice(0, k.indexOf("/")) : "") === tier && k.includes("aee-protected"));
        assert.deepEqual(inTier, [], `${ctx} AC2 tier ${tier}`);
      }
    }
    const newestRv = truth.filter((t) => t.state === "RESTORE_VERIFIED").sort((a, b) => b.time - a.time)[0];
    if (newestRv) assert.ok(!deleted.has(newestRv.key), `${ctx} AC1 newest restore-verified`);
    // R3: no RESTORE_VERIFIED anywhere -> no backup artifact deleted
    if (!newestRv) assert.ok(![...deleted].some((k) => k.endsWith(".tar.enc")), `${ctx} R3`);
    // never: unrelated objects, objects newer than the cutoff, unparseable/future timestamps
    for (const o of listing.objects.filter((x) => deleted.has(x.key))) {
      assert.ok(o.key.includes("aee-protected-"), `${ctx} unrelated`);
      const t = new Date(o.lastModified).valueOf();
      assert.ok(!Number.isNaN(t) && t < cutoff.valueOf(), `${ctx} age floor ${o.key}`);
    }

    // AC3: PRESENT/INVALID objects never count toward keep: dropping every non-verified unit leaves
    // the set of deleted VERIFIED artifacts unchanged.
    const verifiedKeys = new Set(truth.filter(isVerifiedState).map((t) => t.key));
    const onlyVerified = listing.objects.filter((o) => [...verifiedKeys].some((k) => o.key === k || o.key.startsWith(`${k}.`)));
    const pv = planRetention(onlyVerified, cutoff, opts);
    const dv = (s: Set<string>) => new Set([...s].filter((k) => verifiedKeys.has(k)));
    assert.deepEqual(dv(new Set(keys(pv.delete))), dv(deleted), `${ctx} AC3`);

    // AC4: forging a marker (mismatching sha) can only reduce deletions of backup objects
    const victim = truth.find((t) => t.state === "PRESENT");
    if (victim) {
      const forgedKey = `${victim.key}${VERIFIED_SUFFIX}`;
      const objects = listing.objects.filter((o) => o.key !== forgedKey).concat({ key: forgedKey, lastModified: isoFor(1) });
      const evidence: EvidenceMap = { ...listing.evidence, [victim.key]: { ...listing.evidence[victim.key], verified: JSON.stringify({ version: 1, kind: "verified", artifact: basename(victim.key), sha256: sha("forged"), verifiedAt: "x" }) } };
      const pf = planRetention(objects, cutoff, { ...opts, evidence });
      assert.ok(subset(artifactDeletions(pf.delete), artifactDeletions(p.delete)), `${ctx} AC4 forge`);
    }
    // AC4: removing a marker can only reduce deletions
    const marker = listing.objects.find((o) => o.key.endsWith(VERIFIED_SUFFIX) || o.key.endsWith(RESTORE_VERIFIED_SUFFIX));
    if (marker) {
      const pr = planRetention(listing.objects.filter((o) => o !== marker), cutoff, opts);
      assert.ok(subset(new Set(keys(pr.delete)), deleted), `${ctx} AC4 remove`);
    }
  }
  assert.ok(withDeletions > 100, `property test must exercise deletions (got ${withDeletions})`);
});

// =============================================================================================
// R29b: D-9 chain integration (tiers, verified deletes, deletion records, staging sweep).
// =============================================================================================

const tierPolicy = (keep: number, retentionDays: number): TierPolicy => ({
  daily: { keep, retentionDays }, weekly: { keep, retentionDays }, monthly: { keep, retentionDays },
});
const planTiers = (l: Listing, keep: number, extra: { protectedArtifact?: string; retentionDays?: number } = {}) =>
  planTierRetention(l.objects, NOW, tierPolicy(keep, extra.retentionDays ?? 1), { retentionDays: extra.retentionDays ?? 1, minRetained: keep }, {
    evidence: l.evidence,
    ...(extra.protectedArtifact ? { protectedArtifact: extra.protectedArtifact } : {}),
  });

test("R29b T-keys: tier-folder markers are recognised backup keys; markers in another shape are flagged", () => {
  const a = artifactKey(1, "daily");
  assert.deepEqual(parseBackupKey(`${a}${VERIFIED_SUFFIX}`), { tier: "daily", name: `${basename(a)}${VERIFIED_SUFFIX}`, manifest: false, marker: "verified" });
  assert.deepEqual(parseBackupKey(`${a}${RESTORE_VERIFIED_SUFFIX}`), { tier: "daily", name: `${basename(a)}${RESTORE_VERIFIED_SUFFIX}`, manifest: false, marker: "restore-verified" });
  assert.equal(parseBackupKey(`${a}.verified.json.bak`), null);
  assert.deepEqual(assessListing(restoreVerified(1, { tier: "daily" }).objects), { listed: 4, recognised: 4, unrecognisedBackupLike: 0 });
  assert.deepEqual(assessListing(verified(1).objects), { listed: 3, recognised: 3, unrecognisedBackupLike: 0 }, "legacy flat markers");
  assert.equal(assessListing([{ key: `s3://bucket/${a}${VERIFIED_SUFFIX}`, lastModified: isoFor(1) }]).unrecognisedBackupLike, 1);
});

test("R29b R2 (tiered): the newest RESTORE_VERIFIED backup in ANY tier is protected and bounds deletions in every tier", () => {
  const listing = merge(
    restoreVerified(10, { tier: "weekly" }), verified(20, { tier: "weekly" }), verified(21, { tier: "weekly" }), verified(5, { tier: "weekly" }),
    verified(30, { tier: "daily" }), verified(31, { tier: "daily" }), verified(32, { tier: "daily" }), verified(3, { tier: "daily" }),
  );
  const p = planTiers(listing, 2);
  const deleted = keys(p.delete);
  assert.ok(!deleted.some((k) => k.startsWith(artifactKey(10, "weekly"))), "the global newest RESTORE_VERIFIED survives although weekly keep=2 is satisfied by newer copies");
  assert.ok(p.retained.weekly!.includes(basename(artifactKey(10, "weekly"))));
  // Only units older than the global restore point (day 10) are deletable: weekly 5 and daily 3; daily 30 is not
  // deletable although it is outside daily's keep of 2 and past the age floor.
  assert.deepEqual(deleted.filter((k) => k.endsWith(".tar.enc")).sort(), [artifactKey(3, "daily"), artifactKey(5, "weekly")].sort());
  assert.equal(p.states.weekly?.restoreVerified, 1);
  assert.equal(p.states.daily?.verified, 4);
});

test("R29b R3 (tiered): with no RESTORE_VERIFIED in any tier or the legacy layout, no backup unit is deleted anywhere", () => {
  const listing = merge(
    ...[1, 2, 3, 4].map((d) => verified(d, { tier: "daily" })),
    ...[1, 2, 3].map((d) => verified(d, { tier: "weekly" })),
    ...[1, 2, 3].map((d) => verified(d)),
    bk(6, { tier: "daily", artifact: false }),
  );
  const p = planTiers(listing, 1);
  assert.deepEqual(keys(p.delete), [`${artifactKey(6, "daily")}.sha256.json`], "only the INVALID orphan manifest, by age");
});

test("R29b R2 (tiered): a RESTORE_VERIFIED in the legacy flat layout also counts as the global restore point", () => {
  const listing = merge(restoreVerified(50), ...[1, 2, 3].map((d) => verified(d, { tier: "daily" })));
  const p = planTiers(listing, 1);
  assert.deepEqual(keys(p.delete).filter((k) => k.endsWith(".tar.enc")).sort(), [artifactKey(1, "daily"), artifactKey(2, "daily")]);
});

test("R29b S11 (tiered planner): daily copy VERIFIED, weekly copy of the same run PRESENT; weekly deletes nothing", () => {
  const listing = merge(restoreVerified(5, { tier: "daily" }), verified(1, { tier: "daily" }), bk(5, { tier: "weekly" }), bk(1, { tier: "weekly" }));
  const p = planTiers(listing, 1);
  assert.deepEqual(p.states.daily, { present: 0, verified: 1, restoreVerified: 1, invalid: 0 });
  assert.deepEqual(p.states.weekly, { present: 2, verified: 0, restoreVerified: 0, invalid: 0 });
  assert.deepEqual(keys(p.delete).filter((k) => k.startsWith("weekly/")), [], "R1: weekly has 0 VERIFIED");
  assert.deepEqual(keys(p.delete), [artifactKey(1, "daily"), `${artifactKey(1, "daily")}.sha256.json`, `${artifactKey(1, "daily")}${VERIFIED_SUFFIX}`]);
});

test("R29b R4 (tiered): the run's own artifact is protected in every tier", () => {
  const listing = merge(...["daily", "weekly", "monthly"].flatMap((tier) => [restoreVerified(9, { tier }), verified(1, { tier }), verified(2, { tier })]));
  const p = planTiers(listing, 1, { protectedArtifact: basename(artifactKey(1)) });
  assert.ok(!keys(p.delete).some((k) => k.includes(basename(artifactKey(1)))));
  assert.equal(keys(p.delete).filter((k) => k.endsWith(".tar.enc")).length, 3, "day 2 in each tier");
});

// ---- engine (real createBackup against the shared fake remote) --------------------------------
const ENGINE_NOW = new Date("2027-03-01T00:00:00Z"); // Monday: daily only when tiered
const SUNDAY_THE_FIRST = new Date("2026-03-01T00:00:00Z");

function bodiesOf(evidence: EvidenceMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, ev] of Object.entries(evidence)) {
    if (ev.manifest) out[`${key}.sha256.json`] = ev.manifest;
    if (ev.verified) out[`${key}${VERIFIED_SUFFIX}`] = ev.verified;
    if (ev.restoreVerified) out[`${key}${RESTORE_VERIFIED_SUFFIX}`] = ev.restoreVerified;
  }
  return out;
}

async function engine(listing: Listing, options: Partial<FakeRemoteOptions> & { minRetained?: number } = {}): Promise<FakeRemote & { result: Promise<string> }> {
  const { minRetained, configOverrides, ...rest } = options;
  const remote = await createFakeRemote({
    prune: true,
    seed: listing.objects,
    seedMarkers: "none",
    seedBodies: bodiesOf(listing.evidence),
    retentionDays: 1,
    minRetainedBackups: minRetained ?? 1,
    now: ENGINE_NOW,
    ...rest,
    configOverrides: { ...(configOverrides ?? {}) },
  });
  const result = remote.createBackup();
  result.catch(() => undefined);
  return { ...remote, result };
}
const completed = (r: FakeRemote) => r.logs.find((l) => l.event === "completed");
const failedLog = (r: FakeRemote) => r.logs.find((l) => l.event === "failed");

test("R29b S2: a corrupt artifact (manifest sha mismatch at verify) gets no .verified.json, never lists or deletes", async () => {
  const r = await engine({ objects: [], evidence: {} }, { afterUpload: (u, o) => { if (o.endsWith(".tar.enc")) u.set(o, Buffer.from("corrupted")); } });
  try {
    await assert.rejects(r.result, /Post-upload verification failed/);
    assert.ok(![...r.uploaded.keys()].some((k) => k.endsWith(VERIFIED_SUFFIX)), "no marker written for a failed verification");
    assert.ok(!r.calls.includes("list"));
    assert.equal(failedLog(r)?.stage, "verify");
  } finally { await r.cleanup(); }
});

test("R29b S2b: a verified upload writes <artifact>.verified.json carrying the manifest sha256, with the writer identity, before the list", async () => {
  const r = await engine({ objects: [], evidence: {} });
  try {
    const name = await r.result;
    const body = JSON.parse(r.uploaded.get(`${name}${VERIFIED_SUFFIX}`)!.toString("utf8")) as Record<string, unknown>;
    const manifest = JSON.parse(r.uploaded.get(`${name}.sha256.json`)!.toString("utf8")) as { sha256: string };
    assert.deepEqual([body.version, body.kind, body.artifact, body.sha256], [1, "verified", name, manifest.sha256]);
    assert.ok(r.calls.indexOf(`upload:${name}${VERIFIED_SUFFIX}`) < r.calls.indexOf("list"), "marker upload happens before the prune listing");
    assert.ok(r.calls.indexOf(`upload:${name}${VERIFIED_SUFFIX}`) > r.calls.indexOf(`download:${name}.sha256.json`), "marker only after verification");
    assert.ok(r.operations.includes("upload:upload"), "the marker goes through the writer (upload) identity");
  } finally { await r.cleanup(); }
});

test("R29b S2c (tiered): on Sunday the 1st a marker is written for every tier copy, each carrying the manifest sha256", async () => {
  const r = await engine({ objects: [], evidence: {} }, { now: SUNDAY_THE_FIRST, configOverrides: { tierPolicy: tierPolicy(1, 1) } });
  try {
    const name = await r.result;
    for (const tier of ["daily", "weekly", "monthly"]) {
      const marker = JSON.parse(r.uploaded.get(`${tier}/${name}${VERIFIED_SUFFIX}`)!.toString("utf8")) as { sha256: string; artifact: string };
      const manifest = JSON.parse(r.uploaded.get(`${tier}/${name}.sha256.json`)!.toString("utf8")) as { sha256: string };
      assert.equal(marker.sha256, manifest.sha256, tier);
      assert.equal(marker.artifact, name);
    }
  } finally { await r.cleanup(); }
});

test("R29b S11 (engine, tiered): one tier copy failing verification fails the run before ANY marker is written (stricter than per-copy)", async () => {
  const r = await engine({ objects: [], evidence: {} }, {
    now: SUNDAY_THE_FIRST, configOverrides: { tierPolicy: tierPolicy(1, 1) },
    afterUpload: (u, o) => { if (o.startsWith("weekly/") && o.endsWith(".tar.enc")) u.set(o, Buffer.from("corrupted")); },
  });
  try {
    await assert.rejects(r.result, /Post-upload verification failed/);
    assert.deepEqual([...r.uploaded.keys()].filter((k) => k.endsWith(VERIFIED_SUFFIX)), []);
  } finally { await r.cleanup(); }
});

test("R29b S8: a marker PUT failing (quota/AccessDenied) fails the run as marker_write_failed and never lists or prunes", async () => {
  const r = await engine(merge(restoreVerified(1), verified(2)), { failUpload: /\.verified\.json$/ });
  try {
    await assert.rejects(r.result, /marker_write_failed/);
    assert.ok(!r.calls.includes("list"));
    assert.ok(!r.calls.some((c) => c.startsWith("remove")));
    assert.equal(failedLog(r)?.stage, "marker_write");
    assert.equal(r.alerts.length, 1);
    assert.match(r.alerts[0]!.error!, /^marker_write_failed: /);
    assert.ok(!r.alerts[0]!.error!.includes("aee-protected-"), "alert carries a fixed reason code only");
  } finally { await r.cleanup(); }
});

test("R29b S8b: an artifact upload failing fails the run as tier_upload and never prunes", async () => {
  const r = await engine({ objects: [], evidence: {} }, { failUpload: /\.tar\.enc$/ });
  try {
    await assert.rejects(r.result, /upload refused/);
    assert.equal(failedLog(r)?.stage, "tier_upload");
    assert.match(r.alerts[0]!.error!, /^tier_upload_failed: /);
    assert.ok(!r.calls.includes("list"));
  } finally { await r.cleanup(); }
});

test("R29b S9: deletions are re-validated against a fresh listing before the intent record; a changed plan aborts the prune", async () => {
  const first = merge(restoreVerified(10), verified(11), verified(1));
  const second = merge(first, verified(12), restoreVerified(13));
  const r = await engine(first, { relist: second.objects, seedBodies: bodiesOf(second.evidence) });
  try {
    await r.result;
    assert.deepEqual(r.removed, [], "no delete when the fresh listing changes the plan");
    assert.ok(r.logs.some((l) => l.event === "prune_aborted_listing_changed"));
    assert.ok(![...r.uploaded.keys()].some((k) => k.startsWith("deletion-records/")), "no intent record for an aborted prune");
    assert.equal(completed(r)?.pruneAborted, true);
    assert.equal(r.calls.filter((c) => c === "list").length, 2);
  } finally { await r.cleanup(); }
  const same = await engine(first);
  try {
    await same.result;
    assert.deepEqual(same.removed, [artifactKey(1), `${artifactKey(1)}.sha256.json`, `${artifactKey(1)}${VERIFIED_SUFFIX}`]);
    assert.equal(completed(same)?.prunedVerified, 3, "every delete of the unit (incl. the marker) confirmed by the D-9 verifier");
    assert.equal(completed(same)?.pruneAborted, false);
  } finally { await same.cleanup(); }
});

test("R29b D-9: marker deletes go through the mandatory verifier; the intent and outcome records list the unit's markers", async () => {
  const r = await engine(merge(restoreVerified(10), verified(11), verified(1)), { verifyDelete: {} });
  try {
    await r.result;
    const trail = r.calls.filter((c) => c.startsWith("remove:") || c.startsWith("verify-delete:"));
    assert.deepEqual(trail, [artifactKey(1), `${artifactKey(1)}.sha256.json`, `${artifactKey(1)}${VERIFIED_SUFFIX}`].flatMap((k) => [`remove:${k}`, `verify-delete:${k}`]));
    const runId = completed(r)!.runId as string;
    const intent = JSON.parse(r.uploaded.get(`deletion-records/${runId}.intent.json`)!.toString("utf8"));
    assert.deepEqual(intent.units, [{ artifact: artifactKey(1), manifest: `${artifactKey(1)}.sha256.json`, markers: [`${artifactKey(1)}${VERIFIED_SUFFIX}`] }]);
    const outcome = JSON.parse(r.uploaded.get(`deletion-records/${runId}.outcome.json`)!.toString("utf8"));
    assert.equal(outcome.units[0].status, "deleted_verified");
  } finally { await r.cleanup(); }
});

test("R29b D-9: a marker delete that is not verified stops pruning (backup itself already deleted) and alerts", async () => {
  const r = await engine(merge(restoreVerified(10), verified(11), verified(1), verified(2)), { verifyDelete: { stillPresent: /\.verified\.json$/ } });
  try {
    await r.result;
    const runId = completed(r)!.runId as string;
    const outcome = JSON.parse(r.uploaded.get(`deletion-records/${runId}.outcome.json`)!.toString("utf8"));
    assert.deepEqual(outcome.units.map((u: { status: string }) => u.status), ["marker_delete_not_verified_backup_deleted", "not_attempted_pruning_stopped"]);
    assert.equal(outcome.stopped, true);
    assert.equal(r.alerts.length, 1);
    assert.equal(r.alerts[0]!.status, "prune_delete_refused");
    assert.equal(completed(r)?.pruneStopped, true);
  } finally { await r.cleanup(); }
});

test("R29b evidence: manifest/marker bodies are read through the read-only verifier download identity, never the delete identity", async () => {
  const r = await engine(merge(restoreVerified(10), verified(11), verified(1)), {
    configOverrides: { verifyDownload: { executable: "verify-download", args: [] } },
  });
  try {
    await r.result;
    const afterList = r.operations.slice(r.operations.indexOf("list:list") + 1);
    const reads = afterList.filter((o) => o.startsWith("verify-download:") || o.startsWith("download:"));
    assert.ok(reads.length > 0);
    assert.ok(reads.every((o) => o === "verify-download:verify_download"), JSON.stringify(reads));
    assert.ok(r.removed.length === 3);
  } finally { await r.cleanup(); }
});

test("R29b AC7: the engine logs retention_plan with per-state counts per tier/legacy, no object keys; marker alerts are key-free", async () => {
  const listing = merge(restoreVerified(1), bk(2), bk(3, { verified: "mismatch" }), verified(4, { artifact: false }));
  const r = await engine(listing);
  try {
    await r.result;
    const entry = r.logs.find((l) => l.event === "retention_plan");
    assert.ok(entry, "retention_plan logged");
    assert.equal(entry.level, "warn");
    assert.deepEqual((entry.states as Record<string, unknown>).legacy, { present: 2, verified: 0, restoreVerified: 1, invalid: 2 });
    assert.ok(!JSON.stringify(entry).includes("aee-protected-"), "no object keys in the plan log");
    assert.deepEqual(r.alerts.map((a) => a.error).sort(), ["retention_marker_mismatch", "retention_marker_orphan"]);
    assert.ok(!JSON.stringify(r.alerts).includes("aee-protected-"));
  } finally { await r.cleanup(); }
});

test("R29b legacy: marker-less pre-R29b backups are never deleted by the engine (R5: nothing VERIFIED until markers exist)", async () => {
  const listing = merge(bk(1), bk(2), bk(3), bk(4));
  const r = await engine(listing);
  try {
    await r.result;
    assert.deepEqual(r.removed, []);
    assert.equal(completed(r)?.verified, true);
  } finally { await r.cleanup(); }
});

test("R29b staging sweep: a stale backup run directory holding the writer's marker and retention evidence is swept, not 'ambiguous'", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-r29b-sweep-"));
  try {
    const dir = path.join(root, "backup-0123456789abcdef");
    await mkdir(path.join(dir, "retention"), { recursive: true });
    const name = basename(artifactKey(1));
    await writeFile(path.join(dir, name), "enc");
    await writeFile(path.join(dir, `${name}.sha256.json`), "{}");
    await writeFile(path.join(dir, `${name}${VERIFIED_SUFFIX}`), "{}");
    await writeFile(path.join(dir, "retention", "evidence-0.json"), "{}");
    const old = new Date("2026-01-01T00:00:00Z");
    await writeRunMarker(dir, { ...newRunMarker("0123456789abcdef", "backup", old), pid: 999_999, state: "uploaded_verified" });
    const report = await sweepStaging({ stagingDirectory: root, mode: "dry-run", minAgeMs: 3_600_000, now: () => new Date("2026-01-03T00:00:00Z"), isPidAlive: () => false });
    assert.deepEqual(report.entries.map((e) => e.decision), ["would_remove"], JSON.stringify(report.entries));
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- AC5 (tiered): property test over planTierRetention -------------------------------------
function randomTiered(r: () => number) {
  const tiers = ["", "daily", "weekly", "monthly"];
  const parts: Listing[] = [];
  const truth: Truth[] = [];
  const used = new Set<string>();
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const count = Math.floor(r() * 18);
  for (let i = 0; i < count; i++) {
    const tier = pick(tiers);
    const day = 1 + Math.floor(r() * 200);
    const hour = Math.floor(r() * 24);
    const key = artifactKey(day, tier, hour);
    if (used.has(key)) continue;
    used.add(key);
    const artifact = r() > 0.1;
    const manifest = r() > 0.15;
    const vm: MarkerKind = pick(["ok", "ok", "ok", "mismatch", "garbage", false, false]);
    const rmk: MarkerKind = pick(["ok", "mismatch", false, false, false, false]);
    const t = r();
    const lastModified = t < 0.04 ? "garbage" : t < 0.08 ? "2099-06-01T00:00:00Z" : isoFor(day, hour);
    parts.push(bk(day, { tier, hour, artifact, manifest, verified: vm, restore: rmk, lastModified }));
    const time = new Date(lastModified).valueOf();
    const valid = artifact && !Number.isNaN(time) && time <= NOW.valueOf();
    const isV = valid && manifest && vm === "ok";
    truth.push({ key, tier, time, state: !artifact ? "NONE" : isV ? (rmk === "ok" ? "RESTORE_VERIFIED" : "VERIFIED") : "PRESENT" });
  }
  if (r() < 0.2) parts.push({ objects: [{ key: "yearly/report.csv", lastModified: "2000-01-01T00:00:00Z" }], evidence: {} });
  const listing = merge(...parts);
  listing.objects.sort(() => r() - 0.5);
  const keep = 1 + Math.floor(r() * 4);
  const cutoff = new Date(isoFor(1 + Math.floor(r() * 220)));
  return { listing, truth, keep, retentionDays: (NOW.valueOf() - cutoff.valueOf()) / 86_400_000, cutoff };
}

test("R29b AC5 property (tiered): >= 1,000 random tiered listings satisfy AC1–AC4 with global R2/R3", () => {
  const SEED = 0x29b0d9;
  const r = rng(SEED);
  let withDeletions = 0;
  for (let i = 0; i < 1000; i++) {
    const { listing, truth, keep, retentionDays, cutoff } = randomTiered(r);
    const ctx = `seed=${SEED} case=${i}`;
    const run = (objects: RemoteObject[], evidence: EvidenceMap) =>
      planTierRetention(objects, NOW, tierPolicy(keep, retentionDays), { retentionDays, minRetained: keep }, { evidence });
    const p = run(listing.objects, listing.evidence);
    const deleted = new Set(keys(p.delete));
    if ([...deleted].some((k) => k.endsWith(".tar.enc"))) withDeletions += 1;
    assert.deepEqual(run(listing.objects, listing.evidence), p, `${ctx} deterministic`);
    assert.deepEqual(new Set(keys(run([...listing.objects].reverse(), listing.evidence).delete)), deleted, `${ctx} order`);
    for (const tier of new Set(truth.map((t) => t.tier))) {
      const top = truth.filter((t) => t.tier === tier && isVerifiedState(t)).sort((a, b) => b.time - a.time).slice(0, keep);
      for (const t of top) assert.ok(!deleted.has(t.key), `${ctx} AC1 ${t.key}`);
      if (!truth.some((t) => t.tier === tier && isVerifiedState(t))) {
        const inTier = [...deleted].filter((k) => (k.includes("/") ? k.slice(0, k.indexOf("/")) : "") === tier);
        assert.deepEqual(inTier, [], `${ctx} AC2 ${tier}`);
      }
    }
    const newestRv = truth.filter((t) => t.state === "RESTORE_VERIFIED").sort((a, b) => b.time - a.time)[0];
    if (newestRv) assert.ok(!deleted.has(newestRv.key), `${ctx} R2 global`);
    else assert.ok(![...deleted].some((k) => k.endsWith(".tar.enc")), `${ctx} R3 global`);
    for (const k of deleted) {
      if (k.endsWith(".tar.enc") && newestRv) {
        const t = truth.find((x) => x.key === k)!;
        assert.ok(t.time < newestRv.time, `${ctx} older than the global restore point`);
      }
      const o = listing.objects.find((x) => x.key === k)!;
      assert.ok(k.includes("aee-protected-") && new Date(o.lastModified).valueOf() < cutoff.valueOf() + 1, `${ctx} age floor ${k}`);
    }
    const marker = listing.objects.find((o) => o.key.endsWith(VERIFIED_SUFFIX) || o.key.endsWith(RESTORE_VERIFIED_SUFFIX));
    if (marker) {
      const pr = run(listing.objects.filter((o) => o !== marker), listing.evidence);
      assert.ok(subset(new Set(keys(pr.delete)), deleted), `${ctx} AC4 remove`);
    }
  }
  assert.ok(withDeletions > 50, `tiered property test must exercise deletions (got ${withDeletions})`);
});
