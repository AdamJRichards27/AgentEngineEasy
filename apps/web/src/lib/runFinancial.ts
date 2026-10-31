// Owner t181u phase 2b item 6: Run-owned in-app financial screens for the AE
// Pit Crew service fee (settlement statement, service fee panel, receipts,
// Brokerage Administrator queues, read-only payment authority).
//
// Pure view logic only (no fetches, no React): role capabilities that MIRROR
// the server's permissions, labels, and the print model for the statement.
// The capabilities only hide or disable controls; the API stays the authority
// (every action is re-checked server-side and a refusal is shown as returned).
// Mock/sandbox payment providers only; nothing here sends anything.

export const BA_ROLE = "Brokerage Administrator";
export const PIT_CREW_ROLE = "Pit Crew";
export const AGENT_ROLE = "Agent";

export interface RunFinancialCapabilities {
  /** View statements, confirmations, receipts (server: BA, Agent, Pit Crew; per-transaction access re-checked). */
  viewStatements: boolean;
  /** Prepare / issue a statement and record confirmations (server: BA, listing agent, assigned Pit Crew). */
  prepareStatement: boolean;
  /** Supersede an ISSUED statement (server: BA only, with a reason). */
  supersedeStatement: boolean;
  /** See the service fee panel (server: BA or assigned Pit Crew). */
  viewServiceFee: boolean;
  /** Ask to collect the service fee (server: BA or assigned Pit Crew; every gate re-checked). */
  collectServiceFee: boolean;
  /** Payment authority: always read-only on these screens. */
  editAuthority: false;
  /** BA-only queues and recovery: card charges/refunds, resolve, refund, waive/write-off, disputes. */
  baQueues: boolean;
  /** S6: held (uncertain-outcome) debits + resolve (server: BA only, resolver must not be the raiser). */
  heldDebits: boolean;
  /** S6: waiver / write-off adjustment records (server: BA only). */
  adjustmentRecords: boolean;
  corrections: boolean;
  reconciliationExceptions: boolean;
}

export function runFinancialCapabilities(role: string | null | undefined): RunFinancialCapabilities {
  const isBa = role === BA_ROLE;
  const isCrew = role === PIT_CREW_ROLE;
  const isAgent = role === AGENT_ROLE;
  return {
    viewStatements: isBa || isCrew || isAgent,
    prepareStatement: isBa || isCrew || isAgent,
    supersedeStatement: isBa,
    viewServiceFee: isBa || isCrew,
    collectServiceFee: isBa || isCrew,
    editAuthority: false,
    baQueues: isBa,
    heldDebits: isBa,
    adjustmentRecords: isBa,
    // Owner t212u: audited corrections and reconciliation exceptions (existing BA role gate).
    corrections: isBa,
    reconciliationExceptions: isBa,
  };
}

