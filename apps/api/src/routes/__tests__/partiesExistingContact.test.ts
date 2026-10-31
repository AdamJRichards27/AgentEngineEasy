// AE Minimal v1.0 (Owner t149u): POST /parties with an existing partyId links
// that contact to a property without creating a new contact. Covers: link
// without a duplicate contact, create-new regression, cross-brokerage property
// and contact (non-disclosing 404), invalid role / id (400), duplicate and
// repeated / concurrent submissions (one link, 409 PROPERTY_PARTY_LINK_EXISTS),
// Grow-only access with Run boundaries intact, and a property-entry appraisal
// using the linked contact. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { db, entitlementGrants, parties, propertyParties } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
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
let G: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

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
  A = await createBrokerageWithUsers(baseUrl, `Link Existing A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Link Existing B ${suffix}`);
  G = await createBrokerageWithUsers(baseUrl, `Link Existing GrowOnly ${suffix}`);
  for (const x of [A, B, G]) {
    await grant(x.brokerageId, "grow.access");
    await grant(x.brokerageId, "grow.opportunities.manage");
    await grant(x.brokerageId, "grow.contacts.manage");
  }
  // Grow-only: revoke run.access for G.
  await db
    .update(entitlementGrants)
    .set({ status: "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, G.brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(G.brokerageId);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId, G?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function post(cookie: string, path: string, body: unknown) {
  return fetch(`${baseUrl}/api${path}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
}

async function createProperty(cookie: string, label: string): Promise<number> {
  const res = await post(cookie, "/properties", { formattedAddress: `${label} ${suffix}`, state: "QLD", suburb: "Testville", postcode: "4000" });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { property: { id: number } }).property.id;
}

/** A Relationships contact with no property (POST /grow/contacts). */
async function createContact(cookie: string, label: string): Promise<number> {
  const res = await post(cookie, "/grow/contacts", { firstName: "Synthetic", lastName: `${label}${suffix}`, email: `${label.toLowerCase()}.${suffix}@example.test` });
  assert.equal(res.status, 201, await res.clone().text());
  const body = (await res.json()) as { contact?: { id: number }; party?: { id: number }; id?: number };
  const id = body.contact?.id ?? body.party?.id ?? body.id;
  assert.ok(id, `contact id in ${JSON.stringify(body)}`);
  return id!;
}

async function partyCount(brokerageId: number): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(parties).where(eq(parties.brokerageId, brokerageId));
  return row.n;
}

async function linkCount(propertyId: number, partyId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(propertyParties)
    .where(and(eq(propertyParties.propertyId, propertyId), eq(propertyParties.partyId, partyId)));
  return row.n;
}

test("links an existing contact without creating a new contact", async () => {
  const propertyId = await createProperty(A.agent.cookie, "LE link");
  const partyId = await createContact(A.agent.cookie, "Linkone");
  const before = await partyCount(A.brokerageId);
  const res = await post(A.agent.cookie, "/parties", { propertyId, partyId, role: "Seller", firstName: "Ignored" });
  assert.equal(res.status, 201, await res.clone().text());
  const body = (await res.json()) as { party: { id: number; firstName: string }; link: { partyId: number; propertyId: number; role: string } };
  assert.equal(body.party.id, partyId);
  assert.equal(body.party.firstName, "Synthetic", "existing contact fields are not overwritten");
  assert.deepEqual([body.link.partyId, body.link.propertyId, body.link.role], [partyId, propertyId, "Seller"]);
  assert.equal(await partyCount(A.brokerageId), before, "no new contact row");
  assert.equal(await linkCount(propertyId, partyId), 1);
});

test("create-new path unchanged for existing callers", async () => {
  const propertyId = await createProperty(A.agent.cookie, "LE create");
  const before = await partyCount(A.brokerageId);
  const res = await post(A.agent.cookie, "/parties", { propertyId, role: "Seller", firstName: "New", lastName: "Seller" });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { party: { id: number; firstName: string }; link: { role: string } };
  assert.equal(body.party.firstName, "New");
  assert.equal(body.link.role, "Seller");
  assert.equal(await partyCount(A.brokerageId), before + 1);
});

test("cross-brokerage property or contact -> non-disclosing 404, nothing linked", async () => {
  const aProperty = await createProperty(A.agent.cookie, "LE own");
  const aParty = await createContact(A.agent.cookie, "Ownc");
  const bProperty = await createProperty(B.agent.cookie, "LE foreign");
  const bParty = await createContact(B.agent.cookie, "Foreignc");
  const foreignProperty = await post(A.agent.cookie, "/parties", { propertyId: bProperty, partyId: aParty, role: "Seller" });
  assert.equal(foreignProperty.status, 404);
  const missingProperty = await post(A.agent.cookie, "/parties", { propertyId: 2_000_000_000, partyId: aParty, role: "Seller" });
  assert.deepEqual(await foreignProperty.json(), await missingProperty.json());
  const foreignParty = await post(A.agent.cookie, "/parties", { propertyId: aProperty, partyId: bParty, role: "Seller" });
  assert.equal(foreignParty.status, 404);
  const missingParty = await post(A.agent.cookie, "/parties", { propertyId: aProperty, partyId: 2_000_000_000, role: "Seller" });
  assert.equal(missingParty.status, 404);
  assert.deepEqual(await foreignParty.json(), await missingParty.json());
  assert.equal(await linkCount(bProperty, aParty), 0);
  assert.equal(await linkCount(aProperty, bParty), 0);
});

test("invalid role, missing role or bad id -> 400", async () => {
  const propertyId = await createProperty(A.agent.cookie, "LE invalid");
  const partyId = await createContact(A.agent.cookie, "Invalidc");
  for (const body of [
    { propertyId, partyId, role: "Owner" },
    { propertyId, partyId },
    { propertyId, partyId: -3, role: "Seller" },
    { propertyId, partyId: "abc", role: "Seller" },
  ]) {
    const res = await post(A.agent.cookie, "/parties", body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(await linkCount(propertyId, partyId), 0);
});

test("duplicate and repeated submissions -> one link, 409 with the existing link", async () => {
  const propertyId = await createProperty(A.agent.cookie, "LE dup");
  const partyId = await createContact(A.agent.cookie, "Dupc");
  const first = await post(A.agent.cookie, "/parties", { propertyId, partyId, role: "Seller" });
  assert.equal(first.status, 201);
  const firstLink = ((await first.json()) as { link: { id: number } }).link.id;
  for (let i = 0; i < 2; i += 1) {
    const again = await post(A.agent.cookie, "/parties", { propertyId, partyId, role: "Seller" });
    assert.equal(again.status, 409);
    const body = (await again.json()) as { code: string; link: { id: number } };
    assert.equal(body.code, "PROPERTY_PARTY_LINK_EXISTS");
    assert.equal(body.link.id, firstLink);
  }
  assert.equal(await linkCount(propertyId, partyId), 1);
  // A different role is a different relationship and is allowed.
  const other = await post(A.agent.cookie, "/parties", { propertyId, partyId, role: "Other" });
  assert.equal(other.status, 201);
  assert.equal(await linkCount(propertyId, partyId), 2);
});

test("concurrent submissions create exactly one link", async () => {
  const propertyId = await createProperty(A.agent.cookie, "LE race");
  const partyId = await createContact(A.agent.cookie, "Racec");
  const results = await Promise.all(
    Array.from({ length: 6 }, () => post(A.agent.cookie, "/parties", { propertyId, partyId, role: "Seller" })),
  );
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409]);
  assert.equal(await linkCount(propertyId, partyId), 1);
});

test("Grow-only brokerage can link and start an appraisal from the property; Run-only stays 403", async () => {
  const propertyId = await createProperty(G.agent.cookie, "LE grow");
  const partyId = await createContact(G.agent.cookie, "Growc");
  const before = await partyCount(G.brokerageId);
  const link = await post(G.agent.cookie, "/parties", { propertyId, partyId, role: "Seller" });
  assert.equal(link.status, 201, await link.clone().text());
  assert.equal(await partyCount(G.brokerageId), before);

  const appraisal = await post(G.agent.cookie, "/grow/appraisals/from-contact", { partyId, propertyId, entry: "property" });
  assert.equal(appraisal.status, 201, await appraisal.clone().text());
  const body = (await appraisal.json()) as { appraisal: { partyId: number; propertyId: number } };
  assert.equal(body.appraisal.partyId, partyId);
  assert.equal(body.appraisal.propertyId, propertyId);

  const runOnly = await post(G.agent.cookie, `/properties/${propertyId}/ready-to-list`, {});
  assert.equal(runOnly.status, 403);
  assert.equal(((await runOnly.json()) as { entitlementKey?: string }).entitlementKey, "run.access");
});

test("before linking, property-entry appraisal is refused 422", async () => {
  const propertyId = await createProperty(A.agent.cookie, "LE unlinked");
  const partyId = await createContact(A.agent.cookie, "Unlinkedc");
  const res = await post(A.agent.cookie, "/grow/appraisals/from-contact", { partyId, propertyId, entry: "property" });
  assert.equal(res.status, 422);
});
