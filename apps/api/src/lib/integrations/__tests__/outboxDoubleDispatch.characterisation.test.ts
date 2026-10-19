// F-02 — CHARACTERISATION ONLY (no production change). Integrations outbox
// double-dispatch race in outbox.ts (dispatchCommand / dispatchCommandInner).
//
// The gap: dispatchCommand reads the row and checks its status
// (PENDING/RETRY_SCHEDULED) with a plain SELECT. dispatchCommandInner then
// runs `UPDATE integration_outbox SET status='DISPATCHING' WHERE id=$1`
// with NO status predicate. Two dispatchers (a sweep plus an on-demand
// dispatch, or two API instances' sweeps) that both read the row before
// either claims it will BOTH claim it, BOTH call adapter.send, BOTH insert
// an attempt row with the same attemptNumber (no unique index on
// (outbox_id, attempt_number)), and the last writer decides the final
// status.
//
// "[F-02 GAP] CURRENT:" tests pin today's behaviour. A claim-lock fix MUST
// flip them; each says what the INTENDED result is. "[F-02 LOCK]" tests pin
// behaviour a fix must keep.
//
// Deterministic interleaving (same approach as F-01, no sleeps or timing
// races):
//   1. A separate pooled connection takes `SELECT ... FOR UPDATE` on the row.
//      Each dispatcher's plain status SELECT still passes (MVCC), and its
//      UPDATE then blocks on the row lock. The test polls pg_stat_activity
//      with pg_blocking_pids() until exactly N waiters are blocked, directly
//      or transitively, BY THE HOLDER, so unrelated sessions can't be miscounted.
//   2. The holder commits. The waiters claim the row in lock-queue order.
//   3. The mock portal adapter's send is wrapped. Every call parks at a
//      "before" gate and then an "after" gate. The test releases the gates
//      in a fixed order, which fixes both the provider-call order and the
//      DB write order.
//
// µs/ms due-time trap: next_attempt_at defaults to DB now() (µs). A JS
// `new Date()` sweep cutoff is ms, so a just-inserted row can be "not yet
// due". Fixtures therefore set next_attempt_at explicitly to 1999-12-31,
// and the sweep test passes now = 2000-01-01. That also scopes the sweep to
// this file's rows: nothing else in the suite has a 1999 due time, and no
// test runs the production sweep timer (only index.ts starts it).
//
// Synthetic data only.

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import { db, pool, integrationOutbox, integrationOutboxAttempts } from "@aee/db";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";
import { bootstrapIntegrationsForTesting, createActiveMockPortalConnection } from "./testHelpers.js";
import { enqueueCommand, dispatchCommand, dispatchDueOutbox, mintIdempotencyKey } from "../outbox.js";
import { mockPortalAdapter } from "../adapters/mockPortal.js";
import { INTEGRATION_CAPABILITIES } from "../types.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const PAST_DUE = new Date("1999-12-31T00:00:00.000Z");
const SWEEP_NOW = new Date("2000-01-01T00:00:00.000Z");

let server: Server;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let connectionId: string;
const suffix = Date.now();

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { createApp } = await import("../../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  await bootstrapIntegrationsForTesting();
  A = await createBrokerageWithUsers(`http://127.0.0.1:${address.port}`, `F02 Outbox Race ${suffix}`);
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, { id: A.admin.user.id, role: A.admin.user.role });
  connectionId = connection.id;
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId].filter((id): id is number => typeof id === "number"));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

// ---------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

interface ParkedCall {
  index: number;
  before: ReturnType<typeof deferred>;
  after: ReturnType<typeof deferred>;
  ran: ReturnType<typeof deferred>;
  outcome?: string;
}

const originalSend = mockPortalAdapter.send;
let restoreSend: (() => void) | null = null;

