# R-F27 — Decision 6: LAUNCH_ITEM hand-back and escalate

Status: proposal only. Nothing in this document is implemented. Staging tip verified for this proposal: `87498b714ba645f90b81f6d1d8affdb83743a559` (`R-F26: run the existing web test suite in CI (#138)`). Migration journal on that tip ends at `0033_pit_crew_responsibility_closing_note` (`packages/db/migrations/meta/_journal.json`).

This proposal does not change schema, routes, flags, or behaviour. It records how Pit Crew hand-back and escalate could be extended to a responsibility event whose assignment `source_type` is `LAUNCH_ITEM`, and which choices are still the Owner's.

`LAUNCH_ITEM` means one `campaign_items` row. That choice is already the second-source recommendation (`docs/design/PIT_CREW_SECOND_SOURCE_TYPE_DESIGN.md`, decision 1) and is what R-F22 through R-F25 implemented behind `PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED`. This document does not reopen that pick.

## Preserved decisions

These are already in the code or in the accepted second-source design. This proposal does not reopen them.

- Pit Crew `DONE` does not mutate the campaign item. `completeWorkItem` sets the overlay to `DONE` and writes `PC_COMPLETED` (`apps/api/src/lib/pitCrew/assignment.ts` lines 620–622). It does not call `updateCampaignItemStatus`.
- A Pit Crew action does not mutate the underlying campaign item unless a later Owner decision says so. This proposal does not say so.
- A launch item on the Pit Crew workspace is severity `INFORMATION` and category `LAUNCH_CAMPAIGN` (`apps/api/src/lib/pitCrew/queries.ts` lines 308–309). The campaign item status is copied into `exceptionStatus` (line 310).
- The responsibility-inbox title for a launch item is `campaign_items.title`. The flag-on select reads id, title, property id, and brokerage id. It does not select `cost_cents` or `vendor_name` (`queries.ts` lines 575–583 and 718–721).
- `PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED` and `PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED` stay off unless each value is the literal string `"true"`. This proposal does not set either flag.
- The Pit Crew boundary stays role, plus `run.access`, plus brokerage, plus property. `routes/launch.ts` does not gain `run.access`.

Where a real choice remains, it is in Open decisions for the Owner. A sentence there labelled **Recommendation** is a recommendation, not a decision.

## 1. Current state

### What hand-back and escalate do for an exception

`handBackWorkItem` (`apps/api/src/lib/pitCrew/responsibility.ts` lines 402–457) and `escalateWorkItem` (lines 474–527) run only while `isPitCrewResponsibilityActionsEnabled` is true (lines 41–48 and 140–144). The flag is `PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED`, literal `"true"` only.

Both functions then call `assertExceptionSource` (lines 146–149). Any `sourceType` other than `EXCEPTION` throws `PitCrewPropertyMismatchError("Work item not found in this brokerage.")`. That throw happens before `loadOwnedOverlay`, so the function does not create an overlay and does not insert `pit_crew_responsibility_events`.

The same guard sits on the follow-on verbs: `acknowledgeEscalation` (line 532), `closeEscalation` used by `resolveEscalation` and `returnEscalation` (line 569), and `reclaimHandedBack` (line 613).

The library test names the rejection with source type `OFFER` (`apps/api/src/lib/pitCrew/__tests__/responsibility.test.ts` lines 502–514). Two route tests name it with `LAUNCH_ITEM`, with both flags set to the literal `"true"`:

- `apps/api/src/routes/__tests__/pitCrewLaunchItemSource.test.ts` lines 396–426. Hand-back returns 404 `{ "error": "Work item not found in this brokerage." }`. The campaign item status and `completed_at` are unchanged. No responsibility event is inserted.
- `apps/api/src/lib/pitCrew/__tests__/launchItemInbox.test.ts` lines 587–660. Hand-back and escalate both return that same 404 and body. Title, status, `cost_cents`, `vendor_name`, and description are unchanged. The event count for that assignment is unchanged.

For an `EXCEPTION` that passes the guard, the allowed assignment statuses are `CLAIMED`, `IN_PROGRESS`, and `WAITING_ON` (`ACTIVE_FROM`, `responsibility.ts` line 138). `PIT_CREW_STATUS_TRANSITIONS` (`apps/api/src/lib/pitCrew/types.ts` lines 41–48) sends those three to `HANDED_BACK` or `ESCALATED`. `UNCLAIMED` and `DONE` have no edge to either. `HANDED_BACK` only goes to `CLAIMED` (reclaim). `ESCALATED` only goes to `IN_PROGRESS` (resolve or return). Acknowledge leaves the assignment on `ESCALATED`. `DONE` is terminal.

Hand-back writes an event with `kind` `HAND_BACK`, `resulting_responsibility` `AGENT`, null severity, and null `expected_response_at`, and sets the assignment to `HANDED_BACK` with `assignedToUserId` and `claimedAt` cleared and the waiting-on columns cleared (`responsibility.ts` lines 426–455). Escalate writes `kind` `ESCALATION`, `resulting_responsibility` `BROKERAGE_ADMINISTRATOR`, a required severity, and sets the assignment to `ESCALATED` with `assignedToUserId` left as the actor (`responsibility.ts` lines 497–525). Neither function writes `risk_exceptions`.

`handoffWorkItem` (`assignment.ts` lines 641–648) is still Pit Crew to Pit Crew. It does not change status and it is not hand-back or escalate.

### Where LAUNCH_ITEM is already accepted

`PIT_CREW_WORK_SOURCE_TYPES` is still `["EXCEPTION"]` (`types.ts` line 14). `LAUNCH_ITEM` is a separate constant (`types.ts` line 17). `assertSourceRecordOnPropertyInBrokerage` (`assignment.ts` lines 220–250) accepts it only when `isPitCrewLaunchItemSourceEnabled` is true (`apps/api/src/lib/pitCrew/launchItemSource.ts` lines 8–15). The flag is `PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED`, literal `"true"` only. Any other value throws the work-item not-found error and does not query `campaign_items`.

