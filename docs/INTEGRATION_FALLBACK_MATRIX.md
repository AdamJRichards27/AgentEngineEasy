# Integration Fallback Matrix — Controlled Pilot

`docs/INTEGRATION_FALLBACK_MATRIX.md`

**Status.** This document is one of the required deliverables of the Operational Readiness &
Controlled Pilot Gate. It is a read-only, code-grounded inventory — no live network calls were
made to produce it, and no code was modified in producing it (two of its findings, the
mandate-payments and property-data provider-fallback logging, were separately hardened as part
of this gate's bounded remediation — see the Gate Report's remediation log — but the analysis
below reflects the architecture as it stands, not a claim that the underlying gaps described
here have been closed).

---

# Phase 5 — Integration & Fallback Matrix (Pilot Readiness Gate)

**Scope.** This is a read-only, code-grounded inventory of every external integration
AgentEngineEasy touches or could touch during a controlled pilot, based on a full read of
`packages/integrations/*` (aml, esign, payments, mandate-payments, billing, property-data,
object-storage), `apps/api/src/lib/communications/*` (email/SMS), `apps/api/src/lib/ai/*`
(AI model provider), `apps/api/src/lib/observability/*` and `packages/events/*` (monitoring),
`apps/api/src/lib/financial/*` (mandate-payment webhooks, reconciliation), the four inbound
webhook route files, and the repo's `.env.example` / actual `.env` files. No live network
calls were made; every claim below cites a `file:line`. No modifications were made to the repo.

