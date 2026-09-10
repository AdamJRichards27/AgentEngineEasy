# AE GROW — Priority 2 — Contact Intelligence & Relationship Timeline

Completion report. Branch: `feat/ae-grow-priority-2-contact-intelligence`. Base:
`feat/ae-grow-priority-1-daily-command-centre` (SHA `d5691b65adca01dc34a7b347e6f7367509479300`),
later retargeted to `staging` for the actual merge (Phase 4, §19 item 16/17 below).
Pull request: [#30](https://github.com/AdamJRichards27/AgentEngineEasy/pull/30) — **merged**
into `staging` via merge commit `1a55bbc3c875a0f6b3245ce8f004ee42704f8117`.
Final status: **`COMPLETE — MERGED TO STAGING`** (§19 item 17).

---

> **Status update (this CI Stabilisation Gate).** The decision in §1 above (`REMEDIATION REQUIRED`) was accurate when it was written: the `privacy.test.ts` hang blocking CI from ever finishing was still unfixed. A separate, narrowly-scoped Project Owner mandate ("AE GROW — PRIORITY 2 CI STABILISATION GATE") subsequently authorized fixing exactly that class of problem — the test suite's own reliability — without touching Priority 2's feature scope or starting Priority 3. That work is recorded below in §19 and **supersedes §1's decision.** Sections 1–18 above are left untouched as the historical record of Priority 2's feature-complete state at the point the gate began.


## 1. Decision

**REMEDIATION REQUIRED.**

Every Priority 2 concept in the authorizing spec (§1-§21) is implemented — schema, API, Relationship Timeline, Contact Intelligence Summary, Contact 360 UI, and Priority 1 integration — and is covered by a route-level automated test suite that was written honestly against this priority's own acceptance criteria, including a real, previously-undetected bug that the tests caught and this work then fixed (§16 below).

The two blockers this report tracked in earlier passes are now resolved and CI-verified, not just locally reasoned about: the missing `0014` migration snapshot has been regenerated and the schema drift check now passes cleanly in real GitHub Actions CI (PR #30, run #197, commit `1fa22c7`), and the `contacts.test.ts` assertion bug is fixed and confirmed passing. Both changes are committed and pushed to `feat/ae-grow-priority-2-contact-intelligence` — nothing is sitting outside the repository waiting on a maintainer with push access anymore.

The reason this is not `COMPLETE — READY FOR GROW PRIORITY 3` is a third, separate blocker that only surfaced once CI actually ran past the drift check for the first time: a pre-existing defect in `privacy.test.ts`, unrelated to Priority 2, hangs the "API automated test suite" CI step indefinitely after its own 4 tests pass, because its teardown (`after`) hook throws on a `DELETE FROM brokerages` query and the process never exits afterward. In CI this consumed the entire 6-hour GitHub Actions job cap before the run was force-cancelled, meaning the API test suite step, both production-build steps, and the synthetic-startup check have never actually completed in CI on this branch — even though all three are independently verified passing locally. This is diagnosed in full in §16 and §17, is out of Priority 2's scope to fix unilaterally, and needs a Project Owner decision before this priority can be closed out.

## 2. Entry Gate Findings

Confirmed at the start of this priority, before any code was written:

- Priority 1 (`feat/ae-grow-priority-1-daily-command-centre`) was present on the branch this
  work was built from, matching its own completion report: `GET /grow/today` exists, Grow Today
  is the default Grow workspace tab, and the three pre-existing Grow entities
  (`growRelationships`, `growActivities`, `growOpportunities`) were exactly as documented.
- No canonical Contact/Person entity exists separately from the AE-wide `parties` table
  (`packages/db/src/schema/property.ts`) — `parties` is already the identity record RUN's
  `propertyParties` and Grow's own `growRelationships` both key off of via `partyId`. This is
  the critical architecture fact the spec's §1 flagged, and it drove every decision in §3–§6
  below: Priority 2 adds relationship/intelligence tables that reference `parties`, and never a
  second contact database.
- `growRelationships` already satisfies most of §6 (Contact↔Property relationships: type,
  `validFrom`/`validTo`, status, `sourceType`/`sourceId`/`sourceEvidence`) once queried by
  `partyId` instead of `propertyId` — confirmed by reading `packages/db/src/schema/grow.ts` in
  full before writing anything new.
- `growActivities` already covers free-text notes (`activityType: "note"`) and general activity
  logging — confirmed before deciding Priority 2 needed no new "notes" table (§8).
- The Voice interface remains the disabled placeholder Priority 1 shipped; no Opportunity Score
  engine exists anywhere in the codebase; the pre-existing, documented `privacy.test.ts`
  failure/hang was independently re-inspected this priority (see §17) and is unrelated by every
  code-path check available.

## 3. Objective & Scope

Objective, as authorized: build the Contact Intelligence / Contact 360 foundation — backend
**and** the user-facing UI — so AE can answer, in one place, who a person is, what properties
they're connected to, the relationship, the history, the commitments/activities/opportunities
attached to them, and what AE should know when assisting. This is explicitly Grow's
"relationship memory," not predictive of sale likelihood.

Scope was held strictly to Priority 2. Not built, touched, or scaffolded beyond a documented
forward-compatible contract: Communications Hub (Priority 3), Appraisal Builder (Priority 4),
external property-data provider integrations, Selling Signal / AI Opportunity Score, Voice/STT,
or automated nurture. Where the spec required a **contract** for a future priority to plug into
(§13, §14 below), that contract's shape was defined and left unpopulated — never implemented.

## 4. Contact 360 Model

No new canonical identity table. Contact 360 (`GET /grow/contacts/:partyId`) reads the existing
`parties` row directly for identity fields (`partyType`, `firstName`/`middleName`/`lastName`,
`organisationName`, `displayName` derived the same way Priority 1's `growToday.ts` already
derives contact names, `email`, `mobile`, `residentialAddress`, `createdAt`/`updatedAt`) and
layers Grow-specific structure on top via `partyId`-keyed joins — never a duplicate identity
record. `assignedAgentUserId` is deliberately **derived**, not stored: `parties` has no
owner/assigned-agent column, and adding one for something this deterministic to compute (the
most recent property relationship's `createdBy`, falling back to the most recent opportunity's
`ownerUserId`) would have meant modifying the canonical table for a Priority-2-only concern.

## 5. Relationship Classification / Roles

`grow_contact_roles` (`packages/db/src/schema/contacts.ts`): a structured, **multi-valued** set
of 13 roles (`Prospect`, `PastClient`, `CurrentClient`, `Seller`, `Buyer`, `Landlord`, `Tenant`,
`Investor`, `PropertyOwner`, `AppraisalProspect`, `ReferralSource`, `ProfessionalPartner`,
`Other`) — a party can hold several simultaneously (e.g. `CurrentClient` + `ReferralSource` +
`Landlord` all at once), enforced only by a unique index on `(partyId, role)` so the same role
can't be double-assigned, with no exclusivity constraint between different roles. This was a
deliberate rejection of a single mutually-exclusive status column, per §4's explicit
requirement. `POST /grow/contacts/:partyId/roles` and `DELETE
/grow/contacts/:partyId/roles/:role` assign/remove roles one at a time; re-assigning an
already-held role is a no-op (200, not an error). The Grow UI (§12) surfaces every role as a
clickable pill on the Contact 360 header, so an agent sees and edits the full set at a glance.

## 6. Household / Person-to-Person Relationships

`grow_contact_relationships`: directional storage (`partyId` → `relatedPartyId`) over 6
relationship types (`spouse_partner`, `family`, `co_owner`, `business_partner`,
`related_contact`, `other`), with application-layer dedup checked in **both** directions before
insert (`POST /grow/contacts/:partyId/relationships`) — "A is related_contact of B" and "B is
related_contact of A" are treated as the same fact and collapse onto one stored row. Every row
is created by an explicit agent action; nothing in this priority infers, suggests, or
auto-populates a household relationship from any other data (no name-matching, no
same-address inference, nothing). Records the relationship without ever merging the two
`parties` rows — deleting a relationship (`DELETE /grow/contacts/relationships/:id`) affects
only that join row.

**Bug found and fixed during this priority's own test-writing** (not a pre-existing defect):
`GET /grow/contacts/:partyId` originally queried this table by `partyId` alone. Because the
relationship is symmetric but stored as one directed row, whichever contact was **not** the
`partyId` column at creation time never saw the relationship on their own Contact 360 page —
directly contradicting the "understand this relationship in seconds" UX goal. Fixed (commit
`82710d8`) to query both directions and resolve display info for whichever side is "the other
party" relative to the contact being viewed; a dedicated regression test
(`contacts.test.ts`) asserts both sides of a relationship now see it correctly.

## 7. Contact ↔ Property Relationships

No second Grow property source of truth, per §6's explicit instruction. `growRelationships`
(Priority 1's own table) already carries everything needed — relationship type, role, status,
`isPrimary`, `validFrom`/`validTo`, source metadata — and is reused as-is, simply queried by
`partyId` instead of `propertyId` for Contact 360's "Properties" section. Existing
`POST`/`PATCH /grow/relationships` (Priority 1's routes, untouched) remain the only way to
create or update a contact↔property relationship; this priority adds only a `partyId`-scoped
**read** over that same table. The architecture is explicitly ready for future property-data
enrichment (an external provider populating additional fields on a relationship or on
`properties` itself) but — per the spec's explicit instruction — no such provider is integrated
now, and nothing here assumes one exists.

## 8. Relationship Timeline

`apps/api/src/lib/relationshipTimeline.ts` — `getRelationshipTimeline(brokerageId, partyId,
limit)`. Deliberately built as a **direct per-table query plus in-memory merge, not a join**:
querying `growRelationships`, `growActivities`, `growOpportunities`, and `growCommitments`
independently and merging in application code means each source row contributes a small, fixed
number of well-defined events, never a multiplied cross-product — the exact failure mode (a
join across 4 tables multiplying rows) that §16's "no join-caused duplicates" requirement rules
out. A dedicated test creates 3 relationships + 2 activities + 1 opportunity + 1 commitment for
one contact and asserts an **exact** event count with unique event ids, which is the direct
proof.

Deterministic tenant isolation is enforced as a second line of defence inside the function
itself (it refuses to produce events for a party that doesn't belong to the given
`brokerageId`), even though every caller already validates this before invoking it. Events sort
newest-first (`localeCompare` on ISO timestamps), matching every other "what's recent" surface
in Grow. A `*_UPDATED` event is only emitted when a row's `updatedAt` is meaningfully later than
its `createdAt` (a 2-second threshold) — otherwise every row would emit a spurious same-instant
duplicate pair, since `createdAt`/`updatedAt` default to the same `now()` on insert.

The event-type contract (`GROW_TIMELINE_EVENT_TYPES`) establishes the full set of communications
event types now (§13) — see §14 for exactly what is and is not populated.

## 9. Notes / Activities / Commitments

No duplicate task system. Notes and general activity logging continue to use the existing
`growActivities` table and its existing write path (`POST /grow/activities`, unchanged) — Grow
Today's "Add note" button and Contact 360's activity feed both read/write the same table.

`grow_commitments` is genuinely new: a future-dated promise ("call next month," "prepare
appraisal") that has no existing home. `automationTasks` (the RUN automation engine's task
table) was considered and rejected as a base, because it requires a non-null `propertyId` and
carries execution lineage (attempt counts, handler wiring) that doesn't fit a person-first,
property-optional commitment. A commitment is person-first (`partyId` required,
`propertyId`/`opportunityId` optional context), and completing or cancelling one
(`PATCH /grow/contacts/commitments/:id`) is the only mutation. Completion additionally inserts a
`growActivities` row (`activityType: "task_completion"`, a type Priority 1 already reserved for
exactly this) so the Relationship Timeline picks up the completion through the ordinary activity
feed with zero special-casing in the Timeline code itself.

## 10. Contact Intelligence Summary

`apps/api/src/lib/contactIntelligence.ts` — `getContactIntelligenceSummary()`. Every field is a
plain, deterministic read: role list, related-property count, most recent interaction timestamp
and days-since, the single soonest open commitment as the "next follow-up," open-opportunity
count, activity count within a fixed 30-day window (`RECENT_ACTIVITY_WINDOW_DAYS`, a documented
constant, not a magic number), outstanding-commitment count, and relationship age in days from
the earliest known interaction/relationship/opportunity record. `growOpportunities`'s own
`confidenceScore`/`scoreExplanation` columns are deliberately never read anywhere in this file —
matching the same discipline Priority 1's `growToday.ts` already established for the identical
reason. Nothing here computes or approximates a seller probability, an AI Opportunity Score,
predicted intent, or a mortgage/equity assumption; nothing behavioural is inferred. A dedicated
test asserts the full JSON shape of a brand-new contact's summary and specifically checks that
no scoring/probability/prediction key exists anywhere in the response.

## 11. API

All routes live in `apps/api/src/routes/contacts.ts`, mounted at `/grow/contacts` — nested under
Grow's existing namespace (`routes/index.ts`'s existing mount pattern), not a new top-level
surface:

- `GET /grow/contacts` — list/search (`?search=`, `?role=`), brokerage-scoped, always.
- `GET /grow/contacts/:partyId` — the full Contact 360 payload (identity, roles, household
  relationships, properties, opportunities, activities, commitments, timeline, intelligence
  summary) in one request.
- `POST /grow/contacts/:partyId/roles`, `DELETE /grow/contacts/:partyId/roles/:role` — role
  assignment (§5).
- `POST /grow/contacts/:partyId/relationships`, `DELETE /grow/contacts/relationships/:id` —
  household relationships (§6).
- `POST /grow/contacts/:partyId/commitments`, `PATCH /grow/contacts/commitments/:id` —
  commitments (§9).

Every GET is gated by `grow.contacts.read`; role and household-relationship mutations by
`grow.contacts.manage`; commitment mutations reuse the existing `grow.activities.manage` key
(no new entitlement was introduced for that surface, matching Priority 1's own write gate on
`growActivities`). `grow.contacts.read`/`grow.contacts.manage` were both already reserved keys
(defined in `packages/db/src/schema/billing.ts`) that were unused until this priority. Every
mutation validates that any referenced id (`partyId`, `relatedPartyId`, `propertyId`,
`opportunityId`) belongs to the caller's own brokerage before writing, matching §15 and every
existing Grow route's convention. No mutation beyond what §4/§5/§8/§9 actually require was
added — `POST`/`PATCH /grow/relationships` (Priority 1) remain the sole way to create or update
a contact↔property relationship, deliberately not duplicated here.

## 12. Grow UI — Contact 360

`apps/web/src/pages/Grow.tsx`'s Contacts tab (`GrowContactsTab`) is rebuilt into two views:

- `GrowContactList` — a searchable list of contacts (`GET /grow/contacts`) with a "View Contact
  360" link per row. Priority 1's own flat "Relationships" table and "Recent activity" feed (`GET
  /grow/relationships`, `GET /grow/activities`) are kept underneath, unchanged — nothing about
  adding Contact 360 required removing that brokerage-wide overview.
- `GrowContactDetail` — the Contact 360 screen itself, one `GET /grow/contacts/:partyId` request
  rendering, in order: a header (name, type, email, mobile, and every role as a clickable pill —
  click to assign/remove, gated on `grow.contacts.manage`); a headline stat-tile row (related
  properties, open opportunities, 30-day activity count, outstanding commitments); a relationship
  summary sentence built from the Contact Intelligence Summary; household relationships with
  add/remove (add flow: search contacts, pick one, pick a relationship type, optional note);
  properties (reusing AE's canonical property links, `/properties/:id`); the Relationship
  Timeline; recent activity and commitments (add/complete/cancel, gated on
  `grow.activities.manage`); and opportunities. This matches the spec's recommended layout and
  the "understand this relationship in seconds" goal — one screen, no generic CRM record view,
  no tab-hopping to piece together who someone is.

No part of Priority 1's Today tab, Opportunities tab, Nurture/Performance placeholders, or Ask AE
tab was redesigned. `apps/web/src/styles.css` gained a small number of purely additive rules
(`.grow-inline-form-row`, `.grow-contact-roles`, `.btn-link.active`) for the new layout; every
existing rule is untouched.

## 13. Priority 1 Integration

`GrowActionCard` (rendered inside Grow Today) gained one new button, "View Contact," following
the exact precedent already set by its existing "View property" button: a plain link/button,
shown whenever the viewer holds `grow.contacts.read` (the same entitlement the destination tab
itself already requires), that jumps straight into that action item's contact on Contact 360.
This required lifting one piece of state (`contactPartyId`) up to `GrowWorkspace`, so the
"Contacts" tab can be told which contact to open directly instead of defaulting to its list —
the only structural change made to Priority 1's own tab/workspace component, and it is
documented inline in the code at the exact point it was made.

Deliberately **not** touched: `apps/api/src/lib/growToday.ts` (Priority 1's already-shipped,
already-tested ranking/action logic). "View Contact" needed no new field on
`GrowTodayAction.availableActions` because every action item already carries a real `partyId` —
so this integration point required zero backend changes and therefore carries zero risk to
Priority 1's existing, passing test suite.

## 14. Future Communications & Appraisal Contracts

**Communications (§13).** `GROW_TIMELINE_EVENT_TYPES` includes `EMAIL_SENT`, `EMAIL_RECEIVED`,
`EMAIL_DELIVERED`, `EMAIL_OPENED`, `EMAIL_FAILED`, `SMS_SENT`, `SMS_RECEIVED`, `SMS_DELIVERED`,
and `SMS_FAILED` as reserved members of the event-type union. Nothing anywhere in this priority
emits any of them, and no email/SMS provider of any kind was integrated — this is purely a
type-level contract so a future Priority 3 communications surface can start publishing these
event shapes into the same Timeline function without a schema or contract change on the
Timeline side.

**Appraisals (§14).** No Appraisal entity, table, or route was built. The existing chain —
Contact (`parties`) → Property (`properties`) → Opportunity (`growOpportunities`, already
carrying `convertedAppraisalId`/`convertedTransactionId` from Priority 1) → Appraisal (RUN's
existing `appraisals` table) → Listing (RUN's existing workflow) — was left exactly as Priority 1
built it. Contact 360 surfaces a contact's opportunities and their `propertyId`, which is
sufficient for a future Appraisal Builder priority to navigate from a contact to a candidate
opportunity/property without this priority pre-building any part of that screen.

## 15. Tenancy / Security / Privacy

Every route requires authentication (`requireAuth`) and a specific Grow entitlement
(`requireEntitlement`) before touching the database. Every read filters by the caller's own
`brokerageId`, never a client-supplied one. Every write validates that every referenced id —
`partyId`, `relatedPartyId`, `propertyId`, `opportunityId`, a commitment's or role's own id on
update/delete — belongs to the caller's brokerage before proceeding, returning 404 (not a
generic 500 or a silent cross-tenant write) when it doesn't. Household relationships specifically
were tested for cross-tenant rejection on creation (relating two contacts across different
brokerages is refused) and on Contact-360 read/deletion. No audit-logging convention beyond what
Priority 1 already established was introduced or needed, since this priority added no new
category of side-effecting action beyond what `growActivities`/existing patterns already cover.

## 16. Test Evidence

`apps/api/src/routes/__tests__/contacts.test.ts` (15 sequential tests) covers, at minimum, every item this priority's spec required: unauthenticated rejection across the whole `/grow/contacts` surface; `grow.contacts.read`/`grow.contacts.manage`/`grow.activities.manage` each gating exactly their own routes and nothing more; list/search/role filtering; multi-valued role assignment with idempotent re-assignment and no duplicate rows; tenant isolation on read, list, and role mutation; 400 vs. 404 on an invalid vs. a nonexistent contact id; the full Contact 360 payload shape for a brand-new contact, explicitly asserting the intelligence summary carries no predictive/scoring key; household relationships (bidirectional dedup on creation, the just-fixed bidirectional visibility bug, self-relationship rejection, invalid-type rejection, cross-tenant rejection, deletion with tenant isolation); a Priority 1 integration check (a relationship created via the pre-existing `POST /grow/relationships` route surfaces correctly on Contact 360, and Priority 1's own list route is unaffected); the full commitment lifecycle (create/validate/tenant-isolate, complete — asserting both the `growActivities` side effect and the resulting Timeline entry — the 409 on double-completing, and cancellation); and a dedicated Relationship Timeline test that creates 3 relationships + 2 activities + 1 opportunity + 1 commitment for one contact and asserts an exact event count with unique event ids, newest-first ordering, and tenant isolation. `testSupport.ts`'s `cleanupBrokerages` was extended (not replaced) for the three new tables, with foreign-key-safe delete ordering. No existing test was weakened, skipped, or removed to reach any of this.

This suite is now confirmed passing for real, not just reconstructed: this session gained direct access to a real git clone of this repository, with a working Postgres and Node available, and ran `contacts.test.ts` against them. That run caught a genuine bug the test itself had been masking: test 15 ("Priority 1 integration: GET /grow/today still resolves successfully after Priority 2's additions to the Grow schema and routes") called `assert.equal(res.status, 200, await res.text())`, and `await res.text()` was evaluated unconditionally as the assertion's failure-message argument on every call — which itself threw because the response body had already been consumed earlier in the same test. The fix, `assert.equal(res.status, 200)`, is a one-line, test-only change; there is no application-code defect behind it. This fix, together with the regenerated `0014` migration snapshot, is committed as `1fa22c7` and pushed to `feat/ae-grow-priority-2-contact-intelligence`.

Per explicit instruction, the status of `privacy.test.ts` was specifically verified rather than assumed, since earlier passes of this report found it silently missing from full-suite output. Run in isolation, it reproduces a consistent pattern: all 4 of its own tests pass (`GET /legal/versions is public and returns non-empty version strings`; `a signed-in user can create a privacy request and see it in their own history`; `an unauthenticated caller cannot create a privacy request`; `resolving a privacy request never deletes or exports data — it only records a human decision, and is tenant-scoped`) — but the file's own `after` teardown hook then fails (`not ok 5`, `failureType: 'hookFailed'`, `Error: Failed query: delete from "brokerages" where "brokerages"."id" = $1`), and the process hangs indefinitely afterward with no further output; a hard `timeout 60s` wrapper was required to terminate it (exit code 124). `git blame` confirms this file predates Priority 2 entirely (added by commit `11f5eb6`, an unrelated auth/privacy test suite), and no Priority 2 change touches the tables, teardown ordering, or routes it exercises. This finding is independently corroborated by real GitHub Actions CI on PR #30 (run #197): the identical 4-pass-then-hang pattern appears in the CI log at the same point, and the "API automated test suite" step ran for 5h 59m 57s before GitHub Actions' 6-hour job cap force-cancelled the run. This is a genuine, reproducible, pre-existing defect unrelated to Priority 2 — consistent with the already-documented `grow.test.ts` precedent — and it has been diagnosed, not fixed, per this remediation's scope.

With direct repository access now available, both production builds and the synthetic-startup check were also run for real rather than reconstructed: the API production build (`pnpm --filter @aee/api run build`), the Web production build (`pnpm --filter @aee/web run build`), and the synthetic production-startup and storage-readiness script that CI also runs all pass locally. None of this is yet confirmed by CI itself, because the `privacy.test.ts` hang above prevents the same CI job from ever reaching those later steps — but it removes any remaining doubt about their correctness independent of CI reaching them.

## 17. Known Gaps & CI Status

**CI has now run to a real terminal state on PR #30 (run #197, commit `1fa22c7`) — the first time this branch has gotten past the schema drift step.** Workspace typecheck, the deterministic clean-database migration check, and the schema drift check all passed cleanly (the drift check in 2 seconds). The original, long-standing blocker this report tracked across earlier passes is fixed and CI-confirmed, not just locally reasoned about.

**The run's final status is `Cancelled`, not `Success`, at a total duration of 6h 1m 20s.** The "API automated test suite" step alone ran for 5h 59m 57s before GitHub Actions' 6-hour job-execution cap force-cancelled the entire job (annotation: "The job has exceeded the maximum execution time of 6h0m0s"). The CI log shows exactly the pattern reproduced locally and described in §16: `privacy.test.ts`'s 4 tests pass, its teardown hook then fails with `failureType: 'hookFailed'` on the same `brokerages` delete-query error, and the process hangs with no further output until the cap cancels the run.

**Because the test-suite step never finished, nothing after it ran in CI on this branch:** not the API production build, not the Web production build, not the synthetic production-startup and storage-readiness check. All three are verified passing locally (§16) but carry zero CI confirmation on this branch as of this report.

**The pre-existing `grow.test.ts` failures (4, from Priority 1, commit `acc3082`) remain present and untouched**, confirmed via git blame to predate this priority, consistent with every earlier pass of this report.

**The one open item blocking `COMPLETE` is a scoping decision, not a technical unknown.** Should the pre-existing `privacy.test.ts` teardown hang be fixed as part of landing this PR, even though it is not Priority 2 work, so that CI can reach a real pass/fail on the remaining steps? Or should PR #30 be evaluated on the Priority 2 diff alone and the legacy defect tracked and merged separately? This report does not have the authority to make that call and defers it to the Project Owner, per this remediation's explicit instruction not to modify unrelated pre-existing code without authorization.

## 18. Recommended Next Priority

Do not start Grow Priority 3 (Communications Hub) or any later Grow priority yet. Every Priority 2 concept, test, and UI surface described in this report is built, committed, and pushed to `feat/ae-grow-priority-2-contact-intelligence` — the only remaining gate is CI reaching a real green run on PR #30, which now depends entirely on the Project Owner's decision on the pre-existing `privacy.test.ts` hang (§17), not on any further Priority 2 work. Once that is resolved — whether by an authorized fix to that file's teardown or by a decision to track and merge it separately from this PR — and CI actually completes the API test suite, both production builds, and the synthetic-startup check on this branch, this priority can be reclassified `COMPLETE — READY FOR GROW PRIORITY 3` without any further code changes, since every Priority 2 concept is already built and committed. Communications Hub (§13's contract target) remains the logical next priority once this gate clears, since the Relationship Timeline's event-type contract was built specifically to receive it.

## 19. CI Stabilisation Gate (Project Owner Mandate)

**Scope of this section.** This section reports on a distinct, subsequent mandate: make the existing automated API test suite complete reliably in real CI and expose any genuine remaining failures, before PR #30 is considered for merge — explicitly *not* Grow Priority 3, and explicitly not permitted to implement any new Grow functionality (Communications Hub, Email/SMS, Appraisal Builder, external property-data integrations, Selling Signals, Voice, nurture automation). No such functionality was built. Every change in this section is a test file, a test-support helper, a test-script flag, or a CI workflow comment/timeout — nothing in `apps/api/src`'s or `apps/web/src`'s application/production code paths changed.

**1. Starting and final SHAs.** Gate start: `dbdd5dfafbdb2a16f7d2bf0a96636e8ee3d2b443` (the SHA this mandate's own text reported as HEAD; also the tip this report's §16/§17 evidence was gathered against). Two commits were produced, both currently sitting on top of that history on `feat/ae-grow-priority-2-contact-intelligence`:

- `a83da0dd755646e52fa3a39ea548aedc5c1c569f` — **pushed, live on `origin/feat/ae-grow-priority-2-contact-intelligence`, and the exact commit real GitHub Actions CI run #199 (linked in item 9 below) executed.** Contains all four substantive fix files.
- `58f0c2da05d439b2c7a9e5f069f4451c90961ac6` — **local-only.** The current tip of this branch in this session's working checkout, one commit ahead of `a83da0d`. Contains only a `.github/workflows/ci.yml` comment-and-config addition (item 10 below) and could not be pushed to `origin` — see item 11 for why, and item 15 for what the Project Owner needs to do about it.

**2. `privacy.test.ts` root cause.** All 4 of the file's own tests passed every time; its `after()` teardown hook then threw and the test process hung indefinitely afterward. The teardown hand-rolled its own per-brokerage delete order (`invitations` → per-user `privacyRequests` → `users` → `brokerages`) and never deleted `entitlement_grants` — a row `POST /auth/dev-login` inserts for every brokerage this suite creates (`routes/auth.ts`). `DELETE FROM brokerages` therefore threw a Postgres foreign-key violation (`entitlement_grants_brokerage_id_brokerages_id_fk`, code `23503`) partway through the cleanup loop. Because `node:test`'s `after()` hook has no implicit `try`/`finally`, the thrown error meant the function's last line — `server.close(...)` — was never reached, leaving the HTTP server open and the process unable to exit. In real CI (PR #30 run #197, before this gate) this consumed the entire 6-hour GitHub Actions job cap before the run was force-cancelled.

**3. `privacy.test.ts` remediation.** The teardown now delegates to the shared, FK-order-correct `cleanupBrokerages()` helper in `testSupport.ts` (extended by this fix to also delete `privacy_requests`, which it did not previously touch) inside a `try`, and closes the HTTP server inside a `finally` — so the server is always closed and the process always exits, regardless of whether cleanup throws. This is a structural fix, not a suppression: nothing catches-and-ignores the FK error, no test was skipped, no FK constraint was relaxed, and the 6-hour CI cap was not touched. `apps/api/src/routes/__tests__/privacy.test.ts` and `apps/api/src/routes/__tests__/testSupport.ts` are the two files changed.

**4. `grow.test.ts` root cause — all 4 failures, one stale assertion.** `git blame` and re-reading confirm these 4 failures were pre-existing (from Priority 1, commit `acc3082`, as earlier passes of this report already documented) and were never a Priority-2-introduced regression. All 4 traced to a single stale assertion in one test ("a brand-new brokerage has no entitlements yet"): the test asserted a brand-new brokerage's `entitlements` array is `[]`. AE GROW Priority 0.5 (commits `deb4a42a`, `e7ce5a88`; see `docs/AE_GROW_PRIORITY_0_5_FOUNDATION_REPORT.md`, Sections 5 and 13) had since intentionally changed this: every new brokerage is now automatically granted `run.access` on creation. This file's suite was never re-run against that change. The resulting assertion failure threw before the test's own `grow.access` grant call ran, which cascaded into 3 further, later failures in the same file that all depended on that grant having happened.

**5. `grow.test.ts` remediation.** The assertion was corrected to expect `["run.access"]` (not `[]`, and not `["run.access", "grow.access"]` — a citing comment in the test points to the Priority 0.5 commits and report sections above). This is the one and only test-content change made anywhere in this gate; no application/production code and no Priority 1 algorithm was touched, per the mandate's explicit prohibition on redesigning Priority 1 logic or auto-modifying tests without a cited contract justification.

**6. Files changed (complete list, gate start → `a83da0d`).** `apps/api/src/routes/__tests__/privacy.test.ts` (root-cause teardown fix, item 3), `apps/api/src/routes/__tests__/testSupport.ts` (`cleanupBrokerages()` extended to delete `privacy_requests`), `apps/api/src/routes/__tests__/grow.test.ts` (one-line assertion fix + citation, item 5), `apps/api/package.json` (`test` script: native `--test-timeout` flag added, item 10). Plus, local-only in `58f0c2d`: `.github/workflows/ci.yml` (comment + step-level `timeout-minutes: 20`, item 10). 4 files, 47 insertions, 13 deletions in `a83da0d`; 1 file, 41 insertions in `58f0c2d`. No schema, migration, route, service, or UI file changed.

**7. Application code vs. test/CI-config — and why.** Zero application/production source files changed. Every file in item 6 is a test file, a test-only support helper, a test-runner flag, or CI workflow configuration. This was a deliberate scope decision required by the mandate (§9, "Scope Control"): both defects were proven, by direct evidence (items 2 and 4), to be defects in the tests' own setup/assertions, not in the application logic they exercise — so fixing the tests is the correct and minimal remediation, and touching `apps/api/src/routes/privacy.ts`, `apps/api/src/routes/grow.ts`, or any entitlement logic would have been an unauthorized, unjustified change to working production code.

**8. Local suite results and duration.** Full command (`pnpm --filter @aee/api run test`, all ~89 files, single invocation) run to completion, unaided, in this session's sandbox: **801 tests, 787 pass, 13 fail, 0 cancelled, 1 skipped, 0 todo — duration 340473.99 ms (≈5 min 40 s) — exit code 1.** Exit code 1 reflects the 13 pre-existing failures in item 12 below, not a hang or a crash: the process returned control to the shell unaided, with no lingering listeners, pools, or timers (item 14). This is the same full command CI runs; it is not a subset.

**9. GitHub Actions result — real, independent CI evidence.** [Run #199](https://github.com/AdamJRichards27/AgentEngineEasy/actions/runs/34400170456/job/102630035351) on PR #30, for commit `a83da0d`, triggered automatically by `pull_request: synchronize` when that commit was pushed. **Status: Success. Total duration: 17 m 1 s.** Job "Typecheck, test, build, migration validation" succeeded in 16 m 15 s, every step green: Set up job (2 s), Initialize containers (25 s), Checkout (2 s), Install pnpm (1 s), Install Node.js (2 s), Verify vendored dependencies (0 s), Install dependencies — frozen lockfile (3 s), Workspace typecheck (29 s), Deterministic clean-database migration check (2 s), Schema drift check (1 s), **API automated test suite — 14 m 55 s (succeeded)**, API production build (0 s), Web production build (3 s), Synthetic production startup and storage readiness (4 s). One annotation only: a benign Node.js 20 deprecation notice from GitHub's own `actions/checkout@v4`/`actions/setup-node@v4` runtimes, unrelated to this repository. This is the first time this branch's CI has ever reached a `Success` terminal state — the same "API automated test suite" step that previously ran for 5 h 59 m 57 s before the 6-hour job cap force-cancelled run #197 now completes cleanly in well under 15 minutes, and — for the first time on this branch — both production builds and the synthetic-startup check actually ran in CI and passed.

**10. CI timeout / fail-fast changes.** Two layers were added, per the mandate's explicit "only after the underlying hang is fixed, and prefer a native mechanism" instruction — the underlying hang was fixed first (items 2–3), then:
  - **Native, primary mechanism — pushed and live:** `apps/api/package.json`'s `test` script gained `--test-timeout=120000`, Node's own per-test/per-hook timeout, now guarding every one of the suite's ~801 tests and hooks individually. The value is measurement-grounded, not guessed: an initial `30000` ms was tried first and correctly fixed the `privacy.test.ts` hang, but running the *complete* suite (not that one file in isolation) exposed a second-order effect — 3 pre-existing, already-flaky files under `src/lib/exceptions/__tests__/` (item 12) occasionally need slightly over 30 s of cumulative wall-clock time under full-suite Postgres contention even though no individual assertion or hook hangs, which made Node report those whole files as `testTimeoutFailure` and cancel their remaining subtests — a strictly worse failure signature than their normal, fast assertion failures. Re-measured against the complete suite at `120000` ms: zero timeouts, zero cancellations, the same pre-existing assertion failures reported cleanly. This mechanism is confirmed live and effective by CI run #199 itself (item 9): the test step completed in 14 m 55 s, far inside the 2-minute-per-test ceiling.
  - **Coarser, step-level backstop — blocked from `origin`, local-only:** `.github/workflows/ci.yml`'s "API automated test suite" step also gained `timeout-minutes: 20`, sized against this step's own observed normal duration (the full local suite completes in ~5.7 minutes, leaving over 3× headroom for a slower CI runner) as a second, coarser safety net bounding a future *still-unknown* hang class the native per-test mechanism might not cover, rather than a replacement for it. **This change is not on `origin`** — see item 11.

**11. The `origin` push blocker for the CI-config file — exact evidence.** Splitting `a83da0d` from `58f0c2d` was necessary because `git push` for a single commit touching `.github/workflows/ci.yml` was rejected by GitHub itself with: `refusing to allow an OAuth App to create or update workflow ".github/workflows/ci.yml" without \`workflow\` scope`. This is a scope limitation on the git remote's own OAuth credential, not a code or test problem, and per this session's standing instructions (never extract, expose, or work around credentials) it was not bypassed. As a second, independent channel, the GitHub MCP server's `push_files` tool was also tried and returned `403 Resource not accessible by integration` for the same path — a different, narrower credential with no repo-write access at all (the same 403 also blocks that integration from reading check-runs/status on this repo, which is why item 9's evidence was gathered by direct browser navigation to a GitHub Actions run authenticated as `AdamJRichards27` instead). Both are authorization/credential-scope gaps outside this session's control, not defects. `a83da0d` (everything except the CI-config file) pushed cleanly; `58f0c2d` (the CI-config file alone) was committed locally, with its own commit message explicitly addressed to the Project Owner, and deliberately not re-attempted.

**12. Remaining known defects.** 13 of the local run's 787+13 (item 8) failures are pre-existing, confined to `apps/api/src/lib/exceptions/__tests__/` (4 in `engine.test.ts`, 4 in `financialReconciliationVariance.test.ts`, 5 in `integrationOperational.test.ts`), and were traced this gate to nondeterministic resource contention on a single shared, live Postgres instance when Node's test runner's default per-file concurrency runs all ~89 files at once — not to a deterministic assertion bug, a hang, or anything Priority-2- or gate-related. They are unrelated to `privacy.test.ts` or `grow.test.ts`, are out of this gate's authorized scope to fix (per §9's Scope Control — only the two named files' defects and a justified CI timeout were authorized), and were not touched. Notably, they did **not** reproduce in real CI run #199 (item 9) — the "API automated test suite" step there succeeded outright — which is consistent with their diagnosed nondeterministic, contention-dependent nature rather than evidence they are fixed: a future CI run under different timing/load could still see them recur. This is flagged as a known, tracked, accepted risk rather than a blocker, since it predates this gate, predates Priority 2, and CI's own real-world result on the actual `origin` code is currently green.

**13. Regression protection.** The `privacy.test.ts`/`testSupport.ts` fix (item 3) is itself structural regression protection: the teardown can no longer leave the server open on a cleanup failure, by construction (`try`/`finally`), rather than by a new assertion that could later be deleted or bypassed. The native `--test-timeout=120000` guard (item 10) is independent, blanket regression protection against *any* future test or hook — in this file or any other — hanging the whole suite again, which is a stronger and more general guarantee than a single targeted test could provide. No new dedicated test file was added, since the mandate directs adding regression protection "where practical" and both of the above already close the specific recurrence path with more coverage than a new assertion would add.

**14. Test process termination — verified.** The full local suite run (item 8) returned control to the shell unaided, with exit code 1 and no further intervention required — no dangling HTTP servers, connection pools, or timers were observed, and no `timeout`/`kill` wrapper was needed to end the process (contrast with the pre-remediation state, where a hard `timeout 60s` was required to terminate `privacy.test.ts` in isolation, and where CI's own 6-hour job cap was previously the only thing that ever ended the full-suite run at all).

**15. Merge recommendation and decision (historical — see item 16 for the Project Owner's resolution).**

The mandate's core objective — make the existing automated API test suite complete reliably in real CI and expose genuine remaining failures before PR #30 is considered for merge — **is achieved and independently evidenced**: the `privacy.test.ts` hang that previously consumed the full 6-hour CI job cap is fixed at its structural root (items 2–3), the `grow.test.ts` legacy failures are fixed with a cited justification (items 4–5), a measurement-grounded native CI timeout guard is live and CI-proven (items 9–10), and real GitHub Actions now runs this branch's complete pipeline — typecheck, migration check, schema drift check, the full 801-test API suite, both production builds, and the synthetic-startup check — to a clean `Success` in 17 minutes, for the first time ever on this branch.

That result stands on `a83da0d`, which is already the tip of `origin/feat/ae-grow-priority-2-contact-intelligence` — nothing further needs to land for CI to keep passing at that commit. What remains is narrower than the underlying engineering: commit `58f0c2d`'s coarser CI-config hardening (item 10) is stuck in this session's local checkout, blocked by a GitHub OAuth scope restriction outside this session's authority to resolve (item 11), and the 13 pre-existing `exceptions/` test failures (item 12) are a known, accepted, out-of-scope risk that happened not to surface in run #199 but could recur in a future run under different timing.

Because landing that CI-config commit requires an action only the Project Owner can authorize or perform — not further engineering — this report's decision, at the time this item was written, was:

~~BLOCKED — PROJECT OWNER DECISION REQUIRED~~ *(superseded — see item 16)*

scoped narrowly to one item: how to land commit `58f0c2d`. Three paths, any of which resolves this block:
  (a) grant the `workflow` OAuth scope to the credential backing this repository's git remote, so this session (or the Project Owner) can `git push origin feat/ae-grow-priority-2-contact-intelligence` to land it as-is;
  (b) apply the equivalent `.github/workflows/ci.yml` diff manually via the GitHub web UI or the Project Owner's own authenticated `git`/`gh` CLI (the full diff is in this commit, inspectable in this session's local Replit checkout); or
  (c) decide the already-live, already-CI-proven native `--test-timeout=120000` guard (item 10) is sufficient on its own, explicitly waive the coarser step-level backstop, and treat PR #30 as ready to merge at `a83da0d` exactly as it stands on `origin` today.

This was not a request for more engineering time: no further code, test, or CI change was anticipated regardless of which path the Project Owner chose.

**16. Project Owner Decision — Waiver (resolves item 15).**

The Project Owner reviewed this section and issued "AE GROW — PR #30 PROJECT OWNER DECISION," explicitly selecting **path (c)** above: the coarser, unpushed workflow-level `timeout-minutes: 20` backstop in `58f0c2d` is **waived**. The Project Owner's decision, recorded verbatim in substance:

- The native per-test timeout guard (`--test-timeout=120000`, item 10, live on `origin` since `a83da0d`) is accepted as sufficient for the current merge gate.
- The local-only `.github/workflows/ci.yml` timeout commit (`58f0c2d`) is optional defence-in-depth — not required for PR #30, not required for Grow Priority 2 completion, and not required before Priority 3 begins.
- No additional OAuth `workflow` scope is to be requested for this task. Commit `58f0c2d` is not to be recreated or force-pushed. PR #30 is not to be kept blocked because of that commit.
- The unpushed workflow-level timeout is deferred as optional future CI hardening, to be picked up separately (by whichever future session/environment has the appropriate `workflow`-scoped credential) if and when the Project Owner chooses — it is explicitly **not** a condition of this merge.

With this waiver, every item this gate's own item 15 flagged as outstanding is now resolved:

- The `privacy.test.ts` hang is fixed at its structural root (items 2–3) — confirmed by real CI.
- The stale `grow.test.ts` assertion is fixed with a cited justification (items 4–5) — confirmed by real CI.
- CI runs #199 (commit `a83da0d`) and #200 (commit `3aa0f3d`, a documentation-only commit stacked on `a83da0d` — see this report's revision history) both completed to a clean `Success` in real GitHub Actions: 17m1s and 16m40s respectively, every step green, only the pre-existing/unrelated Node.js 20 deprecation annotation present.
- The native per-test timeout guard is live on `origin` and CI-proven (item 10; both green runs completed the API test suite step in well under its 120-second-per-test ceiling — 14m55s and equivalent on run #200 — with zero timeouts or cancellations).
- The coarser workflow-level timeout was never pushed to `origin`, solely because of the missing OAuth `workflow` scope (item 11) — a credential-scope limitation, not a code or test defect.
- The Project Owner has explicitly accepted that limitation and waived the requirement to land it before merge.
- The 13 pre-existing `apps/api/src/lib/exceptions/__tests__/` failures (item 12) remain a known, accepted, out-of-scope risk, unchanged by this waiver, and did not reproduce in either green run.

**Final decision: `COMPLETE — APPROVED FOR MERGE`**, superseding item 15's `BLOCKED — PROJECT OWNER DECISION REQUIRED`, provided PR #30's current HEAD continues to satisfy required CI at merge time (verified separately at merge; see the PR's own description and the stack-verification record for the exact commit and CI evidence used).

**17. Merge execution and final three-priority stack verification (resolves the "AE GROW — PR #30 PROJECT OWNER DECISION" directive, Steps 2–6).**

Acting on item 16's waiver, PR #30 was taken out of Draft, its description rewritten to remove all stale `BLOCKED` language and document Phases 1–4 in full (including the waiver itself), and merged into `staging` with a standard two-parent merge commit — `merge_method: "merge"`, never squash/rebase, preserving full history per Decision 1 governing this whole stack (PR #28 → PR #29 → PR #30 → `staging`).

- **Pre-merge state confirmed clean:** `pull_request_read` showed `mergeable_state: "clean"`, `draft: false`, base `staging` at `f8a2f4d6c297f75a8a480f811032b0f1006f29fc` (PR #29's own merge commit — dependency order intact), head `75a5252f2f9faae82645e4e5869d0fffd4f0a501` (the post-conflict-resolution merge commit from Phase 4, itself CI-confirmed by run #213 — Success, 17m12s).
- **Merge commit:** `merge_pull_request` on PR #30 with `expectedHeadSha: 75a5252f2f9faae82645e4e5869d0fffd4f0a501` returned `{"sha":"1a55bbc3c875a0f6b3245ce8f004ee42704f8117","merged":true}`. Confirmed independently via `pull_request_read`: `state: "closed"`, `merged: true`, `merged_by: "AdamJRichards27"`, `merged_at: "2026-09-10T18:28:33Z"`.
- **Final three-priority stack verification, on the real merged `staging` tip — not just the pre-merge branch.** The push of merge commit `1a55bbc` to `staging` triggered CI run [#214](https://github.com/AdamJRichards27/AgentEngineEasy/actions/runs/34514560573). This is significant: the two earlier push-triggered runs against `staging` (`#211`, PR #28's merge push — **cancelled**, superseded by PR #29's push moments later under the workflow's `cancel-in-progress` concurrency group; `#212`, PR #29's merge push — **failed** solely on a GitHub Actions account billing/spending-limit block, before any step executed) meant `staging`'s actual merged tip had *never* been validated end-to-end by a completed CI run. Run #214 is therefore the first genuine, completed, push-triggered CI validation of the full merged stack (Priority 0.5 + 1 + 2 together) directly on `staging`.
  - **Result: `Success`. Total duration 16m 39s.** Single job "Typecheck, test, build, migration validation" succeeded in 16m 34s. Confirmed via direct browser navigation to the run (the GitHub MCP integration's `get_check_runs`/`get_status` remain 403'd on this repo, per the already-documented permission gap): every step present and green — Set up job, Initialize containers, Checkout, Install pnpm, Install Node.js, Verify vendored dependencies, Install dependencies (frozen lockfile), Workspace typecheck, Deterministic clean-database migration check, Schema drift check, API automated test suite, API production build, Web production build, Synthetic production startup and storage readiness, Post/cleanup steps, Complete job. One annotation only — the same benign, pre-existing "Node.js 20 is deprecated" platform notice already seen on runs #199/#213 (`actions/checkout@v4`, `actions/setup-node@v4`, `pnpm/action-setup@v4` being forced onto Node 24 by GitHub itself) — unrelated to this repository's code and not a new failure class.
  - **No workflow-level `timeout-minutes` backstop is present in `ci.yml`** (confirmed by a fresh read of `staging`'s `ci.yml`, blob sha `ad83d33043ae6ebae2b767dec5deb2cdbf0c8337`, before this merge) — the run relied solely on the native `--test-timeout=120000` per-test/per-hook guard from item 10, and that guard proved sufficient across all three real CI validations this stack has now produced (`#199`, `#213`, `#214`), with zero timeouts or cancellations in any of them. Per the Project Owner's explicit instruction, the already-waived workflow-timeout question is **not** reopened here — this result is exactly the evidence that would have been required to reopen it, and it demonstrates the native guard is sufficient, not insufficient.
  - **The 13 pre-existing, nondeterministic `apps/api/src/lib/exceptions/__tests__/` failures (item 12)** did not reproduce in run #214, consistent with their diagnosed cause (Postgres resource contention under full local-suite concurrency, not present in CI's environment) and with their non-reproduction in runs #199 and #213 — still a known, accepted, out-of-scope risk, not a blocker.
- **Conclusion.** All three conditions of the directive's Step 5 are satisfied on real, current, merged `staging` evidence: Priority 0.5, 1, and 2 are all present together on `staging` (merge commit `1a55bbc`); migrations, schema-drift check, the full API test suite, both production builds, and the synthetic-startup check all passed in the same completed CI run; and only the existing native per-test timeout guard was used, with no workflow-level backstop added. **Grow Priority 2 is closed: `COMPLETE — MERGED TO STAGING.`**
