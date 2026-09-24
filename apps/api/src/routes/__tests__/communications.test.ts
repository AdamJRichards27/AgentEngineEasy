// Agent Engine 2.0 — Communications Hub (Priority 8). DB-backed, HTTP-level
// coverage for the eight required vertical-slice scenarios (Section 38):
//   1. Agent sends a transactional email.
//   2. Pit Crew sends on behalf of an agent (requires approval).
//   3. SMS cost control blocks an over-threshold send.
//   4. A Pit-Crew-authored PC_EVENT (vendor-coordination) message requires
//      approval before it can send — the same authority gate as #2, from a
//      template rather than free text.
//   5. Delivery failure and bounded retry, reaching a terminal state.
//   6. A marketing send is blocked by missing opt-in, then succeeds once
//      consent is recorded and the message is requeued.
//   7. A redelivered inbound webhook is processed exactly once (idempotency).
//   8. Tenant isolation — another brokerage cannot read or act on this one's
//      threads/messages.
//
// Mirrors lib/pitCrew/__tests__/assignment.test.ts's DB-backed style: a
// real Express server, real HTTP calls via fetch, and direct DB reads only
// where an assertion needs to see something the HTTP responses don't
// expose (e.g. delivery-attempt rows, webhook-event dedup rows).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db, users, communicationThreads, communicationMessages, communicationWebhookEvents, entitlementGrants } from "@aee/db";
import { dispatchMessage, queueMessage } from "../../lib/communications/outbox.js";
import { CommunicationTransitionError } from "../../lib/communications/types.js";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
// devLogin() below requires ALLOW_DEV_AUTH=true. Most suites in this repo
// set this themselves at module load (see e.g. transactionConditions.test.ts)
// rather than relying on an ambient value that may not be set, and this
// suite should too.
process.env.ALLOW_DEV_AUTH = "true";
process.env.COMMUNICATIONS_WEBHOOK_INGRESS_ENABLED = "true";
process.env.COMMUNICATIONS_WEBHOOK_SECRET = "test-only-communications-webhook-secret";

let server: Server;
let baseUrl: string;
let admin: DevLoginResult;
let agent: DevLoginResult;
let pitCrew: DevLoginResult;
let brokerageId: number;
let propertyId: number;

let otherAdmin: DevLoginResult;
let otherBrokerageId: number;

const WEBHOOK_SECRET = process.env.COMMUNICATIONS_WEBHOOK_SECRET;

function authHeaders(cookie: string) {
  return { "content-type": "application/json", cookie };
}

async function jsonOf<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got ${res.status}: ${text}`);
  }
}

async function createThread(cookie: string, subject: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties/${propertyId}/communications/threads`, {
    method: "POST",
    headers: authHeaders(cookie),
    body: JSON.stringify({ subject }),
  });
  if (res.status !== 201) throw new Error(`create thread failed: ${res.status} ${await res.text()}`);
  const thread = await jsonOf<{ id: number }>(res);
  return thread.id;
}

async function addManualParticipant(cookie: string, threadId: number, opts: { displayName: string; role: string; email?: string; mobile?: string; reason: string }) {
  const res = await fetch(`${baseUrl}/api/communications/threads/${threadId}/participants/manual`, {
    method: "POST",
    headers: authHeaders(cookie),
    body: JSON.stringify(opts),
  });
  if (res.status !== 201) throw new Error(`add manual participant failed: ${res.status} ${await res.text()}`);
  return jsonOf<{ id: number }>(res);
}

interface DraftMessageInput {
  channel: string;
  classification: string;
  bodyText?: string;
  recipientParticipantId?: number;
  sendOnBehalfOfUserId?: number;
  templateId?: number;
  placeholderValues?: Record<string, string>;
  // AE Grow Priority 3 — a contact-first (or ad-hoc) draft may name its
  // recipient directly rather than via an existing participant row; the
  // route (createDraftMessageSchema) already accepted these two fields
  // before this addition, this interface just hadn't needed them yet.
  recipientDisplayName?: string;
  recipientDestination?: string;
}

async function createDraft(cookie: string, threadId: number, input: DraftMessageInput) {
  const res = await fetch(`${baseUrl}/api/communications/threads/${threadId}/messages`, {
    method: "POST",
    headers: authHeaders(cookie),
    body: JSON.stringify(input),
  });
  if (res.status !== 201) throw new Error(`create draft failed: ${res.status} ${await res.text()}`);
  return jsonOf<{ id: number; version: number; status: string }>(res);
}

async function sendMessage(cookie: string, messageId: number, expectedVersion: number) {
  const res = await fetch(`${baseUrl}/api/communications/messages/${messageId}/send`, {
    method: "POST",
    headers: authHeaders(cookie),
    body: JSON.stringify({ expectedVersion }),
  });
  return { status: res.status, body: await jsonOf<any>(res) };
}