**Headline finding.** The prior audit's concern is substantially confirmed, with one important
nuance: it is not universally "return true" everywhere. Two providers implement genuine
HMAC‑SHA256 verification with constant-time comparison when a **real, credentialed adapter is
selected** (AML's `HttpAMLProvider`, e-sign's `HttpESignProvider`, and payments'
`StripePaymentProvider`, which also checks Stripe's 5‑minute timestamp tolerance). But every
**mock/sandbox provider** — which is the default and, for SMS/email/direct-debit, the *only*
implementation that exists — either returns `true` unconditionally or performs a check that is
cryptographically meaningless. The most operationally significant instance is the **mandate
(direct-debit) payment webhook**: its only shipped provider unconditionally accepts any
signature, and this is confirmed by the codebase's own internal audit doc
(`docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md:52-55`). A second, distinct instance is the
**Grow subscription billing** Stripe adapter, whose `verifyWebhookSignature` is explicitly
labelled a "Stage A placeholder" and checks only that the signature header and body are
non-empty (`packages/integrations/billing/src/index.ts:159-165`) — this is a *named, real*
provider (`BILLING_PROVIDER=stripe`), not a mock, so this gap is live the moment that env var
and a Stripe secret key are set, even before real Stripe webhook traffic is authorised.

Every credential this platform would need for a genuinely live integration (Stripe keys, AML/
e-sign vendor API keys, Google Places key, Anthropic key) is **absent** from both the actual
`.env` files in this mirror and from version control — confirmed by reading
`/home/claude/work/AgentEngineEasy/.env` and `/home/claude/work/AgentEngineEasy/apps/api/.env`
directly, which contain only `DATABASE_URL`, `SESSION_SECRET`, `NODE_ENV`, `PORT`, and a dev-auth
flag. Every `*_PROVIDER` switch defaults to `mock`/`sandbox`/`local` when unset. This means the
pilot, as configured today, cannot make a single real external call for any of AML, e-sign,
payments, billing, mandate/direct-debit, or property-data — the risk is not "a live vendor call
happens accidentally," it is "the webhook *endpoints* for these are still exposed to the public
internet, signature-checked against a mock/placeholder scheme, and an attacker who finds them can
inject fabricated provider events" (see the signature-verification section below).

---

## Integration matrix

| Integration | Pilot use | Live or mock (default) | Credentials ready (Y/N) | Test/sandbox mode available | Retry / idempotency | Failure alerting | Manual fallback | Signature verification quality (webhooks) | Owner |
|---|---|---|---|---|---|---|---|---|---|
| **Email** | Party/agent notifications, comms hub sends | **Mock only — no live implementation exists in the codebase.** Hardcoded to `sandboxEmailProvider`, no env switch (`apps/api/src/lib/communications/providers/types.ts:6-10`, `outbox.ts:341-347`) | N — no vendor even selected; `sandboxEmail.ts` header states "Nothing here makes a network call to a real mail provider" (`sandboxEmail.ts:3-4`) | Y — deterministic sandbox with magic-string failure injection (`sandboxEmail.ts:29-46`) | Idempotency key minted once at queue-time, never re-minted (`outbox.ts:200`); capped exponential backoff 1m→30m (`outbox.ts:427`); non-retryable/exhausted → `job_repeated_failure_total` counter (`outbox.ts:421`) | Yes — `logger.error` on sweep failure (`bootstrap.ts:31`), domain events `COMMUNICATION_MESSAGE_FAILED`/`BLOCKED` published (`outbox.ts:395-437`), and the Exception & Risk Engine's `communicationDelivery.ts` rule watches for it | N/A while sandboxed (nothing to fail over from); once a real vendor ships, no documented manual send path was found | Real HMAC-SHA256 + constant-time compare exists (`lib/communications/webhooks.ts:45-53`), but the *secret* has a hardcoded, source-visible default (`COMMUNICATIONS_WEBHOOK_SECRET ?? "dev-sandbox-communications-webhook-secret"`, `routes/communicationsWebhooks.ts:38`) not present in `.env.example` — see detailed findings | AE Backend Engineering |
| **SMS** | Party/agent SMS notifications | **Mock only — no live implementation exists.** Hardcoded to `sandboxSmsProvider`, no env switch (same file/lines as Email) | N — aspirational vendor only named in a comment ("e.g. Mobile Message"), never implemented (`providers/types.ts:8`, `sandboxSms.ts:7`) | Y — deterministic sandbox with magic-number failure injection (`sandboxSms.ts:22-38`) | Same durable outbox as Email — idempotency key, capped backoff, `job_repeated_failure_total` (`outbox.ts:200,349-353,427`) | Same as Email | Same as Email — no live path, no documented manual-send workaround | Same shared webhook route/secret as Email | AE Backend Engineering |
| **AML / Identity Verification** | KYC/CTF check on buyers & sellers before settlement | Both — `MockAMLProvider` (default) and `HttpAMLProvider` (real HMAC REST+webhook adapter, vendor not yet procured), selected by `AML_PROVIDER` (`packages/integrations/aml/src/index.ts:157-173`) | N — `.env.example:24-27` documents `AML_API_BASE_URL`/`AML_PROVIDER_API_KEY`/`AML_WEBHOOK_SECRET` but all are blank in the real `.env` files; `createAMLProvider` falls back to mock with a `console.warn` if any is missing (`index.ts:164-169`) | Y — mock provider ships by default (`index.ts:39-57`) | Idempotent request guard: one `AMLVerification` row per (property, party); a repeat call returns the existing row rather than re-requesting (`apps/api/src/lib/aml.ts:88-93`); webhook redelivery is a no-op duplicate (`aml.ts:208-235`); no outbound HTTP retry/timeout wrapper around `fetch` in `HttpAMLProvider.requestVerification` (`index.ts:81-116`) | Yes at the domain layer — a `Review Required`/`Failed` verification opens exception rule **E26** for a human (`lib/exceptions/rules/amlCtf.ts:227-244`); no push/page alert (see Monitoring row) | Yes — `POST /aml/:verificationId/resolve-exception`, restricted to Brokerage Administrators, requires non-empty notes (`routes/aml.ts:111-117`) — a genuine human override path | **Mock: unconditional `return true`** (`index.ts:44-46`). **Real (HttpAMLProvider): genuine HMAC-SHA256 + `timingSafeEqual`** (`index.ts:118-131`) | AE Backend Engineering |
| **E-Signature** | Agency agreement / Ready-to-List document signing | Both — `MockESignProvider` (default) and `HttpESignProvider` (real HMAC REST+webhook adapter, vendor not yet procured), selected by `ESIGN_PROVIDER` (`packages/integrations/esign/src/index.ts:131-147`) | N — `.env.example:34-37` fields all blank in real `.env`; same fallback-to-mock-with-warning pattern (`index.ts:141-143`) | Y — mock ships by default (`index.ts:29-46`) | Idempotent send guard: an existing non-Voided `SignatureRequest` is returned as-is, never re-sent (`apps/api/src/lib/documents.ts:216-239`); webhook redelivery handled as duplicate (`documents.ts:384+`); no retry/timeout wrapper on `HttpESignProvider.createEnvelope`'s `fetch` (`index.ts:66-91`) | Yes at the domain layer — an overdue/incomplete signature opens an exception ("Agency agreement signature overdue", `lib/exceptions/rules/appraisalAgreement.ts:85-124`); no push/page alert | **Not found** — no admin API to manually mark a `SignatureRequest` completed; the exception rule's own recommended action is to "follow up with the signatory(ies)" outside the app (`appraisalAgreement.ts:116`), which is itself the de facto manual workaround, but there is no in-app button for it | **Mock: unconditional `return true`** (`index.ts:34-36`). **Real (HttpESignProvider): genuine HMAC-SHA256 + `timingSafeEqual`** (`index.ts:93-103`) | AE Backend Engineering |
| **Property Data Lookup** | Address autocomplete + ownership check at "Start Property" | Both — `MockPropertyDataProvider` (default) and `GooglePlacesProvider` (real, no webhook), selected by `PROPERTY_DATA_PROVIDER` (`packages/integrations/property-data/src/index.ts:123-141`) | N — `GOOGLE_PLACES_API_KEY` blank in real `.env` (`.env.example:20-21`); falls back to mock with a warning if missing (`index.ts:128-132`) | Y — mock ships by default (`index.ts:28-46`) | **No retry, no timeout, no AbortController anywhere in this file** — a `fetch` that hangs blocks the call indefinitely (`index.ts:67,103`). Worse: `GET /properties/address-search` (`routes/properties.ts:41-49`) has **no try/catch** around `propertyDataProvider.searchAddress()` — since this codebase documents elsewhere that Express 4 does not auto-catch an async handler's rejection (e.g. `routes/integrationsWebhooks.ts:50-58`), a Google Places timeout/error here would hang the request rather than return a clean error | **Not found** for outbound failures on this path specifically (no logger call wraps the search/lookup calls in `routes/properties.ts:41-76`) | Yes, structurally — `startPropertySchema.isManualAddress` lets an agent create a property record without any address-lookup provider at all (`routes/properties.ts:57`); ownership lookup is explicitly non-blocking even when it fails to return data (`ownershipData` may be `null`, `index.ts:43-45,118-120`) | No webhook (outbound-only integration) | AE Backend Engineering |
| **Payments — Card charges** (ServiceOrder billing, e.g. AML fee) | Charging an agent's stored card for a service | Both — `MockPaymentProvider` (default) and `StripePaymentProvider` (real, named vendor since Phase 1), selected by `PAYMENT_PROVIDER` (`packages/integrations/payments/src/index.ts:251-267`) | N — `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` blank in real `.env` (`.env.example:44-50`); falls back to mock with a warning (`index.ts:261-263`) | Y — mock ships by default, including an in-memory idempotency guard that throws on a reused key (`index.ts:41-54`) | **Deliberate, well-documented duplicate-charge guard** ("repeated button clicks must never charge twice," `apps/api/src/lib/payments.ts:143-158`): an existing Succeeded/Pending payment short-circuits a new charge (`payments.ts:182-185`); each retry gets its own `idempotencyKey` (`service-order-charge:<id>:<attempt>`, `payments.ts:202`), passed through to Stripe's `Idempotency-Key` header (`index.ts:109`). Edge case, disclosed in the code's own comment: if the process crashes between the provider call succeeding and the local status write, the row stays "Pending" forever with no automated sweep found to reconcile it (`payments.ts:155-158`) | Yes — failed charges are recorded with `failureReason` on the `payments` row (`payments.ts:248-252`); webhook processing distinguishes invalid signature / not-found / duplicate (`payments.ts:279-289`); no push/page alert | Refund is an authenticated, admin-only, in-app action (`routes/payments.ts:163-169`) — reasonable operational control, but no "charge manually outside the app" path is offered nor needed since card capture must happen client-side regardless | **Mock: unconditional `return true`** (`index.ts:60-62`). **Real (StripePaymentProvider): genuine HMAC-SHA256 over `"<timestamp>.<raw body>"`, 5‑minute timestamp tolerance, `timingSafeEqual`** — matches Stripe's real documented scheme (`index.ts:188-214`) | AE Backend Engineering |
| **Payments — Direct Debit / Mandate** (PC success-fee) | Scheduling a debit against an already-authorised bank mandate | **Sandbox only — no real vendor exists in the codebase at all**, by explicit design ("no real bank-debit vendor is procured for this build," `packages/integrations/mandate-payments/src/index.ts:23-28,161-171`) | N/A — nothing to configure; `MANDATE_PAYMENT_PROVIDER` isn't even documented in `.env.example`, and any value other than `sandbox` just logs a warning and still uses the sandbox (`index.ts:161-171`) | Y — sandbox deliberately **replays** the cached result for a repeated idempotency key rather than erroring, matching real provider idempotency-key semantics (`index.ts:72-84,105-122`) | Idempotency key scoped per payment request (`schedule-debit:<paymentRequestId>`, `apps/api/src/lib/financial/paymentOutbox.ts:196`); exponential backoff capped at 24h (`paymentOutbox.ts:240-246`); webhook redelivery is a hard duplicate via a DB unique constraint (`apps/api/src/lib/financial/paymentWebhooks.ts:91-103`) | Yes — a permanently-failed PC fee payment opens a dedicated exception ("PC success fee payment #… failed … will not retry automatically," `lib/exceptions/rules/financial.ts:71-84`); a terminal failure also leaves an internal note on the property's Financial notices thread (`paymentWebhooks.ts` module comment, lines 22-29); no push/page alert | Yes — exhausted-retry failures are designed to require a human (module comment, `paymentOutbox.ts` and `paymentWebhooks.ts:22-29`); disputes route to a dedicated exception too (`financial.ts:130-143`) | **Sandbox: unconditional `return true`, ignoring both arguments** (`index.ts:142-144`) — and this IS what production traffic would hit, since no other provider exists. Independently confirmed by the repo's own audit doc: `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md:52-55` | AE Backend Engineering |
| **Subscription Billing** (Grow add-on, Stripe Checkout/Subscriptions) | Recurring brokerage subscription billing | Both — `MockBillingProvider` (default) and `StripeBillingProvider` (real, named vendor, reuses Stripe keys), selected by `BILLING_PROVIDER` (`apps/api/src/lib/billing/gateway.ts:12-20`) | N — same `STRIPE_SECRET_KEY` as card payments, blank in real `.env`; **`BILLING_PROVIDER` itself is undocumented in `.env.example`** entirely | Y — mock activates a subscription synchronously with no webhook round-trip needed (`packages/integrations/billing/src/index.ts:56-101`) | Idempotent on (provider, providerEventId) at the webhook route (`routes/billing.ts:180-199`); no outbound retry/timeout on the Stripe `fetch` calls (`index.ts:125-157`) | `logger.warn` when `BILLING_PROVIDER=stripe` is set without a secret key (`gateway.ts:33`); no dedicated exception rule found for a failed/degraded subscription state | Not found — no documented manual-billing workaround | **Mock: unconditional `return true`** (`index.ts:93-95`). **Real (StripeBillingProvider): NOT real crypto** — explicitly commented as a "Stage A placeholder," checks only `signature.length > 0 && payload.length > 0` (`index.ts:159-165`). This is the single most important nuance in this audit: it is a **named, real** provider path, not a mock, and it is live the instant `BILLING_PROVIDER=stripe` + a secret key are set | AE Backend Engineering |
| **Accounting / Reconciliation** | Matching payment-processor status against internal financial ledger | **No real accounting/reconciliation vendor exists anywhere in the codebase** (grep across `apps/api/src` and `packages` for Xero/MYOB/QuickBooks/Sage returned nothing). What exists is an internal ledger (`financial_ledger_events`, `financial_reconciliations`) fed by a **mock payment-status feed** (`apps/api/src/lib/financial/mockPaymentStatusSync.ts:1-33`) | N/A — no vendor to credential | Y — the mock feed is the only implementation | Mapping-conflict detection reuses a generic external-id resolver (`mockPaymentStatusSync.ts:29-33`); by explicit design this module can **never** auto-mark a reconciliation `RECONCILED` — that is reserved for a human (`mockPaymentStatusSync.ts:6-18`) | Yes — a variance opens exception `FIN05_RECONCILIATION_VARIANCE_UNRESOLVED` and increments `financial_reconciliation_variance_total` (`lib/exceptions/rules/financial.ts:336-368`, `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md:200-207`) | Yes, by design — reconciliation is a manual, human, in-app action via `reconciledByUserId`/`reconciledAt` fields; the system deliberately never self-reconciles (`mockPaymentStatusSync.ts:6-18`) | No inbound webhook route found for this specifically — it is fed via the generic mock integration framework's payment-status capability (see that row) | AE Backend Engineering / Finance Ops |
| **Object / File Storage** | Storing generated documents & completed signature packages | Both, but the default is genuinely functional (not a placeholder mock) — `LocalObjectStorageProvider` writes to local disk; a real S3/GCS-equivalent adapter does not exist yet (`packages/integrations/object-storage/src/index.ts:9-17,57-64`) | Y (trivially) — `OBJECT_STORAGE_LOCAL_DIR` defaults to `./storage`, no external credential needed for the shipped provider (`.env.example:39-41`) | Y — local disk IS the "sandbox"; no separate test mode | No network calls, so no HTTP retry/timeout applies; path-traversal is defended against with a resolved-path containment check (`index.ts:21-43`, with a documented Phase-7 fix for a prior relative/absolute-path bug); no application-level retry around `fs` errors — they simply throw | Not found — no explicit try/catch/logger around the `putObject`/`getObject` call sites reviewed in `apps/api/src/lib/documents.ts:181,345` | N/A during pilot — since this is local disk, not a third-party vendor, "provider unavailable" mostly means disk-full/permissions, for which no documented manual workaround exists beyond direct server/ops access | No webhook (not a networked provider) | AE Backend Engineering / Platform Ops |
| **Monitoring / Observability & Alerting** | Operational visibility during the pilot | **No external monitoring/alerting vendor is connected at all.** The app exposes a self-hosted Prometheus-text-format metrics endpoint and writes structured JSON logs to stdout/stderr; nothing pushes to Datadog/Sentry/PagerDuty/Opsgenie/CloudWatch/Grafana (grep across the whole repo for all of these found no live client) | N — there is nothing to credential; `GET /api/internal/metrics` is itself protected by a bearer token (`METRICS_TOKEN`, fail-closed at boot in production, per `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md:6-8`) | Y — the metrics/logging code runs the same in every environment | N/A | **This is the key gap for the whole platform, stated by the codebase's own documentation, not inferred**: *"None of these page anyone today — there is no alerting/paging pipeline in this repository"* (`docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md:99-101`); 23 metrics and 27 alert-ready conditions are defined and wired, but firing a real page requires standing up Prometheus/Alertmanager or equivalent and a paging destination — explicitly named as **not done** (`METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md:211-219`) | For the pilot: an operator must actively watch the in-app Exception & Risk Engine / Command Centre and/or tail structured logs; there is no passive "you'll get paged" safety net | N/A | AE Backend Engineering / SRE (role TBD for pilot) |
| **AI Model Provider** (Agent Engine Copilot) | AI-assisted actions/answers inside the app | Both — `MockAiProvider` (default) and `AnthropicAiProvider` (real), selected by `AI_PROVIDER`, with a configurable fallback provider (`apps/api/src/lib/ai/gateway.ts:37-59`) | N — `ANTHROPIC_API_KEY` blank in real `.env`; falls back to mock with `logger.warn` if missing even when `AI_PROVIDER=anthropic` (`gateway.ts:51-56`) | Y — mock ships by default | **Real timeout**: `AbortController` aborts at `AI_TIMEOUT_MS` (default 20s) (`apps/api/src/lib/ai/providers/anthropicProvider.ts:22-23,71-73`). **Real retry+fallback**: retries the primary up to `AI_RETRY_LIMIT` (default 2), then falls back to `AI_FALLBACK_PROVIDER` (default mock) (`gateway.ts:70-88`) | Yes — every failure is recorded to the `aiInteractions` audit table with `status: "error"` and the error message (`apps/api/src/lib/ai/orchestrator.ts:148-164`); also gated by per-role feature flags, all off except read-only Copilot (`.env.example:76-84`); no push/page alert | Every AI role except Copilot ships disabled by default, which is itself the safety fallback; when AI is unavailable the underlying manual workflow (the same UI without AI assistance) is unaffected | No inbound webhook — outbound-only, request/response API | AE Backend Engineering / AI Platform |
| **Generic "Integration Connections" framework** (mock Portal / mock SMS gateway / mock payment-status feed scaffold) | Proves the outbox/webhook/dead-letter foundation end-to-end; not itself a real portal/SMS/payment vendor | **Mock only, and structurally forced to stay mock**: `resolveActiveConnection` fails closed unless `environmentClassification === "MOCK"` — "this build never activates anything else" (`apps/api/src/lib/integrations/registry.ts:44-79`, check at ~line 140+) | N/A — `credentials.ts` is "structurally incapable of persisting a real secret" (`apps/api/src/lib/integrations/credentials.ts:1-11`); it only ever mints an opaque mock reference | Y — this is the sandbox by construction | Full dead-letter + replay machinery: failed webhook processing writes a dead letter and can be replayed by an admin (`apps/api/src/lib/integrations/webhooks.ts:187-213,217-252`); inbound idempotency via a unique `(connectionId, provider, providerEventId)` index (`webhooks.ts:155-185`) | Yes, thoroughly — `integration_webhook_total{outcome}` counters, `logger.error`/`logger.warn` on every rejection/dead-letter path (`webhooks.ts:73-100,195-213`); still no push/page alert | This whole framework IS the pilot's manual/mock fallback layer for a not-yet-built real portal/payment-status integration — nothing to fall back from | **Real HMAC-SHA256 + `timingSafeEqual`** at `lib/integrations/webhooks.ts:36-44`, verified against a per-connection **mock** secret reference (`credentials.ts:71-74`) — the crypto is genuine, but there is no real external counterparty for it to ever matter to, and the endpoint (`POST /integrations/webhooks/:connectionId/:provider`) is internet-reachable and unauthenticated by session, so it is still real attack surface worth pen-testing before the pilot | AE Backend Engineering |

---

## Webhook signature verification — detailed findings

Every `verifyWebhookSignature`-named function found in the codebase, with the **exact check
logic quoted**, not just its name or docstring.

### 1. AML — Mock (`packages/integrations/aml/src/index.ts:44-46`)
```ts
verifyWebhookSignature(_payload: unknown, _signature: string): boolean {
  return true; // mock provider — no real signature to verify
}
```
**Verdict: unconditional accept.** Both arguments are unused (prefixed `_`).

### 2. AML — HttpAMLProvider (real adapter) (`packages/integrations/aml/src/index.ts:118-131`)
```ts
verifyWebhookSignature(payload: unknown, signature: string): boolean {
  if (!signature) return false;
  const raw = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  const expected = createHmac("sha256", this.config.webhookSecret).update(raw).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const givenBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== givenBuf.length) return false;
  return timingSafeEqual(expectedBuf, givenBuf);
}
```
**Verdict: genuine HMAC-SHA256 with constant-time comparison.** Only reachable when
`AML_PROVIDER=http` and all three of `AML_API_BASE_URL`/`AML_PROVIDER_API_KEY`/
`AML_WEBHOOK_SECRET` are set — none are, in this mirror's `.env` files.

### 3. E-Signature — Mock (`packages/integrations/esign/src/index.ts:34-36`)
```ts
verifyWebhookSignature(_payload: unknown, _signature: string): boolean {
  return true;
}
```
**Verdict: unconditional accept.**

### 4. E-Signature — HttpESignProvider (real adapter) (`packages/integrations/esign/src/index.ts:93-103`)
Identical construction to AML's real adapter (HMAC-SHA256 + `timingSafeEqual`, length-checked
first). **Verdict: genuine.**

