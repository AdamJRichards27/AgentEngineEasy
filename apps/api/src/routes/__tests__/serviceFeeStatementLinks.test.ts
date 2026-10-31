// Owner t183u item 7 / #245 S5: payments, refunds, waivers and write-offs
// link to the ISSUED settlement statement by id AND version, and never alter
// the issued version (statement row and its lines are unchanged). Each
// statement version is its own row, so the id pins the version; the version
// is derived on read (no schema change). Synthetic data, mock providers only.
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, financialCardCharges, financialReceipts, settlementStatementLines, settlementStatements } from "@aee/db";
import { paymentProvider } from "../../lib/paymentProvider.js";
import { cleanupBrokerages } from "./testSupport.js";
import { call, cardAuthorityViaApi, collect, confirmBoth, elapseNotice, feeChain, makeWorld, prepareAndIssue, saveCard, type Chain, type World } from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let w: World;
const REASON = "Synthetic statement-link reason";
const NOTE = "Synthetic statement-link evidence";

async function issuedCard(tag: string) {
  const card = await saveCard("Agent", w.X.agent.user.id);
  const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
  const c = await feeChain(w, a.id, tag);
  await confirmBoth(w, c);
  const iss = await prepareAndIssue(w, w.crew, c);
  assert.equal(iss.status, 200, iss.raw);
  await elapseNotice(c);
  const [st] = await db.select().from(settlementStatements).where(eq(settlementStatements.transactionId, c.transactionId));
  assert.equal(st!.status, "ISSUED");
  return { c, statement: st! };
}
async function snapshot(statementId: number) {
  const [row] = await db.select().from(settlementStatements).where(eq(settlementStatements.id, statementId));
  const lines = await db.select().from(settlementStatementLines).where(eq(settlementStatementLines.statementId, statementId)).orderBy(settlementStatementLines.id);
  return JSON.stringify({ row, lines });
}
function declineOnce() {
  const original = paymentProvider.chargeStoredMethod.bind(paymentProvider);
  let first = true;
  return mock.method(paymentProvider, "chargeStoredMethod", async (input: Parameters<typeof original>[0]) => {
    if (first) {
      first = false;
      return { providerChargeRef: `mock-failed-${input.idempotencyKey}`, status: "Failed" as const, failureReason: "card_declined" };
    }
    return original(input);
  });
}
const receiptView = (id: number) => call(w.baseUrl, "GET", `/financial/receipts/${id}`, w.X.admin.cookie);

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "StmtLink");
});
after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("S5 (t183u 7): statement id + version links; issued versions never altered", { concurrency: false }, () => {
  test("payment and refund receipts link to the issued statement by id and version; the issued version is unchanged", async () => {
    const { c, statement } = await issuedCard("LinkPay");
    const before = await snapshot(statement.id);
    assert.equal((await collect(w, w.crew, c)).json.outcome, "card_charged");
    const [charge] = await db.select().from(financialCardCharges).where(eq(financialCardCharges.paymentRequestId, c.requestId));
    const ref = await call(w.baseUrl, "POST", `/financial/card-charges/${charge!.id}/refunds`, w.X.admin.cookie, { amountCents: 100, reason: REASON, evidenceNote: NOTE, requestKey: `link-${charge!.id}-${Date.now()}` });
    assert.equal(ref.status, 201, ref.raw);
    const rows = await db.select().from(financialReceipts).where(eq(financialReceipts.paymentRequestId, c.requestId));
    const kinds = rows.map((r) => r.kind);
    assert.ok(kinds.includes("PAYMENT_SUCCEEDED") && kinds.includes("REFUND"), JSON.stringify(kinds));
    for (const r of rows) {
      assert.equal(r.settlementStatementId, statement.id, `${r.kind} stores the statement id`);
      const v = await receiptView(r.id);
      assert.equal(v.status, 200, v.raw);
      assert.deepEqual(v.json.receipt.settlementStatement, { id: statement.id, version: statement.version, status: "ISSUED" }, `${r.kind}: ${v.raw}`);
    }
    assert.equal(await snapshot(statement.id), before, "issued statement row and lines unchanged by payment and refund");
  });

  test("a waiver links to the issued statement (id + version) and does not alter it", async () => {
    const { c, statement } = await issuedCard("LinkWaive");
    const before = await snapshot(statement.id);
    const r = await call(w.baseUrl, "POST", `/financial/payment-requests/${c.requestId}/waive`, w.X.admin.cookie, { reason: REASON, evidenceNote: NOTE });
    assert.equal(r.status, 200, r.raw);
    const adj = await call(w.baseUrl, "GET", `/financial/payment-requests/${c.requestId}/adjustments`, w.X.admin.cookie);
    const rec = adj.json.adjustments[0];
    assert.equal(rec.settlementStatementId, statement.id);
    assert.equal(rec.settlementStatementVersion, statement.version);
    assert.equal(await snapshot(statement.id), before);
  });

  test("a write-off links to the issued statement (id + version) and does not alter it", async () => {
    const { c, statement } = await issuedCard("LinkWO");
    const spy = declineOnce();
    try {
      assert.equal((await collect(w, w.crew, c)).json.outcome, "card_failed_retry_scheduled");
    } finally {
      spy.mock.restore();
    }
    const before = await snapshot(statement.id);
    const r = await call(w.baseUrl, "POST", `/financial/payment-requests/${c.requestId}/write-off`, w.X.admin.cookie, { reason: REASON, evidenceNote: NOTE });
    assert.equal(r.status, 200, r.raw);
    const adj = await call(w.baseUrl, "GET", `/financial/payment-requests/${c.requestId}/adjustments`, w.X.admin.cookie);
    const rec = adj.json.adjustments.find((a: { kind?: string; eventType?: string }) => (a.kind ?? a.eventType ?? "").includes("WRITE"));
    assert.ok(rec, adj.raw);
    assert.equal(rec.settlementStatementId, statement.id);
    assert.equal(rec.settlementStatementVersion, statement.version);
    assert.equal(await snapshot(statement.id), before);
  });

  test("receipt list carries the statement id + version too", async () => {
    const { c, statement } = await issuedCard("LinkList");
    assert.equal((await collect(w, w.crew, c)).json.outcome, "card_charged");
    const list = await call(w.baseUrl, "GET", `/financial/receipts?transactionId=${c.transactionId}`, w.X.admin.cookie);
    assert.equal(list.status, 200, list.raw);
    assert.ok(list.json.receipts.length > 0, list.raw);
    for (const r of list.json.receipts) assert.deepEqual(r.settlementStatement, { id: statement.id, version: statement.version, status: "ISSUED" }, list.raw);
  });
});
