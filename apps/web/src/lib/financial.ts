// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage G
// frontend types + display helpers (Section 28: Property Financial
// Summary; Section 29: Brokerage Financial Operations queue).
//
// Mirrors packages/db/src/schema/financial.ts's enums and row shapes by
// hand — the web app doesn't share a package with the API, same
// convention lib/riskExceptions.ts and lib/commandCentre.ts already use
// for their own domains. Money is integer cents throughout (never a
// float) and rates are integer basis points, exactly as the schema
// itself documents.
//
// Every read here goes through routes gated Brokerage Administrator only
// (routes/financial.ts's own header comment — the same BROKERAGE_ADMIN_ROLES
// precedent routes/exceptions.ts/commandCentre.ts already established).
// This file makes no attempt to second-guess that on the client — the
// components that use these fetchers are themselves responsible for only
// calling them once useSession() confirms the signed-in user is a
// Brokerage Administrator (see FinancialSummarySection.tsx's own header
// comment for why that self-gating matters here specifically).

import { apiFetch } from "./api";

// ---------------------------------------------------------------------
// Enums — mirrored from packages/db/src/schema/financial.ts by hand.
// ---------------------------------------------------------------------

export const COMMISSION_AGREEMENT_STATUSES = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUPERSEDED", "CANCELLED"] as const;
export type CommissionAgreementStatus = (typeof COMMISSION_AGREEMENT_STATUSES)[number];

export const FINANCIAL_SNAPSHOT_STATES = ["ESTIMATE", "PROVISIONAL", "CONFIRMED", "FINALISED", "SUPERSEDED"] as const;
export type FinancialSnapshotState = (typeof FINANCIAL_SNAPSHOT_STATES)[number];

export const PC_FEE_AUTHORITY_STATUSES = ["NOT_PROVIDED", "PENDING", "ACTIVE", "EXPIRED", "REVOKED", "REPLACED", "INVALID"] as const;
export type PcFeeAuthorityStatus = (typeof PC_FEE_AUTHORITY_STATUSES)[number];

export const PAYMENT_REQUEST_STATUSES = [
  "NOT_CALCULATED",
  "ESTIMATED",
  "CALCULATED",
  "AWAITING_AUTHORITY",
  "READY_TO_INVOICE",
  "INVOICED",
  "NOTICE_SENT",
  "DEBIT_SCHEDULED",
  "PROCESSING",
  "PAID",
  "FAILED",
  "RETRY_SCHEDULED",
  "DISPUTED",
  "WAIVED",
  "REVERSED",
  "WRITTEN_OFF",
  "RECONCILED",
] as const;
export type PaymentRequestStatus = (typeof PAYMENT_REQUEST_STATUSES)[number];

export const DEPOSIT_STATUSES = [
  "NOT_REQUIRED",
  "EXPECTED",
  "DUE",
  "REPORTED_PART_RECEIVED",
  "REPORTED_RECEIVED",
  "EVIDENCE_RECEIVED",
  "RECONCILED_EXTERNALLY",
  "REPORTED_RELEASED",
  "DISPUTED",
  "UNKNOWN",
] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

export const RECONCILIATION_STATUSES = ["NOT_REQUIRED", "UNRECONCILED", "PARTIALLY_RECONCILED", "RECONCILED", "VARIANCE", "DISPUTED"] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export const AUDIT_RETURN_STATUSES = ["SCHEDULED", "REMINDER_SENT", "DUE", "OVERDUE", "SUBMITTED"] as const;
export type AuditReturnStatus = (typeof AUDIT_RETURN_STATUSES)[number];

// ---------------------------------------------------------------------
// Row shapes — field names match the Drizzle columns exactly (camelCase).
// ---------------------------------------------------------------------

