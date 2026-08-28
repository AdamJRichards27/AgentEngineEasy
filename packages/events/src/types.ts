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
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_UPDATED",
  "SUBSCRIPTION_CANCELLED",
  "ENTITLEMENT_GRANTED",
  "ENTITLEMENT_REVOKED",
  "ENTITLEMENT_ALLOCATION_CHANGED",
  "GROW_ACCESS_ACTIVATED",
  "GROW_ACCESS_SUSPENDED",
  "RELATIONSHIP_CREATED",
  "RELATIONSHIP_UPDATED",
  "OPPORTUNITY_CREATED",
  "OPPORTUNITY_STAGE_CHANGED",
  "OPPORTUNITY_CONVERTED",
  // AI Governance, Authority & Action Control Architecture (Stage G7).
  "AI_ACTION_PROPOSED",
  "AI_ACTION_APPROVAL_REQUIRED",
  "AI_ACTION_APPROVED",
  "AI_ACTION_REJECTED",
  "AI_ACTION_EXECUTED",
  "AI_ACTION_FAILED",
  "AI_ACTION_BLOCKED",
  "AI_WORKFLOW_CHANGE_PROPOSED",
  "AI_WORKFLOW_CHANGE_APPROVED",
  "AI_WORKFLOW_VERSION_ACTIVATED",
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
  SUBSCRIPTION_CREATED: { version: 1, description: "A brokerage subscription (Starter, Pro, or an add-on such as Grow) was created." },
  SUBSCRIPTION_UPDATED: { version: 1, description: "A subscription's status, period, or items changed." },
  SUBSCRIPTION_CANCELLED: { version: 1, description: "A subscription was cancelled (immediately or at period end)." },
  ENTITLEMENT_GRANTED: { version: 1, description: "An entitlement grant became active for a brokerage, office, team, or user." },
  ENTITLEMENT_REVOKED: { version: 1, description: "An entitlement grant was revoked or expired." },
  ENTITLEMENT_ALLOCATION_CHANGED: { version: 1, description: "A brokerage administrator changed who a seat-limited entitlement is allocated to." },
  GROW_ACCESS_ACTIVATED: { version: 1, description: "Grow became usable for a brokerage (grow.access granted)." },
  GROW_ACCESS_SUSPENDED: { version: 1, description: "Grow access was suspended for a brokerage (grow.access revoked, data retained)." },
  RELATIONSHIP_CREATED: { version: 1, description: "A Grow person-property relationship was created." },
  RELATIONSHIP_UPDATED: { version: 1, description: "A Grow person-property relationship's status, role, or validity changed." },
  OPPORTUNITY_CREATED: { version: 1, description: "A Grow opportunity was created." },
  OPPORTUNITY_STAGE_CHANGED: { version: 1, description: "A Grow opportunity moved stage." },
  OPPORTUNITY_CONVERTED: { version: 1, description: "A Grow opportunity was converted into a RUN appraisal or transaction." },
  // AI Governance, Authority & Action Control Architecture (Stage G7).
  AI_ACTION_PROPOSED: { version: 1, description: "An AI action request was created and is awaiting policy evaluation or approval." },
  AI_ACTION_APPROVAL_REQUIRED: { version: 1, description: "An AI action request was risk-classified as requiring explicit human approval before execution." },
  AI_ACTION_APPROVED: { version: 1, description: "An authorised human approved a proposed AI action request." },
  AI_ACTION_REJECTED: { version: 1, description: "An authorised human rejected a proposed AI action request." },
  AI_ACTION_EXECUTED: { version: 1, description: "An AI action request was executed through the AI Action Execution Gateway." },
  AI_ACTION_FAILED: { version: 1, description: "An AI action request passed policy and approval but failed during execution." },
  AI_ACTION_BLOCKED: { version: 1, description: "An AI action request was blocked by policy evaluation before approval or execution." },
  AI_WORKFLOW_CHANGE_PROPOSED: { version: 1, description: "The AI proposed a workflow change as a new draft version without altering the active version." },
  AI_WORKFLOW_CHANGE_APPROVED: { version: 1, description: "An authorised human approved a proposed AI workflow change." },
  AI_WORKFLOW_VERSION_ACTIVATED: { version: 1, description: "A new workflow version was activated by an authorised human." },
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

  actorType: "USER" | "SYSTEM" | "PIT_CREW" | "INTEGRATION" | "AI";
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
