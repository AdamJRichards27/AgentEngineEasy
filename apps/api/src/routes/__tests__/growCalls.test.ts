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
// cross-tenant safety; recording fail-closed behaviour with in-call
// disclosure/confirmation; consent creation/
// withdrawal; no recording without consent; audit event creation;
// Relationship Timeline event creation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  entitlementGrants,
  auditLogs,
  growActivities,
  growCallSessions,
  growCallRecordingConsents,
  parties,
  growContactChannelConsents,
  growConsentDecisions,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import {
  captureConsentState,
  recordConsentPolicy,
  recordDncrStatus,
} from "../../lib/consentControlsPersistence.js";
import {
  PHONE_CALL_CONSENT_PURPOSE,
  PHONE_CALL_CONSENT_SCOPE,
} from "../../lib/telephony/eligibility.js";
import { applySandboxLifecycleEvent } from "../../lib/telephony/callSessions.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.GROW_CALLS_WEBHOOK_INGRESS_ENABLED = "true";
process.env.LIVE_RECORDING_APPROVED = "false";
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

test("F3 transcription route requires authentication and its separate entitlement before inspecting a call", async () => {
  const unauthenticated = await fetch(callsUrl("/1/transcription"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recordingReference: 1 }),
  });
  assert.equal(unauthenticated.status, 401);

  const denied = await fetch(callsUrl("/1/transcription"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ recordingReference: 1 }),
  });
  assert.equal(denied.status, 403);
  const body = await denied.json() as { entitlementKey?: string };
  assert.equal(body.entitlementKey, "grow.calling.transcription");
});

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
  const owner = cookie === A.agent.cookie ? A.agent : B.agent;
  await seedCallEvidence(owner.user.brokerageId, owner.user.id, party.id);
  return party.id;
}

/**
 * Some F2 compliance fixtures deliberately need to start without the
 * canonical PHONE_CALL evidence that createParty() installs for the F1
 * lifecycle matrix.  The caller then records the exact consent/DNCR/policy
 * evidence under test before invoking the HTTP route.
 */
async function createPartyWithoutCallEvidence(cookie: string, propertyId: number, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, role: "Buyer", firstName: "Evidence", lastName: "Fixture", ...overrides }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  const { party } = (await res.json()) as { party: { id: number } };
  return party.id;
}

const seededCallBrokerages = new Set<number>();

/**
 * F2 makes call eligibility an explicit fixture.  Every F1 route test contact
 * receives a canonical PHONE_CALL consent, an effective AU policy with a
 * reviewed DNCR requirement, and a fresh cleared DNCR observation.  The
 * recording policy is explicit too; the sandbox adapter still denies actual
 * recording, so this never relaxes a recording gate.
 */
async function seedCallEvidence(brokerageId: number, userId: number, partyId: number): Promise<number> {
  if (!seededCallBrokerages.has(brokerageId)) {
    await recordConsentPolicy({
      brokerageId,
      jurisdiction: "AU",
      version: `f2-call-${brokerageId}-${suffix}`,
      effectiveAt: new Date(Date.now() - 60_000),
      dncrRequired: true,
      suppressionEnabled: true,
      timeZone: "Etc/UTC",
      allowedHoursStart: "00:00",
      allowedHoursEnd: "00:00",
      policyData: { recordingPolicy: { allowed: true, jurisdiction: "AU" } },
      recordedByUserId: userId,
    });
    seededCallBrokerages.add(brokerageId);
  }

  const consent = await captureConsentState({
    brokerageId,
    partyId,
    channel: "PHONE_CALL",
    state: "EXPRESS",
    source: "f2-route-fixture",
    captureMethod: "test-fixture",
    purpose: PHONE_CALL_CONSENT_PURPOSE,
    scope: PHONE_CALL_CONSENT_SCOPE,
    jurisdiction: "AU",
    recordedByUserId: userId,
  });
  await recordDncrStatus({
    brokerageId,
    partyId,
    channel: "PHONE_CALL",
    jurisdiction: "AU",
    status: "CLEARED",
    checkedAt: new Date(Date.now() - 1_000),
    validUntil: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    reviewAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    source: "f2-route-fixture",
    reference: `dncr-fixture-${partyId}`,
    recordedByUserId: userId,
  });
  return consent.id;
}

async function withdrawCallEvidence(brokerageId: number, userId: number, partyId: number): Promise<void> {
  const [head] = await db
    .select()
    .from(growContactChannelConsents)
    .where(
      and(
        eq(growContactChannelConsents.brokerageId, brokerageId),
        eq(growContactChannelConsents.partyId, partyId),
        eq(growContactChannelConsents.channel, "PHONE_CALL"),
        eq(growContactChannelConsents.purpose, PHONE_CALL_CONSENT_PURPOSE),
        eq(growContactChannelConsents.scope, PHONE_CALL_CONSENT_SCOPE),
      ),
    )
    .orderBy(desc(growContactChannelConsents.id))
    .limit(1);
  if (!head) throw new Error(`no call consent fixture for party ${partyId}`);
  await captureConsentState({
    brokerageId,
    partyId,
    channel: "PHONE_CALL",
    state: "WITHDRAWN",
    source: "f2-route-test",
    captureMethod: "test",
    purpose: PHONE_CALL_CONSENT_PURPOSE,
    scope: PHONE_CALL_CONSENT_SCOPE,
    jurisdiction: "AU",
    withdrawnAt: new Date(),
    withdrawnByUserId: userId,
    withdrawalReason: "withdrawn between create and confirm",
    supersedesConsentId: head.id,
    recordedByUserId: userId,
  });
}

async function assertConsentDecisionAudit(
  decision: { id: number; partyId: number },
  expected: { brokerageId: number; userId: number; reasonCode: string },
): Promise<void> {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.brokerageId, expected.brokerageId),
        eq(auditLogs.action, "grow_consent_decision_recorded"),
        eq(auditLogs.recordId, String(decision.id)),
      ),
    );
  assert.equal(rows.length, 1, `expected exactly one consent-decision audit for decision ${decision.id}`);
  const [row] = rows;
  assert.equal(row!.action, "grow_consent_decision_recorded");
  assert.equal(row!.recordType, "grow_consent_decision");
  assert.equal(row!.recordId, String(decision.id));
  assert.equal(row!.brokerageId, expected.brokerageId);
  assert.equal(row!.userId, expected.userId);
  assert.equal(row!.providerReference, `grow-consent-decision:${decision.id}`);

  const payload = JSON.parse(row!.updatedValue ?? "{}") as {
    id?: number;
    brokerageId?: number;
    partyId?: number;
    reasonCode?: string;
  };
  assert.equal(payload.id, decision.id);
  assert.equal(payload.brokerageId, expected.brokerageId);
  assert.equal(payload.partyId, decision.partyId);
  assert.equal(payload.reasonCode, expected.reasonCode);
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

// Provider event ids are globally unique in telephony_webhook_receipts, so
// every id this file sends carries a per-run suffix — a fixed literal would
// collide with a previous (or concurrent) run's receipt and be treated as a
// DUPLICATE instead of being applied.
const webhookEventRunId = `${suffix}-${randomUUID().slice(0, 8)}`;
function webhookEventId(label: string): string {
  return `${label}-${webhookEventRunId}`;
}

async function postWebhookEvent(eventId: string, eventType: string, providerCallId: string, overrideHeaders?: Record<string, string>) {
  const body = JSON.stringify({ eventId: webhookEventId(eventId), eventType, providerCallId });
  const headers = overrideHeaders ?? signGrowCallsWebhook(body);
  return fetch(`${baseUrl}/api/grow/calls/webhooks/sandbox`, { method: "POST", headers, body });
}

