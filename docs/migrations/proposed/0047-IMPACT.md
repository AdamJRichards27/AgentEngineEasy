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

---

# t234u update: design, audit and dry-run package (execution NOT requested yet)

The Owner approved **design, audit and dry-run testing only** (t234u item 5). Nothing here has run against any shared database.

## 1. Per-environment duplicate counts (read-only)
`packages/db/scripts/audit/property-parties-env-counts.sql` returns one row per check (`check_name`, `value`), with counts only and no ids or PII. An operator with existing read-only access runs it in each environment inside `BEGIN READ ONLY … ROLLBACK` and records the results here:

| Check | Blocks | dev | staging | pilot | production |
|---|---|---|---|---|---|
| D2_total_links | n/a | _pending_ | _pending_ | _pending_ | _pending_ |
| D1_duplicate_groups_blocks_0047 | 0047 | _pending_ | _pending_ | _pending_ | _pending_ |
| D1_surplus_rows | n/a | _pending_ | _pending_ | _pending_ | _pending_ |
| D1_brokerages_affected | n/a | _pending_ | _pending_ | _pending_ | _pending_ |
| R1_disallowed_role_rows_blocks_0048 | 0048 | _pending_ | _pending_ | _pending_ | _pending_ |
| P1_multi_primary_groups_blocks_0049 | 0049 | _pending_ | _pending_ | _pending_ | _pending_ |
| I1_cross_brokerage_links | review | _pending_ | _pending_ | _pending_ | _pending_ |

This lane has no read access, so the table cannot be filled from here. **Blocker:** an Owner-designated operator or read-only role is needed (t225u/t227u).

## 2. Reconciliation rules (applied only after separate approval, per brokerage)
1. **Duplicates (D1):** keep the lowest id in each (property, party, role) group. If any row in the group is primary, the kept row becomes primary, subject to rule 3. Before deleting the surplus rows, re-point any rows that reference them. property_parties has no inbound foreign keys today; re-check this at execution time. Write one `audit_logs` row per deleted id (`action='property_party_dedupe'`, `provider_reference=runId`, `previous_value`=full row JSON) so the step can be reversed.
2. **Disallowed roles (R1):** never auto-remap. List them for the Owner, then remap each one or map it to `Other` with the original value kept in the audit row.
3. **Multiple primaries (P1, roles other than `Other`):** keep primary on the most recently updated link, or the lowest id if tied. Demote the rest to `is_primary=false` and write an audit row for each. Primary has no legal or signing meaning, so demoting one changes no authority.
4. **Cross-brokerage (I1):** never auto-fix. These go to review with the Owner.
5. Contacts are never merged, even where emails or phones match (t234u item 1).

## 3. Migration sequence (proposed)
1. Run the env-count audit in each environment and attach the results (read-only).
2. Owner approval for the reconciliation data step, if D1, R1 or P1 is non-zero, run per brokerage in one transaction with a runId.
3. Ship the code that tolerates the index first: the `.onConflictDoNothing()` changes in `lib/offers.ts` and `lib/growAppraisalIntegrations.ts`, plus #285's one-primary API rule.
4. Apply **0047** (unique role link), then **0049** (one primary per role), then optionally **0048** (role CHECK). Each one fails closed if its precondition is not met.
5. Run the reviewed grow_relationships conversion (GROW_RELATIONSHIPS_RECONCILIATION.md) only after 0047 and 0049, so the conversion cannot create duplicates or extra primaries.
6. Re-run the env-count audit and confirm every count is 0.

## 4. Rollback plan
| Step | Rollback | Data loss |
|---|---|---|
| 0047 | `DROP INDEX IF EXISTS property_parties_property_party_role_unique;` | None |
| 0049 | `DROP INDEX IF EXISTS property_parties_one_primary_per_role;` | None |
| 0048 | `ALTER TABLE property_parties DROP CONSTRAINT IF EXISTS property_parties_role_check;` | None |
| Dedupe or primary demotion | Re-insert the rows or restore `is_primary` from `audit_logs.previous_value` for that runId | None (restored from audit) |
| grow conversion | Delete the property_parties ids recorded for that runId, refusing any link edited later (see the reconciliation doc) | None (grow_relationships is never modified) |

The code rollback is independent of all of these: the API rules work with or without the indexes.

## 5. Numbering conflict and proposal (NOT applied)
Migration numbers currently in play:
- staging journal: ends at 0036.
- #270 (M3 offer links): **0037** placeholder.
- #245: 0038–0045.
- #282: 0046.
- t229u `0047_t229u_agreement_instructions.sql` (local, wt-recon-245-282, not pushed): **0047**. This **clashes** with this PR's 0047.

**Proposal:** renumber at promotion time, in merge order. The journal `when` values must strictly increase past 0046's `1793001600000`.

| Proposed | File | Reason |
|---|---|---|
| 0047 | t229u agreement_instructions | Pit Crew agreement policy is a release blocker on the #245/#282 path, which merges first |
| 0048 | property_parties unique role (this PR's current 0047) | |
| 0049 | property_parties one primary per role (this PR's current 0049) | |
| 0050 | property_parties role CHECK (this PR's current 0048, optional) | |
| 0051 | Tap-to-Call consent (t236u), if a new table is needed | |

This is a proposal only. No file has been renamed, because doing so would only cause churn until the merge order is approved.
