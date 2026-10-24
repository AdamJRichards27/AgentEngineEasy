// Outbound-message recovery (specs/outbound-message-recovery.md): the comms
// stale-SENDING sweep, the operator MANUAL_REVIEW routes, the in-flight /
// review gauges, and the recovery policy itself. Synthetic data only.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  auditLogs,
  communicationMessages,
  communicationThreads,
  entitlementGrants,
  integrationDeadLetters,
  integrationOutbox,
} from "@aee/db";
import { resetMetricsForTesting, renderMetricsText } from "@aee/events";
import { dispatchDueMessages, recoverStaleSendingMessages, STALE_SENDING_THRESHOLD_MS } from "../../lib/communications/outbox.js";
import { sandboxEmailProvider } from "../../lib/communications/providers/sandboxEmail.js";
import { sandboxSmsProvider } from "../../lib/communications/providers/sandboxSms.js";
import { mockSmsAdapter } from "../../lib/integrations/adapters/mockSms.js";
import { mockPaymentStatusAdapter } from "../../lib/integrations/adapters/mockPaymentStatus.js";
import { manualReviewTestHooks } from "../../lib/outboxRecovery/operatorActions.js";
import { decideRecovery, capabilityOf, NO_RECOVERY_CAPABILITY } from "../../lib/outboxRecovery/policy.js";
import { sampleQueueGauges } from "../../lib/observability/queueGauges.js";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { bootstrapIntegrationsForTesting, createActiveMockPortalConnection } from "../../lib/integrations/__tests__/testHelpers.js";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

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
let propertyId: number;
let connectionId: string;
// The sweep is system-wide: fixtures use a 1990 updatedAt so they are the oldest SENDING rows anywhere, and every
// assertion is scoped to this file's own ids.
const LONG_AGO = new Date("1990-01-01T00:00:00.000Z");

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  await bootstrapIntegrationsForTesting();
  A = await createBrokerageWithUsers(baseUrl, `Outbound Recovery A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Outbound Recovery B ${suffix}`);
  propertyId = (await createListedProperty(baseUrl, A.agent.cookie, { address: `1 Recovery St ${suffix}` })).propertyId;
  connectionId = (await createActiveMockPortalConnection(A.brokerageId, { id: A.admin.user.id, role: A.admin.user.role })).connection.id;
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number"));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function insertMessage(status: string, updatedAt: Date, label: string) {
  const [thread] = await db.insert(communicationThreads).values({ brokerageId: A.brokerageId, propertyId, subject: `recovery ${label}`, createdByUserId: A.agent.user.id }).returning();
  const [message] = await db
    .insert(communicationMessages)
    .values({
      threadId: thread.id,
      brokerageId: A.brokerageId,
      propertyId,
      direction: "OUTBOUND",
      channel: "EMAIL",
      classification: "TRANSACTIONAL",
      status,
      subject: "Synthetic",
      bodyText: "Synthetic recovery fixture.",
      recipientDestination: `recovery-${label}-${suffix}@example.test`,
      idempotencyKey: `recovery-${label}-${suffix}-${randomUUID()}`,
      scheduledAt: LONG_AGO,
      updatedAt,
    } as typeof communicationMessages.$inferInsert)
    .returning();
  return message;
}

async function insertOutbox(status: string, label: string, nextAttemptAt = LONG_AGO) {
  const [row] = await db
    .insert(integrationOutbox)
    .values({
      brokerageId: A.brokerageId,
      connectionId,
      capability: "portal.publishListing",
      commandPayload: { destination: `recovery-${label}` },
      status,
      nextAttemptAt,
      idempotencyKey: `recovery-${label}-${suffix}-${randomUUID()}`,
      correlationId: randomUUID(),
      sourceRecordType: "TEST_FIXTURE",
      sourceRecordId: `recovery-${label}`,
    })
    .returning();
  return row;
}

function countEmailSendsTo(destinationPart: string) {
  const original = sandboxEmailProvider.send;
  const seen = { calls: 0 };
  sandboxEmailProvider.send = async (input) => {
    if (input.to.includes(destinationPart)) seen.calls++;
    return original.call(sandboxEmailProvider, input);
  };
  return { seen, restore: () => (sandboxEmailProvider.send = original) };
}

