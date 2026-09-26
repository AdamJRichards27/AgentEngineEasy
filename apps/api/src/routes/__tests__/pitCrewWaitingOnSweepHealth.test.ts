// R-F7: GET /pit-crew/ops/waiting-on/health is a read-only, tenant-scoped
// view of the scheduled WAITING_ON detection sweep. Gates match
// POST /pit-crew/ops/waiting-on/sweep. The brokerage id comes from the
// session. A missing settings read stays 200 with settingsAvailable false.
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  db,
  auditLogs,
  entitlementGrants,
  pitCrewAssignments,
  pitCrewWaitingOnSweepSettings,
  pitCrewWaitingOnSweepSightings,
  users,
} from "@aee/db";
import { claimWorkItem, startProgress, setWaitingOn } from "../../lib/pitCrew/assignment.js";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createOrUpdateException, newCorrelationId } from "../../lib/exceptions/model.js";
import type { RiskFinding } from "../../lib/exceptions/types.js";
import { runScheduledWaitingOnSweep, resetPitCrewWaitingOnSweepSchedulerForTests } from "../../lib/pitCrew/waitingOnSweepBootstrap.js";
import { __setPitCrewWaitingOnHealthSettingsLoaderForTests } from "../pitCrew.js";
import {
  __resetOperationalAlertsForTesting,
  __setOperationalAlertTransportForTesting,
} from "../../lib/operationalAlerts.js";
import {
  createBrokerageWithUsers,
  cleanupBrokerages,
  devLogin,
  type DevLoginResult,
} from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

/** Wednesday 10:00 Australia/Brisbane. Inside the default Mon–Fri 08:00–18:00 window. */
const INSIDE_WINDOW = new Date("2026-09-23T00:00:00.000Z");

const savedSweepEnabled = process.env.PIT_CREW_WAITING_ON_SWEEP_ENABLED;

interface HealthBody {
  scheduler: {
    enabled: boolean;
    started: boolean;
    intervalMs: number;
    lastTick: { at: string; outcome: string; durationMs: number | null } | null;
    health: string;
    consecutiveUnhealthyTicks: number;
    consecutiveBrokerageFailureTicks: number;
    alertThreshold: number;
  };
  brokerage: {
    settingsAvailable: boolean;
    cadenceMs: number | null;
    windowStart: string | null;
    windowEnd: string | null;
    weekdays: number[] | null;
    timeZone: string | null;
    timeZoneSource: string | null;
    attentionThresholdHours: number | null;
    elevatedThresholdHours: number | null;
    lastDetectionAt: string | null;
    failedLastTick: boolean | null;
  };
}

const SCHEDULER_KEYS = [
  "alertThreshold",
  "consecutiveBrokerageFailureTicks",
  "consecutiveUnhealthyTicks",
  "enabled",
  "health",
  "intervalMs",
  "lastTick",
  "started",
];

const BROKERAGE_KEYS = [
  "attentionThresholdHours",
  "cadenceMs",
  "elevatedThresholdHours",
  "failedLastTick",
  "lastDetectionAt",
  "settingsAvailable",
  "timeZone",
  "timeZoneSource",
  "weekdays",
  "windowEnd",
  "windowStart",
];

let server: Server;
let baseUrl: string;
let adminA: DevLoginResult;
let agentA: DevLoginResult;
let pitCrewA: DevLoginResult;
let pitCrewB: DevLoginResult;
let brokerageA: number;
let brokerageB: number;
let propertyA: number;
let propertyB: number;
let fixtureCounter = 0;

function health(cookie?: string, search = ""): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return fetch(`${baseUrl}/api/pit-crew/ops/waiting-on/health${search}`, { headers });
}

async function readHealth(cookie: string, search = ""): Promise<HealthBody> {
  const res = await health(cookie, search);
  assert.equal(res.status, 200);
  return (await res.json()) as HealthBody;
}

/**
 * Policy numbers (cadence, thresholds, weekdays, streaks, duration) are not
 * tenant ids. A fresh database can hand out a brokerage id that collides
 * with one of them, so those fields are cleared before the serialised id check.
 */
