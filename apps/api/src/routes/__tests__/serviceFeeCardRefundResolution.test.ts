// Owner t181u phase 2b (G15): Brokerage Administrator resolution of UNKNOWN
// card refunds of the Pit Crew service fee, mirroring card-charge resolution
// (N46/N47). A read-only mock provider status lookup keyed ONLY by the PC-fee
// refund idempotency key (namespace "pcf-card-refund:"), so it can never match
// a service-order refund that shares the numeric refund id; the resolution
// must match the provider; the refund's requester can never resolve it;
// SUCCEEDED writes the REFUND receipt, FAILED releases the reserved amount;
// idempotent; value-free audit. Synthetic data, mock provider only.
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, financialCardCharges, financialCardRefunds, financialLedgerEvents, financialReceipts, settlementStatements } from "@aee/db";
import { MockPaymentProvider } from "@aee/integration-payments";
import { paymentProvider } from "../../lib/paymentProvider.js";
import { cleanupBrokerages } from "./testSupport.js";
import {
  call,
  CARD_TOKEN_MARKER,
  cardAuthorityViaApi,
  collect,
  confirmBoth,
  elapseNotice,
  feeChain,
  makeWorld,
  prepareAndIssue,
  saveCard,
  type Chain,
  type Who,
  type World,
} from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let w: World;
const REASON = "Synthetic refund resolution reason puffin-teal";
const NOTE = "Synthetic provider status check for the refund (no card data)";
let keyN = 0;
const key = () => `t181-2b-${Date.now()}-${++keyN}`;
const refundRow = async (id: number) => (await db.select().from(financialCardRefunds).where(eq(financialCardRefunds.id, id)))[0]!;
const receipts = (c: Chain) => db.select().from(financialReceipts).where(eq(financialReceipts.paymentRequestId, c.requestId)).orderBy(financialReceipts.id);
const status = (who: Who, id: number) => call(w.baseUrl, "GET", `/financial/card-refunds/${id}/provider-status`, who.cookie);
const resolve = (who: Who, id: number, outcome: string, extra: Record<string, unknown> = {}) =>
  call(w.baseUrl, "POST", `/financial/card-refunds/${id}/resolve`, who.cookie, { outcome, reason: REASON, evidenceNote: NOTE, ...extra });
const queue = (who: Who, s = "UNKNOWN") => call(w.baseUrl, "GET", `/financial/card-refunds?status=${s}`, who.cookie);

async function paidCharge(tag: string): Promise<{ c: Chain; chargeId: number; amountCents: number }> {
  const card = await saveCard("Agent", w.X.agent.user.id);
  const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
  assert.equal(a.activated.status, 200, a.activated.raw);
  const c = await feeChain(w, a.id, tag);
  await confirmBoth(w, c);
  assert.equal((await prepareAndIssue(w, w.crew, c)).status, 200);
  await elapseNotice(c);
  assert.equal((await collect(w, w.crew, c)).json.outcome, "card_charged");
  const [charge] = await db.select().from(financialCardCharges).where(eq(financialCardCharges.paymentRequestId, c.requestId));
  return { c, chargeId: charge!.id, amountCents: charge!.amountCents };
}

/** A refund requested by `who` whose provider answer is lost: "accept-then-throw" (money went back), "throw" (never reached) or "pending". */
async function unknownRefund(tag: string, behaviour: "accept-then-throw" | "throw" | "pending", amount?: number, who: Who = w.X.admin) {
  const p = await paidCharge(tag);
  MockPaymentProvider.nextRefundBehaviour = behaviour;
  const r = await call(w.baseUrl, "POST", `/financial/card-charges/${p.chargeId}/refunds`, who.cookie, {
    amountCents: amount ?? p.amountCents,
    reason: "Synthetic refund reason for an unknown outcome",
    evidenceNote: NOTE,
    requestKey: key(),
  });
  assert.equal(r.status, 201, r.raw);
  assert.equal(r.json.refund.status, "UNKNOWN", r.raw);
  return { ...p, refundId: r.json.refund.id as number };
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "RefundRes");
});

