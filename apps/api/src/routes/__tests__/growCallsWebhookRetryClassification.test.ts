// AE GROW Pilot Readiness WP6a (D10) — a permanently-unprocessable telephony
// webhook must not be answered 5xx.
//
// routes/growCallsWebhooks.ts previously answered EVERY failed result with
// 500, which tells a real provider "our fault, send it again". For an event
// that can never succeed — an unknown providerCallId, or a lifecycle
// transition that is invalid for the session's current state — the provider
// then retries on its full backoff schedule until it gives up, re-touching the
// receipt row every time, for a result that is identical each attempt.
//
// Signature/auth/ingress-disabled failures are deliberately unchanged, and a
// genuinely transient failure must still be a retryable 500.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { db, parties, growCallSessions, growCallWebhookEvents } from "@aee/db";
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
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
/** Provider event ids are globally unique, so every id carries a per-run suffix. */
const sentEventIds: string[] = [];
/** A call session already in a terminal state — nothing may transition out of it. */
let terminalProviderCallId: string;

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

  A = await createBrokerageWithUsers(baseUrl, `WP6a Webhook Retry ${suffix}`);

  // Built directly rather than through the calling UI flow: the classification
  // under test is about the state a session is IN, not about how it got there,
  // and a COMPLETED session is precisely the "already terminal, a late
  // redelivery can never apply" case a real provider produces.
  const [party] = await db
    .insert(parties)
    .values({ brokerageId: A.brokerageId, partyType: "Person", firstName: "Retry", lastName: "Fixture" })
    .returning();
  terminalProviderCallId = `sandbox-terminal-${suffix}`;
  await db.insert(growCallSessions).values({
    brokerageId: A.brokerageId,
    partyId: party!.id,
    initiatedByUserId: A.agent.user.id,
    destinationRaw: "0412000111",
    destinationNormalized: "+61412000111",
    destinationCountry: "AU",
    provider: "sandbox",
    providerCallId: terminalProviderCallId,
    status: "COMPLETED",
  });
});

