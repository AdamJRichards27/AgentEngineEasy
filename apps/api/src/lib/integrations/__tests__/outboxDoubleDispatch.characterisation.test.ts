// F-02 — characterisation (d38cbb33), flipped to [F-02 FIXED] by the claim lock in outbox.ts (F-02b). Integrations outbox
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
// At d38cbb33, "[F-02 GAP] CURRENT:" tests pinned the race. On F-02b they are
// replaced by "[F-02 FIXED]" tests asserting the INTENDED result. "[F-02 LOCK]" tests pin
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

// ---------------------------------------------------------------------
// [F-02 FIXED] with the claim lock. These replace the [F-02 GAP] CURRENT
// tests of d38cbb33, using the same harness and interleavings: the second
// dispatcher now loses the conditional claim and never reaches the provider.
// ---------------------------------------------------------------------

/** Both dispatchers pass the early status read and queue on the row lock; after release only the claim winner reaches adapter.send. */
async function raceTwoClaim(outboxId: string, idempotencyKey: string, startFirst: () => Promise<unknown>, startSecond: () => Promise<unknown>) {
  const gate = gateSendFor(idempotencyKey);
  const lock = await holdRowLock(outboxId);
  let first: Promise<unknown>;
  let second: Promise<unknown>;
  try {
    first = startFirst();
    await lock.waitForBlocked(1);
    second = startSecond();
    second.catch(() => undefined);
    await lock.waitForBlocked(2);
  } finally {
    await lock.release();
  }
  await gate.arrived(1);
  return { gate, first: first!, second: second! };
}

/** The loser must be refused BEFORE the provider. Without the claim lock it would instead park at the send gate; fail fast in that case rather than time out. */
async function expectClaimLost(second: Promise<unknown>, gate: { arrived: (n: number) => Promise<void> }): Promise<void> {
  const outcome = await Promise.race([
    second.then(() => "resolved", (err: any) => (err?.reason === "INVALID_STATUS" ? "refused" : `rejected:${err?.reason ?? err}`)),
    gate.arrived(2).then(() => "second-send"),
  ]);
  assert.equal(outcome, "refused", "the losing dispatcher must get INVALID_STATUS and never reach adapter.send");
}

test("[F-02 FIXED] two concurrent dispatchCommand calls: exactly one claim and send; the loser gets INVALID_STATUS (was: double send, two attempt #1 rows)", async () => {
  const cmd = await enqueuePastDue("two-direct", {});
  const { gate, first, second } = await raceTwoClaim(cmd.id, cmd.idempotencyKey, () => dispatchCommand(cmd.id), () => dispatchCommand(cmd.id));
  await expectClaimLost(second, gate);
  gate.calls[0].before.resolve();
  gate.calls[0].after.resolve();
  const r1 = (await first) as { status: string };
  assert.equal(r1.status, "SENT");
  assert.equal(gate.calls.length, 1, "the provider is called once");
  const state = await readState(cmd.id);
  assert.deepEqual(state.attempts, [{ attemptNumber: 1, status: "SENT" }]);
  assert.equal(state.row.status, "SENT");
  assert.equal(state.row.attempts, 1);
});

test("[F-02 FIXED] sweep vs on-demand dispatch: the sweep wins the claim and the on-demand dispatch is refused before the provider (was: both send)", async () => {
  const cmd = await enqueuePastDue("sweep-vs-direct", {});
  const { gate, first, second } = await raceTwoClaim(cmd.id, cmd.idempotencyKey, () => dispatchDueOutbox(SWEEP_NOW), () => dispatchCommand(cmd.id));
  await expectClaimLost(second, gate);
  gate.calls[0].before.resolve();
  gate.calls[0].after.resolve();
  const sweep = (await first) as { dispatchedCount: number; errorCount: number };
  assert.deepEqual(sweep, { dispatchedCount: 1, errorCount: 0 });
  assert.equal(gate.calls.length, 1);
  assert.deepEqual((await readState(cmd.id)).attempts, [{ attemptNumber: 1, status: "SENT" }]);
});

