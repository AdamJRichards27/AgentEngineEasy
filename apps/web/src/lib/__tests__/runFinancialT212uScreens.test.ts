// #245 Owner t212u screens (existing Brokerage Administrator role gate only): audited correction of
// locked financial records (reason + evidence required) and reconciliation exceptions (Paid after a
// waiver/write-off; unconfirmed provider cancellation) with a refund-assessment resolve. Pure views.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { correctionBody, reconResolveBody, runFinancialCapabilities, type CorrectionRecord, type ReconciliationException } from "../runFinancial";
import { CorrectionsView, ReconciliationExceptionsView } from "../../pages/runFinancial/views";

const html = (el: unknown) => renderToStaticMarkup(el as never);
const noop = () => {};

test("capabilities: corrections and reconciliation exceptions are Brokerage-Admin only", () => {
  assert.equal(runFinancialCapabilities("Brokerage Administrator").corrections, true);
  assert.equal(runFinancialCapabilities("Brokerage Administrator").reconciliationExceptions, true);
  for (const role of ["Pit Crew", "Agent", "Seller", null]) {
    assert.equal(runFinancialCapabilities(role).corrections, false, String(role));
    assert.equal(runFinancialCapabilities(role).reconciliationExceptions, false, String(role));
  }
});

test("correctionBody requires a record, a column, a reason and evidence (reference or upload metadata)", () => {
  const ok = { table: "financial_ledger_events", id: "12", column: "reason", value: "Fixed", reason: "Typo in reason", evidenceRef: "SYN-1", upload: null };
  assert.deepEqual(correctionBody(ok), { table: "financial_ledger_events", id: 12, patch: { reason: "Fixed" }, reason: "Typo in reason", evidenceRef: "SYN-1" });
  assert.equal(correctionBody({ ...ok, reason: " " }), null);
  assert.equal(correctionBody({ ...ok, evidenceRef: "" }), null);
  assert.equal(correctionBody({ ...ok, id: "x" }), null);
  assert.equal(correctionBody({ ...ok, column: "" }), null);
  const up = correctionBody({ ...ok, evidenceRef: "", upload: { fileName: "letter.pdf", sha256: "b".repeat(64), sizeBytes: 10 } });
  assert.deepEqual(up?.evidenceUpload, { fileName: "letter.pdf", sha256: "b".repeat(64), sizeBytes: 10 });
});

test("reconResolveBody requires a refund assessment and a reason", () => {
  assert.deepEqual(reconResolveBody("REFUND_REQUIRED", " checked "), { refundAssessment: "REFUND_REQUIRED", reason: "checked" });
  assert.equal(reconResolveBody("", "checked"), null);
  assert.equal(reconResolveBody("REFUND_REQUIRED", ""), null);
});

const exceptions: ReconciliationException[] = [
  { id: 3, paymentRequestId: 9, kind: "PAID_AFTER_WAIVER", source: "WEBHOOK", amountCents: 121440, status: "OPEN", refundAssessment: null, resolutionReason: null, createdAt: "2026-10-31T00:00:00.000Z", resolvedAt: null },
  { id: 4, paymentRequestId: 10, kind: "CANCELLATION_UNCONFIRMED", source: "RECOVERY", amountCents: 121440, status: "OPEN", refundAssessment: null, resolutionReason: null, createdAt: "2026-10-31T00:00:00.000Z", resolvedAt: null },
  { id: 5, paymentRequestId: 11, kind: "PAID_AFTER_WRITE_OFF", source: "RECONCILIATION", amountCents: 5000, status: "RESOLVED", refundAssessment: "NO_REFUND_REQUIRED", resolutionReason: "Agent asked to keep", createdAt: "2026-10-31T00:00:00.000Z", resolvedAt: "2026-10-31T01:00:00.000Z" },
];

test("ReconciliationExceptionsView labels each kind, says nothing was changed, offers resolve only on OPEN rows", () => {
  const out = html(createElement(ReconciliationExceptionsView, { exceptions, busy: false, onResolve: noop }));
  assert.match(out, /Paid after waiver/);
  assert.match(out, /Paid after write-off/);
  assert.match(out, /Provider cancellation not confirmed/);
  assert.match(out, /locked records were not changed/i);
  assert.match(out, /Refund assessment/);
  assert.equal((out.match(/>Resolve</g) ?? []).length, 2);
  assert.match(out, /No refund required/);
  assert.match(html(createElement(ReconciliationExceptionsView, { exceptions: [], busy: false, onResolve: noop })), /No reconciliation exceptions/);
});

const corrections: CorrectionRecord[] = [
  { auditId: 77, table: "financial_ledger_events", recordId: "12", correctedByUserId: 1, correctedAt: "2026-10-31T00:00:00.000Z", before: { reason: "old" }, patch: { reason: "new" }, reason: "Typo", evidence: { kind: "reference", ref: "SYN-1" } },
];
test("CorrectionsView shows the audit trail and a form that needs reason + evidence", () => {
  const out = html(createElement(CorrectionsView, { corrections, busy: false, onSubmit: noop }));
  assert.match(out, /Correct a locked financial record/);
  assert.match(out, /Audit #77/);
  assert.match(out, /SYN-1/);
  assert.match(out, /Reason \(required\)/);
  assert.match(out, /Evidence reference/);
  assert.match(out, /sha256/);
});
