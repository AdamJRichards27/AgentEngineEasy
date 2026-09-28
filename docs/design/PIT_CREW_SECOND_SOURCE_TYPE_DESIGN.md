# Pit Crew second work source type — design proposal

Status: proposal only. Nothing in this document is implemented. Staging tip verified for this proposal: `3c369d87` (`R-F19: stale comments and flag-off responsibility route lock (#129)`). Migration journal on that tip ends at `0033_pit_crew_responsibility_closing_note` (`packages/db/migrations/meta/_journal.json`).

This proposal does not change schema, routes, or behaviour. It records the current code and the facts the Owner needs in order to pick the second Pit Crew source type.

The Owner currently wants no new pending migration until the paused Replit activation finishes. Each candidate below says whether the first implementation can be code-only.

## Decisions required from the Owner

These are product choices. Implementation should not start until the Owner has accepted or replaced each recommended answer.

### 1. Which source type comes first

Recommended answer: `LAUNCH_ITEM`, meaning one `campaign_items` row. Reasons are in Recommendation.

The other verified candidates are `AUTOMATION_TASK` (`automation_tasks`), `WORKFLOW_ACTION` (`workflow_steps`), and `CONTRACT_MILESTONE` (`transaction_conditions`). There is no separate `tasks` table. Command Centre also names `OFFER`, `SETTLEMENT_MILESTONE`, `VENDOR_APPROVAL`, `PROPERTY_MILESTONE`, and `PORTAL_DESTINATION`. Those were checked. They are weaker first sources. See Per candidate source.

### 2. Which rows of that source are Pit Crew's

Recommended answer for `LAUNCH_ITEM`: the same relevance rule exceptions already use. A campaign item is in the workspace when `responsible_owner_type` is `PIT_CREW` or `UNASSIGNED_QUEUE`, or when an overlay row already exists. Do not copy Command Centre's due-date horizon. That horizon hides campaign items with no `due_at`, and items due outside today and the coming-up window (`apps/api/src/lib/commandCentre/queries.ts` lines 254–269).

`AUTOMATION_TASK` does not use `RISK_EXCEPTION_OWNER_TYPES`. `assigned_role` is a user role or null (`packages/db/src/schema/automation.ts` lines 338–340). If the Owner picks this source, they must say which rows count: `assigned_role` null, `assigned_role` equal to `Pit Crew`, both, or every `ACTIVE` row. That choice is not in the code.

`CONTRACT_MILESTONE` and `WORKFLOW_ACTION` have no owner column. If either is chosen, the Owner must say whether every open row on a brokerage property is Pit Crew's, or only rows that already have an overlay.

### 3. Pit Crew `DONE` must not change the source record

Recommended answer: yes, for every candidate. `completeWorkItem` today sets the overlay to `DONE` and writes an audit row. It does not update `risk_exceptions` (`apps/api/src/lib/pitCrew/assignment.ts` lines 557–559 and 280–296). The second source should keep that split.

Calling the source's own complete function is a different product. For launch items that function also recomputes budget, market-ready, and plan status. For contract conditions it can mark the transaction unconditional. Those functions are listed under Safety and must not be called from Pit Crew actions.

### 4. How a non-exception item fills `PcWorkItem`

`PcWorkItem.severity` is required and is one of `INFORMATION`, `ATTENTION`, `AT_RISK`, `CRITICAL` (`apps/api/src/lib/pitCrew/types.ts` lines 52–61). Campaign items, automation tasks, workflow steps, and contract conditions have no severity column. Command Centre sends `severity: null` for those sources (`apps/api/src/lib/commandCentre/queries.ts` lines 594, 748, 825, 863).

Recommended answer: keep the existing card. Send `severity: "INFORMATION"`, put the source status in `exceptionStatus`, and put `LAUNCH_CAMPAIGN` in `category` for a launch item so the existing Launch section can show it (`LAUNCH_COORDINATION_CATEGORIES`, `types.ts` line 205). The Owner can reject that mapping and require a wider type instead. A wider type is still code-only. It is not a migration.

### 5. Inbox title and money

Recommended answer: the inbox title for a launch item is `campaign_items.title`. Do not copy `cost_cents`, `vendor_name`, budget, or approval amounts into `title`, `description`, `note`, or `nextAction`.

`listedExceptionTitle` applies only to risk exceptions (`apps/api/src/lib/exceptions/queries.ts` lines 35–47). Campaign items have no `requires_financial_entitlement` column. Whether a free-text campaign title can contain a dollar amount is unverified. The same is unverified for `automation_tasks.title` and `automation_tasks.detail`. One closed task key is `PREPARE_COMMISSION_PROCESSING_CHECKLIST` (`apps/api/src/lib/automation/types.ts` line 129). If `AUTOMATION_TASK` is chosen, the Owner decides whether that key is omitted from the Pit Crew read.

Financial exceptions stay on the exception path. The workspace read still passes `canViewFinancials: false` (`apps/api/src/lib/pitCrew/queries.ts` lines 223–226), so those rows stay omitted for every role, including Brokerage Administrator. The responsibility inbox still uses `listedExceptionTitle` and shows the raw exception title only to a Brokerage Administrator (lines 185–188 and 470–473).

### 6. Hand-back and escalate for the new source

Recommended answer: not in the first PR. `assertExceptionSource` rejects every other source type (`apps/api/src/lib/pitCrew/responsibility.ts` lines 146–149). The inbox inner-joins `risk_exceptions` and requires `source_type = 'EXCEPTION'` (`queries.ts` lines 431–437). A launch-item hand-back would not appear until that join grows a branch. Leave responsibility on `EXCEPTION` until a later PR extends the join and the title rule in decision 5.

### 7. Feature flag

