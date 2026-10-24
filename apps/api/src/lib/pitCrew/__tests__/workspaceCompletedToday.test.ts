// PC-B (P-01): Pit Crew "Completed Today" uses the brokerage-local
// calendar day, not the UTC day. Zone: communication_settings.time_zone
// when it is a valid IANA zone, otherwise Australia/Brisbane (the same
// Section 12 rule the Command Centre uses), resolved with Pit Crew's own
// helpers (no lib/commandCentre import). getPitCrewWorkspace takes an
// optional { now } so these tests can pin the clock; the route passes none.
// Pit Crew feature flags stay off.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { communicationSettings, db, pitCrewAssignments, users } from "@aee/db";
import { createOrUpdateException, newCorrelationId } from "../../exceptions/model.js";
import type { RiskFinding } from "../../exceptions/types.js";
import { getPitCrewWorkspace } from "../queries.js";
import { claimWorkItem, completeWorkItem } from "../assignment.js";
import { isSamePitCrewLocalDay, resolvePitCrewDayTimeZone } from "../waitingOnDetection.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin } from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

interface Tenant {
  brokerageId: number;
  propertyId: number;
  pitCrewUserId: number;
}

let server: Server;
let baseUrl: string;
let brisbane: Tenant; // no communication_settings row -> fallback Australia/Brisbane
let perth: Tenant; // time_zone = Australia/Perth
let invalid: Tenant; // time_zone = Not/AZone -> fallback Australia/Brisbane
let fixtureCounter = 0;

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "QLD", suburb: "Testville", postcode: "4000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

async function tenant(label: string, stamp: number): Promise<Tenant> {
  const created = await createBrokerageWithUsers(baseUrl, `PCB ${label} ${stamp}`);
  const propertyId = await createProperty(created.agent.cookie, `1 ${label} St`);
  const crew = await devLogin(baseUrl, {
    email: `pcb-crew-${label.toLowerCase()}-${stamp}@example.com`,
    firstName: "Pat",
    lastName: label,
    brokerageName: created.admin.user.brokerageName!,
  });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, crew.user.id));
  return { brokerageId: created.brokerageId, propertyId, pitCrewUserId: crew.user.id };
}