after(async () => {
  MockPaymentProvider.nextRefundBehaviour = null;
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t181u phase 2b (G15): BA resolution of UNKNOWN card refunds", { concurrency: false }, () => {
  test("namespaced lookup: only pcf-card-refund keys; never by the numeric refund id", async () => {
    const { lookupCardRefundProviderStatus } = await import("../../lib/financial/cardRefundStatus.js");
    const k = `pcf-card-refund:999999:${"a".repeat(32)}`;
    MockPaymentProvider.refundsByKey.set(`svc-order-collision-${Date.now()}`, { providerRefundRef: "mock-refund-424242", status: "Succeeded", aeRefundId: 424242, amountCents: 1 });
    assert.equal(lookupCardRefundProviderStatus(k), "NotFound");
    assert.equal(lookupCardRefundProviderStatus("424242"), "Unavailable", "a key outside the PC-fee namespace is never looked up");
    assert.equal(lookupCardRefundProviderStatus("svc-order-collision"), "Unavailable");
    MockPaymentProvider.refundsByKey.set(k, { providerRefundRef: "mock-refund-x", status: "Succeeded", aeRefundId: 1, amountCents: 1 });
    assert.equal(lookupCardRefundProviderStatus(k), "Succeeded");
    MockPaymentProvider.refundsByKey.delete(k);
  });

  test("access: BA only (Pit Crew/agents 403, other brokerage 404); queue lists UNKNOWN refunds; no keys or tokens returned", async () => {
    const { refundId } = await unknownRefund("RRAccess", "throw");
    for (const who of [w.crew, w.X.agent, w.otherAgent]) {
      assert.equal((await status(who, refundId)).status, 403);
      assert.equal((await resolve(who, refundId, "FAILED")).status, 403);
      assert.equal((await queue(who)).status, 403);
    }
    assert.equal((await status(w.Y.admin, refundId)).status, 404);
    assert.equal((await resolve(w.Y.admin, refundId, "FAILED")).status, 404);
    assert.ok(!(await queue(w.Y.admin)).json.cardRefunds.some((r: { id: number }) => r.id === refundId));
    const q = await queue(w.admin2);
    assert.equal(q.status, 200, q.raw);
    assert.ok(q.json.cardRefunds.some((r: { id: number; status: string }) => r.id === refundId && r.status === "UNKNOWN"));
    const s = await status(w.admin2, refundId);
    assert.equal(s.status, 200, s.raw);
    assert.equal(s.json.providerStatus, "NotFound");
    assert.equal(s.json.suggestedOutcome, "FAILED");
    assert.equal(s.json.callerMayResolve, true);
    for (const raw of [q.raw, s.raw]) assert.ok(!raw.includes("pcf-card-refund") && !raw.includes(CARD_TOKEN_MARKER) && !raw.includes("requestKey"), "no provider key, request key or token");
    assert.equal((await status(w.X.admin, refundId)).json.callerMayResolve, false, "the requester is told they cannot resolve");
  });

  test("provider refunded (accepted, answer lost): FAILED refused (mismatch); SUCCEEDED -> REFUND receipt, ledger, value-free audit, reconciliation consistent, idempotent", async () => {
    const { c, refundId, amountCents } = await unknownRefund("RROk", "accept-then-throw");
    assert.equal((await status(w.admin2, refundId)).json.providerStatus, "Succeeded");
    const spy = mock.method(paymentProvider, "refund");
    try {
      const bad = await resolve(w.admin2, refundId, "FAILED");
      assert.equal(bad.status, 409, bad.raw);
      assert.equal(bad.json.code, "CARD_REFUND_OUTCOME_MISMATCH");
      assert.equal((await refundRow(refundId)).status, "UNKNOWN");
      assert.equal((await resolve(w.admin2, refundId, "SUCCEEDED", { reason: "" })).json.code, "RECOVERY_REASON_REQUIRED");
      assert.equal((await resolve(w.admin2, refundId, "SUCCEEDED", { evidenceNote: undefined })).json.code, "RECOVERY_EVIDENCE_REQUIRED");
      const rs = await Promise.all([1, 2, 3].map(() => resolve(w.admin2, refundId, "SUCCEEDED")));
      assert.deepEqual(rs.map((r) => r.status), [200, 200, 200], rs.map((r) => r.raw).join("\n"));
      assert.equal(rs.filter((r) => r.json.idempotent === false).length, 1);
      assert.equal(spy.mock.callCount(), 0, "resolution never calls the provider refund");
      assert.ok(rs.every((r) => !r.raw.includes("pcf-card-refund")));
    } finally {
      spy.mock.restore();
    }
    const row = await refundRow(refundId);
    assert.equal(row.status, "SUCCEEDED");
    assert.ok(row.completedAt);
    const rc = (await receipts(c)).filter((r) => r.kind === "REFUND");
    assert.equal(rc.length, 1, "one REFUND receipt");
    assert.equal(rc[0]!.amountCents, amountCents);
    const ev = await db
      .select()
      .from(financialLedgerEvents)
      .where(and(eq(financialLedgerEvents.sourceRecordType, "PAYMENT_REQUEST"), eq(financialLedgerEvents.sourceRecordId, String(c.requestId))));
    const resolvedEv = ev.filter((e) => e.eventType === "PC_FEE_CARD_REFUND_RESOLVED");
    assert.equal(resolvedEv.length, 1);
    assert.equal((resolvedEv[0]!.metadata as Record<string, unknown>).providerStatus, "Succeeded");
    assert.equal(ev.filter((e) => e.eventType === "PC_FEE_CARD_REFUNDED").length, 1, "refunded event written once (reconciliation source)");
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.brokerageId, w.X.brokerageId), eq(auditLogs.action, "financial_card_refund_resolved")));
    const mine = audits.filter((a) => (a.updatedValue ?? "").includes(`"refundId":${refundId}`));
    assert.equal(mine.length, 1);
    assert.ok(!(mine[0]!.updatedValue ?? "").includes(REASON) && !(mine[0]!.updatedValue ?? "").includes(String(amountCents)), "value-free audit");
    const [st] = await db.select().from(settlementStatements).where(and(eq(settlementStatements.transactionId, c.transactionId), eq(settlementStatements.status, "ISSUED")));
    const rec = await call(w.baseUrl, "GET", `/financial/settlement-statements/${st!.id}/reconciliation`, w.X.admin.cookie);
    assert.equal(rec.status, 200, rec.raw);
    assert.equal(rec.json.reconciliation.status, "REFUNDED", rec.raw);
    const flip = await resolve(w.admin2, refundId, "FAILED");
    assert.equal(flip.status, 409);
    assert.equal(flip.json.code, "CARD_REFUND_ALREADY_FINAL");
  });

  test("provider never refunded: SUCCEEDED refused; FAILED releases the reservation (refundable again), no receipt; a later refund works", async () => {
    const { c, chargeId, refundId, amountCents } = await unknownRefund("RRFail", "throw");
    const before = await call(w.baseUrl, "GET", `/financial/card-charges/${chargeId}/refunds`, w.admin2.cookie);
    assert.equal(before.json.refundableCents, 0, "UNKNOWN reserves the amount");
    const bad = await resolve(w.admin2, refundId, "SUCCEEDED");
    assert.equal(bad.json.code, "CARD_REFUND_OUTCOME_MISMATCH", bad.raw);
    const ok = await resolve(w.admin2, refundId, "FAILED");
    assert.equal(ok.status, 200, ok.raw);
    assert.equal((await refundRow(refundId)).status, "FAILED");
    const after = await call(w.baseUrl, "GET", `/financial/card-charges/${chargeId}/refunds`, w.admin2.cookie);
    assert.equal(after.json.refundableCents, amountCents, "reservation released");
    assert.equal((await receipts(c)).filter((r) => r.kind === "REFUND").length, 0);
    assert.equal((await resolve(w.admin2, refundId, "FAILED")).json.idempotent, true);
    const again = await call(w.baseUrl, "POST", `/financial/card-charges/${chargeId}/refunds`, w.admin2.cookie, { amountCents, reason: REASON, evidenceNote: NOTE, requestKey: key() });
    assert.equal(again.status, 201, again.raw);
    assert.equal(again.json.refund.status, "SUCCEEDED");
  });

  test("separation of duties: the BA who requested the refund cannot resolve it (403, audited, also on replay)", async () => {
    const { refundId } = await unknownRefund("RRSelf", "throw");
    const self = await resolve(w.X.admin, refundId, "FAILED");
    assert.equal(self.status, 403, self.raw);
    assert.equal(self.json.code, "CARD_REFUND_RESOLVER_IS_REQUESTER");
    assert.equal((await refundRow(refundId)).status, "UNKNOWN");
    const refusals = await db.select().from(auditLogs).where(and(eq(auditLogs.brokerageId, w.X.brokerageId), eq(auditLogs.userId, w.X.admin.user.id)));
    assert.ok(refusals.some((a) => (a.updatedValue ?? "").includes("CARD_REFUND_RESOLVER_IS_REQUESTER")));
    assert.equal((await resolve(w.admin2, refundId, "FAILED")).status, 200);
    assert.equal((await resolve(w.X.admin, refundId, "FAILED")).status, 403);
  });

  test("fail closed: pending at the provider or provider unavailable -> refused, refund stays UNKNOWN and reserved; only UNKNOWN refunds are resolvable", async () => {
    const { refundId } = await unknownRefund("RRPending", "pending");
    const s = await status(w.admin2, refundId);
    assert.equal(s.json.providerStatus, "Pending");
    assert.equal(s.json.suggestedOutcome, null);
    for (const o of ["SUCCEEDED", "FAILED"]) {
      const r = await resolve(w.admin2, refundId, o);
      assert.equal(r.status, 409, r.raw);
      assert.equal(r.json.code, "CARD_REFUND_PROVIDER_STATUS_UNAVAILABLE");
    }
    const saved = MockPaymentProvider.refundsByKey;
    (MockPaymentProvider as unknown as { refundsByKey: unknown }).refundsByKey = undefined;
    try {
      assert.equal((await status(w.admin2, refundId)).json.providerStatus, "Unavailable");
    } finally {
      (MockPaymentProvider as unknown as { refundsByKey: unknown }).refundsByKey = saved;
    }
    assert.equal((await refundRow(refundId)).status, "UNKNOWN");
    // A SUCCEEDED refund is never "resolved" again.
    const p = await paidCharge("RRFinal");
    const done = await call(w.baseUrl, "POST", `/financial/card-charges/${p.chargeId}/refunds`, w.X.admin.cookie, { amountCents: 100, reason: REASON, evidenceNote: NOTE, requestKey: key() });
    assert.equal(done.json.refund.status, "SUCCEEDED");
    const nr = await resolve(w.admin2, done.json.refund.id, "SUCCEEDED");
    assert.equal(nr.status, 409);
    assert.equal(nr.json.code, "CARD_REFUND_NOT_UNKNOWN");
  });
});