test("[F-02 FIXED] no lost update: a rate-limited first attempt is retried once and ends SENT with attempts #1 FAILED, #2 SENT (was: SENT overwritten to RETRY_SCHEDULED, then a 3rd send)", async () => {
  const cmd = await enqueuePastDue("lost-update", { __forceRateLimit: true });
  const { gate, first, second } = await raceTwoClaim(cmd.id, cmd.idempotencyKey, () => dispatchCommand(cmd.id), () => dispatchCommand(cmd.id));
  await expectClaimLost(second, gate);
  gate.calls[0].before.resolve();
  await gate.calls[0].ran.promise;
  assert.equal(gate.calls[0].outcome, "FAILED:RATE_LIMITED");
  gate.calls[0].after.resolve();
  const r1 = (await first) as { status: string; attempts: number };
  assert.equal(r1.status, "RETRY_SCHEDULED");
  assert.equal(r1.attempts, 1);

  // The scheduled retry (driven directly here) is the only further provider call.
  restoreSend?.();
  restoreSend = null;
  let retryCalls = 0;
  mockPortalAdapter.send = async (capability, payload, ctx) => {
    if (ctx.idempotencyKey === cmd.idempotencyKey) retryCalls++;
    return originalSend.call(mockPortalAdapter, capability, payload, ctx);
  };
  restoreSend = () => {
    mockPortalAdapter.send = originalSend;
  };
  const again = await dispatchCommand(cmd.id);
  assert.equal(retryCalls, 1);
  assert.equal(again.status, "SENT");
  assert.equal(again.attempts, 2);
  assert.deepEqual((await readState(cmd.id)).attempts, [
    { attemptNumber: 1, status: "FAILED" },
    { attemptNumber: 2, status: "SENT" },
  ]);
  await assert.rejects(dispatchCommand(cmd.id), (err: any) => err?.reason === "INVALID_STATUS");
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

test("[F-02 LOCK] the sweep skips not-yet-due and live-lease DISPATCHING commands (a claim-based fix relies on DISPATCHING being invisible to the sweep)", async () => {
  const notDue = await enqueuePastDue("not-due", {});
  await db.update(integrationOutbox).set({ nextAttemptAt: new Date("2000-01-02T00:00:00.000Z") }).where(eq(integrationOutbox.id, notDue.id));
  const claimed = await enqueuePastDue("claimed", {});
  // RECOVERY SKETCH: a LIVE lease (expires tomorrow) is skipped; an expired one would be reclaimed (tests below).
  await db.update(integrationOutbox).set({ status: "DISPATCHING", nextAttemptAt: new Date(Date.now() + 86_400_000) }).where(eq(integrationOutbox.id, claimed.id));
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

// ---------------------------------------------------------------------
// [RECOVERY] outbound-message recovery (specs/outbound-message-recovery.md).
// A DISPATCHING row whose lease expired has an UNKNOWN outcome: it is never
// blindly re-sent. The adapter's declared `recovery` capability decides:
// lookup -> reconcile; dedupes -> resend with the SAME key; else MANUAL_REVIEW.
// ---------------------------------------------------------------------

const originalRecovery = mockPortalAdapter.recovery;
function setPortalRecovery(recovery: typeof mockPortalAdapter.recovery) {
  mockPortalAdapter.recovery = recovery;
  const prev = restoreSend;
  restoreSend = () => {
    prev?.();
    mockPortalAdapter.recovery = originalRecovery;
  };
}
function countSendsFor(idempotencyKey: string): { calls: number; keys: string[] } {
  const seen = { calls: 0, keys: [] as string[] };
  mockPortalAdapter.send = async (capability, payload, ctx) => {
    if (ctx.idempotencyKey === idempotencyKey) {
      seen.calls++;
      seen.keys.push(ctx.idempotencyKey);
    }
    return originalSend.call(mockPortalAdapter, capability, payload, ctx);
  };
  const prev = restoreSend;
  restoreSend = () => {
    prev?.();
    mockPortalAdapter.send = originalSend;
  };
  return seen;
}
async function strandWithExpiredLease(label: string, extra: Partial<{ attempts: number; maxAttempts: number }> = {}) {
  const cmd = await enqueuePastDue(label, {});
  // Simulate a crash after the claim: DISPATCHING, lease long expired.
  await db.update(integrationOutbox).set({ status: "DISPATCHING", nextAttemptAt: PAST_DUE, ...extra }).where(eq(integrationOutbox.id, cmd.id));
  return cmd;
}

afterEach(() => {
  // Belt and braces: no test may leak a recovery override into the next.
  mockPortalAdapter.recovery = originalRecovery;
});

test("[RECOVERY] the mock portal declares it cannot dedupe or look up (contract)", () => {
  assert.deepEqual(mockPortalAdapter.recovery, { dedupesOnIdempotencyKey: false });
});

test("[RECOVERY] an expired-lease row on a non-deduping adapter goes to MANUAL_REVIEW via the sweep, with 0 provider calls", async () => {
  const cmd = await strandWithExpiredLease("crashed-nodedupe");
  const seen = countSendsFor(cmd.idempotencyKey);
  const sweep = await dispatchDueOutbox(SWEEP_NOW);
  assert.equal(sweep.errorCount, 0);
  assert.equal(seen.calls, 0, "an uncertain send is never blindly retried");
  const state = await readState(cmd.id);
  assert.equal(state.row.status, "MANUAL_REVIEW");
  assert.equal(state.row.attempts, 1, "the reclaim counts the crashed attempt");
  assert.match(state.row.lastError ?? "", /NO_DEDUPE_NO_LOOKUP/);
  assert.deepEqual(state.attempts, [], "no provider call, so no attempt row");
});

test("[RECOVERY] a deduping adapter is re-sent with the SAME idempotency key, once, as attempt #2", async () => {
  const cmd = await strandWithExpiredLease("crashed-dedupe");
  setPortalRecovery({ dedupesOnIdempotencyKey: true });
  const seen = countSendsFor(cmd.idempotencyKey);
  const result = await dispatchCommand(cmd.id);
  assert.equal(result.status, "SENT");
  assert.equal(seen.calls, 1);
  assert.deepEqual(seen.keys, [cmd.idempotencyKey]);
  const state = await readState(cmd.id);
  assert.equal(state.row.attempts, 2);
  assert.deepEqual(state.attempts, [{ attemptNumber: 2, status: "SENT" }]);
});

test("[RECOVERY] lookup DELIVERED reconciles to SENT without a send; NOT_FOUND re-sends once with the same key; UNKNOWN and a failing lookup go to MANUAL_REVIEW", async () => {
  const cases: Array<{ label: string; lookup: () => Promise<"DELIVERED" | "NOT_FOUND" | "UNKNOWN">; status: string; calls: number }> = [
    { label: "lookup-delivered", lookup: async () => "DELIVERED", status: "SENT", calls: 0 },
    { label: "lookup-notfound", lookup: async () => "NOT_FOUND", status: "SENT", calls: 1 },
    { label: "lookup-unknown", lookup: async () => "UNKNOWN", status: "MANUAL_REVIEW", calls: 0 },
    { label: "lookup-throws", lookup: async () => { throw new Error("provider lookup timed out"); }, status: "MANUAL_REVIEW", calls: 0 },
  ];
  for (const c of cases) {
    const cmd = await strandWithExpiredLease(c.label);
    const lookedUp: string[] = [];
    setPortalRecovery({ dedupesOnIdempotencyKey: false, lookupByIdempotencyKey: async (key) => (lookedUp.push(key), c.lookup()) });
    const seen = countSendsFor(cmd.idempotencyKey);
    const result = await dispatchCommand(cmd.id);
    assert.equal(result.status, c.status, c.label);
    assert.equal(seen.calls, c.calls, c.label);
    assert.deepEqual(lookedUp, [cmd.idempotencyKey], `${c.label}: looked up by the row's own key`);
    if (c.calls) assert.deepEqual(seen.keys, [cmd.idempotencyKey], c.label);
    const state = await readState(cmd.id);
    if (c.label === "lookup-delivered") assert.deepEqual(state.attempts, [{ attemptNumber: 2, status: "SENT" }]);
    restoreSend?.();
    restoreSend = null;
  }
});

test("[RECOVERY] a live lease is not reclaimed by a direct dispatch or by the sweep", async () => {
  const cmd = await enqueuePastDue("live-lease", {});
  await db.update(integrationOutbox).set({ status: "DISPATCHING", nextAttemptAt: new Date(Date.now() + 86_400_000) }).where(eq(integrationOutbox.id, cmd.id));
  const seen = countSendsFor(cmd.idempotencyKey);
  await assert.rejects(dispatchCommand(cmd.id), (err: Error & { reason?: string }) => err.reason === "INVALID_STATUS");
  await dispatchDueOutbox(SWEEP_NOW);
  assert.equal(seen.calls, 0);
  const state = await readState(cmd.id);
  assert.equal(state.row.status, "DISPATCHING");
  assert.equal(state.row.attempts, 0);
  await db.update(integrationOutbox).set({ status: "DEAD_LETTERED" }).where(eq(integrationOutbox.id, cmd.id));
});

test("[RECOVERY] a row whose lease keeps expiring dead-letters at maxAttempts without calling the provider", async () => {
  const cmd = await strandWithExpiredLease("crash-loop", { attempts: 4, maxAttempts: 5 });
  const seen = countSendsFor(cmd.idempotencyKey);
  const result = await dispatchCommand(cmd.id);
  assert.equal(result.status, "DEAD_LETTERED");
  assert.equal(seen.calls, 0);
  assert.equal(result.attempts, 5);
});

test("[RECOVERY] a stale dispatcher whose lease was taken over (deduping adapter) cannot overwrite the new holder's outcome", async () => {
  const cmd = await enqueuePastDue("stale-writer", {});
  const gate = gateSendFor(cmd.idempotencyKey);
  setPortalRecovery({ dedupesOnIdempotencyKey: true }); // after gateSendFor: chains onto (not over) its restore
  const stale = dispatchCommand(cmd.id);
  await gate.arrived(1);
  await db.update(integrationOutbox).set({ nextAttemptAt: PAST_DUE }).where(eq(integrationOutbox.id, cmd.id));
  const fresh = dispatchCommand(cmd.id);
  await gate.arrived(2);
  gate.calls[1].before.resolve();
  gate.calls[1].after.resolve();
  assert.equal((await fresh).status, "SENT");
  gate.calls[0].before.resolve();
  gate.calls[0].after.resolve();
  assert.equal((await stale).status, "SENT", "the stale dispatcher returns the current row and writes no outcome of its own");
  const state = await readState(cmd.id);
  assert.equal(state.row.attempts, 2);
  assert.deepEqual(state.attempts.map((a) => a.attemptNumber).sort((x, y) => x - y), [1, 2]);
});

test("[RECOVERY] a stale dispatcher finishing after its row went to MANUAL_REVIEW cannot overwrite MANUAL_REVIEW", async () => {
  const cmd = await enqueuePastDue("stale-vs-review", {});
  const gate = gateSendFor(cmd.idempotencyKey);
  const stale = dispatchCommand(cmd.id);
  await gate.arrived(1);
  await db.update(integrationOutbox).set({ nextAttemptAt: PAST_DUE }).where(eq(integrationOutbox.id, cmd.id));
  const reviewed = await dispatchCommand(cmd.id); // non-deduping: reclaim goes straight to review
  assert.equal(reviewed.status, "MANUAL_REVIEW");
  gate.calls[0].before.resolve();
  gate.calls[0].after.resolve();
  assert.equal((await stale).status, "MANUAL_REVIEW");
  const state = await readState(cmd.id);
  assert.equal(state.row.status, "MANUAL_REVIEW", "the late provider answer is recorded as history only");
  assert.equal(gate.calls.length, 1);
});

test("[RECOVERY] two reclaimers racing on the same expired lease: exactly one claims, one terminal outcome", async () => {
  const cmd = await strandWithExpiredLease("reclaim-race");
  const seen = countSendsFor(cmd.idempotencyKey);
  const settled = await Promise.allSettled([dispatchCommand(cmd.id), dispatchCommand(cmd.id)]);
  const fulfilled = settled.filter((s) => s.status === "fulfilled");
  const rejected = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
  // The loser either stands down at the claim (INVALID_STATUS) or, if it read after the winner finished, is refused up front.
  assert.ok(fulfilled.length >= 1);
  for (const r of rejected) assert.equal((r.reason as { reason?: string }).reason, "INVALID_STATUS");
  assert.equal(seen.calls, 0);
  const state = await readState(cmd.id);
  assert.equal(state.row.status, "MANUAL_REVIEW");
  assert.equal(state.row.attempts, 1, "only one reclaim was counted");
});

test("[RECOVERY] rolling-deploy safety: the sweep never selects MANUAL_REVIEW rows", async () => {
  const cmd = await enqueuePastDue("review-ignored", {});
  await db.update(integrationOutbox).set({ status: "MANUAL_REVIEW", nextAttemptAt: PAST_DUE }).where(eq(integrationOutbox.id, cmd.id));
  const seen = countSendsFor(cmd.idempotencyKey);
  await dispatchDueOutbox(SWEEP_NOW);
  await assert.rejects(dispatchCommand(cmd.id), (err: Error & { reason?: string }) => err.reason === "INVALID_STATUS");
  assert.equal(seen.calls, 0);
  assert.equal((await readState(cmd.id)).row.status, "MANUAL_REVIEW");
});
