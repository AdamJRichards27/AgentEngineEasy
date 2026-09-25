// R-F4: opt-in scheduled WAITING_ON sweep. The flag is off unless it is the
// literal string "true". Under NODE_ENV=test the registrar arms no timer.
// A tick returns overdue rows per brokerage with the ops audit identity,
// isolates a brokerage that throws, and a second tick returns nothing new.
// Two sweeps in parallel prove the version check: each row moves once.
// run.access is not consulted here. lib/entitlements/resolver.ts answers
// per user, and this scheduler has no user, so every overdue brokerage is swept.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, auditLogs, pitCrewAssignments } from "@aee/db";
import {
  claimWorkItem,
  startProgress,
  setWaitingOn,
  sweepOverdueWaitingOn,
  PIT_CREW_WAITING_ON_SWEEP_ACTOR_EMAIL,
} from "../assignment.js";
import {
  pitCrewWaitingOnSweepConfig,
  registerPitCrewWaitingOnSweep,
  resetPitCrewWaitingOnSweepSchedulerForTests,
  runScheduledWaitingOnSweep,
  stopPitCrewWaitingOnSweepScheduler,
} from "../waitingOnSweepBootstrap.js";
import { createOrUpdateException, newCorrelationId } from "../../exceptions/model.js";
import type { RiskFinding } from "../../exceptions/types.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