When the flag is on, `assertLaunchItemOnPropertyInBrokerage` (`assignment.ts` lines 199–218) requires a UUID `campaign_items` row with that id, the caller's `brokerage_id`, and the request's `property_id`. A miss is the same work-item not-found error. A UUID that exists on another brokerage is noted by `notePitCrewLaunchItemIsolationRejection` (lines 189–197) before that error. The check does not read `status`, `cost_cents`, or `vendor_name`.

`loadOrCreateOverlay` (`assignment.ts` lines 260–286) runs the property-in-brokerage check and then that source check before it touches `pit_crew_assignments`. Claim, assign, start, waiting-on, return, complete, release, and handoff use that loader. Hand-back and escalate do not, because `assertExceptionSource` returns first.

`getPitCrewWorkspace` loads launch items only when the launch flag is on (`queries.ts` lines 409–410). `loadLaunchItemWorkItems` (lines 241–269) keeps rows whose `status` is not `COMPLETE`. Each card is `severity: "INFORMATION"` and `category: "LAUNCH_CAMPAIGN"` (lines 308–309). Relevance is the same rule as exceptions: `responsible_owner_type` is `PIT_CREW` or `UNASSIGNED_QUEUE` (`isPitCrewRelevantOwnerType`, `types.ts` lines 209–211), or the overlay `version` is greater than 0 (`queries.ts` lines 413–417).

### Inbox read versus event write

`listResponsibilityItemsForRecipient` (`queries.ts` lines 589–600) still refuses while the responsibility flag is off. While the launch flag is off it calls `listExceptionResponsibilityInbox` (lines 606–640), which inner-joins `risk_exceptions` and does not mention `campaign_items`. While the launch flag is on, `listResponsibilityInboxIncludingLaunchItems` (lines 702–779) left-joins `campaign_items` on source type `LAUNCH_ITEM`, the item id, the caller's brokerage, and `campaign_items.property_id = pit_crew_responsibility_events.property_id`. A missing item, another brokerage, or a different property drops the row. The title is `campaign_items.title`. `cost_cents` and `vendor_name` are not selected.

That read can display a `LAUNCH_ITEM` event. The app cannot create one. The inbox tests insert the event directly. The comment on the read says so (`queries.ts` lines 586–587).

The workspace lists `handedBack` and `escalated` do not use that launch join. `loadOpenResponsibilityBySourceRecordId` is called with exception overlays only (`queries.ts` lines 350–357). A launch item whose overlay status is `HANDED_BACK` or `ESCALATED` is then dropped by `toResponsibilityWorkItem` when the map has no event (lines 210–216 and 435–444), because the map was never given that assignment. The card also leaves the active buckets: `isActiveWorkspaceStatus` excludes `DONE`, `HANDED_BACK`, and `ESCALATED` (lines 134–136). Opening the write without also loading launch-item overlays into that map would remove the card from the workspace and still leave it eligible for the inbox.

### Page, routes, and flags

`POST /pit-crew/items/:sourceType/:sourceRecordId/hand-back` and `.../escalate` (`apps/api/src/routes/pitCrew.ts` lines 421–422 and 441–442) call `rejectIfResponsibilityActionsDisabled` before zod (lines 118–124). Flag off is 404 `{ "error": "Not found." }` and the handler does not read `pit_crew_responsibility_events`. The eight responsibility routes are locked in `apps/api/src/routes/__tests__/pitCrewResponsibilityFlagOffLock.test.ts` (lines 26–35).

On the Pit Crew page, `showHandBackOrEscalate` is false when `item.sourceType === "LAUNCH_ITEM"` (`apps/web/src/pages/PitCrewCommandCentre.tsx` lines 599–601). `apps/web/src/lib/__tests__/pitCrewLaunchItem.behavior.test.ts` lines 355–359 assert that a campaign-item card has no Hand back or Escalate button and that an exception card still has both. `showReclaim` (line 602) does not look at source type. Reclaim on a launch item would still 404 in `reclaimHandedBack`.

Neither flag is set by this repository's runtime config. `.env.example` leaves `PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED` commented out (lines 244–256). `PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED` is not named there. Both stay off.

### Schema through 0033

`pit_crew_assignments.source_type` and `status` are unconstrained `text` (`packages/db/src/schema/pitCrew.ts` lines 62 and 66). Migration `0006_classy_deathstrike.sql` created them with no `CHECK`. Later migrations through `0033` do not add one.

`pit_crew_responsibility_events` was created in `packages/db/migrations/0032_pit_crew_responsibility_events.sql`. The CHECKs are mirrored on the Drizzle table (`packages/db/src/schema/pitCrew.ts` lines 267–345). They constrain kind, event status, resulting responsibility, exactly one recipient, hand-back shape, escalation shape, non-empty next action and reason, recipient role, acknowledgement, closed columns, and the reason-category lists. They do not mention `source_type`. `0033_pit_crew_responsibility_closing_note.sql` adds nullable `closing_note` and no new `CHECK`.

`campaign_items` (`packages/db/src/schema/launch.ts` lines 165–225) holds `title`, `status` (default `TO_ORGANISE`; vocabulary at line 73: `TO_ORGANISE`, `IN_PROGRESS`, `AWAITING_APPROVAL`, `BLOCKED`, `COMPLETE`), `responsible_owner_type`, `responsible_user_id`, `vendor_name`, and `cost_cents`. `pit_crew_assignments.source_record_id` is text. It is not a foreign key to `campaign_items`. Deleting a campaign item would not cascade into the overlay or the event.

Authoritative campaign-item writes are in `apps/api/src/lib/launch/model.ts`: `updateCampaignItemStatus` (line 494), `assignResponsibility` (line 535), `recordVendorAndCost` (line 554), `attachCampaignItemEvidence` (line 607). `updateCampaignItemStatus` also emits launch events and calls `afterLaunchMutation`, which recomputes plan state. No function in that file deletes a campaign item. The Pit Crew import lock forbids the dangerous writers from `assignment.ts` and `queries.ts` (`apps/api/src/routes/__tests__/support/pitCrewForbiddenSourceWriters.ts` lines 9–18). `responsibility.ts` is not in that scan.

