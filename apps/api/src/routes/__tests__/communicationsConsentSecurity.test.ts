// AE GROW Completion Program W1-A — consent write-path security.
//
// Covers three of the four defects this slice closes, all on
// POST/GET /api/communications/consent (routes/communications.ts) and
// recordConsent() (lib/communications/consent.ts):
//
//   A-2 (P0) — both routes were requireAuth-only. routes/index.ts mounts
//     every router with no requireEntitlement and communications.ts has no
//     router-level .use() guard, so any authenticated brokerage user could
//     set marketingOptIn: true for any destination, source "MANUAL", no
//     evidence — manufacturing marketing consent. The write is now gated on
//     grow.contacts.manage and the read on grow.contacts.read.
//
//   A-5 (P1) — partyId was taken straight off the request body and written
//     through unchecked, so a foreign tenant's party id could be stamped on
//     this brokerage's consent row and then emitted on the event bus as a
//     mismatched (brokerageId, partyId) pair. It is now validated against
//     the caller's brokerage before anything is written or published.
//
//   A-4 (P1) — consent is mutated in place and the audit entry recorded
//     only updatedValue, so a withdrawal was indistinguishable from a grant
//     after the fact. Every consent change now leaves a before/after pair.
//
// Same real-HTTP conventions as communications.test.ts and
// communicationsGrowThreadEntitlement.test.ts: a real Express server, real
// fetch calls, direct DB reads only where an assertion needs to see
// something the HTTP response does not expose (audit rows, consent rows,
// domain events).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, desc } from "drizzle-orm";
import { db, auditLogs, communicationConsent, domainEvents, entitlementGrants } from "@aee/db";
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

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `W1A Consent Security A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `W1A Consent Security B ${suffix}`);
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

async function revoke(brokerageId: number, entitlementKey: string) {
  await db
    .update(entitlementGrants)
    .set({ status: "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, entitlementKey)));
  invalidateEntitlementCache(brokerageId);
}

function postConsent(cookie: string, body: unknown) {
  return fetch(`${baseUrl}/api/communications/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

function getConsent(cookie: string, query: string) {
  return fetch(`${baseUrl}/api/communications/consent?${query}`, { headers: { cookie } });
}

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { property: { id: number } }).property.id;
}

async function createParty(cookie: string, propertyId: number, email: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, role: "Buyer", firstName: "Consent", lastName: "Subject", email, mobile: "0400333444" }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { party: { id: number } }).party.id;
}

// ---------------------------------------------------------------------
// A-2 — entitlement gate on the write and the read.
// ---------------------------------------------------------------------

test("A-2: an authenticated user without grow.contacts.manage cannot manufacture marketing consent (403), and nothing is written", async () => {
  const destination = `a2-manufactured-${suffix}@example.com`;

  const blocked = await postConsent(A.agent.cookie, { channel: "EMAIL", destination, marketingOptIn: true });
  assert.equal(blocked.status, 403, await blocked.clone().text());
  const body = (await blocked.json()) as { error: string; reason: string; entitlementKey: string };
  assert.equal(body.error, "Not entitled");
  assert.equal(body.reason, "ENTITLEMENT_MISSING");
  assert.equal(body.entitlementKey, "grow.contacts.manage");

  const rows = await db
    .select()
    .from(communicationConsent)
    .where(and(eq(communicationConsent.brokerageId, A.brokerageId), eq(communicationConsent.destination, destination)));
  assert.equal(rows.length, 0, "a 403'd consent write must leave no consent row behind");

  // The same call succeeds once the brokerage actually holds the key — this
  // is an entitlement gate, not a blanket refusal.
  await grant(A.brokerageId, "grow.contacts.manage");
  const allowed = await postConsent(A.agent.cookie, { channel: "EMAIL", destination, marketingOptIn: true });
  assert.equal(allowed.status, 201, await allowed.clone().text());
  const consent = (await allowed.json()) as { marketingOptIn: boolean; source: string };
  assert.equal(consent.marketingOptIn, true);
  assert.equal(consent.source, "MANUAL");
});

test("A-2: reading a consent decision requires grow.contacts.read", async () => {
  const destination = `a2-read-${suffix}@example.com`;
  const query = `channel=EMAIL&destination=${encodeURIComponent(destination)}&classification=MARKETING`;

  const blocked = await getConsent(A.agent.cookie, query);
  assert.equal(blocked.status, 403, await blocked.clone().text());
  assert.equal(((await blocked.json()) as { entitlementKey: string }).entitlementKey, "grow.contacts.read");

  await grant(A.brokerageId, "grow.contacts.read");
  const allowed = await getConsent(A.agent.cookie, query);
  assert.equal(allowed.status, 200, await allowed.clone().text());
  const result = (await allowed.json()) as { allowed: boolean; consent: unknown };
  assert.equal(result.allowed, false, "no consent record at all is still NOT opted in — the safe default is unchanged");
  assert.equal(result.consent, null);
});

test("A-2: the gate is the entitlement, not the session — a revoked brokerage loses the write again", async () => {
  await revoke(A.brokerageId, "grow.contacts.manage");
  const res = await postConsent(A.agent.cookie, {
    channel: "EMAIL",
    destination: `a2-revoked-${suffix}@example.com`,
    marketingOptIn: true,
  });
  assert.equal(res.status, 403, await res.clone().text());
  await grant(A.brokerageId, "grow.contacts.manage");
});

// ---------------------------------------------------------------------
// A-5 — partyId tenancy validation.
// ---------------------------------------------------------------------

