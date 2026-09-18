import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { test, type TestContext } from "node:test";
import type { Request, Response, NextFunction } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db, brokerages, users, parties, growCallSessions, growCallWebhookEvents,
  growActivities, auditLogs, growConsentDecisions, growContactChannelConsents,
} from "@aee/db";
import { processInboundTelephonyWebhook, type TelephonySandboxEventType } from "../webhooks.js";
import { growCallsWebhooksRouter } from "../../../routes/growCallsWebhooks.js";
import { cleanupBrokerages } from "../../../routes/__tests__/testSupport.js";
import { captureConsentState, recordConsentPolicy, recordDncrStatus } from "../../consentControlsPersistence.js";
import { PHONE_CALL_CONSENT_PURPOSE, PHONE_CALL_CONSENT_SCOPE } from "../eligibility.js";

async function fixture(t: TestContext, status = "DIAL_REQUESTED", recordingRequested = false) {
  const suffix = randomUUID();
  const [brokerage] = await db.insert(brokerages).values({ name: `Webhook retry ${suffix}` }).returning();
  t.after(async () => {
    t.mock.restoreAll();
    await db.delete(growCallWebhookEvents).where(sql`${growCallWebhookEvents.payload}->>'providerCallId' = ${`call-${suffix}`}`);
    await cleanupBrokerages([brokerage.id]);
  });
  const [user] = await db.insert(users).values({
    brokerageId: brokerage.id, email: `webhook-${suffix}@example.test`,
    authProviderId: `webhook-${suffix}`, firstName: "Webhook", lastName: "Regression", role: "Agent",
  }).returning();
  const [party] = await db.insert(parties).values({
    brokerageId: brokerage.id, firstName: "Webhook", mobile: "+61412000999",
  }).returning();
  const [session] = await db.insert(growCallSessions).values({
    brokerageId: brokerage.id, initiatedByUserId: user.id, partyId: party.id,
    destinationRaw: "+61412000999", destinationNormalized: "+61412000999",
    destinationCountry: "AU", provider: "sandbox", providerCallId: `call-${suffix}`,
    status, startedAt: new Date(), recordingRequested,
    recordingStatus: recordingRequested ? "DISCLOSURE_REQUIRED" : "NOT_REQUESTED",
  }).returning();
  await recordConsentPolicy({
    brokerageId: brokerage.id, jurisdiction: "AU", version: suffix,
    effectiveAt: new Date(Date.now() - 60_000), dncrRequired: true,
    suppressionEnabled: true, timeZone: "Etc/UTC",
    allowedHoursStart: "00:00", allowedHoursEnd: "00:00", recordedByUserId: user.id,
  });
  await captureConsentState({
    brokerageId: brokerage.id, partyId: party.id, channel: "PHONE_CALL", state: "EXPRESS",
    source: "webhook-regression", captureMethod: "test-fixture",
    purpose: PHONE_CALL_CONSENT_PURPOSE, scope: PHONE_CALL_CONSENT_SCOPE,
    jurisdiction: "AU", recordedByUserId: user.id,
  });
  await recordDncrStatus({
    brokerageId: brokerage.id, partyId: party.id, channel: "PHONE_CALL",
    jurisdiction: "AU", status: "CLEARED", checkedAt: new Date(Date.now() - 1000),
    validUntil: new Date(Date.now() + 86_400_000), reviewAt: new Date(Date.now() + 86_400_000),
    source: "webhook-regression", reference: suffix, recordedByUserId: user.id,
  });
  return session;
}

function event(session: { providerCallId: string | null }, eventType: TelephonySandboxEventType) {
  const providerEventId = `retry-${randomUUID()}`;
  const providerCallId = session.providerCallId!;
  return {
    provider: "sandbox", providerEventId, eventType, providerCallId,
    payload: { eventId: providerEventId, eventType, providerCallId },
  };
}

async function receipt(providerEventId: string) {
  const [row] = await db.select().from(growCallWebhookEvents)
    .where(eq(growCallWebhookEvents.providerEventId, providerEventId));
  return row;
}

