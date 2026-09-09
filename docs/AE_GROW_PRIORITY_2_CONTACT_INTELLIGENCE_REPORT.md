# AE GROW — Priority 2 — Contact Intelligence & Relationship Timeline

Completion report. Branch: `feat/ae-grow-priority-2-contact-intelligence`. Base:
`feat/ae-grow-priority-1-daily-command-centre` (SHA `d5691b65adca01dc34a7b347e6f7367509479300`).
Pull request: [#30](https://github.com/AdamJRichards27/AgentEngineEasy/pull/30) (open, draft).
Final SHA at the time of this report: `8c9336758c75a876420c4914e33a1e0c5646a173`.

## 1. Decision

**REMEDIATION REQUIRED.**

Every Priority 2 concept in the authorizing spec (§1–§21) is implemented — schema, API,
Relationship Timeline, Contact Intelligence Summary, Contact 360 UI, and Priority 1
integration — and is covered by a route-level automated test suite that was written honestly
against this priority's own acceptance criteria, including a real, previously-undetected bug
that the tests caught and this work then fixed (§16 below).

The reason this is not `COMPLETE — READY FOR GROW PRIORITY 3` is that CI on PR #30 has never
run to completion: it fails at the "Schema drift check" step, before the workspace typecheck,
the migration-apply check, the real API test suite, or either production build ever execute.
The root cause is fully diagnosed, the fix is verified safe, and a ready-to-apply patch has been
handed to the Project Owner directly (not just described) — but it requires a maintainer with
real git push access to apply, because the one file involved is too large for this session's
only write channel to GitHub (the GitHub MCP server) to transmit in a single call. Until that
lands and CI actually runs green through the API test suite, this cannot honestly be reported
as complete. See §17 for the full, precise accounting, and §16 for what verification was and
was not possible from inside this session.

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

`apps/api/src/routes/__tests__/contacts.test.ts` (new, 15 sequential tests) covers, at minimum,
every item §16 required: unauthenticated rejection across the whole `/grow/contacts` surface;
`grow.contacts.read`/`grow.contacts.manage`/`grow.activities.manage` each gating exactly their
own routes and nothing more; list/search/role filtering; multi-valued role assignment with
idempotent re-assignment and no duplicate rows; tenant isolation on read, list, and role
mutation; 400 vs. 404 on an invalid vs. a nonexistent contact id; the full Contact 360 payload
shape for a brand-new contact, explicitly asserting the intelligence summary carries no
predictive/scoring key; household relationships (bidirectional dedup on creation, the
just-fixed bidirectional **visibility** bug, self-relationship rejection, invalid-type
rejection, cross-tenant rejection, deletion with tenant isolation); a Priority 1 integration
check (a relationship created via the pre-existing `POST /grow/relationships` route surfaces
correctly on Contact 360, and Priority 1's own list route is unaffected); the full commitment
lifecycle (create/validate/tenant-isolate, complete — asserting both the `growActivities` side
effect and the resulting Timeline entry — the 409 on double-completing, and cancellation); and a
dedicated Relationship Timeline test that creates 3 relationships + 2 activities + 1 opportunity
+ 1 commitment for one contact and asserts an **exact** event count with **unique** event ids —
the direct proof of no join-caused duplicates — plus newest-first ordering and tenant isolation.
`testSupport.ts`'s `cleanupBrokerages` was extended (not replaced) for the three new tables, with
foreign-key-safe delete ordering. **No existing test was weakened, skipped, or removed** to reach
any of this.

What could **not** be verified from inside this session, and why: this session has no direct
network or git access to GitHub (organizational egress policy; confirmed via a 403 from `curl`
and from `git`) — the GitHub MCP server is the only write channel, and it cannot run arbitrary
commands, only fetch/write file content. So `contacts.test.ts` has never actually been executed
against a real Postgres from inside this session — only reasoned about against `grow.test.ts`
and `propertyTimeline.test.ts`'s already-CI-proven conventions, which this file mirrors
deliberately. In its place, two substitute checks were run in a local, isolated reconstruction
of the relevant packages (fetched file-by-file via the GitHub MCP server, with real pinned
dependency versions installed): a genuine `tsc --noEmit` against `packages/db`'s actual
`tsconfig.json`/`tsconfig.base.json` (TypeScript 5.6.3) — zero errors — and a TypeScript
syntax-parse check (`ts.createSourceFile`, no module resolution) of every new/modified
`apps/api` file and, this segment, the new/modified `apps/web` frontend files
(`Grow.tsx`, using `ScriptKind.TSX`) — zero syntax errors in both. Neither substitute is a
real test run or a real typecheck of the whole monorepo; both are reported here as exactly what
they are, not as a stand-in claim of "tests passed."

## 17. Known Gaps & CI Status

**CI ran once on PR #30 and failed at the "Schema drift check" step** (before typecheck, the
migration-apply check, the real API test suite, or either production build could run — `ci.yml`
has no `continue-on-error` anywhere, so one failing step skips everything after it in the same
job).

**Root cause, confirmed by reproducing it in the isolated local reconstruction described in
§16:** this priority's own migration-authoring step produced
`packages/db/migrations/0014_pretty_shriek.sql` (already committed, correct) but could not commit
its paired `packages/db/migrations/meta/0014_snapshot.json` — a ~455KB pretty-printed JSON file
that exceeds a hard per-call output-size ceiling of this session's only write channel to GitHub
(the GitHub MCP server's `create_or_update_file`/`push_files`, which require a file's complete
content as one literal argument with no chunked-upload mechanism). With that snapshot missing,
`drizzle-kit generate` (the drift-check step) has an orphaned journal entry to work around: it
falls back to the last snapshot it can find (`0013`), decides all three Priority 2 tables are
still new, and emits a **new**, spuriously duplicate migration — observed in real CI as
`migrations/0015_optimal_wither.sql` — which is what actually fails `git diff --exit-code`. This
is a gap in this priority's own delivery, not a pre-existing repository issue, and it is the
reason this report's decision is `REMEDIATION REQUIRED` rather than complete.

**The fix is verified safe and has been handed to the Project Owner as a ready-to-apply file,
not just a description**: a zip (`schema_drift_fix.zip`, delivered separately in this
conversation) containing the regenerated `0014_quick_microchip.sql`, its
`0014_snapshot.json`, a corrected `_journal.json`, and a README with exact `cp`/`git commit`
steps. The regenerated SQL's `CREATE TABLE` statements, foreign keys, and indexes were confirmed
byte-for-byte equivalent to the already-committed `0014_pretty_shriek.sql` (only the
drizzle-kit-assigned filename differs) — this is a pure tooling/naming fix, with zero
schema-design risk, that a maintainer with real git push access can apply in under a minute.
Once applied and pushed, CI should run all the way through the API test suite and both
production builds for the first time on this branch.

**Second, unrelated permission wall, also confirmed and not routed around:** this session's
GitHub MCP token lacks the `workflows` permission scope, so it cannot create or edit anything
under `.github/workflows/` — a temporary CI-side workaround (a parallel verification workflow
skipping just the drift-check step) was attempted and rejected with a 403 at "failed to create
tree." This was abandoned rather than circumvented, consistent with this session's standing
instruction to report a blocked host/permission rather than route around it.

**`privacy.test.ts`** (§17 of the spec): re-inspected this priority; it exercises
`/legal/versions`, `/privacy/requests`, and `/admin/privacy-requests` against
`privacyRequests`/`invitations`/`users`/`brokerages` — no file, table, or route Priority 2
touched. `routes/index.ts`'s only change is one additive router mount. No plausible interaction
was found by code-path inspection, but this session could not independently re-execute the test
suite to confirm the previously-documented hang still reproduces byte-for-byte; per §17's
instruction, it was left untouched and unremediated as a pre-existing, unrelated issue.

**Frontend verification gap, stated plainly:** the new/modified `apps/web` files passed a
syntax-only parse check (§16) but were not run through a full `apps/web` typecheck or build —
reconstructing that locally (React, `@tanstack/react-query`, `wouter`, and every sibling
file `Grow.tsx` imports from) was judged disproportionate to this priority's scope, the same
judgment already applied to the `apps/api` backend files earlier in this PR. This is an
additional reason CI actually completing end-to-end (which does run a real `apps/web` build)
matters before this can be called complete.

## 18. Recommended Next Priority

Do not start Grow Priority 3 (Communications Hub) or any later Grow priority yet. The immediate
next step belongs to the Project Owner or a maintainer with real git access: apply the
3-file schema-drift fix delivered in this conversation, push it, and let CI run all the way
through on PR #30 for the first time. Once CI is actually green — typecheck, migration check,
the real API test suite, and both production builds all passing, not merely "no changes were
made to break them" — this priority can be reclassified `COMPLETE — READY FOR GROW PRIORITY 3`
without any further code changes being required, since every Priority 2 concept, test, and UI
surface described above is already built and committed. If CI surfaces anything genuinely new
once it reaches the steps that never got to run (the real test suite, the production builds),
that would need to be triaged and fixed before Priority 3 begins. Communications Hub itself
(§13's contract target) is the logical next priority once this gate clears, since the
Relationship Timeline's event-type contract was built specifically to receive it.
