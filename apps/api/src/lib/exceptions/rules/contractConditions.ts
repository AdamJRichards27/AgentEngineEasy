// Agent Engine 2.0 — Exception & Risk Engine (Priority 4).
// Category D — Contract & Conditions (Build Instructions §10.D, rules 15-21,
// plus 29 which is merged into D20 — see that rule's own comment for why).

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, transactions, transactionConditions, properties, type Property, type Transaction, type TransactionCondition } from "@aee/db";
import type { RiskRule } from "../registry.js";
import type { RiskFinding } from "../types.js";
import { dedupKey, escalatesAtFor, resolveDefaultOwner, severityForDeadline } from "./shared.js";

async function loadOpenTransactionsWithProperty(brokerageId: number): Promise<Array<{ transaction: Transaction; property: Property }>> {
  const rows = await db
    .select({ transaction: transactions, property: properties })
    .from(transactions)
    .innerJoin(properties, eq(transactions.propertyId, properties.id))
    .where(and(eq(properties.brokerageId, brokerageId), isNull(transactions.closedAt)));
  return rows;
}

const D15_LEGAL_REPS: RiskRule = {
  ruleId: "D15_CONTRACT_MISSING_LEGAL_REPRESENTATIVES",
  version: 1,
  category: "CONTRACT_CONDITIONS",
  name: "Contract missing required legal representatives",
  description: "A transaction has a contract date but no seller and/or buyer solicitor recorded.",
  triggerEventTypes: ["CONTRACT_SIGNED", "CONTRACT_PREPARATION_STARTED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await loadOpenTransactionsWithProperty(brokerageId);
    const findings: RiskFinding[] = [];
    for (const { transaction, property } of rows) {
      if (!transaction.contractDate) continue;
      const reps = (transaction.legalRepresentatives ?? {}) as { sellerSolicitorPartyId?: number; buyerSolicitorPartyId?: number };
      const missing: string[] = [];
      if (!reps.sellerSolicitorPartyId) missing.push("seller solicitor");
      if (!reps.buyerSolicitorPartyId) missing.push("buyer solicitor");
      if (missing.length === 0) continue;
      const owner = resolveDefaultOwner(property, true);
      findings.push({
        ruleId: D15_LEGAL_REPS.ruleId,
        ruleVersion: D15_LEGAL_REPS.version,
        category: "CONTRACT_CONDITIONS",
        severity: "ATTENTION",
        title: "Legal representatives missing on contract",
        problemDescription: `The contract for this transaction is missing: ${missing.join(", ")}.`,
        businessImpact: "Settlement and exchange correspondence cannot be directed correctly without both parties' solicitors on record.",
        detectedCause: "No legal representative recorded against the transaction for the missing role(s).",
        ...owner,
        propertyId: property.id,
        transactionId: transaction.id,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Record the missing solicitor(s) against this transaction.",
        resolutionRequirements: "Both sellerSolicitorPartyId and buyerSolicitorPartyId must be recorded.",
        dismissible: false,
        sourceRecordType: "transaction",
        sourceRecordId: String(transaction.id),
        dedupKey: dedupKey(D15_LEGAL_REPS.ruleId, brokerageId, transaction.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { missingFields: missing.join(",") },
      });
    }
    return findings;
  },
};

const D16_CONDITION_MISSING_DUE_DATE: RiskRule = {
  ruleId: "D16_CONDITION_MISSING_DUE_DATE",
  version: 1,
  category: "CONTRACT_CONDITIONS",
  name: "Contract condition missing a due date",
  description: "A Pending transaction condition has no due date recorded.",
  triggerEventTypes: ["CONTRACT_EXCHANGED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ condition: transactionConditions, transaction: transactions, property: properties })
      .from(transactionConditions)
      .innerJoin(transactions, eq(transactionConditions.transactionId, transactions.id))
      .innerJoin(properties, eq(transactions.propertyId, properties.id))
      .where(and(eq(properties.brokerageId, brokerageId), eq(transactionConditions.status, "Pending"), isNull(transactionConditions.dueDate)));
    return rows.map(({ condition, transaction, property }) => {
      const owner = resolveDefaultOwner(property, true);
      return {
        ruleId: D16_CONDITION_MISSING_DUE_DATE.ruleId,
        ruleVersion: D16_CONDITION_MISSING_DUE_DATE.version,
        category: "CONTRACT_CONDITIONS" as const,
        severity: "ATTENTION" as const,
        title: `Condition "${condition.description}" has no due date`,
        problemDescription: `The contract condition "${condition.description}" is Pending but has no due date, so it cannot be tracked for overdue risk.`,
        businessImpact: "An undated condition cannot be escalated as it approaches or passes its deadline, and may be missed entirely.",
        detectedCause: "transactionConditions.dueDate is null while status is Pending.",
        ...owner,
        propertyId: property.id,
        transactionId: condition.transactionId,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Set a due date for this condition.",
        resolutionRequirements: "A due date is recorded, or the condition is resolved (Satisfied/Waived/Failed/NotApplicable).",
        dismissible: false,
        sourceRecordType: "transaction_condition",
        sourceRecordId: String(condition.id),
        dedupKey: dedupKey(D16_CONDITION_MISSING_DUE_DATE.ruleId, brokerageId, condition.id),
        recurrenceMode: "REOPEN" as const,
        requiresFinancialEntitlement: false,
        metadata: { conditionId: condition.id, conditionDescription: condition.description.slice(0, 200) },
      };
    });
  },
};

function isFinanceCondition(description: string): boolean {
  return /finance/i.test(description);
}

function conditionDeadlineFinding(
  rule: { ruleId: string; version: number },
  condition: TransactionCondition,
  property: Property,
  now: Date,
  approachingDays: number,
  isFinance: boolean,
): RiskFinding {
  const dueDate = condition.dueDate!;
  const severity = severityForDeadline(now, dueDate, approachingDays, isFinance ? 0 : 14);
  const owner = resolveDefaultOwner(property, true);
  const overdue = dueDate.getTime() < now.getTime();
  return {
    ruleId: rule.ruleId,
    ruleVersion: rule.version,
    category: "CONTRACT_CONDITIONS",
    severity,
    title: overdue ? `Condition "${condition.description}" is overdue` : `Condition "${condition.description}" is approaching its due date`,
    problemDescription: overdue
      ? `The condition "${condition.description}" was due ${dueDate.toDateString()} and is still Pending.`
      : `The condition "${condition.description}" is due ${dueDate.toDateString()} and is still Pending.`,
    businessImpact: isFinance
      ? "An unresolved finance condition can delay or void the contract if not satisfied, waived, or extended before deadline."
      : "An unresolved condition can delay exchange, settlement, or void the contract if it lapses unaddressed.",
    detectedCause: "transactionConditions.status is Pending relative to dueDate.",
    ...owner,
    propertyId: property.id,
    transactionId: condition.transactionId,
    dueAt: dueDate,
    escalatesAt: escalatesAtFor(dueDate, isFinance ? 0 : 14),
    recommendedAction: "Resolve the condition (satisfied, waived, or failed) or agree an extension before the deadline.",
    resolutionRequirements: "The condition's status changes to Satisfied, Waived, Failed, or NotApplicable.",
    dismissible: false,
    sourceRecordType: "transaction_condition",
    sourceRecordId: String(condition.id),
    dedupKey: dedupKey(rule.ruleId, property.brokerageId, condition.id),
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
    metadata: { conditionId: condition.id, conditionDescription: condition.description.slice(0, 200), dueDate: dueDate.toISOString() },
  };
}

const D17_18_CONDITION_DUE: RiskRule = {
  ruleId: "D17_18_CONDITION_APPROACHING_OR_OVERDUE",
  version: 1,
  category: "CONTRACT_CONDITIONS",
  name: "Condition approaching or past its due date",
  description: "Merges catalogue #17 (approaching) and #18 (overdue): the same condition's severity escalates along one continuum rather than opening a second exception when it crosses from approaching into overdue.",
  triggerEventTypes: [],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ condition: transactionConditions, property: properties })
      .from(transactionConditions)
      .innerJoin(transactions, eq(transactionConditions.transactionId, transactions.id))
      .innerJoin(properties, eq(transactions.propertyId, properties.id))
      .where(and(eq(properties.brokerageId, brokerageId), eq(transactionConditions.status, "Pending"), sql`${transactionConditions.dueDate} is not null`));
    return rows
      .filter(({ condition }) => !isFinanceCondition(condition.description))
      .map(({ condition, property }) => conditionDeadlineFinding(D17_18_CONDITION_DUE, condition, property, now, 7, false));
  },
};

