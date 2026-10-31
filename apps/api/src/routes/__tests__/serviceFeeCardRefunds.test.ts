// Owner t181u phase 2a item 3: controlled card refunds of the AE Pit Crew
// service fee. Brokerage Administrator only; refunds a SUCCEEDED stored-card
// charge back to the ORIGINAL charge (provider refund by charge reference,
// no destination accepted) through the existing tokenised provider refund
// path, mock provider only, with a per-refund idempotency key. Mandatory
// reason + evidence; never more than the charged amount (partials tracked,
// concurrency safe, DB guard); the refunder is never the charge initiator;
// REFUND receipt + value-free audit. Synthetic data only.
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, financialCardCharges, financialCardRefunds, financialLedgerEvents, financialReceipts } from "@aee/db";
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
  request,
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
const REASON = "Synthetic refund reason kestrel-lilac";
const NOTE = "Synthetic evidence note: agreed goodwill refund";
let keyN = 0;
const key = () => `t181-refund-${Date.now()}-${++keyN}`;
const refunds = (chargeId: number) => db.select().from(financialCardRefunds).where(eq(financialCardRefunds.cardChargeId, chargeId)).orderBy(financialCardRefunds.id);
const receipts = (c: Chain) => db.select().from(financialReceipts).where(eq(financialReceipts.paymentRequestId, c.requestId)).orderBy(financialReceipts.id);
const refund = (who: Who, chargeId: number, body: Record<string, unknown>) =>
  call(w.baseUrl, "POST", `/financial/card-charges/${chargeId}/refunds`, who.cookie, { reason: REASON, evidenceNote: NOTE, requestKey: key(), ...body });
const list = (who: Who, chargeId: number) => call(w.baseUrl, "GET", `/financial/card-charges/${chargeId}/refunds`, who.cookie);

async function paidCharge(tag: string, initiator: Who = w.crew) {
  const card = await saveCard("Agent", w.X.agent.user.id);
  const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
  assert.equal(a.activated.status, 200, a.activated.raw);
  const c = await feeChain(w, a.id, tag);
  await confirmBoth(w, c);
  const iss = await prepareAndIssue(w, w.crew, c);
  assert.equal(iss.status, 200, iss.raw);
  await elapseNotice(c);
  const r = await collect(w, initiator, c);
  assert.equal(r.json.outcome, "card_charged", r.raw);
  const [charge] = await db.select().from(financialCardCharges).where(eq(financialCardCharges.paymentRequestId, c.requestId));
  assert.equal(charge!.status, "SUCCEEDED");
  return { c, charge: charge! };
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "Refund");
});

