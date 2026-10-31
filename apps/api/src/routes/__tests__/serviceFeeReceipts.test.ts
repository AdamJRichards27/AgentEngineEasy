// Owner t180u(2) (slice 5): in-app + PDF receipts for success, failure
// (controlled retry, no double debit), refund and reconciliation; no card or
// mandate data; readable only by BA, listing agent and assigned Pit Crew.
// Synthetic data only.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, financialPaymentOutbox, financialReceipts, financialReconciliations } from "@aee/db";
import { processMandatePaymentWebhook } from "../../lib/financial/paymentWebhooks.js";
import { reverseDebit } from "../../lib/financial/paymentOutbox.js";
import { syncReceiptsForPaymentRequest } from "../../lib/financial/receipts.js";
import { cleanupBrokerages } from "./testSupport.js";
import { activeDebitAuthority, call, collect, confirmBoth, elapseNotice, feeChain, makeWorld, MANDATE_REF_PREFIX, prepareAndIssue, request, type Chain, type World } from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.MANDATE_PAYMENT_WEBHOOK_SECRET = "test-only-mandate-payment-webhook-secret";
process.env.MANDATE_PAYMENT_WEBHOOKS_ENABLED = "true";

let server: Server;
let w: World;
let authorityId: number;
let evt = 0;
async function webhook(c: Chain, status: "Paid" | "Failed", failureReason?: string) {
  const r = await request(c.requestId);
  const payload: Record<string, unknown> = { providerEventId: `evt-${w.suffix}-${++evt}`, providerRequestRef: r.providerRequestRef, status, ...(failureReason ? { failureReason } : {}) };
  const raw = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const sig = `t=${ts},v1=${createHmac("sha256", process.env.MANDATE_PAYMENT_WEBHOOK_SECRET!).update(`${ts}.${raw}`).digest("hex")}`;
  return processMandatePaymentWebhook(raw, sig, payload);
}
async function scheduled(tag: string): Promise<Chain> {
  const c = await feeChain(w, authorityId, tag);
  await confirmBoth(w, c);
  await prepareAndIssue(w, w.crew, c);
  await elapseNotice(c);
  const r = await collect(w, w.crew, c);
  assert.ok(r.status === 200 || r.status === 202, r.raw);
  assert.ok((await request(c.requestId)).providerRequestRef, "debit dispatched to the sandbox provider");
  return c;
}
const receipts = async (c: Chain) => db.select().from(financialReceipts).where(eq(financialReceipts.paymentRequestId, c.requestId)).orderBy(financialReceipts.id);

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "Receipts");
  authorityId = (await activeDebitAuthority(w)).id;
});

