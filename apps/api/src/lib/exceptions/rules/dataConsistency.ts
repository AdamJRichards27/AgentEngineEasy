// Agent Engine 2.0 — Exception & Risk Engine (Priority 4).
// Category DATA_CONSISTENCY — Part B Stage 4. Closes the two concrete open
// items Part B Stage 2's docs/LEGACY_DATA_CLASSIFICATION.md explicitly
// handed to this stage (see that doc's Finding 3 and Finding 4): a
// Transaction's derived properties.workflowStage/workflowSteps projection
// and a property's derived properties.amlStatusSummary projection can each
// drift out of sync with the live state they're supposed to mirror,
// because the write that produces them is not atomic with the canonical
// write that should trigger it (Finding 3: acceptOffer/recordContractSigned/
// scheduleSettlement/recordFundsReceived/recordAgentPaid in
// lib/transactions.ts; Finding 4: the six
// refreshReadyToListSteps(...).catch(...) best-effort call sites across
// lib/aml.ts/lib/documents.ts). Both rules below reuse the exact same pure
// derivations the real write paths use (computeTransactionStepUpdates,
// summariseAmlStatuses — both exported from lib/workflowSteps.ts
// specifically for this) rather than re-deriving "what's correct" a second
// way, so this catalogue's own notion of correct can never itself drift
// from what the app actually computes (the same "one function, not two"
// discipline engine.ts/model.ts already apply between their event-driven
// and time-driven dispatch paths).
//
// Deliberately does NOT re-implement Finding 3's fix (making the five
// call sites atomic) or Finding 4's fix (making the refresh reliable) —
// both remain out of scope for this stage, same as Stage 2 left them.
// This is detection plus an operator-facing remediation action
// (resyncTransactionProjection / refreshReadyToListSteps, exposed via
// POST /transactions/:id/resync-projection and
// POST /properties/:id/resync-aml-summary), not a structural fix of the
// non-atomicity itself.

import { and, eq, inArray } from "drizzle-orm";
import { db, properties, propertyParties, amlVerifications, transactions, workflows, workflowSteps } from "@aee/db";
import type { RiskRule } from "../registry.js";
import type { RiskFinding, RiskExceptionSeverity } from "../types.js";
import { dedupKey, resolveDefaultOwner } from "./shared.js";
import { computeTransactionStepUpdates, summariseAmlStatuses, TRANSACTION_STEP_KEYS } from "../../workflowSteps.js";

// ---------------------------------------------------------------------
// DC01 — Transaction workflow projection drift (Finding 3).
// ---------------------------------------------------------------------

/**
 * The same status -> stage mapping lib/transactions.ts's own
 * resyncTransactionProjection() (via expectedWorkflowStageForStatus) uses
 * — see that function's doc comment for the full rationale: this is keyed
 * off transaction.status rather than raw field presence (e.g.
 * settlementDate, which can already be set at offer-acceptance time, well
 * before scheduleSettlement is ever called) so a healthy Under-Offer or
 * Contract-stage transaction is never misclassified as drifted. Status
 * only ever advances at the exact four call sites that also write
 * workflowStage in the same statement, so it's the reliable signal here.
 * Deliberately duplicated rather than shared — if a future change touches
 * which stage any of those four call sites writes, BOTH that function and
 * this one need the matching update in the same PR, or detection and
 * remediation will disagree with the app's real behaviour.
 */
function expectedWorkflowStageFor(transaction: { status: string }): string {
  switch (transaction.status) {
    case "Closed":
      return "Closed";
    case "Settled":
    case "SettlementScheduled":
      return "Settlement";
    case "UnderContract":
      return "Contract";
    case "ContractPreparation":
    default:
      return "Under Offer";
  }
}

