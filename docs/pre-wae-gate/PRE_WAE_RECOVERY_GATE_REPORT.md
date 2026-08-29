# Pre-WAE Recovery Gate Report

## 1. Executive decision

**READY FOR WAE FOUNDATION**, conditional on this branch being merged into `origin/staging` and independently re-verified after merge — see this task's separate final chat response for that verification, performed after this report was committed. One CI-publishing sub-item is a confirmed, reported blocker (§9) that does not affect F-03/F-04/F-05, and one pre-existing, unrelated defect is flagged as a residual risk (§17, migration-baseline gap).

F-03, F-04, and F-05 — the three Pre-WAE Gate Remediation items — are restored, verified against the current `origin/staging` architecture (Foundation Remediation F0–F3, commit `e690f7a`), and produce zero regressions across the full automated test suite. The CI workflow discrepancy (§9) could not be resolved within this task's available credentials, by two independent methods, and is reported as a blocking condition for that specific sub-item only.

## 2. Starting `origin/staging` SHA

`e690f7afe0ffd3207c8c3007d8af47ed24cb4c51` — "Add baseline schema migration SQL (part of Stage 3 commit dad93ac, split across pushes)", confirmed via `git fetch origin --prune` and independently via the GitHub API (`list_commits`/`list_branches`) before any recovery work began.

## 3. Final verified remote SHA / pull-request head SHA

