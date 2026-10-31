// Owner t222u (31 Oct 2026): catalogue (Grow $139, Run $289 incl. Grow, $69 Starter not offered to NEW
// subscriptions, existing Starter untouched), trials expire on their recorded end date without a provider
// notification, free run.access inventory (dry-run only), and configurable calling metering/limits that
// default to unlimited. Synthetic data only, throwaway DB.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  db, entitlementGrants, subscriptions, parties, growCallSessions, growCallTranscriptions, documents, platformOwners, ENTITLEMENT_KEYS,
} from "@aee/db";
import { invalidateEntitlementCache, resolveEntitlements } from "../../lib/entitlements/resolver.js";
import {
  ensureCatalogueSeeded, GROW_PRODUCT_CODE, STARTER_PRODUCT_CODE, BUNDLE_PRODUCT_CODE, OFFERED_PRODUCT_CODES, CATALOGUE_PRICES_CENTS,
} from "../../lib/billing/catalogue.js";
import { applySubscriptionSnapshot } from "../../lib/billing/sync.js";
import { planFreeRunAccessRemoval } from "../../lib/billing/freeRunAccessInventory.js";
import { getCallUsage, resolveCallUsageLimits, checkCallUsage, CALL_USAGE_METRICS } from "../../lib/telephony/callUsage.js";
import { createBrokerageWithUsers, cleanupBrokerages } from "./testSupport.js";

const ALL = [...ENTITLEMENT_KEYS].sort();
const SOURCE = { actorType: "SYSTEM" as const, actorId: null, label: "test:t222u" };
const tag = `t222u-${process.pid}-${Date.now()}`;
let server: Server; let baseUrl = ""; const created: number[] = [];

before(async () => {
  const { configureEvents } = await import("../../lib/events.js"); configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const a = server.address(); if (!a || typeof a === "string") throw new Error("addr");
  baseUrl = `http://127.0.0.1:${a.port}`;
  await ensureCatalogueSeeded();
});
after(async () => {
  try { await cleanupBrokerages(created); } catch { /* throwaway DB: billing rows may hold FKs */ }
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

async function brokerage(label: string, keepMigrationRun = false) {
  const b = await createBrokerageWithUsers(baseUrl, `${tag} ${label}`);
  created.push(b.brokerageId);
  if (!keepMigrationRun) {
    await db.delete(entitlementGrants).where(and(eq(entitlementGrants.brokerageId, b.brokerageId), eq(entitlementGrants.sourceType, "migration")));
  }
  invalidateEntitlementCache(b.brokerageId);
  return b;
}
async function sync(brokerageId: number, productCode: string, status: string, ref: string, extra: Record<string, unknown> = {}) {
  await applySubscriptionSnapshot({
    subscriptionRef: ref, customerRef: `${ref}-c`, status, productCode, brokerageId,
    currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 864e5), cancelAtPeriodEnd: false, ...extra,
  } as never, SOURCE);
  invalidateEntitlementCache(brokerageId);
}
async function keys(brokerageId: number) {
  invalidateEntitlementCache(brokerageId);
  return [...(await resolveEntitlements({ id: -1, role: "system", brokerageId } as never))].sort();
}
async function api(path: string, cookie: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", cookie, ...(init.headers ?? {}) } });
}

// ── 1. Catalogue ─────────────────────────────────────────────────────────────
test("catalogue: seed prices are Grow $139 and Run (incl. Grow) $289; $69 Starter is not offered", () => {
  assert.equal(CATALOGUE_PRICES_CENTS[GROW_PRODUCT_CODE], 13900);
  assert.equal(CATALOGUE_PRICES_CENTS[BUNDLE_PRODUCT_CODE], 28900);
  assert.deepEqual([...OFFERED_PRODUCT_CODES].sort(), [BUNDLE_PRODUCT_CODE, GROW_PRODUCT_CODE].sort());
  assert.ok(!OFFERED_PRODUCT_CODES.includes(STARTER_PRODUCT_CODE));
});

test("catalogue: GET /billing/catalogue hides Starter; POST /billing/checkout refuses Starter for a new subscription", async () => {
  const b = await brokerage("offer");
  const res = await api("/api/billing/catalogue", b.admin.cookie);
  assert.equal(res.status, 200);
  const codes = ((await res.json()) as { products: { code: string }[] }).products.map((p) => p.code);
  assert.ok(!codes.includes(STARTER_PRODUCT_CODE), codes.join());
  assert.ok(codes.includes(GROW_PRODUCT_CODE) && codes.includes(BUNDLE_PRODUCT_CODE), codes.join());
  const co = await api("/api/billing/checkout", b.admin.cookie, { method: "POST", body: JSON.stringify({ productCode: STARTER_PRODUCT_CODE }) });
  assert.equal(co.status, 410);
  assert.deepEqual(await keys(b.brokerageId), [], "refused checkout grants nothing");
});

test("catalogue: an EXISTING Starter subscription is not altered (still syncs and keeps Run + Grow)", async () => {
  const b = await brokerage("legacy-starter");
  await sync(b.brokerageId, STARTER_PRODUCT_CODE, "Active", `${tag}-legacy`);
  assert.deepEqual(await keys(b.brokerageId), ALL);
});

// ── 2. Unsubscribed ──────────────────────────────────────────────────────────
test("unsubscribed: no grow.* and no run.access from the subscription model; billing/subscription still answers (onboarding)", async () => {
  const b = await brokerage("unsubscribed");
  assert.deepEqual(await keys(b.brokerageId), []);
  const res = await api("/api/billing/subscription", b.admin.cookie);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { subscription: unknown; entitlements: string[] };
  assert.equal(body.subscription, null);
  assert.deepEqual(body.entitlements, []);
  const growRes = await api("/api/grow/contacts", b.admin.cookie);
  assert.equal(growRes.status, 403);
});

// ── 3. Trial expiry on the recorded end date ─────────────────────────────────
test("trial: trial end is stored on sync and grants stop at that date with no provider notification", async () => {
  const b = await brokerage("trial-lapsed");
  const past = new Date(Date.now() - 60_000);
  await sync(b.brokerageId, BUNDLE_PRODUCT_CODE, "Trialing", `${tag}-tl`, { trialEnd: past });
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.brokerageId, b.brokerageId));
  assert.equal(sub!.trialEndsAt?.getTime(), past.getTime());
  assert.deepEqual(await keys(b.brokerageId), [], "expired trial: no access although the provider still says Trialing");
});