test("unauthenticated requests are rejected across the calls surface", async () => {
  const endpoints: Array<[string, string]> = [
    ["GET", "/contacts/1/eligibility"],
    ["POST", "/"],
    ["GET", "/1"],
    ["GET", "/1/recording/status"],
    ["POST", "/1/confirm"],
    ["POST", "/1/cancel"],
    ["POST", "/1/consent"],
    ["POST", "/1/recording/disclosure"],
    ["POST", "/1/recording/disclose"],
    ["POST", "/1/recording/confirm"],
    ["POST", "/1/recording/decline"],
    ["POST", "/contacts/1/consent"],
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
  assert.equal(ambiguousBody.eligible, false, "an ambiguous national number is not eligible until its country is confirmed");
  assert.equal(ambiguousBody.requiresCountryConfirmation, true);
});

test("creation rejects an arbitrary destinationRaw that does not match the contact phone", async () => {
  const propertyId = await createProperty(A.agent.cookie, "2 Destination Binding Way");
  const partyId = await createParty(A.agent.cookie, propertyId, {
    email: uniqueEmail("destination-binding"),
    mobile: "+61412000999",
  });

  const res = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId, destinationRaw: "+61412000888" }),
  });
  const body = (await res.json()) as { error: string };
  assert.equal(res.status, 400);
  assert.match(body.error, /destination must match/i);
});

test("confirmation rejects a session when the contact phone changes after creation", async () => {
  const propertyId = await createProperty(A.agent.cookie, "2 Confirm Binding Way");
  const partyId = await createParty(A.agent.cookie, propertyId, {
    email: uniqueEmail("confirm-binding"),
    mobile: "+61412000888",
  });
  const createRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({
      partyId,
      eligible: true,
      consentDecisionId: 999999999,
      recordingPermitted: true,
      gates: { allPassed: true },
      provider: "live",
      liveApproval: true,
    }),
  });
  const createBody = (await createRes.json()) as { callSession: { id: number } };
  assert.equal(createRes.status, 201);
  await db.update(parties).set({ mobile: "+61412000887" }).where(eq(parties.id, partyId));

  const confirmRes = await fetch(callsUrl(`/${createBody.callSession.id}/confirm`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({
      eligible: true,
      consentDecisionId: 999999999,
      recordingPermitted: true,
      gates: { allPassed: true },
      provider: "live",
      liveApproval: true,
    }),
  });
  const confirmBody = (await confirmRes.json()) as { error: string };
  assert.equal(confirmRes.status, 409);
  assert.match(confirmBody.error, /phone number changed/i);
  const [session] = await db.select().from(growCallSessions).where(eq(growCallSessions.id, createBody.callSession.id));
  assert.equal(session!.status, "READY");
  assert.equal(session!.providerCallId, null);
  const bindingAudits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "grow_call_destination_binding_denied"), eq(auditLogs.recordId, String(createBody.callSession.id))));
  assert.equal(bindingAudits.length, 1);
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
    timelineBody.timeline.some((e) => e.type === "ACTIVITY_LOGGED" && e.sourceId === activityRows[0]!.id),
    "the completed sandbox call must surface on the contact's own Relationship Timeline",
  );
});

test("invalid state transitions are rejected: confirming twice, cancelling a COMPLETED call, and a stale webhook replay after completion", async () => {
  const secondConfirmRes = await fetch(callsUrl(`/${happyPathSessionId}/confirm`), { method: "POST", headers: { cookie: A.agent.cookie } });
  assert.equal(secondConfirmRes.status, 409);

  const duplicateTerminalRes = await postWebhookEvent("evt-duplicate-completed", "call.completed", happyPathProviderCallId);
  const duplicateTerminalBody = (await duplicateTerminalRes.json()) as { status: string };
  assert.equal(duplicateTerminalRes.status, 200);
  assert.equal(duplicateTerminalBody.status, "PROCESSED", "a fresh delivery of the already-applied terminal target is idempotently accepted");

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
  // Grant F3 explicitly so the cross-tenant assertion reaches the service
  // lookup instead of being masked by the entitlement middleware's 403.
  await grant(B.brokerageId, "grow.calling.transcription");

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

test("same-brokerage non-owners cannot read or mutate a session, while the explicit administrator role can read it", async () => {
  const otherAgent = await devLogin(baseUrl, {
    email: uniqueEmail("same-brokerage-agent"),
    firstName: "Second",
    lastName: "Agent",
    brokerageName: brokerageAName,
  });
  const createRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: aPartyId }),
  });
  const createBody = (await createRes.json()) as { callSession: { id: number } };
  assert.equal(createRes.status, 201);

  const otherGet = await fetch(callsUrl(`/${createBody.callSession.id}`), { headers: { cookie: otherAgent.cookie } });
  assert.equal(otherGet.status, 403);
  const otherCancel = await fetch(callsUrl(`/${createBody.callSession.id}/cancel`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: otherAgent.cookie },
    body: JSON.stringify({}),
  });
  assert.equal(otherCancel.status, 403);

  const adminGet = await fetch(callsUrl(`/${createBody.callSession.id}`), { headers: { cookie: A.admin.cookie } });
  assert.equal(adminGet.status, 200);
});

test("concurrent confirmation has one CAS winner and one sandbox dial", async () => {
  const propertyId = await createProperty(A.agent.cookie, "2 Concurrent Confirm Way");
  const partyId = await createParty(A.agent.cookie, propertyId, {
    email: uniqueEmail("concurrent-confirm"),
    mobile: "+61412000666",
  });
  const createRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId }),
  });
  const createBody = (await createRes.json()) as { callSession: { id: number } };
  assert.equal(createRes.status, 201);

  const responses = await Promise.all(
    Array.from({ length: 2 }, () =>
      fetch(callsUrl(`/${createBody.callSession.id}/confirm`), {
        method: "POST",
        headers: { cookie: A.agent.cookie },
      }),
    ),
  );
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const [session] = await db.select().from(growCallSessions).where(eq(growCallSessions.id, createBody.callSession.id));
  assert.equal(session!.status, "DIAL_REQUESTED");
  assert.ok(session!.providerCallId);
  const startedAudits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "grow_call_started"), eq(auditLogs.recordId, String(createBody.callSession.id))));
  assert.equal(startedAudits.length, 1);
});

test("concurrent terminal webhooks have one CAS winner and one idempotent terminal replay", async () => {
  const propertyId = await createProperty(A.agent.cookie, "3 Concurrent Webhook Way");
  const partyId = await createParty(A.agent.cookie, propertyId, {
    email: uniqueEmail("concurrent-webhook"),
    mobile: "+61412000777",
  });
  const createRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId }),
  });
  const createBody = (await createRes.json()) as { callSession: { id: number } };
  const confirmRes = await fetch(callsUrl(`/${createBody.callSession.id}/confirm`), { method: "POST", headers: { cookie: A.agent.cookie } });
  const confirmBody = (await confirmRes.json()) as { callSession: { providerCallId: string } };
  assert.equal(confirmRes.status, 200);
  assert.equal((await postWebhookEvent("evt-concurrent-ring", "call.ringing", confirmBody.callSession.providerCallId)).status, 200);
  assert.equal((await postWebhookEvent("evt-concurrent-connect", "call.connected", confirmBody.callSession.providerCallId)).status, 200);
  const terminal = await Promise.all([
    postWebhookEvent("evt-concurrent-complete-a", "call.completed", confirmBody.callSession.providerCallId),
    postWebhookEvent("evt-concurrent-complete-b", "call.completed", confirmBody.callSession.providerCallId),
  ]);
  assert.deepEqual(terminal.map((response) => response.status).sort(), [200, 200]);
  const [session] = await db.select().from(growCallSessions).where(eq(growCallSessions.id, createBody.callSession.id));
  assert.equal(session!.status, "COMPLETED");
  const activityRows = await db
    .select()
    .from(growActivities)
    .where(and(eq(growActivities.sourceId, String(createBody.callSession.id)), eq(growActivities.source, "grow_calls")));
  assert.equal(activityRows.length, 1);
});

