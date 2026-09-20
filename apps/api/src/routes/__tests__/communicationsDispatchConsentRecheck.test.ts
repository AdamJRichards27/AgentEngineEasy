// AE GROW Completion Program W1-A (A-3, P0) — the dispatch path bypassed
// the consent gate.
//
// Before this slice, `grep -n "checkConsent" lib/communications/outbox.ts`
// returned exactly one hit, inside evaluateAndDispatchQueuedMessage — i.e.
// consent was enforced at ENQUEUE time only. The boot-time sweep
// dispatchDueMessages() (wired at lib/communications/bootstrap.ts, every
// 60s) calls dispatchMessage() directly for:
//
//   * every QUEUED message whose scheduledAt was pushed into the future by
//     the quiet-hours deferral, and
//   * every RETRY_SCHEDULED message whose backoff has elapsed.
//
// On both paths arbitrary time passes between the enqueue-time consent
// decision and the actual provider call, so a recipient who withdrew
// consent in that interval (a STOP reply, or staff revoking opt-in) was
// still sent to. dispatchMessage() now re-runs the consent check itself.
//
// Both tests assert two things, not one: the message ends BLOCKED_BY_CONSENT
// AND the sandbox provider was never called for that destination. The second
// assertion is the one that actually proves nothing left the building — a
// correct status with a provider call already made would be a fabricated
// block.
//
// The sweep is system-wide (it selects across every brokerage), so the
// provider assertions are scoped to this suite's own destinations rather
// than to "no calls at all" — another suite's fixtures sharing the database
// must not be able to turn this into a false pass or a false failure.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, communicationMessages, entitlementGrants } from "@aee/db";
import { dispatchDueMessages } from "../../lib/communications/outbox.js";
import { sandboxEmailProvider } from "../../lib/communications/providers/sandboxEmail.js";
import type { ProviderSendResult, SendEmailInput } from "../../lib/communications/providers/types.js";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let admin: DevLoginResult;
let agent: DevLoginResult;
let brokerageId: number;
let propertyId: number;

const MINUTE_MS = 60_000;

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const created = await createBrokerageWithUsers(baseUrl, `W1A Dispatch Consent ${suffix}`);
  admin = created.admin;
  agent = created.agent;
  brokerageId = created.brokerageId;

  const listed = await createListedProperty(baseUrl, agent.cookie, { address: `1 Dispatch Recheck St ${suffix}` });
  propertyId = listed.propertyId;

  // A-2: recording (and withdrawing) consent over HTTP now needs the Grow
  // contact-management key. This suite is about A-3, so it simply holds it.
  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey: "grow.contacts.manage",
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerageId);
});