// ---------------------------------------------------------------------------
// API shapes (subset the screens read).
export interface StatementLine {
  id: number;
  lineNo: number;
  kind: string;
  effect: "CREDIT" | "DEBIT";
  description: string;
  amountCents: number;
  gstCents: number;
}
export interface ReconciliationEntry {
  kind: "PAYMENT" | "REFUND";
  effect: "CREDIT" | "DEBIT";
  receiptId: number;
  receiptNumber: string;
  amountCents: number;
  gstCents?: number;
  paymentMethodLabel?: string | null;
  issuedAt: string;
}
export interface StatementReconciliation {
  status: "UNPAID" | "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED" | "NEEDS_REVIEW";
  asOf: string;
  entries: ReconciliationEntry[];
  totals: { itemisedServiceFeeCents: number; paidCents: number; refundedCents: number; netCollectedCents: number; balanceCents: number };
  issues: Array<{ code: string; paymentRequestId: number }>;
}
export interface SettlementStatement {
  id: number;
  transactionId: number;
  version: number;
  status: "DRAFT" | "ISSUED" | "SUPERSEDED";
  supersedesId: number | null;
  supersedeReason: string | null;
  payerType: "Agent" | "Brokerage";
  currency: string;
  creditsCents: number;
  debitsCents: number;
  netCents: number;
  pcServiceFeeCents: number | null;
  preparedAt: string;
  issuedAt: string | null;
  supersededAt: string | null;
  lines: StatementLine[];
  reconciliation: StatementReconciliation | null;
}
export interface SettlementConfirmation {
  id: number;
  side: "BUYER" | "SELLER";
  status: "ACTIVE" | "SUPERSEDED";
  representativePartyId: number;
  evidenceDocumentId: number | null;
  evidenceNote: string | null;
  confirmedAt: string;
}
export interface AuthoritySummary {
  id: number;
  version: number;
  status: string;
  payerType: "Agent" | "Brokerage";
  authorisedPaymentMethod: "GENERAL_ACCOUNT_DEBIT_MANDATE" | "STORED_CARD";
  feeBasis: string;
  rateBps: number | null;
  fixedAmountCents: number | null;
  gstApplicable: boolean;
  maximumAmountCents: number | null;
  noticeRequiredDays: number;
  agreementTermsVersion: string | null;
  mandateTermsVersion: string | null;
  effectiveDate: string | null;
  expiresAt: string | null;
  hasSignedEvidence: boolean;
  brokerageCardApproved: boolean;
}
export interface ServiceFeeSummary {
  transactionId: number;
  paymentRequestId: number;
  status: string;
  currency: string;
  grossFeeCents: number;
  gstCents: number;
  totalFeeCents: number;
  capCents: number | null;
  noticeSentAt: string | null;
  noticeElapsesAt: string | null;
  scheduledAt: string | null;
  paidAt: string | null;
  /** S6: read-only retry state (null unless RETRY_SCHEDULED / FAILED). */
  retry?: RetryState | null;
  paymentMethod: { type: string; label?: string | null };
  collectionTiming: { rule: "IMMEDIATE_ON_STATEMENT_ISSUE" | "NOTICE_PERIOD"; noticeReason: string | null };
  authority?: AuthoritySummary;
}
export interface ServiceFeeResponse {
  serviceFee: ServiceFeeSummary;
  collectable: boolean;
  settlementStatement: { issued: true; statementId: number } | { issued: false; code: string };
}
export interface Receipt {
  id: number;
  receiptNumber: string;
  kind: string;
  statusSnapshot: string;
  amountCents: number;
  gstCents: number;
  currency: string;
  paymentMethodType: string;
  paymentMethodLabel: string | null;
  payerType: string;
  failureMessage: string | null;
  retryScheduled: boolean;
  issuedAt: string;
  /** S5: the issued statement this receipt belongs to (null when none). */
  settlementStatement?: { id: number; version: number; status: string } | null;
}
/** S6: retry state of a failed collection (server-computed; read only). */
export interface RetryState {
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
}
/** S6: a formal waiver / write-off record (not a receipt). Subset of the API shape. */
export interface AdjustmentRecord {
  recordNumber: string;
  kind: "WAIVER" | "WRITE_OFF";
  amountCents: number;
  gstCents: number;
  currency: string;
  reason: string;
  settlementStatementId: number | null;
  settlementStatementVersion: number | null;
  approval: { approvedAt: string; approvedByRole: string };
}
/** S6: a debit held after an uncertain provider outcome (never auto-resent). */
export interface HeldDebit {
  outboxEntryId: number;
  paymentRequestId: number;
  action: string;
  attempts: number;
  heldAt: string | null;
  reason: string;
}
export type HeldResolveOutcome = "SCHEDULED" | "FAILED";
/** Body for POST /financial/payment-outbox/:id/resolve-held; null when invalid (mirrors the server's strict schema). */
export function heldResolveBody(outcome: HeldResolveOutcome, reason: string): { outcome: HeldResolveOutcome; reason: string } | null {
  if (outcome !== "SCHEDULED" && outcome !== "FAILED") return null;
  const r = reason.trim();
  if (r.length < 1 || r.length > 2000) return null;
  return { outcome, reason: r };
}
export function formatAestTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Australia/Brisbane" })} AEST`;
}
export interface CardCharge {
  id: number;
  paymentRequestId: number;
  attemptNo: number;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
  amountCents: number;
  currency: string;
  payerType: string;
  trigger: string;
  initiatedByUserId?: number | null;
  createdAt: string;
}
export interface CardRefund {
  id: number;
  paymentRequestId: number;
  cardChargeId: number;
  amountCents: number;
  currency: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
  requestedByUserId: number;
  failureMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}
