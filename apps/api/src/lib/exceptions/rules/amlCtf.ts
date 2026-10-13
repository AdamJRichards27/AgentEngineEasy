// Agent Engine 2.0 — Exception & Risk Engine (Priority 4).
// Category E — AML/CTF (Build Instructions §10.E). Combines several
// catalogue numbers per party/stage to avoid two simultaneous exceptions
// describing the same underlying "this party's AML isn't done" fact — see
// docs/exception-risk-engine/ARCHITECTURE.md's "combined rules" table for
// the full mapping. Only safe operational statuses are ever read or
// written here (AML_STATUSES) — never identity-document or provider
// evidence fields (Build Instructions §10.E: "never expose identity-
// document or provider-sensitive data").

import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db, transactions, properties, propertyParties, amlVerifications, parties, type Property, type Transaction } from "@aee/db";
import type { RiskRule } from "../registry.js";
import type { RiskFinding } from "../types.js";
import { AFTER_APPRAISAL_STAGES, dedupKey, resolveDefaultOwner, severityForDeadline } from "./shared.js";

interface AmlCandidate {
  property: Property;
  transaction: Transaction | null;
  partyId: number;
  partyRole: "Seller" | "Buyer";
  status: string | null; // null = no amlVerifications row at all
}

const INCOMPLETE_NON_FAILURE_STATUSES = ["Not Started", "Awaiting Seller", "In Progress"];
const FAILURE_STATUSES = ["Review Required", "Failed"];

async function loadSellerCandidates(brokerageId: number): Promise<AmlCandidate[]> {
  const rows = await db
    .select({ property: properties, partyId: propertyParties.partyId })
    .from(propertyParties)
    .innerJoin(properties, eq(propertyParties.propertyId, properties.id))
    .where(and(eq(properties.brokerageId, brokerageId), eq(propertyParties.role, "Seller"), ne(properties.workflowStage, "Appraisal")));
  if (rows.length === 0) return [];
  const partyIds = rows.map((r) => r.partyId);
  const amlRows = await db.select().from(amlVerifications).where(inArray(amlVerifications.partyId, partyIds));
  return rows.map(({ property, partyId }) => ({
    property,
    transaction: null,
    partyId,
    partyRole: "Seller" as const,
    status: amlRows.find((a) => a.partyId === partyId && a.propertyId === property.id)?.status ?? null,
  }));
}

async function loadBuyerCandidates(brokerageId: number): Promise<Array<AmlCandidate & { transaction: Transaction }>> {
  const rows = await db
    .select({ transaction: transactions, property: properties })
    .from(transactions)
    .innerJoin(properties, eq(transactions.propertyId, properties.id))
    .where(and(eq(properties.brokerageId, brokerageId), isNull(transactions.closedAt)));
  const withContract = rows.filter((r) => r.transaction.contractDate !== null);
  if (withContract.length === 0) return [];
  const buyerPartyIds = [...new Set(withContract.flatMap((r) => (r.transaction.buyerPartyIds as number[] | null) ?? []))];
  const amlRows = buyerPartyIds.length ? await db.select().from(amlVerifications).where(inArray(amlVerifications.partyId, buyerPartyIds)) : [];
  const out: Array<AmlCandidate & { transaction: Transaction }> = [];
  for (const { transaction, property } of withContract) {
    for (const partyId of (transaction.buyerPartyIds as number[] | null) ?? []) {
      out.push({
        property,
        transaction,
        partyId,
        partyRole: "Buyer",
        status: amlRows.find((a) => a.partyId === partyId && a.propertyId === property.id)?.status ?? null,
      });
    }
  }
  return out;
}

async function partyLabel(partyId: number): Promise<string> {
  const [p] = await db.select().from(parties).where(eq(parties.id, partyId));
  if (!p) return `Party #${partyId}`;
  return p.organisationName || `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || `Party #${partyId}`;
}

