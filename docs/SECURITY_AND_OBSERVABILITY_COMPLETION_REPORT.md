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
session.

**This revision** covers a final bounded closure pass (Parts B–H) completed in the most
recent session window, on top of the Part A tenant-isolation/perimeter work already
recorded below. The decision label changes in this revision — see §1.

## 1. Decision

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
gaps and the typed-error audit specifically); per-rule exception-engine failures are still
only counted at scan level, not per-rule.

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

**CI (Part D)** — see §1 for the governing decision this produces. In brief: the
pre-existing `ci.yml` workflow has never once passed (115/115 runs red, confirmed via
GitHub's own Actions UI after the GitHub API's `checks`/`statuses` read scope turned out to
be unavailable to this session's integration). Root cause fully diagnosed and fixed locally
(a stale drizzle-kit migration journal caused both a false "schema drift" failure and a
separate, more serious silent gap where 3 real migrations were never applied to CI's own
test database). The fix, and this pass's planned `permissions:`-block-plus-two-step
hardening of the workflow file itself, could not be pushed — full, specific, evidence-backed
reasoning in `docs/CI_SCHEMA_DRIFT_FIX.md`, including exactly what a human with normal git
access needs to do to finish it (§11 below).

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

`tsc --noEmit` and the `esbuild` production build for both `apps/api` and `apps/web` were
run clean, including after this pass's own verified-but-unpushed `esbuild` devDependency
bump (§9).

A real, non-destructive backup/restore drill was run in an earlier window against the local
test database (89/89 tables, 191/191 indexes, 357/357 constraints, zero orphaned rows, a
matching whole-table checksum) — unchanged by this pass; full record in
`SECURITY_INCIDENT_RUNBOOKS.md`.

## 9. Dependency risk (Part F) and other deferred/accepted items

**Re-audited this pass** (`docs/DEPENDENCY_RISK_ACCEPTANCE.md`, full detail): `pnpm audit`
now reports 4 distinct advisories (down from the 7 originally found before the `qs` fix).
One — a low-severity `esbuild` path-traversal advisory — has a genuinely safe, fully
verified fix (a devDependency range bump, `^0.27.0` → `^0.28.1`; build/typecheck/audit all
confirm it) that is **not yet pushed**, for the same file-transmission reason blocking Part
D (it requires regenerating a ~92KB `pnpm-lock.yaml`, and this pass already demonstrated
that transmitting content anywhere near that size through this session's push tools is
unreliable — pushing an unverifiable lockfile was judged a worse outcome than leaving this
one low-severity item open one more pass). The remaining two advisories (both high severity,
`xlsx` — no patched version exists at all for either) and one moderate `esbuild` advisory
(transitive, entirely inside `drizzle-kit`'s own dependency tree, dev-tool-only) have no
available fix this pass could safely make. **Per this step's own instruction, Claude has not
self-accepted either remaining risk.** `docs/DEPENDENCY_RISK_ACCEPTANCE.md` is the formal
risk-acceptance record; it names exactly what decision each requires and from whom.

**Other deferred/accepted items, unchanged from earlier revisions of this report:**

- The partial `console.*` sweep (92 of 109 original sites remain) — §6.
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
git/API credential shaped like a real GitHub PAT for direct git operations. All repository
writes went through `mcp__GitHub_MCP__push_files`/`create_or_update_file`, and — a new
verification discipline adopted in this pass, after this pass's own large-file
transmission failures made the risk concrete — every file this pass pushed above a few
kilobytes was independently re-verified by computing its local git blob SHA-1 and comparing
it against the SHA GitHub reports for the pushed content, not merely checking that a push
call returned success. Two small drafting inconsistencies caught by exactly this technique
during this pass (a stale sentence and an incorrect GHSA advisory ID copy-pasted between a
local draft and a push call) were found and corrected before being left on the branch.

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
   ID mix-up above).
6. This completion report.

PR #25 against `staging` carries this step's full scope and is updated in place to reflect
this revision's decision and evidence.

## 11. Next-step recommendation

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