test("recording closure audit failure cannot roll back COMPLETED or FAILED base calls", async () => {
  async function prepareConnectedSession(label: string, mobile: string): Promise<number> {
    const propertyId = await createProperty(A.agent.cookie, `${label} Recording Fault Way`);
    const partyId = await createParty(A.agent.cookie, propertyId, {
      email: uniqueEmail(`recording-fault-${label.toLowerCase()}`),
      mobile,
    });
    const consentRes = await fetch(callsUrl(`/contacts/${partyId}/consent`), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.agent.cookie },
      body: JSON.stringify({ scope: "STANDING", source: "VERBAL_ON_CALL", jurisdiction: "AU" }),
    });
    assert.equal(consentRes.status, 201, await consentRes.text());
    const createRes = await fetch(callsUrl("/"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.agent.cookie },
      body: JSON.stringify({ partyId, recordingRequested: true }),
    });
    const createBody = (await createRes.json()) as { callSession: { id: number } };
    assert.equal(createRes.status, 201, JSON.stringify(createBody));
    const confirmRes = await fetch(callsUrl(`/${createBody.callSession.id}/confirm`), { method: "POST", headers: { cookie: A.agent.cookie } });
    const confirmBody = (await confirmRes.json()) as { callSession: { providerCallId: string } };
    assert.equal(confirmRes.status, 200, JSON.stringify(confirmBody));
    assert.equal((await postWebhookEvent(`${label}-fault-ringing`, "call.ringing", confirmBody.callSession.providerCallId)).status, 200);
    assert.equal((await postWebhookEvent(`${label}-fault-connected`, "call.connected", confirmBody.callSession.providerCallId)).status, 200);
    return createBody.callSession.id;
  }

  const failRecordingAudit = async () => {
    throw new Error("injected recording closure audit failure");
  };

  const completedSessionId = await prepareConnectedSession("completed", "+61412000701");
  const completed = await applySandboxLifecycleEvent(completedSessionId, "COMPLETED", { recordingClosureAuditWriter: failRecordingAudit });
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.recordingStatus, "UNRECORDED");
  assert.equal(completed.recordingPermitted, false);
  const [completedStored] = await db.select().from(growCallSessions).where(eq(growCallSessions.id, completedSessionId));
  assert.equal(completedStored!.status, "COMPLETED");
  assert.equal(completedStored!.recordingStatus, "UNRECORDED");
  assert.equal(completedStored!.recordingPermitted, false);
  await applySandboxLifecycleEvent(completedSessionId, "COMPLETED");
  const completedRecordingAudits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "grow_call_recording_unrecorded"), eq(auditLogs.recordId, String(completedSessionId))));
  assert.equal(completedRecordingAudits.length, 1, "a later terminal delivery can retry the recording-only audit");

  const failedSessionId = await prepareConnectedSession("failed", "+61412000702");
  const failed = await applySandboxLifecycleEvent(failedSessionId, "FAILED", { recordingClosureAuditWriter: failRecordingAudit });
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.recordingStatus, "UNRECORDED");
  assert.equal(failed.recordingPermitted, false);
  const [failedStored] = await db.select().from(growCallSessions).where(eq(growCallSessions.id, failedSessionId));
  assert.equal(failedStored!.status, "FAILED");
  assert.equal(failedStored!.recordingStatus, "UNRECORDED");
  assert.equal(failedStored!.recordingPermitted, false);
});

test("withdrawal between create and confirm fails closed and never invokes the sandbox dial path", async () => {
  const propertyId = await createProperty(A.agent.cookie, "2 Withdrawal Window Way");
  const partyId = await createParty(A.agent.cookie, propertyId, {
    email: uniqueEmail("withdrawal-window"),
    mobile: "+61412000444",
  });

  const createRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({
      partyId,
      eligible: true,
      consentDecisionId: 999999999,
      recordingPermitted: true,
      gates: { allPassed: true },
      provider: "live",
      liveApproval: true,
    }),
  });
  const createBody = (await createRes.json()) as { callSession: { id: number; status: string; providerCallId: string | null } };
  assert.equal(createRes.status, 201, JSON.stringify(createBody));
  assert.equal(createBody.callSession.status, "READY");

  await withdrawCallEvidence(A.brokerageId, A.agent.user.id, partyId);

  const confirmRes = await fetch(callsUrl(`/${createBody.callSession.id}/confirm`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({
      eligible: true,
      consentDecisionId: 999999999,
      recordingPermitted: true,
      gates: { allPassed: true },
      provider: "live",
      liveApproval: true,
    }),
  });
  const confirmBody = (await confirmRes.json()) as { error: string; consentDecisionId?: number | null };
  assert.equal(confirmRes.status, 409, JSON.stringify(confirmBody));
  assert.match(confirmBody.error, /Call consent is not eligible/i);

  const [session] = await db.select().from(growCallSessions).where(eq(growCallSessions.id, createBody.callSession.id));
  assert.equal(session!.status, "READY", "pre-dial withdrawal must not mutate the base call into a dialled state");
  assert.equal(session!.providerCallId, null, "the provider must not receive a dial request after withdrawal");

  const decisions = await db
    .select()
    .from(growConsentDecisions)
    .where(and(eq(growConsentDecisions.brokerageId, A.brokerageId), eq(growConsentDecisions.partyId, partyId)))
    .orderBy(desc(growConsentDecisions.id));
  assert.ok(decisions.length >= 2, "create and confirm each require an audited authoritative decision");
  assert.equal(decisions[0]!.decision, "BLOCKED");
  const deniedAudits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "grow_call_dial_consent_denied"), eq(auditLogs.recordId, String(createBody.callSession.id))));
  assert.equal(deniedAudits.length, 0, "a pre-dial denial before DIAL_REQUESTED must not claim the adapter was reached");
  const denialDecisionAudits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "grow_consent_decision_recorded"), eq(auditLogs.recordId, String(decisions[0]!.id))));
  assert.equal(denialDecisionAudits.length, 1);
  assert.equal((denialDecisionAudits[0]!.updatedValue ?? "").includes("WITHDRAWN"), true);
});

test("recording remains orthogonal: missing consent is unrecorded, disclosure/confirmation do not block the call, and withdrawal fails closed", async () => {
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
  assert.equal(deniedBody.callSession.recordingStatus, "UNRECORDED");
  const deniedSessionId = deniedBody.callSession.id;
  const deniedAuditRows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "grow_call_recording_permission_denied"), eq(auditLogs.recordId, String(deniedSessionId))));
  assert.ok(deniedAuditRows.length >= 1);

  const consentRes = await fetch(callsUrl(`/contacts/${consentPartyId}/consent`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ scope: "STANDING", source: "VERBAL_ON_CALL", jurisdiction: "AU" }),
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
  assert.equal(permittedBody.callSession.recordingPermitted, false, "legacy consent must not enable recording before in-call disclosure and confirmation");
  assert.equal(permittedBody.callSession.recordingStatus, "DISCLOSURE_REQUIRED");
  assert.equal(permittedBody.callSession.recordingConsentId, standingConsentId);
  const permittedSessionId = permittedBody.callSession.id;

  const confirmRes = await fetch(callsUrl(`/${permittedSessionId}/confirm`), { method: "POST", headers: { cookie: A.agent.cookie } });
  const confirmBody = (await confirmRes.json()) as { callSession: { providerCallId: string } };
  assert.equal(confirmRes.status, 200, JSON.stringify(confirmBody));
  const ringingRes = await postWebhookEvent("evt-recording-ringing", "call.ringing", confirmBody.callSession.providerCallId);
  assert.equal(ringingRes.status, 200);
  const connectedRes = await postWebhookEvent("evt-recording-connected", "call.connected", confirmBody.callSession.providerCallId);
  assert.equal(connectedRes.status, 200);

  const disclosureRes = await fetch(callsUrl(`/${permittedSessionId}/recording/disclosure`), {
    method: "POST",
    headers: { cookie: A.agent.cookie },
  });
  assert.equal(disclosureRes.status, 200, JSON.stringify(await disclosureRes.clone().json()));
  const repeatedDisclosureRes = await fetch(callsUrl(`/${permittedSessionId}/recording/disclosure`), {
    method: "POST",
    headers: { cookie: A.agent.cookie },
  });
  assert.equal(repeatedDisclosureRes.status, 409, "a repeated disclosure attestation must not overwrite the recording state");
  const confirmationRes = await fetch(callsUrl(`/${permittedSessionId}/recording/confirm`), {
    method: "POST",
    headers: { cookie: A.agent.cookie },
  });
  const confirmationBody = (await confirmationRes.json()) as { callSession: { recordingPermitted: boolean; recordingStatus: string } };
  assert.equal(confirmationRes.status, 200, JSON.stringify(confirmationBody));
  assert.equal(confirmationBody.callSession.recordingPermitted, false, "sandbox recording capability is a deliberate independent deny gate");
  assert.equal(confirmationBody.callSession.recordingStatus, "UNRECORDED");
  const recordingCompletedRes = await postWebhookEvent("evt-recording-completed", "call.completed", confirmBody.callSession.providerCallId);
  assert.equal(recordingCompletedRes.status, 200, "recording gate failure must never block base call completion");
  const recordingFinalRes = await fetch(callsUrl(`/${permittedSessionId}`), { headers: { cookie: A.agent.cookie } });
  const recordingFinalBody = (await recordingFinalRes.json()) as { callSession: { status: string; recordingStatus: string } };
  assert.equal(recordingFinalBody.callSession.status, "COMPLETED");
  assert.equal(recordingFinalBody.callSession.recordingStatus, "UNRECORDED");

  const withdrawRes = await fetch(callsUrl(`/consent/${standingConsentId}/withdraw`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ reason: "No longer consenting" }),
  });
  const withdrawBody = (await withdrawRes.json()) as { consent: { status: string; withdrawnAt: string | null } };
  assert.equal(withdrawRes.status, 200, JSON.stringify(withdrawBody));
  assert.equal(withdrawBody.consent.status, "WITHDRAWN");
  assert.ok(withdrawBody.consent.withdrawnAt);

  // The withdrawal must immediately re-resolve the completed session that was
  // pointing at this consent — never leave a stale recordingPermitted = true
  // in place (§9).
  const afterWithdrawRes = await fetch(callsUrl(`/${permittedSessionId}`), { headers: { cookie: A.agent.cookie } });
  const afterWithdrawBody = (await afterWithdrawRes.json()) as { callSession: { recordingPermitted: boolean; recordingStatus: string } };
  assert.equal(afterWithdrawBody.callSession.recordingPermitted, false);
  assert.equal(afterWithdrawBody.callSession.recordingStatus, "UNRECORDED");

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
    body: JSON.stringify({ scope: "PER_CALL", source: "VERBAL_ON_CALL", jurisdiction: "AU" }),
  });
  assert.equal(perCallConsentRes.status, 201);

  const afterPerCallConsentRes = await fetch(callsUrl(`/${perCallSessionBody.callSession.id}`), { headers: { cookie: A.agent.cookie } });
  const afterPerCallConsentBody = (await afterPerCallConsentRes.json()) as { callSession: { recordingPermitted: boolean; recordingStatus: string } };
  assert.equal(afterPerCallConsentBody.callSession.recordingPermitted, false);
  assert.equal(afterPerCallConsentBody.callSession.recordingStatus, "DISCLOSURE_REQUIRED");
});

