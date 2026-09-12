# AE GROW Priority 6 Stage B — Grow-Scoped Ask AE — Completion Report

Branch: `feat/ae-grow-priority-6-stage-b-grow-ask-ae`
Forked from `staging` at: `f5da7cb18014c8dd4da8536e4abbb8f3ee3ce2d6`
Final SHA (this report's own baseline): `a7a02b8a3ab1e84130806b8c0da36a9f47cdbc4e`
(backend implementation baseline: `711f9445ba92e1499a8aeed8cfbcbfb753951de0`;
`a7a02b8a3ab1e84130806b8c0da36a9f47cdbc4e` adds the project-owner pre-merge
UX/presentation gate — §8 below — on top of it, with no application/orchestration/
route code changed)
PR: [#35](https://github.com/AdamJRichards27/AgentEngineEasy/pull/35) into `staging` (open, not merged — awaiting project-owner review)

## 1. Scope

Implements Stage B only: a secure, read-only, evidence-grounded Ask AE experience for
Grow, reusing the existing Copilot component (`AskAgentEngine.tsx`) and orchestration
path (`askCopilot()`) rather than building a second AI surface. Stage C (Business
Coach), Stage D (AI-proposed actions), Stage E (Voice input), and Stage F (Call
recording/transcription) are explicitly out of scope and were not started. No live AI
provider was used or is required; all behavior runs against the existing mock provider
(`AI_PROVIDER=mock`).

Note on branch history: two commits at the base of this branch (`5fccb37f99`,
`97c0847bd4`) predate Stage B work and are an unrelated, already-scoped wording fix to
a Priority 5 property-intelligence signal explanation (removing "sale-likelihood"
framing from the long-ownership-tenure signal). Stage B's own work starts at
`2ab966c116` ("extend shared AI types for Grow-scoped Ask AE").

## 2. What was delivered

- **Types** (`apps/api/src/lib/ai/types.ts`): `ResponseKind` gains `"summary"`/
  `"indicator"`; `GrowContext` is defined for real (replacing the Priority-0.5
  placeholder); `AiContextPackage.contextType` gains `"grow"`; `AiStructuredResponse`
  gains four optional Response Contract fields (`supportingRecords`, `dataFreshness`,
  `limitations`, `suggestedNextStep`). All four changes are additive — every existing
  type union is widened, never narrowed or renamed.
- **Context** (`apps/api/src/lib/ai/context/growContext.ts`): `buildGrowContext()`
  reuses `lib/growToday.ts`'s already-tested `getGrowTodaySummary()` rather than
  re-querying Grow's domain tables from scratch, and assembles a brokerage's Grow
  Today items (capped at 20), due follow-ups, appraisal follow-ups, active
  property-intelligence signals, a relationship-type breakdown, an opportunity
  pipeline, recent activity (14-day lookback), and — when a `growFocusItemId` is
  supplied — a single resolved focus item. Every query is scoped to the caller's own
  `brokerageId`; a foreign or unknown `growFocusItemId` resolves to `focusedItem: null`,
  never an error or another tenant's data. Wired into `contextEngine.ts` behind a new
  `contextType === "grow"` branch that runs only for Grow-scoped requests.
- **Tools** (`apps/api/src/lib/ai/tools/registry.ts`): 8 new, read-only,
  riskLevel-0 tools in `GROW_TOOL_REGISTRY` (`get_grow_today_items`,
  `get_contact_relationship_summary`, `get_due_commitments`,
  `get_grow_opportunity_pipeline`, `get_appraisal_followups`,
  `get_property_intelligence_signals`, `get_recent_relationship_activity`,
  `explain_grow_today_item`), each reading one already-bounded field off `ctx.grow`
  rather than querying the database directly, and each failing closed (`ok: false`,
  never a throw or stale data) if `ctx.grow` is unexpectedly null.
  `selectToolsForContext` checks `contextType === "grow"` first, ahead of the
  property-based branches, so a Grow-scoped ask never falls through to the
  property/business tool surface.
- **Prompt** (`apps/api/src/lib/ai/prompts.ts`): a new `copilot.ask.grow.v1` template
  with the five-way Fact/Summary/Indicator/Recommendation/Unknown classification the
  Grow Response Contract requires, plus explicit hard wording constraints (never
  assert a contact is "likely to sell"/"likely to list", never state an inferred
  intention as a confirmed fact, never imply AE knows a contact's private motivations,
  never state a definitive valuation, never present a recommendation as a verified
  fact, never claim unavailable data was checked and found absent).
- **Orchestration** (`apps/api/src/lib/ai/orchestrator.ts`): `askCopilot()` branches
  on `contextType === "grow"` to apply, in order: Grow-specific per-brokerage rate
  limiting (`growRateLimiter.ts`, 20 requests/brokerage/60s, in-memory/per-process),
  the `grow.access`/`run.access`-derived entitlement gate (a STARTER-tier brokerage is
  refused with `AiEntitlementError` before any context/provider work; GROW and PRO
  tiers are allowed; RUN Copilot's own entitlement path is completely unaffected),
  `classifyGrowResponseKind()` (indicator > summary > fact > unknown, based on which
  Grow tool(s) returned usable data), `buildGrowSupportingRecords()` (see the deep-link
  design note below), `buildGrowSuggestedNextStep()`, and the static
  `GROW_LIMITATIONS` caveats. The read-only ceiling (`assertWithinAutoExecuteCeiling(0)`)
  is asserted unconditionally for every request, Grow or not.
- **Route** (`apps/api/src/routes/ai.ts`): `POST /ai/ask`'s Zod schema accepts
  `contextType: "grow"` and an optional, length-capped (`≤64` chars)
  `growFocusItemId`, both threaded straight into `askCopilot()`. A `GrowRateLimitError`
  maps to `429`; the Grow-specific `AiEntitlementError` maps to the existing `403`
  path RUN Copilot's own entitlement failures already use.
- **UI** (`apps/web/src/components/AskAgentEngine.tsx`, `apps/web/src/pages/Grow.tsx`):
  `AskAgentEngine.tsx` is extended, not forked — the same shared component RUN Copilot
  uses now also serves Grow, gated behind `isGrow`/field-presence throughout (Grow copy,
  four "Try asking" example-question chips, distinct 403/429/5xx states, and rendering
  for every new Response Contract field). `Grow.tsx`'s `GrowAskAETab` now passes
  `contextType="grow"` (previously `"business"`, meaning the Grow tab's own "Ask AE"
  was never actually Grow-scoped before this stage).

### Deep-link design note (`buildGrowSupportingRecords`)

`apps/web/src/App.tsx`'s route table is deliberately shallow — the only per-record
detail route that exists today is `/properties/:id`. `buildGrowSupportingRecords`
therefore checks a focused (or Today-list) item's `propertyId` first: when a property
exists, the record is `{recordType: "property", label: <address>, deepLink:
"/properties/:id"}` — a real, navigable link. Only when no property exists does it
fall back to an `opportunity`/`appraisal`/`party` record with `deepLink: null` (never a
fabricated URL that would 404). This is a deliberate design choice, not an oversight,
and is locked in by its own unit test in `growOrchestrator.test.ts` ("a focused,
property-linked item gets a real /properties/:id deep link"). It means a focused
opportunity or appraisal that has a linked property is represented by that property,
not by the contact's name — see §3, bug 2, for the test-side consequence of this.

## 3. Bugs found and fixed during this stage

**Bug 1 (application code) — `classifyGrowResponseKind` summary-tool selection.**
Originally selected its `"summary"` candidate by array position in
`GROW_TOOL_REGISTRY` and checked usable-data on only that one candidate, so a
brokerage with open opportunities but zero active relationships
(`opportunityPipeline` has data, `relationshipBreakdown` does not) picked the
positionally-first, empty relationship-summary result, found no usable data, and fell
through to `"fact"` instead of `"summary"` — never even inspecting the
opportunity-pipeline result. Caught while designing the orchestration test suite's
priority-ordering coverage, before any test asserting the old (wrong) behavior could
be written. Fixed (commit `dbb96ef05e`) by folding the usable-data check into the
`find()` predicate itself, so it selects the first summary-tool result that actually
has data. Locked in by an explicit regression test in `growOrchestrator.test.ts`.

**Bug 2 (test code, not application code) — wrong assertion in `growAskAe.test.ts`'s
"Route Focus" test.** The test asserted `supportingRecords[0].label` would equal the
focused item's contact name ("Fiona RouteFocus"). It does not: per the deep-link
design note in §2, the fixture's opportunity has both a `propertyId` and a `partyId`,
and `buildGrowSupportingRecords` deliberately returns the property record (with a real
`/properties/:id` deep link) whenever one exists — already correctly locked in by
`growOrchestrator.test.ts`'s own unit test. This was surfaced by CI run #308
(`actual: '5 Route Focus Item Ave'`, `expected: 'Fiona RouteFocus'` at
`growAskAe.test.ts:191:12`) once the two test-infrastructure fixes below let the suite
run far enough to reach it cleanly. Fixed (commit `711f9445ba`) by asserting the
actual, intended shape (`recordType: "property"`, `recordId` equal to the fixture's
own `propertyId`, `label` equal to the property's address, `deepLink` equal to
`/properties/:id`), and by strengthening the neighbouring cross-tenant test to also
check brokerage B's response never contains brokerage A's property label, not only its
contact name.

**Three test-infrastructure/fixture bugs (not application code, not Stage B feature
bugs)** were also found and fixed while getting CI to a clean, evidentially meaningful
run — recorded here for completeness per the documentation-integrity requirement, but
distinguished from bugs 1–2 above because none of them reflect a defect in Stage B's
actual Grow-scoped Ask AE behavior:

- `routes/__tests__/testSupport.ts`'s shared `cleanupBrokerages()` never deleted
  `ai_interactions`/`ai_usage` rows before deleting `users`, causing a real Postgres
  foreign-key violation (`ai_interactions_user_id_users_id_fk`) whenever a test calls
  Ask AE and then cleans up its fixture brokerage — every `askCopilot()` call writes an
  `ai_interactions` row on every outcome (success, blocked, or error) via a required,
  non-cascading FK onto `users.id`. This pre-existing gap in a widely-shared helper had
  never been triggered before Stage B because no earlier test combined repeated Ask AE
  calls with an explicit `cleanupBrokerages()` the way `growAskAe.test.ts`'s rate-limit
  and cross-tenant tests do. Fixed in commit `715317ce9f`.
- `growAskAeContext.test.ts` and `growAskAe.test.ts` only granted `grow.access` to
  their fixture brokerages, but `POST`/`PATCH /api/grow/opportunities` (used by several
  fixtures to create an overdue opportunity) requires the separate
  `grow.opportunities.manage` entitlement — `grow.access` alone only gates the GET
  routes. Fixed in commit `e2e182565`.
- `growOrchestrator.test.ts` calls `askCopilot()` directly against the database (not
  through the real HTTP app), so it never used `testSupport.ts`'s shared fixture
  helpers at all — it has its own small, local `cleanupFixture()`, which had the
  identical `ai_interactions`/`ai_usage`-before-`users` ordering bug as the first item
  above, independently. Fixed in commit `fa2259de08`.

## 4. Test evidence

- **Tools**: `apps/api/src/lib/ai/tools/__tests__/registry.test.ts` — all 8 Grow
  tools' shape/riskLevel, `selectToolsForContext` routing (Grow-first, and every
  pre-existing non-Grow contextType unaffected), fail-closed behavior when `ctx.grow`
  is null, exact field-mapping per tool, `runAllTools` coverage, and prompt-injection
  inertness (an injected string in a Grow record field round-trips as inert data).
- **Orchestration**: `apps/api/src/lib/ai/__tests__/growOrchestrator.test.ts` —
  `classifyGrowResponseKind`'s full priority ordering (including the bug-1 regression
  test), `buildGrowSupportingRecords`/`buildGrowSuggestedNextStep`/`GROW_LIMITATIONS`,
  the rate limiter's window/cap/per-brokerage-independence semantics (deterministic,
  via an injected clock — no real sleeping), and database-backed `askCopilot()`
  integration tests: STARTER blocked with `AiEntitlementError` before any provider
  call (RUN Copilot itself unaffected), GROW- and PRO-tier brokerages allowed with the
  full Response Contract back, rate-limit exhaustion refused with
  `GrowRateLimitError`, and an adversarial, instruction-like question string proven
  unable to change `riskLevel` or which tools ran.
- **Context / tenant isolation**: `apps/api/src/routes/__tests__/growAskAeContext.test.ts`
  — an entitled, data-free brokerage gets `hasAnyGrowData: false` and every list
  empty, never an error; two brokerages' contexts never cross-contaminate; a
  `growFocusItemId` resolves only within its owning brokerage (a foreign brokerage's
  real item id, and a nonexistent id, both resolve to `focusedItem: null`); `todayItems`
  is bounded at 20 even with 22 qualifying items.
- **HTTP / route / regression / security**: `apps/api/src/routes/__tests__/growAskAe.test.ts`
  — 401 unauthenticated; 403 for a STARTER brokerage with a "Grow or Pro plan" message
  while its non-Grow Copilot access stays at 200; 400 for an oversized question
  (>2000 chars), an oversized `growFocusItemId` (>64 chars), and an empty question,
  each before touching the database; 200 with the full Response Contract shape for an
  entitled brokerage; the `growFocusItemId` round-trip (asserting the focused item's
  own `recordType`/`recordId`/`label`/`deepLink`); the per-brokerage rate limit
  enforced end-to-end over 21 real HTTP requests (20th succeeds, 21st is 429); and
  cross-tenant isolation (brokerage B's response never contains brokerage A's contact
  name or property label).
- `apps/api/package.json` — added `src/lib/ai/tools/__tests__/*.test.ts` to the test
  glob, without which the new registry tests would have silently never run in CI.

**RUN Copilot / Priority 1–5 regression**: not a separate, narrower run — the full API
automated test suite (§5) runs every existing test file (`ai.test.ts`,
`orchestrator.test.ts`, `contextEngine.test.ts`, `governance.test.ts`,
`entitlements.test.ts`, and the full Priority 1–5 suite: appraisals, e-sign,
operational alerts, relationship timeline, sessions, transaction/offer/settlement/close
lifecycle, F-03 domain events, and more) unchanged and in the same process as the new
Stage B files, in CI run #309. The run's overall status is `succeeded`; no non-Stage-B
test file was modified by any commit on this branch (confirmed by this report's own
diff review of every commit above), so a green suite is direct evidence that none of
this stage's additions regressed existing RUN Copilot or Priority 1–5 behavior.

## 5. CI verification

PR #35 was pushed through five CI runs on this branch as issues were found and fixed,
each inspected job-by-job via the real GitHub Actions run pages:

| Run | Trigger commit | Result | Notes |
|---|---|---|---|
| #305 | initial 18-commit push (PR opened) | Failure | `grow.opportunities.manage` 403s + `testSupport.ts` ai_interactions FK violation |
| #306 | (rapid second push) | Cancelled after 6m39s | Superseded by #307 before completion; not meaningful evidence either way |
| #307 | `715317ce9f` + `e2e182565` (both fixes) | Failure | `growOrchestrator.test.ts`'s own separate `cleanupFixture` ai_interactions FK violation (a different code path, not fixed by the previous two commits) |
| #308 | `fa2259de08` (growOrchestrator cleanupFixture fix) | Failure | Bug 2 (§3): wrong `growAskAe.test.ts` assertion, `actual: '5 Route Focus Item Ave'` vs `expected: 'Fiona RouteFocus'` at `growAskAe.test.ts:191:12` |
| **#309** | **`711f9445ba` (this report's baseline)** | **Success** | **Fully green — see below** |

CI run **#309** (workflow run `34696187609`, job `103559963339`) job-by-job result:

| Step | Result |
|---|---|
| Workspace typecheck | Passed, 37s |
| Deterministic clean-database migration check | Passed, 2s |
| Schema drift check | Passed, 1s |
| API automated test suite (full glob, all Stage B files included) | Passed, 16m 42s |
| API production build | Passed, 1s |
| Web production build | Passed, 2s |
| Synthetic production startup and storage readiness | Passed, 5s |

Overall job status: **succeeded in 18m 1s**. The only annotation on the run is a
single, benign, unrelated warning from the GitHub Actions runner itself (Node.js 20
being deprecated in favor of 24 for `actions/checkout@v4`/`actions/setup-node@v4`/
`pnpm/action-setup@v4` — a platform-level notice, not a repository or Stage B issue).

No exact pass/fail test count is quoted here because the CI log's summary line was not
independently re-extracted this session (the browser-based log-inspection tooling used
throughout this stage was, as in every previous session on this branch, intermittently
unavailable) — this report deliberately states only what was directly, repeatedly
confirmed: every one of the seven job steps above reports "succeeded"/passed, and the
overall run status reported by GitHub Actions itself is `Success`.

## 6. Tenant isolation, entitlement, and read-only evidence

- **Tenant isolation**: `growAskAeContext.test.ts`'s dedicated tenant-isolation test
  (two brokerages, cross-checked both directions) and its `growFocusItemId`
  foreign-brokerage-resolves-to-null test; `growAskAe.test.ts`'s cross-tenant HTTP test
  (now checking both contact-name and property-label leakage, per bug 2's fix). Every
  underlying query in `growContext.ts` is scoped by the authenticated caller's own
  `brokerageId`, never a client-supplied value.
- **Entitlement denial**: `growAskAe.test.ts`'s 403 test (STARTER brokerage, RUN
  Copilot unaffected) and `growOrchestrator.test.ts`'s database-backed STARTER-blocked
  integration test, both asserting `AiEntitlementError`/`403` with a "Grow or Pro plan"
  message, thrown before any provider call.
- **Prompt-injection safeguards**: `registry.test.ts`'s inert-record-field test and
  `growOrchestrator.test.ts`'s adversarial-question integration test, both confirming
  injected/instruction-like text cannot change `riskLevel`, tier, or which tools ran —
  the orchestrator never branches on question content, and nothing in the retrieved
  context is or contains a callable tool or authority claim.
- **Read-only / risk ceiling**: `assertWithinAutoExecuteCeiling(0)` is asserted
  unconditionally inside `askCopilot()` for every request (Grow or not); every test
  above that reaches a 200 response also asserts `riskLevel === 0`.
- **Performance/cost limits**: the Grow rate limiter (20 requests/brokerage/60s,
  tested for cap/reset/per-brokerage independence); `GROW_TODAY_ITEMS_LIMIT`(20),
  `DUE_FOLLOWUPS_LIMIT`(20), `APPRAISAL_FOLLOWUPS_LIMIT`(15),
  `ACTIVE_SIGNALS_LIMIT`(20), `RECENT_ACTIVITY_LIMIT`(20, 14-day lookback), and
  `MAX_GROW_SUPPORTING_RECORDS`(5) all bound context/response size regardless of how
  much Grow data a brokerage holds.

## 7. Known limitations

- No React component-rendering test infrastructure (no jsdom/`@testing-library/react`)
  exists in this codebase; `apps/web`'s own test script only runs plain `.test.ts`
  logic files, and CI does not run any `apps/web` tests at all today. `AskAgentEngine.tsx`'s
  new Grow states were verified by manual code review (every new render path is gated
  behind `isGrow`/field-presence and is a no-op for a non-Grow response) and by the
  HTTP-level route tests, which exercise the exact contract the UI consumes — not by an
  automated component test. Adding that tooling is a cross-cutting build-system change
  outside this stage's scope.
- ~~The new Grow UI classes (`ai-copilot-examples`, `ai-copilot-supporting-records`,
  `ai-copilot-freshness`, `ai-copilot-limitations`) have no stylesheet rules yet~~ —
  **resolved** by the UX/presentation gate, §8 below: every one of these four
  selectors (plus a fifth, `ai-copilot-example-chips`, found only once the gate
  started, and two accessibility/contrast gaps found by an automated pass) now has a
  stylesheet rule, built entirely from existing AE design-system tokens.
- The Grow rate limiter is in-memory and per-process (documented in its own header
  comment) — correct for this build's single-process deployment, but would need a
  shared store (e.g. Redis) before this API runs multiple replicas.
- This report's CI evidence (§5) does not include an independently re-extracted exact
  pass/fail test count for run #309, for the reason stated there.

## 8. UX/presentation gate (project-owner pre-merge review)

The project owner accepted the backend/security/tenant-isolation/CI evidence above and
authorized one additional, narrowly-scoped gate before merge: confirm Grow Ask AE is
"visually complete, understandable and usable — not merely technically wired." No
application/orchestration/route code was touched by this gate; every change is CSS or
the presentation layer of `AskAgentEngine.tsx` only. Starting branch state was first
reconfirmed unmoved (head `6d4f1e05c5ff27d02963b142b653b78e63e3cb32`, `mergeable_state:
clean`, 19 files, `+2483/-52`, 23 commits — exactly the project owner's stated
baseline) before any change was made.

### 8.1 Selectors identified and styled

Five selectors referenced by `AskAgentEngine.tsx` had no matching rule anywhere in
`apps/web/src/styles.css` (confirmed by fetching and reading the stylesheet in full
before writing anything) — four named in §7's original limitation, plus one found only
once this gate started:

| Selector | Component / state | Prior styling | Resolution |
|---|---|---|---|
| `.ai-copilot-examples` | Default state, "Try asking" wrapper | None (bare `<div>`) | Border-top divider + spacing, matching the existing `.ai-copilot-answer` rhythm |
| `.ai-copilot-example-chips` | Default state, chip row (child of the above) | None — found during this gate, not in the original report | `display:flex; flex-wrap:wrap; gap` so chips wrap instead of overflowing narrow viewports |
| `.ai-copilot-supporting-records` | Successful-response state, "Related:" list | None (default `<ul>` bullets/margin) | `ul.plain`-style list reset + row padding + `overflow-wrap` on the link/span text |
| `.ai-copilot-freshness` | Successful-response state, "Data as of…" paragraph | Composed with `.muted` only (no rule of its own) | Small top margin for visual separation from the line above it |
| `.ai-copilot-limitations` | Successful-response state, limitations list | None (default `<ul>` bullets/margin) | Same list-reset pattern as `.ai-copilot-supporting-records` |

Every rule reuses existing tokens/patterns only (the `.card`/`.ai-copilot-answer`
border-top divider rhythm, `ul.plain`/`ul.item-list`'s list-reset, the
`.pc-tabs`/`.stat-tiles` flex-wrap+gap pattern) — no new colours, radii, spacing
values, or breakpoints were introduced. The one genuinely new visual element is a
small loading spinner (§8.3) — this codebase had no spinner anywhere to reuse, and the
required Loading state has no honest way to satisfy "clear preparing-answer
indication" without one.

### 8.2 Voice control requirement

Re-read `apps/web/src/pages/Grow.tsx`'s `GrowAskAETab` (the component that actually
mounts `AskAgentEngine` for Grow) and found the "voice control visibly disabled and
labelled 'Coming soon'" requirement is **already satisfied**, built in Priority 1: a
`.grow-voice-seam` card renders directly below the Ask AE card with a genuinely
`disabled` `<button>` (`aria-label="Voice command (coming soon)"`, visible label
"🎤 Voice command — coming soon"), explicitly commented as an "architectural/visual
seam ONLY — no speech-to-text provider, no microphone stream, no voice-driven action."
`.grow-voice-seam { margin-top: 1rem; }` already separates it from the active text
input above. No change was needed or made here.

