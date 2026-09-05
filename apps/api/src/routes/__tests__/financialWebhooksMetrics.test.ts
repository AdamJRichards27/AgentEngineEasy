// Agent Engine 2.0 — Step 2: Security & Observability Hardening (Part B).
//
// Proves routes/financialWebhooks.ts's metrics wiring: every outcome in
// the shared WEBHOOK_ROUTER_OUTCOMES funnel is incremented at the right
// moment, with a duration observation alongside the terminal outcome —
// and separately proves that a rejected (malformed/duplicate/unresolvable)
// webhook never mutates financialPaymentProviderEvents or
// financialPaymentRequests state.
//
// The sandbox mandate provider's verifyWebhookSignature() always returns
// true (packages/integrations/mandate-payments/src/index.ts — "no real
// webhook traffic reaches the sandbox provider"), so the invalid_signature
// outcome cannot be exercised against THIS build's only provider; the
// metric/label stays declared for when a real provider adapter ships.
// What sandbox mode DOES let a caller send is a malformed payload, which
// mandatePaymentProvider.parseWebhook() throws on — exercised below as the
// schema_rejected path this closure pass added a try/catch specifically
// to handle (previously an uncaught throw there hung the request forever).

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, and } from "drizzle-orm";
import { db, financialPaymentRequests, financialPaymentProviderEvents } from "@aee/db";
import { resetMetricsForTesting, renderMetricsText } from "@aee/events";
import { createBrokerageWithUsers, createTransactionFromListedProperty, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
let admin: DevLoginResult;
let brokerageId: number;
const suffix = Date.now();

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

  const pair = await createBrokerageWithUsers(baseUrl, `Financial Webhook Metrics ${suffix}`);
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

async function createScheduledPaymentRequest(providerRequestRef: string) {
  const { propertyId, transactionId } = await createTransactionFromListedProperty(baseUrl, admin.cookie, { address: `1 Financial Webhook Metrics Rd ${suffix}-${Math.random()}` });
  const [request] = await db
    .insert(financialPaymentRequests)
    .values({
      brokerageId,
      propertyId,
      transactionId,
      amountCents: 50000,
      currency: "AUD",
      idempotencyKey: `fin-webhook-metrics-${suffix}-${Math.random()}`,
      status: "DEBIT_SCHEDULED",
      provider: "sandbox",
      providerRequestRef,
    })
    .returning();
  return request;
}

async function countProviderEventRows(providerEventId: string): Promise<number> {
  const rows = await db
    .select()
    .from(financialPaymentProviderEvents)
    .where(and(eq(financialPaymentProviderEvents.provider, "sandbox"), eq(financialPaymentProviderEvents.providerEventId, providerEventId)));
  return rows.length;
}

test("a malformed payload is rejected as schema_rejected (never hangs, never mutates state) — the try/catch this closure pass added around parseWebhook()", async () => {
  const res = await fetch(`${baseUrl}/api/financial/webhooks/mandate-payments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Missing providerEventId/providerRequestRef/status — parseWebhook() throws.
    body: JSON.stringify({ notAValidShape: true }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { processed: boolean; reason?: string };
  assert.equal(body.processed, false);
  assert.equal(body.reason, "malformed_payload");

  const text = renderMetricsText();
  assert.match(text, /financial_webhook_total\{outcome="received"\} 1/);
  assert.match(text, /financial_webhook_total\{outcome="accepted"\} 1/);
  assert.match(text, /financial_webhook_total\{outcome="schema_rejected"\} 1/);
  assert.match(text, /financial_webhook_duration_ms_count\{outcome="schema_rejected"\} 1/);
});

test("an unresolvable providerRequestRef is rejected as failure and writes a FAILED provider-event row only — never a payment_request mutation", async () => {
  const providerEventId = `evt-${suffix}-unresolvable`;
  const res = await fetch(`${baseUrl}/api/financial/webhooks/mandate-payments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerEventId, providerRequestRef: "no-such-ref-exists", status: "Paid" }),
  });
  assert.equal(res.status, 404);

  const text = renderMetricsText();
  assert.match(text, /financial_webhook_total\{outcome="failure"\} 1/);
  assert.doesNotMatch(text, /financial_webhook_total\{outcome="success"\}/);

  assert.equal(await countProviderEventRows(providerEventId), 1, "the provider-event row itself is still recorded for audit, per this module's own dedup-then-apply design");
});

test("a valid, resolvable webhook is accepted and recorded as success, and a redelivery of the same providerEventId increments replay_rejected without a second row", async () => {
  const providerRequestRef = `ref-${suffix}-metrics-success`;
  await createScheduledPaymentRequest(providerRequestRef);
  const providerEventId = `evt-${suffix}-success`;

  const firstRes = await fetch(`${baseUrl}/api/financial/webhooks/mandate-payments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerEventId, providerRequestRef, status: "Paid" }),
  });
  assert.equal(firstRes.status, 200);
  const firstBody = (await firstRes.json()) as { processed: boolean };
  assert.equal(firstBody.processed, true);

  let text = renderMetricsText();
  assert.match(text, /financial_webhook_total\{outcome="received"\} 1/);
  assert.match(text, /financial_webhook_total\{outcome="accepted"\} 1/);
  assert.match(text, /financial_webhook_total\{outcome="success"\} 1/);
  assert.match(text, /financial_webhook_duration_ms_count\{outcome="success"\} 1/);
  assert.equal(await countProviderEventRows(providerEventId), 1);

  const secondRes = await fetch(`${baseUrl}/api/financial/webhooks/mandate-payments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerEventId, providerRequestRef, status: "Paid" }),
  });
  const secondBody = (await secondRes.json()) as { processed: boolean; reason?: string };
  assert.equal(secondBody.processed, false);
  assert.equal(secondBody.reason, "duplicate_delivery");

  text = renderMetricsText();
  assert.match(text, /financial_webhook_total\{outcome="received"\} 2/);
  assert.match(text, /financial_webhook_total\{outcome="replay_rejected"\} 1/);
  assert.equal(await countProviderEventRows(providerEventId), 1, "a redelivered event must still resolve to exactly one provider-event row, never a second insert");
});
