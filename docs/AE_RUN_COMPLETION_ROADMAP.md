# AE RUN COMPLETION ROADMAP

**Status:** ACTIVE — status record for the Run lane.
**Verified on:** staging tip `07c4c4512cfb14a0b38003b1e6190cd3b860e7f2` (2026-09-28). That commit is the squash merge of #132 (R-F22). R-F23 is not yet merged.
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

## 2. Closed Run foundation slices (R-F1 to R-F11, and R-F13 to R-F23)

Each row except R-F23 is merged to `staging`. The SHA is the squash merge commit (`mergeCommit.oid`). R-F23's squash SHA is pending merge. Lock tests are files on this tip that fail if the slice's behaviour regresses. They are on the API, events, or web test scripts (`apps/api/package.json` `test`, `packages/events` tests where named, and `apps/web` tests where named). R-F12 is this file (see §6). It is not a behaviour row. R-F18 is the previous status update in §6. It is not a behaviour row. R-F20 is the design document for the second source type.

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
| R-F13 | Design only: `docs/design/PIT_CREW_HANDBACK_ESCALATE_DESIGN.md`. Recommends an append-only `pit_crew_responsibility_events` table, statuses `HANDED_BACK` and `ESCALATED`, recipient resolution in one function, and flag `PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED` enabled only for the literal string `"true"`. A later `pit_crew_escalation_routing_rules` table is described as a read inside that function, not as v1. This pull request changed no schema, route, or behaviour. The file's own opening line still says "proposal only" and names tip `d0a7e77`. Later rows in this table are what landed after it. | #121 | `5be8f019797fe55aaec88e72583ea8d06e313f02` | None. The slice is the design document. |
| R-F14 | Schema and migration `packages/db/migrations/0032_pit_crew_responsibility_events.sql`. Creates `pit_crew_responsibility_events` only. No `ALTER` of `pit_crew_assignments`, no backfill, and no `routing_rule_id`. `HANDED_BACK` and `ESCALATED` are added to `PIT_CREW_ITEM_STATUSES` in `packages/db/src/schema/pitCrew.ts`. This pull request did not add the flag or a runtime writer. | #122 | `9559c03a1f6efc67e0fd25d80fcda973aae28843` | `apps/api/src/lib/__tests__/pitCrewResponsibilityEventsSchema.test.ts` |
| R-F15 | Library in `apps/api/src/lib/pitCrew/responsibility.ts`: hand-back, escalate, acknowledge, resolve, return, reclaim, and `resolveResponsibilityRecipient`. Migration `packages/db/migrations/0033_pit_crew_responsibility_closing_note.sql` adds nullable `closing_note`. Resolve and return write `closingNote` and leave the escalation `note`. `isPitCrewResponsibilityActionsEnabled` is true only when the env value is the literal string `"true"`. While it is not, the new functions throw `PitCrewResponsibilityDisabledError` before any read or write of `pit_crew_responsibility_events`, and `getPitCrewWorkspace` does not query that table. Added transitions: `CLAIMED`, `IN_PROGRESS`, and `WAITING_ON` to `HANDED_BACK` or `ESCALATED`; `HANDED_BACK` to `CLAIMED`; `ESCALATED` to `IN_PROGRESS`. `DONE` stays terminal. `routingRuleId` is always null. | #123 | `eec22c0a289b7cd370e07f8b91fc8fc1cbe126ef` | `apps/api/src/lib/pitCrew/__tests__/responsibility.test.ts`; `closing_note` assertions in `pitCrewResponsibilityEventsSchema.test.ts` |
| R-F16 | Six `POST` routes on the existing Pit Crew router: `/pit-crew/items/:sourceType/:sourceRecordId/hand-back`, `.../escalate`, `.../escalation/acknowledge`, `.../escalation/resolve`, `.../escalation/return`, and `.../hand-back/reclaim`. Middleware order is `requireAuth`, Pit Crew or Brokerage Administrator, and `run.access`. The handler then returns 404 `{ "error": "Not found." }` before zod and before any table read unless `PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED` is the literal `"true"`. No migration. No inbox route in this pull request. | #124 | `5e994dda4dee2b028b7d7e377252654d95db615b` | `apps/api/src/routes/__tests__/pitCrewResponsibility.test.ts` |
| R-F16 | `GET /pit-crew/responsibility-inbox`. The flag check runs before auth and returns the same 404 when the value is not the literal `"true"`. The route's own role list is Agent, Pit Crew, and Brokerage Administrator, plus `run.access`. No query params. Brokerage id, user id, and role come from the session. The read is `listResponsibilityItemsForRecipient`: `OPEN` or `ACKNOWLEDGED` events for the caller. `CommandCentre.tsx`, `lib/commandCentre/**`, and `/today` were not edited. | #125 | `6ce2fed6bcaffc945e908501f7f5357a4d570590` | `apps/api/src/lib/pitCrew/__tests__/responsibilityInbox.test.ts`; `apps/api/src/routes/__tests__/pitCrewResponsibilityInbox.test.ts` |
| R-F16 | Pit Crew page actions in `apps/web/src/pages/PitCrewCommandCentre.tsx` and `apps/web/src/lib/pitCrew.ts`. Hand back, escalate, reclaim, acknowledge, resolve, and return call the six POST routes. The page probes `GET /pit-crew/responsibility-inbox`. A 404 leaves the new tabs and buttons unmounted. `CommandCentre.tsx`, `commandCentre.ts`, and `todaySurfaces.ts` were not edited. | #126 | `50ea65645c761fa1bce533b0a31c60e29ec73a84` | `apps/web/src/lib/__tests__/pitCrewResponsibility.test.ts`; `apps/web/src/lib/__tests__/pitCrewResponsibility.behavior.test.ts` |
| R-F17 | Recipient picker. `GET /pit-crew/responsibility-recipients` takes `kind` `HAND_BACK` or `ESCALATE`. The flag check runs before auth, as on the inbox route, and returns 404 unless the value is the literal `"true"`. The role gate is Pit Crew or Brokerage Administrator, plus `run.access`. `HAND_BACK` lists active Agents in the caller's brokerage. `ESCALATE` lists active Brokerage Administrators. The list is capped at `RESPONSIBILITY_RECIPIENT_LIST_CAP` (500) after display-name order. The response is `userId`, `displayName`, and `role`. The Pit Crew page search uses that read. Workspace and inbox items also carry `recipientDisplayName` and `operatorDisplayName`. No migration. The six POST contracts are unchanged. | #127 | `ec98e5076fb411dedd4081731f6b09266710f93f` | `apps/api/src/lib/pitCrew/__tests__/responsibilityRecipients.test.ts`; `apps/api/src/routes/__tests__/pitCrewResponsibilityRecipients.test.ts` |
| R-F19 | Stale-comment correction and a flag-off route lock. The Pit Crew page header now says Command Centre is on staging and that this page does not import it. `financial_reconciliations_legacy_commission_unique_idx` comments now say migration 0009 creates the index and that `.onConflictDoNothing()` is the active race guard. The lock enumerates Pit Crew routes whose paths contain `responsibility`, `hand-back`, `escalate`, or `escalation` and requires exactly the known eight. For flag unset, empty, `false`, `TRUE`, and `1`, an authenticated caller who passes the role and `run.access` gates gets 404 `{ "error": "Not found." }` and `pit_crew_responsibility_events` is not read or written. No migration. No schema change. No behaviour change. Flags stay default off. | #129 | `3c369d87bac2ac552b1a7cc43acddb8f447c9bdf` | `apps/api/src/routes/__tests__/pitCrewResponsibilityFlagOffLock.test.ts` |
| R-F20 | Design only: `docs/design/PIT_CREW_SECOND_SOURCE_TYPE_DESIGN.md`. Recommends `LAUNCH_ITEM` (`campaign_items`) as the first second source, the same relevance rule exceptions already use, overlay-only `DONE`, severity `INFORMATION` and category `LAUNCH_CAMPAIGN`, and flag `PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED` enabled only for the literal string `"true"`. Hand-back stays `EXCEPTION`-only until a later pull request. This pull request changed no schema, route, or behaviour. The file's own opening line still says "proposal only" and names tip `3c369d87`. | #130 | `9a851e9222dcba9dc69737e30bb80450ec33c611` | None. The slice is the design document. |
| R-F21 | Unknown Pit Crew source types are rejected. `assertSourceRecordOnPropertyInBrokerage` throws `PitCrewPropertyMismatchError("Work item not found in this brokerage.")` when `sourceType` is not in `PIT_CREW_WORK_SOURCE_TYPES` (`["EXCEPTION"]`). Routes already map that error to 404 `{ "error": "Work item not found in this brokerage." }`, the same status and body as a missing exception. An unknown type does not increment `tenant_isolation_rejection_total`. `itemParamsSchema` stays `z.string().min(1)`, because an enum would return 400 `{ "error": "Invalid request." }` for a well-formed request. Claim, assign, start, waiting-on, return, complete, release, and handoff are covered for `LAUNCH_ITEM`, `AUTOMATION_TASK`, `OFFER`, and a random string, on a property in the caller's own brokerage, and no `pit_crew_assignments` row is inserted or updated. The EXCEPTION branch is unchanged. No migration. No schema change. No second source type. Existing non-EXCEPTION rows in any live database, if any were created through the old path, are not touched. | #131 | `6f104398ed0caf689af271c7e40f8ed0d9a4c445` | `apps/api/src/routes/__tests__/pitCrewSourceTypeGuard.test.ts` |
| R-F22 | API-only `LAUNCH_ITEM` source behind `PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED`. The flag is on only for the literal string `"true"`. Default off. While off, every source type other than `EXCEPTION` still returns 404 `{ "error": "Work item not found in this brokerage." }`, no overlay row is written, and `campaign_items` is not read or written. While on, the tenant check requires a UUID `campaign_items` row in the caller's brokerage and property, and `getPitCrewWorkspace` includes open campaign items whose responsible owner is `PIT_CREW` or `UNASSIGNED_QUEUE`, or whose overlay version is greater than 0. Those items use severity `INFORMATION`, category `LAUNCH_CAMPAIGN`, and the campaign item status in `exceptionStatus`. Claim, assign, start, waiting-on, return, complete, release, and handoff update the overlay only and do not write `campaign_items`. Hand-back and escalate stay `EXCEPTION`-only. `routes/launch.ts`, Command Centre, and the web app are unchanged. No migration. The flag is not enabled. | #132 | `07c4c4512cfb14a0b38003b1e6190cd3b860e7f2` | `apps/api/src/routes/__tests__/pitCrewLaunchItemSource.test.ts`; `apps/api/src/routes/__tests__/pitCrewLaunchItemImportLock.test.ts`; `apps/api/src/lib/pitCrew/__tests__/launchItemWorkspace.test.ts`; `apps/api/src/routes/__tests__/pitCrewSourceTypeGuard.test.ts` |
| R-F23 | Web Launch section on `/pit-crew`. `launchCoordination` is rendered as the API sends it, so `LAUNCH_CAMPAIGN` exceptions and `LAUNCH_ITEM` campaign items stay in the same section. When that list contains a campaign item, each card is labelled `Campaign item` or `Exception`. When it does not, the section text is unchanged and there is no empty campaign-item block. Hand-back and escalate stay hidden on `LAUNCH_ITEM` cards and stay available on `EXCEPTION` cards. Claim, assign, start, waiting-on, return, complete, release, handoff, and notes still post to `/pit-crew/items/:sourceType/:id/...` with `sourceType` `LAUNCH_ITEM`. The page does not call `/launch`. Team capacity still shows `activeItemCount` from the API. Cost and vendor fields are not rendered. The inbox is unchanged. No API change. No migration. `PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED` and `PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED` are untouched. | open | pending merge | `apps/web/src/lib/__tests__/pitCrewLaunchItem.behavior.test.ts` |