interface LogLine {
  level?: string;
  message?: string;
  enabled?: boolean;
  nodeEnv?: string | null;
  intervalMs?: number;
  brokerageId?: number;
  brokerages?: number;
  scanned?: number;
  returned?: number;
  skipped?: number;
  failedBrokerages?: number;
  durationMs?: number;
  cap?: number;
  error?: string;
  value?: string;
  fallbackMs?: number;
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

async function captureLogs<T>(fn: () => Promise<T> | T): Promise<{ result: T; logs: LogLine[] }> {
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
    const result = await fn();
    return { result, logs };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

describe("pitCrewWaitingOnSweepConfig", () => {
  test("enabled only for the literal string true", () => {
    const off = [undefined, "false", "TRUE", "1", " true", ""];
    for (const value of off) {
      const env: NodeJS.ProcessEnv = {};
      if (value !== undefined) env.PIT_CREW_WAITING_ON_SWEEP_ENABLED = value;
      assert.equal(pitCrewWaitingOnSweepConfig(env).enabled, false, `expected off for ${JSON.stringify(value)}`);
    }
    assert.equal(pitCrewWaitingOnSweepConfig({ PIT_CREW_WAITING_ON_SWEEP_ENABLED: "true" }).enabled, true);
  });

  test("interval defaults to 900000 and clamps into [60000, 86400000]", () => {
    assert.equal(pitCrewWaitingOnSweepConfig({}).intervalMs, 900000);
    assert.equal(pitCrewWaitingOnSweepConfig({ PIT_CREW_WAITING_ON_SWEEP_INTERVAL_MS: "900000" }).intervalMs, 900000);
    assert.equal(pitCrewWaitingOnSweepConfig({ PIT_CREW_WAITING_ON_SWEEP_INTERVAL_MS: "60000" }).intervalMs, 60000);
    assert.equal(pitCrewWaitingOnSweepConfig({ PIT_CREW_WAITING_ON_SWEEP_INTERVAL_MS: "59999" }).intervalMs, 60000);
    assert.equal(pitCrewWaitingOnSweepConfig({ PIT_CREW_WAITING_ON_SWEEP_INTERVAL_MS: "1000" }).intervalMs, 60000);
    assert.equal(pitCrewWaitingOnSweepConfig({ PIT_CREW_WAITING_ON_SWEEP_INTERVAL_MS: "86400000" }).intervalMs, 86400000);
    assert.equal(pitCrewWaitingOnSweepConfig({ PIT_CREW_WAITING_ON_SWEEP_INTERVAL_MS: "86400001" }).intervalMs, 86400000);
    assert.equal(pitCrewWaitingOnSweepConfig({ PIT_CREW_WAITING_ON_SWEEP_INTERVAL_MS: "90000000" }).intervalMs, 86400000);
  });

  test("a non-numeric interval falls back to 900000 and warns", async () => {
    const { result, logs } = await captureLogs(() =>
      pitCrewWaitingOnSweepConfig({ PIT_CREW_WAITING_ON_SWEEP_INTERVAL_MS: "nope" }),
    );
    assert.equal(result.intervalMs, 900000);
    const warning = logs.find((line) => line.message === "pit_crew_waiting_on_sweep_interval_invalid");
    assert.ok(warning, "expected a warning for a non-numeric interval");
    assert.equal(warning.level, "warn");
    assert.equal(warning.value, "nope");
    assert.equal(warning.fallbackMs, 900000);
  });
});

describe("registerPitCrewWaitingOnSweep", { concurrency: 1 }, () => {
  const savedEnabled = process.env.PIT_CREW_WAITING_ON_SWEEP_ENABLED;
  const savedInterval = process.env.PIT_CREW_WAITING_ON_SWEEP_INTERVAL_MS;

  before(() => {
    delete process.env.PIT_CREW_WAITING_ON_SWEEP_ENABLED;
    delete process.env.PIT_CREW_WAITING_ON_SWEEP_INTERVAL_MS;
  });

  after(() => {
    stopPitCrewWaitingOnSweepScheduler();
    resetPitCrewWaitingOnSweepSchedulerForTests();
    if (savedEnabled === undefined) delete process.env.PIT_CREW_WAITING_ON_SWEEP_ENABLED;
    else process.env.PIT_CREW_WAITING_ON_SWEEP_ENABLED = savedEnabled;
    if (savedInterval === undefined) delete process.env.PIT_CREW_WAITING_ON_SWEEP_INTERVAL_MS;
    else process.env.PIT_CREW_WAITING_ON_SWEEP_INTERVAL_MS = savedInterval;
  });

  test("registerPitCrewWaitingOnSweep() under NODE_ENV=test starts no timer and is idempotent", async () => {
    assert.equal(process.env.NODE_ENV, "test");
    resetPitCrewWaitingOnSweepSchedulerForTests();
    const delays: number[] = [];
    const original = globalThis.setInterval;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      delays.push(Number(args[1]));
      return original(...args);
    }) as typeof setInterval;
    try {
      const { logs } = await captureLogs(() => {
        registerPitCrewWaitingOnSweep();
        registerPitCrewWaitingOnSweep();
      });
      assert.deepEqual(delays, []);
      const disabled = logs.filter((line) => line.message === "pit_crew_waiting_on_sweep_scheduler_disabled");
      assert.equal(disabled.length, 1);
      assert.equal(disabled[0]!.enabled, false);
      assert.equal(disabled[0]!.nodeEnv, "test");
      assert.equal(logs.some((line) => line.message === "pit_crew_waiting_on_sweep_scheduler_started"), false);
    } finally {
      globalThis.setInterval = original;
      stopPitCrewWaitingOnSweepScheduler();
    }
  });

  test("startScheduler true arms one unref'd interval at the configured period", async () => {
    resetPitCrewWaitingOnSweepSchedulerForTests();
    const original = globalThis.setInterval;
    const armed: { handle: ReturnType<typeof setInterval> | null } = { handle: null };
    let delay = 0;
    let calls = 0;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      calls += 1;
      delay = Number(args[1]);
      const handle = original(...args);
      armed.handle = handle;
      return handle;
    }) as typeof setInterval;
    try {
      const { logs } = await captureLogs(() => {
        registerPitCrewWaitingOnSweep({ startScheduler: true });
        registerPitCrewWaitingOnSweep({ startScheduler: true });
      });
      assert.equal(calls, 1);
      assert.equal(delay, 900000);
      assert.ok(armed.handle, "expected the scheduler to arm one interval");
      assert.equal(armed.handle.hasRef(), false, "the interval must be unref'd");
      const started = logs.filter((line) => line.message === "pit_crew_waiting_on_sweep_scheduler_started");
      assert.equal(started.length, 1);
      assert.equal(started[0]!.intervalMs, 900000);
    } finally {
      globalThis.setInterval = original;
      stopPitCrewWaitingOnSweepScheduler();
    }
  });
});

