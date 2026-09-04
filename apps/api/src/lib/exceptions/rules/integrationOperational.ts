// Agent Engine 2.0 — Exception & Risk Engine (Priority 4) — AE Step 5
// remediation, Proof D (Workflow and Risk).
//
// A dead-lettered integration command (any capability, any domain proof —
// Proof A/B/C's mock adapters all travel through the SAME
// lib/integrations/outbox.ts, so this rule is generic across all of them,
// not proof-specific) is a material, unresolved failure: the outbox already
// exhausted its own retry budget (or hit a permanent rejection) before this
// rule ever sees it, so severity starts at AT_RISK, not INFORMATION/
// ATTENTION — no premature CRITICAL on a single failure, but this is never
// treated as "probably fine" either. Escalates to CRITICAL after 24h
// unresolved (mirrors rules/workflowOperational.ts's own G37 stale-execution
// ladder). This escalation ladder is platform-protected and NOT exposed to
// brokerage configuration in this build — see
// INTEGRATION_FOUNDATION_COMPLETION_REPORT.md's Proof D section for the
// explicit scoping note this reflects (brokerage-configurable
// retry/escalation policy is deferred scope; what ships here is a fixed,
// reviewed ladder no brokerage setting can loosen or disable).
//
// Property/transaction resolution goes through
// lib/integrations/sourceRecordResolvers.ts's generic registry — this rule
// module deliberately does NOT import communications/financial/launch model
// code directly (Section 4's provider-neutral foundation applies to the risk
// layer too: a workflow/risk rule depends on the integration foundation's
// own abstractions, never reaches into a specific domain proof's internals).
// A dead-lettered command whose sourceRecordType has no registered resolver,
// or whose resolver can't find/owns a same-tenant record, is skipped rather
// than guessed at — same discipline as G36's own "skip a row whose
// triggering event has no propertyId".

import { and, eq } from "drizzle-orm";
import { db, integrationOutbox, properties, type Property } from "@aee/db";
import type { RiskRule } from "../registry.js";
import type { RiskFinding } from "../types.js";
import { dedupKey, escalatesAtFor, resolveDefaultOwner, severityForDeadline } from "./shared.js";
import { resolveIntegrationSourceRecord } from "../../integrations/sourceRecordResolvers.js";

const CRITICAL_AFTER_DAYS = 1; // 24h unresolved — platform-protected, see this file's own header comment.

const H01_INTEGRATION_COMMAND_DEAD_LETTERED: RiskRule = {
  ruleId: "INTEGRATION_OPERATIONAL_COMMAND_DEAD_LETTERED",
  version: 1,
  category: "WORKFLOW_OPERATIONAL",
  name: "Integration command exhausted retries and was dead-lettered",
  description:
    "An outbound integration command (any capability/provider registered through lib/integrations/registry.ts — Proof A/B/C's mock adapters all travel through this same outbox) reached DEAD_LETTERED: either it exhausted its retry budget on a retryable failure, or the provider rejected it permanently. This is a material, already-confirmed failure by the time it reaches this rule, not a speculative one.",
  triggerEventTypes: ["INTEGRATION_COMMAND_DEAD_LETTERED"],
  async scanBrokerage(brokerageId, now) {
    const deadLettered = await db
      .select()
      .from(integrationOutbox)
      .where(and(eq(integrationOutbox.brokerageId, brokerageId), eq(integrationOutbox.status, "DEAD_LETTERED")));

    const findings: RiskFinding[] = [];
    const propertyCache = new Map<number, Property | null>();

    for (const command of deadLettered) {
      const resolved = await resolveIntegrationSourceRecord(command.sourceRecordType, brokerageId, command.sourceRecordId);
      if (!resolved) continue; // no registered resolver for this sourceRecordType, or the record no longer resolves in this tenant — skip rather than guess.

      let property = propertyCache.get(resolved.propertyId);
      if (property === undefined) {
        const [row] = await db.select().from(properties).where(eq(properties.id, resolved.propertyId));
        property = row ?? null;
        propertyCache.set(resolved.propertyId, property);
      }
      if (!property) continue;

      const owner = resolveDefaultOwner(property, resolved.transactionId !== null);
      // The dead-letter moment itself is treated as the "due" instant — the
      // outbox's own retry budget already ran out by the time this rule
      // sees the row, so there is no further grace period before this
      // becomes a real, actionable finding.
      const dueDate = command.updatedAt;
      const severity = severityForDeadline(now, dueDate, 0, CRITICAL_AFTER_DAYS);

      findings.push({
        ruleId: H01_INTEGRATION_COMMAND_DEAD_LETTERED.ruleId,
        ruleVersion: H01_INTEGRATION_COMMAND_DEAD_LETTERED.version,
        category: "WORKFLOW_OPERATIONAL",
        severity,
        title: "An integration command failed permanently and needs review",
        problemDescription: `Integration command ${command.id} (capability ${command.capability}) reached DEAD_LETTERED after ${command.attempts} attempt(s)${command.lastError ? `: ${command.lastError}` : "."}`,
        businessImpact: "An integration command that never succeeded means the external side-effect it represented (a send, a sync, a status update) never happened — downstream state relying on it may be silently missing or stale until this is reviewed and, if appropriate, replayed.",
        detectedCause: `integration_outbox.status = DEAD_LETTERED for command ${command.id}.`,
        ...owner,
        propertyId: property.id,
        transactionId: resolved.transactionId,
        dueAt: dueDate,
        escalatesAt: escalatesAtFor(dueDate, CRITICAL_AFTER_DAYS),
        recommendedAction: "Review the dead-lettered integration command (Settings → Integrations → Dead-letters) and, if the underlying cause is resolved, replay it through an authorised operator action.",
        resolutionRequirements: "The originating integration_outbox row reaches a non-DEAD_LETTERED status (typically SENT, via an authorised replay).",
        dismissible: false,
        sourceRecordType: "integration_outbox",
        sourceRecordId: command.id,
        dedupKey: dedupKey(H01_INTEGRATION_COMMAND_DEAD_LETTERED.ruleId, brokerageId, command.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: {
          integrationOutboxId: command.id,
          integrationConnectionId: command.connectionId,
          integrationCapability: command.capability,
          integrationSourceRecordType: command.sourceRecordType,
          integrationSourceRecordId: command.sourceRecordId,
        },
      });
    }

    return findings;
  },
};

export const INTEGRATION_OPERATIONAL_RULES: RiskRule[] = [H01_INTEGRATION_COMMAND_DEAD_LETTERED];
