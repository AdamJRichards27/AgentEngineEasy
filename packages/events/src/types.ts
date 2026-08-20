// The 19 canonical AgentEngineEasy domain events (Build Brief §17).
// Never hardcode these strings elsewhere — import this type.
export const AGENT_ENGINE_EASY_EVENT_TYPES = [
  "PROPERTY_CREATED",
  "APPRAISAL_COMPLETED",
  "READY_TO_LIST",
  "AML_REQUESTED",
  "AML_COMPLETED",
  "DOCUMENT_PACKAGE_CREATED",
  "AGENCY_AGREEMENT_SENT",
  "AGENCY_AGREEMENT_SIGNED",
  "LISTING_LIVE",
  "OFFER_RECEIVED",
  "OFFER_ACCEPTED",
  "CONTRACT_SIGNED",
  "FINANCE_APPROVED",
  "SETTLEMENT_SCHEDULED",
  "SETTLEMENT_COMPLETED",
  "COMMISSION_CALCULATED",
  "FUNDS_RECEIVED",
  "AGENT_PAID",
  "TRANSACTION_CLOSED",
] as const;

export type AgentEngineEasyEventType = (typeof AGENT_ENGINE_EASY_EVENT_TYPES)[number];

export const EVENT_TYPE_REGISTRY: Record<AgentEngineEasyEventType, { version: number; description: string }> = {
  PROPERTY_CREATED: { version: 1, description: "A new property record was created." },
  APPRAISAL_COMPLETED: { version: 1, description: "An appraisal was finalised." },
  READY_TO_LIST: { version: 1, description: "The agent selected Ready to List, triggering document/AML orchestration." },
  AML_REQUESTED: { version: 1, description: "An AML/CDD verification request was created and sent to the provider." },
  AML_COMPLETED: { version: 1, description: "The AML workflow reached a completed (verified / review required / failed) state." },
  DOCUMENT_PACKAGE_CREATED: { version: 1, description: "A document package was assembled for a workflow stage." },
  AGENCY_AGREEMENT_SENT: { version: 1, description: "An Agency Agreement was issued for signature." },
  AGENCY_AGREEMENT_SIGNED: { version: 1, description: "All required Agency Agreement signatures were collected." },
  LISTING_LIVE: { version: 1, description: "A property formally became live/listed." },
  OFFER_RECEIVED: { version: 1, description: "An offer was received." },
  OFFER_ACCEPTED: { version: 1, description: "An offer was accepted, converting the property into an active transaction." },
  CONTRACT_SIGNED: { version: 1, description: "The contract reached signed/executed state." },
  FINANCE_APPROVED: { version: 1, description: "Buyer finance was recorded as approved." },
  SETTLEMENT_SCHEDULED: { version: 1, description: "A settlement date was established or changed." },
  SETTLEMENT_COMPLETED: { version: 1, description: "Settlement was confirmed complete." },
  COMMISSION_CALCULATED: { version: 1, description: "Commission was calculated for the transaction." },
  FUNDS_RECEIVED: { version: 1, description: "Funds were confirmed received (may recur for partial payments)." },
  AGENT_PAID: { version: 1, description: "Payment to the agent was confirmed." },
  TRANSACTION_CLOSED: { version: 1, description: "The transaction satisfied AgentEngineEasy's defined closure criteria." },
};

export interface DomainEvent<TPayload = Record<string, unknown>> {
  id: string;
  eventType: AgentEngineEasyEventType;
  eventVersion: number;

  occurredAt: Date;
  recordedAt: Date;

  propertyId: number | null;
  transactionId: number | null;
  partyId: number | null;

  actorType: "USER" | "SYSTEM" | "PIT_CREW" | "INTEGRATION";
  actorId: number | null;

  brokerageId: number | null;
  agentId: number | null;

  source: string; // "api:<module>:<action>" or "webhook:<module>:<provider>"

  correlationId: string;
  causationId: string | null;

  idempotencyKey: string | null;

  metadata: Record<string, unknown>;
  payload: TPayload;

  processingStatus: "PROCESSED" | "PARTIAL_FAILURE" | "FAILED";
  handlerErrors: Array<{ handler: string; error: string }> | null;
  attemptCount: number;
}

export type PublishEventInput<TPayload = Record<string, unknown>> = Omit<
  DomainEvent<TPayload>,
  "id" | "recordedAt" | "processingStatus" | "handlerErrors" | "attemptCount" | "eventVersion"
> & { eventVersion?: number };

export interface EventStore {
  append(event: PublishEventInput): Promise<DomainEvent>;
  updateProcessingStatus(
    id: string,
    status: DomainEvent["processingStatus"],
    handlerErrors: DomainEvent["handlerErrors"],
  ): Promise<void>;
}

export type EventHandler<TPayload = Record<string, unknown>> = (event: DomainEvent<TPayload>) => Promise<void>;
