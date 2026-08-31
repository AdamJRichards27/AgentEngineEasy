// Property Timeline prerequisite (#129) — buyer/other-party AML/CTF UI gap
// fix. apps/api/src/lib/aml.ts's initiateAmlIfNeeded() previously had zero
// tenant or property-linkage enforcement: any authenticated user, from any
// brokerage, could pass an arbitrary propertyId/partyId to POST
// /api/aml/request and initiate (or silently retrieve) another tenant's AML
// verification. That gap existed before this change too, but wiring a real
// "Request AML Verification" button to it for buyer/other-party rows makes
// it reachable from ordinary use rather than only a direct API call, so it
// is closed here as part of the same fix (assertPartyOnPropertyInBrokerage
// in lib/aml.ts). These tests prove: the direct request path now works for
// a Buyer/Solicitor party exactly as it already did for a Seller; a second
// request for the same party is idempotent (created: false, no duplicate
// AmlVerification row — "no double AML orders" is a critical, non-optional
// requirement per the build brief); and a cross-tenant property, a
// cross-tenant party, or a real party from the caller's own brokerage that
// simply isn't linked to the given property are all rejected as 404 "not
// found" — indistinguishable from a nonexistent id, so a caller outside the
// brokerage can never confirm another tenant's record exists.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, and } from "drizzle-orm";
import { db, amlVerifications } from "@aee/db";
import { initiateAmlIfNeeded } from "../../lib/aml.js";
import {
  createBrokerageWithUsers,
  createListedProperty,
  cleanupBrokerages,
  type DevLoginResult,
} from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageAName = `Property Timeline Buyer AML A ${suffix}`;
const brokerageBName = `Property Timeline Buyer AML B ${suffix}`;
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

