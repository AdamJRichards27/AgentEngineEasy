// Owner t183u item 6 / #245 S5: the collection scheduler is OFF by default,
// and ONLY the mock/sandbox payment providers may process. Any live provider
// is refused on every money-moving path (card charge, card refund, direct
// debit schedule, outbox resend, debit cancel) with no provider call and no
// row written. Synthetic data only.
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, financialCardCharges, financialCardRefunds, financialPaymentOutbox } from "@aee/db";
import { paymentProvider } from "../../lib/paymentProvider.js";
import { mandatePaymentProvider } from "../../lib/financial/provider.js";
import { cancelScheduledDebit, dispatchPendingPaymentOutbox } from "../../lib/financial/paymentOutbox.js";
import { cleanupBrokerages } from "./testSupport.js";
import {
  activeDebitAuthority,
  call,
  cardAuthorityViaApi,
  collect,
  confirmBoth,
  elapseNotice,
  feeChain,
  makeWorld,
  prepareAndIssue,
  request,
  saveCard,
  TERMS,
  type Chain,
  type World,
} from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let w: World;
const outbox = (c: Chain) => db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.paymentRequestId, c.requestId));
const sched = () => import("../../lib/financial/serviceFeeScheduler.js");

async function issued(authorityId: number, tag: string) {
  const c = await feeChain(w, authorityId, tag);
  await confirmBoth(w, c);
  const iss = await prepareAndIssue(w, w.crew, c);
  assert.equal(iss.status, 200, iss.raw);
  return { c, collection: iss.json.collection };
}
/** Pretend the mandate provider is a live bank for the duration of fn; spy proves no call is made. */
async function withLiveMandate<T>(fn: () => Promise<T>) {
  const orig = mandatePaymentProvider.name;
  const spies = (["scheduleDebit", "cancelScheduledDebit", "reverseDebit"] as const).map((m) => mock.method(mandatePaymentProvider, m));
  (mandatePaymentProvider as { name: string }).name = "live-bank";
  try {
    const out = await fn();
    for (const s of spies) assert.equal(s.mock.callCount(), 0, "no call to a live mandate provider");
    return out;
  } finally {
    (mandatePaymentProvider as { name: string }).name = orig;
    for (const s of spies) s.mock.restore();
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
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "ProvGuard");
});
after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("S5 (t183u 6): scheduler off by default; mock/sandbox providers only", { concurrency: false }, () => {
  test("scheduler is off by default (no env flag) and its provider gate admits only mock + sandbox", async () => {
    const s = await sched();
    delete process.env.PC_FEE_COLLECTION_SCHEDULER_ENABLED;
    s.registerServiceFeeCollectionScheduler();
    assert.equal(s.serviceFeeCollectionSchedulerActive(), false);
    await withLiveMandate(async () => {
      const r = await s.runServiceFeeCollectionTick({ brokerageIds: [w.X.brokerageId] });
      assert.equal(r.skipped, "PROVIDER_NOT_PERMITTED");
    });
  });

  test("direct debit: an explicit collect against a live mandate provider is refused; nothing scheduled or queued", async () => {
    const dd = await activeDebitAuthority(w);
    const { c } = await issued(dd.id, "LiveCollect");
    await elapseNotice(c);
    const r = await withLiveMandate(() => collect(w, w.crew, c));
    assert.equal(r.json.code, "SERVICE_FEE_PROVIDER_NOT_PERMITTED", r.raw);
    assert.equal((await outbox(c)).length, 0, "no outbox row");
    assert.equal((await request(c.requestId)).status, "NOTICE_SENT");
  });

  test("direct debit: immediate collection on statement issue is refused against a live provider", async () => {
    const dd = await activeDebitAuthority(w, { agreementTermsVersion: TERMS.agreementImmediate, mandateTermsVersion: TERMS.mandateImmediate });
    const c = await feeChain(w, dd.id, "LiveIssue");
    await confirmBoth(w, c);
    const iss = await withLiveMandate(() => prepareAndIssue(w, w.crew, c));
    assert.equal(iss.status, 200, "the statement still issues");
    assert.notEqual(iss.json.collection?.outcome, "debit_scheduled", JSON.stringify(iss.json.collection));
    assert.equal((await outbox(c)).length, 0);
  });

  test("outbox sweep never sends a pending entry to a live provider", async () => {
    const dd = await activeDebitAuthority(w);
    const { c } = await issued(dd.id, "LiveSweep");
    await elapseNotice(c);
    // Seed a due PENDING entry directly (no provider call).
    await db.insert(financialPaymentOutbox).values({ brokerageId: w.X.brokerageId, paymentRequestId: c.requestId, action: "SCHEDULE_DEBIT", status: "PENDING", idempotencyKey: `schedule-debit:${c.requestId}`, nextAttemptAt: new Date(Date.now() - 60_000) });
    await withLiveMandate(() => dispatchPendingPaymentOutbox(100));
    const [entry] = await outbox(c);
    assert.notEqual(entry!.status, "DISPATCHED");
  });

  test("debit cancel is refused against a live provider", async () => {
    const dd = await activeDebitAuthority(w, { agreementTermsVersion: TERMS.agreementImmediate, mandateTermsVersion: TERMS.mandateImmediate });
    const { c, collection } = await issued(dd.id, "LiveCancel");
    assert.equal(collection.outcome, "debit_scheduled", JSON.stringify(collection));
    await withLiveMandate(() => assert.rejects(cancelScheduledDebit({ paymentRequestId: c.requestId, reason: "synthetic", actorUserId: w.X.admin.user.id }), /not permitted/i));
    assert.equal((await request(c.requestId)).status, "DEBIT_SCHEDULED");
  });

  test("card refund is refused against a live card provider; no refund row", async () => {
    const card = await saveCard("Agent", w.X.agent.user.id);
    const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
    const { c } = await issued(a.id, "LiveRefund");
    await elapseNotice(c);
    assert.equal((await collect(w, w.crew, c)).json.outcome, "card_charged");
    const [charge] = await db.select().from(financialCardCharges).where(eq(financialCardCharges.paymentRequestId, c.requestId));
    const proto = Object.getPrototypeOf(paymentProvider);
    Object.setPrototypeOf(paymentProvider, { chargeStoredMethod: proto.chargeStoredMethod, refund: proto.refund });
    try {
      const r = await call(w.baseUrl, "POST", `/financial/card-charges/${charge!.id}/refunds`, w.X.admin.cookie, {
        amountCents: charge!.amountCents,
        reason: "Synthetic refund against a live provider",
        evidenceNote: "synthetic",
        requestKey: `live-${charge!.id}-${Date.now()}`,
      });
      assert.equal(r.json.code, "CARD_REFUND_PROVIDER_NOT_PERMITTED", r.raw);
    } finally {
      Object.setPrototypeOf(paymentProvider, proto);
    }
    assert.equal((await db.select().from(financialCardRefunds).where(eq(financialCardRefunds.cardChargeId, charge!.id))).length, 0);
  });
});
