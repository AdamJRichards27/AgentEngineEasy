// AE GROW Priority 6 Stage F1 — Call Foundation, Consent Model and Sandbox
// Telephony: HTTP-level regression coverage for routes/growCalls.ts and
// routes/growCallsWebhooks.ts, mirroring
// apps/api/src/routes/__tests__/aiVoice.test.ts / contacts.test.ts's own
// conventions (real HTTP through requireAuth, a real session cookie,
// entitlements granted in the order routes need them, Brokerage A/B for
// tenant isolation).
//
// Covers §22's minimum matrix: tenant isolation; entitlement denial; call
// creation; user confirmation; sandbox lifecycle; valid/invalid state
// transitions; webhook signature verification/replay rejection/idempotency/
// cross-tenant safety; recording fail-closed behaviour; consent creation/
// withdrawal; no recording without consent; audit event creation;
// Relationship Timeline event creation. Existing test suites are untouched.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, auditLogs, growActivities, growCallSessions } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.GROW_CALLS_WEBHOOK_INGRESS_ENABLED = "true";
const GROW_CALLS_WEBHOOK_SECRET =
  process.env.GROW_CALLS_WEBHOOK_SECRET && process.env.GROW_CALLS_WEBHOOK_SECRET.length > 0
    ? process.env.GROW_CALLS_WEBHOOK_SECRET
    : "test-only-grow-calls-webhook-secret-not-for-real-use";
process.env.GROW_CALLS_WEBHOOK_SECRET = GROW_CALLS_WEBHOOK_SECRET;

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageAName = `Grow Calls A ${suffix}`;
const brokerageBName = `Grow Calls B ${suffix}`;
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

