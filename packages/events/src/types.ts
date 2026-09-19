// The canonical AgentEngineEasy domain event types. This array (and
// EVENT_TYPE_REGISTRY below) is the single source of truth for which
// event types exist and how many there are -- never restate a count in a
// comment, here or elsewhere, and never hardcode these strings elsewhere
// either; import this type. See docs/EVENT_CONTRACTS.md for the full
// catalogue grouped by domain area, the envelope contract, and how
// publishing/consumption actually work.
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
  // AE GROW Priority 6 Stage F4.0 — audit for the (previously unaudited)
  // AWAITING_APPROVAL/APPROVED -> EXPIRED transition.
  "AI_ACTION_EXPIRED",
  "AI_WORKFLOW_CHANGE_PROPOSED",
  "AI_WORKFLOW_CHANGE_APPROVED",
  "AI_WORKFLOW_VERSION_ACTIVATED",
  // Agent Engine 2.0 — Workflow Automation Engine (Stage 2). Added to close
  // gaps against the required 26-type canonical event catalogue confirmed in
  // docs/stage-wf/WF1_DISCOVERY.md §1. WORKFLOW_ACTION_* were renamed to
  // AUTOMATION_ACTION_* to avoid the confirmed naming collision with the
  // existing, unrelated per-property "workflows" checklist engine (§2).
  "APPRAISAL_CREATED",
  "APPRAISAL_STATUS_CHANGED",
  "PROPOSAL_SENT",
  "CONTRACT_PREPARATION_STARTED",
  "CONTRACT_EXCHANGED",
  "TRANSACTION_UNCONDITIONAL",
  "TASK_COMPLETED",
  "TASK_OVERDUE",
  "AUTOMATION_ACTION_FAILED",
  "AUTOMATION_ACTION_BLOCKED",
  "EXCEPTION_CREATED",
  "EXCEPTION_RESOLVED",
  // Agent Engine 2.0 — Workflow Automation Engine (Stage: Foundation).
  // Execution-level lifecycle events, complementing the action-level
  // AUTOMATION_ACTION_FAILED/BLOCKED above — component "Structured audit
  // events for evaluation and execution". Deliberately minimal: an
  // action-level success is already fully audited by the existing
  // AI_ACTION_EXECUTED event (published by executionGateway.ts's own
  // publishAiActionEvent call, reused unchanged by the automation engine),
  // so no separate AUTOMATION_ACTION_SUCCEEDED was added.
  "AUTOMATION_EXECUTION_SKIPPED",
  "AUTOMATION_EXECUTION_COMPLETED",
  // Agent Engine 2.0 -- WAE Operational Readiness (Stage: WF4). Explicit
  // audit-event complements for the new operator-facing lifecycle actions
  // (retry scheduling, cancellation, abandoned-RUNNING recovery) -- section
  // "audit event for every retry scheduling and execution attempt" /
  // "emit an audit event" for every operator control. Execution *attempts*
  // themselves are already fully covered by the existing AI_ACTION_EXECUTED/
  // AI_ACTION_FAILED/AUTOMATION_ACTION_FAILED events a retry re-triggers.
  "AUTOMATION_ACTION_RETRY_SCHEDULED",
  "AUTOMATION_ACTION_CANCELLED",
  "AUTOMATION_EXECUTION_CANCELLED",
  "AUTOMATION_EXECUTION_RECOVERED",
  // Agent Engine 2.0 — Property Launch & Campaign Coordination. 23 new
  // event types covering the operational Launch stage (AGENCY AGREEMENT
  // SIGNED -> LAUNCH PLANNING -> CAMPAIGN PRODUCTION -> VENDOR APPROVAL ->
  // MARKET READY -> PORTAL SUBMISSION -> LISTING LIVE). LISTING_LIVE itself
  // is deliberately NOT redeclared here — the existing event above is
  // reused unchanged (lib/launch/model.ts's confirmLaunchLive() publishes
  // it through the same properties.go-live path routes/properties.ts
  // already uses), so "going live" is never represented two different ways.
  "LAUNCH_PLAN_CREATED",
  "LAUNCH_TEMPLATE_APPLIED",
  "LAUNCH_TARGET_DATE_CHANGED",
  "LAUNCH_DUE_DATES_CALCULATED",
  "LAUNCH_DEFAULT_RESPONSIBILITY_ASSIGNED",
  "CAMPAIGN_ITEM_ADDED",
  "CAMPAIGN_ITEM_STATUS_CHANGED",
  "CAMPAIGN_ITEM_BLOCKED",
  "CAMPAIGN_ITEM_COMPLETED",
  "CAMPAIGN_ITEM_EVIDENCE_ATTACHED",
  "VENDOR_SELECTED",
  "VENDOR_COST_RECORDED",
  "VENDOR_APPROVAL_REQUESTED",
  "VENDOR_APPROVAL_DECIDED",
  "LAUNCH_BUDGET_SET",
  "LAUNCH_BUDGET_EXCEEDED",
  "PORTAL_DESTINATION_ADDED",
  "PORTAL_SUBMISSION_RECORDED",
  "PORTAL_SUBMISSION_FAILED",
  "MARKET_READY_EVALUATED",
  "MARKET_READY_OVERRIDDEN",
  "LAUNCH_PAUSED",
  "LAUNCH_CANCELLED",
  // Agent Engine 2.0 — Communications Hub (Priority 8). Section 23:
  // COMMUNICATION_* domain events, reusing this same correlation/
  // causation/idempotency/audit machinery rather than a parallel one.
  // Deliberately message-lifecycle only (drafted/queued/sent/delivered/
  // failed/blocked/received) plus one consent event — there is no
  // COMMUNICATION_THREAD_CREATED or similar record-shape event because no
  // existing consumer needs to react to a thread's mere existence, only to
  // what happens to a message within it (mirrors EXCEPTION_CREATED/
  // EXCEPTION_RESOLVED's own "react to state changes that matter" scope).
  "COMMUNICATION_MESSAGE_DRAFTED",
  "COMMUNICATION_MESSAGE_QUEUED",
  "COMMUNICATION_MESSAGE_SENT",
  "COMMUNICATION_MESSAGE_DELIVERED",
  "COMMUNICATION_MESSAGE_FAILED",
  "COMMUNICATION_MESSAGE_RECEIVED",
  "COMMUNICATION_MESSAGE_BLOCKED",
  "COMMUNICATION_CONSENT_UPDATED",
  // Agent Engine 2.0 — Financial Transaction Engine (Priority 9, Stage F).
  // The financial engine's own domain events (Sections 9/13-15/17/21/31),
  // added once Stage F wires the engine to this canonical event bus for
  // the first time — Stages B-E built and exercised every financial
  // service function directly, with financialLedgerEvents (a domain-
  // specific, append-only table of its OWN — see routes/financial.ts's
  // header comment) as the audit trail, but never published to this bus.
  // These ten cover only the material, cross-engine-relevant milestones
  // (an approval, a settlement-triggered finalisation, an authority
  // activation/revocation, a payment's terminal outcomes, a marketing
  // invoice/reconciliation milestone) — every finer-grained state
  // transition stays exactly where it already lived, in
  // financialLedgerEvents, mirroring how AUTOMATION_EXECUTION_COMPLETED's
  // own comment above reasons about AI_ACTION_EXECUTED already covering
  // action-level success without a second, duplicate event.
  "COMMISSION_AGREEMENT_APPROVED",
  "COMMISSION_FINALISED",
  "PC_FEE_AUTHORITY_ACTIVATED",
  "PC_FEE_AUTHORITY_REVOKED",
  "FINANCIAL_PAYMENT_SCHEDULED",
  "FINANCIAL_PAYMENT_PAID",
  "FINANCIAL_PAYMENT_FAILED",
  "FINANCIAL_PAYMENT_REVERSED",
  "MARKETING_INVOICE_RECORDED",
  "MARKETING_PAYMENT_RECONCILED",
  // Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
  // Deliberately minimal: an inbound webhook's actual domain effect is
  // published by the existing domain service it calls through (e.g.
  // Launch's PORTAL_SUBMISSION_RECORDED/PORTAL_SUBMISSION_FAILED, published
  // unchanged by lib/launch/model.ts) — these four cover only the
  // integration layer's OWN lifecycle milestones (a connection becoming
  // usable/unusable, a command exhausting retries, a webhook rejected
  // outright), the same "don't duplicate an event another layer already
  // owns" reasoning AUTOMATION_EXECUTION_COMPLETED's own comment above uses.
  "INTEGRATION_CONNECTION_ACTIVATED",
  "INTEGRATION_CONNECTION_SUSPENDED",
  "INTEGRATION_CONNECTION_REVOKED",
  "INTEGRATION_COMMAND_DEAD_LETTERED",
  "INTEGRATION_WEBHOOK_REJECTED",
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
  AI_ACTION_EXPIRED: { version: 1, description: "An AI action request passed its expiry time before being approved or executed and was transitioned to EXPIRED." },
  AI_WORKFLOW_CHANGE_PROPOSED: { version: 1, description: "The AI proposed a workflow change as a new draft version without altering the active version." },
  AI_WORKFLOW_CHANGE_APPROVED: { version: 1, description: "An authorised human approved a proposed AI workflow change." },
  AI_WORKFLOW_VERSION_ACTIVATED: { version: 1, description: "A new workflow version was activated by an authorised human." },
  // Agent Engine 2.0 — Workflow Automation Engine (Stage 2).
  APPRAISAL_CREATED: { version: 1, description: "An appraisal record was created for a property." },
  APPRAISAL_STATUS_CHANGED: { version: 1, description: "An appraisal Grow workspace lifecycle status changed (e.g. ready, sent, presented, follow-up, won, lost, deferred)." },
  PROPOSAL_SENT: { version: 1, description: "A listing proposal was sent to a prospective vendor." },
  CONTRACT_PREPARATION_STARTED: { version: 1, description: "Contract preparation began for a transaction." },
  CONTRACT_EXCHANGED: { version: 1, description: "Contracts were formally exchanged between parties." },
  TRANSACTION_UNCONDITIONAL: { version: 1, description: "A transaction became unconditional (all conditions satisfied)." },
  TASK_COMPLETED: { version: 1, description: "A workflow step / task was marked complete." },
  TASK_OVERDUE: { version: 1, description: "A workflow step / task passed its due date while still incomplete." },
  AUTOMATION_ACTION_FAILED: { version: 1, description: "An automation rule's action attempt failed during execution." },
  AUTOMATION_ACTION_BLOCKED: { version: 1, description: "An automation rule's action was blocked by the authority/policy engine." },
  EXCEPTION_CREATED: { version: 1, description: "A new Exception & Risk Engine record was raised." },
  EXCEPTION_RESOLVED: { version: 1, description: "An open Exception & Risk Engine record was resolved." },
  // Agent Engine 2.0 — Workflow Automation Engine (Stage: Foundation).
  AUTOMATION_EXECUTION_SKIPPED: { version: 1, description: "An automation rule version's conditions did not match the triggering event; no action was attempted." },
  AUTOMATION_EXECUTION_COMPLETED: { version: 1, description: "An automation execution reached COMPLETED — every action succeeded." },
  // Agent Engine 2.0 -- WAE Operational Readiness (Stage: WF4).
  AUTOMATION_ACTION_RETRY_SCHEDULED: { version: 1, description: "A retryable automation action failure was scheduled for a later retry attempt." },
  AUTOMATION_ACTION_CANCELLED: { version: 1, description: "An authorised operator cancelled an automation action before it performed an irreversible side effect." },
  AUTOMATION_EXECUTION_CANCELLED: { version: 1, description: "An authorised operator cancelled an automation execution before it performed an irreversible side effect." },
  AUTOMATION_EXECUTION_RECOVERED: { version: 1, description: "An automation execution or action abandoned in a stale RUNNING state (worker/process interruption) was recovered by the operational-readiness sweep." },
  // Agent Engine 2.0 — Property Launch & Campaign Coordination.
  LAUNCH_PLAN_CREATED: { version: 1, description: "A Launch Plan was created for a property (typically proposed automatically once the agency agreement is signed)." },
  LAUNCH_TEMPLATE_APPLIED: { version: 1, description: "A campaign template (Standard Private Treaty, Auction, Off-Market, or Custom) was applied or changed on a Launch Plan, generating its campaign items." },
  LAUNCH_TARGET_DATE_CHANGED: { version: 1, description: "A Launch Plan's target launch date was set or changed." },
  LAUNCH_DUE_DATES_CALCULATED: { version: 1, description: "Campaign item due dates were backward-calculated from the target launch date." },
  LAUNCH_DEFAULT_RESPONSIBILITY_ASSIGNED: { version: 1, description: "Default responsibility (owner type/user) was assigned across a Launch Plan's campaign items." },
  CAMPAIGN_ITEM_ADDED: { version: 1, description: "A campaign item was added to a Launch Plan." },
  CAMPAIGN_ITEM_STATUS_CHANGED: { version: 1, description: "A campaign item's status changed." },
  CAMPAIGN_ITEM_BLOCKED: { version: 1, description: "A campaign item was marked blocked, with a reason." },
  CAMPAIGN_ITEM_COMPLETED: { version: 1, description: "A campaign item was marked complete." },
  CAMPAIGN_ITEM_EVIDENCE_ATTACHED: { version: 1, description: "Evidence (a photo, document, or other file) was attached to a campaign item." },
  VENDOR_SELECTED: { version: 1, description: "A vendor/supplier name was recorded against a campaign item." },
  VENDOR_COST_RECORDED: { version: 1, description: "A cost was recorded against a campaign item." },
  VENDOR_APPROVAL_REQUESTED: { version: 1, description: "A vendor, budget, or campaign-item-cost approval was requested." },
  VENDOR_APPROVAL_DECIDED: { version: 1, description: "A Brokerage Administrator approved, rejected, or requested changes to a pending vendor/budget approval." },
  LAUNCH_BUDGET_SET: { version: 1, description: "A Launch Plan's approved marketing budget was set or changed by a Brokerage Administrator." },
  LAUNCH_BUDGET_EXCEEDED: { version: 1, description: "A Launch Plan's recorded spend exceeded its approved budget." },
  PORTAL_DESTINATION_ADDED: { version: 1, description: "A portal destination (a named real estate portal or channel) was added to a Launch Plan." },
  PORTAL_SUBMISSION_RECORDED: { version: 1, description: "An agent recorded that a listing was submitted to a portal destination (an operational record, never a direct portal API call)." },
  PORTAL_SUBMISSION_FAILED: { version: 1, description: "A recorded portal submission failed, with a reason." },
  MARKET_READY_EVALUATED: { version: 1, description: "The deterministic Market Ready evaluator ran against a Launch Plan, producing a ready/not-ready result with structured blockers." },
  MARKET_READY_OVERRIDDEN: { version: 1, description: "A Brokerage Administrator overrode one or more outstanding Market Ready blockers." },
  LAUNCH_PAUSED: { version: 1, description: "A Launch Plan was paused." },
  LAUNCH_CANCELLED: { version: 1, description: "A Launch Plan was cancelled." },
  // Agent Engine 2.0 — Communications Hub (Priority 8).
  COMMUNICATION_MESSAGE_DRAFTED: { version: 1, description: "A communication message was created as a draft, not yet sent." },
  COMMUNICATION_MESSAGE_QUEUED: { version: 1, description: "A communication message passed validation/consent/cost checks and was queued for dispatch." },
  COMMUNICATION_MESSAGE_SENT: { version: 1, description: "A communication message was handed to its provider (sent, not yet confirmed delivered)." },
  COMMUNICATION_MESSAGE_DELIVERED: { version: 1, description: "A provider confirmed delivery of a previously sent communication message." },
  COMMUNICATION_MESSAGE_FAILED: { version: 1, description: "A communication message failed to send or deliver, after exhausting retries where retryable." },
  COMMUNICATION_MESSAGE_RECEIVED: { version: 1, description: "An inbound communication (reply or new message) was recorded against a thread." },
  COMMUNICATION_MESSAGE_BLOCKED: { version: 1, description: "A communication message was blocked before sending, by consent/opt-out or a cost control threshold." },
  COMMUNICATION_CONSENT_UPDATED: { version: 1, description: "A destination's consent/opt-out record was created or changed." },
  // Agent Engine 2.0 — Financial Transaction Engine (Priority 9, Stage F).
  COMMISSION_AGREEMENT_APPROVED: { version: 1, description: "A commission agreement was approved by a second Brokerage Administrator (separation of duties from its drafter)." },
  COMMISSION_FINALISED: { version: 1, description: "A transaction's commission was finalised against an approved commission agreement, typically triggered by SETTLEMENT_COMPLETED." },
  PC_FEE_AUTHORITY_ACTIVATED: { version: 1, description: "A Pit Crew success-fee authority was activated once its debit mandate was externally authorised." },
  PC_FEE_AUTHORITY_REVOKED: { version: 1, description: "A Pit Crew success-fee authority was revoked." },
  FINANCIAL_PAYMENT_SCHEDULED: { version: 1, description: "A mandate debit was successfully scheduled with the payment provider for a financial payment request." },
  FINANCIAL_PAYMENT_PAID: { version: 1, description: "A financial payment request's debit cleared (provider-confirmed Paid)." },
  FINANCIAL_PAYMENT_FAILED: { version: 1, description: "A financial payment request failed permanently, after exhausting retries where retryable." },
  FINANCIAL_PAYMENT_REVERSED: { version: 1, description: "A previously paid financial payment request was reversed, either by an administrator or the provider." },
  MARKETING_INVOICE_RECORDED: { version: 1, description: "A marketing invoice was recorded against a Launch campaign item's payment overlay." },
  MARKETING_PAYMENT_RECONCILED: { version: 1, description: "A marketing payment record was reconciled against brokerage financial records." },
  // Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
  INTEGRATION_CONNECTION_ACTIVATED: { version: 1, description: "An integration connection completed approval and validation and became usable (mock adapters only in this build)." },
  INTEGRATION_CONNECTION_SUSPENDED: { version: 1, description: "An integration connection was suspended, immediately making it unusable without revoking it permanently." },
  INTEGRATION_CONNECTION_REVOKED: { version: 1, description: "An integration connection was permanently revoked." },
  INTEGRATION_COMMAND_DEAD_LETTERED: { version: 1, description: "An outbound integration command exhausted its retry budget (or failed permanently) and was moved to the dead-letter queue for authorised review/replay." },
  INTEGRATION_WEBHOOK_REJECTED: { version: 1, description: "An inbound integration webhook was rejected before processing (invalid signature, unresolvable/mismatched tenant, oversized payload, or malformed envelope)." },
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