test("an in-call recording decline is orthogonal and the call still completes", async () => {
  const noRequestPropertyId = await createProperty(A.agent.cookie, "3 Decline Without Request Way");
  const noRequestPartyId = await createParty(A.agent.cookie, noRequestPropertyId, {
    email: uniqueEmail("decline-without-request"),
    mobile: "+61412000544",
  });
  const noRequestCreateRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: noRequestPartyId }),
  });
  const noRequestCreateBody = (await noRequestCreateRes.json()) as { callSession: { id: number } };
  const noRequestConfirmRes = await fetch(callsUrl(`/${noRequestCreateBody.callSession.id}/confirm`), { method: "POST", headers: { cookie: A.agent.cookie } });
  const noRequestConfirmBody = (await noRequestConfirmRes.json()) as { callSession: { providerCallId: string } };
  assert.equal(noRequestConfirmRes.status, 200);
  assert.equal((await postWebhookEvent("evt-no-request-ringing", "call.ringing", noRequestConfirmBody.callSession.providerCallId)).status, 200);
  assert.equal((await postWebhookEvent("evt-no-request-connected", "call.connected", noRequestConfirmBody.callSession.providerCallId)).status, 200);
  const noRequestDeclineRes = await fetch(callsUrl(`/${noRequestCreateBody.callSession.id}/recording/decline`), {
    method: "POST",
    headers: { cookie: A.agent.cookie },
  });
  const noRequestDeclineBody = (await noRequestDeclineRes.json()) as { error: string };
  assert.equal(noRequestDeclineRes.status, 409);
  assert.match(noRequestDeclineBody.error, /recording was not requested/i);

  const propertyId = await createProperty(A.agent.cookie, "3 Declined Recording Drive");
  const partyId = await createParty(A.agent.cookie, propertyId, {
    email: uniqueEmail("declined-recording"),
    mobile: "+61412000555",
  });
  const createRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId, recordingRequested: true }),
  });
  const createBody = (await createRes.json()) as { callSession: { id: number } };
  assert.equal(createRes.status, 201);
  const confirmRes = await fetch(callsUrl(`/${createBody.callSession.id}/confirm`), { method: "POST", headers: { cookie: A.agent.cookie } });
  const confirmBody = (await confirmRes.json()) as { callSession: { providerCallId: string } };
  assert.equal(confirmRes.status, 200);
  assert.equal((await postWebhookEvent("evt-decline-ringing", "call.ringing", confirmBody.callSession.providerCallId)).status, 200);
  assert.equal((await postWebhookEvent("evt-decline-connected", "call.connected", confirmBody.callSession.providerCallId)).status, 200);

  const declineRes = await fetch(callsUrl(`/${createBody.callSession.id}/recording/decline`), {
    method: "POST",
    headers: { cookie: A.agent.cookie },
  });
  const declineBody = (await declineRes.json()) as { callSession: { status: string; recordingPermitted: boolean; recordingStatus: string } };
  assert.equal(declineRes.status, 200, JSON.stringify(declineBody));
  assert.equal(declineBody.callSession.status, "CONNECTED");
  assert.equal(declineBody.callSession.recordingPermitted, false);
  assert.equal(declineBody.callSession.recordingStatus, "DECLINED");

  const completedRes = await postWebhookEvent("evt-decline-completed", "call.completed", confirmBody.callSession.providerCallId);
  assert.equal(completedRes.status, 200);
  const finalRes = await fetch(callsUrl(`/${createBody.callSession.id}`), { headers: { cookie: A.agent.cookie } });
  const finalBody = (await finalRes.json()) as { callSession: { status: string; recordingStatus: string; recordingPermitted: boolean } };
  assert.equal(finalBody.callSession.status, "COMPLETED");
  assert.equal(finalBody.callSession.recordingStatus, "DECLINED");
  assert.equal(finalBody.callSession.recordingPermitted, false);
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

  const body = JSON.stringify({ eventId: webhookEventId("evt-no-sig"), eventType: "call.ringing", providerCallId: webhookLifecycleProviderCallId });

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
  const body = JSON.stringify({ eventId: webhookEventId("evt-connected-dup"), eventType: "call.connected", providerCallId: webhookLifecycleProviderCallId });
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