async function snapshot(id: number) {
  const [session] = await db.select().from(growCallSessions).where(eq(growCallSessions.id, id));
  const audits = await db.select().from(auditLogs).where(and(
    eq(auditLogs.recordType, "grow_call_session"), eq(auditLogs.recordId, String(id)),
  ));
  const activities = await db.select().from(growActivities).where(and(
    eq(growActivities.source, "grow_calls"), eq(growActivities.sourceId, String(id)),
  ));
  return { session, audits, activities };
}

// Inject real orchestration failures at both root and transaction executors.
// No production fault flags or global SQL triggers are needed.
function failWrites(t: TestContext, table: unknown, method: "insert" | "update", predicate: (value: any) => boolean) {
  let enabled = true;
  function patch(executor: any) {
    const original = executor[method].bind(executor);
    t.mock.method(executor, method, (target: unknown) => {
      const builder = original(target);
      if (target === table) {
        const setter = method === "insert" ? "values" : "set";
        const set = builder[setter].bind(builder);
        t.mock.method(builder, setter, (value: any) => {
          if (enabled && predicate(value)) throw new Error("injected-private-database-detail");
          return set(value);
        });
      }
      return builder;
    });
  }
  patch(db);
  const transaction = db.transaction.bind(db);
  t.mock.method(db, "transaction", (callback: any, config: any) =>
    transaction(async (tx) => { patch(tx); return callback(tx); }, config));
  return () => { enabled = false; };
}

test("finding5: transient processing failure retries exactly once under concurrent same-ID delivery", async (t) => {
  const session = await fixture(t);
  const input = event(session, "call.ringing");
  const recover = failWrites(t, auditLogs, "insert", (v) => v.recordId === String(session.id));
  const failed = await deliver(input);
  assert.equal(failed.status, 500);
  assert.equal(failed.body.status, "FAILED");
  assert.doesNotMatch(JSON.stringify(failed.body), /injected-private/);
  assert.equal((await receipt(input.providerEventId)).processingStatus, "FAILED");
  assert.equal((await snapshot(session.id)).session.status, "DIAL_REQUESTED");
  recover();
  const results = await Promise.all(Array.from({ length: 8 }, () => deliver(input)));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(results.filter((r) => r.body.status === "PROCESSED").length, 1);
  assert.equal(results.filter((r) => r.body.status === "DUPLICATE").length, 7);
  const state = await snapshot(session.id);
  assert.equal(state.session.status, "RINGING");
  assert.equal(state.audits.length, 1);
  assert.equal(state.activities.length, 0);
  assert.equal((await receipt(input.providerEventId)).processingError, null);
});

for (const [initial, type, target] of [
  ["DIAL_REQUESTED", "call.ringing", "RINGING"],
  ["RINGING", "call.connected", "CONNECTED"],
  ["CONNECTED", "call.completed", "COMPLETED"],
  ["DIAL_REQUESTED", "call.failed", "FAILED"],
] as const) {
  test(`finding5: ${type} receipt-finalization failure rolls back core effects before crash retry`, async (t) => {
    const session = await fixture(t, initial);
    const input = event(session, type);
    const before = await db.select().from(growConsentDecisions).where(eq(growConsentDecisions.brokerageId, session.brokerageId));
    const recover = failWrites(t, growCallWebhookEvents, "update", (v) => v.processingStatus === "PROCESSED");
    assert.equal((await processInboundTelephonyWebhook(input)).status, "FAILED");
    const rolledBack = await snapshot(session.id);
    assert.equal(rolledBack.session.status, initial, "receipt and core transition must commit together");
    assert.equal(rolledBack.audits.length, 0);
    assert.equal(rolledBack.activities.length, 0);
    assert.equal((await db.select().from(growConsentDecisions).where(eq(growConsentDecisions.brokerageId, session.brokerageId))).length, before.length);
    recover();
    assert.equal((await processInboundTelephonyWebhook(input)).status, "PROCESSED");
    assert.equal((await processInboundTelephonyWebhook(input)).status, "DUPLICATE");
    const committed = await snapshot(session.id);
    assert.equal(committed.session.status, target);
    assert.equal(committed.audits.length, 1);
    assert.equal(committed.activities.length, type === "call.completed" ? 1 : 0);
    assert.equal((await receipt(input.providerEventId)).relatedCallSessionId, session.id);
  });
}

