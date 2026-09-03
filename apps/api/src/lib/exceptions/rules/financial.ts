// Agent Engine 2.0 — Financial Transaction Engine (Priority 9, Stage F) x
// Exception & Risk Engine (Priority 4).
//
// Section 22: financial control-and-evidence gaps reuse the existing
// Exception & Risk Engine outright — no new alert table, no new severity
// system, the same dedupKey/resolveDefaultOwner/severityForDeadline
// machinery every other category already uses (rules/communicationDelivery.ts
// is the template this follows). Four rules, each scoped to a single
// property/transaction (RiskFinding.propertyId is mandatory — this is why
// PC fee AUTHORITIES themselves, which are agent-scoped rather than
// property-scoped, are deliberately not a rule source here; their
// ACTIVATED/REVOKED lifecycle already surfaces on the Property Timeline
// and financial ledger instead):
//
//   FIN01_PC_FEE_PAYMENT_FAILED — a PC success fee payment request
//   exhausted its retries (paymentOutbox.ts's dispatchOutboxEntry, once
//   maxAttempts is reached, sets both the outbox entry and the payment
//   request permanently FAILED). This never auto-clears on its own, so a
//   human must reissue, waive, or write it off — dismissible once handled.
//
//   FIN02_FINANCIAL_DISPUTE_OPEN — a financialDisputes row is still OPEN
//   or UNDER_REVIEW. Purely time-driven (no canonical event publishes a
//   dispute's creation yet), same as several other rules in this
//   catalogue that watch a status column directly.
//
//   FIN03_MARKETING_INVOICE_OVERDUE — a marketingPaymentRecords row has
//   been INVOICED for longer than the expected payment window with
//   nothing reported paid yet.
//
//   FIN04_COMMISSION_AGREEMENT_APPROVAL_STALLED — a commissionAgreements
//   row has sat AWAITING_APPROVAL past the expected window. Separation of
//   duties (agreements.ts's approveCommissionAgreement) means the
//   creator can never clear this themselves — it needs a different
//   Brokerage Administrator to act.

import { eq, and, inArray } from "drizzle-orm";
import {
  db,
  properties,
  financialPaymentRequests,
  financialDisputes,
  marketingPaymentRecords,
  commissionAgreements,
} from "@aee/db";
import type { RiskRule } from "../registry.js";
import type { RiskFinding } from "../types.js";
import { dedupKey, resolveDefaultOwner, severityForDeadline, escalatesAtFor } from "./shared.js";

