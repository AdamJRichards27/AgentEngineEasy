// F-01: originally characterisation tests that pinned payment outbox double-dispatch under concurrent dispatchers
// (commit c2d898d2). The F-01 fix (conditional PENDING -> DISPATCHING claim in dispatchOutboxEntry, lease on
// nextAttemptAt, guarded success/failure writes; lib/financial/paymentOutbox.ts) has landed, so the former
// "[F-01 GAP]" tests are FLIPPED to "[F-01 FIXED]": they now assert exactly one dispatch. "[F-01 LOCK]" tests are
// unchanged and must keep passing.
//
// DETERMINISTIC HARNESS
// - Concurrency comes from the real code: real dispatchPendingPaymentOutbox() / scheduleDebitForPaymentRequest() /
//   dispatchOutboxEntry() calls on separate pooled DB connections.
// - mandatePaymentProvider.scheduleDebit is wrapped IN THIS TEST PROCESS ONLY (own-property override, removed
//   afterwards). For this file's own idempotency key, each call parks at a gate. Dispatcher 1 is parked inside the
//   provider call (it holds the claim); every other dispatcher is then run TO COMPLETION before dispatcher 1 is
//   released, so any second provider call would be counted exactly.
// - "Two instances" = the second call (if any) is answered by a separate SandboxMandatePaymentProvider instance.
// - Shared test DB caveat (disclosed): sweeps are global; files that create payment outbox rows keep them out of
//   sweeps (nextAttemptAt +24h, local/run-test-payment-outbox-isolation).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  db,
  commissionAgreements,
  pcFeeAuthorities,
  financialPaymentOutbox,
  financialPaymentRequests,
  financialLedgerEvents,
  domainEvents,
} from "@aee/db";
import { SandboxMandatePaymentProvider, type DebitRequest, type DebitResult, type MandatePaymentProvider } from "@aee/integration-mandate-payments";
import { createBrokerageWithUsers, createTransactionFromListedProperty, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";
import { createCommissionCalculation } from "../calculations.js";
import { createPcFeeCalculation } from "../pcFeeCalculations.js";
import { ensurePcSuccessFeeRequest } from "../settlement.js";
import { advancePaymentRequestToNoticeSent, dispatchOutboxEntry, dispatchPendingPaymentOutbox, scheduleDebitForPaymentRequest } from "../paymentOutbox.js";
import { mandatePaymentProvider } from "../provider.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

/** Every [F-01 FIXED] assertion carries this marker. */
const F01_FIXED = "F-01 fix: exactly one dispatch per payment outbox command under concurrent dispatchers";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let authorityVersionCounter = 0;

interface Fixture {
  transactionId: number;
  paymentRequestId: number;
  idempotencyKey: string;
}

async function buildNoticeSentFixture(label: string): Promise<Fixture> {
  const { propertyId, transactionId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `1 F01 Double Dispatch St ${suffix} ${label}`,
  });
  const [agreement] = await db
    .insert(commissionAgreements)
    .values({ brokerageId: A.brokerageId, propertyId, transactionId, version: 1, method: "PERCENTAGE", rateBps: 220, status: "APPROVED" })
    .returning();
  const calculation = await createCommissionCalculation({
    brokerageId: A.brokerageId,
    propertyId,
    transactionId,
    commissionAgreementId: agreement.id,
    salePriceCentsInput: 80_000_000,
    state: "FINALISED",
  });
  const [authority] = await db
    .insert(pcFeeAuthorities)
    .values({
      brokerageId: A.brokerageId,
      agentUserId: A.agent.user.id,
      version: ++authorityVersionCounter,
      status: "ACTIVE",
      rateBps: 690,
      noticeRequiredDays: 0,
      mandateProviderRef: `f01-mandate-${suffix}-${label}`,
      mandateProvider: "sandbox",
    })
    .returning();
  const pcFeeCalc = await createPcFeeCalculation({
    brokerageId: A.brokerageId,
    propertyId,
    transactionId,
    pcFeeAuthorityId: authority.id,
    commissionCalculationId: calculation.id,
    state: "FINALISED",
  });
  const { paymentRequest } = await ensurePcSuccessFeeRequest({ transactionId, brokerageId: A.brokerageId, propertyId, pcFeeCalculationId: pcFeeCalc.id });
  await advancePaymentRequestToNoticeSent(paymentRequest.id);
  return { transactionId, paymentRequestId: paymentRequest.id, idempotencyKey: `schedule-debit:${paymentRequest.id}` };
}