// AE Grow Priority 3 — same grant() helper as routes/__tests__/growToday.test.ts
// and routes/__tests__/contacts.test.ts: dev-login does not auto-grant any
// grow.* entitlement, so the contact-first routes' own grow.contacts.read/
// grow.contacts.manage gates must be granted explicitly before they're usable.
async function grant(targetBrokerageId: number, entitlementKey: string) {
  await db.insert(entitlementGrants).values({
    brokerageId: targetBrokerageId,
    entitlementKey,
    granteeType: "brokerage",
    granteeId: targetBrokerageId,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(targetBrokerageId);
}

// AE GROW W1-A (A-2): the inverse of grant(), so a test that needs a
// Grow-gated route for one step can hand the entitlement back afterwards.
// The contact-first test further down deliberately asserts a 403 BEFORE it
// grants anything, so nothing in this file may leave a standing grant behind
// earlier than that test expects one.
async function revoke(targetBrokerageId: number, entitlementKey: string) {
  await db
    .update(entitlementGrants)
    .set({ status: "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, targetBrokerageId), eq(entitlementGrants.entitlementKey, entitlementKey)));
  invalidateEntitlementCache(targetBrokerageId);
}

async function createHttpProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: authHeaders(cookie),
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = await jsonOf<{ property: { id: number } }>(res);
  return property.id;
}

async function createHttpParty(cookie: string, forPropertyId: number, overrides: Record<string, unknown> = {}): Promise<number> {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: authHeaders(cookie),
    body: JSON.stringify({ propertyId: forPropertyId, role: "Buyer", firstName: "Contact", lastName: "First", ...overrides }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  const { party } = await jsonOf<{ party: { id: number } }>(res);
  return party.id;
}

function contactThreadsUrl(partyId: number): string {
  return `${baseUrl}/api/grow/contacts/${partyId}/communications/threads`;
}

async function createContactThread(cookie: string, partyId: number, subject: string) {
  const res = await fetch(contactThreadsUrl(partyId), {
    method: "POST",
    headers: authHeaders(cookie),
    body: JSON.stringify({ subject }),
  });
  return { status: res.status, body: await jsonOf<any>(res) };
}

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

  const name = `Communications Hub ${Date.now()}`;
  const created = await createBrokerageWithUsers(baseUrl, name);
  admin = created.admin;
  agent = created.agent;
  brokerageId = created.brokerageId;

  const pcLogin = await fetch(`${baseUrl}/api/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `pitcrew-${Date.now()}@example.com`, firstName: "Pit", lastName: "Crew", brokerageName: name }),
  });
  const pcBody = (await pcLogin.json()) as { user: { id: number } };
  const cookieMatch = (pcLogin.headers.get("set-cookie") ?? "").match(/aee_session=[^;]+/);
  if (!cookieMatch) throw new Error("no session cookie for pit crew dev-login");
  pitCrew = { cookie: cookieMatch[0], user: { ...pcBody.user, role: "Pit Crew", brokerageId, brokerageName: name } as any };
  // dev-login has no way to request a non-default role — promote directly,
  // matching the same "dev/staging-only shortcut" spirit as dev-login itself.
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pcBody.user.id));

  const listed = await createListedProperty(baseUrl, agent.cookie, { address: "1 Communications Test St" });
  propertyId = listed.propertyId;

  const other = await createBrokerageWithUsers(baseUrl, `Communications Hub Other ${Date.now()}`);
  otherAdmin = other.admin;
  otherBrokerageId = other.brokerageId;
});

after(async () => {
  await cleanupBrokerages([brokerageId, otherBrokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

// ---------------------------------------------------------------------
// 1. Agent sends a transactional email.
// ---------------------------------------------------------------------
let scenario1MessageId: number;

test("1. agent sends a transactional email — reaches SENT through the sandbox provider", async () => {
  const threadId = await createThread(agent.cookie, "Contract update");
  const participant = await addManualParticipant(agent.cookie, threadId, {
    displayName: "Sam Seller",
    role: "Seller",
    email: `seller-scenario1-${Date.now()}@example.com`,
    reason: "Vendor contact for this property",
  });

  const draft = await createDraft(agent.cookie, threadId, {
    channel: "EMAIL",
    classification: "TRANSACTIONAL",
    bodyText: "Your contract has been signed and exchanged.",
    recipientParticipantId: participant.id,
  });
  assert.equal(draft.status, "DRAFT");
  scenario1MessageId = draft.id;

  const { status, body } = await sendMessage(agent.cookie, draft.id, draft.version);
  assert.equal(status, 200);
  assert.equal(body.dispatched, true);
  assert.equal(body.blocked, false);
  assert.equal(body.message.status, "SENT");
  assert.equal(body.message.provider, "sandbox_email");
  assert.ok(body.message.providerMessageId);
  assert.ok(body.message.sentAt);
});

// ---------------------------------------------------------------------
// 2. Pit Crew sends on behalf of an agent — requires approval.
// ---------------------------------------------------------------------

test("2. Pit Crew sending on behalf of an agent is blocked until the agent approves it", async () => {
  const threadId = await createThread(pitCrew.cookie, "Pit Crew coordination");
  const participant = await addManualParticipant(pitCrew.cookie, threadId, {
    displayName: "Sam Seller",
    role: "Seller",
    email: `seller-scenario2-${Date.now()}@example.com`,
    reason: "Vendor contact for this property",
  });

  const draft = await createDraft(pitCrew.cookie, threadId, {
    channel: "EMAIL",
    classification: "SERVICE",
    bodyText: "The photographer is confirmed for Tuesday 9am.",
    recipientParticipantId: participant.id,
    sendOnBehalfOfUserId: agent.user.id,
  });

  const blocked = await sendMessage(pitCrew.cookie, draft.id, draft.version);
  assert.equal(blocked.status, 422, "sending on behalf of an agent must require approval first");

  const approvalReq = await fetch(`${baseUrl}/api/communications/messages/${draft.id}/request-approval`, {
    method: "POST",
    headers: authHeaders(pitCrew.cookie),
    body: JSON.stringify({ expectedVersion: draft.version }),
  });
  const afterRequest = await jsonOf<{ status: string; version: number }>(approvalReq);
  assert.equal(afterRequest.status, "AWAITING_APPROVAL");

  const approveRes = await fetch(`${baseUrl}/api/communications/messages/${draft.id}/approve`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ expectedVersion: afterRequest.version }),
  });
  const approved = await jsonOf<{ status: string; version: number }>(approveRes);
  assert.equal(approved.status, "APPROVED");

  const { status, body } = await sendMessage(agent.cookie, draft.id, approved.version);
  assert.equal(status, 200);
  assert.equal(body.message.status, "SENT");
  assert.equal(body.message.sendOnBehalfOfUserId, agent.user.id);
  assert.equal(body.message.senderUserId, pitCrew.user.id);
});

// ---------------------------------------------------------------------
// 3. SMS cost control blocks an over-threshold send.
// ---------------------------------------------------------------------

test("3. an SMS send is blocked once it would exceed the brokerage's cost-control threshold", async () => {
  // Force the very first SMS in this brokerage over threshold, then restore
  // a generous limit so this test's mutation doesn't leak into any other.
  const lowered = await fetch(`${baseUrl}/api/communications/settings`, {
    method: "PATCH",
    headers: authHeaders(admin.cookie),
    body: JSON.stringify({ smsHardThresholdCents: 5 }),
  });
  assert.equal(lowered.status, 200);

  const threadId = await createThread(agent.cookie, "SMS cost control test");
  const participant = await addManualParticipant(agent.cookie, threadId, {
    displayName: "Sam Seller",
    role: "Seller",
    mobile: "0400000111",
    reason: "SMS test contact",
  });

  const draft = await createDraft(agent.cookie, threadId, {
    channel: "SMS",
    classification: "TRANSACTIONAL",
    bodyText: "Reminder: inspection at 10am tomorrow.",
    recipientParticipantId: participant.id,
  });

  const { status, body } = await sendMessage(agent.cookie, draft.id, draft.version);
  assert.equal(status, 200);
  assert.equal(body.blocked, true);
  assert.equal(body.message.status, "BLOCKED_BY_COST_CONTROL");
  assert.match(body.blockedReason ?? "", /cost limit/);

  const restored = await fetch(`${baseUrl}/api/communications/settings`, {
    method: "PATCH",
    headers: authHeaders(admin.cookie),
    body: JSON.stringify({ smsHardThresholdCents: 20000 }),
  });
  assert.equal(restored.status, 200);
});

// ---------------------------------------------------------------------
// 4. A Pit-Crew-authored PC_EVENT template message requires approval.
// ---------------------------------------------------------------------

test("4. a Pit-Crew-authored PC_EVENT template message requires approval before it can send", async () => {
  const createTemplateRes = await fetch(`${baseUrl}/api/communications/templates`, {
    method: "POST",
    headers: authHeaders(pitCrew.cookie),
    body: JSON.stringify({
      templateKey: "pc-vendor-confirmed",
      name: "Vendor confirmed",
      channel: "EMAIL",
      classification: "SERVICE",
      category: "PC_EVENT",
      bodyText: "{{vendor.name}} is confirmed for {{vendor.date}}.",
      placeholders: ["vendor.name", "vendor.date"],
    }),
  });
  const template = await jsonOf<{ id: number }>(createTemplateRes);
  const activateRes = await fetch(`${baseUrl}/api/communications/templates/${template.id}/activate`, {
    method: "POST",
    headers: authHeaders(pitCrew.cookie),
  });
  assert.equal(activateRes.status, 200);

  const threadId = await createThread(pitCrew.cookie, "Vendor coordination");
  const participant = await addManualParticipant(pitCrew.cookie, threadId, {
    displayName: "Sam Seller",
    role: "Seller",
    email: `seller-scenario4-${Date.now()}@example.com`,
    reason: "Vendor contact for this property",
  });

  const draft = await createDraft(pitCrew.cookie, threadId, {
    channel: "EMAIL",
    classification: "SERVICE",
    recipientParticipantId: participant.id,
    sendOnBehalfOfUserId: agent.user.id,
    templateId: template.id,
    placeholderValues: { "vendor.name": "Dave the Photographer", "vendor.date": "Tuesday 9am" },
  });
  assert.match(draft.status, /DRAFT/);

  const blocked = await sendMessage(pitCrew.cookie, draft.id, draft.version);
  assert.equal(blocked.status, 422);

  await fetch(`${baseUrl}/api/communications/messages/${draft.id}/request-approval`, {
    method: "POST",
    headers: authHeaders(pitCrew.cookie),
    body: JSON.stringify({ expectedVersion: draft.version }),
  });
  const approveRes = await fetch(`${baseUrl}/api/communications/messages/${draft.id}/approve`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ expectedVersion: draft.version + 1 }),
  });
  const approved = await jsonOf<{ status: string; version: number }>(approveRes);
  assert.equal(approved.status, "APPROVED");

  const { status, body } = await sendMessage(agent.cookie, draft.id, approved.version);
  assert.equal(status, 200);
  assert.equal(body.message.status, "SENT");
  assert.equal(body.message.bodyText, "Dave the Photographer is confirmed for Tuesday 9am.");
});

// ---------------------------------------------------------------------
// 5. Delivery failure and bounded retry.
// ---------------------------------------------------------------------

test("5. a retryable delivery failure is retried up to the bound, then reaches a terminal state", async () => {
  const threadId = await createThread(agent.cookie, "Delivery failure test");
  const participant = await addManualParticipant(agent.cookie, threadId, {
    displayName: "Unreachable Recipient",
    role: "Seller",
    email: "sandboxfail+timeout@example.com",
    reason: "Sandbox failure-simulation destination",
  });

  const draft = await createDraft(agent.cookie, threadId, {
    channel: "EMAIL",
    classification: "TRANSACTIONAL",
    bodyText: "This send is designed to fail in the sandbox provider.",
    recipientParticipantId: participant.id,
  });

  const first = await sendMessage(agent.cookie, draft.id, draft.version);
  assert.equal(first.status, 200);
  assert.equal(first.body.message.status, "RETRY_SCHEDULED");
  assert.equal(first.body.message.retryCount, 1);

  // Simulate the scheduler's sweep picking this message up once its backoff
  // has elapsed — dispatchMessage itself doesn't gate on scheduledAt, only
  // dispatchDueMessages' SELECT does, so calling it directly here exercises
  // exactly the same retry path a real elapsed-backoff sweep would.
  const second = await dispatchMessage(draft.id, brokerageId);
  assert.equal(second.status, "RETRY_SCHEDULED");
  assert.equal(second.retryCount, 2);

  const third = await dispatchMessage(draft.id, brokerageId);
  assert.equal(third.status, "FAILED", "the third attempt exhausts maxRetries (3) and becomes terminal");
  assert.equal(third.retryCount, 3);
  assert.equal(third.failureCategory, "PROVIDER_TIMEOUT");
});

// ---------------------------------------------------------------------
// 6. Marketing opt-out blocks a send; consent then unblocks it.
// ---------------------------------------------------------------------

test("6. a marketing send is blocked without opt-in, then succeeds once consent is recorded and requeued", async () => {
  const destination = `marketing-opt-in-${Date.now()}@example.com`;
  const threadId = await createThread(agent.cookie, "Marketing campaign");
  const participant = await addManualParticipant(agent.cookie, threadId, {
    displayName: "Prospective Buyer",
    role: "Other",
    email: destination,
    reason: "Marketing list contact",
  });

  const draft = await createDraft(agent.cookie, threadId, {
    channel: "EMAIL",
    classification: "MARKETING",
    bodyText: "Check out our latest listings!",
    recipientParticipantId: participant.id,
  });

  // MARKETING always requires approval (Section 15) regardless of sender.
  await fetch(`${baseUrl}/api/communications/messages/${draft.id}/request-approval`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ expectedVersion: draft.version }),
  });
  const approveRes = await fetch(`${baseUrl}/api/communications/messages/${draft.id}/approve`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ expectedVersion: draft.version + 1 }),
  });
  const approved = await jsonOf<{ status: string; version: number }>(approveRes);
  assert.equal(approved.status, "APPROVED");

  const blockedSend = await sendMessage(agent.cookie, draft.id, approved.version);
  assert.equal(blockedSend.status, 200);
  assert.equal(blockedSend.body.blocked, true);
  assert.equal(blockedSend.body.message.status, "BLOCKED_BY_CONSENT");

  // AE GROW W1-A (A-2): recording consent now requires grow.contacts.manage.
  // Granted just for this step and handed straight back, because the
  // contact-first test further down asserts a 403 before it grants anything.
  await grant(brokerageId, "grow.contacts.manage");
  const consentRes = await fetch(`${baseUrl}/api/communications/consent`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ channel: "EMAIL", destination, marketingOptIn: true }),
  });
  assert.equal(consentRes.status, 201);
  await revoke(brokerageId, "grow.contacts.manage");

  const requeueRes = await fetch(`${baseUrl}/api/communications/messages/${draft.id}/requeue`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ expectedVersion: blockedSend.body.message.version }),
  });
  const requeued = await jsonOf<{ blocked: boolean; dispatched: boolean; message: { status: string } }>(requeueRes);
  assert.equal(requeued.blocked, false);
  assert.equal(requeued.message.status, "SENT");
});

// ---------------------------------------------------------------------
// 7. Duplicate inbound webhook idempotency.
// ---------------------------------------------------------------------

test("7. a redelivered delivery-receipt webhook is processed exactly once", async () => {
  const [message] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, scenario1MessageId));
  assert.ok(message?.providerMessageId, "scenario 1 must have left a providerMessageId to reference");

  const eventId = `webhook-dedup-test-${Date.now()}`;
  const payload = { eventId, eventType: "DELIVERY_RECEIPT", providerMessageId: message!.providerMessageId };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(timestamp).update(".").update(rawBody).digest("hex");

  const firstRes = await fetch(`${baseUrl}/api/communications/webhooks/${brokerageId}/sandbox_email`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-communications-timestamp": timestamp, "x-communications-signature": signature },
    body: rawBody,
  });
  const first = await jsonOf<{ status: string }>(firstRes);
  assert.equal(firstRes.status, 200);
  assert.equal(first.status, "PROCESSED");

  const [afterFirst] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, scenario1MessageId));
  assert.equal(afterFirst?.status, "DELIVERED");

  // A correctly signed callback must still be bound to the provider and
  // tenant context in its URL. Neither a sibling sandbox provider nor a
  // different brokerage may transition this message.
  for (const [label, callbackBrokerageId, callbackProvider] of [
    ["provider-manipulated", brokerageId, "sandbox_sms"],
    ["tenant-manipulated", otherBrokerageId, "sandbox_email"],
  ] as const) {
    const isolatedPayload = {
      eventId: `${eventId}-${label}`,
      eventType: "BOUNCE",
      providerMessageId: message!.providerMessageId,
    };
    const isolatedRawBody = Buffer.from(JSON.stringify(isolatedPayload));
    const isolatedTimestamp = String(Math.floor(Date.now() / 1_000));
    const isolatedSignature = createHmac("sha256", WEBHOOK_SECRET)
      .update(isolatedTimestamp)
      .update(".")
      .update(isolatedRawBody)
      .digest("hex");
    const isolatedRes = await fetch(`${baseUrl}/api/communications/webhooks/${callbackBrokerageId}/${callbackProvider}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-communications-timestamp": isolatedTimestamp,
        "x-communications-signature": isolatedSignature,
      },
      body: isolatedRawBody,
    });
    assert.equal(isolatedRes.status, 200);
    const [unchanged] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, scenario1MessageId));
    assert.equal(unchanged?.status, "DELIVERED", `${label} webhook must not mutate another provider/tenant's message`);
  }

  const secondRes = await fetch(`${baseUrl}/api/communications/webhooks/${brokerageId}/sandbox_email`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-communications-timestamp": timestamp, "x-communications-signature": signature },
    body: rawBody,
  });
  const second = await jsonOf<{ status: string }>(secondRes);
  assert.equal(secondRes.status, 200);
  assert.equal(second.status, "DUPLICATE");

  const dedupRows = await db
    .select()
    .from(communicationWebhookEvents)
    .where(and(eq(communicationWebhookEvents.provider, "sandbox_email"), eq(communicationWebhookEvents.providerEventId, eventId)));
  assert.equal(dedupRows.length, 1, "exactly one webhook-event row should exist for this provider event id");

  const badSignatureRes = await fetch(`${baseUrl}/api/communications/webhooks/${brokerageId}/sandbox_email`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-communications-signature": "not-a-real-signature" },
    body: Buffer.from(JSON.stringify({ eventId: `${eventId}-bad-sig`, eventType: "DELIVERY_RECEIPT" })),
  });
  assert.equal(badSignatureRes.status, 401);
});