/** Wraps mockPortalAdapter.send for ONE idempotency key. Each call parks at `before`, then runs the real adapter (which records `ran`), then parks at `after`. Other keys pass straight through. */
function gateSendFor(idempotencyKey: string): { calls: ParkedCall[]; arrived: (n: number) => Promise<void> } {
  const calls: ParkedCall[] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  mockPortalAdapter.send = async (capability, payload, ctx) => {
    if (ctx.idempotencyKey !== idempotencyKey) return originalSend.call(mockPortalAdapter, capability, payload, ctx);
    const call: ParkedCall = { index: calls.length, before: deferred(), after: deferred(), ran: deferred() };
    calls.push(call);
    for (const w of waiters) if (calls.length >= w.n) w.resolve();
    await call.before.promise;
    const result = await originalSend.call(mockPortalAdapter, capability, payload, ctx);
    call.outcome = result.status === "SENT" ? "SENT" : `FAILED:${result.failureCategory}`;
    call.ran.resolve();
    await call.after.promise;
    return result;
  };
  restoreSend = () => {
    mockPortalAdapter.send = originalSend;
  };
  return {
    calls,
    arrived: (n) =>
      calls.length >= n ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ n, resolve })),
  };
}

afterEach(() => {
  restoreSend?.();
  restoreSend = null;
});

