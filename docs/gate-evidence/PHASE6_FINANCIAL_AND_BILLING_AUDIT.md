# Phase 6 — Financial & Billing Controls Audit

**Repo:** AgentEngineEasy / "Agent Engine 2.0" (local mirror, read-only, no `.git`)
**Scope:** Controlled-pilot operational readiness — financial and billing controls only.
**Method:** Direct code/schema reading with file:line citations. Pure-function commission/fee
calculation unit tests were actually executed (`node:test`, no DB) and confirmed passing;
DB-backed tests could not be executed (no `DATABASE_URL`/Postgres in this environment) and are
reported as "present but not independently re-run" rather than verified.

## 0. Jurisdiction — RESOLVED: Queensland, Australia (Critical Blocker Remediation, Phase 6)

**This section originally flagged an unresolved mismatch between the task brief and the
codebase. The AE Project Owner has since confirmed the pilot's actual jurisdiction, and it
matches the codebase, not the original brief.** The original finding is retained below,
corrected, as the record of what was checked and why it is now understood to be correct rather
than a discrepancy.

The original task brief described this as "a NZ real-estate transaction-management platform."
The codebase itself said otherwise, explicitly and repeatedly — and this is exactly what the AE
Project Owner has now confirmed is the correct jurisdiction for this pilot: **Queensland,
Australia.**

- `README.md:3` — *"A simplified, property-led real estate transaction platform for **Australian**
  real estate agents."*
- `ARCHITECTURE.md:240` — *"as is normal **AU** real-estate practice"*, *"plus 10% **AU GST** on
  top"*.
- `packages/db/src/schema/financial.ts:54` — *"GST: **AU 10%** ... is the default"*.
- `apps/api/src/lib/transactions.ts:28` — `const GST_RATE_BPS = 1000; // 10% — AU GST`.
- `apps/api/src/lib/financial/pcFeeCalculations.ts:14-19` — `const GST_RATE_BPS = 1000;` hardcoded
  with a comment explaining it is deliberately **not** configurable.
- Currency is hardcoded `"AUD"` at every call site that charges or schedules money:
  `packages/integrations/payments/src/index.ts:8`, `packages/integrations/mandate-payments/src/index.ts:35`,
  `apps/api/src/lib/payments.ts:223`, `apps/api/src/lib/financial/paymentOutbox.ts:274`,
  `packages/db/src/schema/billing.ts:26` (`currency: text("currency").notNull().default("AUD")`),
  `packages/db/src/schema/commissionAgreements` default `currency: "AUD"` (`financial.ts:211`).
- The mandate-debit shape is explicitly modelled as an **AU** Direct-Debit-Request
  (`packages/integrations/mandate-payments/src/index.ts:9,25`), not a NZ direct-debit or
  Automatic Payment scheme.

**Conclusion (updated): this is an Australian-market codebase (AU GST rate, AUD currency, AU
direct-debit shape) built for, and now confirmed to be used for, a Queensland, Australia pilot.**
Every default cited above is the **correct** default for the confirmed jurisdiction — none of it
requires a code change on jurisdiction grounds. See Section 4 for the one item that remains
worth tracking regardless of jurisdiction: the Pit Crew success-fee GST rate has no
per-brokerage override field, which only matters if this rate or jurisdiction ever changes in
the future.

---

## 1. What billing/charging mechanisms exist at all

Three genuinely separate billing/charging subsystems exist in code, each with its own schema and
provider abstraction:

1. **Subscription billing** ("Grow" CRM add-on) — `packages/db/src/schema/billing.ts`
   (`products`, `prices`, `subscriptions`, `subscriptionItems`, `entitlementGrants`,
   `billingWebhookEvents`), driven by `packages/integrations/billing/src/index.ts`
   (`MockBillingProvider` / `StripeBillingProvider`) via `apps/api/src/lib/billing/gateway.ts`
   and synced into entitlements by `apps/api/src/lib/billing/sync.ts`.
2. **Pit Crew (PC) success-fee billing** — `packages/db/src/schema/financial.ts`
   (`commissionAgreements`, `commissionCalculations`, `pcFeeAuthorities`, `pcFeeCalculations`,
   `financialPaymentRequests`, `financialPaymentOutbox`, `financialDisputes`), driven by
   `packages/integrations/mandate-payments/src/index.ts` (`SandboxMandatePaymentProvider` only —
   see Section 6) via `apps/api/src/lib/financial/*`.
3. **Manual/ad-hoc service charges** ("ServiceOrder", e.g. AML checks, title searches, marketing) —
   `packages/db/src/schema/commerce.ts` (`paymentMethods`, `serviceOrders`, `payments`), driven by
   `packages/integrations/payments/src/index.ts` (`MockPaymentProvider` / `StripePaymentProvider`)
   via `apps/api/src/lib/payments.ts`.

