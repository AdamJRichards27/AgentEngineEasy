// Issue #10 coverage completion (tests only, no route change).
// Existing suites (runPropertyPartyIsolationRejection, amlPartyRequest,
// amlTenantScoping) already prove the 404/"not found" status for an agent of
// another brokerage. This file closes the remaining acceptance gaps:
//  - a rejected cross-brokerage WRITE leaves no side effect (no party row,
//    no link, no verification, no service order, no audit row, no status
//    change);
//  - the rejection is indistinguishable from a missing id (same status,
//    same body shape);
//  - another brokerage's Brokerage Administrator gets the same rejection
//    (admins have no cross-brokerage reach, Owner t113u D7).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, auditLogs, parties, propertyParties, amlVerifications, serviceOrders } from "@aee/db";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.AML_WEBHOOK_SECRET = "aml-webhook-test-secret";

const MISSING_ID = 2_000_000_000;
let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `Issue10 Coverage A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Issue10 Coverage B ${suffix}`);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function call(method: string, path: string, cookie: string, body?: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers: body === undefined ? { cookie } : { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try { return JSON.parse(text) as T; } catch { throw new Error(`Expected JSON, got: ${res.status} ${text}`); }
}

async function createProperty(cookie: string): Promise<number> {
  const res = await call("POST", "/properties", cookie, {
    formattedAddress: `${Math.floor(Math.random() * 1_000_000)} Issue Ten Rd`, state: "NSW", suburb: "Testville", postcode: "2000",
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await json<{ property: { id: number } }>(res)).property.id;
}

async function addParty(cookie: string, propertyId: number, role = "Buyer"): Promise<{ partyId: number; linkId: number }> {
  const res = await call("POST", "/parties", cookie, {
    propertyId, role, firstName: "Own", lastName: "Party", email: `i10-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
  });
  assert.equal(res.status, 201, await res.clone().text());
  const b = await json<{ party: { id: number }; link: { id: number } }>(res);
  return { partyId: b.party.id, linkId: b.link.id };
}

async function seedFailedVerification(): Promise<{ propertyId: number; partyId: number; verificationId: number }> {
  const propertyId = await createProperty(A.agent.cookie);
  const { partyId } = await addParty(A.agent.cookie, propertyId);
  const res = await call("POST", "/aml/request", A.agent.cookie, { propertyId, partyId });
  assert.equal(res.status, 201, await res.clone().text());
  const { verification } = await json<{ verification: { id: number; providerReference: string } }>(res);
  const body = JSON.stringify({ providerReference: verification.providerReference, outcome: "UNABLE_TO_VERIFY", reviewRequired: false });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", process.env.AML_WEBHOOK_SECRET!).update(`${ts}.`).update(body).digest("hex");
  const wh = await fetch(`${baseUrl}/api/aml/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-aml-timestamp": ts, "x-aml-signature": sig }, body });
  assert.equal(wh.status, 200);
  return { propertyId, partyId, verificationId: verification.id };
}

async function auditCount(propertyId: number, actions: string[]): Promise<number> {
  const rows = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.propertyId, propertyId), inArray(auditLogs.action, actions)));
  return rows.length;
}

async function verificationRow(id: number) {
  const [row] = await db.select().from(amlVerifications).where(eq(amlVerifications.id, id));
  return row;
}

/** Replace the requested id in an error message so foreign and missing bodies can be compared structurally. */
function normalise(body: { error: unknown }, id: number): string {
  return JSON.stringify(body).replaceAll(String(id), "<id>");
}

// ---- parties: writes ------------------------------------------------------

for (const who of ["agent", "admin"] as const) {
  test(`POST /parties by B ${who} on A's property: 404 identical to missing, and no party, link or audit row is written`, async () => {
    const propertyId = await createProperty(A.agent.cookie);
    const email = `i10-mallory-${who}-${suffix}@example.com`;
    const linksBefore = (await db.select().from(propertyParties).where(eq(propertyParties.propertyId, propertyId))).length;

    const foreign = await call("POST", "/parties", B[who].cookie, { propertyId, role: "Seller", firstName: "Mallory", lastName: "X", email });
    const missing = await call("POST", "/parties", B[who].cookie, { propertyId: MISSING_ID, role: "Seller", firstName: "Mallory", lastName: "X", email });
    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(await json(foreign), await json(missing));

    assert.equal((await db.select().from(parties).where(eq(parties.email, email))).length, 0, "no orphan party row in either brokerage");
    assert.equal((await db.select().from(propertyParties).where(eq(propertyParties.propertyId, propertyId))).length, linksBefore, "no link on A's property");
    assert.equal(await auditCount(propertyId, ["party_added"]), 0, "no audit row on A's property");
    assert.equal((await db.select().from(amlVerifications).where(eq(amlVerifications.propertyId, propertyId))).length, 0, "no AML side effect");
  });

  test(`DELETE /parties/link/:id by B ${who} on A's link: 404 identical to missing, link kept, no audit row`, async () => {
    const propertyId = await createProperty(A.agent.cookie);
    const { linkId } = await addParty(A.agent.cookie, propertyId, "Seller");
    const foreign = await call("DELETE", `/parties/link/${linkId}`, B[who].cookie);
    const missing = await call("DELETE", `/parties/link/${MISSING_ID}`, B[who].cookie);
    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(await json(foreign), await json(missing));
    assert.equal((await db.select().from(propertyParties).where(eq(propertyParties.id, linkId))).length, 1);
    assert.equal(await auditCount(propertyId, ["party_link_removed"]), 0);
  });

  test(`GET /parties/by-property by B ${who}: 404 identical to missing, no party PII in the body`, async () => {
    const propertyId = await createProperty(A.agent.cookie);
    await addParty(A.agent.cookie, propertyId);
    const foreign = await call("GET", `/parties/by-property/${propertyId}`, B[who].cookie);
    const missing = await call("GET", `/parties/by-property/${MISSING_ID}`, B[who].cookie);
    assert.equal(foreign.status, 404);
    const fText = await foreign.text();
    assert.equal(fText, await missing.text());
    assert.doesNotMatch(fText, /Own|Party|@example\.com/);
  });
}

// ---- AML: writes ----------------------------------------------------------

for (const who of ["agent", "admin"] as const) {
  test(`POST /aml/request by B ${who} for A's property and party: 404, no verification or service order created`, async () => {
    const propertyId = await createProperty(A.agent.cookie);
    const { partyId } = await addParty(A.agent.cookie, propertyId);
    const res = await call("POST", "/aml/request", B[who].cookie, { propertyId, partyId });
    assert.equal(res.status, 404);
    assert.equal((await db.select().from(amlVerifications).where(eq(amlVerifications.propertyId, propertyId))).length, 0);
    assert.equal((await db.select().from(serviceOrders).where(eq(serviceOrders.propertyId, propertyId))).length, 0, "no billable order on A's property");
  });

  test(`POST /aml/request by B ${who} with B's own property and A's party: 404, nothing created on B's property`, async () => {
    const aProp = await createProperty(A.agent.cookie);
    const { partyId } = await addParty(A.agent.cookie, aProp);
    const bProp = await createProperty(B.agent.cookie);
    const res = await call("POST", "/aml/request", B[who].cookie, { propertyId: bProp, partyId });
    assert.equal(res.status, 404);
    assert.equal((await db.select().from(amlVerifications).where(eq(amlVerifications.partyId, partyId))).length, 0);
    assert.equal((await db.select().from(serviceOrders).where(eq(serviceOrders.propertyId, bProp))).length, 0);
  });

  test(`POST /aml/:id/retry by B ${who}: rejection matches a missing id, status unchanged, no audit row`, async () => {
    const s = await seedFailedVerification();
    const before = await verificationRow(s.verificationId);
    const foreign = await call("POST", `/aml/${s.verificationId}/retry`, B[who].cookie);
    const missing = await call("POST", `/aml/${MISSING_ID}/retry`, B[who].cookie);
    assert.equal(foreign.status, missing.status);
    assert.equal(normalise(await json(foreign), s.verificationId), normalise(await json(missing), MISSING_ID));
    const afterRow = await verificationRow(s.verificationId);
    assert.equal(afterRow.status, before.status);
    assert.equal(afterRow.providerReference, before.providerReference, "no new provider request");
    assert.equal(await auditCount(s.propertyId, ["aml_verification_retried"]), 0);
  });
}

test("POST /aml/:id/resolve-exception by B admin: rejection matches a missing id, no audit row, exception still open", async () => {
  const s = await seedFailedVerification();
  const notes = "Cross-brokerage attempt";
  const foreign = await call("POST", `/aml/${s.verificationId}/resolve-exception`, B.admin.cookie, { notes });
  const missing = await call("POST", `/aml/${MISSING_ID}/resolve-exception`, B.admin.cookie, { notes });
  assert.equal(foreign.status, missing.status);
  assert.equal(normalise(await json(foreign), s.verificationId), normalise(await json(missing), MISSING_ID));
  const row = await verificationRow(s.verificationId);
  assert.equal(row.status, "Failed");
  assert.equal(row.exceptionResolvedAt, null);
  assert.equal(await auditCount(s.propertyId, ["aml_exception_resolved"]), 0);
});

test("POST /aml/:id/resolve-exception by B agent is refused before any lookup (403 role gate) and changes nothing", async () => {
  const s = await seedFailedVerification();
  const res = await call("POST", `/aml/${s.verificationId}/resolve-exception`, B.agent.cookie, { notes: "x" });
  assert.equal(res.status, 403);
  assert.equal((await verificationRow(s.verificationId)).status, "Failed");
});

// ---- AML: reads -----------------------------------------------------------

for (const who of ["agent", "admin"] as const) {
  for (const path of ["/aml/by-property", "/aml/service-orders/by-property"]) {
    test(`GET ${path} by B ${who}: byte-identical to a missing property, no A data`, async () => {
      const s = await seedFailedVerification();
      const foreign = await call("GET", `${path}/${s.propertyId}`, B[who].cookie);
      const missing = await call("GET", `${path}/${MISSING_ID}`, B[who].cookie);
      assert.equal(foreign.status, 404);
      assert.equal(await foreign.text(), await missing.text());
    });
  }
}
