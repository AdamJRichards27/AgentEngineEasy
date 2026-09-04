# Integration Adapter Contracts

How a provider integration plugs into the foundation: the typed contracts, the capability
catalogue, the registry/resolver, and the concrete steps to add a new provider later. All
types referenced live in `apps/api/src/lib/integrations/types.ts` and `registry.ts`.

## 1. Capability verbs, not provider SDKs

Domain code never imports a provider SDK or references a provider name directly. It calls
one of a small set of AE-defined capability verbs:

```ts
export const INTEGRATION_CAPABILITIES = {
  PORTAL_PUBLISH_LISTING: "portal.publishListing",
  PORTAL_UPDATE_LISTING_STATUS: "portal.updateListingStatus",
  // AE Step 5 remediation — Proof B (Communications Hub): an outbound SMS
  // send routed through the integration foundation's own outbox/adapter/
  // mapping/webhook machinery, instead of Communications' synchronous
  // sandbox provider. See lib/integrations/commsProof.ts.
  COMMS_SEND_SMS: "comms.sendSms",
  // AE Step 5 remediation — Proof C (Financial Transaction Engine): inbound
  // mock payment-STATUS sync only (never a debit/transfer capability — see
  // lib/financial/mockPaymentStatusSync.ts's own header comment).
  PAYMENTS_STATUS_SYNC: "payments.statusSync",
} as const;
```

This grew from two capabilities (the original pass, covering only the Property Launch
proof) to four once the remediation pass added Proofs B and C — each new domain proof
added exactly one verb for the one action it actually needed, nothing speculative. Adding
a capability for a still-later domain (e.g. `esign.requestSignature`) means adding one
more entry here and having the relevant adapter declare it; nothing about the registry,
resolver, outbox, or webhook gateway changes shape to support a new capability — this was
proven twice more by the remediation pass doing exactly that.

`apps/api/src/lib/integrations/launchProof.ts` (Proof A), `commsProof.ts` (Proof B),
`financialProof.ts` (Proof C), and `routes/integrations.ts` are the only places outside
`registry.ts`/`outbox.ts` that reference `INTEGRATION_CAPABILITIES` — every call is against
the verb, never a provider id by name except where the code is explicitly registering or
resolving a provider (`registry.ts`, `bootstrap.ts`, `testHelpers.ts`).

## 2. The provider catalogue

`PROVIDER_CATALOGUE` in `registry.ts` is a small, code-defined, reviewed-like-any-other-
code-change array (the same discipline `lib/exceptions/registry.ts`'s `RISK_RULES` already
uses) — not a database table an operator edits freely. `seedProviderCatalogue()` upserts
it into `integration_providers` at boot (`bootstrap.ts`), idempotently.

This build ships exactly three entries — one per domain proof, still nowhere close to
every category the brief names:

```ts
{
  id: "mock_portal_v1",
  category: "PORTAL",
  displayName: "Mock Property Portal (Sandbox)",
  capabilities: ["portal.publishListing", "portal.updateListingStatus"],
  environmentClassification: "MOCK",
},
{
  id: "mock_sms_v1",
  category: "COMMUNICATIONS",
  displayName: "Mock SMS Gateway (Sandbox)",
  capabilities: ["comms.sendSms"],
  environmentClassification: "MOCK",
},
{
  id: "mock_payment_status_v1",
  category: "FINANCIAL",
  displayName: "Mock Payment Status Feed (Sandbox)",
  capabilities: ["payments.statusSync"],
  environmentClassification: "MOCK",
}
```

A small, still-deliberately-incomplete catalogue remains the design (Section 3 of the
foundation overview document): the brief explicitly warns against suggesting providers are
available that aren't actually implemented, and against building every provider category
now. Each of these three exists because a specific required domain proof needed it — no
"just in case" catalogue rows were added. Every other category the brief names (real
estate portals beyond this one, accounting, banking, calendar, e-sign, AML, conveyancing,
document services, CRM/migration, marketing, signage/photography/brochure, utility/moving
referrals) still has zero catalogue rows in this build.

## 3. `ProviderDefinition`

```ts
export interface ProviderDefinition {
  id: string;
  category: string;
  displayName: string;
  description: string;
  capabilities: IntegrationCapability[];
  environmentClassification: "MOCK" | "SANDBOX" | "PRODUCTION";
}
```

This is intentionally a subset of the full field list the brief's Section 5.1 describes
(supported auth methods, supported environments plural, required config keys, data
classifications, jurisdiction restrictions, health-check capability, installed/approved/
deprecated flags). Those fields matter once there is more than one provider and more than
one environment classification in play; adding them to a catalogue of exactly one
`MOCK`-only provider would be schema decoration with nothing to validate against. The
`integration_providers` table's own columns (`category`, `capabilities` jsonb,
`environmentClassification`, `isBuiltIn`, `active`) are the ones actually load-bearing in
this build; extending both the table and `ProviderDefinition` is a small, additive change
when a second provider is added.

## 4. `IntegrationAdapter`

```ts
export interface IntegrationAdapter {
  providerId: string;
  version: string;
  capabilities: IntegrationCapability[];
  send(
    capability: IntegrationCapability,
    payload: Record<string, unknown>,
    ctx: AdapterSendContext,
  ): Promise<AdapterSendResult>;
}
```

`AdapterSendContext` carries `connectionId`, `brokerageId`, and `idempotencyKey` — enough
for an adapter to make its own outbound call idempotent, without ever seeing a raw
credential (adapters resolve their own secret reference through
`getSecretIdentifierForSigning`/`credentials.ts` if they need one; the mock adapter needs
none).

