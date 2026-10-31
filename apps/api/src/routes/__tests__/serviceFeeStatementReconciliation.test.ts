// Owner t181u phase 2a item 5: automatic payment/refund reconciliation on
// settlement statements (G5). PAYMENT and REFUND entries are DERIVED ON READ
// from the immutable receipts and cross-checked against the ledger; nothing
// is ever written to an ISSUED statement (DB trigger still refuses it), and
// no new version is created. Any inconsistency fails closed to NEEDS_REVIEW.
// Synthetic data, mock provider.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, financialCardCharges, financialLedgerEvents, settlementStatementLines, settlementStatements } from "@aee/db";
import { cleanupBrokerages } from "./testSupport.js";
import {
  call,
  cardAuthorityViaApi,
  collect,
  confirmBoth,
  elapseNotice,
  feeChain,
  makeWorld,
  prepare,
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
let n = 0;

async function issuedCard(tag: string) {
  const card = await saveCard("Agent", w.X.agent.user.id);
  const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
  assert.equal(a.activated.status, 200, a.activated.raw);
  const c = await feeChain(w, a.id, tag);
  await confirmBoth(w, c);
  const iss = await prepareAndIssue(w, w.crew, c);
  assert.equal(iss.status, 200, iss.raw);
  const [st] = await db.select().from(settlementStatements).where(and(eq(settlementStatements.transactionId, c.transactionId), eq(settlementStatements.status, "ISSUED")));
  return { c, statement: st! };
}
async function pay(c: Chain) {
  await elapseNotice(c);
  const r = await collect(w, w.crew, c);
  assert.equal(r.json.outcome, "card_charged", r.raw);
  const [charge] = await db.select().from(financialCardCharges).where(eq(financialCardCharges.paymentRequestId, c.requestId));
  return charge!;
}
const refund = (who: Who, chargeId: number, amountCents: number) =>
  call(w.baseUrl, "POST", `/financial/card-charges/${chargeId}/refunds`, who.cookie, { amountCents, reason: "Synthetic refund for reconciliation", evidenceNote: "Synthetic note", requestKey: `t181-recon-${Date.now()}-${++n}` });
const recon = (who: Who, statementId: number) => call(w.baseUrl, "GET", `/financial/settlement-statements/${statementId}/reconciliation`, who.cookie);
const listed = (who: Who, c: Chain) => call(w.baseUrl, "GET", `/financial/settlement-statements?transactionId=${c.transactionId}`, who.cookie);
async function snapshot(statementId: number) {
  const [s] = await db.select().from(settlementStatements).where(eq(settlementStatements.id, statementId));
  const lines = await db.select().from(settlementStatementLines).where(eq(settlementStatementLines.statementId, statementId)).orderBy(settlementStatementLines.lineNo);
  return JSON.stringify({ s, lines });
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "StmtRecon");
});

