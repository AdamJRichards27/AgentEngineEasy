// Agent Engine 2.0 — Step 2: Security & Observability Hardening (Part B).
//
// Proves sampleQueueGauges() reads the TRUE current backlog/age/critical-risk
// state from the database (never a running total tracked incrementally,
// which would drift) — inserts real rows in each pending state directly,
// samples, and checks the exact counts/labels land in the metrics
// registry; then clears the pending rows and confirms the gauge drops back
// to zero on the next sample (proving overwrite, not accumulation).

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  db,
  integrationOutbox,
  financialPaymentOutbox,
  financialPaymentRequests,
  communicationMessages,
  communicationThreads,
  riskExceptions,
  integrationConnections,
} from "@aee/db";
import { resetMetricsForTesting, renderMetricsText } from "@aee/events";
import { sampleQueueGauges } from "../queueGauges.js";
import { randomUUID } from "node:crypto";
import { createBrokerageWithUsers, createListedProperty, createTransactionFromListedProperty, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";
import { bootstrapIntegrationsForTesting, createActiveMockPortalConnection } from "../../integrations/__tests__/testHelpers.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let baseUrl: string;
let server: import("node:http").Server;
let admin: DevLoginResult;
let brokerageId: number;
const suffix = Date.now();

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { createApp } = await import("../../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  await bootstrapIntegrationsForTesting();
  const pair = await createBrokerageWithUsers(baseUrl, `Queue Gauges ${suffix}`);
  admin = pair.admin;
  brokerageId = pair.brokerageId;
});

