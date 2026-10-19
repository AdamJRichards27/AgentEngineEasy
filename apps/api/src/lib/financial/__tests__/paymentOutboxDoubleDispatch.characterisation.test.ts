// F-01: CHARACTERISATION TESTS ONLY. They pin CURRENT (wrong) behaviour of the payment outbox under concurrent
// dispatch; nothing here is a fix. No production code is changed by this file.
//
// Gap: dispatchPendingPaymentOutbox() (lib/financial/paymentOutbox.ts) selects every due PENDING row and hands each to
// dispatchOutboxEntry(), which calls the mandate provider and THEN updates the outbox row and the payment request
// with no claim: no row lock, no conditional "WHERE status = 'PENDING'" update. Two dispatchers that both read the row
// as PENDING (two API instances' timers, the timer plus POST /financial/ops/dispatch-outbox, or
// scheduleDebitForPaymentRequest plus a sweep) both call the provider and both write. Result: two provider debits for
// one payment command, two PC_FEE_DEBIT_SCHEDULED ledger rows, two FINANCIAL_PAYMENT_SCHEDULED domain events, and,
// when the two dispatchers do not share provider idempotency state, the payment request's providerRequestRef is
// overwritten by the second write (the first debit is orphaned).
//
// HOW TO READ THIS FILE
// - "[F-01 GAP]" tests pin the gap. They are expected to FLIP when an Owner-approved claim/lock lands: each one says
//   "CURRENT:" (what it asserts now) and "INTENDED (likely):" (what a fix would assert). Search for F01_GAP.
// - "[F-01 LOCK]" tests pin neighbouring behaviour a fix must NOT change.
//
// DETERMINISTIC HARNESS
// - Concurrency comes from the real code: two real dispatchPendingPaymentOutbox() calls (or the scheduling call plus
//   one sweep) run at the same time on separate pooled DB connections.
// - The interleaving is fixed by a provider hook: mandatePaymentProvider.scheduleDebit is wrapped IN THIS TEST
//   PROCESS ONLY (own-property override, removed afterwards). For this file's own idempotency key, each call parks at
//   a gate. Dispatcher 1 is started and parked inside the provider call (it has read the row as PENDING and has not
//   written anything yet); only then is dispatcher 2 started, and it parks too, having also read the row as PENDING.
//   Then dispatcher 1 is released and run to completion, then dispatcher 2. So the write order is fixed and every
//   count below is exact. Calls for any other idempotency key pass straight through to the real provider.
// - "Two instances" means the second parked call is answered by a separate SandboxMandatePaymentProvider instance,
//   modelling a second API process (each process has its own in-memory sandbox, see lib/financial/provider.ts).
//   "Shared idempotent provider" answers both from the module singleton, which replays the same ref for the same key.
// - Shared test DB caveat (disclosed): the sweeps are global, so for the few milliseconds of each race they could
//   also touch another file's due PENDING outbox row, and another file's sweep could touch this one. Files that
//   create payment outbox rows keep them out of sweeps (nextAttemptAt +24h, local/run-test-payment-outbox-isolation).
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
import { advancePaymentRequestToNoticeSent, dispatchPendingPaymentOutbox, scheduleDebitForPaymentRequest } from "../paymentOutbox.js";
import { mandatePaymentProvider } from "../provider.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

/** Marker a future fix flips: every [F-01 GAP] test asserts against this documented current behaviour. */
const F01_GAP = "F-01 characterises payment outbox double-dispatch under concurrent dispatchers (no claim)";

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