/** Holds the row lock on a dedicated connection. waitForBlocked(n) resolves once exactly n sessions are blocked (directly or transitively) by THIS holder. */
async function holdRowLock(outboxId: string) {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT id FROM integration_outbox WHERE id = $1 FOR UPDATE", [outboxId]);
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const holderPid = rows[0].pid;
  return {
    async waitForBlocked(n: number): Promise<void> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        // Transitive: the 2nd waiter queues behind the 1st on the tuple lock, so PG reports the 1st waiter (not the holder) as its blocker.
        const r = await db.execute(sql`SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0`);
        const rowsB: Array<{ pid: number; blockers: number[] }> = ((r as any).rows ?? r) as any;
        const chain = new Set<number>([holderPid]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const b of rowsB) if (!chain.has(b.pid) && b.blockers.some((x) => chain.has(x))) { chain.add(b.pid); grew = true; }
        }
        const c = chain.size - 1;
        if (c === n) return;
        if (c > n) throw new Error(`expected ${n} sessions blocked by holder ${holderPid}, saw ${c}`);
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} blocked sessions (saw ${c})`);
        await new Promise((r2) => setImmediate(r2));
      }
    },
    async release(): Promise<void> {
      try {
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    },
  };
}

async function enqueuePastDue(label: string, payload: Record<string, unknown>) {
  const idempotencyKey = mintIdempotencyKey(`f02-${label}-${suffix}`);
  const row = await enqueueCommand({
    brokerageId: A.brokerageId,
    connectionId,
    capability: INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING,
    commandPayload: { destination: `f02-${label}`, ...payload },
    idempotencyKey,
    sourceRecordType: "test",
    sourceRecordId: `f02-${label}`,
  });
  await db.update(integrationOutbox).set({ nextAttemptAt: PAST_DUE }).where(eq(integrationOutbox.id, row.id));
  return { id: row.id, idempotencyKey };
}

async function readState(outboxId: string) {
  const [row] = await db.select().from(integrationOutbox).where(eq(integrationOutbox.id, outboxId));
  const attempts = await db.select().from(integrationOutboxAttempts).where(eq(integrationOutboxAttempts.outboxId, outboxId)).orderBy(integrationOutboxAttempts.id);
  return { row, attempts: attempts.map((a) => ({ attemptNumber: a.attemptNumber, status: a.status })) };
}

/** Both dispatchers pass the status check and then block on the row lock; release them, and both reach adapter.send. */
async function raceTwo(outboxId: string, idempotencyKey: string, startFirst: () => Promise<unknown>, startSecond: () => Promise<unknown>) {
  const gate = gateSendFor(idempotencyKey);
  const lock = await holdRowLock(outboxId);
  let first: Promise<unknown>;
  let second: Promise<unknown>;
  try {
    first = startFirst();
    await lock.waitForBlocked(1);
    second = startSecond();
    await lock.waitForBlocked(2);
  } finally {
    await lock.release();
  }
  await gate.arrived(2);
  return { gate, first: first!, second: second! };
}

// ---------------------------------------------------------------------
// [F-02 GAP] CURRENT behaviour.
// ---------------------------------------------------------------------

test("[F-02 GAP] CURRENT: two concurrent dispatchCommand calls on one PENDING command both send it and both record attempt #1 (INTENDED: exactly one claim and send; the loser gets INVALID_STATUS or a no-op)", async () => {
  const cmd = await enqueuePastDue("two-direct", {});
  const { gate, first, second } = await raceTwo(cmd.id, cmd.idempotencyKey, () => dispatchCommand(cmd.id), () => dispatchCommand(cmd.id));

  for (const call of gate.calls) {
    call.before.resolve();
    await call.ran.promise;
    call.after.resolve();
  }
  const [r1, r2] = (await Promise.all([first, second])) as Array<{ status: string }>;

  assert.equal(gate.calls.length, 2, "CURRENT: the provider is called twice for one command and one idempotency key");
  assert.deepEqual(gate.calls.map((c) => c.outcome), ["SENT", "SENT"]);
  assert.equal(r1.status, "SENT");
  assert.equal(r2.status, "SENT");
  const state = await readState(cmd.id);
  assert.deepEqual(state.attempts, [
    { attemptNumber: 1, status: "SENT" },
    { attemptNumber: 1, status: "SENT" },
  ], "CURRENT: two attempt rows that both claim to be attempt #1");
  assert.equal(state.row.status, "SENT");
  assert.equal(state.row.attempts, 1, "CURRENT: the counter says 1 attempt although the provider saw 2");
});

test("[F-02 GAP] CURRENT: the due-outbox sweep and an on-demand dispatch race on one command; both send (INTENDED: the sweep skips a command another dispatcher has claimed)", async () => {
  const cmd = await enqueuePastDue("sweep-vs-direct", {});
  const { gate, first, second } = await raceTwo(cmd.id, cmd.idempotencyKey, () => dispatchDueOutbox(SWEEP_NOW), () => dispatchCommand(cmd.id));

  for (const call of gate.calls) {
    call.before.resolve();
    await call.ran.promise;
    call.after.resolve();
  }
  const [sweep, direct] = (await Promise.all([first, second])) as [{ dispatchedCount: number; errorCount: number }, { status: string }];

  assert.deepEqual(sweep, { dispatchedCount: 1, errorCount: 0 }, "the sweep (scoped by now=2000-01-01) saw only this file's command");
  assert.equal(direct.status, "SENT");
  assert.equal(gate.calls.length, 2, "CURRENT: double send");
  const state = await readState(cmd.id);
  assert.equal(state.attempts.length, 2);
  assert.ok(state.attempts.every((a) => a.attemptNumber === 1));
});

test("[F-02 GAP] CURRENT: lost update. A provider-ACCEPTED command ends RETRY_SCHEDULED because the failing dispatcher writes last, and the next dispatch sends it a THIRD time (INTENDED: a SENT outcome is final, and only one dispatcher ever writes)", async () => {
  // mock portal: the first call for a key is RATE_LIMITED (retryable), the second is SENT.
  const cmd = await enqueuePastDue("lost-update", { __forceRateLimit: true });
  const { gate, first, second } = await raceTwo(cmd.id, cmd.idempotencyKey, () => dispatchCommand(cmd.id), () => dispatchCommand(cmd.id));

  const [callA, callB] = gate.calls;
  // Provider order: A then B. A gets attempt 1 (RATE_LIMITED); B gets attempt 2 (SENT).
  callA.before.resolve();
  await callA.ran.promise;
  callB.before.resolve();
  await callB.ran.promise;
  assert.deepEqual([callA.outcome, callB.outcome], ["FAILED:RATE_LIMITED", "SENT"]);

  // DB write order: B (SENT) first, then A (RETRY_SCHEDULED) LAST.
  const firstSettled = Promise.race([first.then(() => "first"), second.then(() => "second")]);
  callB.after.resolve();
  const winner = await firstSettled;
  callA.after.resolve();
  await Promise.all([first, second]);
  assert.ok(winner === "first" || winner === "second");

  const state = await readState(cmd.id);
  assert.deepEqual(state.attempts, [
    { attemptNumber: 1, status: "SENT" },
    { attemptNumber: 1, status: "FAILED" },
  ], "CURRENT: both attempts are recorded as #1");
  assert.equal(state.row.status, "RETRY_SCHEDULED", "CURRENT: the accepted command is overwritten to RETRY_SCHEDULED by the last writer");
  assert.equal(state.row.dispatchedAt instanceof Date, true, "dispatchedAt from the SENT write survives under a RETRY_SCHEDULED status");

  // The next (here: direct) dispatch sends it again: a third provider call.
  restoreSend?.();
  restoreSend = null;
  let thirdCalls = 0;
  mockPortalAdapter.send = async (capability, payload, ctx) => {
    if (ctx.idempotencyKey === cmd.idempotencyKey) thirdCalls++;
    return originalSend.call(mockPortalAdapter, capability, payload, ctx);
  };
  restoreSend = () => {
    mockPortalAdapter.send = originalSend;
  };
  const again = await dispatchCommand(cmd.id);
  assert.equal(thirdCalls, 1, "CURRENT: a third provider call for one logical command");
  assert.equal(again.status, "SENT");
  assert.equal(again.attempts, 2);
});

// ---------------------------------------------------------------------
// [F-02 LOCK] behaviour a fix must keep.
// ---------------------------------------------------------------------

test("[F-02 LOCK] a sequential second dispatch of a SENT command is rejected INVALID_STATUS and does not reach the provider", async () => {
  const cmd = await enqueuePastDue("sequential", {});
  let calls = 0;
  mockPortalAdapter.send = async (capability, payload, ctx) => {
    if (ctx.idempotencyKey === cmd.idempotencyKey) calls++;
    return originalSend.call(mockPortalAdapter, capability, payload, ctx);
  };
  restoreSend = () => {
    mockPortalAdapter.send = originalSend;
  };
  const sent = await dispatchCommand(cmd.id);
  assert.equal(sent.status, "SENT");
  await assert.rejects(dispatchCommand(cmd.id), (err: any) => err?.reason === "INVALID_STATUS");
  assert.equal(calls, 1);
  const state = await readState(cmd.id);
  assert.deepEqual(state.attempts, [{ attemptNumber: 1, status: "SENT" }]);
  assert.equal(state.row.attempts, 1);
});

test("[F-02 LOCK] the sweep skips not-yet-due and DISPATCHING commands (a claim-based fix relies on DISPATCHING being invisible to the sweep)", async () => {
  const notDue = await enqueuePastDue("not-due", {});
  await db.update(integrationOutbox).set({ nextAttemptAt: new Date("2000-01-02T00:00:00.000Z") }).where(eq(integrationOutbox.id, notDue.id));
  const claimed = await enqueuePastDue("claimed", {});
  await db.update(integrationOutbox).set({ status: "DISPATCHING" }).where(eq(integrationOutbox.id, claimed.id));
  let calls = 0;
  mockPortalAdapter.send = async (capability, payload, ctx) => {
    if (ctx.idempotencyKey === notDue.idempotencyKey || ctx.idempotencyKey === claimed.idempotencyKey) calls++;
    return originalSend.call(mockPortalAdapter, capability, payload, ctx);
  };
  restoreSend = () => {
    mockPortalAdapter.send = originalSend;
  };
  const sweep = await dispatchDueOutbox(SWEEP_NOW);
  assert.deepEqual(sweep, { dispatchedCount: 0, errorCount: 0 });
  assert.equal(calls, 0);
  assert.equal((await readState(notDue.id)).row.status, "PENDING");
  assert.equal((await readState(claimed.id)).row.status, "DISPATCHING");
  // Leave nothing claimable behind.
  await db.update(integrationOutbox).set({ status: "DEAD_LETTERED" }).where(eq(integrationOutbox.id, claimed.id));
});
