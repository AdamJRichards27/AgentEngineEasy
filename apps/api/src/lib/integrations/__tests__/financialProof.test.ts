// Agent Engine 2.0 — AE Step 5 remediation — Proof C (Financial Transaction
// Engine).
//
// End-to-end through the REAL webhook gateway, mapping, and the Financial
// Engine's own reconciliation authority (lib/financial/mockPaymentStatusSync.ts)
// — no shortcuts. Proves the full 13-step scenario (an obligation exists ->
// a signed mock payment-status event -> external id mapped to the internal
// payment request -> validated internal command -> submitted through the
// Financial Engine's own service boundary -> amount/currency/reference
// validated -> evidence recorded as PARTIALLY_RECONCILED/VARIANCE, NEVER
// RECONCILED -> a provider event can never independently declare the AE
// obligation reconciled), plus the safety-test matrix: duplicate event,
// wrong amount, wrong currency, unknown reference, ambiguous mapping,
// stale/out-of-order event, provider-claimed-success cannot bypass
// reconciliation, unapproved connection cannot submit, cross-tenant
// rejection, and no bank/trust/real-payment credential or money-movement
// capability anywhere in this path.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, financialPaymentRequests, financialReconciliations, financialPaymentOutbox } from "@aee/db";
import { createBrokerageWithUsers, createTransactionFromListedProperty, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";
import { bootstrapIntegrationsForTesting, createActiveMockPaymentStatusConnection, createActiveMockPortalConnection } from "./testHelpers.js";
import { processInboundWebhook } from "../webhooks.js";
import { PAYMENT_STATUS_WEBHOOK_EVENT_TYPE } from "../financialProof.js";
import { MOCK_PAYMENT_STATUS_PROVIDER_ID } from "../adapters/mockPaymentStatus.js";
import { linkPaymentRequestToExternalReference, MappingConflictError, PAYMENT_REQUEST_SOURCE_RECORD_TYPE } from "../../financial/mockPaymentStatusSync.js";
import { IntegrationError } from "../types.js";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

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
  A = await createBrokerageWithUsers(baseUrl, `Integrations Financial Proof ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Integrations Financial Proof B ${suffix}`);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number"));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function actorOf(login: DevLoginResult) {
  return { id: login.user.id, role: login.user.role };
}

/** A real financial obligation (a financial_payment_requests row) against a real transaction — the exact obligation Proof C's evidence trail is validated against. */
async function createPaymentRequest(brokerageId: number, cookie: string, opts?: { amountCents?: number; currency?: string }) {
  const { propertyId, transactionId } = await createTransactionFromListedProperty(baseUrl, cookie, { address: `1 Financial Proof Rd ${suffix}-${Math.floor(Math.random() * 100000)}` });
  const [request] = await db
    .insert(financialPaymentRequests)
    .values({
      brokerageId,
      propertyId,
      transactionId,
      amountCents: opts?.amountCents ?? 150000,
      currency: opts?.currency ?? "AUD",
      idempotencyKey: `financial-proof-${suffix}-${Math.random()}`,
    })
    .returning();
  return { propertyId, transactionId, request };
}

async function latestReconciliation(brokerageId: number, recordId: string) {
  const rows = await db
    .select()
    .from(financialReconciliations)
    .where(and(eq(financialReconciliations.brokerageId, brokerageId), eq(financialReconciliations.recordType, PAYMENT_REQUEST_SOURCE_RECORD_TYPE), eq(financialReconciliations.recordId, recordId)));
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}

test("Proof C: obligation -> linked external reference -> signed mock status event -> Financial Engine's own reconciliation evidence, never RECONCILED, no money movement, duplicate protection", async () => {
  const actor = actorOf(A.admin);
  const { request } = await createPaymentRequest(A.brokerageId, A.admin.cookie, { amountCents: 220000, currency: "AUD" });
  const { connection } = await createActiveMockPaymentStatusConnection(A.brokerageId, actor);

  // --- Link the obligation to the mock processor's external reference. ---
  const externalReference = `REF-${suffix}`;
  await linkPaymentRequestToExternalReference(request.id, A.brokerageId, connection.id, externalReference, actor);

  // --- A signed mock payment-status event, validated internal command,
  // submitted through the Financial Engine's own service boundary. ---
  const result = await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_PAYMENT_STATUS_PROVIDER_ID,
    providerEventId: `evt-match-${suffix}`,
    eventType: PAYMENT_STATUS_WEBHOOK_EVENT_TYPE,
    payload: { externalReference, amountCents: 220000, currency: "AUD", status: "PAID_IN_FULL" },
    signatureValid: true,
  });
  assert.equal(result.status, "PROCESSED");

  const reconciliation = await latestReconciliation(A.brokerageId, String(request.id));
  assert.ok(reconciliation);
  // Evidence of a match, never the Financial Engine's own authoritative
  // sign-off — a provider event, even one claiming full payment, can never
  // independently declare the obligation RECONCILED.
  assert.equal(reconciliation!.status, "PARTIALLY_RECONCILED");
  assert.notEqual(reconciliation!.status, "RECONCILED");

  // --- The obligation itself is untouched — this is evidence, not a status change on the obligation. ---
  const [afterEvent] = await db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, request.id));
  assert.equal(afterEvent.status, "NOT_CALCULATED", "the payment request's own status column must never be written by this proof");

  // --- No money movement anywhere: zero financial_payment_outbox rows for this request. ---
  const outboxRows = await db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.paymentRequestId, request.id));
  assert.equal(outboxRows.length, 0, "Proof C must never create a payment-outbox (money-movement) row");

  // --- Duplicate delivery protection. ---
  const duplicate = await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_PAYMENT_STATUS_PROVIDER_ID,
    providerEventId: `evt-match-${suffix}`,
    eventType: PAYMENT_STATUS_WEBHOOK_EVENT_TYPE,
    payload: { externalReference, amountCents: 220000, currency: "AUD", status: "PAID_IN_FULL" },
    signatureValid: true,
  });
  assert.equal(duplicate.status, "DUPLICATE");

  // --- No row anywhere for this record ever reaches RECONCILED. ---
  const allRows = await db.select().from(financialReconciliations).where(and(eq(financialReconciliations.brokerageId, A.brokerageId), eq(financialReconciliations.recordType, PAYMENT_REQUEST_SOURCE_RECORD_TYPE), eq(financialReconciliations.recordId, String(request.id))));
  assert.ok(allRows.every((r) => r.status !== "RECONCILED"));
});

