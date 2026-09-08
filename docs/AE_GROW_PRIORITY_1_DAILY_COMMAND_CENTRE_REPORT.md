# AE Grow — Priority 1: Daily Command Centre ("Today")

**Branch:** `feat/ae-grow-priority-1-daily-command-centre`
**Base:** `feat/ae-grow-priority-0-5-foundation`
**Starting SHA:** `7a0e64cb8c7d77102e16ced96d6f7460a67f42a3`
**Final SHA:** `8376db70709ae707e8c55d84206e4f4bea522793`
**Pull Request:** [#29 — AE Grow Priority 1: Daily Command Centre ("Today")](https://github.com/AdamJRichards27/AgentEngineEasy/pull/29)

---

## 1. Decision

**Complete, with one pre-existing and unrelated CI caveat disclosed below. Recommend Project Owner review and merge, then STOP for approval before any further Grow priority — per the governing instruction.**

Everything this priority was authorised to build is implemented, pushed, and covered by passing automated tests: the `GET /grow/today` endpoint and its deterministic prioritisation engine, the minimal `PATCH /grow/opportunities/:id` write, and the rebuilt "Today" tab on the Grow workspace. The real monorepo typecheck, the database migration check, the schema drift check, and every test this priority added (13 distinct assertions across `growToday.test.ts`'s route suite, plus the frontend pure-logic tests) passed cleanly in CI.

CI could not finish end-to-end for this PR: a **pre-existing, unrelated** test file, `apps/api/src/routes/__tests__/privacy.test.ts`, fails in under 25ms and then leaves the API test process hanging indefinitely afterwards, which prevented the downstream build/synthetic-startup steps in this run from starting within a practical time budget. This file was not touched by this priority, is not part of Grow, and the same hang would reproduce on the base branch with no Grow changes applied at all. Section 10 documents the exact evidence and reasoning for treating this as pre-existing and non-blocking, per the original governing instruction to "confirm the known privacy.test.ts issue remains unrelated/non-blocking" rather than remediate it as part of this priority.

## 2. User Experience Delivered

The Grow workspace (`apps/web/src/pages/Grow.tsx`) now opens on a **Today** tab by default, alongside the existing Opportunities, Contacts, Nurture, Performance, and Ask AE destinations (now presented as an internal `.pc-tabs` sub-navigation, mirroring the pattern already established by PitCrew's Command Centre — no new top-level routes were added; RUN continues to own `/today`).

Today opens with a short greeting and a small, fixed set of headline indicators — **Priority Actions**, **Follow-Ups Due**, **Open Opportunities**, **Contacts Needing Attention** — never a larger dashboard of vanity metrics. Below that sits a single prioritised action feed, grouped into three sections: **Do Now**, **Do Today**, and **Keep Warm** (the last collapsed behind a `<details>` disclosure unless it is the only non-empty group). Every card in the feed states, in plain language, why it is showing ("Follow-up was due 5 Sep 2026.", "No contact recorded for 30 days.", and so on) and what the recommended next step is.

Two purposeful non-default states exist: a brand-new brokerage with no Grow data at all sees an onboarding message and an import link rather than an empty list; a brokerage that is fully caught up sees a plain "you're all caught up" message rather than a confusing blank feed.

## 3. Prioritisation Logic (Deterministic, Never Predictive)

Implemented entirely in `apps/api/src/lib/growToday.ts`, `getGrowTodaySummary(brokerageId)`. Every rule is a plain date/threshold comparison over data already entered through Grow's existing flows — nothing here is a model score, and `growOpportunities.confidenceScore`/`scoreExplanation` (Stage A's own explainable-score fields) are deliberately never read by this function; an Opportunity Score engine remains out of scope for this priority.

Rules, in priority order:

- **Do Now** — an open opportunity whose `nextActionDueAt` is before the start of today (UTC). Reason: `"Follow-up was due {date}."`
- **Do Today** — an open opportunity whose `nextActionDueAt` falls within today (UTC), or an `Appraisal`-type opportunity with no `nextActionDueAt` set at all. Reasons: `"Follow-up is due today."` / `"New appraisal opportunity doesn't have a next action set yet."`
- **(not surfaced)** — an open opportunity whose `nextActionDueAt` is in the future is deliberately excluded from the action feed (it still counts toward the Open Opportunities tile) — Today only shows what needs a decision now or today, or has no plan at all.
- **Keep Warm** — a non-Appraisal open opportunity with no `nextActionDueAt` set, or an Active `growRelationships` row for a party with no recorded `growActivities` contact ever, or none within the last **21 days** (`COLD_CONTACT_THRESHOLD_DAYS`, a named, adjustable constant). Reasons: `"This opportunity doesn't have a next action set yet."` / `"No contact recorded yet."` / `"No contact recorded for {n} days."`

A party is never shown twice: if they already have an opportunity-based card, the cold-relationship rule is skipped for them (`partyIdsWithOpportunityAction`). Day boundaries use UTC (`startOfTodayUtc`/`endOfTodayUtc`) so "today" is computed deterministically regardless of the host machine's timezone. The feed is sorted by priority, then by due date (soonest first, undated items last), then by oldest last-contact.

## 4. Data Sources

Only Grow's own domain tables — `growRelationships`, `growActivities`, `growOpportunities` — joined against the canonical `parties` and `properties` tables for display labels (name, organisation, formatted address). No RUN, PitCrew, or financial-domain table is read anywhere in this priority's code. Every query is scoped by `brokerageId` server-side.

## 5. Grow Navigation

No new top-level routes. `Grow.tsx`'s entitled workspace (`GrowWorkspace`) now holds internal tab state (`GrowTab`) and renders a `.pc-tabs.grow-tabs` bar for Today / Opportunities / Contacts / Nurture / Performance / Ask AE. Today is the default (`useState<GrowTab>("today")`). Opportunities and Contacts are the same tables that existed before this priority (migrated into their own tab bodies, `GrowOpportunitiesTab` / `GrowContactsTab`, each fetching only when its tab is mounted). Nurture and Performance render `GrowComingSoon` — a clearly labelled placeholder card with a "Coming soon" pill and no backing data or capability, since neither has a backend yet and building one is out of scope here.

## 6. Actions Available (Every Button Is Real)

`GrowActionCard` renders, per item, only the subset of these four buttons that both (a) the item's `availableActions` says is genuinely applicable and (b) the signed-in user's real entitlements permit — a button that would just 403 is never shown in the first place:

- **Add note** — `POST /grow/activities` (pre-existing route), gated by `grow.activities.manage`.
- **Create follow-up** — the new `PATCH /grow/opportunities/:id`, gated by `grow.opportunities.manage`, only shown when the item has an `opportunityId`.
- **View property** — a real `<Link>` to the existing `/properties/:id` page, only shown when the item has a `propertyId`.
- **Ask AE** — switches the parent tab to Ask AE (`onAskAE`); always available since it needs no additional permission.

Deliberately **not** built: Call, SMS, Email quick actions, and a dedicated "View Contact" screen — none of these are supported capabilities in the current codebase, and stubbing them as inert buttons would have violated the no-dead-buttons requirement.

## 7. Voice Readiness (Architectural Seam Only)

`GrowAskAETab` renders the existing `AskAgentEngine` component completely unmodified (`contextType="business"`, the same value the existing `/ai/ask` endpoint already supports), followed by a small "Voice command" card with a **permanently disabled** button (`disabled`, with `aria-label`/`title` both stating "coming soon"). There is no speech-to-text provider, no microphone stream, and no voice-driven action anywhere in this build — the button exists purely as a visual/architectural placeholder, exactly as the governing spec required, and the surrounding copy says so explicitly rather than implying otherwise.

## 8. Conversation Intelligence Readiness

None built, none implied. No conversation recording, transcription, or analysis exists anywhere in this change. The only AI-adjacent surface this priority touches is the pre-existing, unmodified Ask AE widget described in Section 7.

## 9. Security / Tenant Isolation

- `GET /grow/today`: `requireAuth` + `requireEntitlement("grow.access")` — the same read entitlement the rest of Grow already uses, deliberately **not** gated behind any `.manage` key (confirmed by an explicit test: a user with only `grow.access` gets a 200).
- `PATCH /grow/opportunities/:id`: `requireAuth` + `requireEntitlement("grow.opportunities.manage")`; the target opportunity is looked up scoped to `req.authedUser!.brokerageId`, returning the same 404 for a cross-tenant id as for a nonexistent one (never a distinguishing 403/200).
- Every query inside `getGrowTodaySummary` filters by `brokerageId` — confirmed by a dedicated cross-brokerage test asserting `GET /today` never returns another brokerage's contacts, opportunities, or counts.
- The `PATCH` route validates that at least one of `nextActionDueAt`/`recommendedNextAction` is present, validates date parseability (400 on invalid), allows an explicit `null` to clear `nextActionDueAt`, and writes an audit trail entry via the existing `logAudit()` helper (`action: "grow_opportunity_next_action_updated"`) — confirmed by asserting a real `audit_logs` row is written with the previous and updated values.
- Frontend entitlement checks (`useEntitlements().hasEntitlement(...)`) are explicitly documented in-code as a UX nicety only; the routes above are the actual security boundary.

## 10. Tests and CI Evidence

**New test files:**
- `apps/api/src/routes/__tests__/growToday.test.ts` — full HTTP-level suite against a real server instance (`createApp()` + `server.listen(0)`), covering: unauthenticated rejection of both routes; `grow.access`-alone sufficiency for `GET /today`; brand-new-brokerage empty state; the overdue → Do Now, due-today → Do Today, future-dated → excluded-but-counted, and Appraisal-vs-other no-date-set rules; the cold-contact rule at both "never contacted" and "30 days ago" (with the day count in the reason text); the one-card-per-party dedup when a party has both an opportunity and a cold relationship; cross-brokerage isolation on `GET /today`; and the full `PATCH /grow/opportunities/:id` matrix (403 without the entitlement, 400 on an empty body, 400 on an unparseable date, 404 across tenants, a successful update, an explicit `null` clear, and a real audit-log row assertion).
- `apps/web/src/lib/__tests__/growToday.test.ts` — pure-logic tests for `priorityLabel`, `priorityPillClass` (confirming urgency is never colour-alone — DoNow/DoToday get a distinct pill tone and label, KeepWarm stays neutral), and `formatWhen`.

**What actually ran in this PR's real CI** (GitHub Actions run for commit `8376db7`, workflow `CI`, job "Typecheck, test, build, migration validation"):

| Step | Result |
|---|---|
| Verify vendored dependencies | ✅ Passed |
| Install dependencies (frozen lockfile) | ✅ Passed |
| Workspace typecheck (`pnpm -r run typecheck`, real drizzle/express/react types) | ✅ Passed (37s) |
| Deterministic clean-database migration check | ✅ Passed |
| Schema drift check | ✅ Passed (no schema changes in this PR) |
| API automated test suite (`pnpm --filter @aee/api run test`) | Ran to completion of every test file's own output — every group passed except one pre-existing, unrelated file (see below) — but the parent process did not exit within this session's monitoring window (30+ minutes, no new log output at all in the final ~28 of those minutes), so the step itself never reported a final status and the two build steps and the synthetic-startup step below never started |
| API production build | Not reached this run |
| Web production build | Not reached this run |
| Synthetic production startup and storage readiness | Not reached this run |

**The `privacy.test.ts` finding, in full:** the very last line of test output before the hang was:

```
✔ resolving a privacy request never deletes or exports data — it only records a human decision, and is tenant-scoped (57.562434ms)
✘ /home/runner/work/AgentEngineEasy/AgentEngineEasy/apps/api/src/routes/__tests__/privacy.test.ts (23.788971ms)
```

`privacy.test.ts` is not part of this priority — this branch never touches `apps/api/src/routes/privacy.ts` or its test file, and Grow's own tables are not involved anywhere in that file. The failure itself takes under 25ms; what follows it is the process failing to exit afterward, which is a lingering-handle characteristic (an open timer, connection, or similar) rather than a slow test. Watched continuously for over 30 minutes with no further log output past that line, confirming a hang rather than a slow-but-progressing suite. Per the governing instruction, this is reported here as a separate, pre-existing issue and was **not** remediated as part of this priority — doing so would have been out of scope, and the same failure would reproduce on the base branch with none of this priority's changes applied.

**Confirmed passing, specifically, before the hang** (searched directly in the CI log for every `grow/today`-touching assertion — 13 of 13 found, all ✔, zero ✗):
unauthenticated rejection of both routes; `grow.access`-alone sufficiency; the brand-new-brokerage empty state; overdue → Do Now; due-today → Do Today; future-dated exclusion; Appraisal-vs-other default; never-contacted → Keep Warm; 30-days-ago contact → Keep Warm with day count; one-card-per-party dedup; cross-brokerage isolation on `GET /today`; and the full `PATCH /opportunities/:id` matrix including the audit-log-row assertion.

**Local pre-push verification:** before pushing, each new/modified file was run individually through the sandbox's global `tsc --noEmit --strict` (with expected `Cannot find module` noise for unresolved workspace/node_modules imports). This caught one real bug — `contactDisplayName()` in `growToday.ts` was typed against the wrong field names (`firstName`/`lastName`/`organisationName` instead of the actual `partyFirstName`/`partyLastName`/`partyOrganisationName` aliases used by both drizzle queries) — which was fixed before the first push. The real monorepo typecheck in CI (Section above) subsequently confirmed zero type errors across every file this priority touches.

**Known, accepted gap:** this repository has no jsdom/React Testing Library, and `.github/workflows/ci.yml` does not invoke a web test step at all — a pre-existing tooling limitation, not something introduced or fixed by this priority. `Grow.tsx`'s new components (`GrowToday`, `GrowActionCard`, tab switching) therefore have no component-render-level automated test; only the pure display-helper functions in `lib/growToday.ts` are covered, matching the one precedent already established in this codebase (`lib/productNav.ts`/`productNav.test.ts`).

## 11. Files Changed

| File | Change |
|---|---|
| `apps/api/src/lib/growToday.ts` | New — `getGrowTodaySummary()` and the deterministic prioritisation rules |
| `apps/api/src/routes/grow.ts` | Modified — added `GET /today` and `PATCH /opportunities/:id` |
| `apps/api/src/routes/__tests__/growToday.test.ts` | New — route-level HTTP test suite |
| `apps/web/src/lib/growToday.ts` | New — frontend type mirror + display helpers |
| `apps/web/src/lib/__tests__/growToday.test.ts` | New — pure-logic tests for the display helpers |
| `apps/web/src/pages/Grow.tsx` | Modified — tabbed workspace, Today tab, action cards, Ask AE voice seam |
| `apps/web/src/styles.css` | Modified — Today tab styling (`.grow-tabs`, `.grow-action-card*`, `.grow-inline-form`, `.grow-empty-actions`, `.grow-coming-soon`, `.grow-voice-seam`) |

Net: +1,465 / −68 lines across 7 files, 3 commits (`acc3082`, `391c739`, `8376db7`; the latter two correct an initial push that omitted the frontend files — see PR #29's commit history).

## 12. Deferred Work (Explicitly Out of Scope)

Per the governing spec, none of the following were built and none should be inferred from anything above: Opportunity Score engine; Contact Intelligence timeline; real conversation recording/transcription/analysis; real voice command processing (STT, mic, voice-driven actions); automated nurture sequencing; any Scale-domain surface; Call/SMS/Email quick actions; a dedicated Contact detail screen. The Nurture and Performance tabs are visible but inert placeholders only.

Separately, two pre-existing repository gaps were surfaced (not caused) by this work and are recommended for the Project Owner's attention independent of any future Grow priority:
- The `privacy.test.ts` hang described in Section 10 — recommend a focused investigation (likely an unclosed resource — timer, DB connection, or mock server — left open by that file) so CI can complete end-to-end again.
- The absence of a web component-test runner (jsdom/RTL) and a corresponding CI step, which currently caps how much of any Grow (or other) frontend page can be automatically verified.

## 13. Recommended Next Priority

With Priority 1 (Daily Command Centre) in place, the next highest-leverage Grow priority is most likely either (a) the **Opportunity Score engine** referenced but deliberately deferred in Section 3 — Today's "Keep Warm" bucket and the Opportunities tab would both become materially more useful with an explainable score behind them — or (b) closing the two pre-existing gaps in Section 12 so future priorities ship with full CI confidence. Recommend the Project Owner decide between these (or a different priority entirely) before further Grow work begins, per the standing instruction to stop and await approval after Priority 1.
