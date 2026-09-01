// Agent Engine 2.0 — Communications Hub (Priority 8) x Exception & Risk
// Engine (Priority 4).
//
// Section 24: communication delivery failures and blocked sends reuse the
// existing Exception & Risk Engine outright — no new alert table, no new
// severity system, the same dedupKey/resolveDefaultOwner machinery every
// other category already uses (see rules/offers.ts for the template this
// follows). Two rules:
//
//   COMM01_MESSAGE_DELIVERY_FAILED — a message reached a terminal
//   send-side failure (FAILED, BOUNCED, UNDELIVERABLE). There is no
//   authoritative field this rule can watch to auto-clear itself (a
//   terminal failure stays terminal — the only way forward is a brand new
//   message), so every finding here is dismissible: an agent/PC member
//   either resends via a new message or confirms they reached the
//   recipient another way and dismisses it.
//
//   COMM02_MESSAGE_BLOCKED — a message never even reached the provider
//   because consent or cost control stopped it. A MARKETING send blocked
//   by a missing opt-in is the system working exactly as designed, so
//   that specific combination is deliberately excluded — everything else
//   (a TRANSACTIONAL/SERVICE message blocked by consent, or any message
//   blocked by a cost-control threshold) means a real communication did
//   not go out and is worth a human's attention.

import { and, eq, inArray } from "drizzle-orm";
import { db, properties, communicationMessages, type CommunicationMessage, type Property } from "@aee/db";
import type { RiskRule } from "../registry.js";
import type { RiskFinding } from "../types.js";
import { dedupKey, resolveDefaultOwner } from "./shared.js";

const TERMINAL_FAILURE_STATUSES = ["FAILED", "BOUNCED", "UNDELIVERABLE"] as const;
const BLOCKED_STATUSES = ["BLOCKED_BY_CONSENT", "BLOCKED_BY_COST_CONTROL"] as const;

async function loadMessagesWithProperty(brokerageId: number, statuses: readonly string[]): Promise<Array<{ message: CommunicationMessage; property: Property }>> {
  const rows = await db
    .select({ message: communicationMessages, property: properties })
    .from(communicationMessages)
    .innerJoin(properties, eq(communicationMessages.propertyId, properties.id))
    .where(and(eq(communicationMessages.brokerageId, brokerageId), inArray(communicationMessages.status, [...statuses])));
  return rows;
}

