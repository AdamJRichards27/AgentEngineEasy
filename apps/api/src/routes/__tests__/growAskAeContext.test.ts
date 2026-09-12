// AE GROW Priority 6 Stage B — Context-layer tests for buildGrowContext
// (apps/api/src/lib/ai/context/growContext.ts): tenant isolation, bounding,
// and growFocusItemId resolution. Placed alongside routes/__tests__/growToday.test.ts
// (not under lib/ai/__tests__) purely so it can reuse that same real-HTTP
// fixture-building style (createBrokerageWithUsers + the real /grow/*
// routes) rather than hand-inserting rows into growRelationships/
// growOpportunities/growActivities directly and risking a fixture that
// growToday.ts's own ranking rules would not actually produce the same way
// a real agent's usage would.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { db, entitlementGrants } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { buildGrowContext } from "../../lib/ai/context/growContext.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `Grow Ask AE Context A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Grow Ask AE Context B ${suffix}`);
  await grant(A.brokerageId, "grow.access");
  await grant(B.brokerageId, "grow.access");
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function grant(brokerageId: number, entitlementKey: string) {
  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey,
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerageId);
}

function growUrl(path: string) {
  return `${baseUrl}/api/grow${path}`;
}

async function createProperty(cookie: string, address: string) {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

async function createParty(cookie: string, propertyId: number, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, role: "Buyer", firstName: "Test", lastName: "Contact", ...overrides }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  const { party } = (await res.json()) as { party: { id: number } };
  return party.id;
}

async function createOpportunity(cookie: string, body: Record<string, unknown>) {
  const res = await fetch(growUrl("/opportunities"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`create opportunity failed: ${res.status} ${await res.text()}`);
  const { opportunity } = (await res.json()) as { opportunity: { id: number } };
  return opportunity.id;
}

async function makeOverdue(cookie: string, opportunityId: number) {
  const overdue = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const res = await fetch(growUrl(`/opportunities/${opportunityId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ nextActionDueAt: overdue.toISOString() }),
  });
  if (res.status !== 200) throw new Error(`patch opportunity failed: ${res.status} ${await res.text()}`);
}

test("buildGrowContext: an entitled brokerage with zero Grow data gets hasAnyGrowData: false and every list empty, never an error", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Grow Ask AE Context Empty ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const ctx = await buildGrowContext(fresh.brokerageId, null);
    assert.equal(ctx.hasAnyGrowData, false);
    assert.deepEqual(ctx.todayItems, []);
    assert.deepEqual(ctx.dueFollowUps, []);
    assert.deepEqual(ctx.appraisalFollowUps, []);
    assert.deepEqual(ctx.activeSignals, []);
    assert.deepEqual(ctx.relationshipBreakdown, []);
    assert.deepEqual(ctx.opportunityPipeline, []);
    assert.deepEqual(ctx.recentActivity, []);
    assert.equal(ctx.focusedItem, null);
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("buildGrowContext: tenant isolation - brokerage A's context never contains brokerage B's contacts, and vice versa", async () => {
  const propertyA = await createProperty(A.agent.cookie, "1 Context Isolation Ave (A)");
  const partyA = await createParty(A.agent.cookie, propertyA, { firstName: "Alice", lastName: "TenantA" });
  const oppA = await createOpportunity(A.agent.cookie, { partyId: partyA, propertyId: propertyA, opportunityType: "Listing", reason: "Brokerage A fixture." });
  await makeOverdue(A.agent.cookie, oppA);

  const propertyB = await createProperty(B.agent.cookie, "2 Context Isolation Ave (B)");
  const partyB = await createParty(B.agent.cookie, propertyB, { firstName: "Bob", lastName: "TenantB" });
  const oppB = await createOpportunity(B.agent.cookie, { partyId: partyB, propertyId: propertyB, opportunityType: "Listing", reason: "Brokerage B fixture." });
  await makeOverdue(B.agent.cookie, oppB);

  const ctxA = await buildGrowContext(A.brokerageId, null);
  const ctxB = await buildGrowContext(B.brokerageId, null);

  assert.ok(ctxA.todayItems.some((i) => i.id === `opportunity:${oppA}`), "brokerage A's context must contain its own opportunity");
  assert.ok(!ctxA.todayItems.some((i) => i.id === `opportunity:${oppB}`), "brokerage A's context must never contain brokerage B's opportunity");
  assert.ok(!ctxA.todayItems.some((i) => i.contactName === "Bob TenantB"), "brokerage A's context must never contain brokerage B's contact name");

  assert.ok(ctxB.todayItems.some((i) => i.id === `opportunity:${oppB}`), "brokerage B's context must contain its own opportunity");
  assert.ok(!ctxB.todayItems.some((i) => i.id === `opportunity:${oppA}`), "brokerage B's context must never contain brokerage A's opportunity");
});

test("buildGrowContext: growFocusItemId resolves only within the SAME brokerage - a foreign or unknown id resolves to focusedItem: null, never an error or another tenant's data", async () => {
  const propertyA = await createProperty(A.agent.cookie, "3 Focus Item Resolution Ave");
  const partyA = await createParty(A.agent.cookie, propertyA, { firstName: "Fiona", lastName: "FocusTarget" });
  const oppA = await createOpportunity(A.agent.cookie, { partyId: partyA, propertyId: propertyA, opportunityType: "Listing", reason: "Focus resolution fixture." });
  await makeOverdue(A.agent.cookie, oppA);
  const focusId = `opportunity:${oppA}`;

  const ownContext = await buildGrowContext(A.brokerageId, focusId);
  assert.ok(ownContext.focusedItem !== null, "the item's own brokerage must resolve it");
  assert.equal(ownContext.focusedItem?.id, focusId);
  assert.equal(ownContext.focusedItem?.contactName, "Fiona FocusTarget");

  const foreignContext = await buildGrowContext(B.brokerageId, focusId);
  assert.equal(foreignContext.focusedItem, null, "a real item id belonging to another brokerage must resolve to null, never that item's data");

  const unknownContext = await buildGrowContext(A.brokerageId, "opportunity:999999999");
  assert.equal(unknownContext.focusedItem, null, "an id that does not exist at all must resolve to null, not an error");

  const noFocusContext = await buildGrowContext(A.brokerageId, null);
  assert.equal(noFocusContext.focusedItem, null, "no growFocusItemId at all must resolve to null");
});

test("buildGrowContext: todayItems is bounded at 20 even when a brokerage has more than 20 qualifying items", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Grow Ask AE Context Bounding ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const propertyId = await createProperty(fresh.agent.cookie, "4 Bounding Test Ave");

    const TOTAL_ITEMS = 22;
    for (let i = 0; i < TOTAL_ITEMS; i++) {
      const partyId = await createParty(fresh.agent.cookie, propertyId, { firstName: `Bound${i}`, lastName: "Test" });
      const oppId = await createOpportunity(fresh.agent.cookie, {
        partyId,
        propertyId,
        opportunityType: "Listing",
        reason: `Bounding fixture #${i}.`,
      });
      await makeOverdue(fresh.agent.cookie, oppId);
    }

    const ctx = await buildGrowContext(fresh.brokerageId, null);
    assert.equal(ctx.todayItems.length, 20, "todayItems must be capped at GROW_TODAY_ITEMS_LIMIT (20) regardless of how many qualifying items exist");
    assert.equal(ctx.hasAnyGrowData, true);
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});
