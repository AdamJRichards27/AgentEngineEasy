// Owner t181u hardening: negative and security tests for the Pit Crew service
// fee card-charge / card-refund recovery surface (refunds, UNKNOWN and stalled
// resolution, BA queues, reconciliation). Unauthenticated access, malformed
// ids and bodies, evidence from another property, queue filter injection and
// key leakage. Synthetic data, mock provider only; no behaviour change.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import { db, financialCardCharges, financialCardRefunds, settlementStatements } from "@aee/db";
import { MockPaymentProvider } from "@aee/integration-payments";
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
  type World,
} from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let w: World;
const REASON = "Synthetic negative-test reason kestrel-amber";
const NOTE = "Synthetic evidence note for a negative test (no card data)";
let keyN = 0;
const key = () => `t181-neg-${Date.now()}-${++keyN}`;
const refundRow = async (id: number) => (await db.select().from(financialCardRefunds).where(eq(financialCardRefunds.id, id)))[0]!;

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

async function unknownRefund(tag: string) {
  const p = await paidCharge(tag);
  MockPaymentProvider.nextRefundBehaviour = "throw";
  const r = await call(w.baseUrl, "POST", `/financial/card-charges/${p.chargeId}/refunds`, w.X.admin.cookie, { amountCents: p.amountCents, reason: REASON, evidenceNote: NOTE, requestKey: key() });
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
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "RefundNeg");
});

