// RUN-INCLUDES-GROW (Owner decisions t220u, 2026-10-31): a Run (Starter) subscription includes every Grow
// entitlement through the subscription model; unsubscribed brokerages get no paid Grow; trials are
// Trialing subscriptions; cancellation/expiry revokes. AI stays behind the daily usage limits.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  db, entitlementGrants, aiInteractions, subscriptions, productEntitlements, entitlementDefinitions, products, users, ENTITLEMENT_KEYS,
} from "@aee/db";
import { invalidateEntitlementCache, resolveEntitlements } from "../../lib/entitlements/resolver.js";
import { ensureCatalogueSeeded, GROW_PRODUCT_CODE, STARTER_PRODUCT_CODE, BUNDLE_PRODUCT_CODE } from "../../lib/billing/catalogue.js";
import { applySubscriptionSnapshot } from "../../lib/billing/sync.js";
import { backfillRunSubscriptionEntitlements } from "../../lib/billing/runIncludesGrowBackfill.js";
import { MockAiProvider } from "../../lib/ai/providers/mockProvider.js";
import { _resetGrowRateLimiterForTests } from "../../lib/ai/growRateLimiter.js";
import { createBrokerageWithUsers, devLogin, cleanupBrokerages } from "./testSupport.js";

const ALL = [...ENTITLEMENT_KEYS].sort();
const GROW = ALL.filter((k) => k !== "run.access");
const SOURCE = { actorType: "SYSTEM" as const, actorId: null, label: "test:run-includes-grow" };
const tag = `rig-${process.pid}-${Date.now()}`;
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

async function brokerage(label: string, opts: { keepMigrationRun?: boolean } = {}) {
  const b = await createBrokerageWithUsers(baseUrl, `${tag} ${label}`);
  created.push(b.brokerageId);
  if (!opts.keepMigrationRun) {
    // dev-login's migration run.access grant is not a subscription; remove it so we see the subscription alone.
    await db.delete(entitlementGrants).where(and(eq(entitlementGrants.brokerageId, b.brokerageId), eq(entitlementGrants.sourceType, "migration")));
    invalidateEntitlementCache(b.brokerageId);
  }
  return b;
}
async function sync(brokerageId: number, productCode: string, status: string, ref: string, extra: Record<string, unknown> = {}) {
  await applySubscriptionSnapshot({
    subscriptionRef: ref, customerRef: `${ref}-cust`, status, productCode, brokerageId,
    currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 864e5), cancelAtPeriodEnd: false, ...extra,
  } as never, SOURCE);
  invalidateEntitlementCache(brokerageId);
}
async function keys(brokerageId: number) {
  invalidateEntitlementCache(brokerageId);
  return [...(await resolveEntitlements({ id: -1, role: "system", brokerageId } as never))].sort();
}
async function productKeys(code: string) {
  const rows = await db.select({ key: entitlementDefinitions.key }).from(productEntitlements)
    .innerJoin(entitlementDefinitions, eq(productEntitlements.entitlementDefinitionId, entitlementDefinitions.id))
    .innerJoin(products, eq(productEntitlements.productId, products.id))
    .where(and(eq(products.code, code), eq(productEntitlements.enabled, true)));
  return rows.map((r) => r.key).sort();
}
async function subIdFor(brokerageId: number) {
  const [s] = await db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.brokerageId, brokerageId));
  return s!.id;
}
/** Simulates a Starter subscription synced before this change: only its run.access grant exists. */
async function legacyStarter(label: string, status = "Active", extra: Record<string, unknown> = {}) {
  const b = await brokerage(label);
  await sync(b.brokerageId, STARTER_PRODUCT_CODE, status, `${tag}-${label}`);
  // The normalized snapshot carries no trial end date (sync never writes trialEndsAt); set it directly.
  if (extra.trialEndsAt) await db.update(subscriptions).set({ trialEndsAt: extra.trialEndsAt as Date }).where(eq(subscriptions.brokerageId, b.brokerageId));
  await db.delete(entitlementGrants).where(and(eq(entitlementGrants.brokerageId, b.brokerageId), inArray(entitlementGrants.entitlementKey, GROW as never[])));
  invalidateEntitlementCache(b.brokerageId);
  assert.deepEqual(await keys(b.brokerageId), status === "Active" || status === "Trialing" ? ["run.access"] : []);
  return b;
}

test("catalogue: Starter (Run) carries every Grow key plus run.access; Grow never carries run.access; bundle carries all", async () => {
  assert.deepEqual(await productKeys(STARTER_PRODUCT_CODE), ALL);
  assert.deepEqual(await productKeys(GROW_PRODUCT_CODE), GROW);
  assert.deepEqual(await productKeys(BUNDLE_PRODUCT_CODE), ALL);
});