Recommended name: `PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED`. Enabled only when the value is the literal string `"true"`, matching `PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED` (`responsibility.ts` lines 41–48) and `PIT_CREW_WAITING_ON_SWEEP_ENABLED` (`apps/api/src/lib/pitCrew/waitingOnSweepBootstrap.ts` lines 22 and 83). Default off.

While the flag is off, `assertSourceRecordOnPropertyInBrokerage` must reject every source type other than `EXCEPTION`. Today it returns without a check (`assignment.ts` line 168). That early return is the gap a second source must not keep.

While the flag is off, the workspace read must not query `campaign_items`. No Replit step is required to merge that code, because there is no migration.

### 8. Launch routes do not gain `run.access`

`routes/launch.ts` is `requireAuth` plus a brokerage check. Three routes also require Brokerage Administrator: vendor-approval decision (line 334), budget (line 359), and market-ready override (line 458). None of the launch routes call `requireEntitlement("run.access")`.

This design does not add `run.access` to those routes. The new read lives in `getPitCrewWorkspace`, which is already behind `requireRole` and `requireEntitlement("run.access")` (`apps/api/src/routes/pitCrew.ts` lines 75, 78, and 144). If a later proposal can only work by putting `run.access` on `routes/launch.ts`, that is a separate Owner decision, and it is not part of this recommendation.

## Current state

### How `source_type` is stored

`pit_crew_assignments.source_type` is `text NOT NULL` (`packages/db/src/schema/pitCrew.ts` line 62). The table was created in `packages/db/migrations/0006_classy_deathstrike.sql` lines 1–4. That migration has no `CHECK` on `source_type` or on `status`. Later migrations through `0033` do not add one. The Drizzle table callback (`pitCrew.ts` lines 95–100) defines the unique index and three other indexes. It does not call `check()` on `source_type`.

Application restriction is `PIT_CREW_WORK_SOURCE_TYPES = ["EXCEPTION"]` (`apps/api/src/lib/pitCrew/types.ts` lines 11–12). `PcWorkItem.sourceType` uses that union (line 53). The HTTP params schema does not. `itemParamsSchema` accepts any non-empty string (`apps/api/src/routes/pitCrew.ts` line 213).

This checkout cannot see the live database. A `CHECK` added outside this migration journal is unverified.

The unique index `pit_crew_assignments_source_unique` is on `(source_type, source_record_id)` only (`0006` line 29; schema line 96). It does not include `brokerage_id`. `loadOrCreateOverlay` loads an existing row by that pair and does not also compare `brokerage_id` (`assignment.ts` lines 225–229). Exception ids and campaign-item ids are UUIDs, so two brokerages do not share an id in practice. `transaction_conditions.id`, `workflow_steps.id`, `offers.id`, and `transactions.id` are `serial`. A serial primary key is unique inside its own table, so the same source type still cannot collide across brokerages. The index does not need a migration to store a second type string.

### Source-record existence and tenant check

`loadOrCreateOverlay` (`assignment.ts` lines 197–223) checks that `property_id` belongs to the caller's `brokerage_id`, then calls `assertSourceRecordOnPropertyInBrokerage` (lines 167–187).

For `EXCEPTION`, the id must match a UUID shape (lines 101 and 169–171). The row must exist in `risk_exceptions` with the same `brokerage_id` and the same `property_id`. A miss throws `PitCrewPropertyMismatchError` and, only when the id exists in another brokerage, increments `tenant_isolation_rejection_total` with boundary `pit_crew` (lines 124–131 and 183–186).

For every other `sourceType`, the function returns immediately (line 168). The comment on lines 163–166 says a second source type needs its own branch. A caller who passes a property in their own brokerage and `sourceType` `LAUNCH_ITEM` can create an overlay today without a campaign item existing. `getPitCrewWorkspace` will not show that row, because it only loads exceptions. `getPitCrewTeam` counts every active overlay for the user and does not filter `source_type` (`queries.ts` lines 363–370). The human waiting-on sweep also does not filter `source_type` (`assignment.ts` lines 475–489 and 527–530).

### Claim, assign, handoff, release, complete

All of these call `loadOrCreateOverlay` and then update the overlay only.

| Function | Lines | Overlay result | Audit action | Source row |
| --- | --- | --- | --- | --- |
| `claimWorkItem` | 304–315 | `CLAIMED`, assignee is the actor | `PC_CLAIMED` | unchanged |
| `assignWorkItem` | 344–358 | `CLAIMED`, assignee checked with `assertUserInBrokerage` | `PC_ASSIGNED` | unchanged |
| `startProgress` | 360–363 | `IN_PROGRESS` | `PC_STATUS_CHANGED` | unchanged |
| `setWaitingOn` | 373–391 | `WAITING_ON` | `PC_WAITING_ON_SET` | unchanged |
| `returnFromWaitingOn` | 421–424 | `IN_PROGRESS`, waiting-on fields cleared | `PC_WAITING_ON_RETURNED` | unchanged |
| `completeWorkItem` | 557–559 | `DONE`, `completed_at` set | `PC_COMPLETED` | unchanged |
| `releaseWorkItem` | 562–573 | `UNCLAIMED`, assignee and waiting-on cleared | `PC_RELEASED` | unchanged |
| `handoffWorkItem` | 578–613 | status unchanged; assignee moves to another user in the brokerage | `PC_HANDOFF` | unchanged |

`applyTransition` writes `recordType: ref.sourceType` (`assignment.ts` lines 287–296). A second source type would audit as that type without a migration. Handoff is allowed only from `CLAIMED`, `IN_PROGRESS`, or `WAITING_ON` (lines 584–586). Valid status edges are `PIT_CREW_STATUS_TRANSITIONS` (`types.ts` lines 35–43). `DONE` is terminal.

