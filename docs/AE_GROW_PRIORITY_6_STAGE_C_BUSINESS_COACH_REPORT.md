# AE GROW Priority 6 Stage C — AI Business Performance Coach

**Branch:** `feat/ae-grow-priority-6-stage-c-business-coach`
**Status:** COMPLETE — PRIORITY 6 STAGE C TIMEZONE-CORRECTED — READY FOR PROJECT OWNER MERGE REVIEW. PR #36 is open into `staging` (not merged). §9 documents the original (pre-remediation) CI verification; §11 documents the Project Owner's required timezone remediation, its own full audit trail, and the fresh, fully green CI run against the true final PR head (see §11.4 for the complete SHA lineage and §11.6 for the CI result).

## 1. Scope

This stage implements the AI Business Performance Coach authorised by the project owner: a read-only coaching surface that reflects an agent's own already-recorded Grow activity, commitment completion, appraisal momentum, opportunity pipeline health, and relationship engagement back to them as analysis, observations, and recommended human actions. It is explicitly bounded to what the authorisation allowed and nothing more:

- No AI-proposed executable actions (Stage D). Every coaching recommendation is text describing something the agent could choose to do themselves — there is no button, tool, or code path anywhere in this stage that lets the model cause a side effect.
- No voice input (Stage E). The Grow tab's existing, permanently-disabled "Voice command" placeholder is untouched.
- No call recording or transcription (Stage F). Nothing in this stage records or transcribes audio.
- Level 0 (read-only, `riskLevel: 0`) for every coach interaction, the same ceiling Ask AE already operates under.

## 2. Architecture

### 2.1 Role routing

A fifth architected `AiRole`, `"business_coach"`, already existed as a typed placeholder from the original Contextual AI Architecture (Phase 9) — this stage is the first to give it a real implementation, mirroring how `"copilot"` was the first. The client selects it indirectly: `POST /ai/ask` accepts an additive, optional `mode: "ask" | "coach"` field (default `"ask"`), and `askCopilot()` maps `mode === "coach"` to `role = "business_coach"` before anything else runs. There is no field anywhere in the request schema that lets a client name a role directly.

`routes/ai.ts`'s Zod schema enforces the only valid combination server-side:

```
.refine((data) => data.mode !== "coach" || data.contextType === "grow", {
  message: 'mode "coach" is only supported together with contextType "grow".',
  path: ["mode"],
})
```

`askCopilot()` repeats the same check as defense in depth (`if (isCoachRequest && context.coach === null) throw ...`), so even if a future change ever weakened the route-level refine, a coach-mode request with no Grow context still fails closed with a hard error rather than silently falling back to Ask AE or another tool surface.

### 2.2 Context

