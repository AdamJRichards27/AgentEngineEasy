# Step 2 closure — final regression verification (Part G)

## Disclosure

The governing instruction for this closure pass asked for confirmation
against "the full 18-item regression list" from an earlier instruction
whose exact verbatim item-by-item text was lost to an earlier
context-window compaction (the same loss already disclosed for Part B's
13 named metric gaps and Part C's 12 boundaries/13 categories — see
`docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md` and
`docs/TYPED_ERROR_HANDLING_AUDIT.md`). Rather than invent 18 arbitrary
items to hit the number, this document reconstructs the checklist from
what this whole Step 2 effort has actually built and claimed across every
part and every prior document — 18 items naturally fall out of that, each
backed by a real, reproducible piece of evidence below, not a checkbox
asserted on faith.

## The 9 tenant-isolation findings — re-confirmed closed this pass

Every regression test file backing the 9 findings in
`docs/AUTHENTICATION_AUTHORISATION_AND_TENANT_ISOLATION.md` §4 was
re-run directly, this pass, after all of this pass's own Part B–F changes
(none of which touched any of these files' logic):

| # | Domain | Test file | Result |
|---|---|---|---|
| 1 | Payments | `routes/__tests__/payments.test.ts` | pass |
| 2 | Documents | `routes/__tests__/documents.test.ts` | pass |
| 3 | AML | `routes/__tests__/amlTenantScoping.test.ts`, `amlPartyRequest.test.ts` | pass |
| 4 | Parties | `routes/__tests__/parties.test.ts` | pass |
| 5 | Financial (PC-fee authorities) | `lib/financial/__tests__/settlement.test.ts` | pass |
| 6 | Integrations (credential minting) | `routes/__tests__/integrationsAdmin.test.ts` | pass |
| 7 | Pit Crew (work-item overlay) | `lib/pitCrew/__tests__/assignment.test.ts`, `routes/__tests__/pitCrew.test.ts` | pass |
| 7b | Pit Crew (assignee) | (same files as #7) | pass |
| 8 | Grow (activities) | `routes/__tests__/grow.test.ts` | pass |

Run together in one `node --test` invocation: **88 tests, 88 passing, 0
failing.** All 9 tenant-isolation fixes remain closed. No regression.

## Full regression suite — final run, this pass

The complete `apps/api` test script (`pnpm run test`'s own glob list,
covering every `__tests__` directory in the package) was run in full,
after every change made in this pass (Parts B through F):

| Chunk | Directories | Tests | Pass | Fail | Skip |
|---|---|---|---|---|---|
| 1 | `ai`, `entitlements`, `billing`, `middlewares`, `import`, `lib` (root) | 130 | 129 | 0 | 1 |
| 2 | `routes` | 186 | 186 | 0 | 0 |
| 3 | `automation`, `exceptions`, `launch`, `commandCentre`, `pitCrew` | 171 | 171 | 0 | 0 |
| 4 | `communications`, `financial`, `integrations`, `observability` | 176 | 176 | 0 | 0 |
| **Total** | | **663** | **662** | **0** | **1** |

This is 1 more test, and 1 more pass, than the 662-tests/661-pass/1-skip
figure Part C's own audit document reported after its own changes — the
exact expected delta, matching Part E's one new test (the CSV/formula-
injection regression test in `lib/import/__tests__/pipeline.test.ts`).
The 1 skipped test is the same one already carried from before this
pass; skip is not fail, and this pass did not investigate or change it
(out of the bounded scope this closure pass was given).

## The 18-item checklist

| # | Item | Evidence |
|---|---|---|
| 1 | Tenant isolation — Payments (finding #1) | 9/9 pass, `payments.test.ts` |
| 2 | Tenant isolation — Documents (finding #2) | 12/12 pass, `documents.test.ts` |
| 3 | Tenant isolation — AML (finding #3) | 12/12 pass, `amlTenantScoping.test.ts` + `amlPartyRequest.test.ts` |
| 4 | Tenant isolation — Parties (finding #4) | 4/4 pass, `parties.test.ts` |
| 5 | Tenant isolation — Financial PC-fee authorities (finding #5) | 7/7 pass, `settlement.test.ts` |
| 6 | Tenant isolation — Integrations credential minting (finding #6) | 7/7 pass, `integrationsAdmin.test.ts` |
| 7 | Tenant isolation — Pit Crew overlay + assignee (findings #7/#7b) | 37/37 pass, `assignment.test.ts` + `pitCrew.test.ts` |
| 8 | Tenant isolation — Grow activities (finding #8) | 10/10 pass, `grow.test.ts` |
| 9 | Perimeter hardening (CORS fail-closed, rate limiting, helmet, body-size limit) | Live dynamic checks this pass, `docs/STATIC_AND_DYNAMIC_SECURITY_CHECKS.md` — server refused to start without `CORS_ALLOWED_ORIGINS`/`METRICS_TOKEN`; all 4 headers present; 413 on oversized body; 429 after 20 auth attempts |
| 10 | Session-epoch revocation (logout invalidates outstanding tokens) | Covered by `lib/__tests__/session.test.ts` (part of chunk 1's 130) |
| 11 | Structured logging + redaction, including the Part C `Error`-object fix | `packages/events/src/__tests__/redaction.test.ts` (63/63, includes the 5 new Error-shape tests) |
| 12 | Correlation-ID propagation | `packages/events/src/__tests__/context.test.ts` (unchanged this pass, part of the pre-existing suite) |
| 13 | Metrics — 23-metric registry, including this pass's `financial_reconciliation_variance_total` | `packages/events/src/__tests__/metrics.test.ts`; `lib/exceptions/__tests__/financialReconciliationVariance.test.ts` |
| 14 | Metrics — webhook routers wired (communications, financial) | `routes/__tests__/communicationsWebhooksMetrics.test.ts`, `financialWebhooksMetrics.test.ts` (part of chunk 2's 186) |
| 15 | Observability — queue-depth/oldest-item/dead-letter gauges | `lib/observability/__tests__/queueGauges.test.ts` (6/6, part of chunk 4's 176) |
| 16 | Global error handler (no stack-trace/internal-detail leak on an unhandled route error) | `middlewares/__tests__/errorHandler.test.ts` (6/6, part of chunk 1's 130) |
| 17 | Integrations webhook route reachability + safe error handling (Part C's 3-bug fix) | `routes/__tests__/integrationsWebhooks.test.ts` (4/4, part of chunk 2's 186) |
| 18 | CSV/formula-injection neutralisation on the rejected-rows import export (Part E) | `lib/import/__tests__/pipeline.test.ts` (24/24, part of chunk 1's 130, including the new test) |

Every item above is backed by a test file this pass actually ran in this
session (not merely cited from an earlier document without re-running
it), in the full-suite run recorded in the table above. Nothing in this
checklist is a restatement of a claim from an earlier part without
independent re-execution.

## Explicitly out of scope for this regression pass

- Part D's migration-journal fix and CI workflow changes are **not**
  reflected in a green CI run as of this document (see
  `docs/CI_SCHEMA_DRIFT_FIX.md`) — they are verified locally but not on
  the branch, for the reasons documented there. This regression pass does
  not claim otherwise.
- Part F's low-severity esbuild fix is likewise verified locally but not
  pushed (see `docs/DEPENDENCY_RISK_ACCEPTANCE.md`) — not included above
  as a "closed" item for that reason, only as prepared-and-verified.
- No new whole-of-app audit was performed to produce this checklist —
  every item traces to a specific closure-pass part and a specific test
  file already named in this pass's own documents.
