# Integration Security Boundary

The security controls this step actually implements and tested, versus what remains for
the later, dedicated security-hardening stage (build brief §11 and §19 both draw this
line explicitly — this step is not that stage).

## 1. Fail-closed authorization: the resolver's check order

`resolveActiveConnection(brokerageId, connectionId, capability)` in `registry.ts` is the
single chokepoint. Every check must pass, in this exact order, or the function throws a
typed `IntegrationError` with a specific `reason` — never silently proceeds, never falls
back to a default connection:

1. **A connection matching `connectionId` exists and belongs to `brokerageId`.**
   `reason: "NOT_FOUND"` otherwise — identical whether the row is missing entirely or
   belongs to a different tenant (see §2).
2. **The brokerage's `integration_settings.enabled` is true.**
   `reason: "BROKERAGE_DISABLED"` otherwise.
3. **The brokerage holds the `integrations.access` entitlement.**
   `reason: "ENTITLEMENT_DENIED"` otherwise.
4. **`connection.status === "ACTIVE"`** — the only usable status.
   `reason: "CONNECTION_NOT_USABLE"` otherwise (covers `DRAFT`, `PENDING_APPROVAL`,
   `SUSPENDED`, `REVOKED`, everything non-`ACTIVE`).
5. **`connection.environmentClassification === "MOCK"`** — defence in depth. This build
   has no real adapter and no approved sandbox/production connection can exist, so this
   check should never fire in practice; it exists so that a future connection somehow
   marked `SANDBOX`/`PRODUCTION` without the corresponding real-adapter work being done
   and reviewed still cannot be used. `reason: "ENVIRONMENT_NOT_ALLOWED"`.
6. **The requested capability is in `connection.approvedScopes`** — not merely
   `requestedScopes`; an administrator's approval can grant a narrower scope than was
   asked for, and only the approved subset is usable. `reason: "SCOPE_NOT_APPROVED"`.
7. **The provider catalogue entry still exists, is active, and still declares the
   capability.** `reason: "NOT_FOUND"` / `"CAPABILITY_NOT_SUPPORTED"`.

Check 1 was deliberately moved to run *before* every other check during this step's own
testing (it did not start there — see the completion report's test-evidence section for
the exact bug this fixes). Tenant/existence is the outermost boundary: a caller from
brokerage B, passing brokerage A's real `connectionId`, must get the same `NOT_FOUND` a
caller passing a nonexistent id would get, regardless of brokerage B's *own* settings or
entitlement state. Checking brokerage-level settings first would have let a cross-tenant
caller learn something about their own brokerage's configuration in response to probing
someone else's connection id — not a leak of the other tenant's data, but still the wrong
invariant for a boundary the brief (§4.6) requires to be airtight.

Any unexpected error partway through resolution (e.g. a DB error resolving settings) is
caught and converted to a fail-closed `IntegrationError`, never allowed to surface as an
ambiguous failure that might read as "try again and it'll work."

## 2. Tenant isolation — what's actually tested

`connectionLifecycle.test.ts` has a dedicated cross-tenant test: brokerage B attempting to
`loadConnectionInBrokerage`, `resolveActiveConnection`, and `suspendConnection` against
brokerage A's connection all reject with an identical `NOT_FOUND` — proving the isolation
holds across read, resolve, and write/operate paths, not just one of them. This directly
satisfies build-brief acceptance scenario #8 ("A user from another tenant cannot view,
operate or replay the event").

Every table in the schema carries `brokerageId` (or reaches it via a `connectionId` FK)
and every query in `model.ts`/`registry.ts`/`outbox.ts`/`webhooks.ts`/`mapping.ts`/
`deadLetters.ts` filters by it. There is no cross-brokerage list or lookup path anywhere
in this build's code — every read is scoped by the caller's own `brokerageId` from the
first query, not filtered after the fact.

## 3. Webhook authenticity, replay, and idempotency

Covered in full in `INTEGRATION_EVENT_AND_DELIVERY_MODEL.md` §3-4. Summary of the security
properties specifically:

- **Authenticity**: HMAC-SHA256 over the exact raw request bytes, constant-time compared.
  An invalid signature is recorded (for audit) and rejected — never dispatched to a
  handler. Proven by `outboxAndWebhooks.test.ts`'s dedicated invalid-signature test.
- **Replay protection / idempotency**: a durable, database-level unique constraint on
  `(connectionId, provider, providerEventId)`, not an in-memory cache. A redelivered event
  is recorded as `DUPLICATE` and never reaches an effect handler a second time. Proven by
  a dedicated duplicate-webhook test that asserts the effect handler's own call counter
  stays at exactly one.
- **Payload-size limits**: `MAX_WEBHOOK_PAYLOAD_BYTES = 256 KiB`, checked before any
  further processing.
- **No arbitrary outbound HTTP / no SSRF surface**: this build has no configurable
  provider endpoint at all — the one adapter is entirely in-process and makes no network
  call. The admin API (§5) has no generic "make an HTTP request" endpoint, matching the
  brief's explicit prohibition on one.

## 4. Credential-reference boundary

`integration_credentials` (schema) has these columns: `id`, `connectionId` (unique FK),
`referenceType`, `secretIdentifier` (`text`), `status`, `createdBy`, `revokedBy`,
timestamps. **There is no column capable of holding a secret value** — no `value`,
`token`, `apiKey`, or similar. This is a structural guarantee, not a convention someone
could accidentally violate by adding data to an existing column.

