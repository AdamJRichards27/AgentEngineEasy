// Agent Engine 2.0 — Exception & Risk Engine (Priority 4) — AE Step 5
// remediation, Proof C (Financial Transaction Engine).
//
// FIN05_RECONCILIATION_VARIANCE_UNRESOLVED (rules/financial.ts) is the risk
// rule this remediation pass added alongside Proof C itself: an unresolved
// VARIANCE row in financial_reconciliations (written only by
// lib/financial/mockPaymentStatusSync.ts's applyMockPaymentStatusEvent, via
// the real inbound webhook gateway — see financialProof.test.ts for that
// half of the proof) is a material discrepancy a human needs to review, not
// something the Financial Engine silently resolves on its own.
//
// This file exists because FIN05 was found, while writing the completion
// report, to be fully wired into FINANCIAL_RULES/registry.ts but to have NO
// dedicated test anywhere proving it actually fires — every other new rule
// this remediation pass added (H01, rules/integrationOperational.ts) has
// full scan-level coverage; this closes the same gap for FIN05, the one
// other new risk rule this pass introduced. It deliberately does not attempt
// to backfill coverage for FIN01-04, which pre-date this step and are out of
// its scope.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, financialPaymentRequests, financialReconciliations, riskExceptions } from "@aee/db";
import { resetMetricsForTesting, renderMetricsText } from "@aee/events";
import { createBrokerageWithUsers, createTransactionFromListedProperty, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";
import { bootstrapIntegrationsForTesting, createActiveMockPaymentStatusConnection } from "../../integrations/__tests__/testHelpers.js";
import { processInboundWebhook } from "../../integrations/webhooks.js";
import { PAYMENT_STATUS_WEBHOOK_EVENT_TYPE } from "../../integrations/financialProof.js";
import { MOCK_PAYMENT_STATUS_PROVIDER_ID } from "../../integrations/adapters/mockPaymentStatus.js";
import { linkPaymentRequestToExternalReference, PAYMENT_REQUEST_SOURCE_RECORD_TYPE } from "../../financial/mockPaymentStatusSync.js";
import { registerExceptionEngine } from "../bootstrap.js";
import { runScheduledScan, type ScanSummary } from "../engine.js";
import { dismissException, RiskExceptionError, acknowledgeException } from "../model.js";
import { FINANCIAL_RULES } from "../rules/financial.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const FIN05_RULE_ID = FINANCIAL_RULES.find((r) => r.ruleId.startsWith("FIN05"))!.ruleId;

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  registerExceptionEngine({ startScheduler: false });
  const { createApp } = await import("../../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  await bootstrapIntegrationsForTesting();
  A = await createBrokerageWithUsers(baseUrl, `Financial Reconciliation Risk A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Financial Reconciliation Risk B ${suffix}`);
});