The route layer exposes each of these under `/pit-crew/items/:sourceType/:sourceRecordId/...` with `requireAuth`, `canAccess` (Pit Crew or Brokerage Administrator), and `requiresRunAccess` (`routes/pitCrew.ts` lines 215, 235, 256, 276, 306, 321, 336, 351).

### Responsibility events (hand back, escalate, migrations 0032 and 0033)

`handBackWorkItem` (line 404), `escalateWorkItem` (line 476), `acknowledgeEscalation` (line 532), `closeEscalation` (line 569, used by resolve and return), and `reclaimHandedBack` (line 613) each call `assertExceptionSource` before `loadOrCreateOverlay`. A non-`EXCEPTION` source throws `PitCrewPropertyMismatchError` (`responsibility.ts` lines 146–149). The existing test names this: `apps/api/src/lib/pitCrew/__tests__/responsibility.test.ts` line 502, using source type `OFFER`.

`0032_pit_crew_responsibility_events.sql` creates `pit_crew_responsibility_events`. Its `CHECK`s constrain kind, status, reason, recipient, and shape. They do not mention `source_type`. The event points at `assignment_id`. `0033_pit_crew_responsibility_closing_note.sql` adds nullable `closing_note`. No source-type change is in either migration.

The routes are flag-gated. `requireResponsibilityActionsEnabled` runs before auth on the inbox and recipients reads (`routes/pitCrew.ts` lines 118–134, 165–170, and 186). The POST routes call `rejectIfResponsibilityActionsDisabled` before zod. The flag is `PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED`, literal `"true"` only.

### WAITING_ON sweep and detection (0031)

`0031_pit_crew_waiting_on_detection.sql` creates sweep settings and sightings. It does not constrain `source_type`.

Two different sweeps exist.

The human sweep, `POST /pit-crew/ops/waiting-on/sweep` (`routes/pitCrew.ts` line 587), calls `sweepOverdueWaitingOn`. It selects `WAITING_ON` rows whose `waiting_on_expected_at` is strictly before now, in the caller's brokerage when a brokerage is passed (lines 475–489). It moves those rows to `IN_PROGRESS` and clears waiting-on fields (lines 400–418 and 541–544). It does not read the source table and does not filter `source_type`. A null expected-at is never returned (lines 465–472).

The scheduled detection path does not change Pit Crew status. `loadOverdueWaitingOnCandidates` (`apps/api/src/lib/pitCrew/waitingOnDetectionRun.ts` lines 65–134) loads the same overdue overlay rows, then loads exception category and dates only when `sourceType === "EXCEPTION"` and the id is a UUID (lines 79–80 and 117–118). Any other source type is still returned, with exception fields null. Settlement date is loaded from `transactions` by property, not by source type (lines 95–115). The scheduler runs only when `PIT_CREW_WAITING_ON_SWEEP_ENABLED` is the literal `"true"` (`waitingOnSweepBootstrap.ts` lines 22 and 83).

### Inbox and recipients reads

`listResponsibilityItemsForRecipient` (`queries.ts` lines 400–473) refuses unless the responsibility flag is on. It inner-joins the event to the assignment, then to `risk_exceptions` with `source_type = 'EXCEPTION'`, the exception id, and the caller's `brokerage_id`. A non-exception assignment cannot appear. Title is `listedExceptionTitle`. Agent and Pit Crew receive null when `requires_financial_entitlement` is true. Brokerage Administrator receives the raw title (`callerCanViewFinancials`, lines 185–188). The read does not join financial tables.

`listResponsibilityRecipients` (`queries.ts` line 522) lists users for the hand-back and escalate forms. It is role-scoped inside Pit Crew. It does not read a source record.

Routes: `GET /pit-crew/responsibility-inbox` allows Agent, Pit Crew, and Brokerage Administrator, plus `run.access` (`routes/pitCrew.ts` lines 77 and 186). `GET /pit-crew/responsibility-recipients` uses `canAccess` (Pit Crew and Brokerage Administrator only) plus `run.access` (lines 165–170).

### Flag-off lock test

`apps/api/src/routes/__tests__/pitCrewResponsibilityFlagOffLock.test.ts` enumerates responsibility routes on `pitCrewRouter` and fails if a new path contains `responsibility`, `hand-back`, `escalate`, or `escalation` without being added to `LOCKED_RESPONSIBILITY_ROUTES` (lines 24–35 and 82–89). While the responsibility flag is unset, empty, `"false"`, `"TRUE"`, or `"1"`, an authenticated Brokerage Administrator with `run.access` receives 404 `{ "error": "Not found." }` and no query text includes `pit_crew_responsibility_events` (lines 37–43 and 173–203). The item routes in that test substitute source type `EXCEPTION` (line 124). Claim, assign, start, waiting-on, return, complete, release, and handoff are not in that lock. They are available with the responsibility flag off.

### Web Pit Crew surface

The page is `apps/web/src/pages/PitCrewCommandCentre.tsx`, route `/pit-crew` (`apps/web/src/App.tsx` line 216). The nav link is shown for role `Pit Crew` or `Brokerage Administrator` (`apps/web/src/lib/productNav.ts` lines 54 and 64). The page comment says the API role gate is the security boundary (lines 1–8). It does not import Command Centre (lines 10–15). It reads `GET /pit-crew/workspace`.

Sections include Launch and Transactions (lines 70–79). Those lists are not launch items or contract conditions. They are the same exception items, filtered by category: `LAUNCH_CAMPAIGN` for Launch, and `OFFERS`, `CONTRACT_CONDITIONS`, `SETTLEMENT_CLOSURE` for Transactions (`types.ts` lines 205–206; `queries.ts` lines 308–313). The empty Launch copy says "No launch campaign items need Pit Crew right now" (page line 115). The data behind that sentence is still exceptions.

