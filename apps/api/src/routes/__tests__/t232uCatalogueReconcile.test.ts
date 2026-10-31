// Owner t232u (1 Nov 2026): reconcile the $139 Grow catalogue with Run-includes-Grow. Seeded prices on a fresh DB,
// the offered catalogue, and the entitlements a NEW mock-provider checkout grants (Grow = grow.* only;
// Run (Pro+Grow bundle, $289 total) = run.access + every grow.* key). No live billing; mock provider only.
// Existing customer prices/charges are not touched.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { db, entitlementGrants, ENTITLEMENT_KEYS } from "@aee/db";
import { invalidateEntitlementCache, resolveEntitlements } from "../../lib/entitlements/resolver.js";
import {
  ensureCatalogueSeeded, GROW_PRODUCT_CODE, STARTER_PRODUCT_CODE, BUNDLE_PRODUCT_CODE, OFFERED_PRODUCT_CODES, CATALOGUE_PRICES_CENTS,
} from "../../lib/billing/catalogue.js";
import { applySubscriptionSnapshot } from "../../lib/billing/sync.js";
import { createBrokerageWithUsers, cleanupBrokerages } from "./testSupport.js";

const ALL = [...ENTITLEMENT_KEYS].sort();
const SOURCE = { actorType: "SYSTEM" as const, actorId: null, label: "test:t232u" };
const tag = `t232u-${process.pid}-${Date.now()}`;
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

import { products, prices } from "@aee/db";
const GROW_KEYS = ALL.filter((k) => k !== "run.access");

test("seeded catalogue rows: Grow 13900 AUD monthly, Run incl. Grow (bundle) 28900; offered list matches", async () => {
  const rows = await db
    .select({ code: products.code, amountCents: prices.amountCents, currency: prices.currency, status: prices.status })
    .from(products)
    .innerJoin(prices, eq(prices.productId, products.id))
    .where(and(inArray(products.code, [GROW_PRODUCT_CODE, BUNDLE_PRODUCT_CODE]), eq(prices.status, "Active")));
  const by = Object.fromEntries(rows.map((r) => [r.code, r]));
  assert.equal(by[GROW_PRODUCT_CODE]?.amountCents, 13900);
  assert.equal(by[BUNDLE_PRODUCT_CODE]?.amountCents, 28900);
  assert.equal(by[GROW_PRODUCT_CODE]?.currency, "AUD");
  assert.equal(rows.filter((r) => r.code === GROW_PRODUCT_CODE).length, 1, "one Active Grow price");
  assert.equal(CATALOGUE_PRICES_CENTS[GROW_PRODUCT_CODE], 13900);
  assert.equal(CATALOGUE_PRICES_CENTS[BUNDLE_PRODUCT_CODE], 28900);
  assert.ok(!OFFERED_PRODUCT_CODES.includes(STARTER_PRODUCT_CODE));
  // Re-seeding is idempotent: no second price row.
  await ensureCatalogueSeeded();
  const again = await db.select({ id: prices.id }).from(prices).innerJoin(products, eq(prices.productId, products.id)).where(and(eq(products.code, GROW_PRODUCT_CODE), eq(prices.status, "Active")));
  assert.equal(again.length, 1);
});

test("GET /billing/catalogue offers Grow $139 and Run $289 only", async () => {
  const b = await brokerage("Cat");
  const res = await api("/api/billing/catalogue", b.admin.cookie);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { products: Array<{ code: string; amountCents: number }> };
  const amounts = Object.fromEntries(body.products.map((p) => [p.code, p.amountCents]));
  assert.deepEqual(amounts, { [GROW_PRODUCT_CODE]: 13900, [BUNDLE_PRODUCT_CODE]: 28900 });
});

test("new subscriptions: Grow grants grow.* only (no run.access); Run (bundle) grants run.access + every grow.* key", async () => {
  const g = await brokerage("NewGrow");
  await sync(g.brokerageId, GROW_PRODUCT_CODE, "Active", `${tag}-grow`);
  assert.deepEqual(await keys(g.brokerageId), GROW_KEYS);
  const r = await brokerage("NewRun");
  await sync(r.brokerageId, BUNDLE_PRODUCT_CODE, "Active", `${tag}-run`);
  assert.deepEqual(await keys(r.brokerageId), ALL);
  for (const k of GROW_KEYS) assert.ok((await keys(r.brokerageId)).includes(k), `Run includes ${k}`);
});

test("mock checkout (no live provider): Grow and Run start through the offered catalogue and grant the right keys", async () => {
  for (const [label, code, expected] of [["CoGrow", GROW_PRODUCT_CODE, GROW_KEYS], ["CoRun", BUNDLE_PRODUCT_CODE, ALL]] as const) {
    const b = await brokerage(label);
    const res = await api("/api/billing/checkout", b.admin.cookie, { method: "POST", body: JSON.stringify({ productCode: code, customerEmail: `${label.toLowerCase()}@example.test` }) });
    assert.equal(res.status, 200, `${label} checkout`);
    assert.deepEqual(await keys(b.brokerageId), [...expected], label);
  }
});
