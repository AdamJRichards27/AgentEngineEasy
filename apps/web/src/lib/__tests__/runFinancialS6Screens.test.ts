// #245 S6: in-app screens for S1-S5 behind the existing gates only (role
// capabilities + the server's run.access entitlement): waivers/write-offs
// (adjustment records), retries, held debits with resolve, authority
// versions, receipt statement links. Pure views; mock states; nothing sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { heldResolveBody, runFinancialCapabilities, type AdjustmentRecord, type HeldDebit, type Receipt } from "../runFinancial";
import { AdjustmentRecordsView, AuthorityView, HeldDebitsView, ReceiptsView, RetryStatusView } from "../../pages/runFinancial/views";

const html = (el: unknown) => renderToStaticMarkup(el as never);
const noop = () => {};

const receipt: Receipt = {
  id: 7,
  receiptNumber: "AER-1-ABC",
  kind: "PAYMENT_SUCCEEDED",
  statusSnapshot: "PAID",
  amountCents: 121440,
  gstCents: 11040,
  currency: "AUD",
  paymentMethodType: "STORED_CARD",
  paymentMethodLabel: "Visa ending 4242",
  payerType: "Agent",
  failureMessage: null,
  retryScheduled: false,
  issuedAt: "2026-10-30T00:00:00.000Z",
  settlementStatement: { id: 12, version: 2, status: "ISSUED" },
};

test("capabilities: held debits and adjustment records are Brokerage-Admin only (existing role gate, no new flag)", () => {
  assert.equal(runFinancialCapabilities("Brokerage Administrator").heldDebits, true);
  assert.equal(runFinancialCapabilities("Brokerage Administrator").adjustmentRecords, true);
  for (const role of ["Pit Crew", "Agent", "Seller", null]) {
    const c = runFinancialCapabilities(role);
    assert.equal(c.heldDebits, false, String(role));
    assert.equal(c.adjustmentRecords, false, String(role));
  }
});

test("receipts show the issued statement id and version", () => {
  const out = html(createElement(ReceiptsView, { receipts: [receipt] }));
  assert.match(out, /Statement #12 v2/);
  const none = html(createElement(ReceiptsView, { receipts: [{ ...receipt, settlementStatement: null }] }));
  assert.doesNotMatch(none, /Statement #/);
});

test("retry status: attempt n of max with the next attempt time (AEST); nothing when no retry", () => {
  const out = html(createElement(RetryStatusView, { retry: { attempts: 1, maxAttempts: 3, nextAttemptAt: "2026-10-30T00:30:00.000Z" } }));
  assert.match(out, /Attempt 1 of 3/);
  assert.match(out, /AEST/);
  assert.match(out, /10:30/);
  assert.equal(html(createElement(RetryStatusView, { retry: null })), "");
});

test("authority versions: effective date, terms versions and a replaced authority is labelled read-only history", () => {
  const a = {
    id: 3,
    version: 2,
    status: "REPLACED",
    payerType: "Agent" as const,
    authorisedPaymentMethod: "STORED_CARD" as const,
    feeBasis: "PERCENTAGE_OF_GCI",
    rateBps: 690,
    fixedAmountCents: null,
    gstApplicable: true,
    maximumAmountCents: null,
    noticeRequiredDays: 7,
    agreementTermsVersion: "AE-PCF-AGREEMENT-2026.11",
    mandateTermsVersion: "AE-PCF-MANDATE-2026.11",
    effectiveDate: "2026-10-01T00:00:00.000Z",
    expiresAt: null,
    hasSignedEvidence: true,
    brokerageCardApproved: false,
  };
  const out = html(createElement(AuthorityView, { authority: a }));
  assert.match(out, /Effective/);
  assert.match(out, /1 Oct 2026/);
  assert.match(out, /Replaced by a newer version/);
  assert.match(out, /AE-PCF-AGREEMENT-2026\.11/);
});

test("adjustment records (waivers, write-offs): record number, kind, amount, statement id + version; marked not a receipt", () => {
  const recs: AdjustmentRecord[] = [
    { recordNumber: "ADJ-WO-00000042", kind: "WRITE_OFF", amountCents: 121440, gstCents: 11040, currency: "AUD", reason: "Synthetic", settlementStatementId: 12, settlementStatementVersion: 2, approval: { approvedAt: "2026-10-30T00:00:00.000Z", approvedByRole: "Brokerage Administrator" } },
  ];
  const out = html(createElement(AdjustmentRecordsView, { records: recs }));
  assert.match(out, /ADJ-WO-00000042/);
  assert.match(out, /Write-off/);
  assert.match(out, /Statement #12 v2/);
  assert.match(out, /not a receipt/i);
  assert.match(html(createElement(AdjustmentRecordsView, { records: [] })), /No waivers or write-offs/);
});

test("held debits: listed with reason and a resolve form (Scheduled / Failed + mandatory reason); explains no resend", () => {
  const held: HeldDebit[] = [{ outboxEntryId: 9, paymentRequestId: 4, action: "SCHEDULE_DEBIT", attempts: 1, heldAt: "2026-10-30T00:00:00.000Z", reason: "network timeout" }];
  const out = html(createElement(HeldDebitsView, { held, onResolve: noop, busy: false }));
  assert.match(out, /network timeout/);
  assert.match(out, /Payment request #4/);
  assert.match(out, /value="SCHEDULED"/);
  assert.match(out, /value="FAILED"/);
  assert.match(out, /never resent/i);
  assert.match(html(createElement(HeldDebitsView, { held: [], onResolve: noop, busy: false })), /No held debits/);
});

test("held resolve body: trimmed reason required; only SCHEDULED or FAILED", () => {
  assert.deepEqual(heldResolveBody("FAILED", "  checked the provider  "), { outcome: "FAILED", reason: "checked the provider" });
  assert.equal(heldResolveBody("FAILED", "   "), null);
  assert.equal(heldResolveBody("PAID" as never, "x"), null);
});