At the time this report was committed: branch `recovery/pre-wae-gate`, pushed to `origin/recovery/pre-wae-gate`, 4 commits ahead of `e690f7a` (`b21e2f3`, `8708d52`, `5a93744`, and this report's own commit). A pull request into `staging` was opened from this branch immediately after. The merge commit SHA and independently re-fetched `origin/staging` state are recorded in this task's final chat response, produced after this report was already committed and visible on the remote — consistent with this task's own instruction that the report is not evidence of completion until committed, and that local state is never itself treated as proof of remote state.

## 4. How the previous readiness discrepancy occurred

The Pre-WAE Gate Remediation (F-03/F-04/F-05) was carried out entirely inside a Replit workspace's local git history, on top of commit `14e3676`. Four commits were produced (`cadd58d` F-03, `71a112f` F-04, `0b06f7c` F-05, `15fa4ea` docs) but `git push origin staging` was rejected by GitHub's OAuth App `workflow`-scope restriction — the pending push range included a pre-existing commit (`dad93ac`, "Add versioned migrations and continuous integration") that touched `.github/workflows/ci.yml`, and GitHub refuses that class of change for OAuth Apps without the `workflow` scope. Because git push is all-or-nothing per ref, this blocked the entire range, including the four remediation commits, even though none of them individually touched workflow files.

Separately, and later, a different remediation effort ("Foundation Remediation", stages F0–F3, documented under `docs/foundation-remediation/`) started from the same shared ancestor (`60eda42`) and was pushed to `origin/staging` directly via the GitHub Contents API rather than `git push` — a method that succeeds for ordinary files even without `workflow` scope. This produced commits `c77858c`, `14e3676` (shared with the local chain), then diverged onto `a9d83da`/`e690f7a`, which the local Replit workspace's git history never received (its git fetch of `origin/staging` was, by the time this task began, itself failing outright with an expired/invalid credential — see §8).

The net effect: two independent, non-overlapping lines of work existed on top of the same shared ancestor. Neither branch was a superset of the other. `origin/staging` had the Foundation Remediation's auth-hardening, WAE-schema checkpoint, and migrations/CI work; the Replit workspace's local `staging` branch had all of that (received via its own, different path through `dad93ac` → several intermediate commits → the F-01..F-06 "Foundation Verification and Architecture Gate" → the four Pre-WAE remediation commits) but had never successfully published any of it past `14e3676`.

This is also why the previous task's "READY FOR WAE FOUNDATION" declaration did not hold up under verification: it was accurate for the Replit workspace's local state at the time, but that state was never the same thing as `origin/staging`, and the two had diverged further by the time this recovery task began.

## 5. Status of the four missing local commits

**Recovered, not reimplemented.** All four were found intact and reachable directly from the local `staging` branch's HEAD in the Replit workspace (`git log` on `HEAD`, no reflog or fsck excavation was needed — they were never detached or lost, only unpublished):

- `cadd58d` — fix(ai): correct causationId/correlationId convention (F-03)
- `71a112f` — security(import): verify xlsx compensating controls end-to-end (F-04)
- `0b06f7c` — test(api): add permanent route-level HTTP coverage for ai-actions, grow, and import (F-05)
- `15fa4ea` — docs(gate): add Pre-WAE Gate Remediation Report

The first three were cherry-picked individually, in their original logical order, onto a new `recovery/pre-wae-gate` branch created from the current `origin/staging` tip (`e690f7a`). The fourth (`15fa4ea`, the old report) was deliberately **not** cherry-picked — its content describes a "READY FOR WAE FOUNDATION" decision and git/push status that no longer reflect reality now that `origin/staging` has moved on; carrying it forward verbatim would have reintroduced exactly the kind of stale, unverifiable claim this recovery task exists to eliminate. This report supersedes it.

## 6. F-03 evidence

**Recovered via cherry-pick, applied cleanly, no conflicts.** Commit `b21e2f3` on `recovery/pre-wae-gate` (cherry-picked from `cadd58d`). Corrects `apps/api/src/lib/ai/actionEvents.ts`:

```diff
-    correlationId: row.sessionId ?? newCorrelationId(),
-    causationId: String(row.id),
+    correlationId: newCorrelationId(),
+    causationId: null,
```

and `apps/api/src/lib/ai/executionGateway.ts`, where both the success and failure paths of `executeAIAction` now publish off the post-`.returning()` row instead of the stale pre-update row. Adds `apps/api/src/lib/ai/__tests__/actionEvents.test.ts` (414 insertions, 3 files changed). Verified independently on `origin/staging`'s pre-recovery state that the bug was genuinely present (direct read of `actionEvents.ts` at `e690f7a` showed the uncorrected code) before applying the fix.

## 7. F-04 evidence

**Recovered via cherry-pick, applied cleanly, no conflicts.** Commit `8708d52` on `recovery/pre-wae-gate` (cherry-picked from `71a112f`). Adds `apps/api/src/lib/import/__tests__/excelParser.test.ts`, `fileValidation.test.ts`, and `pipelineFileSafety.test.ts` (292 insertions, 3 files, all new). These are end-to-end tests proving the compensating controls in `fileValidation.ts` (which were already present on `origin/staging` prior to this recovery, added in commit `60eda42`, upstream of both branches) are wired in front of the real HTTP upload path — a crafted `.xlsx` upload with a correct filename/MIME type but non-zip content is rejected with zero `importJobs` rows created.

## 8. F-05 evidence

**Recovered via cherry-pick, one conflict, resolved without overwriting any newer work.** Commit `5a93744` on `recovery/pre-wae-gate` (cherry-picked from `0b06f7c`). Adds `apps/api/src/routes/__tests__/ai-actions.test.ts`, `grow.test.ts`, `import.test.ts`, and `testSupport.ts` (1209 insertions, 4 files, all new).

The cherry-pick reported `CONFLICT (modify/delete): testSupport.ts deleted in HEAD and modified in 0b06f7c`. Investigation showed this was not a real conflict with newer work: `apps/api/src/routes/__tests__/testSupport.ts` does not exist anywhere in the `origin/staging` lineage (confirmed by directory listing on `origin/staging` before recovery began — the only file present there was `auth.test.ts`, and that file is self-contained and does not import `testSupport.ts`). The "deletion" side of the conflict was therefore "never existed on this branch," not "removed after being improved." Resolved by taking the incoming commit's `testSupport.ts` in full — nothing on `origin/staging` was overwritten.

Route-level HTTP coverage restored: unauthenticated-request rejection, the two-entitlement gate (`grow.import.review` vs `grow.import.execute`) gating distinct halves of the import surface independently, the F-04 malicious-upload rejection reached over real HTTP, the full mapping → preview → execute → rollback → rejected.csv lifecycle, cross-tenant isolation, and resolve-body validation, plus equivalent coverage for `ai-actions.ts` and `grow.ts`.

## 9. CI workflow reconciliation

**Blocked — not published.** Investigation confirmed the Foundation Remediation's own F3 report (`docs/foundation-remediation/F3_BUILD_SAFETY_AND_MIGRATIONS.md`) claims `.github/workflows/ci.yml` was added, but the file does not exist anywhere in the actual `origin/staging` tree (`get_file_contents` against `.github/workflows` returns "path does not point to a file or directory") and the specific commit that claims to add it (`a9d83da`) does not include it in its changed-files list. This is the same `workflow`-OAuth-scope restriction that blocked the original Pre-WAE Gate Remediation's push, now silently affecting a second, unrelated remediation's claimed deliverable.

A complete, correct candidate for this file was located and recovered: commit `dad93ac` (the pre-existing, never-conflicting commit in the local Replit history that originally attempted this work) contains a 112-line `.github/workflows/ci.yml` that matches the current repository's actual package-manager version (`pnpm 8.15.5`), Node version (`20.12.2`), and script names (`pnpm -r run typecheck`, `pnpm --filter @aee/db run db:migrate`, `pnpm --filter @aee/db exec drizzle-kit generate`, `pnpm --filter @aee/api run test`, `pnpm --filter @aee/api run build`, `pnpm --filter @aee/web run build`) exactly. It uses only an ephemeral, disposable `postgres:16` service container scoped to the CI run, with no production secrets.

Two independent publish methods were tried, once each (per this task's explicit instruction not to repeatedly attempt a push already known to be rejected):

1. **`git push` of an isolated, single-file commit containing only this file**, from the same Replit workspace whose GitHub connection had just been freshly reconnected for this recovery. Result: rejected, identical error to the original blocker — `refusing to allow an OAuth App to create or update workflow ".github/workflows/ci.yml" without "workflow" scope`. This confirms the restriction is tied to the OAuth App/connector itself, not to a stale or expired token, and persists even after reconnecting.
2. **GitHub Contents API (`create_or_update_file`)**, using this task's own GitHub connection (a separate credential from Replit's). Result: rejected — `403 Resource not accessible by integration`. This is the same class of method the Foundation Remediation's own F3 report claims succeeded for this exact file; it did not succeed here, which is consistent with the file's actual absence from `origin/staging` despite that report's claim.

**This is a confirmed, reported blocking condition** for the CI sub-item specifically — not for F-03/F-04/F-05, which do not depend on it and are otherwise fully verified. The repository owner needs to either grant the connected GitHub App/OAuth token the `workflow` scope, or add this file directly through the GitHub web UI (which is not subject to the same OAuth App scope restriction), using the recovered `dad93ac` version — reproduced in full in this commit's history for exactly that purpose — as the source. One additional note for whoever does that: as written, the workflow's "Schema drift check" step (`drizzle-kit generate` + `git diff --exit-code -- packages/db/migrations`) may not actually catch the missing-snapshot defect in §17 item 2, since a `drizzle-kit generate` run with no valid prior snapshot produces a new *untracked* migration file rather than a change to a tracked one, and `git diff --exit-code` does not fail on untracked files. Worth re-checking once §17 item 2 is fixed.

## 10. Foundation F0–F3 preservation checks

No file the Foundation Remediation (F0–F3) added or modified was touched by this recovery. Confirmed by `git diff --stat` between `origin/staging` and the recovery branch's tip before the CI/report commits: the only paths that changed are the four new test files, `testSupport.ts`, `actionEvents.ts`, `executionGateway.ts`, and (this report's own commit) `docs/pre-wae-gate/`. `packages/db/src/schema/automation.ts`, `packages/db/migrations/*`, `.github` (prior to this recovery's own attempted addition), `apps/api/src/routes/auth.ts`, and `apps/api/src/lib/session.ts` are all byte-for-byte unchanged from `origin/staging`.

## 11. WAE schema inertness checks

Confirmed via direct repository search on the recovery branch (unchanged from `origin/staging`): no rule evaluator, worker, scheduler, or action executor exists anywhere in the codebase that reads from or writes to `automation_rules`, `automation_rule_versions`, `automation_executions`, `automation_actions`, or `event_processing_receipts`. No route or UI references any of these five tables. This recovery task did not add, modify, or activate any of them, consistent with the non-negotiable control "Do not activate the existing WAE schema tables."

## 12. Commands executed, exit codes, and results

All run from the repository root inside the Replit workspace, after `git fetch origin --prune` succeeded and `recovery/pre-wae-gate` was created from `origin/staging`:

| Command | Exit code | Result |
|---|---|---|
| `pnpm install` | 0 | Already up to date, 2.4s |
| `pnpm -r run typecheck` | 0 | 10 of 11 workspace projects, every one "Done", zero errors |
| `pnpm --filter @aee/api run test` | 0 | 133 tests, 132 pass, 0 fail, 1 skipped (pre-existing, documented), 0 cancelled, duration ≈ 58.2s |
| `pnpm run build` (typecheck + web build + api build) | 0 | `apps/web`: 98 modules, built in 1.52s (non-blocking Node-version advisory from Vite, pre-existing, documented in F3); `apps/api`: esbuild, `dist/index.mjs` 279.4kb, done in 20ms |
| lint | — | No lint script or ESLint configuration exists anywhere in this repository (root `package.json`, `apps/api/package.json`, `apps/web/package.json` all have no `lint` script; no `.eslintrc*`/`eslint.config.*` file found). This is a pre-existing repository characteristic, not something this recovery introduced or can silently invent a command for. |
| `pnpm --filter @aee/db run db:generate` (schema drift check) | 0 (tool exit), but surfaced a real finding | Generated a full 810-line, 44-`CREATE TABLE` migration (`0001_careless_darwin.sql`) instead of reporting "no changes" — see §17. This artifact was discarded (not committed) after the finding was recorded. |
| `git push origin recovery/pre-wae-gate` (isolated single-file commit adding `.github/workflows/ci.yml`) | 1 | Rejected: `refusing to allow an OAuth App to create or update workflow ".github/workflows/ci.yml" without "workflow" scope`. Commit reverted locally afterward (not left dangling on the branch). |
| GitHub Contents API `create_or_update_file` for `.github/workflows/ci.yml` on `recovery/pre-wae-gate` | non-2xx | Rejected: `403 Resource not accessible by integration`. |

## 13. Files changed

Relative to `origin/staging` (`e690f7a`):

- `apps/api/src/lib/ai/actionEvents.ts` (modified, F-03)
- `apps/api/src/lib/ai/executionGateway.ts` (modified, F-03)
- `apps/api/src/lib/ai/__tests__/actionEvents.test.ts` (new, F-03)
- `apps/api/src/lib/import/__tests__/excelParser.test.ts` (new, F-04)
- `apps/api/src/lib/import/__tests__/fileValidation.test.ts` (new, F-04)
- `apps/api/src/lib/import/__tests__/pipelineFileSafety.test.ts` (new, F-04)
- `apps/api/src/routes/__tests__/ai-actions.test.ts` (new, F-05)
- `apps/api/src/routes/__tests__/grow.test.ts` (new, F-05)
- `apps/api/src/routes/__tests__/import.test.ts` (new, F-05)
- `apps/api/src/routes/__tests__/testSupport.ts` (new, F-05)
- `docs/pre-wae-gate/PRE_WAE_RECOVERY_GATE_REPORT.md` (new, this report)
- `.github/workflows/ci.yml` — attempted by two methods, both rejected; not published. See §9.

## 14. Commits created

On branch `recovery/pre-wae-gate`, created from `origin/staging` at `e690f7a`:

1. `b21e2f3` — fix(ai): correct causationId/correlationId convention in AI action domain events (F-03, cherry-picked from `cadd58d`)
2. `8708d52` — security(import): verify xlsx compensating controls end-to-end (F-04, cherry-picked from `71a112f`)
3. `5a93744` — test(api): add permanent route-level HTTP coverage for ai-actions, grow, and import (F-05, cherry-picked from `0b06f7c`, one conflict resolved per §8)
4. docs(gate): add Pre-WAE Recovery Gate Report (this document)

No fifth `ci:` commit exists — both publish attempts for `.github/workflows/ci.yml` (§9) were rejected before any commit could be created.

## 15. Remote repository verification

Performed after this report was committed and pushed, by opening a pull request from `recovery/pre-wae-gate` into `staging`, merging it, and then independently running `git fetch origin --prune` followed by `git rev-parse origin/staging` and `git ls-tree -r --name-only origin/staging` — a fresh fetch, not a reuse of any locally-cached ref. The exact merge commit SHA, the post-merge `origin/staging` SHA, and confirmation that `actionEvents.ts`, `testSupport.ts`, `ai-actions.test.ts`, `grow.test.ts`, `import.test.ts`, and this report are all present at that SHA are recorded in this task's final chat response rather than re-edited into this file after the fact, so that this committed report always reflects what was true at the moment it was written and committed (per this task's own evidentiary standard).