after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t181u phase 2a item 5: statement payment/refund reconciliation (computed on read)", { concurrency: false }, () => {
  test("unpaid: UNPAID, no entries, balance = itemised fee; the issued statement is untouched", async () => {
    const { statement } = await issuedCard("ReconUnpaid");
    const before = await snapshot(statement.id);
    const r = await recon(w.X.admin, statement.id);
    assert.equal(r.status, 200, r.raw);
    const rec = r.json.reconciliation;
    assert.equal(rec.computed, true);
    assert.equal(rec.persisted, false);
    assert.equal(rec.statementId, statement.id);
    assert.equal(rec.status, "UNPAID");
    assert.deepEqual(rec.entries, []);
    assert.ok(rec.totals.itemisedServiceFeeCents > 0);
    assert.equal(rec.totals.balanceCents, rec.totals.itemisedServiceFeeCents);
    assert.equal(await snapshot(statement.id), before, "reading never mutates the issued statement");
  });

  test("paid, then partially refunded: PAYMENT (credit) and REFUND (debit) entries from receipts; PARTIALLY_REFUNDED then REFUNDED; statement row and lines unchanged, no new version", async () => {
    const { c, statement } = await issuedCard("ReconPaid");
    const before = await snapshot(statement.id);
    const charge = await pay(c);
    let rec = (await recon(w.crew, statement.id)).json.reconciliation;
    assert.equal(rec.status, "PAID", JSON.stringify(rec));
    assert.deepEqual(rec.entries.map((e: { kind: string; effect: string; amountCents: number }) => [e.kind, e.effect, e.amountCents]), [["PAYMENT", "CREDIT", charge.amountCents]]);
    assert.ok(rec.entries[0].receiptNumber.startsWith("AER-"));
    assert.equal(rec.totals.balanceCents, 0);

    const part = Math.floor(charge.amountCents / 4);
    assert.equal((await refund(w.X.admin, charge.id, part)).status, 201);
    rec = (await recon(w.X.admin, statement.id)).json.reconciliation;
    assert.equal(rec.status, "PARTIALLY_REFUNDED", JSON.stringify(rec));
    assert.deepEqual(rec.entries.map((e: { kind: string; effect: string; amountCents: number }) => [e.kind, e.effect, e.amountCents]), [["PAYMENT", "CREDIT", charge.amountCents], ["REFUND", "DEBIT", part]]);
    assert.equal(rec.totals.paidCents, charge.amountCents);
    assert.equal(rec.totals.refundedCents, part);
    assert.equal(rec.totals.netCollectedCents, charge.amountCents - part);
    assert.equal(rec.totals.balanceCents, part);

    assert.equal((await refund(w.X.admin, charge.id, charge.amountCents - part)).status, 201);
    rec = (await recon(w.X.admin, statement.id)).json.reconciliation;
    assert.equal(rec.status, "REFUNDED");
    assert.equal(rec.totals.netCollectedCents, 0);

    // The list endpoint carries the same computed section on the ISSUED statement only.
    const l = await listed(w.X.admin, c);
    assert.equal(l.status, 200);
    const st = l.json.statements.find((s: { id: number }) => s.id === statement.id);
    assert.equal(st.reconciliation.status, "REFUNDED");
    assert.ok(st.lines.every((x: { kind: string }) => x.kind !== "PAYMENT" && x.kind !== "REFUND"), "no PAYMENT/REFUND lines were written");
    assert.equal(await snapshot(statement.id), before, "ISSUED statement and its lines are byte-identical");
    assert.equal((await db.select().from(settlementStatements).where(eq(settlementStatements.transactionId, c.transactionId))).length, 1, "no new version");
  });

  test("immutability: the database refuses a PAYMENT line on an ISSUED statement", async () => {
    const { statement } = await issuedCard("ReconImmutable");
    await assert.rejects(
      db.insert(settlementStatementLines).values({ statementId: statement.id, lineNo: 99, kind: "PAYMENT", effect: "CREDIT", description: "Synthetic", amountCents: 1, gstCents: 0, sourceType: "test", sourceId: "1" }),
    );
  });

  test("fail closed: a ledger refund with no matching receipt makes the section NEEDS_REVIEW", async () => {
    const { c, statement } = await issuedCard("ReconMismatch");
    await pay(c);
    await db.insert(financialLedgerEvents).values({
      brokerageId: w.X.brokerageId,
      propertyId: c.propertyId,
      transactionId: c.transactionId,
      eventType: "PC_FEE_CARD_REFUNDED",
      amountCents: 100,
      sourceRecordType: "PAYMENT_REQUEST",
      sourceRecordId: String(c.requestId),
      actorType: "SYSTEM",
      reason: "Synthetic orphan ledger refund",
      metadata: { refundAmountCents: 100, refundId: -1 },
    });
    const rec = (await recon(w.X.admin, statement.id)).json.reconciliation;
    assert.equal(rec.status, "NEEDS_REVIEW", JSON.stringify(rec));
    assert.ok(rec.issues.some((i: { code: string }) => i.code === "LEDGER_RECEIPT_MISMATCH"), JSON.stringify(rec.issues));
  });

  test("access and versions: other brokerage 404, unassigned Pit Crew 404; a DRAFT carries no reconciliation", async () => {
    const { c, statement } = await issuedCard("ReconAccess");
    assert.equal((await recon(w.Y.admin, statement.id)).status, 404);
    assert.equal((await recon(w.crewUnassigned, statement.id)).status, 404);
    assert.equal((await recon(w.otherAgent, statement.id)).status, 404);
    const draft = await prepare(w, w.X.admin, c, { supersedeReason: "Synthetic correction draft" });
    assert.equal(draft.status, 201, draft.raw);
    const r = await recon(w.X.admin, draft.json.statement.id);
    assert.equal(r.status, 200);
    assert.equal(r.json.reconciliation, null, "only an ISSUED statement is reconciled");
  });
});
