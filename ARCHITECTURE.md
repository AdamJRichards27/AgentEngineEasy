# AgentEngineEasy — Architecture Plan

Produced before implementation, per the build brief's Section "Before writing significant code." Covers: proposed folder structure, domain model, database changes, integration interfaces, development sequence, reusable components from Agent Engine Staging, and components explicitly not carried across. This document ships in the repo (`/ARCHITECTURE.md`) as the standing reference for the build.

Full prior-art audit (KEEP/ADAPT/REBUILD/RETIRE/FUTURE classification of every capability in `AgentEngineStaging`) lives in that audit's own delivered document; this file restates only what's load-bearing for the build itself.

---

## 1. Proposed folder structure

```
AgentEngineEasy/
  ARCHITECTURE.md
  README.md
  package.json                    pnpm workspace root
  pnpm-workspace.yaml
  tsconfig.base.json
  .env.example
  .replit                         Replit run configuration

  packages/
    db/                           Drizzle schema + client (own database — see §7)
      src/schema/
        users.ts                  User, Brokerage
        property.ts                Property, Party, PropertyParty
        appraisal.ts                Appraisal
        aml.ts                      AMLVerification
        documents.ts                Document, DocumentPackage, SignatureRequest
        commerce.ts                 ServiceOrder, Payment, PaymentMethod
        transaction.ts              Offer, Transaction
        workflow.ts                 Workflow, WorkflowStep
        events.ts                   DomainEvent
        audit.ts                    AuditLog
        index.ts                    barrel export
      drizzle.config.ts
      migrations/                  hand-written idempotent SQL (convention kept from Agent Engine)

    events/                       Domain event backbone (ported pattern from lib/events)
      src/types.ts                  19 canonical event types (§6)
      src/registry.ts                handler registration/dispatch
      src/publisher.ts               publish + idempotency

    integrations/                 Provider abstraction layer (§5)
      property-data/src/index.ts    PropertyDataProvider interface + GooglePlaces adapter + Mock
      aml/src/index.ts               AMLProvider interface + Mock
      esign/src/index.ts             ESignProvider interface + Mock
      payments/src/index.ts          PaymentProvider interface + Mock

  apps/
    api/                         Express/TypeScript API
      src/app.ts                    app assembly
      src/index.ts                   server bootstrap
      src/middlewares/auth.ts        role model: Agent, Brokerage Administrator, Pit Crew
      src/lib/audit.ts               logAudit() — ported pattern
      src/lib/events.ts              publishDomainEvent() wiring
      src/routes/
        health.ts
        properties.ts                Start Property, get, list, ready-to-list
        parties.ts                   add/list sellers & buyers on a property
        aml.ts                       verification status (stub, Phase 4 builds it out)
        documents.ts                 document package status (stub, Phase 5)
        offers.ts                    (stub, Phase 7)
        index.ts

    web/                         React/Vite frontend
      src/pages/
        Home.tsx                     "what needs my attention today"
        PropertiesList.tsx
        StartProperty.tsx            address search → property created
        PropertyWorkspace.tsx        the Property Action Screen (§4)
        Settings.tsx
      src/lib/api.ts
      src/App.tsx                    shallow route table — 5 destinations, not 15
      src/main.tsx
```

This mirrors the *pattern* proven in `AgentEngineStaging` (pnpm workspace, `packages/*` for shared domain logic, `apps/*` for the two runtimes) without inheriting its module-per-page navigation.

---

## 2. Domain model

Core entities, matching the build brief's Section 23 list, resolved against what the prior audit found:

| Entity | Notes |
|---|---|
| **User** | Same shape as Agent Engine's `users` table (id, clerkId, name, role, officeId→brokerageId, isActive). |
| **Brokerage** | Built as a real first-class entity from day one — the prior audit flagged this as a gap in the old app (tenancy was `officeId`-by-convention only). AgentEngineEasy does not repeat that gap. |
| **Property** | The single operational container. Holds address, workflow stage, and denormalized status summaries (aml, listing, contract) for fast "what's next" queries. |
| **Party** | Person / Organisation / Trust / Estate / Other. Minimum fields captured once (first/middle/last name, mobile, email, residential address); entity-specific fields requested only when `partyType !== "Person"`. |
| **PropertyParty** | Join table: property ↔ party ↔ role (Seller, Buyer, Solicitor, etc.) ↔ relationship metadata. This is the mechanism that makes "enter once" real. |
| **Appraisal** | Property-scoped, versioned (immutable snapshot on finalisation — this pattern from Agent Engine's `appraisals.ts` is worth keeping). |
| **AMLVerification** | Exact shape from Section 7 of the brief: verification_id, property_id, party_id, provider, provider_reference, verification_type, status, requested_at, completed_at, outcome, risk_level, review_required, evidence_reference, created_by, audit timestamps. Agent-facing status is the 6-value enum (Not Started / Awaiting Seller / In Progress / Complete / Review Required / Failed); provider-side detail stays server-side. |
| **Document / DocumentPackage** | `Document` = one generated/uploaded file; `DocumentPackage` = the bundle assembled for a given workflow stage (e.g. "Ready to List package") and sent as one signature envelope. |
| **SignatureRequest** | One row per e-sign envelope; tracks provider reference, signatories, status, webhook history. |
| **ServiceOrder** | Generic paid-service entity (Section 11) — AML verification, searches, paid forms all flow through this one table rather than a bespoke billing path per service type. |
| **Payment / PaymentMethod** | Stored payment method + charge records, with a `payerType`/`payerId` pair (individual / team / brokerage / subscription-allowance / central) from day one, per Section 12 — so introducing brokerage billing later doesn't require rebuilding `ServiceOrder`. |
| **Offer** | Revision-chain shape (each change is a new row, matching Agent Engine's proven `offers.ts` pattern — never overwritten in place). |
| **Transaction** | Created from an accepted Offer, linked to the Property rather than duplicating seller/buyer/property data. Real structured fields (not a single flat `commission` number) from the start — the prior audit's biggest schema warning. |
| **Workflow / WorkflowStep** | Generic engine instance: a Property (or Transaction) has an active `Workflow` made of ordered `WorkflowStep`s, each mapped to a real status. This is what answers "what needs to happen next?" generically instead of hand-coding per-page logic, and what will later let state/brokerage rules vary the milestone set (Section 16) without a schema change. |
| **Event** | `DomainEvent` — 19 canonical types (§6). |
| **AuditLog** | Ported pattern: who/what/property/party/previous→new value/provider reference/timestamp. Property Timeline is a read projection over this + Event, exactly as Agent Engine already does it. |

---

## 3. Database changes vs. Agent Engine Staging

AgentEngineEasy uses its **own separate database** (Section 1) — this is additive design, not a migration of existing rows. Where a table shape is being reused, it's reused as a *pattern*, re-created fresh:

- `users`, `contacts`→`Party`, `contactPropertyRelationships`→`PropertyParty`, `documents`/`documentVersions`/`documentActivity`, `tasks`(folded into `WorkflowStep`), `auditLogs`, `domainEvents` — ported near-as-is.
- `offices` → **replaced**, not extended: a real `brokerages` table from the start (see §2).
- `agencyAgreements` → not ported as-is. AgentEngineEasy's `DocumentPackage`/`Document` model carries agency-agreement terms as real structured fields, not opaque JSON — this was the single clearest "not a source of truth" finding in the prior audit and is not being repeated.
- `transactions` → not ported as-is (the flat single-table shape, and the unresolved schema-drift bug found in the old app, are both left behind). Real `Transaction` + `WorkflowStep` milestones from the start.
- `amlRequests` (legacy, parallel table in the old app) → not ported at all. Only the `amlOrders`-equivalent (`AMLVerification`) exists here.
- No `Listing` table yet in Phase 1–3 scope — tracked as a `Property.workflowStage` value initially, exactly like the old app, with the same caveat flagged in the prior audit: revisit before assuming a status field is enough once listing-specific history (price changes, relisting) matters.

---

## 4. The Property Action Screen (frontend anchor)

`PropertyWorkspace.tsx` is the one screen the whole build orients around. It renders from a single `GET /api/properties/:id/workspace` response shaped as:

```
{
  property: { address, stage },
  parties: [{ name, role, amlStatus }],
  nextActions: [{ label, status, cta }],   // e.g. "Verify Sellers", "Agency Agreement", "Required Documents"
  timeline: [...]                          // recent audit/event entries, human-readable
}
```

One primary CTA at a time (`Review & Send`, `Verify Sellers`, etc.) — never a menu of fifteen options. This is the concrete implementation of Section 13/26's UI principle.

---

## 5. Integration interfaces (provider abstraction)

Every external service sits behind a narrow interface in `packages/integrations/*`, never called directly from route or UI code (Section 18–19):

```ts
// packages/integrations/property-data/src/index.ts
export interface PropertyDataProvider {
  searchAddress(query: string): Promise<AddressCandidate[]>;
  lookupOwnership(addressId: string): Promise<OwnershipRecord[] | null>;
}

// packages/integrations/aml/src/index.ts
export interface AMLProvider {
  requestVerification(input: AMLVerificationRequest): Promise<{ providerReference: string }>;
  handleWebhook(payload: unknown, signature: string): Promise<AMLWebhookResult>;
}

// packages/integrations/esign/src/index.ts
export interface ESignProvider {
  createEnvelope(pkg: DocumentPackageInput): Promise<{ providerReference: string }>;
  handleWebhook(payload: unknown, signature: string): Promise<ESignWebhookResult>;
}

// packages/integrations/payments/src/index.ts
export interface PaymentProvider {
  chargeStoredMethod(input: ChargeRequest): Promise<ChargeResult>;
  refund(providerReference: string, amountCents: number): Promise<void>;
}
```

Every provider package ships a `Mock*Provider` implementing the same interface, used until real credentials exist — the app runs end-to-end against mocks from the first commit, provider swap is a factory-config change only (matching the AML/Payments factory pattern already proven in Agent Engine Staging).

---

## 6. Event architecture

19 canonical events (Section 17's list, carried forward exactly):

`PROPERTY_CREATED`, `APPRAISAL_COMPLETED`, `READY_TO_LIST`, `AML_REQUESTED`, `AML_COMPLETED`, `DOCUMENT_PACKAGE_CREATED`, `AGENCY_AGREEMENT_SENT`, `AGENCY_AGREEMENT_SIGNED`, `LISTING_LIVE`, `OFFER_RECEIVED`, `OFFER_ACCEPTED`, `CONTRACT_SIGNED`, `FINANCE_APPROVED`, `SETTLEMENT_SCHEDULED`, `SETTLEMENT_COMPLETED`, `COMMISSION_CALCULATED`, `FUNDS_RECEIVED`, `AGENT_PAID`, `TRANSACTION_CLOSED`.

Same rules as the proven Agent Engine pattern: persist-then-publish, always try/catch + logged (never blocks the business transaction), idempotency key required on anything retriable, handlers isolated from each other and from the publisher.

---

## 7. Environment separation

- Separate GitHub repository (`AgentEngineEasy`, private), independent of `AgentEngineStaging` — no shared history, no shared branches.
- Separate database (own `DATABASE_URL`), separate Clerk (or equivalent) application/credentials, separate provider API keys — all via `.env`, `.env.example` committed, real values never committed.
- Branches: `main` (protected, releases only) and `staging` (all active development, per the brief). Feature branches fork from `staging`.
- Deployment: Replit-connectable (`.replit` included), same as the reference app.

---

## 8. Reusable components from Agent Engine Staging

Pattern-level reuse (re-implemented fresh in this repo, not copy-pasted, since it's now a separate codebase and several of these change shape — see §3):

- Domain event backbone design (types/registry/publisher/handler isolation).
- Audit logging shape and Property-Timeline-as-projection idea.
- Role-middleware pattern (`requireAuth`/`requireRole`) — roles renamed to the brief's 3-role model (Agent, Brokerage Administrator, Pit Crew) rather than the old app's 10-role list.
- AML/Payments provider factory+interface pattern, generalized into the `packages/integrations/*` shape used for all four provider categories.
- Offer revision-chain (never overwrite, always insert) pattern.
- Idempotent hand-written SQL migration convention.
- Party/PropertyParty normalized-junction-table shape.
- Ownership-mismatch-as-review-not-block pattern (Section 8 of the brief matches what `OwnershipStageGate`/`validateAMLRequestOwnership` already do in the old app).

## 9. Components explicitly NOT carried across

- The old app's 15-destination navigation and per-module pages (`AmlList`/`AmlOrderDetail`, standalone `DocumentsList`/`DocumentTemplates`, `Brokerage.tsx`, `AccountsDashboard.tsx`, `Billing.tsx`, `PitCrewList`/`PitCrewManager` as nav destinations) — superseded by the Property Workspace + 5-destination nav.
- `agencyAgreements`' JSON-only commission storage.
- The flat, drift-affected `transactions` table.
- The legacy `amlRequests` table.
- Any of the six 50–97KB monolithic page components — rebuilt as composed, smaller pieces from the start.
- `artifacts/mockup-sandbox` (design tooling, not part of any product repo).
- The 10-role `USER_ROLES` list — replaced by the brief's 3-role model; can grow later, deliberately, not by accretion.
- Traditional CRM functionality not directly supporting a property transaction (prospecting, nurture campaigns, standalone contacts-first navigation) — out of scope per the brief's opening instruction.

---

## 10. Development sequence

Following the brief's Section 25 order exactly (it was checked against the domain model above and no reordering is warranted):

**Phase 1 — Foundation** (built): repo, environment separation, `packages/db` schema for every entity in §2, `packages/events`, role/auth middleware skeleton, audit/event wiring, `apps/api` + `apps/web` skeletons, Property + Party CRUD.
**Phase 2 — Start Property** (built): `GooglePlacesProvider` (autocomplete + address-component resolution) behind `PropertyDataProvider`, `PROPERTY_DATA_PROVIDER=google-places` factory wiring with a safe fallback to the mock when no API key is set; manual address fallback (unchanged from Phase 1, verified still works standalone); ownership review-not-block flow — `reviewOwnershipForProperty()` compares each linked Seller's name against the provider's ownership data and flips `ownershipReviewRequired`, resolved via `POST /properties/:id/ownership-review` with an optional note (`ownershipReviewedBy`/`ownershipReviewedAt`/`ownershipReviewNotes` columns added); multi-seller capture — fixed a Phase 1 bug where the workspace endpoint only ever returned one linked party regardless of how many were linked, added `DELETE /parties/link/:linkId` to remove a mis-added link, and an inline add/remove party UI on the Property Workspace; property overview — the workspace response and UI now surface suburb/state/postcode, manual-address flag, AML/listing status summaries, and the ownership block.
**Phase 3 — Ready to List workflow**: seller/ownership validation, AML initiation, required-document determination, document package creation, `WorkflowStep` orchestration.
**Phase 4 — AML integration**: real `AMLProvider` adapter, webhook processing, exceptions, service charges.
**Phase 5 — Documents + e-sign**: state rule engine, template population, `ESignProvider` adapter, webhook status, completed-document storage.
**Phase 6 — Payments**: stored payment method, `ServiceOrder` charging, receipts, idempotency (Section 21 — critical, not optional).
**Phase 7 — Offers & Transactions**: offer capture/acceptance, transaction creation, contract workflow, settlement milestones.
**Phase 8 — Agent command experience**: Home screen, exceptions surfaced, no BI dashboards yet.

This document, plus the prior full capability audit, are the standing reference — update this file as decisions are made, don't let it drift from what's actually built.
