# Integration Event and Delivery Model

How data moves in and out through the foundation: the outbox (outbound), the webhook
gateway and inbox (inbound), idempotency, retry/backoff, and how this relates to AE's
existing canonical domain-event bus (`packages/events`).

## 1. Relationship to the canonical event bus

AE already has one domain-event system (`packages/events`, documented in
`docs/EVENT_CONTRACTS.md`) — the 100-plus `DomainEvent` types every existing engine
publishes to and consumes from. This foundation does **not** introduce a second, competing
event model. It reuses `publishDomainEvent()` for the handful of integration-lifecycle
moments other AE engines might reasonably want to react to, and adds five new canonical
event types to `AGENT_ENGINE_EASY_EVENT_TYPES`:

| Event type | Published when |
| --- | --- |
| `INTEGRATION_CONNECTION_ACTIVATED` | A connection's `validateConnection()` call succeeds and it reaches `ACTIVE`. |
| `INTEGRATION_CONNECTION_SUSPENDED` | An operator suspends an `ACTIVE` connection. |
| `INTEGRATION_CONNECTION_REVOKED` | A connection is permanently revoked. |
| `INTEGRATION_COMMAND_DEAD_LETTERED` | An outbound outbox command exhausts retries or fails permanently. |
| `INTEGRATION_WEBHOOK_REJECTED` | An inbound webhook fails signature verification or resolves to no connection. |

**Unchanged by the Step 5 remediation pass.** Proofs B, C, and D — built after this
document was first written — reuse this exact same five-event list and the same
outbox/inbox/dead-letter row-as-envelope model described below; none of them needed a
sixth event type or a second delivery mechanism. Concretely: Proof B's SMS delivery-status
webhook (`SMS_DELIVERY_STATUS_UPDATE`, an *inbound webhook event type*, not one of the five
canonical `AGENT_ENGINE_EASY_EVENT_TYPES` above) and Proof C's payment-status webhook
(`MOCK_PAYMENT_STATUS_UPDATE`) both flow through the same `processInboundWebhook()`
gateway described in Section 3, registering their own `WebhookEffectHandler` the same way
the Launch proof's handler already did. Proof D doesn't add a new event type at all — its
Exception and Risk Engine rule simply *subscribes to* the existing
`INTEGRATION_COMMAND_DEAD_LETTERED` event this document already lists, the same way any
other AE engine can subscribe to any other domain event.

This list is deliberately minimal, following the same reasoning
`AUTOMATION_EXECUTION_COMPLETED`'s own history in `EVENT_CONTRACTS.md` §2.4 documents: an
inbound webhook's actual **domain** effect is published by the existing domain service it
calls through, not duplicated here. When the mock portal's "listing live" webhook updates
a portal destination, that update goes through Launch's own `confirmPortalLive`, which is
Launch's code, in Launch's file, using Launch's own event-publishing conventions — this
foundation does not also publish a second, parallel "something happened to a listing"
event. What these five events cover is exactly the integration-plumbing-level lifecycle
moments (a connection's own state, a command's own terminal failure, a webhook's own
rejection) that no other engine already represents.

**The internal envelope described in the build brief's Section 5.5** (event id, schema
version, tenant, correlation/causation, direction, idempotency key, trace id, and so on)
is not a new struct this build introduces. It maps directly onto fields that already exist
on two tables:

- **Outbound**: `integration_outbox` rows already carry `id`, `brokerageId`,
  `connectionId`, `capability`, `correlationId`, `causationId`, `idempotencyKey`,
  `sourceRecordType`/`sourceRecordId` (the aggregate reference), and `status` (the
  processing state) — the brief's envelope fields, on the row that IS the outbound
  intent, rather than a separate structure wrapping it.
- **Inbound**: `integration_inbox` rows carry the equivalent — `connectionId`,
  `brokerageId`, `provider`, `providerEventId` (the dedup key), `eventType`, `payload`,
  `signatureValid`, `receivedAt`, `processingStatus`.

Reusing the row itself as the envelope, rather than introducing a separate
`integration_events` table that would just duplicate these same fields, is the same
"reuse rather than duplicate" decision the schema file's header comment documents for
several other tables in the brief's illustrative list.

## 2. Outbound: the transactional outbox

