// HTTP-level coverage for routes/parties.ts's tenant isolation.
//
// Confirmed IDOR fix: DELETE /link/:linkId, POST / (create a
// party-property link), and GET /by-property/:propertyId all previously
// resolved a propertyId/linkId with zero (or existence-only) brokerage
// check. Any authenticated user, from any brokerage, could:
//   - delete another brokerage's party-property link, triggering the
//     ownership-review/workflow-refresh side effects on that brokerage's
//     property (DELETE /link/:linkId);
//   - link a newly created party to an arbitrary cross-brokerage property
//     and trigger AML/workflow side effects on it (POST /);
//   - read another brokerage's party PII — name/email/mobile
//     (GET /by-property/:propertyId).
// Fixed by scoping every load to the caller's brokerageId in the same
// query that fetches by id (not a check-after), matching
// assertPropertyInBrokerage (lib/launch/model.ts) and
// assertPartyOnPropertyInBrokerage (lib/aml.ts) — identical 404 "not
// found" whether the id is missing or belongs to another tenant.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, propertyParties } from "@aee/db";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageAName = `Parties Routes A ${suffix}`;
const brokerageBName = `Parties Routes B ${suffix}`;
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

  A = await createBrokerageWithUsers(baseUrl, brokerageAName);
  B = await createBrokerageWithUsers(baseUrl, brokerageBName);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got: ${res.status} ${text}`);
  }
}

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = await json<{ property: { id: number } }>(res);
  return property.id;
}

async function addParty(
  cookie: string,
  propertyId: number,
  role: "Seller" | "Buyer" | "Solicitor" | "PowerOfAttorney" | "Other",
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      propertyId,
      role,
      firstName: "Sam",
      lastName: "Seller",
      email: `party-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`,
      ...overrides,
    }),
  });
}

// ---------------------------------------------------------------------
// Happy path — same-brokerage create/list/delete is unchanged.
// ---------------------------------------------------------------------

test("happy path: same-brokerage create, list by-property, and delete a party-property link all still work", async () => {
  const propertyId = await createProperty(A.agent.cookie, "1 Happy Path St");

  const createRes = await addParty(A.agent.cookie, propertyId, "Seller");
  const created = await json<{ party: { id: number; firstName: string }; link: { id: number; role: string; propertyId: number } }>(createRes);
  assert.equal(createRes.status, 201, `create failed: ${JSON.stringify(created)}`);
  assert.equal(created.party.firstName, "Sam");
  assert.equal(created.link.role, "Seller");

  const listRes = await fetch(`${baseUrl}/api/parties/by-property/${propertyId}`, { headers: { cookie: A.agent.cookie } });
  assert.equal(listRes.status, 200);
  const list = await json<{ parties: Array<{ linkId: number; role: string; party: { id: number } | null }> }>(listRes);
  assert.equal(list.parties.length, 1);
  assert.equal(list.parties[0].linkId, created.link.id);
  assert.equal(list.parties[0].party?.id, created.party.id);

  const deleteRes = await fetch(`${baseUrl}/api/parties/link/${created.link.id}`, { method: "DELETE", headers: { cookie: A.agent.cookie } });
  assert.equal(deleteRes.status, 204);

  const afterDelete = await db.select().from(propertyParties).where(eq(propertyParties.id, created.link.id));
  assert.equal(afterDelete.length, 0, "link row must actually be gone after a legitimate same-brokerage delete");

  const listAfterDelete = await fetch(`${baseUrl}/api/parties/by-property/${propertyId}`, { headers: { cookie: A.agent.cookie } });
  const listAfterDeleteBody = await json<{ parties: unknown[] }>(listAfterDelete);
  assert.equal(listAfterDeleteBody.parties.length, 0);
});

// ---------------------------------------------------------------------
// Cross-tenant: DELETE /link/:linkId
// ---------------------------------------------------------------------

test("DELETE /link/:linkId: brokerage B cannot delete brokerage A's party-property link", async () => {
  const aPropertyId = await createProperty(A.agent.cookie, "2 Cross Tenant Delete St");
  const createRes = await addParty(A.agent.cookie, aPropertyId, "Seller");
  assert.equal(createRes.status, 201);
  const { link } = await json<{ link: { id: number } }>(createRes);

  const crossTenantDelete = await fetch(`${baseUrl}/api/parties/link/${link.id}`, { method: "DELETE", headers: { cookie: B.agent.cookie } });
  assert.equal(crossTenantDelete.status, 404, "brokerage B must not be able to delete brokerage A's link");
  const crossTenantBody = await json<{ error: string }>(crossTenantDelete);
  assert.match(crossTenantBody.error, /not found/i);

  // Same 404 shape for a genuinely nonexistent linkId — a caller can never
  // tell "doesn't exist" apart from "exists but isn't yours".
  const nonexistentDelete = await fetch(`${baseUrl}/api/parties/link/999999999`, { method: "DELETE", headers: { cookie: B.agent.cookie } });
  assert.equal(nonexistentDelete.status, 404);
  const nonexistentBody = await json<{ error: string }>(nonexistentDelete);
  assert.equal(nonexistentBody.error, crossTenantBody.error);

  // The link must still exist, untouched, in the database.
  const stillThere = await db.select().from(propertyParties).where(eq(propertyParties.id, link.id));
  assert.equal(stillThere.length, 1, "brokerage A's link must survive brokerage B's delete attempt");

  // A can still delete its own link (the fix doesn't break the happy path).
  const legitDelete = await fetch(`${baseUrl}/api/parties/link/${link.id}`, { method: "DELETE", headers: { cookie: A.agent.cookie } });
  assert.equal(legitDelete.status, 204);
});

// ---------------------------------------------------------------------
// Cross-tenant: POST / (create party + link)
// ---------------------------------------------------------------------

test("POST /: brokerage B cannot link a party to brokerage A's property", async () => {
  const aPropertyId = await createProperty(A.agent.cookie, "3 Cross Tenant Create St");

  const res = await addParty(B.agent.cookie, aPropertyId, "Buyer", { firstName: "Mallory", lastName: "Attacker" });
  assert.equal(res.status, 404, "brokerage B must not be able to link a party to brokerage A's property");
  const body = await json<{ error: string }>(res);
  assert.match(body.error, /not found/i);

  // Same 404 shape for a genuinely nonexistent propertyId.
  const nonexistentRes = await addParty(B.agent.cookie, 999999999, "Buyer");
  assert.equal(nonexistentRes.status, 404);
  const nonexistentBody = await json<{ error: string }>(nonexistentRes);
  assert.equal(nonexistentBody.error, body.error);

  // No stray link or "Mallory" party must have been created against A's property.
  const links = await db.select().from(propertyParties).where(eq(propertyParties.propertyId, aPropertyId));
  assert.equal(links.length, 0, "no party-property link may exist for A's property after the rejected cross-tenant attempt");

  // A can still legitimately link a party to its own property.
  const legit = await addParty(A.agent.cookie, aPropertyId, "Buyer", { firstName: "Bob", lastName: "Buyer" });
  assert.equal(legit.status, 201);
});

// ---------------------------------------------------------------------
// Cross-tenant: GET /by-property/:propertyId
// ---------------------------------------------------------------------

test("GET /by-property/:propertyId: brokerage B cannot list (or see the PII of) brokerage A's property's parties", async () => {
  const aPropertyId = await createProperty(A.agent.cookie, "4 Cross Tenant List St");
  const createRes = await addParty(A.agent.cookie, aPropertyId, "Seller", {
    firstName: "Priva",
    lastName: "Secret",
    email: "priva.secret@example.com",
    mobile: "0400000000",
  });
  assert.equal(createRes.status, 201);

  const crossTenantList = await fetch(`${baseUrl}/api/parties/by-property/${aPropertyId}`, { headers: { cookie: B.agent.cookie } });
  assert.equal(crossTenantList.status, 404, "brokerage B must not be able to read brokerage A's property's parties");
  const crossTenantBody = await json<{ error?: string }>(crossTenantList);
  assert.match(crossTenantBody.error ?? "", /not found/i);
  // Belt-and-braces: whatever the response, it must never contain the seller's PII.
  const rawText = JSON.stringify(crossTenantBody);
  assert.doesNotMatch(rawText, /Priva|Secret|priva\.secret@example\.com|0400000000/);

  // Same 404 shape for a genuinely nonexistent propertyId.
  const nonexistentList = await fetch(`${baseUrl}/api/parties/by-property/999999999`, { headers: { cookie: B.agent.cookie } });
  assert.equal(nonexistentList.status, 404);
  const nonexistentBody = await json<{ error: string }>(nonexistentList);
  assert.equal(nonexistentBody.error, crossTenantBody.error);

  // A can still legitimately read its own property's parties.
  const legitList = await fetch(`${baseUrl}/api/parties/by-property/${aPropertyId}`, { headers: { cookie: A.agent.cookie } });
  assert.equal(legitList.status, 200);
  const legitBody = await json<{ parties: Array<{ party: { firstName: string } | null }> }>(legitList);
  assert.equal(legitBody.parties.length, 1);
  assert.equal(legitBody.parties[0].party?.firstName, "Priva");
});