In addition, `apps/api/src/lib/transactions.ts` has its own **legacy flat commission calculation**
(`calculateCommission()`, line 418) that is independent of the Financial Engine and always
available even with none of the above configured — this is the "no billing at all, just recorded
figures" path.

There is **no manual-invoice-document generation** anywhere (see Section 5) — "manual invoicing"
today means an admin recording numbers into fields, not the system producing an invoice a client
or PC could be handed.

## 2. Subscription entitlement enforcement (tier gating)

Enforcement is real and server-side, not just UI-side:

- `apps/api/src/lib/entitlements/resolver.ts:134-139` — `requireEntitlement()` throws
  `EntitlementError` on denial; `explainEntitlementDecision()` (lines 95-132) fails closed
  (`ENTITLEMENT_MISSING`) on any resolver error.
- `apps/api/src/middlewares/entitlement.ts:6-34` — the actual HTTP gate: comment states plainly
  *"this is the actual security boundary, not the UI's locked state"*; returns 403 on denial.
- Applied on real routes: `apps/api/src/routes/grow.ts:32,46,77,143,204,281` and
  `apps/api/src/routes/import.ts:56,82,91,104,131,142,185,229`.
- Grants are the sole source of truth (`resolver.ts:9-13`) — never re-derived from a subscription
  row at request time, and `invalidateEntitlementCache()` is called on every subscription change
  (`apps/api/src/lib/billing/sync.ts:15,123,244`).

**However, the tier names in the pilot brief do not match the code.** There is no "Run", "Grow",
"Scale" three-tier structure anywhere in this codebase. The actual product catalogue
(`apps/api/src/lib/billing/catalogue.ts:32-34,75-77`) is:
- `agent_engine_starter` ("Starter" — description: *"Core Agent Engine **RUN** platform"*)
- `grow` ("Grow" — a CRM/relationship-management add-on, $99/mo)
- `agent_engine_pro_grow_bundle` ("Pro + Grow Bundle", $289/mo)

A repo-wide search found **no "Scale" product, price, or entitlement anywhere** in
`apps/api/src`, `packages/db/src`, or `docs/`. Entitlement gating (`grow.access`,
`grow.contacts.manage`, etc.) only exists for the Grow CRM module — the core transaction platform
("Starter"/"Run") has no entitlement gate at all in this build; it is simply available once a
user is authenticated into a brokerage. **Conclusion: entitlement enforcement is real for what
exists (Grow), but a "Run/Grow/Scale" three-tier model as described in the brief is not
implemented — "Scale" does not exist in code.**

## 3. Pricing — hardcoded, configurable, or absent?

Mixed, and mostly sound:
- Subscription pricing is genuinely data, not logic: `catalogue.ts:9-13` states this explicitly
  and seeds `prices` rows ($69/$99/$289 monthly) rather than hardcoding amounts in business logic;
  `resolver.ts` never reads a price, only `entitlementGrants`.
- Commission rates are per-transaction, admin-entered, versioned data
  (`commissionAgreements.rateBps`/`.tiers`/`.fixedAmountCents`,
  `packages/db/src/schema/financial.ts:212-221`) — not hardcoded.
- The **Pit Crew fee rate** has a hardcoded *default* (`financial.ts:879`,
  `defaultPcFeeRateBps: ... .default(690)`, i.e. 6.90%) but is fully overridable per
  `pcFeeAuthorities.rateBps` (`financial.ts:330`) — configurable, with a sane fallback.
- The **GST rate applied to the Pit Crew fee itself** is the one place pricing is truly hardcoded
  with **no override path**: `pcFeeCalculations.ts:14-19`, `const GST_RATE_BPS = 1000;` — the
  module comment explicitly says this was a deliberate choice not to add a configurable field.
  This rate (10%) is correct for the confirmed Queensland, Australia jurisdiction today; the gap
  is the absence of an override, tracked as a future item (Section 4) in case the rate or
  jurisdiction ever changes, not a present compliance risk.

## 4. GST treatment (confirmed jurisdiction: Queensland, Australia)

GST **is** calculated and recorded as structured data (not absent), and — now that the
jurisdiction question is resolved — it is the correct Australian GST logic for this pilot:
- Commission GST: `commissionAgreements.gstRateBps` defaults to 1000 (10%, correct for AU) but is
  a real, stored, per-agreement field (`financial.ts:224`) — a brokerage admin could still
  manually set a different rate per agreement if ever needed. `computeCommission()`
  (`apps/api/src/lib/financial/calculations.ts:144-145`) correctly reads and applies whatever
  rate is stored.
- The legacy flat calculation (`lib/transactions.ts:28,436`) hardcodes 1000 bps (10% AU GST,
  correct for this pilot) with no override at all.
