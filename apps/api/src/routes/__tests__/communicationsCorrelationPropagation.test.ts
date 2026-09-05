// Agent Engine 2.0 — Step 2: Security & Observability Hardening.
//
// Named proof flow: "Mock Communications delivery" — one correlationId
// tying the drafting request to the eventual send, PROVABLY including the
// case where dispatch happens later, outside any HTTP request at all (the
// boot-time scheduler's dispatchDueMessages() sweep — see
// lib/communications/bootstrap.ts).
//
// This is the specific gap Step 2 hardening found and fixed: outbox.ts's
// publishCommunicationEvent has always read `message.correlationId ??
// currentCorrelationId()`, but nothing ever WROTE communicationMessages
// .correlationId at draft time, so that read always fell through to
// currentCorrelationId() — fine when dispatch happens inline inside the
// same request that queued the message (the common case, and what
// communications.test.ts's scenario 1 exercises), silently wrong the
// moment dispatch is deferred to the scheduler, which runs on a plain
// setInterval with no ambient correlation context at all: every scheduled
// send would have started its own brand-new, disconnected id instead of
// continuing the drafting request's chain.
//
// The fix (lib/communications/messages.ts's createDraftMessage) persists
// the drafting request's correlationId on the message row itself. This
// test proves it: draft a message over real HTTP (capturing the request's
// own id from the X-Correlation-Id response header — see
// middlewares/requestId.ts), manually put it into the same QUEUED state
// dispatchDueMessages() would find it in, then call dispatchMessage()
// directly — exactly as dispatchDueMessages() does, with no
// runWithCorrelationId wrapper of any kind — and confirm the resulting
// COMMUNICATION_MESSAGE_SENT domain event still carries the ORIGINAL
// drafting request's correlationId, not a freshly minted one.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, and, desc } from "drizzle-orm";
import { db, communicationMessages, domainEvents } from "@aee/db";
import { dispatchMessage } from "../../lib/communications/outbox.js";
import { CORRELATION_ID_HEADER } from "../../middlewares/requestId.js";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
let agent: DevLoginResult;
let brokerageId: number;
let propertyId: number;

function authHeaders(cookie: string) {
  return { "content-type": "application/json", cookie };
}

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
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

  const created = await createBrokerageWithUsers(baseUrl, `Comms Correlation Propagation ${Date.now()}`);
  agent = created.agent;
  brokerageId = created.brokerageId;
  const listed = await createListedProperty(baseUrl, agent.cookie, { address: "1 Correlation Propagation St" });
  propertyId = listed.propertyId;
});

after(async () => {
  await cleanupBrokerages([brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("a message drafted under request correlationId A, then dispatched later with NO ambient context at all (simulating the scheduler), still publishes COMMUNICATION_MESSAGE_SENT under correlationId A", async () => {
  const threadRes = await fetch(`${baseUrl}/api/properties/${propertyId}/communications/threads`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ subject: "Async dispatch correlation proof" }),
  });
  assert.equal(threadRes.status, 201);
  const thread = await jsonOf<{ id: number }>(threadRes);

  const participantRes = await fetch(`${baseUrl}/api/communications/threads/${thread.id}/participants/manual`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ displayName: "Async Proof Recipient", role: "Seller", email: `async-proof-${Date.now()}@example.com`, reason: "Vendor contact for this property" }),
  });
  assert.equal(participantRes.status, 201);
  const participant = await jsonOf<{ id: number }>(participantRes);

  // Capture the DRAFTING request's own correlationId directly from the
  // response header requestId.ts sets on every response — this is the
  // "known good" value the eventual dispatch must still carry, with no
  // need to guess or re-derive it.
  const draftRes = await fetch(`${baseUrl}/api/communications/threads/${thread.id}/messages`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({
      channel: "EMAIL",
      classification: "TRANSACTIONAL",
      bodyText: "Async dispatch correlation propagation proof.",
      recipientParticipantId: participant.id,
    }),
  });
  assert.equal(draftRes.status, 201);
  const draftingRequestCorrelationId = draftRes.headers.get(CORRELATION_ID_HEADER);
  assert.ok(draftingRequestCorrelationId, "the drafting request must echo an X-Correlation-Id response header");
  const draft = await jsonOf<{ id: number; version: number; status: string }>(draftRes);
  assert.equal(draft.status, "DRAFT");

  // Confirm the fix actually persisted it on the row (not just that the
  // HTTP response happened to carry one) — this is the specific write
  // Step 2 hardening added to createDraftMessage.
  const [persisted] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, draft.id));
  assert.equal(persisted.correlationId, draftingRequestCorrelationId, "communicationMessages.correlationId must be set at draft time, not left null");

  // Move the message to QUEUED exactly as queueMessage() would leave a
  // deferred send (past quiet hours) or a RETRY_SCHEDULED backoff sitting
  // — this is the state dispatchDueMessages() finds and hands to
  // dispatchMessage() from its own setInterval tick, with no HTTP request
  // and therefore no ambient correlation context whatsoever.
  await db
    .update(communicationMessages)
    .set({ status: "QUEUED", version: persisted.version + 1, idempotencyKey: `async-proof-${draft.id}` })
    .where(eq(communicationMessages.id, draft.id));

  // The critical assertion setup: call dispatchMessage() directly, at the
  // top level of this async test function — NOT inside any
  // runWithCorrelationId() wrapper, exactly matching how
  // dispatchDueMessages()'s scheduler sweep calls it in production. If the
  // correlationId propagation gap this test targets were still open, the
  // resulting domain event below would carry a freshly-minted, unrelated
  // id instead of draftingRequestCorrelationId.
  const dispatched = await dispatchMessage(draft.id, brokerageId);
  assert.equal(dispatched.status, "SENT", "the sandbox email provider should accept this send deterministically");

  const [sentEvent] = await db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.eventType, "COMMUNICATION_MESSAGE_SENT"), eq(domainEvents.brokerageId, brokerageId)))
    .orderBy(desc(domainEvents.occurredAt))
    .limit(1);

  assert.ok(sentEvent, "COMMUNICATION_MESSAGE_SENT should have been published");
  assert.equal(
    sentEvent.correlationId,
    draftingRequestCorrelationId,
    "the SENT event published from a context-free scheduler-style dispatch must still carry the original drafting request's correlationId, proving propagation survives deferred/async dispatch",
  );
});