after(async () => {
  MockPaymentProvider.nextRefundBehaviour = null;
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t181u hardening: refund/recovery negative and security tests", { concurrency: false }, () => {
  test("unauthenticated: every card-charge/card-refund/reconciliation route is 401 and nothing changes", async () => {
    const { c, chargeId, refundId } = await unknownRefund("NegAnon");
    const [st] = await db.select().from(settlementStatements).where(eq(settlementStatements.transactionId, c.transactionId));
    const routes: [string, string, unknown?][] = [
      ["GET", "/financial/card-refunds"],
      ["GET", `/financial/card-refunds/${refundId}/provider-status`],
      ["POST", `/financial/card-refunds/${refundId}/resolve`, { outcome: "FAILED", reason: REASON, evidenceNote: NOTE }],
      ["GET", "/financial/card-charges"],
      ["GET", `/financial/card-charges/${chargeId}/provider-status`],
      ["POST", `/financial/card-charges/${chargeId}/resolve`, { outcome: "FAILED", reason: REASON, evidenceNote: NOTE }],
      ["GET", `/financial/card-charges/${chargeId}/refunds`],
      ["POST", `/financial/card-charges/${chargeId}/refunds`, { amountCents: 1, reason: REASON, evidenceNote: NOTE, requestKey: key() }],
      ["GET", `/financial/settlement-statements/${st!.id}/reconciliation`],
    ];
    for (const [m, p, b] of routes) {
      const r = await call(w.baseUrl, m, p, undefined, b);
      assert.equal(r.status, 401, `${m} ${p}: ${r.raw}`);
      assert.ok(!r.raw.includes("pcf-card-refund") && !r.raw.includes(CARD_TOKEN_MARKER));
    }
    assert.equal((await refundRow(refundId)).status, "UNKNOWN");
    assert.equal((await db.select().from(financialCardRefunds).where(eq(financialCardRefunds.cardChargeId, chargeId))).length, 1, "no refund created");
  });

  test("malformed ids and bodies: 400/404, never 500; strict resolve body; refund stays UNKNOWN", async () => {
    const { refundId } = await unknownRefund("NegShape");
    for (const id of ["abc", "-1", "0", "1.5", "99999999999999999999", "1e3", "%20"]) {
      for (const [m, p] of [
        ["GET", `/financial/card-refunds/${id}/provider-status`],
        ["POST", `/financial/card-refunds/${id}/resolve`],
        ["GET", `/financial/card-charges/${id}/refunds`],
        ["POST", `/financial/card-charges/${id}/resolve`],
      ] as const) {
        const r = await call(w.baseUrl, m, p, w.admin2.cookie, m === "POST" ? { outcome: "FAILED", reason: REASON, evidenceNote: NOTE } : undefined);
        assert.ok(r.status === 404 || r.status === 400, `${m} ${p} -> ${r.status} ${r.raw}`);
      }
    }
    const path = `/financial/card-refunds/${refundId}/resolve`;
    for (const body of [
      { outcome: "FAILED", reason: REASON, evidenceNote: NOTE, providerRefundRef: "mock-refund-forged" },
      { outcome: "FAILED", reason: REASON, evidenceNote: NOTE, amountCents: 1 },
      { outcome: "FAILED", reason: REASON, evidenceNote: NOTE, status: "SUCCEEDED" },
      { outcome: "PENDING", reason: REASON, evidenceNote: NOTE },
      { outcome: "UNKNOWN", reason: REASON, evidenceNote: NOTE },
      { outcome: ["FAILED"], reason: REASON, evidenceNote: NOTE },
      { reason: REASON, evidenceNote: NOTE },
    ]) {
      const r = await call(w.baseUrl, "POST", path, w.admin2.cookie, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.raw}`);
    }
    const huge = await call(w.baseUrl, "POST", path, w.admin2.cookie, { outcome: "FAILED", reason: "x".repeat(2001), evidenceNote: NOTE });
    assert.equal(huge.status, 400, huge.raw);
    assert.equal((await refundRow(refundId)).status, "UNKNOWN");
  });

  test("evidence must be on this transaction's property: another property's document is refused (422), nothing changes", async () => {
    const { refundId } = await unknownRefund("NegEvA");
    const other = await paidCharge("NegEvB");
    const r = await call(w.baseUrl, "POST", `/financial/card-refunds/${refundId}/resolve`, w.admin2.cookie, { outcome: "FAILED", reason: REASON, evidenceDocumentId: other.c.docId });
    assert.equal(r.status, 422, r.raw);
    assert.equal(r.json.code, "RECOVERY_EVIDENCE_INVALID");
    const refund = await call(w.baseUrl, "POST", `/financial/card-charges/${other.chargeId}/refunds`, w.admin2.cookie, { amountCents: 100, reason: REASON, evidenceDocumentId: (await paidCharge("NegEvC")).c.docId, requestKey: key() });
    assert.equal(refund.status, 422, refund.raw);
    assert.equal((await refundRow(refundId)).status, "UNKNOWN");
    assert.equal((await db.select().from(financialCardRefunds).where(eq(financialCardRefunds.cardChargeId, other.chargeId))).length, 0);
  });

  test("queue filters: unknown or injected status values never widen scope beyond the caller's brokerage; no keys returned", async () => {
    const { chargeId } = await unknownRefund("NegQueue");
    const mineX = (await db.select({ id: financialCardRefunds.id }).from(financialCardRefunds).where(eq(financialCardRefunds.brokerageId, w.X.brokerageId))).map((r) => r.id);
    for (const s of ["UNKNOWN' OR '1'='1", "%27%20OR%201%3D1", "PENDING,UNKNOWN", "unknown", ""]) {
      for (const p of [`/financial/card-refunds?status=${s}`, `/financial/card-charges?status=${s}`]) {
        const y = await call(w.baseUrl, "GET", p, w.Y.admin.cookie);
        assert.equal(y.status, 200, y.raw);
        const rows = (y.json.cardRefunds ?? y.json.cardCharges) as { id: number; brokerageId: number }[];
        assert.ok(rows.every((r) => r.brokerageId === w.Y.brokerageId), `${p} leaked another brokerage`);
        const x = await call(w.baseUrl, "GET", p, w.admin2.cookie);
        assert.equal(x.status, 200, x.raw);
        assert.ok(!x.raw.includes("pcf-card-refund") && !x.raw.includes("requestKey") && !x.raw.includes("idempotencyKey") && !x.raw.includes(CARD_TOKEN_MARKER), p);
      }
    }
    const xs = (await call(w.baseUrl, "GET", `/financial/card-refunds?status=x`, w.admin2.cookie)).json.cardRefunds as { id: number }[];
    assert.ok(xs.every((r) => mineX.includes(r.id)));
    const list = await call(w.baseUrl, "GET", `/financial/card-charges/${chargeId}/refunds`, w.admin2.cookie);
    assert.equal(list.status, 200, list.raw);
    assert.ok(!list.raw.includes("pcf-card-refund") && !list.raw.includes("requestKey") && !list.raw.includes("idempotencyKey"));
    const ids = (list.json.refunds as { id: number }[]).map((r) => r.id);
    assert.equal((await db.select().from(financialCardRefunds).where(inArray(financialCardRefunds.id, ids))).every((r) => r.brokerageId === w.X.brokerageId), true);
  });
});