const E_SELLER_AML: RiskRule = {
  ruleId: "E05_22_24_SELLER_AML_INCOMPLETE",
  version: 1,
  category: "AML_CTF",
  scopeExitPolicy: "KEEP_OPEN",
  stageRange: AFTER_APPRAISAL_STAGES,
  name: "Seller AML/CTF incomplete",
  description: "Combines catalogue #5, #22, and the seller half of #24: a required seller has no AML verification row, or one that hasn't reached Complete (excluding Review Required/Failed, which E26 covers with more specific guidance).",
  triggerEventTypes: ["READY_TO_LIST", "AML_REQUESTED"],
  async scanBrokerage(brokerageId, now) {
    const candidates = await loadSellerCandidates(brokerageId);
    const findings: RiskFinding[] = [];
    for (const c of candidates) {
      if (c.status === "Complete") continue;
      if (c.status && FAILURE_STATUSES.includes(c.status)) continue; // E26's territory
      const owner = resolveDefaultOwner(c.property, false);
      const severity = c.property.workflowStage === "Appraisal" || c.property.workflowStage === "Ready to List" ? "ATTENTION" : "AT_RISK";
      const label = await partyLabel(c.partyId);
      findings.push({
        ruleId: E_SELLER_AML.ruleId,
        ruleVersion: E_SELLER_AML.version,
        category: "AML_CTF",
        severity,
        title: `Seller AML/CTF verification incomplete for ${label}`,
        problemDescription: c.status
          ? `${label}'s AML/CTF verification is currently "${c.status}", not yet Complete.`
          : `${label} has no AML/CTF verification on record.`,
        businessImpact: "The listing cannot proceed to a clean settlement without seller AML/CTF verification completed.",
        detectedCause: c.status ? `amlVerifications.status = ${c.status}` : "No amlVerifications row for this seller.",
        ...owner,
        propertyId: c.property.id,
        transactionId: c.transaction?.id ?? null,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Request or follow up seller AML/CTF verification through the AML workflow.",
        resolutionRequirements: "The seller's amlVerifications row reaches status Complete.",
        dismissible: false,
        sourceRecordType: "party",
        sourceRecordId: String(c.partyId),
        dedupKey: dedupKey(E_SELLER_AML.ruleId, brokerageId, `${c.property.id}:${c.partyId}`),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { partyRole: "Seller", amlStatus: c.status ?? "MISSING" },
      });
    }
    return findings;
  },
};

const E_BUYER_AML_EARLY: RiskRule = {
  ruleId: "E23_24_BUYER_AML_INCOMPLETE",
  version: 1,
  category: "AML_CTF",
  scopeExitPolicy: "KEEP_OPEN",
  name: "Buyer AML/CTF incomplete (no settlement date yet)",
  description: "Combines catalogue #23 and the buyer half of #24. Active only before a settlement date exists — once one is set, E27 takes over with deadline-based severity so the same fact is never tracked by two rules at once.",
  triggerEventTypes: ["CONTRACT_SIGNED"],
  async scanBrokerage(brokerageId, now) {
    const candidates = await loadBuyerCandidates(brokerageId);
    const findings: RiskFinding[] = [];
    for (const c of candidates) {
      if (c.transaction.settlementDate) continue; // E27's territory
      if (c.status === "Complete") continue;
      if (c.status && FAILURE_STATUSES.includes(c.status)) continue; // E26's territory
      const owner = resolveDefaultOwner(c.property, true);
      const label = await partyLabel(c.partyId);
      findings.push({
        ruleId: E_BUYER_AML_EARLY.ruleId,
        ruleVersion: E_BUYER_AML_EARLY.version,
        category: "AML_CTF",
        severity: "ATTENTION",
        title: `Buyer AML/CTF verification incomplete for ${label}`,
        problemDescription: c.status
          ? `${label}'s AML/CTF verification is currently "${c.status}", not yet Complete.`
          : `${label} has no AML/CTF verification on record.`,
        businessImpact: "Settlement cannot proceed until buyer AML/CTF verification is complete.",
        detectedCause: c.status ? `amlVerifications.status = ${c.status}` : "No amlVerifications row for this buyer.",
        ...owner,
        propertyId: c.property.id,
        transactionId: c.transaction.id,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Request or follow up buyer AML/CTF verification through the AML workflow.",
        resolutionRequirements: "The buyer's amlVerifications row reaches status Complete.",
        dismissible: false,
        sourceRecordType: "party",
        sourceRecordId: String(c.partyId),
        dedupKey: dedupKey(E_BUYER_AML_EARLY.ruleId, brokerageId, `${c.property.id}:${c.partyId}`),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { partyRole: "Buyer", amlStatus: c.status ?? "MISSING" },
      });
    }
    return findings;
  },
};