`AdapterSendResult` uses one shared, typed outcome shape rather than a bag of
provider-specific fields:

```ts
export interface AdapterSendResult {
  status: "SENT" | "FAILED";
  providerReference: string | null;
  failureCategory?: IntegrationFailureCategory; // only when status === "FAILED"
  failureDetail?: string;
  responseSummary: string;
}
```

`IntegrationFailureCategory` (`types.ts`) is the error taxonomy referenced by
`isRetryableIntegrationFailure()`:

| Category | Retryable? |
| --- | --- |
| `TRANSIENT_PROVIDER_ERROR` | yes |
| `RATE_LIMITED` | yes |
| `PERMANENT_REJECTION` | no |
| `VALIDATION_ERROR` | no |
| `AUTH_ERROR` | no |

This is a smaller taxonomy than the brief's Section 5.14 list (which also names
authentication/authorisation failure separately, timeout, invalid provider response,
schema mismatch, mapping failure, duplicate, conflict, tenant mismatch, consent/authority
missing, configuration/credential-reference missing, unknown provider event, internal
processing failure as distinct categories). The five here are exactly what
`dispatchCommand`'s retry/dead-letter decision actually needs to branch on; the broader
list mixes true adapter-outcome categories with resolver-level failures that are already
handled as distinct `IntegrationError` reasons before an adapter is ever invoked (see
`INTEGRATION_SECURITY_BOUNDARY.md` Section 1 for that list). This same five-category
taxonomy was reused, unchanged, by the two mock adapters the remediation pass added
(`mockSms.ts`, `mockPaymentStatus.ts`) — three adapters now validate against it without
needing it to grow, which is some evidence (not proof) that it is reasonably shaped.
Extending it further is still a natural next step once a *real* adapter's actual failure
modes are known — inventing finer categories now, with only mock adapters to validate them
against, risks a taxonomy that doesn't match anything real.

The brief's Section 5.3 also lists `validateConfiguration`, `testConnection`, `getHealth`,
`verifyWebhook`, `parseWebhook`, `normaliseEvent`, `reconcile`, `disconnect`, and
`redactForLogging` as adapter methods. This build's `IntegrationAdapter` has `send()` only.
`validateConnection()` in `model.ts` calls `adapter.send()` with a
`{ __validationProbe: true }` payload rather than a separate `testConnection()` method —
every mock adapter treats that flag as an always-succeeding probe. Webhook signature
verification is implemented directly in `webhooks.ts`'s `verifyWebhookSignature()` (HMAC,
provider-agnostic) rather than per-adapter, because the one real gateway this build has
only needs one verification scheme; a provider needing a different scheme would extend
that function or take a provider-specific verifier, not require restructuring the adapter
interface. `getHealth`, `reconcile`, `disconnect`, and `redactForLogging` are not yet
implemented anywhere — genuine gaps, listed again in the completion report.

## 5. The registry and resolver

`registerAdapter(adapter)` / `getAdapter(providerId)` — a plain in-process
`Map<string, IntegrationAdapter>`, matching the reasoning `PROVIDER_CATALOGUE` itself uses
(this is executable configuration, reviewed like code, not a database-driven plugin
system). `clearAdaptersForTesting()` resets it between test files.

`resolveActiveConnection(brokerageId, connectionId, capability)` is the **one** fail-closed
chokepoint. Every outbound dispatch (`outbox.ts`) and every inbound webhook's connection
lookup (`webhooks.ts`) goes through it — there is no code path from "a command sits in the
outbox table" or "a webhook arrived" to "the adapter is actually invoked" that skips this
function. Its full check order and the reasoning for that order (tenant/existence checked
first, deliberately) is documented in `INTEGRATION_SECURITY_BOUNDARY.md` Section 1, since
it is as much a security control as an adapter-lookup mechanism.

## 6. Adding a new provider (for a later, individually approved stage)

None of the following is done in this build. When a real provider is added later:

1. Add a capability verb to `INTEGRATION_CAPABILITIES` if the provider needs one that
   doesn't already exist.
2. Write an adapter implementing `IntegrationAdapter` for that provider (its own module,
   e.g. `apps/api/src/lib/integrations/adapters/<provider>.ts` — see `mockPortal.ts` for
   the shape, though a real adapter will actually call out to the provider rather than
   simulating outcomes from payload flags).
3. Add one `ProviderDefinition` entry to `PROVIDER_CATALOGUE`, with
   `environmentClassification` set honestly (`SANDBOX` for a real sandbox — this build's
   resolver currently hard-rejects anything but `MOCK` as defence in depth, so that check
   in `registry.ts` needs a deliberate, reviewed change at the same time, not a silent
   widening).
4. Call `registerAdapter()` for it in `bootstrap.ts`.
5. Wire a real credential flow through `credentials.ts` in place of
   `mintMockAuthFlow` — this is where a real secrets-manager integration belongs (Section
   19 of the build brief scopes that as security-hardening work, not this step).
6. Write a domain integration proof for whichever domain the provider serves, following
   the shape `launchProof.ts` establishes: the provider's inbound/outbound traffic reaches
   the domain only through that domain's own existing service-boundary functions, never a
   new parallel write path.
7. Only then does a brokerage administrator create a `DRAFT` connection, request approval,
   and — following whatever individual sandbox-activation approval process Section 20 of
   the build brief describes as a later, separate step — activate it.