This checkout cannot see the live database. A `CHECK` that exists only there, beyond the journal through `0033`, is unverified.

## 2. Permitted transitions

The proposal uses the edges already in `PIT_CREW_STATUS_TRANSITIONS`. It does not add a status and it does not add an edge.

For a `LAUNCH_ITEM` assignment, hand-back and escalate would be allowed only from `CLAIMED`, `IN_PROGRESS`, and `WAITING_ON`.

| From | Action | Assignment status after | Event |
| --- | --- | --- | --- |
| `CLAIMED`, `IN_PROGRESS`, or `WAITING_ON` | hand-back | `HANDED_BACK` | insert `HAND_BACK`, status `OPEN` |
| `CLAIMED`, `IN_PROGRESS`, or `WAITING_ON` | escalate | `ESCALATED` | insert `ESCALATION`, status `OPEN` |

Not allowed, same as an exception: `UNCLAIMED`, `DONE`, `HANDED_BACK`, or `ESCALATED` as the start of hand-back or escalate. A second open event on the same assignment hits `pit_crew_responsibility_events_one_open_uidx` and `writeEvent` turns that unique violation into `PitCrewTransitionError` (`responsibility.ts` lines 378–381). The route maps that to 422.

Hand-back's assignment patch stays the exception patch: status `HANDED_BACK`, `assignedToUserId` null, `claimedAt` null, waiting-on columns cleared. Escalate's patch stays status `ESCALATED`, `assignedToUserId` set to the actor, waiting-on columns cleared. `completedAt` is not set. `DONE` remains the only completion status, and it remains a different write from hand-back, including when the reason is `WORK_COMPLETE`.

The follow-on edges already exist and stay source-agnostic in the map: reclaim is `HANDED_BACK` to `CLAIMED`; resolve and return are `ESCALATED` to `IN_PROGRESS`; acknowledge does not change the assignment. Whether those four functions accept `LAUNCH_ITEM` is Open decision 1. The map itself does not need a change either way.

`UNCLAIMED` still reaches `CLAIMED` only through claim or assign. That path already accepts `LAUNCH_ITEM` when the launch flag is on, and this proposal does not change it.

## 3. Role and entitlement checks

The proposal mirrors the exception routes. It does not widen `canAccess`.

`canAccess` is `requireRole("Pit Crew", "Brokerage Administrator")` (`routes/pitCrew.ts` lines 75–78, from `PIT_CREW_ROLES` and `BROKERAGE_ADMIN_ROLES` in `apps/api/src/middlewares/auth.ts` lines 18–19). Hand-back, escalate, acknowledge, resolve, return, and reclaim all use that gate plus `requiresRunAccess` (`requireEntitlement("run.access")`). An Agent stays on `requireRole`'s 403 `{ "error": "Forbidden" }` and never reaches the library. A caller without `run.access` gets the existing entitlement 403. The R-F22 test covers both for `LAUNCH_ITEM` and `EXCEPTION` together (`apps/api/src/routes/__tests__/pitCrewLaunchItemSource.test.ts` lines 349–385).

Flag order for a future `LAUNCH_ITEM` hand-back or escalate:

1. Responsibility flag not the literal `"true"`: 404 `{ "error": "Not found." }` before zod and before any read or write of `pit_crew_responsibility_events`. Same as today (`rejectIfResponsibilityActionsDisabled`, and `assertResponsibilityActionsEnabled` if a caller reaches the library).
2. Responsibility flag on, launch flag not the literal `"true"`: `PitCrewPropertyMismatchError("Work item not found in this brokerage.")`, which the route already maps to 404. Do not query `campaign_items`. This matches `assertSourceRecordOnPropertyInBrokerage` when the launch flag is off (`assignment.ts` lines 221–224).
3. Both flags on: the source gate allows `EXCEPTION` and `LAUNCH_ITEM` only. Every other source type, including `AUTOMATION_TASK` and `OFFER`, still throws that work-item not-found error and does not query `campaign_items`.

`GET /pit-crew/responsibility-inbox` keeps `canReadResponsibilityInbox` (`Agent`, `Pit Crew`, `Brokerage Administrator`) plus `run.access`, and still runs the responsibility flag before auth (`routes/pitCrew.ts` lines 76–77 and 186–191). `GET /pit-crew/responsibility-recipients` keeps `canAccess` plus `run.access`. Neither list is redefined for launch items.

The inbox does not take a user id from the query. Brokerage, user, and role come from the session (`listResponsibilityItemsForRecipient`). A launch-item row matches the same way an exception row matches: `recipient_user_id` is the caller, or `recipient_role` equals the caller's role.

`routes/launch.ts` stays without `run.access`. Hand-back and escalate are Pit Crew routes. They do not go through the launch router. The launch route `POST /launch/campaign-items/:itemId/responsibility` calls `assignResponsibility` and is a different action. This proposal does not call it.

No new role is introduced. A Pit Crew user does not become allowed to acknowledge their own escalation unless they are also an active Brokerage Administrator. That rule is `assertEscalationResponder` (`responsibility.ts` lines 303–317) and the page helpers `canAcknowledgeEscalation` and `canResolveOrReturnEscalation` (`apps/web/src/lib/pitCrew.ts` lines 175–198). Whether those helpers run for a launch item depends on Open decision 1 and Open decision 6.

## 4. Brokerage and property validation

Action time re-checks the campaign item. The proposal does that by calling the loader the exception path already uses, after the source gate above, instead of returning inside `assertExceptionSource`.

`loadOwnedOverlay` (`responsibility.ts` lines 258–273) calls `loadOrCreateOverlay` and then rejects a row whose `brokerageId`, `propertyId`, `sourceType`, or `sourceRecordId` disagrees with the request. `loadOrCreateOverlay` proves the property belongs to the caller's brokerage (`assignment.ts` lines 271–278). A miss throws `PitCrewPropertyMismatchError` with the default message `"Property not found in this brokerage."` and the route maps that to 404. It then runs `assertLaunchItemOnPropertyInBrokerage` when the source is `LAUNCH_ITEM` and the launch flag is on.