test("authoritative eligible decisions ignore forged authority fields and permit a real inferred call only when policy enables it", async () => {
  await recordConsentPolicy({
    brokerageId: A.brokerageId,
    jurisdiction: "AU",
    version: `f2-inferred-enabled-${suffix}`,
    effectiveAt: new Date(Date.now() - 2_000),
    allowInferredConsent: true,
    dncrRequired: true,
    suppressionEnabled: true,
    timeZone: "Etc/UTC",
    allowedHoursStart: "00:00",
    allowedHoursEnd: "00:00",
    policyData: { recordingPolicy: { allowed: true, jurisdiction: "AU" } },
    recordedByUserId: A.agent.user.id,
  });
  const propertyId = await createProperty(A.agent.cookie, "6 Inferred Evidence Way");
  const partyId = await createPartyWithoutCallEvidence(A.agent.cookie, propertyId, {
    email: uniqueEmail("inferred-enabled"),
    mobile: "+61412000901",
  });
  const reviewedAt = new Date(Date.now() - 1_000);
  const consent = await captureConsentState({
    brokerageId: A.brokerageId,
    partyId,
    channel: "PHONE_CALL",
    state: "INFERRED",
    source: "relationship-review",
    captureMethod: "record-review",
    purpose: PHONE_CALL_CONSENT_PURPOSE,
    scope: PHONE_CALL_CONSENT_SCOPE,
    jurisdiction: "AU",
    inferredReasoning: "The recorded relationship is an active buyer enquiry.",
    evidenceReference: `relationship-review-${partyId}`,
    relationshipEvidence: { source: "grow_relationship", sourceId: `relationship-${partyId}` },
    inferredEvidenceReviewedAt: reviewedAt,
    inferredEvidenceReviewedByUserId: A.agent.user.id,
    recordedByUserId: A.agent.user.id,
  });
  await recordDncrStatus({
    brokerageId: A.brokerageId,
    partyId,
    channel: "PHONE_CALL",
    jurisdiction: "AU",
    status: "CLEARED",
    checkedAt: new Date(Date.now() - 1_000),
    validUntil: new Date(Date.now() + 60 * 60 * 1_000),
    reviewAt: new Date(Date.now() + 60 * 60 * 1_000),
    source: "f2-inferred-test",
    reference: `dncr-inferred-${partyId}`,
    recordedByUserId: A.agent.user.id,
  });

  const eligibilityRes = await fetch(callsUrl(`/contacts/${partyId}/eligibility`), { headers: { cookie: A.agent.cookie } });
  const eligibilityBody = (await eligibilityRes.json()) as {
    eligible: boolean;
    reason: string;
    consentDecisionId: number | null;
    recording: { permitted: boolean; provider: string; fiveGateResult: { allPassed: boolean } };
  };
  assert.equal(eligibilityRes.status, 200, JSON.stringify(eligibilityBody));
  assert.equal(eligibilityBody.eligible, true);
  assert.equal(eligibilityBody.reason, "OK");
  assert.ok(eligibilityBody.consentDecisionId, "eligibility must expose the server-recorded decision id");
  assert.equal(eligibilityBody.recording.permitted, false);
  assert.equal(eligibilityBody.recording.provider, "sandbox");
  assert.equal(eligibilityBody.recording.fiveGateResult.allPassed, false);

  const createRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({
      partyId,
      recordingRequested: true,
      eligible: false,
      consentDecisionId: 1,
      recordingPermitted: true,
      gates: { allPassed: true },
      provider: "live",
      liveApproval: true,
    }),
  });
  const createBody = (await createRes.json()) as {
    callSession: {
      id: number;
      status: string;
      provider: string;
      providerCallId: string | null;
      recordingPermitted: boolean;
      recordingStatus: string;
      [key: string]: unknown;
    };
  };
  assert.equal(createRes.status, 201, JSON.stringify(createBody));
  assert.equal(createBody.callSession.status, "READY");
  assert.equal(createBody.callSession.provider, "sandbox");
  assert.equal(createBody.callSession.providerCallId, null);
  assert.equal(createBody.callSession.recordingPermitted, false);
  assert.equal(createBody.callSession.recordingStatus, "UNRECORDED");
  for (const forgedField of ["eligible", "consentDecisionId", "gates", "liveApproval"]) {
    assert.equal(forgedField in createBody.callSession, false, `create must not echo forged ${forgedField}`);
  }
  const createdSessionId = createBody.callSession.id;

  const createdDecisions = await db
    .select()
    .from(growConsentDecisions)
    .where(and(eq(growConsentDecisions.brokerageId, A.brokerageId), eq(growConsentDecisions.partyId, partyId)))
    .orderBy(desc(growConsentDecisions.id));
  assert.ok(createdDecisions.length >= 2, "eligibility and create must each record an authoritative decision");
  assert.equal(createdDecisions[0]!.decision, "ELIGIBLE");
  assert.equal(createdDecisions[0]!.reasonCode, "INFERRED_CONSENT_ELIGIBLE");
  assert.equal(createdDecisions[0]!.consentId, consent.id);
  const decisionAudit = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "grow_consent_decision_recorded"), eq(auditLogs.recordId, String(createdDecisions[0]!.id))));
  assert.equal(decisionAudit.length, 1);
  assert.equal(decisionAudit[0]!.providerReference, `grow-consent-decision:${createdDecisions[0]!.id}`);
  assert.equal((decisionAudit[0]!.updatedValue ?? "").includes("INFERRED_CONSENT_ELIGIBLE"), true);

  const confirmRes = await fetch(callsUrl(`/${createdSessionId}/confirm`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({
      eligible: false,
      consentDecisionId: 999999999,
      recordingPermitted: true,
      gates: { allPassed: true },
      provider: "live",
      liveApproval: true,
    }),
  });
  const confirmBody = (await confirmRes.json()) as {
    callSession: { status: string; provider: string; providerCallId: string; recordingPermitted: boolean; [key: string]: unknown };
  };
  assert.equal(confirmRes.status, 200, JSON.stringify(confirmBody));
  assert.equal(confirmBody.callSession.status, "DIAL_REQUESTED");
  assert.equal(confirmBody.callSession.provider, "sandbox");
  assert.equal(confirmBody.callSession.providerCallId, `sandbox_call_${createdSessionId}`);
  assert.equal(confirmBody.callSession.recordingPermitted, false);
  for (const forgedField of ["eligible", "consentDecisionId", "gates", "liveApproval"]) {
    assert.equal(forgedField in confirmBody.callSession, false, `confirm must not echo forged ${forgedField}`);
  }

  const [stored] = await db.select().from(growCallSessions).where(eq(growCallSessions.id, createdSessionId));
  assert.equal(stored!.provider, "sandbox");
  assert.equal(stored!.providerCallId, `sandbox_call_${createdSessionId}`);
  assert.equal(stored!.recordingPermitted, false);
  const startedAudit = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "grow_call_started"), eq(auditLogs.recordId, String(createdSessionId))));
  assert.equal(startedAudit.length, 1, "only the authoritative confirmation may create the provider-start audit");
});

