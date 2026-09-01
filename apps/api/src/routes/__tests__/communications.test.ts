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
import { db, users, communicationMessages, communicationWebhookEvents } from "@aee/db";
import { dispatchMessage } from "../../lib/communications/outbox.js";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

// devLogin() below requires ALLOW_DEV_AUTH=true. Most suites in this repo
// set this themselves at module load (see e.g. transactionConditions.test.ts)
// rather than relying on an ambient value that may not be set, and this
// suite should too.
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
let admin: DevLoginResult;
let agent: DevLoginResult;
let pitCrew: DevLoginResult;
let brokerageId: number;
let propertyId: number;

let otherAdmin: DevLoginResult;
let otherBrokerageId: number;

const WEBHOOK_SECRET = process.env.COMMUNICATIONS_WEBHOOK_SECRET ?? "dev-sandbox-communications-webhook-secret";

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
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");

  const firstRes = await fetch(`${baseUrl}/api/communications/webhooks/${brokerageId}/sandbox_email`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-communications-signature": signature },
    body: rawBody,
  });
  const first = await jsonOf<{ status: string }>(firstRes);
  assert.equal(firstRes.status, 200);
  assert.equal(first.status, "PROCESSED");

  const [afterFirst] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, scenario1MessageId));
  assert.equal(afterFirst?.status, "DELIVERED");

  const secondRes = await fetch(`${baseUrl}/api/communications/webhooks/${brokerageId}/sandbox_email`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-communications-signature": signature },
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
