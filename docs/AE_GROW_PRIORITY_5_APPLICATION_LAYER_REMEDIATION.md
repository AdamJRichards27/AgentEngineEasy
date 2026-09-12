# AE GROW Priority 5 Remediation — Property Intelligence Application Layer

**Status: REMEDIATION COMPLETE, CI-VERIFIED, PR OPEN AND AWAITING PROJECT OWNER MERGE REVIEW — NOT MERGED.**

This report is the corrected, primary record of what Priority 5 ("Data & Property Intelligence") actually delivers. `docs/AE_GROW_PRIORITY_5_DATA_PROPERTY_INTELLIGENCE_REPORT.md` — the original report — carries a correction notice at its top pointing here; it is left otherwise unedited as the historical record of what was originally (and inaccurately) claimed. Read that notice for the exact discrepancy between what it claimed and what its own merge commit actually contained.

---

## 1. Discovery finding — why this remediation exists

While planning AE GROW Priority 6, a review of what Priority 5 had actually shipped found that PR #33's merge commit (`ec410d0df7736f45225f9cfa9f329c38905db46b`) touched exactly **9 files**, every one of them schema, migration, entitlement-catalogue, or documentation. Confirmed directly via `get_commit` on the merge commit: additions 18,176, deletions 2, zero files under `apps/api/src/routes`, `apps/api/src/lib/propertyIntelligence`, or `apps/web` of any kind.

No API route, no service or rule-engine module, no UI component, and no test file for Property Intelligence existed anywhere in the merged codebase. The "821 tests, 820 pass" figures the original report quoted in its Sections 6.4/7.2 were real CI output — but from the pre-existing, unrelated test suite that already existed before that PR. The specific log lines the original report quoted as if they were Priority 5's own evidence (a job/rollback/export tenant-isolation assertion, and a `communications.sms` entitlement assertion) came from the Communications Hub / automation-ops test suites, not from any Property Intelligence test.

**Why CI did not catch this:** CI's typecheck/migration/schema-drift/test/build steps only check that committed code is internally consistent and that existing tests still pass. They have no way to detect that a described capability was never actually implemented when nothing in the diff references the new schema and no new test was added to exercise it. A schema-only PR that adds unused tables and unused entitlement keys passes every one of those checks trivially, precisely because nothing yet depends on them.

**What was genuinely true, and remains true:** the schema/migration/entitlement-key work itself was real — `packages/db/src/schema/propertyIntelligence.ts`, the two new nullable `properties` columns, the two new `grow.propertyIntelligence.*` entitlement keys, and migration `0017` all exist in `staging` exactly as the original report described, and CI runs #294/#296 genuinely passed. Priority 5's foundation was accurate; only its application-layer claim was not.

**Governing decision:** this gap was formally reopened as a separately tracked remediation, distinct from and blocking AE GROW Priority 6 (Stages B–F of that roadmap are unauthorised and untouched by this work). This document is that remediation's record.

---

## 2. Branch, PR, and commit history

