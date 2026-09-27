# AE RUN COMPLETION ROADMAP

**Status:** ACTIVE — status record for the Run lane.
**Verified on:** staging tip `d0a7e771bc96124b18ba3064fdb03dbb3885de4c` (2026-09-27). That commit is the squash merge of #119.
**Maintenance rule:** update this file when a Run slice lands. Do not treat the Grow roadmap as the Run status record.

Claims below were checked against that tip and against merged pull requests (`gh pr view` merge commits). A statement that could not be checked is marked as such.

---

## 1. Purpose and scope

This file is the claim and status surface for Run work. `docs/AE_GROW_COMPLETION_ROADMAP.md` and `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md` record the Grow completion program. They do not list Run slices R-F1 through R-F11 as a lane. Parallel Grow and Run edits have been landing on the same metrics document (see §5).

**In scope for this lane:**

| Area | Where it lives on this tip |
|---|---|
| Transactions | `apps/api/src/routes/transactions.ts`, `apps/api/src/lib/transactions.ts` |
| Offers | `apps/api/src/routes/offers.ts` |
| Settlement / financial engine | `apps/api/src/routes/financial.ts`, `apps/api/src/lib/financial/**` |
| Pit Crew | `apps/api/src/routes/pitCrew.ts`, `apps/api/src/lib/pitCrew/**`, `packages/db/src/schema/pitCrew.ts` |
| `run.access` | `packages/db/src/schema/billing.ts` (`ENTITLEMENT_KEYS` includes `"run.access"` only as the RUN key) |
| Run metrics and alerts | `packages/events/src/metrics.ts`; Pit Crew sweep section of `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md` (§2c, §4 item 1) |

**Relation to the Grow documents.** Grow status stays in `docs/AE_GROW_COMPLETION_ROADMAP.md`. File ownership stays in `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`. This file does not move Grow findings, and it does not start the Owner-gated Grow IDs in §4. G-12 is a Grow slice; it is listed in §2 only because it added the `grow` label on the same counter the Run slices use.

The register's "Current staging" line and several Active rows still describe pre-merge Run claims (R-F6, R-F7, R-F8). Those rows were not rewritten by this document. Merged status for those slices is the table in §2.

---

## 2. Closed Run foundation slices (R-F1 to R-F11)

Each row is merged to `staging`. The SHA is the squash merge commit (`mergeCommit.oid`). Lock tests are files on this tip that fail if the slice's behaviour regresses. They are on the API or events test scripts (`apps/api/package.json` `test`, and `packages/events` tests where named).