test("Run subscriber (Active Starter) resolves every Grow key incl. grow.access, grow.contacts.read, AI and calling", async () => {
  const b = await brokerage("run-active");
  await sync(b.brokerageId, STARTER_PRODUCT_CODE, "Active", `${tag}-run-active`);
  const k = await keys(b.brokerageId);
  assert.deepEqual(k, ALL);
  for (const key of ["grow.access", "grow.contacts.read", "grow.ai.use", "grow.calling.access", "grow.calling.recording", "grow.calling.transcription"]) assert.ok((k as string[]).includes(key), key);
});

test("authorised trial = Trialing Starter subscription: all keys; trial Ended revokes them all", async () => {
  const b = await brokerage("run-trial");
  await sync(b.brokerageId, STARTER_PRODUCT_CODE, "Trialing", `${tag}-run-trial`, { trialEndsAt: new Date(Date.now() + 7 * 864e5) });
  assert.deepEqual(await keys(b.brokerageId), ALL);
  await sync(b.brokerageId, STARTER_PRODUCT_CODE, "Ended", `${tag}-run-trial`);
  assert.deepEqual(await keys(b.brokerageId), []);
});

test("cancelled Run subscription revokes run.access and every Grow key", async () => {
  const b = await brokerage("run-cancel");
  await sync(b.brokerageId, STARTER_PRODUCT_CODE, "Active", `${tag}-run-cancel`);
  await sync(b.brokerageId, STARTER_PRODUCT_CODE, "Cancelled", `${tag}-run-cancel`);
  assert.deepEqual(await keys(b.brokerageId), []);
});

test("Grow-only subscriber: Grow keys, never run.access; bundle: everything", async () => {
  const g = await brokerage("grow-only");
  await sync(g.brokerageId, GROW_PRODUCT_CODE, "Active", `${tag}-grow-only`);
  assert.deepEqual(await keys(g.brokerageId), GROW);
  const bu = await brokerage("bundle");
  await sync(bu.brokerageId, BUNDLE_PRODUCT_CODE, "Active", `${tag}-bundle`);
  assert.deepEqual(await keys(bu.brokerageId), ALL);
});

test("unsubscribed brokerage (no subscription, no trial) gets NO Grow entitlement; dev-login creation unchanged (run.access migration grant only)", async () => {
  const b = await brokerage("unsubscribed", { keepMigrationRun: true });
  assert.deepEqual(await keys(b.brokerageId), ["run.access"]);
  const res = await fetch(`${baseUrl}/api/grow/contacts`, { headers: { cookie: b.admin.cookie } });
  assert.equal(res.status, 403);
});

test("backfill: dry-run writes nothing; apply adds missing Grow grants only to active/trialing Run subscriptions; idempotent; never revokes", async () => {
  const legacy = await legacyStarter("bf-legacy");
  const trial = await legacyStarter("bf-trial", "Trialing", { trialEndsAt: new Date(Date.now() + 5 * 864e5) });
  const lapsedTrial = await legacyStarter("bf-lapsed", "Trialing", { trialEndsAt: new Date(Date.now() - 864e5) });
  const cancelled = await brokerage("bf-cancelled");
  await sync(cancelled.brokerageId, STARTER_PRODUCT_CODE, "Active", `${tag}-bf-cancelled`);
  await sync(cancelled.brokerageId, STARTER_PRODUCT_CODE, "Cancelled", `${tag}-bf-cancelled`);
  const unsub = await brokerage("bf-unsub", { keepMigrationRun: true });
  const growOnly = await brokerage("bf-grow");
  await sync(growOnly.brokerageId, GROW_PRODUCT_CODE, "Active", `${tag}-bf-grow`);
  const mine = new Set([legacy, trial, lapsedTrial, cancelled, unsub, growOnly].map((b) => b.brokerageId));

  const countBefore = (await db.select({ id: entitlementGrants.id }).from(entitlementGrants)).length;
  const dry = await backfillRunSubscriptionEntitlements({ dryRun: true });
  assert.equal((await db.select({ id: entitlementGrants.id }).from(entitlementGrants)).length, countBefore, "dry-run must not write");
  const planned = dry.planned.filter((p) => mine.has(p.brokerageId));
  assert.deepEqual([...new Set(planned.map((p) => p.brokerageId))].sort(), [legacy.brokerageId, trial.brokerageId].sort());
  assert.equal(planned.length, GROW.length * 2);
  assert.ok(dry.skippedLapsedTrials.some((s) => s.brokerageId === lapsedTrial.brokerageId));

  const applied = await backfillRunSubscriptionEntitlements({ dryRun: false });
  assert.equal(applied.inserted.filter((p) => mine.has(p.brokerageId)).length, GROW.length * 2);
  assert.deepEqual(await keys(legacy.brokerageId), ALL);
  assert.deepEqual(await keys(trial.brokerageId), ALL);
  assert.deepEqual(await keys(lapsedTrial.brokerageId), ["run.access"]);
  assert.deepEqual(await keys(cancelled.brokerageId), []);
  assert.deepEqual(await keys(unsub.brokerageId), ["run.access"]);
  assert.deepEqual(await keys(growOnly.brokerageId), GROW);

  const again = await backfillRunSubscriptionEntitlements({ dryRun: false });
  assert.equal(again.inserted.filter((p) => mine.has(p.brokerageId)).length, 0, "idempotent");

  // Backfilled grants belong to the subscription, so cancelling it revokes them.
  await sync(legacy.brokerageId, STARTER_PRODUCT_CODE, "Cancelled", `${tag}-bf-legacy`);
  assert.deepEqual(await keys(legacy.brokerageId), []);
  const [g] = await db.select().from(entitlementGrants).where(and(eq(entitlementGrants.brokerageId, legacy.brokerageId), eq(entitlementGrants.entitlementKey, "grow.contacts.read")));
  assert.equal(g!.sourceType, "subscription");
  assert.equal(g!.sourceId, await subIdFor(legacy.brokerageId));
});

