// R-F6: the scheduled WAITING_ON sweep emits bounded metrics and pages
// operations only when the sweep itself fails three ticks in a row. An
// overdue item never pages. These brokerages are this file's own, and every
// tick passes brokerageIds so a shared database is not swept.
import { test, before, after, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  auditLogs,
  pitCrewAssignments,
  pitCrewWaitingOnSweepSettings,
  pitCrewWaitingOnSweepSightings,
  riskExceptions,
  transactions,
} from "@aee/db";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
import {
  claimWorkItem,
  startProgress,
  setWaitingOn,
} from "../assignment.js";
import { PIT_CREW_WAITING_ON_SWEEP_DEFAULT_CADENCE_MS } from "../waitingOnDetection.js";
import {
  PIT_CREW_WAITING_ON_SWEEP_ALERT_AFTER_CONSECUTIVE_FAILURES,
  pitCrewWaitingOnSweepHealthSnapshot,
  resetPitCrewWaitingOnSweepSchedulerForTests,
  runScheduledWaitingOnSweep,
  stopPitCrewWaitingOnSweepScheduler,
} from "../waitingOnSweepBootstrap.js";
import {
  __resetOperationalAlertsForTesting,
  __setOperationalAlertTransportForTesting,
} from "../../operationalAlerts.js";
import { createOrUpdateException, newCorrelationId } from "../../exceptions/model.js";
import type { RiskFinding } from "../../exceptions/types.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

/** Wednesday 10:00 Australia/Brisbane. Inside the default Mon–Fri 08:00–18:00 window. */
const INSIDE_WINDOW = new Date("2026-09-23T00:00:00.000Z");
/** Saturday 10:00 Australia/Brisbane. Outside the default window. */
const OUTSIDE_WINDOW = new Date("2026-09-26T00:00:00.000Z");
const CADENCE_MS = PIT_CREW_WAITING_ON_SWEEP_DEFAULT_CADENCE_MS;

const ALERT_ENV_KEYS = [
  "OPERATIONAL_ALERTS_ENABLED",
  "OPERATIONAL_ALERTS_PROVIDER",
  "OPERATIONAL_ALERTS_WEBHOOK_URL",
  "OPERATIONAL_ALERTS_TOKEN",
] as const;

const savedAlertEnv: Record<(typeof ALERT_ENV_KEYS)[number], string | undefined> = {
  OPERATIONAL_ALERTS_ENABLED: process.env.OPERATIONAL_ALERTS_ENABLED,
  OPERATIONAL_ALERTS_PROVIDER: process.env.OPERATIONAL_ALERTS_PROVIDER,
  OPERATIONAL_ALERTS_WEBHOOK_URL: process.env.OPERATIONAL_ALERTS_WEBHOOK_URL,
  OPERATIONAL_ALERTS_TOKEN: process.env.OPERATIONAL_ALERTS_TOKEN,
};

interface CapturedAlert {
  type: string;
  dedupKey: string;
  severity: string;
  owner: string;
  runbook: string;
  summary: string;
  details?: Record<string, unknown>;
}

interface LogLine {
  message?: string;
  tier?: string;
  sourceRecordId?: string;
}

let captured: CapturedAlert[] = [];

function enableAlerts(): void {
  process.env.OPERATIONAL_ALERTS_ENABLED = "true";
  process.env.OPERATIONAL_ALERTS_PROVIDER = "webhook";
  process.env.OPERATIONAL_ALERTS_WEBHOOK_URL = "https://alerts.example.invalid/pit-crew-waiting-on";
  process.env.OPERATIONAL_ALERTS_TOKEN = "test-token-at-least-sixteen-characters";
}