So a hand-back or escalate, at the moment it runs, requires all of the following:

- the property id on the body belongs to the caller's brokerage;
- `sourceRecordId` is a UUID;
- `campaign_items` has that id on that brokerage and that property;
- the overlay, if one already exists, is that same brokerage, property, source type, and source record.

A campaign item that has been deleted, or whose `property_id` no longer equals the event's property, fails this check with `"Work item not found in this brokerage."` The overlay is not updated and no event is inserted. The same miss on a later reclaim, resolve, or return does the same, if Open decision 1 lets those verbs run.

The existing unique index `pit_crew_assignments_source_unique` is on `(source_type, source_record_id)` only. `loadOrCreateOverlay` loads by that pair (`assignment.ts` lines 288–292). Campaign item ids are UUIDs, so two brokerages do not share an id in practice. This proposal does not change that index. A brokerage column on it is the second-source sequence's later migration, not this design.

The check does not read `cost_cents`, `vendor_name`, `description`, or `responsible_owner_type`. Whether it should also reject `status = 'COMPLETE'` is Open decision 5. The exception path does not re-check exception status, only existence, brokerage, and property.

`expectedVersion` stays the optimistic lock inside `commitResponsibility` (`responsibility.ts` lines 343–348). A stale version throws `PitCrewConcurrencyError` and the route returns 409. The event insert rolls back with it.

## 5. Recipients

Resolution stays `resolveResponsibilityRecipient` (`responsibility.ts` lines 216–256) and the picker stays `listResponsibilityRecipients` (`queries.ts` lines 849–888). Both already refuse while the responsibility flag is off. Neither reads a source record today. The picker returns `userId`, `displayName`, and `role` only. It does not return email.

Order, unchanged from the exception path:

1. An explicit `recipientUserId`, after `assertUserInBrokerage`. Hand-back requires an active `Agent`. Escalation requires an active `Brokerage Administrator`. `explicitResponsibilityRecipientRole` (lines 204–206) is the role both the resolver and the picker use.
2. A routing rule. There is still no `pit_crew_escalation_routing_rules` table. `routingRuleId` stays null.
3. The default. Hand-back loads `properties.agent_id` for the property in the caller's brokerage and requires that user to be an active Agent. Escalation sets `recipient_user_id` null and `recipient_role` `'Brokerage Administrator'`.

Exactly one of `recipient_user_id` and `recipient_role` is set. The `CHECK` `pit_crew_responsibility_events_one_recipient_check` enforces that. `pit_crew_responsibility_events_recipient_role_check` allows null or `'Brokerage Administrator'` only. Hand-back therefore cannot store a role recipient. Escalation cannot store an Agent. The client still does not send a recipient role (`routes/pitCrew.ts` lines 370–372).

A hand-back with no explicit user returns to the property's agent, not to `campaign_items.responsible_user_id`. Using the campaign item's responsible user instead is Open decision 3. An escalation with no explicit user is visible to every active Brokerage Administrator in the brokerage, because the inbox matches `recipient_role` to the caller's role. Requiring a named administrator for launch items is Open decision 4.

The recipient must be in the caller's brokerage. `assertUserInBrokerage` throws `PitCrewAssigneeMismatchError` for a user in another brokerage, and the route maps that to 404 (`routes/pitCrew.ts` lines 97–101). A user in the brokerage with the wrong role, or an inactive user, is `PitCrewResponsibilityValidationError` and the route returns 400 `{ "error": "Invalid request." }` (`routes/pitCrew.ts` lines 111–113).

## 6. Audit events

The proposal reuses `commitResponsibility` (`responsibility.ts` lines 339–369). One transaction inserts or updates the event, updates the assignment on `expectedVersion`, and calls `logAudit` with `strict: true` and a writer bound to that transaction. The route does not write a second audit row (`routes/pitCrew.ts` lines 373–375).

Audit action names stay the ones the exception path already writes:

| Action | Audit `action` | `previousValue` | `updatedValue` |
| --- | --- | --- | --- |
| hand-back | `PC_HANDED_BACK` | assignment status before the write | `HANDED_BACK` |
| escalate | `PC_ESCALATED` | assignment status before the write | `ESCALATED` |
| acknowledge | `PC_ESCALATION_ACKNOWLEDGED` | `OPEN` | `ACKNOWLEDGED` |
| resolve | `PC_ESCALATION_RESOLVED` | `ESCALATED` | `IN_PROGRESS` |
| return | `PC_ESCALATION_RETURNED` | `ESCALATED` | `IN_PROGRESS` |
| reclaim | `PC_RECLAIMED` | `HANDED_BACK` | `CLAIMED` |

Acknowledge, resolve, return, and reclaim are written only if Open decision 1 includes those verbs. The columns are `AuditLogInput` (`apps/api/src/lib/audit.ts` lines 4–15):

- `brokerageId`: the caller's brokerage. Responsibility audits set this. `applyTransition` in `assignment.ts` (lines 350–359) still omits it. This proposal does not change that older path.
- `userId` and `userEmail`: the actor.
- `action`: the code in the table above.
- `recordType`: the source type string. For this work item that is `LAUNCH_ITEM`. The exception test expects `EXCEPTION` (`responsibility.test.ts` lines 410–415). The same field distinguishes the source. No new action code is required for that.
- `recordId`: the campaign item UUID (`sourceRecordId`).
- `propertyId`: the property on the request, already checked against the brokerage and the campaign item.
- `previousValue` and `updatedValue`: the status pair in the table. They are not a title, a note, or an amount.
- `providerReference`: set only on resolve and return, as `JSON.stringify({ closingNote })` (`responsibility.ts` lines 326–328 and 588). The closing note is also stored on `closing_note`. Hand-back and escalate leave `providerReference` unset.

