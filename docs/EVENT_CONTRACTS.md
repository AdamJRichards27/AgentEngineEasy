# Event Contracts

This document is the canonical reference for AgentEngineEasy's domain event system: what
events exist, what shape they take on the wire, how they get published, and how they get
consumed. It exists because the previous source of truth — a one-line comment atop
`packages/events/src/types.ts` — had drifted (see "Methodology and DOC-001" below) and
because no single document previously described the publish/consume contract end to end.

The code is still the ultimate authority. Where this document and the code disagree, the
code wins and this document is stale — please fix it in the same PR that changes the code.

## 1. Methodology and DOC-001

Part B Stage 1 of the ongoing audit (the "Canonical Source Registry") flagged an issue
tracked as **DOC-001**: the comment at the top of `packages/events/src/types.ts` read

> `// The 19 canonical AgentEngineEasy domain events (Build Brief §17).`

That count was accurate when it was written, but the array has grown by nine separate
additions since (AI Governance/Stage G7, WAE Stage 2, WAE Foundation, WAE Operational
Readiness/WF4, Property Launch & Campaign, Communications Hub, and the Financial
Transaction Engine/Stage F) without the comment ever being updated. A direct count of
`AGENT_ENGINE_EASY_EVENT_TYPES` (verified programmatically, deduplicated) shows **100**
entries as of this writing, not 19.

Rather than change "19" to "100" — which would only reproduce the same staleness the next
time an event type is added — the comment in `types.ts` has been rewritten to stop stating
a count at all, and instead point here. This document's catalogue (Section 2) is the
concrete count going forward, and it should be updated in the same PR as any change to
`AGENT_ENGINE_EASY_EVENT_TYPES`.

## 2. Canonical event catalogue

All 100 canonical event types are defined in `AGENT_ENGINE_EASY_EVENT_TYPES` in
`packages/events/src/types.ts`, grouped below by the domain area that introduced them (the
grouping mirrors the inline comments already present in the array). Every type also has a
matching entry in `EVENT_TYPE_REGISTRY` in the same file, giving each event a `version`
(all currently `1` — see Section 4) and a one-line `description`; the descriptions below
are drawn directly from that registry.

### 2.1 Original Build Brief events (19)

| Event type | Description |
| --- | --- |
| `PROPERTY_CREATED` | A new property record was created. |
| `APPRAISAL_COMPLETED` | An appraisal was finalised. |
| `READY_TO_LIST` | The agent selected Ready to List, triggering document/AML orchestration. |
| `AML_REQUESTED` | An AML/CDD verification request was created and sent to the provider. |
| `AML_COMPLETED` | The AML workflow reached a completed (verified / review required / failed) state. |
| `DOCUMENT_PACKAGE_CREATED` | A document package was assembled for a workflow stage. |
| `AGENCY_AGREEMENT_SENT` | An Agency Agreement was issued for signature. |
| `AGENCY_AGREEMENT_SIGNED` | All required Agency Agreement signatures were collected. |
| `LISTING_LIVE` | A property formally became live/listed. |
| `OFFER_RECEIVED` | An offer was received. |
| `OFFER_ACCEPTED` | An offer was accepted, converting the property into an active transaction. |
| `CONTRACT_SIGNED` | The contract reached signed/executed state. |
| `FINANCE_APPROVED` | Buyer finance was recorded as approved. |
| `SETTLEMENT_SCHEDULED` | A settlement date was established or changed. |
| `SETTLEMENT_COMPLETED` | Settlement was confirmed complete. |
| `COMMISSION_CALCULATED` | Commission was calculated for the transaction. |
| `FUNDS_RECEIVED` | Funds were confirmed received (may recur for partial payments). |
| `AGENT_PAID` | Payment to the agent was confirmed. |
| `TRANSACTION_CLOSED` | The transaction satisfied AgentEngineEasy's defined closure criteria. |

Thirteen more events from the original catalogue that don't fit the transaction-lifecycle
sequence above — subscription, entitlement, and Grow relationship/opportunity events — are
also part of this original set:

| Event type | Description |
| --- | --- |
| `SUBSCRIPTION_CREATED` | A brokerage subscription (Starter, Pro, or an add-on such as Grow) was created. |
| `SUBSCRIPTION_UPDATED` | A subscription's status, period, or items changed. |
| `SUBSCRIPTION_CANCELLED` | A subscription was cancelled (immediately or at period end). |
| `ENTITLEMENT_GRANTED` | An entitlement grant became active for a brokerage, office, team, or user. |
| `ENTITLEMENT_REVOKED` | An entitlement grant was revoked or expired. |
| `ENTITLEMENT_ALLOCATION_CHANGED` | A brokerage administrator changed who a seat-limited entitlement is allocated to. |
| `GROW_ACCESS_ACTIVATED` | Grow became usable for a brokerage (grow.access granted). |
| `GROW_ACCESS_SUSPENDED` | Grow access was suspended for a brokerage (grow.access revoked, data retained). |
| `RELATIONSHIP_CREATED` | A Grow person-property relationship was created. |
| `RELATIONSHIP_UPDATED` | A Grow person-property relationship's status, role, or validity changed. |
| `OPPORTUNITY_CREATED` | A Grow opportunity was created. |
| `OPPORTUNITY_STAGE_CHANGED` | A Grow opportunity moved stage. |
| `OPPORTUNITY_CONVERTED` | A Grow opportunity was converted into a RUN appraisal or transaction. |

That brings the original Build Brief §17 set to 32 events in the current array — the "19"
in the old comment referred only to the transaction-lifecycle subsequence, which is itself
one likely source of the eventual confusion.

### 2.2 AI Governance, Authority & Action Control Architecture — Stage G7 (10) + Stage F4.0 (1)

| Event type | Description |
| --- | --- |
| `AI_ACTION_PROPOSED` | An AI action request was created and is awaiting policy evaluation or approval. |
| `AI_ACTION_APPROVAL_REQUIRED` | An AI action request was risk-classified as requiring explicit human approval before execution. |
| `AI_ACTION_APPROVED` | An authorised human approved a proposed AI action request. |
| `AI_ACTION_REJECTED` | An authorised human rejected a proposed AI action request. |
| `AI_ACTION_EXECUTED` | An AI action request was executed through the AI Action Execution Gateway. |
| `AI_ACTION_FAILED` | An AI action request passed policy and approval but failed during execution. |
| `AI_ACTION_BLOCKED` | An AI action request was blocked by policy evaluation before approval or execution. |
| `AI_ACTION_EXPIRED` | An AI action request passed its expiry time before being approved or executed and was transitioned to EXPIRED. (Stage F4.0) |
| `AI_WORKFLOW_CHANGE_PROPOSED` | The AI proposed a workflow change as a new draft version without altering the active version. |
| `AI_WORKFLOW_CHANGE_APPROVED` | An authorised human approved a proposed AI workflow change. |
| `AI_WORKFLOW_VERSION_ACTIVATED` | A new workflow version was activated by an authorised human. |

### 2.3 Workflow Automation Engine — Stage 2 (11)

Added to close gaps against the required canonical event catalogue confirmed in
`docs/stage-wf/WF1_DISCOVERY.md` §1. `WORKFLOW_ACTION_*` was renamed to
`AUTOMATION_ACTION_*` at this point to avoid a naming collision with the existing,
unrelated per-property "workflows" checklist engine.

| Event type | Description |
| --- | --- |
| `APPRAISAL_CREATED` | An appraisal record was created for a property. |
| `PROPOSAL_SENT` | A listing proposal was sent to a prospective vendor. |
| `CONTRACT_PREPARATION_STARTED` | Contract preparation began for a transaction. |
| `CONTRACT_EXCHANGED` | Contracts were formally exchanged between parties. |
| `TRANSACTION_UNCONDITIONAL` | A transaction became unconditional (all conditions satisfied). |
| `TASK_COMPLETED` | A workflow step / task was marked complete. |
| `TASK_OVERDUE` | A workflow step / task passed its due date while still incomplete. |
| `AUTOMATION_ACTION_FAILED` | An automation rule's action attempt failed during execution. |
| `AUTOMATION_ACTION_BLOCKED` | An automation rule's action was blocked by the authority/policy engine. |
| `EXCEPTION_CREATED` | A new Exception & Risk Engine record was raised. |
| `EXCEPTION_RESOLVED` | An open Exception & Risk Engine record was resolved. |

### 2.4 Workflow Automation Engine — Foundation stage (2)

Execution-level lifecycle events, complementing the action-level
`AUTOMATION_ACTION_FAILED`/`AUTOMATION_ACTION_BLOCKED` above. Deliberately minimal: an
action-level success is already fully audited by the existing `AI_ACTION_EXECUTED` event
(published by `executionGateway.ts`'s own `publishAiActionEvent` call, reused unchanged by
the automation engine), so no separate `AUTOMATION_ACTION_SUCCEEDED` was added.