/**
 * Inserts the SCHEDULE_DEBIT row as scheduleDebitForPaymentRequest does (PENDING, due), except nextAttemptAt is set
 * 1s in the past: the column default is the DB's now() (microseconds) while the sweep compares against a JS Date
 * (milliseconds), so a sweep in the same millisecond as the insert can miss a "due now" row (seen in the targeted run).
 */
async function insertDueOutboxRow(f: Fixture) {
  const [row] = await db
    .insert(financialPaymentOutbox)
    .values({ brokerageId: A.brokerageId, paymentRequestId: f.paymentRequestId, action: "SCHEDULE_DEBIT", status: "PENDING", idempotencyKey: f.idempotencyKey, nextAttemptAt: new Date(Date.now() - 1_000) })
    .returning();
  return row;
}

interface Arrival {
  index: number;
  release: () => void;
  result?: DebitResult;
}

/** Provider hook (test process only): parks this fixture's scheduleDebit calls until released. */
function installProviderGate(idempotencyKey: string, options: { autoRelease?: boolean; providerFor: (index: number) => MandatePaymentProvider }) {
  const original = mandatePaymentProvider.scheduleDebit;
  const realSingleton = original.bind(mandatePaymentProvider);
  const arrivals: Arrival[] = [];
  const override = async (input: DebitRequest): Promise<DebitResult> => {
    if (input.idempotencyKey !== idempotencyKey) return realSingleton(input);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const arrival: Arrival = { index: arrivals.length, release };
    arrivals.push(arrival);
    if (!options.autoRelease) await released;
    const provider = options.providerFor(arrival.index);
    arrival.result = provider === mandatePaymentProvider ? await realSingleton(input) : await provider.scheduleDebit(input);
    return arrival.result;
  };
  (mandatePaymentProvider as { scheduleDebit: typeof override }).scheduleDebit = override;
  return {
    arrivals,
    async waitForArrivals(count: number): Promise<void> {
      const deadline = Date.now() + 15_000;
      while (arrivals.length < count) {
        if (Date.now() > deadline) {
          for (const arrival of arrivals) arrival.release(); // never leave a dispatcher parked
          throw new Error(`provider gate: expected ${count} parked scheduleDebit call(s), saw ${arrivals.length}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    /**
     * Awaits `work`, but if it makes a SECOND parked provider call (the double dispatch the fix prevents) every parked
     * call is released so nothing hangs; the caller's arrival-count assertion then fails fast instead of timing out.
     */
    async settleUnlessSecondArrival<T>(work: Promise<T>): Promise<T> {
      let done = false;
      const watcher = (async () => {
        while (!done) {
          if (arrivals.length >= 2) for (const arrival of arrivals) arrival.release(); // keep releasing until work settles
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })();
      try {
        return await work;
      } finally {
        done = true;
        await watcher;
      }
    },
    restore(): void {
      delete (mandatePaymentProvider as { scheduleDebit?: unknown }).scheduleDebit;
      assert.equal(mandatePaymentProvider.scheduleDebit, original, "provider hook removed");
    },
  };
}

const singletonOnly = () => mandatePaymentProvider;
const twoInstances = () => {
  const secondInstance = new SandboxMandatePaymentProvider();
  return (index: number) => (index === 0 ? mandatePaymentProvider : secondInstance);
};

async function scheduledLedgerRows(f: Fixture) {
  return db
    .select()
    .from(financialLedgerEvents)
    .where(and(eq(financialLedgerEvents.sourceRecordId, String(f.paymentRequestId)), eq(financialLedgerEvents.eventType, "PC_FEE_DEBIT_SCHEDULED")));
}
async function scheduledDomainEvents(f: Fixture) {
  return db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.eventType, "FINANCIAL_PAYMENT_SCHEDULED"), eq(domainEvents.transactionId, f.transactionId)));
}
async function paymentRequest(f: Fixture) {
  const [row] = await db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, f.paymentRequestId));
  return row;
}
async function outboxRows(f: Fixture) {
  return db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.paymentRequestId, f.paymentRequestId));
}

/**
 * Two real sweeps: sweep 1 claims the row and parks inside the provider call; sweep 2 then runs to completion while
 * sweep 1 still holds the claim; a stale-snapshot dispatchOutboxEntry (the row as both sweeps read it, PENDING) is
 * also run to completion; then sweep 1 is released. Returns provider arrivals and the stand-down results.
 */
async function raceTwoSweeps(f: Fixture, providerFor: (index: number) => MandatePaymentProvider) {
  const gate = installProviderGate(f.idempotencyKey, { providerFor });
  try {
    const [stalePending] = await outboxRows(f);
    assert.equal(stalePending.status, "PENDING");
    const sweep1 = dispatchPendingPaymentOutbox(50);
    await gate.waitForArrivals(1); // sweep 1 holds the claim and is inside the provider call
    const sweep2Result = await gate.settleUnlessSecondArrival(dispatchPendingPaymentOutbox(50)); // finishes while sweep 1 is parked
    const staleOutcome = await gate.settleUnlessSecondArrival(dispatchOutboxEntry(stalePending)); // read PENDING before the claim
    gate.arrivals[0].release();
    await sweep1;
    return { arrivals: gate.arrivals, sweep2Result, staleOutcome };
  } finally {
    for (const arrival of gate.arrivals) arrival.release();
    gate.restore();
  }
}

const fx: Record<string, Fixture> = {};

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { createApp } = await import("../../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `F01 Double Dispatch ${suffix}`);
  for (const label of ["two-instances", "shared-provider", "caller-vs-sweep", "single-sweep", "sequential-sweeps", "redispatch-call", "lease-reclaim", "stale-failure"]) {
    fx[label] = await buildNoticeSentFixture(label);
  }
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("F-01: payment outbox dispatch claim under concurrent dispatchers", { concurrency: false }, () => {
  test("[F-01 FIXED] two concurrent sweeps, two API instances: one provider debit, one ledger row, one event, ref kept", async () => {
    // WAS (GAP, c2d898d2): two provider debits, ref overwritten by the second, two ledger rows, two events.
    const f = fx["two-instances"];
    await insertDueOutboxRow(f);
    const { arrivals, staleOutcome } = await raceTwoSweeps(f, twoInstances());

    assert.equal(arrivals.length, 1, F01_FIXED); // exactly one provider scheduleDebit call
    assert.equal(staleOutcome.paymentRequest, null, F01_FIXED); // the stale dispatcher stood down
    const request = await paymentRequest(f);
    assert.equal(request.status, "DEBIT_SCHEDULED");
    assert.equal(request.providerRequestRef, arrivals[0].result!.providerRequestRef, F01_FIXED);
    assert.equal((await scheduledLedgerRows(f)).length, 1, F01_FIXED);
    assert.equal((await scheduledDomainEvents(f)).length, 1, F01_FIXED);
    const rows = await outboxRows(f);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "DISPATCHED");
  });

  test("[F-01 FIXED] two concurrent sweeps, shared idempotent provider: one provider call, one ledger row, one event", async () => {
    // WAS (GAP): ref kept by provider idempotency, but two provider calls, two ledger rows, two events.
    const f = fx["shared-provider"];
    await insertDueOutboxRow(f);
    const { arrivals } = await raceTwoSweeps(f, singletonOnly);

    assert.equal(arrivals.length, 1, F01_FIXED);
    assert.equal((await paymentRequest(f)).providerRequestRef, arrivals[0].result!.providerRequestRef);
    assert.equal((await scheduledLedgerRows(f)).length, 1, F01_FIXED);
    assert.equal((await scheduledDomainEvents(f)).length, 1, F01_FIXED);
  });

  test("[F-01 FIXED] scheduleDebitForPaymentRequest racing one sweep: the caller's providerRequestRef is the stored ref", async () => {
    // WAS (GAP): both dispatched; the caller's returned ref was overwritten by the sweep's (webhook -> not_found).
    const f = fx["caller-vs-sweep"];
    const gate = installProviderGate(f.idempotencyKey, { providerFor: twoInstances() });
    let callerRef: string | null | undefined;
    let sweepResult: Awaited<ReturnType<typeof dispatchPendingPaymentOutbox>> | undefined;
    try {
      const caller = scheduleDebitForPaymentRequest({ paymentRequestId: f.paymentRequestId });
      await gate.waitForArrivals(1); // the caller inserted and claimed the row and is inside the provider call
      sweepResult = await gate.settleUnlessSecondArrival(dispatchPendingPaymentOutbox(50)); // completes while the caller holds the claim
      const again = await gate.settleUnlessSecondArrival(scheduleDebitForPaymentRequest({ paymentRequestId: f.paymentRequestId })); // a retrying caller
      assert.equal(gate.arrivals.length, 1, F01_FIXED);
      assert.equal(again.dispatched, false, F01_FIXED); // reported in flight, not dispatched again
      gate.arrivals[0].release();
      callerRef = (await caller).paymentRequest.providerRequestRef;
    } finally {
      for (const arrival of gate.arrivals) arrival.release();
      gate.restore();
    }
    assert.ok(sweepResult);
    assert.equal(gate.arrivals.length, 1, F01_FIXED);
    assert.equal(callerRef, gate.arrivals[0].result!.providerRequestRef);
    assert.equal((await paymentRequest(f)).providerRequestRef, callerRef, F01_FIXED);
    assert.equal((await scheduledLedgerRows(f)).length, 1, F01_FIXED);
    assert.equal((await scheduledDomainEvents(f)).length, 1, F01_FIXED);
  });

  test("[F-01 FIXED] an expired claim (crashed dispatcher) is reclaimed by the sweep, counted as an attempt, and dispatched once", async () => {
    const f = fx["lease-reclaim"];
    const row = await insertDueOutboxRow(f);
    // Simulate a dispatcher that claimed the row and crashed: DISPATCHING with a lease that expired 1s ago.
    await db.update(financialPaymentOutbox).set({ status: "DISPATCHING", nextAttemptAt: new Date(Date.now() - 1_000) }).where(eq(financialPaymentOutbox.id, row.id));
    const gate = installProviderGate(f.idempotencyKey, { autoRelease: true, providerFor: singletonOnly });
    try {
      await dispatchPendingPaymentOutbox(50);
      await dispatchPendingPaymentOutbox(50);
    } finally {
      gate.restore();
    }
    assert.equal(gate.arrivals.length, 1, F01_FIXED);
    const [after] = await outboxRows(f);
    assert.equal(after.status, "DISPATCHED");
    assert.equal(after.attempts, row.attempts + 1); // the reclaim counted as an attempt
    assert.equal((await scheduledLedgerRows(f)).length, 1, F01_FIXED);
  });

  test("[F-01 FIXED] a live claim is not reclaimed, and a stale dispatcher cannot write the row back to PENDING", async () => {
    const f = fx["stale-failure"];
    const row = await insertDueOutboxRow(f);
    // Another dispatcher holds a live claim (lease in the future).
    const leaseUntil = new Date(Date.now() + 60_000);
    await db.update(financialPaymentOutbox).set({ status: "DISPATCHING", nextAttemptAt: leaseUntil }).where(eq(financialPaymentOutbox.id, row.id));
    const gate = installProviderGate(f.idempotencyKey, { autoRelease: true, providerFor: singletonOnly });
    let outcome: Awaited<ReturnType<typeof dispatchOutboxEntry>>;
    try {
      outcome = await dispatchOutboxEntry(row); // stale PENDING snapshot
      await dispatchPendingPaymentOutbox(50);
    } finally {
      gate.restore();
    }
    assert.equal(gate.arrivals.length, 0, F01_FIXED);
    assert.equal(outcome.paymentRequest, null);
    const [after] = await outboxRows(f);
    assert.equal(after.status, "DISPATCHING", F01_FIXED); // not flipped back to PENDING, not FAILED
    assert.equal(after.attempts, row.attempts);
    assert.equal(after.nextAttemptAt.getTime(), leaseUntil.getTime());
    assert.equal((await paymentRequest(f)).status, "NOTICE_SENT");
  });

  test("[F-01 LOCK] one sweep alone dispatches the row once: one provider call, one ledger row, one event, ref stored", async () => {
    const f = fx["single-sweep"];
    await insertDueOutboxRow(f);
    const gate = installProviderGate(f.idempotencyKey, { autoRelease: true, providerFor: singletonOnly });
    try {
      await dispatchPendingPaymentOutbox(50);
    } finally {
      gate.restore();
    }
    assert.equal(gate.arrivals.length, 1);
    const request = await paymentRequest(f);
    assert.equal(request.status, "DEBIT_SCHEDULED");
    assert.equal(request.providerRequestRef, gate.arrivals[0].result!.providerRequestRef);
    assert.equal((await scheduledLedgerRows(f)).length, 1);
    assert.equal((await scheduledDomainEvents(f)).length, 1);
    const [row] = await outboxRows(f);
    assert.equal(row.status, "DISPATCHED");
    assert.ok(row.dispatchedAt);
  });

  test("[F-01 LOCK] sequential sweeps: once DISPATCHED, a later sweep does not dispatch the row again", async () => {
    const f = fx["sequential-sweeps"];
    await insertDueOutboxRow(f);
    const gate = installProviderGate(f.idempotencyKey, { autoRelease: true, providerFor: singletonOnly });
    try {
      await dispatchPendingPaymentOutbox(50);
      await dispatchPendingPaymentOutbox(50);
    } finally {
      gate.restore();
    }
    assert.equal(gate.arrivals.length, 1);
    assert.equal((await scheduledLedgerRows(f)).length, 1);
    assert.equal((await scheduledDomainEvents(f)).length, 1);
  });

  test("[F-01 LOCK] scheduleDebitForPaymentRequest on an already DISPATCHED row returns the stored result with no provider call", async () => {
    const f = fx["redispatch-call"];
    await insertDueOutboxRow(f);
    const gate = installProviderGate(f.idempotencyKey, { autoRelease: true, providerFor: singletonOnly });
    let first: Awaited<ReturnType<typeof scheduleDebitForPaymentRequest>>;
    let again: Awaited<ReturnType<typeof scheduleDebitForPaymentRequest>>;
    try {
      first = await scheduleDebitForPaymentRequest({ paymentRequestId: f.paymentRequestId });
      again = await scheduleDebitForPaymentRequest({ paymentRequestId: f.paymentRequestId });
    } finally {
      gate.restore();
    }
    assert.equal(gate.arrivals.length, 1);
    assert.equal(first.dispatched, true);
    assert.equal(again.dispatched, true);
    assert.equal(again.outboxEntry.id, first.outboxEntry.id);
    assert.equal(again.paymentRequest.providerRequestRef, first.paymentRequest.providerRequestRef);
    assert.equal((await outboxRows(f)).length, 1);
    assert.equal((await scheduledLedgerRows(f)).length, 1);
  });

  test("[F-01 LOCK] even under the race the outbox keeps exactly one row per (payment request, action)", async () => {
    // The unique index financial_payment_outbox_payment_request_action_idx holds today and must keep holding.
    for (const label of ["two-instances", "shared-provider", "caller-vs-sweep"]) {
      assert.equal((await outboxRows(fx[label])).length, 1, label);
    }
  });
});
