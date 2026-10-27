// Owner t181u phase 2b item 6: Run financial screens (pure views + helpers).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  newRefundRequestKey,
  recoveryActionsFor,
  runFinancialCapabilities,
  statementActions,
  statementPrintModel,
  type CardCharge,
  type CardRefund,
  type ServiceFeeResponse,
  type SettlementStatement,
} from "../runFinancial";
import {
  AuthorityView,
  CardChargeRow,
  CardRefundRow,
  ReceiptsView,
  RecoveryActionsView,
  ServiceFeePanelView,
  StatementPrintView,
  StatementView,
  receiptPdfHref,
} from "../../pages/runFinancial/views";

const BA = runFinancialCapabilities("Brokerage Administrator");
const CREW = runFinancialCapabilities("Pit Crew");
const AGENT = runFinancialCapabilities("Agent");
const SELLER = runFinancialCapabilities("Seller");
const noop = () => {};

const recon = {
  status: "PARTIALLY_REFUNDED" as const,
  asOf: "2026-10-26T00:00:00.000Z",
  entries: [
    { kind: "PAYMENT" as const, effect: "CREDIT" as const, receiptId: 1, receiptNumber: "RCPT-000001", amountCents: 110000, issuedAt: "2026-10-20T00:00:00.000Z" },
    { kind: "REFUND" as const, effect: "DEBIT" as const, receiptId: 2, receiptNumber: "RCPT-000002", amountCents: 10000, issuedAt: "2026-10-21T00:00:00.000Z" },
  ],
  totals: { itemisedServiceFeeCents: 110000, paidCents: 110000, refundedCents: 10000, netCollectedCents: 100000, balanceCents: 10000 },
  issues: [{ code: "RECEIPT_LEDGER_MISMATCH", paymentRequestId: 9 }],
};
function stmt(over: Partial<SettlementStatement> = {}): SettlementStatement {
  return {
    id: 10, transactionId: 5, version: 1, status: "ISSUED", supersedesId: null, supersedeReason: null, payerType: "Agent", currency: "AUD",
    creditsCents: 500000, debitsCents: 110000, netCents: 390000, pcServiceFeeCents: 110000, preparedAt: "2026-10-19T00:00:00.000Z",
    issuedAt: "2026-10-19T01:00:00.000Z", supersededAt: null,
    lines: [{ id: 1, lineNo: 1, kind: "PC_SERVICE_FEE", effect: "DEBIT", description: "AE Pit Crew service fee", amountCents: 100000, gstCents: 10000 }],
    reconciliation: recon, ...over,
  };
}
const html = (el: unknown) => renderToStaticMarkup(el as never);

test("capabilities follow server roles; authority never editable in the UI", () => {
  assert.deepEqual([BA.supersedeStatement, CREW.supersedeStatement, AGENT.supersedeStatement], [true, false, false]);
  assert.deepEqual([BA.baQueues, CREW.baQueues, AGENT.baQueues], [true, false, false]);
  assert.deepEqual([BA.collectServiceFee, CREW.collectServiceFee, AGENT.collectServiceFee], [true, true, false]);
  for (const c of [BA, CREW, AGENT, SELLER]) assert.equal(c.editAuthority, false);
  assert.equal(SELLER.viewStatements, false);
});

test("statement actions: draft → issue; issued → BA-only correction; corrections need BA", () => {
  const draft = stmt({ status: "DRAFT", issuedAt: null, reconciliation: null });
  assert.deepEqual(statementActions(CREW, [draft]), { prepare: true, issue: true, supersede: false });
  assert.deepEqual(statementActions(CREW, [stmt()]), { prepare: false, issue: false, supersede: false });
  assert.deepEqual(statementActions(BA, [stmt()]), { prepare: false, issue: false, supersede: true });
  const correction = stmt({ id: 11, version: 2, status: "DRAFT", supersedesId: 10, issuedAt: null, reconciliation: null });
  assert.equal(statementActions(CREW, [stmt(), correction]).issue, false);
  assert.equal(statementActions(BA, [stmt(), correction]).issue, true);
});