The card posts `item.sourceType` back to the API (`apps/web/src/lib/pitCrew.ts` `pcPost`, around lines 238–247). The web module does not itself reject a non-`EXCEPTION` type. It never receives one from the current workspace read.

### Every place that hard-codes `EXCEPTION` in the Pit Crew path

Production gates and reads:

- `apps/api/src/lib/pitCrew/types.ts` line 11. The only allowed work source type.
- `apps/api/src/lib/pitCrew/assignment.ts` line 168. Tenant check returns without looking up any other type. The comment is lines 163–166.
- `apps/api/src/lib/pitCrew/responsibility.ts` line 147, called from lines 404, 476, 532, 569, and 613.
- `apps/api/src/lib/pitCrew/queries.ts` line 237 (overlay join), line 253 (`sourceType` on each workspace item), line 434 (inbox join), line 466 (inbox item).
- `apps/api/src/lib/pitCrew/waitingOnDetectionRun.ts` lines 80 and 118 (exception fields only).

Production paths that do not hard-code it, and therefore follow the early return:

- `itemParamsSchema` (`routes/pitCrew.ts` line 213).
- `claimWorkItem`, `assignWorkItem`, `startProgress`, `setWaitingOn`, `returnFromWaitingOn`, `completeWorkItem`, `releaseWorkItem`, `handoffWorkItem`, and `sweepOverdueWaitingOn`.
- `getPitCrewTeam` active counts (`queries.ts` lines 363–370).
- The web card, which displays whatever `sourceType` the workspace returns.

Test files pass the literal `"EXCEPTION"` as fixture data. They are not an extra allow-list. The behavioural rejection of a non-`EXCEPTION` source is the responsibility test at `responsibility.test.ts` line 502. No assignment test rejects a non-`EXCEPTION` source. The flag-off lock substitutes `EXCEPTION` into the path (`pitCrewResponsibilityFlagOffLock.test.ts` line 124).

`EXCEPTION` also appears in Command Centre, the risk engine, and domain events. Those are the exception product, not a Pit Crew allow-list. Command Centre's source list is the ten strings in `COMMAND_CENTRE_SOURCE_TYPES` (`apps/api/src/lib/commandCentre/types.ts` lines 10–21, mirrored in `apps/web/src/lib/commandCentre.ts` lines 13–24).

## Per candidate source

Command Centre's `getCommandCentre` is on staging. Pit Crew does not import it (`queries.ts` lines 1–8). A second source should be read from its own table inside `apps/api/src/lib/pitCrew/`, the same way exceptions are read through `listBrokerageExceptions`. None of the candidates below require a Pit Crew write into Grow-owned files. Collision check is the next section.

### `LAUNCH_ITEM` — `campaign_items`

Authoritative table: `campaign_items` (`packages/db/src/schema/launch.ts` lines 165–225). Authoritative writes: `apps/api/src/lib/launch/model.ts`. Command Centre maps each projected campaign item to `sourceType: "LAUNCH_ITEM"` and `sourceRecordId` equal to the UUID (`queries.ts` lines 574–584). The parent plan is `launch_plans` (`launch.ts` lines 97–163). A plan is not the work item. Command Centre projects the plan separately as `PROPERTY_MILESTONE` (lines 612–623).

Tenant path: `campaign_items.brokerage_id` and `campaign_items.property_id` are both not null (lines 170–171). `loadCampaignItemInBrokerage` loads by id and rejects a row whose `brokerage_id` differs (`model.ts` lines 144–147). `assertPropertyInBrokerage` requires `properties.brokerage_id` (lines 129–132). The id is a UUID, so the existing `UUID_SHAPE` guard in `assignment.ts` can be reused. A Pit Crew branch must require the same `brokerage_id` and the same `property_id`, matching the exception branch.

Done in the source: `status = 'COMPLETE'` (`CAMPAIGN_ITEM_STATUSES`, `launch.ts` line 73). `completed_at` is set when status becomes `COMPLETE` (`model.ts` lines 506–507). Command Centre treats `COMPLETE` as done and, for other statuses, only projects rows that have `due_at` and fall in overdue, today, or the coming-up horizon (`queries.ts` lines 256–269). `BLOCKED`, `AWAITING_APPROVAL`, `IN_PROGRESS`, and `TO_ORGANISE` are not done.

Pit Crew completing an item must not change the campaign item. `updateCampaignItemStatus` (`model.ts` lines 494–531) writes the status, emits `CAMPAIGN_ITEM_STATUS_CHANGED`, and on `COMPLETE` emits `CAMPAIGN_ITEM_COMPLETED`. It then calls `afterLaunchMutation` (lines 269–274), which recalculates budget, re-evaluates market-ready, and may rewrite `launch_plans.status`. That is source-of-truth work, not an overlay update.

Roles that can see the source today: every authenticated user in the brokerage. Launch routes use `requireAuth` and the brokerage check. They do not use `restrictedPropertyIdsFor`. An Agent is not limited to `properties.agent_id` on these routes. Pit Crew and Brokerage Administrator are not given a separate launch role. Brokerage Administrator is required only for deciding a vendor approval, setting the budget, and overriding market-ready (`routes/launch.ts` lines 334, 359, and 458). The property page loads `GET /properties/:propertyId/launch` for the open property (`apps/web/src/pages/PropertyWorkspace.tsx` lines 609–611). Whether that page hides the panel by role beyond "the user could open the property" was not separately verified.