test("finding5: a durable PENDING receipt is recoverable and a changed retry cannot retarget tenants or event types", async (t) => {
  const original = await fixture(t);
  const foreign = await fixture(t, "CONNECTED", true);
  const input = event(original, "call.ringing");
  await db.insert(growCallWebhookEvents).values({
    provider: input.provider, providerEventId: input.providerEventId,
    eventType: input.eventType, payload: input.payload,
  });
  const altered = {
    ...input, providerCallId: foreign.providerCallId!, eventType: "call.completed" as const,
    payload: { ...input.payload, providerCallId: foreign.providerCallId, eventType: "call.completed", brokerageId: foreign.brokerageId },
  };
  assert.equal((await processInboundTelephonyWebhook(altered)).status, "PROCESSED");
  assert.equal((await snapshot(original.id)).session.status, "RINGING");
  assert.equal((await snapshot(foreign.id)).session.status, "CONNECTED");
  assert.equal((await receipt(input.providerEventId)).relatedCallSessionId, original.id);
  assert.equal((await processInboundTelephonyWebhook(altered)).status, "DUPLICATE");
  assert.equal((await snapshot(foreign.id)).audits.length, 0);
});

test("finding5: a processed terminal replay cannot run recording closure against a different tenant", async (t) => {
  const original = await fixture(t, "CONNECTED");
  const foreign = await fixture(t, "COMPLETED", true);
  const input = event(original, "call.completed");
  assert.equal((await processInboundTelephonyWebhook(input)).status, "PROCESSED");
  assert.equal((await processInboundTelephonyWebhook({ ...input, providerCallId: foreign.providerCallId! })).status, "DUPLICATE");
  const untouched = await snapshot(foreign.id);
  assert.equal(untouched.session.recordingStatus, "DISCLOSURE_REQUIRED");
  assert.equal(untouched.audits.length, 0);
});

test("finding5: terminal recording audit retry remains independent of committed receipt/core activity", async (t) => {
  const session = await fixture(t, "CONNECTED", true);
  const input = event(session, "call.completed");
  const recover = failWrites(t, auditLogs, "insert", (v) => v.action === "grow_call_recording_unrecorded");
  assert.equal((await processInboundTelephonyWebhook(input)).status, "PROCESSED");
  let state = await snapshot(session.id);
  assert.equal(state.session.recordingStatus, "UNRECORDED");
  assert.equal(state.audits.length, 1);
  recover();
  assert.equal((await processInboundTelephonyWebhook(input)).status, "DUPLICATE");
  state = await snapshot(session.id);
  assert.equal(state.audits.filter((r) => r.action === "grow_call_recording_unrecorded").length, 1);
  assert.equal(state.audits.filter((r) => r.action === "grow_call_completed").length, 1);
  assert.equal(state.activities.length, 1);
});

test("finding5: CONNECTED denial evidence still commits while receipt remains retryable FAILED", async (t) => {
  const session = await fixture(t, "RINGING");
  const [consent] = await db.select().from(growContactChannelConsents).where(eq(growContactChannelConsents.partyId, session.partyId));
  await captureConsentState({
    brokerageId: session.brokerageId, partyId: session.partyId, channel: "PHONE_CALL", state: "WITHDRAWN",
    source: "webhook-regression", captureMethod: "test-fixture", purpose: PHONE_CALL_CONSENT_PURPOSE,
    scope: PHONE_CALL_CONSENT_SCOPE, jurisdiction: "AU", recordedByUserId: session.initiatedByUserId,
    withdrawnAt: new Date(), withdrawnByUserId: session.initiatedByUserId, withdrawalReason: "regression withdrawal",
    supersedesConsentId: consent.id,
  });
  const input = event(session, "call.connected");
  assert.equal((await processInboundTelephonyWebhook(input)).status, "FAILED");
  assert.equal((await snapshot(session.id)).session.status, "RINGING");
  assert.equal((await snapshot(session.id)).audits.filter((r) => r.action === "grow_call_connected_consent_denied").length, 1);
  const decisions = await db.select().from(growConsentDecisions).where(eq(growConsentDecisions.brokerageId, session.brokerageId));
  assert.equal(decisions.at(-1)?.decision, "BLOCKED");
});