test("trial: a current trial grants until its end; conversion to Active clears the end date", async () => {
  const b = await brokerage("trial-live");
  const future = new Date(Date.now() + 7 * 864e5);
  await sync(b.brokerageId, BUNDLE_PRODUCT_CODE, "Trialing", `${tag}-tv`, { trialEnd: future });
  assert.deepEqual(await keys(b.brokerageId), ALL);
  const ends = await db.select({ endsAt: entitlementGrants.endsAt }).from(entitlementGrants)
    .where(and(eq(entitlementGrants.brokerageId, b.brokerageId), eq(entitlementGrants.status, "Active")));
  assert.ok(ends.length > 0 && ends.every((g) => g.endsAt?.getTime() === future.getTime()));
  await sync(b.brokerageId, BUNDLE_PRODUCT_CODE, "Active", `${tag}-tv`);
  const after = await db.select({ endsAt: entitlementGrants.endsAt }).from(entitlementGrants)
    .where(and(eq(entitlementGrants.brokerageId, b.brokerageId), eq(entitlementGrants.status, "Active")));
  assert.ok(after.length > 0 && after.every((g) => g.endsAt === null));
  assert.deepEqual(await keys(b.brokerageId), ALL);
});

test("trial: a later Trialing sync without a trial end keeps the stored end date (fail closed)", async () => {
  const b = await brokerage("trial-keep");
  const past = new Date(Date.now() - 1000);
  await sync(b.brokerageId, GROW_PRODUCT_CODE, "Trialing", `${tag}-tk`, { trialEnd: past });
  await sync(b.brokerageId, GROW_PRODUCT_CODE, "Trialing", `${tag}-tk`);
  assert.deepEqual(await keys(b.brokerageId), []);
});