### 8.3 Required Ask AE states — reviewed and (where needed) fixed

`AskAgentEngine.tsx`'s own render branches were re-read end to end for all eight
required states. Two gaps beyond plain missing CSS were found and fixed:

- **Loading**: previously had no visible "preparing answer" indication at all, and
  the example chips simply disappeared (their render condition excludes
  `ask.isPending`), which would visibly collapse the card while waiting. Added an
  `isGrow`-gated `.ai-copilot-loading` row (small spinner + "Preparing your answer…")
  that occupies the vacated space, plus the submit button's existing `disabled`+
  `"Asking..."` text (unchanged) already prevented duplicate submits.
- **Dynamic announcements**: the answer/error/loading region had no live-region, so a
  screen reader user got no signal when a question's outcome arrived. Wrapped that
  region in a single `aria-live="polite" aria-atomic="true"` container (non-visual;
  applied unconditionally, not gated to Grow, since RUN Copilot benefits identically
  at zero visual cost).
- **Successful grounded response**: kind labels (Fact/Summary/Indicator/Suggestion/
  Inference/Unknown) already carry a distinct text label — the primary, non-colour
  differentiator required by the accessibility checklist. Added a secondary,
  Grow-only colour reinforcement so a recommendation/inference now reads visibly
  differently from a verified fact/summary (`--color-success` vs `--color-warning-
  text` vs `--color-text-muted` for unknown/indicator) — RUN Copilot's identical,
  already-shipped `.eyebrow` rendering is completely untouched (gated on `isGrow`).
  Supporting records already render as real internal links via wouter's `<Link>` when
  a `deepLink` exists, and as plain text (never a raw numeric ID) when it doesn't.
