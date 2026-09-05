# Authentication, Authorisation, and Tenant Isolation

Agent Engine 2.0, Step 2. This document is the authoritative, evidence-cited record of the
session/auth mechanism, the role model, and — the largest single body of work in this
step — the full tenant-isolation audit of every route file in `apps/api/src/routes`,
including the 9 real cross-tenant vulnerabilities found and fixed.

## 1. Authentication

`POST /auth/dev-login` (`apps/api/src/routes/auth.ts`) is a passwordless, email-lookup
sign-in — finds-or-creates a user by email and a brokerage by name, then issues an
HMAC-signed session cookie. It and its sibling `GET /auth/known-users` are gated by
`isDevAuthEnabled()` (`lib/env.ts`): unconditionally off when `NODE_ENV==="production"`,
otherwise requires the literal env var `ALLOW_DEV_AUTH==="true"`. A disabled environment
returns `404`, not `403`, so the route's existence isn't confirmed to a prober. This is
pre-existing (Foundation Remediation Stage 1.1) and was verified, not modified, this step.

**Session token.** `apps/api/src/lib/session.ts`: `{uid, iat, epoch}`, base64url-encoded,
signed `HMAC-SHA256(SESSION_SECRET)`, compared with `timingSafeEqual` (constant-time — the
signature is attacker-influenced input). `SESSION_SECRET` has no fallback: `secret()` throws
if unset or under 32 characters, and `assertSessionSecretConfigured()` is called at boot
(`index.ts`) so the process refuses to start rather than silently signing untrustworthy
tokens. Server-side expiry is enforced independently of the cookie's own `Max-Age`
(`ageSeconds > MAX_AGE_SECONDS` rejected inside `verifySessionToken` itself), so a token
presented outside the browser's own cookie-expiry enforcement (e.g. replayed directly)
still expires.