function daysToMs(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------
// FIN01 — PC success fee payment failed permanently.
// ---------------------------------------------------------------------

async function loadFailedPaymentRequests(brokerageId: number) {
  return db
    .select({ request: financialPaymentRequests, property: properties })
    .from(financialPaymentRequests)
    .innerJoin(properties, eq(financialPaymentRequests.propertyId, properties.id))
    .where(and(eq(financialPaymentRequests.brokerageId, brokerageId), eq(financialPaymentRequests.status, "FAILED")));
}

const FIN01_PC_FEE_PAYMENT_FAILED: RiskRule = {
  ruleId: "FIN01_PC_FEE_PAYMENT_FAILED",
  version: 1,
  category: "FINANCIAL",
  name: "PC success fee payment failed permanently",
  description: "A PC success fee payment request exhausted its retries and failed permanently — it will not retry automatically.",
  triggerEventTypes: ["FINANCIAL_PAYMENT_FAILED"],
  async scanBrokerage(brokerageId) {
    const rows = await loadFailedPaymentRequests(brokerageId);
    const findings: RiskFinding[] = [];

    for (const { request, property } of rows) {
      const owner = resolveDefaultOwner(property, true);
      findings.push({
        ruleId: FIN01_PC_FEE_PAYMENT_FAILED.ruleId,
        ruleVersion: FIN01_PC_FEE_PAYMENT_FAILED.version,
        category: "FINANCIAL",
        severity: "AT_RISK",
        title: `PC success fee payment #${request.id} failed`,
        problemDescription: `Payment request #${request.id} (${(request.amountCents / 100).toFixed(2)} ${request.currency}) failed after ${request.retryCount} of ${request.maxRetries} attempt(s)${request.failureReason ? `: ${request.failureReason}` : "."}`,
        businessImpact: "A Pit Crew success fee that was authorised and due has not been collected — the PC has not been paid, and this will not resolve on its own.",
        detectedCause: `financial_payment_requests.status = FAILED (retryCount ${request.retryCount}/${request.maxRetries}).`,
        ...owner,
        propertyId: property.id,
        transactionId: request.transactionId,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Review the mandate and payment request, then reissue, waive, or write off the payment as appropriate.",
        resolutionRequirements: "A human resolves the underlying payment (reissued and paid, waived, or written off) and resolves or dismisses this exception.",
        dismissible: true,
        sourceRecordType: "financial_payment_request",
        sourceRecordId: String(request.id),
        dedupKey: dedupKey(FIN01_PC_FEE_PAYMENT_FAILED.ruleId, brokerageId, request.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: true,
        metadata: {
          paymentRequestId: request.id,
        },
      });
    }
    return findings;
  },
};

// ---------------------------------------------------------------------
// FIN02 — Financial dispute awaiting review.
// ---------------------------------------------------------------------

const OPEN_DISPUTE_STATUSES = ["OPEN", "UNDER_REVIEW"] as const;

async function loadOpenDisputes(brokerageId: number) {
  return db
    .select({ dispute: financialDisputes, request: financialPaymentRequests, property: properties })
    .from(financialDisputes)
    .innerJoin(financialPaymentRequests, eq(financialDisputes.paymentRequestId, financialPaymentRequests.id))
    .innerJoin(properties, eq(financialPaymentRequests.propertyId, properties.id))
    .where(and(eq(financialDisputes.brokerageId, brokerageId), inArray(financialDisputes.status, [...OPEN_DISPUTE_STATUSES])));
}

const FIN02_FINANCIAL_DISPUTE_OPEN: RiskRule = {
  ruleId: "FIN02_FINANCIAL_DISPUTE_OPEN",
  version: 1,
  category: "FINANCIAL",
  name: "Financial dispute awaiting review",
  description: "A dispute has been raised against a financial payment request and is still open or under review.",
  triggerEventTypes: [],
  async scanBrokerage(brokerageId) {
    const rows = await loadOpenDisputes(brokerageId);
    const findings: RiskFinding[] = [];

    for (const { dispute, request, property } of rows) {
      const owner = resolveDefaultOwner(property, true);
      findings.push({
        ruleId: FIN02_FINANCIAL_DISPUTE_OPEN.ruleId,
        ruleVersion: FIN02_FINANCIAL_DISPUTE_OPEN.version,
        category: "FINANCIAL",
        severity: dispute.status === "UNDER_REVIEW" ? "ATTENTION" : "AT_RISK",
        title: `Dispute open on payment request #${request.id}`,
        problemDescription: `A dispute of ${(dispute.disputedAmountCents / 100).toFixed(2)} ${request.currency} was raised against payment request #${request.id}: ${dispute.reason}`,
        businessImpact: "The disputed amount cannot be collected or reconciled until this dispute is resolved.",
        detectedCause: `financial_disputes.status = ${dispute.status}.`,
        ...owner,
        propertyId: property.id,
        transactionId: request.transactionId,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Review the dispute evidence and reason, then record a resolution (payable, adjusted, or waived).",
        resolutionRequirements: "A human records a resolution on the dispute and resolves this exception.",
        dismissible: false,
        sourceRecordType: "financial_dispute",
        sourceRecordId: String(dispute.id),
        dedupKey: dedupKey(FIN02_FINANCIAL_DISPUTE_OPEN.ruleId, brokerageId, dispute.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: true,
        metadata: {
          financialDisputeId: dispute.id,
          paymentRequestId: request.id,
        },
      });
    }
    return findings;
  },
};

// ---------------------------------------------------------------------
// FIN03 — Marketing invoice not yet reported paid.
// ---------------------------------------------------------------------

const MARKETING_INVOICE_GRACE_DAYS = 30;
const MARKETING_INVOICE_APPROACHING_DAYS = 7;
const MARKETING_INVOICE_CRITICAL_AFTER_DAYS = 30;

async function loadInvoicedMarketingRecords(brokerageId: number) {
  return db
    .select({ record: marketingPaymentRecords, property: properties })
    .from(marketingPaymentRecords)
    .innerJoin(properties, eq(marketingPaymentRecords.propertyId, properties.id))
    .where(and(eq(marketingPaymentRecords.brokerageId, brokerageId), eq(marketingPaymentRecords.status, "INVOICED")));
}

const FIN03_MARKETING_INVOICE_OVERDUE: RiskRule = {
  ruleId: "FIN03_MARKETING_INVOICE_OVERDUE",
  version: 1,
  category: "FINANCIAL",
  name: "Marketing invoice not yet reported paid",
  description: "A marketing expense was invoiced but has not been reported as paid within the expected window.",
  triggerEventTypes: ["MARKETING_INVOICE_RECORDED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await loadInvoicedMarketingRecords(brokerageId);
    const findings: RiskFinding[] = [];

    for (const { record, property } of rows) {
      if (!record.invoicedAt) continue;
      const dueDate = new Date(record.invoicedAt.getTime() + daysToMs(MARKETING_INVOICE_GRACE_DAYS));
      const severity = severityForDeadline(now, dueDate, MARKETING_INVOICE_APPROACHING_DAYS, MARKETING_INVOICE_CRITICAL_AFTER_DAYS);
      if (severity === "INFORMATION") continue;

      const owner = resolveDefaultOwner(property, false);
      const daysOverdue = Math.max(0, Math.floor((now.getTime() - dueDate.getTime()) / (24 * 60 * 60 * 1000)));
      findings.push({
        ruleId: FIN03_MARKETING_INVOICE_OVERDUE.ruleId,
        ruleVersion: FIN03_MARKETING_INVOICE_OVERDUE.version,
        category: "FINANCIAL",
        severity,
        title: `Marketing invoice ${record.invoiceReference ?? `#${record.id}`} not yet reported paid`,
        problemDescription: `Campaign item ${record.campaignItemId}'s invoice${record.supplierName ? ` from ${record.supplierName}` : ""} was recorded on ${record.invoicedAt.toISOString().slice(0, 10)} and has not been reported as paid within ${MARKETING_INVOICE_GRACE_DAYS} days.`,
        businessImpact: "An outstanding marketing invoice risks a supplier relationship or a missed payment obligation if it goes unreported for too long.",
        detectedCause: `marketing_payment_records.status = INVOICED, invoicedAt more than ${MARKETING_INVOICE_GRACE_DAYS} days ago.`,
        ...owner,
        propertyId: property.id,
        transactionId: null,
        dueAt: dueDate,
        escalatesAt: escalatesAtFor(dueDate, MARKETING_INVOICE_CRITICAL_AFTER_DAYS),
        recommendedAction: "Confirm whether the invoice has been paid and record it, or follow up with the supplier if it is still outstanding.",
        resolutionRequirements: "A human records the payment as reported paid (or cancels the record if it will not be paid) and resolves this exception.",
        dismissible: true,
        sourceRecordType: "marketing_payment_record",
        sourceRecordId: String(record.id),
        dedupKey: dedupKey(FIN03_MARKETING_INVOICE_OVERDUE.ruleId, brokerageId, record.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: true,
        metadata: {
          marketingPaymentRecordId: record.id,
          campaignItemId: record.campaignItemId,
          dueDate: dueDate.toISOString().slice(0, 10),
          daysOverdue,
        },
      });
    }
    return findings;
  },
};

// ---------------------------------------------------------------------
// FIN04 — Commission agreement stalled awaiting approval.
// ---------------------------------------------------------------------

const COMMISSION_AGREEMENT_APPROVAL_GRACE_DAYS = 5;
const COMMISSION_AGREEMENT_APPROVAL_APPROACHING_DAYS = 2;
const COMMISSION_AGREEMENT_APPROVAL_CRITICAL_AFTER_DAYS = 10;

async function loadAwaitingApprovalAgreements(brokerageId: number) {
  return db
    .select({ agreement: commissionAgreements, property: properties })
    .from(commissionAgreements)
    .innerJoin(properties, eq(commissionAgreements.propertyId, properties.id))
    .where(and(eq(commissionAgreements.brokerageId, brokerageId), eq(commissionAgreements.status, "AWAITING_APPROVAL")));
}

const FIN04_COMMISSION_AGREEMENT_APPROVAL_STALLED: RiskRule = {
  ruleId: "FIN04_COMMISSION_AGREEMENT_APPROVAL_STALLED",
  version: 1,
  category: "FINANCIAL",
  name: "Commission agreement awaiting approval too long",
  description: "A commission agreement has been awaiting approval for longer than expected — separation of duties means its own creator cannot clear this.",
  triggerEventTypes: ["COMMISSION_AGREEMENT_APPROVED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await loadAwaitingApprovalAgreements(brokerageId);
    const findings: RiskFinding[] = [];

    for (const { agreement, property } of rows) {
      const submittedAt = agreement.updatedAt ?? agreement.createdAt;
      const dueDate = new Date(submittedAt.getTime() + daysToMs(COMMISSION_AGREEMENT_APPROVAL_GRACE_DAYS));
      const severity = severityForDeadline(now, dueDate, COMMISSION_AGREEMENT_APPROVAL_APPROACHING_DAYS, COMMISSION_AGREEMENT_APPROVAL_CRITICAL_AFTER_DAYS);
      if (severity === "INFORMATION") continue;

      const owner = resolveDefaultOwner(property, true);
      findings.push({
        ruleId: FIN04_COMMISSION_AGREEMENT_APPROVAL_STALLED.ruleId,
        ruleVersion: FIN04_COMMISSION_AGREEMENT_APPROVAL_STALLED.version,
        category: "FINANCIAL",
        severity,
        title: `Commission agreement v${agreement.version} still awaiting approval`,
        problemDescription: `Commission agreement #${agreement.id} (version ${agreement.version}) has been AWAITING_APPROVAL since ${submittedAt.toISOString().slice(0, 10)} — it requires approval by someone other than its creator before it can be used to finalise commission.`,
        businessImpact: "Commission cannot be finalised at settlement until an approved commission agreement exists — this risks a delayed or incorrect payout.",
        detectedCause: `commission_agreements.status = AWAITING_APPROVAL, more than ${COMMISSION_AGREEMENT_APPROVAL_GRACE_DAYS} days ago.`,
        ...owner,
        propertyId: property.id,
        transactionId: agreement.transactionId,
        dueAt: dueDate,
        escalatesAt: escalatesAtFor(dueDate, COMMISSION_AGREEMENT_APPROVAL_CRITICAL_AFTER_DAYS),
        recommendedAction: "Have a Brokerage Administrator other than the agreement's creator review and approve or cancel this commission agreement.",
        resolutionRequirements: "The agreement is approved or cancelled, and this exception is resolved.",
        dismissible: false,
        sourceRecordType: "commission_agreement",
        sourceRecordId: String(agreement.id),
        dedupKey: dedupKey(FIN04_COMMISSION_AGREEMENT_APPROVAL_STALLED.ruleId, brokerageId, agreement.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: true,
        metadata: {
          commissionAgreementId: agreement.id,
          dueDate: dueDate.toISOString().slice(0, 10),
        },
      });
    }
    return findings;
  },
};

export const FINANCIAL_RULES: RiskRule[] = [
  FIN01_PC_FEE_PAYMENT_FAILED,
  FIN02_FINANCIAL_DISPUTE_OPEN,
  FIN03_MARKETING_INVOICE_OVERDUE,
  FIN04_COMMISSION_AGREEMENT_APPROVAL_STALLED,
];
