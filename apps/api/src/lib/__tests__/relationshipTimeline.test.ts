// AE GROW PRIORITY 3 — permanent lib-level regression coverage for
// apps/api/src/lib/relationshipTimeline.ts's communications aggregation
// (buildCommunicationEvent / getRelationshipTimeline). This file did not
// exist before this priority — relationshipTimeline.ts's own Priority 2
// coverage lives entirely inside routes/__tests__/contacts.test.ts's
// "Relationship Timeline" test (via the GET /grow/contacts/:partyId HTTP
// route), which never touched communications and is left untouched here.
//
// Mirrors lib/__tests__/transactionConditions.test.ts's own convention: a
// real Express server + dev-login purely to create HTTP-backed fixtures
// (a brokerage, a property, a party), then the actual Communications Hub
// lib functions under test — createThread / createDraftMessage (messages.ts)
// and queueMessage / applyMessageTransition (outbox.ts) — called directly,
// exactly as outbox.ts's own header comment describes queueMessage-then-
// dispatchMessage as the SOLE place a message is ever sent. This file is
// scoped to getRelationshipTimeline's own contract (one event per message,
// the EMAIL/SMS SENT/DELIVERED/FAILED status mapping, tenant isolation) —
// the outbox/consent/cost-control machinery those functions lean on already
// has its own dedicated end-to-end coverage in
// routes/__tests__/communications.test.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { getRelationshipTimeline } from "../relationshipTimeline.js";
import { createThread, createDraftMessage } from "../communications/messages.js";
import { queueMessage, applyMessageTransition } from "../communications/outbox.js";
import { normalizeDestination } from "../communications/consent.js";
import { db, communicationConsent, growContactChannelConsents } from "@aee/db";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
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

  A = await createBrokerageWithUsers(baseUrl, `Relationship Timeline Comms A ${Date.now()}`);
  B = await createBrokerageWithUsers(baseUrl, `Relationship Timeline Comms B ${Date.now()}`);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