- **Branch:** `fix/ae-grow-priority-5-application-layer`, created from `staging` tip `8ccbb6955a3db4a22ee431d5b14ac7ab8ab43a11` (the same commit independently confirmed via CI run #298, `run_id` `34665530110`, `conclusion: success`).
- **Pull request:** [#34](https://github.com/AdamJRichards27/AgentEngineEasy/pull/34), `fix/ae-grow-priority-5-application-layer` → `staging`. **Open, not merged**, title marked `(DO NOT MERGE)` pending Project Owner review.
- **9 commits**, in the order pushed:

| # | Commit | Timestamp (UTC) | Summary |
|---|---|---|---|
| 1 | `f25e5cfdd09cd69890f7dd249a728d1aa0beb9bb` | 04:06:44 | Property Intelligence service + deterministic signal engine |
| 2 | `aafe194a3126763db2f15d521fc63e4cd79c992b` | 04:07:49 | Mount the Property Intelligence API router |
| 3 | `066ad885893c533f839f1691958e4c74af9e2a81` | 04:17:07 | Shared `PropertyIntelligencePanel` component |
| 4 | `57fb4d480892e6762da6c2bdbe7017ea09b38691` | 04:20:02 | Mount panel in Contact 360 (`Grow.tsx`) |
| 5 | `7e01a4a3b49d177175f8c07f808a4d081223b0db` | 04:25:52 | Mount panel in Property Workspace |
| 6 | `e2a621560d812c81df3ac29de591d962253ff6cc` | 04:35:03 | Grow Today Rule F |
| 7 | `c73f6c538c0db2f35c961eb29395b05a3dada574` | 04:38:42 | Relationship Timeline + Property Timeline integration |
| 8 | `0c892356e535ecc3a1ef7500039a97d5fe78b059` | 04:56:11 | `testSupport.ts` cleanup fix (Priority 5 tables were never deleted between tests) |
| 9 | `aa3a28357daf960887c8cd5343646a8bc615722a` | 05:00:25 | Property Intelligence HTTP-integration tests + Grow Today Rule F regression coverage |

- **PR head at the time of this report:** `aa3a28357daf960887c8cd5343646a8bc615722a`.
- **Every file in every commit was byte-fidelity verified after push**: this session computed a local SHA-1 git-blob hash of the exact intended content and compared it against GitHub's own reported blob SHA for the pushed file, for every push in the list above — no silent transcription drift.

This documentation commit (and the correction notice on the original report) will follow as a 10th commit, described in Section 10 below.

---

## 3. Changed files — cross-checked against the actual PR diff

16 files changed, **+3,012 / −9** lines (confirmed via `pull_request_read get_files` against PR #34 directly — not asserted from memory):

| File | Status | +/− | What it is |
|---|---|---|---|
| `apps/api/src/lib/propertyIntelligence/observations.ts` | added | +119 | `recordObservation()` / `listCurrentObservations()` / `listObservationHistory()` — append-only, history-preserving provider observations |
| `apps/api/src/lib/propertyIntelligence/matches.ts` | added | +177 | `proposeMatch()` / `listMatchesForProperty()` / `confirmMatch()` / `rejectMatch()` — external-property match review |
| `apps/api/src/lib/propertyIntelligence/signals.ts` | added | +549 | Deterministic rule engine + `recalculateSignalsForProperty()` / `reviewSignal()` / `dismissSignal()` / `promoteSignal()` |
| `apps/api/src/lib/propertyIntelligence/service.ts` | added | +130 | Tenant-scoped read surface (`getPropertyIntelligenceSummary`, `getContactPropertyIntelligenceSummary`) |
| `apps/api/src/routes/propertyIntelligence.ts` | added | +202 | The API router — 10 routes, `.read`/`.manage` gated |
| `apps/api/src/routes/index.ts` | modified | +9/−0 | Mounts the router at `/grow/property-intelligence` |
| `apps/web/src/components/PropertyIntelligencePanel.tsx` | added | +447 | Shared decision-support panel used by both Contact 360 and Property Workspace |
| `apps/web/src/pages/Grow.tsx` | modified | +12/−0 | Mounts the panel in Contact 360 (`GrowContactDetail`) |
| `apps/web/src/pages/PropertyWorkspace.tsx` | modified | +14/−0 | Mounts the panel in the property view |
| `apps/api/src/lib/growToday.ts` | modified | +185/−6 | Rule F + `hasAnyGrowData` fix |
| `apps/api/src/routes/grow.ts` | modified | +15/−1 | `GET /today` resolves `grow.propertyIntelligence.read` and passes it to Rule F |
| `apps/api/src/lib/relationshipTimeline.ts` | modified | +80/−1 | 3 new signal event types on the per-contact timeline |
| `apps/api/src/lib/timeline.ts` | modified | +22/−0 | 5 new audit-log entry types on the per-property timeline |
| `apps/api/src/routes/__tests__/testSupport.ts` | modified | +22/−0 | Cleanup fix for the 3 new Priority 5 tables |
| `apps/api/src/routes/__tests__/propertyIntelligence.test.ts` | added | +823 | Full HTTP-integration test suite (824 lines including trailing newline) |
| `apps/api/src/routes/__tests__/growToday.test.ts` | modified | +206/−1 | 3 new Rule F regression tests, zero edits to any pre-existing test |

Sum check: 185+177+119+130+549+80+22+206+823+22+15+9+202+447+12+14 = **3,012** additions; 6+1+1+1 = **9** deletions — matches PR #34's own reported totals exactly.

No new or replacement schema was introduced, and no migration is part of this remediation — every module above reads and writes the already-merged Priority 5 tables (`grow_opportunity_signals`, `property_external_identifiers`, `property_provider_observations`) and the already-merged `properties` columns and entitlement keys, unmodified.

---

## 4. Property Intelligence service and deterministic signal engine

`apps/api/src/lib/propertyIntelligence/{observations,matches,signals,service}.ts`. Every exported function takes a trusted server-side `brokerageId` (derived from `req.authedUser` at the route layer, never from a client-supplied value) and re-scopes to it independently inside the service layer — no method trusts a caller-supplied tenant identifier.

Signal types are generated only from data genuinely available in this system today:

- **`long_ownership_tenure`** — from `growRelationships.validFrom`; confidence scales Emerging (≥5y) → WorthReviewing (≥7y) → StrongIndicator (≥10y).
- **`stale_previous_appraisal`** — from the real appraisal follow-up lifecycle (`appraisals.followUpAt`).
- **`recent_nearby_sales_activity`** — observation-driven, from `sales_history` and `market_activity` provider observations (mock-only, via `recordObservation()`).
- Additional observation-driven types map through `OBSERVATION_SIGNAL_MAP` for planning/development and equity/valuation observation categories.

Confidence is restricted to three bands only — Emerging / WorthReviewing / StrongIndicator — never a percentage probability or a "likely to sell" claim. Every signal carries `evidence` (structured) and a human-readable `explanation`. Idempotency is enforced via a unique `dedupeKey` per underlying fact; `HUMAN_DECIDED_STATUSES = new Set(["Dismissed", "Reviewed", "Superseded"])` guarantees `recalculateSignalsForProperty()` never resurrects or silently re-touches a human-decided signal — a genuinely new piece of evidence (a different `dedupeKey`) raises its own new signal alongside an untouched dismissed one, proven directly by test.

---

## 5. Match-review workflow

`property_external_identifiers` rows move `PendingReview` → `Confirmed`/`Rejected` via `confirmMatch()`/`rejectMatch()`. Re-treating an already-decided match (confirming a rejected one, rejecting a confirmed one, or repeating either action) returns `409 Conflict` — proven directly by test, including the double-action case in both directions. `proposeMatch()` refreshes an existing `PendingReview` row on a `(provider, externalId)` collision rather than inserting a duplicate, and never auto-confirms on name similarity alone. No contact or property is ever silently merged by any part of this workflow.

---

## 6. Signal lifecycle and safeguards

Explicit, auditable states: `Active` → `Reviewed` / `Dismissed` / `Superseded` (via promotion). `reviewSignal()`/`dismissSignal()`/`promoteSignal()` each 409 on repeat action against an already-decided signal. `dismissSignal()` requires a non-empty `dismissedReason` (400 without one). `promoteSignal()`:

- re-checks entitlement and brokerage ownership before acting;
- requires the signal to carry a linked `partyId` — a signal with no contact (e.g. purely observation-driven) returns 409 on a promotion attempt;
- creates exactly one real `growOpportunities` row via the canonical table (no parallel table), setting `promotedOpportunityId` on the signal and 409'ing on any repeat promotion attempt;
- never creates an appraisal, campaign, transaction, or communication of any kind.

---

## 7. API routes

`apps/api/src/routes/propertyIntelligence.ts`, mounted at `/api/grow/property-intelligence`:

| Method | Path | Gate |
|---|---|---|
| GET | `/property/:propertyId` | `.read` |
| GET | `/contact/:partyId` | `.read` |
| GET | `/property/:propertyId/matches` | `.read` |
| GET | `/property/:propertyId/signals` | `.read` |
| POST | `/matches/:identifierId/confirm` | `.manage` |
| POST | `/matches/:identifierId/reject` | `.manage` |
| POST | `/signals/:signalId/review` | `.manage` |
| POST | `/signals/:signalId/dismiss` | `.manage` |
| POST | `/signals/:signalId/promote` | `.manage` |
| POST | `/property/:propertyId/recalculate` | `.manage` |

`.read`/`.manage` refer to `grow.propertyIntelligence.read`/`.manage`, enforced via `requireEntitlement()`, independently of and in addition to `grow.access` (proven by test: a brokerage holding `grow.access` alone gets 403 on every route above until the specific key is granted). Every mutating route calls `logAudit()`. No route makes a live external-provider request — `recalculate` only re-runs the deterministic rule engine against data already in Postgres.

---

## 8. Contact 360 and Property Workspace integration

A single shared component, `apps/web/src/components/PropertyIntelligencePanel.tsx` (447 lines), is mounted in both existing screens — no new screen, tab, or route was created in either case, per the remediation objective's explicit instruction:

- **Contact 360** (`Grow.tsx`, `GrowContactDetail`) — `anchor="contact"`, inserted between the existing Properties section and the Relationship Timeline section.
- **Property Workspace** (`PropertyWorkspace.tsx`) — `anchor="property"`, inserted immediately under the page header, before Ownership review.

The panel renders explicit Loading / Empty / Populated / Permission-denied / Recoverable-error states, gates itself client-side on `grow.propertyIntelligence.read`/`.manage` via `useEntitlements()` (rendering nothing at all when absent — the server enforces the same gate independently and authoritatively), and is deliberately concise: confidence renders only as the three allowed band labels, a pending match is always labelled "Pending match review" rather than presented as settled fact, and no dollar figure, percentage, or "likely to sell" claim appears anywhere in it.

---

## 9. Grow Today Rule F

`apps/api/src/lib/growToday.ts` gains Rule F behind a new `options.includePropertyIntelligenceSignals` flag (default `false`), so Rules A–E's existing signature and behaviour are completely unaffected when the flag is omitted — the flag is only set `true` by `routes/grow.ts`'s `GET /today` when the caller actually holds `grow.propertyIntelligence.read` (resolved server-side via `resolveEntitlements()`, not trusted from the client). A qualifying signal (linked to a contact, at or above `WorthReviewing`) surfaces as its own `DoToday` card, whose `reason` is always the signal's own pre-written `explanation` (never an invented probability), and which suppresses the generic Rule D "cold relationship" card for the same contact — the same suppression pattern Rule E already established for appraisal follow-ups. `hasAnyGrowData` was corrected so a brokerage whose only actionable item is a Rule F signal is no longer incorrectly shown the onboarding empty state.

Every pre-existing test in `growToday.test.ts` was left untouched — those tests are themselves the regression evidence that Rules A–E behave exactly as they did before this remediation. Three new tests were added on top, explicitly proving: Rule F is invisible without the entitlement; a StrongIndicator signal surfaces and suppresses Rule D for that contact once entitled; an Emerging-band signal never surfaces regardless of entitlement, and the DoNow → DoToday → KeepWarm ordering contract holds with Rule F cards mixed in; and `hasAnyGrowData` correctly reports `true` for a Rule-F-only brokerage.

---

## 10. Relationship Timeline and Property Timeline integration

Two existing timeline systems, both extended — no new timeline table or system was created:

- **Relationship Timeline** (`relationshipTimeline.ts`, per-contact) — three new event types, `PROPERTY_INTELLIGENCE_SIGNAL_REVIEWED`/`DISMISSED`/`PROMOTED`, sourced directly from `growOpportunitySignals` rows filtered by `partyId` and `brokerageId`. Only the meaningful, human-decided terminal outcome of a signal is ever an event — a signal merely becoming or staying `Active` produces zero events, matching this file's existing "no technical refresh noise" convention. A signal with no linked contact never appears here (it has no `partyId` to key off).
- **Property Timeline** (`timeline.ts`, per-property) — five new `audit_log`-sourced entry types: `property_intelligence_match_confirmed`/`_rejected` and `property_intelligence_signal_reviewed`/`_dismissed`/`_promoted`, populated by the exact `logAudit()` calls already made in `matches.ts`/`signals.ts`. Matches only ever appear here (they carry no `partyId`, so they never reach the Relationship Timeline).

This was directly proven by test, not assumed: reviewing, dismissing, and promoting a signal each produce exactly one event on the correct surface(s); confirming and rejecting a match each produce exactly one event on the Property Timeline only; a merely-Active signal produces zero events on either surface; and tenant isolation holds on both `GET /grow/contacts/:partyId` and `GET /properties/:id/timeline` against a second brokerage holding every relevant entitlement (a 404 there can only mean tenant isolation, never an entitlement decision).

---

## 11. Genuine tenant-isolation and entitlement test evidence

Every mutating and reading operation added by this remediation is proven tenant-isolated against **a second brokerage holding the identical entitlement set** — never a brokerage that merely lacks entitlements, so a 404 can only mean tenant isolation, never an entitlement decision. This pattern is applied to: the property intelligence summary/matches/signals reads, `recalculate`, `confirm`/`reject`, `review`/`dismiss`/`promote`, the Contact 360 property-intelligence summary, and — new in this remediation's final test commit — the Relationship Timeline (`GET /grow/contacts/:partyId`) and Property Timeline (`GET /properties/:id/timeline`) routes.

Entitlement gating is proven independently for `grow.propertyIntelligence.read` and `.manage` (each can be granted/revoked independently of the other and of `grow.access`), and `grow.contacts.read` was additionally granted to the test fixture brokerages specifically because the Relationship Timeline integration test depends on it — documented inline in the test file so a future reader does not mistake it for scope creep.

---

## 12. Test files and what they cover

- **`apps/api/src/routes/__tests__/propertyIntelligence.test.ts`** (new, 824 lines) — unauthenticated rejection on every route; entitlement gating independent of `grow.access`; a fresh property's empty summary and safe-no-op recalculation; long-ownership-tenure signal generation with confidence-band scaling and idempotent recalculation; stale-previous-appraisal signal via the real appraisal lifecycle; two observation-driven signal fixtures; match review workflow (propose/list/confirm/reject, 409 on re-treatment in both directions); signal lifecycle (review, dismiss-requires-non-empty-reason, promote-creates-a-real-opportunity-and-requires-a-linked-contact, each with its own duplicate-action 409); a genuinely new piece of evidence raising a distinct new signal alongside an already-dismissed one; tenant isolation across every mutation and read; the Contact 360 property-intelligence summary; and the Relationship Timeline / Property Timeline integration test described in Section 10.
- **`apps/api/src/routes/__tests__/growToday.test.ts`** (206 additions, 1 deletion — every pre-existing test byte-for-byte unchanged) — the three Rule F tests described in Section 9.
- **`apps/api/src/routes/__tests__/testSupport.ts`** (22 additions) — the cleanup-ordering fix described in Section 2, without which repeated test runs would leak rows across brokerages and risk FK violations.

No unrelated Communications Hub, automation-ops, or other pre-existing suite is cited anywhere in this remediation as evidence for Property Intelligence's own behaviour — the exact failure mode identified in the original report's correction notice (Section 1 above) is deliberately not repeated here.

---

## 13. CI verification — PR #34, run #299

- **Workflow run:** [`#299`](https://github.com/AdamJRichards27/AgentEngineEasy/actions/runs/34674694978) (`ci.yml`), run ID `34674694978`, triggered by `pull_request` on PR #34, head commit `aa3a28357daf960887c8cd5343646a8bc615722a`.
- **Conclusion: Success. Total duration: 17m 28s** (job itself: 17m 25s).
- **Every step individually inspected** (not inferred from the overall green status):

| Step | Result | Duration |
|---|---|---|
| Set up job | ✅ | 1s |
| Initialize containers | ✅ | 17s |
| Checkout | ✅ | 1s |
| Install pnpm | ✅ | 2s |
| Install Node.js | ✅ | 2s |
| Verify vendored dependencies | ✅ | 1s |
| Install dependencies (frozen lockfile) | ✅ | 2s |
| Workspace typecheck | ✅ | 39s |
| Deterministic clean-database migration check | ✅ | 2s |
| Schema drift check | ✅ | 2s |
| **API automated test suite** | ✅ | **16m 5s** |
| API production build | ✅ | 1s |
| Web production build | ✅ | 3s |
| Synthetic production startup and storage readiness | ✅ | 5s |
| Post-steps / Stop containers / Complete job | ✅ | ≤1s each |

- **Schema drift check passed** — confirms zero drift between the schema source and the already-merged, unmodified `0017` migration/snapshot; this remediation introduces no schema change of its own, so a passing drift check here is expected and was not skipped over.
- **API automated test suite (16m 5s):** this session directly observed real, streaming test output at multiple points during the run — dozens of genuine, pre-existing test names (appraisal lifecycle, e-sign HMAC verification, operational alerts, session-token verification, offer/transaction/settlement flows, relationship-timeline tenant isolation, and more) each printing with a `✔` pass marker, with **zero** `✗`/failure markers observed in any reviewed excerpt. Because `pnpm --filter @aee/api run test` (the underlying `node:test` runner) exits non-zero on any failing test — which would fail this step, and with it the whole job, red — the step's own green "succeeded in 16m 5s" status is direct, authoritative confirmation that every test in the full API suite passed, including every new test added by this remediation (Sections 11–12). **Known limitation:** a single machine-readable pass/fail summary line (the runner's own `# tests / # pass / # fail` block) could not be isolated as literal text through the GitHub Actions log viewer's in-browser tooling this session had available, for this specific run — this is a viewer/tooling limitation, recorded plainly rather than papered over, exactly as the original report's own Section 6.4 recorded the same limitation for an earlier run. It does not weaken the conclusion above: the step's exit-code-derived success status is the authoritative CI signal, and it is green.
- **API production build / Web production build:** both passed in 1s/3s respectively — both builds succeed against the new application code with no type or bundling errors.
- **Synthetic production startup and storage readiness:** passed in 5s.
- **Annotations:** 1 warning — a pre-existing, GitHub-infrastructure-level notice that `actions/checkout@v4`/`actions/setup-node@v4`/`pnpm/action-setup@v4` target Node.js 20 but are forced onto the Node.js 24 runner. Unrelated to this PR's code; not something this branch's changes caused or can fix.

**This session's own attempt to query CI status via the GitHub API directly** (`pull_request_read` with `get_check_runs`/`get_status`) was refused with `403 Resource not accessible by integration` — the GitHub App token backing this session's MCP tools has no Checks/Statuses read scope. All CI verification in this remediation was therefore performed by inspecting the real GitHub Actions UI through the browser, per this project's standing verification discipline, not by trusting a locally-simulated result or an unread API response.

---

## 14. Provider boundary — unchanged

`PROPERTY_DATA_PROVIDER` continues to default to the mock provider; `mustForceMockExternalProvider()`'s existing fail-closed gate is untouched; `LIVE_EXTERNAL_TRANSACTIONS_APPROVED` remains unset throughout this build. No Pricefinder/Domain/Landchecker credential, endpoint, or live network call was added anywhere in this remediation. `recordObservation()` (used by this remediation's own test fixtures) is the same mock-only write path a future provider-ingestion job would call — no route in this remediation calls it, and no route makes any outbound request.

---

## 15. Documentation corrections made by this remediation

- A correction notice was added to the top of `docs/AE_GROW_PRIORITY_5_DATA_PROPERTY_INTELLIGENCE_REPORT.md`, explaining exactly what was and was not true in that report, and pointing here. Nothing below that notice was edited, deleted, or rewritten — the original text is preserved verbatim as the historical record, per the explicit instruction not to rewrite history without explanation. (Verified locally before push: stripping only the notice and its trailing blank line from the corrected file reproduces the current on-`staging` file byte-for-byte — confirmed by computing the git blob SHA-1 of the reconstructed content and matching it exactly against GitHub's own reported blob SHA, `b527b1e4414a2ea63be664f85f03c2c5c2b87afb`, for the file as it exists on `staging` today.)
- This document is the new, corrected primary tracking report for Priority 5's application layer.

---

## 16. Outstanding condition — carried forward, not resolved by this remediation

**`PROJECT OWNER / LEGAL REVIEW REQUIRED BEFORE LIVE PROPERTY-DATA ENRICHMENT`.** Non-blocking for the mock-only state this remediation adds to (no live provider is enabled, and nothing here changes that), but it remains blocking for any future work that would enable a live external property-data provider or act on inferred signals against real consumer data. Not resolved, and not described as resolved, by this or any prior verification.

---

## 17. Scope boundary

No merge was performed by this session. No deploy was performed. No branch was deleted. No production configuration was modified. No credentials were added. No new or replacement schema was created. AE GROW Priority 6 (Stages B–F) has **not** been started — this remediation is scoped exclusively to the Priority 5 application layer, per the explicit instruction authorising only this work.

---

## 18. Known limitations

- The exact numeric `# tests / # pass / # fail` summary line for CI run #299's "API automated test suite" step could not be isolated as literal text through this session's available browser tooling (Section 13) — the step's own green/success exit status is the authoritative signal, and multiple direct log excerpts reviewed during the run showed only passing tests, but a single copy-pasted summary line is not quoted here because it was not directly observed.
- This document and the correction notice on the original report are committed together as a documentation-only commit (Section 2), which will trigger its own CI run; that run will be inspected before this remediation is described as fully closed out.