`run.access` and feature flags: launch routes do not require `run.access`. No launch feature flag was found on those routes. Command Centre's own route is `requireAuth` only (`apps/api/src/routes/commandCentre.ts` lines 19–28). It does restrict Agent callers to their own properties, and gives Pit Crew and Brokerage Administrator the whole brokerage, via `restrictedPropertyIdsFor` (`apps/api/src/routes/exceptions.ts` lines 48–55). The Pit Crew workspace is stricter than the launch routes: Pit Crew or Brokerage Administrator, plus `run.access`.

Title: `campaign_items.title` is `text NOT NULL` (schema line 174). There is no `listedExceptionTitle` equivalent. `cost_cents` is a separate integer (line 182). The inbox and the workspace description must not use it. Owner decision 5 covers free-text amounts. `responsible_owner_type` reuses `RISK_EXCEPTION_OWNER_TYPES`, which includes `PIT_CREW` and `UNASSIGNED_QUEUE` (`packages/db/src/schema/exceptions.ts` lines 95–101; re-exported at `launch.ts` line 90).

### `AUTOMATION_TASK` — `automation_tasks`

Authoritative table: `automation_tasks` (`packages/db/src/schema/automation.ts` lines 320–393). Authoritative writes: `apps/api/src/lib/automation/tasks.ts`. HTTP surface for an ordinary user: `apps/api/src/routes/tasks.ts`, mounted at `/tasks` (`apps/api/src/routes/index.ts` line 154). Command Centre maps a projected row to `sourceType: "AUTOMATION_TASK"` (`queries.ts` lines 803–813). This is the task record. There is no `tasks` table in `packages/db/src/schema`.

`WORKFLOW_ACTION` is a different table. See below. The Pit Crew schema header's phrase "workflow/automation actions" (`pitCrew.ts` lines 4–5) matches both Command Centre source types, not one table.

Tenant path: `automation_tasks.brokerage_id` and `property_id` are both not null (schema lines 324–325). `completeAutomationTask` loads by id and returns `NOT_FOUND` when `brokerage_id` differs (`apps/api/src/lib/automation/tasks.ts` lines 276–279). The id is a UUID. `GET /tasks/by-property/:propertyId` filters `property_id`, `brokerage_id`, and `status = 'ACTIVE'` (`routes/tasks.ts` lines 100–103). It does not check that the property row's brokerage matches when zero tasks exist. A foreign property id returns an empty list rather than 404.

Done in the source: `status` is `ACTIVE`, `COMPLETED`, `SUPERSEDED`, or `CANCELLED` (`automation.ts` lines 343–344). `COMPLETED` sets `completed_at` (`apps/api/src/lib/automation/tasks.ts` lines 288–291). `SUPERSEDED` and `CANCELLED` cannot be completed (lines 284–286). Command Centre reads `ACTIVE` and `COMPLETED` only (`queries.ts` lines 360–368). Overdue `ACTIVE` tasks are skipped in that projection (line 381) because the comment says they already became `WORKFLOW_OPERATIONAL` exceptions (lines 355–356). Completing the exception and completing the task are different writes today.

Pit Crew completing an item must not call `completeAutomationTask`. That function sets the task to `COMPLETED`. It does not publish a domain event and it does not update a transaction. It is still a source-record write. The overlay `DONE` must leave the task `ACTIVE` until someone completes it through `POST /tasks/:id/complete` or a later Owner-approved action.

Roles: `routes/tasks.ts` is `requireAuth` only (lines 92 and 118). No role list. No `run.access`. Any signed-in user in the brokerage who can name the property id can list active tasks and complete one. Automation ops (`apps/api/src/routes/automationOps.ts` line 46) is Brokerage Administrator only. That ops router is rule and execution control, not the task complete path. Command Centre visibility follows `restrictedPropertyIdsFor`: Agent sees their properties; Pit Crew and Brokerage Administrator see the brokerage.

Feature flags: no task-list feature flag was found on `routes/tasks.ts`. Task keys are the closed list `AUTOMATION_TASK_KEYS` (`apps/api/src/lib/automation/types.ts` lines 104–133).

Title: `title` is not null (schema line 335). `detail` is nullable. Neither column has a financial-entitlement flag. `assigned_role` is not an owner type. Inbox redaction cannot call `listedExceptionTitle` for this row. The key `PREPARE_COMMISSION_PROCESSING_CHECKLIST` is the financial-adjacent case the Owner has to decide (decision 5).

### `WORKFLOW_ACTION` — `workflow_steps`

Authoritative table: `workflow_steps` (`packages/db/src/schema/workflow.ts` lines 20–30), parent `workflows` (lines 11–18). Command Centre maps a step in status `Ready` to `sourceType: "WORKFLOW_ACTION"` (`queries.ts` lines 841–851 and 397–401). The automation engine was named so it would not be confused with this table (`automation.ts` lines 11–15).

Tenant path: `workflows` has `property_id` and no `brokerage_id`. `workflow_steps` has no `brokerage_id` and no `property_id`. The path is `workflow_steps.workflow_id` to `workflows.property_id` to `properties.brokerage_id`. Command Centre only reaches steps for properties already loaded for the caller (`queries.ts` lines 205–209 and 397–401). A Pit Crew check has to walk that path and compare both brokerage and the client-supplied `property_id`. The step id is `serial`, not a UUID. Reusing `UUID_SHAPE` would reject every real step id.

Done in the source: step `status` `Complete` (schema line 26). Those statuses are recomputed from live property state. `refreshReadyToListSteps` overwrites them (`apps/api/src/lib/workflowSteps.ts` lines 41–48). `refreshTransactionSteps` does the same class of rewrite (line 177). A Pit Crew write to `workflow_steps.status` would not stick. Command Centre only projects `Ready` steps (line 401). It does not project `Complete` as completed-today for this source (`workflowStepToActionItem` sets `completedAt: null`, lines 872–875).

