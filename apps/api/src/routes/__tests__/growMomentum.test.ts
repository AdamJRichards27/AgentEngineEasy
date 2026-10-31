import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { db, entitlementGrants, growActivities } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

// CC #5 / SPEC-01: GET /grow/momentum — flag gate, privacy, tenant isolation, read-only.

let server: Server;
let baseUrl: string;
const suffix = Date.now();
type B = { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let A: B;
let OTHER: B;
const cleanupIds: number[] = [];
const prevFlag = process.env.GROW_MOMENTUM_ENABLED;

async function grant(brokerageId: number, key: string) {
  await db.insert(entitlementGrants).values({ brokerageId, entitlementKey: key, granteeType: "brokerage", granteeId: brokerageId, sourceType: "manual", status: "Active" });
  invalidateEntitlementCache(brokerageId);
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `Momentum A ${suffix}`);
  OTHER = await createBrokerageWithUsers(baseUrl, `Momentum Other ${suffix}`);
  cleanupIds.push(A.brokerageId, OTHER.brokerageId);
  await grant(A.brokerageId, "grow.access");
  await grant(OTHER.brokerageId, "grow.access");
  const at = new Date();
  const rows = [
    // A.agent: 2 conversations with different contacts (12 pts)
    { brokerageId: A.brokerageId, responsibleUserId: A.agent.user.id, activityType: "meeting", summary: "m1", occurredAt: at },
    { brokerageId: A.brokerageId, responsibleUserId: A.agent.user.id, activityType: "meeting", summary: "m2", occurredAt: at, sourceId: `x-${suffix}` },
    // A.admin (same brokerage, different agent): must not leak into A.agent's private score
    { brokerageId: A.brokerageId, responsibleUserId: A.admin.user.id, activityType: "meeting", summary: "admin", occurredAt: at },
    // OTHER brokerage
    { brokerageId: OTHER.brokerageId, responsibleUserId: OTHER.agent.user.id, activityType: "meeting", summary: "o", occurredAt: at },
  ];
  await db.insert(growActivities).values(rows);
});

after(async () => {
  if (prevFlag === undefined) delete process.env.GROW_MOMENTUM_ENABLED;
  else process.env.GROW_MOMENTUM_ENABLED = prevFlag;
  await cleanupBrokerages(cleanupIds);
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});

const get = (cookie: string, q = "") => fetch(`${baseUrl}/api/grow/momentum${q}`, { headers: { cookie } });

test("flag OFF: endpoint does not exist (404)", async () => {
  delete process.env.GROW_MOMENTUM_ENABLED;
  assert.equal((await get(A.agent.cookie)).status, 404);
  process.env.GROW_MOMENTUM_ENABLED = "1";
  assert.equal((await get(A.agent.cookie)).status, 404);
});

test("flag ON: agent sees only their own private score (no other agent, no other brokerage)", async () => {
  process.env.GROW_MOMENTUM_ENABLED = "true";
  const res = await get(A.agent.cookie);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { private: boolean; rulesVersion: string; score: number; categories: { key: string; count: number }[]; trend: unknown[]; streakDays: number };
  assert.equal(body.private, true);
  assert.equal(body.rulesVersion, "momentum-v1");
  assert.equal(body.categories.find((c) => c.key === "connectedConversation")!.count, 2);
  assert.equal(body.score, 12);
  assert.equal(body.trend.length, 4);
  assert.ok(body.streakDays >= 1);
  assert.ok(!("leaderboard" in body) && !("rank" in body));

  const admin = (await (await get(A.admin.cookie)).json()) as { score: number };
  assert.equal(admin.score, 6);
  const other = (await (await get(OTHER.agent.cookie)).json()) as { score: number };
  assert.equal(other.score, 6);
});

test("month period returns 6-point trend; bad period is 400; no grow.access is 403", async () => {
  process.env.GROW_MOMENTUM_ENABLED = "true";
  const m = (await (await get(A.agent.cookie, "?period=month")).json()) as { trend: unknown[] };
  assert.equal(m.trend.length, 6);
  assert.equal((await get(A.agent.cookie, "?period=year")).status, 400);
  const NOG = await createBrokerageWithUsers(baseUrl, `Momentum NoGrow ${suffix}`);
  cleanupIds.push(NOG.brokerageId);
  assert.equal((await get(NOG.agent.cookie)).status, 403);
});

test("unauthenticated is 401 when ON", async () => {
  process.env.GROW_MOMENTUM_ENABLED = "true";
  assert.equal((await fetch(`${baseUrl}/api/grow/momentum`)).status, 401);
});