- The **Pit Crew success-fee GST** (`pcFeeCalculations.ts:19,82`) is hardcoded to 1000 bps with
  **no field to override it, anywhere in the schema** (`pcFeeAuthorities` has no `gstRateBps`
  column — only a boolean `gstApplicable`, `financial.ts:333`). This is the correct rate for
  Queensland, Australia today. **Tracked future item:** because there is no override field, this
  platform could not correctly serve a second jurisdiction with a different GST/VAT rate, or
  adapt automatically if the Australian GST rate itself ever changes, without a code change. This
  is not a blocker for the current, single-jurisdiction pilot.
- No jurisdiction/tax-authority field exists anywhere (no per-brokerage jurisdiction setting) —
  `financialSettings` (`financial.ts:874-885`) has `defaultGstRateBps` but it is not read by
  `pcFeeCalculations.ts` at all (that module hardcodes its own constant instead of consulting
  `financialSettings`). Wiring `pcFeeCalculations.ts` to read `financialSettings.defaultGstRateBps`
  (falling back to the current 1000 bps constant) would be a reasonable, low-risk future
  improvement that closes this gap without changing today's behavior — recorded here as a
  suggestion, not performed as part of this bounded correction pass.

**Conclusion (updated): GST is calculated and recorded, and the code's GST logic — the
Australian 10% rate — is the correct rate for the confirmed Queensland, Australia pilot. The
gap is architectural (no override field for the Pit Crew fee specifically), not a jurisdiction
error, and is tracked as a non-blocking future item.**

## 5. Invoice generation

**No real invoice document generation exists.** What exists is data fields only:
- `financialPaymentRequests.invoiceNumber` / `.invoiceIssuedAt` (`financial.ts:422-423`) and the
  status vocabulary includes `READY_TO_INVOICE` / `INVOICED` (`financial.ts:113-114`).
- A repo-wide search for `invoiceNumber`, `invoiceIssuedAt`, `READY_TO_INVOICE`, `generateInvoice`,
  and PDF-generation code in `apps/api/src` returns **no writer anywhere** — nothing ever sets
  `invoiceNumber` or `invoiceIssuedAt`, and no payment request is ever transitioned to
  `READY_TO_INVOICE` or `INVOICED`.