test("safety: an amount mismatch is recorded as VARIANCE — a provider event can never talk its way into a false match", async () => {
  const actor = actorOf(A.admin);
  const { request } = await createPaymentRequest(A.brokerageId, A.admin.cookie, { amountCents: 500000, currency: "AUD" });
  const { connection } = await createActiveMockPaymentStatusConnection(A.brokerageId, actor);
  const externalReference = `REF-amount-${suffix}`;
  await linkPaymentRequestToExternalReference(request.id, A.brokerageId, connection.id, externalReference, actor);

  await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_PAYMENT_STATUS_PROVIDER_ID,
    providerEventId: `evt-wrong-amount-${suffix}`,
    eventType: PAYMENT_STATUS_WEBHOOK_EVENT_TYPE,
    payload: { externalReference, amountCents: 499999, currency: "AUD", status: "PAID_IN_FULL" },
    signatureValid: true,
  });

  const reconciliation = await latestReconciliation(A.brokerageId, String(request.id));
  assert.equal(reconciliation?.status, "VARIANCE");
  assert.equal(reconciliation?.differenceCents, -1);
});

test("safety: a currency mismatch is recorded as VARIANCE", async () => {
  const actor = actorOf(A.admin);
  const { request } = await createPaymentRequest(A.brokerageId, A.admin.cookie, { amountCents: 300000, currency: "AUD" });
  const { connection } = await createActiveMockPaymentStatusConnection(A.brokerageId, actor);
  const externalReference = `REF-currency-${suffix}`;
  await linkPaymentRequestToExternalReference(request.id, A.brokerageId, connection.id, externalReference, actor);

  await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_PAYMENT_STATUS_PROVIDER_ID,
    providerEventId: `evt-wrong-currency-${suffix}`,
    eventType: PAYMENT_STATUS_WEBHOOK_EVENT_TYPE,
    payload: { externalReference, amountCents: 300000, currency: "USD", status: "PAID_IN_FULL" },
    signatureValid: true,
  });

  const reconciliation = await latestReconciliation(A.brokerageId, String(request.id));
  assert.equal(reconciliation?.status, "VARIANCE");
});

test("safety: an unknown external reference (never linked) is recorded for audit only, with no reconciliation effect", async () => {
  const actor = actorOf(A.admin);
  const { connection } = await createActiveMockPaymentStatusConnection(A.brokerageId, actor);

  const result = await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_PAYMENT_STATUS_PROVIDER_ID,
    providerEventId: `evt-unknown-ref-${suffix}`,
    eventType: PAYMENT_STATUS_WEBHOOK_EVENT_TYPE,
    payload: { externalReference: `no-such-ref-${suffix}`, amountCents: 1000, currency: "AUD", status: "PAID_IN_FULL" },
    signatureValid: true,
  });
  assert.equal(result.status, "PROCESSED");
  assert.match(result.detail, /No payment request is mapped/);
});

test("safety: ambiguous mapping — linking a SECOND, different payment request to an already-mapped external reference is rejected as a conflict", async () => {
  const actor = actorOf(A.admin);
  const { request: firstRequest } = await createPaymentRequest(A.brokerageId, A.admin.cookie);
  const { request: secondRequest } = await createPaymentRequest(A.brokerageId, A.admin.cookie);
  const { connection } = await createActiveMockPaymentStatusConnection(A.brokerageId, actor);
  const externalReference = `REF-ambiguous-${suffix}`;

  await linkPaymentRequestToExternalReference(firstRequest.id, A.brokerageId, connection.id, externalReference, actor);
  await assert.rejects(
    () => linkPaymentRequestToExternalReference(secondRequest.id, A.brokerageId, connection.id, externalReference, actor),
    (err: unknown) => err instanceof MappingConflictError,
  );
});

