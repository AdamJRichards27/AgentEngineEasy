// AE GROW Pilot Readiness WP1 (P2-3) — once a contact-first (Grow, propertyId
// IS NULL) communication thread exists, every mutation on it through the
// generic /communications/threads/:threadId/... and
// /communications/messages/:messageId/... routes requires
// grow.contacts.manage — the same key required to create the thread.
// Property-scoped (RUN) threads are unchanged: no Grow entitlement needed.
// Cancel stays available (it can only withdraw an unsent message).
// Same real-HTTP conventions as communications.test.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, communicationMessages, communicationConsent, entitlementGrants, growContactChannelConsents } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { normalizeDestination } from "../../lib/communications/consent.js";
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
  A = await createBrokerageWithUsers(baseUrl, `WP1 Comms Grow Thread A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `WP1 Comms Grow Thread B ${suffix}`);
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

async function revokeEntitlement(brokerageId: number, entitlementKey: string) {
  await db
    .update(entitlementGrants)
    .set({ status: "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, entitlementKey)));
  invalidateEntitlementCache(brokerageId);
}

function post(path: string, cookie: string, body: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await post("/properties", cookie, { formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { property: { id: number } }).property.id;
}

async function createParty(cookie: string, propertyId: number): Promise<number> {
  const res = await post("/parties", cookie, {
    propertyId,
    role: "Buyer",
    firstName: "Grow",
    lastName: "Thread",
    email: `wp1-grow-thread-${suffix}@example.com`,
    mobile: "0400111222",
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { party: { id: number } }).party.id;
}

async function draft(cookie: string, threadId: number, participantId: number) {
  const res = await post(`/communications/threads/${threadId}/messages`, cookie, {
    channel: "EMAIL",
    classification: "TRANSACTIONAL",
    bodyText: "WP1 entitlement test message.",
    recipientParticipantId: participantId,
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as { id: number; version: number; status: string };
}

test("WP1 P2-3: mutations on a contact-first (Grow) thread require grow.contacts.manage once the thread exists; cancel stays available; nothing is sent", async () => {
  await grant(A.brokerageId, "grow.contacts.manage");
  const propertyId = await createProperty(A.agent.cookie, `1 Grow Thread St ${suffix}`);
  const partyId = await createParty(A.agent.cookie, propertyId);

  const threadRes = await post(`/grow/contacts/${partyId}/communications/threads`, A.agent.cookie, { subject: "WP1 contact-first" });
  assert.equal(threadRes.status, 201, await threadRes.clone().text());
  const thread = (await threadRes.json()) as { id: number; propertyId: number | null };
  assert.equal(thread.propertyId, null);

  const participantRes = await post(`/communications/threads/${thread.id}/participants`, A.agent.cookie, { partyId, role: "Other" });
  assert.equal(participantRes.status, 201, await participantRes.clone().text());
  const participantId = ((await participantRes.json()) as { id: number }).id;
  const pending = await draft(A.agent.cookie, thread.id, participantId);
  const toCancel = await draft(A.agent.cookie, thread.id, participantId);

  // The brokerage loses Grow contact management (e.g. Grow lapses).
  await revokeEntitlement(A.brokerageId, "grow.contacts.manage");

  const refused: Array<[string, unknown]> = [
    [`/communications/threads/${thread.id}/participants`, { partyId, role: "Other" }],
    [`/communications/threads/${thread.id}/participants/manual`, { displayName: "X", role: "Other", email: "x@example.com", reason: "test" }],
    [`/communications/threads/${thread.id}/messages`, { channel: "EMAIL", classification: "TRANSACTIONAL", bodyText: "x", recipientParticipantId: participantId }],
    [`/communications/messages/${pending.id}/request-approval`, { expectedVersion: pending.version }],
    [`/communications/messages/${pending.id}/approve`, { expectedVersion: pending.version }],
    [`/communications/messages/${pending.id}/send`, { expectedVersion: pending.version }],
    [`/communications/messages/${pending.id}/requeue`, { expectedVersion: pending.version }],
  ];
  for (const [path, body] of refused) {
    const res = await post(path, A.agent.cookie, body);
    assert.equal(res.status, 403, path);
    const payload = (await res.json()) as { entitlementKey: string };
    assert.equal(payload.entitlementKey, "grow.contacts.manage", path);
  }

  const [stillDraft] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, pending.id));
  assert.equal(stillDraft.status, "DRAFT", "a refused send must not have sent anything");
  const threadMessages = await db.select().from(communicationMessages).where(eq(communicationMessages.threadId, thread.id));
  assert.equal(threadMessages.length, 2, "a refused draft must not have created a message");

  const cancelRes = await post(`/communications/messages/${toCancel.id}/cancel`, A.agent.cookie, { expectedVersion: toCancel.version });
  assert.equal(cancelRes.status, 200, "cancel only withdraws an unsent message and stays available");

  // Restoring the entitlement restores the flow (proves the 403 was the entitlement, not the row).
  // GP-4: a party-linked send also needs a destination consent row and an
  // affirmative F2 head. This test is about the entitlement, so those rows
  // are recorded before the send that is expected to succeed.
  await grant(A.brokerageId, "grow.contacts.manage");
  const destination = normalizeDestination("EMAIL", `wp1-grow-thread-${suffix}@example.com`);
  await db.insert(communicationConsent).values({
    brokerageId: A.brokerageId,
    partyId,
    destination,
    channel: "EMAIL",
    marketingOptIn: false,
    transactionalOptOut: false,
    source: "MANUAL",
    recordedByUserId: A.agent.user.id,
  });
  await db.insert(growContactChannelConsents).values({
    brokerageId: A.brokerageId,
    partyId,
    channel: "EMAIL",
    state: "EXPRESS",
    source: "MANUAL",
    captureMethod: "WRITTEN",
    purpose: "EMAIL",
    scope: "OUTBOUND",
    recordedByUserId: A.agent.user.id,
  });
  const sendRes = await post(`/communications/messages/${pending.id}/send`, A.agent.cookie, { expectedVersion: pending.version });
  assert.equal(sendRes.status, 200, await sendRes.clone().text());
});

test("WP1 P2-3: another brokerage holding grow.contacts.manage still gets 404 (not 403/200) on a foreign contact-first thread/message", async () => {
  await grant(A.brokerageId, "grow.contacts.manage");
  await grant(B.brokerageId, "grow.contacts.manage");
  const propertyId = await createProperty(A.agent.cookie, `2 Grow Thread St ${suffix}`);
  const partyId = await createParty(A.agent.cookie, propertyId);
  const threadRes = await post(`/grow/contacts/${partyId}/communications/threads`, A.agent.cookie, { subject: "WP1 isolation" });
  const thread = (await threadRes.json()) as { id: number };
  const participantRes = await post(`/communications/threads/${thread.id}/participants`, A.agent.cookie, { partyId, role: "Other" });
  const participantId = ((await participantRes.json()) as { id: number }).id;
  const message = await draft(A.agent.cookie, thread.id, participantId);

  assert.equal((await post(`/communications/threads/${thread.id}/messages`, B.agent.cookie, { channel: "EMAIL", classification: "TRANSACTIONAL", bodyText: "x" })).status, 404);
  assert.equal((await post(`/communications/messages/${message.id}/send`, B.agent.cookie, { expectedVersion: message.version })).status, 404);
  // AE GROW Pilot Readiness WP6a (D1-residual): "abc" is not a tenant case at
  // all — it is a malformed id, and is now rejected as one (400) before the
  // Grow gate ever looks anything up. That discloses nothing: the answer is
  // identical for every caller, entitled or not, in any brokerage, because the
  // id cannot name a resource in the first place. Tenant isolation for a
  // WELL-FORMED foreign id is what the two assertions above cover, and both
  // still answer 404.
  assert.equal((await post(`/communications/messages/abc/send`, B.agent.cookie, { expectedVersion: 0 })).status, 400);
});

test("WP1 P2-3: property-scoped (RUN) threads are unchanged -- a brokerage with no Grow entitlements can still draft and send on them", async () => {
  const run = await createBrokerageWithUsers(baseUrl, `WP1 Comms Run Only ${suffix}`);
  try {
    const propertyId = await createProperty(run.agent.cookie, `3 Run Thread St ${suffix}`);
    const threadRes = await post(`/properties/${propertyId}/communications/threads`, run.agent.cookie, { subject: "WP1 property-first" });
    assert.equal(threadRes.status, 201, await threadRes.clone().text());
    const thread = (await threadRes.json()) as { id: number; propertyId: number | null };
    assert.equal(thread.propertyId, propertyId);

    const participantRes = await post(`/communications/threads/${thread.id}/participants/manual`, run.agent.cookie, {
      displayName: "Solicitor",
      role: "Other",
      email: `wp1-run-${suffix}@example.com`,
      reason: "WP1 regression",
    });
    assert.equal(participantRes.status, 201, await participantRes.clone().text());
    const participantId = ((await participantRes.json()) as { id: number }).id;
    const message = await draft(run.agent.cookie, thread.id, participantId);
    const sendRes = await post(`/communications/messages/${message.id}/send`, run.agent.cookie, { expectedVersion: message.version });
    assert.equal(sendRes.status, 200, await sendRes.clone().text());
  } finally {
    await cleanupBrokerages([run.brokerageId]);
  }
});
