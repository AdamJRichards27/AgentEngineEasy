# AE GROW Priority 6 Stage B — Grow-Scoped Ask AE — Completion Report

Branch: `feat/ae-grow-priority-6-stage-b-grow-ask-ae`
Forked from `staging` at: `f5da7cb18014c8dd4da8536e4abbb8f3ee3ce2d6`
Final SHA (this report's own baseline): `711f9445ba92e1499a8aeed8cfbcbfb753951de0`
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
- The new Grow UI classes (`ai-copilot-examples`, `ai-copilot-supporting-records`,
  `ai-copilot-freshness`, `ai-copilot-limitations`) have no stylesheet rules yet — they
  render correctly but unstyled (inheriting default element/`.muted` styling) pending a
  follow-up design pass.
- The Grow rate limiter is in-memory and per-process (documented in its own header
  comment) — correct for this build's single-process deployment, but would need a
  shared store (e.g. Redis) before this API runs multiple replicas.
- This report's CI evidence (§5) does not include an independently re-extracted exact
  pass/fail test count for run #309, for the reason stated there.

## 8. Final decision

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
used or is required. This PR remains open, unmerged, awaiting the project owner's own
review and merge decision.