export interface ProviderStatus {
  providerStatus: string | null;
  suggestedOutcome: "SUCCEEDED" | "FAILED" | null;
  callerMayResolve: boolean;
  /** Card refunds only (G19, t525u): UNKNOWN or PENDING, resolvable by an independent BA to the provider's answer. */
  resolvable?: boolean;
}

// ---------------------------------------------------------------------------
// Labels.
const STATEMENT_STATUS: Record<string, string> = { DRAFT: "Draft", ISSUED: "Issued", SUPERSEDED: "Superseded" };
export const statementStatusLabel = (s: string) => STATEMENT_STATUS[s] ?? s;
export const statementStatusPill = (s: string) => (s === "ISSUED" ? "pill pill-success" : s === "DRAFT" ? "pill pill-warning" : "pill");

const RECON_STATUS: Record<string, string> = {
  UNPAID: "Not yet paid",
  PAID: "Paid in full",
  PARTIALLY_REFUNDED: "Partly refunded",
  REFUNDED: "Refunded",
  NEEDS_REVIEW: "Needs review",
};
export const reconciliationLabel = (s: string) => RECON_STATUS[s] ?? s;
export const reconciliationPill = (s: string) => (s === "NEEDS_REVIEW" ? "pill pill-danger" : s === "PAID" ? "pill pill-success" : "pill pill-warning");

const ISSUE_TEXT: Record<string, string> = {
  LEDGER_RECEIPT_MISMATCH: "Receipts and the ledger disagree",
  PAYMENT_AMOUNT_MISMATCH: "Amount paid differs from the itemised fee",
  UNLISTED_RECEIPT: "A receipt is not for a fee on this statement",
  OVER_REFUNDED: "Refunds exceed payments",
};
export const reconciliationIssueText = (code: string) => ISSUE_TEXT[code] ?? code;

export function timingText(t: ServiceFeeSummary["collectionTiming"] | undefined): string {
  if (!t) return "Unknown";
  if (t.rule === "IMMEDIATE_ON_STATEMENT_ISSUE") return "Collected when the final statement is issued (the signed agreement and mandate both allow it)";
  const why: Record<string, string> = {
    AGREEMENT_TERMS_UNVERSIONED: "the signed agreement predates versioned terms",
    AGREEMENT_TERMS_REQUIRE_NOTICE: "the signed agreement requires notice",
    MANDATE_TERMS_UNVERSIONED: "the mandate predates versioned terms",
    MANDATE_TERMS_REQUIRE_NOTICE: "the mandate requires notice",
    TERMS_ACCEPTANCE_UNEVIDENCED: "signed acceptance of the terms is not on record",
  };
  return `Notice period applies${t.noticeReason && why[t.noticeReason] ? ` (${why[t.noticeReason]})` : ""}`;
}

const GATE_TEXT: Record<string, string> = {
  SETTLEMENT_STATEMENT_NOT_ISSUED: "Waiting for the final settlement statement to be issued",
  SETTLEMENT_STATEMENT_PAYER_MISMATCH: "The issued statement is not addressed to the authorised payer",
  SETTLEMENT_STATEMENT_FEE_MISMATCH: "The issued statement does not itemise this fee",
  SETTLEMENT_CONFIRMATIONS_INCOMPLETE: "Both written settlement confirmations are needed",
  SETTLEMENT_STATEMENT_STALE: "The figures changed after issue; a Brokerage Administrator must correct the statement",
};
export const statementGateText = (code: string) => GATE_TEXT[code] ?? "Collection is on hold";

export const methodText = (m: string) => (m === "STORED_CARD" ? "Saved card" : m === "GENERAL_ACCOUNT_DEBIT_MANDATE" ? "Direct debit (signed mandate)" : m);