- **Empty/unknown, permission-denied, rate-limited, provider-unavailable, general
  error**: all already correctly branch on `ask.isError`/`err.status` into distinct,
  non-technical copy (§2 of this report); none leak an entitlement key, provider name,
  or stack trace; none render inside `.error-text` for the "unknown" kind (so it never
  visually reads as an error). No code change was needed for these five; only the
  live-region wrapper above applies to all of them equally.
- Added a missing accessible `aria-label` to the previously label-less question
  `<input>` ("Ask AE a question" / "Ask Agent Engine a question").

### 8.4 Visual verification evidence

Browser/preview tooling in this sandbox cannot run the real app (no local clone or
direct git/HTTP access to this repository is available; only the sanctioned MCP
tools). A live, database-backed render of the actual page was therefore not possible,
and this report does not claim one. What was performed instead, and is disclosed
precisely rather than overstated:

A static-markup harness was built by hand-mirroring `AskAgentEngine.tsx`'s exact JSX
output for each of the 8 required states (verbatim class names and DOM structure) into
one HTML file, loaded against the real, unmodified `apps/web/src/styles.css` fetched
from this branch (not a re-created approximation). This is real, rendered-pixel
evidence of the actual CSS rules against the actual markup shape — not a live React
render, and not a substitute for one; it cannot catch a bug in the *data-to-markup*
logic itself (e.g. a wrong field name), only in how the resulting markup is styled and
laid out, which is what this gate is scoped to.

