// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage F.
//
// The funnel every financial-engine publishDomainEvent call goes through —
// mirrors lib/launch/model.ts's own private emit() helper (same file-local
// "every publish call funnels through here" shape), just exported and
// shared across financial's five publishing modules (agreements.ts,
// settlement.ts, pcFeeAuthorities.ts, paymentOutbox.ts,
// paymentWebhooks.ts) rather than nested in one, since — unlike
// launch/model.ts — the financial engine has no single model.ts all of
// its writes already funnel through.
//
// Rule 2 from packages/events/src/publisher.ts's own publishDomainEvent
// doc comment: "Callers must wrap this in their own try/catch and log on
// failure — a broken event pipeline must never break AML submission,
// offer creation, contract signing, or settlement recording." The same
// holds here: a broken event pipeline must never break a commission
// approval, a PC fee authority activation, or a payment webhook's own
// state transition, all of which have ALREADY been committed to the
// database by the time this is called (publish-after-persist, rule 1).

import { publishDomainEvent, currentCorrelationId, logger, type AgentEngineEasyEventType } from "@aee/events";

export interface EmitFinancialEventInput {
  eventType: AgentEngineEasyEventType;
  brokerageId: number;
  propertyId: number | null;
  transactionId?: number | null;
  agentId?: number | null;
  actorType: "USER" | "SYSTEM";
  actorId?: number | null;
  source: string; // "api:financial:<action>" or "webhook:financial:<provider>"
  payload: Record<string, unknown>;
  correlationId?: string | null;
  idempotencyKey?: string | null;
}

export async function emitFinancialEvent(input: EmitFinancialEventInput): Promise<void> {
  try {
    await publishDomainEvent({
      eventType: input.eventType as any,
      occurredAt: new Date(),
      propertyId: input.propertyId,
      transactionId: input.transactionId ?? null,
      partyId: null,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      brokerageId: input.brokerageId,
      agentId: input.agentId ?? null,
      source: input.source,
      correlationId: input.correlationId ?? currentCorrelationId(),
      causationId: null,
      idempotencyKey: input.idempotencyKey ?? null,
      metadata: {},
      payload: input.payload,
    });
  } catch (err) {
    logger.error("emit_financial_event_failed", { eventType: input.eventType, brokerageId: input.brokerageId, propertyId: input.propertyId, transactionId: input.transactionId, error: err });
  }
}
