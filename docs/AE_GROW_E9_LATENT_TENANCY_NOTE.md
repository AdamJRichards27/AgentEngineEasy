# E-9 latent tenancy — design note

**Status:** design note. #207 (E-9 A4, `b4d3ba3fc4ab2b9dbbdcda55ddfa31dc119867e1`) is merged and adds no migration. #211 (`20751469662d3268263f83f5ad6799feeccb49b7`) is merged: migration 0036 prepares the column, backfill, and constraints and is **not applied to any environment**. The #211 merge carried an approval-scope deviation recorded by the Owner, without a history rewrite. E-9 stays **PARTIAL**. Nothing in this note closes E-9.
**Wave:** Grow Completion Program. This is not a new Priority 2, and it does not reopen historical Grow Priority 1 or historical Grow Priority 2 (Contact Intelligence, #30).
**Staging tip verified for this note:** `5ee41952199ea877f0cabc5ce8e6e718050c5c34` (*Grow Appraisals list and Appraisal Workspace*, #167).
**Post-merge CI:** run [37559800941](https://github.com/AdamJRichards27/AgentEngineEasy/actions/runs/37559800941) SUCCESS (event `push`, head = that tip).
**Roadmap anchor:** `docs/AE_GROW_COMPLETION_ROADMAP.md` §2 E, row **E-9** (P1, latent). The §2 finding row stays the original audit. This file is the design record.
**Migration impact:** none. This note adds no column, no migration, and no product code.

Open docs PR #169 is editing `docs/AE_GROW_COMPLETION_ROADMAP.md` and `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md` (E-1 close and Grow Completion Program naming). This note does not edit those files, so it does not collide with that diff. I-15 product PR #170 is a separate index-lock slice and is not touched here.

Adding `brokerage_id` (or any other tenant column) to `appraisals` or `communication_participants` requires a **separate Owner decision and a separate migration approval**. Merging this note is not that approval. Applying a future migration to any database, including production, is a further Owner gate.

---

## The finding

E-9, as recorded in the roadmap §2 table:

> `appraisals` has no `brokerage_id`; tenancy is correct-by-discipline across all 18 endpoints. `communication_participants` holds contact PII with no tenant column.

Anchor cited there: `packages/db/src/schema/appraisal.ts` lines 114–120. That comment is still accurate on this tip: `appraisals` is tenant-scoped only through `property_id` → `properties.brokerage_id`. The “18 endpoints” count is the Signal Sweep wording. This note does not re-count routes.

On this tip the two tables are:

| Table | Tenant column | How a row is supposed to belong to one brokerage | Sensitive columns with no tenant of their own |
|---|---|---|---|
| `appraisals` | none | `property_id` is `NOT NULL` and references `properties.id`. `properties.brokerage_id` is `NOT NULL`. | Pricing, commission, marketing proposal, outcome notes, follow-up notes, finalised snapshot |
| `communication_participants` | none | `thread_id` is `NOT NULL` and references `communication_threads.id`. `communication_threads.brokerage_id` is `NOT NULL`. | `display_name`, `email`, `mobile`, `manual_entry_reason` |

Parent tables that already carry `brokerage_id` are not part of E-9: `properties`, `parties`, `communication_threads`, and `communication_messages`.

Two child tables also have no `brokerage_id`: `appraisal_comparable_sales` and `appraisal_market_competition`. They hang off `appraisal_id` only. They are not named in the E-9 row. Decision 2 below asks whether a future remediation includes them.

---

## What the risk is

Postgres will not reject a read or a write that forgets the parent join. There is no `brokerage_id` to put in a `WHERE`, and no check that the parent’s brokerage matches `parties.brokerage_id` when `party_id` is set.

Party ids do not collide across brokerages. `parties.id` is a global serial primary key, and each party has one `brokerage_id`. The hole is different: a row whose parent is in brokerage A while `party_id` points at a party in brokerage B, or a new query that selects the child table by primary key, `party_id`, email, or mobile and never joins the parent.

That is latent. The known production readers on this tip do join or gate (next section). The risk is the next reader, and any row that application code fails to keep consistent, because the database will store it.

Concrete consequences if discipline slips:

- An appraisal read by id or by `party_id` alone can return another brokerage’s price range, commission, and outcome notes.
- A participant read by id, email, or mobile alone can return another brokerage’s contact name, email, and mobile. Those columns are the PII the finding names.
- Contact 360’s timeline selects `appraisals` by `party_id` only (`relationshipTimeline.ts`, the appraisal query in the same `Promise.all` as the participant thread-id query). It then refuses the whole timeline when `party.brokerageId` is not the caller’s. It does **not** re-check `properties.brokerage_id` on the appraisal rows before emitting events. Events carry appraisal id, property id, opportunity id, and a status summary. Property labels are loaded with `brokerage_id`, so a cross-tenant property address is not filled in. A mismatched property/party row would still surface the status event and the foreign property id. Writes that attach a party check the party’s brokerage today; the database does not.

---

## Current correct-by-discipline behaviour

Verified on tip `5ee41952199ea877f0cabc5ce8e6e718050c5c34`. These paths are the reason the finding is latent rather than an open cross-tenant read.

**Appraisals**

- `assertAppraisalInBrokerage` (`apps/api/src/lib/growAppraisals.ts`) inner-joins `properties` and rejects the row when `properties.brokerageId` is not the caller’s. The comment on that helper says there is no denormalised `brokerageId` on `appraisals`. Grow workspace reads and writes go through it. Comparable sales and market competition are loaded only after that check (`getAppraisalWorkspace`).
- `listAppraisalPipeline` inner-joins `properties` and filters `properties.brokerageId`. The owner join also requires `users.brokerageId`.
- RUN create and finalise (`apps/api/src/lib/appraisals.ts`, `getOrCreateAppraisal` and `finaliseAppraisal`) load the property and reject it when `property.brokerageId` is not the caller’s, before inserting or updating the appraisal.
- Grow Today’s appraisal existence probe and Rule E follow-up read (`apps/api/src/lib/growToday.ts`) inner-join `properties` and filter `properties.brokerageId`.

**Participants**

- `listParticipants` calls `getThread(threadId, brokerageId)` first. `getThread` loads `communication_threads` and throws when `thread.brokerageId` is not the caller’s. The participant select then runs by `thread_id` only.
- `addParticipantFromParty` (`apps/api/src/lib/communications/recipientResolution.ts`) rejects the thread and the party unless both `brokerageId` values match the caller, then inserts `display_name`, `email`, and `mobile` copied from that party.
- `createDraftMessage` resolves the thread with `getThread`, then loads a participant by id and rejects it when `participant.threadId` is not that thread.
- Inbound reply resolution (`apps/api/src/lib/communications/webhooks.ts`) matches `communication_participants.email` or `.mobile` only inside an inner join to `communication_threads` with `communication_threads.brokerageId` equal to the webhook’s brokerage, and checks the thread’s brokerage again before use.
- Contact 360 path 2 selects participant `thread_id` by `party_id` alone, then keeps only threads whose `communication_threads.brokerage_id` is the caller’s before loading messages (`relationshipTimeline.ts`).

Indexes match that shape. Appraisal indexes are property-leading (plus `appraisals_party_idx`). Participant indexes are `thread_id` and `party_id`. There is no brokerage-leading index on either table, because there is no column to lead with. The sweep comment in `appraisal.ts` says the brokerage-scoped queries are joins driven from `properties`, and that `properties.brokerage_id` is indexed.

---

## Owner decision points

Implementation of a column does not start until the Owner has accepted or replaced each recommended answer. This note’s recommendation on every decision is to **keep the current columns and the current joins**.

### 1. Leave the latent shape in place

**Recommended answer:** yes, for now.

E-9 stays an open latent P1. Correct-by-discipline on the readers above is the accepted control until a later slice. This note does not close E-9.

### 2. Which tables a later slice would change

**Recommended answer:** if the Owner later approves a column, change `appraisals` and `communication_participants` together. They are the two tables named by E-9.

Also say explicitly whether `appraisal_comparable_sales` and `appraisal_market_competition` are in that same migration or stay scoped only through `assertAppraisalInBrokerage`. This note does not add those children to the E-9 finding.

### 3. What would count as closing E-9

**Recommended answer:** a `NOT NULL` `brokerage_id` foreign key to `brokerages`, backfilled from the parent, plus a database check that the stored value equals the parent’s `brokerage_id` (`properties` for appraisals, `communication_threads` for participants). Existing joins stay.

A nullable column, or a column that is allowed to disagree with the parent, does not close the finding. Application discipline alone is the status quo in decision 1, not a closure.

### 4. Party consistency

**Recommended answer:** when `party_id` is not null, `parties.brokerage_id` must equal the row’s brokerage. Today that is application code. A later migration should enforce it in the database as well.

Do not treat “party ids are globally unique” as a tenant constraint. It only prevents two brokerages from sharing one party row.

### 5. Which reads must gain a column predicate

**Recommended answer:** every read listed under “Current correct-by-discipline behaviour”, including the timeline’s `party_id`-only appraisal select and the timeline’s participant `thread_id` select. The predicate is defence in depth on top of the parent join, not a replacement for it.

This note does not edit those files.

### 6. Indexes

**Recommended answer:** keep the existing property-leading, thread-leading, and party indexes, including the partial follow-up and deferred indexes the sweep uses. A brokerage-leading index is a performance choice inside the later slice. It is not required to describe the column, and this note does not add one.

### 7. Approval and apply

**Recommended answer:** three separate Owner acts, none of which this note performs.

1. Approve the column and the constraint shape (decisions 2–6).
2. Approve the migration file in its own PR.
3. Approve apply on a named database. Merge to `staging` does not apply a migration. Production apply stays with the Project Owner.

### 8. What stays out of scope

Do not reopen E-1 (product #167; docs close is PR #169). Do not reopen historical Priority 1 or Priority 2. Do not modify I-15 timeline or index code (PR #170). Do not start E-5 (appraisal status ownership). Do not start the hard gates: A-8, G-1, G-7, B-2, C-1, C-2, H-5, F-4, live providers, production activation, launch gates, or Owner #15.

---

## What an Owner-approved remediation would need

This is the checklist for a future PR. It is not permission to write that PR.

1. **Schema.** Additive `brokerage_id` on the tables the Owner named in decision 2, `NOT NULL` after backfill, foreign key to `brokerages`. Drizzle schema and the SQL migration stay in lockstep. No other column changes.
2. **Backfill.** `appraisals.brokerage_id` from `properties.brokerage_id` via `property_id`. `communication_participants.brokerage_id` from `communication_threads.brokerage_id` via `thread_id`. Both parents are `NOT NULL` on this tip, so a missing parent is a stop, not a guessed brokerage.
3. **Parent match.** A check or trigger so the stored `brokerage_id` cannot drift from that parent. When `party_id` is set, the same check includes `parties.brokerage_id`.
4. **Writes.** Inserts set `brokerage_id` from the parent row already loaded for the tenancy check, not from an unchecked caller argument.
5. **Reads.** The paths in the behaviour section gain `brokerage_id =` in SQL and keep the parent join. The timeline stops emitting an appraisal event whose property brokerage is not the caller’s.
6. **Tests.** A foreign brokerage id still resolves as not found. A participant email or mobile match does not return a row from another brokerage. A timeline for an in-tenant party does not include an appraisal whose property is in another brokerage. Existing isolation tests stay green.
7. **Indexes.** Only if decision 6 says so. Do not drop `appraisals_property_follow_up_idx`, `appraisals_property_deferred_outcome_idx`, or `appraisals_property_updated_at_idx`.
8. **Apply.** The PR states that it does not apply the migration. Apply is decision 7.

Until those eight items are approved, the control remains the joins and gates in the behaviour section.
