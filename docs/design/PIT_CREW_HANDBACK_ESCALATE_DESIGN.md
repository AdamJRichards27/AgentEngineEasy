# Pit Crew HAND BACK and ESCALATE — design proposal

Status: proposal only. Nothing in this document is implemented. Staging tip verified for this proposal: `d0a7e77` (`feat(grow): G-12 tenant-isolation rejection metric at Grow boundaries (#119)`). Migration journal on that tip ends at `0031_pit_crew_waiting_on_detection` (`packages/db/migrations/meta/_journal.json`). Open pull requests against `staging` at the time of writing (#120, #41, #39, #23) do not add a `0032` migration.

This proposal does not change schema, routes, or behaviour. It records the current code and a recommended shape for two new Pit Crew actions.

HAND BACK is the action Pit Crew uses when its own responsibility is finished, or when the next required action belongs to the agent. ESCALATE is the action Pit Crew uses when it cannot safely or appropriately progress an item. Escalation does not authorise a consequential action.

Existing PC-to-PC reassignment stays as it is. `handoffWorkItem` (`apps/api/src/lib/pitCrew/assignment.ts` lines 570–608) keeps the assignment status unchanged and moves `assignedToUserId` to another user in the same brokerage. That is not HAND BACK and it is not ESCALATE.

## Decisions required before implementation

These are product and schema choices. Implementation should not start until the Owner has accepted or replaced each recommended answer.

### 1. Schema and migration

Recommended answer: one additive migration, **0032**, next after `0031_pit_crew_waiting_on_detection`. It creates `pit_crew_responsibility_events` only. It does not `ALTER` `pit_crew_assignments`, does not add a `CHECK` on the existing `status` column, and does not backfill rows.

`pit_crew_assignments.status` is unconstrained `text` (`packages/db/src/schema/pitCrew.ts` line 59; created in `packages/db/migrations/0006_classy_deathstrike.sql` with no status `CHECK`). New status strings can be written by application code without a migration. A database `CHECK` on that column is a later, separate migration, and only after a preflight count of unexpected status values. This checkout cannot see the live database, so that count is unverified.

Rollback of an unused 0032 is `DROP TABLE`. See Migration plan.

The feature flag below lets the code merge before the Owner applies 0032 on Replit. The flag stays off until that apply succeeds.

### 2. Data model

Recommended answer: **option (b)** in the options section. An append-only `pit_crew_responsibility_events` row holds the reason, severity, note, operator, recipient, next action, expected response time, and event lifecycle. The assignment row gains two status values, `HANDED_BACK` and `ESCALATED`, enforced in `PIT_CREW_STATUS_TRANSITIONS`, so the item leaves the active Pit Crew buckets. The assignment row does not gain a wide set of hand-back and escalation columns.

Option (a) (columns on `pit_crew_assignments` only) and option (c) (audit log only) are recorded below with why they were not chosen.

### 3. Enumerations

Recommended values are in Reason, severity, and event enumerations. The Owner decides the final lists before they are hard-coded. Keep them small. Suggested sets:

- Hand-back reason: `WORK_COMPLETE`, `NEXT_ACTION_WITH_AGENT`, `INFORMATION_RETURNED`, `NOT_PIT_CREW_WORK`.
- Escalation reason: `BLOCKED_DEPENDENCY`, `OVERDUE_THIRD_PARTY`, `SETTLEMENT_OR_COMPLIANCE_RISK`, `MISSING_AUTHORITY`, `MISSING_INFORMATION`, `OTHER_MATERIAL_EXCEPTION`.
- Escalation severity: `ATTENTION`, `AT_RISK`, `CRITICAL`. The risk-exception scale also has `INFORMATION` (`packages/db/src/schema/exceptions.ts` lines 26–27). Escalation does not use `INFORMATION` in this proposal.
- Event status: `OPEN`, `ACKNOWLEDGED`, `RESOLVED`, `RETURNED`, `SUPERSEDED`.
- Resulting responsibility while the event is open: `AGENT` for hand-back, `BROKERAGE_ADMINISTRATOR` for escalation.

`DONE` stays the existing “Pit Crew finished the overlay item” status. Hand-back is a different status, including when the reason is `WORK_COMPLETE`. Completing and handing back are not the same write.

### 4. Recipient resolution

Recommended v1, implemented as one function (name: `resolveResponsibilityRecipient`) so a later rules table can be read inside that function without changing the route or the state machine:

- HAND BACK: an explicit user id in the caller’s brokerage, or, when omitted, `properties.agent_id` for the assignment’s property (`packages/db/src/schema/property.ts` lines 18–21). The user must pass `assertUserInBrokerage`. Resulting responsibility is `AGENT`.
- ESCALATE: an explicit user id who is an active `Brokerage Administrator` in the caller’s brokerage, or, when omitted, `recipient_role = 'Brokerage Administrator'` with `recipient_user_id` null. v1 does not escalate to an Agent. Hand-back is how an Agent becomes the recipient.
- Exactly one of `recipient_user_id` and `recipient_role` is set.
- A later `pit_crew_escalation_routing_rules` table is consulted only by this function, after an explicit recipient and before the v1 default. v1 has no rules table, so that branch finds nothing and uses the default.

### 5. Agent-visible surface

Recommended answer: a Pit Crew-owned read, `listResponsibilityItemsForRecipient`, in `apps/api/src/lib/pitCrew/queries.ts`, and a new agent-readable route that returns that read. Do not implement the read by editing `apps/api/src/lib/commandCentre/**` or `apps/api/src/lib/grow/**` or `apps/api/src/lib/growToday.ts`.

The product surface the agent already uses for Run Today is `GET /api/command-centre`, rendered at `/today` by `apps/web/src/pages/CommandCentre.tsx`. Wiring the new read into that page is a later slice and collides with Grow’s history on that page and on `lib/commandCentre/queries.ts`. The first implementation slices stop at the Pit Crew-owned query and route. The web slice that places the list on `/today` waits until no Grow claim holds those files, and it fetches the new route beside the existing command-centre payload. It does not fold the rows into `ActionItem` inside `getCommandCentre`.

### Further decisions (same gate)

6. **Who may acknowledge, resolve, or return an escalation.** Recommended: the named `recipient_user_id`, or any active Brokerage Administrator in the brokerage when `recipient_role` is `Brokerage Administrator`. The originating Pit Crew user cannot acknowledge, resolve, or return their own escalation unless they are also a Brokerage Administrator. Hand-back has no acknowledge step. Pit Crew reclaims a hand-back by moving `HANDED_BACK` to `CLAIMED`.

7. **What resolve and return do to the assignment.** Recommended: both move `ESCALATED` to `IN_PROGRESS` and leave `assignedToUserId` as the originating Pit Crew user. Neither resolves the risk exception, neither hands the item to the agent, and neither sets `DONE`. Acknowledge leaves the assignment at `ESCALATED` and sets the event to `ACKNOWLEDGED`. The difference between resolve and return is the event status and the audit code (`PC_ESCALATION_RESOLVED` versus `PC_ESCALATION_RETURNED`), plus a required note on both.

8. **Expected response time.** Recommended: `expected_response_at` is optional on escalation and forbidden on hand-back. It is required when severity is `CRITICAL` or `AT_RISK`. v1 displays it. v1 does not add a scheduler that pages anyone or changes status when the time passes.

9. **Audit strictness and the property timeline.** Recommended: the new actions call `logAudit` with `brokerageId` set and with `strict: true` inside the same database transaction as the event insert and the assignment update (`apps/api/src/lib/audit.ts` lines 17–29 already allow `strict` and an injected `write`). Existing Pit Crew mutations stay best-effort and keep omitting `brokerageId` (`assignment.ts` lines 285–294). New audit codes do not appear on the property timeline until they are added to `TIMELINE_ENTRY_TYPES` in `apps/api/src/lib/timeline.ts`. Current `PC_*` assignment actions are already in that position: they are written and they are not timeline entries. Whether to extend the timeline allow-list is its own slice; `timeline.ts` is shared and is not part of the Pit Crew route module.

10. **Feature flag.** Recommended name: `PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED`. Enabled only when the value is the literal string `"true"`, matching `PIT_CREW_WAITING_ON_SWEEP_ENABLED` (`apps/api/src/lib/pitCrew/waitingOnSweepBootstrap.ts` lines 22–25). Default off. While off, the new routes respond `404` with `{ "error": "Not found." }` and the new library functions refuse before any write. `getPitCrewWorkspace` does not read the new table, so a missing migration does not break the current workspace while the flag is off.

11. **Source statuses.** Recommended: hand-back and escalate are allowed only from `CLAIMED`, `IN_PROGRESS`, and `WAITING_ON`, the same set `handoffWorkItem` already requires (`assignment.ts` lines 578–580). Not from `UNCLAIMED`, `DONE`, `HANDED_BACK`, or `ESCALATED`.

## Recommendation

Use an append-only responsibility-event table plus two assignment statuses. One open event per assignment. Recipient chosen by `resolveResponsibilityRecipient`, whose v1 is an explicit in-brokerage user or the Brokerage Administrator role, and whose later version can read per-brokerage routing rules without a new workflow.

Hand-back and escalate write the event, move the assignment status, bump `version`, and append one audit row. They do not write the risk exception, the transaction, a communication, a payment, or an approval.

## Current state

### Assignment table

`pit_crew_assignments` is a thin overlay. The file header states that the work item itself stays in the source system, and that this table records who on Pit Crew is working it, the Pit Crew status, and waiting-on / handoff metadata (`packages/db/src/schema/pitCrew.ts` lines 1–27). One row per `(source_type, source_record_id)`. A missing row means unclaimed.

Columns on the staging schema (lines 50–86):

| Column | Type in schema | Role today |
| --- | --- | --- |
| `id` | serial PK | |
| `brokerage_id` | integer, not null, FK `brokerages` | Tenant stamp |
| `source_type` | text, not null | Application values are only `EXCEPTION` (below) |
| `source_record_id` | text, not null | For exceptions, the `risk_exceptions.id` UUID |
| `property_id` | integer, not null, FK `properties` | |
| `status` | text, not null, default `UNCLAIMED` | Application vocabulary below. No database `CHECK` |
| `assigned_to_user_id` | integer, FK `users`, null | Current Pit Crew assignee |
| `claimed_at` | timestamp, null | |
| `waiting_on_party`, `waiting_on_note`, `waiting_on_since`, `waiting_on_expected_at` | text / timestamp | Last waiting-on payload |
| `handoff_from_user_id`, `handoff_to_user_id`, `handoff_note`, `handoff_at` | integer / text / timestamp | Last PC-to-PC handoff only |
| `completed_at` | timestamp, null | Set by complete |
| `version` | integer, not null, default 1 | Optimistic concurrency |
| `created_at`, `updated_at` | timestamp, not null | |

Indexes (lines 88–93):

- Unique `pit_crew_assignments_source_unique` on `(source_type, source_record_id)`. It does **not** include `brokerage_id`.
- `pit_crew_assignments_brokerage_status_idx` on `(brokerage_id, status)`.
- `pit_crew_assignments_assigned_to_idx` on `assigned_to_user_id`.
- `pit_crew_assignments_property_idx` on `property_id`.

The header says full history lives in the audit log rather than a second history table (lines 23–27). That is true of the writes: every successful mutation calls `logAudit`. It is not true of the property timeline. `getPropertyTimeline` loads audit rows only when `action` is in `AUDIT_LOG_ENTRY_TYPES` (`apps/api/src/lib/timeline.ts` lines 240–242 and 459). That map has no `PC_CLAIMED`, `PC_ASSIGNED`, `PC_STATUS_CHANGED`, `PC_WAITING_ON_SET`, `PC_WAITING_ON_RETURNED`, `PC_COMPLETED`, `PC_RELEASED`, or `PC_HANDOFF`. Those strings are absent from `timeline.ts`. The comment in `getPropertyTimeline` (lines 455–458) says `audit_logs` has no `brokerage_id` column. The column exists and is nullable (`packages/db/src/schema/audit.ts` lines 6–11). Pit Crew’s `logAudit` calls do not set it.

Two further tables in the same schema file are out of scope here: `pit_crew_waiting_on_sweep_settings` and `pit_crew_waiting_on_sweep_sightings` (lines 109–162), added by migration 0031. They are detection policy and a surfaced fingerprint. They do not authorise a status change.

### Statuses and transitions

Schema and lib both list the same five statuses (`pitCrew.ts` lines 38–45, `apps/api/src/lib/pitCrew/types.ts` lines 26–33):

`UNCLAIMED`, `CLAIMED`, `IN_PROGRESS`, `WAITING_ON`, `DONE`.

`PIT_CREW_STATUS_TRANSITIONS` (`types.ts` lines 40–46):

| From | To |
| --- | --- |
| `UNCLAIMED` | `CLAIMED` |
| `CLAIMED` | `IN_PROGRESS`, `WAITING_ON`, `DONE`, `UNCLAIMED` |
| `IN_PROGRESS` | `WAITING_ON`, `DONE`, `UNCLAIMED` |
| `WAITING_ON` | `IN_PROGRESS`, `DONE`, `UNCLAIMED` |
| `DONE` | (none) |

`DONE` is terminal. `isValidPitCrewTransition` (lines 48–50) is what `applyTransition` checks.

`version` in practice: the column default is 1 (schema line 83). The first insert in `loadOrCreateOverlay` sets `version: 0` (`assignment.ts` lines 238–249) so a client that observed “no row” (`expectedVersion: 0`) can win the first transition. `getPitCrewWorkspace` uses `0` when there is no overlay row (`queries.ts` lines 109–112). The comment on those lines says real rows always start at version 1. That comment does not match the insert. `applyTransition` sets `version` to `row.version + 1` and updates only where `version` equals the caller’s `expectedVersion` (lines 278–283). A zero-row update throws `PitCrewConcurrencyError`.

`handoffWorkItem` does not go through `applyTransition`. It still updates only where `id` and `version` match, and it still increments `version` (lines 582–595). It does not change `status`.

### Source type is EXCEPTION only

`PIT_CREW_WORK_SOURCE_TYPES` is `["EXCEPTION"]` (`types.ts` lines 21–22). `PcWorkItem.sourceType` uses that union.

`assertSourceRecordOnPropertyInBrokerage` (`assignment.ts` lines 167–187) checks the source only when `sourceType === "EXCEPTION"`. The id must match a UUID shape, then a `risk_exceptions` row with that id, the same `brokerage_id`, and the same `property_id`. Any other `sourceType` returns immediately and is not rejected (line 168). The function comment (lines 163–166) already says a second source type needs its own branch. The HTTP params schema accepts any non-empty `sourceType` string (`routes/pitCrew.ts` line 109). New hand-back and escalate routes should reject anything other than `EXCEPTION` with the same not-found error, instead of using that early return.

The workspace reads open exceptions and left-joins the overlay by `source_record_id` (`queries.ts` lines 39 and 57–63). Open means `OPEN`, `ACKNOWLEDGED`, `IN_PROGRESS`, `AWAITING_EXTERNAL`, `REOPENED`. An overlay whose exception is `RESOLVED` or `DISMISSED` is not in this read. The join filters `source_type = 'EXCEPTION'` and the id list from the caller’s brokerage exceptions. It does not also filter the overlay’s `brokerage_id`. The source-record check on write is what stops a forged overlay from being created against another brokerage’s exception.

### What the mutations do today

All of these take `brokerageId` from the session at the route, plus client `propertyId`, `expectedVersion`, `sourceType`, and `sourceRecordId`. Routes require `requireAuth`, `requireRole("Pit Crew", "Brokerage Administrator")`, and `requireEntitlement("run.access")` (`routes/pitCrew.ts` lines 54–55; role constants in `apps/api/src/middlewares/auth.ts` lines 18–19). User roles are `Agent`, `Brokerage Administrator`, and `Pit Crew` (`packages/db/src/schema/users.ts` line 7). The route file header says agents do not get this surface (lines 3–5).

| Function | Status effect | Audit `action` | Other fields |
| --- | --- | --- | --- |
| `claimWorkItem` | to `CLAIMED` | `PC_CLAIMED` | assignee = actor, `claimedAt` |
| `assignWorkItem` | to `CLAIMED` | `PC_ASSIGNED` | assignee = `assigneeUserId` after `assertUserInBrokerage` |
| `startProgress` | to `IN_PROGRESS` | `PC_STATUS_CHANGED` | |
| `setWaitingOn` | to `WAITING_ON` | `PC_WAITING_ON_SET` | waiting-on columns |
| `returnFromWaitingOn` | to `IN_PROGRESS` | `PC_WAITING_ON_RETURNED` | waiting-on columns cleared |
| `completeWorkItem` | to `DONE` | `PC_COMPLETED` | `completedAt` |
| `releaseWorkItem` | to `UNCLAIMED` | `PC_RELEASED` | assignee, `claimedAt`, and waiting-on cleared |
| `handoffWorkItem` | status unchanged | `PC_HANDOFF` | assignee and last-handoff columns |

None of these functions import or call the exception writers, the transaction writers, the communications senders, or the financial writers. `assignment.ts` imports `db`, the counter, `logAudit`, the transition helper, and `dispatchOperationalAlert` (lines 14–19).

`assertUserInBrokerage` (`assignment.ts` lines 324–334) loads `users` where `id` and `brokerage_id` match. A miss throws `PitCrewAssigneeMismatchError`.

### Tenant-isolation counter

`tenant_isolation_rejection_total` has a `pit_crew` boundary (`packages/events/src/metrics.ts` lines 118–120). `notePitCrewRejection` increments it only when a follow-up existence lookup finds the same id in another brokerage (`assignment.ts` lines 103–112). Three lookups: property (`notePitCrewPropertyIsolationRejection`, lines 114–122), exception (`notePitCrewWorkItemIsolationRejection`, lines 124–132), and user (`notePitCrewAssigneeIsolationRejection`, lines 134–142). A genuine miss does not increment. The other brokerage’s id is not selected. Callers still throw `PitCrewPropertyMismatchError` or `PitCrewAssigneeMismatchError` either way. Routes map those to HTTP 404, concurrency to 409, and an illegal transition to 422 (lines 57–79).

### How the source exception relates to the overlay

The exception is the authoritative problem record: category, severity, exception status, `owner_type`, `owner_user_id`, due date, recommended action (`packages/db/src/schema/exceptions.ts`). Exception statuses (lines 34–43) are `OPEN`, `ACKNOWLEDGED`, `IN_PROGRESS`, `AWAITING_EXTERNAL`, `RESOLVED`, `DISMISSED`, `REOPENED`. Owner types (lines 95–101) are `LISTING_AGENT`, `TRANSACTION_OWNER`, `BROKERAGE_ADMINISTRATOR`, `PIT_CREW`, `UNASSIGNED_QUEUE`.

Pit Crew relevance in the workspace is `ownerType` of `PIT_CREW` or `UNASSIGNED_QUEUE`, or any exception that already has an overlay row (`types.ts` lines 134–142; filter at `queries.ts` lines 116–121). The overlay does not copy exception status and does not update it.

Exception status writers live in `apps/api/src/lib/exceptions/model.ts`: `acknowledgeException` (line 378), `startRemediation` (line 393), `markAwaitingExternal` (line 408), `resolveExceptionManually` (line 498), `dismissException` (line 520), `reassignOwner` (line 549). `reassignOwner` changes `owner_type` and `owner_user_id` and increments `reassignment_count`. Hand-back and escalate must not call these. Changing `owner_type` would also change who the command centre treats as the accountable owner (below). That is a different action from recording Pit Crew responsibility.

`apps/api/src/lib/pitCrew/types.ts` lines 3–19 and `queries.ts` lines 3–15 say the Agent Daily Command Centre is not merged and that the workspace should later be repointed at `getCommandCentre`. On this staging tip `getCommandCentre` exists, `apps/api/src/routes/index.ts` mounts `commandCentreRouter`, and the workspace still calls `listBrokerageExceptions` directly. Those two comments are stale relative to the tree. This proposal does not edit them.

## Where the receiving agent can see an item today

There is no hand-back and no escalation, so no current surface shows a Pit Crew next action aimed at an agent.

### Run Command Centre / Today

`ActionItem` (`apps/api/src/lib/commandCentre/types.ts` lines 39–67) is a derived read model. The module header says it owns no rows (lines 1–8). Fields include `recommendedAction`, `accountableOwnerType`, `accountableOwnerUserId`, `sections`, `dueAt`, and `deepLink`. Source types (lines 10–21) include `EXCEPTION` and several others. Pit Crew’s write model only accepts `EXCEPTION`.

`getCommandCentre` (`apps/api/src/lib/commandCentre/queries.ts`) builds items from exceptions, campaign items, launch plans, vendor approvals, transactions, conditions, offers, automation tasks, and workflow steps. Its imports (lines 19–33) do not include `pitCrewAssignments`. The `pitCrew` array on the response is the deduped items whose `accountableOwnerType === "PIT_CREW"` or whose `performingParty === "Pit Crew"` (lines 426–428). For an exception, `accountableOwnerType` is the exception’s `ownerType` (line 553), not the overlay status. Sections such as `today` and `overdue` come from the exception due date and status (lines 520–535), not from `pit_crew_assignments`.

HTTP: `GET /api/command-centre` requires authentication only (`apps/api/src/routes/commandCentre.ts` lines 19–29). Agents are limited to properties where `properties.agent_id` is themselves; Pit Crew and Brokerage Administrator get `restrictToPropertyIds = null` (`apps/api/src/routes/exceptions.ts` lines 48–56, `restrictedPropertyIdsFor`). The web page is `apps/web/src/pages/CommandCentre.tsx`. It calls `/command-centre` (line 51). The route on screen is `/today` (`apps/web/src/lib/todaySurfaces.ts` lines 1–10, `apps/web/src/lib/productNav.ts` line 59). The “Pit Crew Activity” block (page lines 115–125) renders `data.pitCrew` and its comment points at the owner-type filter above. It does not read the overlay.

A hand-back that only changes the overlay will not add a row to `today` or `now`, and it will not remove a row from `pitCrew`, because those lists do not read the overlay. If the exception `ownerType` remains `PIT_CREW`, the item stays in Pit Crew Activity. If it is already `LISTING_AGENT`, the item may already be in Today because of its due date, still without the hand-back’s next action. `recommendedAction` on that item is the exception’s recommended action, not a Pit Crew note.

### Grow Today

`GET /api/grow/today` (`apps/api/src/routes/grow.ts` line 101) requires `grow.access` and calls `getGrowTodaySummary` in `apps/api/src/lib/growToday.ts`. A search of `growToday.ts` and `apps/api/src/lib/grow/**` for `pit_crew` / `pitCrew` / `PIT_CREW` finds no matches. Grow Today is relationships, follow-ups, and signals (`todaySurfaces.ts` lines 3–4). It is not the Run Today workflow and it is not a place to project Pit Crew responsibility.

### Pit Crew workspace

`GET /api/pit-crew/workspace` is Pit Crew and Brokerage Administrator only. An Agent cannot call it. `myWork` is items assigned to the caller whose `pcStatus !== "DONE"` (`queries.ts` lines 124–126). `teamWork` is every non-`DONE` relevant item (line 127). `getPitCrewTeam` counts only `CLAIMED`, `IN_PROGRESS`, and `WAITING_ON` (lines 175–182). Those filters are why a new status is useful: `HANDED_BACK` and `ESCALATED` drop out of the team capacity count without a special case, and they drop out of `myWork` once the assignee is cleared or the filter excludes those statuses. `teamWork` as written today would still include them, because it only excludes `DONE`. The library slice must exclude them from `teamWork`, the coordination lists, and the overdue count, and expose separate handed-back and escalated lists so Pit Crew can still see and reclaim them.

### Least-invasive read path, and the collision

`apps/api/src/lib/commandCentre/**` and `apps/api/src/lib/grow/**` (and `apps/api/src/lib/growToday.ts`) are Grow-owned in the sense the ownership register uses: Run slices state that they do not claim `commandCentre`, and the edits that landed on those trees are Grow slices. Examples on the register: I-14 merged #101 edited `apps/api/src/lib/commandCentre/queries.ts`; G-3 merged #97 edited the Run header in `apps/web/src/pages/CommandCentre.tsx` and the Grow Today cross-links; F-5 / #96 edited `apps/api/src/lib/growToday.ts` and `apps/api/src/lib/grow/signalRanking.ts`. R-F6, R-F7, and R-F8 each say they do not claim `commandCentre` (`docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`). This proposal does not edit that register.

Least-invasive path:

1. Add `listResponsibilityItemsForRecipient(brokerageId, userId, role)` in `apps/api/src/lib/pitCrew/queries.ts`. It reads `pit_crew_responsibility_events` for that brokerage where the event status is `OPEN` or `ACKNOWLEDGED`, and either `recipient_user_id` is the caller or `recipient_role` equals the caller’s role. It joins the assignment and the exception for title, property address, and deep link `/properties/{propertyId}` (the same link `PcWorkItem` already uses, `queries.ts` line 93). The response field for the clear next action is the event’s `next_action`. The type is a Pit Crew DTO, not `ActionItem`.
2. Serve it from a new route on the Pit Crew router that allows `Agent` as well as Pit Crew and Brokerage Administrator, still with `requireEntitlement("run.access")`. The existing `canAccess` gate excludes Agents, so this route needs its own role list. The caller is always the recipient filter. The route does not accept another user’s id.
3. Leave `getCommandCentre` and Grow Today unchanged in that slice.

Collision: a later web slice that renders this list on `/today` has to touch `apps/web/src/pages/CommandCentre.tsx` (and likely `apps/web/src/lib/commandCentre.ts` if the client type lives there). Doing the projection inside `getCommandCentre` instead would touch `apps/api/src/lib/commandCentre/queries.ts` and the `ActionItem` dedup rules, which is a larger collision with the same Grow trees. The parallel fetch is the smaller edit. It can still conflict with an active Grow claim on the page. Do not schedule it while one of those files is claimed. At design time I-14 and G-3 are merged, not active claims. That can change before the web slice starts.

`run.access` is a brokerage entitlement (`apps/api/src/lib/billing/catalogue.ts`). The command-centre route does not check it. The new inbox should check it, because the action is Pit Crew / Run. An Agent in a brokerage that has `run.access` can pass `requireEntitlement`. That is the same grant Pit Crew routes already use.

## Data model options

### (a) New statuses and new columns on `pit_crew_assignments`

Add `HANDED_BACK` and `ESCALATED` to the status vocabulary. Add nullable columns for reason, severity, note, operator, recipient user, recipient role, next action, expected response time, and acknowledgement timestamps.

Pros: matches the current “last waiting-on / last handoff on the row” pattern. One table. Workspace filters that already key off `status` keep working. Optimistic `version` stays the one column that already exists.

Cons: one assignment can hold only the latest hand-back or escalation. A second escalation overwrites the first event’s recipient, expected time, and acknowledgement. Acknowledge, resolve, and return become more nullable columns on the same row. A future routing-rule id is another column that the next escalation replaces. The row gets wide, and most columns are null in the ordinary `CLAIMED` / `IN_PROGRESS` life of the item. `CHECK`s that tie columns to status are easy to get wrong.

Migration: yes. `ALTER TABLE` to add columns. New status strings themselves do not need a migration. Backfill: none if the new columns are nullable and existing rows are left alone.

### (b) Append-only responsibility events, status set extended only enough to leave the active buckets

Add `pit_crew_responsibility_events`, linked to the assignment. Keep the payload off the assignment. Add `HANDED_BACK` and `ESCALATED` as assignment statuses so `teamWork` / capacity / waiting-on sweep behaviour stays understandable. Do not add payload columns to the assignment.

Pros: each hand-back and escalation is a row, so acknowledgement and a later second escalation do not destroy the first. Expected response time and next action are real columns and can be queried. `brokerage_id` is on every event row. A partial unique index enforces one open event. The routing-rules table plugs into the resolver that fills the recipient at insert time. The assignment `version` remains the concurrency token. History that must be queried (open items, overdue response time, who acknowledged) does not depend on parsing `audit_logs.previous_value`.

Cons: two writes (event insert and assignment update) must commit together. The workspace read joins the open event when it shows the handed-back and escalated lists. This is a second table, which the overlay header originally avoided for handoff history. The difference is that handoff’s last-value columns cannot store an expected response time and an acknowledgement lifecycle that both have to stay queryable. The audit log still records the timeline event; the event table is the operational record.

Migration: yes. `CREATE TABLE` plus indexes and `CHECK`s. No change to existing rows. Backfill: none.

### (c) Audit log only

Write `PC_HANDED_BACK` / `PC_ESCALATED` through `logAudit` and do not store a structured row.

This cannot meet the product requirements, for these concrete reasons:

- `audit_logs` columns are `action`, `record_type`, `record_id`, `previous_value`, `updated_value`, and optional `brokerage_id` / `property_id` / user fields (`packages/db/src/schema/audit.ts` lines 6–20). There is no column for severity, recipient, next action, or expected response time. Putting them into `updated_value` makes them untyped text.
- `logAudit` swallows errors unless the caller passes `strict: true` (`audit.ts` lines 34–54). A best-effort insert can fail and leave no record. Existing Pit Crew calls do not pass `strict`.
- The command centre and the Pit Crew workspace do not build their lists from `audit_logs`. An audit row does not become an `ActionItem` and does not become a `PcWorkItem`.
- The property timeline will not show the row unless the action is added to `TIMELINE_ENTRY_TYPES`, and even then the timeline is a history list, not a per-user inbox with a due time.
- There is no index for “open escalations for this user whose expected response is before now”. `audit_logs_property_action_idx` is `(property_id, action)` (schema lines 29–30).

Migration: no. That is not a reason to choose it.

### Choice

Option (b). Status values `HANDED_BACK` and `ESCALATED` are part of that choice so the existing status filters have a truthful bucket. They are not option (a)’s column set.

## Proposed table

`pit_crew_responsibility_events`. Types below are the Postgres types to generate. Names are snake_case columns.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | serial PK | no | |
| `brokerage_id` | integer FK `brokerages.id` | no | Tenant on every row |
| `assignment_id` | integer FK `pit_crew_assignments.id` | no | |
| `property_id` | integer FK `properties.id` | no | Copied from the assignment at insert so an inbox query can filter without trusting a client property id |
| `kind` | text | no | `HAND_BACK` or `ESCALATION` |
| `reason_category` | text | no | Enumeration for that `kind` |
| `severity` | text | yes | Required for `ESCALATION`, null for `HAND_BACK` |
| `note` | text | yes | Optional on hand-back. Required on escalate, resolve, and return (application validation; the column stays nullable so acknowledge can omit it) |
| `next_action` | text | no | The clear next action shown to the recipient. Non-empty |
| `originating_user_id` | integer FK `users.id` | no | The Pit Crew operator (or Brokerage Administrator) who performed the action |
| `recipient_user_id` | integer FK `users.id` | yes | |
| `recipient_role` | text | yes | v1 only `Brokerage Administrator` |
| `resulting_responsibility` | text | no | `AGENT` or `BROKERAGE_ADMINISTRATOR` |
| `expected_response_at` | timestamp | yes | Escalation only. Null on hand-back |
| `status` | text | no | Event status, default `OPEN` |
| `acknowledged_at` | timestamp | yes | |
| `acknowledged_by_user_id` | integer FK `users.id` | yes | |
| `closed_at` | timestamp | yes | Set when status becomes `RESOLVED`, `RETURNED`, or `SUPERSEDED` |
| `closed_by_user_id` | integer FK `users.id` | yes | |
| `routing_rule_id` | — | — | Not in 0032. A later migration adds a nullable FK once the rules table exists |
| `created_at` | timestamp | no | default `now()` |
| `updated_at` | timestamp | no | default `now()` |

No `open_responsibility_event_id` on the assignment. That would be a circular foreign key (the event points at the assignment, the assignment would point at the event). The open event is the row selected by the partial unique index below. The assignment `status` is the workspace bucket.

### Checks

- `kind in ('HAND_BACK', 'ESCALATION')`
- `status in ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'RETURNED', 'SUPERSEDED')`
- `resulting_responsibility in ('AGENT', 'BROKERAGE_ADMINISTRATOR')`
- Exactly one recipient: `(recipient_user_id is not null)::int + (recipient_role is not null)::int = 1`
- `kind = 'HAND_BACK'` implies `severity is null` and `expected_response_at is null` and `resulting_responsibility = 'AGENT'` and `status in ('OPEN', 'SUPERSEDED')`
- `kind = 'ESCALATION'` implies `severity in ('ATTENTION', 'AT_RISK', 'CRITICAL')` and `resulting_responsibility = 'BROKERAGE_ADMINISTRATOR'` and `status in ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'RETURNED')`
- `char_length(trim(next_action)) > 0`
- `char_length(trim(reason_category)) > 0`
- `recipient_role is null or recipient_role = 'Brokerage Administrator'`
- Acknowledgement columns are both null or both set, and both set only when status is `ACKNOWLEDGED`, `RESOLVED`, or `RETURNED`
- `closed_at` and `closed_by_user_id` are both null when status is `OPEN` or `ACKNOWLEDGED`, and both set otherwise

Reason-category allowed values can be a `CHECK` as well, once the Owner locks the lists. Until then, application validation is the gate, and the `CHECK`s above still keep kind, severity, recipient, and event status coherent. Prefer putting the locked reason lists into the `CHECK` in 0032 if the Owner has already decided them, so a bad value cannot be inserted by a later caller that skips the route schema.

### Indexes

- Partial unique index `pit_crew_responsibility_events_one_open_uidx` on `(assignment_id)` where `status in ('OPEN', 'ACKNOWLEDGED')`. One open event per assignment.
- `pit_crew_responsibility_events_brokerage_recipient_idx` on `(brokerage_id, recipient_user_id, status)`.
- `pit_crew_responsibility_events_brokerage_role_idx` on `(brokerage_id, recipient_role, status)`.
- `pit_crew_responsibility_events_assignment_created_idx` on `(assignment_id, created_at)`.
- `pit_crew_responsibility_events_property_idx` on `(property_id)`.

Every query from a route includes `brokerage_id` from the session. The recipient indexes are for the inbox. They are not a substitute for the brokerage predicate.

### Optimistic version

The assignment `version` stays the token. Hand-back, escalate, acknowledge, resolve, return, and reclaim all run in one `db.transaction` (the codebase already uses `db.transaction`, for example `apps/api/src/lib/workflowSteps.ts`). Inside it:

1. Insert the event, or update the open event’s status.
2. Update `pit_crew_assignments` set `status` (when it changes), the assignee fields described in the state machine, `version = version + 1`, `updated_at = now()` where `id` and `version` equal the caller’s `expectedVersion`.
3. If that update returns no row, throw `PitCrewConcurrencyError` and roll back the event write.
4. `logAudit` with `strict: true` and `write` bound to the same transaction.

`expectedVersion` remains required on every mutating body, including acknowledge, which does not change assignment status but still bumps `version`. That matches handoff: a concurrent writer cannot interleave.

The waiting-on sweep selects `status = 'WAITING_ON'` (`assignment.ts` lines 470–475). A row that has moved to `HANDED_BACK` or `ESCALATED` is not selected. The human sweep and the scheduled detection sweep do not need a change to stay correct. The library slice should still clear waiting-on columns when leaving `WAITING_ON`, so the columns do not show a stale block.

### Future routing table (not in 0032)

`pit_crew_escalation_routing_rules`:

| Column | Notes |
| --- | --- |
| `id` | serial PK |
| `brokerage_id` | not null, FK |
| `reason_category` | not null |
| `recipient_user_id` | nullable FK |
| `recipient_role` | nullable, v1 vocabulary `Brokerage Administrator` |
| `priority` | integer, not null, smaller wins |
| `enabled` | boolean, not null, default true |
| `created_at`, `updated_at` | |

Same exactly-one-recipient `CHECK`. Index `(brokerage_id, reason_category, enabled, priority)`.

`resolveResponsibilityRecipient` order, unchanged as a workflow:

1. If the caller passed `recipientUserId`, `assertUserInBrokerage`. For escalation, the user must have role `Brokerage Administrator`. For hand-back, the user must have role `Agent` (recommended; Owner confirms).
2. Else if an enabled rule exists for this brokerage and reason, use the first by `priority`. v1 has no table, so this step is absent and the function returns the default. When the table exists, this step is a select inside the same function. The route body and the status transition do not change.
3. Else hand-back uses `properties.agent_id`, then `assertUserInBrokerage`. Escalate uses `recipient_role = 'Brokerage Administrator'`.
4. The function returns `{ recipientUserId, recipientRole, routingRuleId }`. `routingRuleId` is null until the later column exists. The event insert stores the user or the role. It does not store a rule id in 0032.

Adding the rules table is additive. It does not change `PIT_CREW_STATUS_TRANSITIONS` or the route paths.

## State machine

Proposed `PIT_CREW_STATUS_TRANSITIONS`. Existing edges stay.

| From | Added `to` | Who | Assignment fields | Event |
| --- | --- | --- | --- | --- |
| `CLAIMED`, `IN_PROGRESS`, `WAITING_ON` | `HANDED_BACK` | Pit Crew or Brokerage Administrator, with `run.access` | Clear `assignedToUserId`, `claimedAt`, and waiting-on columns. Do not set `completedAt`. Leave the last PC-to-PC handoff columns as they are | Insert `HAND_BACK` / `OPEN`. Audit `PC_HANDED_BACK` |
| `CLAIMED`, `IN_PROGRESS`, `WAITING_ON` | `ESCALATED` | Same | Keep `assignedToUserId` as the originator so a return has a Pit Crew user to come back to. Clear waiting-on columns. Do not set `completedAt` | Insert `ESCALATION` / `OPEN`. Audit `PC_ESCALATED` |
| `HANDED_BACK` | `CLAIMED` | Pit Crew or Brokerage Administrator | Set `assignedToUserId` to the actor, set `claimedAt` | Open hand-back event becomes `SUPERSEDED`. Audit `PC_RECLAIMED` |
| `ESCALATED` | `ESCALATED` (status unchanged, version still bumps) | Named recipient, or a Brokerage Administrator when the recipient is the role | No assignee change | Event `OPEN` to `ACKNOWLEDGED`. Audit `PC_ESCALATION_ACKNOWLEDGED` |
| `ESCALATED` | `IN_PROGRESS` | Same people as acknowledge | Assignee stays the originator. Waiting-on stays clear | Event to `RESOLVED` (audit `PC_ESCALATION_RESOLVED`) or `RETURNED` (audit `PC_ESCALATION_RETURNED`) |

Edges that stay forbidden:

- Anything out of `DONE`.
- Hand-back or escalate from `UNCLAIMED`, `HANDED_BACK`, `ESCALATED`, or `DONE`.
- `HANDED_BACK` to `ESCALATED` or to `DONE`. Reclaim first if Pit Crew must take the item again.
- `ESCALATED` to `HANDED_BACK` or to `DONE`. Return or resolve to `IN_PROGRESS`, then hand back or complete as a separate action.
- `UNCLAIMED` is still only reached by `releaseWorkItem`.

Workspace consequences the library slice must implement, because today’s filters do not know the new statuses:

- `myWork`: exclude `HANDED_BACK` and `ESCALATED`. Hand-back has already cleared the assignee. Escalation would still match `assignedToUserId === actor && pcStatus !== "DONE"` (`queries.ts` lines 124–126) if the filter is not updated.
- `teamWork`, launch coordination, transaction coordination, overdue count: exclude both new statuses from the active lists.
- `getPitCrewTeam` already ignores any status outside `CLAIMED` / `IN_PROGRESS` / `WAITING_ON`.
- Add `handedBack` and `escalated` arrays on `PcWorkspace`, each joined to the open event so the screen can show reason, recipient, and next action.
- `unassignedWork` stays `pcStatus === "UNCLAIMED"`.
- `completedToday` stays `DONE` with `completedAt` today. Hand-back does not appear there.

The source exception’s `status`, `owner_type`, and `owner_user_id` do not change. Transaction status does not change. No domain event of type `CONTRACT_*`, `SETTLEMENT_*`, `FUNDS_RECEIVED`, `OFFER_*`, or the financial event types is published.

Reclaim, resolve, and return are the only ways an open event stops being open. The partial unique index then allows a later hand-back or escalation on the same assignment.

## Reason, severity, and event enumerations

Application constants, mirrored by `CHECK`s once the Owner locks them. Not Postgres enum types. The existing Pit Crew status column is `text` for the same reason: the vocabulary lives in the schema module and the transition map.

Hand-back `reason_category`:

| Value | Meaning |
| --- | --- |
| `WORK_COMPLETE` | Pit Crew’s own part is finished and the agent has the next action |
| `NEXT_ACTION_WITH_AGENT` | The next step was always the agent’s |
| `INFORMATION_RETURNED` | Pit Crew gathered what was asked and is returning the item |
| `NOT_PIT_CREW_WORK` | The item should not sit with Pit Crew |

Escalation `reason_category` follows the cases the product named:

| Value | Meaning |
| --- | --- |
| `BLOCKED_DEPENDENCY` | A dependency Pit Crew cannot clear |
| `OVERDUE_THIRD_PARTY` | A third party is overdue. Recording this does not contact that party |
| `SETTLEMENT_OR_COMPLIANCE_RISK` | Settlement or compliance risk Pit Crew must not progress itself |
| `MISSING_AUTHORITY` | The operator lacks authority to take the next step |
| `MISSING_INFORMATION` | Required information is missing |
| `OTHER_MATERIAL_EXCEPTION` | Another material exception. The note says what it is |

Severity, escalation only: `ATTENTION`, `AT_RISK`, `CRITICAL`.

Event `status`: `OPEN`, `ACKNOWLEDGED`, `RESOLVED`, `RETURNED`, `SUPERSEDED`.

`resulting_responsibility`: `AGENT`, `BROKERAGE_ADMINISTRATOR`.

These lists are Owner decisions. The tables above are the proposed minimum that covers the product wording without a free-text reason.

## API

All new routes live on `pitCrewRouter`, which is already mounted with the `/api` prefix used by the existing `/pit-crew/...` paths. Bodies that fail zod return `400` `{ "error": "Invalid request." }`, matching the existing routes.

Flag off: `404` `{ "error": "Not found." }` before any read of the new table.

### Hand back and escalate

`POST /pit-crew/items/:sourceType/:sourceRecordId/hand-back`

`POST /pit-crew/items/:sourceType/:sourceRecordId/escalate`

Gate: the existing `canAccess` plus `requireEntitlement("run.access")`. Agents are refused by that role gate (403 from `requireRole`, the same as today’s claim route).

Shared checks, in order:

1. Flag.
2. Params and body schema.
3. `sourceType` must be `EXCEPTION`. Otherwise `PitCrewPropertyMismatchError` (404). Do not use the early return in `assertSourceRecordOnPropertyInBrokerage`.
4. `loadOrCreateOverlay`, which already checks the property and the exception in the caller’s brokerage and increments `tenant_isolation_rejection_total` with boundary `pit_crew` on a cross-tenant hit.
5. `resolveResponsibilityRecipient`, which calls `assertUserInBrokerage` for any user id. A user in another brokerage is `PitCrewAssigneeMismatchError` (404) and the same counter.
6. Transition check, then the transaction described above.

Hand-back body:

```json
{
  "propertyId": 1,
  "expectedVersion": 3,
  "reasonCategory": "WORK_COMPLETE",
  "note": "optional",
  "recipientUserId": 42,
  "nextAction": "Review the returned condition evidence and confirm the next step."
}
```

`recipientUserId` may be omitted. The resolver then uses `properties.agent_id`.

Escalate body:

```json
{
  "propertyId": 1,
  "expectedVersion": 3,
  "reasonCategory": "MISSING_AUTHORITY",
  "severity": "AT_RISK",
  "note": "Settlement figure is outside Pit Crew authority.",
  "nextAction": "Decide whether the brokerage will authorise the next settlement step.",
  "recipientUserId": 7,
  "expectedResponseAt": "2026-10-01T04:00:00.000Z"
}
```

`recipientUserId` may be omitted. The resolver then sets `recipient_role` to `Brokerage Administrator`. The client does not send an arbitrary role in v1. `expectedResponseAt` is required for `AT_RISK` and `CRITICAL` if decision 8 stands.

Success `200` JSON: the updated assignment row (the same shape the existing mutation routes return) plus `responsibilityEvent` with the columns above. Existing routes return the assignment row only (`res.json(row)`). Adding a sibling field changes the success body for these new routes only.

### Acknowledge, resolve, return, reclaim

`POST /pit-crew/items/:sourceType/:sourceRecordId/escalation/acknowledge`

`POST /pit-crew/items/:sourceType/:sourceRecordId/escalation/resolve`

`POST /pit-crew/items/:sourceType/:sourceRecordId/escalation/return`

`POST /pit-crew/items/:sourceType/:sourceRecordId/hand-back/reclaim`

Acknowledge, resolve, and return: caller is the `recipient_user_id`, or an active Brokerage Administrator in the brokerage when the open event’s `recipient_role` is `Brokerage Administrator`. Also require `run.access`. A Pit Crew originator who is not the recipient and not a Brokerage Administrator receives 403. A missing open escalation is 404 with the same not-found wording as a cross-tenant miss, after the source-record check, so the route does not reveal another brokerage’s event.

Bodies: `propertyId`, `expectedVersion`, and for resolve and return a required `note`. Acknowledge may omit `note`.

Reclaim: existing `canAccess` plus `run.access`. Body is `propertyId` and `expectedVersion` only. Allowed from `HANDED_BACK` only.

### Agent inbox

`GET /pit-crew/responsibility-inbox`

Gate: `requireAuth`, role `Agent` or `Pit Crew` or `Brokerage Administrator`, `requireEntitlement("run.access")`. No query params. `brokerageId` and the user come from the session.

Response:

```json
{
  "generatedAt": "2026-09-27T00:00:00.000Z",
  "items": [
    {
      "sourceType": "EXCEPTION",
      "sourceRecordId": "uuid",
      "propertyId": 1,
      "propertyAddress": "…",
      "title": "…",
      "nextAction": "…",
      "kind": "HAND_BACK",
      "reasonCategory": "WORK_COMPLETE",
      "severity": null,
      "note": null,
      "originatingUserId": 9,
      "recipientUserId": 42,
      "recipientRole": null,
      "expectedResponseAt": null,
      "eventStatus": "OPEN",
      "assignmentStatus": "HANDED_BACK",
      "version": 4,
      "deepLink": "/properties/1",
      "createdAt": "…"
    }
  ]
}
```

`nextAction` is the clear next action. This object is not an `ActionItem`. Financial exceptions stay redacted by reusing the risk engine’s existing non-entitled view if the joined exception is financial. Pit Crew workspace already calls `listBrokerageExceptions` with `canViewFinancials: false` (`queries.ts` lines 48–55). The inbox should use that same redaction for any exception field it copies. The event’s own `note` and `next_action` are text the operator typed. The route must not attach payment amounts. v1 does not add a separate financial filter beyond “do not join financial tables”. If the underlying exception is in the financial category, the inbox still shows the responsibility event’s next action and the exception title only when the caller’s existing financial entitlement would allow the title. Brokerage Administrator can view financials (`canViewFinancials` in `routes/exceptions.ts` lines 44–46). Agents and Pit Crew cannot. For those callers, a financial-category exception should contribute a redacted title, not the raw exception title. The exact redaction string should reuse the one `listBrokerageExceptions` already returns, not a new string. That reuse is an implementation check against `apps/api/src/lib/exceptions/queries.ts` at build time; this proposal does not quote that string because it was not re-read for the redaction copy.

### Errors

| Condition | HTTP | Body |
| --- | --- | --- |
| Flag off, or source/property/exception not in the brokerage, or recipient user not in the brokerage | 404 | `{ "error": "<existing mismatch message or Not found.>" }` |
| Role not allowed | 403 | existing `requireRole` response |
| Bad body, including a reason or severity outside the enum | 400 | `{ "error": "Invalid request." }` |
| Stale `expectedVersion` | 409 | `PitCrewConcurrencyError` message |
| Status does not allow the action | 422 | `PitCrewTransitionError` message |
| No open escalation when acknowledging | 404 | `{ "error": "Not found." }` |

Do not add a new error class for the cross-tenant recipient case. Reuse `PitCrewAssigneeMismatchError` so the counter and the 404 stay on the path that already exists.

### Audit codes

| Code | When | `previous_value` | `updated_value` |
| --- | --- | --- | --- |
| `PC_HANDED_BACK` | Hand back | from status | `HANDED_BACK` |
| `PC_ESCALATED` | Escalate | from status | `ESCALATED` |
| `PC_ESCALATION_ACKNOWLEDGED` | Acknowledge | `OPEN` | `ACKNOWLEDGED` |
| `PC_ESCALATION_RESOLVED` | Resolve | `ESCALATED` | `IN_PROGRESS` |
| `PC_ESCALATION_RETURNED` | Return | `ESCALATED` | `IN_PROGRESS` |
| `PC_RECLAIMED` | Reclaim hand-back | `HANDED_BACK` | `CLAIMED` |

`record_type` stays `EXCEPTION` and `record_id` stays the exception id, matching `applyTransition` (lines 285–294). `property_id` and `brokerage_id` are set. `user_id` is the actor. The structured reason, recipient, and next action live on the event row. They are not packed into `updated_value`.

## Safety

Hand-back, escalate, acknowledge, resolve, return, and reclaim are overlay writes plus an audit row. They do not send a message, move money, change a transaction or a legal/condition status, or approve anything.

The new module must not call, and must not import, these functions:

| Must not call | File |
| --- | --- |
| `acknowledgeException`, `startRemediation`, `markAwaitingExternal`, `resolveExceptionManually`, `dismissException`, `reassignOwner` | `apps/api/src/lib/exceptions/model.ts` |
| `acceptOffer`, `recordContractSigned`, `recordFinanceApproved`, `scheduleSettlement`, `completeSettlement`, `recordFundsReceived`, `recordAgentPaid`, `recordLegalRepresentatives`, `closeTransaction`, `calculateCommission` | `apps/api/src/lib/transactions.ts` |
| `withdrawOffer`, `declineOffer` | `apps/api/src/lib/offers.ts` |
| `resolveCondition`, `maybeRecordUnconditional`, `addCondition`, `rescheduleConditionDueDate` | `apps/api/src/lib/transactionConditions.ts` |
| `sendMessageNow`, `approveMessage` | `apps/api/src/lib/communications/messages.ts` |
| `dispatchMessage`, `dispatchDueMessages` | `apps/api/src/lib/communications/outbox.ts` |
| `sendSmsViaIntegration` | `apps/api/src/lib/integrations/commsProof.ts` |
| `notifyFinancialEvent` | `apps/api/src/lib/financial/communications.ts` |
| `finalizeCommissionForSettlement`, `ensurePcSuccessFeeRequest` | `apps/api/src/lib/financial/settlement.ts` |
| `approveCommissionAgreement`, `createCommissionAgreement`, `cancelCommissionAgreement` | `apps/api/src/lib/financial/agreements.ts` |
| `scheduleDebitForPaymentRequest`, `dispatchOutboxEntry`, `dispatchPendingPaymentOutbox`, `cancelScheduledDebit`, `reverseDebit` | `apps/api/src/lib/financial/paymentOutbox.ts` |
| `createPcFeeCalculation` | `apps/api/src/lib/financial/pcFeeCalculations.ts` |
| `activatePcFeeAuthority`, `revokePcFeeAuthority`, `createPcFeeAuthority` | `apps/api/src/lib/financial/pcFeeAuthorities.ts` |
| `emitFinancialEvent` | `apps/api/src/lib/financial/events.ts` |
| `decideVendorApproval` | `apps/api/src/lib/launch/model.ts` |
| `publishListingToMockPortal` | `apps/api/src/lib/integrations/launchProof.ts` |
| `approveAIActionRequest` | `apps/api/src/lib/ai/actionRequests.ts` |
| `approveAndActivateRuleVersion` | `apps/api/src/lib/automation/rules.ts` |

No new call to `dispatchOperationalAlert` except the existing mismatch constructors, which already alert on a cross-tenant id. Hand-back and escalate do not page a third party and do not create an operational alert that asks someone to contact a customer, a solicitor, or a settlement agent.

Tests that lock this. None of these exist yet. `apps/api/src/lib/pitCrew/__tests__/assignment.test.ts` covers the current lifecycle and asserts a `PC_CLAIMED` audit row (around lines 164–166). It does not assert that the exception row is unchanged, because the new actions do not exist. The implementation slice adds, in that suite or a sibling file that uses the same real-exception fixtures:

- After hand-back and after escalate, `risk_exceptions.status`, `owner_type`, and `owner_user_id` equal the fixture values. `transactions` row for the property, if any, is unchanged. No new `communication_messages` row, no new `financial_payment_requests` row, no new `financial_payment_outbox` row.
- The new module’s source does not import the modules in the table above. A file-read assertion is enough. It fails if a later edit imports `transactions.js` or `communications/messages.js` from the responsibility module.
- `DONE` and `UNCLAIMED` reject hand-back and escalate with `PitCrewTransitionError`.
- A `recipientUserId` in another brokerage throws `PitCrewAssigneeMismatchError` and increments `tenant_isolation_rejection_total` with boundary `pit_crew` once.
- A stale `expectedVersion` throws `PitCrewConcurrencyError` and leaves no `OPEN` event row.
- With the flag unset, the new functions do not insert an event and the new routes return 404.
- Acknowledge, resolve, and return do not change exception status and do not change `assignedToUserId`.

`apps/api/src/routes/__tests__/pitCrew.test.ts` is the route-level place for the 400 / 403 / 404 / 409 / 422 mapping. `apps/api/src/routes/__tests__/pitCrewHandoffRecipient.test.ts` is the pattern for the recipient brokerage check.

## Migration plan

Number: **0032**. Journal tag proposal: `0032_pit_crew_responsibility_events`. File: `packages/db/migrations/0032_pit_crew_responsibility_events.sql`. Schema declaration goes in `packages/db/src/schema/pitCrew.ts` in the same implementation pull request as the SQL, so `drizzle-kit` drift stays empty. This design pull request does not add that SQL.

Additive only: `CREATE TABLE`, foreign keys, `CHECK`s, and indexes. No `UPDATE`. No backfill. Existing `pit_crew_assignments` rows are untouched, so their `version` values stay valid.

Preflight: `packages/db/scripts/preflight-migrations.mjs` covers migrations 0020, 0022, 0024, and 0025 only. 0032 does not constrain existing rows, so it does not need a new preflight check. The Owner still runs the existing preflight because the runbook says to run it before every `db:migrate`.

Apply, Owner-approved, on Replit, as its own step, not from application boot. `packages/db/src/migrate.ts` lines 14–22 say the runner is not executed against the live database as part of boot, and `docs/REPLIT_PILOT_DEPLOYMENT_RUNBOOK.md` section 6 says the same (“Never let the application boot itself run migrations automatically”). Steps, matching that runbook:

1. Owner approval to apply 0032 on the named database.
2. `DATABASE_URL="<the pilot's own connection string>" pnpm --filter @aee/db run db:preflight` (runbook section 6.1).
3. Confirm session time zone UTC (runbook section 6.2). The new timestamps are `timestamp without time zone`, the same as the rest of the schema.
4. `DATABASE_URL="<the pilot's own connection string>" pnpm --filter @aee/db run db:migrate` (runbook section 6.3), once.

The SQL file should contain no `--> statement-breakpoint` markers, so it is one script in one journal entry. Do not put `BEGIN` / `COMMIT` inside the file: a migrator that has already opened a transaction rejects a nested `BEGIN`. Whether the installed `drizzle-orm` migrator wraps one journal entry in a single database transaction was **not verified** in this checkout. `node_modules/drizzle-orm` is not present here. The operational guarantee this proposal can make is: one new journal entry, no breakpoints, one Owner-run `db:migrate`, and SQL that is a single create. If that migrator is later shown to commit per statement, the creates are still one table plus its constraints; a failure mid-file leaves a journal gap that `db:migrate` will retry only if the partial objects are dropped first. The rollback below is that drop.

Flag: `PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED` defaults off. Code that references the table only from the flagged functions can merge before step 4. CI’s own database applies the migration from the repo, so tests of the flagged functions can run in CI after the migration file exists, while Replit stays on 0031 until the Owner runs step 4. Turning the flag on before step 4 would make the new routes query a missing table. Leave the flag off until `db:migrate` reports 0032 applied. Do not set the variable in `.env` as part of the schema pull request. A comment in `.env.example` belongs with the route slice, not with this document.

Rollback, only before any `HANDED_BACK` or `ESCALATED` row exists (the flag has never been on):

```sql
DROP TABLE IF EXISTS pit_crew_responsibility_events;
```

Then remove the 0032 journal row only under the same Owner procedure the project already uses to repair a failed migration. This proposal does not invent that procedure.

If the flag was on and assignments were moved, `DROP TABLE` removes the events and leaves `status` values the old code does not understand. `applyTransition` would then reject every transition out of those statuses (`DONE`-like stuck rows, except `DONE` is a known status and these strings are not). Recovery before drop, in the same transaction as the drop:

```sql
UPDATE pit_crew_assignments
SET status = 'IN_PROGRESS', updated_at = now()
WHERE status IN ('HANDED_BACK', 'ESCALATED');
DROP TABLE IF EXISTS pit_crew_responsibility_events;
```

That `UPDATE` does not restore the previous assignee or waiting-on columns. It is a stopgap so the row is a known status. It is not a full undo. Prefer never enabling the flag until the Owner intends to keep the table.

`version` on rows that were updated by the feature will have increased. Rolling the status back does not roll `version` back. Clients holding an old `expectedVersion` already have to refresh after any successful mutation today.

## Implementation sequence

Each line is one pull request, independently testable. None of them is this document.

| # | Pull request | Migration | Owner decision required first |
| --- | --- | --- | --- |
| 1 | Schema module plus `0032_pit_crew_responsibility_events.sql` and the journal entry. No runtime calls. Test: migration applies on a scratch database, `drizzle-kit` generates no further diff, existing Pit Crew tests still pass | Yes, 0032. Do not apply it on Replit in this pull request | Decisions 1, 2, and 3 (table shape, statuses, enums that go into `CHECK`s) |
| 2 | `resolveResponsibilityRecipient`, hand-back, escalate, acknowledge, resolve, return, reclaim, and the workspace filter updates, behind the flag. Tests listed in Safety, including the forbidden-import test and the unchanged exception row | No, if 1 has merged. Tests run against CI’s migrated database | Decisions 4, 6, 7, 8, and 11 |
| 3 | Routes, zod, error mapping, audit codes, flag 404. Route tests for 400 / 403 / 404 / 409 / 422 and the cross-tenant recipient. Comment in `.env.example`, flag unset | No | Decision 10, and the audit half of decision 9 (`brokerageId` + `strict`). Timeline allow-list stays out of this pull request |
| 4 | `listResponsibilityItemsForRecipient` and `GET /pit-crew/responsibility-inbox`. Tests: an Agent sees their hand-back and does not see another agent’s; a Brokerage Administrator sees role-addressed escalations in their brokerage only; financial title redaction matches the exception read | No | Decision 5 (the read path). Does not edit `lib/commandCentre/**` or `lib/grow/**` |
| 5 | Web: Pit Crew buttons on `apps/web/src/pages/PitCrewCommandCentre.tsx` and `apps/web/src/lib/pitCrew.ts` for hand-back, escalate, reclaim, and the escalation responses. Separately, only when `CommandCentre.tsx` is unclaimed, a section on `/today` that fetches the inbox route and shows `nextAction` | No | Decision 5 for the `/today` placement. The Pit Crew page itself is the Run surface and can land first |

A timeline allow-list change in `apps/api/src/lib/timeline.ts` is optional and is not one of the five. It is decision 9’s second half. It should not be folded into pull request 3, because that file is shared and the current `PC_*` codes are already absent from it on purpose or by omission. This proposal did not find a comment that says the omission is deliberate. It found only that the codes are not in the map.

Pull request 1 can merge with the flag absent. Pull requests 2–5 merge with the flag defaulting off. The Owner applies 0032 before anyone sets the flag. Pull request 5’s `/today` edit does not start during a Grow claim on `CommandCentre.tsx` or `lib/commandCentre/queries.ts`.

## Open questions

1. Should hand-back’s default recipient be `properties.agent_id`, or the exception’s `owner_user_id` when `owner_type` is `LISTING_AGENT` or `TRANSACTION_OWNER`? This proposal uses `properties.agent_id` because that column is the agent scope `restrictedPropertyIdsFor` already uses. It is not always the exception owner.
2. When several users have role `Brokerage Administrator`, a role recipient means each of them sees the escalation in the inbox. There is no single assignee. Confirm that fan-in is acceptable. v1 does not pick “the first administrator”.
3. May hand-back name an Agent who is not `properties.agent_id`? Recommended yes, if they are an Agent in the brokerage, because the operator may be returning the item to a specific person. The inbox shows it to that user even if `restrictedPropertyIdsFor` would hide the property on the command centre. Confirm that recipient scope should win over the property-agent scope.
4. Should `expected_response_at` overdue items eventually reuse the waiting-on detection sweep? Recommended not in v1. A later design can add a read-only detection pass. It must not call `sweepOverdueWaitingOn` and must not send communications.
5. Should the new audit codes be added to `TIMELINE_ENTRY_TYPES`? If yes, that slice also has to decide a `TimelineCategory`. The exception actions use `Compliance` (`timeline.ts` lines 138–160). Pit Crew responsibility is closer to a task handoff than to a compliance resolution. This proposal does not choose a category.
6. `queries.ts` still says the command centre is unmerged, and it says overlay versions start at 1. Fixing those comments is a separate small edit. It is not required to implement hand-back.
7. The unique index on `(source_type, source_record_id)` is not brokerage-scoped. Exception ids are UUIDs, so two brokerages do not share an id in practice. The new table is brokerage-scoped anyway. No change to the old unique index in 0032.
8. Live row contents of `pit_crew_assignments.status` were not queried. The recommendation to avoid a status `CHECK` in 0032 does not depend on that count. A later `CHECK` does.
9. Drizzle migrator transaction boundaries were not verified here, as noted in the migration plan.