test("missing, listed, unknown, and policy-disabled inferred consent produce audited blocked/review outcomes without a provider dial", async () => {
  async function prepareExpressParty(label: string, mobile: string) {
    const propertyId = await createProperty(A.agent.cookie, `${label} Consent Evidence Way`);
    const partyId = await createPartyWithoutCallEvidence(A.agent.cookie, propertyId, {
      email: uniqueEmail(label.toLowerCase().replace(/\s+/g, "-")),
      mobile,
    });
    await captureConsentState({
      brokerageId: A.brokerageId,
      partyId,
      channel: "PHONE_CALL",
      state: "EXPRESS",
      source: "f2-compliance-test",
      captureMethod: "test",
      purpose: PHONE_CALL_CONSENT_PURPOSE,
      scope: PHONE_CALL_CONSENT_SCOPE,
      jurisdiction: "AU",
      recordedByUserId: A.agent.user.id,
    });
    return partyId;
  }

  const missingDncrPartyId = await prepareExpressParty("Missing DNCR", "+61412000911");
  const missingEligibilityRes = await fetch(callsUrl(`/contacts/${missingDncrPartyId}/eligibility`), { headers: { cookie: A.agent.cookie } });
  const missingEligibilityBody = (await missingEligibilityRes.json()) as { eligible: boolean; reason: string; consentDecisionId: number | null };
  assert.equal(missingEligibilityRes.status, 200);
  assert.equal(missingEligibilityBody.eligible, false);
  assert.equal(missingEligibilityBody.reason, "NO_VALID_DNCR_CLEARED_CONSENT");
  assert.ok(missingEligibilityBody.consentDecisionId);
  const missingCreateRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({
      partyId: missingDncrPartyId,
      eligible: true,
      consentDecisionId: 1,
      provider: "live",
      liveApproval: true,
    }),
  });
  const missingCreateBody = (await missingCreateRes.json()) as { error: string; consentDecisionId?: number };
  assert.equal(missingCreateRes.status, 400);
  assert.match(missingCreateBody.error, /NO_VALID_DNCR_CLEARED_CONSENT/);
  const missingSessions = await db.select().from(growCallSessions).where(eq(growCallSessions.partyId, missingDncrPartyId));
  assert.equal(missingSessions.length, 0, "blocked creation must not leave a session that could later be dialled");
  const [missingDecision] = await db
    .select()
    .from(growConsentDecisions)
    .where(and(eq(growConsentDecisions.brokerageId, A.brokerageId), eq(growConsentDecisions.partyId, missingDncrPartyId)))
    .orderBy(desc(growConsentDecisions.id))
    .limit(1);
  assert.equal(missingDecision!.decision, "BLOCKED");
  assert.equal(missingDecision!.reasonCode, "NO_VALID_DNCR_CLEARED_CONSENT");
  await assertConsentDecisionAudit(missingDecision!, {
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
    reasonCode: "NO_VALID_DNCR_CLEARED_CONSENT",
  });
  assert.equal("consentDecisionId" in missingCreateBody, false, "the route must not accept or echo a forged decision id");

  const listedPartyId = await prepareExpressParty("Listed DNCR", "+61412000912");
  await recordDncrStatus({
    brokerageId: A.brokerageId,
    partyId: listedPartyId,
    channel: "PHONE_CALL",
    jurisdiction: "AU",
    status: "LISTED",
    source: "f2-compliance-test",
    reference: `dncr-listed-${listedPartyId}`,
    recordedByUserId: A.agent.user.id,
  });
  const listedCreateRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: listedPartyId, eligible: true, provider: "live", liveApproval: true }),
  });
  const listedCreateBody = (await listedCreateRes.json()) as { error: string };
  assert.equal(listedCreateRes.status, 400);
  assert.match(listedCreateBody.error, /DNCR_LISTED/);
  assert.equal((await db.select().from(growCallSessions).where(eq(growCallSessions.partyId, listedPartyId))).length, 0);
  const [listedDecision] = await db
    .select()
    .from(growConsentDecisions)
    .where(and(eq(growConsentDecisions.brokerageId, A.brokerageId), eq(growConsentDecisions.partyId, listedPartyId)))
    .orderBy(desc(growConsentDecisions.id))
    .limit(1);
  assert.equal(listedDecision!.decision, "BLOCKED");
  assert.equal(listedDecision!.reasonCode, "DNCR_LISTED");
  await assertConsentDecisionAudit(listedDecision!, {
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
    reasonCode: "DNCR_LISTED",
  });

  const unknownPartyPropertyId = await createProperty(A.agent.cookie, "Unknown Consent Evidence Way");
  const unknownPartyId = await createPartyWithoutCallEvidence(A.agent.cookie, unknownPartyPropertyId, {
    email: uniqueEmail("unknown-consent"),
    mobile: "+61412000913",
  });
  await assert.rejects(
    () =>
      captureConsentState({
        brokerageId: A.brokerageId,
        partyId: unknownPartyId,
        channel: "PHONE_CALL",
        state: "INFERRED",
        source: "invalid-f2-fixture",
        captureMethod: "test",
        purpose: PHONE_CALL_CONSENT_PURPOSE,
        scope: PHONE_CALL_CONSENT_SCOPE,
        jurisdiction: "AU",
        recordedByUserId: A.agent.user.id,
      }),
    /INFERRED consent requires explicit inferred reasoning/,
    "inferred consent without proof must not become an authority row",
  );
  const unknownEligibilityRes = await fetch(callsUrl(`/contacts/${unknownPartyId}/eligibility`), { headers: { cookie: A.agent.cookie } });
  const unknownEligibilityBody = (await unknownEligibilityRes.json()) as { eligible: boolean; reason: string };
  assert.equal(unknownEligibilityRes.status, 200);
  assert.equal(unknownEligibilityBody.eligible, false);
  assert.equal(unknownEligibilityBody.reason, "UNKNOWN_CONSENT");
  const unknownCreateRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: unknownPartyId, eligible: true, provider: "live", liveApproval: true }),
  });
  const unknownCreateBody = (await unknownCreateRes.json()) as { error: string };
  assert.equal(unknownCreateRes.status, 400);
  assert.match(unknownCreateBody.error, /UNKNOWN_CONSENT/);
  assert.equal((await db.select().from(growCallSessions).where(eq(growCallSessions.partyId, unknownPartyId))).length, 0);
  const [unknownDecision] = await db
    .select()
    .from(growConsentDecisions)
    .where(and(eq(growConsentDecisions.brokerageId, A.brokerageId), eq(growConsentDecisions.partyId, unknownPartyId)))
    .orderBy(desc(growConsentDecisions.id))
    .limit(1);
  assert.equal(unknownDecision!.decision, "REVIEW_REQUIRED");
  assert.equal(unknownDecision!.reasonCode, "UNKNOWN_CONSENT");
  await assertConsentDecisionAudit(unknownDecision!, {
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
    reasonCode: "UNKNOWN_CONSENT",
  });

  await recordConsentPolicy({
    brokerageId: A.brokerageId,
    jurisdiction: "AU",
    version: `f2-inferred-disabled-${suffix}`,
    effectiveAt: new Date(Date.now() - 1_000),
    allowInferredConsent: false,
    dncrRequired: true,
    suppressionEnabled: true,
    timeZone: "Etc/UTC",
    allowedHoursStart: "00:00",
    allowedHoursEnd: "00:00",
    policyData: { recordingPolicy: { allowed: true, jurisdiction: "AU" } },
    recordedByUserId: A.agent.user.id,
  });
  const inferredReviewPropertyId = await createProperty(A.agent.cookie, "Inferred Review Evidence Way");
  const inferredReviewPartyId = await createPartyWithoutCallEvidence(A.agent.cookie, inferredReviewPropertyId, {
    email: uniqueEmail("inferred-review"),
    mobile: "+61412000914",
  });
  await captureConsentState({
    brokerageId: A.brokerageId,
    partyId: inferredReviewPartyId,
    channel: "PHONE_CALL",
    state: "INFERRED",
    source: "f2-compliance-test",
    captureMethod: "test",
    purpose: PHONE_CALL_CONSENT_PURPOSE,
    scope: PHONE_CALL_CONSENT_SCOPE,
    jurisdiction: "AU",
    inferredReasoning: "A recorded relationship was reviewed.",
    evidenceReference: `relationship-review-${inferredReviewPartyId}`,
    relationshipEvidence: { source: "grow_relationship", sourceId: `relationship-${inferredReviewPartyId}` },
    inferredEvidenceReviewedAt: new Date(Date.now() - 1_000),
    inferredEvidenceReviewedByUserId: A.agent.user.id,
    recordedByUserId: A.agent.user.id,
  });
  await recordDncrStatus({
    brokerageId: A.brokerageId,
    partyId: inferredReviewPartyId,
    channel: "PHONE_CALL",
    jurisdiction: "AU",
    status: "CLEARED",
    checkedAt: new Date(Date.now() - 1_000),
    validUntil: new Date(Date.now() + 60 * 60 * 1_000),
    reviewAt: new Date(Date.now() + 60 * 60 * 1_000),
    source: "f2-compliance-test",
    reference: `dncr-inferred-review-${inferredReviewPartyId}`,
    recordedByUserId: A.agent.user.id,
  });
  const inferredReviewRes = await fetch(callsUrl(`/contacts/${inferredReviewPartyId}/eligibility`), { headers: { cookie: A.agent.cookie } });
  const inferredReviewBody = (await inferredReviewRes.json()) as { eligible: boolean; reason: string };
  assert.equal(inferredReviewRes.status, 200);
  assert.equal(inferredReviewBody.eligible, false);
  assert.equal(inferredReviewBody.reason, "INFERRED_NOT_ENABLED_BY_POLICY");
  const inferredReviewCreateRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: inferredReviewPartyId, eligible: true, provider: "live", liveApproval: true }),
  });
  const inferredReviewCreateBody = (await inferredReviewCreateRes.json()) as { error: string };
  assert.equal(inferredReviewCreateRes.status, 400);
  assert.match(inferredReviewCreateBody.error, /INFERRED_NOT_ENABLED_BY_POLICY/);
  assert.equal((await db.select().from(growCallSessions).where(eq(growCallSessions.partyId, inferredReviewPartyId))).length, 0);
  const [inferredReviewDecision] = await db
    .select()
    .from(growConsentDecisions)
    .where(and(eq(growConsentDecisions.brokerageId, A.brokerageId), eq(growConsentDecisions.partyId, inferredReviewPartyId)))
    .orderBy(desc(growConsentDecisions.id))
    .limit(1);
  assert.equal(inferredReviewDecision!.decision, "REVIEW_REQUIRED");
  assert.equal(inferredReviewDecision!.reasonCode, "INFERRED_NOT_ENABLED_BY_POLICY");
  await assertConsentDecisionAudit(inferredReviewDecision!, {
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
    reasonCode: "INFERRED_NOT_ENABLED_BY_POLICY",
  });
  const inferredStartedAudits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "grow_call_started"), eq(auditLogs.recordId, String(inferredReviewPartyId))));
  assert.equal(inferredStartedAudits.length, 0, "review/blocked outcomes must never produce a provider-start audit");
});