Using Playwright (pre-installed in this sandbox) against that harness:

- **Screenshots**: all 8 required states (Default, Loading, Successful — shown once
  with a "Suggestion"/advisory-coloured kind and once with a "Summary"/verified-coloured
  kind, Empty/unknown, Permission denied, Rate limited, Provider unavailable, General
  error) captured at **1440px** (desktop) and **390px** (mobile); Default and
  Successful additionally captured at **1024px** and **768px** — 21 screenshots total,
  reviewed directly. No horizontal overflow, no broken wrapping of example chips or
  supporting-record links, and no competition between the voice "Coming soon" control
  and the active text input was observed at any width. Screenshots were not committed
  to the repository, consistent with this repo not already following that convention.
- **Automated accessibility scan**: axe-core (WCAG2A/WCAG2AA/best-practice rule sets)
  run against every one of the 9 rendered states. The first pass found three genuine
  WCAG AA colour-contrast failures, all inherited from a pre-existing, app-wide token
  (`--color-primary`/`#e05a1b` on white is ≈3.7:1 at this text size/weight; 4.5:1 is
  required): the "Ask" button and example chips (`.btn-secondary`), the new
  supporting-record links, and the kind-eyebrow label for the "unknown"/"indicator"
  kinds. Each was fixed with a narrowly scoped selector (`.ai-copilot .btn-secondary`,
  `.ai-copilot-supporting-records a`, and a Grow-only neutral eyebrow accent) reusing
  `--color-primary-dark`/`--color-text-muted` — both existing tokens already used
  elsewhere (e.g. `.btn-primary:hover`) — so no other `.btn-secondary` or link
  anywhere else in the product is affected. A second pass after the fix found **zero**
  colour-contrast violations across all 9 states. The one remaining reported item
  (`page-has-heading-one`, moderate) is a harness artifact, not a real defect: the
  isolated fragment has no page-level `<h1>`, but `Grow.tsx` itself renders `<h1>Grow</h1>`
  in both the entitled and locked states, above where `AskAgentEngine` mounts — confirmed
  by re-reading that file directly, not assumed.