// ---------------------------------------------------------------------
// 8. Tenant isolation.
// ---------------------------------------------------------------------

test("8. a message/thread from one brokerage is invisible and inaccessible to another brokerage's user", async () => {
  const threadId = await createThread(agent.cookie, "Tenant isolation test");
  const participant = await addManualParticipant(agent.cookie, threadId, {
    displayName: "Sam Seller",
    role: "Seller",
    email: `seller-scenario8-${Date.now()}@example.com`,
    reason: "Tenant isolation test contact",
  });
  const draft = await createDraft(agent.cookie, threadId, {
    channel: "EMAIL",
    classification: "TRANSACTIONAL",
    bodyText: "This message must never be visible to another brokerage.",
    recipientParticipantId: participant.id,
  });

  const crossTenantThreadRes = await fetch(`${baseUrl}/api/communications/threads/${threadId}`, { headers: { cookie: otherAdmin.cookie } });
  assert.equal(crossTenantThreadRes.status, 404);

  const crossTenantMessageRes = await fetch(`${baseUrl}/api/communications/messages/${draft.id}`, { headers: { cookie: otherAdmin.cookie } });
  assert.equal(crossTenantMessageRes.status, 404);

  const crossTenantSendRes = await fetch(`${baseUrl}/api/communications/messages/${draft.id}/send`, {
    method: "POST",
    headers: authHeaders(otherAdmin.cookie),
    body: JSON.stringify({ expectedVersion: draft.version }),
  });
  assert.equal(crossTenantSendRes.status, 404);

  const crossTenantRecipientsRes = await fetch(`${baseUrl}/api/properties/${propertyId}/communications/recipients`, { headers: { cookie: otherAdmin.cookie } });
  assert.equal(crossTenantRecipientsRes.status, 404);

  // The message is untouched and still sendable by its own brokerage.
  const ownSend = await sendMessage(agent.cookie, draft.id, draft.version);
  assert.equal(ownSend.status, 200);
  assert.equal(ownSend.body.message.status, "SENT");
});