### 5. Payments (card) — Mock (`packages/integrations/payments/src/index.ts:60-62`)
```ts
verifyWebhookSignature(_payload: unknown, _signature: string): boolean {
  return true;
}
```
**Verdict: unconditional accept.**

### 6. Payments (card) — StripePaymentProvider (real adapter) (`packages/integrations/payments/src/index.ts:188-214`)
```ts
verifyWebhookSignature(payload: unknown, signature: string): boolean {
  if (!signature) return false;
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(...);
  const parts = Object.fromEntries(signature.split(",").map((kv) => { const [k, v] = kv.split("="); return [k, v]; }));
  const timestamp = parts.t; const v1 = parts.v1;
  if (!timestamp || !v1) return false;
  const toleranceSeconds = 300;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return false;
  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), raw]);
  const expected = createHmac("sha256", this.config.webhookSecret).update(signedPayload).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8"); const givenBuf = Buffer.from(v1, "utf8");
  if (expectedBuf.length !== givenBuf.length) return false;
  return timingSafeEqual(expectedBuf, givenBuf);
}
```
**Verdict: genuine, and matches Stripe's real documented scheme** (`t=...,v1=...` header,
`"<timestamp>.<raw body>"` signed payload, 5-minute replay tolerance, constant-time compare).

### 7. Mandate / Direct-Debit Payments — SandboxMandatePaymentProvider (the ONLY provider that ships) (`packages/integrations/mandate-payments/src/index.ts:142-144`)
```ts
verifyWebhookSignature(): boolean {
  return true; // no real webhook traffic reaches the sandbox provider
}
```
**Verdict: unconditional accept, and both parameters are dropped from the signature entirely**
(the function takes no arguments at all, unlike every other provider's mock which at least
accepts-and-ignores). This is the highest-consequence instance of the pattern because there is
no real adapter anywhere in the codebase to switch to — `createMandatePaymentProvider()`
(`index.ts:161-171`) returns this sandbox for every value of `MANDATE_PAYMENT_PROVIDER` except
falling through with a warning for anything unrecognised. The route that calls it,
`POST /financial/webhooks/mandate-payments` (`apps/api/src/routes/financialWebhooks.ts:49-81`),
is unauthenticated by session (webhooks carry no cookie) and, per its own module comment,
**has no per-brokerage credential/scoping to check a signature against even in principle**
(`financialWebhooks.ts:10-13`). The only things standing between the public internet and a
fabricated "this direct-debit was Paid/Failed/Reversed/Disputed" state change are (a) knowing or
guessing a valid `providerRequestRef` (a `sandbox-debit-<uuid>` value) and `providerEventId`
dedup key, and (b) the payload matching the expected shape. This is independently confirmed, not
just my own reading, by the codebase's own audit note: *"the sandbox mandate-payments provider's
`verifyWebhookSignature()` always returns `true` ... so `financial_webhook_total
{outcome="invalid_signature"}` cannot be exercised against this build's only provider"*
(`docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md:52-55`).

