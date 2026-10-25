import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, propertyParties } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

/* ---------------------------------------------------------------------
 * AB-5 / SPEC-03 (D8): start an appraisal from a property via its linked
 * contact. POST /grow/appraisals/from-contact with entry:"property" adds
 * server validation; without entry the Contact 360 path is unchanged.
 *   cross-brokerage property or contact -> 404 (no existence leak)
 *   contact not linked to the property  -> 422 PROPERTY_CONTACT_NOT_LINKED
 *   no grow.opportunities.manage        -> 403
 *   appraisal already exists            -> 409 APPRAISAL_EXISTS + id
 * -----------------------------------------------------------------*/

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let VIEW: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
const cleanupIds: number[] = [];

async function grant(brokerageId: number, entitlementKey: string) {
  await db.insert(entitlementGrants).values({
    brokerageId, entitlementKey, granteeType: "brokerage", granteeId: brokerageId, sourceType: "manual", status: "Active",
  });
  invalidateEntitlementCache(brokerageId);
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
  A = await createBrokerageWithUsers(baseUrl, `D8 A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `D8 B ${suffix}`);
  VIEW = await createBrokerageWithUsers(baseUrl, `D8 View ${suffix}`);
  cleanupIds.push(A.brokerageId, B.brokerageId, VIEW.brokerageId);
  for (const x of [A, B]) {
    await grant(x.brokerageId, "grow.access");
    await grant(x.brokerageId, "grow.opportunities.manage");
  }
  await grant(VIEW.brokerageId, "grow.access");
});

after(async () => {
  await cleanupBrokerages(cleanupIds);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function createProperty(cookie: string, label: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: `${label} ${suffix}`, state: "QLD", suburb: "Testville", postcode: "4000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { property: { id: number } }).property.id;
}

async function createLinkedParty(cookie: string, propertyId: number): Promise<number> {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, role: "Seller", firstName: "D8", lastName: "Contact" }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { party: { id: number } }).party.id;
}

function fromProperty(cookie: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/grow/appraisals/from-contact`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

test("D8: linked contact on own property creates the appraisal with party and owner", async () => {
  const propertyId = await createProperty(A.agent.cookie, "D8 ok");
  const partyId = await createLinkedParty(A.agent.cookie, propertyId);
  const res = await fromProperty(A.agent.cookie, { partyId, propertyId, entry: "property" });
  assert.equal(res.status, 201, await res.clone().text());
  const { appraisal } = (await res.json()) as { appraisal: { id: number; partyId: number; propertyId: number; ownerUserId: number } };
  assert.equal(appraisal.partyId, partyId);
  assert.equal(appraisal.propertyId, propertyId);
  assert.equal(appraisal.ownerUserId, A.agent.user.id);
});

test("D8: duplicate submit -> 409 APPRAISAL_EXISTS with the existing id", async () => {
  const propertyId = await createProperty(A.agent.cookie, "D8 dup");
  const partyId = await createLinkedParty(A.agent.cookie, propertyId);
  const first = await fromProperty(A.agent.cookie, { partyId, propertyId, entry: "property" });
  assert.equal(first.status, 201);
  const id = ((await first.json()) as { appraisal: { id: number } }).appraisal.id;
  const second = await fromProperty(A.agent.cookie, { partyId, propertyId, entry: "property" });
  assert.equal(second.status, 409);
  const body = (await second.json()) as { code: string; appraisalId: number };
  assert.equal(body.code, "APPRAISAL_EXISTS");
  assert.equal(body.appraisalId, id);
});

test("D8: contact not linked to the property -> 422, nothing created", async () => {
  const propertyId = await createProperty(A.agent.cookie, "D8 unlinked");
  const otherProperty = await createProperty(A.agent.cookie, "D8 other");
  const partyId = await createLinkedParty(A.agent.cookie, otherProperty);
  await db.delete(propertyParties).where(and(eq(propertyParties.propertyId, propertyId), eq(propertyParties.partyId, partyId)));
  const res = await fromProperty(A.agent.cookie, { partyId, propertyId, entry: "property" });
  assert.equal(res.status, 422);
  assert.equal(((await res.json()) as { code: string }).code, "PROPERTY_CONTACT_NOT_LINKED");
  const check = await fetch(`${baseUrl}/api/appraisals/by-property/${propertyId}`, { headers: { cookie: A.agent.cookie } });
  if (check.status === 200) {
    const body = (await check.json()) as { appraisal?: unknown };
    assert.ok(!body.appraisal, "no appraisal should exist after a 422");
  }
});

test("D8: another brokerage's property or contact -> 404 (no existence leak)", async () => {
  const bProperty = await createProperty(B.agent.cookie, "D8 foreign");
  const bParty = await createLinkedParty(B.agent.cookie, bProperty);
  const aProperty = await createProperty(A.agent.cookie, "D8 own");
  const aParty = await createLinkedParty(A.agent.cookie, aProperty);
  const foreignProperty = await fromProperty(A.agent.cookie, { partyId: aParty, propertyId: bProperty, entry: "property" });
  assert.equal(foreignProperty.status, 404);
  const foreignParty = await fromProperty(A.agent.cookie, { partyId: bParty, propertyId: aProperty, entry: "property" });
  assert.equal(foreignParty.status, 404);
  const missing = await fromProperty(A.agent.cookie, { partyId: aParty, propertyId: 2_000_000_000, entry: "property" });
  assert.equal(missing.status, 404);
  assert.deepEqual(await foreignProperty.json(), await missing.json(), "foreign and missing are indistinguishable");
});

test("D8: no grow.opportunities.manage -> 403", async () => {
  const propertyId = await createProperty(VIEW.agent.cookie, "D8 view");
  const partyId = await createLinkedParty(VIEW.agent.cookie, propertyId);
  const res = await fromProperty(VIEW.agent.cookie, { partyId, propertyId, entry: "property" });
  assert.equal(res.status, 403);
});

test("D8: unknown entry value is rejected (400)", async () => {
  const res = await fromProperty(A.agent.cookie, { partyId: 1, propertyId: 1, entry: "bogus" });
  assert.equal(res.status, 400);
});