// =======================================================================
// AE GROW PRIORITY 3 — contact-first (property-less) threads/messages.
// Additive coverage for the new /grow/contacts/:partyId/communications/...
// routes and the propertyId/partyId anchoring change to createThread/
// createDraftMessage (see routes/communications.ts's own "contact-first"
// header comment and lib/communications/messages.ts's AE GROW PRIORITY 3
// comments). Scenarios 1-8 above are untouched — every property-first
// assertion in this file still exercises the exact same routes it always
// did, unchanged.
// =======================================================================

let contactFirstPartyId: number;
let contactFirstThreadId: number;
let contactFirstParticipantId: number;

test("AE Grow Priority 3 — creating a contact-first thread requires grow.contacts.manage and anchors the thread to partyId with propertyId null", async () => {
  const originPropertyId = await createHttpProperty(agent.cookie, "Contact First Origin Property");
  contactFirstPartyId = await createHttpParty(agent.cookie, originPropertyId, {
    firstName: "Cara",
    lastName: "ContactFirst",
    email: `cara-contactfirst-${Date.now()}@example.com`,
    mobile: "0400222333",
  });

  const beforeGrant = await createContactThread(agent.cookie, contactFirstPartyId, "Prospecting chat");
  assert.equal(beforeGrant.status, 403, "creating a contact-first thread must require grow.contacts.manage, not just being an authenticated brokerage user");
  assert.equal(beforeGrant.body.reason, "ENTITLEMENT_MISSING");

  await grant(brokerageId, "grow.contacts.manage");
  await grant(brokerageId, "grow.contacts.read");

  const created = await createContactThread(agent.cookie, contactFirstPartyId, "Prospecting chat");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.partyId, contactFirstPartyId);
  assert.equal(created.body.propertyId, null, "a contact-first thread must never carry a propertyId");
  contactFirstThreadId = created.body.id;
});