### 8. Subscription Billing — MockBillingProvider (`packages/integrations/billing/src/index.ts:93-95`)
```ts
verifyWebhookSignature(): boolean {
  return true; // no real webhook traffic reaches the mock provider
}
```
**Verdict: unconditional accept.**

### 9. Subscription Billing — StripeBillingProvider (the "real", named-vendor adapter) (`packages/integrations/billing/src/index.ts:159-165`)
```ts
verifyWebhookSignature(payload: Buffer, signature: string | undefined): boolean {
  // Stage A placeholder - full Stripe-Signature HMAC verification (t=...,v1=...) is wired in
  // once real STRIPE_WEBHOOK_SECRET traffic is authorised; today this fails closed (no
  // signature, no verification key configured) rather than trusting an unverified payload.
  if (!signature || !this.config.webhookSecret) return false;
  return signature.length > 0 && payload.length > 0;
}
```
**Verdict: NOT a cryptographic check.** Once past the initial "did anyone bother sending a
signature header and is a webhook secret configured" gate, the actual check is only
`signature.length > 0 && payload.length > 0` — any non-empty string in the `stripe-signature` /
`x-webhook-signature` header on any non-empty body passes. This is the finding most likely to
surprise a reviewer skimming only the mock providers: **this is the code path a real,
credentialed, named Stripe integration would run in production** if `BILLING_PROVIDER=stripe`
and a secret key are set for the pilot, and it is not a mock at all — it self-labels as an
intentional "Stage A placeholder," but nothing in the config or route layer prevents it from
being activated before that placeholder is replaced.