Pit Crew completing an item must not update the step and must not call `refreshReadyToListSteps` or `refreshTransactionSteps`. Overlay `DONE` is the only safe meaning of finished. The step can still be `Ready` or can later be rewritten to `Complete` by the refresh. Those two facts are independent.

Roles: the step is visible on Command Centre under the same property scope as the rest of that read. No separate workflow-step route was found that Pit Crew would have to call. `run.access` is not on `GET /command-centre`.

Title: `workflow_steps.label` (schema line 24). No financial flag. No owner column. Accountable owner in the Command Centre projection is hard-coded `LISTING_AGENT` (`queries.ts` lines 862–863).

This is a weak first source. The row is a derived checklist step, not a durable assignment.

### `CONTRACT_MILESTONE` — `transaction_conditions`

The prompt's "transaction conditions" candidate is this table. Command Centre's source type string is `CONTRACT_MILESTONE`, not a new name (`queries.ts` lines 726–738). Using any other string would not match `COMMAND_CENTRE_SOURCE_TYPES`. That naming choice is still an Owner decision if this candidate is picked. Recommended string, if it is ever implemented: `CONTRACT_MILESTONE`.

Authoritative table: `transaction_conditions` (`packages/db/src/schema/transaction.ts` lines 105–122). Authoritative writes: `apps/api/src/lib/transactionConditions.ts`. Parent: `transactions` (lines 36–91), which also has no `brokerage_id`.

Tenant path: condition id to `transaction_id` to `transactions.property_id` to `properties.brokerage_id`. `resolveCondition` calls `loadTransactionInBrokerage` (`transactionConditions.ts` lines 120–122). Transaction routes require `run.access` (`apps/api/src/routes/transactions.ts` lines 25–42). `requireTransactionAccess` checks the transaction's property brokerage (lines 149–158). `POST /conditions/:conditionId/resolve` requires auth and `run.access` (line 363). It does not use `requireRole`. The condition id is `serial`. `UUID_SHAPE` must not be applied to it.

Done in the source: anything other than `Pending`. Statuses are `Pending`, `Satisfied`, `Waived`, `Failed`, `NotApplicable` (`transaction.ts` line 93). Command Centre skips non-`Pending` rows and says `Failed` is already a `CONTRACT_CONDITIONS` exception (`queries.ts` line 333). It also skips a `Pending` row with no `due_date` (line 334).

Pit Crew completing an item must not call `resolveCondition`. After the condition update, that function calls `maybeRecordUnconditional` (lines 145–151). When the contract is exchanged and every condition is in a non-blocking status, `maybeRecordUnconditional` sets `transactions.unconditional_at` and publishes `TRANSACTION_UNCONDITIONAL` (lines 222–269). That changes transaction status. It is out of bounds for a Pit Crew overlay action.

Roles: any authenticated user with `run.access` in the brokerage can resolve a condition, subject to the tenant check. Command Centre visibility is the property scope in `restrictedPropertyIdsFor`. There is no Pit Crew-specific condition role.

Title: `description` (schema line 108). No financial-entitlement flag. A finance condition's description can name the condition. Whether the text contains figures is unverified. Do not copy `transactions` money columns into the Pit Crew title.

This is a poor first source because the ordinary "mark done" function changes legal status.

### Other Command Centre source types that were checked

These are real projections or real tables. They are not recommended as the first Pit Crew source.

`OFFER` is `offers` (`transaction.ts` lines 10–24). No `brokerage_id`. Tenant path is `offers.property_id` to `properties.brokerage_id`. Command Centre emits an offer only when `status` is `Accepted` and `created_at` is today, into completed-today (`queries.ts` lines 348–352 and 766–800). That is not an open work queue. `acceptOffer` (`apps/api/src/lib/transactions.ts` line 75) creates the transaction side of an acceptance. Pit Crew must not call it.

`SETTLEMENT_MILESTONE` is a `transactions` row projected from `settlement_date` or `settlement_completed_at` (`queries.ts` lines 687–723). Done in that projection is `settlement_completed_at` set. `completeSettlement` (`transactions.ts` line 470) is the settlement write. Pit Crew must not call it. The row is a date on the transaction, not a separate assignable work item.

`VENDOR_APPROVAL` is `vendor_approvals` with `status = 'PENDING'` (`queries.ts` lines 291–299 and 651–684). The row has `brokerage_id` (`launch.ts` lines 267–294). Deciding it is `decideVendorApproval`, and the route is Brokerage Administrator only (`routes/launch.ts` line 334). That decision is an approval. Pit Crew must not call it. "Done" for the source is an admin decision, not an overlay `DONE`.

`PROPERTY_MILESTONE` in the launch projection is the launch plan's target date or actual launch date (`queries.ts` lines 612–648). Confirming listing live calls `goLiveProperty` (`model.ts` lines 863–870). Pit Crew must not call `confirmLaunchLive`. The plan is not a campaign item.

`PORTAL_DESTINATION` is in `COMMAND_CENTRE_SOURCE_TYPES` (`commandCentre/types.ts` line 16) and has a web label (`apps/web/src/lib/commandCentre.ts` lines 149–150). `getCommandCentre` never selects `portal_destinations` and never emits that source type. The table exists (`launch.ts` lines 231–258) and has `brokerage_id`. It is not a current Command Centre work queue. `recordPortalSubmission`, `recordPortalFailure`, and `confirmPortalLive` (`model.ts` lines 769, 784, and 814) change launch tracking. Pit Crew must not call them. `confirmLaunchLive` also requires a portal destination in status `LIVE` (comment at `model.ts` lines 858–860).

## Migration need, per candidate

None of these candidates need a migration to store the new `source_type` string.