test("finding5: initial concurrent delivery has one receipt, one core audit and one activity", async (t) => {
  const session = await fixture(t, "CONNECTED");
  const input = event(session, "call.completed");
  const results = await Promise.all(Array.from({ length: 8 }, () => processInboundTelephonyWebhook(input)));
  assert.equal(results.filter((r) => r.status === "PROCESSED").length, 1);
  assert.equal(results.filter((r) => r.status === "DUPLICATE").length, 7);
  assert.equal(new Set(results.map((r) => r.webhookEventId)).size, 1);
  const state = await snapshot(session.id);
  assert.equal(state.audits.length, 1);
  assert.equal(state.activities.length, 1);
});

test("finding5: successful nonterminal replay after lifecycle advancement has no new effects", async (t) => {
  const session = await fixture(t);
  const ringing = event(session, "call.ringing");
  const connected = event(session, "call.connected");
  for (const input of [ringing, connected, event(session, "call.completed")]) {
    assert.equal((await processInboundTelephonyWebhook(input)).status, "PROCESSED");
  }
  const before = await snapshot(session.id);
  const decisions = await db.select().from(growConsentDecisions).where(eq(growConsentDecisions.brokerageId, session.brokerageId));
  for (const input of [ringing, connected]) {
    assert.equal((await processInboundTelephonyWebhook(input)).status, "DUPLICATE");
  }
  assert.deepEqual(await snapshot(session.id), before);
  assert.deepEqual(await db.select().from(growConsentDecisions).where(eq(growConsentDecisions.brokerageId, session.brokerageId)), decisions);
});

test("finding5: delayed FAILED bookkeeping cannot overwrite a competing committed retry", async (t) => {
  const session = await fixture(t);
  const input = event(session, "call.ringing");
  const recover = failWrites(t, auditLogs, "insert", (v) => v.recordId === String(session.id));
  const originalUpdate = db.update.bind(db);
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(db, "update", (table: any) => {
    const builder = originalUpdate(table);
    if (table === growCallWebhookEvents) {
      const set = builder.set.bind(builder);
      t.mock.method(builder, "set", (value: any) => {
        const update = set(value);
        if (value.processingStatus === "FAILED") {
          const where = update.where.bind(update);
          t.mock.method(update, "where", (condition: any) => {
            entered();
            return gate.then(() => where(condition)) as any;
          });
        }
        return update;
      });
    }
    return builder;
  });
  const failing = processInboundTelephonyWebhook(input);
  try {
    await blocked;
    recover();
    assert.equal((await processInboundTelephonyWebhook(input)).status, "PROCESSED");
  } finally {
    release();
    await failing;
  }
  assert.equal((await receipt(input.providerEventId)).processingStatus, "PROCESSED");
  assert.equal((await receipt(input.providerEventId)).processingError, null);
  assert.equal((await snapshot(session.id)).audits.length, 1);
});

test("finding5: provider namespace is part of session lookup and receipt deduplication", async (t) => {
  const session = await fixture(t);
  const input = event(session, "call.ringing");
  const otherProvider = { ...input, provider: `isolated-${randomUUID()}` };
  assert.equal((await processInboundTelephonyWebhook(otherProvider)).status, "FAILED");
  assert.equal((await snapshot(session.id)).session.status, "DIAL_REQUESTED");
  assert.equal((await processInboundTelephonyWebhook(input)).status, "PROCESSED");
  assert.equal((await snapshot(session.id)).session.status, "RINGING");
});