### 10. Communications (Email/SMS) inbound webhook (`apps/api/src/lib/communications/webhooks.ts:45-53`)
```ts
export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): boolean {
  if (!input.signatureHeader) return false;
  const expected = createHmac("sha256", input.secret).update(input.rawBody).digest("hex");
  const provided = input.signatureHeader.trim().toLowerCase().replace(/^sha256=/, "");
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
```
**Verdict: genuine HMAC-SHA256 with constant-time comparison** — the check itself is real.
However, the *secret* it is checked against
(`routes/communicationsWebhooks.ts:38`, `WEBHOOK_SECRET = process.env.COMMUNICATIONS_WEBHOOK_SECRET
?? "dev-sandbox-communications-webhook-secret"`) has a hardcoded, source-visible fallback value
that is not documented anywhere in `.env.example`. If a pilot deployment leaves
`COMMUNICATIONS_WEBHOOK_SECRET` unset — which is easy to do, since no `.env.example` entry
prompts an operator to set it — anyone who reads this open-source-style codebase (or guesses the
literal string) can compute a valid signature for
`POST /api/communications/webhooks/:brokerageId/:provider` and inject fabricated
delivery-receipt/bounce/opt-out events for any `brokerageId` in the URL path.

### 11. Generic Integration Connections framework (`apps/api/src/lib/integrations/webhooks.ts:36-44`)
Identical HMAC-SHA256 + `timingSafeEqual` construction to #10, verified via
`getSecretIdentifierForSigning()` against a per-connection **mock** secret reference
(`apps/api/src/lib/integrations/credentials.ts:71-74`). **Verdict: genuine crypto**, but the
secret it protects is never a real vendor credential (the module is "structurally incapable of
persisting a real secret," `credentials.ts:1-11`) and every connection is fail-closed to
`environmentClassification: "MOCK"` (`registry.ts`), so there is nothing of real consequence
behind this endpoint today — it is still real, internet-reachable attack surface, just not one
that can currently move money or send a real message if bypassed.

### Summary table of the pattern

| Provider (webhook) | Ships as default? | Check quoted above | Real crypto? |
|---|---|---|---|
| AML mock | Yes | `return true` | No |
| AML HttpAMLProvider | No (needs 3 env vars) | HMAC-SHA256 + `timingSafeEqual` | **Yes** |
| E-sign mock | Yes | `return true` | No |
| E-sign HttpESignProvider | No (needs 3 env vars) | HMAC-SHA256 + `timingSafeEqual` | **Yes** |
| Payments (card) mock | Yes | `return true` | No |
| Payments (card) StripePaymentProvider | No (needs 2 env vars) | Stripe `t=,v1=` HMAC-SHA256 + 5min tolerance + `timingSafeEqual` | **Yes** |
| Mandate/direct-debit sandbox | **Yes, and only option** | `return true` (args dropped entirely) | No |
| Billing mock | Yes | `return true` | No |
| Billing StripeBillingProvider | No (needs `BILLING_PROVIDER=stripe` + key) | `signature.length > 0 && payload.length > 0` | **No — non-empty check only, despite being the "real" path** |
| Communications (email/SMS) | Yes (only implementation) | HMAC-SHA256 + `timingSafeEqual` | **Yes, but against a hardcoded default secret if unconfigured** |
| Generic integrations framework | Yes (mock-only) | HMAC-SHA256 + `timingSafeEqual` | **Yes, against a mock secret with no real vendor behind it** |

---

## Recommended pilot inclusion/exclusion per integration

- **Email / SMS — exclude any live send.** There is no live implementation to include; the
  sandbox is what ships. Fine to run in the pilot exactly as-is (nothing to configure, nothing
  can leak to a real recipient), but do not represent to pilot users that messages are actually
  delivered — the code itself is explicit that sandbox results "must not fabricate delivery"
  (`sandboxEmail.ts:10`). If a real vendor is added mid-pilot, `COMMUNICATIONS_WEBHOOK_SECRET`
  must be set to a strong value before the webhook route is exposed publicly.
- **AML / E-Signature — include only in mock mode.** Both have genuinely good real-adapter code
  (real HMAC, idempotent request/webhook handling, human exception-resolution paths for AML), but
  no vendor is procured and no credentials exist. Safe to pilot as-is since `mock` is the
  documented and actual default. Do **not** flip `AML_PROVIDER`/`ESIGN_PROVIDER` to `http`
  without also provisioning `AML_WEBHOOK_SECRET`/`ESIGN_WEBHOOK_SECRET` as strong random values
  (the code fails closed to mock if they're missing, which is good, but an operator should not
  assume that safety net covers a partially-configured state — verify all three vars together).
- **Property Data Lookup — include mock; fix the untrapped-exception path before enabling Google Places.**
  If the pilot wants real address autocomplete, add error handling and a timeout around
  `propertyDataProvider.searchAddress()`/`lookupOwnership()` in `routes/properties.ts` first —
  today a provider timeout can hang the request. The manual-address fallback
  (`isManualAddress`) already exists and is a good safety net either way.
- **Payments — card charges — include only in mock mode; do not flip to Stripe for this pilot.**
  The Stripe card adapter's webhook verification and idempotency design are solid and
  production-shaped, but `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` are not provisioned, and per
  the platform's own stated rule this requires **separate owner authorization** before any real
  charge is possible (see the closing reminder below).
- **Payments — direct debit / mandate — exclude live activation entirely; this is the single
  highest-priority fix if this surface is exposed publicly during the pilot.** Since the sandbox
  provider's `verifyWebhookSignature()` unconditionally returns `true` and is the *only* provider
  that will ever run, `POST /financial/webhooks/mandate-payments` should either be firewalled off
  from the public internet for the duration of the pilot, or the route should be temporarily
  disabled, until a real adapter with real signature verification exists. This is a real-money
  surface (PC success fees), not a demo feature.
- **Subscription Billing (Grow) — exclude `BILLING_PROVIDER=stripe` from this pilot.** Its
  webhook check is explicitly a non-cryptographic placeholder. Keep `BILLING_PROVIDER` unset
  (defaults to mock) until the "Stage A placeholder" comment is resolved with real Stripe
  signature verification.
- **Accounting / Reconciliation — include as-is.** By design this never auto-finalizes a
  reconciliation; a human always closes the loop. This is a strength, not a gap, for a pilot.
- **Object / File Storage — include as-is.** It is a genuinely functional local-disk
  implementation, not a mock; the main residual item is adding explicit logging around
  `putObject`/`getObject` failures so a disk/permissions problem doesn't fail silently.
- **Monitoring / Alerting — treat as a pilot operations gap to close before go-live, not a code
  defect to fix.** The metrics and structured logs are genuinely good and comprehensive; what's
  missing is entirely external (a scrape target + a paging destination). Assign a named person to
  actively watch the Exception & Risk Engine and `/api/internal/metrics` for the duration of the
  pilot as a manual substitute for paging.
- **AI Model Provider — include Copilot only, exactly as configured (`mock` default, other roles
  off).** The retry/timeout/fallback engineering here is solid. If `AI_PROVIDER=anthropic` is
  turned on for the pilot, confirm `ANTHROPIC_API_KEY` is provisioned via a secrets manager (not
  committed) before enabling.
- **Generic Integration Connections framework — include as-is; treat its webhook endpoint as
  pilot attack surface to scan, not as a functioning vendor integration.** It cannot move money
  or send a real message today (fail-closed to `MOCK` classification), but the endpoint is real
  and internet-reachable and should be included in any pre-pilot penetration test.

## No live external transaction may be triggered without separate owner authorization

Nothing found in this codebase changes that rule — if anything, it reinforces why it matters:
every provider capable of a genuine external side effect (a real card charge via
`StripePaymentProvider`, a real bank debit once a mandate-payments adapter exists, a real
subscription charge via `StripeBillingProvider`, a real AML/e-sign vendor call once one is
procured, or a real AI API spend via `AnthropicAiProvider`) is switched on by an environment
variable plus a credential that, in this mirror, simply does not exist — which is exactly the
gate that must stay in the owner's hands, not a developer's or an operator's default `.env`.
Two things earn a stronger warning than "keep doing what you're doing": (1) the mandate-payment
and Grow-billing webhook *endpoints* are exposed and reachable regardless of whether their
provider is "live," and their signature checks (unconditional `true`, and a non-empty-string
check respectively) would not stop a forged callback from writing a fabricated financial-event
row today if either surface is left reachable from the public internet during the pilot; and
(2) flipping any `*_PROVIDER` env var to its real value is, functionally, the same decision as
authorizing a live external transaction, even if no credential is supplied yet — the fallback-
to-mock behavior is a safety net for a *missing* key, not a substitute for someone with
authority deciding, in writing, that this specific integration is allowed to go live for this
pilot.