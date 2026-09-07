# Agent Engine — Subprocessor and Third-Party Service Disclosure

**STATUS: DRAFT — LEGAL REVIEW REQUIRED. This document has not been reviewed or approved by a
qualified Australian lawyer and must not be relied upon or distributed to real pilot participants
until it has been.**

| | |
|---|---|
| Document | Subprocessor and Third-Party Service Disclosure |
| Version | 0.1 (draft) |
| Basis | Direct review of the Platform's integration code (`packages/integrations/*`, `apps/api/src/lib/communications/providers/*`, `apps/api/src/lib/auth/email.ts`, `apps/api/src/lib/billing/*`) at the time of drafting |

Every provider integration in this codebase is built behind a provider-neutral interface, selected
by an environment variable, with a non-live "mock" or "sandbox" implementation as the default and
(in most cases) a fallback if a real provider isn't configured. **This document lists what the code
actually supports and what mode each is in as reviewed — it must be re-checked against the pilot's
actual live environment configuration before being relied upon, since an environment variable can
be changed without changing this document.**

## Disclosure table

| Function | Integration point | Real vendor supported by code | Status for this pilot | Data categories potentially involved if a real vendor were enabled |
|---|---|---|---|---|
| AML / identity verification | `packages/integrations/aml` | A generic HTTP-based provider (specific vendor not yet chosen) | **Sandbox/mock only.** No live AML vendor is configured or authorised for this pilot. | Party name, and whatever identity details a real AML check would require |
| E-signature | `packages/integrations/esign` | A generic HTTP-based provider (specific vendor not yet chosen) | **Sandbox/mock only.** No live e-signature vendor is configured or authorised. No signature captured in the pilot has real legal effect. | Signatory name and email |
| Card/one-off payments | `packages/integrations/payments` | Stripe | **Mock only for this pilot.** A Stripe adapter exists in the codebase but is not configured or authorised for live use. | Payment-method references (never raw card numbers, by design) |
| Subscription billing ("Grow") | `apps/api/src/lib/billing` | Stripe | **Mock only for this pilot**, consistent with the Owner's instruction that the pilot is free or manually invoiced only — no automated subscription billing is active. | Billing/customer references |
| Direct-debit mandate payments (e.g. Pit Crew fees) | `packages/integrations/mandate-payments` | **No live vendor integration exists in the codebase at all** — only a sandbox simulation ships | **Sandbox only**, structurally — there is currently no real vendor this could even be pointed at without new development. | Mandate references, scheduled-debit amounts (simulated only) |
| Property/address data lookup | `packages/integrations/property-data` | Google (Places API) | **Mock by default.** A Google Places adapter exists in the codebase; **confirm before relying on this document whether it has been enabled with a real API key for this pilot** — if enabled, Google would be a live subprocessor for address-lookup queries. | Property address search terms |
| Object/document storage | `packages/integrations/object-storage` | None — local disk storage only in this codebase | **Local storage only.** No cloud storage vendor is currently integrated. | Generated/signed document content |
| Email delivery (general communications) | `apps/api/src/lib/communications/providers/sandboxEmail.ts` | None yet — sandbox only | **Sandbox only.** No real email is sent; a real provider is required before production and does not yet exist in this codebase. | Recipient address, message content |
| SMS delivery | `apps/api/src/lib/communications/providers/sandboxSms.ts` | None yet — sandbox only | **Sandbox only.** No real SMS is sent. | Recipient mobile number, message content |
| Account security email (invitations, password reset) | `apps/api/src/lib/auth/email.ts` | None yet — sandbox only, and the codebase explicitly refuses to use the sandbox provider in a real production environment | **Sandbox only.** A real provider must be configured before this pilot could safely rely on real email delivery for invitations/password resets in production. | Recipient address, invitation/reset link |
| AI-assisted features | `apps/api/src/lib/ai/*` | Anthropic (an adapter exists) | **Confirm current configuration before relying on this row** — the code defaults to a mock/simulated response, but a real provider adapter exists and may be enabled for the pilot given AI features are central to the product. If a real provider is enabled, treat it as a live subprocessor. | Property/transaction context assembled for a specific AI-assisted request (see the AI Use Disclosure) |
| Database / application hosting | Not vendor-specific in the reviewed code | N/A | **To be confirmed and added** — wherever the pilot's database and application are actually hosted is itself a subprocessor for all data in the system, and is not identified by name in this draft. | All categories in the Pilot Privacy Policy |

## What this means in practice, today

If every provider above is left at its coded default, the pilot sends personal information to
**no live third-party AML, e-signature, payment, or SMS vendor at all** — those functions run
entirely inside the Platform's own sandbox simulations. The two rows that most plausibly carry a
real, live third party during the pilot are the **AI-assisted features** (if a real AI provider is
configured, given AI is core to the product) and, if enabled, the **property-data lookup** (Google)
— both are flagged above for direct confirmation, and the hosting/infrastructure provider row is a
placeholder needing a name.

---

### Assumptions requiring confirmation before legal review

- Assumes this document will be re-verified against the pilot's actual environment configuration
  (not just the code's defaults) immediately before go-live, and again if any provider setting
  changes — confirm a change-control process ties configuration changes to this document.
- Assumes the AI provider actually in use for the pilot (mock vs a real provider) is identified and
  this row updated accordingly before real client data is processed by an AI feature.
- Assumes the property-data provider (mock vs Google Places) actually in use is identified and this
  row updated accordingly.
- Assumes the database/application hosting provider will be named here once confirmed, and that its
  own data-location and subprocessor arrangements are reviewed for APP 8 cross-border disclosure
  purposes if relevant.
- Assumes no additional third-party service (e.g. an error-monitoring or logging SaaS tool) is
  wired into the pilot build beyond what this code review found — confirm no such tool exists
  outside the reviewed directories.