The event row itself stores `reason_category`, `severity` (null on hand-back), `note`, `next_action`, `originating_user_id`, `recipient_user_id`, `recipient_role`, `resulting_responsibility`, `expected_response_at` (null on hand-back), and `status`. Those fields are already the exception payload. None of them is `cost_cents`, `vendor_name`, `budget_cents`, or an approval amount. The implementation must not copy those campaign-item columns into `note`, `next_action`, `title`, or the audit values.

`TIMELINE_ENTRY_TYPES` in `apps/api/src/lib/timeline.ts` does not contain `PC_HANDED_BACK`, `PC_ESCALATED`, or the other `PC_*` responsibility codes. Existing responsibility audits are stored and are not timeline entries. This proposal does not add them. Whether they should appear on the property timeline is still the original hand-back design's open question 5 (`docs/design/PIT_CREW_HANDBACK_ESCALATE_DESIGN.md`). It is not decided here.

`logAudit` for these actions does not emit a domain event. The exception responsibility test asserts the message, payment, outbox, and domain-event sets are unchanged (`responsibility.test.ts` lines 380–386). A launch-item implementation has to keep that, and has to keep from emitting `CAMPAIGN_ITEM_STATUS_CHANGED`, `CAMPAIGN_ITEM_COMPLETED`, or `CAMPAIGN_ITEM_BLOCKED`. Those names are emitted by `updateCampaignItemStatus` (`launch/model.ts` lines 522–527).

## 7. Resulting responsibility

The event `CHECK`s already fix the words. `pit_crew_responsibility_events_hand_back_shape_check` requires `resulting_responsibility = 'AGENT'` on a hand-back. `pit_crew_responsibility_events_escalation_shape_check` requires `resulting_responsibility = 'BROKERAGE_ADMINISTRATOR'` on an escalation (`0032` lines 27–38; schema `pitCrew.ts` lines 283–299). A launch item uses those same two values. A third value would fail the `CHECK`. This proposal does not add one.

Who holds the work after each action:

- After hand-back, the open event says `AGENT`. The recipient is the named Agent from section 5. The assignment is `HANDED_BACK`, with no `assignedToUserId`. It leaves `myWork`, `teamWork`, `waitingOn`, and `launchCoordination`, because those lists use `isActiveWorkspaceStatus`. `getPitCrewTeam` counts only `CLAIMED`, `IN_PROGRESS`, and `WAITING_ON` (`queries.ts` lines 483–490), so the item drops out of `activeItemCount`. The campaign item's `responsible_owner_type` and `responsible_user_id` are not written. Pit Crew's overlay no longer says a Pit Crew user is assigned. The Agent sees the row in `GET /pit-crew/responsibility-inbox` when the launch flag is on, titled with `campaign_items.title`.
- After escalate, the open event says `BROKERAGE_ADMINISTRATOR`. The recipient is the named administrator, or the role when no user was sent. The assignment is `ESCALATED` and `assignedToUserId` remains the Pit Crew actor, matching the exception path so resolve and return still have that user on the row. The item leaves the active workspace buckets and the team count. Brokerage Administrators see it in the inbox under the same recipient rule as an exception escalation.
- Acknowledge, if Open decision 1 includes it, leaves the assignment `ESCALATED` and sets the event to `ACKNOWLEDGED`. Resulting responsibility stays `BROKERAGE_ADMINISTRATOR`.
- Resolve and return, if included, move the assignment to `IN_PROGRESS` and close the event as `RESOLVED` or `RETURNED`. The overlay assignee stays the originating Pit Crew user. The item can re-enter the active buckets. The campaign item is still not updated.
- Reclaim, if included, moves `HANDED_BACK` to `CLAIMED`, sets `assignedToUserId` to the reclaiming user, and sets the event to `SUPERSEDED`. Resulting responsibility on the closed event stays `AGENT`, which the hand-back shape `CHECK` allows for `SUPERSEDED`.

For the workspace `handedBack` and `escalated` arrays to show the card, `loadOpenResponsibilityBySourceRecordId` has to be given the launch-item overlay rows as well as the exception rows, and only when the launch flag is already on (that is the only time `loadLaunchItemWorkItems` runs). The map today keys by `sourceRecordId` alone (line 179). Launch item ids and exception ids are UUIDs from different tables. The implementation should key by source type and id before both sets share one map, so an event cannot attach to the other source. That is a correctness constraint on the read, not a new product status.

The inbox path already joins a launch item when both flags are on and the campaign item still matches brokerage and property. No new inbox query is required for the title. The workspace join above is required, or the card disappears from `/pit-crew` while the inbox still has it.

`campaign_items.responsible_owner_type` remains whatever Launch last stored. Hand-back does not mean "Launch now says the owner is the agent." That would be `assignResponsibility`, which this proposal does not call.

## 8. Source-state behaviour

The campaign item is unchanged by hand-back, escalate, acknowledge, resolve, return, and reclaim.

Unchanged columns include `status`, `completed_at`, `blocked_at`, `blocked_reason`, `responsible_owner_type`, `responsible_user_id`, `title`, `description`, `vendor_name`, `cost_cents`, `cost_approval_required`, `cost_approved_at`, `due_at`, and `evidence`. The parent `launch_plans` row is unchanged: no budget recalculation, no market-ready evaluation, no plan status change, no portal write, no listing-live write.

The forbidden calls are the ones the import lock already names, plus the other campaign-item writers in `launch/model.ts`: `updateCampaignItemStatus`, `assignResponsibility`, `recordVendorAndCost`, `attachCampaignItemEvidence`, `confirmLaunchLive`, `decideVendorApproval`. Also still forbidden, because they are not launch-item writers but they are the same safety list: `completeAutomationTask`, `resolveCondition`, `maybeRecordUnconditional`, `acceptOffer`, `completeSettlement`. A future change to `responsibility.ts` has to stay off that list. The lock today scans only `assignment.ts` and `queries.ts`, so the test plan extends the scan.

`DONE` stays overlay-only. This proposal does not change `completeWorkItem`.

What the current reads do if the campaign item changes while an event is open, assuming the write has been allowed and no new status rule is added (Open decision 5 is the choice to add one):