`context/businessCoachContext.ts` is built only when `contextType === "grow"` and `mode === "coach"` (`contextEngine.ts`'s `buildContext()`) — a plain Grow Ask AE request never pays for or exposes the coaching-metrics queries. It composes, rather than duplicates, Stage B's existing `GrowContext` (the same object a plain Ask AE request already builds) for the Grow Today snapshot, and issues its own set of brokerage-scoped, capped queries (via `coaching/metrics.ts`) for everything else, run in parallel with `Promise.all`. The "currently overdue" / "currently stale" / "currently open" row sets are fetched once and reused for both the current and previous period's derived metrics, since those facts are deliberately not period-bound (see §3).

### 2.3 Tools

`tools/registry.ts` adds `COACH_TOOL_REGISTRY`, eight new read-only tools that each expose exactly one field already computed on `ctx.coach`, plus one bundle tool:

| Tool | Exposes |
|---|---|
| `get_activity_consistency` | `ctx.coach.activity` |
| `get_commitment_performance` | `ctx.coach.commitments` |
| `get_appraisal_momentum` | `ctx.coach.appraisals` |
| `get_opportunity_pipeline_health` | `ctx.coach.opportunities` |
| `get_relationship_engagement` | `ctx.coach.relationships` |
| `get_grow_today_patterns` | `ctx.coach.growToday` |
| `get_performance_snapshot` | all of the above, bundled |
| `compare_performance_periods` | `ctx.coach.comparison` |

None of these tools query the database, accept a caller-supplied brokerage or date-range override, or can return an unbounded result — every cap and every date-range validation already happened in `coaching/period.ts` and `coaching/metrics.ts` before `ctx.coach` existed. `selectToolsForContext()` routes a `role === "business_coach"` request to this registry exclusively, checked before the Grow branch (every coach request is also Grow-scoped, so without this ordering it would silently fall through to `GROW_TOOL_REGISTRY` and never see its own metrics).

### 2.4 Prompt

`business.coach.grow.v1` (`prompts.ts`) is a new, versioned system prompt distinct from `copilot.ask.grow.v1`. It restates Ask AE's existing hard constraints (no predictions about a named contact, no fabricated data, read-only, no claim of having taken or being able to take an action) and adds coaching-specific ones the plain Ask AE prompt never needed: never recompute or estimate a figure the model wasn't given, never fabricate an industry benchmark, never assert causation from a correlation, never criticise the agent personally, and never let stored contact/activity text be read as instructions rather than data. It also gives the model a fixed, deliberately narrow vocabulary of framing phrases ("The available data shows...", "This may warrant attention because...", "A practical next step could be...", "Progress could be measured by...", "There is not yet enough information to determine...") so the model's own generated narrative (`response.summary`) stays inside the same evidentiary posture as the deterministic fields sitting beside it.

### 2.5 Response construction

Every structured figure in a coaching response is produced by `coaching/responseBuilder.ts` from the already-computed `BusinessCoachContext` — never by the model, and never recomputed from raw rows a second time. The model's own generated text becomes only the free-text `summary` narrative; `orchestrator.ts`'s `askCopilot()` assembles the rest directly:

```
kind: "recommendation",
summary: generation.response.text,           // model-generated narrative only
riskLevel: 0,
headline: buildCoachHeadline(coach),          // deterministic
period: coach.period,                         // deterministic
performanceSummary: buildCoachPerformanceSummary(coach),
observations: buildCoachObservations(coach),
strengths: buildCoachStrengths(coach),
focusAreas: buildCoachFocusAreas(coach),
recommendations: buildCoachRecommendations(coach),
supportingMetrics: buildCoachSupportingMetrics(coach),
dataFreshness: coach.asOf,
limitations: buildCoachLimitations(coach),
suggestedReviewDate: buildCoachSuggestedReviewDate(coach, new Date()),
```

This is the "no model-arithmetic" requirement enforced by construction rather than by prompt instruction alone: even if the model ignored every constraint in its prompt, it has no code path that lets its output override or feed into any of these fields.

## 3. Metrics reference

Every metric below is computed by a pure function in `apps/api/src/lib/ai/coaching/metrics.ts` that takes only already-fetched, brokerage-scoped, capped rows and a resolved period — no metric ever touches the database, the real wall clock, or the AI provider itself. This section is the authoritative definition of what each figure means, so a reader of a coaching response (or of this report) can check it without reading the implementation.

### 3.1 Activity consistency

- **Definition:** how much Grow activity was recorded in the requested period, and how evenly spread across it.
- **totalActivities:** every `growActivities` row in the period, scoped to the caller's brokerage.
- **activeDays / totalDaysInPeriod / activeDayRate:** `activeDays` is the count of distinct UTC calendar days in the period with at least one activity row; `activeDayRate = activeDays / totalDaysInPeriod`.
- **longestGapDays:** the longest run of consecutive inactive days between two active days; `null` when fewer than two active days exist (a single data point cannot describe a gap).
- **Exclusions:** activities outside the requested period; activities belonging to another brokerage.
- **Row cap:** 2,000 (`ACTIVITY_ROW_CAP`), ordered by date, oldest first.
- **Limitations surfaced:** truncation at the cap; a still-in-progress period (e.g. "this month so far") flagged as not directly comparable to a completed one.

### 3.2 Commitment performance

- **Definition:** how reliably commitments due in the period were completed, plus a live (not period-bound) view of what is overdue right now.
- **totalDue / completed / completionRate:** `totalDue` = commitments whose `dueAt` falls in the period, regardless of current status; `completed` = of those, `status === "Completed"`; `completionRate = completed / totalDue`, reported as `null` (not 0%) when `totalDue` is 0.
- **currentlyOverdueCount / averageOverdueAgeDays / repeatedOverdueContacts:** deliberately **not** period-bound — an overdue commitment from before the requested period is still overdue today, and hiding it would understate what the agent needs to act on now. Computed from a separate "as of now" fetch (`status === "Open"` and `dueAt < now`). `repeatedOverdueContacts` lists contacts with 2 or more currently-overdue commitments.
- **Exclusions:** cancelled commitments are never counted as due or completed.
- **Row cap:** 2,000 for both the period-bound and the "as of now" fetch; the repeated-overdue list itself is capped at 10.
- **Limitations surfaced:** truncation at the cap; no commitments due in the period; a still-in-progress period noted as possibly understating completions still to come.

### 3.3 Appraisal momentum

- **Definition:** appraisals created in the period, their current status/outcome, and appraisals that have gone stale.
- **created / byStatus / wonCount / lostCount / followUpDueCount:** `created` = appraisals whose `createdAt` falls in the period; the rest describe the **current** status/outcome of those same appraisals — this is not a history of status transitions, because this build's schema does not record appraisal status changes over time, only the current row.
- **staleCount:** deliberately **not** period-bound, for the same reason as overdue commitments. Computed from a separate fetch of non-terminal (excludes WON/LOST/DEFERRED/ARCHIVED) appraisals whose `updatedAt` is 21+ days old (`STALE_APPRAISAL_DAYS`), scoped to the brokerage via a join through `properties` (appraisals carry no `brokerageId` column of their own — the same join pattern `growToday.ts` already uses).
- **Exclusions:** terminal-status appraisals are excluded from the stale fetch in the query itself, not filtered afterwards, so a long-closed appraisal can never crowd a genuinely stale one out of the capped result.
- **Row cap:** 500 for both fetches.
- **Limitations surfaced:** always states the "current status, not a history" caveat; truncation at the cap; zero appraisals created in the period.

### 3.4 Opportunity pipeline health

- **Definition:** the health of the open pipeline right now, plus what's new in the requested period.
- **openCount / byStage / averageAgeDays / stalled:** all describe the **current** open pipeline (`status === "Open"`), not a period-bound slice — an open opportunity from before the period is still open today. `stalled` = open opportunities whose last meaningful contact (or, if none recorded, creation date) is 21+ days in the past (`STALL_THRESHOLD_DAYS`).
- **newInPeriod / newFromSignalsInPeriod:** the only period-bound figures here — opportunities whose `createdAt` falls in the requested period, and of those, how many trace back to a Property Intelligence signal an agent explicitly promoted (`growOpportunitySignals.promotedOpportunityId`, set only by an explicit agent action, never by the signal engine itself).
- **Exclusions:** stage-to-stage movement history is not recorded in this build — this reports current stage distribution and age, never historical transitions.
- **Row cap:** 1,000 open opportunities; the stalled list itself is capped at 10.
- **Limitations surfaced:** the "no stage-history" caveat is always present; truncation at the cap; zero open opportunities.

### 3.5 Relationship engagement

- **Definition:** how many of the caller's active contacts have been engaged with recently.
- **distinctContacts:** distinct parties holding at least one `Active` relationship (a party with several relationship rows counts once, preferring its primary relationship's type for display).
- **recentlyEngagedContacts / noRecentActivityContacts:** a contact counts as recently engaged if any `growActivities` row for that party falls within the last 21 days (`RECENT_ENGAGEMENT_THRESHOLD_DAYS`) — deliberately **not** bound to the requested coaching period, since "recently engaged" always means relative to right now.
- **Row cap:** 2,000 active relationships; the no-recent-activity list itself is capped at 10.
- **Limitations surfaced:** truncation at the cap.

### 3.6 Grow Today patterns

- **Definition:** a snapshot of the caller's current Grow Today list (Priority 1's own live "what needs attention right now" view), grouped by priority and item type.
- **Source:** the same `GrowContext` a plain Grow Ask AE request already builds — this metric adds no new query.
- **Limitation surfaced, always:** Grow Today has no persistence of its own, so this is a live snapshot, never a historical count of items resolved over time.

### 3.7 Period comparison

- **Definition:** a neutral, non-causal comparison of five figures (recorded activity, active days, commitment completion rate, appraisals created, new opportunities) between the requested period and the previous comparable period.
- **Comparable period:** for `currentMonth`, the previous full calendar month; for every trailing-window or custom period, an equal-length immediately preceding window.
- **Direction / percentChange:** `increased` / `decreased` / `stable` based on the sign of the absolute change; percent change is never shown when the earlier period's value was zero (a "+infinite%" figure would mislead, not inform); `insufficient_data` is reported (never a spurious direction) when either value is missing, or — for the commitment-completion-rate comparison specifically — when either period had fewer than 3 commitments due (`MIN_SAMPLE_SIZE_FOR_TREND`).
- **Limitations surfaced:** the zero-baseline percent-change caveat is always present; a still-in-progress current period is flagged as possibly understating its final figures; insufficient commitment sample size is flagged when it applies.

## 4. Response Contract (coach-specific fields)

A coach-mode response reuses the single, existing `AiStructuredResponse` type (the same one Ask AE and RUN Copilot already use) rather than a second response shape, with these additive, coach-only fields — all `undefined` on every non-coach response, and `response.supportingRecords` / `response.suggestedNextStep` (Ask AE's own additive fields) are asserted `undefined` on every coach response, so the two extensions never bleed into each other:

- `headline` — one sentence naming the period (e.g. "A look at your last 7 days").
- `period` — the resolved `PeriodView` (key, label, start/end ISO timestamps, `isComplete`, `durationDays`, and an explicit `timeBasis` string stating this build's UTC-calendar-only limitation).
- `performanceSummary` — a deterministic paragraph built from activity/commitment/opportunity/appraisal counts.
- `observations` — deltas from the period comparison plus any "may warrant attention" flags (overdue commitments, stalled opportunities, stale appraisals).
- `strengths` — evidence-gated positive observations (e.g. a strong completion rate only fires once at least 3 commitments were due).
- `focusAreas` — the same underlying conditions as `strengths`, phrased as what needs attention.
- `recommendations` — 1 to 3 (`MAX_COACH_RECOMMENDATIONS`) candidates, each with an `action`, a `reason`, an optional `relatedMetric`, `suggestedTimeframe`, `progressMeasure`, and `evidenceStrength` ("Preliminary" | "Moderate" | "Strong"). When no condition fires, a single fallback ("keep up your current routine") is returned rather than an empty list.
- `supportingMetrics` — exactly 6 pre-formatted `{key, label, value, definition}` entries (active days, commitment completion rate, currently overdue commitments, open opportunities, stalled opportunities, appraisals needing an update) — `value` is always an already-formatted display string (e.g. "62%", "3 of 5"), never a raw number the model or the UI has to reformat.
- `dataFreshness` — `coach.asOf`, the single "as of" timestamp every metric was computed against.
- `limitations` — the union of every metric's own limitations plus three standing, coaching-specific limitations restated in every response regardless of which metrics happened to fire (data-only basis, no knowledge of private intent, suggestions not instructions AE carried out).
- `suggestedReviewDate` — 7 days out for a short/custom period, 14 days out for a monthly-shaped one.

`kind` is always `"recommendation"` and `riskLevel` is always `0` for a coach response, confirmed by the orchestrator-level prompt-injection test (a question containing fabricated `{"role":"business_coach","riskLevel":4,"bypassEntitlement":true}` text has no effect on either field, or on which tools ran).

## 5. UI implementation

### 5.1 `AskAgentEngine.tsx`

The same shared "Ask Agent Engine" component Ask AE already uses gained one new, additive, optional prop: `mode?: "ask" | "coach"` (defaults to `"ask"`, so every existing call site — which never passes it — is unaffected; confirmed by a strict TypeScript compile of the finished file against the real `react`/`@tanstack/react-query`/`wouter` type definitions with zero errors). When `mode === "coach"`:

- The capabilities gate checks `businessCoachEnabled` instead of `copilotEnabled`.
- A small period selector (three tabs — Last 7 days / Last 30 days / This month — reusing the existing `.pc-tabs`/`.pc-tab` segmented-control pattern) lets the agent pick which period a typed question is asked against.
- Seven starting-option buttons, worded exactly as specified in the authorisation, each carrying its own period so clicking one asks immediately without a separate period-tab click first: "Review my last 7 days", "Review my last 30 days", "Where is my pipeline stalling?", "What should I focus on this week?", "How consistent is my follow-up?", "Which appraisals need attention?", "Compare this month with last month".
- The response layout visually separates every section named in the authorisation — performance snapshot (with the deltas/attention observations folded in), what's working, what needs attention, top priorities (each recommendation showing its reason, suggested timeframe, and evidence strength), evidence (the 6 supporting metrics, rendered as `.stat-tile` cards), limitations, and the suggested review date — with a section rendered only when it actually has content, never an empty "nothing to report" heading.
- Every existing UI state carries over: loading (the existing spinner), error (403/429/5xx each get Business-Coach-specific copy, checked ahead of Ask AE's own Grow-specific copy since a coach request is always also Grow-scoped), empty state (no starting chips once a first answer is showing, matching Ask AE's own existing chip-hiding behaviour), and the answer itself. No button anywhere in this rendering implies AE will carry out an action — every one asks a read-only question.
- The existing `aria-live="polite" aria-atomic="true"` region, the Stage B accessibility-contrast fixes (`.ai-copilot .btn-secondary`, `.ai-copilot-supporting-records a`), and the `.ai-copilot-loading`/`.ai-copilot-limitations`/`.ai-copilot-freshness` treatments all apply unchanged, because the coach response still renders inside the same `<section className="card ai-copilot">` wrapper.

### 5.2 `Grow.tsx`

The pre-wired "Performance" tab, previously a `GrowComingSoon` placeholder, now renders a new `GrowBusinessCoachTab` component — a one-line wrapper around `<AskAgentEngine contextType="grow" contextId={null} mode="coach" />`, the exact same pattern `GrowAskAETab` already established for the "Ask AE" tab. The "Nurture" tab keeps its own, separate `GrowComingSoon` placeholder untouched. Switching between the "Ask AE" and "Performance" tabs in Grow's existing tab bar is the mode toggle — no second, redundant toggle control was added inside either tab.

### 5.3 `styles.css`

New rules are additive only, built from existing design tokens (`--color-border`, `--color-bg`, `--radius-sm`) and existing patterns already used elsewhere in the file (`.pc-tabs`/`.pc-tab` for the period selector, `.stat-tiles`/`.stat-tile` for the evidence grid): `.ai-coach-period-tabs`, `.ai-coach-section`, `.ai-coach-recommendations`, `.ai-coach-recommendation`, `.ai-coach-recommendation-action`. No existing rule was modified.

## 6. Architecture decisions

- **Zero database migration.** Every table this stage reads (`growActivities`, `growCommitments`, `appraisals`, `growOpportunities`, `growOpportunitySignals`, `growRelationships`, `properties`) already existed from earlier priorities. No column, index, or table was added.
- **Minimal role routing.** A single `mode: "ask" | "coach"` enum on the existing `/ai/ask` request, server-mapped to the `AiRole` enum's pre-existing `"business_coach"` value — no new endpoint, no new request shape for the common case.
- **Reused entitlement boundary.** `business_coach` capability gating reuses the exact same `TIER_CAPABILITIES` table and `isRoleEntitled()` function every other role already uses — no new entitlement key was added anywhere in the schema or config.
- **Reused feature flag.** `AI_BUSINESS_COACH_ENABLED` is checked through the same `isRoleEnabled()` function every other role already uses.
- **Reused rate limiter.** Coach-mode requests share the exact same per-brokerage Grow rate limiter Ask AE already uses (`assertGrowRateLimit`) — confirmed by a test that exhausts the limiter with plain `assertGrowRateLimit` calls and shows a subsequent coach-mode `askCopilot()` call is refused with the same `GrowRateLimitError`.
- **Deterministic response construction.** Covered in full in §2.5 — every structured figure is produced by `coaching/responseBuilder.ts`, never by the model.
- **Type-only circular import, deliberately accepted.** `lib/ai/types.ts` (`BusinessCoachContext`) imports metric interfaces from `coaching/metrics.ts` as `import type` only; `coaching/metrics.ts` imports `GrowContext` back from `types.ts`, also `import type` only. Both sides are erased at compile time, so this is a type-only cycle TypeScript resolves safely with no runtime dependency in either direction — documented in both files' header comments rather than left as an unexplained cross-reference.
- **Versioned prompt.** `business.coach.grow.v1` sits in the same `PROMPT_REGISTRY` every other prompt already uses, versioned from 1, so a future revision doesn't silently change behaviour for requests already in flight or already logged.
- **No Stage D/E/F surface.** Confirmed by inspection of every file touched this stage: no tool or response field carries an execution payload of any kind (`CoachingRecommendation` has no field resembling `AiStructuredResponse.actionProposals`), no voice/audio code was added or enabled, and the existing disabled voice-command placeholder was not touched.

### 6.1 Disclosed gap: no structured audit columns for mode/period/tools-invoked

This stage does not add dedicated `mode`, `period`, or `toolsInvoked` columns to the `aiInteractions` audit table. The existing `aiRole` column already distinguishes a coach interaction from a plain Ask AE one (`"business_coach"` vs `"copilot"`), and the response payload itself carries the period and every field derived from the tools that ran — so the information is not lost, but it is not queryable as its own indexed audit column today. Adding those columns would have required a schema migration, which this stage's "zero database migration" decision (made to keep this stage's footprint minimal and reversible) deliberately avoided. This gap is the same one the governing authorisation asked to be disclosed rather than silently left out, and is repeated in the final report to the project owner.

## 7. Test coverage

Ten test files (six new, two edited existing fixtures, one HTTP-level route test) cover this stage, all using Node's built-in test runner (`node:test`/`node:assert/strict`), consistent with the rest of this codebase:

| File | Covers |
|---|---|
| `lib/ai/coaching/__tests__/period.test.ts` | Period resolution for every key, custom-range bounds, comparison-period pairing. |
| `lib/ai/coaching/__tests__/metrics.test.ts` | Every `computeX` function in §3, against hand-built fixture rows, including edge cases (zero due, cap truncation, insufficient sample size). |
| `lib/ai/coaching/__tests__/responseBuilder.test.ts` | Every `buildCoachX` function in §2.5/§4, including the "no attention items" fallback recommendation and the priority ordering/3-item cap. |
| `lib/ai/tools/__tests__/coachRegistry.test.ts` | Each `COACH_TOOL_REGISTRY` tool's `ctx.coach === null` fail-closed path and its happy path; `selectToolsForContext` routing a `business_coach` role to the coach registry ahead of the Grow branch. |
| `lib/ai/__tests__/coachOrchestrator.test.ts` | STARTER-tier refusal naming the Business Coach specifically; the defense-in-depth guard for coach mode without a Grow context; GROW- and PRO-tier success with the full Response Contract shape asserted field-by-field; plain Ask AE is unaffected by Stage C; shared rate-limit exhaustion; prompt-injection inertness. |
| `routes/__tests__/growAskAeCoach.test.ts` | Full HTTP-level coverage via a real `createApp()` instance and real session cookies: 401 unauthenticated, 400 on the schema refine and on an invalid period, 403 naming the Business Coach for a STARTER brokerage, 200 with the full contract for a Grow-entitled brokerage, `businessCoachEnabled` on `GET /ai/capabilities`, shared rate limiting across ask/coach modes, and cross-tenant isolation (brokerage B never sees brokerage A's opportunity count). |
| `lib/ai/tools/__tests__/registry.test.ts` (edited) | Added a `coach: null` field to the shared context fixture plus one new test confirming a plain Grow Ask AE request still gets `GROW_TOOL_REGISTRY`, not `COACH_TOOL_REGISTRY`. |
| `lib/ai/__tests__/growOrchestrator.test.ts` (edited) | Added a `coach: null` field to the shared context fixture only — no existing Ask AE test behaviour changed. |

Every new/edited test file was byte-fidelity verified against the pushed GitHub content (git-blob SHA1 comparison) immediately after pushing; all matched exactly with zero discrepancies.

## 8. Verification performed this stage

- **Byte-fidelity on every push.** Every file pushed this stage (2 backend edits' worth of content re-verified from a prior segment, 6 new backend/test files, 2 edited test fixtures, and the 3 UI files in this segment) was compared by git-blob SHA1 against GitHub's own reported SHA immediately after pushing, with zero unresolved mismatches.
- **Strict TypeScript compilation of the finished `AskAgentEngine.tsx`.** Run in isolation against the real `react@18`, `react-dom@18`, `@tanstack/react-query@5`, and `wouter@3` type definitions (not stubs) with `strict: true`, `jsx: "react-jsx"` — zero errors.
- **Syntax-level parse check of the finished `Grow.tsx` and `AskAgentEngine.tsx`** via the TypeScript compiler's own parser (`ts.createSourceFile`), independent of module resolution — zero parse diagnostics on either file.
- **Minimal, reviewable diff on `Grow.tsx`.** A line-level diff against the pre-edit baseline (itself independently byte-verified against GitHub before editing) confirms exactly two changes: the `tab === "performance"` render swap, and the new `GrowBusinessCoachTab` function — nothing else in a 1,586-line file was touched.

Not yet performed (see §9): a live CI run, the full monorepo `pnpm typecheck`/`pnpm build`/full test suite, and a manual staging walkthrough — these require the PR to be opened first.

## 9. CI verification and remediation

PR #36 (`feat/ae-grow-priority-6-stage-c-business-coach` → `staging`) was opened after the text above was written, and real GitHub Actions CI was run and inspected job-by-job in the browser, per the authorisation's delivery requirements.

### 9.1 First CI run — genuine failures found (run #314, run id `34730490523`)

The first real CI run on PR #36 failed: 6 of 7 tests in `lib/ai/__tests__/coachOrchestrator.test.ts` and 3 of 9 tests in `routes/__tests__/growAskAeCoach.test.ts` failed. Both failures were root-caused to bugs in the Stage C **test suite itself** — not in any production code path the tests exercise:

1. **Missing feature-flag activation.** `business_coach` is a non-default-on `AiRole` (`apps/api/src/lib/ai/featureFlags.ts`'s `ROLE_FLAG_ENV`): the master `AI_ENABLED` switch defaults to true, but the per-role flag (`AI_BUSINESS_COACH_ENABLED`) defaults to disabled and is enabled only by the exact lowercase string `"true"`. Neither `coachOrchestrator.test.ts` nor `growAskAeCoach.test.ts` ever set it, so every `mode: "coach"` request in both files was refused as feature-disabled before the tier/entitlement gate the tests actually meant to exercise was ever reached.
2. **GROW-vs-PRO tier fixture mismatch.** `growAskAeCoach.test.ts`'s capabilities test asserted that an HTTP fixture brokerage granted only `"grow.access"` resolves to tier `"GROW"`. But `createBrokerageWithUsers()`'s underlying dev-login (`routes/auth.ts`) auto-grants `"run.access"` to every brand-new brokerage at creation — so that fixture actually resolved to tier `"PRO"` (`grow.access` **and** `run.access`), not `"GROW"`, failing the test's exact `assert.equal(body.tier, "GROW")` assertion.

### 9.2 Fix and final verification (commit `0bfa5690af33e877297079ed3c7c20c0ad286cbd`)

Both test files were corrected, with no production code changed:

- Added `process.env.AI_BUSINESS_COACH_ENABLED = "true";` at the top of both `coachOrchestrator.test.ts` and `growAskAeCoach.test.ts` (each with an explanatory comment). Node's test runner (`node:test`) isolates each `*.test.ts` file into its own process, so this assignment cannot leak into any other test file's run.
- Added a `revokeRunAccess(brokerageId)` helper to `growAskAeCoach.test.ts`, called only by the one capabilities test that specifically asserts tier `"GROW"`, so that fixture brokerage is genuinely Grow-only (its auto-granted `run.access` is explicitly revoked, via an `entitlementGrants` status update plus `invalidateEntitlementCache`) rather than actually PRO.

Both changed files were byte-fidelity verified (git-blob SHA1) against GitHub immediately after pushing.

A second, complete real CI run (run #315, run id `34732073292`) on the same PR then finished **green — Status: Success, duration 18m 37s** — confirmed via the run summary page. This run is the evidence cited throughout this report and the final 30-item response delivered alongside it for: the workspace typecheck, the clean migration/102-table schema-drift check, the full Stage C metrics/tools/orchestrator/route test suite (including tenant-isolation, Grow-only entitlement, and prompt-injection tests), the Stage B and RUN Copilot regression suite, and the API and Web production builds. **Correction:** run #315 also included, and passed, the "Synthetic production startup and storage readiness" step (6s) — an earlier verbal report of this run incorrectly described that step as not applicable or not run; it did run, and it succeeded. A subsequent documentation-only commit (`b847d155c5d0e0ea9bca6310d45e620b11f68f9c`) produced a further green run (run #316, run id `34733670668`, Status: Success, duration 18m 35s), confirming the doc-only change did not affect CI. Both #315 and #316 predate the Project Owner-required timezone remediation described in §11; that remediation's own CI verification is documented separately in §11.6.

## 10. Final decision to project owner (pre-remediation — see §11 for the current, superseding decision)

**This section is retained for the historical record and is superseded by §11.7.** At the time this section was written, the decision was COMPLETE — PRIORITY 6 STAGE C READY FOR PROJECT OWNER MERGE REVIEW, against head `0bfa5690af33e877297079ed3c7c20c0ad286cbd`. The Project Owner's review of that state ("REMEDIATION REQUIRED — STAGE C TIMEZONE AND FINAL-HEAD VERIFICATION") subsequently identified that coaching periods used UTC calendar boundaries rather than the agent's local timezone, and required remediation before merge review — `0bfa5690af33e877297079ed3c7c20c0ad286cbd` must not be described as the final branch SHA. See §11 for the corrected, current decision and the true final PR head.

PR #36 is open against `staging` (base `staging` at `0a69fe2cae8d72d6e968d4211e4121ed6c3636bd`) and has **not** been merged, deployed, or acted on beyond opening it, per the authorisation's explicit instruction not to merge, deploy, begin Stages D–F, or delete the branch as part of this stage. The disclosed audit-column gap (§6.1) and the two test-suite-only bugs found and fixed via real CI (§9) are the only known limitations at that point in time; neither blocked Project Owner merge review on its own, but the timezone defect below did.

## 11. Timezone remediation (Project Owner-required)

### 11.1 Governing instruction

The Project Owner's "REMEDIATION REQUIRED — STAGE C TIMEZONE AND FINAL-HEAD VERIFICATION" decision directed four corrections before merge review: (1) correct local-time handling for coaching periods (previously UTC-calendar-only); (2) reconcile this report with the actual PR head; (3) correct the storage-readiness statement (§9.2's correction above); (4) complete verification against the true final branch state. It also required a timezone source-of-truth audit before any code change, using a strict precedence order, with a `BLOCKED` stop condition if no canonical source existed.

### 11.2 Timezone source-of-truth audit and precedence

Precedence required (highest first): (1) an explicit authenticated-user timezone — not supported; `users` carries no timezone column anywhere in the schema. (2) An explicit brokerage timezone — `communication_settings.time_zone` (`packages/db/src/schema/communications.ts`) **is** a real, existing, nullable per-brokerage IANA-timezone column, already established by the Communications Hub and already reused as a fallback source by that hub's own quiet-hours logic (`lib/communications/quietHours.ts`'s `resolveCommunicationTimeZone`). (3) An existing canonical application default — `DEFAULT_TIME_ZONE` (`"Australia/Brisbane"`, `lib/commandCentre/timezone.ts`), the one documented, cross-feature-reused (Command Centre and Communications Hub) default this codebase has. (4) Fail closed — never reached, since tier 3 always resolves.

Because tier 2 (an existing, non-schema-migration column) and tier 3 (an existing, cross-feature default) together satisfy the precedence chain without introducing any new schema field, **no `BLOCKED` stop condition applies** and no Project Owner timezone-source decision was required.

### 11.3 Implementation summary

- `lib/commandCentre/timezone.ts`: `zonedParts`/`offsetMs` changed from module-private to exported, so the coaching module below can build local-month boundaries on the same DST-safe primitives (`Intl.DateTimeFormat.formatToParts`, guess-then-correct via `Date.UTC`) without a second, subtly different implementation. No other line changed.
- `lib/ai/coaching/timezone.ts` (new): `resolveCoachingTimeZone(brokerageId)` — a read-only `db.select()` against `communication_settings` (never `getOrCreateCommunicationSettings()`, which has a write side effect coaching must never trigger), falling back safely to `DEFAULT_TIME_ZONE` on a missing row, a null column, or an invalid stored value (validated via `isValidIanaTimeZone`, an `Intl.DateTimeFormat` type-guard). Also adds `startOfLocalMonth`/`startOfPreviousLocalMonth`, built on the same exported primitives, with `startOfPreviousLocalMonth` deliberately using an out-of-range month index (`-1`) to let `Date.UTC`'s own month/year rollover handle a December→January crossing without a hand-written special case.
- `lib/ai/coaching/period.ts`: every `ResolvedPeriod`/`PeriodView` now carries `timeZone`/`timeZoneSource` (plus a human-readable `timeBasis` disclosure string); `last7days`/`last30days`/`currentMonth`/`previousPeriod` all resolve against true local calendar boundaries in the resolved timezone instead of UTC.
- **Off-by-one defect found and fixed in the same pass:** the pre-remediation `last7days`/`last30days` formula (`start = todayStart - N*24h`, `end = now`) actually spanned N+1 calendar dates for any `now` not at exact local midnight — masked by every prior test fixture using an exact-UTC-midnight `now`. Corrected to `start = localTodayStart - (N-1)*24h`, spanning exactly N local calendar dates (today inclusive, plus the previous N-1) — the definition most consistent with this UI's own existing "Last 7 days"/"Last 30 days" labels, now stated explicitly in the module's own header comment.
- `lib/ai/coaching/metrics.ts`: `computeActivityConsistency`'s "active day" bucketing changed from a bare UTC date slice (`occurredAt.toISOString().slice(0, 10)`) to the period's resolved local calendar day (`localDateKey(row.occurredAt, period.timeZone)`) — an activity logged late at night in an AU/NZ zone can fall on the following UTC calendar date, which previously miscounted it against the wrong local day.
- `lib/ai/context/businessCoachContext.ts`: the single call site that resolves the brokerage's coaching timezone (`resolveCoachingTimeZone`) and threads it into `resolvePeriod` — every other file downstream only ever reads `period.timeZone` off an already-resolved period, never re-resolves one, keeping "one place decides the timezone" true by construction.
- `apps/web/.../AskAgentEngine.tsx`: the coaching period pill now shows the resolved timezone directly (e.g. "Last 7 days · Australia/Brisbane"), with the fuller disclosure sentence as a hover tooltip, per the UI requirement.
- **No changes needed** in `lib/ai/types.ts` (imports `PeriodView` as a type only) or `routes/ai.ts` (its `askSchema` has no `timeZone` field, and the route handler reads only specific named fields off the parsed body, never a spread) — confirmed by direct reading before concluding no client-supplied timezone can reach the response.
- **Explicitly not changed, per the authorisation's scope boundary:** the pre-existing, disclosed inconsistency between `resolveComparisonPeriods` and `resolvePreviousComparablePeriod` for `currentMonth` comparisons (found in an earlier segment) — noted here again only as a standing observation, not remediated in this pass.

### 11.4 SHA lineage

| Label | SHA |
|---|---|
| Starting `staging` base SHA | `0a69fe2cae8d72d6e968d4211e4121ed6c3636bd` |
| Last functional-code SHA before this remediation (previously mislabeled as "final SHA" in an earlier verbal report — it was not) | `0bfa5690af33e877297079ed3c7c20c0ad286cbd` |
| Documentation-only commit SHA (added the pre-remediation version of this report) | `b847d155c5d0e0ea9bca6310d45e620b11f68f9c` |
| Timezone-remediation commit 1 of 4 (production code: `commandCentre/timezone.ts`, new `coaching/timezone.ts`, `coaching/period.ts`, `coaching/metrics.ts`, `context/businessCoachContext.ts`) | `934f20b5a49192565e3d4036b02819c494426e9e` |
| Timezone-remediation commit 2 of 4 (new `coaching/__tests__/timezone.test.ts`, rewritten `coaching/__tests__/period.test.ts`) | `58f3301a609acdbdf31af78f5bbb5acc15fc2ef1` |
| Timezone-remediation commit 3 of 4 (`coaching/__tests__/metrics.test.ts`, `coaching/__tests__/responseBuilder.test.ts`, `tools/__tests__/coachRegistry.test.ts`) | `71e753eb6b75f47b278258e7ec5d87c343df120b` |
| Timezone-remediation commit 4 of 4 (`__tests__/coachOrchestrator.test.ts`, `routes/__tests__/growAskAeCoach.test.ts`, `AskAgentEngine.tsx`) — **actual final PR head SHA** | `db338cd0ffb4093d4543596b9d7d2ec10cfb5ba3` |

The four timezone-remediation commits were pushed sequentially rather than as one atomic commit; each intermediate commit represents a genuinely incomplete state of the change (e.g. production code expecting new test fixture fields not yet present) and is not independently meaningful — only the state at the final head (`db338cd0...`) reflects the completed remediation. This produced three superseded, non-representative CI runs against those intermediate states (run #317 and #318 failed, run #319 was cancelled by the next push) — none of them describe the finished code and none is cited as evidence anywhere in this report. Only run #320, against `db338cd0...`, is cited.

### 11.5 Required timezone test matrix

Implemented across `coaching/__tests__/timezone.test.ts` (pure primitives) and the rewritten `coaching/__tests__/period.test.ts` (product-level period resolution), both using injected/frozen clocks, never the CI runner's own timezone: Brisbane (no DST), Sydney (standard and daylight), Adelaide (half-hour offset, standard and daylight), Perth (no DST), Auckland (standard and daylight), a UTC calendar date disagreeing with the agent's local calendar date, a month boundary, a year boundary, the exact DST spring-forward transition instant, an invalid timezone string, a missing timezone (safe default), a client timezone-override attempt (`coachOrchestrator.test.ts` / `growAskAeCoach.test.ts` — has no effect), cross-tenant timezone isolation (`coachOrchestrator.test.ts` — one brokerage configured, a sibling brokerage falling back, in a single test), like-for-like comparison periods, a zero-valued prior period, an incomplete current period, and a suggested review date read back correctly in the local calendar (`responseBuilder.test.ts`).

### 11.6 CI verification against the true final head

Run #320 (run id `34736796800`), triggered by the fourth and final remediation commit, finished **Status: Success, Total duration: 18m 49s**, confirmed via the run summary page and the individual job step list, both inspected directly in the browser: Workspace typecheck (36s) — pass; Deterministic clean-database migration check (2s) — pass; Schema drift check (2s) — pass; API automated test suite (17m 10s, carrying the full Stage C suite including every timezone test above, the Stage B regression suite, and the RUN Copilot regression suite) — pass; API production build — pass; Web production build — pass; Synthetic production startup and storage readiness (6s) — pass. One unrelated informational warning was present (a GitHub Actions Node 20 deprecation notice for `actions/checkout@v4`/`actions/setup-node@v4`/`pnpm/action-setup@v4`, forced to run on Node 24 instead) — not a code defect and outside this stage's scope to address.

### 11.7 Corrected final decision (supersedes §10)

**COMPLETE — PRIORITY 6 STAGE C TIMEZONE-CORRECTED — READY FOR PROJECT OWNER MERGE REVIEW.**

PR #36 is open against `staging` (true final head `db338cd0ffb4093d4543596b9d7d2ec10cfb5ba3`, base `staging` at `0a69fe2cae8d72d6e968d4211e4121ed6c3636bd`), with a fully green real CI run (#320) against that exact head, and has **not** been merged, deployed, or acted on beyond opening it. Coaching periods are now resolved against the agent's correct local calendar timezone (brokerage-configured, or the application default, per §11.2's precedence), with the required test matrix in place and passing. Known, disclosed limitations: the §6.1 audit-column gap; the pre-existing `resolveComparisonPeriods`/`resolvePreviousComparablePeriod` inconsistency noted in §11.3 (observed, not fixed, per the authorisation's scope boundary); and no live UI/manual staging walkthrough was performed (non-blocking, per the authorisation). None of these blocks Project Owner merge review. The full required 28-item structured response accompanies this report in the conversation with the Project Owner.

## Scope boundary confirmation

Everything built in this stage stays within the authorised boundary: read-only analysis and coaching narrative only; no AI-proposed executable action; no voice input; no call recording or transcription; no live deployment; no live AI provider credentials introduced (this stage reuses the existing gateway/provider abstraction unchanged); no distributed rate limiter; no new billing entitlement; no branch deletion; no unrelated changes to any other Priority's code; PR #36 (opened this stage) has not been merged, per authorisation.