`credentials.ts`'s `mintMockAuthFlow(connectionId, brokerageId, actor)` mints an opaque identifier of
the form `mock-secret-ref:<uuid>` (`SECRET_IDENTIFIER_PREFIX`) — it does not look like a
real API key, JWT, or any recognisable secret format, and a dedicated test
(`outboxAndWebhooks.test.ts`) asserts exactly that: the identifier starts with the mock
prefix and does not match JWT shape or common real-provider key prefixes. **Updated this
step (Step 2):** `mintMockAuthFlow` now requires and uses `brokerageId` as its second
parameter — it calls `loadConnectionInBrokerage(connectionId, brokerageId)` before any
read/write of `integration_credentials`, closing a tenant-isolation gap where the function
previously accepted only `(connectionId, actor)` with no brokerage check at all. See
`AUTHENTICATION_AUTHORISATION_AND_TENANT_ISOLATION.md` finding #6 and
`SECURE_INTEGRATION_BOUNDARY.md` §2 for the full before/after and test evidence.

`getSecretIdentifierForSigning(connectionId)` is the only function that reads
`secretIdentifier` back out, and it is called from exactly two places: the webhook route
handler (server-side, to verify an inbound signature) and test code. It is never returned
from any HTTP response — `routes/integrations.ts`'s connection-detail and
mint-credential endpoints explicitly omit `secretIdentifier` from what they send back, and
there is no endpoint that returns it at all.

Revocation cascades: `revokeConnection()` in `model.ts` also revokes the credential
reference, so a revoked connection cannot still have a "live" reference sitting around.

## 5. Redaction

Credential values structurally cannot appear in logs, errors, or API responses because
they are never held anywhere but the opaque reference described above. Full-payload
redaction for sensitive inbound webhook content beyond the credential boundary (e.g. a
future provider payload containing PII or financial account numbers) is not yet
implemented as a general mechanism — `integration_inbox.payload` currently stores
whatever the webhook sent, in full, for audit/replay. For the three mock providers this
build has, that payload never contains anything sensitive (a portal destination id and
status string; an SMS delivery status and message reference; a payment-status event with
amount/currency and a reference id — no account numbers, no PII beyond what AE's own
canonical records already hold). This is a real gap for a future real provider whose
payloads might carry PII or account data — flagged in the completion report, not silently
left unaddressed.

## 5a. The administration UI's own access boundary (Step 5 remediation)

The Settings → Integrations admin UI (`apps/web/src/pages/SettingsIntegrations.tsx` and
its backend routes in `routes/integrations.ts`, built during the remediation pass) is
subject to the exact same boundary described above, checked independently at two layers:

- **Presentation layer**: `SettingsIntegrations.tsx`'s top-level component checks
  `user?.role === "Brokerage Administrator"` before rendering anything integration-related
  — the same raw-string role check every other admin-only page in this codebase already
  uses (e.g. `FinancialOperations.tsx`). This is a UX nicety, not the actual boundary.
- **API layer, independently**: every route under `/integrations/*` — including the three
  new admin read-model routes (`GET /integrations/overview`, `/activity`,
  `/reconciliation`) — sits behind the router-level `requireAuth, requireRole(...
  BROKERAGE_ADMIN_ROLES)` gate. A request that somehow reached these routes without going
  through the UI at all (a non-admin user calling the API directly) is rejected the same
  way. `integrationsAdmin.test.ts` proves this by calling the routes directly as a
  non-admin Agent-role user and asserting HTTP 403 on all three, and by a dedicated
  cross-tenant test on the overview route. `integrationOperational.test.ts` separately
  proves the same 403 on the dead-letter replay route.
- **No connection is ever implied where none exists.** The overview read-model
  (`getIntegrationOverview` in `adminViews.ts`) returns `connectionId: null` and every
  connection-dependent field (`connectionStatus`, `approvalStatus`, `health`) as `null` —
  never a default value that could be misread as a real state — for a catalogue provider
  the brokerage has not connected to, with `reconciliationStatus: "NOT_APPLICABLE"`.
  Proven by test and confirmed visually in a live browser session (see
  `INTEGRATION_FOUNDATION_COMPLETION_REPORT.md` §D.1): the frontend's separate
  `NOT_CONNECTED_LABEL`/`NOT_CONNECTED_PILL_CLASS` constants are used only for this case,
  distinct from all 11 real lifecycle-state labels.
- **No secret is ever returned by an admin-UI endpoint.** None of the three new read-model
  functions, nor any existing connection/credential endpoint, includes `secretIdentifier`
  in its response shape — confirmed by direct reading of `adminViews.ts` and
  `routes/integrations.ts`, consistent with Section 4 above.

## 6. What's out of scope for this step

Per build brief §11 and §19, the following are explicitly the *next* stage's work, not
this one's: a full security-hardening program; SSRF protection for a *configurable*
provider endpoint (none exists yet to protect); a formalised secrets-manager integration
(the reference boundary above is designed to make that a clean drop-in later, not a
rework); rate-limiting/abuse controls on the admin API; and comprehensive
sensitive-payload redaction for real provider content. **Update (Step 2):** rate-limiting
is no longer entirely absent — the global `rateLimiter` (300/min/IP) applies to every
route including `/integrations/*`, though no integration-admin-specific tighter limit was
added this step. The remaining items above are still genuinely unaddressed — none of these
were silently skipped — they're absent because nothing in this build yet has the surface
area (a real provider, a configurable endpoint, a real secret) that would make them
meaningful to build now rather than decorative.