describe("runScheduledWaitingOnSweep", { concurrency: 1 }, () => {
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

  function buildFinding(targetBrokerageId: number, targetPropertyId: number): RiskFinding {
    fixtureCounter += 1;
    return {
      ruleId: "TEST_PITCREW_WAITING_ON_SCHEDULER_RULE",
      ruleVersion: 1,
      category: "WORKFLOW_OPERATIONAL",
      severity: "ATTENTION",
      title: `Test PC waiting-on scheduler ${fixtureCounter}`,
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
      dedupKey: `TEST_PITCREW_WAITING_ON_SCHEDULER_RULE:${targetBrokerageId}:SCHED_${fixtureCounter}`,
      recurrenceMode: "REOPEN",
      requiresFinancialEntitlement: false,
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
    waitingOnExpectedAt?: Date;
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

    const createdA = await createBrokerageWithUsers(baseUrl, `PitCrew Sweep Sched A ${Date.now()}`);
    const createdB = await createBrokerageWithUsers(baseUrl, `PitCrew Sweep Sched B ${Date.now()}`);
    agentA = createdA.agent;
    agentB = createdB.agent;
    brokerageA = createdA.brokerageId;
    brokerageB = createdB.brokerageId;
    propertyA = await createProperty(agentA.cookie, "1 Waiting On Scheduler St");
    propertyB = await createProperty(agentB.cookie, "2 Waiting On Scheduler St");
  });

  after(async () => {
    stopPitCrewWaitingOnSweepScheduler();
    await cleanupBrokerages([brokerageA, brokerageB].filter((id) => typeof id === "number"));
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  test("a tick returns overdue rows in two brokerages and leaves null and future expected-at rows WAITING_ON", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 60 * 60 * 1000);
    const future = new Date(now.getTime() + 60 * 60 * 1000);
    const overdueA = await parkWaitingOn({
      brokerageId: brokerageA,
      propertyId: propertyA,
      actorUserId: agentA.user.id,
      waitingOnExpectedAt: past,
    });
    const overdueB = await parkWaitingOn({
      brokerageId: brokerageB,
      propertyId: propertyB,
      actorUserId: agentB.user.id,
      waitingOnExpectedAt: past,
    });
    const openEnded = await parkWaitingOn({
      brokerageId: brokerageA,
      propertyId: propertyA,
      actorUserId: agentA.user.id,
    });
    const later = await parkWaitingOn({
      brokerageId: brokerageB,
      propertyId: propertyB,
      actorUserId: agentB.user.id,
      waitingOnExpectedAt: future,
    });

    const { result, logs } = await captureLogs(() => runScheduledWaitingOnSweep(now, {
      brokerageIds: [brokerageA, brokerageB],
    }));
    assert.equal(result.overlapSkipped, false);
    assert.equal(result.brokerages, 2);
    assert.equal(result.scanned, 2);
    assert.equal(result.returned, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.failedBrokerages, 0);
    assert.equal(typeof result.durationMs, "number");

    const summary = logs.find((line) => line.message === "pit_crew_waiting_on_sweep_tick_completed");
    assert.ok(summary, "expected one tick summary");
    assert.equal(summary.brokerages, 2);
    assert.equal(summary.scanned, 2);
    assert.equal(summary.returned, 2);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.failedBrokerages, 0);
    assert.equal(summary.durationMs, result.durationMs);

    for (const parked of [overdueA, overdueB]) {
      const row = await loadAssignment(parked.sourceRecordId);
      assert.equal(row.status, "IN_PROGRESS");
      assert.equal(row.waitingOnParty, null);
      assert.equal(row.waitingOnNote, null);
      assert.equal(row.waitingOnSince, null);
      assert.equal(row.waitingOnExpectedAt, null);
      assert.equal(row.version, parked.version + 1);
      const audits = await returnedAudits(parked.sourceRecordId);
      assert.equal(audits.length, 1);
      assert.equal(audits[0]!.userId, null);
      assert.equal(audits[0]!.userEmail, PIT_CREW_WAITING_ON_SWEEP_ACTOR_EMAIL);
      assert.equal(audits[0]!.previousValue, "WAITING_ON");
      assert.equal(audits[0]!.updatedValue, "IN_PROGRESS");
    }

    const openRow = await loadAssignment(openEnded.sourceRecordId);
    assert.equal(openRow.status, "WAITING_ON");
    assert.equal(openRow.waitingOnExpectedAt, null);
    assert.equal(openRow.version, openEnded.version);

    const laterRow = await loadAssignment(later.sourceRecordId);
    assert.equal(laterRow.status, "WAITING_ON");
    assert.ok(laterRow.waitingOnExpectedAt);
    assert.equal(laterRow.version, later.version);
  });

  test("a second tick returns nothing new", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 5 * 60 * 1000);
    const parked = await parkWaitingOn({
      brokerageId: brokerageA,
      propertyId: propertyA,
      actorUserId: agentA.user.id,
      waitingOnExpectedAt: past,
    });

    const first = await runScheduledWaitingOnSweep(now, { brokerageIds: [brokerageA, brokerageB] });
    assert.ok(first.returned >= 1);
    const afterFirst = await loadAssignment(parked.sourceRecordId);
    assert.equal(afterFirst.status, "IN_PROGRESS");
    assert.equal(afterFirst.version, parked.version + 1);

    const second = await runScheduledWaitingOnSweep(now, { brokerageIds: [brokerageA, brokerageB] });
    assert.equal(second.overlapSkipped, false);
    assert.equal(second.returned, 0);
    assert.equal(second.scanned, 0);
    const afterSecond = await loadAssignment(parked.sourceRecordId);
    assert.equal(afterSecond.status, "IN_PROGRESS");
    assert.equal(afterSecond.version, afterFirst.version);
    assert.equal(afterSecond.waitingOnExpectedAt, null);
    const audits = await returnedAudits(parked.sourceRecordId);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.userId, null);
    assert.equal(audits[0]!.userEmail, PIT_CREW_WAITING_ON_SWEEP_ACTOR_EMAIL);
  });

  test("one brokerage throwing does not stop the other brokerage's return", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 60 * 1000);
    const stuck = await parkWaitingOn({
      brokerageId: brokerageA,
      propertyId: propertyA,
      actorUserId: agentA.user.id,
      waitingOnExpectedAt: past,
    });
    const other = await parkWaitingOn({
      brokerageId: brokerageB,
      propertyId: propertyB,
      actorUserId: agentB.user.id,
      waitingOnExpectedAt: past,
    });

    const { result, logs } = await captureLogs(() => runScheduledWaitingOnSweep(now, {
      brokerageIds: [brokerageA, brokerageB],
      beforeBrokerage: (brokerageId) => {
        if (brokerageId === brokerageA) throw new Error("forced brokerage failure");
      },
    }));
    assert.equal(result.overlapSkipped, false);
    assert.equal(result.failedBrokerages, 1);
    assert.equal(result.returned, 1);
    assert.equal(result.brokerages, 2);

    const failure = logs.find((line) => line.message === "pit_crew_waiting_on_sweep_brokerage_failed");
    assert.ok(failure, "expected a brokerage failure log");
    assert.equal(failure.level, "error");
    assert.equal(failure.brokerageId, brokerageA);
    assert.match(failure.error ?? "", /forced brokerage failure/);

    const summary = logs.find((line) => line.message === "pit_crew_waiting_on_sweep_tick_completed");
    assert.ok(summary);
    assert.equal(summary.failedBrokerages, 1);
    assert.equal(summary.returned, 1);

    const stuckRow = await loadAssignment(stuck.sourceRecordId);
    assert.equal(stuckRow.status, "WAITING_ON");
    assert.equal(stuckRow.version, stuck.version);
    await sweepOverdueWaitingOn({ now, brokerageId: brokerageA });

    const otherRow = await loadAssignment(other.sourceRecordId);
    assert.equal(otherRow.status, "IN_PROGRESS");
    assert.equal(otherRow.version, other.version + 1);
    assert.equal(otherRow.waitingOnExpectedAt, null);
    const audits = await returnedAudits(other.sourceRecordId);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.userId, null);
    assert.equal(audits[0]!.userEmail, PIT_CREW_WAITING_ON_SWEEP_ACTOR_EMAIL);
  });

  test("two sweeps in parallel return each overdue row once and skip the loser", async () => {
    // Two API instances do not share the in-process overlap guard. Each
    // calls sweepOverdueWaitingOn. Promise.all here is that race: the loser
    // of WHERE id = ? AND version = expected is skipped.
    const now = new Date();
    const past = new Date(now.getTime() - 60 * 1000);
    const firstRow = await parkWaitingOn({
      brokerageId: brokerageA,
      propertyId: propertyA,
      actorUserId: agentA.user.id,
      waitingOnExpectedAt: past,
    });
    const secondRow = await parkWaitingOn({
      brokerageId: brokerageA,
      propertyId: propertyA,
      actorUserId: agentA.user.id,
      waitingOnExpectedAt: past,
    });

    let arrivals = 0;
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const beforeReturn = async () => {
      arrivals += 1;
      if (arrivals >= 2) openGate();
      await gate;
    };

    const [left, right] = await Promise.all([
      sweepOverdueWaitingOn({ now, brokerageId: brokerageA, beforeReturn }),
      sweepOverdueWaitingOn({ now, brokerageId: brokerageA, beforeReturn }),
    ]);

    assert.equal(left.scanned, 2);
    assert.equal(right.scanned, 2);
    assert.equal(left.returned + right.returned, 2);
    assert.equal(left.skipped + right.skipped, 2);
    assert.equal(left.returned + left.skipped, left.scanned);
    assert.equal(right.returned + right.skipped, right.scanned);

    for (const parked of [firstRow, secondRow]) {
      const row = await loadAssignment(parked.sourceRecordId);
      assert.equal(row.status, "IN_PROGRESS");
      assert.equal(row.version, parked.version + 1);
      assert.equal(row.waitingOnExpectedAt, null);
      const audits = await returnedAudits(parked.sourceRecordId);
      assert.equal(audits.length, 1);
      assert.equal(audits[0]!.userId, null);
      assert.equal(audits[0]!.userEmail, PIT_CREW_WAITING_ON_SWEEP_ACTOR_EMAIL);
    }
  });

  test("a second tick started while the first is still running is skipped", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 60 * 1000);
    const parked = await parkWaitingOn({
      brokerageId: brokerageB,
      propertyId: propertyB,
      actorUserId: agentB.user.id,
      waitingOnExpectedAt: past,
    });

    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });

    const firstPromise = runScheduledWaitingOnSweep(now, {
      brokerageIds: [brokerageB],
      beforeBrokerage: async () => {
        markEntered();
        await hold;
      },
    });
    await entered;
    const { result: second, logs } = await captureLogs(() => runScheduledWaitingOnSweep(now, {
      brokerageIds: [brokerageB],
    }));
    assert.equal(second.overlapSkipped, true);
    assert.equal(second.returned, 0);
    assert.ok(logs.some((line) => line.message === "pit_crew_waiting_on_sweep_tick_skipped_overlap"));
    release();
    const first = await firstPromise;
    assert.equal(first.overlapSkipped, false);
    assert.equal(first.returned, 1);

    const row = await loadAssignment(parked.sourceRecordId);
    assert.equal(row.status, "IN_PROGRESS");
    assert.equal(row.version, parked.version + 1);
    const audits = await returnedAudits(parked.sourceRecordId);
    assert.equal(audits.length, 1);
  });

  test("a tick that hits the brokerage cap sweeps the lowest ids and logs truncation", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 60 * 1000);
    const lowerId = Math.min(brokerageA, brokerageB);
    const higherId = Math.max(brokerageA, brokerageB);
    const lower = lowerId === brokerageA
      ? { brokerageId: brokerageA, propertyId: propertyA, actorUserId: agentA.user.id }
      : { brokerageId: brokerageB, propertyId: propertyB, actorUserId: agentB.user.id };
    const higher = higherId === brokerageA
      ? { brokerageId: brokerageA, propertyId: propertyA, actorUserId: agentA.user.id }
      : { brokerageId: brokerageB, propertyId: propertyB, actorUserId: agentB.user.id };
    const kept = await parkWaitingOn({ ...lower, waitingOnExpectedAt: past });
    const deferred = await parkWaitingOn({ ...higher, waitingOnExpectedAt: past });

    const { result, logs } = await captureLogs(() => runScheduledWaitingOnSweep(now, {
      brokerageIds: [brokerageA, brokerageB],
      maxBrokerages: 1,
    }));
    assert.equal(result.brokerages, 1);
    assert.equal(result.returned, 1);
    const truncation = logs.find((line) => line.message === "pit_crew_waiting_on_sweep_brokerages_truncated");
    assert.ok(truncation, "expected a truncation warning");
    assert.equal(truncation.level, "warn");
    assert.equal(truncation.cap, 1);

    const keptRow = await loadAssignment(kept.sourceRecordId);
    assert.equal(keptRow.status, "IN_PROGRESS");
    assert.equal(keptRow.version, kept.version + 1);
    const deferredRow = await loadAssignment(deferred.sourceRecordId);
    assert.equal(deferredRow.status, "WAITING_ON");
    assert.equal(deferredRow.version, deferred.version);
  });
});