test("finding5 boundary: failed bookkeeping is also sanitized and a stranded PENDING receipt retries", async (t) => {
  const session = await fixture(t);
  const input = event(session, "call.ringing");
  const recover = failWrites(t, auditLogs, "insert", (v) => v.recordId === String(session.id));
  const update = db.update.bind(db);
  const brokenBookkeeping = t.mock.method(db, "update", (table: any) => {
    if (table === growCallWebhookEvents) throw new Error("private-bookkeeping-query");
    return update(table);
  });
  const failed = await deliver(input);
  assert.equal(failed.status, 500);
  assert.equal(failed.body.status, "FAILED");
  assert.doesNotMatch(JSON.stringify(failed.body), /private|query/);
  assert.equal((await receipt(input.providerEventId)).processingStatus, "PENDING");
  brokenBookkeeping.mock.restore();
  recover();
  const success = await deliver(input);
  assert.equal(success.status, 200);
  assert.equal(success.body.status, "PROCESSED");
});

// Invoke Express's actual async handler with a signed request. Awaiting its
// returned promise in the test exposes the rejection Express 4 ignores,
// without installing a process-wide unhandledRejection listener.
const route = growCallsWebhooksRouter.stack.find((layer: any) => layer.route)?.route!.stack[0]!.handle as
  (req: Request, res: Response, next: NextFunction) => Promise<void>;
async function deliver(input: ReturnType<typeof event>) {
  const secret = "webhook-regression-only-secret";
  const previousEnabled = process.env.GROW_CALLS_WEBHOOK_INGRESS_ENABLED;
  const previousSecret = process.env.GROW_CALLS_WEBHOOK_SECRET;
  process.env.GROW_CALLS_WEBHOOK_INGRESS_ENABLED = "true";
  process.env.GROW_CALLS_WEBHOOK_SECRET = secret;
  const rawBody = Buffer.from(JSON.stringify(input.payload));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString()}`).digest("hex");
  let status = 0;
  let body: any;
  const req = {
    body: input.payload, rawBody,
    header: (name: string) => name === "x-grow-calls-timestamp" ? timestamp : `sha256=${signature}`,
  };
  const res = { status(code: number) { status = code; return this; }, json(value: unknown) { body = value; return this; } };
  // All concurrent calls use the same values; avoid restoring environment
  // until the synchronous ingress/signature checks have already run.
  const pending = route(req as unknown as Request, res as unknown as Response, () => { throw new Error("unexpected next"); });
  if (previousEnabled === undefined) delete process.env.GROW_CALLS_WEBHOOK_INGRESS_ENABLED;
  else process.env.GROW_CALLS_WEBHOOK_INGRESS_ENABLED = previousEnabled;
  if (previousSecret === undefined) delete process.env.GROW_CALLS_WEBHOOK_SECRET;
  else process.env.GROW_CALLS_WEBHOOK_SECRET = previousSecret;
  await pending;
  return { status, body };
}

for (const method of ["select", "insert"] as const) {
  test(`finding5 boundary: initial receipt ${method.toUpperCase()} failure returns sanitized retryable 500, not a rejected Express handler`, async (t) => {
    const input = event({ providerCallId: `missing-${randomUUID()}` }, "call.ringing");
    const original = db[method].bind(db);
    const injected = t.mock.method(db, method, (...args: any[]) => {
      if (method === "insert") throw new Error("private-db-password-and-query");
      const builder = (original as any)(...args);
      const from = builder.from.bind(builder);
      t.mock.method(builder, "from", (table: unknown) => {
        if (table === growCallWebhookEvents) throw new Error("private-db-password-and-query");
        return from(table);
      });
      return builder;
    });
    try {
      let response: Awaited<ReturnType<typeof deliver>> | undefined;
      await assert.doesNotReject(async () => { response = await deliver(input); });
      assert.equal(response?.status, 500);
      assert.equal(response?.body.status, "FAILED");
      assert.doesNotMatch(JSON.stringify(response?.body), /private-db|password|query/i);
    } finally {
      injected.mock.restore();
      t.mock.restoreAll();
    }
  });
}