| Event type | Description |
| --- | --- |
| `AUTOMATION_EXECUTION_SKIPPED` | An automation rule version's conditions did not match the triggering event; no action was attempted. |
| `AUTOMATION_EXECUTION_COMPLETED` | An automation execution reached COMPLETED — every action succeeded. |

### 2.5 WAE Operational Readiness — Stage WF4 (4)

Explicit audit-event complements for operator-facing lifecycle actions (retry scheduling,
cancellation, abandoned-`RUNNING` recovery). Execution *attempts* themselves are already
fully covered by the existing `AI_ACTION_EXECUTED`/`AI_ACTION_FAILED`/
`AUTOMATION_ACTION_FAILED` events that a retry re-triggers.

| Event type | Description |
| --- | --- |
| `AUTOMATION_ACTION_RETRY_SCHEDULED` | A retryable automation action failure was scheduled for a later retry attempt. |
| `AUTOMATION_ACTION_CANCELLED` | An authorised operator cancelled an automation action before it performed an irreversible side effect. |
| `AUTOMATION_EXECUTION_CANCELLED` | An authorised operator cancelled an automation execution before it performed an irreversible side effect. |
| `AUTOMATION_EXECUTION_RECOVERED` | An automation execution or action abandoned in a stale RUNNING state (worker/process interruption) was recovered by the operational-readiness sweep. |

### 2.6 Property Launch & Campaign Coordination (23)

Covers the operational Launch stage (agency agreement signed → launch planning → campaign
production → vendor approval → market ready → portal submission → listing live).
`LISTING_LIVE` itself is deliberately not redeclared in this group — the existing event
from Section 2.1 is reused unchanged (`lib/launch/model.ts`'s `confirmLaunchLive()`
publishes it through the same properties go-live path `routes/properties.ts` already uses),
so "going live" is never represented two different ways.

| Event type | Description |
| --- | --- |
| `LAUNCH_PLAN_CREATED` | A Launch Plan was created for a property (typically proposed automatically once the agency agreement is signed). |
| `LAUNCH_TEMPLATE_APPLIED` | A campaign template (Standard Private Treaty, Auction, Off-Market, or Custom) was applied or changed on a Launch Plan, generating its campaign items. |
| `LAUNCH_TARGET_DATE_CHANGED` | A Launch Plan's target launch date was set or changed. |
| `LAUNCH_DUE_DATES_CALCULATED` | Campaign item due dates were backward-calculated from the target launch date. |
| `LAUNCH_DEFAULT_RESPONSIBILITY_ASSIGNED` | Default responsibility (owner type/user) was assigned across a Launch Plan's campaign items. |
| `CAMPAIGN_ITEM_ADDED` | A campaign item was added to a Launch Plan. |
| `CAMPAIGN_ITEM_STATUS_CHANGED` | A campaign item's status changed. |
| `CAMPAIGN_ITEM_BLOCKED` | A campaign item was marked blocked, with a reason. |
| `CAMPAIGN_ITEM_COMPLETED` | A campaign item was marked complete. |
| `CAMPAIGN_ITEM_EVIDENCE_ATTACHED` | Evidence (a photo, document, or other file) was attached to a campaign item. |
| `VENDOR_SELECTED` | A vendor/supplier name was recorded against a campaign item. |
| `VENDOR_COST_RECORDED` | A cost was recorded against a campaign item. |
| `VENDOR_APPROVAL_REQUESTED` | A vendor, budget, or campaign-item-cost approval was requested. |
| `VENDOR_APPROVAL_DECIDED` | A Brokerage Administrator approved, rejected, or requested changes to a pending vendor/budget approval. |
| `LAUNCH_BUDGET_SET` | A Launch Plan's approved marketing budget was set or changed by a Brokerage Administrator. |
| `LAUNCH_BUDGET_EXCEEDED` | A Launch Plan's recorded spend exceeded its approved budget. |
| `PORTAL_DESTINATION_ADDED` | A portal destination (a named real estate portal or channel) was added to a Launch Plan. |
| `PORTAL_SUBMISSION_RECORDED` | An agent recorded that a listing was submitted to a portal destination (an operational record, never a direct portal API call). |
| `PORTAL_SUBMISSION_FAILED` | A recorded portal submission failed, with a reason. |
| `MARKET_READY_EVALUATED` | The deterministic Market Ready evaluator ran against a Launch Plan, producing a ready/not-ready result with structured blockers. |
| `MARKET_READY_OVERRIDDEN` | A Brokerage Administrator overrode one or more outstanding Market Ready blockers. |
| `LAUNCH_PAUSED` | A Launch Plan was paused. |
| `LAUNCH_CANCELLED` | A Launch Plan was cancelled. |

