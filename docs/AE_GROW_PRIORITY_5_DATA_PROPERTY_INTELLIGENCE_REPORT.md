# AE GROW Priority 5 — Data & Property Intelligence

**Status at first commit: Phase A audit complete, architecture decided, implementation in progress.**
**This document is updated with a Final Addendum before the pull request is opened.**

Authorised under a separate, explicit Project Owner instruction (the "AE GROW Priority 5 — Data & Property Intelligence" specification), issued after AE GROW Priority 4 (Appraisal Builder & Appraisal Workspace) was independently verified merged to `staging` and closed out.

- **Starting `staging` SHA:** `d0796d2b02623e75ccd14df4e4c6f69088a1cfa0` (the Priority 4 closing-report commit; Priority 4's merge commit `a3f4b70b3fa9a757d7dab1ec1290acdc06f76ca7` confirmed present in its history via `list_commits`).
- **Branch:** `feat/ae-grow-priority-5-data-property-intelligence`, created from the `staging` tip above via the GitHub MCP `create_branch` tool.
- **Working environment note (carried forward from Priority 4, still true):** this session has no working local git credentials and no way to run a genuine local `pnpm install`/`tsc`/`test`/`drizzle-kit generate` against a full checkout of this monorepo. Every repository read and write in this priority goes through the GitHub MCP tool suite (`get_file_contents`, `create_branch`, `push_files`, `create_or_update_file`, `create_pull_request`, `list_commits`, `add_issue_comment`, `pull_request_read`), and genuine verification of typecheck/migration/schema-drift/tests/builds happens exclusively via real GitHub Actions CI once the branch is pushed, monitored job-by-job through the Claude-in-Chrome browser — exactly as was done for Priority 4's CI runs #289/#291. Anywhere this report says "verified," it means verified against real CI output, not a local run.

---

## 1. Phase A — Entry gate

1. Fetched latest `staging` via `list_commits`; confirmed HEAD = `d0796d2b02623e75ccd14df4e4c6f69088a1cfa0`.
2. Confirmed Priority 4 present: merge commit `a3f4b70b3fa9a757d7dab1ec1290acdc06f76ca7` appears in `staging`'s history.
3. Confirmed the Priority 4 closing-report commit `d0796d2b02623e75ccd14df4e4c6f69088a1cfa0` is `staging`'s current HEAD (one commit ahead of the merge, as expected — the closing addendum commit itself).
4. Full `staging` SHA recorded above.
5. No local working tree exists in this session to be "clean" or "dirty" in the traditional sense (see environment note above); the equivalent guarantee here is that every file this priority touches is read fresh from `staging`/the new branch immediately before each edit, and every write is a `create_or_update_file`/`push_files` call carrying the correct blob `sha` (an optimistic-concurrency check GitHub itself enforces), so no edit can silently clobber content this session hasn't seen.
6. Branch `feat/ae-grow-priority-5-data-property-intelligence` created from the `staging` tip (details above).
7–10. Full existing-system audit performed — see Section 2.

---

## 2. Audit findings — what already exists

The audit inspected actual schema, service, route, and test code (not filenames or prior reports) across the ~18 named categories. Findings, grouped:

### 2.1 Property identity and address handling

- `properties` (`packages/db/src/schema/property.ts`) is RUN's canonical property record: `brokerageId`, `agentId`, `formattedAddress`, `placeId`, `suburb`/`state`/`postcode`, `isManualAddress`, plus RUN workflow/listing fields. It already carries `ownershipData` (jsonb) and `ownershipReviewRequired`/`ownershipReviewedBy`/`ownershipReviewedAt`/`ownershipReviewNotes`.
- `packages/integrations/property-data` (`@aee/integration-property-data`) is a real, existing, narrow provider abstraction: `PropertyDataProvider` interface with exactly two methods, `searchAddress(query)` and `lookupOwnership(placeId)`. Two implementations ship: `MockPropertyDataProvider` (default) and `GooglePlacesProvider` (address autocomplete only — Google Places has no title/ownership data, so `lookupOwnership` returns `null` there too). A `createPropertyDataProvider()` factory reads `PROPERTY_DATA_PROVIDER` env and fails closed to mock in production unless `LIVE_EXTERNAL_TRANSACTIONS_APPROVED === "true"` (`mustForceMockExternalProvider()`), mirroring the same pilot lock used across every other external-action-capable package in this repo. A commented-out `case "pricefinder"` line is the only trace of Pricefinder in the codebase — no implementation, no fixture, no endpoint shape exists for it, Domain, or Landchecker anywhere in the repository (confirmed by direct directory traversal; `search_code` returned zero hits for all three, itself unreliable, so this was cross-checked by reading `packages/integrations` and `packages/integrations/property-data/src` directly).
- No geospatial identifiers, external per-provider IDs, match-confidence, provenance, first-seen/last-refreshed, or data-quality-status fields exist anywhere on `properties` or elsewhere.
- No deterministic AU/NZ address-normalisation or property-matching module exists beyond `GooglePlacesProvider`'s autocomplete + component parsing (suburb/state/postcode extraction from a Google Places result) and `ownership.ts`'s narrow per-property fuzzy *name* comparison (see 2.4).

### 2.2 Contacts, ownership roles, and contact-property relationships

- `parties` (`property.ts`) is the single canonical person/organisation record, reused by both RUN and Grow — confirmed no competing identity table exists.
- `growRelationships` (`packages/db/src/schema/grow.ts`, AE GROW Stage A) is Grow's own, already-rich relationship model: `partyId`, nullable `propertyId` (deliberately optional since AE GROW Priority 0.5, for pre-property relationships), `relationshipType` (17-value `GROW_RELATIONSHIP_TYPES`: owner, co_owner, former_owner, occupier, tenant, landlord, buyer, prospective_buyer, seller, prospective_seller, appraisal_contact, vendor, investor, developer, referrer, related_party, unknown_pending_review), free-text `role`, `status` (Active/Historical/PendingReview), `isPrimary`, `confidenceScore` (0..1, null = manual), `validFrom`/`validTo`, `sourceType` (manual/import/inferred/migration), `sourceId`, `sourceEvidence`, `createdBy`, full timestamps. This is a near-complete implementation of the specification's "contact-property relationship" canonical model: effective dates ✅, source/provenance ✅, confidence-where-inferred ✅, status-based historical preservation (soft deletion) ✅, tenant isolation (`brokerageId` + defence-in-depth re-checks throughout `apps/api/src/lib`) ✅. Its role vocabulary already overlaps almost one-to-one with the specification's required role list.
- `growContactRoles` and `growContactRelationships` (`packages/db/src/schema/contacts.ts`, AE GROW Priority 2) add multi-valued contact classification and explicit person-to-person relationships (spouse/partner, family, co-owner, business partner) — directly satisfies the specification's "households/related parties" requirement; no new work needed there.
- `propertyParties` (`property.ts`) is RUN's separate, narrow 5-role legal/transactional join (Seller/Buyer/Solicitor/PowerOfAttorney/Other) — explicitly *not* Grow's relationship model, left untouched by this priority exactly as prior priorities have done.

### 2.3 Opportunities / recommendations / selling signals

- `growOpportunities` (`grow.ts`) already embodies the "explainable, never just a raw score" philosophy this specification also requires: `opportunityType`, `status`, `stage`, `ownerUserId`, `source`, a required narrative `reason`, `confidenceScore`/`scoreExplanation`/`scoreVersion` (present but deliberately never read as a bare number anywhere in the codebase — confirmed via `growToday.ts`'s own header comment), `recommendedNextAction`, `nextActionDueAt`, conversion targets into a real `Appraisal`/`Transaction`.
- This is **not** the same concept the specification asks for. `growOpportunities` is an *agent-owned pipeline entity* — created either manually or by an agent converting something, carrying an owner, a stage, and a close outcome. The specification's "opportunity signal" is a *system-generated, evidence-backed indicator* that an agent has not yet acted on: dismissable, expiring, re-generatable, and explicitly required to "recommend a human action ... but must NEVER perform it automatically" and never auto-create an opportunity/appraisal/campaign. These are complementary, not duplicate, concepts — see Section 3.2 for the exact composition decided.

### 2.4 Entity matching / data quality

- The only existing matching logic is `apps/api/src/lib/ownership.ts`'s `reviewOwnershipForProperty()`: compares normalised owner names from `properties.ownershipData` against `propertyParties` rows with `role === "Seller"`; on any non-match it flips `properties.ownershipReviewRequired = true` and never throws or blocks. This is RUN-specific (keyed to the Seller-vs-title-owner check at listing time), not a general provider-record-to-canonical-property/contact matcher, and does not store confidence, reasons, or a review/confirm/reject workflow — it only sets one boolean. Its "review, not block" philosophy is directly reused (see Section 3.3), but the mechanism itself does not cover what this priority needs.

### 2.5 Provider observations / valuation / sales history / market data

- No sales-history, market-activity, planning/development, valuation, or equity/mortgage fields exist anywhere in the schema.
- `properties.ownershipData` (jsonb) is the only existing "provider observation" style field, and it is a single mutable column with no history: an ownership refresh silently overwrites it, with no record of what a provider said previously, when, or from where. This directly fails the specification's explicit requirement that "a refresh must never destroy history" and that provider data be "stored separately, traceably" from canonical data — a genuine, material gap, not something to extend in place.

### 2.6 External provider adapters / webhooks / data-ingestion

Two pre-existing, architecturally distinct systems were found and had to be reconciled:

1. **`@aee/integration-property-data`** (2.1 above) — a small, purpose-built, multi-method *read* interface (`searchAddress`, `lookupOwnership`) used synchronously inline by RUN's Start Property flow.
2. **The Integration and Data Exchange Foundation** (`apps/api/src/lib/integrations/*`, `packages/db/src/schema/integrations.ts`, AE Step 5) — a mature, general-purpose *outbound connection* framework: a `DRAFT → PENDING_APPROVAL → APPROVED → CONFIGURING → VALIDATING → ACTIVE → SUSPENDED/REVOKED/EXPIRED` lifecycle with human-approval gates, a code-defined `PROVIDER_CATALOGUE`, a single-capability `IntegrationAdapter.send(capability, payload, ctx)` contract, an idempotent outbox, inbound webhook gateway, dead-letter queue, credential storage, and a fail-closed `resolveActiveConnection()` chokepoint that only ever allows `environmentClassification === "MOCK"` connections to dispatch in this build. It currently ships three mock adapters (portal listing publish, SMS send, payment-status sync) — all outbound, single-capability, human-approved-connection shaped.

The Integration Foundation's shape (one capability verb, one `send()` call, a human-approved standing *connection*) fits an outbound side-effect (publish a listing, send an SMS) far better than it fits a read-heavy, multi-method enrichment provider (address search *and* ownership lookup *and* sales history *and* market activity *and* planning *and* valuation, called synchronously, no side effect on the outside world, nothing to "approve" a standing connection for). Forcing property-data lookups through the approval-lifecycle/connection/outbox machinery would be architecturally dishonest — it would either require inventing a fake "connection" for something that isn't a standing relationship, or bending the single-capability `send()` contract into a bag of unrelated read methods it was never designed for. This priority therefore **extends `@aee/integration-property-data`'s existing multi-method interface shape** (Section 3.1) rather than registering property data as a new Integration Foundation category — a deliberate architectural decision, not an oversight, recorded here so a future priority does not "fix" it by merging the two.

### 2.7 Entitlements

- `apps/api/src/lib/entitlements/{resolver.ts,types.ts}` is a generic, DB-backed, fail-closed resolver: `resolveEntitlements`/`hasEntitlement`/`explainEntitlementDecision`/`requireEntitlement`, keyed by a closed `EntitlementKey` string union declared in `packages/db/src/schema/billing.ts` (`ENTITLEMENT_KEYS`). `run.access` is auto-granted to every new brokerage at first dev-login; `grow.access` and every `grow.*.manage`/`grow.*.read` key is purchase-gated (never auto-granted) — Grow stays opt-in. This is fully reusable as-is; this priority only needs to add its own keys to `ENTITLEMENT_KEYS` (Section 3.5), following the exact `grow.contacts.read` / `grow.contacts.manage` naming precedent already established by AE GROW Priority 2.

### 2.8 Contact 360 / Relationship Timeline / Grow Today

- `apps/api/src/lib/contactIntelligence.ts` (Priority 2) — read-side aggregation over `growContactRoles`/`growRelationships`/`growActivities`/`growOpportunities`/`growCommitments`, defensively re-scoped to `brokerageId` on every query.
- `apps/api/src/lib/relationshipTimeline.ts` (Priority 2/3) — `getRelationshipTimeline()` + exported `GROW_TIMELINE_EVENT_TYPES` array + `sourceType` union (`party`/`relationship`/`activity`/`opportunity`/`commitment`/`communication`/`appraisal`). Per-table-query + in-memory-merge by design (never a SQL join, to avoid row multiplication); every prior priority (2, 3, 4) added its own event types by extending this same array and adding a new `sourceType` — the established, and only, extension pattern for new timeline events, and the one this priority follows for its own new event types (Section 3.6).
- `apps/api/src/lib/growToday.ts` (Priority 1, extended by Priority 4) — `getGrowTodaySummary()`'s lettered Rule A–E structure (open opportunities, cold-contact follow-up, appraisal follow-up). Priority 4 added Rule E for appraisal follow-ups by adding a new lettered rule, not a parallel ranking engine — the established extension pattern this priority also follows (Section 3.7), with new tests as the specification requires, and with the existing deterministic sort order (priority → `dueAt` → oldest-last-contact) left untouched.
- No dedicated "Contact 360" or "Property view" component file exists under `apps/web/src/pages` or `apps/web/src/components` by that name; Grow's contact-facing UI lives inside `apps/web/src/pages/Grow.tsx` (60,247 bytes) and RUN's property-facing UI inside `apps/web/src/pages/PropertyWorkspace.tsx` (129,182 bytes). Both were read in full before any UI code was written (Section 5).

### 2.9 Privacy, consent, audit logging

- `apps/api/src/lib/audit.ts`'s `logAudit()` (a thin, never-throwing insert into `auditLogs`, already used by `propertyNotes.ts`, `integrations/model.ts`, and elsewhere) is the established, reusable audit-logging mechanism — this priority reuses it rather than inventing a second one.
- `packages/db/src/schema/privacy.ts` / `apps/api/src/routes/privacy.ts` implement existing consent/privacy-request machinery (Critical Blocker Remediation, Phase 8). This priority's own signals/observations tables do not attempt to re-litigate that framework; **whether the existing consent model already covers property-enrichment/inferred-signal data specifically, or needs an explicit policy extension, is recorded as an open legal/policy item in Section 6 — this priority does not invent that approval.**

### 2.10 Migrations / CI

- Migrations are drizzle-kit-generated (`packages/db/migrations/0000..0016_*.sql` + matching `meta/NNNN_snapshot.json` + `meta/_journal.json`), and CI's own "Schema drift check" step (`.github/workflows/ci.yml`) *re-runs* `drizzle-kit generate` against the PR's own schema and does `git diff --exit-code` against what's committed — i.e. CI itself is the authoritative check for whether a hand-authored migration/snapshot pair is byte-correct, not merely a passive validator. Given this session cannot run `drizzle-kit generate` locally (Phase A entry-gate note above), the migration and snapshot committed by this priority were authored by hand, matching the exact SQL/JSON conventions observed in migrations `0013`–`0016`, and are treated as provisional until CI's schema-drift step confirms them — any discrepancy CI reports is corrected in a follow-up commit on this same branch, exactly as Priority 4 corrected a CI-only failure earlier in this project. This is called out explicitly rather than silently claimed as "verified."

---

## 3. Duplication Stop Condition — explicit determination

Per the governing instruction: *"If a substantial Data & Property Intelligence implementation already exists, do not build a competing system... Only stop... if proceeding would create conflicting sources of truth, incompatible schemas, or a material architectural choice. Minor overlap that can be safely reused does not require stopping."*

**Determination: proceed — this is reusable overlap, not a stop condition.** None of the existing components (`growRelationships`, `growContactRoles`/`growContactRelationships`, `growOpportunities`, `@aee/integration-property-data`, `properties.ownershipData`, `ownership.ts`'s review pattern, the Integration Foundation) implement the specification's core, missing pieces: (a) a provider-neutral, multi-capability enrichment interface reaching sales history/market/planning/valuation, (b) a history-preserving, separately-stored provider-observation record, (c) deterministic, confidence-scored, reviewable entity matching between provider records and canonical properties/parties, (d) a canonical, evidence-backed, dismissable "opportunity signal" model distinct from (and only ever manually promotable into) `growOpportunities`, and (e) a Property Intelligence surface in Contact 360 / the property view. These are genuine gaps. Building them **extends** the existing canonical tables and established patterns rather than replacing or forking any of them — no new parallel contact table, no new parallel property table, no second timeline, no second entitlement resolver, no second audit log, no second opportunity/pipeline concept.

### 3.1 Provider architecture — decision

Extend `@aee/integration-property-data`'s existing `PropertyDataProvider` interface (kept backward compatible: existing `searchAddress`/`lookupOwnership` callers and the `MockPropertyDataProvider`/`GooglePlacesProvider` classes are unchanged) with new, optional, capability-scoped methods matching the specification's list (sales history, market activity, planning/development, valuation/equity indicator, mortgage/refinancing indicator). Each is independently optional on the interface (a provider need only implement what it actually supports, per the specification's "appropriate subsets" requirement) and ships with a clearly-labelled mock/fixture implementation only. `mustForceMockExternalProvider()`'s existing production fail-closed gate is reused unchanged. No Pricefinder/Domain/Landchecker endpoint, schema, or credential is invented; no live network call is added; nothing beyond `mock` is reachable in production without `LIVE_EXTERNAL_TRANSACTIONS_APPROVED=true`, which remains unset everywhere in this build.

### 3.2 Opportunity signals — decision

A new, canonical `grow_opportunity_signals` table (Section 4) is the system-generated, evidence-backed indicator model the specification requires. It is explicitly upstream of, and separate from, `growOpportunities`: a signal is generated by the deterministic rule engine (Section 3.4), reviewed by an agent (accepted/dismissed), and — only via an explicit agent action — may be *promoted* into a real `growOpportunities` row (`promotedOpportunityId`). Nothing in this priority ever creates a `growOpportunities`, `appraisals`, campaign, or transaction row automatically. This composition satisfies both the "explainable, never opaque" house style already established for `growOpportunities` and the specification's distinct requirement that signals be indicators, not actions.

### 3.3 Entity matching — decision

A new `property_external_identifiers` table (Section 4) records provider-to-canonical-property links with `matchConfidence`, `matchReasons`, and a `PendingReview`/`Confirmed`/`Rejected` status — generalising `ownership.ts`'s existing "review, not block" philosophy (never silently merges, never hard-blocks, always leaves an explicit human decision point) into a reusable matching/review primitive, without touching `ownership.ts` or RUN's own Seller-vs-title check, which is left exactly as it is.

### 3.4 Signal generation — decision

A new, deterministic, rule-based module (`apps/api/src/lib/propertyIntelligence/signals.ts`) computes signals only from data already legitimately available in this system (relationship tenure from `growRelationships.validFrom`, stale-appraisal detection from `appraisals`, past-interest from `growActivities`, ownership-change detection from provider observations vs. canonical `growRelationships`, and mocked/fixture provider observations for market/planning/valuation categories) — never a raw AI/ML score, always a confidence *band* (`Emerging`/`WorthReviewing`/`StrongIndicator`), always carrying `evidence` and a human-readable `explanation`. A `dedupeKey` (unique-indexed) keyed to the underlying fact makes recalculation idempotent and prevents duplicate active signals for the same event; dismissing a signal does not clear its `dedupeKey`, so it cannot silently regenerate unless the rule computing it produces a materially different `dedupeKey` (i.e. new evidence).

### 3.5 Entitlements — decision

Two new keys are added to `ENTITLEMENT_KEYS` (`packages/db/src/schema/billing.ts`), following the exact existing `grow.contacts.read`/`grow.contacts.manage` precedent: `grow.propertyIntelligence.read` (view signals / property intelligence summaries) and `grow.propertyIntelligence.manage` (review/dismiss a signal, confirm/reject a match, promote a signal to an opportunity). Both additionally require `grow.access`, matching every existing Grow route. Neither is auto-granted to any brokerage; both are enforced server-side via the existing `requireEntitlement` middleware, never only hidden in the frontend. Run/Scale access inheritance (`run.access`) is untouched — this priority adds no RUN-tier behaviour at all.

### 3.6 Relationship Timeline — decision

`GROW_TIMELINE_EVENT_TYPES` gains new members (`PROPERTY_LINKED`, `PROPERTY_RELATIONSHIP_CONFIRMED`, `PROVIDER_DATA_REFRESHED`, `SIGNAL_CREATED`, `SIGNAL_REVIEWED`, `SIGNAL_DISMISSED`, `APPRAISAL_OPPORTUNITY_ACCEPTED`) and a new `sourceType: "property_intelligence"`, read via the same per-table-query + in-memory-merge pattern as every existing source. Per the specification's own caution against flooding the timeline with low-value technical events, routine provider refresh *attempts* are not logged as timeline events — only a refresh that actually changes an observation, and only material signal lifecycle transitions (created/reviewed/dismissed), are recorded.

### 3.7 Grow Today — decision

A new Rule F is added to `getGrowTodaySummary()` (`growToday.ts`) surfacing only *reviewed and accepted* signals with a due follow-up — never a raw, unreviewed signal — preserving the existing deterministic sort contract untouched and adding explicit new tests asserting Rule A–E behaviour is byte-for-byte unchanged, per the specification's explicit requirement not to alter Priority 1's ranking behaviour without tests proving it.

---

## 4. Schema and migration summary

*(Completed in the Final Addendum below, once implementation and CI verification are complete — recorded here as the plan being executed.)*

New tables (`packages/db/src/schema/propertyIntelligence.ts`, exported from `schema/index.ts`): `property_external_identifiers`, `property_provider_observations`, `grow_opportunity_signals`. New nullable columns on `properties`: `latitude`, `longitude`, `data_quality_status`, `last_enriched_at`. New `ENTITLEMENT_KEYS` members on `billing.ts`. All additive, forward-only, nullable/defaulted where mixed with existing rows, tenant-scoped (`brokerage_id` on every new table), and indexed on `(brokerage_id, property_id)`/`(brokerage_id, party_id)`/`(brokerage_id, status)` access patterns. No existing table is dropped, renamed, or narrowed.

---

## 5. Known limitations and deferred items (interim — finalised in the Final Addendum)

- Live Pricefinder/Domain/Landchecker/mortgage-equity provider integration is explicitly **not** enabled anywhere in this build — only the interface and mocked fixtures exist, exactly as instructed.
- Whether the existing consent/privacy framework (`privacy.ts`) already adequately covers property-enrichment and inferred-signal data, or needs an explicit policy extension, is a legal/policy question this priority does not resolve — flagged for Project Owner / legal review, not assumed.
- The migration/snapshot pair in this branch was authored by hand against drizzle-kit's observed conventions (Section 2.10) and is verified against real CI's schema-drift check rather than a local `drizzle-kit generate` run; any correction CI surfaces is applied in a follow-up commit on this same branch and documented in the Final Addendum.
- UI scope for Contact 360 / the property view is recorded in the Final Addendum once written, including which parts of `Grow.tsx`/`PropertyWorkspace.tsx` were read and safely, additively extended.