after(async () => {
  await cleanupBrokerages([brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function headers(cookie: string) {
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

async function patchSettings(body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/api/communications/settings`, {
    method: "PATCH",
    headers: headers(admin.cookie),
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, await res.clone().text());
}

async function createThread(subject: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties/${propertyId}/communications/threads`, {
    method: "POST",
    headers: headers(agent.cookie),
    body: JSON.stringify({ subject }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await jsonOf<{ id: number }>(res)).id;
}

async function addParticipant(threadId: number, displayName: string, email: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/communications/threads/${threadId}/participants/manual`, {
    method: "POST",
    headers: headers(agent.cookie),
    body: JSON.stringify({ displayName, role: "Other", email, reason: "W1-A dispatch consent re-check fixture" }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await jsonOf<{ id: number }>(res)).id;
}

async function createDraft(threadId: number, recipientParticipantId: number) {
  const res = await fetch(`${baseUrl}/api/communications/threads/${threadId}/messages`, {
    method: "POST",
    headers: headers(agent.cookie),
    body: JSON.stringify({
      channel: "EMAIL",
      classification: "TRANSACTIONAL",
      bodyText: "W1-A dispatch-time consent re-check.",
      recipientParticipantId,
    }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  return jsonOf<{ id: number; version: number; status: string }>(res);
}

async function send(messageId: number, expectedVersion: number) {
  const res = await fetch(`${baseUrl}/api/communications/messages/${messageId}/send`, {
    method: "POST",
    headers: headers(agent.cookie),
    body: JSON.stringify({ expectedVersion }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return jsonOf<{ blocked: boolean; dispatched: boolean; message: { id: number; status: string; version: number; scheduledAt: string | null } }>(res);
}

/** The withdrawal — a transactional opt-out the brokerage's settings honour. */
async function withdrawConsent(destination: string) {
  const res = await fetch(`${baseUrl}/api/communications/consent`, {
    method: "POST",
    headers: headers(agent.cookie),
    body: JSON.stringify({ channel: "EMAIL", destination, transactionalOptOut: true }),
  });
  assert.equal(res.status, 201, await res.clone().text());
}

async function readMessage(messageId: number) {
  const [row] = await db.select().from(communicationMessages).where(and(eq(communicationMessages.id, messageId), eq(communicationMessages.brokerageId, brokerageId)));
  assert.ok(row, `message ${messageId} not found`);
  return row!;
}

/**
 * Replaces sandboxEmailProvider.send for the duration of `run`, recording
 * every destination it is asked to send to. outbox.ts calls
 * `sandboxEmailProvider.send(...)` as a method on the imported singleton, so
 * swapping the property intercepts the real call site — and, unlike a spy
 * that delegates, a recorded call here means a message genuinely would have
 * gone out.
 */
async function withProviderSpy<T>(run: (sentTo: string[]) => Promise<T>): Promise<T> {
  const sentTo: string[] = [];
  const original = sandboxEmailProvider.send;
  sandboxEmailProvider.send = async (input: SendEmailInput): Promise<ProviderSendResult> => {
    sentTo.push(input.to.toLowerCase());
    return original.call(sandboxEmailProvider, input);
  };
  try {
    return await run(sentTo);
  } finally {
    sandboxEmailProvider.send = original;
  }
}

// ---------------------------------------------------------------------
// Path 1 — QUEUED, deferred past quiet hours.
// ---------------------------------------------------------------------

test("A-3: a message deferred past quiet hours is BLOCKED_BY_CONSENT when the sweep runs after consent was withdrawn — and the provider is never called", async () => {
  // A quiet-hours window that definitely contains "now", expressed in UTC so
  // the assertion does not depend on where this test runs. The window is
  // closed 30 minutes from now, which is where queueMessage will push
  // scheduledAt to.
  const now = new Date();
  const windowStart = new Date(now.getTime() - MINUTE_MS);
  const windowEnd = new Date(now.getTime() + 30 * MINUTE_MS);
  const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  await patchSettings({
    timeZone: "UTC",
    quietHoursStart: hhmm(windowStart),
    quietHoursEnd: hhmm(windowEnd),
    // Section 16's policy knob: this brokerage honours transactional
    // opt-outs. Without it, a transactional opt-out is recorded but does not
    // block — which is exactly the configurability the gate is built around.
    transactionalOptOutAllowed: true,
  });

  const destination = `a3-quiet-hours-${suffix}@example.com`;
  const threadId = await createThread("W1-A quiet hours deferral");
  const participantId = await addParticipant(threadId, "Quiet Hours Recipient", destination);
  const draft = await createDraft(threadId, participantId);

  // Enqueue: consent is fine right now, so the message passes the step-5
  // gate and is deferred by quiet hours rather than blocked.
  const queued = await send(draft.id, draft.version);
  assert.equal(queued.blocked, false);
  assert.equal(queued.dispatched, false, "quiet hours must defer this send, not perform it");
  assert.equal(queued.message.status, "QUEUED");
  const scheduledAt = new Date(queued.message.scheduledAt!);
  assert.ok(scheduledAt > now, "the deferral must push scheduledAt into the future");

  // The interval during which the recipient changes their mind.
  await withdrawConsent(destination);

  // The sweep, run as if the quiet window has now closed.
  const sweepAt = new Date(scheduledAt.getTime() + MINUTE_MS);
  const result = await withProviderSpy(async (sentTo) => {
    const sweep = await dispatchDueMessages(sweepAt);
    assert.equal(
      sentTo.includes(destination),
      false,
      "the provider must never be called for a destination whose consent was withdrawn while the message sat deferred",
    );
    return sweep;
  });
  assert.ok(result.blockedCount >= 1, "the sweep must report the consent block as a block, not as a dispatch");

  const final = await readMessage(draft.id);
  assert.equal(final.status, "BLOCKED_BY_CONSENT");
  assert.equal(final.failureCategory, "CONSENT_BLOCKED", "reuses the existing failure taxonomy, not a new one");
  assert.match(final.failureDetail ?? "", /opted out/i);
  assert.equal(final.sentAt, null, "a blocked message was never sent");
  assert.equal(final.provider, null);

  // Clear quiet hours again for the next test.
  await patchSettings({ quietHoursStart: null, quietHoursEnd: null });
});

// ---------------------------------------------------------------------
// Path 2 — RETRY_SCHEDULED, waiting out a backoff.
// ---------------------------------------------------------------------

// NOTE on the terminal status for this path. The consent re-check in
// dispatchMessage() is status-agnostic: it runs before the SENDING
// transition for QUEUED and RETRY_SCHEDULED alike and asks for
// BLOCKED_BY_CONSENT in both cases. For a QUEUED message that lands (the
// test above asserts it). For a RETRY_SCHEDULED message the transition
// table currently has no RETRY_SCHEDULED -> BLOCKED_BY_CONSENT edge
// (lib/communications/types.ts: RETRY_SCHEDULED: ["SENDING", "FAILED",
// "CANCELLED"]), so applyMessageTransition refuses it and
// dispatchDueMessages' own try/catch logs communications_dispatch_due_failed
// and moves on — the message stays RETRY_SCHEDULED.
//
// That is fail-closed, which is the security property that matters here and
// is what this test pins: the provider is never called and the message never
// becomes SENT, on every sweep, for as long as consent stays withdrawn.
// Adding the missing edge is a one-line additive change to types.ts, which
// is outside this slice's file ownership (AE GROW W1-A) and is reported as
// the single outstanding item. The assertions below are deliberately
// written to hold both before and after that edge lands, so this test does
// not pin the current defective status and does not need revisiting.
test("A-3: a RETRY_SCHEDULED message whose consent was withdrawn during its backoff is never handed to the provider and never becomes SENT", async () => {
  await patchSettings({ timeZone: "UTC", quietHoursStart: null, quietHoursEnd: null, transactionalOptOutAllowed: true });

  // sandboxfail+timeout is the sandbox adapter's deterministic retryable
  // failure (PROVIDER_TIMEOUT), so the first attempt genuinely fails and the
  // message lands in RETRY_SCHEDULED with a real backoff.
  const destination = `a3-retry-sandboxfail+timeout-${suffix}@example.com`;
  const threadId = await createThread("W1-A retry backoff");
  const participantId = await addParticipant(threadId, "Retry Recipient", destination);
  const draft = await createDraft(threadId, participantId);

  const attempted = await send(draft.id, draft.version);
  assert.equal(attempted.message.status, "RETRY_SCHEDULED", "the first attempt must fail retryably and schedule a retry");
  const retryAt = new Date((await readMessage(draft.id)).scheduledAt!);

  await withdrawConsent(destination);

  // Two consecutive sweeps, because the scheduler runs every 60s forever:
  // the guarantee has to hold on every pass, not just the first.
  const sweepAt = new Date(retryAt.getTime() + MINUTE_MS);
  await withProviderSpy(async (sentTo) => {
    await dispatchDueMessages(sweepAt);
    await dispatchDueMessages(new Date(sweepAt.getTime() + MINUTE_MS));
    assert.equal(
      sentTo.includes(destination),
      false,
      "a retry must not reach the provider once consent has been withdrawn during the backoff",
    );
  });

  const final = await readMessage(draft.id);
  assert.notEqual(final.status, "SENT", "a message whose consent was withdrawn must never reach SENT on the retry path");
  assert.equal(final.sentAt, null);
  assert.equal(final.provider, null, "no provider ever accepted this message");
  assert.equal(final.retryCount, 1, "the retry was abandoned on consent grounds, not consumed as another failed attempt");

  // Belt and braces: prove the block is the consent gate and not, say, an
  // exhausted retry budget — restoring consent lets the very next sweep
  // deliver the message, so nothing else is holding it back.
  const restore = await fetch(`${baseUrl}/api/communications/consent`, {
    method: "POST",
    headers: headers(agent.cookie),
    body: JSON.stringify({ channel: "EMAIL", destination, transactionalOptOut: false }),
  });
  assert.equal(restore.status, 201, await restore.clone().text());
  await withProviderSpy(async (sentTo) => {
    await dispatchDueMessages(new Date(sweepAt.getTime() + 2 * MINUTE_MS));
    assert.equal(sentTo.includes(destination), true, "with consent restored the retry is attempted again — the gate was the only thing blocking it");
  });
});

// ---------------------------------------------------------------------
// Regression — the re-check must not block anything it should not.
// ---------------------------------------------------------------------

test("A-3 regression: a deferred message whose consent is still intact dispatches normally when the sweep runs", async () => {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 5 * MINUTE_MS);
  const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  await patchSettings({
    timeZone: "UTC",
    quietHoursStart: hhmm(new Date(now.getTime() - MINUTE_MS)),
    quietHoursEnd: hhmm(windowEnd),
    transactionalOptOutAllowed: true,
  });

  const destination = `a3-still-allowed-${suffix}@example.com`;
  const threadId = await createThread("W1-A deferral, consent intact");
  const participantId = await addParticipant(threadId, "Still Allowed Recipient", destination);
  const draft = await createDraft(threadId, participantId);

  const queued = await send(draft.id, draft.version);
  assert.equal(queued.message.status, "QUEUED");
  const scheduledAt = new Date(queued.message.scheduledAt!);

  const sweepAt = new Date(scheduledAt.getTime() + MINUTE_MS);
  await withProviderSpy(async (sentTo) => {
    await dispatchDueMessages(sweepAt);
    assert.equal(sentTo.includes(destination), true, "an unchanged consent decision must still let the deferred send through");
  });

  const final = await readMessage(draft.id);
  assert.equal(final.status, "SENT");
  assert.equal(final.provider, "sandbox_email");

  await patchSettings({ quietHoursStart: null, quietHoursEnd: null });
});