export interface CommissionAgreement {
  id: number;
  brokerageId: number;
  propertyId: number;
  transactionId: number;
  version: number;
  status: CommissionAgreementStatus;
  supersedesId: number | null;
  currency: string;
  method: string;
  rateBps: number | null;
  fixedAmountCents: number | null;
  minimumAmountCents: number | null;
  manualReason: string | null;
  gstApplicable: boolean;
  gstRateBps: number;
  referralFeeCents: number;
  brokerageSplitBps: number | null;
  agentSplitBps: number | null;
  sourceDocumentRef: string | null;
  effectiveDate: string | null;
  approvedByUserId: number | null;
  approvedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommissionCalculation {
  id: number;
  brokerageId: number;
  propertyId: number;
  transactionId: number;
  commissionAgreementId: number;
  calculationVersion: number;
  state: FinancialSnapshotState;
  supersededReason: string | null;
  salePriceCentsInput: number;
  methodUsed: string;
  rateBpsUsed: number | null;
  grossCommissionCents: number;
  minimumAppliedCents: number | null;
  referralFeeCents: number;
  commissionExGstCents: number;
  gstCents: number;
  gstRateBpsUsed: number;
  brokerageComponentCents: number | null;
  agentComponentCents: number | null;
  calculationRuleVersion: number;
  calculatedAt: string;
  finalisedAt: string | null;
}

export interface PcFeeCalculation {
  id: number;
  brokerageId: number;
  propertyId: number;
  transactionId: number;
  commissionCalculationId: number | null;
  pcFeeAuthorityId: number | null;
  calculationVersion: number;
  state: FinancialSnapshotState;
  feeBasisUsed: string;
  gciBasisCents: number;
  rateBpsUsed: number | null;
  grossFeeCents: number;
  gstCents: number;
  totalFeeCents: number;
  isDisputed: boolean;
  isProvisional: boolean;
  calculatedAt: string;
  finalisedAt: string | null;
}

// Redacted shape — mirrors routes/financial.ts's own redactPcFeeAuthority()
// (Section 33): hasMandate is a boolean, the raw mandateProviderRef is
// never sent to the browser at all.
export interface PcFeeAuthority {
  id: number;
  brokerageId: number;
  agentUserId: number;
  version: number;
  status: PcFeeAuthorityStatus;
  feeBasis: string;
  rateBps: number | null;
  fixedAmountCents: number | null;
  gciDefinition: string;
  gstApplicable: boolean;
  paymentTrigger: string;
  authorisedPaymentMethod: string;
  hasMandate: boolean;
  mandateProvider: string | null;
  maximumAmountCents: number | null;
  noticeRequiredDays: number;
  effectiveDate: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FinancialPaymentRequest {
  id: number;
  brokerageId: number;
  propertyId: number;
  transactionId: number;
  kind: string;
  pcFeeCalculationId: number | null;
  pcFeeAuthorityId: number | null;
  payeeUserId: number | null;
  payerUserId: number | null;
  status: PaymentRequestStatus;
  amountCents: number;
  currency: string;
  invoiceNumber: string | null;
  invoiceIssuedAt: string | null;
  noticeSentAt: string | null;
  provider: string | null;
  providerStatus: string | null;
  scheduledAt: string | null;
  paidAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  retryCount: number;
  maxRetries: number;
  reversedAt: string | null;
  reversalReason: string | null;
  waivedAt: string | null;
  waiveReason: string | null;
  writtenOffAt: string | null;
  reconciliationStatus: ReconciliationStatus;
  reconciledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FinancialDispute {
  id: number;
  brokerageId: number;
  paymentRequestId: number;
  disputedAmountCents: number;
  reason: string;
  raisedAt: string;
  status: string;
  resolution: string | null;
  resolvedAt: string | null;
}

export interface FinancialDeposit {
  id: number;
  brokerageId: number;
  propertyId: number;
  transactionId: number;
  status: DepositStatus;
  requiredAmountCents: number | null;
  dueDate: string | null;
  reportedReceivedAmountCents: number;
  reportedReceivedAt: string | null;
  externalHolderType: string | null;
  externalHolderName: string | null;
  reportedReleasedAt: string | null;
  reconciliationStatus: ReconciliationStatus;
  reconciledAt: string | null;
}

// Section 19 — mirrors schema/financial.ts's financialReconciliations
// table exactly. Polymorphic over recordType/recordId (a legacy
// commission, a deposit, a PC fee, ...) rather than one interface per
// domain, same as the table itself.
export interface FinancialReconciliation {
  id: number;
  brokerageId: number;
  recordType: string;
  recordId: string;
  expectedAmountCents: number | null;
  reportedAmountCents: number | null;
  evidenceAmountCents: number | null;
  differenceCents: number | null;
  status: ReconciliationStatus;
  source: string | null;
  externalReference: string | null;
  evidenceRef: string | null;
  notes: string | null;
  reconciledByUserId: number | null;
  reconciledAt: string | null;
  createdAt: string;
}

export interface AuditReturnReminder {
  id: number;
  brokerageId: number;
  jurisdiction: string;
  reportingEntityName: string | null;
  reportingPeriodStart: string;
  reportingPeriodEnd: string;
  dueDate: string;
  responsibleUserId: number | null;
  status: AuditReturnStatus;
  submissionReference: string | null;
  submittedAt: string | null;
}

// Financial Transaction Engine Verification (Step 2), COHERENCE-001
// remediation — mirrors lib/financial/queries.ts's LegacyCommissionSummary
// (API) exactly. Populated on PropertyFinancialSummaryResponse only when
// the property has no Financial Engine commissionAgreement at all, so the
// UI has a single coherent explanation instead of a bare "no commission
// agreement" state sitting beside the legacy Transaction section's own
// commission figure. This is a read-only, labelled surface of the
// pre-existing legacy transactions.grossCommissionCents/gstCents figure —
// it is never a Financial Engine calculation, and no commissionAgreement
// or commissionCalculation is inferred from it.
export interface LegacyCommissionSummary {
  transactionId: number;
  propertyId: number;
  brokerageId: number;
  transactionStatus: string;
  grossCommissionCents: number;
  gstCents: number | null;
  commissionCalculatedAt: string | null;
  alreadyFlaggedForReconciliation: boolean;
}

// ---------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------

export interface PropertyFinancialSummaryResponse {
  propertyId: number;
  currentCommissionAgreement: CommissionAgreement | null;
  latestCommissionCalculation: CommissionCalculation | null;
  latestPcFeeCalculation: PcFeeCalculation | null;
  paymentRequests: FinancialPaymentRequest[];
  deposit: FinancialDeposit | null;
  legacyCommission: LegacyCommissionSummary | null;
}

/** Section 28: the Property Financial Summary's single bundled read. */
export function fetchPropertyFinancialSummary(propertyId: number) {
  return apiFetch<PropertyFinancialSummaryResponse>(`/properties/${propertyId}/financial/summary`);
}

export function approveCommissionAgreement(agreementId: number) {
  return apiFetch<{ agreement: CommissionAgreement }>(`/financial/commission-agreements/${agreementId}/approve`, { method: "POST" });
}

// COHERENCE-001 remediation: the "Flag for reconciliation" action behind
// FinancialSummarySection.tsx's legacy-commission card — the single
// authorised way this build lets a Brokerage Administrator acknowledge a
// legacy commission that predates the Financial Engine. Never creates a
// commissionAgreement/commissionCalculation; only ever creates (or
// returns the existing) financialReconciliations row via
// lib/financial/legacyReconciliation.ts's reconcileLegacyCommission.
export interface FlagLegacyCommissionForReconciliationResponse {
  reconciliation: FinancialReconciliation;
  created: boolean;
}

export function flagLegacyCommissionForReconciliation(transactionId: number) {
  return apiFetch<FlagLegacyCommissionForReconciliationResponse>(`/financial/transactions/${transactionId}/legacy-commission/reconcile`, {
    method: "POST",
  });
}

export interface PaymentRequestsResponse {
  paymentRequests: FinancialPaymentRequest[];
}

/** Section 29: brokerage-wide payment-request queue (no transactionId filter). */
export function fetchPaymentRequests(params?: { transactionId?: number; status?: string }) {
  const qs = new URLSearchParams();
  if (params?.transactionId != null) qs.set("transactionId", String(params.transactionId));
  if (params?.status) qs.set("status", params.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiFetch<PaymentRequestsResponse>(`/financial/payment-requests${suffix}`);
}

export interface AuditReturnRemindersResponse {
  reminders: AuditReturnReminder[];
}

/** Section 23: annual audit-return reminders, brokerage-wide. */
export function fetchAuditReturnReminders() {
  return apiFetch<AuditReturnRemindersResponse>("/financial/audit-return-reminders");
}

// ---------------------------------------------------------------------
// Display helpers — mirror lib/riskExceptions.ts / lib/commandCentre.ts's
// conventions: only four pill tones exist in this app's design system
// (pill / pill-success / pill-warning / pill-danger — see styles.css),
// so every status below is bucketed into one of those four, told apart
// by its label text rather than by inventing a new colour.
// ---------------------------------------------------------------------

export function formatCents(cents: number | null | undefined, currency = "AUD"): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-AU", { style: "currency", currency }).format(cents / 100);
}

export function formatBps(bps: number | null | undefined): string | null {
  if (bps == null) return null;
  return `${(bps / 100).toFixed(2)}%`;
}

export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

export function commissionAgreementStatusLabel(status: string): string {
  return status === "AWAITING_APPROVAL" ? "Awaiting Approval" : titleCase(status);
}

export function commissionAgreementStatusPillClass(status: string): string {
  switch (status) {
    case "APPROVED":
      return "pill pill-success";
    case "AWAITING_APPROVAL":
      return "pill pill-warning";
    case "CANCELLED":
      return "pill pill-danger";
    default:
      return "pill";
  }
}

export function snapshotStateLabel(state: string): string {
  return titleCase(state);
}

export function snapshotStatePillClass(state: string): string {
  switch (state) {
    case "FINALISED":
      return "pill pill-success";
    case "ESTIMATE":
    case "PROVISIONAL":
      return "pill pill-warning";
    default:
      return "pill";
  }
}

export function pcFeeAuthorityStatusLabel(status: string): string {
  return status === "NOT_PROVIDED" ? "Not Provided" : titleCase(status);
}

export function pcFeeAuthorityStatusPillClass(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "pill pill-success";
    case "PENDING":
    case "EXPIRED":
      return "pill pill-warning";
    case "REVOKED":
    case "INVALID":
      return "pill pill-danger";
    default:
      return "pill";
  }
}

// Section 14/15's payment-request lifecycle is the longest vocabulary in
// this domain (17 values) — explicit switch, same convention
// lib/riskExceptions.ts's statusLabel uses, rather than relying on the
// generic title-case transform to read naturally for every value.
export function paymentRequestStatusLabel(status: string): string {
  switch (status) {
    case "NOT_CALCULATED":
      return "Not Calculated";
    case "ESTIMATED":
      return "Estimated";
    case "CALCULATED":
      return "Calculated";
    case "AWAITING_AUTHORITY":
      return "Awaiting PC Authority";
    case "READY_TO_INVOICE":
      return "Ready to Invoice";
    case "INVOICED":
      return "Invoiced";
    case "NOTICE_SENT":
      return "Notice Sent";
    case "DEBIT_SCHEDULED":
      return "Debit Scheduled";
    case "PROCESSING":
      return "Processing";
    case "PAID":
      return "Paid";
    case "FAILED":
      return "Failed";
    case "RETRY_SCHEDULED":
      return "Retry Scheduled";
    case "DISPUTED":
      return "Disputed";
    case "WAIVED":
      return "Waived";
    case "REVERSED":
      return "Reversed";
    case "WRITTEN_OFF":
      return "Written Off";
    case "RECONCILED":
      return "Reconciled";
    default:
      return titleCase(status);
  }
}

export function paymentRequestStatusPillClass(status: string): string {
  switch (status) {
    case "PAID":
    case "RECONCILED":
      return "pill pill-success";
    case "FAILED":
    case "DISPUTED":
    case "REVERSED":
      return "pill pill-danger";
    case "AWAITING_AUTHORITY":
    case "NOTICE_SENT":
    case "DEBIT_SCHEDULED":
    case "PROCESSING":
    case "RETRY_SCHEDULED":
      return "pill pill-warning";
    default:
      return "pill";
  }
}

export function depositStatusLabel(status: string): string {
  return titleCase(status);
}

export function depositStatusPillClass(status: string): string {
  switch (status) {
    case "REPORTED_RECEIVED":
    case "EVIDENCE_RECEIVED":
    case "RECONCILED_EXTERNALLY":
      return "pill pill-success";
    case "DUE":
    case "REPORTED_PART_RECEIVED":
      return "pill pill-warning";
    case "DISPUTED":
    case "UNKNOWN":
      return "pill pill-danger";
    default:
      return "pill";
  }
}

export function reconciliationStatusLabel(status: string): string {
  return titleCase(status);
}

export function reconciliationStatusPillClass(status: string): string {
  switch (status) {
    case "RECONCILED":
      return "pill pill-success";
    case "UNRECONCILED":
    case "PARTIALLY_RECONCILED":
      return "pill pill-warning";
    case "VARIANCE":
    case "DISPUTED":
      return "pill pill-danger";
    default:
      return "pill";
  }
}

export function auditReturnStatusLabel(status: string): string {
  return titleCase(status);
}

export function auditReturnStatusPillClass(status: string): string {
  switch (status) {
    case "SUBMITTED":
      return "pill pill-success";
    case "REMINDER_SENT":
    case "DUE":
      return "pill pill-warning";
    case "OVERDUE":
      return "pill pill-danger";
    default:
      return "pill";
  }
}
