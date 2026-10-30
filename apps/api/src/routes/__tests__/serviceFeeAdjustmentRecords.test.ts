// Owner t183u items 1 and 2 (S2): PC fee waivers and write-offs.
//   1. A single authorised Brokerage Administrator approves AND executes a waiver or write-off. There is
//      no second-admin approval step.
//   2. Every adjustment carries a reason, the admin's identity, a timestamp and an immutable audit
//      record. It produces a formal adjustment record linked to the original settlement statement, with
//      amount, GST treatment, reason and approval details. Adjustment records are NOT payment receipts
//      and never appear or classify as receipts.
// Synthetic data, mock payments, local throwaway test DB only.

import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { auditLogs, db, financialDisputes, financialLedgerEvents, financialPaymentRequests, financialReceipts, pcFeeCalculations, settlementStatements } from "@aee/db";
import { paymentProvider } from "../../lib/paymentProvider.js";
import { cleanupBrokerages } from "./testSupport.js";
import {
  activeDebitAuthority,
  call,
  cardAuthorityViaApi,
  collect,
  confirmBoth,
  elapseNotice,
  elapseRetry,
  feeChain,
  makeWorld,
  prepare,
  prepareAndIssue,
  request,
  saveCard,
  type Chain,
  type World,
  type Who,
} from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let w: World;
const REASON = "Synthetic adjustment reason amber-falcon";
const NOTE = "Synthetic adjustment evidence note cobalt-lynx";

const waive = (who: Who, c: Chain, body: Record<string, unknown> = { reason: REASON, evidenceNote: NOTE }) =>
  call(w.baseUrl, "POST", `/financial/payment-requests/${c.requestId}/waive`, who.cookie, body);
const writeOff = (who: Who, c: Chain, body: Record<string, unknown> = { reason: REASON, evidenceNote: NOTE }) =>
  call(w.baseUrl, "POST", `/financial/payment-requests/${c.requestId}/write-off`, who.cookie, body);
const resolveDispute = (who: Who, c: Chain, outcome: string) =>
  call(w.baseUrl, "POST", `/financial/payment-requests/${c.requestId}/resolve-dispute`, who.cookie, { outcome, reason: REASON, evidenceDocumentId: c.docId });
const adjustments = (who: Who, c: Chain) => call(w.baseUrl, "GET", `/financial/payment-requests/${c.requestId}/adjustments`, who.cookie);
const receiptRows = (c: Chain) => db.select().from(financialReceipts).where(eq(financialReceipts.paymentRequestId, c.requestId)).orderBy(financialReceipts.id);
const ledger = (c: Chain, types: string[]) =>
  db
    .select()
    .from(financialLedgerEvents)
    .where(and(eq(financialLedgerEvents.sourceRecordId, String(c.requestId)), inArray(financialLedgerEvents.eventType, types)));
const issuedStatement = async (c: Chain) =>
  (await db.select().from(settlementStatements).where(and(eq(settlementStatements.transactionId, c.transactionId), eq(settlementStatements.status, "ISSUED"))))[0];
const feeGst = async (c: Chain) => {
  const req = await request(c.requestId);
  const [calc] = await db.select({ gstCents: pcFeeCalculations.gstCents }).from(pcFeeCalculations).where(eq(pcFeeCalculations.id, req.pcFeeCalculationId!));
  return { amountCents: req.amountCents, gstCents: Math.min(calc?.gstCents ?? 0, req.amountCents) };
};

/** Confirmed chain with an ISSUED statement (notice started). */
async function issued(authorityId: number, tag: string): Promise<Chain> {
  const c = await feeChain(w, authorityId, tag);
  await confirmBoth(w, c);
  const iss = await prepareAndIssue(w, w.crew, c);
  assert.equal(iss.status, 200, iss.raw);
  return c;
}

/** A card fee whose collection failed three times -> FAILED (write-off eligible). */
async function failedCardFee(tag: string): Promise<Chain> {
  const card = await saveCard("Agent", w.X.agent.user.id);
  const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
  assert.equal(a.activated.status, 200, a.activated.raw);
  const c = await issued(a.id, tag);
  await elapseNotice(c);
  const original = paymentProvider.chargeStoredMethod.bind(paymentProvider);
  const spy = mock.method(paymentProvider, "chargeStoredMethod", async (input: Parameters<typeof original>[0]) => ({
    providerChargeRef: `mock-failed-${input.idempotencyKey}`,
    status: "Failed" as const,
    failureReason: "card_declined",
  }));
  try {
    for (let i = 0; i < 3; i++) {
      if (i > 0) await elapseRetry(c);
      await collect(w, w.crew, c);
    }
  } finally {
    spy.mock.restore();
  }
  assert.equal((await request(c.requestId)).status, "FAILED");
  return c;
}

