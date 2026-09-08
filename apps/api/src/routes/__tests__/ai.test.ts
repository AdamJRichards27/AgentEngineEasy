// AE GROW Priority 0.5 Final Verification and Priority 1 Entry Gate — regression
// coverage for a defect the real CI pipeline (not static review) surfaced: GET
// /ai/capabilities called resolveBrokerageTier() (async since Workstream 4 - see
// lib/ai/entitlements.ts) without awaiting it, so `tier` was left as an
// unresolved Promise. TIER_CAPABILITIES[tier] in isRoleEntitled() then indexed
// the lookup table with a Promise object, resolved to undefined, and threw on
// `.roles` - turning every real request to this route into a 500. Only a
// typecheck run against the real pnpm/tsc toolchain caught this (the exact
// point of this verification gate); lib/ai/__tests__/entitlements.test.ts only
// ever tested resolveBrokerageTier() directly, never through this route.
//
// Follows the same real-HTTP-request pattern as routes/__tests__/ai-actions.test.ts
// (spins up the real app via createApp(), exercises it over HTTP with a real
// session cookie) so a future regression here fails a real request the same way
// it would in production, not just a type check.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageName = `AI Capabilities Route Test ${suffix}`;
let brokerage: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

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

  brokerage = await createBrokerageWithUsers(baseUrl, brokerageName);
});

after(async () => {
  await cleanupBrokerages([brokerage?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("GET /api/ai/capabilities returns a real, resolved tier - not an unawaited Promise", async () => {
  const res = await fetch(`${baseUrl}/api/ai/capabilities`, { headers: { cookie: brokerage.agent.cookie } });
  assert.equal(
    res.status,
    200,
    `expected 200, got ${res.status} - an unawaited resolveBrokerageTier() call throws inside isRoleEntitled() and Express turns that into a 500`,
  );
  const body = (await res.json()) as { tier: unknown; copilotEnabled: unknown };
  assert.ok(
    body.tier === "STARTER" || body.tier === "GROW" || body.tier === "PRO",
    `tier must be a real resolved SubscriptionTier string, got ${JSON.stringify(body.tier)}`,
  );
  assert.equal(typeof body.copilotEnabled, "boolean");
});

test("GET /api/ai/capabilities requires authentication", async () => {
  const res = await fetch(`${baseUrl}/api/ai/capabilities`);
  assert.equal(res.status, 401);
});