const D19_FINANCE_CONDITION: RiskRule = {
  ruleId: "D19_FINANCE_CONDITION_NEAR_DEADLINE",
  version: 1,
  category: "CONTRACT_CONDITIONS",
  name: "Finance condition unresolved near deadline",
  description: "A finance-related condition (description containing \"finance\") is approaching or past its due date — tracked separately from D17/18 with a tighter escalation (AT_RISK the moment it's overdue) because an unresolved finance condition risks the whole contract.",
  triggerEventTypes: ["FINANCE_APPROVED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ condition: transactionConditions, property: properties })
      .from(transactionConditions)
      .innerJoin(transactions, eq(transactionConditions.transactionId, transactions.id))
      .innerJoin(properties, eq(transactions.propertyId, properties.id))
      .where(and(eq(properties.brokerageId, brokerageId), eq(transactionConditions.status, "Pending"), sql`${transactionConditions.dueDate} is not null`));
    return rows
      .filter(({ condition }) => isFinanceCondition(condition.description))
      .map(({ condition, property }) => conditionDeadlineFinding(D19_FINANCE_CONDITION, condition, property, now, 7, true));
  },
};

// D20 merges catalogue #20 ("transaction state conflicts with unresolved
// blocking conditions") and #29 ("settlement approaching with unresolved
// conditions") into one rule for the same reason D17/18 were merged — both
// describe the identical underlying fact (a Pending blocking condition
// while settlement approaches or is overdue) and would otherwise open two
// exceptions for one problem. This is the rule behind the spec's named
// Critical scenario (Build Instructions §24): "Settlement becomes due with
// a blocking contract condition unresolved -> severity escalates to
// Critical -> closure remains blocked".
const D20_29_SETTLEMENT_BLOCKED_BY_CONDITION: RiskRule = {
  ruleId: "D20_29_SETTLEMENT_BLOCKED_BY_UNRESOLVED_CONDITION",
  version: 1,
  category: "CONTRACT_CONDITIONS",
  name: "Settlement approaching or overdue with an unresolved blocking condition",
  description: "A transaction has a settlement date and at least one still-Pending condition — merges catalogue #20 and #29.",
  triggerEventTypes: ["SETTLEMENT_SCHEDULED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await loadOpenTransactionsWithProperty(brokerageId);
    const findings: RiskFinding[] = [];
    for (const { transaction, property } of rows) {
      if (!transaction.settlementDate || transaction.settlementCompletedAt) continue;
      const pending = await db
        .select()
        .from(transactionConditions)
        .where(and(eq(transactionConditions.transactionId, transaction.id), eq(transactionConditions.status, "Pending")));
      if (pending.length === 0) continue;

      const settlementDate = transaction.settlementDate;
      const severity = severityForDeadline(now, settlementDate, 7, 0); // CRITICAL the instant settlement is overdue while blocked
      const owner = resolveDefaultOwner(property, true);
      findings.push({
        ruleId: D20_29_SETTLEMENT_BLOCKED_BY_CONDITION.ruleId,
        ruleVersion: D20_29_SETTLEMENT_BLOCKED_BY_CONDITION.version,
        category: "CONTRACT_CONDITIONS",
        severity,
        title: settlementDate.getTime() < now.getTime() ? "Settlement is overdue with unresolved conditions" : "Settlement is approaching with unresolved conditions",
        problemDescription: `Settlement is scheduled for ${settlementDate.toDateString()} but ${pending.length} condition(s) remain Pending: ${pending.map((c) => c.description).join("; ")}.`,
        businessImpact: "Settlement cannot safely proceed while a blocking condition is unresolved — this risks default, delay, or an unsafe closure.",
        detectedCause: "transactions.settlementDate is set and >=1 transactionConditions row is still Pending.",
        ...owner,
        propertyId: property.id,
        transactionId: transaction.id,
        dueAt: settlementDate,
        escalatesAt: settlementDate,
        recommendedAction: "Resolve every Pending condition before settlement, or formally reschedule settlement.",
        resolutionRequirements: "No transactionConditions row for this transaction remains Pending.",
        dismissible: false,
        sourceRecordType: "transaction",
        sourceRecordId: String(transaction.id),
        dedupKey: dedupKey(D20_29_SETTLEMENT_BLOCKED_BY_CONDITION.ruleId, brokerageId, transaction.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { settlementDate: settlementDate.toISOString(), missingFields: pending.map((c) => c.description).join(",").slice(0, 200) },
      });
    }
    return findings;
  },
};

const D21_SETTLEMENT_DATE_MISSING: RiskRule = {
  ruleId: "D21_SETTLEMENT_DATE_MISSING_AFTER_UNCONDITIONAL",
  version: 1,
  category: "CONTRACT_CONDITIONS",
  name: "Settlement date missing after transaction became unconditional",
  description: "A transaction reached unconditionalAt but has no settlementDate recorded.",
  triggerEventTypes: ["TRANSACTION_UNCONDITIONAL"],
  async scanBrokerage(brokerageId, now) {
    const rows = await loadOpenTransactionsWithProperty(brokerageId);
    const findings: RiskFinding[] = [];
    for (const { transaction, property } of rows) {
      if (!transaction.unconditionalAt || transaction.settlementDate) continue;
      const daysSince = (now.getTime() - transaction.unconditionalAt.getTime()) / (1000 * 60 * 60 * 24);
      const severity = daysSince >= 7 ? "AT_RISK" : "ATTENTION";
      const owner = resolveDefaultOwner(property, true);
      findings.push({
        ruleId: D21_SETTLEMENT_DATE_MISSING.ruleId,
        ruleVersion: D21_SETTLEMENT_DATE_MISSING.version,
        category: "CONTRACT_CONDITIONS",
        severity,
        title: "Settlement date not yet recorded",
        problemDescription: `This transaction became unconditional on ${transaction.unconditionalAt.toDateString()} but no settlement date has been recorded.`,
        businessImpact: "Without a settlement date, downstream settlement tasks and reminders cannot be scheduled.",
        detectedCause: "transactions.unconditionalAt is set and transactions.settlementDate is null.",
        ...owner,
        propertyId: property.id,
        transactionId: transaction.id,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Record the agreed settlement date for this transaction.",
        resolutionRequirements: "transactions.settlementDate is recorded.",
        dismissible: false,
        sourceRecordType: "transaction",
        sourceRecordId: String(transaction.id),
        dedupKey: dedupKey(D21_SETTLEMENT_DATE_MISSING.ruleId, brokerageId, transaction.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
      });
    }
    return findings;
  },
};

export const CONTRACT_CONDITIONS_RULES: RiskRule[] = [
  D15_LEGAL_REPS,
  D16_CONDITION_MISSING_DUE_DATE,
  D17_18_CONDITION_DUE,
  D19_FINANCE_CONDITION,
  D20_29_SETTLEMENT_BLOCKED_BY_CONDITION,
  D21_SETTLEMENT_DATE_MISSING,
];