- Title, description, vendor, or cost edits. The next inbox read returns the new `campaign_items.title`. Cost and vendor are still not selected. The event text (`note`, `next_action`) is whatever was stored at insert and is not rewritten from the campaign item.
- Status moves to `COMPLETE`, including through `updateCampaignItemStatus`. `loadLaunchItemWorkItems` drops the row (`queries.ts` lines 241–244 and 269), so the workspace card goes away even if the overlay is `HANDED_BACK` or `ESCALATED`. The inbox join does not filter `campaign_items.status`, so the recipient can still see the row while the item exists and the property matches. The next hand-back, escalate, or follow-on action still passes `assertLaunchItemOnPropertyInBrokerage`, because that function does not read status. The event stays `OPEN` or `ACKNOWLEDGED` until a person closes it. Nothing in this proposal supersedes it automatically.
- Status moves to `BLOCKED`, `AWAITING_APPROVAL`, `IN_PROGRESS`, or `TO_ORGANISE`. The workspace can still show the item, because only `COMPLETE` is excluded. The inbox can still show it. The action-time check still passes.
- `property_id` changes, or the row is deleted. The inbox drops it, same as R-F25 for a property mismatch and same as a missing exception for a delete. The next action throws the work-item not-found 404 and does not update the overlay or the event. There is no foreign key from the assignment or the event to `campaign_items`, so the overlay and the open event remain. No Launch function surveyed here deletes a campaign item. Absence is still the outcome the reads and the tenant check already implement.
- A new campaign item is not created, and the launch plan is not cancelled, paused, or confirmed live, by these actions.

The proposal does not add a hook inside `updateCampaignItemStatus`. That function is Grow-adjacent Launch code and is on the forbidden list. Closing the Pit Crew event from that function would couple the two writes.

## 9. What remains prohibited

- Writing `campaign_items` or `launch_plans` from any Pit Crew responsibility function, including `DONE`.
- Calling the source writers named in section 8.
- Sending a communication, moving funds, changing a transaction or legal status, or bypassing an approval. The exception responsibility test's "no message, payment, outbox, or domain event" bar applies to `LAUNCH_ITEM` as well.
- Hand-back or escalate for any source other than `EXCEPTION` and, when the launch flag is the literal `"true"`, `LAUNCH_ITEM`. `AUTOMATION_TASK`, `OFFER`, `WORKFLOW_ACTION`, `CONTRACT_MILESTONE`, and any other string stay on the work-item 404.
- Hand-back or escalate from `UNCLAIMED`, `DONE`, `HANDED_BACK`, or `ESCALATED`.
- A hand-back recipient who is not an active Agent in the brokerage, and an escalation recipient who is not an active Brokerage Administrator or the Brokerage Administrator role.
- `expected_response_at` or a non-null severity on a hand-back. An escalation without a severity in `ATTENTION`, `AT_RISK`, `CRITICAL`. `INFORMATION` is the workspace card severity only. It is not a legal event severity (`pit_crew_responsibility_events_escalation_shape_check`).
- Copying `cost_cents`, `vendor_name`, budget, or approval amounts into the inbox title, the event note, the next action, or the audit payload.
- Changing the workspace mapping away from severity `INFORMATION` and category `LAUNCH_CAMPAIGN`.
- Setting either flag. Adding `run.access` to `routes/launch.ts`. Editing `apps/api/src/lib/commandCentre/**`, `apps/web/src/lib/commandCentre.ts`, `apps/web/src/pages/CommandCentre.tsx`, `apps/web/src/lib/todaySurfaces.ts`, `apps/api/src/lib/grow/**`, `apps/api/src/lib/communications/**`, `apps/api/src/lib/propertyIntelligence/**`, or `docs/AE_GROW_*`.
- Placing the inbox on `/today`.
- Adding `pit_crew_escalation_routing_rules` or `routing_rule_id`.
- A `CHECK` on `pit_crew_assignments.source_type` or `status`. That is the second-source sequence item 4, called out in section 10.
- Changing `listExceptionResponsibilityInbox`. Its exception join still does not compare `risk_exceptions.property_id` to the event. The flag-on exception join does. Closing that gap is a separate Owner follow-up. This proposal does not do it.
- A scheduler that pages someone or changes status when `expected_response_at` passes. The exception design left that out of v1. This proposal leaves it out as well.

## 10. Dependencies and gates

A future implementation that stays inside the choices recommended below is code-only. It does not need a migration. `pit_crew_responsibility_events` already accepts a hand-back or escalation whose assignment happens to be `LAUNCH_ITEM`, because the 0032 CHECKs do not mention `source_type`. `HANDED_BACK` and `ESCALATED` are already legal application statuses. `source_type` and `status` on `pit_crew_assignments` have no database `CHECK`, so writing `LAUNCH_ITEM` there does not need one. `0033` already added `closing_note`.

What would need a migration, and is not part of this proposal:

- A new reason category, a new event severity, or a new `resulting_responsibility`. Those are `CHECK` changes on `pit_crew_responsibility_events_reason_category_check`, `pit_crew_responsibility_events_escalation_shape_check`, or `pit_crew_responsibility_events_resulting_responsibility_check`.
- A `CHECK` that limits `pit_crew_assignments.source_type`, or a brokerage column on `pit_crew_assignments_source_unique`. The second-source design's sequence item 4 is that migration ("Not scheduled with the three above"). It stays Owner-gated. It waits until the pause on new migrations ends, and until someone can count unexpected `source_type` values. This document does not authorise it and does not write the SQL.
- Any live database `CHECK` that is not in the journal. This checkout cannot see that database. Verification of live constraints beyond migration `0033` is Owner-gated. The code-only claim is wrong if that database has a constraint this repo does not contain. Someone with database access has to confirm that before either flag is turned on. This proposal does not perform that confirmation.

Both flags stay unset. A later implementation leaves the default off: missing, empty, `"false"`, `"TRUE"`, `"1"`, and `"yes"` all stay off. Enabling `PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED` on a persistent environment remains an Owner/ops step after migrations `0032` and `0033` are applied there. Enabling `PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED` remains an Owner/ops step after the live-constraint confirmation above. Turning a flag on is not a migration and is not something this document does.