// The rule behind the spec's named At Risk scenario (Build Instructions
// §24): "Settlement approaches -> buyer AML/CTF remains incomplete -> At
// Risk exception opens -> responsible agent is assigned -> registered
// remediation task is created -> AML/CTF is completed through the
// authorised pathway -> exception resolves automatically."
const E27_BUYER_AML_NEAR_SETTLEMENT: RiskRule = {
  ruleId: "E27_BUYER_AML_APPROACHING_SETTLEMENT",
  version: 1,
  category: "AML_CTF",
  scopeExitPolicy: "KEEP_OPEN",
  name: "Buyer AML/CTF incomplete as settlement approaches",
  description: "A settlement date is set and buyer AML/CTF is not yet Complete — deadline-based severity ladder culminating in CRITICAL at/after settlement.",
  triggerEventTypes: ["SETTLEMENT_SCHEDULED", "AML_COMPLETED"],
  async scanBrokerage(brokerageId, now) {
    const candidates = await loadBuyerCandidates(brokerageId);
    const findings: RiskFinding[] = [];
    for (const c of candidates) {
      if (!c.transaction.settlementDate || c.transaction.settlementCompletedAt) continue;
      if (c.status === "Complete") continue;
      const owner = resolveDefaultOwner(c.property, true);
      const label = await partyLabel(c.partyId);
      const settlementDate = c.transaction.settlementDate;
      const severity = severityForDeadline(now, settlementDate, 10, 0);
      findings.push({
        ruleId: E27_BUYER_AML_NEAR_SETTLEMENT.ruleId,
        ruleVersion: E27_BUYER_AML_NEAR_SETTLEMENT.version,
        category: "AML_CTF",
        severity,
        title: `Buyer AML/CTF incomplete with settlement ${settlementDate.getTime() < now.getTime() ? "overdue" : "approaching"}`,
        problemDescription: `Settlement is scheduled for ${settlementDate.toDateString()} and ${label}'s AML/CTF verification is currently "${c.status ?? "not started"}".`,
        businessImpact: "Settlement cannot proceed without completed buyer AML/CTF verification — this risks a delayed or failed settlement.",
        detectedCause: c.status ? `amlVerifications.status = ${c.status}` : "No amlVerifications row for this buyer.",
        ...owner,
        propertyId: c.property.id,
        transactionId: c.transaction.id,
        dueAt: settlementDate,
        escalatesAt: settlementDate,
        recommendedAction: "Request or urgently follow up buyer AML/CTF verification before settlement.",
        resolutionRequirements: "The buyer's amlVerifications row reaches status Complete.",
        dismissible: false,
        sourceRecordType: "party",
        sourceRecordId: String(c.partyId),
        dedupKey: dedupKey(E27_BUYER_AML_NEAR_SETTLEMENT.ruleId, brokerageId, `${c.property.id}:${c.partyId}`),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { partyRole: "Buyer", amlStatus: c.status ?? "MISSING", settlementDate: settlementDate.toISOString() },
      });
    }
    return findings;
  },
};