**G-12 (Grow, not a Run slice).** #119, squash `d0a7e771bc96124b18ba3064fdb03dbb3885de4c`, added `grow` to the `boundary` allowlist in `packages/events/src/metrics.ts` and wired Grow by-id misses through `apps/api/src/lib/grow/isolationRejection.ts`. Lock test: `apps/api/src/routes/__tests__/growTenantIsolationRejection.test.ts`. It also edited the Run isolation tests so the allowlist assertion still passes.

`boundary="other"` is declared and has no increment site on this tip (`docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md` §5 item 2).

---

## 3. Open gaps

Status is what the code on this tip does. "Blocks" means the concrete fact that stops the gap from being closed, not a proposed design.

### Pit Crew source types beyond EXCEPTION

**Partly present.** R-F22 adds `LAUNCH_ITEM` (`campaign_items`) behind `PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED`. The flag is on only for the literal string `"true"`. Unset, empty, `false`, `TRUE`, and `1` leave it off. While off, `assertSourceRecordOnPropertyInBrokerage` rejects every source type other than `EXCEPTION` with the same 404 a missing exception returns, writes no overlay row, and does not query `campaign_items`. `getPitCrewWorkspace` does not query `campaign_items` either. While on, a `LAUNCH_ITEM` id must be a UUID campaign item in the caller's brokerage and property. The workspace then includes open campaign items (status other than `COMPLETE`) whose responsible owner is `PIT_CREW` or `UNASSIGNED_QUEUE`, or whose overlay version is greater than 0. That is the same relevance rule exceptions already use. There is no Command Centre due-date horizon. The cards use severity `INFORMATION`, category `LAUNCH_CAMPAIGN`, and the campaign item status in `exceptionStatus`. Launch-campaign exceptions stay in that section as well. Claim, assign, start, waiting-on, return, complete, release, and handoff update the overlay only and do not write `campaign_items`. Hand-back and escalate stay `EXCEPTION`-only on the API. `getPitCrewTeam` still counts every active overlay, so a claimed launch item counts toward capacity. The waiting-on sweep still changes overlay status only. `routes/launch.ts` is unchanged. `PIT_CREW_WORK_SOURCE_TYPES` stays `["EXCEPTION"]`. The flag is not enabled. R-F23 renders that workspace list in the Pit Crew Launch section. A campaign item is labelled `Campaign item` and a launch exception is labelled `Exception` only when the list contains a campaign item. Hand-back and escalate are not offered on `LAUNCH_ITEM` cards. The page posts item actions to the Pit Crew routes and does not call `/launch`. It shows the API team count unchanged and does not render cost or vendor fields.