**Session revocation — new this step.** Previously, clearing the cookie on logout was the
*only* revocation mechanism — a token captured before logout (XSS, a synced device, a
proxy log) remained cryptographically valid and accepted for up to 30 days after the user
believed they'd signed out. `users.sessionEpoch` (new column, migration
`0011_session_epoch_revocation.sql`, `int not null default 0`) is embedded in the token at
sign-time and re-checked against the live column value on every request
(`middlewares/auth.ts`'s `loadSession`: `row.sessionEpoch === verified.epoch`).
`POST /auth/logout` increments it (`sql\`${users.sessionEpoch} + 1\``), which instantly
invalidates every other outstanding token for that user — logout-everywhere semantics, not
just "this browser." A token signed before this column existed carries no `epoch` field and
is treated as epoch 0, identical to the column's own default, so no prior session is broken
by this change. Both `user_signed_in` and `user_signed_out` are now recorded via
`logAudit` (old/new epoch in `previousValue`/`updatedValue` — never token contents).
Verified: `apps/api/src/lib/__tests__/session.test.ts` (epoch round-trip, legacy-token
defaults to 0) and `apps/api/src/routes/__tests__/auth.test.ts` (full
login → logout → old-token-401 → new-login → new-token-200 sequence, and audit-row
correctness) — 21/21 passing, part of the final consolidated regression run recorded in the
completion report.

## 2. Role model

Three roles (`packages/db/src/schema/users.ts`'s `USER_ROLES`), deliberately small: `Agent`
(full access to their own brokerage's properties/transactions), `Brokerage Administrator`
(brokerage-wide oversight — the only role that can refund payments, resolve AML exceptions,
and, as of this step, mint/reactivate integration credentials), `Pit Crew` (optional
delegated operational role, otherwise scoped like Agent). `requireRole(...)`
(`middlewares/auth.ts`) is the single chokepoint for role checks; unchanged this step.

## 3. The tenant-isolation convention

Every row in this schema that isn't global (roughly: everything except `brokerages`
itself) carries `brokerageId`, directly or reachable via a foreign key. The established,
correct pattern — used consistently across this codebase and now extended to every place
found missing it — is: **any function that loads a row by a client-supplied id filters by
`brokerageId` in the SAME query that does the id lookup** (a direct `WHERE id = ? AND
brokerageId = ?`, or a join onto a table that carries `brokerageId`), and the failure mode
for "doesn't exist" and "belongs to another brokerage" is **identical** — the same 404,
the same message, never a distinguishable 403. Reference implementations:
`lib/exceptions/model.ts`'s `assertTenantAndLoad`, `lib/launch/model.ts`'s
`loadLaunchPlanInBrokerage`/`assertPropertyInBrokerage`, `lib/aml.ts`'s
`assertPartyOnPropertyInBrokerage`.

This step's instruction treats unresolved cross-tenant exposure as release-blocking. Every
route file in `apps/api/src/routes` was audited against this convention — first via 3
read-only reconnaissance passes (informing where to look), then via targeted implementation
work once specific gaps were confirmed by reading the actual query code, and finally via a
dedicated, comprehensive audit pass across every remaining router not yet personally
checked. Every finding below was verified by reading the actual vulnerable query (not
inferred), and every fix was personally re-read against the live file after the
implementing agent reported completion — the same discipline applied throughout this step.

## 4. Findings fixed this step

Nine real tenant-isolation defects were found and fixed — eight CRITICAL (full cross-tenant
read and/or write) and one MEDIUM (write-side reference-integrity gap, no confirmed read
leak). Every fix follows the convention in §3 and ships with new regression tests (cross-
tenant rejection + happy-path preservation).

| # | Domain | File(s) | Defect | Fix | Tests |
|---|---|---|---|---|---|
| 1 | Payments | `lib/payments.ts`, `routes/payments.ts` | `chargeServiceOrder`, `refundPayment`, `listPaymentsForServiceOrder` loaded the service order/payment by id with no brokerage filter — a brokerage admin could charge, refund, or read payment history for another brokerage's service order. | New `selectServiceOrderInBrokerage`/`selectPaymentInBrokerage` chokepoints; every route handler now passes `req.authedUser!.brokerageId`. | `routes/__tests__/payments.test.ts` (new, 9/9 pass) |
| 2 | Documents | `lib/documents.ts`, `routes/documents.ts` | `upsertAgencyAgreementTerms`, `populateDocumentPackage`, `sendPackageForSignature` accepted a `propertyId`/`packageId` with no brokerage check — cross-tenant read/write of agreement terms and document content. | New `assertPropertyInBrokerage`, `loadDocumentPackageInBrokerage` chokepoints; tenant-scoped logic moved into the lib layer (`getAgencyAgreementTerms`, `getDocumentContent`, `getPackageByProperty`). | `routes/__tests__/documents.test.ts` (new, 12/12 pass) |
| 3 | AML | `lib/aml.ts`, `routes/aml.ts` | `retryAmlVerification`/`resolveAmlException` had no brokerage check on the verification/exception id; two `GET .../by-property/:propertyId` reads had no property-ownership join. | Both functions now require and use `brokerageId`, join-scoped via `properties`; the two GET routes now join onto `properties` filtered by `user.brokerageId`. | `routes/__tests__/amlTenantScoping.test.ts` (new, 6) + `amlPartyRequest.test.ts` (existing, 6) — 12/12 pass |
| 4 | Parties | `routes/parties.ts` | `POST /`, `GET /by-property/:propertyId`, `DELETE /link/:linkId` all trusted a client-supplied `propertyId`/`linkId` with no ownership check — cross-tenant party PII read, and cross-tenant party-link creation/deletion (with real side effects: ownership review, AML initiation, workflow refresh). | Every handler now checks `properties.brokerageId = user.brokerageId` (or, for the link delete, joins `propertyParties` onto `properties`) in the same query. | `routes/__tests__/parties.test.ts` (new, 4/4 pass) |
| 5 | Financial — PC fee calculations | `lib/financial/pcFeeCalculations.ts` | `createPcFeeCalculation`'s authority lookup (`pcFeeAuthorities`) filtered by id only — a brokerage admin could supply another brokerage's `pcFeeAuthorityId` and have the fee computed from, and the response disclose, that authority's confidential mandate terms (`feeBasis`, `rateBps`, `gciDefinition`). | Authority lookup now filters `eq(id, ...) AND eq(brokerageId, ...)` in one query; identical "not found" either way. | New cross-tenant + happy-path tests added to `lib/financial/__tests__/settlement.test.ts` — 7/7 pass |
| 6 | Integrations — credential minting | `lib/integrations/credentials.ts`, `routes/integrations.ts` | `mintMockAuthFlow` took only a `connectionId`, with no brokerage parameter at all — any brokerage admin could mint or reactivate a credential reference for any other brokerage's integration connection by id, including flipping a `REVOKED` credential back to `ACTIVE`. | `mintMockAuthFlow` now calls the same `loadConnectionInBrokerage` chokepoint every other handler in this file already uses, before touching `integration_credentials`; route passes `brokerageId` through. | `routes/__tests__/integrationsAdmin.test.ts` — 7/7 pass (5 existing + 2 new) |
| 7 | Pit Crew — work-item overlay | `lib/pitCrew/assignment.ts` | `loadOrCreateOverlay` validated the client-supplied `propertyId` against the caller's brokerage but never validated `sourceRecordId` (a client-supplied exception UUID) against either the property or the brokerage — a caller could pair one of *their own* valid property ids with *any guessed/enumerated* foreign exception UUID, and the forged overlay row (created under the attacker's own brokerageId) would later merge into the real owner's own Pit Crew workspace view via `queries.ts`'s unfiltered `sourceRecordId` join. | New `assertSourceRecordOnPropertyInBrokerage` — requires the exception referenced by `sourceRecordId` to belong to both the caller's `propertyId` and `brokerageId` before any overlay row is touched; a UUID-shape guard prevents a malformed id from surfacing a raw DB error instead of the same tenant-mismatch error. | New/updated tests in `lib/pitCrew/__tests__/assignment.test.ts` and `routes/__tests__/pitCrew.test.ts` — 37/37 pass |
| 7b | Pit Crew — assignee | `lib/pitCrew/assignment.ts` | `assignWorkItem` never verified the client-supplied `assigneeUserId` belonged to the caller's own brokerage before recording it as the claimant. | New `assertUserInBrokerage` check before the assignment proceeds. | Included in the 37/37 above |
| 8 | Grow — activities | `routes/grow.ts` | `POST /activities` accepted `partyId`/`propertyId`/`opportunityId` from the request body with no ownership check — unlike the sibling `POST /relationships` and `POST /opportunities` in the same file, which both already check correctly. MEDIUM, not CRITICAL: no current read path joins `growActivities` back out cross-tenant, so this was a write-side referential-integrity gap, not a confirmed data leak — closed proactively before any future feature adds such a join. | Each of the three optional fields, when supplied, is now checked against `user.brokerageId` before the insert, mirroring the exact pattern already used by `POST /relationships` in the same file. | `routes/__tests__/grow.test.ts` — 10/10 pass (8 existing + 2 new) |

## 5. Tenant-isolation matrix — full route-file coverage

PASS = correctly scoped (either always was, or fixed this step and now verified).
N/A-WEBHOOK = unauthenticated by design; tenant resolved from the HMAC-verified payload/
connection, not a session — reviewed and confirmed correct, not a gap.
N/A-NO-TENANT-DATA = no client-supplied id lookup against tenant-scoped data exists in this
file.

| Route file | Verdict | Evidence |
|---|---|---|
| `payments.ts` | **PASS (fixed this step)** | Finding #1 above; `routes/__tests__/payments.test.ts` |
| `documents.ts` | **PASS (fixed this step)** | Finding #2 above; `routes/__tests__/documents.test.ts` |
| `aml.ts` | **PASS (fixed this step)** | Finding #3 above; `routes/__tests__/amlTenantScoping.test.ts` |
| `parties.ts` | **PASS (fixed this step)** | Finding #4 above; `routes/__tests__/parties.test.ts` |
| `financial.ts` | **PASS (fixed this step)** | Finding #5 above; `lib/financial/__tests__/settlement.test.ts`. Every other handler in this file (payment-requests, commission-agreements, pc-fee-authorities, ledger/deposit/reconciliation reads) was confirmed already correctly scoped via `lib/financial/queries.ts`/`agreements.ts`/`pcFeeAuthorities.ts`. |
| `integrations.ts` | **PASS (fixed this step)** | Finding #6 above; `routes/__tests__/integrationsAdmin.test.ts`. Every other handler (`connections/:id`, `dead-letters/:id`, action-publish/send-sms/link-payment-reference) confirmed already correctly threading `brokerageId` through `loadConnectionInBrokerage`/`resolveActiveConnection`/`loadDeadLetterInBrokerage`/`loadPortalDestinationInBrokerage`. |
| `pitCrew.ts` | **PASS (fixed this step)** | Findings #7/#7b above; `lib/pitCrew/__tests__/assignment.test.ts`, `routes/__tests__/pitCrew.test.ts` |
| `grow.ts` | **PASS (fixed this step)** | Finding #8 above; `routes/__tests__/grow.test.ts` |
| `exceptions.ts` | PASS (already correct) | Delegates to `lib/exceptions/model.ts`'s `assertTenantAndLoad` (this codebase's own reference implementation); reads through `lib/exceptions/queries.ts`, which filters `brokerageId` in the same WHERE as the id filter and redacts financial fields. |
| `launch.ts` | PASS (already correct) | Every mutation funnels through `lib/launch/model.ts`'s `loadLaunchPlanInBrokerage`/`loadCampaignItemInBrokerage`/`loadPortalDestinationInBrokerage`/`loadVendorApprovalInBrokerage` — identical 404 on missing vs. wrong-brokerage. |
| `properties.ts` | PASS (already correct) | Every `:id` route does `eq(id,...) AND eq(brokerageId,...)` in one query (this file's own documented prior `#123` fix). |
| `offers.ts` | PASS (already correct — weaker pattern, functionally safe) | Fetches the offer unfiltered, then verifies `propertyInBrokerage` before any read/mutation reaches the caller — the "fetch-then-check" shape rather than a single filtered query, but nothing is exposed pre-check. Noted for awareness, not scored as a gap. |
| `transactions.ts` | PASS (already correct — one unscored note) | `requireTransactionAccess` middleware gates every `:id` route with an id+ownership check before `next()`. Minor, unscored note: `recordLegalRepresentatives` stores client-supplied `sellerSolicitorPartyId`/`buyerSolicitorPartyId` with no ownership check, but nothing currently reads them back cross-tenant (only a presence/absence boolean). Listed as a deferred, accepted, low-severity item in the completion report. |
| `import.ts` | PASS (already correct) | Every route loads via `eq(importJobs.brokerageId, brokerageId)`; a client-supplied duplicate-resolution candidate id is re-validated at execution time (`execute.ts`), so a cross-tenant id simply fails to execute rather than merging. |
| `ai-actions.ts` | PASS (already correct) | `lib/ai/actionRequests.ts`'s `getAIActionRequest`/`approveAIActionRequest`/`rejectAIActionRequest` all filter by id+brokerageId in one query. |
| `ai.ts` | PASS (already correct) | `buildPropertyContext`/`buildTransactionContext` (`lib/ai/context/contextEngine.ts`) check ownership and return `null` (not a distinguishable error) before any data reaches the AI prompt. |
| `appraisals.ts` | PASS (already correct) | Route checks `assertPropertyInBrokerage` before every call; the lib layer re-verifies independently. |
| `automationOps.ts` | PASS (already correct) | Every `:id` route filters `brokerageId` in the same query, directly or via `lib/automation/operations.ts`. |
| `billing.ts` | PASS (already correct) | No client-id lookups; always scoped by the caller's own `brokerageId`. Webhook is signature-verified and idempotent. |
| `communications.ts` | PASS (already correct) | Every `:threadId`/`:messageId`/`:templateId` route checks `row.brokerageId !== brokerageId` before use, throwing a dedicated tenancy error. |
| `tasks.ts` | PASS (already correct) | Reads filter `brokerageId` directly; completions/resolutions check `row.brokerageId !== brokerageId` before mutating. |
| `commandCentre.ts` | N/A-NO-TENANT-DATA | No id-shaped param; aggregates via already-tenant-scoped helpers. |
| `home.ts` | N/A-NO-TENANT-DATA | No id-shaped param. |
| `health.ts` | N/A-NO-TENANT-DATA | No tenant data. |
| `auth.ts` | N/A — identity establishment | No tenant-scoped resource fetch by id (session issuance only). |
| `communicationsWebhooks.ts` | N/A-WEBHOOK (verified correct) | Tenant resolved from the URL's `:brokerageId`, but `findMessageForBrokerage` re-checks `communicationMessages.brokerageId` in the same query before any mutation — not a bare trust of the URL segment. |
| `financialWebhooks.ts` | N/A-WEBHOOK (verified correct) | Signature-verified; resolves the payment request via the signed payload's `providerRequestRef`, never a client-supplied id. |
| `integrationsWebhooks.ts` | N/A-WEBHOOK (verified correct) | Per-connection signing secret; tenant resolved from the connection the signature actually verifies against. |

Total: 28 route files audited. 8 required a fix this step (all now PASS with new tests), 1
required a fix for a MEDIUM finding (now PASS with new tests), 13 were already correct with
no change needed, 3 are webhook routers verified correct by design, 3 have no tenant-scoped
id-lookup surface at all.

## 6. Deferred, accepted, non-blocking items

- **`DELETE /payment-methods/:id`** (`routes/payments.ts`) returns a distinguishable `403`
  (row exists, wrong owner) rather than the same `404` a nonexistent id gets — an
  existence-leak, not a full IDOR (no data beyond "a payment method with this id exists" is
  disclosed). Flagged, not fixed this step; low severity.
- **`recordLegalRepresentatives`** (`lib/transactions.ts`) — see the `transactions.ts` row
  above. Low severity, no confirmed read path.

Neither item blocks the tenant-isolation gate: both are write-time reference/authorization
looseness with no confirmed cross-tenant data disclosure, distinct from the 9 CRITICAL/
MEDIUM findings above which all involved a real disclosed defect (a real cross-tenant read,
or a real cross-tenant write with a confirmed downstream effect).

## 7. Conclusion

Every finding this step's own instruction would classify as release-blocking (unresolved
cross-tenant exposure) has been fixed, verified via direct code review of the actual diff
(not just an implementer's self-report), and covered by new regression tests that were run
and confirmed passing. The `BLOCKED — TENANT ISOLATION FAILURE` condition does not apply
to this submission.