### 8.5 Accessibility result

Beyond the automated pass above: the question input now has an accessible label; both
buttons already had accessible names from their own text content; the loading state is
now visually indicated and (via the live region) announced; dynamic outcomes use a
single `aria-live="polite"` region rather than either silence or excessive
announcements; global `input:focus` keeps its existing visible outline (unchanged,
never removed); keyboard-only submission (Enter key) was already implemented and
untouched; kind classification is never colour-only (the text label is primary,
colour is reinforcement only, gated to Grow so RUN Copilot is unaffected); the
disabled voice-control button is genuinely `disabled` (not just styled to look
inactive) with its own accessible name. One pre-existing, product-wide limitation is
explicitly out of scope and not fixed here: `.btn-small` buttons (used by both the
example chips and the separate voice-command placeholder) have a 32px minimum touch
target, below the ~44px commonly recommended — this predates Stage B, is used
identically throughout the rest of the product (Pit Crew tabs, etc.), and fixing it
would be an unrelated, product-wide design change outside this gate's explicit scope
boundary.

### 8.6 Behavioural smoke test

No live app+database environment is available in this sandbox (confirmed again this
gate — see §8.4), so the ten representative questions were not literally typed into a
running instance. Because the mock AI provider classifies and answers from which Grow
tools returned usable *data*, not by parsing the literal English wording of the
question, each scenario is mapped instead to the specific existing, passing automated
test that already exercises the equivalent code path — disclosed explicitly rather
than presented as a literal end-to-end run:

1. "Who should I call today?" — this is `growAskAe.test.ts`'s literal default fixture
   question; its "succeeds … full Response Contract shape" test covers it directly.
2. "Which commitments are overdue?" — `buildGrowContext`'s `dueFollowUps` field,
   covered by `growAskAeContext.test.ts` and the overdue-opportunity fixtures used
   throughout `growAskAe.test.ts`.
3. "Which appraisals need follow-up?" — `get_appraisal_followups`
   (`registry.test.ts`) and `growContext`'s `appraisalFollowUps` field.
4. "Which contacts have active property signals?" — `get_property_intelligence_signals`
   (`registry.test.ts`) and `growContext`'s `activeSignals` field.
5. "Why is this item in Grow Today?" — the `growFocusItemId`/`explain_grow_today_item`
   path, covered directly by `growAskAe.test.ts`'s "Route Focus" test and
   `growAskAeContext.test.ts`'s focus-item resolution tests (own/foreign/nonexistent).
6. "Summarise my opportunity pipeline." — `get_grow_opportunity_pipeline` plus
   `classifyGrowResponseKind`'s "summary" bug-1 regression test (§3), which is
   specifically a pipeline-summary scenario.
7. A question with no supporting data — `growAskAeContext.test.ts`'s empty-brokerage
   test (`hasAnyGrowData: false`, every list empty, never an error) and
   `growOrchestrator.test.ts`'s "unknown" fallback case in the priority-ordering test.
