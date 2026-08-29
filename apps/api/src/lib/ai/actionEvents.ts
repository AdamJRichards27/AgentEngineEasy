// AI Governance, Authority & Action Control Architecture -- Stage G7.
//
// Shared helper for publishing AI_ACTION_* / AI_WORKFLOW_* domain events
// from an aiActionRequests row. Used by both the Approval Engine (G5,
// state-machine transitions: proposed / approval-required / approved /
// rejected) and the Execution Gateway (G6: executed / failed / blocked),
// so every stage of an AI action's lifecycle produces exactly one
// canonical, queryable event through the existing event architecture
// (packages/events) rather than a second, parallel audit mechanism.
//
// Rule inherited from packages/events/src/publisher.ts: a broken event
// pipeline must never break the governance transaction it describes. The
// underlying aiActionRequests row has already been committed by the time
// any of these are called, so a publish failure here is logged and
// swallowed, never thrown back at the caller.

import type { AiActionRequest } from "@aee/db";
import { publishDomainEvent, newCorrelationId, type AgentEngineEasyEventType } from "@aee/events";

export async function publishAiActionEvent(
  row: AiActionRequest,
  eventType: AgentEngineEasyEventType,
  payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    await publishDomainEvent({
      eventType,
      occurredAt: new Date(),
      propertyId: null,
      transactionId: null,
      partyId: null,
      actorType: row.actorType === "AI" ? "AI" : "USER",
      actorId: row.userId,
      brokerageId: row.brokerageId,
      agentId: null,
      source: "api:ai-action-requests",
      correlationId: newCorrelationId(),
      causationId: null,
      idempotencyKey: `ai_action_request:${row.id}:${eventType}`,
      metadata: { actionKey: row.actionKey, requestId: row.id, status: row.status },
      payload,
    });
  } catch (err) {
    console.error(`publishAiActionEvent: failed to publish ${eventType}, continuing`, err);
  }
}
