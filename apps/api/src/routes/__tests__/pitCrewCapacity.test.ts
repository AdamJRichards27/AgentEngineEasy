// GET /api/pit-crew/capacity (Owner t165u D4): warning-only capacity view.
// Same gate as /pit-crew/team (Pit Crew + Brokerage Administrator, run.access);
// counts CLAIMED / IN_PROGRESS / WAITING_ON per member; never blocks a claim.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, pitCrewAssignments, users } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let busy: DevLoginResult;
let light: DevLoginResult;
let bCrew: DevLoginResult;
let propertyId: number;
let bPropertyId: number;
let seq = 0;

async function makePitCrew(name: string, brokerageName: string): Promise<DevLoginResult> {
  const r = await devLogin(baseUrl, { email: `${name}-${suffix}@example.com`, firstName: name, lastName: "Crew", brokerageName });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, r.user.id));
  return r;
}

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { property: { id: number } }).property.id;
}

async function addAssignments(brokerageId: number, property: number, userId: number, status: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    seq += 1;
    await db.insert(pitCrewAssignments).values({ brokerageId, sourceType: "EXCEPTION", sourceRecordId: `cap-${suffix}-${seq}`, propertyId: property, status, assignedToUserId: userId });
  }
}

async function capacity(cookie: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/pit-crew/capacity`, { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

type Member = { userId: number; activeAssignments: number; warning: boolean };

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `PC Capacity A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `PC Capacity B ${suffix}`);
  busy = await makePitCrew("busy", `PC Capacity A ${suffix}`);
  light = await makePitCrew("light", `PC Capacity A ${suffix}`);
  bCrew = await makePitCrew("bcrew", `PC Capacity B ${suffix}`);
  propertyId = await createProperty(A.agent.cookie, `5 Capacity St ${suffix}, Testville`);
  bPropertyId = await createProperty(B.agent.cookie, `6 Capacity St ${suffix}, Testville`);
  // busy: 12 active (5 CLAIMED, 4 IN_PROGRESS, 3 WAITING_ON) plus inactive rows that must not count.
  await addAssignments(A.brokerageId, propertyId, busy.user.id, "CLAIMED", 5);
  await addAssignments(A.brokerageId, propertyId, busy.user.id, "IN_PROGRESS", 4);
  await addAssignments(A.brokerageId, propertyId, busy.user.id, "WAITING_ON", 3);
  await addAssignments(A.brokerageId, propertyId, busy.user.id, "DONE", 6);
  await addAssignments(A.brokerageId, propertyId, light.user.id, "IN_PROGRESS", 11);
  await addAssignments(B.brokerageId, bPropertyId, bCrew.user.id, "CLAIMED", 20);
});

after(async () => {
  delete process.env.PIT_CREW_CAPACITY_WARNING_THRESHOLD;
  await db.delete(pitCrewAssignments).where(eq(pitCrewAssignments.propertyId, propertyId));
  await db.delete(pitCrewAssignments).where(eq(pitCrewAssignments.propertyId, bPropertyId));
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("default threshold 12: warning at 12 active, not at 11; DONE never counts; warning-only, non-blocking", async () => {
  delete process.env.PIT_CREW_CAPACITY_WARNING_THRESHOLD;
  const r = await capacity(A.admin.cookie);
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, "WARNING_ONLY");
  assert.equal(r.body.blocking, false);
  assert.equal(r.body.threshold, 12);
  assert.equal(r.body.thresholdSource, "default");
  const members = r.body.members as Member[];
  const b = members.find((m) => m.userId === busy.user.id)!;
  const l = members.find((m) => m.userId === light.user.id)!;
  assert.deepEqual([b.activeAssignments, b.warning], [12, true]);
  assert.deepEqual([l.activeAssignments, l.warning], [11, false]);
  assert.equal(r.body.membersWithWarning, 1);
});

test("configurable: PIT_CREW_CAPACITY_WARNING_THRESHOLD changes the threshold", async () => {
  process.env.PIT_CREW_CAPACITY_WARNING_THRESHOLD = "11";
  try {
    const r = await capacity(busy.cookie);
    assert.equal(r.status, 200);
    assert.equal(r.body.threshold, 11);
    assert.equal(r.body.thresholdSource, "config");
    assert.equal(r.body.membersWithWarning, 2);
  } finally {
    delete process.env.PIT_CREW_CAPACITY_WARNING_THRESHOLD;
  }
});

test("tenant: only the caller's brokerage members are listed", async () => {
  const r = await capacity(A.admin.cookie);
  const ids = (r.body.members as Member[]).map((m) => m.userId);
  assert.ok(!ids.includes(bCrew.user.id));
  const rb = await capacity(B.admin.cookie);
  assert.deepEqual((rb.body.members as Member[]).map((m) => m.userId), [bCrew.user.id]);
});

test("gates: Agent 403, unauthenticated 401, run.access revoked 403", async () => {
  assert.equal((await capacity(A.agent.cookie)).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/pit-crew/capacity`)).status, 401);
  await db.update(entitlementGrants).set({ status: "Revoked" }).where(and(eq(entitlementGrants.brokerageId, A.brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(A.brokerageId);
  try {
    const r = await capacity(A.admin.cookie);
    assert.equal(r.status, 403);
    assert.equal(r.body.entitlementKey, "run.access");
  } finally {
    await db.update(entitlementGrants).set({ status: "Active" }).where(and(eq(entitlementGrants.brokerageId, A.brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
    invalidateEntitlementCache(A.brokerageId);
  }
});
