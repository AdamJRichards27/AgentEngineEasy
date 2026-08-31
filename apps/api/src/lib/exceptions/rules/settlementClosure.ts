// Agent Engine 2.0 — Exception & Risk Engine (Priority 4).
// Category F — Settlement & Closure (Build Instructions §10.F). #29 is
// merged into contractConditions.ts's D20_29 rule; #35 is explicitly
// deferred (see docs/exception-risk-engine/ARCHITECTURE.md) because it is
// already substantially mitigated by automation/tasks.ts's own
// supersede-on-material-change behaviour.

import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, transactions, properties, transactionConditions, automationTasks, auditLogs, amlVerifications, type Property, type Transaction } from "@aee/db";
import type { RiskRule } from "../registry.js";
import type { RiskFinding } from "../types.js";
import { dedupKey, resolveDefaultOwner } from "./shared.js";

async function loadOpenTransactions(brokerageId: number): Promise<Array<{ transaction: Transaction; property: Property }>> {
  return db
    .select({ transaction: transactions, property: properties })
    .from(transactions)
    .innerJoin(properties, eq(transactions.propertyId, properties.id))
    .where(eq(properties.brokerageId, brokerageId));
}

const F30_INCOMPLETE_MANDATORY_TASKS: RiskRule = {
  ruleId: "F30_SETTLEMENT_APPROACHING_INCOMPLETE_TASKS",
  version: 1,
  category: "SETTLEMENT_CLOSURE",
  name: "Settlement approaching with incomplete mandatory tasks",
  description: "An ACTIVE automation task for this transaction is due before its settlement date.",
  triggerEventTypes: ["SETTLEMENT_SCHEDULED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await loadOpenTransactions(brokerageId);
    const findings: RiskFinding[] = [];
    for (const { transaction, property } of rows) {
      if (!transaction.settlementDate || transaction.settlementCompletedAt) continue;
      const tasks = await db
        .select()
        .from(automationTasks)
        .where(and(eq(automationTasks.transactionId, transaction.id), eq(automationTasks.status, "ACTIVE"), isNotNull(automationTasks.dueAt)));
      const overdueOrDueBeforeSettlement = tasks.filter((t) => t.dueAt && t.dueAt.getTime() <= transaction.settlementDate!.getTime());
      if (overdueOrDueBeforeSettlement.length === 0) continue;
      const owner = resolveDefaultOwner(property, true);
      const settlementDate = transaction.settlementDate;
      const severity = settlementDate.getTime() < now.getTime() ? "AT_RISK" : "ATTENTION";
      findings.push({
        ruleId: F30_INCOMPLETE_MANDATORY_TASKS.ruleId,
        ruleVersion: F30_INCOMPLETE_MANDATORY_TASKS.version,
        category: "SETTLEMENT_CLOSURE",
        severity,
        title: "Mandatory settlement tasks still incomplete",
        problemDescription: `${overdueOrDueBeforeSettlement.length} task(s) due on or before settlement (${settlementDate.toDateString()}) are still active: ${overdueOrDueBeforeSettlement.map((t) => t.title).join("; ")}.`,
        businessImpact: "Incomplete pre-settlement tasks risk an unprepared or delayed settlement.",
        detectedCause: "automationTasks rows for this transaction are ACTIVE with a dueAt on or before settlementDate.",
        ...owner,
        propertyId: property.id,
        transactionId: transaction.id,
        dueAt: settlementDate,
        escalatesAt: settlementDate,
        recommendedAction: "Complete the outstanding settlement tasks before the settlement date.",
        resolutionRequirements: "Every such task reaches COMPLETED, or settlement is rescheduled.",
        dismissible: false,
        sourceRecordType: "transaction",
        sourceRecordId: String(transaction.id),
        dedupKey: dedupKey(F30_INCOMPLETE_MANDATORY_TASKS.ruleId, brokerageId, transaction.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
      });
    }
    return findings;
  },
};

const F31_SETTLEMENT_DATE_PASSED: RiskRule = {
  ruleId: "F31_SETTLEMENT_DATE_PASSED_WITHOUT_COMPLETION",
  version: 1,
  category: "SETTLEMENT_CLOSURE",
  name: "Settlement date passed without completion",
  description: "transactions.settlementDate is in the past and settlementCompletedAt is still null.",
  triggerEventTypes: [],
  async scanBrokerage(brokerageId, now) {
    const rows = await loadOpenTransactions(brokerageId);
    const findings: RiskFinding[] = [];
    for (const { transaction, property } of rows) {
      if (!transaction.settlementDate || transaction.settlementCompletedAt) continue;
      if (transaction.settlementDate.getTime() >= now.getTime()) continue;
      const owner = resolveDefaultOwner(property, true);
      findings.push({
        ruleId: F31_SETTLEMENT_DATE_PASSED.ruleId,
        ruleVersion: F31_SETTLEMENT_DATE_PASSED.version,
        category: "SETTLEMENT_CLOSURE",
        severity: "CRITICAL",
        title: "Settlement date has passed without completion",
        problemDescription: `Settlement was scheduled for ${transaction.settlementDate.toDateString()} and has not been recorded as complete.`,
        businessImpact: "A missed settlement date without a recorded reason is a serious risk to the transaction and possibly a contractual default.",
        detectedCause: "transactions.settlementDate < now and transactions.settlementCompletedAt is null.",
        ...owner,
        propertyId: property.id,
        transactionId: transaction.id,
        dueAt: transaction.settlementDate,
        escalatesAt: transaction.settlementDate,
        recommendedAction: "Confirm settlement status immediately and record completion, or reschedule with a documented reason.",
        resolutionRequirements: "transactions.settlementCompletedAt is recorded, or settlementDate is authoritatively rescheduled.",
        dismissible: false,
        sourceRecordType: "transaction",
        sourceRecordId: String(transaction.id),
        dedupKey: dedupKey(F31_SETTLEMENT_DATE_PASSED.ruleId, brokerageId, transaction.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
      });
    }
    return findings;
  },
};

const F32_CLOSURE_CONDITIONS_UNRESOLVED: RiskRule = {
  ruleId: "F32_CLOSURE_BLOCKED_BY_UNRESOLVED_CONDITION",
  version: 1,
  category: "SETTLEMENT_CLOSURE",
  name: "Settlement completed but a blocking condition remains unresolved",
  description: "settlementCompletedAt is set, closedAt is null, and a transactionConditions row is still Pending — the condition-focused sibling of E28 (AML-focused) for the same post-settlement window.",
  triggerEventTypes: ["SETTLEMENT_COMPLETED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await loadOpenTransactions(brokerageId);
    const findings: RiskFinding[] = [];
    for (const { transaction, property } of rows) {
      if (!transaction.settlementCompletedAt || transaction.closedAt) continue;
      const daysSince = (now.getTime() - transaction.settlementCompletedAt.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 3) continue;
      const pending = await db.select().from(transactionConditions).where(and(eq(transactionConditions.transactionId, transaction.id), eq(transactionConditions.status, "Pending")));
      if (pending.length === 0) continue;
      const owner = resolveDefaultOwner(property, true);
      findings.push({
        ruleId: F32_CLOSURE_CONDITIONS_UNRESOLVED.ruleId,
        ruleVersion: F32_CLOSURE_CONDITIONS_UNRESOLVED.version,
        category: "SETTLEMENT_CLOSURE",
        severity: "AT_RISK",
        title: "Closure blocked by unresolved condition after settlement",
        problemDescription: `Settlement completed on ${transaction.settlementCompletedAt.toDateString()} but ${pending.length} condition(s) remain Pending.`,
        businessImpact: "The transaction record cannot be safely closed while a condition is still open.",
        detectedCause: "transactions.settlementCompletedAt is set, closedAt is null, and >=1 condition is still Pending.",
        ...owner,
        propertyId: property.id,
        transactionId: transaction.id,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Resolve the remaining condition(s) so this transaction can close cleanly.",
        resolutionRequirements: "No transactionConditions row for this transaction remains Pending.",
        dismissible: false,
        sourceRecordType: "transaction",
        sourceRecordId: String(transaction.id),
        dedupKey: dedupKey(F32_CLOSURE_CONDITIONS_UNRESOLVED.ruleId, brokerageId, transaction.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
      });
    }
    return findings;
  },
};

const F33_PREMATURE_CLOSURE_OVERRIDE: RiskRule = {
  ruleId: "F33_CLOSURE_ATTEMPTED_PREMATURELY",
  version: 1,
  category: "SETTLEMENT_CLOSURE",
  name: "Closure attempted prematurely (forced override used)",
  description: "auditLogs contains a transaction_closed_forced entry for this transaction — an authorised override was used to close it despite an unresolved requirement.",
  triggerEventTypes: ["TRANSACTION_CLOSED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ log: auditLogs, property: properties })
      .from(auditLogs)
      .innerJoin(properties, eq(auditLogs.propertyId, properties.id))
      .where(and(eq(properties.brokerageId, brokerageId), eq(auditLogs.action, "transaction_closed_forced")));
    const findings: RiskFinding[] = [];
    for (const { log, property } of rows) {
      const owner = resolveDefaultOwner(property, true);
      findings.push({
        ruleId: F33_PREMATURE_CLOSURE_OVERRIDE.ruleId,
        ruleVersion: F33_PREMATURE_CLOSURE_OVERRIDE.version,
        category: "SETTLEMENT_CLOSURE",
        severity: "CRITICAL",
        title: "Transaction was closed using a forced override",
        problemDescription: `This transaction (record ${log.recordId}) was closed with an override that bypassed a normal closure requirement.`,
        businessImpact: "A forced closure means a mandatory requirement was overridden — this must be reviewed to confirm it was appropriate.",
        detectedCause: "auditLogs.action = transaction_closed_forced.",
        ...owner,
        propertyId: property.id,
        transactionId: null,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Review the forced closure and confirm the override was appropriate; record the review outcome.",
        resolutionRequirements: "An authorised reviewer records that the override was appropriate (manual resolution with a reason).",
        dismissible: true,
        sourceRecordType: "audit_log",
        sourceRecordId: String(log.id),
        dedupKey: dedupKey(F33_PREMATURE_CLOSURE_OVERRIDE.ruleId, brokerageId, log.id),
        recurrenceMode: "NEW_OCCURRENCE",
        requiresFinancialEntitlement: false,
      });
    }
    return findings;
  },
};

const F34_CLOSED_WITH_CONTRADICTORY_BLOCKER: RiskRule = {
  ruleId: "F34_CLOSED_TRANSACTION_HAS_ACTIVE_BLOCKER",
  version: 1,
  category: "SETTLEMENT_CLOSURE",
  name: "Closed transaction has a contradictory active blocker",
  description: "transactions.closedAt is set but a transactionConditions row is still Pending, or a required party's AML is incomplete — a data-integrity conflict.",
  triggerEventTypes: ["TRANSACTION_CLOSED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ transaction: transactions, property: properties })
      .from(transactions)
      .innerJoin(properties, eq(transactions.propertyId, properties.id))
      .where(and(eq(properties.brokerageId, brokerageId), isNotNull(transactions.closedAt)));
    const findings: RiskFinding[] = [];
    for (const { transaction, property } of rows) {
      const pending = await db.select().from(transactionConditions).where(and(eq(transactionConditions.transactionId, transaction.id), eq(transactionConditions.status, "Pending")));
      const partyIds = [...(((transaction.sellerPartyIds as number[] | null) ?? [])), ...(((transaction.buyerPartyIds as number[] | null) ?? []))];
      const amlRows = partyIds.length ? await db.select().from(amlVerifications).where(and(eq(amlVerifications.propertyId, property.id), inArray(amlVerifications.partyId, partyIds))) : [];
      const amlIncomplete = partyIds.filter((id) => {
        const row = amlRows.find((a) => a.partyId === id);
        return !row || row.status !== "Complete";
      });
      if (pending.length === 0 && amlIncomplete.length === 0) continue;
      const owner = resolveDefaultOwner(property, true);
      const reasons = [
        pending.length ? `${pending.length} condition(s) still Pending` : null,
        amlIncomplete.length ? `${amlIncomplete.length} part(y/ies) with incomplete AML/CTF` : null,
      ].filter(Boolean);
      findings.push({
        ruleId: F34_CLOSED_WITH_CONTRADICTORY_BLOCKER.ruleId,
        ruleVersion: F34_CLOSED_WITH_CONTRADICTORY_BLOCKER.version,
        category: "SETTLEMENT_CLOSURE",
        severity: "CRITICAL",
        title: "Closed transaction has an unresolved blocker",
        problemDescription: `This transaction is marked closed but still has: ${reasons.join(", ")}.`,
        businessImpact: "A closed transaction with an unresolved blocker is a data-integrity conflict that must be investigated — the closure may be unsafe or the blocker stale.",
        detectedCause: "transactions.closedAt is set while a blocking condition or AML requirement remains unresolved.",
        ...owner,
        propertyId: property.id,
        transactionId: transaction.id,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Investigate and correct the contradictory state through the authorised pathway (resolve the blocker, or correct the closure record).",
        resolutionRequirements: "No blocking condition remains Pending and every required party's AML reaches Complete.",
        dismissible: false,
        sourceRecordType: "transaction",
        sourceRecordId: String(transaction.id),
        dedupKey: dedupKey(F34_CLOSED_WITH_CONTRADICTORY_BLOCKER.ruleId, brokerageId, transaction.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
      });
    }
    return findings;
  },
};

export const SETTLEMENT_CLOSURE_RULES: RiskRule[] = [
  F30_INCOMPLETE_MANDATORY_TASKS,
  F31_SETTLEMENT_DATE_PASSED,
  F32_CLOSURE_CONDITIONS_UNRESOLVED,
  F33_PREMATURE_CLOSURE_OVERRIDE,
  F34_CLOSED_WITH_CONTRADICTORY_BLOCKER,
];
