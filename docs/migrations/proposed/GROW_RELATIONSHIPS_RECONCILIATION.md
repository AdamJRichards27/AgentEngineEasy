# grow_relationships → property_parties: mapping and reconciliation plan (t228u P3)

**Status: plan and read-only dry run only. No data migration is executed and none is proposed without separate Owner approval.**

## Why
Two tables relate contacts to properties:
- **`property_parties`:** Run plus the Minimal property screen. Now authoritative (PR B: `/parties/by-contact`).
- **`grow_relationships`:** Grow import, Grow manual links, appraisal integrations. It has types, status, validity dates, ownership start dates, PendingReview, and property-less rows.

t226u found that contact detail read only `grow_relationships`, so links made on the property side were invisible from the contact. PR B fixes the read. This plan aligns the data.

## Principles
1. **Nothing in grow_relationships is deleted or edited.** It keeps history (Historical, validTo), confidence, ownership-start provenance and pre-property relationships that property_parties cannot represent.
2. **Insert-only into property_parties**, and only where (property, party, role) is missing. This is idempotent and respects the proposed 0047.
3. **Brokerage-consistent only:** the grow row, its property and its party must share a brokerage; otherwise the row goes to review.
4. **Active only:** Historical, `valid_to` set and PendingReview rows stay in Grow.

## Mapping
| grow relationshipType | property_parties.role | Note |
|---|---|---|
| owner, co_owner | **Owner** | Both collapse to one Owner link per (property, party). isPrimary is the OR of the sources. |
| landlord | **Landlord** | |
| tenant | **Tenant** | |
| seller, vendor | **Seller** | ⚠ Seller links trigger ownership review and, after Ready to List, AML. A backfill must **not** run those side effects (direct insert, not via the API). Decide whether to map these at all. |
| buyer | **Buyer** | |
| occupier | — (not mapped) | Ambiguous (owner-occupier or tenant); keep in Grow. Decision. |
| former_owner, prospective_buyer, prospective_seller, appraisal_contact, investor, developer, referrer, related_party, unknown_pending_review | — (not mapped) | Grow pipeline and history semantics; keep in Grow |
| any, with property_id NULL | — | Pre-property relationship; keep |

## Genuine property links vs other relationships (t230u)
The audit (G1) puts every grow_relationships row into exactly one category:
- **`genuine_property_link`:** has a property, is Active with no `valid_to`, and its type is a current holding or party role (owner, co_owner, landlord, tenant, seller, vendor, buyer). Only these rows are candidates.
- **`other:pre_property`:** no property; a person-first relationship.
- **`other:non_link_type`:** interest, pipeline, history or third-party types (prospective_*, former_owner, appraisal_contact, investor, developer, referrer, related_party, unknown_pending_review, occupier).
- **`other:historical_or_pending`:** Historical, PendingReview, or has `valid_to`.

`other:*` rows are never copied, changed or deleted.

## Dry run
`packages/db/scripts/audit/grow-relationships-reconciliation.sql` (SELECT only; ids and counts):
- **G1:** inventory.
- **G2:** per-row classification: `insert`, `skip:already_linked`, `keep:*`, `review:brokerage_mismatch`.
- **G3:** de-duplicated rows that would be inserted, with source ids.
- **G4:** property_parties links with no Grow counterpart.

**Synthetic result** (`propertyPartiesIntegrity.test.ts`, UTC and Brisbane), 8 rows:
- **insert:**
  - owner+co_owner collapse to 1 Owner (primary carried).
  - Active tenant becomes 1 Tenant.
- **skip:** seller (already linked as Seller).
- **keep:**
  - Historical tenant.
  - prospective_buyer.
  - Property-less buyer.
- **review:** buyer on another brokerage's property.
- **Written:** nothing (property_parties count unchanged; grow rows intact).

**Staging/production: NOT RUN** (no read access in this lane).

## Proposed execution (needs separate approval)
1. Run the audit and dry run read-only per environment, then attach G1–G4.
2. Owner decides seller/vendor, occupier and the review rows.
3. Apply 0047 first, so the backfill cannot create duplicates.
4. Run a one-off script per brokerage, in one transaction:
   - Generate a `runId`.
   - `INSERT … SELECT` from G3 with `ON CONFLICT DO NOTHING RETURNING id`.
   - For each returned id, write an `audit_logs` row (`action = 'property_party_reconciled'`, `record_type = 'property_party'`, `record_id = id`, `provider_reference = runId`, `previous_value` = source grow_relationship ids).
   - No API side effects (no AML or ownership review).
   - grow_relationships is not touched.

## Rollback (reversible by construction)
- Rollback of run X is `DELETE FROM property_parties WHERE id IN (SELECT record_id::int FROM audit_logs WHERE action='property_party_reconciled' AND provider_reference = X)`. It is followed by an audit row `property_party_reconcile_rolled_back`.
- Only rows created by that run are removed:
  - Pre-existing links were skipped at insert time, so they are never in the run's list.
  - grow_relationships was never modified, so nothing needs restoring.
- R0 in the audit SQL rehearses the rollback read-only.
- **Caveat:** if a user edits a reconciled link afterwards (PATCH role or primary), rollback still deletes it. The script should refuse to roll back links whose audit trail shows a later `party_link_updated`, and list them for manual review instead.
5. Going forward:
   - Either Grow writers (`POST /grow/relationships` with a property, import) also upsert the mapped property_parties link,
   - or Grow reads property_parties for these roles.
   - Pick one, to avoid drift. **Decision.**

---

# t234u: reviewed mapping (supersedes the open decisions above)

Owner decisions (t234u item 3) and how the dry run applies them:

| grow type | Dry-run action | Why |
|---|---|---|
| owner, co_owner | insert → **Owner** (collapsed) | Genuine current holding |
| landlord | insert → **Landlord** | |
| tenant | insert → **Tenant** | |
| buyer | insert → **Buyer** | |
| seller, vendor | **review:seller_manual_no_aml**, never inserted | A Seller link can start ownership review and, after Ready to List, AML. Historical conversion must **not** trigger AML or Pit Crew activation, so these rows are listed for an agent to confirm through the normal UI, where AML runs as it does today |
| occupier | keep (type_not_mapped) | Ambiguous: preserved in Grow |
| all other types, property-less rows, Historical/PendingReview/`valid_to` rows | keep | Unrelated or ambiguous: preserved |
| brokerage mismatch | review | |

## Additional rules
- **Primary:** a converted link is primary only if the source was primary, the property has no existing primary for that role, and no other candidate for the same (property, role) also wants primary. Otherwise the link is inserted as non-primary. This matches 0049 and #285, and primary carries no legal or signing authority.
- **No side effects:** the conversion is a direct `INSERT … ON CONFLICT DO NOTHING` from G3. It never calls `/parties`, `runSellerSideEffects`, `initiateAmlIfNeeded`, `refreshReadyToListSteps`, or any Pit Crew or agreement code. Because Sellers are excluded, a later Ready-to-List refresh cannot pick up a converted Seller either.
- **No deletion or edit of grow_relationships.**
- Contacts are never merged. Shared emails and phones are legitimate (t234u item 1).

The synthetic dry run (`propertyPartiesIntegrity.test.ts`, UTC and Brisbane) covers: owner+co_owner collapsed (primary carried), two Tenants with only the single would-be primary marked, the vendor sent to review, occupier and prospective_buyer kept, the Historical tenant kept, the property-less buyer kept, and the cross-brokerage buyer sent to review. Nothing is written.

**Execution status:** not requested. It needs the env counts, then 0047/0049, then separate Owner approval.