function assertNoForeignTenant(body: HealthBody, foreignId: number): void {
  assert.deepEqual(Object.keys(body).sort(), ["brokerage", "scheduler"]);
  assert.deepEqual(Object.keys(body.scheduler).sort(), SCHEDULER_KEYS);
  assert.deepEqual(Object.keys(body.brokerage).sort(), BROKERAGE_KEYS);
  if (body.scheduler.lastTick) {
    assert.deepEqual(Object.keys(body.scheduler.lastTick).sort(), ["at", "durationMs", "outcome"]);
  }
  const clone = structuredClone(body);
  clone.scheduler.intervalMs = 0;
  clone.scheduler.alertThreshold = 0;
  clone.scheduler.consecutiveUnhealthyTicks = 0;
  clone.scheduler.consecutiveBrokerageFailureTicks = 0;
  if (clone.scheduler.lastTick) clone.scheduler.lastTick.durationMs = 0;
  clone.brokerage.cadenceMs = 0;
  clone.brokerage.attentionThresholdHours = 0;
  clone.brokerage.elevatedThresholdHours = 0;
  clone.brokerage.weekdays = [];
  const serialised = JSON.stringify(clone).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "");
  assert.equal(
    new RegExp(`(?<![0-9])${foreignId}(?![0-9])`).test(serialised),
    false,
    `serialised health response contains brokerage ${foreignId}`,
  );
  for (const key of ["failedBrokerageIds", "failedBrokerages", "brokerages", "brokerageIds", "brokerageCount"]) {
    assert.equal(serialised.includes(`"${key}"`), false, `response includes ${key}`);
  }
}

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

async function makePitCrew(email: string, brokerageName: string): Promise<DevLoginResult> {
  const result = await devLogin(baseUrl, { email, firstName: "Pit", lastName: "Crew", brokerageName });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, result.user.id));
  return result;
}

