// R-F42 — milestone auto-completion for the tasks in the closure policy.
// Registered beside the automation engine. Completion always re-reads the
// live row. An already-COMPLETED task is a no-op. SUPERSEDED and CANCELLED
// rows are not selected. S1 and S3 are never completed here.

import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  amlVerifications,
  automationTasks,
  properties,
  propertyParties,
  transactions,
  type AutomationTask,
} from "@aee/db";
import type { DomainEvent, AgentEngineEasyEventType } from "@aee/events";
import { computeFundsReconciliation } from "../transactionFunds.js";
import { completeAutomationTask } from "./tasks.js";
import { isAutomationTaskKey, taskKeysForMilestone } from "./closurePolicy.js";
import type { AutomationTaskKey } from "./types.js";

export const CLOSURE_AUTO_COMPLETE_EVENT_TYPES = [
  "CONTRACT_SIGNED",
  "CONTRACT_EXCHANGED",
  "TRANSACTION_UNCONDITIONAL",
  "SETTLEMENT_SCHEDULED",
  "SETTLEMENT_COMPLETED",
  "AGENT_PAID",
  "FUNDS_RECEIVED",
  "COMMISSION_CALCULATED",
  "TRANSACTION_CLOSED",
  "AML_COMPLETED",
  "LISTING_LIVE",
] as const satisfies readonly AgentEngineEasyEventType[];

export interface ClosureMilestone {
  brokerageId: number;
  propertyId: number | null;
  transactionId: number | null;
  eventType: string;
  eventId: string;
  correlationId?: string | null;
}

export async function handleClosureAutoComplete(event: DomainEvent): Promise<void> {
  if (!event.brokerageId) return;
  await completeSatisfiedAutomationTasks({
    brokerageId: event.brokerageId,
    propertyId: event.propertyId,
    transactionId: event.transactionId,
    eventType: event.eventType,
    eventId: event.id,
    correlationId: event.correlationId,
  });
}

export async function completeSatisfiedAutomationTasks(milestone: ClosureMilestone): Promise<void> {
  const keys = taskKeysForMilestone(milestone.eventType);
  if (keys.length === 0 || !milestone.brokerageId) return;

  const candidates = await loadCandidateTasks(milestone, keys);
  for (const task of candidates) {
    if (task.brokerageId !== milestone.brokerageId) continue;
    if (milestone.propertyId != null && task.propertyId !== milestone.propertyId) continue;
    if (!isAutomationTaskKey(task.taskKey) || !keys.includes(task.taskKey)) continue;
    const evidence = await readLiveEvidence(task, milestone);
    if (!evidence) continue;
    await completeAutomationTask({
      brokerageId: task.brokerageId,
      taskId: task.id,
      userId: null,
      mode: "system",
      milestone: {
        eventType: milestone.eventType,
        eventId: milestone.eventId,
        evidence,
        correlationId: milestone.correlationId ?? null,
      },
    });
  }
}

async function loadCandidateTasks(milestone: ClosureMilestone, taskKeys: AutomationTaskKey[]): Promise<AutomationTask[]> {
  if (milestone.transactionId) {
    return db
      .select()
      .from(automationTasks)
      .where(
        and(
          eq(automationTasks.brokerageId, milestone.brokerageId),
          eq(automationTasks.transactionId, milestone.transactionId),
          eq(automationTasks.status, "ACTIVE"),
          inArray(automationTasks.taskKey, taskKeys),
        ),
      );
  }
  if (!milestone.propertyId) return [];
  return db
    .select()
    .from(automationTasks)
    .where(
      and(
        eq(automationTasks.brokerageId, milestone.brokerageId),
        eq(automationTasks.propertyId, milestone.propertyId),
        isNull(automationTasks.transactionId),
        eq(automationTasks.status, "ACTIVE"),
        inArray(automationTasks.taskKey, taskKeys),
      ),
    );
}