### 2.7 Communications Hub (8)

`COMMUNICATION_*` domain events, reusing the same correlation/causation/idempotency/audit
machinery as every other event rather than a parallel one. Deliberately message-lifecycle
only (drafted/queued/sent/delivered/failed/blocked/received) plus one consent event —
there is no `COMMUNICATION_THREAD_CREATED` or similar record-shape event because no
existing consumer needs to react to a thread's mere existence, only to what happens to a
message within it (mirrors `EXCEPTION_CREATED`/`EXCEPTION_RESOLVED`'s own "react to state
changes that matter" scope).

| Event type | Description |
| --- | --- |
| `COMMUNICATION_MESSAGE_DRAFTED` | A communication message was created as a draft, not yet sent. |
| `COMMUNICATION_MESSAGE_QUEUED` | A communication message passed validation/consent/cost checks and was queued for dispatch. |
| `COMMUNICATION_MESSAGE_SENT` | A communication message was handed to its provider (sent, not yet confirmed delivered). |
| `COMMUNICATION_MESSAGE_DELIVERED` | A provider confirmed delivery of a previously sent communication message. |
| `COMMUNICATION_MESSAGE_FAILED` | A communication message failed to send or deliver, after exhausting retries where retryable. |
| `COMMUNICATION_MESSAGE_RECEIVED` | An inbound communication (reply or new message) was recorded against a thread. |
| `COMMUNICATION_MESSAGE_BLOCKED` | A communication message was blocked before sending, by consent/opt-out or a cost control threshold. |
| `COMMUNICATION_CONSENT_UPDATED` | A destination's consent/opt-out record was created or changed. |

### 2.8 Financial Transaction Engine — Stage F (10)

Added once Stage F wired the financial engine to this canonical event bus for the first
time — Stages B-E built and exercised every financial service function directly, with
`financialLedgerEvents` (a domain-specific, append-only table of its own — see
`routes/financial.ts`'s header comment) as the audit trail, but never published to this
bus. These ten cover only the material, cross-engine-relevant milestones (an approval, a
settlement-triggered finalisation, an authority activation/revocation, a payment's
terminal outcomes, a marketing invoice/reconciliation milestone) — every finer-grained
state transition stays exactly where it already lived, in `financialLedgerEvents`,
mirroring how `AUTOMATION_EXECUTION_COMPLETED`'s own reasoning (Section 2.4) treats
`AI_ACTION_EXECUTED` as already covering action-level success without a second, duplicate
event.

| Event type | Description |
| --- | --- |
| `COMMISSION_AGREEMENT_APPROVED` | A commission agreement was approved by a second Brokerage Administrator (separation of duties from its drafter). |
| `COMMISSION_FINALISED` | A transaction's commission was finalised against an approved commission agreement, typically triggered by `SETTLEMENT_COMPLETED`. |
| `PC_FEE_AUTHORITY_ACTIVATED` | A Pit Crew success-fee authority was activated once its debit mandate was externally authorised. |
| `PC_FEE_AUTHORITY_REVOKED` | A Pit Crew success-fee authority was revoked. |
| `FINANCIAL_PAYMENT_SCHEDULED` | A mandate debit was successfully scheduled with the payment provider for a financial payment request. |
| `FINANCIAL_PAYMENT_PAID` | A financial payment request's debit cleared (provider-confirmed Paid). |
| `FINANCIAL_PAYMENT_FAILED` | A financial payment request failed permanently, after exhausting retries where retryable. |
| `FINANCIAL_PAYMENT_REVERSED` | A previously paid financial payment request was reversed, either by an administrator or the provider. |
| `MARKETING_INVOICE_RECORDED` | A marketing invoice was recorded against a Launch campaign item's payment overlay. |
| `MARKETING_PAYMENT_RECONCILED` | A marketing payment record was reconciled against brokerage financial records. |

**Total: 19 + 13 + 10 + 11 + 2 + 4 + 23 + 8 + 10 = 100 canonical event types**, matching a
direct, deduplicated count of `AGENT_ENGINE_EASY_EVENT_TYPES` at the time of writing.

## 3. Envelope contract

Every event on the bus is a `DomainEvent<TPayload>` (`packages/events/src/types.ts`):

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Assigned by the event store on append; never set by the caller. |
| `eventType` | `AgentEngineEasyEventType` | Must be one of the 100 canonical types; TypeScript enforces this at every call site (see Section 5). |
| `eventVersion` | `number` | Defaults from `EVENT_TYPE_REGISTRY[eventType].version` when omitted by the publisher (see Section 4). |
| `occurredAt` / `recordedAt` | `Date` | When the underlying business fact actually happened vs. when the event store durably recorded it — these can differ under retry or backfill. |
| `propertyId` / `transactionId` / `partyId` | `number \| null` | Correlation to AgentEngineEasy's core entities; any or all may be null depending on the event. |
| `actorType` | `"USER" \| "SYSTEM" \| "PIT_CREW" \| "INTEGRATION" \| "AI"` | Who/what caused the event. |
| `actorId` | `number \| null` | |
| `brokerageId` / `agentId` | `number \| null` | Tenant/ownership scoping. |
| `source` | `string` | Convention: `"api:<module>:<action>"` or `"webhook:<module>:<provider>"`. |
| `correlationId` | `string` | Ties related events together across a business operation; see `newCorrelationId()` in `publisher.ts`. |
| `causationId` | `string \| null` | The specific event (if any) that directly caused this one. |
| `idempotencyKey` | `string \| null` | Set by the publisher when the same logical event could plausibly be published more than once (see Section 5). |
| `metadata` | `Record<string, unknown>` | Free-form, non-payload context. |
| `payload` | `TPayload` | The event-specific data. |
| `processingStatus` | `"PROCESSED" \| "PARTIAL_FAILURE" \| "FAILED"` | Set by the dispatch layer after handlers run — never set by the publisher. |
| `handlerErrors` | `Array<{handler: string; error: string}> \| null` | Populated when `processingStatus` is not `PROCESSED`. |
| `attemptCount` | `number` | |

`PublishEventInput<TPayload>` is what a publisher actually supplies: `DomainEvent` minus
the fields the store/dispatch layer owns (`id`, `recordedAt`, `processingStatus`,
`handlerErrors`, `attemptCount`), with `eventVersion` optional rather than required.

## 4. Versioning

`EVENT_TYPE_REGISTRY` in `packages/events/src/types.ts` is a
`Record<AgentEngineEasyEventType, {version: number; description: string}>`. Because it's
typed as a `Record` over the full union (not a partial map), TypeScript's object-literal
checking enforces bidirectional exhaustiveness at compile time: every member of
`AGENT_ENGINE_EASY_EVENT_TYPES` must have a registry entry, and the registry cannot contain
an entry for anything that isn't a member. Adding an event type to the array without adding
a matching registry entry (or vice versa) is a type error, not a runtime surprise.

All 100 entries are currently at `version: 1` — no event type has had a breaking payload
change since it was introduced. When one does, bump that event's `version` in the registry
and treat it the same way any versioned contract change is treated: consumers that care
about the payload shape should branch on `event.eventVersion`, and the change should be
called out in the PR that makes it.

## 5. Publish discipline

Publishing goes through `publishDomainEvent<TPayload>()` in
`packages/events/src/publisher.ts`. Its input type, `PublishEventInput<TPayload>`, requires
`eventType: AgentEngineEasyEventType` — so every call site in the codebase is validated
against the canonical union at compile time. This is a live guarantee, not just a
convention: the full monorepo typechecks cleanly with zero errors, which would not be true
if any call site passed a string outside the union.

The publisher's own header comment documents three rules that every caller is expected to
follow, and which this document restates because they're easy to miss when skimming a call
site in isolation:

1. **Persist first, publish second.** Call `publishDomainEvent` *after* the write it
   describes has already committed. If publishing throws, the caller's business
   transaction has already succeeded and must not be rolled back on account of it.
2. **Callers own their own failure handling.** Wrap the publish call in your own
   try/catch and log on failure — a broken event pipeline must never break AML
   submission, offer creation, settlement recording, or any other primary business
   operation.
3. **Set `idempotencyKey` whenever the trigger can plausibly re-fire** — webhook
   retries, a user double-clicking a non-idempotent action, and similar.

## 6. Consumption model

Consumers register through `registerHandler(eventType, handler)` in
`packages/events/src/registry.ts`, a `Map<AgentEngineEasyEventType, EventHandler[]>`.
`dispatchToHandlers(event)` runs every handler registered for `event.eventType`, isolating
per-handler failures — each handler runs in its own try/catch, errors are collected into
an `errors` array, and the result is returned as `{ok, errors}` rather than thrown, so one
handler's failure can never block a sibling handler or corrupt the persisted event record.
(`clearHandlersForTesting()` resets registry state between test runs.)

Four consumers currently register against the bus, using two distinct patterns:

**Universal subscription.** `registerAutomationEngine()` in
`apps/api/src/lib/automation/bootstrap.ts` (lines 1-30) loops over the *entire*
`AGENT_ENGINE_EASY_EVENT_TYPES` array and registers `handleAutomationDomainEvent` for
every one of the 100 event types — inclusive of any future addition, with no code change
needed at the consumer when the array grows. The bootstrap file's own comment justifies
this as cheap: for event types with zero active automation rules, the handler resolves to
one indexed, tenant-scoped `SELECT` returning no rows.

**Targeted subscription**, used by the other three consumers:

- `registerExceptionEventHandlers()` in `apps/api/src/lib/exceptions/engine.ts`
  (lines 230-258) registers `handleExceptionDomainEvent` only for the event types that
  actually appear in at least one `RISK_RULES[].triggerEventTypes` — a data-driven,
  curated subset rather than a hardcoded list.
- `apps/api/src/lib/financial/bootstrap.ts` (line 92) registers a single explicit
  handler: `SETTLEMENT_COMPLETED` → `handleSettlementCompleted`.
- `apps/api/src/lib/launch/bootstrap.ts` (line 38) registers a single explicit handler:
  `AGENCY_AGREEMENT_SIGNED` → `handleAgencyAgreementSigned`.

When adding a new consumer, prefer targeted subscription unless the consumer genuinely
needs visibility into every event type the way the automation engine does — it keeps the
registration list self-documenting about what a module actually reacts to, and avoids
paying a per-event dispatch cost for event types the consumer will never act on.

## 7. Enforcement and integrity

Event-type validity is enforced at the **type level only**, not the database level. The
`event_type` column in `packages/db/src/schema/events.ts` (line 11) is declared as plain
Postgres `text` (`eventType: text("event_type").notNull()`) — there is no `ENUM` type and
no `CHECK` constraint restricting its values. This means `AgentEngineEasyEventType` (and,
transitively, `AGENT_ENGINE_EASY_EVENT_TYPES`) is the *sole* source of truth for which
event-type strings are valid; the guarantee holds because every write path is TypeScript
that the monorepo typechecks cleanly, not because the database would reject an invalid
value if one somehow reached it (for example, from a manual `INSERT` or a future
non-TypeScript writer). Anyone adding a new way to write to the `events` table should keep
this in mind — it will not be caught by the database.

## 8. Relationship to other Part B documents

This document sits alongside two earlier Part B deliverables:

- **Stage 1 — Canonical Source Registry**: identified DOC-001 (the stale "19 canonical
  events" comment this document's Section 1 resolves) among its findings.
- **Stage 2 — `docs/LEGACY_DATA_CLASSIFICATION.md`** (PR #20, open as of this writing,
  not yet merged) and the `completeSettlement`/`closeTransaction` atomicity fix (PR #21,
  merged to `staging`): unrelated in mechanism, but both are examples of the same
  underlying theme this document also addresses — making an implicit guarantee (data
  provenance, transactional atomicity, event-type validity) explicit and verifiable
  rather than tribal knowledge.

## 9. Open items

- **DB-level enforcement of `event_type`** (Section 7) is a deliberate gap, not an
  oversight, but it has not been re-evaluated against the current risk tolerance. Adding a
  `CHECK` constraint (or generating one from `AGENT_ENGINE_EASY_EVENT_TYPES`) would close it
  but adds migration overhead every time an event type is added; left for a future stage to
  decide.
- **Per-event payload schemas** are not yet formalised — `TPayload` is generic and each
  publish call site currently defines its own inline shape. A follow-up could introduce a
  `payload` schema registry parallel to `EVENT_TYPE_REGISTRY`, gated on whether the
  cross-team payload-shape drift this would prevent has actually been observed as a
  problem.
- Risk 2 (AML best-effort refresh) and the five transaction-lifecycle functions not yet
  audited for atomicity remain explicitly deferred, per the scope agreed for the
  `completeSettlement`/`closeTransaction` fix — tracked separately from this document.