// One exception, claimed and completed by Pit Crew, with completedAt pinned.
async function completedAt(t: Tenant, iso: string): Promise<string> {
  fixtureCounter += 1;
  const finding: RiskFinding = {
    ruleId: "TEST_PITCREW_COMPLETED_TODAY_RULE",
    ruleVersion: 1,
    category: "WORKFLOW_OPERATIONAL",
    severity: "ATTENTION",
    title: `Completed today finding ${fixtureCounter}`,
    problemDescription: "A test problem.",
    businessImpact: "Test impact.",
    detectedCause: "Test cause.",
    ownerType: "PIT_CREW",
    ownerUserId: null,
    propertyId: t.propertyId,
    transactionId: null,
    dueAt: null,
    escalatesAt: null,
    recommendedAction: "Do the test thing.",
    resolutionRequirements: "The test condition clears.",
    dismissible: true,
    sourceRecordType: "property",
    sourceRecordId: String(t.propertyId),
    dedupKey: `TEST_PITCREW_COMPLETED_TODAY_RULE:${t.brokerageId}:PCB_${fixtureCounter}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
  };
  const { exception } = await createOrUpdateException(finding, t.brokerageId, t.propertyId, null, newCorrelationId(), null);
  const ref = { brokerageId: t.brokerageId, propertyId: t.propertyId, sourceType: "EXCEPTION" as const, sourceRecordId: exception.id, actorUserId: t.pitCrewUserId };
  const claimed = await claimWorkItem({ ...ref, expectedVersion: 0 });
  await completeWorkItem({ ...ref, expectedVersion: claimed.version });
  await db
    .update(pitCrewAssignments)
    .set({ completedAt: new Date(iso) })
    .where(and(eq(pitCrewAssignments.sourceType, "EXCEPTION"), eq(pitCrewAssignments.sourceRecordId, exception.id)));
  return exception.id;
}

async function completedTodayIds(t: Tenant, nowIso: string): Promise<{ ids: Set<string>; count: number }> {
  const workspace = await getPitCrewWorkspace(t.brokerageId, t.pitCrewUserId, { now: new Date(nowIso) });
  return { ids: new Set(workspace.completedToday.map((item) => item.sourceRecordId)), count: workspace.summary.completedTodayCount };
}

// Brisbane fixtures (UTC+10, no DST).
let bne2359Prev: string; // 23:59 Brisbane 19 Oct = 2026-10-19T13:59Z
let bne0000: string; // 00:00 Brisbane 20 Oct = 2026-10-19T14:00Z
let bne0959: string; // 09:59 Brisbane 20 Oct = 2026-10-19T23:59Z
// Perth fixtures (UTC+8, no DST).
let per2330Prev: string; // 23:30 Perth 19 Oct = 2026-10-19T15:30Z (01:30 Brisbane 20 Oct)
let per0030: string; // 00:30 Perth 20 Oct = 2026-10-19T16:30Z
// Invalid-zone fixture.
let inv0030: string; // 00:30 Brisbane 20 Oct = 2026-10-19T14:30Z

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

  const stamp = Date.now();
  brisbane = await tenant("Brisbane", stamp);
  perth = await tenant("Perth", stamp);
  invalid = await tenant("Invalid", stamp);
  await db.insert(communicationSettings).values({ brokerageId: perth.brokerageId, timeZone: "Australia/Perth" });
  await db.insert(communicationSettings).values({ brokerageId: invalid.brokerageId, timeZone: "Not/AZone" });

  bne2359Prev = await completedAt(brisbane, "2026-10-19T13:59:00.000Z");
  bne0000 = await completedAt(brisbane, "2026-10-19T14:00:00.000Z");
  bne0959 = await completedAt(brisbane, "2026-10-19T23:59:00.000Z");
  per2330Prev = await completedAt(perth, "2026-10-19T15:30:00.000Z");
  per0030 = await completedAt(perth, "2026-10-19T16:30:00.000Z");
  inv0030 = await completedAt(invalid, "2026-10-19T14:30:00.000Z");
});

after(async () => {
  await cleanupBrokerages([brisbane, perth, invalid].filter(Boolean).map((t) => t.brokerageId));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("pure: isSamePitCrewLocalDay compares calendar days in the given zone, DST-safe", () => {
  const a = new Date("2026-10-19T13:59:00.000Z"); // 23:59 Brisbane 19 Oct
  const b = new Date("2026-10-19T14:00:00.000Z"); // 00:00 Brisbane 20 Oct
  assert.equal(isSamePitCrewLocalDay(a, b, "UTC"), true);
  assert.equal(isSamePitCrewLocalDay(a, b, "Australia/Brisbane"), false);
  assert.equal(isSamePitCrewLocalDay(b, new Date("2026-10-20T13:59:00.000Z"), "Australia/Brisbane"), true);
  // Sydney is on daylight time (UTC+11) on 20 Oct 2026.
  assert.equal(isSamePitCrewLocalDay(new Date("2026-10-19T13:00:00.000Z"), new Date("2026-10-20T12:59:00.000Z"), "Australia/Sydney"), true);
  assert.equal(isSamePitCrewLocalDay(new Date("2026-10-19T12:59:00.000Z"), new Date("2026-10-19T13:00:00.000Z"), "Australia/Sydney"), false);
});

test("pure: resolvePitCrewDayTimeZone uses a valid stored zone, otherwise Australia/Brisbane", () => {
  assert.equal(resolvePitCrewDayTimeZone("Australia/Perth"), "Australia/Perth");
  assert.equal(resolvePitCrewDayTimeZone("  Australia/Adelaide "), "Australia/Adelaide");
  assert.equal(resolvePitCrewDayTimeZone(null), "Australia/Brisbane");
  assert.equal(resolvePitCrewDayTimeZone(undefined), "Australia/Brisbane");
  assert.equal(resolvePitCrewDayTimeZone(""), "Australia/Brisbane");
  assert.equal(resolvePitCrewDayTimeZone("Not/AZone"), "Australia/Brisbane");
});

test("Brisbane fallback: at 10:30 local, items completed at 00:00 and 09:59 local count as today; 23:59 the night before does not", async () => {
  const { ids, count } = await completedTodayIds(brisbane, "2026-10-20T00:30:00.000Z");
  assert.equal(ids.has(bne0000), true, "00:00 Brisbane is today");
  assert.equal(ids.has(bne0959), true, "09:59 Brisbane is today (the UTC day is still yesterday)");
  assert.equal(ids.has(bne2359Prev), false, "23:59 Brisbane yesterday is not today");
  assert.equal(count, 2);
});

test("Brisbane fallback: just after local midnight, 23:59 the night before drops out even though the UTC date matches", async () => {
  const { ids } = await completedTodayIds(brisbane, "2026-10-19T14:30:00.000Z"); // 00:30 Brisbane 20 Oct, still 19 Oct UTC
  assert.equal(ids.has(bne2359Prev), false, "23:59 Brisbane 19 Oct is yesterday at 00:30 Brisbane 20 Oct");
  assert.equal(ids.has(bne0000), true, "00:00 Brisbane 20 Oct is today");
});

test("Perth brokerage: the boundary follows Perth, not Brisbane or UTC", async () => {
  const { ids, count } = await completedTodayIds(perth, "2026-10-20T01:00:00.000Z"); // 09:00 Perth 20 Oct
  assert.equal(ids.has(per0030), true, "00:30 Perth 20 Oct is today in Perth (UTC date is 19 Oct)");
  assert.equal(ids.has(per2330Prev), false, "23:30 Perth 19 Oct is yesterday in Perth (it would be today in Brisbane)");
  assert.equal(count, 1);
});

test("invalid stored zone falls back to Brisbane without throwing", async () => {
  const { ids, count } = await completedTodayIds(invalid, "2026-10-20T00:30:00.000Z"); // 10:30 Brisbane 20 Oct
  assert.equal(ids.has(inv0030), true, "00:30 Brisbane 20 Oct is today under the fallback");
  assert.equal(count, 1);
});

test("the workspace read does not create a communication_settings row for a brokerage without one", async () => {
  await completedTodayIds(brisbane, "2026-10-20T00:30:00.000Z");
  const rows = await db.select({ id: communicationSettings.id }).from(communicationSettings).where(eq(communicationSettings.brokerageId, brisbane.brokerageId));
  assert.equal(rows.length, 0);
});

test("lock: completedToday stays newest-first", async () => {
  const workspace = await getPitCrewWorkspace(brisbane.brokerageId, brisbane.pitCrewUserId, { now: new Date("2026-10-20T00:30:00.000Z") });
  const times = workspace.completedToday.map((item) => new Date(item.completedAt!).getTime());
  assert.deepEqual(times, [...times].sort((x, y) => y - x));
});
