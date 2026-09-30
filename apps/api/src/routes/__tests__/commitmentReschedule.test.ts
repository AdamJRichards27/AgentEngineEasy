// G-UAT-4 — reschedule an Open commitment by PATCH dueAt.
// One system_event grow_activities row records the previous and new times
// and the acting user. Status changes stay a separate request. Visibility
// is the same gate complete/cancel already use.
import { before, after, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, growActivities, growCommitments, users } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { DEFAULT_TIME_ZONE, startOfNextLocalDay } from "../../lib/commandCentre/timezone.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();

let admin: DevLoginResult;
let agentA: DevLoginResult;
let agentB: DevLoginResult;
let pitCrew: DevLoginResult;
let other: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let locked: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let brokerageId: number;
let propertyAId: number;
let propertyBId: number;
let partyId: number;

const GROW_KEYS = ["grow.access", "grow.activities.manage", "grow.contacts.read"] as const;

function tomorrowIso(): string {
  return new Date(startOfNextLocalDay(new Date(), DEFAULT_TIME_ZONE).getTime() + 12 * 60 * 60 * 1000).toISOString();
}

function overdueIso(): string {
  return new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
}

function headers(cookie: string, json = false): Record<string, string> {
  return json ? { cookie, "content-type": "application/json" } : { cookie };
}