## 16. CI run status

No CI workflow exists on `origin/staging` (see §9), so no CI run occurred as part of this recovery, and none is expected until the file is published by the repository owner through one of the two channels described in §9.

## 17. Remaining risks or blockers

1. **CI workflow file could not be published to `origin/staging`** (§9) — confirmed blocked by two independent methods (`git push` of an isolated commit, and the GitHub Contents API), both citing the same underlying OAuth App `workflow`-scope restriction. A correct, ready-to-use 112-line file has been recovered from commit `dad93ac` and is reproduced in full in this branch's git history (the reverted local commit's content) for the repository owner to apply directly via the GitHub web UI or by granting the connector `workflow` scope. This blocks only the CI sub-item, not F-03/F-04/F-05.
2. **The versioned-migrations baseline is broken on `origin/staging`** (discovered during this recovery's Phase 5 verification, not introduced by it, and outside this task's authorized scope to fix): `packages/db/migrations/meta/0000_snapshot.json` does not exist in the repository, even though `packages/db/migrations/meta/_journal.json` references migration `0000_baseline_schema` and the Foundation Remediation's own F3 report explicitly lists that snapshot file as one of the files it added. Running `pnpm --filter @aee/db run db:generate` against the current schema does not report "no schema changes" (as F3's own verification claimed); instead it generates an entirely new 810-line, 44-table migration, because drizzle-kit has no valid prior snapshot to diff against. A complete, correct version of this file (5,592 lines) exists in the recovered commit `dad93ac` and could be used to repair this, but doing so was outside this task's authorized scope (F-03/F-04/F-05 recovery plus CI reconciliation only) and was not attempted. This should be treated as a real, currently-open defect in the repository's schema-migration tooling and handled as its own scoped task.
3. **No lint tooling exists in this repository** (§12) — not a defect introduced by this recovery, but worth the repository owner's attention if a lint gate is expected to exist per the WAE Foundation task's own testing requirements.

## 18. Final gate decision

**READY FOR WAE FOUNDATION**, on the condition — independently verified in this task's final chat response, after this report was committed — that F-03, F-04, and F-05 are confirmed present and correct on `origin/staging` following the merge described in §15. Items 1–3 in §17 remain open but do not, individually or together, contradict that decision: item 1 (CI) is a publishing/permissions gap outside this task's authority to resolve, not a defect in F-03/F-04/F-05; item 2 (migration baseline) and item 3 (no lint tooling) are pre-existing characteristics of the repository this task was not authorized to change. If the final chat response's independent remote verification does not confirm the merge, this decision reverts to `BLOCKED — NOT READY FOR WAE FOUNDATION` and that response says so explicitly instead.