function buildFinding(targetPropertyId: number, targetBrokerageId: number): RiskFinding {
  fixtureCounter += 1;
  return {
    ruleId: "TEST_PITCREW_WAITING_ON_HEALTH_RULE",
    ruleVersion: 1,
    category: "WORKFLOW_OPERATIONAL",
    severity: "ATTENTION",
    title: `Test PC sweep health ${fixtureCounter}`,
    problemDescription: "A test problem.",
    businessImpact: "Test impact.",
    detectedCause: "Test cause.",
    ownerType: "PIT_CREW",
    ownerUserId: null,
    propertyId: targetPropertyId,
    transactionId: null,
    dueAt: null,
    escalatesAt: null,
    recommendedAction: "Do the test thing.",
    resolutionRequirements: "The test condition clears.",
    dismissible: true,
    sourceRecordType: "property",
    sourceRecordId: String(targetPropertyId),
    dedupKey: `TEST_PITCREW_WAITING_ON_HEALTH_RULE:${targetBrokerageId}:HEALTH_${fixtureCounter}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
  };
}

async function createException(targetBrokerageId: number, targetPropertyId: number): Promise<string> {
  const finding = buildFinding(targetPropertyId, targetBrokerageId);
  const result = await createOrUpdateException(finding, targetBrokerageId, targetPropertyId, null, newCorrelationId(), null);
  return result.exception.id;
}

async function parkWaitingOn(input: {
  brokerageId: number;
  propertyId: number;
  actorUserId: number;
  waitingOnExpectedAt: Date;
}): Promise<{ sourceRecordId: string; version: number }> {
  const sourceRecordId = await createException(input.brokerageId, input.propertyId);
  let row = await claimWorkItem({
    brokerageId: input.brokerageId,
    propertyId: input.propertyId,
    sourceType: "EXCEPTION",
    sourceRecordId,
    expectedVersion: 0,
    actorUserId: input.actorUserId,
  });
  row = await startProgress({
    brokerageId: input.brokerageId,
    propertyId: input.propertyId,
    sourceType: "EXCEPTION",
    sourceRecordId,
    expectedVersion: row.version,
    actorUserId: input.actorUserId,
  });
  row = await setWaitingOn({
    brokerageId: input.brokerageId,
    propertyId: input.propertyId,
    sourceType: "EXCEPTION",
    sourceRecordId,
    expectedVersion: row.version,
    actorUserId: input.actorUserId,
    waitingOnParty: "Buyer's solicitor",
    waitingOnNote: "Chasing the contract",
    waitingOnExpectedAt: input.waitingOnExpectedAt,
  });
  assert.equal(row.status, "WAITING_ON");
  return { sourceRecordId, version: row.version };
}

async function loadAssignment(sourceRecordId: string) {
  const [row] = await db
    .select()
    .from(pitCrewAssignments)
    .where(and(eq(pitCrewAssignments.sourceType, "EXCEPTION"), eq(pitCrewAssignments.sourceRecordId, sourceRecordId)));
  assert.ok(row, "expected an overlay row");
  return row;
}

async function setRunAccess(targetBrokerageId: number, active: boolean): Promise<void> {
  await db
    .update(entitlementGrants)
    .set({ status: active ? "Active" : "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, targetBrokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(targetBrokerageId);
}

interface LogLine {
  message?: string;
}

function parseLogChunk(chunk: unknown, into: LogLine[]): void {
  const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      into.push(JSON.parse(line) as LogLine);
    } catch {
      /* not one of ours */
    }
  }
}

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: LogLine[] }> {
  const logs: LogLine[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const wrap = (real: typeof realOut) => ((chunk: unknown, ...rest: unknown[]) => {
    parseLogChunk(chunk, logs);
    return (real as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stdout.write = wrap(realOut);
  process.stderr.write = wrap(realErr);
  try {
    return { result: await fn(), logs };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

describe("GET /pit-crew/ops/waiting-on/health", { concurrency: 1 }, () => {
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

    const createdA = await createBrokerageWithUsers(baseUrl, `PitCrew Sweep Health A ${Date.now()}`);
    adminA = createdA.admin;
    agentA = createdA.agent;
    brokerageA = createdA.brokerageId;
    propertyA = await createProperty(agentA.cookie, "1 Sweep Health St");
    pitCrewA = await makePitCrew(`pitcrew-health-a-${brokerageA}@example.com`, adminA.user.brokerageName!);

    const createdB = await createBrokerageWithUsers(baseUrl, `PitCrew Sweep Health B ${Date.now()}`);
    brokerageB = createdB.brokerageId;
    propertyB = await createProperty(createdB.agent.cookie, "2 Sweep Health St");
    pitCrewB = await makePitCrew(`pitcrew-health-b-${brokerageB}@example.com`, createdB.admin.user.brokerageName!);
  });

  after(async () => {
    if (savedSweepEnabled === undefined) delete process.env.PIT_CREW_WAITING_ON_SWEEP_ENABLED;
    else process.env.PIT_CREW_WAITING_ON_SWEEP_ENABLED = savedSweepEnabled;
    __setPitCrewWaitingOnHealthSettingsLoaderForTests(null);
    resetPitCrewWaitingOnSweepSchedulerForTests();
    await setRunAccess(brokerageA, true);
    await cleanupBrokerages([brokerageA, brokerageB]);
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  beforeEach(() => {
    resetPitCrewWaitingOnSweepSchedulerForTests();
    __setPitCrewWaitingOnHealthSettingsLoaderForTests(null);
    if (savedSweepEnabled === undefined) delete process.env.PIT_CREW_WAITING_ON_SWEEP_ENABLED;
    else process.env.PIT_CREW_WAITING_ON_SWEEP_ENABLED = savedSweepEnabled;
  });

  test("requires authentication, rejects an Agent and a caller without run.access, and allows Pit Crew and a Brokerage Administrator", async () => {
    const anon = await health();
    assert.equal(anon.status, 401);

    const agent = await health(agentA.cookie);
    assert.equal(agent.status, 403);
    const agentBody = (await agent.json()) as { error?: string };
    assert.equal(agentBody.error, "Forbidden");

    await setRunAccess(brokerageA, false);
    try {
      const revoked = await health(pitCrewA.cookie);
      assert.equal(revoked.status, 403);
      const revokedBody = (await revoked.json()) as { error?: string; entitlementKey?: string };
      assert.equal(revokedBody.error, "Not entitled");
      assert.equal(revokedBody.entitlementKey, "run.access");
    } finally {
      await setRunAccess(brokerageA, true);
    }

    const pitCrew = await health(pitCrewA.cookie);
    assert.equal(pitCrew.status, 200);
    const admin = await health(adminA.cookie);
    assert.equal(admin.status, 200);
  });

  test("flag off and never ticked reports not_running", async () => {
    const body = await readHealth(pitCrewA.cookie);
    assert.equal(body.scheduler.enabled, false);
    assert.equal(body.scheduler.started, false);
    assert.equal(body.scheduler.lastTick, null);
    assert.equal(body.scheduler.health, "not_running");
    assert.equal(body.scheduler.consecutiveUnhealthyTicks, 0);
    assert.equal(body.scheduler.consecutiveBrokerageFailureTicks, 0);
    assert.equal(body.scheduler.alertThreshold, 3);
    assert.equal(body.scheduler.intervalMs, 1_800_000);
    assert.equal(body.brokerage.failedLastTick, null);
    assert.equal(body.brokerage.settingsAvailable, true);
    assert.equal(body.brokerage.lastDetectionAt, null);
  });

  test("a healthy tick reports completed, ok, and this brokerage's lastDetectionAt", async () => {
    process.env.PIT_CREW_WAITING_ON_SWEEP_ENABLED = "true";
    await parkWaitingOn({
      brokerageId: brokerageA,
      propertyId: propertyA,
      actorUserId: pitCrewA.user.id,
      waitingOnExpectedAt: new Date(INSIDE_WINDOW.getTime() - 30 * 60 * 1000),
    });
    const tick = await runScheduledWaitingOnSweep(INSIDE_WINDOW, { brokerageIds: [brokerageA] });
    assert.equal(tick.overlapSkipped, false);
    assert.equal(tick.failedBrokerages, 0);

    const body = await readHealth(pitCrewA.cookie);
    assert.equal(body.scheduler.enabled, true);
    assert.equal(body.scheduler.started, false);
    assert.equal(body.scheduler.lastTick?.outcome, "completed");
    assert.equal(typeof body.scheduler.lastTick?.durationMs, "number");
    assert.equal(body.scheduler.health, "ok");
    assert.equal(body.scheduler.consecutiveUnhealthyTicks, 0);
    assert.equal(body.brokerage.settingsAvailable, true);
    assert.equal(body.brokerage.failedLastTick, false);
    assert.equal(body.brokerage.lastDetectionAt, INSIDE_WINDOW.toISOString());
    assert.equal(body.brokerage.cadenceMs, 1_800_000);
    assert.equal(body.brokerage.windowStart, "08:00");
    assert.equal(body.brokerage.windowEnd, "18:00");
    assert.deepEqual(body.brokerage.weekdays, [1, 2, 3, 4, 5]);
    assert.equal(body.brokerage.timeZone, "Australia/Brisbane");
    assert.equal(body.brokerage.timeZoneSource, "fallback");
    assertNoForeignTenant(body, brokerageB);
  });

  test("a caller sees only whether their own brokerage failed the last completed tick", async () => {
    process.env.PIT_CREW_WAITING_ON_SWEEP_ENABLED = "true";
    const overdueAt = new Date(INSIDE_WINDOW.getTime() - 30 * 60 * 1000);
    await parkWaitingOn({
      brokerageId: brokerageA,
      propertyId: propertyA,
      actorUserId: pitCrewA.user.id,
      waitingOnExpectedAt: overdueAt,
    });
    await parkWaitingOn({
      brokerageId: brokerageB,
      propertyId: propertyB,
      actorUserId: pitCrewB.user.id,
      waitingOnExpectedAt: overdueAt,
    });
    const tick = await runScheduledWaitingOnSweep(INSIDE_WINDOW, {
      brokerageIds: [brokerageA, brokerageB],
      beforeBrokerage: (brokerageId) => {
        if (brokerageId === brokerageB) throw new Error("brokerage B down");
      },
    });
    assert.equal(tick.failedBrokerages, 1);

    const callerA = await readHealth(pitCrewA.cookie, `?brokerageId=${brokerageB}`);
    const callerB = await readHealth(pitCrewB.cookie);
    assert.equal(callerA.brokerage.failedLastTick, false);
    assert.equal(callerB.brokerage.failedLastTick, true);
    assert.equal(callerA.scheduler.health, "degraded");
    assert.equal(callerA.scheduler.consecutiveBrokerageFailureTicks, 1);
    assert.equal(callerA.scheduler.consecutiveUnhealthyTicks, 0);
    assert.equal(callerB.scheduler.health, callerA.scheduler.health);
    assert.equal(callerA.brokerage.lastDetectionAt, INSIDE_WINDOW.toISOString());
    assert.equal(callerB.brokerage.lastDetectionAt, null);
    assertNoForeignTenant(callerA, brokerageB);
    assertNoForeignTenant(callerB, brokerageA);
  });

  test("one or two whole-tick failures are degraded, and the third is unhealthy", async () => {
    process.env.PIT_CREW_WAITING_ON_SWEEP_ENABLED = "true";
    const fail = () => runScheduledWaitingOnSweep(INSIDE_WINDOW, {
      brokerageIds: [brokerageA, brokerageB],
      beforeScan: () => {
        throw new Error("scan down");
      },
    });

    await assert.rejects(fail, /scan down/);
    const once = await readHealth(pitCrewA.cookie);
    assert.equal(once.scheduler.health, "degraded");
    assert.equal(once.scheduler.consecutiveUnhealthyTicks, 1);
    assert.equal(once.scheduler.consecutiveBrokerageFailureTicks, 0);
    assert.equal(once.scheduler.lastTick?.outcome, "failed");
    assert.equal(typeof once.scheduler.lastTick?.durationMs, "number");

    await assert.rejects(fail, /scan down/);
    const twice = await readHealth(adminA.cookie);
    assert.equal(twice.scheduler.health, "degraded");
    assert.equal(twice.scheduler.consecutiveUnhealthyTicks, 2);

    await assert.rejects(fail, /scan down/);
    const thrice = await readHealth(pitCrewA.cookie);
    assert.equal(thrice.scheduler.health, "unhealthy");
    assert.equal(thrice.scheduler.consecutiveUnhealthyTicks, 3);
    assert.equal(thrice.scheduler.alertThreshold, 3);
    assert.equal(thrice.brokerage.failedLastTick, null);
  });

  test("a settings read error is 200 with settingsAvailable false", async () => {
    __setPitCrewWaitingOnHealthSettingsLoaderForTests(async () => {
      throw new Error("relation pit_crew_waiting_on_sweep_settings does not exist");
    });
    const { result, logs } = await captureLogs(() => health(pitCrewA.cookie));
    assert.equal(result.status, 200);
    const body = (await result.json()) as HealthBody;
    assert.equal(body.brokerage.settingsAvailable, false);
    assert.equal(body.brokerage.cadenceMs, null);
    assert.equal(body.brokerage.windowStart, null);
    assert.equal(body.brokerage.windowEnd, null);
    assert.equal(body.brokerage.weekdays, null);
    assert.equal(body.brokerage.timeZone, null);
    assert.equal(body.brokerage.timeZoneSource, null);
    assert.equal(body.brokerage.attentionThresholdHours, null);
    assert.equal(body.brokerage.elevatedThresholdHours, null);
    assert.equal(body.brokerage.lastDetectionAt, null);
    assert.equal(body.scheduler.health, "not_running");
    assert.equal(
      logs.some((line) => line.message === "pit_crew_waiting_on_sweep_health_settings_unavailable"),
      true,
    );
  });

  test("the read changes no rows and dispatches no alert", async () => {
    const savedAlerts = {
      enabled: process.env.OPERATIONAL_ALERTS_ENABLED,
      provider: process.env.OPERATIONAL_ALERTS_PROVIDER,
      url: process.env.OPERATIONAL_ALERTS_WEBHOOK_URL,
      token: process.env.OPERATIONAL_ALERTS_TOKEN,
    };
    const captured: string[] = [];
    process.env.OPERATIONAL_ALERTS_ENABLED = "true";
    process.env.OPERATIONAL_ALERTS_PROVIDER = "webhook";
    process.env.OPERATIONAL_ALERTS_WEBHOOK_URL = "https://alerts.example.invalid/pit-crew-waiting-on";
    process.env.OPERATIONAL_ALERTS_TOKEN = "test-token-at-least-sixteen-characters";
    __resetOperationalAlertsForTesting();
    __setOperationalAlertTransportForTesting(async (_url, _token, envelope) => {
      captured.push((envelope as { type?: string }).type ?? "unknown");
      return 202;
    });
    try {
      const parked = await parkWaitingOn({
        brokerageId: brokerageA,
        propertyId: propertyA,
        actorUserId: pitCrewA.user.id,
        waitingOnExpectedAt: new Date(INSIDE_WINDOW.getTime() - 30 * 60 * 1000),
      });
      const before = await loadAssignment(parked.sourceRecordId);
      const auditsBefore = await db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.brokerageId, brokerageA));
      const sightingsBefore = await db.select().from(pitCrewWaitingOnSweepSightings).where(eq(pitCrewWaitingOnSweepSightings.brokerageId, brokerageA));
      const settingsBefore = await db.select().from(pitCrewWaitingOnSweepSettings).where(eq(pitCrewWaitingOnSweepSettings.brokerageId, brokerageA));

      const res = await health(pitCrewA.cookie);
      assert.equal(res.status, 200);
      const after = await loadAssignment(parked.sourceRecordId);
      assert.equal(after.status, before.status);
      assert.equal(after.status, "WAITING_ON");
      assert.equal(after.version, before.version);
      const auditsAfter = await db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.brokerageId, brokerageA));
      const sightingsAfter = await db.select().from(pitCrewWaitingOnSweepSightings).where(eq(pitCrewWaitingOnSweepSightings.brokerageId, brokerageA));
      const settingsAfter = await db.select().from(pitCrewWaitingOnSweepSettings).where(eq(pitCrewWaitingOnSweepSettings.brokerageId, brokerageA));
      assert.deepEqual(auditsAfter.map((row) => row.id), auditsBefore.map((row) => row.id));
      assert.deepEqual(sightingsAfter, sightingsBefore);
      assert.deepEqual(settingsAfter, settingsBefore);
      assert.deepEqual(captured, []);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await assert.rejects(
          () => runScheduledWaitingOnSweep(INSIDE_WINDOW, {
            brokerageIds: [brokerageA],
            beforeScan: () => {
              throw new Error("scan down");
            },
          }),
          /scan down/,
        );
      }
      assert.equal(captured.length, 1);
      const mid = await loadAssignment(parked.sourceRecordId);
      const again = await health(pitCrewA.cookie);
      assert.equal(again.status, 200);
      const end = await loadAssignment(parked.sourceRecordId);
      assert.equal(end.status, mid.status);
      assert.equal(end.version, mid.version);
      assert.equal(captured.length, 1, "the health read must not dispatch an alert");
      const returned = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(
        eq(auditLogs.recordId, parked.sourceRecordId),
        eq(auditLogs.action, "PC_WAITING_ON_RETURNED"),
      ));
      assert.equal(returned.length, 0);
    } finally {
      __setOperationalAlertTransportForTesting(async () => 204);
      __resetOperationalAlertsForTesting();
      if (savedAlerts.enabled === undefined) delete process.env.OPERATIONAL_ALERTS_ENABLED;
      else process.env.OPERATIONAL_ALERTS_ENABLED = savedAlerts.enabled;
      if (savedAlerts.provider === undefined) delete process.env.OPERATIONAL_ALERTS_PROVIDER;
      else process.env.OPERATIONAL_ALERTS_PROVIDER = savedAlerts.provider;
      if (savedAlerts.url === undefined) delete process.env.OPERATIONAL_ALERTS_WEBHOOK_URL;
      else process.env.OPERATIONAL_ALERTS_WEBHOOK_URL = savedAlerts.url;
      if (savedAlerts.token === undefined) delete process.env.OPERATIONAL_ALERTS_TOKEN;
      else process.env.OPERATIONAL_ALERTS_TOKEN = savedAlerts.token;
    }
  });
});