`source_type` is unconstrained `text`. `status` is unconstrained `text`. The unique index already includes `source_type`. Responsibility-event `CHECK`s do not mention source type. `0031` sweep tables do not mention it. No new column is required for an overlay-only second source. No new index is required to look up one campaign item or one automation task by its existing primary key.

What makes code-only safe:

- Existing rows stay `EXCEPTION`. A new string is written only when the new flag is the literal `"true"` and the new tenant branch has found the source row in the caller's brokerage and property.
- While the flag is off, the tenant check rejects every source type other than `EXCEPTION`. That closes the early return at `assignment.ts` line 168. The workspace read does not query the new table. A missing flag cannot make `getPitCrewWorkspace` depend on a new migration.
- The inbox keeps its inner join to `risk_exceptions` until a later PR. Hand-back of the new type stays rejected by `assertExceptionSource`, so no event row needs a new shape.
- Replit has nothing new to apply. Turning the flag on later is an Owner decision. It is not a migration apply.

A database `CHECK` that limits `source_type` to a list would be a new migration. Do not add it in the first PRs. It would wait until the Owner lifts the pause on new migrations, and until someone can count unexpected `source_type` values in the live database. That count is unverified from this checkout. The same is true for a brokerage column on the unique index. Serial and UUID primary keys already make `(source_type, source_record_id)` unique per table, so that index change is not required for correctness of a second type.

This conclusion is the same for `LAUNCH_ITEM`, `AUTOMATION_TASK`, `WORKFLOW_ACTION`, and `CONTRACT_MILESTONE`. The unsafe part of each candidate is a function call, not a missing column.

## Collision check

Grow-owned files named for this proposal:

- `apps/api/src/lib/commandCentre/**`
- `apps/web/src/lib/commandCentre.ts`
- `apps/web/src/pages/CommandCentre.tsx`
- `apps/web/src/lib/todaySurfaces.ts`
- `apps/api/src/lib/grow/**`
- `apps/api/src/lib/communications/**`
- `apps/api/src/lib/propertyIntelligence/**`

A candidate does not have to touch those files. Command Centre already projects the rows. Pit Crew copying that projection would mean importing `getCommandCentre` or editing it. `queries.ts` lines 1–8 already refuse that import. The least-invasive path is a direct read of the source table from `apps/api/src/lib/pitCrew/queries.ts`, plus a tenant branch in `assignment.ts`, plus the flag. The web change, when it comes, is `PitCrewCommandCentre.tsx` and `apps/web/src/lib/pitCrew.ts` only if the payload grows. It does not edit `CommandCentre.tsx` or `todaySurfaces.ts`.

`LAUNCH_ITEM` does not depend on editing `routes/launch.ts`. The read does not go through those routes. Adding `run.access` there is not required and is out of this design (decision 8).

`AUTOMATION_TASK` does not depend on editing `routes/tasks.ts` or `routes/automationOps.ts`. Those routes stay as they are. Pit Crew must not complete the task by calling them from the overlay action.

`CONTRACT_MILESTONE` does not depend on editing `routes/transactions.ts`. Transaction routes already require `run.access`. Pit Crew must not call `resolveCondition` from the overlay action. No launch-route change is involved.

`WORKFLOW_ACTION` does not depend on editing `workflowSteps.ts` if Pit Crew only reads. A write to step status would touch that file and would be overwritten. Do not do that write.

`VENDOR_APPROVAL` and portal destinations live in `lib/launch/model.ts`. Using them as the source would still be a read from `pitCrew/queries.ts`. Calling `decideVendorApproval` or the portal recorders would be a write into launch, which this design forbids. They do not force a Command Centre edit. They do force an approval or a listing-live dependency, which is why they are not the recommendation.

## Safety

Pit Crew claim, assign, start, waiting-on, return, complete, release, handoff, hand-back, escalate, acknowledge, resolve, return, and reclaim must not send an external communication, move funds, change a transaction or legal status, or bypass an approval. The overlay functions do not do those things today. The second source stays safe only if the new branch does not call the source writers below.

Must not be called from any Pit Crew action on a new source:

- Launch: `updateCampaignItemStatus`, `assignResponsibility`, `recordVendorAndCost`, `attachCampaignItemEvidence`, `requestVendorApproval`, `decideVendorApproval`, `setBudget`, `addPortalDestination`, `recordPortalSubmission`, `recordPortalFailure`, `confirmPortalLive`, `overrideMarketReady`, `confirmLaunchLive`, `goLiveProperty`, `pauseLaunchPlan`, `resumeLaunchPlan`, `cancelLaunchPlan`, `applyTemplate`.
- Automation: `completeAutomationTask`, `assignAutomationTaskToRole`, `createAutomationTask`, `resolveAttentionItem`, `retryAutomationAction`, and the execution engine in `apps/api/src/lib/automation/engine.ts`.
- Transaction and legal status: `resolveCondition`, `maybeRecordUnconditional`, `recordExchange`, `acceptOffer`, `completeSettlement`, `recordContractSigned`, `recordFundsReceived`, `recordAgentPaid`, `closeTransaction`, `calculateCommission`, `recordLegalRepresentatives`.
- Communications senders under `apps/api/src/lib/communications/**`. This proposal does not name a single send function to call. The rule is that the new Pit Crew branch does not import that tree.

Tests that lock it, in the implementation PRs, not in this docs change:

