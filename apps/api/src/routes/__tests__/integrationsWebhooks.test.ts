// Agent Engine 2.0 — Step 2: Security & Observability Hardening (Part C —
// typed-error-handling audit).
//
// POST /api/integrations/webhooks/:connectionId/:provider had NO existing
// HTTP-level test coverage at all before this file — lib/integrations/
// __tests__ exercises processInboundWebhook() directly (bypassing the
// route), and no test anywhere drove a request through this actual URL.
// This file closes that gap AND proves the specific fix this audit pass
// made here.
//
// The real, trivially-reachable bug this proves is fixed: connectionId is
// read straight from the URL path and compared against a `uuid` column
// (integration_connections.id) with no format pre-check. A non-UUID-shaped
// connectionId — anything an unauthenticated caller (this route is
// mounted outside requireAuth by design, same as every inbound-webhook
// router) types into the URL — makes Postgres throw a raw
// "invalid input syntax for type uuid" error, which is a plain Error, not
// an IntegrationError. Before this pass's fix, the route's catch block
// returned ANY caught Error's own `.message` to the caller, meaning that
// raw database error text was directly exposed. Now: only a recognised
// IntegrationError's own deliberately-safe message is echoed back; every
// other error (like this one) gets a generic message, with full detail
// logged server-side instead.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { bootstrapIntegrationsForTesting } from "../../lib/integrations/__tests__/testHelpers.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;

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
  await bootstrapIntegrationsForTesting();
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("an oversized raw body is rejected 413 before any parsing", async () => {
  const res = await fetch(`${baseUrl}/api/integrations/webhooks/00000000-0000-0000-0000-000000000000/mock_portal_v1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerEventId: "x".repeat(300_000), eventType: "TEST", payload: {} }),
  });
  assert.equal(res.status, 413);
});

test("a schema-invalid body (missing required fields) is rejected 400 with zod's own flattened error, unaffected by this pass's error-handling change", async () => {
  const res = await fetch(`${baseUrl}/api/integrations/webhooks/00000000-0000-0000-0000-000000000000/mock_portal_v1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ notTheRightShape: true }),
  });
  assert.equal(res.status, 400);
});

test("an unknown but validly-shaped UUID connectionId surfaces IntegrationError's own safe NOT_FOUND message, unchanged by this pass's fix (IntegrationError is still echoed back deliberately)", async () => {
  const res = await fetch(`${baseUrl}/api/integrations/webhooks/00000000-0000-0000-0000-000000000000/mock_portal_v1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerEventId: "evt-1", eventType: "TEST", payload: {} }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Unknown integration connection.");
});

test("a non-UUID-shaped connectionId — trivially reachable by any caller, since this route is unauthenticated by design — no longer leaks the raw Postgres 'invalid input syntax for type uuid' error, the real bug this pass's fix closes", async () => {
  const res = await fetch(`${baseUrl}/api/integrations/webhooks/not-a-uuid-at-all/mock_portal_v1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerEventId: "evt-2", eventType: "TEST", payload: {} }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Webhook processing failed.", "must be the generic fallback message, never the raw database error text");
  assert.doesNotMatch(body.error, /uuid|syntax|postgres|invalid input/i, "must never leak the underlying database error's own wording");
});
