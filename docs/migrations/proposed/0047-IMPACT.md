# Proposed 0047 / 0048: property_parties integrity (t228u Priority 3)

**Status: PREPARED, NOT APPLIED.** The SQL lives in `docs/migrations/proposed/`, outside `packages/db/migrations/` and the journal, so `db:migrate` cannot run it. No database (staging, pilot, shared or production) has been touched. The only execution was inside rolled-back transactions on a throwaway local PG16 with synthetic rows, and the DDL there ran against a session-temporary shadow copy (`propertyPartiesIntegrity.test.ts`).

## What changes
| File | Effect | Blocking precondition |
|---|---|---|
| `0047_property_parties_unique_role.sql` | `UNIQUE (property_id, party_id, role)` index `property_parties_property_party_role_unique`. A guard block aborts if any duplicate group exists. | Audit D1 = 0 rows |
| `0048_property_parties_role_check.sql` (optional) | `CHECK role IN (Seller, Buyer, Solicitor, PowerOfAttorney, Owner, Landlord, Tenant, Other)`, NOT VALID then VALIDATE | Audit R1 has no `allowed = false` row |

**Owner, Landlord and Tenant need no migration.** `property_parties.role` is `text`, not a Postgres enum. This PR adds them to API validation (`POST /parties`) and the UI role lists only. 0048 is an optional hardening step, not a requirement.

## Audit (read-only)
Run `packages/db/scripts/audit/property-parties-audit.sql` inside `BEGIN READ ONLY … ROLLBACK`. The output has ids and counts only; no PII.
- **D1:** duplicate groups (blocks 0047).
- **D2:** totals and surplus rows.
- **R1:** role values (blocks 0048).
- **I1:** cross-brokerage links (expected 0).
- **P1:** more than one primary per (property, role); informational.

**Synthetic result (throwaway DB):** a deliberately created duplicate was reported by D1 and blocked 0047 (`RAISE`, nothing changed). After that one synthetic row was removed inside the transaction, 0047 applied and refused a second `(property, party, Buyer)`. 0048 refused `Occupier`. Everything rolled back, and afterwards neither the index nor the constraint existed.

**Staging/production counts: NOT RUN.** There is no read access in this lane (t225u). An operator with existing read-only access runs the audit file and attaches the output here before approval.

## Code paths that write property_parties (read-only analysis)
| Writer | Today | With 0047 |
|---|---|---|
| `POST /parties` (link existing) | FOR UPDATE on the property + check → 409 | Unchanged; the index is a backstop |
| `POST /parties` (create + link) | New party id, so it cannot duplicate | Unchanged |
| `PATCH /parties/link/:id` (PR B) | FOR UPDATE + clash check → 409 | Unchanged; backstop |
| `lib/offers.ts:83` (buyer link on offer) | Check-then-insert, **no lock**: two concurrent offers for one buyer could duplicate | The losing racer gets a unique violation (500). **Recommend `.onConflictDoNothing()` in the same change that promotes 0047.** |
| `lib/growAppraisalIntegrations.ts:520` (Seller on agreement) | Check-then-insert, no lock | Same as above; recommend `.onConflictDoNothing()` |
| Readers | | Unaffected; they never assume duplicates |

**Lock and time:** `CREATE UNIQUE INDEX` (not CONCURRENTLY, because drizzle runs migrations in a transaction) takes a SHARE lock on `property_parties` for the build. The table is small (one row per property contact), so this is expected to be well under a second. If D2 shows more than about 1M rows, use a CONCURRENTLY variant outside a transaction instead.

**Rollback:** `DROP INDEX IF EXISTS property_parties_property_party_role_unique;` and `ALTER TABLE property_parties DROP CONSTRAINT IF EXISTS property_parties_role_check;`. Neither drops data.

## If D1 is not empty
Do not auto-delete. For each group, keep the lowest id. If any row in the group is primary, set `is_primary` on the kept row. Delete the rest, reviewing their audit trail first. This is a **data migration needing separate Owner approval**, run per brokerage with the D1 output attached.

## Numbering and ordering (flag)
- Staging's journal ends at **0036**.
- #245 brings 0038–0045, and #282 brings 0046 (`when` 1793001600000). **0037 is not on staging or in either PR** (gap; confirm owner).
- These files are numbered **0047/0048** per t228u.
- On promotion, the journal `when` must be **greater than 0046's 1793001600000**. Otherwise drizzle can skip the migration silently (the 0035 hazard in `preflight-migrations.mjs`).
- They must be promoted after #245 and #282 merge.
- Add D1/R1 checks to `preflight-migrations.mjs` at the same time.