after(async () => {
  const ids = [A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number");
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function actorOf(login: DevLoginResult) {
  return { id: login.user.id, role: login.user.role };
}

/** A real financial obligation against a real transaction — mirrors financialProof.test.ts's own helper exactly. */
async function createPaymentRequest(brokerageId: number, cookie: string, opts?: { amountCents?: number; currency?: string }) {
  const { propertyId, transactionId } = await createTransactionFromListedProperty(baseUrl, cookie, { address: `1 Financial Risk Rd ${suffix}-${Math.floor(Math.random() * 100000)}` });
  const [request] = await db
    .insert(financialPaymentRequests)
    .values({
      brokerageId,
      propertyId,
      transactionId,
      amountCents: opts?.amountCents ?? 150000,
      currency: opts?.currency ?? "AUD",
      idempotencyKey: `financial-risk-${suffix}-${Math.random()}`,
    })
    .returning();
  return { propertyId, transactionId, request };
}

// Mirrors integrationOperational.test.ts's own scanOrRetry — this test file
// shares the same test database as every other exceptions/integrations
// suite, so a concurrently-running scan can transiently hold the
// scan_runs lock.
// Scoped to this file's own tenants (A and B) so a scan here never touches
// another concurrently-running file's brokerages; the retry covers the
// global single-flight scan lock being held by another file's scan.
async function scanOrRetry(trigger: "SCHEDULED" | "MANUAL" = "MANUAL"): Promise<ScanSummary> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await runScheduledScan(trigger, { brokerageIds: [A.brokerageId, B.brokerageId] });
    if (result.ok) return result.summary;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("runScheduledScan did not succeed after retries — another scan kept the lock held throughout");
}

beforeEach(() => {
  resetMetricsForTesting();
});

async function findFin05Exception(brokerageId: number, paymentRequestId: number) {
  const rows = await db
    .select()
    .from(riskExceptions)
    .where(and(eq(riskExceptions.brokerageId, brokerageId), eq(riskExceptions.ruleId, FIN05_RULE_ID)));
  return rows.find((r) => (r.metadata as Record<string, unknown> | null)?.paymentRequestId === paymentRequestId) ?? null;
}

async function countFin05Exceptions(brokerageId: number, paymentRequestId: number): Promise<number> {
  const rows = await db
    .select()
    .from(riskExceptions)
    .where(and(eq(riskExceptions.brokerageId, brokerageId), eq(riskExceptions.ruleId, FIN05_RULE_ID)));
  return rows.filter((r) => (r.metadata as Record<string, unknown> | null)?.paymentRequestId === paymentRequestId).length;
}

test("FIN05: an amount-mismatch VARIANCE from a real mock payment-status webhook opens a dismissible, ATTENTION risk exception, and a later matching event auto-resolves it", async () => {
  const actor = actorOf(A.admin);
  const { propertyId, transactionId, request } = await createPaymentRequest(A.brokerageId, A.admin.cookie, { amountCents: 500000, currency: "AUD" });
  const { connection } = await createActiveMockPaymentStatusConnection(A.brokerageId, actor);
  const externalReference = `REF-fin05-${suffix}`;
  await linkPaymentRequestToExternalReference(request.id, A.brokerageId, connection.id, externalReference, actor);

  const mismatched = await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_PAYMENT_STATUS_PROVIDER_ID,
    providerEventId: `evt-fin05-variance-${suffix}`,
    eventType: PAYMENT_STATUS_WEBHOOK_EVENT_TYPE,
    payload: { externalReference, amountCents: 499999, currency: "AUD", status: "PAID_IN_FULL" },
    signatureValid: true,
  });
  assert.equal(mismatched.status, "PROCESSED");

  // AE Step 2 closure — Part B named critical gap: financial reconciliation
  // mismatch. The VARIANCE evidence just recorded above, over the real
  // inbound webhook path (not a bare model-function call), must have
  // incremented financial_reconciliation_variance_total exactly once.
  assert.match(renderMetricsText(), /financial_reconciliation_variance_total\{source="mock_integration_payment_status"\} 1/);

  // --- VARIANCE evidence -> FIN05 opens a real risk exception on the next scan. ---
  await scanOrRetry();
  const opened = await findFin05Exception(A.brokerageId, request.id);
  assert.ok(opened, "expected FIN05 to open a risk exception for the VARIANCE reconciliation row");
  assert.equal(opened!.status, "OPEN");
  assert.equal(opened!.severity, "ATTENTION");
  assert.equal(opened!.category, "FINANCIAL");
  assert.equal(opened!.propertyId, propertyId);
  assert.equal(opened!.transactionId, transactionId);
  assert.equal(opened!.ownerType, "TRANSACTION_OWNER");
  assert.equal(opened!.ownerUserId, A.admin.user.id);
  assert.equal(opened!.dismissible, true, "unlike H01's dead-letter case, a reconciliation variance is a human-reviewable judgement call, not purely evidence-driven — it must be dismissible");
  assert.equal(opened!.sourceRecordType, "financial_reconciliation");
  const metadata = opened!.metadata as Record<string, unknown> | null;
  assert.equal(metadata?.paymentRequestId, request.id);
  assert.ok(metadata?.financialReconciliationId, "expected the specific financial_reconciliations row id to be recorded in metadata");

  // --- No duplicate exception across repeated scans of the same still-open variance. ---
  await scanOrRetry();
  await scanOrRetry();
  assert.equal(await countFin05Exceptions(A.brokerageId, request.id), 1, "re-detecting the same still-open variance must update the existing row, never insert a second one");

  // --- A later, correctly-matching event supersedes the variance ("latest
  // wins" — rules/financial.ts's own documented convention) -> the next scan
  // no longer reports this payment request as a current variance -> the
  // exception auto-resolves from that authoritative evidence. ---
  const matched = await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_PAYMENT_STATUS_PROVIDER_ID,
    providerEventId: `evt-fin05-match-${suffix}`,
    eventType: PAYMENT_STATUS_WEBHOOK_EVENT_TYPE,
    payload: { externalReference, amountCents: 500000, currency: "AUD", status: "PAID_IN_FULL" },
    signatureValid: true,
  });
  assert.equal(matched.status, "PROCESSED");

  // A correctly-matching event must NOT increment the variance counter —
  // still exactly the one occurrence recorded above.
  assert.match(renderMetricsText(), /financial_reconciliation_variance_total\{source="mock_integration_payment_status"\} 1/);

  await scanOrRetry();
  const resolved = await findFin05Exception(A.brokerageId, request.id);
  assert.ok(resolved);
  assert.equal(resolved!.id, opened!.id, "the SAME exception row resolves — not a second, separate row");
  assert.equal(resolved!.status, "RESOLVED");
  assert.equal(resolved!.resolutionMethod, "AUTO");
  const evidence = resolved!.resolutionEvidence as {
    kind?: string;
    ruleCode?: string;
    ruleVersion?: number;
    record?: { scope?: string; brokerageId?: number };
  } | null;
  assert.equal(evidence?.kind, "CONDITION_SATISFIED");
  assert.equal(evidence?.ruleCode, FIN05_RULE_ID);
  assert.equal(evidence?.ruleVersion, 1);
  assert.equal(evidence?.record?.scope, "IN_SCOPE");
  assert.equal(evidence?.record?.brokerageId, A.brokerageId);
});

