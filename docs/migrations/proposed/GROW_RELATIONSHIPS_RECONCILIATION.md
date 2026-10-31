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
4. Run a one-off script: `INSERT … SELECT` from G3 with `ON CONFLICT DO NOTHING` per brokerage, logging source ids to `audit_logs`. No side effects. Reversible by deleting rows created by that run id.
5. Going forward:
   - Either Grow writers (`POST /grow/relationships` with a property, import) also upsert the mapped property_parties link,
   - or Grow reads property_parties for these roles.
   - Pick one, to avoid drift. **Decision.**