after(async () => {
  MockPaymentProvider.nextRefundBehaviour = null;
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t181u phase 2a item 3: controlled card refunds", { concurrency: false }, () => {
  test("access: Pit Crew, listing agent and other agents 403; another brokerage 404; nothing refunded", async () => {
    const { charge } = await paidCharge("RefundAccess");
    const spy = mock.method(paymentProvider, "refund");
    try {
      for (const who of [w.crew, w.crewUnassigned, w.X.agent, w.otherAgent]) {
        assert.equal((await refund(who, charge.id, { amountCents: 100 })).status, 403);
        assert.equal((await list(who, charge.id)).status, 403);
      }
      assert.equal((await refund(w.Y.admin, charge.id, { amountCents: 100 })).status, 404);
      assert.equal((await list(w.Y.admin, charge.id)).status, 404);
      assert.equal(spy.mock.callCount(), 0);
    } finally {
      spy.mock.restore();
    }
    assert.equal((await refunds(charge.id)).length, 0);
  });

  test("validation: reason and evidence mandatory; amount a positive integer; no destination accepted; only a SUCCEEDED charge", async () => {
    const { charge } = await paidCharge("RefundValidate");
    assert.equal((await refund(w.X.admin, charge.id, { amountCents: 100, reason: "" })).json.code, "RECOVERY_REASON_REQUIRED");
    assert.equal((await refund(w.X.admin, charge.id, { amountCents: 100, evidenceNote: undefined })).json.code, "RECOVERY_EVIDENCE_REQUIRED");
    for (const amountCents of [0, -5, 10.5, "100"]) assert.equal((await refund(w.X.admin, charge.id, { amountCents })).status, 400, String(amountCents));
    assert.equal((await refund(w.X.admin, charge.id, { amountCents: 100, requestKey: undefined })).status, 400, "request key required");
    for (const extra of [{ paymentMethodId: 1 }, { destination: "acct_other" }, { providerChargeRef: "other-charge" }]) {
      assert.equal((await refund(w.X.admin, charge.id, { amountCents: 100, ...extra })).status, 400, `refused: ${Object.keys(extra)[0]}`);
    }
    const over = await refund(w.X.admin, charge.id, { amountCents: charge.amountCents + 1 });
    assert.equal(over.status, 409, over.raw);
    assert.equal(over.json.code, "CARD_REFUND_EXCEEDS_REFUNDABLE");
    assert.equal((await refunds(charge.id)).length, 0);
    const [failed] = await db
      .insert(financialCardCharges)
      .values({ ...charge, id: undefined, attemptNo: 7, idempotencyKey: `t181-failed-${key()}`, status: "FAILED" } as never)
      .returning();
    const nf = await refund(w.X.admin, failed!.id, { amountCents: 100 });
    assert.equal(nf.status, 409, nf.raw);
    assert.equal(nf.json.code, "CARD_REFUND_CHARGE_NOT_REFUNDABLE");
  });

  test("partial then remaining refund to the original charge: REFUND receipts, ledger, value-free audit, cap enforced, request stays PAID", async () => {
    const { c, charge } = await paidCharge("RefundPartial");
    const spy = mock.method(paymentProvider, "refund");
    const part = Math.floor(charge.amountCents / 3);
    try {
      const r1 = await refund(w.X.admin, charge.id, { amountCents: part });
      assert.equal(r1.status, 201, r1.raw);
      assert.equal(r1.json.refund.status, "SUCCEEDED");
      assert.equal(r1.json.refundableCents, charge.amountCents - part);
      assert.ok(!r1.raw.includes(CARD_TOKEN_MARKER) && !r1.raw.includes("idempotencyKey"), "no token or provider key returned");
      const input = spy.mock.calls[0]!.arguments[0] as { providerChargeRef: string; amountCents: number; idempotencyKey: string };
      assert.equal(input.providerChargeRef, charge.providerChargeRef, "refund goes back to the original charge");
      assert.equal(input.amountCents, part);
      assert.deepEqual(Object.keys(input).sort(), ["aeRefundId", "amountCents", "idempotencyKey", "providerChargeRef"], "no destination of any kind");
      const r2 = await refund(w.X.admin, charge.id, { amountCents: charge.amountCents - part });
      assert.equal(r2.status, 201, r2.raw);
      assert.equal(r2.json.refundableCents, 0);
      const r3 = await refund(w.X.admin, charge.id, { amountCents: 1 });
      assert.equal(r3.json.code, "CARD_REFUND_EXCEEDS_REFUNDABLE");
      assert.equal(spy.mock.callCount(), 2);
    } finally {
      spy.mock.restore();
    }
    const rows = await refunds(charge.id);
    assert.deepEqual(rows.map((r) => [r.amountCents, r.status]), [[part, "SUCCEEDED"], [charge.amountCents - part, "SUCCEEDED"]]);
    assert.ok(rows.every((r) => r.requestedByUserId === w.X.admin.user.id));
    const l = await list(w.X.admin, charge.id);
    assert.equal(l.status, 200);
    assert.equal(l.json.refundedCents, charge.amountCents);
    assert.equal(l.json.refundableCents, 0);
    assert.ok(!l.raw.includes("idempotencyKey"));
    const rc = (await receipts(c)).filter((r) => r.kind === "REFUND");
    assert.deepEqual(rc.map((r) => r.amountCents), [part, charge.amountCents - part]);
    assert.ok(rc.every((r) => r.paymentMethodType === "STORED_CARD" && r.providerReference?.startsWith("mock-refund-")));
    assert.equal((await request(c.requestId)).status, "PAID", "money was collected; refunds are tracked separately");
    const ev = await db
      .select()
      .from(financialLedgerEvents)
      .where(and(eq(financialLedgerEvents.sourceRecordId, String(c.requestId)), eq(financialLedgerEvents.eventType, "PC_FEE_CARD_REFUNDED")));
    assert.equal(ev.length, 2);
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.brokerageId, w.X.brokerageId), eq(auditLogs.recordType, "financial_payment_request"), eq(auditLogs.recordId, String(c.requestId))));
    const refundAudits = audits.filter((a) => a.action.startsWith("financial_card_refund"));
    assert.ok(refundAudits.length >= 2, refundAudits.map((a) => a.action).join(","));
    for (const a of refundAudits) {
      const v = a.updatedValue ?? "";
      assert.ok(!v.includes(REASON) && !v.includes(NOTE) && !v.includes(CARD_TOKEN_MARKER) && !v.includes("amountCents"), `value-free: ${v}`);
    }
  });

  test("idempotent: the same request key replays without a second provider refund; reusing it for another amount is refused", async () => {
    const { charge } = await paidCharge("RefundReplay");
    const spy = mock.method(paymentProvider, "refund");
    try {
      const k = key();
      const rs = await Promise.all([1, 2, 3].map(() => refund(w.X.admin, charge.id, { amountCents: 500, requestKey: k })));
      assert.ok(rs.every((r) => r.status === 201 || r.status === 200), rs.map((r) => r.raw).join("\n"));
      assert.equal(rs.filter((r) => r.json.idempotent === false).length, 1);
      assert.equal(spy.mock.callCount(), 1);
      const reuse = await refund(w.X.admin, charge.id, { amountCents: 600, requestKey: k });
      assert.equal(reuse.status, 409);
      assert.equal(reuse.json.code, "CARD_REFUND_KEY_REUSED");
    } finally {
      spy.mock.restore();
    }
    assert.equal((await refunds(charge.id)).length, 1);
  });

  test("concurrency: parallel refunds never exceed the charged amount; the database refuses an over-refund row", async () => {
    const { charge } = await paidCharge("RefundRace");
    const each = Math.floor(charge.amountCents * 0.4);
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => refund(w.X.admin, charge.id, { amountCents: each })));
    assert.equal(rs.filter((r) => r.status === 201).length, 2, rs.map((r) => r.raw).join("\n"));
    assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.json.code === "CARD_REFUND_EXCEEDS_REFUNDABLE"));
    const rows = await refunds(charge.id);
    assert.equal(rows.reduce((s, r) => s + r.amountCents, 0), each * 2);
    await assert.rejects(
      db.insert(financialCardRefunds).values({ ...rows[0]!, id: undefined, requestKey: key(), idempotencyKey: `t181-direct-${key()}`, status: "PENDING" } as never),
      (e: unknown) => /exceed/i.test(`${(e as Error).message} ${(e as { cause?: Error }).cause?.message ?? ""}`),
    );
  });

  test("separation of duties: the BA who initiated the charge cannot refund it (403, audited); another BA can", async () => {
    const { c, charge } = await paidCharge("RefundSelf", w.X.admin);
    assert.equal(charge.initiatedByUserId, w.X.admin.user.id);
    const self = await refund(w.X.admin, charge.id, { amountCents: 100 });
    assert.equal(self.status, 403, self.raw);
    assert.equal(self.json.code, "CARD_REFUND_REFUNDER_IS_INITIATOR");
    const refused = await db.select().from(auditLogs).where(and(eq(auditLogs.brokerageId, w.X.brokerageId), eq(auditLogs.userId, w.X.admin.user.id)));
    assert.ok(refused.some((a) => (a.updatedValue ?? "").includes("CARD_REFUND_REFUNDER_IS_INITIATOR")));
    const ok = await refund(w.admin2, charge.id, { amountCents: 100 });
    assert.equal(ok.status, 201, ok.raw);
    assert.equal((await refunds(charge.id)).length, 1);
    assert.equal((await request(c.requestId)).status, "PAID");
  });

  test("provider outcomes: a rejection is FAILED (amount released, no receipt); a lost answer is UNKNOWN (amount stays reserved, never retried)", async () => {
    const { c, charge } = await paidCharge("RefundOutcomes");
    MockPaymentProvider.nextRefundBehaviour = "reject";
    const rej = await refund(w.X.admin, charge.id, { amountCents: charge.amountCents });
    assert.equal(rej.status, 201, rej.raw);
    assert.equal(rej.json.refund.status, "FAILED");
    assert.equal(rej.json.refundableCents, charge.amountCents, "a failed refund releases its reservation");
    MockPaymentProvider.nextRefundBehaviour = "throw";
    const lost = await refund(w.X.admin, charge.id, { amountCents: 300 });
    assert.equal(lost.json.refund.status, "UNKNOWN", lost.raw);
    assert.equal(lost.json.refundableCents, charge.amountCents - 300, "UNKNOWN keeps the amount reserved");
    const over = await refund(w.X.admin, charge.id, { amountCents: charge.amountCents - 299 });
    assert.equal(over.json.code, "CARD_REFUND_EXCEEDS_REFUNDABLE");
    assert.equal((await receipts(c)).filter((r) => r.kind === "REFUND").length, 0, "no refund receipt without a confirmed refund");
  });
});

