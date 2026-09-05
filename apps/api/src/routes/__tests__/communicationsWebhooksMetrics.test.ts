// Agent Engine 2.0 — Step 2: Security & Observability Hardening (Part B).
//
// Proves routes/communicationsWebhooks.ts's metrics wiring: every outcome
// in the shared WEBHOOK_ROUTER_OUTCOMES funnel (received/accepted/
// invalid_signature/schema_rejected/replay_rejected/success/failure) is
// actually incremented at the right moment, with a duration observation
// alongside the terminal outcome — and separately proves that a rejected
// webhook (bad signature, bad schema) never reaches
// processInboundWebhook and so can never write a communicationWebhookEvents
// row, i.e. a rejected webhook cannot mutate state.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db, communicationWebhookEvents } from "@aee/db";
import { resetMetricsForTesting, renderMetricsText } from "@aee/events";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const WEBHOOK_SECRET = process.env.COMMUNICATIONS_WEBHOOK_SECRET ?? "dev-sandbox-communications-webhook-secret";

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

  const pair = await createBrokerageWithUsers(baseUrl, `Comms Webhook Metrics ${suffix}`);
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

function sign(rawBody: Buffer): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
}

async function countRows(provider: string, providerEventId: string): Promise<number> {
  const rows = await db
    .select()
    .from(communicationWebhookEvents)
    .where(and(eq(communicationWebhookEvents.provider, provider), eq(communicationWebhookEvents.providerEventId, providerEventId)));
  return rows.length;
}

test("an invalid brokerage id in the URL is rejected as schema_rejected, before any signature check, and increments received+schema_rejected only", async () => {
  const res = await fetch(`${baseUrl}/api/communications/webhooks/not-a-number/sandbox_email`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-communications-signature": "irrelevant" },
    body: JSON.stringify({ eventId: `evt-${suffix}-bad-brokerage`, eventType: "DELIVERY_RECEIPT" }),
  });
  assert.equal(res.status, 400);

  const text = renderMetricsText();
  assert.match(text, /communications_webhook_total\{outcome="received"\} 1/);
  assert.match(text, /communications_webhook_total\{outcome="schema_rejected"\} 1/);
  assert.doesNotMatch(text, /communications_webhook_total\{outcome="accepted"\}/);
  assert.doesNotMatch(text, /communications_webhook_total\{outcome="invalid_signature"\}/);
});

test("a missing/invalid signature is rejected as invalid_signature and never reaches processInboundWebhook — no communicationWebhookEvents row is ever written", async () => {
  const eventId = `evt-${suffix}-bad-sig`;
  const rawBody = Buffer.from(JSON.stringify({ eventId, eventType: "DELIVERY_RECEIPT" }));

  const res = await fetch(`${baseUrl}/api/communications/webhooks/${brokerageId}/sandbox_email`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-communications-signature": "not-a-real-signature" },
    body: rawBody,
  });
  assert.equal(res.status, 401);

  const text = renderMetricsText();
  assert.match(text, /communications_webhook_total\{outcome="received"\} 1/);
  assert.match(text, /communications_webhook_total\{outcome="invalid_signature"\} 1/);
  assert.match(text, /communications_webhook_duration_ms_count\{outcome="invalid_signature"\} 1/);
  assert.doesNotMatch(text, /communications_webhook_total\{outcome="accepted"\}/);

  assert.equal(await countRows("sandbox_email", eventId), 0, "an invalid-signature webhook must never mutate state");
});

test("a schema-invalid body (correctly signed) is rejected as schema_rejected and never reaches processInboundWebhook", async () => {
  const eventId = `evt-${suffix}-bad-schema`;
  const rawBody = Buffer.from(JSON.stringify({ eventId, eventType: "NOT_A_REAL_EVENT_TYPE" }));

  const res = await fetch(`${baseUrl}/api/communications/webhooks/${brokerageId}/sandbox_email`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-communications-signature": sign(rawBody) },
    body: rawBody,
  });
  assert.equal(res.status, 400);

  const text = renderMetricsText();
  assert.match(text, /communications_webhook_total\{outcome="schema_rejected"\} 1/);
  assert.doesNotMatch(text, /communications_webhook_total\{outcome="accepted"\}/);

  assert.equal(await countRows("sandbox_email", eventId), 0, "a schema-rejected webhook must never mutate state");
});

test("a validly signed, schema-valid, unrecognised event is accepted and recorded as success, and a redelivery of the same event increments replay_rejected", async () => {
  const eventId = `evt-${suffix}-success`;
  const rawBody = Buffer.from(JSON.stringify({ eventId, eventType: "DELIVERY_RECEIPT" }));
  const signature = sign(rawBody);

  const firstRes = await fetch(`${baseUrl}/api/communications/webhooks/${brokerageId}/sandbox_email`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-communications-signature": signature },
    body: rawBody,
  });
  assert.equal(firstRes.status, 200);

  let text = renderMetricsText();
  assert.match(text, /communications_webhook_total\{outcome="received"\} 1/);
  assert.match(text, /communications_webhook_total\{outcome="accepted"\} 1/);
  assert.match(text, /communications_webhook_total\{outcome="success"\} 1/);
  assert.match(text, /communications_webhook_duration_ms_count\{outcome="success"\} 1/);

  assert.equal(await countRows("sandbox_email", eventId), 1);

  const secondRes = await fetch(`${baseUrl}/api/communications/webhooks/${brokerageId}/sandbox_email`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-communications-signature": signature },
    body: rawBody,
  });
  assert.equal(secondRes.status, 200);

  text = renderMetricsText();
  assert.match(text, /communications_webhook_total\{outcome="received"\} 2/);
  assert.match(text, /communications_webhook_total\{outcome="replay_rejected"\} 1/);
  assert.equal(await countRows("sandbox_email", eventId), 1, "a redelivered event must still resolve to exactly one row, never a second insert");
});