function restoreAlertEnv(): void {
  for (const key of ALERT_ENV_KEYS) {
    const saved = savedAlertEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

function installCapturingTransport(): void {
  __setOperationalAlertTransportForTesting(async (_url, _token, envelope) => {
    captured.push(envelope as CapturedAlert);
    return 202;
  });
}

function counter(name: string, labels: Record<string, string>): number {
  for (const line of renderMetricsText().split("\n")) {
    if (!line.startsWith(`${name}{`)) continue;
    const rendered = Object.fromEntries(
      line
        .slice(line.indexOf("{") + 1, line.indexOf("}"))
        .split(",")
        .filter(Boolean)
        .map((pair) => {
          const [k, v] = pair.split("=");
          return [k, v.replace(/"/g, "")];
        }),
    );
    const matches =
      Object.keys(rendered).length === Object.keys(labels).length &&
      Object.entries(labels).every(([k, v]) => rendered[k] === v);
    if (matches) return Number(line.slice(line.lastIndexOf(" ") + 1));
  }
  return 0;
}

function histogramCount(name: string, labels: Record<string, string>): number {
  return counter(`${name}_count`, labels);
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

describe("waiting-on sweep operability", { concurrency: 1 }, () => {
  let server: Server;
  let baseUrl: string;
  let brokerageA: number;
  let brokerageB: number;
  let propertyA: number;
  let propertyB: number;
  let agentA: DevLoginResult;
  let agentB: DevLoginResult;
  let fixtureCounter = 0;

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

  function buildFinding(
    targetBrokerageId: number,
    targetPropertyId: number,
    overrides: Partial<RiskFinding> = {},
  ): RiskFinding {
    fixtureCounter += 1;
    return {
      ruleId: "TEST_PITCREW_WAITING_ON_OPERABILITY_RULE",
      ruleVersion: 1,
      category: "WORKFLOW_OPERATIONAL",
      severity: "ATTENTION",
      title: `Test PC waiting-on operability ${fixtureCounter}`,
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
      dedupKey: `TEST_PITCREW_WAITING_ON_OPERABILITY_RULE:${targetBrokerageId}:OPS_${fixtureCounter}`,
      recurrenceMode: "REOPEN",
      requiresFinancialEntitlement: false,
      ...overrides,
    };
  }

  async function createException(targetBrokerageId: number, targetPropertyId: number): Promise<string> {
    const finding = buildFinding(targetBrokerageId, targetPropertyId);
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

  async function returnedAudits(sourceRecordId: string) {
    return db.select().from(auditLogs).where(and(
      eq(auditLogs.recordType, "EXCEPTION"),
      eq(auditLogs.recordId, sourceRecordId),
      eq(auditLogs.action, "PC_WAITING_ON_RETURNED"),
    ));
  }

  const scope = () => [brokerageA, brokerageB];

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

    const createdA = await createBrokerageWithUsers(baseUrl, `PitCrew Sweep Ops A ${Date.now()}`);
    const createdB = await createBrokerageWithUsers(baseUrl, `PitCrew Sweep Ops B ${Date.now()}`);
    agentA = createdA.agent;
    agentB = createdB.agent;
    brokerageA = createdA.brokerageId;
    brokerageB = createdB.brokerageId;
    propertyA = await createProperty(agentA.cookie, "1 Waiting On Operability St");
    propertyB = await createProperty(agentB.cookie, "2 Waiting On Operability St");
  });

  after(async () => {
    stopPitCrewWaitingOnSweepScheduler();
    restoreAlertEnv();
    __setOperationalAlertTransportForTesting(async () => 204);
    await cleanupBrokerages([brokerageA, brokerageB].filter((id) => typeof id === "number"));
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  beforeEach(() => {
    captured = [];
    enableAlerts();
    resetMetricsForTesting();
    __resetOperationalAlertsForTesting();
    resetPitCrewWaitingOnSweepSchedulerForTests();
    installCapturingTransport();
  });

  afterEach(async () => {
    restoreAlertEnv();
    const ids = [brokerageA, brokerageB].filter((id) => typeof id === "number");
    if (ids.length === 0) return;
    await db.delete(pitCrewWaitingOnSweepSightings).where(inArray(pitCrewWaitingOnSweepSightings.brokerageId, ids));
    await db.delete(pitCrewWaitingOnSweepSettings).where(inArray(pitCrewWaitingOnSweepSettings.brokerageId, ids));
    await db
      .update(pitCrewAssignments)
      .set({ waitingOnExpectedAt: new Date("2099-01-01T00:00:00.000Z") })
      .where(and(inArray(pitCrewAssignments.brokerageId, ids), eq(pitCrewAssignments.status, "WAITING_ON")));
  });

  test("a healthy tick records bounded metrics and never pages, including an elevated item", async () => {
    assert.equal(PIT_CREW_WAITING_ON_SWEEP_ALERT_AFTER_CONSECUTIVE_FAILURES, 3);
    const now = INSIDE_WINDOW;
    await parkWaitingOn({
      brokerageId: brokerageA,
      propertyId: propertyA,
      actorUserId: agentA.user.id,
      waitingOnExpectedAt: new Date(now.getTime() - 30 * 60 * 1000),
    });
    await parkWaitingOn({
      brokerageId: brokerageB,
      propertyId: propertyB,
      actorUserId: agentB.user.id,
      waitingOnExpectedAt: new Date(now.getTime() - 30 * 60 * 1000),
    });

    const first = await runScheduledWaitingOnSweep(now, { brokerageIds: scope() });
    assert.equal(first.overlapSkipped, false);
    assert.equal(first.surfaced, 2);
    assert.equal(counter("pit_crew_waiting_on_sweep_tick_total", { outcome: "completed" }), 1);
    assert.equal(histogramCount("pit_crew_waiting_on_sweep_tick_duration_ms", { outcome: "completed" }), 1);
    assert.equal(counter("pit_crew_waiting_on_sweep_brokerage_total", { outcome: "detected" }), 2);
    assert.equal(counter("pit_crew_waiting_on_sweep_item_total", { outcome: "surfaced" }), 2);
    assert.equal(captured.length, 0);

    const insideCadence = await runScheduledWaitingOnSweep(new Date(now.getTime() + 60 * 1000), { brokerageIds: scope() });
    assert.equal(insideCadence.skippedCadence, 2);
    assert.equal(counter("pit_crew_waiting_on_sweep_brokerage_total", { outcome: "skipped_cadence" }), 2);

    const outside = await runScheduledWaitingOnSweep(OUTSIDE_WINDOW, { brokerageIds: scope() });
    assert.equal(outside.skippedWindow, 2);
    assert.equal(counter("pit_crew_waiting_on_sweep_brokerage_total", { outcome: "skipped_window" }), 2);

    const sameTierAt = new Date(now.getTime() + CADENCE_MS);
    const deduped = await runScheduledWaitingOnSweep(sameTierAt, { brokerageIds: scope() });
    assert.equal(deduped.deduped, 2);
    assert.equal(deduped.surfaced, 0);
    assert.equal(counter("pit_crew_waiting_on_sweep_item_total", { outcome: "deduped" }), 2);

    const elevatedAt = new Date(now.getTime() + 2 * CADENCE_MS);
    const elevated = await parkWaitingOn({
      brokerageId: brokerageA,
      propertyId: propertyA,
      actorUserId: agentA.user.id,
      waitingOnExpectedAt: new Date(elevatedAt.getTime() - 5 * 60 * 60 * 1000),
    });
    const { result: elevatedTick, logs } = await captureLogs(() =>
      runScheduledWaitingOnSweep(elevatedAt, { brokerageIds: scope() }),
    );
    assert.equal(elevatedTick.surfaced, 1);
    const elevatedLog = logs.find((line) => line.message === "pit_crew_waiting_on_detected" && line.sourceRecordId === elevated.sourceRecordId);
    assert.equal(elevatedLog?.tier, "elevated_attention");
    assert.equal(captured.length, 0, "an elevated overdue item does not page");

    const text = renderMetricsText();
    assert.equal(text.includes(`"${brokerageA}"`), false);
    assert.equal(text.includes(`"${brokerageB}"`), false);
    for (const line of text.split("\n")) {
      if (!line.includes("pit_crew_waiting_on_sweep_") || !line.includes("{")) continue;
      const labels = line.slice(line.indexOf("{") + 1, line.indexOf("}"));
      assert.doesNotMatch(labels, /\b(brokerage|assignment|property)\b/i, `series carries a tenant or record label: ${line}`);
    }
    assert.deepEqual(pitCrewWaitingOnSweepHealthSnapshot(), {
      consecutiveUnhealthyTicks: 0,
      consecutiveBrokerageFailureTicks: 0,
    });
  });

  test("an overlap skip increments skipped_overlap, records no duration, and leaves the streaks unchanged", async () => {
    const now = INSIDE_WINDOW;
    await parkWaitingOn({
      brokerageId: brokerageA,
      propertyId: propertyA,
      actorUserId: agentA.user.id,
      waitingOnExpectedAt: new Date(now.getTime() - 60 * 1000),
    });
    await parkWaitingOn({
      brokerageId: brokerageB,
      propertyId: propertyB,
      actorUserId: agentB.user.id,
      waitingOnExpectedAt: new Date(now.getTime() - 60 * 1000),
    });
    await runScheduledWaitingOnSweep(now, {
      brokerageIds: scope(),
      beforeBrokerage: (brokerageId) => {
        if (brokerageId === brokerageA) throw new Error("prime a brokerage failure");
      },
    });
    const streakBefore = pitCrewWaitingOnSweepHealthSnapshot();
    assert.equal(streakBefore.consecutiveBrokerageFailureTicks, 1);
    assert.equal(streakBefore.consecutiveUnhealthyTicks, 0);
    const durationBefore = histogramCount("pit_crew_waiting_on_sweep_tick_duration_ms", { outcome: "completed" });
    const failedDurationBefore = histogramCount("pit_crew_waiting_on_sweep_tick_duration_ms", { outcome: "failed" });

    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const heldAt = new Date(now.getTime() + CADENCE_MS);
    const held = runScheduledWaitingOnSweep(heldAt, {
      brokerageIds: scope(),
      beforeBrokerage: async () => {
        markEntered();
        await hold;
      },
    });
    try {
      await entered;
      const skipped = await runScheduledWaitingOnSweep(heldAt, { brokerageIds: scope() });
      assert.equal(skipped.overlapSkipped, true);
      assert.equal(counter("pit_crew_waiting_on_sweep_tick_total", { outcome: "skipped_overlap" }), 1);
      assert.equal(histogramCount("pit_crew_waiting_on_sweep_tick_duration_ms", { outcome: "completed" }), durationBefore);
      assert.equal(histogramCount("pit_crew_waiting_on_sweep_tick_duration_ms", { outcome: "failed" }), failedDurationBefore);
      assert.equal(
        renderMetricsText().includes('pit_crew_waiting_on_sweep_tick_duration_ms_count{outcome="skipped_overlap"}'),
        false,
      );
      assert.deepEqual(pitCrewWaitingOnSweepHealthSnapshot(), streakBefore);
      assert.equal(captured.length, 0);
    } finally {
      release();
      const finished = await held;
      assert.equal(finished.overlapSkipped, false);
    }
  });

  test("brokerage failures page once on the third tick, then the cooldown and a healthy tick reset the streak", async () => {
    const now = INSIDE_WINDOW;
    await parkWaitingOn({
      brokerageId: brokerageA,
      propertyId: propertyA,
      actorUserId: agentA.user.id,
      waitingOnExpectedAt: new Date(now.getTime() - 30 * 60 * 1000),
    });
    await parkWaitingOn({
      brokerageId: brokerageB,
      propertyId: propertyB,
      actorUserId: agentB.user.id,
      waitingOnExpectedAt: new Date(now.getTime() - 30 * 60 * 1000),
    });

    const failing = (index: number) => runScheduledWaitingOnSweep(new Date(now.getTime() + index * CADENCE_MS), {
      brokerageIds: scope(),
      beforeBrokerage: (brokerageId) => {
        if (brokerageId === brokerageA) throw new Error("brokerage A down");
      },
    });

    await failing(0);
    await failing(1);
    assert.equal(captured.length, 0);
    await failing(2);
    assert.equal(captured.length, 1);
    const envelope = captured[0]!;
    assert.equal(envelope.type, "PIT_CREW_WAITING_ON_SWEEP_BROKERAGE_FAILED");
    assert.equal(envelope.severity, "high");
    assert.equal(envelope.owner, "operations");
    assert.equal(envelope.runbook, "pit-crew-waiting-on-sweep");
    assert.equal(envelope.dedupKey, "pit-crew-waiting-on-sweep:brokerage-failures");
    const failedIds = envelope.details?.failedBrokerageIds;
    assert.ok(Array.isArray(failedIds));
    assert.equal(failedIds.includes(brokerageA), true);
    assert.equal(failedIds.includes(brokerageB), false);
    const serialised = JSON.stringify(envelope);
    assert.equal(serialised.includes("propertyId"), false);
    assert.equal(serialised.includes("assignmentId"), false);
    assert.equal(serialised.includes("sourceRecordId"), false);

    await failing(3);
    assert.equal(captured.length, 1, "the cooldown collapses the fourth tick to the same page");

    const healthy = await runScheduledWaitingOnSweep(new Date(now.getTime() + 4 * CADENCE_MS), {
      brokerageIds: scope(),
    });
    assert.equal(healthy.failedBrokerages, 0);
    assert.deepEqual(pitCrewWaitingOnSweepHealthSnapshot(), {
      consecutiveUnhealthyTicks: 0,
      consecutiveBrokerageFailureTicks: 0,
    });
    __resetOperationalAlertsForTesting();
    await failing(5);
    await failing(6);
    assert.equal(captured.length, 1, "two failures after a healthy tick are below the threshold");
    assert.equal(counter("pit_crew_waiting_on_sweep_brokerage_total", { outcome: "failed" }), 6);
  });

  test("three thrown ticks reject, page unhealthy once, release the overlap guard, and a healthy tick resets the streak", async () => {
    const now = INSIDE_WINDOW;
    await parkWaitingOn({
      brokerageId: brokerageA,
      propertyId: propertyA,
      actorUserId: agentA.user.id,
      waitingOnExpectedAt: new Date(now.getTime() - 60 * 1000),
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(
        () => runScheduledWaitingOnSweep(now, {
          brokerageIds: scope(),
          beforeScan: () => {
            throw new Error("scan down");
          },
        }),
        /scan down/,
      );
    }
    assert.equal(counter("pit_crew_waiting_on_sweep_tick_total", { outcome: "failed" }), 3);
    assert.equal(histogramCount("pit_crew_waiting_on_sweep_tick_duration_ms", { outcome: "failed" }), 3);
    assert.equal(histogramCount("pit_crew_waiting_on_sweep_tick_duration_ms", { outcome: "completed" }), 0);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.type, "PIT_CREW_WAITING_ON_SWEEP_UNHEALTHY");
    assert.equal(captured[0]!.dedupKey, "pit-crew-waiting-on-sweep:unhealthy");
    assert.equal(captured[0]!.details?.error, "scan down");
    assert.equal(pitCrewWaitingOnSweepHealthSnapshot().consecutiveUnhealthyTicks, 3);
    assert.equal(pitCrewWaitingOnSweepHealthSnapshot().consecutiveBrokerageFailureTicks, 0);

    const healthy = await runScheduledWaitingOnSweep(now, { brokerageIds: scope() });
    assert.equal(healthy.overlapSkipped, false);
    assert.equal(healthy.surfaced, 1);
    assert.deepEqual(pitCrewWaitingOnSweepHealthSnapshot(), {
      consecutiveUnhealthyTicks: 0,
      consecutiveBrokerageFailureTicks: 0,
    });
  });

  test("every brokerage failing three ticks pages unhealthy once and does not also page brokerage failures", async () => {
    const now = INSIDE_WINDOW;
    await parkWaitingOn({
      brokerageId: brokerageA,
      propertyId: propertyA,
      actorUserId: agentA.user.id,
      waitingOnExpectedAt: new Date(now.getTime() - 60 * 1000),
    });
    await parkWaitingOn({
      brokerageId: brokerageB,
      propertyId: propertyB,
      actorUserId: agentB.user.id,
      waitingOnExpectedAt: new Date(now.getTime() - 60 * 1000),
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await runScheduledWaitingOnSweep(now, {
        brokerageIds: scope(),
        beforeBrokerage: () => {
          throw new Error("settings table missing");
        },
      });
      assert.equal(result.failedBrokerages, 2);
      assert.equal(result.brokerages, 2);
      assert.equal(result.overlapSkipped, false);
    }
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.type, "PIT_CREW_WAITING_ON_SWEEP_UNHEALTHY");
    assert.equal(captured.filter((envelope) => envelope.type === "PIT_CREW_WAITING_ON_SWEEP_BROKERAGE_FAILED").length, 0);
    assert.equal(counter("pit_crew_waiting_on_sweep_tick_total", { outcome: "completed" }), 3);
    assert.equal(counter("pit_crew_waiting_on_sweep_tick_total", { outcome: "failed" }), 0);
  });

  test("disabled alerts never call the transport, and failing ticks still resolve or reject", async () => {
    delete process.env.OPERATIONAL_ALERTS_ENABLED;
    let transportCalls = 0;
    __setOperationalAlertTransportForTesting(async () => {
      transportCalls += 1;
      return 202;
    });
    const now = INSIDE_WINDOW;
    await parkWaitingOn({
      brokerageId: brokerageA,
      propertyId: propertyA,
      actorUserId: agentA.user.id,
      waitingOnExpectedAt: new Date(now.getTime() - 60 * 1000),
    });
    await parkWaitingOn({
      brokerageId: brokerageB,
      propertyId: propertyB,
      actorUserId: agentB.user.id,
      waitingOnExpectedAt: new Date(now.getTime() - 60 * 1000),
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await runScheduledWaitingOnSweep(new Date(now.getTime() + attempt * CADENCE_MS), {
        brokerageIds: scope(),
        beforeBrokerage: (brokerageId) => {
          if (brokerageId === brokerageA) throw new Error("brokerage A down");
        },
      });
      assert.equal(result.failedBrokerages, 1);
      assert.equal(result.overlapSkipped, false);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(
        () => runScheduledWaitingOnSweep(now, {
          brokerageIds: scope(),
          beforeScan: () => {
            throw new Error("scan down");
          },
        }),
        /scan down/,
      );
    }
    assert.equal(transportCalls, 0);
    assert.equal(captured.length, 0);
  });

  test("a failing alert transport does not change assignment, exception, transaction, or audit state", async () => {
    const now = INSIDE_WINDOW;
    const parkedA = await parkWaitingOn({
      brokerageId: brokerageA,
      propertyId: propertyA,
      actorUserId: agentA.user.id,
      waitingOnExpectedAt: new Date(now.getTime() - 60 * 1000),
    });
    const parkedB = await parkWaitingOn({
      brokerageId: brokerageB,
      propertyId: propertyB,
      actorUserId: agentB.user.id,
      waitingOnExpectedAt: new Date(now.getTime() - 60 * 1000),
    });
    const beforeA = await loadAssignment(parkedA.sourceRecordId);
    const beforeB = await loadAssignment(parkedB.sourceRecordId);
    const exceptionIds = [parkedA.sourceRecordId, parkedB.sourceRecordId];
    const beforeExceptions = (await db.select().from(riskExceptions).where(inArray(riskExceptions.id, exceptionIds)))
      .sort((left, right) => left.id.localeCompare(right.id));
    const beforeTransactions = (await db.select().from(transactions).where(inArray(transactions.propertyId, [propertyA, propertyB])))
      .sort((left, right) => left.id - right.id);
    let transportCalls = 0;
    __setOperationalAlertTransportForTesting(async () => {
      transportCalls += 1;
      return 503;
    });

    let last: Awaited<ReturnType<typeof runScheduledWaitingOnSweep>> | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = await runScheduledWaitingOnSweep(new Date(now.getTime() + attempt * CADENCE_MS), {
        brokerageIds: scope(),
        beforeBrokerage: (brokerageId) => {
          if (brokerageId === brokerageA) throw new Error("brokerage A down");
        },
      });
    }
    assert.ok(last);
    assert.equal(last.overlapSkipped, false);
    assert.equal(last.failedBrokerages, 1);

    const assertUnchanged = async () => {
      const afterA = await loadAssignment(parkedA.sourceRecordId);
      const afterB = await loadAssignment(parkedB.sourceRecordId);
      assert.equal(afterA.status, "WAITING_ON");
      assert.equal(afterB.status, "WAITING_ON");
      assert.equal(afterA.version, parkedA.version);
      assert.equal(afterB.version, parkedB.version);
      assert.deepStrictEqual(afterA, beforeA);
      assert.deepStrictEqual(afterB, beforeB);
      const afterExceptions = (await db.select().from(riskExceptions).where(inArray(riskExceptions.id, exceptionIds)))
        .sort((left, right) => left.id.localeCompare(right.id));
      assert.deepStrictEqual(afterExceptions, beforeExceptions);
      const afterTransactions = (await db.select().from(transactions).where(inArray(transactions.propertyId, [propertyA, propertyB])))
        .sort((left, right) => left.id - right.id);
      assert.deepStrictEqual(afterTransactions, beforeTransactions);
      assert.equal((await returnedAudits(parkedA.sourceRecordId)).length, 0);
      assert.equal((await returnedAudits(parkedB.sourceRecordId)).length, 0);
    };
    await assertUnchanged();
    await new Promise<void>((resolve) => setTimeout(resolve, 800));
    assert.equal(transportCalls, 3, "a 503 is retried in-process and does not fail the tick");
    await assertUnchanged();
  });
});