test("Run subscriber roles: BA, Agent and Pit Crew read Grow contacts; another brokerage's contact is 404", async () => {
  const other = await brokerage("iso-other");
  await sync(other.brokerageId, BUNDLE_PRODUCT_CODE, "Active", `${tag}-iso-other`);
  const oc = await fetch(`${baseUrl}/api/grow/contacts`, { method: "POST", headers: { cookie: other.admin.cookie, "content-type": "application/json" }, body: JSON.stringify({ firstName: "Iso", lastName: "Other", email: `iso-${tag}@example.com` }) });
  const ob = (await oc.json()) as { contact?: { id: number }; id?: number };
  const otherContact = ob.contact?.id ?? ob.id;
  assert.ok(otherContact, `other contact ${oc.status}`);

  const b = await brokerage("roles");
  await sync(b.brokerageId, STARTER_PRODUCT_CODE, "Active", `${tag}-roles`);
  const pcEmail = `pc-${tag}@example.com`;
  const first = await devLogin(baseUrl, { email: pcEmail, firstName: "Pit", lastName: "Crew", brokerageName: `${tag} roles` });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, first.user.id));
  const pc = await devLogin(baseUrl, { email: pcEmail, firstName: "Pit", lastName: "Crew", brokerageName: `${tag} roles` });
  for (const [who, u] of [["BA", b.admin], ["Agent", b.agent], ["Pit Crew", pc]] as const) {
    assert.equal((await fetch(`${baseUrl}/api/grow/contacts`, { headers: { cookie: u.cookie } })).status, 200, `${who} contacts`);
    assert.equal((await fetch(`${baseUrl}/api/grow/opportunities`, { headers: { cookie: u.cookie } })).status, 200, `${who} opportunities`);
    assert.equal((await fetch(`${baseUrl}/api/grow/contacts/${otherContact}`, { headers: { cookie: u.cookie } })).status, 404, `${who} cross-brokerage contact`);
  }
  // Role rules are unchanged: Financial stays BA-only, Pit Crew workspace refuses an Agent.
  assert.equal((await fetch(`${baseUrl}/api/pit-crew/workspace`, { headers: { cookie: b.agent.cookie } })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/financial/commission-agreements`, { headers: { cookie: b.agent.cookie } })).status, 403);
});

test("AI is not unlimited for Run subscribers: at the configured per-user daily limit /api/ai/ask (Grow context) is refused with 429 before the provider", async () => {
  const prev = { e: process.env.AI_DAILY_CAP_ENFORCED, u: process.env.AI_DAILY_LIMIT_PER_USER };
  process.env.AI_DAILY_CAP_ENFORCED = "true";
  process.env.AI_DAILY_LIMIT_PER_USER = "2";
  const orig = MockAiProvider.prototype.generate; let calls = 0;
  MockAiProvider.prototype.generate = async function (this: MockAiProvider, r) { calls += 1; return orig.call(this, r); };
  try {
    _resetGrowRateLimiterForTests();
    const b = await brokerage("ai-limit");
    await sync(b.brokerageId, STARTER_PRODUCT_CODE, "Active", `${tag}-ai-limit`);
    await db.insert(aiInteractions).values({ requestId: randomUUID(), brokerageId: b.brokerageId, userId: b.agent.user.id, aiRole: "copilot", riskLevel: 0, status: "success" });
    const ask = () => fetch(`${baseUrl}/api/ai/ask`, { method: "POST", headers: { cookie: b.agent.cookie, "content-type": "application/json" }, body: JSON.stringify({ question: "How am I tracking?", contextId: null, contextType: "grow" }) });
    const under = await ask();
    assert.equal(under.status, 200, await under.clone().text());
    const at = await ask();
    assert.equal(at.status, 429, await at.clone().text());
    assert.equal(calls, 1, "a capped request never reaches the provider");
  } finally {
    MockAiProvider.prototype.generate = orig;
    if (prev.e === undefined) delete process.env.AI_DAILY_CAP_ENFORCED; else process.env.AI_DAILY_CAP_ENFORCED = prev.e;
    if (prev.u === undefined) delete process.env.AI_DAILY_LIMIT_PER_USER; else process.env.AI_DAILY_LIMIT_PER_USER = prev.u;
  }
});