No Replit step follows from this document. There is nothing to apply.

The responsibility flag-off lock stays on all eight existing routes. A `LAUNCH_ITEM` hand-back while the responsibility flag is off is 404 `{ "error": "Not found." }` and does not read or write `pit_crew_responsibility_events`. While the launch flag is off, the same request does not read or write `campaign_items`.

## 11. Test plan for a future implementation

Described here. Not written in this change.

Flag matrix, responsibility flag and launch flag each unset, empty, `"false"`, `"TRUE"`, `"1"`, and the literal `"true"`:

- Responsibility flag not `"true"`: `POST .../LAUNCH_ITEM/:id/hand-back` and `.../escalate` return 404 `{ "error": "Not found." }` for an authenticated Brokerage Administrator with `run.access`, before zod. A query observer shows no `pit_crew_responsibility_events`. The existing eight-route lock still passes. `campaign_items` is not written.
- Responsibility flag `"true"`, launch flag not `"true"`: both posts return 404 `{ "error": "Work item not found in this brokerage." }`. The observer shows no `campaign_items` read or write and no event insert. `OFFER` and `AUTOMATION_TASK` still do the same.
- Both literal `"true"`: the cases below.

Happy path, both flags on, campaign item UUID on the caller's property and brokerage, overlay in `CLAIMED`, `IN_PROGRESS`, and `WAITING_ON`:

- Hand-back inserts one `HAND_BACK` event (`OPEN`, `resulting_responsibility` `AGENT`, null severity, null `expected_response_at`, recipient the explicit Agent or `properties.agent_id`). Assignment becomes `HANDED_BACK`, assignee and waiting-on cleared, version incremented. One `PC_HANDED_BACK` audit with `brokerageId`, `recordType` `LAUNCH_ITEM`, `recordId` the campaign item id, `previousValue` the prior status, `updatedValue` `HANDED_BACK`. No `providerReference` amount. No money field in the event row.
- Escalate inserts one `ESCALATION` (`OPEN`, `resulting_responsibility` `BROKERAGE_ADMINISTRATOR`). `AT_RISK` and `CRITICAL` require `expectedResponseAt`. `ATTENTION` may omit it. Assignment becomes `ESCALATED` with `assignedToUserId` the actor. Audit `PC_ESCALATED` with the same identity fields.
- Snapshot `campaign_items` before and after, including `status`, `completed_at`, `cost_cents`, `vendor_name`, `title`, `description`, `responsible_owner_type`, and `responsible_user_id`. Assert equal. Also assert no new `launch_plans` mutation and no campaign-item domain event.
- Inbox, launch flag on: the recipient sees `sourceType` `LAUNCH_ITEM` and `title` equal to `campaign_items.title`. A Brokerage Administrator and an Agent both get that title. `cost_cents` and `vendor_name` do not appear in the JSON. Launch flag off: that row is absent and `campaign_items` is not queried.
- Workspace, both flags on: the item leaves the active lists and appears on `handedBack` or `escalated` with the open event joined. Team `activeItemCount` no longer includes it.
- Property mismatch, other brokerage, deleted id, and a non-UUID id: 404 work-item not found, no event, campaign item unchanged when it still exists. A UUID on another brokerage still goes through `notePitCrewLaunchItemIsolationRejection`.
- Stale `expectedVersion`: 409, no event left behind.
- `UNCLAIMED` and `DONE`: 422, no event.
- Agent role: 403 from the role gate. Missing `run.access`: 403 entitlement. Exception hand-back and escalate tests stay green and still reject a non-exception source other than the newly allowed `LAUNCH_ITEM`.

Follow Open decision 1 in the tests. If the four follow-on verbs are included, mirror the exception tests for acknowledge, resolve, return, and reclaim, and assert the campaign item snapshot again. If they are excluded, those four posts stay on the work-item 404 and insert nothing.

Follow Open decision 5 in the tests. If `COMPLETE` is rejected, a completed campaign item returns the work-item 404 and is absent from the inbox. If it is not, the action succeeds and the inbox still returns the title.

Extend `assertPitCrewModulesDoNotReferenceSourceWriters` so `responsibility.ts` is scanned for the same forbidden names. While the launch flag is off, the responsibility functions still must not reference `campaign_items`.

Web, only if Open decision 6 includes the page: the launch-item behaviour test that today requires the Hand back and Escalate buttons to be absent is updated so those buttons render on `CLAIMED`, `IN_PROGRESS`, and `WAITING_ON` when the responsibility probe is on, and the posts go to `/api/pit-crew/items/LAUNCH_ITEM/:id/hand-back` and `.../escalate`. Exception cards stay as they are. The page still does not call `/launch` and still does not render cost or vendor. If the page stays out of the implementation, that test stays as it is.

Do not add a migration test. Do not set either flag in `.env.example` beyond a comment if a later PR already comments the responsibility flag. Do not enable either flag in CI.

## 12. Open decisions for the Owner

Implementation should not start until the Owner has accepted or replaced each recommendation. The rest of this document describes the shape that stays inside the current state machine, the current CHECKs, and the current recipient function. These six points are the choices that shape does not settle.

### 1. Which verbs accept LAUNCH_ITEM

**Options**

- A. `handBackWorkItem` and `escalateWorkItem` only. `acknowledgeEscalation`, `resolveEscalation`, `returnEscalation`, and `reclaimHandedBack` keep `assertExceptionSource` and keep rejecting `LAUNCH_ITEM`.
- B. All six functions accept `LAUNCH_ITEM` under the same two-flag gate as section 3.

**Trade-offs**

- A matches a narrow reading of decision 6. An event can be opened and cannot be acknowledged, resolved, returned, or reclaimed through the app. `pit_crew_responsibility_events_one_open_uidx` then blocks a second open event on that assignment. The page already shows Reclaim on every `HANDED_BACK` card, with no source-type exclusion (`PitCrewCommandCentre.tsx` line 602). That button would 404.
- B lets a launch-item event finish the same way an exception event finishes. More functions change. Exception behaviour is unchanged. The state machine already has the edges.