async function markDisputed(c: Chain) {
  const req = await request(c.requestId);
  await db.update(financialPaymentRequests).set({ status: "DISPUTED", providerStatus: "Disputed" }).where(eq(financialPaymentRequests.id, c.requestId));
  await db.insert(financialDisputes).values({ brokerageId: w.X.brokerageId, paymentRequestId: c.requestId, disputedAmountCents: req.amountCents, reason: "Disputed (synthetic)", status: "OPEN" });
}

type AdjustmentRecord = {
  recordNumber: string;
  documentType: string;
  isReceipt: boolean;
  kind: "WAIVER" | "WRITE_OFF";
  paymentRequestId: number;
  transactionId: number;
  settlementStatementId: number | null;
  settlementStatementVersion: number | null;
  amountCents: number;
  gstCents: number;
  amountExGstCents: number;
  gstTreatment: string;
  currency: string;
  reason: string;
  approval: { mode: string; approvedByUserId: number; approvedByRole: string; approvedAt: string; executedByUserId: number };
  via: "WAIVE" | "WRITE_OFF" | "DISPUTE_RESOLUTION";
  evidence: { kind: string; documentId: number | null };
  ledgerEventId: number;
};

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "Adjust");
});

after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("Owner t183u items 1-2: single-admin PC fee adjustments with formal adjustment records", { concurrency: false }, () => {
  test("item 1: one Brokerage Administrator approves and executes a waiver in a single step; no second admin, no pending approval", async () => {
    const dd = await activeDebitAuthority(w);
    const c = await issued(dd.id, "AdjWaiveSingle");
    const r = await waive(w.X.admin, c);
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.json.idempotent, false);
    assert.equal(r.json.paymentRequest.status, "WAIVED", "executed immediately, not left awaiting a second approval");
    const row = await request(c.requestId);
    assert.equal(row.status, "WAIVED");
    assert.equal(row.waivedByUserId, w.X.admin.user.id);
    const recs = (await adjustments(w.X.admin, c)).json.adjustments as AdjustmentRecord[];
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.approval.mode, "SINGLE_BROKERAGE_ADMIN");
    assert.equal(recs[0]!.approval.approvedByUserId, w.X.admin.user.id);
    assert.equal(recs[0]!.approval.executedByUserId, w.X.admin.user.id, "the approver is the executor");
  });

  test("item 1: Pit Crew, an agent and another brokerage's admin cannot waive or write off", async () => {
    const dd = await activeDebitAuthority(w);
    const c = await issued(dd.id, "AdjWaiveRoles");
    for (const who of [w.crew, w.X.agent]) {
      assert.equal((await waive(who, c)).status, 403);
      assert.equal((await writeOff(who, c)).status, 403);
    }
    assert.equal((await waive(w.Y.admin, c)).status, 404);
    assert.equal((await request(c.requestId)).status, "NOTICE_SENT");
    assert.equal((await ledger(c, ["PC_FEE_WAIVED", "PC_FEE_WRITTEN_OFF"])).length, 0);
  });

  test("item 2: a waiver produces a formal adjustment record linked to the original statement, with amount, GST treatment, reason and approval details", async () => {
    const dd = await activeDebitAuthority(w);
    const c = await issued(dd.id, "AdjWaiveRecord");
    const original = await issuedStatement(c);
    assert.ok(original, "statement issued");
    const before = Date.now();
    assert.equal((await waive(w.X.admin, c)).status, 200);
    const res = await adjustments(w.X.admin, c);
    assert.equal(res.status, 200, res.raw);
    const recs = res.json.adjustments as AdjustmentRecord[];
    assert.equal(recs.length, 1);
    const a = recs[0]!;
    const { amountCents, gstCents } = await feeGst(c);
    assert.match(a.recordNumber, /^ADJ-W-\d{8}$/);
    assert.equal(a.documentType, "PC_FEE_ADJUSTMENT");
    assert.equal(a.isReceipt, false);
    assert.equal(a.kind, "WAIVER");
    assert.equal(a.via, "WAIVE");
    assert.equal(a.paymentRequestId, c.requestId);
    assert.equal(a.transactionId, c.transactionId);
    assert.equal(a.settlementStatementId, original!.id);
    assert.equal(a.settlementStatementVersion, original!.version);
    assert.equal(a.amountCents, amountCents);
    assert.equal(a.gstCents, gstCents);
    assert.equal(a.amountExGstCents, amountCents - gstCents);
    assert.equal(a.gstTreatment, gstCents > 0 ? "GST_INCLUSIVE" : "NO_GST");
    assert.equal(a.currency, "AUD");
    assert.equal(a.reason, REASON);
    assert.equal(a.approval.approvedByRole, "Brokerage Administrator");
    const at = Date.parse(a.approval.approvedAt);
    assert.ok(at >= before - 5_000 && at <= Date.now() + 5_000, `timestamp ${a.approval.approvedAt}`);
    assert.deepEqual(a.evidence, { kind: "note", documentId: null });

    // The record is the immutable ledger event; its stored metadata carries the same facts.
    const [ev] = await ledger(c, ["PC_FEE_WAIVED"]);
    assert.equal(a.ledgerEventId, ev!.id);
    const adj = (ev!.metadata as Record<string, unknown>).adjustment as Record<string, unknown>;
    assert.ok(adj, "ledger metadata carries the adjustment record");
    assert.equal(adj.settlementStatementId, original!.id);
    assert.equal(adj.gstCents, gstCents);
    assert.equal(adj.approvedByUserId, w.X.admin.user.id);

    // Correcting the statement afterwards (a BA supersedes it) does not move the record off the original.
    const v2 = await prepare(w, w.X.admin, c, { supersedeReason: "Fee waived (synthetic)" });
    assert.equal(v2.status, 201, v2.raw);
    const again = (await adjustments(w.X.admin, c)).json.adjustments as AdjustmentRecord[];
    assert.deepEqual(again, recs, "record unchanged by a later statement correction");
  });

  test("item 2: a write-off produces a formal WRITE_OFF record; it is not a receipt and never appears or classifies as one", async () => {
    const c = await failedCardFee("AdjWriteOff");
    const original = await issuedStatement(c);
    const rcBefore = await receiptRows(c);
    const r = await writeOff(w.admin2, c);
    assert.equal(r.status, 200, r.raw);
    const recs = (await adjustments(w.admin2, c)).json.adjustments as AdjustmentRecord[];
    assert.equal(recs.length, 1);
    const a = recs[0]!;
    assert.match(a.recordNumber, /^ADJ-WO-\d{8}$/);
    assert.equal(a.kind, "WRITE_OFF");
    assert.equal(a.via, "WRITE_OFF");
    assert.equal(a.isReceipt, false);
    assert.equal(a.settlementStatementId, original!.id);
    assert.equal(a.approval.approvedByUserId, w.admin2.user.id, "any single authorised BA, not only the one who issued");

    // Not a receipt: no receipt row, no receipt kind, not in the receipts list, record number never a receipt number.
    const rcAfter = await receiptRows(c);
    assert.deepEqual(rcAfter.map((x) => x.id), rcBefore.map((x) => x.id), "no receipt row for a write-off");
    for (const rc of rcAfter) assert.ok(["PAYMENT_SUCCEEDED", "PAYMENT_FAILED", "REFUND", "RECONCILIATION"].includes(rc.kind));
    const list = await call(w.baseUrl, "GET", `/financial/receipts?transactionId=${c.transactionId}`, w.X.admin.cookie);
    assert.equal(list.status, 200, list.raw);
    assert.ok(!list.raw.includes(a.recordNumber), "adjustment record never listed as a receipt");
    assert.ok(!(list.json.receipts as Array<{ receiptNumber: string }>).some((x) => x.receiptNumber.startsWith("ADJ-")));
  });

  test("item 2: adjustments are kept out of receipt views: no waiver/write-off activity in a receipt's history or PDF", async () => {
    const c = await failedCardFee("AdjNotInReceiptHistory");
    const rc = await receiptRows(c);
    assert.ok(rc.length > 0, "the failed attempts issued payment-failed receipts");
    assert.equal((await writeOff(w.X.admin, c)).status, 200);
    const [rec] = (await adjustments(w.X.admin, c)).json.adjustments as AdjustmentRecord[];
    for (const r of await receiptRows(c)) {
      const detail = await call(w.baseUrl, "GET", `/financial/receipts/${r.id}`, w.X.admin.cookie);
      assert.equal(detail.status, 200, detail.raw);
      const types = (detail.json.history as Array<{ eventType: string }>).map((h) => h.eventType);
      assert.ok(types.includes("PC_FEE_PAYMENT_FAILED"), "payment activity still shown");
      assert.ok(!types.includes("PC_FEE_WRITTEN_OFF") && !types.includes("PC_FEE_WAIVED"), `no adjustment in receipt history: ${types.join(",")}`);
      assert.ok(!detail.raw.includes(rec!.recordNumber));
      const pdf = await fetch(`${w.baseUrl}/api/financial/receipts/${r.id}/pdf`, { headers: { cookie: w.X.admin.cookie } });
      assert.equal(pdf.status, 200);
      const bytes = Buffer.from(await pdf.arrayBuffer()).toString("latin1");
      assert.ok(!bytes.includes("PC_FEE_WRITTEN_OFF") && !bytes.includes("PC_FEE_WAIVED"), "no adjustment in the receipt PDF");
      assert.ok(!bytes.includes(REASON), "write-off reason not printed on a receipt");
    }
  });

  test("item 2: dispute resolution to WAIVED or WRITTEN_OFF produces the same formal records (via DISPUTE_RESOLUTION)", async () => {
    const dd = await activeDebitAuthority(w);
    const cw = await issued(dd.id, "AdjDisputeWaive");
    const cwo = await issued(dd.id, "AdjDisputeWO");
    await markDisputed(cw);
    await markDisputed(cwo);
    assert.equal((await resolveDispute(w.X.admin, cw, "WAIVED")).status, 200);
    assert.equal((await resolveDispute(w.X.admin, cwo, "WRITTEN_OFF")).status, 200);
    const [rw] = (await adjustments(w.X.admin, cw)).json.adjustments as AdjustmentRecord[];
    const [rwo] = (await adjustments(w.X.admin, cwo)).json.adjustments as AdjustmentRecord[];
    assert.equal(rw!.kind, "WAIVER");
    assert.equal(rw!.via, "DISPUTE_RESOLUTION");
    assert.equal(rwo!.kind, "WRITE_OFF");
    assert.equal(rwo!.via, "DISPUTE_RESOLUTION");
    for (const r of [rw!, rwo!]) {
      assert.equal(r.isReceipt, false);
      assert.equal(r.reason, REASON);
      assert.deepEqual(r.evidence.kind, "document");
      assert.equal(r.approval.mode, "SINGLE_BROKERAGE_ADMIN");
    }
  });

  test("item 2: reason, identity and timestamp are mandatory; replays and refusals create no second record; records are read-only", async () => {
    const dd = await activeDebitAuthority(w);
    const c = await issued(dd.id, "AdjImmutable");
    assert.equal((await waive(w.X.admin, c, { reason: "  ", evidenceNote: NOTE })).json.code, "RECOVERY_REASON_REQUIRED");
    assert.deepEqual((await adjustments(w.X.admin, c)).json.adjustments, [], "a refusal records no adjustment");
    assert.equal((await waive(w.X.admin, c)).status, 200);
    const first = (await adjustments(w.X.admin, c)).json.adjustments as AdjustmentRecord[];
    assert.equal((await waive(w.admin2, c)).json.idempotent, true);
    assert.deepEqual((await adjustments(w.X.admin, c)).json.adjustments, first, "a replay changes nothing and adds nothing");
    for (const method of ["PATCH", "PUT", "DELETE"]) {
      const r = await call(w.baseUrl, method, `/financial/payment-requests/${c.requestId}/adjustments`, w.X.admin.cookie, { reason: "edited" });
      assert.ok([404, 405].includes(r.status), `${method} -> ${r.status}`);
    }
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.recordId, String(c.requestId)), eq(auditLogs.action, "financial_pc_fee_waived")));
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.userId, w.X.admin.user.id);
    assert.ok(audits[0]!.createdAt instanceof Date);
    const v = JSON.parse(audits[0]!.updatedValue ?? "{}");
    assert.equal(v.adjustmentRecordNumber, first[0]!.recordNumber, "audit row names the adjustment record");
  });

  test("item 2: adjustment records are Brokerage Administrator reads, tenant-scoped", async () => {
    const dd = await activeDebitAuthority(w);
    const c = await issued(dd.id, "AdjAccess");
    assert.equal((await waive(w.X.admin, c)).status, 200);
    assert.equal((await adjustments(w.admin2, c)).status, 200);
    assert.equal((await adjustments(w.crew, c)).status, 403);
    assert.equal((await adjustments(w.X.agent, c)).status, 403);
    assert.equal((await adjustments(w.Y.admin, c)).status, 404);
  });

  test("immutability: no production code updates or deletes ledger events or audit rows", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = join(here, "..", "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) {
          if (n !== "__tests__" && n !== "node_modules") walk(p);
        } else if (n.endsWith(".ts")) {
          const s = readFileSync(p, "utf8");
          if (/\.(update|delete)\(\s*(financialLedgerEvents|auditLogs)\s*\)/.test(s)) offenders.push(p);
        }
      }
    };
    walk(src);
    assert.deepEqual(offenders, []);
  });
});