- Mirror `pitCrewResponsibilityFlagOffLock.test.ts`. While `PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED` is unset, empty, `"false"`, `"TRUE"`, or `"1"`, `POST /pit-crew/items/LAUNCH_ITEM/:id/claim` and `.../complete` return the same not-found error as a missing exception, and the test's query observer shows no `campaign_items` write. The responsibility lock stays as it is for the eight existing routes.
- A behavioural test: with the flag on, `completeWorkItem` for a real campaign item in the caller's brokerage sets the overlay to `DONE` and leaves `campaign_items.status` and `completed_at` unchanged. The same shape for `AUTOMATION_TASK` leaves `automation_tasks.status` at `ACTIVE`. The same shape for a condition leaves `transaction_conditions.status` at `Pending` and leaves `transactions.unconditional_at` null.
- An import lock in the style of `apps/api/src/routes/__tests__/support/f4ForbiddenCalls.ts`: the Pit Crew assignment and query modules do not import `updateCampaignItemStatus`, `completeAutomationTask`, `resolveCondition`, `maybeRecordUnconditional`, `acceptOffer`, `completeSettlement`, `confirmLaunchLive`, or `decideVendorApproval`.

`sweepOverdueWaitingOn` may already return a non-`EXCEPTION` overlay if one was created through the early return. The first implementation PR should reject those creates while the flag is off. It should not teach the sweep to call a source writer. The sweep remains an overlay status change only.

## Recommendation

Do `LAUNCH_ITEM` (`campaign_items`) first.

It already has `brokerage_id`, `property_id`, a UUID id, a title, a due date, a status, and `responsible_owner_type` from the same list as exceptions, including `PIT_CREW` and `UNASSIGNED_QUEUE`. The Pit Crew page already has a Launch section that is still exception category `LAUNCH_CAMPAIGN`. The tenant check can follow the exception branch, including `UUID_SHAPE`. The first PR can be code-only and flag-gated. Pit Crew `DONE` must not call `updateCampaignItemStatus`, so budget, market-ready, plan status, portal state, and listing live stay untouched. The read does not require `run.access` on `routes/launch.ts` and does not require edits under `lib/commandCentre/**`.

`AUTOMATION_TASK` is the second choice if the Owner rejects launch items. It is also code-only and UUID-scoped, but the relevance rule and the commission task key are open product choices, and overdue tasks are already expected to show up as exceptions. `CONTRACT_MILESTONE` and `WORKFLOW_ACTION` stay later. One changes legal status if the obvious complete function is reused. The other is a derived step that refresh overwrites.

### Sequence of small PRs

1. Code-only. Flag `PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED`, default off. No migration. No Replit step. Owner decisions 1, 2, 3, 4, and 7 must be accepted first, or the PR uses the recommended answers and says so. While the flag is off, reject every source type other than `EXCEPTION` in `assertSourceRecordOnPropertyInBrokerage`, and do not query `campaign_items`. While it is on, add the tenant branch and include the relevant open campaign items in `getPitCrewWorkspace`. Complete, claim, handoff, and release touch the overlay only. Do not edit `routes/launch.ts`, `lib/commandCentre/**`, or the Grow-owned files listed above. Hand-back stays `EXCEPTION`-only.

2. Code-only. Same flag, still default off. No migration. No Replit step. Web only: the existing Launch section on `/pit-crew` renders the new items when the API sends them. Files: `PitCrewCommandCentre.tsx` and, only if the payload grows, `apps/web/src/lib/pitCrew.ts`. Not `CommandCentre.tsx`. Depends on decision 4 (severity mapping) from PR 1.

3. Code-only. Same flag. No migration. No Replit step. Owner decisions 5 and 6: inbox title, and allowing hand-back and escalate for `LAUNCH_ITEM` only when the flag is on. Extend the inbox join so a launch item is not dropped by the `risk_exceptions` inner join. Do not copy `cost_cents`. Mirror the flag-off lock for a `LAUNCH_ITEM` hand-back: 404 and no read or write of `pit_crew_responsibility_events` while the responsibility flag is off, and no campaign-item write while the source flag is off. Responsibility-event `CHECK`s stay as they are.

4. Not scheduled with the three above. A `CHECK` on `source_type`, or a brokerage column on the unique index, is a migration and a Replit apply. Owner decision, and only after the pause on new migrations ends. Preflight count of unexpected `source_type` values is unverified here.

Turning the flag on in an environment is an Owner decision. It is not a migration and not a Replit schema step.

## Open questions

1. The Owner's pick may be `AUTOMATION_TASK` instead. If so, which `assigned_role` values are Pit Crew's, and is `PREPARE_COMMISSION_PROCESSING_CHECKLIST` excluded?
2. Should the Launch section keep showing `LAUNCH_CAMPAIGN` exceptions and also show campaign items, or should campaign items replace that category filter? Recommended: show both. An exception and a campaign item are different rows. Hiding the exception would drop financial and risk items that are not campaign items.
3. Campaign items with `responsible_owner_type` `LISTING_AGENT` are outside the recommended relevance rule unless an overlay already exists. Should an agent be able to ask Pit Crew to claim one before an overlay exists? Today an exception becomes visible once Pit Crew is the owner or once someone has already touched it. The same rule is the recommendation. A "show every open campaign item" rule is wider and is an Owner choice.
4. Free-text titles may contain amounts. This checkout did not sample live `campaign_items.title` or `automation_tasks.title` values. If the Owner needs a guarantee, the first implementation needs a redaction rule. None exists on those tables today.
5. `getPitCrewTeam` counts active overlays of every source type. After the flag is on, a claimed launch item will count toward capacity. Confirm that is wanted. It matches the current function, which does not filter type.
6. The human waiting-on sweep will return a `LAUNCH_ITEM` overlay that is `WAITING_ON` and overdue, because it does not filter type. That return does not change the campaign item. Confirm that overlay-only return is wanted for the new source. The scheduled detector will classify that row with null exception category until a later change loads campaign status. That detector change is not in PR 1.
7. Live database constraints beyond migration `0033` are unverified. If Replit's database has a `CHECK` this repo does not contain, the code-only claim is wrong. Someone with database access has to confirm before the flag is turned on.