test("FIN05: a matching mock payment-status event (no mismatch) never creates a risk exception", async () => {
  const actor = actorOf(A.admin);
  const { request } = await createPaymentRequest(A.brokerageId, A.admin.cookie, { amountCents: 220000, currency: "AUD" });
  const { connection } = await createActiveMockPaymentStatusConnection(A.brokerageId, actor);
  const externalReference = `REF-fin05-clean-${suffix}`;
  await linkPaymentRequestToExternalReference(request.id, A.brokerageId, connection.id, externalReference, actor);

  const result = await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_PAYMENT_STATUS_PROVIDER_ID,
    providerEventId: `evt-fin05-clean-${suffix}`,
    eventType: PAYMENT_STATUS_WEBHOOK_EVENT_TYPE,
    payload: { externalReference, amountCents: 220000, currency: "AUD", status: "PAID_IN_FULL" },
    signatureValid: true,
  });
  assert.equal(result.status, "PROCESSED");

  await scanOrRetry();
  assert.equal(await countFin05Exceptions(A.brokerageId, request.id), 0, "matching evidence must never open a variance exception");
});

test("FIN05: dismissible — an authorised administrator can dismiss a still-open variance exception (unlike H01's non-dismissible dead-letter case)", async () => {
  const actor = actorOf(A.admin);
  const { request } = await createPaymentRequest(A.brokerageId, A.admin.cookie, { amountCents: 900000, currency: "AUD" });
  const { connection } = await createActiveMockPaymentStatusConnection(A.brokerageId, actor);
  const externalReference = `REF-fin05-dismiss-${suffix}`;
  await linkPaymentRequestToExternalReference(request.id, A.brokerageId, connection.id, externalReference, actor);

  await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_PAYMENT_STATUS_PROVIDER_ID,
    providerEventId: `evt-fin05-dismiss-${suffix}`,
    eventType: PAYMENT_STATUS_WEBHOOK_EVENT_TYPE,
    payload: { externalReference, amountCents: 1, currency: "AUD", status: "PAID_IN_FULL" },
    signatureValid: true,
  });

  await scanOrRetry();
  const opened = await findFin05Exception(A.brokerageId, request.id);
  assert.ok(opened);

  const dismissed = await dismissException(opened!.id, A.brokerageId, actor, "Reviewed manually — provider sandbox sent a clearly malformed test amount, not a real discrepancy.");
  assert.equal(dismissed.status, "DISMISSED");
});

test("FIN05: cross-tenant — a variance exception belongs to its own brokerage and is invisible/inaccessible from another brokerage", async () => {
  const actorB = actorOf(B.admin);
  const { request } = await createPaymentRequest(B.brokerageId, B.admin.cookie, { amountCents: 400000, currency: "AUD" });
  const { connection } = await createActiveMockPaymentStatusConnection(B.brokerageId, actorB);
  const externalReference = `REF-fin05-tenant-${suffix}`;
  await linkPaymentRequestToExternalReference(request.id, B.brokerageId, connection.id, externalReference, actorB);

  await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_PAYMENT_STATUS_PROVIDER_ID,
    providerEventId: `evt-fin05-tenant-${suffix}`,
    eventType: PAYMENT_STATUS_WEBHOOK_EVENT_TYPE,
    payload: { externalReference, amountCents: 111111, currency: "AUD", status: "PAID_IN_FULL" },
    signatureValid: true,
  });

  await scanOrRetry();
  const exceptionInB = await findFin05Exception(B.brokerageId, request.id);
  assert.ok(exceptionInB);
  assert.equal(exceptionInB!.brokerageId, B.brokerageId);

  await assert.rejects(
    () => acknowledgeException(exceptionInB!.id, A.brokerageId, actorOf(A.admin)),
    (err: unknown) => err instanceof RiskExceptionError && err.reason === "NOT_FOUND",
  );
  assert.equal(await countFin05Exceptions(A.brokerageId, request.id), 0);
});