test("AE Grow Priority 3 — creating a contact-first thread for a nonexistent party, or a party belonging to another brokerage, is rejected with 404, not a 500 or silent success", async () => {
  const nonexistentRes = await createContactThread(agent.cookie, 999999999, "Should not be created");
  assert.equal(nonexistentRes.status, 404, JSON.stringify(nonexistentRes.body));

  const otherOriginPropertyId = await createHttpProperty(otherAdmin.cookie, "Other Brokerage Origin Property");
  const otherPartyId = await createHttpParty(otherAdmin.cookie, otherOriginPropertyId, { firstName: "Other", lastName: "Brokerage" });

  const crossTenantRes = await createContactThread(agent.cookie, otherPartyId, "Should not be created either");
  assert.equal(crossTenantRes.status, 404, JSON.stringify(crossTenantRes.body));

  // Confirm neither rejected attempt actually left a row behind.
  const threadsForOtherParty = await db.select().from(communicationThreads).where(eq(communicationThreads.partyId, otherPartyId));
  assert.equal(threadsForOtherParty.length, 0, "a rejected thread creation (nonexistent or cross-tenant party) must not have left a row behind");
});

test("AE Grow Priority 3 — an email send from a contact-first thread reaches SENT through the same draft-to-send lifecycle as property-first, via the intended add-participant-from-party flow", async () => {
  const recipientsRes = await fetch(`${baseUrl}/api/grow/contacts/${contactFirstPartyId}/communications/recipients`, { headers: { cookie: agent.cookie } });
  const recipientsBody = await jsonOf<{ candidates: Array<{ partyId: number; email: string | null; mobile: string | null }> }>(recipientsRes);
  assert.equal(recipientsRes.status, 200);
  assert.equal(recipientsBody.candidates.length, 1, "a contact-first thread's candidate pool is exactly the one contact it is anchored to");
  assert.equal(recipientsBody.candidates[0]!.partyId, contactFirstPartyId);

  const participantRes = await fetch(`${baseUrl}/api/communications/threads/${contactFirstThreadId}/participants`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ partyId: contactFirstPartyId, role: "Other" }),
  });
  const participant = await jsonOf<{ id: number }>(participantRes);
  assert.equal(participantRes.status, 201, JSON.stringify(participant));
  contactFirstParticipantId = participant.id;

  const draft = await createDraft(agent.cookie, contactFirstThreadId, {
    channel: "EMAIL",
    classification: "TRANSACTIONAL",
    bodyText: "Thanks for registering your interest.",
    recipientParticipantId: contactFirstParticipantId,
  });
  assert.equal(draft.status, "DRAFT");

  const { status, body } = await sendMessage(agent.cookie, draft.id, draft.version);
  assert.equal(status, 200);
  assert.equal(body.dispatched, true);
  assert.equal(body.blocked, false);
  assert.equal(body.message.status, "SENT");
  assert.equal(body.message.provider, "sandbox_email");
  assert.equal(body.message.partyId, contactFirstPartyId);
  assert.equal(body.message.propertyId, null, "a contact-first message must never carry a propertyId");
});

