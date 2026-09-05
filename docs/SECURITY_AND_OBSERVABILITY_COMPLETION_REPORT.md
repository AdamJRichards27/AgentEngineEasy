# Security and Observability Completion Report

Agent Engine 2.0 — Step 2: Harden Security and Observability. This is the final,
evidence-based report for this step, prepared against `AdamJRichards27/AgentEngineEasy`,
branch `feat/security-observability-hardening`, PR #25 against `staging`.

**A note on this report's own limitation, disclosed up front rather than buried.** This
step's original governing instruction was extremely long and formally structured, and its
literal text was lost across multiple context-window compactions during this session. The
retained summary preserved the instruction's *structure* (Parts A–H of a final bounded
closure pass, the specific release-blocking treatment of tenant isolation, the requirement
to observe an actual CI run rather than infer success, the requirement that Claude never
self-accept a dependency-risk decision, and the requirement to close with exactly one of a
defined set of decision labels) but not every verbatim enumerated list inside it — specific
field names, named-flow counts, the 13 named metric gaps, the 12 trust boundaries/13 error
categories, and the "18-item regression list." Every document produced this step states
this plainly wherever it applies and substitutes a reasoned, disclosed equivalent, flagged
for a human reviewer to diff against the original spec text if it's available outside this
session. This same disclosure applies to the "CI Unblocking and Final Merge-Readiness"
follow-on instruction this report's top section covers — its own verbatim phase text is
retained in full for that pass (it arrived in this session's active context), so no
reconstruction was needed there.

**This revision** covers a subsequent "CI Unblocking and Final Merge-Readiness" closure
pass — see the update section immediately below — on top of the Parts B–H closure work
already recorded in the rest of this document, which itself sat on top of the original
Part A tenant-isolation/perimeter work. **The current decision is in the update section
below; the "## 1. Decision" section further down is the prior revision's decision and is
superseded.**

## Update — CI Unblocking and Final Merge-Readiness pass

This pass's own governing instruction required moving the prior revision's
decision (`BLOCKED — CI WORKFLOW PERMISSION REQUIRED`) forward to one of
`READY TO MERGE`, `BLOCKED — MAINTAINER WORKFLOW ACTION REQUIRED`,
`BLOCKED — CI FAILURE REMAINS`, or `BLOCKED — HUMAN RISK DECISION
REQUIRED`, via a real local git clone with normal git operations — and
explicitly forbade transmitting generated lockfiles or migration snapshots
through the API mechanism already shown to corrupt large files.

### 1. Final decision

**`BLOCKED — MAINTAINER WORKFLOW ACTION REQUIRED`**

### 2. PR head and base SHAs

- Head: `feat/security-observability-hardening` @
  `ba9d86980bea8379e055a54c3dbe008561bcc51d` (unchanged this pass — no
  commit was pushed, since every prepared fix is blocked from landing; see
  §6/§11).
- Base: `staging` @ `8eb5c24a5905415b2b4bb30febead263f0a553fc`.
- Confirmed via `pull_request_read` (`get`) at the start of this pass, and
  the same head SHA is what run #127 below was triggered against.

### Phase 1 — no real git working environment was available

This pass first attempted, exactly as instructed, to establish a genuine
local clone with normal git push access before touching anything:

- `GITHUB_TOKEN`/`GH_TOKEN` are present in this session's environment, but
  the GitHub REST API (`GET /repos/AdamJRichards27/AgentEngineEasy`) using
  that token returns a custom, non-GitHub error: *"GitHub access to this
  repository is not enabled for this session. Use add_repo to request
  access."* — a session-repo gate this session has no tool to satisfy.
- `git clone https://x-access-token:$GITHUB_TOKEN@github.com/...` against
  **real github.com** (not a proxy stub — confirmed by GitHub's own error
  text) returned `remote: Invalid username or token. Password
  authentication is not supported for Git operations.` — this token is not
  a valid git-over-HTTPS credential.
- No SSH key exists in `~/.ssh/` (empty directory), no `GIT_ASKPASS` script
  is configured, and no `credential.helper` is configured for
  `github.com` — only an SSH→HTTPS URL rewrite with no credential behind
  it.
- Every git operation this pass performed instead used the same
  `mcp__GitHub_MCP__*` tool surface as prior passes (already known, from
  earlier in this PR's history, to lack `.github/workflows/**` write
  scope and to be unreliable above roughly 50KB of exact byte content per
  call).

This is a hard, structural block matching this pass's own Phase 1 stop
condition verbatim ("If a real clone, authenticated Git push, or clean
branch state is unavailable, stop with `BLOCKED — MAINTAINER WORKFLOW
ACTION REQUIRED`"), and it is the same underlying capability gap Phase 5's
own stop condition names for workflow-file writes specifically — so both
phases converge on the same decision label. Per that instruction's own
"do not recreate PR #25 or open a replacement PR," none was created, and
no destructive or substitute action was taken.

Given this, every fix below was fully prepared, fully verified against a
real local Postgres database and the actual toolchain, and packaged as an
exact file bundle for a human with real git access to apply directly —
rather than stopping at diagnosis alone.

### 3. CI run IDs and final status

Re-confirmed live, this pass, via GitHub's own Actions UI (the
`mcp__GitHub_MCP__pull_request_read` methods `get_status` and
`get_check_runs` both still return `403 Resource not accessible by
integration` — this session's GitHub App still lacks `checks:read` /
`statuses:read`, unchanged from every prior pass):

- Workflow **CI**, run **#127**, run ID `33976931377`, job ID
  `101335170875`, job name "Typecheck, test, build, migration validation".
- Triggered by commit `ba9d86980bea8379e055a54c3dbe008561bcc51d` (this
  PR's current head — the previous pass's completion-report-only commit;
  no application code changed since, so this is a fresh reconfirmation of
  the pre-existing failure, not a new one).
- **Status: failed**, at the **Schema drift check** step, in 1m12s — same
  step, same failure class as all 126 runs before it. Exact error
  captured live: `Error: packages/db/migrations is out of date with
  packages/db/src/schema. Run 'pnpm --filter @aee/db run db:generate'
  locally and commit the result.`
- Root cause confirmed unchanged from the diagnosis in
  `docs/CI_SCHEMA_DRIFT_FIX.md`: a stale migration-tracking journal. This
  pass re-derived and more rigorously verified the fix — see §4 and that
  document's own update section.

### 4. Migration snapshot repair and validation

Re-derived from a clean, tool-only `drizzle-kit generate` run (a stray,
previously-generated local snapshot file left over from an earlier session
was found masking the real drift and removed first, so this pass's local
state genuinely matched the branch before regenerating). Full detail,
including the correction to the prior pass's approach, is in
`docs/CI_SCHEMA_DRIFT_FIX.md`'s update section. Summary:

- One new, tool-generated migration
  (`packages/db/migrations/0009_flimsy_norrin_radd.sql`, 15,974 bytes)
  consolidates the same schema delta as the three already-committed but
  never-registered legacy files (`0009_tired_warbird.sql`,
  `0010_integration_and_data_exchange_foundation.sql`,
  `0011_session_epoch_revocation.sql`) — **verified statement-for-statement
  identical** (57/57 SQL statements match in both directions; 0 added, 0
  removed).
- `packages/db/migrations/meta/0009_snapshot.json` (421,545 bytes) and an
  updated `packages/db/migrations/meta/_journal.json` (1,517 bytes, one new
  entry) generated by the tool itself, not hand-assembled.
- Applied to a brand-new, empty Postgres 16 database via
  `pnpm --filter @aee/db run db:migrate`: succeeds, 89 tables created
  (matches CI's own schema listing), `users.session_epoch` present, all 10
  `integration_*` tables present, the relevant unique index present, a
  second run is a safe no-op (idempotent), and a subsequent
  `drizzle-kit generate` reports **"No schema changes, nothing to
  migrate"** — confirming the Schema drift check would pass.
- Not pushed: same two blockers as the prior pass, both re-confirmed live
  this pass (workflow-scope 403 re-tested directly — see §6; large-file
  transmission not re-attempted, per this pass's own instruction not to
  risk it). Delivered instead as an exact file bundle — see §11.

### 5. `esbuild` and lockfile changes

The previously-verified low-severity `esbuild` fix
(GHSA-g7r4-m6w7-qqqr, `apps/api`'s own direct devDependency) was
re-verified from a clean baseline this pass, specifically to rule out
unrelated dependency churn:

- Started from an exact copy of the branch's own current
  `apps/api/package.json` and `pnpm-lock.yaml` (fetched from GitHub, not
  a locally-drifted copy), changed exactly one line
  (`"esbuild": "^0.27.0"` → `"^0.28.1"`), and ran `pnpm install`.
- **Diff-verified minimal:** the resulting lockfile diff touches only
  `esbuild` itself (`0.27.7` → `0.28.2`), its 26 per-platform optional
  binary packages (required collateral of any esbuild version bump), and
  one shared `vite`-internal dedup entry. A first, uncorrected attempt
  earlier in this pass (built on a multi-day-drifted local lockfile
  instead of a fresh copy of the branch's own file) had picked up ~15
  unrelated package bumps (rollup, tanstack query, postcss, browserslist
  data, etc.) with no relationship to esbuild — that attempt was
  discarded and redone from the clean baseline specifically to avoid this;
  the final delivered lockfile has none of that unrelated churn.
- Verified: frozen-lockfile install succeeds; `apps/api` typecheck clean;
  `apps/api` production build succeeds (`dist/index.mjs`, 1.0mb, esbuild
  0.28.2); `apps/web` production build succeeds unchanged; full 663-test
  regression suite and the 88-test tenant-isolation subset both pass
  unchanged (see §7); `pnpm audit` unchanged at 3 remaining advisories,
  confirmed not to reintroduce or mask anything (see §8).
- Not pushed: no authenticated git push available (§2); delivered as an
  exact file bundle instead — see §11.

### 6. Workflow permission change — exact maintainer patch (blocked)

A complete, ready-to-commit `.github/workflows/ci.yml` was prepared with a
job-level `permissions: contents: read` block — the narrowest permission
this workflow's single job needs. Every step in the job was checked
individually: `actions/checkout` is the only step that consumes the
`GITHUB_TOKEN`'s `contents` permission (to fetch the ref under test); no
step in this job calls the GitHub API, pushes, or creates/updates any
repository resource (no PR comments, no releases, no other checks/statuses
writes), so **no non-read permission is granted** — the full block is
`contents: read` and nothing else. Unified diff: 12 lines added, nothing
else touched; both YAML-validated.

**Confirmed blocked, freshly this pass:** a direct push attempt of this
exact file returned
`403 refusing to allow a GitHub App to create or update workflow
'.github/workflows/ci.yml' without 'workflows' permission` — this
session's GitHub App installation has `contents: write` but not the
separate `workflow` scope GitHub requires specifically for
`.github/workflows/**`. This is an installation-level setting; no
in-session workaround exists (re-confirmed, not merely carried forward
from the prior pass's finding).

Delivered as `ci_yml_fix/ci.yml` (complete file) and `ci_yml_fix/ci.yml.diff`
(exact diff) in the maintainer patch bundle — see §11.

### 7. Tests, type checks and builds — exact totals

All of the following were re-run this pass, with both the migration fix
and the esbuild fix applied locally (not just the pre-existing baseline):

| Check | Result |
|---|---|
| Full `apps/api` regression suite (4 chunks) | **663 tests, 662 pass, 0 fail, 1 skip** — identical to the pre-fix baseline recorded in `docs/STEP2_REGRESSION_VERIFICATION.md` |
| Tenant-isolation regression subset (9 findings, 8 test files) | **88/88 pass** — unchanged |
| Workspace `tsc --noEmit` (all 13 packages, via `pnpm -r run typecheck`) | **clean**, no errors, mirrors CI's own "Workspace typecheck" step |
| `apps/api` production build | **succeeds** (`esbuild`, `dist/index.mjs`, 1.0mb) |
| `apps/web` production build | **succeeds** (Vite, 113 modules, `dist/index.html` + assets) |
| `pnpm --filter @aee/db run db:migrate` (fresh database) | **succeeds**, 89 tables, idempotent on re-run |
| `drizzle-kit generate` (post-fix) | **"No schema changes, nothing to migrate"** |
| `pnpm install --frozen-lockfile` (post-esbuild-fix lockfile) | **succeeds** |

No newly failing test anywhere; the single pre-existing skip is the same
one carried since before this PR's Part C baseline and was not
investigated (unchanged, out of this pass's bounded scope).

### 8. Dependency audit results

`pnpm audit` (re-run against the current, unfixed branch state, and again
against this pass's locally-applied esbuild fix): **unchanged at 3
distinct advisories** in both cases — 2 high (`xlsx@0.18.5`, no patched
version exists for either) and 1 moderate (`esbuild`, transitive, entirely
inside `packages/db > drizzle-kit`'s own dev-only dependency tree). The
low-severity finding this pass's esbuild fix addresses
(GHSA-g7r4-m6w7-qqqr) is confirmed absent after the fix and was already
the only advisory tied to `apps/api`'s own direct esbuild dependency — no
vulnerability was reintroduced or masked by this pass's dependency change
(§5's diff-verification directly supports this: only esbuild's own
resolution changed).

### 9. Human risk decisions still required

Both remaining advisories now have a full structured decision record in
the rewritten `docs/DEPENDENCY_RISK_ACCEPTANCE.md` (affected version,
exact vulnerabilities, where/how used, whether untrusted files reach the
code, existing mitigations, replacement/isolation options, operational
impact, a recommended interim decision, and a proposed review/expiry
date) — summarized:

- **A. `xlsx@0.18.5`, 2 high-severity findings** (no patched version
  exists). Confirmed: untrusted, agent-uploaded `.xlsx` files do reach the
  affected parser (`apps/api/src/lib/import/parsers/excelParser.ts`),
  bounded by a 25MB upload-size cap and a 50,000-row parse cap already in
  place. Recommended interim decision: **accept temporarily** (90-day
  review), with a scoped migration to an alternative parser as tracked
  follow-up. **Claude has not accepted this risk** — a named human owner
  must record the decision.
- **B. `esbuild`, 1 moderate transitive finding** (inside `drizzle-kit`'s
  own dev-only dependency tree). Confirmed dev-tooling-only exposure
  (never reachable in either production build); the vulnerable behavior is
  esbuild's own development server, which nothing in this repository's
  scripts invokes for `drizzle-kit`'s bundled copies. Recommended interim
  decision: **accept temporarily** (revisit at the next `drizzle-kit`
  upgrade, or 180 days), rather than force an untested `pnpm.overrides`
  into a third party's dependency tree that this PR's own CI fix now
  depends on working correctly. **Claude has not accepted this risk** — a
  named human owner must record the decision.

### 10. Remaining `console.*` debt

This pass independently re-counted the current codebase rather than
carrying forward the "92 of 109" figure cited in an earlier revision of
this report (that figure could not be reproduced against the current tree
and traces to an even earlier, lost-instruction context this PR has
already disclosed carrying forward without independent re-verification —
see this report's own top-of-document disclosure). The actual current
count, `grep`-verified against `apps/api/src` and every `packages/*/src`
directory for `.ts`/`.tsx` files, excluding test files: **15 non-test
`console.*` call sites across 8 files** (27 total including test
fixtures, which are out of scope by definition).

Every site was individually read in context and classified:

- **11 of 15 — CLI-only scripts, not production request-handling paths.**
  `apps/api/src/scripts/reconcileLegacyCommissions.ts` (6 sites: 5
  `console.log` progress/report lines + 1 `console.error`) is a
  human-operated backfill CLI, run manually from a terminal — its
  `console.log` output *is* its intended UX (a human watches it run), and
  it never executes as part of the running API server. `packages/db/src/migrate.ts`
  (3 sites) is likewise a CLI/CI-only migration runner, explicitly
  documented in its own header comment as not run against any live
  environment by this remediation effort. Neither leaks secrets or
  credentials (their output is generic status text, transaction/property
  IDs, and commission figures — internal business data an operator running
  the tool already has full access to, not a random unauthenticated
  party). **No remediation needed; not a security or observability gap.**
- **4 of 15 — provider-fallback startup warnings** (`packages/integrations/{aml,esign,payments,property-data}/src/index.ts`,
  one `console.warn` each), printed once at process startup when a "real"
  provider is configured via environment variable but its required
  credentials are incomplete, so the module falls back to its Mock/sandbox
  implementation. No secrets are logged (only which env vars are unset).
  This is the one category with genuine, if narrow, production-observability
  relevance: if a real deployment silently falls back to a Mock payment,
  AML, or e-sign provider, that is an operationally important signal, and
  today it only reaches raw stdout rather than this repository's own
  structured, correlation-ID-carrying logger (`@aee/events`). **Not
  remediated this pass**, and deliberately so: none of these four
  integration packages currently declares `@aee/events` as a dependency,
  so wiring them to the shared logger is a new cross-package dependency
  edge, not a same-file code edit — a larger and more architecturally
  consequential change than this bounded pass's own instruction not to
  "add features" or perform "a large mechanical rewrite" permits it to
  make unreviewed. Recorded as bounded technical debt:
  - **Count:** 4 call sites, 4 files.
  - **Category:** provider-fallback configuration warnings, startup-time
    only, no secrets involved.
  - **Owner:** not assigned by this pass — needs a human decision-maker
    to name one, since it requires a small but real dependency-graph
    change.
  - **Suggested completion milestone:** the next time any of these four
    integration packages is otherwise touched (e.g., adding a second real
    provider, or the transitive `esbuild` finding's own resolution if that
    ever requires a `drizzle-kit`/tooling-adjacent change to these
    packages) — bundle in adding `@aee/events` as a dependency and
    converting these four `console.warn` calls to `logger.warn(...)` with
    a structured event name, as a small, reviewed, standalone change.
- **1 of 15 (`packages/events/src/logger.ts`) is not a real call site at
  all** — the only match in that file is inside a comment describing the
  *old* pattern this module replaces, not executable code. Excluded from
  the counts above.

No mechanical rewrite was performed to reduce this count, consistent with
this pass's own instruction.

### 11. Exact action required before merge

In order, each with the validation command that confirms it worked:

1. **Land the migration fix.** From a real local clone:
   `git checkout feat/security-observability-hardening && git pull`, then
   copy the three files from `pr25_maintainer_patch.zip`'s `migration_fix/`
   directory into `packages/db/migrations/` (see that bundle's `README.md`
   for exact paths and git-blob-SHA-1 values to verify against after
   copying). Optionally remove the three now-superseded legacy files.
   Commit and push. **Validation:** `pnpm --filter @aee/db run db:migrate`
   against a fresh database succeeds, then
   `pnpm --filter @aee/db exec drizzle-kit generate` reports "No schema
   changes, nothing to migrate."
2. **Land the esbuild fix.** Copy `esbuild_fix/package.json` and
   `esbuild_fix/pnpm-lock.yaml` from the same bundle into
   `apps/api/package.json` and `pnpm-lock.yaml` respectively. Commit and
   push (can be the same commit as #1, or separate — both are independent
   and non-conflicting). **Validation:**
   `pnpm install --frozen-lockfile` succeeds; `pnpm audit` still shows
   exactly the same 3 remaining advisories (§8/§9).
3. **A repository maintainer (or this GitHub App re-installed with the
   `workflow` permission scope) applies the CI workflow permissions
   patch.** Copy `ci_yml_fix/ci.yml` from the bundle to
   `.github/workflows/ci.yml` (or apply `ci_yml_fix/ci.yml.diff`). Commit
   and push. This step specifically requires `.github/workflows/**` write
   access this session's integration does not have — it is the reason
   this report's decision is `BLOCKED — MAINTAINER WORKFLOW ACTION
   REQUIRED` rather than a lower-severity label.
4. **Confirm CI is green** on the resulting commit(s) — this report does
   not and cannot claim that outcome itself, consistent with this PR's own
   standing rule to never claim CI status without GitHub confirming it.
5. **A named human owner records a decision** for each of the two
   remaining dependency risk items in `docs/DEPENDENCY_RISK_ACCEPTANCE.md`
   (§9 above) — this can happen in parallel with steps 1–4, but the PR
   should not be treated as fully risk-closed until both are recorded,
   even after CI is green.
6. **Optional, non-blocking:** assign an owner and schedule the small
   `@aee/events` wiring for the 4 provider-fallback warnings (§10) as a
   standalone follow-up.

Once steps 1–4 are done and CI is confirmed green by GitHub itself, and
step 5's two decisions are recorded, this PR meets this pass's own
decision rule for `READY TO MERGE`.

---
## 1. Decision (prior revision — superseded by the update section above)

**BLOCKED — CI WORKFLOW PERMISSION REQUIRED**

Every item this step's instruction would treat as release-blocking on its own — unresolved
cross-tenant (IDOR) exposure — remains fixed and verified (§4/§5); this is **not**
`BLOCKED — TENANT ISOLATION FAILURE`. Parts B (metrics), C (typed-error-handling audit), E
(static analysis + live dynamic checks, plus a real CSV-injection fix), and G (full
regression verification) are complete, pushed, and independently verified this pass (§6–§8,
§10). Part F's dependency re-audit produced one genuinely safe, fully-verified fix and a
proper risk-acceptance record for what remains (§9) — no risk was self-accepted.

What forces this decision label is Part D. This pass tried, for the first time, to actually
*observe* a CI result for this PR rather than assume one — the instruction's own explicit
requirement — and found that the pre-existing `.github/workflows/ci.yml` (not created by
this pass) has failed **every one of its 115 recorded runs**, always at the same step, for a
real, now fully-diagnosed reason (a stale drizzle-kit migration-tracking journal — full
detail in `docs/CI_SCHEMA_DRIFT_FIX.md`). The fix was found, implemented, and verified
completely *locally* — a from-scratch database migrate-and-generate cycle confirms it works.
It could not be landed on the branch: pushing it requires either write access to
`.github/workflows/ci.yml` (a separate hardening change to that file) or, at minimum,
committing a large machine-generated snapshot file, and this pass hit two independent,
confirmed technical walls doing so — a genuine `403 Resource not accessible by integration`
on `.github/workflows/**` (the GitHub App integration available to this session lacks the
`workflow` write scope), and a demonstrated, reproducible inability to transmit a file of
that size intact through the push tools available in this session (proven directly, not
assumed — see `docs/CI_SCHEMA_DRIFT_FIX.md`'s own verification section). Per this step's own
governing instruction, hitting a permission wall on the CI workflow is the one condition
with its own named stop-and-report label, precisely so that CI status is never claimed
without GitHub actually confirming it. This report does exactly that: CI is not green, has
never been green on this PR, the reason is now fully understood and the fix is fully
prepared, but neither is claimed as done.

This label governs the overall submission. It does not mean the rest of this pass's work is
withheld or unusable — §6 through §10 document real, pushed, independently-verified
progress that stands on its own regardless of the CI question, and §11 gives the exact,
minimal steps a human with normal repository access needs to finish Part D.

## 2. Entry-gate evidence

Verified in an earlier session window and re-confirmed via `mcp__GitHub_MCP__list_branches`:
PR #24 (the prior step) was merged into `staging`; branch
`feat/security-observability-hardening` was created from `staging` HEAD with 35 files
spot-checked byte-identical to `staging` before any of this step's work began; `staging`'s
own tests/typecheck/build were confirmed passing prior to branching. This step's continuity
into its most recent closure-pass window was itself re-verified at the start of that window
(a frozen-lockfile install, a Postgres restart, and a PR head/base SHA check against the
branch's actual state, plus a smoke test) before any further work proceeded.

## 3. Security work (Part A)

Full detail and file-by-file citations live in `SECURITY_ARCHITECTURE_AND_THREAT_MODEL.md`
(system overview, trust boundaries, assets, the full threat table, session-security and
webhook-trust models, perimeter hardening, secrets/dependency posture) and
`DATA_CLASSIFICATION_AND_PROTECTION.md` (data-category inventory, access control, the
formal secrets-scan record, file/upload security, the sensitive-data-in-logs gap, AI/
automation data handling). Summary of what changed, all real code with real tests:

- **CORS**: explicit allowlist (`lib/cors.ts`) replacing `origin: true`; fails closed in
  production via `assertCorsConfigured()`, called at boot — re-confirmed live this pass
  (§7): the server refuses to start in production without `CORS_ALLOWED_ORIGINS` set, and a
  disallowed `Origin` gets no `Access-Control-Allow-Origin` header back.
- **Rate limiting**: `middlewares/rateLimit.ts` — global (300/min/IP) and a tighter
  auth-specific limiter (20/min/IP on `/auth/*`) — re-confirmed live this pass: 25 rapid
  `POST /auth/login` attempts return `401` for the first 20, then `429`.
- **Security headers**: `helmet()` mounted first in `app.ts`'s middleware chain —
  re-confirmed live this pass: `Content-Security-Policy`, `Strict-Transport-Security`,
  `X-Content-Type-Options`, and `X-Frame-Options` all present on a real response.
- **Request body size**: explicit 1 MB JSON limit — re-confirmed live this pass: a 2MB body
  against a real route returns `413`.
- **Session revocation**: `users.sessionEpoch`, embedded in the session token and re-checked
  on every request; logout bumps it, instantly invalidating every other outstanding token.
- **Health check**: liveness/readiness/degraded split, a real `select 1` against Postgres.
- **Dependency fix**: `qs` pinned via a root `pnpm.overrides` entry (this step); this pass's
  own re-audit (§9) found and fixed a further safe dependency issue (`esbuild`, low
  severity) and produced a formal risk-acceptance record for what remains.
- **Integration security re-verification**: every webhook router (communications,
  financial, integrations) re-verified signature-authentic and tenant-resolved-from-payload.
  This pass additionally found and fixed a severe, previously-undiscovered defect in the
  integrations webhook route specifically — see §6.
- **AI/automation and file/upload security**: reviewed, unchanged — see the original
  Part A documents for detail.

**By far the largest body of work in Part A is the tenant-isolation audit** — see §4/§5,
re-confirmed closed again this pass (§8).

## 4. Findings and remediation

Nine real tenant-isolation defects were found and fixed across the full route surface:
eight CRITICAL (full cross-tenant read and/or write of another brokerage's data) and one
MEDIUM (a write-side reference-integrity gap with no confirmed read leak).

| # | Domain | Defect | Fix |
|---|---|---|---|
| 1 | Payments | `chargeServiceOrder`/`refundPayment`/`listPaymentsForServiceOrder` loaded by id with no brokerage filter. | New brokerage-scoped chokepoints; 9/9 tests pass. |
| 2 | Documents | Agency terms, package populate, send-for-signature, and document content all loaded by id/propertyId with no brokerage check — including real signed-contract content. | New tenant-scoped chokepoints in `lib/documents.ts`; 12/12 tests pass. |
| 3 | AML | Retry/resolve-exception had no brokerage check; two by-property GETs leaked cross-tenant. | Brokerage-scoped joins throughout; 12/12 tests pass. |
| 4 | Parties | Create/list/delete party-property links trusted a client-supplied id with no ownership check. | Every handler checks `properties.brokerageId` in the same query; 4/4 tests pass. |
| 5 | Financial (PC fee) | Fee-authority lookup filtered by id only — could disclose another brokerage's confidential commission mandate terms. | Single filtered query (`id AND brokerageId`); 7/7 tests pass. |
| 6 | Integrations | `mintMockAuthFlow` had no brokerage parameter at all — could mint/reactivate any brokerage's credential, including un-revoking one. | Routes through the same `loadConnectionInBrokerage` chokepoint every sibling handler uses; 7/7 tests pass. |
| 7/7b | Pit Crew | Work-item overlay validated `propertyId` but not the foreign `sourceRecordId`, nor the assignee's brokerage. | New `assertSourceRecordOnPropertyInBrokerage`/`assertUserInBrokerage` guards; 37/37 tests pass. |
| 8 | Grow | `POST /activities` accepted `partyId`/`propertyId`/`opportunityId` with no ownership check (MEDIUM). | Each optional field checked against the caller's brokerage before insert; 10/10 tests pass. |

Full defect descriptions and the complete 28-file tenant-isolation matrix are in
`AUTHENTICATION_AUTHORISATION_AND_TENANT_ISOLATION.md`. **All 9 findings' regression tests
were re-run in full in this pass's own closure window** (88/88 passing) — see §8 and
`docs/STEP2_REGRESSION_VERIFICATION.md`.

## 5. Tenant-isolation matrix — summary

28 route files audited in total: 8 required a fix for a CRITICAL finding, 1 required a fix
for a MEDIUM finding, 13 were already correctly scoped, 3 are webhook routers verified
correct by design, and 3 have no tenant-scoped id-lookup surface at all. Two low-severity,
non-blocking items remain deferred (§9). Full per-file verdict table:
`AUTHENTICATION_AUTHORISATION_AND_TENANT_ISOLATION.md` §5.

**This is the basis for §1's confirmation that `BLOCKED — TENANT ISOLATION FAILURE` does
not apply**: every CRITICAL/MEDIUM finding has a verified fix and a passing regression test,
re-confirmed passing again in this pass's own final regression run (§8).

## 6. Observability and error-handling work (Parts B and C)

Full detail in `METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md` (Part B) and
`TYPED_ERROR_HANDLING_AUDIT.md` (Part C). Both are now substantially complete, not
specified-only:

**Part B — metrics.** Grew from 9 to 23 bounded-cardinality metrics, backing 14 SLI areas
and 27 alert-ready conditions. Of the 13 named critical-gap categories this closure pass
worked from, 10 are fully closed and 2 are partially closed with the exact wired/unwired
boundary named (full cross-check table in `METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md` §5).
Concretely this pass: wired `integration_webhook_total` into both the communications and
financial webhook routers (previously only the integrations router emitted it); added a new
`financial_reconciliation_variance_total` metric and wired it into the mock payment-status
reconciliation path; and fixed two pre-existing test failures in
`lib/observability/__tests__/queueGauges.test.ts` (a schema-constraint violation and a
missing-column insert) plus added a new test for the `integration_outbox` gauge, which had
no test coverage at all before this pass.

**Part C — typed-error-handling audit.** The single highest-value finding: every
`logger.error(msg, { error: err })` call site across the entire codebase was silently
logging `error: {}` for a plain `Error`, because `message`/`stack` are non-enumerable own
properties Node's `Object.entries`/`JSON.stringify` skip. Fixed once, at the shared root
(`packages/events/src/redaction.ts`), retroactively correct for every existing call site
with zero call-site changes needed. Also added: a global Express error-handling safety net
(`apps/api/src/middlewares/errorHandler.ts`) closing a real, previously-live stack-trace/
internal-detail leak on any unhandled route error; diagnostic logging on two previously-silent
plain-`Error` fallback paths (`routes/financial.ts`, `routes/communications.ts`); and a
three-bug fix in `routes/integrationsWebhooks.ts` found while auditing it — the route was
**completely unreachable** (a router-mount-order bug meant every unauthenticated webhook
request was 401'd by a sibling router's blanket auth gate before ever reaching this one), a
non-UUID `connectionId` caused an unhandled-promise-rejection hang, and the resulting raw
Postgres error was echoed verbatim to an unauthenticated caller. All three fixed, each with
new test coverage — first-ever HTTP-level tests for this route (previously only exercised
by calling its underlying function directly, bypassing the route and its mount order
entirely). 662/662 tests passing across `packages/events` and `apps/api` after every Part
B/C change, re-confirmed again in this pass's own final full-suite run (§8).

**What remains genuinely unimplemented, disclosed rather than implied away**: the
`console.*`-to-structured-logger migration is still partial (92 of an original 109 raw
call sites remain — unchanged by this closure pass, which focused on the 13 named metric
gaps and the typed-error audit specifically; **this figure was independently re-verified
and corrected by the subsequent "CI Unblocking" pass — see that pass's own §10 above, which
found only 15 non-test sites currently present**); per-rule exception-engine failures are
still only counted at scan level, not per-rule.

## 7. Security tooling results (Part E) and the CI investigation (Part D)

**Static analysis.** `semgrep`'s registry rulesets require network access this session's
proxy does not allow to `semgrep.dev` (`403`); `njsscan` v1.0.0 (bundled, offline rules) was
used instead — a real, independently-maintained Node/Express-specific analyzer. 5 rule
categories were flagged; every individual hit was read against the actual code, not
dismissed by the tool's confidence label alone. 4 of 5 categories (and every hit within
them) were false positives, each with the specific reason recorded in
`docs/STATIC_AND_DYNAMIC_SECURITY_CHECKS.md`. Investigating one false positive
(`express_xss` on the CSV export route) surfaced a real, different, previously-undocumented
issue njsscan has no rule for: CSV/formula injection in `exportRejectedRecordsCsv`
(`apps/api/src/lib/import/pipeline.ts`) — a cell or header value starting with `=`, `+`,
`-`, or `@` from an uploaded import file would round-trip unmodified into a downloadable
CSV, interpreted as a formula rather than text by Excel/Sheets/LibreOffice. **Fixed**: the
standard OWASP mitigation (a neutralising leading quote), verified by a new end-to-end test
(24/24 passing in that file, up from 23).

**Bounded live dynamic checks.** Rather than defer all dynamic verification, this pass ran
the API in `NODE_ENV=production` against the local test database and drove 8 real checks at
it: fail-closed startup without `CORS_ALLOWED_ORIGINS`/`METRICS_TOKEN`, all 4 helmet
headers present, auth required on a protected route, the metrics endpoint's bearer-token
gate, CORS allowlist enforcement (not reflect-any-origin), the 413 body-size limit, and the
429 auth rate limit. All 8 behaved exactly as documented. Full detail, including the exact
`curl` commands and responses: `docs/STATIC_AND_DYNAMIC_SECURITY_CHECKS.md`. No SAST/DAST
tool run beyond njsscan, and no independent penetration test — both remain out of scope for
this bounded pass, not silently claimed as covered.

**CI (Part D)** — see the update section at the top of this document for the current
decision this produces and this pass's own fresh, corrected diagnosis; the paragraph below
is the prior pass's own record. In brief: the pre-existing `ci.yml` workflow has never once
passed (confirmed again, freshly, by the follow-on pass at run #127 — still the same failure
class). Root cause fully diagnosed and fixed locally (a stale drizzle-kit migration journal
caused both a false "schema drift" failure and a separate, more serious silent gap where
real migrations were never applied to CI's own test database). The fix, and this pass's
planned `permissions:`-block hardening of the workflow file itself, could not be pushed —
full, specific, evidence-backed reasoning in `docs/CI_SCHEMA_DRIFT_FIX.md` (both this pass's
original record and the follow-on pass's update section), including exactly what a human
with normal git access needs to do to finish it.

## 8. Test-and-build evidence

**The full regression suite — re-run in full, this pass, after every Part B–F change.**

```
Chunk 1 (ai, entitlements, billing, middlewares, import, lib):  130 tests, 129 pass, 0 fail, 1 skip
Chunk 2 (routes):                                                186 tests, 186 pass, 0 fail, 0 skip
Chunk 3 (automation, exceptions, launch, commandCentre, pitCrew): 171 tests, 171 pass, 0 fail, 0 skip
Chunk 4 (communications, financial, integrations, observability): 176 tests, 176 pass, 0 fail, 0 skip
Total:                                                            663 tests, 662 pass, 0 fail, 1 skip
```

This is exactly 1 more test and 1 more pass than the 662/661/0/1 figure Part C's own audit
recorded — the expected delta, matching Part E's one new CSV-injection regression test. The
9 tenant-isolation findings' own regression tests were also re-run together in this pass,
independently of the full-suite run above: **88/88 passing** (§4, §5). Full breakdown and
the reconstructed 18-item regression checklist, each item backed by a specific test file
actually re-run this pass (not cited from memory): `docs/STEP2_REGRESSION_VERIFICATION.md`.
**This exact 663/662/0/1 total, and the 88/88 tenant-isolation total, were independently
reproduced again by the follow-on "CI Unblocking" pass, with both the migration fix and the
esbuild fix applied locally — see that pass's own §7 above.**

`tsc --noEmit` and the `esbuild` production build for both `apps/api` and `apps/web` were
run clean, including after this pass's own verified-but-unpushed `esbuild` devDependency
bump (§9).

A real, non-destructive backup/restore drill was run in an earlier window against the local
test database (89/89 tables, 191/191 indexes, 357/357 constraints, zero orphaned rows, a
matching whole-table checksum) — unchanged by this pass; full record in
`SECURITY_INCIDENT_RUNBOOKS.md`.

## 9. Dependency risk (Part F) and other deferred/accepted items

**Re-audited this pass** (`docs/DEPENDENCY_RISK_ACCEPTANCE.md` — since restructured into a
formal per-item decision record by the follow-on "CI Unblocking" pass; see that document's
current version and this report's own §9 above for the current, structured form): `pnpm
audit` now reports 4 distinct advisories (down from the 7 originally found before the `qs`
fix). One — a low-severity `esbuild` path-traversal advisory — has a genuinely safe, fully
verified fix (a devDependency range bump, `^0.27.0` → `^0.28.1`; build/typecheck/audit all
confirm it) that is **not yet pushed**, for the same file-transmission reason blocking Part
D (it requires regenerating a ~92KB `pnpm-lock.yaml`, and this pass already demonstrated
that transmitting content anywhere near that size through this session's push tools is
unreliable — pushing an unverifiable lockfile was judged a worse outcome than leaving this
one low-severity item open one more pass; **the follow-on pass re-verified this fix from a
clean baseline and packaged it as an exact file bundle — see that pass's §5/§11 above**).
The remaining two advisories (both high severity, `xlsx` — no patched version exists at all
for either) and one moderate `esbuild` advisory (transitive, entirely inside `drizzle-kit`'s
own dependency tree, dev-tool-only) have no available fix this pass could safely make. **Per
this step's own instruction, Claude has not self-accepted either remaining risk.**
`docs/DEPENDENCY_RISK_ACCEPTANCE.md` is the formal risk-acceptance record; it names exactly
what decision each requires and from whom.

**Other deferred/accepted items, unchanged from earlier revisions of this report:**

- The partial `console.*` sweep — see the follow-on pass's §10 above for a corrected,
  independently re-verified current count and classification, superseding the "92 of 109"
  figure this section originally cited.
- `DELETE /payment-methods/:id` returns a distinguishable 403 rather than a uniform 404 —
  existence-leak, not data-leak, low severity, flagged not fixed.
- `recordLegalRepresentatives` (`lib/transactions.ts`) stores a client-supplied solicitor-
  party id with no ownership check, but nothing currently reads it back cross-tenant.
- Sensitive webhook-payload redaction for a future real (non-mock) provider —
  `integration_inbox.payload` stores whatever a webhook sends, in full, for audit/replay;
  today's mock providers never send anything sensitive.
- No dedicated tenant-isolation-rejection metric, no per-rule exception-scan metric.

## 10. Git-and-PR-state

This session's working environment has no local `.git` directory for this repository and no
git/API credential shaped like a real GitHub PAT for direct git operations (**the follow-on
"CI Unblocking" pass tested this directly and confirmed it precisely — see that pass's own
§2 above for the exact evidence: a session-repo API gate, and a real GitHub rejection of the
available token for git-over-HTTPS use**). All repository writes went through
`mcp__GitHub_MCP__push_files`/`create_or_update_file`, and — a new verification discipline
adopted in this pass, after this pass's own large-file transmission failures made the risk
concrete — every file this pass pushed above a few kilobytes was independently re-verified
by computing its local git blob SHA-1 and comparing it against the SHA GitHub reports for
the pushed content, not merely checking that a push call returned success. Two small
drafting inconsistencies caught by exactly this technique during this pass (a stale sentence
and an incorrect GHSA advisory ID copy-pasted between a local draft and a push call) were
found and corrected before being left on the branch.

**What this pass pushed, in order:**

1. Part B: 24 files (the metrics registry extension, both webhook routers wired, the new
   `financial_reconciliation_variance_total` metric and its call site, two fixed + one new
   observability test, and the rewritten `METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`).
2. Part C: 11 files (the shared redaction fix, the new global error handler and its tests,
   two diagnostic-logging additions, the three-bug integrations-webhook fix and its new test
   file, the mount-order fix in `routes/index.ts`, and `TYPED_ERROR_HANDLING_AUDIT.md`).
3. Part D: `docs/CI_SCHEMA_DRIFT_FIX.md` (created, then updated with the full disclosure of
   why the fix itself could not be landed — see §1/§7); a corrective revert of a
   `packages/db/migrations/meta/_journal.json` change and an accidentally-committed
   placeholder file from a failed first push attempt at the real fix, restoring the branch
   to its exact prior state rather than leaving it half-applied.
4. Part E/G in one commit: the CSV-injection fix and its new test
   (`apps/api/src/lib/import/pipeline.ts` and its test file),
   `docs/STATIC_AND_DYNAMIC_SECURITY_CHECKS.md`, and
   `docs/STEP2_REGRESSION_VERIFICATION.md` — all four independently blob-hash-verified
   byte-exact.
5. Part F: `docs/DEPENDENCY_RISK_ACCEPTANCE.md` (created, then corrected once for the GHSA
   ID mix-up above; **since substantially rewritten again by the follow-on pass — see
   above**).
6. The prior revision of this completion report.
7. **The follow-on "CI Unblocking" pass pushed no further commits to the branch** (§2 above)
   — its migration fix, esbuild fix, and CI workflow permissions patch are all delivered as
   an exact file bundle instead, and this document plus
   `docs/CI_SCHEMA_DRIFT_FIX.md`/`docs/DEPENDENCY_RISK_ACCEPTANCE.md` were updated via the
   same verified push mechanism as every prior pass.

PR #25 against `staging` carries this step's full scope and is updated in place to reflect
this revision's decision and evidence.

## 11. Next-step recommendation (prior revision — see the update section's own §11 above for the current, authoritative version)

For whoever reviews or continues this work, in priority order:

1. **Finish landing Part D's CI fix** — the fix itself is fully diagnosed, implemented, and
   verified; it only needs a human (or an agent) with normal `git push` access to apply it.
   Exact steps in `docs/CI_SCHEMA_DRIFT_FIX.md`'s "To actually apply this fix" section: run
   `pnpm --filter @aee/db exec drizzle-kit generate` from a real clone, commit
   `packages/db/migrations/meta/` (no `.sql` file changes expected), and push. Separately,
   apply the drafted `permissions:` block and two reconciled steps to `ci.yml` itself (a
   repo maintainer needs `.github/workflows/**` write access this session's integration
   does not have).
2. **Apply Part F's verified `esbuild` fix** — change `apps/api/package.json`'s
   `"esbuild": "^0.27.0"` to `"^0.28.1"`, run `pnpm install`, and commit both files
   together. Fully verified already (§9); only the same push-mechanics limitation as Part D
   blocks it.
3. **Human sign-off needed**: the two remaining dependency risks in
   `docs/DEPENDENCY_RISK_ACCEPTANCE.md` (both `xlsx` high-severity findings with no
   available fix; the remaining moderate `esbuild` transitive finding).
4. **Finish the `console.*`-to-structured-logger sweep** (92 of 109 sites remain) —
   unchanged scope from earlier revisions of this report.
5. **A real SAST/DAST tool and an independent penetration test** — this pass ran a real,
   offline static analyzer and 8 live dynamic checks (§7), but neither substitutes for
   dedicated tooling with network access to a real rule registry, or a third-party
   engagement.
6. Compare every "reasoned equivalent" flagged throughout this step's documents (field
   lists, named flows, the 13 metric gaps, the 12 boundaries/13 categories, the 18-item
   regression checklist, and this report's own decision-label choice in §1) against the
   original instruction text if it is available outside this session, and correct any
   material divergence.