async function send(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers: headers(cookie, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function grant(id: number, entitlementKey: string) {
  await db.insert(entitlementGrants).values({
    brokerageId: id,
    entitlementKey,
    granteeType: "brokerage",
    granteeId: id,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(id);
}

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await send("POST", "/properties", cookie, {
    formattedAddress: address,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { property: { id: number } }).property.id;
}

async function createParty(cookie: string, propertyId: number, name: string): Promise<number> {
  const res = await send("POST", "/parties", cookie, {
    propertyId,
    role: "Buyer",
    firstName: name,
    lastName: "Contact",
    email: `${name.toLowerCase()}-${suffix}@example.com`,
  });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { party: { id: number } }).party.id;
}

async function createCommitment(
  cookie: string,
  body: { description: string; dueAt: string; propertyId?: number },
): Promise<{ id: number; dueAt: string; status: string; propertyId: number | null }> {
  const res = await send("POST", `/grow/contacts/${partyId}/commitments`, cookie, body);
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { commitment: { id: number; dueAt: string; status: string; propertyId: number | null } }).commitment;
}

function patch(id: number, cookie: string, body: unknown) {
  return send("PATCH", `/grow/contacts/commitments/${id}`, cookie, body);
}

async function rescheduleRows(commitmentId: number) {
  const rows = await db
    .select()
    .from(growActivities)
    .where(and(eq(growActivities.brokerageId, brokerageId), eq(growActivities.activityType, "system_event")));
  return rows.filter((row) => {
    const details = row.details as { kind?: string; commitmentId?: number } | null;
    return details?.kind === "commitment_rescheduled" && details.commitmentId === commitmentId;
  });
}

describe("G-UAT-4 commitment reschedule", { concurrency: 1 }, () => {
  before(async () => {
    const { configureEvents } = await import("../../lib/events.js");
    configureEvents();
    const { createApp } = await import("../../app.js");
    server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected server address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const created = await createBrokerageWithUsers(baseUrl, `G-UAT-4 Reschedule ${suffix}`);
    admin = created.admin;
    agentA = created.agent;
    brokerageId = created.brokerageId;
    agentB = await devLogin(baseUrl, {
      email: `guat4-agent-b-${suffix}@example.com`,
      firstName: "Agent",
      lastName: "Bee",
      brokerageName: `G-UAT-4 Reschedule ${suffix}`,
    });
    pitCrew = await devLogin(baseUrl, {
      email: `guat4-pit-${suffix}@example.com`,
      firstName: "Pit",
      lastName: "Crew",
      brokerageName: `G-UAT-4 Reschedule ${suffix}`,
    });
    await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));
    pitCrew = { ...pitCrew, user: { ...pitCrew.user, role: "Pit Crew" } };

    other = await createBrokerageWithUsers(baseUrl, `G-UAT-4 Other ${suffix}`);
    locked = await createBrokerageWithUsers(baseUrl, `G-UAT-4 Locked ${suffix}`);

    for (const id of [brokerageId, other.brokerageId]) {
      for (const key of GROW_KEYS) await grant(id, key);
    }

    propertyAId = await createProperty(agentA.cookie, `${suffix} Agent A St`);
    propertyBId = await createProperty(agentB.cookie, `${suffix} Agent B St`);
    partyId = await createParty(agentA.cookie, propertyAId, "Casey");
  });

  after(async () => {
    await cleanupBrokerages([brokerageId, other?.brokerageId, locked?.brokerageId]);
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  test("reschedules an Open commitment and writes exactly one system_event", async () => {
    const created = await createCommitment(agentA.cookie, {
      description: "Call Casey",
      dueAt: overdueIso(),
      propertyId: propertyAId,
    });
    const next = tomorrowIso();
    const res = await patch(created.id, agentA.cookie, { dueAt: next });
    const body = (await res.json()) as { commitment: { status: string; dueAt: string; propertyId: number | null } };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.commitment.status, "Open");
    assert.equal(body.commitment.propertyId, propertyAId);
    assert.equal(new Date(body.commitment.dueAt).getTime(), new Date(next).getTime());

    const rows = await rescheduleRows(created.id);
    assert.equal(rows.length, 1, "exactly one reschedule activity");
    const row = rows[0]!;
    assert.equal(row.partyId, partyId);
    assert.equal(row.propertyId, propertyAId);
    assert.equal(row.responsibleUserId, agentA.user.id);
    assert.equal(row.activityType, "system_event");
    const details = row.details as {
      kind: string;
      commitmentId: number;
      previousDueAt: string;
      newDueAt: string;
      actingUserId: number;
    };
    assert.equal(details.kind, "commitment_rescheduled");
    assert.equal(details.commitmentId, created.id);
    assert.equal(new Date(details.previousDueAt).getTime(), new Date(created.dueAt).getTime());
    assert.equal(new Date(details.newDueAt).getTime(), new Date(next).getTime());
    assert.equal(details.actingUserId, agentA.user.id);
    assert.match(row.summary, /Commitment rescheduled from/);

    const completions = await db
      .select({ id: growActivities.id })
      .from(growActivities)
      .where(
        and(
          eq(growActivities.brokerageId, brokerageId),
          eq(growActivities.activityType, "task_completion"),
          eq(growActivities.partyId, partyId),
        ),
      );
    assert.equal(completions.length, 0, "a reschedule does not write a task_completion");
  });

  test("a past dueAt, including one before createdAt, is accepted", async () => {
    const created = await createCommitment(agentA.cookie, {
      description: "Still movable into the past",
      dueAt: tomorrowIso(),
    });
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const res = await patch(created.id, agentA.cookie, { dueAt: past });
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as { commitment: { dueAt: string } };
    assert.equal(new Date(body.commitment.dueAt).getTime(), new Date(past).getTime());
    assert.equal((await rescheduleRows(created.id)).length, 1);
  });

  test("Completed and Cancelled commitments cannot be rescheduled", async () => {
    const completed = await createCommitment(agentA.cookie, {
      description: "Already done",
      dueAt: tomorrowIso(),
    });
    assert.equal((await patch(completed.id, agentA.cookie, { status: "Completed" })).status, 200);
    const completedDue = tomorrowIso();
    const completedRes = await patch(completed.id, agentA.cookie, { dueAt: completedDue });
    assert.equal(completedRes.status, 409, await completedRes.clone().text());
    assert.equal((await rescheduleRows(completed.id)).length, 0);

    const cancelled = await createCommitment(agentA.cookie, {
      description: "Already cancelled",
      dueAt: tomorrowIso(),
    });
    assert.equal((await patch(cancelled.id, admin.cookie, { status: "Cancelled", cancelReason: "no longer needed" })).status, 200);
    const cancelledRes = await patch(cancelled.id, agentA.cookie, { dueAt: tomorrowIso() });
    assert.equal(cancelledRes.status, 409, await cancelledRes.clone().text());
    assert.equal((await rescheduleRows(cancelled.id)).length, 0);
  });

  test("an invalid timestamp is rejected, and status plus dueAt cannot be combined", async () => {
    const created = await createCommitment(agentA.cookie, {
      description: "Keep this due time",
      dueAt: tomorrowIso(),
    });
    for (const dueAt of ["not-a-date", "2027-06-01", "2027-06-01T00:00:00", 42, null]) {
      const res = await patch(created.id, agentA.cookie, { dueAt });
      assert.equal(res.status, 400, `dueAt ${JSON.stringify(dueAt)}: ${await res.clone().text()}`);
    }
    const combined = await patch(created.id, agentA.cookie, { status: "Completed", dueAt: tomorrowIso() });
    assert.equal(combined.status, 400, await combined.clone().text());
    const openStatus = await patch(created.id, agentA.cookie, { status: "Open" });
    assert.equal(openStatus.status, 400, await openStatus.clone().text());

    const [row] = await db.select().from(growCommitments).where(eq(growCommitments.id, created.id));
    assert.equal(row.status, "Open");
    assert.equal(new Date(row.dueAt).getTime(), new Date(created.dueAt).getTime());
    assert.equal((await rescheduleRows(created.id)).length, 0);
  });

  test("returns 403 without grow.activities.manage", async () => {
    const propertyId = await createProperty(locked.agent.cookie, `${suffix} Locked St`);
    const lockedPartyId = await createParty(locked.agent.cookie, propertyId, "Locked");
    const dueAt = new Date(tomorrowIso());
    const [inserted] = await db
      .insert(growCommitments)
      .values({
        brokerageId: locked.brokerageId,
        partyId: lockedPartyId,
        propertyId: null,
        description: "No key",
        dueAt,
        status: "Open",
        createdBy: locked.agent.user.id,
      })
      .returning({ id: growCommitments.id });
    const res = await patch(inserted.id, locked.agent.cookie, { dueAt: tomorrowIso() });
    assert.equal(res.status, 403, await res.clone().text());
    const [row] = await db.select().from(growCommitments).where(eq(growCommitments.id, inserted.id));
    assert.equal(new Date(row.dueAt).getTime(), dueAt.getTime());
    const activities = await db
      .select({ id: growActivities.id })
      .from(growActivities)
      .where(eq(growActivities.brokerageId, locked.brokerageId));
    assert.equal(activities.length, 0);
  });

  test("an Agent is blocked on another Agent's property-linked commitment", async () => {
    const created = await createCommitment(agentB.cookie, {
      description: "Agent B promise",
      dueAt: tomorrowIso(),
      propertyId: propertyBId,
    });
    const res = await patch(created.id, agentA.cookie, { dueAt: tomorrowIso() });
    assert.equal(res.status, 404, await res.clone().text());
    assert.deepEqual(await res.json(), { error: "Commitment not found in this brokerage" });
    const [row] = await db.select().from(growCommitments).where(eq(growCommitments.id, created.id));
    assert.equal(new Date(row.dueAt).getTime(), new Date(created.dueAt).getTime());
    assert.equal((await rescheduleRows(created.id)).length, 0);
  });

  test("an Agent can reschedule a commitment with no property", async () => {
    const created = await createCommitment(agentA.cookie, {
      description: "Contact-level promise",
      dueAt: overdueIso(),
    });
    assert.equal(created.propertyId, null);
    const next = tomorrowIso();
    const res = await patch(created.id, agentA.cookie, { dueAt: next });
    assert.equal(res.status, 200, await res.clone().text());
    const rows = await rescheduleRows(created.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.propertyId, null);
    assert.equal(rows[0]!.partyId, partyId);
  });

  test("an admin can reschedule a property-linked commitment in the brokerage", async () => {
    const created = await createCommitment(agentB.cookie, {
      description: "Admin may move this",
      dueAt: overdueIso(),
      propertyId: propertyBId,
    });
    const next = tomorrowIso();
    const res = await patch(created.id, admin.cookie, { dueAt: next });
    assert.equal(res.status, 200, await res.clone().text());
    const rows = await rescheduleRows(created.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.propertyId, propertyBId);
    assert.equal(rows[0]!.responsibleUserId, admin.user.id);
    const details = rows[0]!.details as { actingUserId: number };
    assert.equal(details.actingUserId, admin.user.id);
  });

  test("Pit Crew can reschedule a property-linked commitment in the brokerage", async () => {
    const created = await createCommitment(agentB.cookie, {
      description: "Pit crew may move this",
      dueAt: overdueIso(),
      propertyId: propertyBId,
    });
    const res = await patch(created.id, pitCrew.cookie, { dueAt: tomorrowIso() });
    assert.equal(res.status, 200, await res.clone().text());
    const rows = await rescheduleRows(created.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.responsibleUserId, pitCrew.user.id);
    assert.equal(rows[0]!.propertyId, propertyBId);
  });

  test("a cross-brokerage attempt is rejected", async () => {
    const created = await createCommitment(agentA.cookie, {
      description: "Stays in this brokerage",
      dueAt: tomorrowIso(),
    });
    const res = await patch(created.id, other.agent.cookie, { dueAt: tomorrowIso() });
    assert.equal(res.status, 404, await res.clone().text());
    const [row] = await db.select().from(growCommitments).where(eq(growCommitments.id, created.id));
    assert.equal(new Date(row.dueAt).getTime(), new Date(created.dueAt).getTime());
    assert.equal((await rescheduleRows(created.id)).length, 0);
    const foreign = await db
      .select({ id: growActivities.id })
      .from(growActivities)
      .where(eq(growActivities.brokerageId, other.brokerageId));
    assert.equal(foreign.length, 0);
  });

  test("an overdue commitment rescheduled to tomorrow leaves Overdue", async () => {
    const fresh = await createBrokerageWithUsers(baseUrl, `G-UAT-4 Today ${suffix}`);
    try {
      for (const key of GROW_KEYS) await grant(fresh.brokerageId, key);
      const propertyId = await createProperty(fresh.agent.cookie, `${suffix} Overdue St`);
      const freshParty = await createParty(fresh.agent.cookie, propertyId, "Overdue");
      const createRes = await send("POST", `/grow/contacts/${freshParty}/commitments`, fresh.agent.cookie, {
        description: "Was overdue",
        dueAt: overdueIso(),
        propertyId,
      });
      assert.equal(createRes.status, 201, await createRes.clone().text());
      const commitmentId = ((await createRes.json()) as { commitment: { id: number } }).commitment.id;

      const before = await send("GET", "/grow/today", fresh.agent.cookie);
      assert.equal(before.status, 200, await before.clone().text());
      const beforeBody = (await before.json()) as { priorityActions: Array<{ id: string; priority: string; reason: string }> };
      const beforeCard = beforeBody.priorityActions.find((action) => action.id === `commitment:${commitmentId}`);
      assert.ok(beforeCard, "the overdue commitment is on Today");
      assert.equal(beforeCard.priority, "DoNow");
      assert.match(beforeCard.reason, /was due/);

      const next = tomorrowIso();
      const rescheduled = await send("PATCH", `/grow/contacts/commitments/${commitmentId}`, fresh.agent.cookie, { dueAt: next });
      assert.equal(rescheduled.status, 200, await rescheduled.clone().text());

      const after = await send("GET", "/grow/today", fresh.agent.cookie);
      assert.equal(after.status, 200, await after.clone().text());
      const afterBody = (await after.json()) as { priorityActions: Array<{ id: string }> };
      assert.equal(
        afterBody.priorityActions.some((action) => action.id === `commitment:${commitmentId}`),
        false,
        "tomorrow is no longer overdue or due today, so the card leaves Today",
      );
    } finally {
      await cleanupBrokerages([fresh.brokerageId]);
    }
  });
});
