import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { db, transactionConditions } from "@aee/db";
import {
  createBrokerageWithUsers,
  createTransactionFromListedProperty,
  devLogin,
  cleanupBrokerages,
  type DevLoginResult,
} from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let agent2: DevLoginResult;
let propertyId: number;
let conditionId: number;

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

  A = await createBrokerageWithUsers(baseUrl, `Command Centre Route ${suffix}`);
  agent2 = await devLogin(baseUrl, {
    email: `cc-route-agent2-${suffix}@example.com`,
    firstName: "Route",
    lastName: "Second",
    brokerageName: `Command Centre Route ${suffix}`,
  });

  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `2 Command Centre Route St ${suffix}`,
  });
  propertyId = created.propertyId;
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const [cond] = await db
    .insert(transactionConditions)
    .values({
      transactionId: created.transactionId,
      description: `Route test condition ${suffix}`,
      dueDate: twoDaysAgo,
      status: "Pending",
    })
    .returning();
  conditionId = cond.id;
});

after(async () => {
  const ids = [A?.brokerageId].filter((id): id is number => typeof id === "number");
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("GET /api/command-centre", () => {
  test("unauthenticated requests are rejected", async () => {
    const res = await fetch(`${baseUrl}/api/command-centre`);
    assert.equal(res.status, 401);
  });

  test("an authenticated agent gets 200 with their own overdue item, wired through requireAuth + the shared scoping helpers", async () => {
    const res = await fetch(`${baseUrl}/api/command-centre`, { headers: { cookie: A.agent.cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      agent: { id: number; firstName: string; role: string };
      timeZone: string;
      timeZoneSource: string;
      overdue: Array<{ sourceRecordId: string; sourceType: string; propertyId: number; id: string }>;
    };
    assert.equal(body.agent.id, A.agent.user.id);
    assert.equal(body.timeZone, "Australia/Brisbane");
    assert.equal(body.timeZoneSource, "fallback");
    const found = body.overdue.find((i) => i.sourceRecordId === String(conditionId));
    assert.ok(found, "expected the route to surface the agent's own overdue condition");
    assert.equal(found!.propertyId, propertyId);
    assert.equal(found!.sourceType, "CONTRACT_MILESTONE");
  });

  test("a peer agent in the same brokerage does not see another agent's item through the route", async () => {
    const res = await fetch(`${baseUrl}/api/command-centre`, { headers: { cookie: agent2.cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { overdue: Array<{ sourceRecordId: string }> };
    assert.ok(!body.overdue.some((i) => i.sourceRecordId === String(conditionId)));
  });
});