**What remains.** Hand-back and escalate for `LAUNCH_ITEM`, and the inbox title, are design sequence PR 3. The inbox join still requires `EXCEPTION`. `AUTOMATION_TASK` and the other Command Centre sources are still rejected. A `CHECK` on `source_type` is still a later migration. Turning the flag on is an Owner decision, and only after someone with database access confirms live constraints beyond migration 0033. Command Centre files stay Grow-owned (§5).

**Blocks:** those leftovers. This document does not start them.

### Agent hand-back / escalate verbs

**Partly present.** The verbs are on this tip. Every one of them stays off unless `PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED` is the literal string `"true"`. Unset, empty, `false`, `TRUE`, and `1` leave them off. While off, `GET /pit-crew/responsibility-inbox` and `GET /pit-crew/responsibility-recipients` return 404 `{ "error": "Not found." }` before auth, and they do not read `pit_crew_responsibility_events`. The six POST routes still run `requireAuth`, the Pit Crew or Brokerage Administrator role gate, and `run.access` first. A caller who passes those gates then gets the same 404, before zod and before any read of that table. The library throws `PitCrewResponsibilityDisabledError` before any read or write of that table, and `getPitCrewWorkspace` does not query it.

What the flag gates, from §2:

- `handBackWorkItem`, `escalateWorkItem`, `acknowledgeEscalation`, `resolveEscalation`, `returnEscalation`, and `reclaimHandedBack` in `apps/api/src/lib/pitCrew/responsibility.ts`, plus `resolveResponsibilityRecipient`.
- Statuses `HANDED_BACK` and `ESCALATED` on `PIT_CREW_STATUS_TRANSITIONS` in `apps/api/src/lib/pitCrew/types.ts`. Hand-back and escalate run from `CLAIMED`, `IN_PROGRESS`, and `WAITING_ON`. Reclaim is `HANDED_BACK` to `CLAIMED`. Resolve and return are `ESCALATED` to `IN_PROGRESS` and write `closing_note` (migration 0033). Acknowledge leaves the assignment on `ESCALATED`.
- Table `pit_crew_responsibility_events` (migration 0032).
- The six POST routes, the inbox read, the Pit Crew page actions, and the recipient picker.