async function addParty(
  cookie: string,
  propertyId: number,
  role: "Buyer" | "Solicitor" | "Other",
  overrides: Record<string, unknown> = {},
): Promise<{ party: { id: number }; link: { id: number; role: string } }> {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      propertyId,
      role,
      firstName: "Bob",
      lastName: "Buyer",
      email: `party-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`,
      ...overrides,
    }),
  });
  if (res.status !== 201) throw new Error(`add ${role} party failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ party: { id: number }; link: { id: number; role: string } }>;
}

async function requestAml(cookie: string, propertyId: number, partyId: number): Promise<Response> {
  return fetch(`${baseUrl}/api/aml/request`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, partyId }),
  });
}

test("POST /api/aml/request initiates a check for a Buyer party — the same generic action the Seller path already relies on — and is idempotent on a repeat click", async () => {
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: "1 Buyer Aml Test Rd" });
  const { party: buyer } = await addParty(A.agent.cookie, propertyId, "Buyer");

  const first = await requestAml(A.agent.cookie, propertyId, buyer.id);
  assert.equal(first.status, 201);
  const firstBody = (await first.json()) as { verification: { id: number; status: string }; created: boolean };
  assert.equal(firstBody.created, true);
  assert.equal(firstBody.verification.status, "Awaiting Seller", "the AmlVerification status vocabulary is role-agnostic — the frontend's amlStatusCopy() renders this the same way for a buyer as for a seller");

  const second = await requestAml(A.agent.cookie, propertyId, buyer.id);
  assert.equal(second.status, 200, "a repeat request returns 200, not 201 — nothing new was created");
  const secondBody = (await second.json()) as { verification: { id: number }; created: boolean };
  assert.equal(secondBody.created, false);
  assert.equal(secondBody.verification.id, firstBody.verification.id, "clicking Request AML Verification twice must never produce a second AmlVerification row");

  const rows = await db
    .select()
    .from(amlVerifications)
    .where(and(eq(amlVerifications.propertyId, propertyId), eq(amlVerifications.partyId, buyer.id)));
  assert.equal(rows.length, 1, "exactly one AmlVerification row must exist no matter how many times the button is clicked");
});

test("POST /api/aml/request works identically for a Solicitor party (any non-Seller role, not just Buyer)", async () => {
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: "2 Solicitor Aml Test Rd" });
  const { party: solicitor } = await addParty(A.agent.cookie, propertyId, "Solicitor", { firstName: "Sally", lastName: "Solicitor" });

  const res = await requestAml(A.agent.cookie, propertyId, solicitor.id);
  assert.equal(res.status, 201);
});

test("POST /api/aml/request rejects a propertyId belonging to a different brokerage as 404, identical to a nonexistent property", async () => {
  const { propertyId: bPropertyId } = await createListedProperty(baseUrl, B.agent.cookie, { address: "3 Cross Tenant Property Rd" });
  const { party: bBuyer } = await addParty(B.agent.cookie, bPropertyId, "Buyer");

  const crossTenant = await requestAml(A.agent.cookie, bPropertyId, bBuyer.id);
  assert.equal(crossTenant.status, 404);
  const crossTenantBody = (await crossTenant.json()) as { error: string };
  assert.match(crossTenantBody.error, /not found/i);

  const nonexistent = await requestAml(A.agent.cookie, 999_999_999, 999_999_999);
  assert.equal(nonexistent.status, 404);
  const nonexistentBody = (await nonexistent.json()) as { error: string };
  // Same 404 + "not found" shape as the cross-tenant case above — a caller
  // can never tell "doesn't exist" apart from "exists but isn't yours".
  assert.match(nonexistentBody.error, /not found/i);
});

test("POST /api/aml/request rejects a partyId belonging to a different brokerage, even against the caller's own property", async () => {
  const { propertyId: aPropertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: "4 Cross Tenant Party Rd" });
  const { propertyId: bPropertyId } = await createListedProperty(baseUrl, B.agent.cookie, { address: "5 Other Brokerage Property Rd" });
  const { party: bBuyer } = await addParty(B.agent.cookie, bPropertyId, "Buyer");

  const res = await requestAml(A.agent.cookie, aPropertyId, bBuyer.id);
  assert.equal(res.status, 404);
});

test("POST /api/aml/request rejects a real party from the caller's own brokerage that simply isn't linked to the given property", async () => {
  const { propertyId: aPropertyId1 } = await createListedProperty(baseUrl, A.agent.cookie, { address: "6 Unlinked Party Property One" });
  const { propertyId: aPropertyId2 } = await createListedProperty(baseUrl, A.agent.cookie, { address: "7 Unlinked Party Property Two" });
  const { party: buyerOnPropertyTwo } = await addParty(A.agent.cookie, aPropertyId2, "Buyer");

  // buyerOnPropertyTwo is a genuine party in A's own brokerage — just never
  // linked to aPropertyId1 — so this proves the check isn't only "same
  // brokerage", it's "actually linked to this property".
  const res = await requestAml(A.agent.cookie, aPropertyId1, buyerOnPropertyTwo.id);
  assert.equal(res.status, 404);
});

test("initiateAmlIfNeeded (lib) enforces the same tenant + linkage guard directly, independent of the route layer", async () => {
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: "8 Direct Lib Call Rd" });
  const { party: buyer } = await addParty(A.agent.cookie, propertyId, "Buyer");

  await assert.rejects(
    () => initiateAmlIfNeeded({ propertyId, partyId: buyer.id, userId: B.agent.user.id, brokerageId: B.brokerageId }),
    /not found/i,
  );

  const created = await initiateAmlIfNeeded({ propertyId, partyId: buyer.id, userId: A.agent.user.id, brokerageId: A.brokerageId });
  assert.equal(created.created, true);

  const again = await initiateAmlIfNeeded({ propertyId, partyId: buyer.id, userId: A.agent.user.id, brokerageId: A.brokerageId });
  assert.equal(again.created, false);
  assert.equal(again.verification.id, created.verification.id);
});
