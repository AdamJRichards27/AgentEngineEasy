// Owner t212u item 3: a provider "Paid" after a waiver or write-off creates a reconciliation
// exception for Brokerage Administrator review (with refund assessment). The provider event is
// persisted, never discarded; the locked request/ledger/receipts are not mutated.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, financialLedgerEvents, financialPaymentProviderEvents, financialReceipts, financialReconciliationExceptions } from "@aee/db";
import { cleanupBrokerages } from "./testSupport.js";
import { call, request, type World } from "./serviceFeeStatementFixtures.js";
import { finallyFailedDd, REASON, reconcile, sandbox, startWorld, webhook } from "./t212uCommon.js";

let server: Server;
let w: World;
const body = { reason: REASON, evidenceNote: "Synthetic evidence note" };
const exceptionsFor = (requestId: number) => db.select().from(financialReconciliationExceptions).where(eq(financialReconciliationExceptions.paymentRequestId, requestId));
const paidLedger = async (requestId: number) =>
  (await db.select().from(financialLedgerEvents).where(and(eq(financialLedgerEvents.sourceRecordId, String(requestId)), eq(financialLedgerEvents.eventType, "PC_FEE_PAID")))).length;
const receiptsFor = (requestId: number) => db.select().from(financialReceipts).where(eq(financialReceipts.paymentRequestId, requestId));

before(async () => ({ server, w } = await startWorld("T212uPaid")));
after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

let waivedRequestId = 0;
describe("t212u item 3: Paid after waiver / write-off -> reconciliation exception", { concurrency: false }, () => {
  test("webhook Paid after a waiver: event persisted, exception OPEN with the amount, request stays WAIVED, no PAID ledger/receipt", async () => {
    const s = await finallyFailedDd(w, "PaidAfterWaive");
    waivedRequestId = s.c.requestId;
    assert.equal((await call(w.baseUrl, "POST", `/financial/payment-requests/${s.c.requestId}/waive`, w.X.admin.cookie, body)).status, 200);
    const receiptsBefore = (await receiptsFor(s.c.requestId)).length;
    const { result, providerEventId } = await webhook(s.ref, "Paid");
    assert.equal(result.processed, true, JSON.stringify(result));
    const [evt] = await db.select().from(financialPaymentProviderEvents).where(eq(financialPaymentProviderEvents.providerEventId, providerEventId));
    assert.ok(evt, "provider event persisted");
    assert.equal(evt!.paymentRequestId, s.c.requestId);
    assert.equal(evt!.processingStatus, "EXCEPTION");
    const ex = await exceptionsFor(s.c.requestId);
    assert.equal(ex.length, 1);
    assert.equal(ex[0]!.kind, "PAID_AFTER_WAIVER");
    assert.equal(ex[0]!.status, "OPEN");
    assert.equal(ex[0]!.source, "WEBHOOK");
    assert.equal(ex[0]!.providerEventRowId, evt!.id);
    assert.equal(ex[0]!.amountCents, s.c.amountCents);
    const r = await request(s.c.requestId);
    assert.equal(r.status, "WAIVED");
    assert.equal(r.paidAt, null);
    assert.equal(await paidLedger(s.c.requestId), 0);
    assert.equal((await receiptsFor(s.c.requestId)).length, receiptsBefore);
    // A repeated notice is also persisted, but does not open a second exception.
    const again = await webhook(s.ref, "Paid");
    assert.equal(again.result.processed, true);
    assert.ok((await db.select().from(financialPaymentProviderEvents).where(eq(financialPaymentProviderEvents.providerEventId, again.providerEventId))).length === 1);
    assert.equal((await exceptionsFor(s.c.requestId)).length, 1);
  });

  test("reconciliation reporting Paid after a write-off opens one exception (idempotent) and mutates nothing", async () => {
    const s = await finallyFailedDd(w, "PaidAfterWo");
    assert.equal((await call(w.baseUrl, "POST", `/financial/payment-requests/${s.c.requestId}/write-off`, w.X.admin.cookie, body)).status, 200);
    sandbox().simulateDebitStatus(s.ref, { status: "Paid", attempt: 4 });
    await reconcile(w);
    await reconcile(w);
    const ex = await exceptionsFor(s.c.requestId);
    assert.equal(ex.length, 1);
    assert.equal(ex[0]!.kind, "PAID_AFTER_WRITE_OFF");
    assert.equal(ex[0]!.source, "RECONCILIATION");
    assert.equal((await request(s.c.requestId)).status, "WRITTEN_OFF");
    assert.equal(await paidLedger(s.c.requestId), 0);
  });

  test("BA list and resolve with a refund assessment; Pit Crew 403; other brokerage 404; resolve once", async () => {
    const [ex] = await exceptionsFor(waivedRequestId);
    const list = await call(w.baseUrl, "GET", "/financial/reconciliation-exceptions?status=OPEN", w.X.admin.cookie);
    assert.equal(list.status, 200, list.raw);
    assert.ok(list.json.exceptions.some((e: { id: number }) => e.id === ex!.id));
    assert.equal((await call(w.baseUrl, "GET", "/financial/reconciliation-exceptions", w.crew.cookie)).status, 403);
    const ylist = await call(w.baseUrl, "GET", "/financial/reconciliation-exceptions", w.Y.admin.cookie);
    assert.ok(!ylist.json.exceptions.some((e: { id: number }) => e.id === ex!.id));
    const resolve = (cookie: string, b: Record<string, unknown>) => call(w.baseUrl, "POST", `/financial/reconciliation-exceptions/${ex!.id}/resolve`, cookie, b);
    assert.equal((await resolve(w.crew.cookie, { refundAssessment: "REFUND_REQUIRED", reason: REASON })).status, 403);
    assert.equal((await resolve(w.Y.admin.cookie, { refundAssessment: "REFUND_REQUIRED", reason: REASON })).status, 404);
    const noA = await resolve(w.X.admin.cookie, { reason: REASON });
    assert.equal(noA.status, 400);
    assert.equal(noA.json.code, "RECON_ASSESSMENT_REQUIRED");
    const noR = await resolve(w.X.admin.cookie, { refundAssessment: "REFUND_REQUIRED", reason: "" });
    assert.equal(noR.status, 400);
    assert.equal(noR.json.code, "RECON_REASON_REQUIRED");
    const ok = await resolve(w.X.admin.cookie, { refundAssessment: "REFUND_REQUIRED", reason: REASON });
    assert.equal(ok.status, 200, ok.raw);
    const [after] = await db.select().from(financialReconciliationExceptions).where(eq(financialReconciliationExceptions.id, ex!.id));
    assert.equal(after!.status, "RESOLVED");
    assert.equal(after!.refundAssessment, "REFUND_REQUIRED");
    assert.equal(after!.resolvedByUserId, w.X.admin.user.id);
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "reconciliation_exception_resolved"), eq(auditLogs.recordId, String(ex!.id))));
    assert.equal(audits.length, 1);
    const twice = await resolve(w.X.admin.cookie, { refundAssessment: "NO_REFUND_REQUIRED", reason: REASON });
    assert.equal(twice.status, 409);
    assert.equal(twice.json.code, "RECON_EXCEPTION_NOT_OPEN");
    assert.equal((await request(waivedRequestId)).status, "WAIVED", "resolution records the assessment; it never edits the locked request");
  });
});