const DC01_TRANSACTION_PROJECTION_DRIFT: RiskRule = {
  ruleId: "DC01_TRANSACTION_PROJECTION_DRIFT",
  version: 1,
  category: "DATA_CONSISTENCY",
  name: "Transaction workflow projection has drifted",
  description:
    "properties.workflowStage and/or this Transaction's workflowSteps rows no longer match what this transaction's own canonical fields (status, contractDate, settlementDate, settlementCompletedAt, agentPaidAt, fundsReceivedCents) derive — the crash-window risk left open by acceptOffer/recordContractSigned/scheduleSettlement/recordFundsReceived/recordAgentPaid in lib/transactions.ts, none of which commit their properties/workflowSteps writes atomically with the transactions write itself (Part B Stage 2, Finding 3).",
  triggerEventTypes: ["OFFER_ACCEPTED", "CONTRACT_SIGNED", "SETTLEMENT_SCHEDULED", "SETTLEMENT_COMPLETED", "FUNDS_RECEIVED", "AGENT_PAID", "TRANSACTION_CLOSED"],
  async scanBrokerage(brokerageId, _now) {
    const rows = await db
      .select({ transaction: transactions, property: properties })
      .from(transactions)
      .innerJoin(properties, eq(transactions.propertyId, properties.id))
      .where(eq(properties.brokerageId, brokerageId));
    if (rows.length === 0) return [];

    const propertyIds = rows.map((r) => r.property.id);
    const workflowRows = await db
      .select()
      .from(workflows)
      .where(and(inArray(workflows.propertyId, propertyIds), eq(workflows.workflowType, "Transaction")));
    const workflowByPropertyId = new Map(workflowRows.map((w) => [w.propertyId, w]));

    const workflowIds = workflowRows.map((w) => w.id);
    const stepRows = workflowIds.length ? await db.select().from(workflowSteps).where(inArray(workflowSteps.workflowId, workflowIds)) : [];
    const stepsByWorkflowId = new Map<number, typeof stepRows>();
    for (const step of stepRows) {
      const list = stepsByWorkflowId.get(step.workflowId) ?? [];
      list.push(step);
      stepsByWorkflowId.set(step.workflowId, list);
    }

    const findings: RiskFinding[] = [];
    for (const { transaction, property } of rows) {
      const expectedStage = expectedWorkflowStageFor(transaction);
      const stageDrifted = property.workflowStage !== expectedStage;

      const workflow = workflowByPropertyId.get(property.id);
      const steps = workflow ? (stepsByWorkflowId.get(workflow.id) ?? []) : [];
      const stepByKey = new Map(steps.map((s) => [s.stepKey, s]));
      const computed = computeTransactionStepUpdates(transaction);
      const driftedSteps = workflow
        ? TRANSACTION_STEP_KEYS.filter((key) => {
            const actual = stepByKey.get(key);
            if (!actual) return false; // a missing step row entirely is a different, more fundamental problem than this rule's territory
            const expected = computed[key];
            return (
              actual.status !== expected.status ||
              (actual.blockedReason ?? null) !== (expected.blockedReason ?? null) ||
              (actual.completedAt?.getTime() ?? null) !== (expected.completedAt?.getTime() ?? null)
            );
          })
        : [];

      if (!stageDrifted && driftedSteps.length === 0) continue;

      const owner = resolveDefaultOwner(property, true);
      // Stage drift is the more consequential half — the Property
      // Workspace's own "what needs to happen next" logic (and every rule
      // elsewhere in this catalogue that branches on workflowStage) reads
      // that field directly, so a wrong value can misrepresent what stage
      // the transaction is genuinely at. Steps-only drift is confusing but
      // narrower in effect, so it stays one notch down (Build Instructions
      // §6: severity assigned through explicit rules, not left implicit).
      const severity: RiskExceptionSeverity = stageDrifted ? "AT_RISK" : "ATTENTION";

      const parts: string[] = [];
      if (stageDrifted) parts.push(`properties.workflowStage is "${property.workflowStage}", expected "${expectedStage}"`);
      if (driftedSteps.length > 0) parts.push(`workflow step(s) ${driftedSteps.join(", ")} do not match this transaction's own fields`);

      findings.push({
        ruleId: DC01_TRANSACTION_PROJECTION_DRIFT.ruleId,
        ruleVersion: DC01_TRANSACTION_PROJECTION_DRIFT.version,
        category: "DATA_CONSISTENCY",
        severity,
        title: "Transaction workflow projection has drifted",
        problemDescription: `This transaction's derived workflow projection no longer matches its own canonical fields: ${parts.join("; ")}.`,
        businessImpact:
          "A stale workflowStage or workflow step can misrepresent what still needs to happen on this transaction, or let a decision be made against the wrong state.",
        detectedCause:
          "The write that produced this transaction's current status/dates and the separate properties.workflowStage / Transaction workflowSteps refresh that should mirror it were not committed atomically together (Part B Stage 2, Finding 3).",
        ...owner,
        propertyId: property.id,
        transactionId: transaction.id,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Resync this transaction's workflow projection (POST /transactions/:id/resync-projection), or investigate why the underlying write did not commit as expected.",
        resolutionRequirements: "properties.workflowStage and every Transaction workflow step match what this transaction's own fields currently derive.",
        dismissible: false,
        sourceRecordType: "transaction",
        sourceRecordId: String(transaction.id),
        dedupKey: dedupKey(DC01_TRANSACTION_PROJECTION_DRIFT.ruleId, brokerageId, transaction.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: {
          expectedWorkflowStage: expectedStage,
          actualWorkflowStage: property.workflowStage,
          driftedWorkflowSteps: driftedSteps.join(","),
        },
      });
    }
    return findings;
  },
};

// ---------------------------------------------------------------------
// DC02 — Property AML status summary drift (Finding 4).
// ---------------------------------------------------------------------

/**
 * Which direction of drift actually matters for AML/CTF (Build
 * Instructions §10.E: a stale value must never make things look safer
 * than they are). properties.amlStatusSummary reading Complete when the
 * real derivation is not, or a genuine Review Required flag being hidden
 * behind a stale non-Review value, both risk a listing/settlement action
 * proceeding as if compliance were satisfied when it is not — CRITICAL.
 * Every other direction (stuck on Not Started/In Progress while the real
 * state has quietly moved forward) is still wrong and still worth fixing,
 * but it under- rather than over-states risk, so it stays one notch down.
 */
function amlDriftSeverity(expected: string, actual: string): RiskExceptionSeverity {
  if (actual === "Complete" && expected !== "Complete") return "CRITICAL";
  if (expected === "Review Required" && actual !== "Review Required") return "CRITICAL";
  return "ATTENTION";
}

const DC02_AML_STATUS_SUMMARY_DRIFT: RiskRule = {
  ruleId: "DC02_AML_STATUS_SUMMARY_DRIFT",
  version: 1,
  category: "DATA_CONSISTENCY",
  name: "Property AML status summary has drifted",
  description:
    "properties.amlStatusSummary no longer matches summariseAmlStatuses() over this property's current seller AML verification statuses — the risk left open by every refreshReadyToListSteps(...).catch((err) => ...) best-effort call site in lib/aml.ts/lib/documents.ts, whose failures are logged but never retried or surfaced (Part B Stage 2, Finding 4).",
  triggerEventTypes: ["AML_REQUESTED", "AML_COMPLETED", "AGENCY_AGREEMENT_SENT", "AGENCY_AGREEMENT_SIGNED"],
  async scanBrokerage(brokerageId, _now) {
    const propertyRows = await db.select().from(properties).where(eq(properties.brokerageId, brokerageId));
    if (propertyRows.length === 0) return [];
    const propertyIds = propertyRows.map((p) => p.id);

    const sellerLinks = await db
      .select()
      .from(propertyParties)
      .where(and(inArray(propertyParties.propertyId, propertyIds), eq(propertyParties.role, "Seller")));
    const sellerPartyIdsByProperty = new Map<number, number[]>();
    for (const link of sellerLinks) {
      const list = sellerPartyIdsByProperty.get(link.propertyId) ?? [];
      list.push(link.partyId);
      sellerPartyIdsByProperty.set(link.propertyId, list);
    }

    const allSellerPartyIds = [...new Set(sellerLinks.map((l) => l.partyId))];
    const amlRows = allSellerPartyIds.length ? await db.select().from(amlVerifications).where(inArray(amlVerifications.partyId, allSellerPartyIds)) : [];

    const findings: RiskFinding[] = [];
    for (const property of propertyRows) {
      const sellerPartyIds = sellerPartyIdsByProperty.get(property.id) ?? [];
      const statuses = sellerPartyIds
        .map((partyId) => amlRows.find((a) => a.partyId === partyId && a.propertyId === property.id)?.status)
        .filter((s): s is string => Boolean(s));
      const expected = summariseAmlStatuses(statuses);
      if (expected === property.amlStatusSummary) continue;

      const owner = resolveDefaultOwner(property, false);
      const severity = amlDriftSeverity(expected, property.amlStatusSummary);
      findings.push({
        ruleId: DC02_AML_STATUS_SUMMARY_DRIFT.ruleId,
        ruleVersion: DC02_AML_STATUS_SUMMARY_DRIFT.version,
        category: "DATA_CONSISTENCY",
        severity,
        title: "Property AML status summary has drifted",
        problemDescription: `properties.amlStatusSummary is "${property.amlStatusSummary}", but this property's seller AML verifications currently derive "${expected}".`,
        businessImpact:
          severity === "CRITICAL"
            ? "A stale AML status summary that looks more complete than reality can let a listing or settlement action proceed as if seller AML/CTF compliance were satisfied when it is not."
            : "A stale AML status summary can misrepresent whether a required seller AML/CTF step still needs attention.",
        detectedCause:
          "refreshReadyToListSteps did not successfully recompute properties.amlStatusSummary after an AML or document-package change (Part B Stage 2, Finding 4) — see GET /exceptions/ops/health's readyToListStepsRefreshFailures for how often that catch branch fires.",
        ...owner,
        propertyId: property.id,
        transactionId: null,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Resync this property's AML status summary (POST /properties/:id/resync-aml-summary).",
        resolutionRequirements: "properties.amlStatusSummary matches summariseAmlStatuses() over this property's current seller AML verification statuses.",
        dismissible: false,
        sourceRecordType: "property",
        sourceRecordId: String(property.id),
        dedupKey: dedupKey(DC02_AML_STATUS_SUMMARY_DRIFT.ruleId, brokerageId, property.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { expectedAmlStatusSummary: expected, actualAmlStatusSummary: property.amlStatusSummary },
      });
    }
    return findings;
  },
};

export const DATA_CONSISTENCY_RULES: RiskRule[] = [DC01_TRANSACTION_PROJECTION_DRIFT, DC02_AML_STATUS_SUMMARY_DRIFT];