test("AE Grow Priority 3 — an SMS send from a contact-first thread reaches SENT likewise, reusing the same participant record", async () => {
  const draft = await createDraft(agent.cookie, contactFirstThreadId, {
    channel: "SMS",
    classification: "TRANSACTIONAL",
    bodyText: "Reminder: your appraisal is booked for 10am.",
    recipientParticipantId: contactFirstParticipantId,
  });
  assert.equal(draft.status, "DRAFT");

  const { status, body } = await sendMessage(agent.cookie, draft.id, draft.version);
  assert.equal(status, 200);
  assert.equal(body.dispatched, true);
  assert.equal(body.blocked, false);
  assert.equal(body.message.status, "SENT");
  assert.equal(body.message.provider, "sandbox_sms");
  assert.equal(body.message.partyId, contactFirstPartyId);
  assert.equal(body.message.propertyId, null, "a contact-first message must never carry a propertyId");
});

test("AE Grow Priority 3 — a brokerage cannot create a thread for, read, or send on another brokerage's contact-first thread/party, even while holding the same entitlements; nothing leaks in the DB", async () => {
  // Grant otherBrokerageId the SAME entitlements brokerageId already holds so a 404 here proves
  // the row-level tenant check, not merely a missing entitlement (matching contacts.test.ts's
  // own isolation-testing convention).
  await grant(otherBrokerageId, "grow.contacts.manage");
  await grant(otherBrokerageId, "grow.contacts.read");

  const crossTenantCreate = await createContactThread(otherAdmin.cookie, contactFirstPartyId, "Should be rejected");
  assert.equal(crossTenantCreate.status, 404);

  const crossTenantRead = await fetch(`${baseUrl}/api/communications/threads/${contactFirstThreadId}`, { headers: { cookie: otherAdmin.cookie } });
  assert.equal(crossTenantRead.status, 404);

  const crossTenantThreadsList = await fetch(contactThreadsUrl(contactFirstPartyId), { headers: { cookie: otherAdmin.cookie } });
  assert.equal(crossTenantThreadsList.status, 404, "listing another brokerage's contact's threads must 404, not return them");

  const ownDraft = await createDraft(agent.cookie, contactFirstThreadId, {
    channel: "EMAIL",
    classification: "TRANSACTIONAL",
    bodyText: "A message on the real owner's own thread.",
    recipientParticipantId: contactFirstParticipantId,
  });
  const crossTenantSend = await sendMessage(otherAdmin.cookie, ownDraft.id, ownDraft.version);
  assert.equal(crossTenantSend.status, 404);

  // Direct DB read: confirm the cross-tenant attempts left nothing behind, and that the real
  // thread/message still belong to the original brokerage, untouched.
  const [threadRow] = await db.select().from(communicationThreads).where(eq(communicationThreads.id, contactFirstThreadId));
  assert.equal(threadRow?.brokerageId, brokerageId);
  const [messageRow] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, ownDraft.id));
  assert.equal(messageRow?.brokerageId, brokerageId);
  assert.equal(messageRow?.status, "DRAFT", "the cross-tenant send attempt must not have moved this message out of DRAFT");

  const threadsAnchoredToContact = await db.select().from(communicationThreads).where(eq(communicationThreads.partyId, contactFirstPartyId));
  assert.ok(
    threadsAnchoredToContact.every((t) => t.brokerageId === brokerageId),
    "no thread anchored to this contact must ever belong to another brokerage",
  );
});

