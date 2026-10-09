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
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, lte, or } from "drizzle-orm";
import { db, communicationMessages, communicationThreads, entitlementGrants } from "@aee/db";
import { DISPATCH_DUE_MESSAGES_LIMIT, dispatchDueMessages, resolveDispatchDueMessageLimit } from "../../lib/communications/outbox.js";
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
  assert.equal(final.failureDetail, "Can't send: no recorded consent for this email/mobile.");
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
// BLOCKED_BY_CONSENT in both cases.
//
// The transition table gained the RETRY_SCHEDULED -> BLOCKED_BY_CONSENT edge
// so this path settles the same way the QUEUED path does. Without it the
// message was still fail-closed — the provider was never called — but it
// never settled: applyMessageTransition refused the move, and the 60s sweep
// logged communications_dispatch_due_failed on every pass, forever.
//
// Settling as BLOCKED_BY_CONSENT (rather than auto-resuming when consent
// returns) is deliberate and matches the rest of the model: BLOCKED_BY_CONSENT
// is documented as re-attemptable via an explicit requeue into QUEUED, not as
// a state the dispatch sweep silently escapes. The QUEUED path already behaves
// exactly this way, so the two paths are now consistent.
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
  assert.equal(final.status, "BLOCKED_BY_CONSENT", "the retry must settle as blocked rather than re-failing on every sweep forever");
  assert.equal(final.sentAt, null);
  assert.equal(final.provider, null, "no provider ever accepted this message");
  assert.equal(final.retryCount, 1, "the retry was abandoned on consent grounds, not consumed as another failed attempt");

  // Belt and braces: prove the block is the consent gate and not, say, an
  // exhausted retry budget. A blocked message is deliberately NOT auto-resumed
  // by the sweep — it takes an explicit requeue, exactly as the QUEUED path
  // does — so restore consent, requeue, and confirm it then goes out.
  const restore = await fetch(`${baseUrl}/api/communications/consent`, {
    method: "POST",
    headers: headers(agent.cookie),
    body: JSON.stringify({ channel: "EMAIL", destination, transactionalOptOut: false }),
  });
  assert.equal(restore.status, 201, await restore.clone().text());

  await withProviderSpy(async (sentTo) => {
    await dispatchDueMessages(new Date(sweepAt.getTime() + 2 * MINUTE_MS));
    assert.equal(sentTo.includes(destination), false, "a blocked message is not silently resumed by the sweep just because consent came back");
  });

  const blocked = await readMessage(draft.id);
  const requeued = await fetch(`${baseUrl}/api/communications/messages/${draft.id}/requeue`, {
    method: "POST",
    headers: headers(agent.cookie),
    body: JSON.stringify({ expectedVersion: blocked.version }),
  });
  assert.equal(requeued.status, 200, await requeued.clone().text());

  await withProviderSpy(async (sentTo) => {
    await dispatchDueMessages(new Date(sweepAt.getTime() + 3 * MINUTE_MS));
    assert.equal(sentTo.includes(destination), true, "once consent is restored and the message is requeued it dispatches — the gate was the only thing blocking it");
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

// ---------------------------------------------------------------------
// I-17 — the due sweep is bounded. Excess due rows wait for a later tick.
//
// This lives in the same file as the A-3 sweep tests because
// dispatchDueMessages() selects across every brokerage. Node runs test
// files in parallel processes; this file's tests run sequentially, and
// it is the only suite that calls the sweep. A second file sweeping at
// the same time could dispatch the rows this test expects to still be
// waiting.
// ---------------------------------------------------------------------

test("I-17: the due-message cap is a positive bound and a caller cannot raise it", () => {
  assert.equal(DISPATCH_DUE_MESSAGES_LIMIT, 25);
  assert.ok(DISPATCH_DUE_MESSAGES_LIMIT >= 1);
  assert.equal(resolveDispatchDueMessageLimit(undefined), DISPATCH_DUE_MESSAGES_LIMIT);
  assert.equal(resolveDispatchDueMessageLimit(1), 1);
  assert.equal(resolveDispatchDueMessageLimit(DISPATCH_DUE_MESSAGES_LIMIT), DISPATCH_DUE_MESSAGES_LIMIT);
  assert.equal(resolveDispatchDueMessageLimit(DISPATCH_DUE_MESSAGES_LIMIT + 100), DISPATCH_DUE_MESSAGES_LIMIT);
  assert.throws(() => resolveDispatchDueMessageLimit(0), /positive integer/);
  assert.throws(() => resolveDispatchDueMessageLimit(-1), /positive integer/);
  assert.throws(() => resolveDispatchDueMessageLimit(1.5), /positive integer/);
});

test("I-17: one sweep dispatches only the oldest due rows; excess due rows stay queued until a later tick", async () => {
  assert.notEqual(process.env.LIVE_COMMUNICATIONS_APPROVED, "true", "this slice must not activate a live provider");

  const now = new Date();
  const [oldestDue] = await db
    .select({ scheduledAt: communicationMessages.scheduledAt })
    .from(communicationMessages)
    .where(
      and(
        or(eq(communicationMessages.status, "QUEUED"), eq(communicationMessages.status, "RETRY_SCHEDULED")),
        isNotNull(communicationMessages.scheduledAt),
        lte(communicationMessages.scheduledAt, now),
      ),
    )
    .orderBy(asc(communicationMessages.scheduledAt))
    .limit(1);
  // Sit strictly before any due row already in this database so the
  // bounded select's oldest-first order picks this fixture first.
  const baseMs = (oldestDue?.scheduledAt ? oldestDue.scheduledAt.getTime() : now.getTime()) - 60_000;
  const tieAt = new Date(baseMs);

  const [thread] = await db
    .insert(communicationThreads)
    .values({ brokerageId, propertyId, subject: `I-17 due bound ${suffix}`, createdByUserId: agent.user.id })
    .returning();

  const inserted = await db
    .insert(communicationMessages)
    .values([
      dueRow(thread.id, "tie-low", tieAt, "QUEUED"),
      dueRow(thread.id, "tie-high", tieAt, "QUEUED"),
      dueRow(thread.id, "retry", new Date(baseMs + 1_000), "RETRY_SCHEDULED"),
      dueRow(thread.id, "later", new Date(baseMs + 2_000), "QUEUED"),
      dueRow(thread.id, "future", new Date(now.getTime() + 24 * 60 * 60_000), "QUEUED"),
      dueRow(thread.id, "unscheduled", null, "QUEUED"),
    ])
    .returning();

  const byLabel = new Map(inserted.map((row) => [row.recipientDestination!.split("@")[0].split("+").pop()!, row]));
  const tieLow = byLabel.get("tie-low")!;
  const tieHigh = byLabel.get("tie-high")!;
  const retry = byLabel.get("retry")!;
  const later = byLabel.get("later")!;
  const future = byLabel.get("future")!;
  const unscheduled = byLabel.get("unscheduled")!;
  assert.ok(tieLow.id < tieHigh.id, "insert order must give the first tied row the lower id");

  const first = await dispatchDueMessages(now, 1);
  assert.equal(first.selectedCount, 1);
  assert.ok(first.selectedCount <= DISPATCH_DUE_MESSAGES_LIMIT);
  assert.equal(first.dispatchedCount + first.blockedCount + first.errorCount, first.selectedCount);
  assert.equal(first.dispatchedCount, 1);
  assert.equal(first.blockedCount, 0);
  assert.equal(first.errorCount, 0);

  const afterFirst = await readOurs([tieLow.id, tieHigh.id, retry.id, later.id, future.id, unscheduled.id]);
  assert.equal(afterFirst.get(tieLow.id)!.status, "SENT", "the oldest due row (lowest id on a scheduledAt tie) is the one row this tick takes");
  assert.equal(afterFirst.get(tieLow.id)!.provider, "sandbox_email", "D-3 still resolves the sandbox adapter; this sweep does not activate a live provider");
  assert.equal(afterFirst.get(tieHigh.id)!.status, "QUEUED");
  assert.equal(afterFirst.get(tieHigh.id)!.version, tieHigh.version, "a due row past the limit is not touched");
  assert.equal(afterFirst.get(retry.id)!.status, "RETRY_SCHEDULED");
  assert.equal(afterFirst.get(retry.id)!.version, retry.version);
  assert.equal(afterFirst.get(later.id)!.status, "QUEUED");
  assert.equal(afterFirst.get(later.id)!.version, later.version);
  assert.equal(afterFirst.get(future.id)!.status, "QUEUED", "a QUEUED row whose scheduledAt is still in the future is not due");
  assert.equal(afterFirst.get(unscheduled.id)!.status, "QUEUED", "a QUEUED row with no scheduledAt is not due");

  const second = await dispatchDueMessages(new Date(), 2);
  assert.equal(second.selectedCount, 2);
  assert.equal(second.dispatchedCount, 2);
  assert.equal(second.blockedCount, 0);
  assert.equal(second.errorCount, 0);

  const afterSecond = await readOurs([tieHigh.id, retry.id, later.id, future.id, unscheduled.id]);
  assert.equal(afterSecond.get(tieHigh.id)!.status, "SENT", "the row that waited on the first tick is taken on the next tick, ahead of newer due rows");
  assert.equal(afterSecond.get(tieHigh.id)!.provider, "sandbox_email");
  assert.equal(afterSecond.get(retry.id)!.status, "SENT", "RETRY_SCHEDULED shares the same bounded select and still dispatches through dispatchMessage");
  assert.equal(afterSecond.get(retry.id)!.provider, "sandbox_email");
  assert.equal(afterSecond.get(later.id)!.status, "QUEUED");
  assert.equal(afterSecond.get(later.id)!.version, later.version, "a due row past this tick's limit waits again");
  assert.equal(afterSecond.get(future.id)!.status, "QUEUED");
  assert.equal(afterSecond.get(unscheduled.id)!.status, "QUEUED");

  const third = await dispatchDueMessages(new Date(), 1);
  assert.equal(third.selectedCount, 1);
  assert.equal(third.dispatchedCount, 1);

  const afterThird = await readOurs([later.id, future.id, unscheduled.id]);
  assert.equal(afterThird.get(later.id)!.status, "SENT", "the row held back by the earlier ticks is dispatched once it is the oldest due row");
  assert.equal(afterThird.get(later.id)!.provider, "sandbox_email");
  assert.equal(afterThird.get(future.id)!.status, "QUEUED");
  assert.equal(afterThird.get(future.id)!.version, future.version);
  assert.equal(afterThird.get(unscheduled.id)!.status, "QUEUED");
  assert.equal(afterThird.get(unscheduled.id)!.version, unscheduled.version);
});

function dueRow(threadId: number, label: string, scheduledAt: Date | null, status: "QUEUED" | "RETRY_SCHEDULED") {
  return {
    threadId,
    brokerageId,
    propertyId,
    direction: "OUTBOUND",
    channel: "EMAIL",
    classification: "TRANSACTIONAL",
    status,
    bodyText: `I-17 due-bound fixture ${label}.`,
    senderUserId: agent.user.id,
    createdByUserId: agent.user.id,
    recipientDestination: `i17-${suffix}+${label}@example.com`,
    idempotencyKey: `i17-${suffix}-${label}-${randomUUID()}`,
    scheduledAt,
  };
}

async function readOurs(ids: number[]) {
  const rows = await db.select().from(communicationMessages).where(inArray(communicationMessages.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}
