// AML/CTF cross-tenant IDOR fix — retryAmlVerification / resolveAmlException
// (apps/api/src/lib/aml.ts) and GET /by-property, GET
// /service-orders/by-property (apps/api/src/routes/aml.ts) previously loaded
// or listed by raw id/propertyId with zero brokerage check. Any
// authenticated user could retry another brokerage's (paid) verification;
// a Brokerage Administrator could clear another brokerage's AML/CTF
// compliance exception — a genuine compliance-bypass IDOR, since AML/CTF
// exceptions exist for regulatory reasons, not convenience; and both
// by-property GET routes leaked another tenant's AML verification and
// billing (ServiceOrder) records outright. This is deliberately a separate
// file from amlPartyRequest.test.ts, which covers POST /request's own
// (already-correct) tenant guard — these tests cover the four routes that
// did NOT have one. Fix mirrors assertPartyOnPropertyInBrokerage in
// lib/aml.ts: amlVerifications/serviceOrders carry no brokerageId of their
// own, so every fetch here joins onto properties and filters by the
// caller's brokerageId in that same query, not a check performed after the
// row is loaded — a cross-tenant id is indistinguishable from a
// nonexistent one.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, domainEvents } from "@aee/db";
import {
  createBrokerageWithUsers,
  cleanupBrokerages,
  type DevLoginResult,
} from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.AML_WEBHOOK_SECRET = "aml-webhook-test-secret";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageAName = `AML Tenant Scoping A ${suffix}`;
const brokerageBName = `AML Tenant Scoping B ${suffix}`;
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

async function addBuyer(cookie: string, propertyId: number): Promise<number> {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      propertyId,
      role: "Buyer",
      firstName: "Bob",
      lastName: "Buyer",
      email: `party-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`,
    }),
  });
  if (res.status !== 201) throw new Error(`add party failed: ${res.status} ${await res.text()}`);
  const { party } = await json<{ party: { id: number } }>(res);
  return party.id;
}

/** Property + Buyer party + an ordered AmlVerification (status "Awaiting Seller"), all in one brokerage. */
async function seedVerification(cookie: string): Promise<{ propertyId: number; verificationId: number; providerReference: string }> {
  const propertyId = await createProperty(cookie, `${Math.floor(Math.random() * 1_000_000)} Tenant Scoping Test Rd`);
  const partyId = await addBuyer(cookie, propertyId);
  const res = await fetch(`${baseUrl}/api/aml/request`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, partyId }),
  });
  if (res.status !== 201) throw new Error(`aml request failed: ${res.status} ${await res.text()}`);
  const { verification } = await json<{ verification: { id: number; providerReference: string } }>(res);
  return { propertyId, verificationId: verification.id, providerReference: verification.providerReference };
}

/** Drives a seeded verification to "Failed" via the (unauthenticated) provider webhook, so retry/resolve-exception have something to act on. */
async function failViaWebhook(providerReference: string): Promise<void> {
  const body = JSON.stringify({ providerReference, outcome: "UNABLE_TO_VERIFY", reviewRequired: false });
  const res = await fetch(`${baseUrl}/api/aml/webhook`, {
    method: "POST",
    headers: amlWebhookHeaders(body),
    body,
  });
  if (res.status !== 200) throw new Error(`aml webhook failed: ${res.status} ${await res.text()}`);
}

function amlWebhookHeaders(body: string, timestamp = String(Math.floor(Date.now() / 1000))): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-aml-timestamp": timestamp,
    "x-aml-signature": createHmac("sha256", process.env.AML_WEBHOOK_SECRET!).update(`${timestamp}.`).update(body).digest("hex"),
  };
}