- `apps/api/src/lib/financial/paymentOutbox.ts:17-20` states this outright: *"Advancing a payment
  request through its earlier, business-facing states (AWAITING_AUTHORITY, READY_TO_INVOICE,
  invoice-number issuance) is Stage E/G's job"* — that stage was never built. The actual code path
  (`settlement.ts`'s `ensurePcSuccessFeeRequest`, status `"CALCULATED"`) jumps straight to
  `advancePaymentRequestToNoticeSent()` (`paymentOutbox.ts:82-118`), which sets status
  `NOTICE_SENT` directly — skipping `AWAITING_AUTHORITY`/`READY_TO_INVOICE`/`INVOICED` entirely.
- The only other "invoice" concept in the financial engine, `marketingPaymentRecords.invoiceReference`
  (`financial.ts:575`), is a free-text field a human types in after receiving a supplier's own
  invoice — not something the system produces.

**Conclusion: no invoice is ever generated by this codebase — for either the commission side or
the Pit Crew fee side. There is no PDF/document output and the invoicing state-machine steps in
the schema's own vocabulary are unimplemented.**

## 6. Payment provider integration — real, sandbox, or mocked?

Three independent provider abstractions, all defaulting to non-real implementations:

- **ServiceOrder charges** (`packages/integrations/payments/src/index.ts`): a real
  `StripePaymentProvider` class exists (lines 101-249) — genuine `POST /v1/payment_intents`
  calls, real `Stripe-Signature` HMAC verification with 5-minute tolerance and
  `timingSafeEqual` (lines 188-213). Selected only when `PAYMENT_PROVIDER=stripe` **and** both
  `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` are set (`createPaymentProvider()`, lines 251-267);
  otherwise falls back to `MockPaymentProvider` (lines 41-73). `.env.example:44` ships
  `PAYMENT_PROVIDER=mock` as the documented default.
- **Grow subscription billing** (`packages/integrations/billing/src/index.ts`): a real
  `StripeBillingProvider` exists (lines 114-205, checkout sessions, subscription cancel), but its
  `verifyWebhookSignature()` (lines 159-165) is **not real signature verification** — the code
  comment admits it: *"Stage A placeholder ... today this fails closed ... rather than trusting an
  unverified payload"*, and the implementation is just `signature.length > 0 && payload.length > 0`
  — it accepts any non-empty signature string, it does not check the HMAC at all. Selected via
  `BILLING_PROVIDER=stripe` (not even documented in `.env.example`); defaults to `MockBillingProvider`.
- **Pit Crew success-fee mandate debits** (`packages/integrations/mandate-payments/src/index.ts`):
  **there is no real provider implementation at all.** Only `SandboxMandatePaymentProvider` exists
  (lines 100-159). The module header states plainly (lines 22-28): *"No real bank-debit vendor is
  procured for this build ... so only the sandbox adapter ships."*
  `createMandatePaymentProvider()` (lines 161-171) warns and falls back to sandbox for **any**
  value of `MANDATE_PAYMENT_PROVIDER` other than `"sandbox"` — there is no `MANDATE_PAYMENT_PROVIDER`
  entry in `.env.example` at all, and no code path in this repository can turn this into a real
  charge, regardless of configuration.

**Conclusion:** ServiceOrder charging has a genuine (if untested-in-this-audit) Stripe path
available. Grow subscription billing has a Stripe path with a webhook-verification placeholder
that must not be trusted as-is. **The Pit Crew success-fee flow — the mechanism most central to
this platform's business model — is 100% simulated with no real payment rail available in code
today, full stop.**

## 7. Settlement-event trigger

`completeSettlement()` in `apps/api/src/lib/transactions.ts:470-523` is the trigger: a
Brokerage-Administrator/agent action (via `POST /transactions/:id/complete-settlement`, gated by
role at the route layer) that requires a settlement date already scheduled, sets
`settlementCompletedAt`, and publishes the `SETTLEMENT_COMPLETED` domain event
(`lib/transactions.ts:511-515`). That event is consumed by
`handleSettlementCompleted()` (`apps/api/src/lib/financial/bootstrap.ts:40-86`), registered via
`registerHandler("SETTLEMENT_COMPLETED", handleSettlementCompleted)`
(`bootstrap.ts:92`), which:
1. Calls `finalizeCommissionForSettlement()` (no-op if no `APPROVED` commission agreement exists —
   `settlement.ts:90-103`).
2. If that produced a calculation, looks up the agent's `ACTIVE` PC fee authority
   (`bootstrap.ts:63-66`) — no authority, no fee, by design (comment: *"never invented, only ever
   recorded"*).
3. Calls `createPcFeeCalculation()` then `ensurePcSuccessFeeRequest()` to create the
   `PC_SUCCESS_FEE` payment request.

This is a genuine, human-triggered settlement event (not a scheduled job or webhook), and the
whole chain is a no-op absent an approved commission agreement and an active PC fee authority —
appropriate defaults for a pilot with synthetic data.

## 8. Success-fee (Pit Crew) calculation logic

Code: `apps/api/src/lib/financial/pcFeeCalculations.ts:47-86` (`computePcFee`, pure function).
Logic: resolves the GCI basis (ex-GST or inc-GST commission per `gciDefinition`), applies
`feeBasis` (`PERCENTAGE_OF_GCI` / `FIXED_AMOUNT` / `NONE` / `MANUAL_WITH_REASON`), caps at
`maximumAmountCents` if set, then adds GST at the hardcoded 10% (see Section 4). Rounding is
`Math.round` per step with each rounding adjustment recorded (`RoundingAdjustment[]`), mirroring
the commission calculation's own approach.

**Verified by actually running the tests** (`node:test`, no DB required — pure functions only):

```
apps/api/src/lib/financial/__tests__/calculations.test.ts    — 15 tests, all passing
apps/api/src/lib/financial/__tests__/pcFeeCalculations.test.ts — 6 tests, all passing
21 tests total / 21 pass / 0 fail
```

Coverage includes: percentage-of-GCI, `COMMISSION_INC_GST` vs `COMMISSION_EX_GST` basis,
`maximumAmountCents` capping, `FIXED_AMOUNT`/`NONE` bypassing the GCI basis, and GST suppression
when `gstApplicable` is false. The logic itself reads as internally consistent and correctly
implements what it claims to. **Not independently verified:** the DB-backed integration tests
(`settlement.test.ts`, `pcFeeAuthorities.test.ts`, `paymentOutbox.test.ts`,
`paymentWebhooks.test.ts`, `schema.test.ts`, `legacyReconciliation.test.ts` — 2,046 lines total)
could not be executed in this environment (`DATABASE_URL is not set`, `packages/db/src/index.ts:5-9`),
so their claimed coverage of persistence/idempotency/webhook behavior is taken on the strength of
the code being read directly (Sections 7, 9, 10), not re-run.

## 9. Duplicate-charge prevention (idempotency)

Strong, layered idempotency, present at every stage of the Pit Crew fee pipeline:
- **Settlement → payment request:** `financial_payment_requests_transaction_kind_idx`, a DB-level
  unique index on `(transactionId, kind)` (`financial.ts:461`), backed by
  `ensurePcSuccessFeeRequest()`'s SELECT-before-INSERT + `.onConflictDoNothing()` + re-SELECT-on-race
  pattern (`settlement.ts:193-256`) — explicitly documented as *"THE settlement-idempotency
  chokepoint"*.
- **Outbox dispatch:** `financial_payment_outbox_payment_request_action_idx`, unique on
  `(paymentRequestId, action)` (`financial.ts:517`), plus an idempotent short-circuit in
  `scheduleDebitForPaymentRequest()` (`paymentOutbox.ts:151-163`) that returns the already-dispatched
  result rather than re-dispatching.
- **Provider-level:** every debit call carries an `idempotencyKey`
  (`paymentOutbox.ts:275`, `= schedule-debit:<paymentRequestId>`); `SandboxMandatePaymentProvider`
  deliberately **replays** the cached result for a repeated key rather than erroring
  (`mandate-payments/src/index.ts:72-98`) — modelling real-provider idempotency-key semantics.
- **Inbound webhooks:** `financial_payment_provider_events_dedup_idx`, unique on
  `(provider, providerEventId)` (`financial.ts:484`), with insert-before-apply so a redelivered
  webhook fails the unique constraint before any state changes (`paymentWebhooks.ts:91-103`).
- **ServiceOrder charges** (separate flow): `payments.idempotencyKey` is a DB-unique column
  (`commerce.ts:60`), and `chargeServiceOrder()` checks for an existing `Succeeded`/`Pending`
  attempt before charging again (`lib/payments.ts:176-185`).

**Conclusion: idempotency protection is genuinely strong and multi-layered, not just aspirational
comments.**

## 10. Failed-payment handling

- **Pre-dispatch failures / provider errors:** `dispatchOutboxEntry()`
  (`paymentOutbox.ts:254-386`) retries with exponential backoff (`backoffMinutesFor`, 2 min → up to
  24h cap, lines 238-243) up to `maxAttempts` (default 3, `financial.ts:440`); once exhausted, both
  the outbox row and the payment request are marked terminally `FAILED`
  (`paymentOutbox.ts:325-356`), a `PC_FEE_PAYMENT_FAILED` ledger event is recorded, and a
  `FIN01_PC_FEE_PAYMENT_FAILED` risk-exception finding is raised
  (`apps/api/src/lib/exceptions/rules/financial.ts:66-108`) requiring human resolution
  (reissue/waive/write-off) — it does not silently retry forever nor silently vanish.
- **Provider-reported failure via webhook:** `applyMandateWebhookResult()`'s `"Failed"` branch
  (`paymentWebhooks.ts:186-249`) is retryable up to `financialPaymentRequests.maxRetries`
  (default 3); once exhausted it sets status `FAILED`, and — a good touch — proactively posts an
  internal note to the property's Financial notices thread naming the listing agent
  (`paymentWebhooks.ts:234-246`), so a human is notified rather than the failure sitting invisibly
  in a database row.
- **ServiceOrder charge failures** (separate flow) are recorded (`status: "Failed"`,
  `failureReason`) and are retryable on a fresh attempt (`lib/payments.ts:247-261`).

**Conclusion: failed-payment handling is real, bounded (never infinite retry), and surfaces to a
human through the existing Exception & Risk Engine and a notification — a solid design.**

## 11. Refund/cancellation handling

- **Pre-clearing cancellation:** `cancelScheduledDebit()` (`paymentOutbox.ts:426-460`) — only
  works while status is `DEBIT_SCHEDULED`, calls the provider's `cancelScheduledDebit`, moves the
  request to `WAIVED`.
- **Post-clearing reversal:** `reverseDebit()` (`paymentOutbox.ts:470-511`) — only works from
  `PAID`, calls the provider's `reverseDebit`, moves the request to `REVERSED`.
- **Provider-initiated reversal** arrives via the `"Reversed"` webhook branch
  (`paymentWebhooks.ts:252-285`).
- **ServiceOrder refunds:** `refundPayment()` (`lib/payments.ts:334-358`), Brokerage-Administrator-only,
  calls the real/mock provider's `refund()`.

Both PC-fee cancel/reverse actions require only a free-text `reason` and a Brokerage
Administrator role — **no second-approval / separation-of-duties check**, unlike agreement
approval and authority activation (see Section 15).

## 12. Reconciliation against the payment processor's actual settled transactions

**This does not exist for real money.** Two reconciliation mechanisms are present, and both are
explicitly scoped away from being a real processor-settlement match:

- `apps/api/src/lib/financial/legacyReconciliation.ts` — reconciles the app's own **legacy flat
  commission figures** against the newer Financial Engine's structured records (an internal
  data-migration/coherence check), not against any payment processor.
- `apps/api/src/lib/financial/mockPaymentStatusSync.ts` — its own name and header comment say it
  plainly: *"validates an inbound **mock** payment-STATUS observation"* (line 4-5), and *"no writer
  anywhere in the Financial Engine sets status 'RECONCILED' today, and this module does not change
  that"* (lines 16-18). Even a matching event only produces `PARTIALLY_RECONCILED`
  (`mockPaymentStatusSync.ts:220`) — full `RECONCILED` status requires a human, and a repo-wide
  search confirms **no code anywhere sets `financialPaymentRequests.reconciliationStatus` to
  `RECONCILED`**, and no code sets a `financialReconciliations` row's `status` to `RECONCILED`
  except a manual test fixture (`__tests__/legacyReconciliation.test.ts:272`, an admin manually
  editing the row).

**Conclusion: there is no automated reconciliation against a real payment processor's settled
transactions (Stripe payout/balance-transaction reports, bank statements, etc.) anywhere in this
codebase.** This is consistent with there being no real payment processor in the Pit Crew flow at
all (Section 6).

## 13. Fee dispute process

Partially implemented, and explicitly one-directional:
- **Opening a dispute:** the `"Disputed"` webhook branch (`paymentWebhooks.ts:287-321`) is
  idempotent (checks for an existing `OPEN` dispute before inserting another) and creates a
  `financialDisputes` row plus a `PC_FEE_DISPUTED` ledger event; the payment request itself moves
  to status `DISPUTED`.
- **Surfacing it:** `FIN02_FINANCIAL_DISPUTE_OPEN`
  (`apps/api/src/lib/exceptions/rules/financial.ts:110-160+`) raises a risk-exception finding for
  any dispute still `OPEN`/`UNDER_REVIEW`.
- **Resolving it: no code path exists at all.** A repo-wide search for any `UPDATE`/write to
  `financialDisputes` finds only the single insert above — **there is no route, service function,
  or script anywhere that ever changes a `financialDisputes.status` away from `OPEN`**, despite the
  schema defining `UNDER_REVIEW`/`RESOLVED_PAYABLE`/`RESOLVED_ADJUSTED`/`RESOLVED_WAIVED`/`CLOSED`
  as real values (`financial.ts:143`). `financial.ts` (the route file) only exposes
  `GET .../payment-requests/:id` with its disputes attached (`routes/financial.ts:478-484`) — read
  only.

**Conclusion: a dispute can be recorded and flagged, but the system provides no way — in code —
to ever close it out. This is a genuine, confirmed gap, not a design choice documented anywhere.**

## 14. Audit history for financial actions

Two separate audit surfaces exist, and the Financial Engine mostly uses the narrower one:
- **`financialLedgerEvents`** (`financial.ts:791-823`) — an append-only, immutable ledger with a
  large, well-considered vocabulary (`FINANCIAL_LEDGER_EVENT_TYPES`, lines 745-788) covering every
  commission/PC-fee/dispute/marketing/deposit state transition. This table is written to
  consistently by every financial service function (`agreements.ts`, `calculations.ts`,
  `pcFeeAuthorities.ts`, `settlement.ts`, `paymentOutbox.ts`, `paymentWebhooks.ts`). It is exposed
  read-only to Brokerage Administrators via `GET /financial/ledger-events`
  (`routes/financial.ts:553-558`).
- **`auditLogs`** (`lib/audit.ts`, the app-wide `logAudit()` that feeds the Property Timeline
  every other domain uses) is **not called by the financial engine's commission/PC-fee code at
  all** — a repo-wide search of `apps/api/src/lib/financial/*.ts` finds `logAudit` used only in
  `mockPaymentStatusSync.ts` (linking an external reference, and recording an observed mock status,
  lines 125-131 and 250-256 of that file). Commission agreement approval/cancellation, PC fee
  authority create/activate/revoke, and debit schedule/cancel/reverse **never** call `logAudit()`.
  This is a discrepancy from the schema's own stated design intent
  (`packages/db/src/schema/financial.ts:44-49`: *"auditLogs ... is still called via logAudit() for
  every sensitive mutation, exactly as every other domain in this app does"*) — that claim does
  not hold for the bulk of the financial engine as actually implemented. A practical consequence:
  financial-engine actions do **not** appear on the Property Timeline (`lib/timeline.ts` does not
  reference `financialLedgerEvents` at all), only in the separate, admin-only ledger-events API.

**Conclusion: financial actions are consistently and durably logged, but to a separate,
narrower, admin-only ledger rather than the app's general audit/timeline surface the schema
comment claims — a documentation/implementation mismatch worth resolving before scaling beyond a
pilot, though not itself a loss of evidence.**

## 15. Prevention of manual fee bypass

Real controls exist for *creation*, weaker/absent controls exist for *undoing*:
- **Separation of duties on creation/approval** — enforced in code, not just at the route layer:
  - `approveCommissionAgreement()` rejects self-approval: *"the user who drafted a commission
    agreement cannot also approve it"* (`agreements.ts:145-147`, `SEPARATION_OF_DUTIES` error).
  - `activatePcFeeAuthority()` rejects self-activation identically
    (`pcFeeAuthorities.ts:124-126`).
  - Both routes are additionally restricted to `Brokerage Administrator` at the route layer
    (`routes/financial.ts:91`, the **only** role permitted anywhere on `/financial/*`).
  - `FIN04_COMMISSION_AGREEMENT_APPROVAL_STALLED` (`exceptions/rules/financial.ts:30-34`)
    surfaces a stuck approval precisely because the creator cannot self-clear it.
- **No such control on undoing a fee once due.** `cancelScheduledDebit()` (waive),
  `revokePcFeeAuthority()`, and `reverseDebit()` each require only a single Brokerage
  Administrator and a free-text `reason` string (Sections 10-11) — there is no check that the
  actor cancelling/waiving/revoking is different from whoever created or approved the underlying
  record. A single compromised or dishonest Brokerage-Administrator account **could** waive a
  scheduled PC success-fee debit, revoke the authority behind it, or cancel the commission
  agreement that produced it, entirely unilaterally.
- Every such action **is** durably logged (`financialLedgerEvents`, with `actorUserId` and
  `reason` — Sections 9-11, 14), so the action would be forensically visible after the fact, but
  nothing in code *prevents* it before the fact, and nothing routes it to a second approver or
  raises a dedicated risk-exception the way a stalled approval does.
- `RBAC` is coarse: only one role (`"Brokerage Administrator"`) has any access to `/financial/*`
  at all (`middlewares/auth.ts:13`) — there is no separate "Finance Manager"/"Compliance" role that
  could provide a genuine second set of eyes independent of whoever administers the brokerage.

**Conclusion: bypass is not "click a button and the fee disappears silently" — every bypass path
is logged with an actor and a reason — but a single admin acting alone genuinely can waive,
revoke, or reverse a Pit Crew fee with no second-approval requirement, unlike creating one.**

## 16. CRITICAL — the custody boundary claim

**Claim under test:** "AE must not receive, hold, transfer or disburse trust money," and PC fee
debits are scoped to the agent's own general operating account via
`authorisedPaymentMethod: "GENERAL_ACCOUNT_DEBIT_MANDATE"`, never a client/deposit/trust account.

**Direct verification, schema and code:**

- `pcFeeAuthorities.authorisedPaymentMethod` (`packages/db/src/schema/financial.ts:336`) is a
  free-text (`text`) column defaulting to `"GENERAL_ACCOUNT_DEBIT_MANDATE"`. It is **not** a
  Postgres enum and **not constrained** to a fixed set of values by any CHECK constraint in the
  schema.
- `CreatePcFeeAuthorityInput.authorisedPaymentMethod` (`apps/api/src/lib/financial/pcFeeAuthorities.ts:70`)
  is an optional plain `string` parameter accepted from the caller
  (`createPcFeeAuthority()`, lines 79-103) with **no validation of its value at all** — the input
  is written straight through: `authorisedPaymentMethod: input.authorisedPaymentMethod ??
  "GENERAL_ACCOUNT_DEBIT_MANDATE"` (line 94).
- At the HTTP layer, `POST /financial/pc-fee-authorities` (`routes/financial.ts:335-345,360-369`)
  does **not even accept `authorisedPaymentMethod` in its Zod schema** (`createAuthoritySchema`) —
  meaning the only way to set it via this route is to *not* set it, so the default
  `"GENERAL_ACCOUNT_DEBIT_MANDATE"` always applies in practice through the API surface as it exists
  today. But this is a byproduct of the route's Zod schema simply omitting the field, not a
  deliberate, enforced constraint — if a future route or script passed a different value (e.g. a
  developer wiring up a batch-import script, or a future admin UI feature), nothing in
  `createPcFeeAuthority()` or the database schema would reject it.
- Once activated, nothing downstream re-checks `authorisedPaymentMethod` at all before scheduling
  a debit: `scheduleDebitForPaymentRequest()`/`dispatchOutboxEntry()`
  (`paymentOutbox.ts:135-231, 254-386`) read `authority.mandateProviderRef` and call
  `mandatePaymentProvider.scheduleDebit()` — they never inspect `authority.authorisedPaymentMethod`
  at all. The field is descriptive metadata the code trusts was set correctly at authority-creation
  time; it is not re-verified as a gate at charge time.
- There is no `financialDeposits`/trust-account code path anywhere that is wired to
  `mandatePaymentProvider` or any payment provider — `financialDeposits`
  (`financial.ts:601-639`) is explicitly evidentiary/read-only (`externalHolderType`,
  `externalTrustAccountRef` are free-text fields a human records for evidence, never touched by
  any charge/debit function). A repo-wide check confirms no import of `financialDeposits` in
  `paymentOutbox.ts`, `paymentWebhooks.ts`, `provider.ts`, or either payment/mandate integration
  package.
- The mandate-payments package's own header (`packages/integrations/mandate-payments/src/index.ts:15-21`)
  states the custody boundary as an architectural *intention*: *"this package only ever talks to
  an external provider's REST/webhook surface — it never holds funds ... and the mandate itself
  ... is captured by an external, already-authorised process before anything here is called."*
  This is true of what the code does (it never models or moves trust money, never touches a trust
  ledger, has no bank-account-holding logic of its own) — but it is true because **AE's code
  simply never implements the deposit/trust side as a chargeable object**, not because of an
  enforced boundary check that would stop it if someone tried.

**Plain verdict:** The custody boundary holds **today**, as a fact about what this codebase
implements — there is no trust-account model wired to any charge function, and the default
(and, via the current route's Zod schema, the *only reachable*) value for
`authorisedPaymentMethod` is `"GENERAL_ACCOUNT_DEBIT_MANDATE"`. But this is an **emergent property
of what has and hasn't been built**, not an enforced invariant: the field is a free-text
description with no database or application-level validation, no downstream code checks it before
scheduling a debit, and nothing would stop `authorisedPaymentMethod` from being set to something
else (e.g. a mistakenly-entered trust-account reference) if a future code path — a script, an
admin bulk-import, a future UI feature — ever passed a different value. **The claim is
documented and true-in-effect for the pilot as it stands today; it is not technically enforced.**
Recommend adding either a Postgres CHECK constraint / enum restricting
`authorisedPaymentMethod` to an explicit allow-list, or an assertion in
`createPcFeeAuthority()`/`activatePcFeeAuthority()` that rejects any value other than
`GENERAL_ACCOUNT_DEBIT_MANDATE`, before this claim is relied on beyond a pilot with a fixed,
reviewed set of callers.

---

## Recommendation

**Run this pilot as free / manually-invoiced only. Do not enable live charging for any of the
three billing subsystems.** (Confirmed under the Critical Blocker Remediation pass: no automated
subscription/direct-debit/PC success-fee/trust-money transaction is authorised.)

Reasoning, drawn only from the findings above:

1. **The Pit Crew success-fee flow — the feature this platform's business model most depends on —
   has no real payment provider in code at all** (Section 6). There is no configuration that turns
   it on; `SandboxMandatePaymentProvider` is the only implementation that exists. Any claim that
   "PC fees will actually charge agents" during this pilot is not possible as the code stands —
   this alone settles the question for that flow.
2. **Invoicing is entirely unimplemented** (Section 5) — even if a real mandate provider existed,
   there is no code path that produces an invoice number or document, and the schema's own
   invoicing states (`AWAITING_AUTHORITY`, `READY_TO_INVOICE`, `INVOICED`) are never reached.
   Charging a real agent real money with no invoice ever issued is not something to pilot live.
3. **The Pit Crew fee GST rate has no override for a future jurisdiction change** (Section 4) —
   this is correct at 10% for the confirmed Queensland, Australia pilot today, but if this
   platform is ever extended to a jurisdiction with a different rate, or the Australian rate
   itself changes, this hardcoding would need to be fixed first. Not a live-charging blocker for
   this pilot, but worth closing before scaling beyond it.
4. **Fee disputes can be opened but never closed in code** (Section 13), and **reconciliation
   against actual settled payment-processor transactions does not exist** (Section 12) — both are
   acceptable gaps for a pilot recording synthetic transactions, but neither should be live with
   real money moving, because there is no way to close the loop when something goes wrong.
5. The two flows that *do* have a real Stripe adapter available (ServiceOrder charges, Grow
   subscription billing — Section 6) both default to mock and require explicit environment
   configuration to go live; that configuration should stay unset for this pilot. The Grow billing
   webhook signature check is a known, admitted placeholder (Section 6) and should not be trusted
   with real Stripe traffic yet regardless.
6. What **does** work well and would support a pilot on synthetic/test data: the commission and
   PC-fee calculation math itself (verified passing, Section 8), idempotency protection at every
   layer (Section 9), bounded/retryable failure handling with human escalation (Section 10), and
   append-only ledger logging of every state change (Section 14, modulo the narrower-than-claimed
   audit surface). These are real, working controls over *data* — they just have nothing real to
   protect yet, because nothing real is being charged.

**Custody-boundary confirmation:** the "AE must not receive, hold, transfer or disburse trust
money" claim is **true of this codebase as built today** — there is no trust-account or deposit
model wired to any charge/debit path, and PC fee debits are, in every reachable code path today,
scoped to `GENERAL_ACCOUNT_DEBIT_MANDATE`. It is **not, however, a technically enforced
invariant** — `authorisedPaymentMethod` is an unvalidated free-text column with no downstream
check, so the claim currently holds because of what has not yet been built (a trust-money charge
path) rather than because something would stop it if attempted. This does not change the
recommendation above, since no real charging is recommended for this pilot regardless — but it
should be closed (a CHECK constraint or an explicit code-level assertion) before this boundary is
relied upon for any future phase that does enable live charging.
