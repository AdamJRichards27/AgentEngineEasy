# Agent Engine 2.0 — Consolidated Build-State and Merge Audit

**Step 1 — Integration Readiness Program**

Repository: `AdamJRichards27/AgentEngineEasy` · Audit date: 2 September 2026 · Auditor: Claude (this session) · Audit type: read-only verification. No product code was changed, no tests were weakened, no protected branch was merged, no destructive git operation was performed.

---

## 0. Scope and method, stated plainly

This is a verification audit, not a build. Every claim below is labeled by how it was established:

- **[LIVE]** — independently reproduced in this session (a fresh test/build/typecheck run, a live browser walkthrough, a direct GitHub API read of the actual file/commit/PR content).
- **[DOC]** — taken from a prior PR's own description or an earlier report, not independently re-run this session. Used only when [LIVE] verification wasn't feasible in the time available, and always marked as such.
- **[GAP]** — explicitly not verified this session; stated as an open item rather than assumed.

The classification system requested (DESIGNED / IMPLEMENTED / MERGED / CONNECTED / ENFORCED / TESTED / USER ACCESSIBLE) is applied in Section 4. A capability only gets a label when there is evidence for it; the absence of a label is itself a finding, not an oversight.

### 0.1 Environment facts established at the start of this audit

- This sandbox's git remote (`gitsafe-backup`) is an internal proxy, not `github.com` directly; direct `git push`/`clone` to GitHub is not usable from this shell. All GitHub reads/writes in this audit went through the GitHub MCP tool (`get_file_contents`, `pull_request_read`, `list_*`, `get_commit`), which **is** talking to the real repository.
- No `AGENTS.md`/`CLAUDE.md` exists at the repo root. `.agents/` is empty of repo-specific instructions (Replit-internal only). `README.md` states the branch policy in one place: `main` — protected, releases only; `staging` — active development, feature branches fork from it.
- There is **one** Postgres database for the whole Replit workspace (`DATABASE_URL`, Replit-injected). There is no local ephemeral test database — every local test run (this audit's baseline included) shares that one database. The GitHub Actions CI workflow (added in PR #4) provisions its own disposable Postgres service per run; that is the only place a true "clean database" test happens. This session's `pull_request_read(method: get_status)` call for PR #17's head commit again returned `403 Resource not accessible by integration` — this is a token-permission limit of the GitHub MCP server's credentials in this environment, not a claim about CI's actual result. CI status could not be independently confirmed from here; the Checks tab on the PR itself is authoritative and wasn't accessible to this session.

---

## 1. Repository identity and PR/branch inventory — Task 1–2 [LIVE]

### 1.1 A methodology finding, surfaced and resolved before it became a false alarm

`list_pull_requests` (the bulk listing endpoint) reported `merged: false` with a populated `merged_at` timestamp for every one of PRs #1–#16 — an internally contradictory pair of fields that would, taken at face value, look like 16 PRs were closed without merging. Cross-checking each one individually with `pull_request_read(method: "get")` (the single-PR endpoint, which carries the authoritative `merged` boolean and `merged_by`) showed all 16 are genuinely `merged: true`, `merged_by: "AdamJRichards27"`. The bulk listing endpoint's `merged` field is not reliable in this environment; the per-PR `get` call is. This is recorded here because the brief explicitly warns against treating "open" and "merged" as equivalent without checking — the inverse trap (a tool field claiming *not* merged when it was) is just as real, and this audit almost inherited it. All merge-status claims below rest on the per-PR `get` call, not the list call.

### 1.2 Full PR inventory, all 17 PRs that exist (PR #10 does not — see 1.4)

| PR | Title | Head → Base | Merged | Merged at |
|---|---|---|---|---|
| #1 | Pre-WAE Gate Recovery (F-03/F-04/F-05 + gate report) | `recovery/pre-wae-gate` → `staging` | Yes | 2026-08-29 03:30 |
| #2 | fix(db): restore missing `migrations/meta/0000_snapshot.json` | `chore/migration-snapshot-repair` → `staging` | Yes | 2026-08-29 05:06 |
| #3 | Staging (promotion) | `staging` → `main` | Yes | 2026-08-29 05:20 |
| #4 | ci: install repository verification workflow | `chore/install-ci-workflow` → `staging` | Yes | 2026-08-29 08:10 |
| #5 | WAE Foundation (rules, conditions, engine, AGENCY_AGREEMENT_SIGNED slice) | `feat/wae-foundation` → `staging` | Yes | 2026-08-29 23:32 |
| #6 | WAE Stage 2: Controlled Production Workflows | `feat/wae-controlled-workflows` → `staging` | Yes | 2026-08-30 01:36 |
| #7 | WAE Operational Readiness — retry, cancellation, health & operator API | `feat/wae-operational-readiness` → `staging` | Yes | 2026-08-30 05:55 |
| #8 | Run Transaction Vertical Slice (Appraisal → Closure) | `feat/run-transaction-vertical-slice` → `staging` | Yes | 2026-08-31 01:28 |
| #9 | Fix buyer/other-party AML/CTF UI gap + close cross-tenant AML request hole | `feat/property-timeline` → `staging` | Yes | 2026-08-31 02:29 |
| #11 | Property Timeline (Priority 3) | `feat/property-timeline-core` → `staging` | Yes | 2026-08-31 04:59 |
| #12 | Exception & Risk Engine (Priority 4) | `feat/exception-risk-engine` → `staging` | Yes | 2026-08-31 19:41 |
| #13 | Property Launch & Campaign Coordination (Priority 5) | `feat/launch-campaign-coordination` → `staging` | Yes | 2026-08-31 19:42 |
| #14 | Agent Daily Command Centre (Priority 6) | `feat/agent-daily-command-centre` → `staging` | Yes | 2026-09-01 10:28 |
| #15 | Pit Crew Command Centre (Priority 7) | `feat/pit-crew-command-centre` → `staging` | Yes | 2026-09-01 11:32 |
| #16 | Communications Hub (Priority 8) | `feat/communications-hub` → `staging` | Yes | 2026-09-01 18:19 |
| #17 | Financial Transaction Engine (Priority 9) | `feat/financial-transaction-engine` → `staging` | **No — open** | — |

Every PR's recorded base SHA chains cleanly to the previous PR's resulting `staging` HEAD (spot-verified for #4→#5→#6→#7→#8→#9, and for the #12/#13 back-to-back pair, whose bodies themselves document the deliberate merge order). `staging`'s current HEAD (`ea3bc79...`, "Merge pull request #16 … as the required base-and-merge gate for Priority 9") equals PR #17's own recorded base SHA exactly. Conclusion: **staging has not moved since PR #17 was opened; the merge sequence #1→#16 is a clean, unbroken, non-diverging chain; PR #17 is a zero-conflict fast-forward candidate.**

### 1.3 Branch inventory (20 branches)

18 non-`main`/`staging` branches exist. 16 correspond 1:1 to the PRs above (14 feature branches already merged, `recovery/pre-wae-gate` merged via #1, `feat/financial-transaction-engine` still open as #17). Two do not correspond to any PR:

- `chore/ci-workflow-api-attempt` — its HEAD commit (`dc95591...`) **is** the PR #1 merge commit itself, i.e. this branch ref carries zero unique commits beyond what's already on `staging`. It reads as an abandoned first attempt at the CI-workflow task, superseded by PR #4's `chore/install-ci-workflow`.
- `workflow-scope-test` — its HEAD (`14e3676c...`) is a commit from 2026-08-28, *before* PR #1 was even opened — an early "Foundation Remediation Stage 2" checkpoint (bare `automation.ts` schema, zero rows) that was superseded by the real WAE Foundation work in PR #5.

Both are dead branch pointers with no unmerged unique work. They are safe to delete; nothing is lost by doing so. (P3 finding, §6.)

### 1.4 PR #10

`GET /pulls/10` returns `404 Not Found`. GitHub shares one number sequence across issues and PRs in a repo, so #10 was very likely an issue, not a deleted PR — this could not be fully confirmed (issue-history lookup was out of scope for the time available) and is recorded as a minor open item, not a merge-integrity concern (nothing in the branch graph depends on a "#10").

---

## 2. Staging baseline — Task 5 [LIVE]

The prior session's Financial Transaction Engine verification (typecheck/build/test 501/502) ran on `feat/financial-transaction-engine` itself, not on plain `staging` — per this program's own rules that doesn't count as a staging baseline. This audit built one properly: `git worktree add --detach /tmp/staging-baseline staging` (a fully separate checkout, the live `feat/financial-transaction-engine` workspace was never touched), then ran the full verification chain fresh, from zero:

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Clean |
| `pnpm run typecheck` (11 workspace projects) | Clean, 0 errors |
| `pnpm run build` (`apps/web` vite, `apps/api` esbuild) | Clean. `apps/web`: 108 modules, built in 1.41s. `apps/api`: 776.9kb, 46ms. (Pre-existing, non-fatal Vite Node-version advisory: workspace runs Node 20.12.2, Vite wants 20.19+/22.12+ — carried forward from earlier stages, not new.) |
| `drizzle-kit check` (`packages/db`) | **"Everything's fine."** Zero schema drift on `staging` itself. |
| `pnpm --filter @aee/api run test` | **407 tests, 405 pass, 1 fail, 0 skipped, 0 cancelled, ~165.5s.** |

The one failure is investigated in full in §3. This is the authoritative, independently-reproduced state of `staging` as it stands right now, separate from any feature branch's own self-reported numbers.

Working-tree hygiene: the live workspace's three pre-existing, unrelated local changes (`M .replit`, `M pnpm-lock.yaml`, `?? apps/api/src/scripts/`) were confirmed present and untouched before and after this audit. The temporary worktree was removed at the end of the session (`git worktree remove --force`); `git worktree list` now shows only the main workspace.

---

## 3. The one test failure, root-caused — Task 12 [LIVE]

Every PR from #13 onward reports this same failure as "pre-existing, unrelated, out of scope" without saying why it actually fails. That's not good enough for a data-integrity CRITICAL-severity test, so this audit reproduced it directly rather than repeating the inherited description.

**Test:** `apps/api/src/lib/exceptions/__tests__/engine.test.ts` → *"CRITICAL scenario: two offers independently marked Accepted for one property is detected, cannot be manually overridden, and auto-resolves once corrected"* (rule `C13_MULTIPLE_OFFERS_ACCEPTED_FOR_PROPERTY`).

**Actual error, from this session's fresh run:**
```
error: 'create offer failed: 400 {"error":"This property already has an accepted offer."}'
stack: createOffer (.../lib/exceptions/__tests__/engine.test.ts:87:33)
```

**Root cause, confirmed against the real source (`apps/api/src/lib/offers.ts`):** the test's own `createOffer()` helper calls the real `POST /api/offers/by-property/:id` route to add a "second" offer to a property that the shared fixture (`createTransactionFromListedProperty`) has already advanced past `workflowStage: "Listed"` by accepting a first offer. `lib/offers.ts` correctly refuses any offer creation once a property isn't `Listed` — that's the very safeguard the test's own comment says makes this anomaly "arise only from a data-integrity gap outside that chokepoint." The test tries to create the second offer *through* that chokepoint instead of around it (e.g. a direct `db.insert(offers)`), so it 400s before it ever reaches the line that force-flips the second offer's status to simulate the anomaly. **The test never exercises its own intended assertion.**

This means the C13 CRITICAL-severity detection rule — a rule specifically meant to catch a real data-integrity anomaly that the normal API can't produce — has had a broken regression test since PR #13 first introduced it, and every subsequent PR (#14, #15, #16, #17) has correctly-but-uninformatively repeated "1 pre-existing failure, unrelated" without anyone tracing it to the actual line. It is a **test-authoring bug, not a product defect** — nothing evaluated here suggests the C13 rule itself doesn't work, only that its own safety-net test can't currently prove that it does. Recorded as finding **RISK-001** in §6 (P2: fix the test fixture to insert the second offer directly, bypassing the route, matching what the test's own comment already claims it does).

---

## 4. Engine registration / runtime audit — Task 8 [LIVE]

Read `apps/api/src/index.ts` on `staging` and on `feat/financial-transaction-engine` directly (not summarized from a PR body).

**On `staging`, at boot:** `assertSessionSecretConfigured()` (fail-closed) → `configureEvents()` → `registerAutomationEngine()` (WAE) → `registerExceptionEngine()` (Exception & Risk Engine, incl. its scan scheduler) → `registerLaunchEngine()` → `registerCommunicationsEngine()` (incl. outbox sweep scheduler) → fire-and-forget `ensureCatalogueSeeded()` (Grow/billing) and `ensureStage2CatalogueSeeded()` (WAE workflow-template install sweep).

**On `feat/financial-transaction-engine`:** the same list, plus `registerFinancialEngine()` — confirmed present in the branch's own `index.ts`, and its implementation (`lib/financial/bootstrap.ts`) confirmed to (a) subscribe a `SETTLEMENT_COMPLETED` handler that finalises commission and, only if an ACTIVE PC fee authority exists, creates the PC success-fee request, and (b) start a 15-minute payment-outbox sweep (`dispatchPendingPaymentOutbox`), `unref()`'d so it never blocks shutdown, mirroring `registerExceptionEngine`'s own pattern exactly. **This closes a gap this audit specifically checked for and did not find**: the Financial Engine's payment outbox is not an orphaned table with nothing to drain it — it has a real, correctly-wired scheduler once PR #17 merges.

No boot-time registration exists for Pit Crew Command Centre or Agent Daily Command Centre — both are architecturally pure read-projections / operational overlays over other engines' data with no background process of their own (confirmed against their PR bodies' own explicit scope statements), so the absence is expected, not a gap.

---

## 5. Database and migration audit — Task 6 [LIVE, partial]

`staging`'s migration journal has 8 entries, `0000`–`0007`, sequential with no gaps or duplicate indices. Each was mapped to the feature that introduced it by reading the actual SQL, not by trusting the claim:

| Migration | Confirmed content | Feature |
|---|---|---|
| `0000_baseline_schema` | 44KB baseline schema | Foundation |
| `0001_brave_bloodscream` | `automation_tasks`, `automation_attention_items` | WAE Stage 2 (PR #6) |
| `0002_clammy_molecule_man` | 19 additive columns + FKs on `automationExecutions`/`automationActions` | WAE Operational Readiness (PR #7) |
| `0003_perpetual_blockbuster` | `transaction_conditions` table + `properties`/`transactions` column additions | Run Transaction Vertical Slice (PR #8) |
| `0004_white_shaman` | `risk_exceptions`, `risk_exception_transitions`, `risk_exception_scan_runs` (+ 6 indexes incl. brokerage/status/severity/due_at) | Exception & Risk Engine (PR #12) |
| `0005_wonderful_pet_avengers` | `launch_plans` + 4 related tables | Launch & Campaign Coordination (PR #13) |
| `0006_classy_deathstrike` | `pit_crew_assignments` | Pit Crew Command Centre (PR #15) |
| `0007_furry_moonstone` | 9 communications tables | Communications Hub (PR #16) |

All 8 read directly from the repository content at `staging`'s current HEAD (not inferred from a journal filename). `feat/financial-transaction-engine` carries a 9th migration, `0008` (not yet on `staging` — expected, since PR #17 is unmerged), for the 14 financial tables.

Spot-checked FK/index hygiene on `0004` (the largest, most relationally complex of the eight): every risk-exception table has a `brokerage_id`-scoped FK, a `brokerage_id, status` composite index and a `brokerage_id, severity, status` composite index — tenant-scoped indexing is real, not just a schema comment. Money fields in `financial.ts` (confirmed in the prior session, re-confirmed by inspection this session) are integer cents throughout; no floating-point currency column exists anywhere in the domain.

**Not done this session** [GAP]: an exhaustive per-table FK/index audit of all 8 migrations (only `0004` was spot-checked in full); a clean-migration-from-zero run against an empty database (this workspace's shared dev DB already has all tables applied out-of-band, as documented since PR #1 — CI's disposable Postgres service is the actual clean-from-zero check, and this session could not read its result, §0.1).

---

## 6. Findings register

Ordered most severe first. Each finding states what was actually observed, not a category.

### P1 — should be resolved before third-party integration work begins

**COHERENCE-001 — Two independent, unreconciled commission-calculation systems can show contradictory state for the same property.**
Observed live, [LIVE]: on the running `feat/financial-transaction-engine` build (logged in as the seeded Brokerage Administrator), property "27 Vertical Slice Walkthrough Rd" — a fully **Closed** transaction — shows, in its pre-existing **Transaction** section: *"Commission: $20500.00 + $2050.00 GST"*, *"Funds received: $820000.00"*. On the same page, in the new **Financial Summary** section (Financial Transaction Engine, PR #17): *"No commission agreement recorded yet"*, *"No commission calculation recorded yet"*. Root cause: `handleSettlementCompleted` (the Financial Engine's own settlement handler, §4) is a documented no-op when no `commissionAgreements` row exists for the property, and this property predates the Financial Engine's existence in this workspace, so no agreement was ever created for it — the two commission concepts (the original, simpler per-transaction calculation from the Run Transaction Vertical Slice, and the new, richer agreement-driven Financial Engine calculation) were never designed to reconcile against transactions that closed before the newer system existed, and nothing backfills that gap. A Brokerage Administrator opening this property today sees two different, disagreeing answers to "has commission been calculated" in two sections of the same page. This is exactly the "operates as one coherent application" test the governing brief asks for, and it fails it for any transaction that closed before PR #17's tables existed. **Recommendation:** either a one-time backfill job that creates a `commissionCalculations` row from historical `transactions.commission*` data for already-closed transactions, or an explicit UI reconciliation note in `FinancialSummarySection.tsx` ("this transaction closed before the Financial Transaction Engine was active; see the Transaction section above for its recorded commission") — the second is cheaper and should ship with or immediately after PR #17; the first is the real fix.

### P2 — should be resolved, not release-blocking

**RISK-001 — The CRITICAL-severity C13 exception-detection rule has an unreachable test assertion.** See §3 in full. The test has silently failed to exercise its own scenario since PR #13 (five-plus merged PRs have carried it forward as "1 pre-existing, unrelated failure"). Fix: change the test's second-offer creation to a direct `db.insert(offers)` (bypassing the route), matching the pattern the test's own comment already describes. Until fixed, the C13 rule is **DESIGNED and IMPLEMENTED but not demonstrably TESTED** at the one severity tier (CRITICAL) where a silent regression would matter most.

**AI-001 — "Ask Agent Engine" has never been exercised against a real language model in this environment.** Observed live [LIVE]: a real query ("What's the AML status on this property?") against the running app returned a correctly-scoped context payload (brokerage/property JSON, properly tenant-restricted) but the response body states outright: *"This is a Mock AI Provider response — no real model call was made. Set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY in Replit Secrets to use a real model."* The read-only guardrail and context-scoping machinery are real and working; actual natural-language answer quality, prompt-injection resistance under a real model, and latency are all **untested** in this environment. Not blocking for internal consolidation; is blocking for any user-facing "the AI actually answers correctly" claim.

### P3 — hygiene, non-blocking

**DOC-001** — `packages/events/src/types.ts`'s header comment still reads *"The 19 canonical AgentEngineEasy domain events"*; the file now defines roughly 90. Harmless, but will mislead the next engineer who trusts the comment over the array.

**REPO-001** — Two stale branches with zero unique unmerged content: `chore/ci-workflow-api-attempt` (its tip *is* the PR #1 merge commit) and `workflow-scope-test` (a pre-WAE-Foundation checkpoint, fully superseded). Safe to delete.

**PROC-001** — `GET /pulls/10` 404s; likely an issue number, not a deleted PR, but not confirmed this session. No branch or merge depends on it.

**CI-001** — CI status on PR #17's head commit could not be read from this session (`403` on the GitHub MCP token for the combined-status/check-runs endpoints, consistent across two separate sessions now). Not a repository problem — a credential-scope limit of the tool available here. Check the PR's own Checks tab directly before merging.

---

## 7. Capability matrix

Classification per capability against: **D**esigned · **I**mplemented · **M**erged to staging · **C**onnected at runtime · **E**nforced (auth/tenancy) · **T**ested · **U**ser accessible. A capability list this size wasn't reproduced verbatim from the original brief text (lost to context compaction earlier in this session) — it was reconstructed from the actual, verified build history above, which is the more defensible source anyway. ✅ = verified this session or by direct primary-source read. 〜 = evidenced but not independently re-verified this session (relies on a prior stage's own test/report, not re-run). ❌ = confirmed gap.

| # | Capability | D | I | M | C | E | T | U |
|---|---|---|---|---|---|---|---|---|
| 1 | Auth & session (dev-login, fail-closed prod gate) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 2 | Multi-tenant brokerage isolation | ✅ | ✅ | ✅ | ✅ | ✅ | 〜 | ✅ |
| 3 | Core property/party/offer/transaction domain | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 4 | Domain event architecture (packages/events) | ✅ | ✅ | ✅ | ✅ | n/a | ✅ | n/a |
| 5 | AI Gateway / Ask Agent Engine (copilot) | ✅ | ✅ | ✅ | ✅ | ✅ | 〜 | ✅ (mock model only — AI-001) |
| 6 | AI Governance (authority, action registry, approval) | ✅ | ✅ | ✅ | ✅ | 〜 | 〜 | 〜 |
| 7 | Grow / subscription & billing entitlements | ✅ | ✅ | ✅ | ✅ | 〜 | 〜 | 〜 |
| 8 | Import (CSV/XLSX ingestion, dedup) | ✅ | ✅ | ✅ | ✅ | 〜 | ✅ | 〜 (task #40 in this program's own history notes UI walkthrough still outstanding) |
| 9 | Workflow Automation Engine — Foundation | ✅ | ✅ | ✅ | ✅ | 〜 | ✅ | n/a (no direct UI; operates via events) |
| 10 | WAE — Controlled Workflows (Stage 2) | ✅ | ✅ | ✅ | ✅ | 〜 | ✅ | n/a |
| 11 | WAE — Operational Readiness (retry/cancel/ops API) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 〜 (admin-only ops API, not walked live this session) |
| 12 | Run Transaction Vertical Slice (Appraisal→Closure) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 13 | AML/CTF verification (all party types) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 〜 |
| 14 | Property Timeline (read-model) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 15 | Exception & Risk Engine | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ at CRITICAL tier (RISK-001) | ✅ |
| 16 | Property Launch & Campaign Coordination | ✅ | ✅ | ✅ | ✅ | 〜 | ✅ | ✅ |
| 17 | Agent Daily Command Centre ("Today") | ✅ | ✅ | ✅ | n/a (pure projection) | ✅ | ✅ | ✅ |
| 18 | Pit Crew Command Centre | ✅ | ✅ | ✅ | n/a (pure projection) | 〜 | ✅ | ✅ |
| 19 | Communications Hub | ✅ | ✅ | ✅ | ✅ | 〜 | ✅ | ✅ |
| 20 | Financial Transaction Engine | ✅ | ✅ | **❌ — PR #17 open, not merged** | ✅ (verified on branch) | ✅ | ✅ | ✅ (verified on branch; ❌ coherence gap, COHERENCE-001) |
| 21 | Audit logging / audit trail | ✅ | ✅ | ✅ | ✅ | n/a | 〜 | n/a |
| 22 | Documents / e-sign | ✅ | ✅ | ✅ | ✅ | 〜 | 〜 | ✅ |
| 23 | Settlement & commission calculation (legacy path) | ✅ | ✅ | ✅ | ✅ | 〜 | ✅ | ✅ — but see COHERENCE-001 |
| 24 | CI workflow (GitHub Actions) | ✅ | ✅ | ✅ | 〜 (exists; result unreadable this session, CI-001) | n/a | n/a | n/a |
| 25 | DB schema & migration infrastructure | ✅ | ✅ | ✅ | ✅ | n/a | ✅ (drizzle-kit check clean) | n/a |

---

## 8. Merge plan (not executed — recorded only)

1. **Merge PR #17 to `staging`.** Zero conflict risk (confirmed §1.2 — `staging` HEAD equals PR #17's own base SHA; no other PR has landed since). Recommended pre-merge gate: confirm the actual CI Checks tab result on PR #17 directly (this session's tooling can't read it — CI-001), since the last thing this audit can say is "unstable, checks in flight" from the PR's own `mergeable_state`, not a resolved pass/fail.
2. **Before or immediately after that merge**, ship a fix for RISK-001 (the C13 test) and at least the cheap mitigation for COHERENCE-001 (a UI note distinguishing legacy vs. Financial-Engine commission data on already-closed transactions) — both are small, isolated changes with no dependency on anything else in flight.
3. **Delete the two dead branches** (`chore/ci-workflow-api-attempt`, `workflow-scope-test`) — zero risk, confirmed no unique content (§1.3).
4. No other branch requires a merge decision — everything else named in this repository's history is already on `staging`.

---

## 9. Remediation roadmap

**Phase 1 (before/with PR #17 merge):** RISK-001 fix (C13 test), COHERENCE-001 UI mitigation, delete the two dead branches.
**Phase 2 (soon after):** COHERENCE-001 real fix (backfill historical commission calculations, or an explicit one-time reconciliation script), DOC-001 (fix the stale event-count comment).
**Phase 3 (before relying on AI features in front of a real user):** AI-001 — configure a real model provider in at least a staging-like environment and re-walk the copilot with real queries, including adversarial ones, before any claim of "AI answers correctly" ships.
**Phase 4 (housekeeping, whenever convenient):** resolve PROC-001 (confirm what #10 was), and — separately from this audit's own scope — the broader tenant-scoping gaps already flagged by PR #9's own body as deliberately out-of-scope-for-that-PR (`routes/parties.ts`, several `routes/aml.ts` sub-routes lacking the same `assertPartyOnPropertyInBrokerage`-style check) remain open and worth a dedicated pass.

No new feature work is recommended here, consistent with the governing instruction not to propose expansion ahead of P1/P2 resolution.

---

## 10. Final decision

**READY FOR CONSOLIDATION REMEDIATION.**

Reasoning: nothing found in this audit is a critical architectural or security failure — tenancy scoping, fail-closed auth gating, sandboxed payment/comms providers, and the trust-boundary constraint on the Financial Engine (a system of record, never a mover of funds) all held up under direct source inspection and, where checked, live testing. The 14 already-merged feature branches sit on `staging` in a clean, non-diverging, freshly-reproduced-green state (405/407, one precisely root-caused test-authoring bug). The one open PR (#17) is a zero-conflict fast-forward candidate whose own engine registration was independently confirmed correct.

It is not the stronger "READY FOR BROKERAGE RULES & INTEGRATION FOUNDATION" label, because this audit found one concrete, live-reproduced case (COHERENCE-001) where two already-merged/about-to-merge systems disagree about the same fact on the same screen — precisely the "operates as one coherent application" bar this program has set for itself — plus one safety-relevant test that has not actually been testing what it claims to test since the PR that introduced it (RISK-001). Both are small, well-scoped, and do not require reopening any architectural decision — which is why this is a remediation label, not a blocked one.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01C6398UV8VKXaKSVDRpLsQh