function callsUrl(path: string) {
  return `${baseUrl}/api/grow/calls${path}`;
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
    body: JSON.stringify({ propertyId, role: "Buyer", firstName: "Test", lastName: "Party", ...overrides }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  const { party } = (await res.json()) as { party: { id: number } };
  return party.id;
}

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`;
}

function signGrowCallsWebhook(body: string, timestamp: string = String(Date.now())): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-grow-calls-timestamp": timestamp,
    "x-grow-calls-signature": createHmac("sha256", GROW_CALLS_WEBHOOK_SECRET).update(timestamp).update(".").update(body).digest("hex"),
  };
}

async function postWebhookEvent(eventId: string, eventType: string, providerCallId: string, overrideHeaders?: Record<string, string>) {
  const body = JSON.stringify({ eventId, eventType, providerCallId });
  const headers = overrideHeaders ?? signGrowCallsWebhook(body);
  return fetch(`${baseUrl}/api/grow/calls/webhooks/sandbox`, { method: "POST", headers, body });
}

test("unauthenticated requests are rejected across the calls surface", async () => {
  const endpoints: Array<[string, string]> = [
    ["GET", "/contacts/1/eligibility"],
    ["POST", "/"],
    ["GET", "/1"],
    ["POST", "/1/confirm"],
    ["POST", "/1/cancel"],
    ["POST", "/1/consent"],
    ["POST", "/consent/1/withdraw"],
  ];
  for (const [method, path] of endpoints) {
    const res = await fetch(callsUrl(path), {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });
    assert.equal(res.status, 401, `${method} ${path} should require authentication`);
  }
});

let aPartyId: number;

test("every route requires grow.calling.access; POST / and GET .../eligibility 403 until it is granted", async () => {
  const propertyId = await createProperty(A.agent.cookie, "1 Sandbox Calling Way");
  aPartyId = await createParty(A.agent.cookie, propertyId, {
    firstName: "Sarah",
    lastName: "Mitchell",
    email: uniqueEmail("sarah"),
    mobile: "+61412345678",
  });

  const eligBefore = await fetch(callsUrl(`/contacts/${aPartyId}/eligibility`), { headers: { cookie: A.agent.cookie } });
  assert.equal(eligBefore.status, 403);

  const createBefore = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: aPartyId }),
  });
  assert.equal(createBefore.status, 403);
  const createBeforeBody = (await createBefore.json()) as { reason: string };
  assert.equal(createBeforeBody.reason, "ENTITLEMENT_MISSING");

  await grant(A.brokerageId, "grow.calling.access");
  await grant(A.brokerageId, "grow.calling.recording");
  await grant(A.brokerageId, "grow.contacts.read");
});

test("Contact 360 eligibility check: no phone number, valid phone, and ambiguous national-format phone", async () => {
  const propertyId = await createProperty(A.agent.cookie, "2 Eligibility Ct");
  const noPhonePartyId = await createParty(A.agent.cookie, propertyId, { email: uniqueEmail("nophone") });
  const ambiguousPartyId = await createParty(A.agent.cookie, propertyId, { email: uniqueEmail("ambiguous"), mobile: "0212345678" });

  const noPhoneRes = await fetch(callsUrl(`/contacts/${noPhonePartyId}/eligibility`), { headers: { cookie: A.agent.cookie } });
  const noPhoneBody = (await noPhoneRes.json()) as { eligible: boolean; reason: string };
  assert.equal(noPhoneRes.status, 200);
  assert.equal(noPhoneBody.eligible, false);
  assert.equal(noPhoneBody.reason, "NO_PHONE_NUMBER");

  const okRes = await fetch(callsUrl(`/contacts/${aPartyId}/eligibility`), { headers: { cookie: A.agent.cookie } });
  const okBody = (await okRes.json()) as { eligible: boolean; requiresCountryConfirmation: boolean };
  assert.equal(okRes.status, 200);
  assert.equal(okBody.eligible, true);
  assert.equal(okBody.requiresCountryConfirmation, false);

  const ambiguousRes = await fetch(callsUrl(`/contacts/${ambiguousPartyId}/eligibility`), { headers: { cookie: A.agent.cookie } });
  const ambiguousBody = (await ambiguousRes.json()) as { eligible: boolean; requiresCountryConfirmation: boolean };
  assert.equal(ambiguousRes.status, 200);
  assert.equal(ambiguousBody.eligible, true, "still callable — assumedCountry is required at creation time, not at eligibility time");
  assert.equal(ambiguousBody.requiresCountryConfirmation, true);
});

let happyPathSessionId: number;
let happyPathProviderCallId: string;

test("creates a call session, requires confirmation before dialling, and progresses through the sandbox lifecycle to COMPLETED", async () => {
  const createRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: aPartyId }),
  });
  const createBody = (await createRes.json()) as { callSession: { id: number; status: string; destinationNormalized: string; providerCallId: string | null } };
  assert.equal(createRes.status, 201, JSON.stringify(createBody));
  assert.equal(createBody.callSession.status, "READY");
  assert.equal(createBody.callSession.destinationNormalized, "+61412345678");
  assert.equal(createBody.callSession.providerCallId, null, "no sandbox call is placed before explicit confirmation");
  happyPathSessionId = createBody.callSession.id;

  const confirmRes = await fetch(callsUrl(`/${happyPathSessionId}/confirm`), {
    method: "POST",
    headers: { cookie: A.agent.cookie },
  });
  const confirmBody = (await confirmRes.json()) as { callSession: { status: string; providerCallId: string } };
  assert.equal(confirmRes.status, 200, JSON.stringify(confirmBody));
  assert.equal(confirmBody.callSession.status, "DIAL_REQUESTED");
  assert.ok(confirmBody.callSession.providerCallId);
  happyPathProviderCallId = confirmBody.callSession.providerCallId;

  const ringingRes = await postWebhookEvent("evt-ringing-1", "call.ringing", happyPathProviderCallId);
  assert.equal(ringingRes.status, 200);
  const connectedRes = await postWebhookEvent("evt-connected-1", "call.connected", happyPathProviderCallId);
  assert.equal(connectedRes.status, 200);
  const completedRes = await postWebhookEvent("evt-completed-1", "call.completed", happyPathProviderCallId);
  assert.equal(completedRes.status, 200);

  const finalRes = await fetch(callsUrl(`/${happyPathSessionId}`), { headers: { cookie: A.agent.cookie } });
  const finalBody = (await finalRes.json()) as { callSession: { status: string; durationSeconds: number | null; answeredAt: string | null } };
  assert.equal(finalRes.status, 200);
  assert.equal(finalBody.callSession.status, "COMPLETED");
  assert.ok(finalBody.callSession.answeredAt);
  assert.ok(typeof finalBody.callSession.durationSeconds === "number");

  // §16 — audit events for every step of this lifecycle.
  const expectedActions = [
    "grow_call_session_created",
    "grow_call_confirmed",
    "grow_call_started",
    "grow_call_connected",
    "grow_call_completed",
  ];
  for (const action of expectedActions) {
    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, action), eq(auditLogs.recordId, String(happyPathSessionId))));
    assert.ok(rows.length >= 1, `expected at least one ${action} audit row for session ${happyPathSessionId}`);
  }

  // §14 — Relationship Timeline integration: exactly one growActivities row, via a plain
  // activityType "call" insert with no changes to relationshipTimeline.ts required.
  const activityRows = await db
    .select()
    .from(growActivities)
    .where(and(eq(growActivities.sourceId, String(happyPathSessionId)), eq(growActivities.source, "grow_calls")));
  assert.equal(activityRows.length, 1);
  assert.equal(activityRows[0]!.activityType, "call");

  const timelineRes = await fetch(`${baseUrl}/api/grow/contacts/${aPartyId}`, { headers: { cookie: A.agent.cookie } });
  const timelineBody = (await timelineRes.json()) as { timeline: Array<{ type: string; sourceId: number }> };
  assert.equal(timelineRes.status, 200);
  assert.ok(
    timelineBody.timeline.some((e) => e.type === "ACTIVITY_LOGGED" && e.sourceId === happyPathSessionId),
    "the completed sandbox call must surface on the contact's own Relationship Timeline",
  );
});

test("invalid state transitions are rejected: confirming twice, cancelling a COMPLETED call, and a stale webhook replay after completion", async () => {
  const secondConfirmRes = await fetch(callsUrl(`/${happyPathSessionId}/confirm`), { method: "POST", headers: { cookie: A.agent.cookie } });
  assert.equal(secondConfirmRes.status, 409);

  const cancelRes = await fetch(callsUrl(`/${happyPathSessionId}/cancel`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({}),
  });
  assert.equal(cancelRes.status, 409);

  // A "ringing" event delivered again after the call already COMPLETED is an invalid
  // transition — the webhook route reports it as a processing FAILED outcome rather than
  // silently reopening a terminal call.
  const staleEventRes = await postWebhookEvent("evt-stale-ringing", "call.ringing", happyPathProviderCallId);
  const staleEventBody = (await staleEventRes.json()) as { status: string };
  assert.equal(staleEventRes.status, 500);
  assert.equal(staleEventBody.status, "FAILED");
});

test("tenant isolation: Brokerage B cannot read, confirm, or cancel Brokerage A's call session", async () => {
  await grant(B.brokerageId, "grow.calling.access");
  await grant(B.brokerageId, "grow.calling.recording");

  const getRes = await fetch(callsUrl(`/${happyPathSessionId}`), { headers: { cookie: B.agent.cookie } });
  assert.equal(getRes.status, 404);

  const confirmRes = await fetch(callsUrl(`/${happyPathSessionId}/confirm`), { method: "POST", headers: { cookie: B.agent.cookie } });
  assert.equal(confirmRes.status, 404);

  const cancelRes = await fetch(callsUrl(`/${happyPathSessionId}/cancel`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: B.agent.cookie },
    body: JSON.stringify({}),
  });
  assert.equal(cancelRes.status, 404);

  const eligRes = await fetch(callsUrl(`/contacts/${aPartyId}/eligibility`), { headers: { cookie: B.agent.cookie } });
  assert.equal(eligRes.status, 404, "Brokerage B must never see Brokerage A's contact, even for a call-eligibility check");
});

test("a call session can be cancelled before it is ever confirmed", async () => {
  const createRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: aPartyId }),
  });
  const createBody = (await createRes.json()) as { callSession: { id: number } };
  assert.equal(createRes.status, 201);

  const cancelRes = await fetch(callsUrl(`/${createBody.callSession.id}/cancel`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ reason: "Changed my mind" }),
  });
  const cancelBody = (await cancelRes.json()) as { callSession: { status: string; cancelledReason: string | null } };
  assert.equal(cancelRes.status, 200, JSON.stringify(cancelBody));
  assert.equal(cancelBody.callSession.status, "CANCELLED");
  assert.equal(cancelBody.callSession.cancelledReason, "Changed my mind");

  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "grow_call_cancelled"), eq(auditLogs.recordId, String(createBody.callSession.id))));
  assert.equal(rows.length, 1);
});

test("recording is fail-closed: denied with no consent, permitted once a STANDING consent exists, and denied again immediately upon withdrawal", async () => {
  const propertyId = await createProperty(A.agent.cookie, "3 Recording Consent Rd");
  const consentPartyId = await createParty(A.agent.cookie, propertyId, { email: uniqueEmail("consent"), mobile: "+61412000111" });

  const deniedRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: consentPartyId, recordingRequested: true }),
  });
  const deniedBody = (await deniedRes.json()) as { callSession: { id: number; recordingPermitted: boolean; recordingStatus: string } };
  assert.equal(deniedRes.status, 201);
  assert.equal(deniedBody.callSession.recordingPermitted, false);
  assert.equal(deniedBody.callSession.recordingStatus, "DENIED");
  const deniedSessionId = deniedBody.callSession.id;
  const deniedAuditRows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "grow_call_recording_permission_denied"), eq(auditLogs.recordId, String(deniedSessionId))));
  assert.ok(deniedAuditRows.length >= 1);

  const consentRes = await fetch(callsUrl(`/contacts/${consentPartyId}/consent`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ scope: "STANDING", source: "VERBAL_ON_CALL" }),
  });
  const consentBody = (await consentRes.json()) as { consent: { id: number; scope: string; status: string } };
  assert.equal(consentRes.status, 201, JSON.stringify(consentBody));
  assert.equal(consentBody.consent.scope, "STANDING");
  const standingConsentId = consentBody.consent.id;

  const permittedRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: consentPartyId, recordingRequested: true }),
  });
  const permittedBody = (await permittedRes.json()) as { callSession: { id: number; recordingPermitted: boolean; recordingStatus: string; recordingConsentId: number } };
  assert.equal(permittedRes.status, 201);
  assert.equal(permittedBody.callSession.recordingPermitted, true, "a valid STANDING consent must now permit recording for a NEW session");
  assert.equal(permittedBody.callSession.recordingStatus, "PERMITTED_NOT_CAPTURED", "F1 never actually captures/stores audio, even when permitted");
  assert.equal(permittedBody.callSession.recordingConsentId, standingConsentId);
  const permittedSessionId = permittedBody.callSession.id;

  const withdrawRes = await fetch(callsUrl(`/consent/${standingConsentId}/withdraw`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ reason: "No longer consenting" }),
  });
  const withdrawBody = (await withdrawRes.json()) as { consent: { status: string; withdrawnAt: string | null } };
  assert.equal(withdrawRes.status, 200, JSON.stringify(withdrawBody));
  assert.equal(withdrawBody.consent.status, "WITHDRAWN");
  assert.ok(withdrawBody.consent.withdrawnAt);

  // The withdrawal must immediately re-resolve the in-flight session that was pointing at
  // this consent — never leave a stale recordingPermitted = true in place (§9).
  const afterWithdrawRes = await fetch(callsUrl(`/${permittedSessionId}`), { headers: { cookie: A.agent.cookie } });
  const afterWithdrawBody = (await afterWithdrawRes.json()) as { callSession: { recordingPermitted: boolean; recordingStatus: string } };
  assert.equal(afterWithdrawBody.callSession.recordingPermitted, false);
  assert.equal(afterWithdrawBody.callSession.recordingStatus, "DENIED");

  const doubleWithdrawRes = await fetch(callsUrl(`/consent/${standingConsentId}/withdraw`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({}),
  });
  assert.equal(doubleWithdrawRes.status, 409, "a consent already withdrawn cannot be withdrawn again");

  // A NEW session created after withdrawal must be denied again — the withdrawn consent is
  // never resurrected for a fresh resolution.
  const afterWithdrawNewSessionRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: consentPartyId, recordingRequested: true }),
  });
  const afterWithdrawNewSessionBody = (await afterWithdrawNewSessionRes.json()) as { callSession: { recordingPermitted: boolean } };
  assert.equal(afterWithdrawNewSessionRes.status, 201);
  assert.equal(afterWithdrawNewSessionBody.callSession.recordingPermitted, false);

  // PER_CALL consent, explicitly associated with one specific existing session (§8's
  // "call-session association" requirement) — distinct from the STANDING path above.
  const perCallSessionRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: consentPartyId, recordingRequested: true }),
  });
  const perCallSessionBody = (await perCallSessionRes.json()) as { callSession: { id: number; recordingPermitted: boolean } };
  assert.equal(perCallSessionRes.status, 201);
  assert.equal(perCallSessionBody.callSession.recordingPermitted, false, "still denied — no consent has been captured against this session yet");

  const perCallConsentRes = await fetch(callsUrl(`/${perCallSessionBody.callSession.id}/consent`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ scope: "PER_CALL", source: "VERBAL_ON_CALL" }),
  });
  assert.equal(perCallConsentRes.status, 201);

  const afterPerCallConsentRes = await fetch(callsUrl(`/${perCallSessionBody.callSession.id}`), { headers: { cookie: A.agent.cookie } });
  const afterPerCallConsentBody = (await afterPerCallConsentRes.json()) as { callSession: { recordingPermitted: boolean; recordingStatus: string } };
  assert.equal(afterPerCallConsentBody.callSession.recordingPermitted, true);
  assert.equal(afterPerCallConsentBody.callSession.recordingStatus, "PERMITTED_NOT_CAPTURED");
});

test("only STANDING consent may be captured via the contact-level (no call session) endpoint", async () => {
  const res = await fetch(callsUrl(`/contacts/${aPartyId}/consent`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ scope: "PER_CALL", source: "WRITTEN" }),
  });
  assert.equal(res.status, 400);
});

let webhookLifecycleSessionId: number;
let webhookLifecycleProviderCallId: string;

test("webhook signature verification: missing signature, invalid signature, and a stale timestamp are all rejected", async () => {
  const propertyId = await createProperty(A.agent.cookie, "4 Webhook Security Ave");
  const partyId = await createParty(A.agent.cookie, propertyId, { email: uniqueEmail("webhook"), mobile: "+61412000222" });
  const createRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId }),
  });
  const createBody = (await createRes.json()) as { callSession: { id: number } };
  webhookLifecycleSessionId = createBody.callSession.id;
  const confirmRes = await fetch(callsUrl(`/${webhookLifecycleSessionId}/confirm`), { method: "POST", headers: { cookie: A.agent.cookie } });
  const confirmBody = (await confirmRes.json()) as { callSession: { providerCallId: string } };
  webhookLifecycleProviderCallId = confirmBody.callSession.providerCallId;

  const body = JSON.stringify({ eventId: "evt-no-sig", eventType: "call.ringing", providerCallId: webhookLifecycleProviderCallId });

  const missingSigRes = await fetch(`${baseUrl}/api/grow/calls/webhooks/sandbox`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(missingSigRes.status, 401);

  const invalidSigRes = await fetch(`${baseUrl}/api/grow/calls/webhooks/sandbox`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-grow-calls-timestamp": String(Date.now()), "x-grow-calls-signature": "0".repeat(64) },
    body,
  });
  assert.equal(invalidSigRes.status, 401);

  const staleTimestamp = String(Date.now() - 10 * 60 * 1000);
  const staleRes = await fetch(`${baseUrl}/api/grow/calls/webhooks/sandbox`, {
    method: "POST",
    headers: signGrowCallsWebhook(body, staleTimestamp),
    body,
  });
  assert.equal(staleRes.status, 401);

  // The correctly signed, fresh version of the same event succeeds — proving the rejections
  // above were genuinely about the signature/timestamp, not the payload itself.
  const validRes = await fetch(`${baseUrl}/api/grow/calls/webhooks/sandbox`, {
    method: "POST",
    headers: signGrowCallsWebhook(body),
    body,
  });
  assert.equal(validRes.status, 200);
});

test("webhook idempotency: redelivering the same eventId is recognised as a duplicate and never re-applied", async () => {
  const body = JSON.stringify({ eventId: "evt-connected-dup", eventType: "call.connected", providerCallId: webhookLifecycleProviderCallId });
  const headers = signGrowCallsWebhook(body);

  const firstRes = await fetch(`${baseUrl}/api/grow/calls/webhooks/sandbox`, { method: "POST", headers, body });
  const firstBody = (await firstRes.json()) as { status: string };
  assert.equal(firstRes.status, 200);
  assert.equal(firstBody.status, "PROCESSED");

  const replayRes = await fetch(`${baseUrl}/api/grow/calls/webhooks/sandbox`, { method: "POST", headers, body });
  const replayBody = (await replayRes.json()) as { status: string };
  assert.equal(replayRes.status, 200);
  assert.equal(replayBody.status, "DUPLICATE", "a redelivered providerEventId must never be reprocessed");

  const [session] = await db.select().from(growCallSessions).where(eq(growCallSessions.id, webhookLifecycleSessionId));
  assert.equal(session!.status, "CONNECTED", "the duplicate delivery must not have advanced the call session a second time");
});

test("webhook cross-tenant safety: an event for Brokerage A's providerCallId never touches Brokerage B's session, with no brokerageId in the payload at all", async () => {
  const bPropertyId = await createProperty(B.agent.cookie, "5 Cross Tenant Sandbox Rd");
  const bPartyId = await createParty(B.agent.cookie, bPropertyId, { email: uniqueEmail("btenant"), mobile: "+61412000333" });
  const bCreateRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: B.agent.cookie },
    body: JSON.stringify({ partyId: bPartyId }),
  });
  const bCreateBody = (await bCreateRes.json()) as { callSession: { id: number } };
  const bConfirmRes = await fetch(callsUrl(`/${bCreateBody.callSession.id}/confirm`), { method: "POST", headers: { cookie: B.agent.cookie } });
  const bConfirmBody = (await bConfirmRes.json()) as { callSession: { providerCallId: string } };

  // Advance Brokerage B's own session to RINGING.
  const bRingingRes = await postWebhookEvent("evt-b-ringing", "call.ringing", bConfirmBody.callSession.providerCallId);
  assert.equal(bRingingRes.status, 200);

  // Advance Brokerage A's session (still CONNECTED from the idempotency test above) toward
  // COMPLETED using A's own providerCallId — this must never affect B's session.
  const aCompletedRes = await postWebhookEvent("evt-a-completed", "call.completed", webhookLifecycleProviderCallId);
  assert.equal(aCompletedRes.status, 200);

  const [aSession] = await db.select().from(growCallSessions).where(eq(growCallSessions.id, webhookLifecycleSessionId));
  const [bSession] = await db.select().from(growCallSessions).where(eq(growCallSessions.id, bCreateBody.callSession.id));
  assert.equal(aSession!.status, "COMPLETED");
  assert.equal(bSession!.status, "RINGING", "Brokerage B's session must be completely unaffected by Brokerage A's webhook event");
});