/** Inserts the SCHEDULE_DEBIT row exactly as scheduleDebitForPaymentRequest does (PENDING, due now). */
async function insertDueOutboxRow(f: Fixture) {
  const [row] = await db
    .insert(financialPaymentOutbox)
    .values({ brokerageId: A.brokerageId, paymentRequestId: f.paymentRequestId, action: "SCHEDULE_DEBIT", status: "PENDING", idempotencyKey: f.idempotencyKey })
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

/** Two real sweeps, interleaved deterministically: both read the row as PENDING, then 1 finishes, then 2. */
async function raceTwoSweeps(f: Fixture, providerFor: (index: number) => MandatePaymentProvider) {
  const gate = installProviderGate(f.idempotencyKey, { providerFor });
  try {
    const sweep1 = dispatchPendingPaymentOutbox(50);
    await gate.waitForArrivals(1); // sweep 1 has read the row as PENDING and is inside the provider call
    const sweep2 = dispatchPendingPaymentOutbox(50);
    await gate.waitForArrivals(2); // sweep 2 has ALSO read it as PENDING (sweep 1 has written nothing yet)
    gate.arrivals[0].release();
    await sweep1;
    gate.arrivals[1].release();
    await sweep2;
    return gate.arrivals;
  } finally {
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
  for (const label of ["two-instances", "shared-provider", "caller-vs-sweep", "single-sweep", "sequential-sweeps", "redispatch-call"]) {
    fx[label] = await buildNoticeSentFixture(label);
  }
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("F-01 characterisation: payment outbox double-dispatch under concurrent dispatchers", { concurrency: false }, () => {
  test("[F-01 GAP] two concurrent sweeps, two API instances: two provider debits, two ledger rows, two events, providerRequestRef overwritten", async () => {
    // CURRENT: both sweeps dispatch the one PENDING row. INTENDED (likely): exactly one dispatch; the second sweep sees
    // the row claimed (or skips it) and makes no provider call, no ledger row and no event.
    const f = fx["two-instances"];
    await insertDueOutboxRow(f);
    const arrivals = await raceTwoSweeps(f, twoInstances());

    assert.equal(arrivals.length, 2, F01_GAP); // two provider scheduleDebit calls for ONE payment command
    const [first, second] = arrivals.map((a) => a.result!.providerRequestRef);
    assert.notEqual(first, second, F01_GAP); // two distinct debits at the provider
    const request = await paymentRequest(f);
    assert.equal(request.status, "DEBIT_SCHEDULED");
    assert.equal(request.providerRequestRef, second, F01_GAP); // the second write overwrote the first
    assert.notEqual(request.providerRequestRef, first, F01_GAP); // the first debit is orphaned (no row points at it)
    assert.equal((await scheduledLedgerRows(f)).length, 2, F01_GAP);
    assert.equal((await scheduledDomainEvents(f)).length, 2, F01_GAP);
    const rows = await outboxRows(f);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "DISPATCHED");
  });

  test("[F-01 GAP] two concurrent sweeps, shared idempotent provider: ref kept, but still two provider calls, two ledger rows, two events", async () => {
    // CURRENT: the provider replays the same ref for the same idempotency key, so the ref survives, but the app still
    // writes its side effects twice. INTENDED (likely): one provider call, one ledger row, one event.
    const f = fx["shared-provider"];
    await insertDueOutboxRow(f);
    const arrivals = await raceTwoSweeps(f, singletonOnly);

    assert.equal(arrivals.length, 2, F01_GAP);
    const [first, second] = arrivals.map((a) => a.result!.providerRequestRef);
    assert.equal(first, second); // provider-side idempotency on the key holds (LOCK-like; stays true after a fix)
    assert.equal((await paymentRequest(f)).providerRequestRef, first);
    assert.equal((await scheduledLedgerRows(f)).length, 2, F01_GAP);
    assert.equal((await scheduledDomainEvents(f)).length, 2, F01_GAP);
  });

  test("[F-01 GAP] scheduleDebitForPaymentRequest racing one sweep: the caller is handed a providerRequestRef the DB no longer holds", async () => {
    // The production shape of the paymentWebhooks full-suite flake: an API request schedules the debit while a sweep
    // (timer or ops route, another instance) picks up the just-inserted, already-due row.
    // CURRENT: both dispatch; the caller's returned ref is overwritten by the sweep's.
    // INTENDED (likely): one dispatch; whatever ref the caller is given is the ref stored on the payment request.
    const f = fx["caller-vs-sweep"];
    const gate = installProviderGate(f.idempotencyKey, { providerFor: twoInstances() });
    let callerRef: string | null | undefined;
    try {
      const caller = scheduleDebitForPaymentRequest({ paymentRequestId: f.paymentRequestId });
      await gate.waitForArrivals(1); // the caller inserted the PENDING row and is inside the provider call
      const sweep = dispatchPendingPaymentOutbox(50);
      await gate.waitForArrivals(2); // the sweep read the same row as PENDING
      gate.arrivals[0].release();
      callerRef = (await caller).paymentRequest.providerRequestRef;
      gate.arrivals[1].release();
      await sweep;
    } finally {
      gate.restore();
    }
    assert.equal(gate.arrivals.length, 2, F01_GAP);
    assert.equal(callerRef, gate.arrivals[0].result!.providerRequestRef);
    const stored = (await paymentRequest(f)).providerRequestRef;
    assert.equal(stored, gate.arrivals[1].result!.providerRequestRef, F01_GAP);
    assert.notEqual(stored, callerRef, F01_GAP); // a webhook for the caller's ref would be payment_request_not_found
    assert.equal((await scheduledLedgerRows(f)).length, 2, F01_GAP);
    assert.equal((await scheduledDomainEvents(f)).length, 2, F01_GAP);
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