test("AE Grow Priority 3 — a marketing email on a contact-first thread is blocked without opt-in, then succeeds once consent is recorded and requeued", async () => {
  const marketingOriginPropertyId = await createHttpProperty(agent.cookie, "Contact First Marketing Origin");
  const marketingPartyId = await createHttpParty(agent.cookie, marketingOriginPropertyId, { firstName: "Mia", lastName: "Marketing" });
  const threadRes = await createContactThread(agent.cookie, marketingPartyId, "Marketing outreach");
  assert.equal(threadRes.status, 201, JSON.stringify(threadRes.body));
  const threadId = threadRes.body.id;

  const destination = `contact-first-marketing-${Date.now()}@example.com`;
  const draft = await createDraft(agent.cookie, threadId, {
    channel: "EMAIL",
    classification: "MARKETING",
    bodyText: "Check out our latest listings!",
    recipientDisplayName: "Mia Marketing",
    recipientDestination: destination,
  });

  await fetch(`${baseUrl}/api/communications/messages/${draft.id}/request-approval`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ expectedVersion: draft.version }),
  });
  const approveRes = await fetch(`${baseUrl}/api/communications/messages/${draft.id}/approve`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ expectedVersion: draft.version + 1 }),
  });
  const approved = await jsonOf<{ status: string; version: number }>(approveRes);
  assert.equal(approved.status, "APPROVED");

  const blockedSend = await sendMessage(agent.cookie, draft.id, approved.version);
  assert.equal(blockedSend.status, 200);
  assert.equal(blockedSend.body.blocked, true);
  assert.equal(blockedSend.body.message.status, "BLOCKED_BY_CONSENT");
  assert.equal(blockedSend.body.message.partyId, marketingPartyId, "the blocked message must still carry its contact-first partyId");
  assert.equal(blockedSend.body.message.propertyId, null);

  const consentRes = await fetch(`${baseUrl}/api/communications/consent`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ channel: "EMAIL", destination, marketingOptIn: true }),
  });
  assert.equal(consentRes.status, 201);

  const requeueRes = await fetch(`${baseUrl}/api/communications/messages/${draft.id}/requeue`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ expectedVersion: blockedSend.body.message.version }),
  });
  const requeued = await jsonOf<{ blocked: boolean; message: { status: string } }>(requeueRes);
  assert.equal(requeued.blocked, false);
  assert.equal(requeued.message.status, "SENT");
});