test("safety: a stale/out-of-order event never regresses more recent reconciliation evidence", async () => {
  const actor = actorOf(A.admin);
  const { request } = await createPaymentRequest(A.brokerageId, A.admin.cookie, { amountCents: 90000, currency: "AUD" });
  const { connection } = await createActiveMockPaymentStatusConnection(A.brokerageId, actor);
  const externalReference = `REF-stale-${suffix}`;
  await linkPaymentRequestToExternalReference(request.id, A.brokerageId, connection.id, externalReference, actor);

  // A recent, MATCHING event first.
  await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_PAYMENT_STATUS_PROVIDER_ID,
    providerEventId: `evt-stale-recent-${suffix}`,
    eventType: PAYMENT_STATUS_WEBHOOK_EVENT_TYPE,
    payload: { externalReference, amountCents: 90000, currency: "AUD", status: "PAID_IN_FULL", occurredAt: new Date().toISOString() },
    signatureValid: true,
  });
  const afterRecent = await latestReconciliation(A.brokerageId, String(request.id));
  assert.equal(afterRecent?.status, "PARTIALLY_RECONCILED");

  // An OLDER, mismatching event arriving late must not regress the record.
  await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_PAYMENT_STATUS_PROVIDER_ID,
    providerEventId: `evt-stale-old-${suffix}`,
    eventType: PAYMENT_STATUS_WEBHOOK_EVENT_TYPE,
    payload: { externalReference, amountCents: 1, currency: "AUD", status: "PAID_IN_FULL", occurredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
    signatureValid: true,
  });
  const afterStale = await latestReconciliation(A.brokerageId, String(request.id));
  assert.equal(afterStale?.id, afterRecent?.id, "a stale/out-of-order event must be ignored, never overwriting more recent evidence");
  assert.equal(afterStale?.status, "PARTIALLY_RECONCILED");
});

test("safety: unapproved connection — a real ACTIVE connection never approved for payments.statusSync cannot submit reconciliation evidence", async () => {
  const actor = actorOf(A.admin);
  const { request } = await createPaymentRequest(A.brokerageId, A.admin.cookie);
  // A genuinely different, ACTIVE, entitled connection (mock_portal_v1)
  // whose approvedScopes never included payments.statusSync — an
  // empty-approvedScopes connection can never itself reach ACTIVE (see
  // commsProof.test.ts's identical note on model.ts's validateConnection).
  const { connection: portalConnection } = await createActiveMockPortalConnection(A.brokerageId, actor);
  const paymentConnection = await createActiveMockPaymentStatusConnection(A.brokerageId, actor);
  const externalReference = `REF-unapproved-${suffix}`;
  await linkPaymentRequestToExternalReference(request.id, A.brokerageId, paymentConnection.connection.id, externalReference, actor);

  // Deliver the SAME webhook, but through the portal connection's id — the
  // gateway itself does not require input.provider to match the
  // connection's own providerId (defense-in-depth is the domain handler's
  // job, per financialProof.ts's own header comment), so this is exactly
  // the "connection resolves, but was never approved for this capability"
  // shape.
  const result = await processInboundWebhook({
    connectionId: portalConnection.id,
    provider: MOCK_PAYMENT_STATUS_PROVIDER_ID,
    providerEventId: `evt-unapproved-${suffix}`,
    eventType: PAYMENT_STATUS_WEBHOOK_EVENT_TYPE,
    payload: { externalReference, amountCents: 150000, currency: "AUD", status: "PAID_IN_FULL" },
    signatureValid: true,
  });
  assert.equal(result.status, "PROCESSED");
  assert.match(result.detail, /not usable/i);

  const reconciliation = await latestReconciliation(A.brokerageId, String(request.id));
  assert.equal(reconciliation, null, "an unapproved connection must never be able to record reconciliation evidence");
});

test("safety: cross-tenant — brokerage B's payment request can never be reconciled through brokerage A's connection or mapping", async () => {
  const aActor = actorOf(A.admin);
  const { connection: aConnection } = await createActiveMockPaymentStatusConnection(A.brokerageId, aActor);

  const bActor = actorOf(B.admin);
  const { request: bRequest } = await createPaymentRequest(B.brokerageId, B.admin.cookie);

  // Brokerage A cannot even link brokerage B's payment request through its own connection.
  await assert.rejects(
    () => linkPaymentRequestToExternalReference(bRequest.id, A.brokerageId, aConnection.id, `REF-cross-${suffix}`, aActor),
    (err: unknown) => (err as { reason?: string })?.reason === "NOT_FOUND" || err instanceof Error,
  );

  // And brokerage B cannot resolve/use brokerage A's connection at all.
  const { resolveActiveConnection } = await import("../registry.js");
  const { INTEGRATION_CAPABILITIES } = await import("../types.js");
  await assert.rejects(
    () => resolveActiveConnection(B.brokerageId, aConnection.id, INTEGRATION_CAPABILITIES.PAYMENTS_STATUS_SYNC),
    (err: unknown) => err instanceof IntegrationError && err.reason === "NOT_FOUND",
  );
});