async function createParty(cookie: string, propertyId: number, overrides: Record<string, unknown> = {}): Promise<number> {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, role: "Buyer", firstName: "Test", lastName: "Contact", ...overrides }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  const { party } = (await res.json()) as { party: { id: number } };
  return party.id;
}

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`;
}

interface SendFixtureInput {
  brokerageId: number;
  senderUserId: number;
  partyId: number;
  channel: "EMAIL" | "SMS";
  bodyText: string;
  recipientDisplayName: string;
  recipientDestination: string;
}

/** Creates a contact-first thread + DRAFT message, then queues it through the real outbox send path (queueMessage -> evaluateAndDispatchQueuedMessage -> dispatchMessage) — the exact same path routes/communications.ts's POST .../send uses, minus the HTTP/approval layer this lib-level suite doesn't need to re-exercise. */
async function draftAndSend(input: SendFixtureInput) {
  const thread = await createThread({
    brokerageId: input.brokerageId,
    partyId: input.partyId,
    subject: `Timeline fixture — ${input.channel}`,
    createdByUserId: input.senderUserId,
  });
  assert.equal(thread.partyId, input.partyId);
  assert.equal(thread.propertyId, null, "a contact-first thread must never carry a propertyId");

  const message = await createDraftMessage({
    threadId: thread.id,
    brokerageId: input.brokerageId,
    channel: input.channel,
    classification: "TRANSACTIONAL",
    bodyText: input.bodyText,
    recipientDisplayName: input.recipientDisplayName,
    recipientDestination: input.recipientDestination,
    senderUserId: input.senderUserId,
    createdByUserId: input.senderUserId,
  });
  assert.equal(message.partyId, input.partyId);
  assert.equal(message.propertyId, null);

  await db.insert(communicationConsent).values({
    brokerageId: input.brokerageId,
    partyId: input.partyId,
    destination: normalizeDestination(input.channel, input.recipientDestination),
    channel: input.channel,
    marketingOptIn: false,
    transactionalOptOut: false,
    source: "MANUAL",
    recordedByUserId: input.senderUserId,
  });
  await db.insert(growContactChannelConsents).values({
    brokerageId: input.brokerageId,
    partyId: input.partyId,
    channel: input.channel,
    state: "EXPRESS",
    source: "MANUAL",
    captureMethod: "WRITTEN",
    purpose: input.channel,
    scope: "OUTBOUND",
    recordedByUserId: input.senderUserId,
  });

  const result = await queueMessage(message.id, input.brokerageId, input.senderUserId, message.version);
  return { thread, message: result.message, result };
}

test("a sent email appears as EMAIL_SENT in the contact's timeline", async () => {
  const propertyId = await createProperty(A.agent.cookie, "1 Timeline Email Way");
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Tess", lastName: "Timeline", email: uniqueEmail("tess-email") });

  const { message } = await draftAndSend({
    brokerageId: A.brokerageId,
    senderUserId: A.agent.user.id,
    partyId,
    channel: "EMAIL",
    bodyText: "Your appraisal is booked for Thursday.",
    recipientDisplayName: "Tess Timeline",
    recipientDestination: uniqueEmail("tess-timeline-dest"),
  });
  assert.equal(message.status, "SENT");
  assert.equal(message.provider, "sandbox_email");

  const timeline = await getRelationshipTimeline(A.brokerageId, partyId);
  const event = timeline.find((e) => e.id === `communication:${message.id}:EMAIL_SENT`);
  assert.ok(event, "EMAIL_SENT event must appear on the contact's timeline");
  assert.equal(event!.type, "EMAIL_SENT");
  assert.equal(event!.sourceType, "communication");
  assert.equal(event!.sourceId, message.id);
});

test("a sent SMS appears as SMS_SENT in the contact's timeline", async () => {
  const propertyId = await createProperty(A.agent.cookie, "2 Timeline SMS Rd");
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Sam", lastName: "SmsTimeline", mobile: "0400333444" });

  const { message } = await draftAndSend({
    brokerageId: A.brokerageId,
    senderUserId: A.agent.user.id,
    partyId,
    channel: "SMS",
    bodyText: "Reminder: your appraisal is at 10am.",
    recipientDisplayName: "Sam SmsTimeline",
    recipientDestination: "0400333555",
  });
  assert.equal(message.status, "SENT");
  assert.equal(message.provider, "sandbox_sms");

  const timeline = await getRelationshipTimeline(A.brokerageId, partyId);
  const event = timeline.find((e) => e.id === `communication:${message.id}:SMS_SENT`);
  assert.ok(event, "SMS_SENT event must appear on the contact's timeline");
  assert.equal(event!.type, "SMS_SENT");
  assert.equal(event!.sourceType, "communication");
  assert.equal(event!.sourceId, message.id);
});

test("a message that moves from SENT to DELIVERED produces exactly one timeline entry for that message, now typed EMAIL_DELIVERED", async () => {
  const propertyId = await createProperty(A.agent.cookie, "3 Timeline Delivered Cl");
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Della", lastName: "Delivered", email: uniqueEmail("della") });

  const { message } = await draftAndSend({
    brokerageId: A.brokerageId,
    senderUserId: A.agent.user.id,
    partyId,
    channel: "EMAIL",
    bodyText: "Your contract pack is attached.",
    recipientDisplayName: "Della Delivered",
    recipientDestination: uniqueEmail("della-dest"),
  });
  assert.equal(message.status, "SENT");

  const timelineAfterSent = await getRelationshipTimeline(A.brokerageId, partyId);
  const sentEventsForMessage = timelineAfterSent.filter((e) => e.sourceType === "communication" && e.sourceId === message.id);
  assert.equal(sentEventsForMessage.length, 1);
  assert.equal(sentEventsForMessage[0]!.type, "EMAIL_SENT");

  const delivered = await applyMessageTransition({
    messageId: message.id,
    brokerageId: A.brokerageId,
    toStatus: "DELIVERED",
    expectedVersion: message.version,
    actorUserId: null,
    patch: { deliveredAt: new Date() },
    auditAction: "communication_message_delivered_test_only",
  });
  assert.equal(delivered.status, "DELIVERED");

  const timelineAfterDelivered = await getRelationshipTimeline(A.brokerageId, partyId);
  const eventsForMessage = timelineAfterDelivered.filter((e) => e.sourceType === "communication" && e.sourceId === message.id);
  assert.equal(eventsForMessage.length, 1, "a SENT-then-DELIVERED message must produce exactly one timeline entry, not two");
  assert.equal(eventsForMessage[0]!.type, "EMAIL_DELIVERED");
  assert.equal(eventsForMessage[0]!.id, `communication:${message.id}:EMAIL_DELIVERED`);
});

test("a failed email send appears as EMAIL_FAILED in the contact's timeline", async () => {
  const propertyId = await createProperty(A.agent.cookie, "4 Timeline Failed Way");
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Fiona", lastName: "Failed", email: uniqueEmail("fiona") });

  // "sandboxfail+invalid" is a non-retryable failure category
  // (INVALID_DESTINATION) in sandboxEmail.ts, so this reaches terminal
  // FAILED after exactly one dispatch attempt — no retry-loop needed here,
  // that path is already covered end-to-end by
  // routes/__tests__/communications.test.ts's own retry scenario.
  const { message } = await draftAndSend({
    brokerageId: A.brokerageId,
    senderUserId: A.agent.user.id,
    partyId,
    channel: "EMAIL",
    bodyText: "This send is designed to fail in the sandbox provider.",
    recipientDisplayName: "Fiona Failed",
    recipientDestination: "sandboxfail+invalid@example.com",
  });
  assert.equal(message.status, "FAILED");
  assert.equal(message.failureCategory, "INVALID_DESTINATION");

  const timeline = await getRelationshipTimeline(A.brokerageId, partyId);
  const event = timeline.find((e) => e.id === `communication:${message.id}:EMAIL_FAILED`);
  assert.ok(event, "EMAIL_FAILED event must appear on the contact's timeline");
  assert.equal(event!.type, "EMAIL_FAILED");
});

test("a failed SMS send appears as SMS_FAILED in the contact's timeline", async () => {
  const propertyId = await createProperty(A.agent.cookie, "5 Timeline SMS Failed Rd");
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Frank", lastName: "SmsFailed", mobile: "0400666777" });

  // "0000000" (7 zeros) is sandboxSms.ts's own non-retryable
  // INVALID_DESTINATION trigger — reaches terminal FAILED after one attempt.
  const { message } = await draftAndSend({
    brokerageId: A.brokerageId,
    senderUserId: A.agent.user.id,
    partyId,
    channel: "SMS",
    bodyText: "This send is designed to fail in the sandbox provider.",
    recipientDisplayName: "Frank SmsFailed",
    recipientDestination: "0400000000",
  });
  assert.equal(message.status, "FAILED");
  assert.equal(message.failureCategory, "INVALID_DESTINATION");

  const timeline = await getRelationshipTimeline(A.brokerageId, partyId);
  const event = timeline.find((e) => e.id === `communication:${message.id}:SMS_FAILED`);
  assert.ok(event, "SMS_FAILED event must appear on the contact's timeline");
  assert.equal(event!.type, "SMS_FAILED");
});

test("getRelationshipTimeline is tenant-isolated: a party belonging to another brokerage yields no events, even if the brokerageId argument alone were trusted", async () => {
  const bPropertyId = await createProperty(B.agent.cookie, "6 Cross Tenant Timeline Rd");
  const bPartyId = await createParty(B.agent.cookie, bPropertyId, { firstName: "Bea", lastName: "OtherBrokerage", email: uniqueEmail("bea") });

  const { message: bMessage } = await draftAndSend({
    brokerageId: B.brokerageId,
    senderUserId: B.agent.user.id,
    partyId: bPartyId,
    channel: "EMAIL",
    bodyText: "Should never appear in A's view of anything.",
    recipientDisplayName: "Bea OtherBrokerage",
    recipientDestination: uniqueEmail("bea-dest"),
  });
  assert.equal(bMessage.status, "SENT");

  // Cross-tenant call: A's brokerageId paired with B's partyId must yield nothing — the
  // function's own defence-in-depth check (party.brokerageId !== brokerageId) refuses to
  // produce events even though every source table was queried by partyId alone.
  const crossTenantTimeline = await getRelationshipTimeline(A.brokerageId, bPartyId);
  assert.deepEqual(crossTenantTimeline, []);

  // Sanity check: B's own timeline for its own party does show it — proving the empty result
  // above is real tenant isolation, not merely a broken query that returns nothing for anyone.
  const ownTimeline = await getRelationshipTimeline(B.brokerageId, bPartyId);
  assert.ok(ownTimeline.some((e) => e.id === `communication:${bMessage.id}:EMAIL_SENT`));
});
