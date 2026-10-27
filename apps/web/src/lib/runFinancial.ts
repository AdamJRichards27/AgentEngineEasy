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
  /** Card refunds only (G19): UNKNOWN, or PENDING past the in-flight window. */
  resolvable?: boolean;
  stalePending?: boolean;
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