`apps/api/src/lib/integrations/outbox.ts`, structurally identical in shape to the two
existing outbox implementations in this codebase (`lib/communications/outbox.ts` and
`financial_payment_outbox`'s own attempts/backoff convention) — this is a precedented
pattern in AE, not a new one invented for Step 5.

**`enqueueCommand(input)`** — idempotent on `idempotencyKey` (a unique DB constraint plus
a `23505`-catch-and-reselect, the same pattern `getOrCreateLaunchPlan` already uses). A
re-enqueue with the same key returns the existing row rather than creating a duplicate
command.

**`dispatchCommand(outboxId)`** — one attempt:

1. Loads the row; refuses anything not `PENDING`/`RETRY_SCHEDULED`.
2. Flips it to `DISPATCHING`.
3. Calls `resolveActiveConnection()` — **the** fail-closed check (see
   `INTEGRATION_SECURITY_BOUNDARY.md` §1). If the connection stopped being usable between
   enqueue and dispatch (suspended, revoked), the command is dead-lettered immediately,
   never retried — fail-closed applies at dispatch time, not just enqueue time.
4. Looks up the registered adapter; calls `adapter.send()`.
5. Records the attempt (`integration_outbox_attempts`, append-only).
6. On `SENT`: the row moves to `SENT`, done.
7. On failure: if the failure category is retryable (§4 of the adapter-contracts
   document) and attempts remain under `maxAttempts`, the row moves to
   `RETRY_SCHEDULED` with `nextAttemptAt` set by exponential backoff (`60s * 2^(n-1)`,
   capped at 30 minutes). Otherwise it's dead-lettered.

**`dispatchDueOutbox(now)`** — the sweep: every `PENDING`/`RETRY_SCHEDULED` row whose
`nextAttemptAt` has elapsed gets one dispatch attempt. `bootstrap.ts` runs this on a 60s
`.unref()`'d interval so it never keeps the process alive on its own — the same convention
`lib/communications/outbox.ts`'s own sweep already uses.

**Dead-lettering** (`failCommand`) writes a row to `integration_dead_letters` (source type
`OUTBOX`) and publishes `INTEGRATION_COMMAND_DEAD_LETTERED`. The event's idempotency key
includes the attempt number (`INTEGRATION_COMMAND_DEAD_LETTERED:<outboxId>:<attemptNumber>`),
not just the outbox row id — a real bug caught during this step's own test run (see
`INTEGRATION_FOUNDATION_COMPLETION_REPORT.md` §D): a replay that fails again permanently
calls `failCommand` a second time for the same row, and without the attempt number the
second publish collided with the first on `domain_events`' own idempotency-key uniqueness
constraint, silently losing the second dead-letter event.

## 3. Inbound: the webhook gateway

`apps/api/src/lib/integrations/webhooks.ts`, mirroring `lib/communications/webhooks.ts`'s
own shape. Mounted **outside** `requireAuth` (`routes/integrationsWebhooks.ts` —
`POST /integrations/webhooks/:connectionId/:provider`), because a real provider cannot
present an AE session cookie; authenticity comes from signature verification instead.

**`verifyWebhookSignature({rawBody, signatureHeader, secret})`** — HMAC-SHA256 over the
exact raw request bytes (captured via `app.ts`'s `express.json({verify})` hook, never a
re-serialised copy of the parsed body — signatures are computed over exact bytes by
design, and a re-serialisation can silently change them), compared with Node's
`timingSafeEqual` rather than `===` — a non-constant-time comparison would let an attacker
learn the correct signature one byte at a time via response-timing differences.

**`processInboundWebhook(input)`**, in order:

1. Payload-size check — `MAX_WEBHOOK_PAYLOAD_BYTES = 256 * 1024`; oversized requests are
   rejected before any processing.
2. Resolves the connection via `resolveActiveConnection()` — an unresolvable
   `connectionId` is rejected, never silently accepted as "some connection, somewhere".
3. If the signature is invalid: records the event as `REJECTED` in `integration_inbox`
   (for audit — a rejected event is still recorded, just marked as such) and publishes
   `INTEGRATION_WEBHOOK_REJECTED`. It is never dispatched to an effect handler.
4. Idempotency check — the unique index on `(connectionId, provider, providerEventId)`.
   A redelivery of an already-processed `providerEventId` is recorded as `DUPLICATE` and,
   critically, **never re-dispatched to the effect handler** — this is what stops a
   redelivered webhook from creating a second timeline entry, a second financial record,
   a second anything.
5. First receipt: inserted into `integration_inbox`, then dispatched to whatever
   `WebhookEffectHandler` is registered for `(provider, eventType)` via
   `registerWebhookEffectHandler()`. Handler success marks the row `PROCESSED`; a handler
   throw marks it `FAILED` and writes a dead letter (source type `INBOX`).

**Out-of-order protection** is the effect handler's own responsibility, not the gateway's
— the gateway only guarantees *exactly-once delivery to the handler*, not ordering. The
Launch proof's handler (`applyListingStatusUpdate` in `launchProof.ts`) demonstrates the
pattern: it treats `LIVE`/`FAILED` as terminal (`LIVE_TERMINAL_STATUSES`) and refuses to
let a later-arriving, earlier-state event (e.g. a stale `SUBMITTED` webhook delivered
after the destination is already `LIVE`) regress state — proven directly by
`launchProof.test.ts`'s final assertion. `commsProof.ts`'s and `financialProof.ts`'s own
webhook effect handlers (registered via `registerCommsIntegrationHandlers()` and
`registerFinancialIntegrationHandlers()` in `bootstrap.ts`, alongside the Launch proof's
own registration) follow the same "gateway guarantees exactly-once delivery, handler owns
its own domain invariants" division of responsibility — neither introduces a second
delivery guarantee mechanism.

## 4. Durability of idempotency

Both idempotency mechanisms are real unique database constraints, not an in-memory cache —
`integration_outbox.idempotencyKey` and the compound unique index on
`integration_inbox(connectionId, provider, providerEventId)`. This matters because the
brief (§5.8) explicitly calls out that "an in-memory cache alone is insufficient" — a
process restart, a horizontally-scaled second instance, or a race between two concurrent
webhook deliveries all still produce correct dedup behaviour, because the guarantee lives
in Postgres, not in a process-local `Map`.

## 5. What's deferred here

Sync cursors, the reconciliation-run framework, and the import/export job foundation
(brief §5.11, §5.13, §5.15) have no service code in this build — only the schema-level
reasoning documented in `packages/db/src/schema/integrations.ts`'s header comment for why
they were left out of the ten tables actually built. They are real gaps, not implemented
elsewhere under a different name; see the completion report for the honest scenario-level
accounting.