8. An oversized question — `growAskAe.test.ts`'s explicit 400 test for a >2000-char
   question.
9. An adversarial instruction attempting to change tenant or authority —
   `growOrchestrator.test.ts`'s adversarial-question integration test (asserts
   `riskLevel`/tools/tenant unchanged) and `registry.test.ts`'s prompt-injection
   inertness test.
10. A request asking AE to send a message or modify a record — no single test poses
    this exact wording, because no wording could change the outcome: this is
    structural, not behavioural. `assertWithinAutoExecuteCeiling(0)` is asserted
    unconditionally inside `askCopilot()` for every request, and none of the 8 Grow
    tools performs a write or has a code path capable of one — there is no tool,
    route, or branch in Grow's Ask AE request handling that can execute a send or
    mutation regardless of what the question asks for.

### 8.7 Component-test decision

No new frontend component-testing framework was added, per explicit instruction. This
codebase still has no jsdom/`@testing-library/react`, and `apps/web`'s CI-run test
script still only executes plain `.test.ts` logic files — unchanged by this gate. The
axe-core/Playwright harness in §8.4 is a one-off, session-local visual/accessibility
audit tool, not a repository-committed test suite, and is not represented as a
component-rendering test in CI. The **Web production build** (CI run #311, step "Web
production build", passed — §8.8) remains, exactly as required, the minimum
executable frontend validation this stage relies on: it independently confirms the
edited `.tsx`/`.css` compile and bundle correctly in production mode.

### 8.8 Rate-limiter limitation (reaffirmed, unchanged)

Restated for completeness of this gate, per its explicit checklist item — nothing
about the rate limiter's architecture was touched. The Grow rate limiter
(`growRateLimiter.ts`) remains in-memory and per-process: correct and sufficient for
this build's current single-process development/pilot deployment, tested for
cap/reset/per-brokerage-independence semantics (§4, §6), but **not** reliable as a
global limit once this API runs multiple replicas — it would need a shared/distributed
store (e.g. Redis) before horizontally-scaled production deployment. No such
replacement was made or attempted; doing so would be distributed-infrastructure work
explicitly out of this gate's scope.

### 8.9 Code change, commit, and CI

One commit, `a7a02b8a3ab1e84130806b8c0da36a9f47cdbc4e`, touching exactly two files
(`apps/web/src/components/AskAgentEngine.tsx`, `apps/web/src/styles.css`) — no
application, orchestration, route, or test file changed. Pushed without force;
byte-fidelity of both files verified before and after the push (local SHA-1 of the
intended new content matched GitHub's reported blob SHA exactly post-push:
`AskAgentEngine.tsx` → `ab426045e47431b2004ed3b673c94de7a93f58b2`; `styles.css` →
`a8cbca500c23b8ee009fe3c89f14f2f14a240562`). PR #35's description was left as-is for
the backend delivery; this report is the record of the UX gate itself.

CI run **#311** (workflow run `34719547510`, job `103622746949`), triggered by this
commit, is fully green — every step re-run and re-inspected job-by-job (identical step
list to run #309, confirming the UX-only change touched nothing else):

| Step | Result |
|---|---|
| Workspace typecheck | Passed, 41s |
| Deterministic clean-database migration check | Passed, 2s |
| Schema drift check | Passed, 2s |
| API automated test suite (full suite, unchanged) | Passed, 16m 50s |
| API production build | Passed, 1s |
| Web production build | Passed, 3s |
| Synthetic production startup and storage readiness | Passed, 5s |

Overall job status: **succeeded in 18m 12s** (annotations: the same single, benign
Node.js 20→24 runner-deprecation notice as every previous run on this branch — not a
Stage B or repository issue). PR #35's head is now `a7a02b8a3ab1e84130806b8c0da36a9f47cdbc4e`,
`mergeable_state: "clean"`, 20 changed files, `+2675/-59`, 24 commits — re-confirmed via
the GitHub API immediately after this CI run completed.

## 9. Final decision

**COMPLETE — PRIORITY 6 STAGE B READY FOR PROJECT OWNER MERGE REVIEW**

Every ENTRY GATE requirement has been met: the Grow-scoped Ask AE feature is
implemented end-to-end (context → tools → prompt → orchestration → route → UI),
genuine tests exist across every required layer (Context, Tools, Orchestration,
Security, HTTP/route-level regression), RUN Copilot and the full Priority 1–5 suite
pass unchanged in the same CI run as every new Stage B test file, and PR #35's head
commit (`711f9445ba92e1499a8aeed8cfbcbfb753951de0`) has a fully green CI run (#309,
workflow run `34696187609`) covering typecheck, migration/schema-drift checks, the
full automated test suite, both production builds, and synthetic production
startup/storage-readiness. No Stage C/D/E/F work was started; no live AI provider was
used or is required.

Additionally, the project-owner UX/presentation gate (§8) is also complete: the four
(plus one found in-gate) previously unstyled selectors are now styled from existing
design-system tokens only, two genuine accessibility/UX gaps (loading indication,
live-region announcements) and three genuine WCAG AA contrast failures were found and
fixed, the pre-existing voice "Coming soon" control was confirmed to already satisfy
its requirement, visual verification was performed to the extent this sandbox
credibly allows (a real-CSS static-markup harness plus an automated axe-core pass —
disclosed precisely, not overstated as a live app render) with zero remaining
contrast violations, the ten behavioural scenarios are each mapped to specific,
already-passing automated test evidence, no new test framework was introduced, the
rate-limiter's known limitation is unchanged and re-documented, and CI run #311 on the
resulting head commit (`a7a02b8a3ab1e84130806b8c0da36a9f47cdbc4e`) is fully green. This
PR remains open, unmerged, awaiting the project owner's own review and merge decision.