| ID | What landed | PR | Squash SHA | Lock tests |
|---|---|---|---|---|
| R-F1 | `sweepOverdueWaitingOn()` returns Pit Crew rows in `WAITING_ON` whose `waitingOnExpectedAt` is strictly before now, through the same transition as `returnFromWaitingOn`. A null expected-at is not selected. The default audit actor is `ops:pit-crew-waiting-on-sweep`. No migration. | #102 | `36b741b031e0d790bf7fcb444575e9bee6ef9cc0` | `apps/api/src/lib/pitCrew/__tests__/waitingOnSweep.test.ts` |
| R-F2 | `requireEntitlement("run.access")` on every route in `apps/api/src/routes/transactions.ts` and on the authenticated routes in `apps/api/src/routes/offers.ts`. `GET /offers/public/:shareToken` stays unauthenticated. No new entitlement key. | #105 | `fac472db58dbd40c329e84749577b40642b9e746` | `apps/api/src/routes/__tests__/transactionRunAccess.test.ts` |
| R-F3 | `POST /pit-crew/ops/waiting-on/sweep` calls `sweepOverdueWaitingOn` for the session brokerage. Gates: `requireAuth`, Pit Crew or Brokerage Administrator, `run.access`. The body is not read. The audit actor is the caller. `GET /pit-crew/workspace` does not sweep. | #106 | `0110e0d9383344c65b5badeb54408b9bade75431` | `apps/api/src/routes/__tests__/pitCrewWaitingOnSweepRoute.test.ts`; actor case in `waitingOnSweep.test.ts` |
| R-F4 | Opt-in scheduled tick: `registerPitCrewWaitingOnSweep()` in `apps/api/src/lib/pitCrew/waitingOnSweepBootstrap.ts`, started from `apps/api/src/index.ts`. `PIT_CREW_WAITING_ON_SWEEP_ENABLED` must be the literal string `true`. Unset, `false`, `TRUE`, and `1` leave it off. No Postgres advisory lock; an in-process overlap guard skips a second tick in the same process. On this tip the tick is the R-F5 detection path, not the R-F1 return. The #109 PR body said the wake default was 900000 ms. The constant on this tip is `PIT_CREW_WAITING_ON_SWEEP_DEFAULT_INTERVAL_MS` = 1800000, clamped to [60000, 86400000] (`.env.example`). | #109 | `a86855b76a4fe941c93128a8400399d377f5320e` | `apps/api/src/lib/pitCrew/__tests__/waitingOnSweepScheduler.test.ts` |
| R-F5 | Scheduled path is detection-only. It does not call `sweepOverdueWaitingOn`. It records sightings and settings. Migration `packages/db/migrations/0031_pit_crew_waiting_on_detection.sql` creates `pit_crew_waiting_on_sweep_settings` and `pit_crew_waiting_on_sweep_sightings`. `GET /pit-crew/ops/waiting-on/detections` is the read. The human POST route from R-F3 still returns overdue rows to `IN_PROGRESS`. | #110 | `ae15762e81b089ddafc97b08c580408d268a6a2a` | `apps/api/src/lib/pitCrew/__tests__/waitingOnDetection.test.ts`; scheduler cases in `waitingOnSweepScheduler.test.ts` |
| R-F6 | Scheduled-path metrics `pit_crew_waiting_on_sweep_tick_total`, `pit_crew_waiting_on_sweep_tick_duration_ms`, `pit_crew_waiting_on_sweep_brokerage_total`, `pit_crew_waiting_on_sweep_item_total`. Repeated failure dispatches `PIT_CREW_WAITING_ON_SWEEP_UNHEALTHY` and `PIT_CREW_WAITING_ON_SWEEP_BROKERAGE_FAILED` after 3 consecutive ticks (`PIT_CREW_WAITING_ON_SWEEP_ALERT_AFTER_CONSECUTIVE_FAILURES`). The POST sweep route is not these metrics. No migration. Flag stays default off. | #112 | `51b9f26e07ddfe412a51391ceaee6bd02cc106bd` | `packages/events/src/__tests__/metrics.test.ts`; `apps/api/src/lib/__tests__/operationalAlerts.test.ts`; `apps/api/src/lib/pitCrew/__tests__/waitingOnSweepOperability.test.ts` |
| R-F7 | `GET /pit-crew/ops/waiting-on/health`. Same role gate and `run.access` as the POST sweep. Brokerage id comes from the session. The handler does not write, sweep, audit, or alert. Health is `ok`, `degraded`, `unhealthy`, or `not_running`. A missing migration 0031 stays 200 with `settingsAvailable: false`. | #113 | `43b5aafff78c39f8d4561733fbd7bfc8c98ac069` | `apps/api/src/routes/__tests__/pitCrewWaitingOnSweepHealth.test.ts`; snapshot assertions in `waitingOnSweepOperability.test.ts` |
| R-F8 | `tenant_isolation_rejection_total` at transaction, financial (`resolveTransactionScope` only), and authenticated offer checks. Offers use `boundary="transaction"` because the allowlist has no `offer` value. The counter increments only when the named row exists in another brokerage. A missing row, a role or entitlement 403, and a success do not increment it. Response status is unchanged. | #114 | `1fc6c0df08e1390c30b96e9d608b91fbbb1e8fba` | `apps/api/src/routes/__tests__/runTenantIsolationRejection.test.ts` |
| R-F9 | Same counter at property and party by-id misses (`boundary="property"`, `boundary="party"`) in `apps/api/src/routes/properties.ts` and `apps/api/src/routes/parties.ts`. | #116 | `edae2215e7041bf602a87da478094e464696f413` | `apps/api/src/routes/__tests__/runPropertyPartyIsolationRejection.test.ts` |
| R-F10 | Same counter on the remaining financial by-id misses (`boundary="financial"`, beyond `resolveTransactionScope`) and on pit crew (`boundary="pit_crew"`). Pit crew mismatch errors no longer increment inside the constructor; a genuine not-found does not increment. `financialWebhooks.ts` was not edited. | #117 | `077e2f7767a3a1e6672c7c470ba4acece26fc3b4` | `apps/api/src/routes/__tests__/runFinancialPitCrewIsolationRejection.test.ts` |
| R-F11 | `handoffWorkItem` calls `assertUserInBrokerage` before `loadOrCreateOverlay`. A `toUserId` in another brokerage is 404 `Assignee not found in this brokerage.` and increments `boundary="pit_crew"`. A user id that does not exist does not increment. | #118 | `72d6e4241fe3859d645c5aa1eeab09f3a1775eb5` | `apps/api/src/routes/__tests__/pitCrewHandoffRecipient.test.ts` |