test("AML webhook ingress rejects unsigned, stale, replayed, disabled, and manipulated-context callbacks while a signed sandbox callback succeeds", async () => {
  const seeded = await seedVerification(A.agent.cookie);
  const validBody = JSON.stringify({ providerReference: seeded.providerReference, outcome: "VERIFIED", reviewRequired: false });

  const missingSignature = await fetch(`${baseUrl}/api/aml/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-aml-timestamp": String(Math.floor(Date.now() / 1000)) },
    body: validBody,
  });
  assert.equal(missingSignature.status, 401);

  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301);
  const stale = await fetch(`${baseUrl}/api/aml/webhook`, {
    method: "POST",
    headers: amlWebhookHeaders(validBody, staleTimestamp),
    body: validBody,
  });
  assert.equal(stale.status, 401);

  const tamperedBody = JSON.stringify({
    providerReference: seeded.providerReference,
    outcome: "VERIFIED",
    reviewRequired: false,
    brokerageId: B.brokerageId,
  });
  const tampered = await fetch(`${baseUrl}/api/aml/webhook`, {
    method: "POST",
    headers: amlWebhookHeaders(tamperedBody),
    body: tamperedBody,
  });
  assert.equal(tampered.status, 400);

  process.env.AML_WEBHOOKS_ENABLED = "false";
  try {
    const disabled = await fetch(`${baseUrl}/api/aml/webhook`, {
      method: "POST",
      headers: amlWebhookHeaders(validBody),
      body: validBody,
    });
    assert.equal(disabled.status, 200);
    const beforeValid = await fetch(`${baseUrl}/api/aml/by-property/${seeded.propertyId}`, { headers: { cookie: A.agent.cookie } });
    const beforeValidBody = await json<{ verifications: Array<{ id: number; status: string }> }>(beforeValid);
    assert.equal(beforeValidBody.verifications.find((v) => v.id === seeded.verificationId)?.status, "Awaiting Seller");
  } finally {
    delete process.env.AML_WEBHOOKS_ENABLED;
  }

  const [concurrentA, concurrentB] = await Promise.all(
    [0, 1].map(() =>
      fetch(`${baseUrl}/api/aml/webhook`, {
        method: "POST",
        headers: amlWebhookHeaders(validBody),
        body: validBody,
      }),
    ),
  );
  assert.equal(concurrentA.status, 200);
  assert.equal(concurrentB.status, 200);
  const concurrentBodies = await Promise.all([
    json<{ processed: boolean; reason?: string }>(concurrentA),
    json<{ processed: boolean; reason?: string }>(concurrentB),
  ]);
  assert.equal(concurrentBodies.filter((body) => body.processed).length, 1, "exactly one concurrent delivery may claim and apply the outcome");
  assert.equal(
    concurrentBodies.filter((body) => !body.processed && body.reason === "duplicate_delivery").length,
    1,
    "the delivery waiting on the advisory lock must re-read and become a duplicate",
  );
  const completionEvents = await db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.propertyId, seeded.propertyId), eq(domainEvents.eventType, "AML_COMPLETED")));
  assert.equal(completionEvents.length, 1, "only the successful claimant may publish AML_COMPLETED");

  const replay = await fetch(`${baseUrl}/api/aml/webhook`, {
    method: "POST",
    headers: amlWebhookHeaders(validBody),
    body: validBody,
  });
  assert.equal(replay.status, 200);
  const replayBody = await json<{ processed: boolean; reason?: string }>(replay);
  assert.equal(replayBody.processed, false);
  assert.equal(replayBody.reason, "duplicate_delivery");
});

// --- retry -------------------------------------------------------------

test("POST /api/aml/:verificationId/retry rejects a verification belonging to a different brokerage as if it didn't exist", async () => {
  const seeded = await seedVerification(A.agent.cookie);
  await failViaWebhook(seeded.providerReference);

  const crossTenant = await fetch(`${baseUrl}/api/aml/${seeded.verificationId}/retry`, {
    method: "POST",
    headers: { cookie: B.agent.cookie },
  });
  assert.equal(crossTenant.status, 400, "retryAmlVerification throws, and the route maps every error to 400");
  const body = await json<{ error: string }>(crossTenant);
  assert.match(body.error, /not found/i);
});

test("POST /api/aml/:verificationId/retry succeeds for a caller in the owning brokerage, unchanged", async () => {
  const seeded = await seedVerification(A.agent.cookie);
  await failViaWebhook(seeded.providerReference);

  const res = await fetch(`${baseUrl}/api/aml/${seeded.verificationId}/retry`, {
    method: "POST",
    headers: { cookie: A.agent.cookie },
  });
  assert.equal(res.status, 200);
  const body = await json<{ verification: { id: number; status: string } }>(res);
  assert.equal(body.verification.id, seeded.verificationId);
  assert.equal(body.verification.status, "Awaiting Seller", "a successful retry resets status back to Awaiting Seller");
});

// --- resolve-exception ---------------------------------------------------

test("POST /api/aml/:verificationId/resolve-exception rejects a verification belonging to a different brokerage even for that brokerage's own admin", async () => {
  const seeded = await seedVerification(A.agent.cookie);
  await failViaWebhook(seeded.providerReference);

  const crossTenant = await fetch(`${baseUrl}/api/aml/${seeded.verificationId}/resolve-exception`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: B.admin.cookie },
    body: JSON.stringify({ notes: "Reviewed directly with the provider — clearing to proceed." }),
  });
  assert.equal(crossTenant.status, 400, "resolveAmlException throws, and the route maps every error to 400");
  const body = await json<{ error: string }>(crossTenant);
  assert.match(body.error, /not found/i);

  // Prove the exception genuinely was NOT cleared — this is the compliance
  // bypass the fix closes, not just an error-code detail.
  const stillOpen = await fetch(`${baseUrl}/api/aml/by-property/${seeded.propertyId}`, { headers: { cookie: A.agent.cookie } });
  const stillOpenBody = await json<{ verifications: Array<{ id: number; status: string; exceptionResolvedAt: string | null }> }>(stillOpen);
  const row = stillOpenBody.verifications.find((v) => v.id === seeded.verificationId);
  assert.ok(row, "verification must still be visible to its own brokerage");
  assert.equal(row!.status, "Failed", "status must be untouched by the rejected cross-tenant attempt");
  assert.equal(row!.exceptionResolvedAt, null);
});

test("POST /api/aml/:verificationId/resolve-exception succeeds for a Brokerage Administrator in the owning brokerage, unchanged", async () => {
  const seeded = await seedVerification(A.agent.cookie);
  await failViaWebhook(seeded.providerReference);

  const res = await fetch(`${baseUrl}/api/aml/${seeded.verificationId}/resolve-exception`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ notes: "Reviewed directly with the provider — clearing to proceed." }),
  });
  assert.equal(res.status, 200);
  const body = await json<{ verification: { id: number; status: string; exceptionResolvedAt: string | null } }>(res);
  assert.equal(body.verification.id, seeded.verificationId);
  assert.equal(body.verification.status, "Complete");
  assert.ok(body.verification.exceptionResolvedAt);
});

// --- by-property GETs ----------------------------------------------------

test("GET /api/aml/by-property/:propertyId returns nothing for a different brokerage's property, and the owning brokerage's own records unchanged", async () => {
  const seeded = await seedVerification(A.agent.cookie);

  const crossTenant = await fetch(`${baseUrl}/api/aml/by-property/${seeded.propertyId}`, { headers: { cookie: B.agent.cookie } });
  assert.equal(crossTenant.status, 404);
  assert.deepEqual(await json<{ error: string }>(crossTenant), { error: "Not found" });

  const sameTenant = await fetch(`${baseUrl}/api/aml/by-property/${seeded.propertyId}`, { headers: { cookie: A.agent.cookie } });
  assert.equal(sameTenant.status, 200);
  const sameTenantBody = await json<{ verifications: Array<{ id: number }> }>(sameTenant);
  assert.ok(sameTenantBody.verifications.some((v) => v.id === seeded.verificationId), "the owning brokerage must still see its own verification");
});

test("GET /api/aml/service-orders/by-property/:propertyId returns nothing for a different brokerage's property, and the owning brokerage's own billing records unchanged", async () => {
  const seeded = await seedVerification(A.agent.cookie);

  const crossTenant = await fetch(`${baseUrl}/api/aml/service-orders/by-property/${seeded.propertyId}`, { headers: { cookie: B.agent.cookie } });
  assert.equal(crossTenant.status, 404);
  assert.deepEqual(await json<{ error: string }>(crossTenant), { error: "Not found" });

  const sameTenant = await fetch(`${baseUrl}/api/aml/service-orders/by-property/${seeded.propertyId}`, { headers: { cookie: A.agent.cookie } });
  assert.equal(sameTenant.status, 200);
  const sameTenantBody = await json<{ serviceOrders: Array<{ propertyId: number }> }>(sameTenant);
  assert.ok(sameTenantBody.serviceOrders.length > 0, "the owning brokerage must still see its own ServiceOrder for this verification");
  assert.ok(sameTenantBody.serviceOrders.every((so) => so.propertyId === seeded.propertyId));
});