const COMM01_MESSAGE_DELIVERY_FAILED: RiskRule = {
  ruleId: "COMM01_MESSAGE_DELIVERY_FAILED",
  version: 1,
  category: "COMMUNICATION",
  name: "Communication message failed to deliver",
  description: "An outbound EMAIL/SMS message reached a terminal failure status (FAILED, BOUNCED, or UNDELIVERABLE) and was not successfully delivered.",
  triggerEventTypes: ["COMMUNICATION_MESSAGE_FAILED"],
  async scanBrokerage(brokerageId) {
    const rows = await loadMessagesWithProperty(brokerageId, TERMINAL_FAILURE_STATUSES);
    const findings: RiskFinding[] = [];

    for (const { message, property } of rows) {
      const owner = resolveDefaultOwner(property, message.transactionId != null);
      const isCritical = message.classification === "TRANSACTIONAL" || message.classification === "SERVICE";
      findings.push({
        ruleId: COMM01_MESSAGE_DELIVERY_FAILED.ruleId,
        ruleVersion: COMM01_MESSAGE_DELIVERY_FAILED.version,
        category: "COMMUNICATION",
        severity: isCritical ? "AT_RISK" : "ATTENTION",
        title: `${message.channel} message to ${message.recipientDisplayName ?? "recipient"} did not deliver`,
        problemDescription: `Message #${message.id} (${message.channel}, ${message.classification}) ended in ${message.status}${message.failureDetail ? `: ${message.failureDetail}` : "."}`,
        businessImpact: isCritical
          ? "A transactional or service communication did not reach its recipient — they may be unaware of a contract, launch, or Pit Crew event they need to act on."
          : "A marketing communication did not reach its recipient — no contractual or time-sensitive obligation is affected.",
        detectedCause: `communication_messages.status = ${message.status}${message.failureCategory ? ` (failureCategory: ${message.failureCategory})` : ""}.`,
        ...owner,
        propertyId: property.id,
        transactionId: message.transactionId,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Confirm whether the recipient needs to be reached another way, then resend via a new message or dismiss once handled.",
        resolutionRequirements: "A human confirms this has been handled (resent through another message, or reached the recipient by another channel) and resolves or dismisses this exception.",
        dismissible: true,
        sourceRecordType: "communication_message",
        sourceRecordId: String(message.id),
        dedupKey: dedupKey(COMM01_MESSAGE_DELIVERY_FAILED.ruleId, brokerageId, message.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: {
          communicationMessageId: message.id,
          communicationChannel: message.channel,
          ...(message.failureCategory ? { communicationFailureCategory: message.failureCategory } : {}),
        },
      });
    }
    return findings;
  },
};

const COMM02_MESSAGE_BLOCKED: RiskRule = {
  ruleId: "COMM02_MESSAGE_BLOCKED",
  version: 1,
  category: "COMMUNICATION",
  name: "Communication message blocked before it could send",
  description: "A message never reached the provider because it was blocked by consent (for a non-marketing send) or by a cost-control threshold.",
  triggerEventTypes: ["COMMUNICATION_MESSAGE_BLOCKED"],
  async scanBrokerage(brokerageId) {
    const rows = await loadMessagesWithProperty(brokerageId, BLOCKED_STATUSES);
    const findings: RiskFinding[] = [];

    for (const { message, property } of rows) {
      // A MARKETING send blocked by a missing opt-in is the consent system
      // working as designed, not a risk to surface.
      if (message.status === "BLOCKED_BY_CONSENT" && message.classification === "MARKETING") continue;

      const owner = resolveDefaultOwner(property, message.transactionId != null);
      const isCostBlock = message.status === "BLOCKED_BY_COST_CONTROL";
      findings.push({
        ruleId: COMM02_MESSAGE_BLOCKED.ruleId,
        ruleVersion: COMM02_MESSAGE_BLOCKED.version,
        category: "COMMUNICATION",
        severity: "AT_RISK",
        title: isCostBlock ? `${message.channel} message blocked by a cost-control limit` : `${message.channel} message blocked by consent`,
        problemDescription: `Message #${message.id} (${message.channel}, ${message.classification}) was never sent — ${message.failureDetail ?? message.status}.`,
        businessImpact: isCostBlock
          ? "This brokerage or user has reached its monthly SMS cost limit — further messages will keep being blocked until the limit is raised or the period rolls over."
          : "A transactional or service communication was blocked by an opt-out — the recipient will not receive it through this channel until that is resolved.",
        detectedCause: `communication_messages.status = ${message.status}.`,
        ...owner,
        propertyId: property.id,
        transactionId: message.transactionId,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: isCostBlock
          ? "Review current SMS spend against the brokerage's cost-control settings, or reach the recipient by another channel in the meantime."
          : "Confirm the recipient's consent status is correct, then reach them by another channel (e.g. a phone call, recorded as a PHONE_CALL message) if this communication is time-sensitive.",
        resolutionRequirements: "A human confirms this has been handled (requeued after the block cleared, or reached the recipient another way) and resolves or dismisses this exception.",
        dismissible: true,
        sourceRecordType: "communication_message",
        sourceRecordId: String(message.id),
        dedupKey: dedupKey(COMM02_MESSAGE_BLOCKED.ruleId, brokerageId, message.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: {
          communicationMessageId: message.id,
          communicationChannel: message.channel,
        },
      });
    }
    return findings;
  },
};

export const COMMUNICATION_DELIVERY_RULES: RiskRule[] = [COMM01_MESSAGE_DELIVERY_FAILED, COMM02_MESSAGE_BLOCKED];