after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t180u slice 5: receipts", { concurrency: false }, () => {
  test("success: one payment receipt (deduplicated on webhook replay and re-sync), in-app + PDF, audited, no mandate data", async () => {
    const c = await scheduled("Paid");
    assert.equal((await receipts(c)).length, 0, "no receipt before payment");
    assert.equal((await webhook(c, "Paid")).processed, true);
    await syncReceiptsForPaymentRequest(c.requestId);
    await syncReceiptsForPaymentRequest(c.requestId);
    const rows = await receipts(c);
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(r.kind, "PAYMENT_SUCCEEDED");
    assert.equal(r.amountCents, c.amountCents);
    assert.ok(r.settlementStatementId, "linked to the issued statement");
    assert.equal(r.paymentMethodType, "GENERAL_ACCOUNT_DEBIT_MANDATE");
    assert.ok(r.providerReference, "payment reference recorded");
    assert.ok(!JSON.stringify(r).includes(MANDATE_REF_PREFIX), "no mandate reference on the receipt");
    const list = await call(w.baseUrl, "GET", `/financial/receipts?transactionId=${c.transactionId}`, w.crew.cookie);
    assert.equal(list.status, 200, list.raw);
    assert.equal(list.json.receipts.length, 1);
    const one = await call(w.baseUrl, "GET", `/financial/receipts/${r.id}`, w.X.agent.cookie);
    assert.equal(one.status, 200);
    assert.ok(one.json.history.some((h: { eventType: string }) => h.eventType === "PC_FEE_PAID"), "audit history included");
    const pdf = await fetch(`${w.baseUrl}/api/financial/receipts/${r.id}/pdf`, { headers: { cookie: w.X.admin.cookie } });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    const bytes = Buffer.from(await pdf.arrayBuffer()).toString("latin1");
    assert.ok(bytes.startsWith("%PDF-1.4") && bytes.trimEnd().endsWith("%%EOF"));
    assert.ok(bytes.includes(r.receiptNumber));
    assert.ok(!bytes.includes(MANDATE_REF_PREFIX));
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.recordType, "financial_receipt"), eq(auditLogs.recordId, String(r.id))));
    assert.deepEqual(audits.map((a) => a.action).sort(), ["financial_receipt_downloaded", "financial_receipt_issued"]);
  });

  test("failure: each failed attempt gets a failure notice (retry scheduled, then final), sanitised; retries never add a second debit", async () => {
    const c = await scheduled("Failed");
    await webhook(c, "Failed", "Insufficient funds on account 062000 12345678");
    assert.equal((await request(c.requestId)).status, "RETRY_SCHEDULED");
    let rows = await receipts(c);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "PAYMENT_FAILED");
    assert.equal(rows[0]!.retryScheduled, true);
    assert.ok(!rows[0]!.failureMessage!.includes("12345678"), "long digit runs are redacted");
    // Manual collect while a retry is pending is a no-op (no second debit row).
    const again = await collect(w, w.crew, c);
    assert.equal(again.json.outcome, "already_in_progress", again.raw);
    const debits = await db.select().from(financialPaymentOutbox).where(and(eq(financialPaymentOutbox.paymentRequestId, c.requestId), eq(financialPaymentOutbox.action, "SCHEDULE_DEBIT")));
    assert.equal(debits.length, 1);
    await webhook(c, "Failed", "Declined");
    await webhook(c, "Failed", "Declined");
    assert.equal((await request(c.requestId)).status, "FAILED");
    rows = await receipts(c);
    assert.equal(rows.filter((x) => x.kind === "PAYMENT_FAILED").length, 3);
    assert.equal(rows.at(-1)!.retryScheduled, false);
    // Recovery is BA-only: Pit Crew cannot restart a FAILED fee.
    assert.equal((await collect(w, w.crew, c)).json.code, "SERVICE_FEE_NOT_COLLECTABLE");
    const pdf = await fetch(`${w.baseUrl}/api/financial/receipts/${rows.at(-1)!.id}/pdf`, { headers: { cookie: w.crew.cookie } });
    assert.ok(Buffer.from(await pdf.arrayBuffer()).toString("latin1").includes("No automatic retry"));
  });

  test("refund (reversal) and reconciliation receipts", async () => {
    const c = await scheduled("Refund");
    await webhook(c, "Paid");
    await reverseDebit({ paymentRequestId: c.requestId, reason: "Agreed refund (synthetic)", actorUserId: w.X.admin.user.id });
    await db.insert(financialReconciliations).values({
      brokerageId: w.X.brokerageId,
      recordType: "financial_payment_request",
      recordId: String(c.requestId),
      expectedAmountCents: c.amountCents,
      reportedAmountCents: c.amountCents,
      evidenceAmountCents: c.amountCents,
      differenceCents: 0,
      status: "PARTIALLY_RECONCILED",
      source: "test",
      externalReference: `recon-${w.suffix}`,
    } as never);
    const list = await call(w.baseUrl, "GET", `/financial/receipts?transactionId=${c.transactionId}`, w.X.admin.cookie);
    assert.deepEqual(list.json.receipts.map((r: { kind: string }) => r.kind).sort(), ["PAYMENT_SUCCEEDED", "RECONCILIATION", "REFUND"]);
  });

  test("receipts are immutable and private: update refused by trigger; other agents, unassigned Pit Crew and other brokerages get 404", async () => {
    const c = await scheduled("Private");
    await webhook(c, "Paid");
    const [r] = await syncReceiptsForPaymentRequest(c.requestId);
    await assert.rejects(db.update(financialReceipts).set({ amountCents: 1 }).where(eq(financialReceipts.id, r!.id)), (e: unknown) => {
      const err = e as { message?: string; cause?: { message?: string } };
      assert.match(`${err.message} ${err.cause?.message ?? ""}`, /immutable/);
      return true;
    });
    for (const who of [w.otherAgent, w.crewUnassigned, w.Y.admin]) {
      assert.equal((await call(w.baseUrl, "GET", `/financial/receipts/${r!.id}`, who.cookie)).status, 404);
      assert.equal((await call(w.baseUrl, "GET", `/financial/receipts/${r!.id}/pdf`, who.cookie)).status, 404);
      assert.equal((await call(w.baseUrl, "GET", `/financial/receipts?transactionId=${c.transactionId}`, who.cookie)).status, 404);
    }
  });
});