after(async () => {
  if (sentEventIds.length > 0) {
    await db
      .delete(growCallWebhookEvents)
      .where(and(eq(growCallWebhookEvents.provider, "sandbox"), inArray(growCallWebhookEvents.providerEventId, sentEventIds)));
  }
  await cleanupBrokerages([A?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function signed(body: string, timestamp: string = String(Date.now())): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-grow-calls-timestamp": timestamp,
    "x-grow-calls-signature": createHmac("sha256", GROW_CALLS_WEBHOOK_SECRET).update(timestamp).update(".").update(body).digest("hex"),
  };
}

async function postEvent(label: string, eventType: string, providerCallId: string): Promise<{ res: Response; eventId: string }> {
  const eventId = `${label}-${suffix}`;
  sentEventIds.push(eventId);
  const body = JSON.stringify({ eventId, eventType, providerCallId });
  const res = await fetch(`${baseUrl}/api/grow/calls/webhooks/sandbox`, { method: "POST", headers: signed(body), body });
  return { res, eventId };
}

async function receiptFor(eventId: string) {
  const [row] = await db
    .select()
    .from(growCallWebhookEvents)
    .where(and(eq(growCallWebhookEvents.provider, "sandbox"), eq(growCallWebhookEvents.providerEventId, eventId)));
  return row;
}

// ---------------------------------------------------------------------
// Permanent rejections: non-retryable status, receipt still recorded FAILED.
// ---------------------------------------------------------------------

test("an unknown providerCallId is answered non-retryably, with the receipt recorded FAILED", async () => {
  const { res, eventId } = await postEvent("evt-unknown-call", "call.connected", `sandbox-does-not-exist-${suffix}`);

  assert.equal(res.status, 422, "a provider must be told to stop retrying an event that can never be applied");
  assert.ok(res.status < 500, "a permanent rejection must never look like a server fault");
  const body = (await res.json()) as { status: string; retryable?: boolean; detail?: string };
  assert.equal(body.status, "FAILED");
  assert.equal(body.retryable, false, "the response says explicitly that this must not be redelivered");

  const receipt = await receiptFor(eventId);
  assert.ok(receipt, "the receipt must still exist — a non-retryable answer is not a silent drop");
  assert.equal(receipt!.processingStatus, "FAILED");
  assert.ok(receipt!.processedAt, "a terminally-rejected receipt is processed, not left pending");
  assert.match(receipt!.processingError ?? "", /No matching call session/);
});

test("a transition that is invalid for the session's current state is answered non-retryably", async () => {
  // The session is already COMPLETED; a late "call.ringing" redelivery can
  // never apply to it, no matter how many times the provider sends it.
  const { res, eventId } = await postEvent("evt-stale-transition", "call.ringing", terminalProviderCallId);

  assert.equal(res.status, 422, `expected a non-retryable status, got ${res.status}`);
  const body = (await res.json()) as { status: string; retryable?: boolean };
  assert.equal(body.status, "FAILED");
  assert.equal(body.retryable, false);

  const receipt = await receiptFor(eventId);
  assert.ok(receipt);
  assert.equal(receipt!.processingStatus, "FAILED");
  assert.ok((receipt!.processingError ?? "").length > 0, "the permanent reason is recorded for an operator to read");

  // The session itself is untouched — a rejected event never half-applies.
  const [session] = await db
    .select()
    .from(growCallSessions)
    .where(and(eq(growCallSessions.provider, "sandbox"), eq(growCallSessions.providerCallId, terminalProviderCallId)));
  assert.equal(session!.status, "COMPLETED");
});

// ---------------------------------------------------------------------
// Transient failures must still be retryable.
// ---------------------------------------------------------------------

test("a transient database failure is still answered 500 so the provider retries", async () => {
  // Only the session lookup inside processInboundTelephonyWebhook is made to
  // fail: the receipt is written first (so the failure happens mid-processing,
  // exactly as a real database blip would), and the generic "please retry"
  // detail that produces is the single marker the route treats as retryable.
  const original = db.select;
  let calls = 0;
  (db as { select: typeof db.select }).select = ((...args: Parameters<typeof original>) => {
    calls += 1;
    if (calls === 2) throw new Error("simulated transient database failure");
    return (original as (...a: Parameters<typeof original>) => ReturnType<typeof original>).apply(db, args);
  }) as typeof db.select;

  let status: number;
  let body: { status?: string; retryable?: boolean };
  let eventId: string;
  try {
    const sent = await postEvent("evt-transient-db", "call.connected", terminalProviderCallId);
    status = sent.res.status;
    body = (await sent.res.json()) as { status?: string; retryable?: boolean };
    eventId = sent.eventId;
  } finally {
    (db as { select: typeof db.select }).select = original;
  }

  assert.equal(status, 500, "a transient failure must stay retryable — this is the case 5xx exists for");
  assert.equal(body.status, "FAILED");
  assert.notEqual(body.retryable, false, "a transient failure must never be marked non-retryable");

  // A retryable failure leaves a FAILED receipt too (it is retryable by
  // providerEventId, which the idempotency check re-reads on redelivery) — the
  // difference from the permanent cases above is the status code alone.
  const receipt = await receiptFor(eventId);
  assert.ok(receipt);
  assert.notEqual(receipt!.processingStatus, "PROCESSED");
});

// ---------------------------------------------------------------------
// Unchanged behaviour.
// ---------------------------------------------------------------------

test("signature, timestamp and ingress failures are unchanged", async () => {
  const body = JSON.stringify({ eventId: `evt-unsigned-${suffix}`, eventType: "call.ringing", providerCallId: terminalProviderCallId });

  const missing = await fetch(`${baseUrl}/api/grow/calls/webhooks/sandbox`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(missing.status, 401);

  const badSignature = await fetch(`${baseUrl}/api/grow/calls/webhooks/sandbox`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-grow-calls-timestamp": String(Date.now()), "x-grow-calls-signature": "0".repeat(64) },
    body,
  });
  assert.equal(badSignature.status, 401);

  const stale = await fetch(`${baseUrl}/api/grow/calls/webhooks/sandbox`, {
    method: "POST",
    headers: signed(body, String(Date.now() - 10 * 60 * 1000)),
    body,
  });
  assert.equal(stale.status, 401);

  // A malformed payload is still a 400, not the new non-retryable status —
  // those are different failures and keep different codes.
  const malformedBody = JSON.stringify({ eventId: `evt-malformed-${suffix}`, eventType: "call.exploded", providerCallId: "x" });
  const malformed = await fetch(`${baseUrl}/api/grow/calls/webhooks/sandbox`, {
    method: "POST",
    headers: signed(malformedBody),
    body: malformedBody,
  });
  assert.equal(malformed.status, 400);
});

test("the retryable/permanent classifier itself", async () => {
  const { isRetryableWebhookFailure, RETRYABLE_FAILURE_DETAIL, NON_RETRYABLE_STATUS } = await import("../growCallsWebhooks.js");

  // lib/telephony/webhooks.ts replaces the message of any non-domain error
  // with this single generic string, so it is the one and only marker of a
  // transient failure. A result with no detail at all keeps the same
  // retryable treatment.
  assert.equal(isRetryableWebhookFailure(RETRYABLE_FAILURE_DETAIL), true);
  assert.equal(isRetryableWebhookFailure(undefined), true);

  // Every other detail is a typed, permanent domain rejection. Transition
  // messages vary with the states involved, which is exactly why the
  // classifier cannot be written as a list of permanent reasons.
  assert.equal(isRetryableWebhookFailure("No matching call session for this providerCallId."), false);
  assert.equal(isRetryableWebhookFailure("Cannot apply RINGING to a call session in status COMPLETED."), false);
  assert.equal(isRetryableWebhookFailure("Invalid transition."), false);

  assert.ok(NON_RETRYABLE_STATUS >= 200 && NON_RETRYABLE_STATUS < 500, "a permanent rejection is never a 5xx");
});