test("A-5: a foreign-tenant partyId is rejected with 400, writes no row, and publishes no event", async () => {
  await grant(B.brokerageId, "grow.contacts.manage");

  // A real party that belongs to brokerage B, not to A.
  const foreignPropertyId = await createProperty(B.agent.cookie, `1 Foreign Party St ${suffix}`);
  const foreignPartyId = await createParty(B.agent.cookie, foreignPropertyId, `b-party-${suffix}@example.com`);

  const destination = `a5-foreign-${suffix}@example.com`;
  const eventsBefore = await db.select({ id: domainEvents.id }).from(domainEvents).where(eq(domainEvents.brokerageId, A.brokerageId));

  const res = await postConsent(A.agent.cookie, {
    channel: "EMAIL",
    destination,
    partyId: foreignPartyId,
    marketingOptIn: true,
  });
  assert.equal(res.status, 400, await res.clone().text());
  assert.match(((await res.json()) as { error: string }).error, /does not belong to your brokerage/i);

  const rows = await db
    .select()
    .from(communicationConsent)
    .where(and(eq(communicationConsent.brokerageId, A.brokerageId), eq(communicationConsent.destination, destination)));
  assert.equal(rows.length, 0, "a rejected foreign partyId must leave no consent row");

  const eventsAfter = await db.select({ id: domainEvents.id }).from(domainEvents).where(eq(domainEvents.brokerageId, A.brokerageId));
  assert.equal(
    eventsAfter.length,
    eventsBefore.length,
    "a rejected foreign partyId must publish no COMMUNICATION_CONSENT_UPDATED carrying a mismatched (brokerageId, partyId) pair",
  );
});

test("A-5: the caller's own partyId is still accepted and stamped on the consent row", async () => {
  const propertyId = await createProperty(A.agent.cookie, `2 Own Party St ${suffix}`);
  const ownPartyId = await createParty(A.agent.cookie, propertyId, `a-party-${suffix}@example.com`);
  const destination = `a5-own-${suffix}@example.com`;

  const res = await postConsent(A.agent.cookie, { channel: "EMAIL", destination, partyId: ownPartyId, marketingOptIn: true });
  assert.equal(res.status, 201, await res.clone().text());
  const consent = (await res.json()) as { partyId: number; brokerageId: number };
  assert.equal(consent.partyId, ownPartyId);
  assert.equal(consent.brokerageId, A.brokerageId);
});

test("A-5: an unknown partyId is rejected the same way as a foreign one", async () => {
  const res = await postConsent(A.agent.cookie, {
    channel: "EMAIL",
    destination: `a5-unknown-${suffix}@example.com`,
    partyId: 2_000_000_000,
    marketingOptIn: true,
  });
  assert.equal(res.status, 400, await res.clone().text());
});

// ---------------------------------------------------------------------
// A-4 — before/after audit pair on every consent change.
// ---------------------------------------------------------------------

async function latestConsentAudit(consentId: number) {
  const [row] = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.recordType, "communication_consent"), eq(auditLogs.recordId, String(consentId))))
    .orderBy(desc(auditLogs.id))
    .limit(1);
  return row;
}

test("A-4: every consent change leaves a before/after audit pair, including the withdrawal that overwrites a grant", async () => {
  const destination = `a4-audit-${suffix}@example.com`;

  // 1. First write — there was no prior record at all.
  const created = await postConsent(A.agent.cookie, { channel: "EMAIL", destination, marketingOptIn: true });
  assert.equal(created.status, 201, await created.clone().text());
  const consentId = ((await created.json()) as { id: number }).id;

  const first = await latestConsentAudit(consentId);
  assert.ok(first, "the creating write must be audited");
  assert.equal(first!.previousValue, "none", "a brand-new consent record has no prior value");
  assert.equal(first!.updatedValue, "marketingOptIn=true,transactionalOptOut=false");
  assert.equal(first!.brokerageId, A.brokerageId, "consent audit evidence must be tenant-scoped");

  // 2. The withdrawal. This is the case that was previously unrecoverable:
  //    the consent row is mutated in place, so without previousValue the
  //    audit log could not tell you the recipient HAD been opted in.
  const withdrawn = await postConsent(A.agent.cookie, {
    channel: "EMAIL",
    destination,
    marketingOptIn: false,
    transactionalOptOut: true,
  });
  assert.equal(withdrawn.status, 201, await withdrawn.clone().text());
  assert.equal(((await withdrawn.json()) as { id: number }).id, consentId, "the same row is updated in place — the schema is unchanged by this slice");

  const second = await latestConsentAudit(consentId);
  assert.equal(second!.previousValue, "marketingOptIn=true,transactionalOptOut=false", "the withdrawal must record what consent was before it");
  assert.equal(second!.updatedValue, "marketingOptIn=false,transactionalOptOut=true");
  assert.notEqual(second!.id, first!.id, "each change appends its own audit row");

  // 3. The pair reconstructs the history the mutated row itself cannot: the
  //    chain of (previous -> updated) values is continuous.
  const chain = await db
    .select({ previousValue: auditLogs.previousValue, updatedValue: auditLogs.updatedValue })
    .from(auditLogs)
    .where(and(eq(auditLogs.recordType, "communication_consent"), eq(auditLogs.recordId, String(consentId))))
    .orderBy(auditLogs.id);
  assert.equal(chain.length, 2);
  assert.equal(chain[1]!.previousValue, chain[0]!.updatedValue, "each entry's before value is the previous entry's after value");
});