test("statement view shows reconciliation; Pit Crew sees no correction control", () => {
  const crew = html(createElement(StatementView, { caps: CREW, statements: [stmt()], confirmations: [], onPrepare: noop, onIssue: noop, onRecordConfirmation: noop, onPrint: noop }));
  assert.match(crew, /statement-reconciliation/);
  assert.match(crew, /RCPT-000002/);
  assert.match(crew, /Print \/ save as PDF/);
  assert.doesNotMatch(crew, /Prepare correction/);
  assert.match(crew, /Only a Brokerage Administrator can correct/);
  const ba = html(createElement(StatementView, { caps: BA, statements: [stmt()], confirmations: [], onPrepare: noop, onIssue: noop, onRecordConfirmation: noop, onPrint: noop }));
  assert.match(ba, /Prepare correction/);
  const none = html(createElement(StatementView, { caps: SELLER, statements: [stmt()], confirmations: [], onPrepare: noop, onIssue: noop, onRecordConfirmation: noop, onPrint: noop }));
  assert.equal(none, "");
});

test("print model and print view include the reconciliation section", () => {
  const m = statementPrintModel(stmt());
  assert.ok(m.reconciliation);
  assert.equal(m.reconciliation!.entries.length, 2);
  const out = html(createElement(StatementPrintView, { statement: stmt() }));
  assert.match(out, /Payments and refunds/);
  assert.match(out, /RCPT-000001/);
  assert.match(out, /Review:/);
  assert.equal(statementPrintModel(stmt({ status: "DRAFT", reconciliation: null })).reconciliation, null);
});

const fee: ServiceFeeResponse = {
  serviceFee: {
    transactionId: 5, paymentRequestId: 9, status: "NOTICE_SENT", currency: "AUD", grossFeeCents: 100000, gstCents: 10000, totalFeeCents: 110000, capCents: null,
    noticeSentAt: null, noticeElapsesAt: "2026-10-30T00:00:00.000Z", scheduledAt: null, paidAt: null, paymentMethod: { type: "STORED_CARD", label: "Visa ending 4242" },
    collectionTiming: { rule: "NOTICE_PERIOD", noticeReason: "TERMS_UNVERSIONED" },
    authority: {
      id: 3, version: 2, status: "ACTIVE", payerType: "Agent", authorisedPaymentMethod: "STORED_CARD", feeBasis: "PERCENT_OF_GCI", rateBps: 150, fixedAmountCents: null,
      gstApplicable: true, maximumAmountCents: 500000, noticeRequiredDays: 7, agreementTermsVersion: null, mandateTermsVersion: null, effectiveDate: null, expiresAt: null,
      hasSignedEvidence: true, brokerageCardApproved: false,
    },
  },
  collectable: false,
  settlementStatement: { issued: false, code: "SETTLEMENT_STATEMENT_NOT_ISSUED" },
};

test("service fee panel: timing, gate, collect by role, read-only authority", () => {
  const crew = html(createElement(ServiceFeePanelView, { caps: CREW, data: fee, onCollect: noop }));
  assert.match(crew, /Collect service fee/);
  assert.match(crew, /disabled/);
  assert.match(crew, /authority-view/);
  assert.match(crew, /Read only/);
  assert.match(crew, /Mock payment provider only/);
  assert.doesNotMatch(crew, /Revoke|Activate|Edit authority/i);
  assert.equal(html(createElement(ServiceFeePanelView, { caps: AGENT, data: fee, onCollect: noop })), "");
  assert.match(html(createElement(AuthorityView, { authority: undefined })), /No payment authority/);
});

test("receipts list links each receipt PDF", () => {
  const out = html(createElement(ReceiptsView, {
    receipts: [{ id: 7, receiptNumber: "RCPT-000007", kind: "PAYMENT_RECEIVED", statusSnapshot: "PAID", amountCents: 110000, gstCents: 10000, currency: "AUD", paymentMethodType: "STORED_CARD", paymentMethodLabel: null, payerType: "Agent", failureMessage: null, retryScheduled: false, issuedAt: "2026-10-20T00:00:00.000Z" }],
  }));
  assert.equal(receiptPdfHref(7), "/api/financial/receipts/7/pdf");
  assert.match(out, /href="\/api\/financial\/receipts\/7\/pdf"/);
  assert.match(html(createElement(ReceiptsView, { receipts: [] })), /No receipts yet/);
});