**G-12 (Grow, not a Run slice).** #119, squash `d0a7e771bc96124b18ba3064fdb03dbb3885de4c`, added `grow` to the `boundary` allowlist in `packages/events/src/metrics.ts` and wired Grow by-id misses through `apps/api/src/lib/grow/isolationRejection.ts`. Lock test: `apps/api/src/routes/__tests__/growTenantIsolationRejection.test.ts`. It also edited the Run isolation tests so the allowlist assertion still passes.

`boundary="other"` is declared and has no increment site on this tip (`docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md` §5 item 2).

---

## 3. Open gaps

Status is what the code on this tip does. "Blocks" means the concrete fact that stops the gap from being closed, not a proposed design.

### Pit Crew source types beyond EXCEPTION

**Open.** `PIT_CREW_WORK_SOURCE_TYPES` in `apps/api/src/lib/pitCrew/types.ts` is `["EXCEPTION"]`. `getPitCrewWorkspace` (`apps/api/src/lib/pitCrew/queries.ts`) loads open risk exceptions only. `assertSourceRecordOnPropertyInBrokerage` returns immediately when `sourceType !== "EXCEPTION"`, and its comment says a second source type needs its own branch. Command Centre already projects ten source types in `COMMAND_CENTRE_SOURCE_TYPES` (`apps/api/src/lib/commandCentre/types.ts`), including `LAUNCH_ITEM`, `AUTOMATION_TASK`, `OFFER`, and the milestone types. The header of `queries.ts` still says Command Centre PR #14 is not merged. That sentence is stale: `apps/api/src/lib/commandCentre/` is on this tip.

**Blocks:** the workspace read and the source-record tenant check only implement `EXCEPTION`. Command Centre files are Grow-owned (§5).

### Agent hand-back / escalate verbs

**Open.** No Pit Crew function or route named hand-back or escalate was found. The route verbs in `apps/api/src/routes/pitCrew.ts` are claim, assign, start, waiting-on, return, complete, release, handoff, and note. `handoffWorkItem` is Pit Crew to Pit Crew and stays `CLAIMED` (`apps/api/src/lib/pitCrew/assignment.ts`). `releaseWorkItem` sets `UNCLAIMED` and clears the assignee. `PIT_CREW_STATUS_TRANSITIONS` has no escalate target. `exception_escalates_next_business_day` in `waitingOnDetection.ts` is a detection reason string. The scheduled sweep comment says it never escalates or reassigns. Exception-engine `POST /exceptions/:id/reassign` changes the exception owner; it is not a Pit Crew verb.

**Blocks:** there is no status, transition, or route for those verbs.

### Unified allocator across tasks, exceptions, and launch items

**Open.** A search of the repository found no symbol named allocator. Command Centre builds `ActionItem` rows from its ten source types in `apps/api/src/lib/commandCentre/queries.ts`. Pit Crew buckets exceptions in `getPitCrewWorkspace`. Those two projections are not joined.

**Blocks:** no shared assignment writer exists, and the Pit Crew source-type check does not cover the Command Centre types. Editing `lib/commandCentre/**` collides with Grow (§5).

### Pit Crew AI context stub

**Open.** `buildPitCrewContext` in `apps/api/src/lib/ai/context/pitCrewContext.ts` returns `null`. The file comment says the AML route `GET /aml/service-orders-by-property/:propertyId` is left unread. `buildGrowContext` in `growContext.ts` is a real read; this function is not.