export function formatAud(cents: number | null | undefined, currency = "AUD"): string {
  if (cents == null) return "—";
  const v = (cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency === "AUD" ? "$" : `${currency} `}${v}`;
}
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Brisbane" });
}

/** Current = the ISSUED statement, else the DRAFT, else the newest. Versions newest first. */
export function statementVersions(statements: SettlementStatement[]): { current: SettlementStatement | null; draft: SettlementStatement | null; issued: SettlementStatement | null; versions: SettlementStatement[] } {
  const versions = [...statements].sort((a, b) => b.version - a.version);
  const issued = versions.find((s) => s.status === "ISSUED") ?? null;
  const draft = versions.find((s) => s.status === "DRAFT") ?? null;
  return { current: issued ?? draft ?? versions[0] ?? null, draft, issued, versions };
}

/** Which statement actions to offer (the server re-checks every one). */
export function statementActions(caps: RunFinancialCapabilities, statements: SettlementStatement[]) {
  const { draft, issued } = statementVersions(statements);
  const draftSupersedes = Boolean(draft?.supersedesId);
  return {
    prepare: caps.prepareStatement && !issued && (!draftSupersedes || caps.supersedeStatement),
    issue: Boolean(draft) && caps.prepareStatement && (!draftSupersedes || caps.supersedeStatement),
    supersede: Boolean(issued) && caps.supersedeStatement,
  };
}

export function activeConfirmations(rows: SettlementConfirmation[]) {
  const active = rows.filter((r) => r.status === "ACTIVE");
  return { buyer: active.find((r) => r.side === "BUYER") ?? null, seller: active.find((r) => r.side === "SELLER") ?? null };
}

/** A fresh idempotency key for one BA refund request (never reused for another amount). */
export function newRefundRequestKey(now = Date.now(), rand = Math.random): string {
  return `ui-${now.toString(36)}-${Math.floor(rand() * 1e12).toString(36)}`;
}

/** Print/PDF model: the issued statement plus its reconciliation section (G17). */
export function statementPrintModel(s: SettlementStatement) {
  const r = s.reconciliation;
  return {
    title: `Settlement statement v${s.version}`,
    status: statementStatusLabel(s.status),
    issuedOn: formatDay(s.issuedAt),
    lines: s.lines.map((l) => ({ no: l.lineNo, description: l.description, effect: l.effect === "CREDIT" ? "Credit" : "Debit", amount: formatAud(l.amountCents + l.gstCents, s.currency) })),
    totals: { credits: formatAud(s.creditsCents, s.currency), debits: formatAud(s.debitsCents, s.currency), net: formatAud(s.netCents, s.currency) },
    reconciliation: r
      ? {
          status: reconciliationLabel(r.status),
          asOf: formatDay(r.asOf),
          entries: r.entries.map((e) => ({
            receipt: e.receiptNumber,
            kind: e.kind === "PAYMENT" ? "Payment received" : "Refund",
            effect: e.effect === "CREDIT" ? "Credit" : "Debit",
            amount: formatAud(e.amountCents, s.currency),
            date: formatDay(e.issuedAt),
          })),
          totals: {
            itemised: formatAud(r.totals.itemisedServiceFeeCents, s.currency),
            paid: formatAud(r.totals.paidCents, s.currency),
            refunded: formatAud(r.totals.refundedCents, s.currency),
            net: formatAud(r.totals.netCollectedCents, s.currency),
            balance: formatAud(r.totals.balanceCents, s.currency),
          },
          issues: r.issues.map((i) => reconciliationIssueText(i.code)),
        }
      : null,
  };
}

export const RECOVERABLE_STATUSES = ["NOTICE_SENT", "RETRY_SCHEDULED", "FAILED", "DISPUTED", "CALCULATED", "INVOICED", "READY_TO_INVOICE", "AWAITING_AUTHORITY"] as const;
/** BA recovery actions offered for a payment request status (server re-checks). */
export function recoveryActionsFor(status: string) {
  return {
    waive: ["NOT_CALCULATED", "ESTIMATED", "CALCULATED", "AWAITING_AUTHORITY", "READY_TO_INVOICE", "INVOICED", "NOTICE_SENT", "RETRY_SCHEDULED", "FAILED"].includes(status),
    writeOff: ["RETRY_SCHEDULED", "FAILED"].includes(status),
    resolveDispute: status === "DISPUTED",
  };
}

// ---------------------------------------------------------------------------
// Owner t212u: audited corrections + reconciliation exceptions (BA only).
export interface CorrectionEvidenceView {
  kind: "reference" | "upload";
  ref?: string;
  fileName?: string;
  sha256?: string;
  sizeBytes?: number;
}
export interface CorrectionRecord {
  auditId: number;
  table: string;
  recordId: string;
  correctedByUserId: number | null;
  correctedAt: string;
  before: Record<string, unknown>;
  patch: Record<string, unknown>;
  reason: string;
  evidence: CorrectionEvidenceView | null;
}
export interface CorrectionUpload {
  fileName: string;
  sha256: string;
  sizeBytes: number;
}
export interface CorrectionFormInput {
  table: string;
  id: string;
  column: string;
  value: string;
  reason: string;
  evidenceRef: string;
  upload: CorrectionUpload | null;
}
export const CORRECTABLE_TABLES = ["financial_ledger_events", "financial_receipts", "settlement_statements", "pc_fee_authorities", "financial_payment_requests"] as const;
export function correctionBody(input: CorrectionFormInput): {
  table: string;
  id: number;
  patch: Record<string, string>;
  reason: string;
  evidenceRef?: string;
  evidenceUpload?: CorrectionUpload;
} | null {
  const id = Number(input.id);
  const column = input.column.trim();
  const reason = input.reason.trim();
  if (!input.table || !Number.isSafeInteger(id) || id <= 0 || !column || reason.length < 1 || reason.length > 2000) return null;
  const ref = input.evidenceRef.trim();
  const base = { table: input.table, id, patch: { [column]: input.value }, reason };
  if (ref.length >= 3) return { ...base, evidenceRef: ref };
  const u = input.upload;
  if (u && u.fileName.trim() && /^[0-9a-f]{64}$/.test(u.sha256) && Number.isSafeInteger(u.sizeBytes) && u.sizeBytes > 0) {
    return { ...base, evidenceUpload: { fileName: u.fileName.trim(), sha256: u.sha256, sizeBytes: u.sizeBytes } };
  }
  return null;
}

export type ReconExceptionKind = "PAID_AFTER_WAIVER" | "PAID_AFTER_WRITE_OFF" | "CANCELLATION_UNCONFIRMED";
export type RefundAssessment = "REFUND_REQUIRED" | "NO_REFUND_REQUIRED" | "NOT_APPLICABLE";
export interface ReconciliationException {
  id: number;
  paymentRequestId: number;
  kind: ReconExceptionKind | string;
  source: string;
  amountCents: number | null;
  status: "OPEN" | "RESOLVED" | string;
  refundAssessment: RefundAssessment | string | null;
  resolutionReason: string | null;
  createdAt: string;
  resolvedAt: string | null;
}
export const RECON_KIND_LABEL: Record<string, string> = {
  PAID_AFTER_WAIVER: "Paid after waiver",
  PAID_AFTER_WRITE_OFF: "Paid after write-off",
  CANCELLATION_UNCONFIRMED: "Provider cancellation not confirmed",
};
export const REFUND_ASSESSMENT_LABEL: Record<string, string> = {
  REFUND_REQUIRED: "Refund required",
  NO_REFUND_REQUIRED: "No refund required",
  NOT_APPLICABLE: "Not applicable",
};
export function reconResolveBody(assessment: string, reason: string): { refundAssessment: RefundAssessment; reason: string } | null {
  if (!(assessment in REFUND_ASSESSMENT_LABEL)) return null;
  const r = reason.trim();
  if (r.length < 3 || r.length > 2000) return null;
  return { refundAssessment: assessment as RefundAssessment, reason: r };
}