test("recording disclosure, confirmation, status, and decline expose and persist the authoritative five-gate evidence", async () => {
  await recordConsentPolicy({
    brokerageId: A.brokerageId,
    jurisdiction: "AU",
    version: `f2-recording-gates-${suffix}`,
    effectiveAt: new Date(Date.now() - 2_000),
    allowInferredConsent: false,
    dncrRequired: true,
    suppressionEnabled: true,
    timeZone: "Etc/UTC",
    allowedHoursStart: "00:00",
    allowedHoursEnd: "00:00",
    policyData: { recordingPolicy: { allowed: true, jurisdiction: "AU" } },
    recordedByUserId: A.agent.user.id,
  });
  const propertyId = await createProperty(A.agent.cookie, "7 Recording Gates Way");
  const partyId = await createParty(A.agent.cookie, propertyId, {
    email: uniqueEmail("recording-gates"),
    mobile: "+61412000921",
  });
  const standingConsentRes = await fetch(callsUrl(`/contacts/${partyId}/consent`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({
      scope: "STANDING",
      source: "VERBAL_ON_CALL",
      jurisdiction: "AU",
      evidenceMetadata: { capturedFor: "recording-gates-test" },
    }),
  });
  const standingConsentBody = (await standingConsentRes.json()) as { consent: { id: number } };
  assert.equal(standingConsentRes.status, 201, JSON.stringify(standingConsentBody));

  const createRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({
      partyId,
      recordingRequested: true,
      eligible: false,
      consentDecisionId: 999999999,
      recordingPermitted: true,
      gates: { allPassed: true },
      provider: "live",
      liveApproval: true,
    }),
  });
  const createBody = (await createRes.json()) as {
    callSession: {
      id: number;
      provider: string;
      providerCallId: string | null;
      recordingRequested: boolean;
      recordingPermitted: boolean;
      recordingConsentId: number | null;
      recordingStatus: string;
      [key: string]: unknown;
    };
  };
  assert.equal(createRes.status, 201, JSON.stringify(createBody));
  const sessionId = createBody.callSession.id;
  assert.equal(createBody.callSession.provider, "sandbox");
  assert.equal(createBody.callSession.providerCallId, null);
  assert.equal(createBody.callSession.recordingRequested, true);
  assert.equal(createBody.callSession.recordingPermitted, false);
  assert.equal(createBody.callSession.recordingConsentId, standingConsentBody.consent.id);
  assert.equal(createBody.callSession.recordingStatus, "DISCLOSURE_REQUIRED");
  assert.equal("gates" in createBody.callSession, false);
  assert.equal("liveApproval" in createBody.callSession, false);

  const confirmRes = await fetch(callsUrl(`/${sessionId}/confirm`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ provider: "live", liveApproval: true, recordingPermitted: true, gates: { allPassed: true } }),
  });
  const confirmBody = (await confirmRes.json()) as { callSession: { providerCallId: string; provider: string; recordingPermitted: boolean } };
  assert.equal(confirmRes.status, 200, JSON.stringify(confirmBody));
  assert.equal(confirmBody.callSession.provider, "sandbox");
  assert.equal(confirmBody.callSession.providerCallId, `sandbox_call_${sessionId}`);
  assert.equal(confirmBody.callSession.recordingPermitted, false);
  assert.equal((await postWebhookEvent("evt-gates-ringing", "call.ringing", confirmBody.callSession.providerCallId)).status, 200);
  assert.equal((await postWebhookEvent("evt-gates-connected", "call.connected", confirmBody.callSession.providerCallId)).status, 200);

  const beforeRecordingRes = await fetch(callsUrl(`/${sessionId}/recording/status`), { headers: { cookie: A.agent.cookie } });
  const beforeRecordingBody = (await beforeRecordingRes.json()) as {
    callSessionId: number;
    recording: {
      provider: string;
      permitted: boolean;
      statusCode: string;
      fiveGateResult: {
        allPassed: boolean;
        outboundDecisionId: number | null;
        gates: Record<string, { passed: boolean; reason: string }>;
      };
    };
  };
  assert.equal(beforeRecordingRes.status, 200, JSON.stringify(beforeRecordingBody));
  assert.equal(beforeRecordingBody.callSessionId, sessionId);
  assert.equal(beforeRecordingBody.recording.provider, "sandbox");
  assert.equal(beforeRecordingBody.recording.permitted, false);
  assert.equal(beforeRecordingBody.recording.statusCode, "DISCLOSURE_REQUIRED");
  assert.equal(beforeRecordingBody.recording.fiveGateResult.allPassed, false);
  assert.equal(beforeRecordingBody.recording.fiveGateResult.outboundDecisionId, null, "read-only status must not manufacture an authority id");
  assert.deepEqual(Object.keys(beforeRecordingBody.recording.fiveGateResult.gates).sort(), [
    "adapterCapability",
    "entitlement",
    "legacyConsentAndDisclosure",
    "legalPolicy",
    "operationalApproval",
  ]);
  assert.equal(beforeRecordingBody.recording.fiveGateResult.gates.entitlement.passed, true);
  assert.equal(beforeRecordingBody.recording.fiveGateResult.gates.legalPolicy.passed, true);
  assert.equal(beforeRecordingBody.recording.fiveGateResult.gates.legacyConsentAndDisclosure.passed, false);
  assert.equal(beforeRecordingBody.recording.fiveGateResult.gates.adapterCapability.reason, "ADAPTER_RECORDING_UNAVAILABLE");
  assert.equal(beforeRecordingBody.recording.fiveGateResult.gates.operationalApproval.reason, "OPERATIONAL_RECORDING_NOT_APPROVED");

  const disclosureRes = await fetch(callsUrl(`/${sessionId}/recording/disclosure`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ provider: "live", liveApproval: true, recordingPermitted: true, gates: { allPassed: true } }),
  });
  const disclosureBody = (await disclosureRes.json()) as { callSession: { status: string; recordingStatus: string; recordingPermitted: boolean } };
  assert.equal(disclosureRes.status, 200, JSON.stringify(disclosureBody));
  assert.equal(disclosureBody.callSession.status, "CONNECTED");
  assert.equal(disclosureBody.callSession.recordingStatus, "DISCLOSED");
  assert.equal(disclosureBody.callSession.recordingPermitted, false);

  const recordingConfirmRes = await fetch(callsUrl(`/${sessionId}/recording/confirm`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ provider: "live", liveApproval: true, recordingPermitted: true, gates: { allPassed: true } }),
  });
  const recordingConfirmBody = (await recordingConfirmRes.json()) as {
    callSession: { status: string; recordingStatus: string; recordingPermitted: boolean; provider: string };
  };
  assert.equal(recordingConfirmRes.status, 200, JSON.stringify(recordingConfirmBody));
  assert.equal(recordingConfirmBody.callSession.status, "CONNECTED");
  assert.equal(recordingConfirmBody.callSession.recordingStatus, "UNRECORDED");
  assert.equal(recordingConfirmBody.callSession.recordingPermitted, false);
  assert.equal(recordingConfirmBody.callSession.provider, "sandbox");

  const disclosureAudits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "grow_call_recording_disclosed_in_call"), eq(auditLogs.recordId, String(sessionId))));
  assert.equal(disclosureAudits.length, 1);
  assert.equal(disclosureAudits[0]!.updatedValue, "DISCLOSED");
  const confirmationAudits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "grow_call_recording_confirmation_received"), eq(auditLogs.recordId, String(sessionId))));
  assert.equal(confirmationAudits.length, 1);
  assert.equal(confirmationAudits[0]!.updatedValue, "CONFIRMED");
  const gateAudits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "grow_call_recording_unrecorded"), eq(auditLogs.recordId, String(sessionId))));
  assert.equal(gateAudits.length, 1);
  const gateEvidence = JSON.parse(gateAudits[0]!.updatedValue ?? "{}") as {
    allPassed: boolean;
    requested: boolean;
    outboundDecisionId: number | null;
    outboundReasonCode: string | null;
    gates: Record<string, { passed: boolean; reason: string; humanReason: string }>;
  };
  assert.equal(gateEvidence.requested, true);
  assert.equal(gateEvidence.allPassed, false);
  assert.ok(gateEvidence.outboundDecisionId, "mutating recording confirmation must retain the authoritative decision id");
  assert.equal(gateEvidence.outboundReasonCode, "EXPRESS_CONSENT_ELIGIBLE");
  assert.deepEqual(Object.keys(gateEvidence.gates).sort(), [
    "adapterCapability",
    "entitlement",
    "legacyConsentAndDisclosure",
    "legalPolicy",
    "operationalApproval",
  ]);
  assert.equal(gateEvidence.gates.entitlement.passed, true);
  assert.equal(gateEvidence.gates.legalPolicy.passed, true);
  assert.equal(gateEvidence.gates.legacyConsentAndDisclosure.passed, true);
  assert.equal(gateEvidence.gates.adapterCapability.passed, false);
  assert.equal(gateEvidence.gates.operationalApproval.passed, false);
  const [gateDecision] = await db.select().from(growConsentDecisions).where(eq(growConsentDecisions.id, gateEvidence.outboundDecisionId));
  assert.equal(gateDecision!.decision, "ELIGIBLE");

  const declinePropertyId = await createProperty(A.agent.cookie, "7 Recording Decline Way");
  const declinePartyId = await createParty(A.agent.cookie, declinePropertyId, {
    email: uniqueEmail("recording-decline-authority"),
    mobile: "+61412000922",
  });
  const declineCreateRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: declinePartyId, recordingRequested: true }),
  });
  const declineCreateBody = (await declineCreateRes.json()) as { callSession: { id: number } };
  assert.equal(declineCreateRes.status, 201);
  const declineConfirmRes = await fetch(callsUrl(`/${declineCreateBody.callSession.id}/confirm`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ provider: "live", liveApproval: true, recordingPermitted: true, gates: { allPassed: true } }),
  });
  const declineConfirmBody = (await declineConfirmRes.json()) as { callSession: { providerCallId: string } };
  assert.equal(declineConfirmRes.status, 200);
  assert.equal((await postWebhookEvent("evt-gates-decline-ringing", "call.ringing", declineConfirmBody.callSession.providerCallId)).status, 200);
  assert.equal((await postWebhookEvent("evt-gates-decline-connected", "call.connected", declineConfirmBody.callSession.providerCallId)).status, 200);
  const declineRes = await fetch(callsUrl(`/${declineCreateBody.callSession.id}/recording/decline`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ provider: "live", liveApproval: true, recordingPermitted: true, gates: { allPassed: true } }),
  });
  const declineBody = (await declineRes.json()) as { callSession: { recordingStatus: string; recordingPermitted: boolean } };
  assert.equal(declineRes.status, 200, JSON.stringify(declineBody));
  assert.equal(declineBody.callSession.recordingStatus, "DECLINED");
  assert.equal(declineBody.callSession.recordingPermitted, false);
  const declineAudits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "grow_call_recording_declined_in_call"), eq(auditLogs.recordId, String(declineCreateBody.callSession.id))));
  assert.equal(declineAudits.length, 1);
  assert.equal(declineAudits[0]!.updatedValue, "DECLINED");
});