test("BA queues: resolve needs provider status; refunds offered on succeeded charges", () => {
  const charge: CardCharge = { id: 4, paymentRequestId: 9, attemptNo: 1, status: "UNKNOWN", amountCents: 110000, currency: "AUD", payerType: "Agent", trigger: "MANUAL", createdAt: "2026-10-20T00:00:00.000Z" };
  const before = html(createElement(CardChargeRow, { charge, onCheckStatus: noop, onResolve: noop, onRefund: noop }));
  assert.match(before, /Check provider status/);
  assert.equal((before.match(/disabled=""/g) ?? []).length, 2);
  const self = html(createElement(CardChargeRow, { charge, status: { providerStatus: "Succeeded", suggestedOutcome: "SUCCEEDED", callerMayResolve: false }, onCheckStatus: noop, onResolve: noop, onRefund: noop }));
  assert.match(self, /another Brokerage Administrator must resolve/);
  const ok = html(createElement(CardChargeRow, { charge: { ...charge, status: "SUCCEEDED" }, onCheckStatus: noop, onResolve: noop, onRefund: noop }));
  assert.match(ok, /original card only/);
  const refund: CardRefund = { id: 2, paymentRequestId: 9, cardChargeId: 4, amountCents: 5000, currency: "AUD", status: "UNKNOWN", requestedByUserId: 1, failureMessage: null, createdAt: "2026-10-21T00:00:00.000Z", completedAt: null };
  const r = html(createElement(CardRefundRow, { refund, status: { providerStatus: "Pending", suggestedOutcome: null, callerMayResolve: true }, onCheckStatus: noop, onResolve: noop }));
  assert.match(r, /amount stays reserved/);
  assert.match(newRefundRequestKey(1, () => 0.5), /^ui-[0-9a-z]+-[0-9a-z]+$/);
  assert.ok(/^[A-Za-z0-9_.:-]{8,100}$/.test(newRefundRequestKey()));
});

test("recovery actions by payment request status", () => {
  assert.deepEqual(recoveryActionsFor("DISPUTED"), { waive: false, writeOff: false, resolveDispute: true });
  assert.deepEqual(recoveryActionsFor("FAILED"), { waive: true, writeOff: true, resolveDispute: false });
  assert.deepEqual(recoveryActionsFor("PAID"), { waive: false, writeOff: false, resolveDispute: false });
  assert.equal(html(createElement(RecoveryActionsView, { paymentRequestId: 9, status: "PAID", onAction: noop })), "");
  assert.match(html(createElement(RecoveryActionsView, { paymentRequestId: 9, status: "DISPUTED", onAction: noop })), /Resolve dispute/);
});

test("G19: a PENDING card refund offers status check; resolve stays disabled until the server says it is stalled and resolvable", () => {
  const refund: CardRefund = { id: 3, paymentRequestId: 9, cardChargeId: 4, amountCents: 5000, currency: "AUD", status: "PENDING", requestedByUserId: 1, failureMessage: null, createdAt: "2026-10-21T00:00:00.000Z", completedAt: null };
  const none = html(createElement(CardRefundRow, { refund, onCheckStatus: noop, onResolve: noop }));
  assert.match(none, /Check provider status/);
  const fresh = html(createElement(CardRefundRow, { refund, status: { providerStatus: null, suggestedOutcome: null, callerMayResolve: true, resolvable: false, stalePending: false }, onCheckStatus: noop, onResolve: noop }));
  assert.match(fresh, /may still be in progress/);
  assert.equal((fresh.match(/<button[^>]*disabled=""[^>]*>Resolve as/g) ?? []).length, 2, "both resolve buttons disabled while in flight");
  const stale = html(createElement(CardRefundRow, { refund, status: { providerStatus: "NotFound", suggestedOutcome: "FAILED", callerMayResolve: true, resolvable: true, stalePending: true }, onCheckStatus: noop, onResolve: noop }));
  assert.match(stale, /Stalled in pending/);
  assert.match(stale, /resolve as FAILED/);
  const done = html(createElement(CardRefundRow, { refund: { ...refund, status: "SUCCEEDED" }, onCheckStatus: noop, onResolve: noop }));
  assert.doesNotMatch(done, /Check provider status/);
});