// Owner 27 Oct refund rules (c) verified processor evidence and (e) provider
// references mandatory: a provider "Succeeded" answer that carries no provider
// reference is not verified evidence, so it must never mark money as moved.
describe("Owner 27 Oct (c)(e): a success without a provider reference is not verified", { concurrency: false }, () => {
  test("refund: provider says Succeeded but returns no refund reference -> held UNKNOWN, amount reserved, no REFUND receipt", async () => {
    const { c, charge } = await paidCharge("RefundNoRef");
    const m = mock.method(paymentProvider, "refund", async () => ({ providerRefundRef: "", status: "Succeeded" as const }));
    try {
      const r = await refund(w.X.admin, charge.id, { amountCents: 200 });
      assert.equal(r.status, 201, r.raw);
      assert.equal(r.json.refund.status, "UNKNOWN", "an unreferenced success must be held as uncertain");
      assert.equal(r.json.refund.providerRefundRef ?? null, null);
      assert.equal(r.json.refundableCents, charge.amountCents - 200, "the amount stays reserved");
    } finally {
      m.mock.restore();
    }
    assert.equal((await receipts(c)).filter((x) => x.kind === "REFUND").length, 0, "no refund receipt without a provider reference");
    const [row] = await refunds(charge.id);
    assert.equal(row!.status, "UNKNOWN");
  });

  test("charge: provider says Succeeded but returns no charge reference -> not PAID; charge held UNKNOWN for Brokerage Administrator review", async () => {
    const card = await saveCard("Agent", w.X.agent.user.id);
    const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
    assert.equal(a.activated.status, 200, a.activated.raw);
    const c = await feeChain(w, a.id, "ChargeNoRef");
    await confirmBoth(w, c);
    const iss = await prepareAndIssue(w, w.crew, c);
    assert.equal(iss.status, 200, iss.raw);
    await elapseNotice(c);
    const m = mock.method(paymentProvider, "chargeStoredMethod", async () => ({ providerChargeRef: "", status: "Succeeded" as const }));
    try {
      await collect(w, w.crew, c);
    } finally {
      m.mock.restore();
    }
    const [charge] = await db.select().from(financialCardCharges).where(eq(financialCardCharges.paymentRequestId, c.requestId));
    assert.notEqual(charge!.status, "SUCCEEDED", "an unreferenced success must not be recorded as a succeeded charge");
    assert.equal(charge!.status, "UNKNOWN");
    assert.notEqual((await request(c.requestId)).status, "PAID", "the fee must not be marked PAID without a provider charge reference");
  });
});