// Owner t181u hardening (G19): a refund row left PENDING (process stopped
// between the durable intent and recording the provider answer) is resolvable
// by another Brokerage Administrator once it is stale (older than the in-flight
// window), with exactly the G15 rules. No schema change: the 0043 guard already
// allows PENDING -> SUCCEEDED/FAILED. A fresh PENDING row is in flight and refused.
describe("t181u hardening (G19): BA resolution of a stalled PENDING card refund", { concurrency: false }, () => {
  async function pendingRefund(tag: string, ageMs: number, provider?: "Succeeded" | "Pending") {
    const p = await paidCharge(tag);
    const { createHash } = await import("node:crypto");
    const requestKey = key();
    const [charge] = await db.select().from(financialCardCharges).where(eq(financialCardCharges.id, p.chargeId));
    const idempotencyKey = `pcf-card-refund:${p.chargeId}:${createHash("sha256").update(requestKey).digest("hex").slice(0, 32)}`;
    const [row] = await db
      .insert(financialCardRefunds)
      .values({
        brokerageId: w.X.brokerageId,
        paymentRequestId: p.c.requestId,
        cardChargeId: p.chargeId,
        requestKey,
        idempotencyKey,
        amountCents: p.amountCents,
        status: "PENDING",
        provider: charge!.provider,
        reason: "Synthetic refund interrupted before the outcome was recorded",
        requestedByUserId: w.X.admin.user.id,
        createdAt: new Date(Date.now() - ageMs),
      })
      .returning();
    if (provider) MockPaymentProvider.refundsByKey.set(idempotencyKey, { providerRefundRef: `mock-refund-g19-${row!.id}`, status: provider, aeRefundId: row!.id, amountCents: p.amountCents });
    return { ...p, refundId: row!.id };
  }
  const STALE = 20 * 60 * 1000;

  test("in flight: a fresh PENDING refund is refused (409), stays PENDING and reserved; status shows no provider answer; refusal audited", async () => {
    const { chargeId, refundId } = await pendingRefund("G19Fresh", 1000);
    const s = await status(w.admin2, refundId);
    assert.equal(s.status, 200, s.raw);
    assert.equal(s.json.refundStatus, "PENDING");
    assert.equal(s.json.providerStatus, null, "no lookup while in flight");
    assert.equal(s.json.resolvable, false);
    for (const o of ["SUCCEEDED", "FAILED"]) {
      const r = await resolve(w.admin2, refundId, o);
      assert.equal(r.status, 409, r.raw);
      assert.equal(r.json.code, "CARD_REFUND_IN_FLIGHT");
    }
    assert.equal((await refundRow(refundId)).status, "PENDING");
    assert.equal((await call(w.baseUrl, "GET", `/financial/card-charges/${chargeId}/refunds`, w.admin2.cookie)).json.refundableCents, 0, "PENDING reserves the amount");
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.brokerageId, w.X.brokerageId), eq(auditLogs.userId, w.admin2.user.id)));
    assert.ok(audits.some((a) => (a.updatedValue ?? "").includes("CARD_REFUND_IN_FLIGHT")));
  });

  test("stalled, never reached the provider: queue lists it; SUCCEEDED refused (mismatch); FAILED releases the reservation, no receipt, audit statusBefore PENDING, idempotent, never calls the provider", async () => {
    const { c, chargeId, refundId, amountCents } = await pendingRefund("G19Never", STALE);
    const q = await queue(w.admin2, "PENDING");
    assert.ok(q.json.cardRefunds.some((r: { id: number }) => r.id === refundId), q.raw);
    const s = await status(w.admin2, refundId);
    assert.equal(s.json.providerStatus, "NotFound");
    assert.equal(s.json.suggestedOutcome, "FAILED");
    assert.equal(s.json.resolvable, true);
    assert.ok(!s.raw.includes("pcf-card-refund"));
    const spy = mock.method(paymentProvider, "refund");
    try {
      assert.equal((await resolve(w.admin2, refundId, "SUCCEEDED")).json.code, "CARD_REFUND_OUTCOME_MISMATCH");
      assert.equal((await resolve(w.admin2, refundId, "FAILED", { reason: "" })).json.code, "RECOVERY_REASON_REQUIRED");
      const rs = await Promise.all([1, 2].map(() => resolve(w.admin2, refundId, "FAILED")));
      assert.deepEqual(rs.map((r) => r.status), [200, 200], rs.map((r) => r.raw).join("\n"));
      assert.equal(rs.filter((r) => r.json.idempotent === false).length, 1);
      assert.equal(spy.mock.callCount(), 0);
    } finally {
      spy.mock.restore();
    }
    assert.equal((await refundRow(refundId)).status, "FAILED");
    assert.equal((await call(w.baseUrl, "GET", `/financial/card-charges/${chargeId}/refunds`, w.admin2.cookie)).json.refundableCents, amountCents);
    assert.equal((await receipts(c)).filter((r) => r.kind === "REFUND").length, 0);
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.brokerageId, w.X.brokerageId), eq(auditLogs.action, "financial_card_refund_resolved")));
    const mine = audits.filter((a) => (a.updatedValue ?? "").includes(`"refundId":${refundId}`));
    assert.equal(mine.length, 1);
    assert.ok((mine[0]!.updatedValue ?? "").includes(`"statusBefore":"PENDING"`), mine[0]!.updatedValue ?? "");
    assert.ok(!(mine[0]!.updatedValue ?? "").includes(REASON) && !(mine[0]!.updatedValue ?? "").includes(String(amountCents)), "value-free audit");
  });

  test("stalled after the provider accepted: SUCCEEDED -> REFUND receipt and provider ref recorded; FAILED refused", async () => {
    const { c, refundId, amountCents } = await pendingRefund("G19Took", STALE, "Succeeded");
    assert.equal((await resolve(w.admin2, refundId, "FAILED")).json.code, "CARD_REFUND_OUTCOME_MISMATCH");
    const ok = await resolve(w.admin2, refundId, "SUCCEEDED");
    assert.equal(ok.status, 200, ok.raw);
    const row = await refundRow(refundId);
    assert.equal(row.status, "SUCCEEDED");
    assert.equal(row.providerRefundRef, `mock-refund-g19-${refundId}`);
    const rc = (await receipts(c)).filter((r) => r.kind === "REFUND");
    assert.equal(rc.length, 1);
    assert.equal(rc[0]!.amountCents, amountCents);
    assert.equal((await resolve(w.admin2, refundId, "FAILED")).json.code, "CARD_REFUND_ALREADY_FINAL");
  });

  test("stalled: requester 403, Pit Crew/agents 403, other brokerage 404; provider Pending -> refused, stays PENDING", async () => {
    const { refundId } = await pendingRefund("G19Gate", STALE, "Pending");
    assert.equal((await resolve(w.X.admin, refundId, "FAILED")).json.code, "CARD_REFUND_RESOLVER_IS_REQUESTER");
    for (const who of [w.crew, w.X.agent]) assert.equal((await resolve(who, refundId, "FAILED")).status, 403);
    assert.equal((await resolve(w.Y.admin, refundId, "FAILED")).status, 404);
    assert.equal((await status(w.Y.admin, refundId)).status, 404);
    assert.equal((await status(w.admin2, refundId)).json.providerStatus, "Pending");
    for (const o of ["SUCCEEDED", "FAILED"]) assert.equal((await resolve(w.admin2, refundId, o)).json.code, "CARD_REFUND_PROVIDER_STATUS_UNAVAILABLE");
    assert.equal((await refundRow(refundId)).status, "PENDING");
  });
});
