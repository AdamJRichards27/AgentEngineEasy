// Owner t211u item 4: direct-debit retries are provider-managed. AE never
// re-collects a DD itself; it reconciles the provider's own status (retry
// scheduled, paid, finally failed) through the provider interface. Sandbox
// (mock) provider only; nothing here sends.
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, financialLedgerEvents, financialPaymentOutbox, financialReceipts } from "@aee/db";
import type { SandboxMandatePaymentProvider } from "@aee/integration-mandate-payments";
import { mandatePaymentProvider } from "../../lib/financial/provider.js";
import { reconcileProviderManagedDebits } from "../../lib/financial/ddReconciliation.js";
import { runServiceFeeCollectionTick } from "../../lib/financial/serviceFeeScheduler.js";
import { cleanupBrokerages } from "./testSupport.js";
import { activeDebitAuthority, cardAuthorityViaApi, collect, confirmBoth, elapseNotice, elapseRetry, feeChain, makeWorld, prepareAndIssue, request, saveCard, type Chain, type World } from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let w: World;
const sandbox = () => mandatePaymentProvider as unknown as SandboxMandatePaymentProvider;
const reconcile = () => reconcileProviderManagedDebits({ brokerageIds: [w.X.brokerageId] });
const ledgerCount = async (c: Chain, type: string) =>
  (await db.select().from(financialLedgerEvents).where(and(eq(financialLedgerEvents.sourceRecordId, String(c.requestId)), eq(financialLedgerEvents.eventType, type)))).length;

async function scheduledDd(tag: string) {
  const a = await activeDebitAuthority(w);
  const c = await feeChain(w, a.id, tag);
  await confirmBoth(w, c);
  assert.equal((await prepareAndIssue(w, w.crew, c)).status, 200);
  await elapseNotice(c);
  await collect(w, w.crew, c);
  const r = await request(c.requestId);
  assert.equal(r.status, "DEBIT_SCHEDULED");
  return { c, ref: r.providerRequestRef! };
}
async function sendsDuring<T>(fn: () => Promise<T>) {
  const spy = mock.method(mandatePaymentProvider, "scheduleDebit", mandatePaymentProvider.scheduleDebit.bind(mandatePaymentProvider));
  try {
    const result = await fn();
    return { result, sends: spy.mock.callCount() };
  } finally {
    spy.mock.restore();
  }
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "T211uDd");
});
after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t211u item 4: provider-managed direct-debit retries; AE reconciles, never re-collects", { concurrency: false }, () => {
  test("the provider interface declares who manages retries and exposes a read-only status; the sandbox manages its own", () => {
    assert.equal(mandatePaymentProvider.name, "sandbox");
    assert.equal(mandatePaymentProvider.retryManagement, "PROVIDER_MANAGED");
    assert.equal(typeof mandatePaymentProvider.getDebitStatus, "function");
  });

  test("provider retry scheduled -> RETRY_SCHEDULED with the provider's attempt and time; idempotent; nothing sent", async () => {
    const { c, ref } = await scheduledDd("DdRetry");
    const next = new Date(Date.now() + 3 * 86_400_000);
    sandbox().simulateDebitStatus(ref, { status: "RetryScheduled", attempt: 1, nextAttemptAt: next, failureReason: "insufficient_funds" });
    const { result, sends } = await sendsDuring(async () => [await reconcile(), await reconcile()]);
    assert.equal(sends, 0);
    assert.equal(result[0]!.updated, 1);
    assert.equal(result[1]!.updated, 0, "second pass is a no-op");
    const r = await request(c.requestId);
    assert.equal(r.status, "RETRY_SCHEDULED");
    assert.equal(r.retryCount, 1);
    assert.equal(r.nextAttemptAt?.getTime(), next.getTime());
    assert.equal(await ledgerCount(c, "PC_FEE_PAYMENT_FAILED"), 1);
  });

  test("AE never re-collects a DD in RETRY_SCHEDULED: collect and the scheduler tick send nothing, even when the time has passed", async () => {
    const { c, ref } = await scheduledDd("DdNoRecollect");
    sandbox().simulateDebitStatus(ref, { status: "RetryScheduled", attempt: 1, nextAttemptAt: new Date(Date.now() + 60_000), failureReason: "insufficient_funds" });
    await reconcile();
    await elapseRetry(c);
    const { result, sends } = await sendsDuring(async () => ({ col: await collect(w, w.crew, c), tick: await runServiceFeeCollectionTick({ brokerageIds: [w.X.brokerageId] }) }));
    assert.equal(sends, 0);
    // Collect is a no-op for a debit the provider is retrying (refused, or "already in progress"), never a new send.
    assert.ok(result.col.status >= 400 || result.col.json.outcome === "already_in_progress", result.col.raw);
    assert.equal(result.tick.results.filter((x) => x.paymentRequestId === c.requestId).length, 0);
    assert.equal((await db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.paymentRequestId, c.requestId))).length, 1);
    assert.equal((await request(c.requestId)).status, "RETRY_SCHEDULED");
  });

  test("provider retry then paid -> PAID once (one ledger event, a receipt); reconciling again changes nothing", async () => {
    const { c, ref } = await scheduledDd("DdPaid");
    sandbox().simulateDebitStatus(ref, { status: "RetryScheduled", attempt: 1, nextAttemptAt: new Date(Date.now() + 86_400_000), failureReason: "insufficient_funds" });
    await reconcile();
    sandbox().simulateDebitStatus(ref, { status: "Paid", attempt: 2 });
    await reconcile();
    await reconcile();
    const r = await request(c.requestId);
    assert.equal(r.status, "PAID");
    assert.equal(await ledgerCount(c, "PC_FEE_PAID"), 1);
    assert.ok((await db.select().from(financialReceipts).where(eq(financialReceipts.paymentRequestId, c.requestId))).some((x) => x.kind === "PAYMENT_SUCCEEDED"));
  });

  test("provider finally failed -> FAILED with the provider's attempt count; never re-armed", async () => {
    const { c, ref } = await scheduledDd("DdFinal");
    sandbox().simulateDebitStatus(ref, { status: "Failed", attempt: 3, final: true, failureReason: "retries_exhausted" });
    await reconcile();
    const r = await request(c.requestId);
    assert.equal(r.status, "FAILED");
    assert.equal(r.retryCount, 3);
    assert.equal(r.nextAttemptAt, null);
  });

  test("no provider record (or no status lookup) -> nothing changes", async () => {
    const { c, ref } = await scheduledDd("DdUnknown");
    sandbox().simulateDebitStatus(ref, null);
    const res = await reconcile();
    assert.ok(res.unavailable >= 1);
    assert.equal((await request(c.requestId)).status, "DEBIT_SCHEDULED");
  });

  test("stored-card fees are not touched by DD reconciliation", async () => {
    const card = await saveCard("Agent", w.X.agent.user.id);
    const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
    const c = await feeChain(w, a.id, "DdCard");
    await confirmBoth(w, c);
    assert.equal((await prepareAndIssue(w, w.crew, c)).status, 200);
    const before = (await request(c.requestId)).status;
    await reconcile();
    assert.equal((await request(c.requestId)).status, before);
  });
});