test("AE Grow Priority 3 — a marketing SMS on a contact-first thread is blocked without opt-in, then succeeds once consent is recorded and requeued", async () => {
  const marketingOriginPropertyId = await createHttpProperty(agent.cookie, "Contact First SMS Marketing Origin");
  const marketingPartyId = await createHttpParty(agent.cookie, marketingOriginPropertyId, { firstName: "Sam", lastName: "SmsMarketing" });
  const threadRes = await createContactThread(agent.cookie, marketingPartyId, "SMS marketing outreach");
  assert.equal(threadRes.status, 201, JSON.stringify(threadRes.body));
  const threadId = threadRes.body.id;

  const destination = "0400777888";
  const draft = await createDraft(agent.cookie, threadId, {
    channel: "SMS",
    classification: "MARKETING",
    bodyText: "Check out our latest listings!",
    recipientDisplayName: "Sam SmsMarketing",
    recipientDestination: destination,
  });

  await fetch(`${baseUrl}/api/communications/messages/${draft.id}/request-approval`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ expectedVersion: draft.version }),
  });
  const approveRes = await fetch(`${baseUrl}/api/communications/messages/${draft.id}/approve`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ expectedVersion: draft.version + 1 }),
  });
  const approved = await jsonOf<{ status: string; version: number }>(approveRes);
  assert.equal(approved.status, "APPROVED");

  const blockedSend = await sendMessage(agent.cookie, draft.id, approved.version);
  assert.equal(blockedSend.status, 200);
  assert.equal(blockedSend.body.blocked, true);
  assert.equal(blockedSend.body.message.status, "BLOCKED_BY_CONSENT");

  const consentRes = await fetch(`${baseUrl}/api/communications/consent`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ channel: "SMS", destination, marketingOptIn: true }),
  });
  assert.equal(consentRes.status, 201);

  const requeueRes = await fetch(`${baseUrl}/api/communications/messages/${draft.id}/requeue`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ expectedVersion: blockedSend.body.message.version }),
  });
  const requeued = await jsonOf<{ blocked: boolean; message: { status: string } }>(requeueRes);
  assert.equal(requeued.blocked, false);
  assert.equal(requeued.message.status, "SENT");
});

test("AE Grow Priority 3 regression — a property-first thread and message keep propertyId set and partyId null throughout the lifecycle, unchanged by the contact-first addition", async () => {
  const threadId = await createThread(agent.cookie, "Property-first regression check");
  const threadRes = await fetch(`${baseUrl}/api/communications/threads/${threadId}`, { headers: { cookie: agent.cookie } });
  const threadBody = await jsonOf<{ thread: { propertyId: number | null; partyId: number | null } }>(threadRes);
  assert.equal(threadRes.status, 200);
  assert.equal(threadBody.thread.propertyId, propertyId);
  assert.equal(threadBody.thread.partyId, null, "a property-first thread must never pick up a partyId it was never given");

  const participant = await addManualParticipant(agent.cookie, threadId, {
    displayName: "Regression Contact",
    role: "Seller",
    email: `regression-${Date.now()}@example.com`,
    reason: "Property-first regression contact",
  });
  const draft = await createDraft(agent.cookie, threadId, {
    channel: "EMAIL",
    classification: "TRANSACTIONAL",
    bodyText: "Property-first regression message.",
    recipientParticipantId: participant.id,
  });
  assert.equal(draft.status, "DRAFT");

  const { status, body } = await sendMessage(agent.cookie, draft.id, draft.version);
  assert.equal(status, 200);
  assert.equal(body.message.status, "SENT");
  assert.equal(body.message.propertyId, propertyId, "a property-first message must keep its propertyId unchanged by the Priority 3 anchoring change");
  assert.equal(body.message.partyId, null, "a property-first message must never pick up a partyId it was never given");
});

// ---------------------------------------------------------------------
// B-5. SERVICE needs a human other than the sender.
// ---------------------------------------------------------------------

test("B-5: a SERVICE message is rejected when the only accountable human is the sender", async () => {
  const threadId = await createThread(agent.cookie, "Service needs another human");
  const participant = await addManualParticipant(agent.cookie, threadId, {
    displayName: "Sam Seller",
    role: "Seller",
    email: `seller-b5-${Date.now()}@example.com`,
    reason: "Service-message recipient",
  });

  const draft = await createDraft(agent.cookie, threadId, {
    channel: "EMAIL",
    classification: "SERVICE",
    bodyText: "The photographer is confirmed for Tuesday 9am.",
    recipientParticipantId: participant.id,
  });
  assert.equal(draft.status, "DRAFT");

  const blockedSend = await sendMessage(agent.cookie, draft.id, draft.version);
  assert.equal(blockedSend.status, 422, "the sender alone must not be able to send a SERVICE message");
  assert.match(String(blockedSend.body.error), /requires approval/);

  await assert.rejects(
    () => queueMessage(draft.id, brokerageId, agent.user.id, draft.version),
    (err: unknown) => err instanceof CommunicationTransitionError && /requires approval/.test(err.message),
    "queueing a SERVICE draft must not skip the approval gate",
  );

  const approvalReq = await fetch(`${baseUrl}/api/communications/messages/${draft.id}/request-approval`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ expectedVersion: draft.version }),
  });
  const afterRequest = await jsonOf<{ status: string; version: number }>(approvalReq);
  assert.equal(approvalReq.status, 200);
  assert.equal(afterRequest.status, "AWAITING_APPROVAL");

  const selfApprove = await fetch(`${baseUrl}/api/communications/messages/${draft.id}/approve`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ expectedVersion: afterRequest.version }),
  });
  const selfBody = await jsonOf<{ error: string }>(selfApprove);
  assert.equal(selfApprove.status, 422, "the sender must not be able to approve their own SERVICE message");
  assert.match(selfBody.error, /someone other than the sender/);

  const approveRes = await fetch(`${baseUrl}/api/communications/messages/${draft.id}/approve`, {
    method: "POST",
    headers: authHeaders(admin.cookie),
    body: JSON.stringify({ expectedVersion: afterRequest.version }),
  });
  const approved = await jsonOf<{ status: string; version: number }>(approveRes);
  assert.equal(approveRes.status, 200);
  assert.equal(approved.status, "APPROVED");

  const sent = await sendMessage(agent.cookie, draft.id, approved.version);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.message.status, "SENT");
});