**Recommendation:** B.

### 2. Reason categories and escalation severity

**Options**

- A. Reuse `PIT_CREW_HAND_BACK_REASON_CATEGORIES` (`WORK_COMPLETE`, `NEXT_ACTION_WITH_AGENT`, `INFORMATION_RETURNED`, `NOT_PIT_CREW_WORK`) and `PIT_CREW_ESCALATION_REASON_CATEGORIES` (`BLOCKED_DEPENDENCY`, `OVERDUE_THIRD_PARTY`, `SETTLEMENT_OR_COMPLIANCE_RISK`, `MISSING_AUTHORITY`, `MISSING_INFORMATION`, `OTHER_MATERIAL_EXCEPTION`). Escalation severity stays `ATTENTION`, `AT_RISK`, `CRITICAL`. No `CHECK` change.
- B. Add or drop values for launch items, or allow `INFORMATION` as an event severity. That alters `pit_crew_responsibility_events_reason_category_check` and possibly `pit_crew_responsibility_events_escalation_shape_check`.

**Trade-offs**

- A needs no migration. `SETTLEMENT_OR_COMPLIANCE_RISK` and `OTHER_MATERIAL_EXCEPTION` are exception-flavoured words on a campaign item. The workspace card stays severity `INFORMATION`. Event severity is a different column, and the hand-back shape `CHECK` requires it to be null on a hand-back.
- B can name launch work more closely. It is a migration. Sequence item 4's source-type `CHECK`, and live constraint verification beyond `0033`, stay Owner-gated either way. This document does not authorise the migration.

**Recommendation:** A.

### 3. Default hand-back recipient

**Options**

- A. Keep `resolveResponsibilityRecipient`. An explicit user must be an active Agent. When omitted, the recipient is `properties.agent_id`, who must be an active Agent in the brokerage.
- B. When omitted, use `campaign_items.responsible_user_id` if that user is an active Agent, otherwise `properties.agent_id`.
- C. When omitted, use only `campaign_items.responsible_user_id`, and reject the hand-back if that user is missing or is not an active Agent.

**Trade-offs**

- A is one function for both sources. It does not read the campaign item's owner. Rows Pit Crew sees are often `responsible_owner_type` `PIT_CREW` or `UNASSIGNED_QUEUE`. Those owners are not the Agent the hand-back is for. The `CHECK` still requires `resulting_responsibility` `AGENT`.
- B returns the item to the agent already named on the campaign item when that person is an Agent, and falls through when the responsible user is Pit Crew or unset. It is a second lookup and a second definition of "default".
- C fails for the rows the relevance rule actually puts on the board, because those responsible users are often not Agents.

**Recommendation:** A.

### 4. Escalation with no named user

**Options**

- A. Keep the current default. No `recipientUserId` stores `recipient_role` `'Brokerage Administrator'` and a null user id. Every active Brokerage Administrator in the brokerage sees the inbox row.
- B. A `LAUNCH_ITEM` escalation requires `recipientUserId`. The role default stays available for `EXCEPTION` only.

**Trade-offs**

- A is one resolver. The `CHECK` already allows a role recipient. Several administrators all see the row. There is no single assignee. The exception design's open question 2 shipped this fan-in.
- B gives a launch escalation one person. The zod schema would diverge by source type. Omitting the id would be 400 for a launch item and would still succeed for an exception.

**Recommendation:** A.

### 5. Campaign item status while the event is open

**Options**

- A. Action time re-checks existence, brokerage, and property only, which is what `assertLaunchItemOnPropertyInBrokerage` does now. `COMPLETE` still passes. Nothing automatically supersedes an open event if the item is later completed, deleted, or moved.
- B. Action time also rejects `status = 'COMPLETE'` with the work-item not-found 404, and the flag-on inbox excludes a `COMPLETE` campaign item the way it excludes a missing one. `BLOCKED` and the other non-complete statuses still pass. Nothing automatically supersedes.
- C. A later job or a hook in `updateCampaignItemStatus` supersedes the event and moves the overlay when the item is completed, deleted, or moved to another property.

**Trade-offs**

- A matches the exception path, which does not re-check source status. A completed campaign item already disappears from `getPitCrewWorkspace` and can remain in the inbox, because the inbox join does not filter `campaign_items.status`. A delete or a property change already drops the inbox row and 404s the next action. The open event remains until a person closes it.
- B makes the inbox and the workspace agree that a finished campaign item is not still an open responsibility. It is a predicate in the flag-on read and in the action. It is not a migration. It does not call a launch writer.
- C closes the event with no person. It needs a scheduler or a call into the launch writer this proposal forbids. That is the easiest way to mutate the campaign item by accident.

**Recommendation:** B. Do not auto-supersede. Do not treat `BLOCKED` as finished.

### 6. Whether the Pit Crew page changes in the same implementation

**Options**

- A. API only. `showHandBackOrEscalate` keeps `item.sourceType !== "LAUNCH_ITEM"`. The buttons stay hidden. The inbox and the posts can still work.
- B. The same implementation removes that exclusion, so Hand back and Escalate render on a `LAUNCH_ITEM` card when the responsibility signal is on and the status is `CLAIMED`, `IN_PROGRESS`, or `WAITING_ON`. Reclaim, acknowledge, resolve, and return follow Open decision 1. The page still does not call `/launch`.

**Trade-offs**

- A is smaller and matches the API-only boundary of R-F22, R-F24, and R-F25. The action is invisible on `/pit-crew` until a later web slice. `pitCrewLaunchItem.behavior.test.ts` lines 355–359 stay true.
- B is what an operator would need in order to use the action from the board. It edits `PitCrewCommandCentre.tsx` and that test. It does not edit Command Centre, `todaySurfaces.ts`, or `/today`.

**Recommendation:** B, together with Open decision 1 option B. If the Owner wants the first implementation to stay API-only, choose A and leave the page test unchanged.
