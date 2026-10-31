// Owner t210u (#245, after S4): a debit-scheduling send that errors with an
// UNCERTAIN outcome (the provider call itself threw, e.g. a timeout: the debit
// may or may not have been accepted) is NEVER auto-resent. The outbox entry
// is held, the fee is parked in PROCESSING (outcome unknown), a ledger event
// and an audit row flag it, and Brokerage Administrators can see it for manual
// review. Failures before the provider is called (nothing sent) keep the
// existing backoff. Synthetic data, sandbox provider only.
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, financialLedgerEvents, financialPaymentOutbox } from "@aee/db";
import { mandatePaymentProvider } from "../../lib/financial/provider.js";
import { dispatchPendingPaymentOutbox } from "../../lib/financial/paymentOutbox.js";
import { cleanupBrokerages } from "./testSupport.js";
import { activeDebitAuthority, call, collect, confirmBoth, feeChain, makeWorld, prepareAndIssue, request, TERMS, type Chain, type World } from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let w: World;
const outbox = async (c: Chain) => (await db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.paymentRequestId, c.requestId)))[0]!;
const sched = () => import("../../lib/financial/serviceFeeScheduler.js");

/** Issue a fee under immediate (executed) terms while the provider's scheduleDebit throws. */
async function heldFee(tag: string) {
  const a = await activeDebitAuthority(w, { agreementTermsVersion: TERMS.agreementImmediate, mandateTermsVersion: TERMS.mandateImmediate });
  const c = await feeChain(w, a.id, tag);
  await confirmBoth(w, c);
  const spy = mock.method(mandatePaymentProvider, "scheduleDebit", async () => {
    throw new Error("network timeout");
  });
  try {
    const iss = await prepareAndIssue(w, w.crew, c);
    assert.equal(iss.status, 200, iss.raw);
    assert.equal(spy.mock.callCount(), 1);
  } finally {
    spy.mock.restore();
  }
  return c;
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "OutboxHold");
});
after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t210u: uncertain debit dispatch is held for Brokerage Admin review, never auto-resent", { concurrency: false }, () => {
  test("an uncertain send holds the entry, parks the fee in PROCESSING and flags it (ledger + audit)", async () => {
    const c = await heldFee("Held");
    const entry = await outbox(c);
    assert.equal(entry.status, "FAILED", "held: no longer PENDING, so no sweep picks it up");
    assert.equal(entry.attempts, 1);
    assert.match(entry.lastError ?? "", /^HELD_UNCERTAIN: /);
    const req = await request(c.requestId);
    assert.equal(req.status, "PROCESSING", "outcome unknown: not FAILED, not retried");
    assert.ok(req.failureReason == null, "not recorded as a failure");
    const ledger = await db
      .select()
      .from(financialLedgerEvents)
      .where(and(eq(financialLedgerEvents.sourceRecordType, "PAYMENT_REQUEST"), eq(financialLedgerEvents.sourceRecordId, String(c.requestId))));
    assert.ok(ledger.some((e) => e.eventType === "PC_FEE_PAYMENT_PROCESSING" && /manual review/i.test(e.reason ?? "")), JSON.stringify(ledger.map((e) => [e.eventType, e.reason])));
    assert.ok(!ledger.some((e) => e.eventType === "PC_FEE_PAYMENT_FAILED"));
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.recordType, "financial_payment_request"), eq(auditLogs.recordId, String(c.requestId))));
    assert.ok(audits.some((x) => x.action === "financial_payment_debit_dispatch_held"), JSON.stringify(audits.map((x) => x.action)));
  });

  test("nothing resends it: outbox sweep, scheduler tick and an explicit collect make no provider call", async () => {
    const c = await heldFee("NoResend");
    await db.update(financialPaymentOutbox).set({ nextAttemptAt: new Date(Date.now() - 86_400_000) }).where(eq(financialPaymentOutbox.paymentRequestId, c.requestId));
    const spy = mock.method(mandatePaymentProvider, "scheduleDebit");
    try {
      await dispatchPendingPaymentOutbox(100);
      await (await sched()).runServiceFeeCollectionTick({ brokerageIds: [w.X.brokerageId] });
      const r = await collect(w, w.crew, c);
      assert.equal(r.json.outcome, "already_in_progress", r.raw);
      assert.equal(spy.mock.callCount(), 0, "never auto-resent");
    } finally {
      spy.mock.restore();
    }
    assert.equal((await outbox(c)).attempts, 1);
    assert.equal((await request(c.requestId)).status, "PROCESSING");
  });

  test("visible to Brokerage Admins only: GET /financial/payment-outbox/held", async () => {
    const c = await heldFee("Visible");
    const ba = await call(w.baseUrl, "GET", "/financial/payment-outbox/held", w.X.admin.cookie);
    assert.equal(ba.status, 200, ba.raw);
    const mine = (ba.json.held as Array<{ paymentRequestId: number; reason: string }>).find((h) => h.paymentRequestId === c.requestId);
    assert.ok(mine, ba.raw);
    assert.match(mine!.reason, /network timeout/);
    for (const who of [w.crew, w.X.agent]) {
      const r = await call(w.baseUrl, "GET", "/financial/payment-outbox/held", who.cookie);
      assert.equal(r.status, 403, r.raw);
    }
    const other = await call(w.baseUrl, "GET", "/financial/payment-outbox/held", w.Y.admin.cookie);
    assert.equal(other.status, 200, other.raw);
    assert.ok(!(other.json.held as Array<{ paymentRequestId: number }>).some((h) => h.paymentRequestId === c.requestId), "another brokerage never sees it");
  });
});