`handoffWorkItem` is still Pit Crew to Pit Crew and does not change status (`apps/api/src/lib/pitCrew/assignment.ts`). `releaseWorkItem` still sets `UNCLAIMED` and clears the assignee. `exception_escalates_next_business_day` in `waitingOnDetection.ts` is still a detection reason string. The scheduled-sweep comment in `waitingOnSweepBootstrap.ts` still says that path never escalates or reassigns. `POST /exceptions/:id/reassign` still changes the exception owner. It is not a Pit Crew verb.

**What remains.** The `/today` surface is deferred. Placing the inbox on that page would touch Command Centre and today-surface files outside the Run lane (`apps/web/src/pages/CommandCentre.tsx`, `apps/web/src/lib/commandCentre.ts`, `apps/web/src/lib/todaySurfaces.ts`, `apps/api/src/lib/commandCentre/**`). The escalation routing-rules table is a later option from `docs/design/PIT_CREW_HANDBACK_ESCALATE_DESIGN.md`. `resolveResponsibilityRecipient` returns `routingRuleId: null`. There is no `pit_crew_escalation_routing_rules` table and no `routing_rule_id` column.

**Blocks:** those two leftovers. This document does not start either.

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

`apps/api/src/lib/financial/legacyReconciliation.ts` flags a closed legacy transaction that has gross cents and no financial-engine agreement. It does not invent a method or rate.

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
| `PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED` enablement | Enabling this flag on a persistent environment is an Owner/ops step, and only after migrations 0032 and 0033 are applied there. The routes and library stay off unless the env value is the literal `true`. `.env.example` leaves the flag commented out. This file does not record any environment's live state. |
| `PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED` enablement | The API and the Pit Crew Launch section stay off this source unless the env value is the literal `true`. Enabling it is an Owner/ops step. Live database constraints beyond migration 0033 have to be confirmed by someone with database access before the flag is turned on. This file does not enable the flag and does not record any environment's live state. |
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
| 2026-09-27 | **R-F18.** Status after R-F13 to R-F17. Verified against staging tip `ec98e5076fb411dedd4081731f6b09266710f93f` (squash merge of #127). §2 adds those slices. §3 rewrites the hand-back / escalate gap. §4 records flag enablement as an Owner/ops step after migrations 0032 and 0033. The `queries.ts` sentence R-F12 called stale was already rewritten by #123, so this change does not edit that file. The Pit Crew page header still says PR #14 is unmerged; correcting that comment is a follow-up. No code, test, migration, config, CI, or feature-flag change. |
| 2026-09-27 | **R-F19 (#129).** Stale comments and a flag-off route lock. Verified against staging tip `368cbc50d0010df9449f55db023146060d1ce286` (squash merge of #128). §2 adds this slice. Squash SHA `3c369d87bac2ac552b1a7cc43acddb8f447c9bdf`. §3 drops the Pit Crew page-comment follow-up and the stale `legacyReconciliation.ts` index sentences. Comment-only corrections elsewhere. Lock test `apps/api/src/routes/__tests__/pitCrewResponsibilityFlagOffLock.test.ts`. No migration, schema, behaviour, or feature-flag change. |
| 2026-09-28 | **R-F21 (#131).** Pit Crew source-type guard. `assertSourceRecordOnPropertyInBrokerage` rejects a `sourceType` outside `PIT_CREW_WORK_SOURCE_TYPES` with the same 404 a missing exception returns, and does not increment `tenant_isolation_rejection_total`. `itemParamsSchema` is left unchanged so that request stays 404 rather than 400. The EXCEPTION branch is unchanged. Lock test `apps/api/src/routes/__tests__/pitCrewSourceTypeGuard.test.ts`. §2 adds this slice. Squash SHA `6f104398ed0caf689af271c7e40f8ed0d9a4c445`. No migration, schema change, or second source type. Existing non-EXCEPTION overlay rows, if any, are not touched. |
| 2026-09-28 | **R-F19, R-F20, R-F21 status.** Squash SHAs recorded: R-F19 `3c369d87bac2ac552b1a7cc43acddb8f447c9bdf` (#129), R-F20 `9a851e9222dcba9dc69737e30bb80450ec33c611` (#130), R-F21 `6f104398ed0caf689af271c7e40f8ed0d9a4c445` (#131). |
| 2026-09-28 | **R-F22.** API-only `LAUNCH_ITEM` source behind `PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED`, literal `"true"` only, default off. While off, non-`EXCEPTION` item actions stay the missing-exception 404 and `campaign_items` is not queried. While on, the workspace includes relevant open campaign items and complete updates the overlay only. Hand-back stays `EXCEPTION`-only. No migration. Flag not enabled. Open questions in the design use its recommendations (see the pull request). |
| 2026-09-28 | **R-F22 merged.** Squash SHA `07c4c4512cfb14a0b38003b1e6190cd3b860e7f2` (#132). |
| 2026-09-28 | **R-F23.** Pit Crew Launch section renders `LAUNCH_ITEM` rows beside `LAUNCH_CAMPAIGN` exceptions when the workspace includes them, labels the two sources, and hides hand-back and escalate on campaign items. With no campaign items the section text is unchanged. Item actions stay on the Pit Crew routes. No API change, no migration, no flag change. Inbox unchanged. |