// ── 4. Free run.access inventory (dry run only) ──────────────────────────────
test("free run.access inventory: classifies migration grants; protects trial, platform-owner and named test brokerages", async () => {
  const lose = await brokerage("inv-lose", true);
  const paid = await brokerage("inv-paid", true);
  await sync(paid.brokerageId, BUNDLE_PRODUCT_CODE, "Active", `${tag}-inv-paid`);
  const trial = await brokerage("inv-trial", true);
  await sync(trial.brokerageId, BUNDLE_PRODUCT_CODE, "Trialing", `${tag}-inv-trial`, { trialEnd: new Date(Date.now() + 864e5) });
  const owner = await brokerage("inv-owner", true);
  await db.insert(platformOwners).values({ userId: owner.admin.user.id });
  const qa = await brokerage("inv-QA", true);
  const before = await db.select().from(entitlementGrants);
  const plan = await planFreeRunAccessRemoval({ protectBrokerageIds: [qa.brokerageId] });
  const after = await db.select().from(entitlementGrants);
  assert.equal(after.length, before.length, "inventory writes nothing");
  const cls = (id: number) => plan.rows.find((r) => r.brokerageId === id)?.classification;
  assert.equal(cls(lose.brokerageId), "WOULD_LOSE_RUN_ACCESS");
  assert.equal(cls(paid.brokerageId), "REDUNDANT_PAID_RUN");
  assert.equal(cls(trial.brokerageId), "PROTECTED_AUTHORISED_TRIAL");
  assert.equal(cls(owner.brokerageId), "PROTECTED_PLATFORM_ADMIN");
  assert.equal(cls(qa.brokerageId), "PROTECTED_TEST_OR_ALLOWLIST");
  assert.ok(plan.counts.WOULD_LOSE_RUN_ACCESS >= 1);
  await db.delete(platformOwners).where(eq(platformOwners.userId, owner.admin.user.id));
});

// ── 6. Calling metering ──────────────────────────────────────────────────────
test("calling: limits default to unlimited/disabled; metering counts calls, minutes, recordings, transcriptions per brokerage", async () => {
  assert.deepEqual(CALL_USAGE_METRICS, ["calls", "minutes", "recordings", "transcriptions"]);
  const none = resolveCallUsageLimits({});
  for (const m of CALL_USAGE_METRICS) assert.equal(none[m], null);
  assert.equal(resolveCallUsageLimits({ AE_CALL_USAGE_LIMITS: "not json" }).calls, null, "bad config fails open to unlimited, never invents a cap");

  const a = await brokerage("call-a"); const other = await brokerage("call-b");
  const [party] = await db.insert(parties).values({ brokerageId: a.brokerageId, firstName: "Meter", lastName: "Synthetic", mobile: "+61400111222" }).returning();
  for (const secs of [61, 120]) {
    const [s] = await db.insert(growCallSessions).values({
      brokerageId: a.brokerageId, partyId: party!.id, initiatedByUserId: a.admin.user.id, destinationRaw: "+61400111222",
      destinationNormalized: "+61400111222", destinationCountry: "AU", provider: "synthetic", status: "COMPLETED", durationSeconds: secs, endedAt: new Date(),
    }).returning();
    if (secs === 120) {
      await db.insert(documents).values({ brokerageId: a.brokerageId, logicalOwnerType: "telephony-call", logicalOwnerId: s!.id, documentType: "CallRecording", title: "synthetic", status: "Generated" });
      await db.insert(growCallTranscriptions).values({ brokerageId: a.brokerageId, callSessionId: s!.id, partyId: party!.id, processingState: "PENDING" });
    }
  }
  const u = await getCallUsage(a.brokerageId);
  assert.deepEqual({ calls: u.calls, minutes: u.minutes, recordings: u.recordings, transcriptions: u.transcriptions }, { calls: 2, minutes: 4, recordings: 1, transcriptions: 1 });
  const uo = await getCallUsage(other.brokerageId);
  assert.equal(uo.calls, 0, "brokerage isolation");

  assert.equal((await checkCallUsage(a.brokerageId, "calls", {})).allowed, true, "no limits configured: allowed");
  const capped = { calls: 2, minutes: null, recordings: null, transcriptions: null };
  const d = await checkCallUsage(a.brokerageId, "calls", capped);
  assert.equal(d.allowed, false); assert.equal(d.used, 2); assert.equal(d.limit, 2);
  assert.equal((await checkCallUsage(other.brokerageId, "calls", capped)).allowed, true);
});