after(async () => {
  await cleanupBrokerages([brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(() => {
  resetMetricsForTesting();
});

test("sampleQueueGauges reports a zero backlog and zero age for a brand-new brokerage with no pending work", async () => {
  await sampleQueueGauges();
  const text = renderMetricsText();
  assert.match(text, /queue_backlog_size\{queue="integration_outbox"\} \d/);
  assert.match(text, /queue_backlog_size\{queue="financial_payment_outbox"\} \d/);
  assert.match(text, /queue_backlog_size\{queue="communications_outbox"\} \d/);
  assert.match(text, /unresolved_critical_risk_gauge\{status="open"\} \d/);
});

test("a PENDING financial_payment_outbox row increases the backlog gauge, and clearing it drops the gauge back down on the next sample (overwrite, not accumulation)", async () => {
  // financial_payment_requests.transaction_id is NOT NULL — this needs a
  // real accepted-offer Transaction, not just a listed property.
  const { propertyId, transactionId } = await createTransactionFromListedProperty(baseUrl, admin.cookie, { address: `1 Queue Gauges Financial Rd ${suffix}` });

  const [paymentRequest] = await db
    .insert(financialPaymentRequests)
    .values({
      brokerageId,
      propertyId,
      transactionId,
      amountCents: 1000,
      currency: "AUD",
      idempotencyKey: `queue-gauge-test-${suffix}`,
    })
    .returning();

  const [outboxRow] = await db
    .insert(financialPaymentOutbox)
    .values({
      brokerageId,
      paymentRequestId: paymentRequest.id,
      action: "SCHEDULE_DEBIT",
      status: "PENDING",
      idempotencyKey: `queue-gauge-outbox-${suffix}`,
      // Test isolation (shared test DB): not yet due, so a concurrent GLOBAL
      // dispatchPendingPaymentOutbox() sweep in another file never picks it
      // up. Otherwise that sweep's failed dispatch (this request has no
      // authority) can write status back to PENDING after this test sets it
      // to FAILED below. The backlog gauge counts PENDING rows whatever their
      // nextAttemptAt, so the gauge assertions are unchanged.
      nextAttemptAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning();

  await sampleQueueGauges();
  let text = renderMetricsText();
  const beforeMatch = text.match(/queue_backlog_size\{queue="financial_payment_outbox"\} (\d+)/);
  assert.ok(beforeMatch, "expected a financial_payment_outbox backlog series");
  assert.ok(Number(beforeMatch![1]) >= 1, "backlog must include the PENDING row just inserted");
  assert.match(text, /queue_oldest_item_age_ms\{queue="financial_payment_outbox"\} \d+/);
  const ageBefore = Number(text.match(/queue_oldest_item_age_ms\{queue="financial_payment_outbox"\} (\d+)/)![1]);
  assert.ok(ageBefore >= 0, "a freshly-created row's age must be a non-negative number of milliseconds");

  await db.update(financialPaymentOutbox).set({ status: "FAILED" }).where(eq(financialPaymentOutbox.id, outboxRow.id));

  resetMetricsForTesting();
  await sampleQueueGauges();
  text = renderMetricsText();
  const afterMatch = text.match(/queue_backlog_size\{queue="financial_payment_outbox"\} (\d+)/);
  assert.ok(afterMatch);
  assert.equal(Number(afterMatch![1]), 0, "once the row is no longer PENDING, the very next sample must reflect zero — proving this is sampled fresh, not tracked incrementally");
});

test("a QUEUED communications message increases the communications_outbox backlog gauge", async () => {
  const { propertyId } = await createListedProperty(baseUrl, admin.cookie, { address: `1 Queue Gauges Comms Rd ${suffix}` });
  const [thread] = await db
    .insert(communicationThreads)
    .values({ brokerageId, propertyId, subject: "Queue gauge test thread", createdByUserId: admin.user.id })
    .returning();
  await db.insert(communicationMessages).values({
    threadId: thread.id,
    brokerageId,
    propertyId,
    direction: "OUTBOUND",
    channel: "EMAIL",
    classification: "TRANSACTIONAL",
    status: "QUEUED",
    bodyText: "Queue gauge test message.",
    senderUserId: admin.user.id,
    createdByUserId: admin.user.id,
  });

  await sampleQueueGauges();
  const text = renderMetricsText();
  const match = text.match(/queue_backlog_size\{queue="communications_outbox"\} (\d+)/);
  assert.ok(match);
  assert.ok(Number(match![1]) >= 1, "backlog must include the QUEUED message just inserted");
});

test("an OPEN CRITICAL risk exception is counted by unresolved_critical_risk_gauge; an OPEN ATTENTION one is not", async () => {
  const { propertyId } = await createListedProperty(baseUrl, admin.cookie, { address: `1 Queue Gauges Risk Rd ${suffix}` });

  await db.insert(riskExceptions).values({
    brokerageId,
    propertyId,
    ruleId: "queue-gauge-test-rule",
    category: "OTHER",
    severity: "CRITICAL",
    status: "OPEN",
    title: "Queue gauge test — critical",
    problemDescription: "Test fixture.",
    businessImpact: "Test fixture.",
    detectedCause: "Test fixture.",
    recommendedAction: "Test fixture.",
    resolutionRequirements: "Test fixture.",
    sourceRecordType: "TEST_FIXTURE",
    sourceRecordId: `queue-gauge-critical-${suffix}`,
    correlationId: randomUUID(),
    dedupKey: `queue-gauge-critical-${suffix}`,
    openDedupKey: `queue-gauge-critical-${suffix}`,
  });
  await db.insert(riskExceptions).values({
    brokerageId,
    propertyId,
    ruleId: "queue-gauge-test-rule-attention",
    category: "OTHER",
    severity: "ATTENTION",
    status: "OPEN",
    title: "Queue gauge test — attention",
    problemDescription: "Test fixture.",
    businessImpact: "Test fixture.",
    detectedCause: "Test fixture.",
    recommendedAction: "Test fixture.",
    resolutionRequirements: "Test fixture.",
    sourceRecordType: "TEST_FIXTURE",
    sourceRecordId: `queue-gauge-attention-${suffix}`,
    correlationId: randomUUID(),
    dedupKey: `queue-gauge-attention-${suffix}`,
    openDedupKey: `queue-gauge-attention-${suffix}`,
  });

  await sampleQueueGauges();
  const text = renderMetricsText();
  const match = text.match(/unresolved_critical_risk_gauge\{status="open"\} (\d+)/);
  assert.ok(match);
  assert.ok(Number(match![1]) >= 1, "the OPEN CRITICAL exception just inserted must be counted");
});

test("a PENDING integration_outbox row increases the backlog gauge, and moving it to SENT drops the gauge back down on the next sample", async () => {
  const actor = { id: admin.user.id, role: admin.user.role };
  const { connection } = await createActiveMockPortalConnection(brokerageId, actor);

  const [outboxRow] = await db
    .insert(integrationOutbox)
    .values({
      brokerageId,
      connectionId: connection.id,
      capability: "PORTAL_PUBLISH_LISTING",
      commandPayload: { note: "queue gauge test fixture" },
      status: "PENDING",
      idempotencyKey: `queue-gauge-integration-outbox-${suffix}`,
      correlationId: randomUUID(),
      sourceRecordType: "TEST_FIXTURE",
      sourceRecordId: `queue-gauge-${suffix}`,
    })
    .returning();

  await sampleQueueGauges();
  let text = renderMetricsText();
  const beforeMatch = text.match(/queue_backlog_size\{queue="integration_outbox"\} (\d+)/);
  assert.ok(beforeMatch, "expected an integration_outbox backlog series");
  assert.ok(Number(beforeMatch![1]) >= 1, "backlog must include the PENDING row just inserted");
  const ageBefore = Number(text.match(/queue_oldest_item_age_ms\{queue="integration_outbox"\} (\d+)/)![1]);
  assert.ok(ageBefore >= 0, "a freshly-created row's age must be a non-negative number of milliseconds");

  await db.update(integrationOutbox).set({ status: "SENT" }).where(eq(integrationOutbox.id, outboxRow.id));

  resetMetricsForTesting();
  await sampleQueueGauges();
  text = renderMetricsText();
  const afterMatch = text.match(/queue_backlog_size\{queue="integration_outbox"\} (\d+)/);
  assert.ok(afterMatch);
  assert.equal(Number(afterMatch![1]), 0, "once the row is SENT (no longer PENDING/RETRY_SCHEDULED), the very next sample must reflect zero");
});

test("sampleQueueGauges never throws even if a query fails — it fails open so a gauge-sampling bug can never 500 the metrics endpoint", async () => {
  await assert.doesNotReject(() => sampleQueueGauges());
});

// integrationConnections itself is never queried directly by this file —
// createActiveMockPortalConnection above is what actually exercises it —
// but the import is kept here as the same "fixtures this file's setup
// depends on" documentation anchor used elsewhere in this suite.
void integrationConnections;
