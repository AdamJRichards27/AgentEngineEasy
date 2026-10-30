// Owner t165u: "Offer prices: listing agent and authorised brokerage
// administrators only." "Pit Crew: read only the buyer details required for
// assigned, authorised transaction work." Integration review finding P1: the
// per-offer routes returned offerPriceCents + conditions to any Run user in
// the brokerage. Same pattern as #263/#267: the listing agent
// (properties.agent_id) and Brokerage Administrators get the full view; any
// other Agent gets 404 (the existing own-property rule); Pit Crew keeps the
// offer status but never price or conditions (offerTermsVisible: false).
//
// Not covered here, deliberately (Owner decision P2): transaction purchase
// price on the transaction routes and the `transaction` object in the accept
// response.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, users } from "@aee/db";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const brokerageName = `Offer Privacy A ${suffix}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let otherAgent: DevLoginResult;
let crew: DevLoginResult;
let propertyId: number;
const PRICE = 91_234_500;
const CONDITION_TEXT = "Subject to finance within 14 days (synthetic)";

async function call(method: "GET" | "POST", path: string, cookie: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: body !== undefined ? { cookie, "content-type": "application/json" } : { cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  return { status: res.status, raw, json: raw ? (JSON.parse(raw) as Record<string, any>) : {} };
}

async function asRole(name: string, role: "Agent" | "Pit Crew"): Promise<DevLoginResult> {
  const r = await devLogin(baseUrl, { email: `${name}-${suffix}@example.com`, firstName: name, lastName: "Synthetic", brokerageName });
  await db.update(users).set({ role }).where(eq(users.id, r.user.id));
  return r;
}

async function newOffer(price = PRICE): Promise<number> {
  const r = await call("POST", `/offers/by-property/${propertyId}`, A.agent.cookie, {
    offerPriceCents: price,
    conditions: { finance: CONDITION_TEXT },
    buyer: { firstName: "Synthetic", lastName: `Buyer${price}`, email: `pp-${price}-${suffix}@example.com` },
  });
  assert.equal(r.status, 201, r.raw);
  return r.json.offer.id as number;
}

function assertFull(offer: Record<string, any>, label: string) {
  assert.equal(typeof offer.offerPriceCents, "number", `${label}: price present`);
  assert.ok(offer.conditions && typeof offer.conditions === "object", `${label}: conditions present`);
  assert.equal(offer.offerTermsVisible, true, `${label}: offerTermsVisible true`);
}

function assertRedacted(raw: string, offer: Record<string, any>, label: string) {
  assert.equal("offerPriceCents" in offer, false, `${label}: no offerPriceCents key`);
  assert.equal("conditions" in offer, false, `${label}: no conditions key`);
  assert.equal(offer.offerTermsVisible, false, `${label}: offerTermsVisible false`);
  assert.equal(typeof offer.status, "string", `${label}: status still visible`);
  assert.equal(raw.includes(CONDITION_TEXT), false, `${label}: condition text absent from body`);
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, brokerageName);
  B = await createBrokerageWithUsers(baseUrl, `Offer Privacy B ${suffix}`);
  otherAgent = await asRole("other-agent", "Agent");
  crew = await asRole("crew", "Pit Crew");
  ({ propertyId } = await createListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Price Privacy St, Testville`,
    sellerEmail: `seller-pp-${suffix}@example.com`,
  }));
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("listing agent and Brokerage Administrator get price and conditions on list and detail", async () => {
  const id = await newOffer();
  for (const [label, cookie] of [["listing agent", A.agent.cookie], ["brokerage admin", A.admin.cookie]] as const) {
    const list = await call("GET", `/offers/by-property/${propertyId}`, cookie);
    assert.equal(list.status, 200, list.raw);
    const row = (list.json.offers as Record<string, any>[]).find((o) => o.id === id)!;
    assertFull(row, `${label} list`);
    assert.equal(row.offerPriceCents, PRICE);
    const detail = await call("GET", `/offers/${id}`, cookie);
    assert.equal(detail.status, 200, detail.raw);
    assertFull(detail.json.offer, `${label} detail`);
  }
});

test("Pit Crew sees offer status but never price or conditions (list and detail)", async () => {
  const id = await newOffer(PRICE + 1);
  const list = await call("GET", `/offers/by-property/${propertyId}`, crew.cookie);
  assert.equal(list.status, 200, list.raw);
  assert.equal(list.raw.includes(String(PRICE + 1)), false, "price digits absent from list body");
  for (const row of list.json.offers as Record<string, any>[]) assertRedacted(list.raw, row, "crew list");
  const detail = await call("GET", `/offers/${id}`, crew.cookie);
  assert.equal(detail.status, 200, detail.raw);
  assertRedacted(detail.raw, detail.json.offer, "crew detail");
});

test("Pit Crew decline/withdraw responses carry no offer price or conditions", async () => {
  const d = await newOffer(PRICE + 2);
  const w = await newOffer(PRICE + 3);
  const dec = await call("POST", `/offers/${d}/decline`, crew.cookie);
  assert.equal(dec.status, 200, dec.raw);
  assertRedacted(dec.raw, dec.json.offer, "crew decline");
  assert.equal(dec.raw.includes(String(PRICE + 2)), false);
  const wd = await call("POST", `/offers/${w}/withdraw`, crew.cookie);
  assert.equal(wd.status, 200, wd.raw);
  assertRedacted(wd.raw, wd.json.offer, "crew withdraw");
});

test("an Agent who is not the listing agent gets 404 on every per-offer route (own-property rule)", async () => {
  const id = await newOffer(PRICE + 5);
  const checks = [
    await call("GET", `/offers/by-property/${propertyId}`, otherAgent.cookie),
    await call("GET", `/offers/${id}`, otherAgent.cookie),
    await call("POST", `/offers/${id}/decline`, otherAgent.cookie),
    await call("POST", `/offers/${id}/withdraw`, otherAgent.cookie),
    await call("POST", `/offers/${id}/accept`, otherAgent.cookie),
  ];
  for (const r of checks) {
    assert.equal(r.status, 404, r.raw);
    assert.deepEqual(r.json, { error: "Not found" });
  }
  // Nothing was mutated by the refused calls.
  const still = await call("GET", `/offers/${id}`, A.agent.cookie);
  assert.equal(still.json.offer.status, "Received");
});

test("listing agent decline/withdraw responses keep the full view; other brokerage still 404", async () => {
  const d = await newOffer(PRICE + 6);
  const dec = await call("POST", `/offers/${d}/decline`, A.agent.cookie);
  assert.equal(dec.status, 200, dec.raw);
  assertFull(dec.json.offer, "agent decline");
  const cross = await call("GET", `/offers/${d}`, B.admin.cookie);
  assert.equal(cross.status, 404);
});

// Runs last: accepting converts the property to a transaction.
test("Pit Crew accept response carries no offer price or conditions on the offer object", async () => {
  // Accept: the offer object is redacted. The `transaction` object (purchase
  // price) is Owner decision P2 and is deliberately not asserted on.
  const a = await newOffer(PRICE + 4);
  const acc = await call("POST", `/offers/${a}/accept`, crew.cookie);
  assert.ok(acc.status === 200 || acc.status === 201, acc.raw);
  assertRedacted(JSON.stringify(acc.json.offer), acc.json.offer, "crew accept offer");
});