function post(path: string, cookie: string, body: unknown) {
  return fetch(`${baseUrl}/api${path}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
}

// ---------------------------------------------------------------------
// Policy + adapter contract.
// ---------------------------------------------------------------------

test("[RECOVERY] policy: no capability declared is fail-closed (MANUAL_REVIEW); dedupe resends; lookup outcomes map as designed", async () => {
  assert.deepEqual(capabilityOf(undefined), NO_RECOVERY_CAPABILITY);
  assert.deepEqual(capabilityOf({}), NO_RECOVERY_CAPABILITY);
  assert.equal((await decideRecovery(NO_RECOVERY_CAPABILITY, "k")).action, "MANUAL_REVIEW");
  assert.equal((await decideRecovery({ dedupesOnIdempotencyKey: true }, "k")).action, "RESEND_SAME_KEY");
  assert.equal((await decideRecovery({ dedupesOnIdempotencyKey: true, lookupByIdempotencyKey: async () => "UNKNOWN" }, "k")).action, "MANUAL_REVIEW", "lookup takes precedence over dedupe");
  assert.equal((await decideRecovery({ dedupesOnIdempotencyKey: false, lookupByIdempotencyKey: async () => "DELIVERED" }, "k")).action, "MARK_SENT");
  assert.equal((await decideRecovery({ dedupesOnIdempotencyKey: false, lookupByIdempotencyKey: async () => "NOT_FOUND" }, "k")).action, "RESEND_SAME_KEY");
  assert.deepEqual(await decideRecovery({ dedupesOnIdempotencyKey: false, lookupByIdempotencyKey: async () => { throw new Error("timeout"); } }, "k"), { action: "MANUAL_REVIEW", reason: "LOOKUP_FAILED" });
});

test("[RECOVERY] adapter contract: every adapter's declared capability matches its behaviour", async () => {
  // mock_sms: same reference back but the message is accepted again -> must not claim dedupe.
  assert.deepEqual(mockSmsAdapter.recovery, { dedupesOnIdempotencyKey: false });
  assert.deepEqual(mockPaymentStatusAdapter.recovery, { dedupesOnIdempotencyKey: false });
  // sandbox email/SMS: a fresh random message id per send, even for the same key -> no dedupe.
  assert.deepEqual(sandboxEmailProvider.recovery, { dedupesOnIdempotencyKey: false });
  assert.deepEqual(sandboxSmsProvider.recovery, { dedupesOnIdempotencyKey: false });
  const key = `contract-${suffix}`;
  const e1 = await sandboxEmailProvider.send({ to: "contract@example.test", subject: null, bodyText: "x", bodyHtml: null, idempotencyKey: key });
  const e2 = await sandboxEmailProvider.send({ to: "contract@example.test", subject: null, bodyText: "x", bodyHtml: null, idempotencyKey: key });
  assert.notEqual(e1.providerMessageId, e2.providerMessageId, "a resend is a second email, so dedupe=false is the honest declaration");
  const s1 = await sandboxSmsProvider.send({ to: "+61400000000", bodyText: "x", idempotencyKey: key });
  const s2 = await sandboxSmsProvider.send({ to: "+61400000000", bodyText: "x", idempotencyKey: key });
  assert.notEqual(s1.providerMessageId, s2.providerMessageId);
});

// ---------------------------------------------------------------------
// Communications: stale SENDING -> MANUAL_REVIEW, never re-sent.
// ---------------------------------------------------------------------

test("[RECOVERY] comms: a SENDING message older than the threshold goes to MANUAL_REVIEW (audited, version bumped, 0 sends); a fresh one is untouched", async () => {
  const stale = await insertMessage("SENDING", LONG_AGO, "stale");
  const fresh = await insertMessage("SENDING", new Date(), "fresh");
  const counter = countEmailSendsTo(`-${suffix}@`);
  try {
    await recoverStaleSendingMessages(new Date(), STALE_SENDING_THRESHOLD_MS);
    await dispatchDueMessages(new Date());
  } finally {
    counter.restore();
  }
  assert.equal(counter.seen.calls, 0, "nothing is re-sent");
  const [s] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, stale.id));
  const [f] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, fresh.id));
  assert.equal(s.status, "MANUAL_REVIEW");
  assert.equal(s.version, stale.version + 1);
  assert.match(s.failureDetail ?? "", /outcome unknown/);
  assert.equal(f.status, "SENDING");
  const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.recordType, "communication_message"), eq(auditLogs.recordId, String(stale.id))));
  assert.deepEqual(audits.map((a) => [a.action, a.previousValue, a.updatedValue]), [["communication_message_manual_review", "SENDING", "MANUAL_REVIEW"]]);
  await db.update(communicationMessages).set({ status: "SENT" }).where(eq(communicationMessages.id, fresh.id));
});

test("[RECOVERY] comms: two concurrent recovery sweeps move a stale message exactly once (version guard)", async () => {
  const stale = await insertMessage("SENDING", LONG_AGO, "race");
  await Promise.all([recoverStaleSendingMessages(), recoverStaleSendingMessages()]);
  const [s] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, stale.id));
  assert.equal(s.status, "MANUAL_REVIEW");
  assert.equal(s.version, stale.version + 1, "exactly one transition landed");
  const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.recordType, "communication_message"), eq(auditLogs.recordId, String(stale.id))));
  assert.equal(audits.length, 1);
});

// ---------------------------------------------------------------------
// Operator routes.
// ---------------------------------------------------------------------

test("[RECOVERY] routes: only Brokerage Administrators can list or resolve; the list is brokerage-scoped", async () => {
  const review = await insertOutbox("MANUAL_REVIEW", "list");
  const agentList = await fetch(`${baseUrl}/api/integrations/outbound-recovery/manual-review`, { headers: { cookie: A.agent.cookie } });
  assert.equal(agentList.status, 403);
  const agentResolve = await post(`/integrations/outbound-recovery/integration_outbox/${review.id}/resolve`, A.agent.cookie, { resolution: "MARK_SENT", note: "x" });
  assert.equal(agentResolve.status, 403);
  const listA = (await (await fetch(`${baseUrl}/api/integrations/outbound-recovery/manual-review`, { headers: { cookie: A.admin.cookie } })).json()) as { items: Array<{ queue: string; id: string }> };
  assert.ok(listA.items.some((i) => i.queue === "integration_outbox" && i.id === review.id));
  const listB = (await (await fetch(`${baseUrl}/api/integrations/outbound-recovery/manual-review`, { headers: { cookie: B.admin.cookie } })).json()) as { items: unknown[] };
  assert.deepEqual(listB.items, []);
  await db.update(integrationOutbox).set({ status: "DEAD_LETTERED" }).where(eq(integrationOutbox.id, review.id));
});

test("[RECOVERY] routes: cross-tenant resolve is 404 and changes nothing; bad input is 400; unknown queue is 404", async () => {
  const review = await insertOutbox("MANUAL_REVIEW", "xtenant");
  const res = await post(`/integrations/outbound-recovery/integration_outbox/${review.id}/resolve`, B.admin.cookie, { resolution: "MARK_SENT", note: "x" });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "That item was not found.", code: "NOT_FOUND" });
  assert.equal((await db.select().from(integrationOutbox).where(eq(integrationOutbox.id, review.id)))[0].status, "MANUAL_REVIEW");
  const bad = await post(`/integrations/outbound-recovery/integration_outbox/${review.id}/resolve`, A.admin.cookie, { resolution: "DELETE", note: "x" });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { code: string }).code, "INVALID_INPUT");
  const unknownQueue = await post(`/integrations/outbound-recovery/not_a_queue/${review.id}/resolve`, A.admin.cookie, { resolution: "MARK_SENT", note: "x" });
  assert.equal(unknownQueue.status, 404);
  await db.update(integrationOutbox).set({ status: "DEAD_LETTERED" }).where(eq(integrationOutbox.id, review.id));
});

test("[RECOVERY] routes: integration MARK_FAILED dead-letters (replayable) with an audit row; a second resolve is 409 ALREADY_RESOLVED", async () => {
  const review = await insertOutbox("MANUAL_REVIEW", "markfailed");
  const res = await post(`/integrations/outbound-recovery/integration_outbox/${review.id}/resolve`, A.admin.cookie, { resolution: "MARK_FAILED", note: "synthetic: portal shows no listing" });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(((await res.json()) as { status: string }).status, "DEAD_LETTERED");
  const letters = await db.select().from(integrationDeadLetters).where(and(eq(integrationDeadLetters.sourceType, "OUTBOX"), eq(integrationDeadLetters.sourceId, review.id)));
  assert.equal(letters.length, 1);
  assert.equal(letters[0].brokerageId, A.brokerageId);
  const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.recordType, "integration_outbox"), eq(auditLogs.recordId, review.id)));
  assert.deepEqual(audits.map((a) => [a.action, a.userId, a.previousValue]), [["outbound_recovery_manual_mark_failed", A.admin.user.id, "MANUAL_REVIEW"]]);
  const again = await post(`/integrations/outbound-recovery/integration_outbox/${review.id}/resolve`, A.admin.cookie, { resolution: "MARK_SENT", note: "x" });
  assert.equal(again.status, 409);
  assert.equal(((await again.json()) as { code: string }).code, "ALREADY_RESOLVED");
});

test("[RECOVERY] routes: REQUEUE without acknowledging the duplicate risk is 400 and changes nothing; with it the row is due again", async () => {
  const review = await insertOutbox("MANUAL_REVIEW", "requeue");
  const noAck = await post(`/integrations/outbound-recovery/integration_outbox/${review.id}/resolve`, A.admin.cookie, { resolution: "REQUEUE", note: "synthetic" });
  assert.equal(noAck.status, 400);
  assert.equal(((await noAck.json()) as { code: string }).code, "DUPLICATE_RISK_NOT_ACKNOWLEDGED");
  assert.equal((await db.select().from(integrationOutbox).where(eq(integrationOutbox.id, review.id)))[0].status, "MANUAL_REVIEW");
  const ack = await post(`/integrations/outbound-recovery/integration_outbox/${review.id}/resolve`, A.admin.cookie, { resolution: "REQUEUE", note: "synthetic", acknowledgeDuplicateRisk: true });
  assert.equal(ack.status, 200);
  const [row] = await db.select().from(integrationOutbox).where(eq(integrationOutbox.id, review.id));
  assert.equal(row.status, "RETRY_SCHEDULED");
  assert.ok(row.nextAttemptAt.getTime() <= Date.now() + 1_000);
  // Leave nothing dispatchable behind for other suites' global sweeps / gauges.
  await db.update(integrationOutbox).set({ status: "CANCELLED" }).where(eq(integrationOutbox.id, review.id));
});

test("[RECOVERY] routes: comms MARK_SENT records the operator's evidence through the audited transition", async () => {
  const msg = await insertMessage("MANUAL_REVIEW", LONG_AGO, "marksent");
  const res = await post(`/integrations/outbound-recovery/communication_messages/${msg.id}/resolve`, A.admin.cookie, { resolution: "MARK_SENT", note: "synthetic: provider log shows accepted" });
  assert.equal(res.status, 200, await res.clone().text());
  const [row] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, msg.id));
  assert.equal(row.status, "SENT");
  const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.recordId, String(msg.id)), eq(auditLogs.userId, A.admin.user.id)));
  assert.deepEqual(audits.map((a) => a.action).sort(), ["communication_message_manual_mark_sent", "outbound_recovery_manual_mark_sent"]);
  const cross = await post(`/integrations/outbound-recovery/communication_messages/${msg.id}/resolve`, B.admin.cookie, { resolution: "MARK_FAILED", note: "x" });
  assert.equal(cross.status, 404);
});

test("[RECOVERY] routes: the Run-scoped payment queue needs run.access (Grow-only admin is 403, and its list hides payment items)", async () => {
  await db.update(entitlementGrants).set({ status: "Revoked" }).where(and(eq(entitlementGrants.brokerageId, A.brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(A.brokerageId);
  try {
    const res = await post(`/integrations/outbound-recovery/financial_payment_outbox/1/resolve`, A.admin.cookie, { resolution: "MARK_FAILED", note: "x" });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Run access is required for this item.", code: "RUN_ACCESS_REQUIRED" });
    const list = await fetch(`${baseUrl}/api/integrations/outbound-recovery/manual-review`, { headers: { cookie: A.admin.cookie } });
    assert.equal(list.status, 200, "Grow-only admin can still review Grow queues");
  } finally {
    await db.update(entitlementGrants).set({ status: "Active" }).where(and(eq(entitlementGrants.brokerageId, A.brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
    invalidateEntitlementCache(A.brokerageId);
  }
});

// ---------------------------------------------------------------------
// Operator visibility: gauges.
// ---------------------------------------------------------------------

test("[RECOVERY] gauges: expired-lease DISPATCHING, live DISPATCHING and MANUAL_REVIEW rows are each counted", async () => {
  const expired = await insertOutbox("DISPATCHING", "gauge-expired", LONG_AGO);
  const live = await insertOutbox("DISPATCHING", "gauge-live", new Date(Date.now() + 86_400_000));
  const review = await insertOutbox("MANUAL_REVIEW", "gauge-review");
  const staleMsg = await insertMessage("SENDING", LONG_AGO, "gauge-stale");
  try {
    resetMetricsForTesting();
    await sampleQueueGauges();
    const text = renderMetricsText();
    const value = (re: RegExp) => Number(text.match(re)?.[1] ?? NaN);
    assert.ok(value(/outbound_in_flight_gauge\{queue="integration_outbox",lease="expired"\} (\d+)/) >= 1, text.split("\n").filter((l) => l.includes("outbound_")).join("\n"));
    assert.ok(value(/outbound_in_flight_gauge\{queue="integration_outbox",lease="live"\} (\d+)/) >= 1);
    assert.ok(value(/outbound_manual_review_gauge\{queue="integration_outbox"\} (\d+)/) >= 1);
    assert.ok(value(/outbound_in_flight_gauge\{queue="communications_outbox",lease="expired"\} (\d+)/) >= 1);
    assert.ok(Number.isFinite(value(/outbound_manual_review_gauge\{queue="financial_payment_outbox"\} (\d+)/)));
  } finally {
    for (const id of [expired.id, live.id, review.id]) await db.update(integrationOutbox).set({ status: "CANCELLED" }).where(eq(integrationOutbox.id, id));
    await db.update(communicationMessages).set({ status: "FAILED" }).where(eq(communicationMessages.id, staleMsg.id));
  }
});

// ---------------------------------------------------------------------
// Atomicity: the resolve and its audit rows commit together or not at all.
// ---------------------------------------------------------------------

test("[ATOMIC] integration MARK_FAILED: if the operator audit write fails, the status change and the dead letter roll back (500, row still MANUAL_REVIEW)", async () => {
  const review = await insertOutbox("MANUAL_REVIEW", "atomic-int");
  manualReviewTestHooks.beforeAuditWrite = ({ id }) => {
    if (id === review.id) throw new Error("synthetic audit failure");
  };
  try {
    const res = await post(`/integrations/outbound-recovery/integration_outbox/${review.id}/resolve`, A.admin.cookie, { resolution: "MARK_FAILED", note: "synthetic" });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Could not resolve that item.", code: "INTERNAL_ERROR" });
  } finally {
    manualReviewTestHooks.beforeAuditWrite = undefined;
  }
  assert.equal((await db.select().from(integrationOutbox).where(eq(integrationOutbox.id, review.id)))[0].status, "MANUAL_REVIEW");
  assert.deepEqual(await db.select().from(integrationDeadLetters).where(eq(integrationDeadLetters.sourceId, review.id)), [], "dead letter rolled back");
  assert.deepEqual(await db.select().from(auditLogs).where(eq(auditLogs.recordId, review.id)), []);
  // The same action then succeeds, with exactly one of each row.
  const ok = await post(`/integrations/outbound-recovery/integration_outbox/${review.id}/resolve`, A.admin.cookie, { resolution: "MARK_FAILED", note: "synthetic" });
  assert.equal(ok.status, 200);
  const letters = await db.select().from(integrationDeadLetters).where(eq(integrationDeadLetters.sourceId, review.id));
  assert.equal(letters.length, 1);
  const letterAudits = await db.select().from(auditLogs).where(and(eq(auditLogs.recordType, "integration_dead_letter"), eq(auditLogs.recordId, String(letters[0].id))));
  assert.equal(letterAudits.length, 1, "the dead letter's own audit row commits in the same transaction");
  assert.equal((await db.select().from(auditLogs).where(and(eq(auditLogs.recordType, "integration_outbox"), eq(auditLogs.recordId, review.id)))).length, 1);
});

test("[ATOMIC] comms MARK_SENT: if the operator audit write fails, the message stays MANUAL_REVIEW with its version unchanged and no audit rows", async () => {
  const msg = await insertMessage("MANUAL_REVIEW", LONG_AGO, "atomic-comms");
  manualReviewTestHooks.beforeAuditWrite = ({ id }) => {
    if (id === String(msg.id)) throw new Error("synthetic audit failure");
  };
  try {
    const res = await post(`/integrations/outbound-recovery/communication_messages/${msg.id}/resolve`, A.admin.cookie, { resolution: "MARK_SENT", note: "synthetic" });
    assert.equal(res.status, 500);
  } finally {
    manualReviewTestHooks.beforeAuditWrite = undefined;
  }
  const [row] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, msg.id));
  assert.equal(row.status, "MANUAL_REVIEW");
  assert.equal(row.version, msg.version);
  // recordId alone is a serial id shared with every other record type in a shared test DB, so scope it to the
  // two comms record types written by a resolve (operator row: queue name; transition row: communication_message).
  assert.deepEqual(
    await db.select().from(auditLogs).where(and(eq(auditLogs.recordId, String(msg.id)), inArray(auditLogs.recordType, ["communication_messages", "communication_message"]))),
    [],
  );
});