test("every grow-calls route rejects Brokerage B's cross-tenant actor, party, session, consent, and evidence ids", async () => {
  await grant(B.brokerageId, "grow.calling.access");
  await grant(B.brokerageId, "grow.calling.recording");
  const propertyId = await createProperty(A.agent.cookie, "8 Cross Tenant Route Way");
  const partyId = await createParty(A.agent.cookie, propertyId, {
    email: uniqueEmail("cross-tenant-routes"),
    mobile: "+61412000931",
  });
  const consentRes = await fetch(callsUrl(`/contacts/${partyId}/consent`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ scope: "STANDING", source: "VERBAL_ON_CALL", jurisdiction: "AU" }),
  });
  const consentBody = (await consentRes.json()) as { consent: { id: number; status: string } };
  assert.equal(consentRes.status, 201, JSON.stringify(consentBody));
  assert.equal(consentBody.consent.status, "ACTIVE");
  const createRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId, recordingRequested: true }),
  });
  const createBody = (await createRes.json()) as { callSession: { id: number; providerCallId: string | null } };
  assert.equal(createRes.status, 201);
  const sessionId = createBody.callSession.id;
  assert.equal(createBody.callSession.providerCallId, null);

  const getRes = await fetch(callsUrl(`/${sessionId}`), { headers: { cookie: B.agent.cookie } });
  assert.equal(getRes.status, 404);
  assert.equal((await getRes.text()).includes(String(sessionId)), false);
  const recordingStatusRes = await fetch(callsUrl(`/${sessionId}/recording/status`), { headers: { cookie: B.agent.cookie } });
  assert.equal(recordingStatusRes.status, 404);
  assert.equal((await recordingStatusRes.text()).includes(String(sessionId)), false);
  const eligibilityRes = await fetch(callsUrl(`/contacts/${partyId}/eligibility`), { headers: { cookie: B.agent.cookie } });
  assert.equal(eligibilityRes.status, 404);
  assert.equal((await eligibilityRes.text()).includes(String(partyId)), false);

  const createCrossRes = await fetch(callsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: B.agent.cookie },
    body: JSON.stringify({
      brokerageId: A.brokerageId,
      partyId,
      initiatedByUserId: A.agent.user.id,
      consentDecisionId: consentBody.consent.id,
      recordingConsentId: consentBody.consent.id,
      provider: "live",
    }),
  });
  assert.equal(createCrossRes.status, 400, "a cross-tenant party cannot be used even with forged owner/evidence ids");

  const routeRequests: Array<{ path: string; method: "POST"; body?: Record<string, unknown> }> = [
    { path: `/${sessionId}/confirm`, method: "POST", body: { confirmedByUserId: A.agent.user.id, consentDecisionId: consentBody.consent.id } },
    { path: `/${sessionId}/cancel`, method: "POST", body: { cancelledByUserId: A.agent.user.id, reason: "cross-tenant" } },
    { path: `/${sessionId}/recording/disclosure`, method: "POST", body: { disclosedByUserId: A.agent.user.id, provider: "live" } },
    { path: `/${sessionId}/recording/disclose`, method: "POST", body: { disclosedByUserId: A.agent.user.id, provider: "live" } },
    { path: `/${sessionId}/recording/confirm`, method: "POST", body: { confirmedByUserId: A.agent.user.id, liveApproval: true } },
    { path: `/${sessionId}/recording/decline`, method: "POST", body: { declinedByUserId: A.agent.user.id, liveApproval: true } },
    { path: `/${sessionId}/transcription`, method: "POST", body: { recordingReference: 1 } },
    { path: `/${sessionId}/consent`, method: "POST", body: { scope: "PER_CALL", source: "VERBAL_ON_CALL", jurisdiction: "AU", capturedByUserId: A.agent.user.id } },
    { path: `/consent/${consentBody.consent.id}/withdraw`, method: "POST", body: { withdrawnByUserId: A.agent.user.id, reason: "cross-tenant" } },
    { path: `/contacts/${partyId}/consent`, method: "POST", body: { scope: "STANDING", source: "VERBAL_ON_CALL", jurisdiction: "AU", capturedByUserId: A.agent.user.id } },
  ];
  for (const request of routeRequests) {
    const response = await fetch(callsUrl(request.path), {
      method: request.method,
      headers: { "content-type": "application/json", cookie: B.agent.cookie },
      body: JSON.stringify(request.body ?? {}),
    });
    assert.equal(response.status, 404, `Brokerage B must not use A's ids at ${request.method} ${request.path}`);
    const responseText = await response.text();
    assert.equal(responseText.includes(String(partyId)), false, `cross-tenant response must not disclose party ${partyId}`);
    assert.equal(responseText.includes(String(sessionId)), false, `cross-tenant response must not disclose session ${sessionId}`);
    assert.equal(responseText.includes(String(consentBody.consent.id)), false, `cross-tenant response must not disclose consent ${consentBody.consent.id}`);
  }

  const [unchanged] = await db.select().from(growCallSessions).where(eq(growCallSessions.id, sessionId));
  assert.equal(unchanged!.status, "READY");
  assert.equal(unchanged!.providerCallId, null);
  const consentReadAsB = await fetch(callsUrl(`/consent/${consentBody.consent.id}/withdraw`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: B.agent.cookie },
    body: JSON.stringify({}),
  });
  assert.equal(consentReadAsB.status, 404);
  const consentRows = await db.select().from(growCallRecordingConsents).where(eq(growCallRecordingConsents.id, consentBody.consent.id));
  assert.equal(consentRows[0]!.status, "ACTIVE");
});