async function readLiveEvidence(task: AutomationTask, milestone: ClosureMilestone): Promise<Record<string, unknown> | null> {
  switch (task.taskKey as AutomationTaskKey) {
    case "PREPARE_CONTRACT_DOCUMENTATION": {
      const transaction = await loadTransaction(task.transactionId);
      if (!transaction?.contractDate) return null;
      return { contractDate: transaction.contractDate.toISOString() };
    }
    case "CONFIRM_TRANSACTION_LEGAL_REPRESENTATIVES":
    case "IDENTIFY_MISSING_LEGAL_REPRESENTATIVES": {
      const transaction = await loadTransaction(task.transactionId);
      const reps = legalRepresentatives(transaction);
      if (!reps) return null;
      return reps;
    }
    case "RECORD_TRANSACTION_DATES_CONDITIONS": {
      const transaction = await loadTransaction(task.transactionId);
      if (!transaction?.contractDate || !transaction.settlementDate) return null;
      return {
        contractDate: transaction.contractDate.toISOString(),
        settlementDate: transaction.settlementDate.toISOString(),
      };
    }
    case "CONFIRM_CONTRACT_EXCHANGE_STATUS": {
      const transaction = await loadTransaction(task.transactionId);
      if (!transaction?.exchangedAt) return null;
      return { exchangedAt: transaction.exchangedAt.toISOString() };
    }
    case "FOLLOWUP_EXCHANGE_UNCONDITIONAL_STATUS":
    case "CAPTURE_CONTRACT_CONDITION_DATES":
    case "CONDITION_DEADLINE_FOLLOWUP":
    case "IDENTIFY_UNRESOLVED_TRANSACTION_CONDITIONS": {
      const transaction = await loadTransaction(task.transactionId);
      if (!transaction) return null;
      if (milestone.eventType === "SETTLEMENT_COMPLETED") {
        if (!transaction.settlementCompletedAt) return null;
        return { settlementCompletedAt: transaction.settlementCompletedAt.toISOString() };
      }
      if (!transaction.unconditionalAt) return null;
      return { unconditionalAt: transaction.unconditionalAt.toISOString() };
    }
    case "PREPARE_SETTLEMENT_TRACKING": {
      const transaction = await loadTransaction(task.transactionId);
      if (!transaction?.settlementDate) return null;
      return { settlementDate: transaction.settlementDate.toISOString() };
    }
    case "IDENTIFY_MISSING_TRANSACTION_INFO":
    case "CONFIRM_SETTLEMENT_DATE_TIME":
    case "PRE_SETTLEMENT_MILESTONE_REMINDER":
    case "PREPARE_INTERNAL_SETTLEMENT_TASKS": {
      const transaction = await loadTransaction(task.transactionId);
      if (!transaction?.settlementCompletedAt) return null;
      return { settlementCompletedAt: transaction.settlementCompletedAt.toISOString() };
    }
    case "PREPARE_COMMISSION_PROCESSING_CHECKLIST": {
      const transaction = await loadTransaction(task.transactionId);
      if (!transaction?.commissionCalculatedAt || !transaction.agentPaidAt) return null;
      const funds = computeFundsReconciliation(transaction);
      if (funds.status !== "MATCHED") return null;
      return {
        commissionCalculatedAt: transaction.commissionCalculatedAt.toISOString(),
        agentPaidAt: transaction.agentPaidAt.toISOString(),
        fundsStatus: funds.status,
        expectedCents: funds.expectedCents,
        receivedCents: funds.receivedCents,
      };
    }
    case "PREPARE_PROPERTY_TRANSACTION_CLOSURE": {
      const transaction = await loadTransaction(task.transactionId);
      if (!transaction?.closedAt && transaction?.status !== "Closed") return null;
      return { closedAt: transaction.closedAt?.toISOString() ?? null, status: transaction.status };
    }
    case "CONFIRM_AML_CTF_REQUIREMENTS":
      return sellerAmlEvidence(task.propertyId);
    case "VERIFY_REGISTERED_PROPERTY_OWNERS":
    case "PREPARE_LISTING_LAUNCH_REQUIREMENTS":
    case "REQUEST_MISSING_PROPERTY_CAMPAIGN_INFO":
      return listingLiveEvidence(task.propertyId);
    default:
      return null;
  }
}

async function loadTransaction(transactionId: number | null) {
  if (!transactionId) return null;
  const [row] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
  return row ?? null;
}

function legalRepresentatives(
  transaction: { legalRepresentatives: unknown } | null,
): { sellerSolicitorPartyId: number; buyerSolicitorPartyId: number } | null {
  const reps = (transaction?.legalRepresentatives ?? null) as {
    sellerSolicitorPartyId?: number | null;
    buyerSolicitorPartyId?: number | null;
  } | null;
  if (typeof reps?.sellerSolicitorPartyId !== "number" || typeof reps?.buyerSolicitorPartyId !== "number") return null;
  return {
    sellerSolicitorPartyId: reps.sellerSolicitorPartyId,
    buyerSolicitorPartyId: reps.buyerSolicitorPartyId,
  };
}

async function sellerAmlEvidence(propertyId: number): Promise<Record<string, unknown> | null> {
  const links = await db
    .select()
    .from(propertyParties)
    .where(and(eq(propertyParties.propertyId, propertyId), eq(propertyParties.role, "Seller")));
  if (links.length === 0) return null;
  const partyIds = links.map((link) => link.partyId);
  const verifications = await db
    .select()
    .from(amlVerifications)
    .where(and(eq(amlVerifications.propertyId, propertyId), inArray(amlVerifications.partyId, partyIds)));
  const allComplete = partyIds.every((id) => verifications.some((row) => row.partyId === id && row.status === "Complete"));
  if (!allComplete) return null;
  return { sellerPartyIds: partyIds, status: "Complete" };
}

async function listingLiveEvidence(propertyId: number): Promise<Record<string, unknown> | null> {
  const [property] = await db.select({ listingStatus: properties.listingStatus }).from(properties).where(eq(properties.id, propertyId));
  if (property?.listingStatus !== "Listed") return null;
  return { listingStatus: property.listingStatus };
}