const E26_AML_PROVIDER_FAILED: RiskRule = {
  ruleId: "E26_AML_PROVIDER_REQUEST_FAILED_OR_REVIEW",
  version: 1,
  category: "AML_CTF",
  scopeExitPolicy: "KEEP_OPEN",
  name: "AML/CTF provider request failed or requires review",
  description: "An amlVerifications row is Review Required or Failed and has not been resolved through the exception-resolution fields the AML domain already provides.",
  triggerEventTypes: ["AML_COMPLETED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ aml: amlVerifications, property: properties })
      .from(amlVerifications)
      .innerJoin(properties, eq(amlVerifications.propertyId, properties.id))
      .where(and(eq(properties.brokerageId, brokerageId), inArray(amlVerifications.status, FAILURE_STATUSES), isNull(amlVerifications.exceptionResolvedAt)));
    const findings: RiskFinding[] = [];
    for (const { aml, property } of rows) {
      const owner = resolveDefaultOwner(property, false);
      const label = await partyLabel(aml.partyId);
      findings.push({
        ruleId: E26_AML_PROVIDER_FAILED.ruleId,
        ruleVersion: E26_AML_PROVIDER_FAILED.version,
        category: "AML_CTF",
        severity: "AT_RISK",
        title: `AML/CTF verification for ${label} needs review`,
        problemDescription: `${label}'s AML/CTF verification came back "${aml.status}" and has not yet been reviewed/resolved.`,
        businessImpact: "An unresolved AML/CTF failure or review flag must not be silently reinterpreted as verified — it blocks safe progression.",
        detectedCause: `amlVerifications.status = ${aml.status}, exceptionResolvedAt is null.`,
        ...owner,
        propertyId: property.id,
        transactionId: null,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Review the AML/CTF exception with the provider and record the compliance decision.",
        resolutionRequirements: "amlVerifications.exceptionResolvedAt is recorded (a human compliance decision), or status reaches Complete.",
        dismissible: false,
        sourceRecordType: "aml_verification",
        sourceRecordId: String(aml.id),
        dedupKey: dedupKey(E26_AML_PROVIDER_FAILED.ruleId, brokerageId, aml.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { amlVerificationId: aml.id, amlStatus: aml.status, partyRole: "Unknown" },
      });
    }
    return findings;
  },
};

const E28_CLOSURE_BLOCKED_BY_AML: RiskRule = {
  ruleId: "E28_CLOSURE_BLOCKED_BY_INCOMPLETE_AML",
  version: 1,
  category: "AML_CTF",
  scopeExitPolicy: "KEEP_OPEN",
  name: "Closure blocked by incomplete AML/CTF",
  description: "Settlement completed but the transaction has not closed, and a required party's AML/CTF is still not Complete.",
  triggerEventTypes: ["SETTLEMENT_COMPLETED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ transaction: transactions, property: properties })
      .from(transactions)
      .innerJoin(properties, eq(transactions.propertyId, properties.id))
      .where(and(eq(properties.brokerageId, brokerageId), isNull(transactions.closedAt)));
    const findings: RiskFinding[] = [];
    for (const { transaction, property } of rows) {
      if (!transaction.settlementCompletedAt) continue;
      const partyIds = [...(((transaction.sellerPartyIds as number[] | null) ?? [])), ...(((transaction.buyerPartyIds as number[] | null) ?? []))];
      if (partyIds.length === 0) continue;
      const amlRows = await db.select().from(amlVerifications).where(and(eq(amlVerifications.propertyId, property.id), inArray(amlVerifications.partyId, partyIds)));
      const incomplete = partyIds.filter((id) => {
        const row = amlRows.find((a) => a.partyId === id);
        return !row || row.status !== "Complete";
      });
      if (incomplete.length === 0) continue;
      const owner = resolveDefaultOwner(property, true);
      findings.push({
        ruleId: E28_CLOSURE_BLOCKED_BY_AML.ruleId,
        ruleVersion: E28_CLOSURE_BLOCKED_BY_AML.version,
        category: "AML_CTF",
        severity: "CRITICAL",
        title: "Transaction closure blocked by incomplete AML/CTF",
        problemDescription: `Settlement completed on ${transaction.settlementCompletedAt.toDateString()} but ${incomplete.length} required part${incomplete.length === 1 ? "y" : "ies"} still lack completed AML/CTF verification.`,
        businessImpact: "Closing a transaction with incomplete AML/CTF verification is a compliance failure that must never be bypassed.",
        detectedCause: "transactions.settlementCompletedAt is set, transactions.closedAt is null, and >=1 required party's AML is not Complete.",
        ...owner,
        propertyId: property.id,
        transactionId: transaction.id,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Complete AML/CTF verification for every remaining party before closing this transaction.",
        resolutionRequirements: "Every required party's amlVerifications row reaches Complete, or the transaction closes through the authorised pathway.",
        dismissible: false,
        sourceRecordType: "transaction",
        sourceRecordId: String(transaction.id),
        dedupKey: dedupKey(E28_CLOSURE_BLOCKED_BY_AML.ruleId, brokerageId, transaction.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
      });
    }
    return findings;
  },
};

export const AML_CTF_RULES: RiskRule[] = [E_SELLER_AML, E_BUYER_AML_EARLY, E27_BUYER_AML_NEAR_SETTLEMENT, E26_AML_PROVIDER_FAILED, E28_CLOSURE_BLOCKED_BY_AML];
