# Secure Integration Boundary — Step 2 Re-verification

Agent Engine 2.0 Step 5 built and documented the integration/data-exchange foundation's
security boundary in `INTEGRATION_SECURITY_BOUNDARY.md` (still the primary reference for
the resolver's check order and the credential-reference model — this document does not
repeat it). This step's job, per its own instruction ("integration security
re-verification"), was to confirm that boundary still holds and to close anything it
doesn't — not to redesign it.

## 1. What was re-verified, and the result

**The fail-closed resolver chain** (`resolveActiveConnection` in
`lib/integrations/registry.ts` — existence/tenant → brokerage-enabled → entitlement →
status → environment classification → approved scope → capability). Re-read this step
against the live file; unchanged from Step 5's own description and still the single
chokepoint every read/write integration action goes through, with one exception found and
fixed (§2).

**The credential-reference boundary** (`lib/integrations/credentials.ts`) — structurally
incapable of persisting a real secret value: no exported function in this file accepts a
"value" parameter, only an opaque, self-generated `secretIdentifier`
(`mock-secret-ref:<uuid>`). This guarantee is unchanged. What this step found and fixed was
a **tenant-isolation gap in front of it**, not a defect in the guarantee itself:

## 2. Finding fixed this step — `mintMockAuthFlow` had no tenant check

`POST /integrations/connections/:id/mint-credential` called `mintMockAuthFlow(connectionId,
actor)` with no `brokerageId` anywhere in the call — the one handler in `routes/
integrations.ts` that didn't route through `loadConnectionInBrokerage` before touching a
connection by id, unlike every sibling handler in the same file (`connections/:id`,
`dead-letters/:id`, the action-publish/send-sms/link-payment-reference routes). A Brokerage
Administrator from any brokerage could mint or reactivate a credential reference against
any other brokerage's connection by id, including flipping a `REVOKED` credential back to
`ACTIVE`. Fixed by making `mintMockAuthFlow` call `loadConnectionInBrokerage` itself, first,
before any read/write of `integration_credentials` — the identical chokepoint every other
handler already used. Full detail, including the exact before/after and new test evidence,
is in `AUTHENTICATION_AUTHORISATION_AND_TENANT_ISOLATION.md`, finding #6. This closes the
gap in the resolver chain's own consistency: the chain in §1 was never wrong, one caller of
a *different* function (credential minting, which doesn't go through
`resolveActiveConnection` at all — it's a connection-lifecycle action, not a
capability-execution one) simply never called the tenant-scoped loader it should have.

## 3. Webhook trust re-verified — three routers, three providers

Every webhook route was re-read this step to confirm signature verification and payload-
driven tenant resolution still hold, with no regressions from any change made elsewhere
this step (in particular, `app.ts`'s new middleware stack — helmet, requestId, CORS, rate
limiting, the 1 MB body-size limit — was checked to confirm none of it interferes with
`req.rawBody` capture, which webhook signature verification depends on byte-for-byte; it
doesn't, since `express.json({ verify })`'s capture happens in the same call that changed
only its `limit` option).

- **`communicationsWebhooks.ts`** — tenant resolved from the URL's `:brokerageId` segment,
  but `findMessageForBrokerage` re-checks `communicationMessages.brokerageId` in the same
  query before any mutation — the URL segment alone is never trusted for the write itself.
- **`financialWebhooks.ts`** — signature-verified; resolves the payment request via the
  signed payload's `providerRequestRef`, never a client-supplied id.
- **`integrationsWebhooks.ts`** — per-connection signing secret
  (`getSecretIdentifierForSigning(connectionId)`, never a shared/global secret); tenant
  resolved from whichever connection the signature actually verifies against, so a
  signature computed with connection A's secret cannot be replayed against connection B's
  webhook handler even if the attacker knows B's connection id.

All three: verified correct by direct code review this step, not modified (no defect
found).

## 4. Third-party sandbox/production connections

**None approved.** This step's instruction is explicit that it does not authorise a real
third-party sandbox or production connection, and none was made. Every provider adapter in
`packages/integrations/*` remains its mock implementation
(`AML_PROVIDER=mock`/`ESIGN_PROVIDER=mock`/`PAYMENT_PROVIDER=mock`/`PROPERTY_DATA_
PROVIDER=mock`/`AI_PROVIDER=mock`, per `.env.example`), and `resolveActiveConnection`'s own
`environmentClassification === "MOCK"` defense-in-depth check (§1, check 5) — which exists
specifically so a connection somehow marked `SANDBOX`/`PRODUCTION` without the
corresponding real-adapter work being reviewed still can't be used — was left in place,
unmodified, and untriggered throughout this step's testing (every test fixture creates
`MOCK`-classification connections only).

## 5. Outstanding from Step 5, still outstanding

Step 5's own completion report (`INTEGRATION_FOUNDATION_COMPLETION_REPORT.md`, Section G)
already disclosed that the sync-cursor/reconciliation-run/import-export *frameworks* (as
reusable, general-purpose services, distinct from the domain-specific proofs that do exist)
and most of the wider observability baseline remained unbuilt. This step's own
observability work (see `OBSERVABILITY_STANDARD.md`) closes a small part of that
(correlation id, health check) but does not build those frameworks — unchanged status,
carried forward honestly rather than silently dropped from the record.