**Blocks:** the function has no read. `lib/ai/context/**` is recorded in the register as outside the C-10 claim and inside Performance/Coach discovery (Owner decisions #4 and #5). This document does not start that work.

### Commission dual-path

**Open.** Two writers store commission:

- `calculateCommission` in `apps/api/src/lib/transactions.ts` writes `transactions.grossCommissionCents` and `gstCents` from `agencyAgreementTerms`.
- `finalizeCommissionForSettlement` in `apps/api/src/lib/financial/settlement.ts` is a no-op when no `APPROVED` `commissionAgreement` exists, and otherwise writes `commissionCalculations`.

`apps/api/src/lib/financial/legacyReconciliation.ts` flags a closed legacy transaction that has gross cents and no financial-engine agreement. It does not invent a method or rate. Its header still says the partial unique index has not been applied as a migration. That sentence is stale on this tip: `packages/db/migrations/0009_flimsy_norrin_radd.sql` creates `financial_reconciliations_legacy_commission_unique_idx`.

**Blocks:** the legacy `transactions` row stores output totals only. The module's own comment says materialising a `commissionAgreement` would require a method that was never stored.

### Listing lifecycle

**Partly present. No single unfinished module with this name was found.** `WORKFLOW_STAGES` in `packages/db/src/schema/property.ts` is Appraisal, Ready to List, Listed, Under Offer, Contract, Settlement, Closed. Writers on this tip: Ready to List in `apps/api/src/routes/properties.ts`; Listed and `listingStatus = "Listed"` in `apps/api/src/lib/goLive.ts` (also called from `apps/api/src/lib/launch/model.ts`); Under Offer, Contract, Settlement, and Closed in `apps/api/src/lib/transactions.ts`. `listingStatus` is not written again after `"Listed"`. Listing-preparation columns (`salesMethod`, `priceDisplay`, campaign dates) are described in `property.ts` as informational and do not publish a listing. Exception rule #9 in `apps/api/src/lib/exceptions/rules/listing.ts` is deferred: the comment says no field records the dependency it would check.

**Blocks for the deferred rule:** the missing field named in that comment. A broader "listing lifecycle" product gap, beyond the facts above, was not found as a named task in code.

### Placeholder document / brokerage rules

**Open. Legal gate.** `apps/api/src/lib/documentRules.ts` says the rule set is still a placeholder (`DOCUMENT_RULE_SET_VERSION = 1`) and that legal review against current state legislation has not happened. `apps/api/src/lib/documentTemplates.ts` prefixes rendered text with `TEMPLATE PLACEHOLDER — NOT LEGAL ADVICE` and says a licensed conveyancer or lawyer must review it before it is sent for signature. Rules are code constants keyed by AU state (`STATE_DOCUMENTS`), plus `BASE_DOCUMENTS`. No brokerage-rules module and no per-brokerage document-rule table were found.

**Blocks:** the file comments require that legal review. This document does not treat the placeholder text as approved content.

### Live Pit Crew fee collection

**Open. Legal and commercial gate.** Authorities, calculations, and the payment outbox exist (`apps/api/src/lib/financial/pcFeeAuthorities.ts`, `pcFeeCalculations.ts`, `paymentOutbox.ts`; routes under `/financial/pc-fee-*`). `createMandatePaymentProvider` in `packages/integrations/mandate-payments/src/index.ts` always returns `SandboxMandatePaymentProvider`. Any other `MANDATE_PAYMENT_PROVIDER` value logs `mandate_payment_provider_fallback_to_sandbox` and still returns the sandbox. The comment cites `docs/gate-evidence/PHASE10_BILLING_AND_EXTERNAL_ACTION_LOCKS.md`: no live direct-debit or PC success-fee implementation exists for the env var to select. That phase document records the Owner instruction that no automated PC success-fee transaction is authorised.

**Blocks:** there is no live provider branch, and the Phase 10 instruction forbids authorising one here.

### Fine-grained Run entitlements

**Deferred.** `packages/db/src/schema/billing.ts` says `run.access` is one coarse key for the RUN surface and that a finer-grained RUN taxonomy is deferred. `ENTITLEMENT_KEYS` has no other `run.*` key. On this tip `run.access` is required by Pit Crew routes, `requireFinancialAdmin` in `routes/financial.ts`, transaction routes, authenticated offer routes, and `POST /grow/appraisals/:id/run-handoff` in `routes/growAppraisals.ts`.

**Blocks:** the schema comment defers the taxonomy. Adding keys would be a catalogue change, which R-F2 explicitly did not do.

### `communications` and `integrations` tenant-metric labels

**Already wired.** They are not an open Run gap on this tip.

- `boundary="communications"` increments inside the `CommunicationTenancyError` constructor (`apps/api/src/lib/communications/types.ts`). The comment says the constructor treats "does not exist" and "another tenant" the same, so a genuine not-found increments the counter. That is the Step 2 constructor wiring. It is not the R-F8 miss-only existence lookup.
- `boundary="integrations"` increments inside `IntegrationError` when `reason` is `NOT_FOUND` or `TENANT_MISMATCH` (`apps/api/src/lib/integrations/types.ts`). Same constructor style.

R-F8, R-F9, R-F10, R-F11, and G-12 did not change these two constructors. `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md` §4 item 1 and §5 item 2 already count both labels as wired (8 of 9 declared boundaries; `other` unused).

---

## 4. Owner decisions and gated items

Each row is **not started / Owner-gated**. This document does not recommend a choice.

| Item | One-line description |
|---|---|
| `PIT_CREW_WAITING_ON_SWEEP_ENABLED` enablement and cadence | The scheduler code is on this tip and stays off unless the env value is the literal `true`. Process wake default is 1800000 ms; per-brokerage cadence default on `pit_crew_waiting_on_sweep_settings` is also 1800000 ms, window Mon–Fri 08:00–18:00 (`waitingOnDetection.ts`, `.env.example`). Turning the flag on, and choosing a cadence, is an Owner/ops step. `.env.example` leaves the flag commented out. |
| `run.access` on `routes/launch.ts` | No launch route calls `requireEntitlement`. `GET /properties/:propertyId/launch` is `requireAuth` only. `apps/web/src/pages/PropertyWorkspace.tsx` loads that path for the property card. A `run.access` gate on that read would 403 a brokerage that does not hold `run.access`. |
| `run.access` on AML, documents, and exceptions routes | `routes/aml.ts`, `routes/documents.ts`, and `routes/exceptions.ts` have no `requireEntitlement("run.access")` call. |
| `/exceptions/ops/health` and `/exceptions/ops/scan` | Both require `requireRole(...BROKERAGE_ADMIN_ROLES)` only. The health handler selects the latest `risk_exception_scan_runs` with no brokerage filter. The scan handler calls `runScheduledScan("MANUAL")` with no `brokerageIds`, and `engine.ts` says the omitted option means every brokerage. No platform-operator role is applied on these two routes. |
| Per-brokerage sweep settings API | The settings table and `upsertPitCrewWaitingOnSweepSettings` exist (`waitingOnSweepSettings.ts`). The only non-test caller found is the detection run's own write (`markPitCrewWaitingOnSweepRan` from the scheduler). No HTTP route reads or writes the settings as an admin API. |
| `TRUST_PROXY` configuration | `parseTrustProxySetting` is applied in `apps/api/src/app.ts` and fails safe to trusting nothing when unset, empty, `false`, or unparseable. `.env.example` ships `TRUST_PROXY=` blank. The production hop count is an operator setting, not a value this repository sets. |

**Hard-gated IDs, untouched by this document and by R-F1–R-F11.** Descriptions are the Grow roadmap's, not new findings.

| ID | One-line description |
|---|---|
| C-1 | Coaching metrics are brokerage-wide and presented as the agent's own. |
| E-1 | The Grow Appraisal Workspace API has no web client. |
| G-1 | Calling surfaces do not explain a missing `grow.calling.*` entitlement. |
| H-5 | Document-storage and call-transcription reconcilers use an in-process `running` flag and no advisory lock; rate limiters use `MemoryStore`. |
| F-4 | DECISION A (contactability) is unimplemented on the commitment surfaces. |
| Performance/Coach | Implementation stays gated on Grow Owner decisions #4 and #5. C-9 closed the recent-activity order; it did not start the product. |
| B-2 / W4-B | No signal-to-nurture path (B-2). W4-B is the nurture architecture slice, gated on Owner decision #10 (outbound posture). |
| A-8 | Three consent models are unreconciled. |
| Owner #15 | Run-table retention for the property-signal sweep. The Grow roadmap leaves it open. |

---

## 5. Collision rules for Run work

Do not edit these Grow-owned trees in a Run slice. Paths below are where those trees sit on this tip:

- `apps/api/src/lib/commandCentre/**` (there is also `apps/web/src/lib/commandCentre.ts`, claimed with the Command Centre in the ownership register)
- `apps/api/src/lib/grow/**`
- `apps/api/src/lib/communications/**`
- `apps/api/src/lib/propertyIntelligence/**`
- `docs/AE_GROW_*`

`docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md` is shared. It was edited by Run #112, #113, #114, #116, #117, and #118, and by Grow #119. Two open pull requests that both edit it have to be rebased onto each other before merge. A Run slice that only needs a status note belongs in this file, not in that metrics document.

`docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md` remains the ownership record. A Run implementation slice still needs a claim row there before it edits code. This document does not add a claim row.

---

## 6. Changelog

| Date | Change |
|---|---|
| 2026-09-27 | **R-F12 (#120).** This document added. Verified against staging tip `d0a7e771bc96124b18ba3064fdb03dbb3885de4c`. One pointer line added to `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`. No code, test, migration, config, or feature-flag change. |
