-- t228u/t244u READ-ONLY dry run: how grow_relationships would map into property_parties.
-- SELECTs only. Executes NO data migration. Ids and counts only (no PII).
-- t244u AUTHORITATIVE mapping (docs/migrations/proposed/GROW_RELATIONSHIPS_RECONCILIATION.md):
--   property_parties holds ONLY property-specific relationships. Auto-conversion
--   candidates are owner -> Owner, tenant -> Tenant, landlord -> Landlord,
--   buyer -> Buyer, and ONLY when Active, no valid_to, and the property is VERIFIED
--   (exists, same brokerage as row and party, confidence_score NULL (manual) or >= 0.9).
--   review: co_owner, former_owner, occupier, appraisal_contact, seller, vendor,
--           investor, developer, related_party, unknown*, unrecognised types,
--           unverified property, brokerage mismatch
--   prospecting: prospective_buyer, prospective_seller
--   person_level: referrer
--   opportunity_intelligence: any row without a property (stays in Grow)
--   NEVER mapped to Other. No Seller/Vendor conversion, so no AML or Pit Crew triggers.
-- A converted row is primary only when it would be the ONLY primary for that (property, role).

-- G1. Inventory, classifying each row as a GENUINE PROPERTY LINK (a current,
-- property-bound holding/party role that property_parties can represent) or
-- OTHER (pipeline/interest, history, pre-property, or unresolved). Only
-- genuine_property_link rows are ever candidates for consolidation.
SELECT
  CASE
    WHEN property_id IS NULL THEN 'other:pre_property'
    WHEN relationship_type NOT IN ('owner','landlord','tenant','buyer') THEN 'other:non_link_type'
    WHEN status <> 'Active' OR valid_to IS NOT NULL THEN 'other:historical_or_pending'
    ELSE 'genuine_property_link'
  END AS category,
  relationship_type, status, count(*) AS rows
FROM grow_relationships
GROUP BY 1, relationship_type, status
ORDER BY 1, relationship_type, status;

-- G2. Per-row classification (counts).
WITH m AS (
  SELECT gr.*,
    CASE gr.relationship_type
      WHEN 'owner' THEN 'Owner' WHEN 'landlord' THEN 'Landlord'
      WHEN 'tenant' THEN 'Tenant' WHEN 'buyer' THEN 'Buyer'
    END AS target_role
  FROM grow_relationships gr
), c AS (
  SELECT m.*,
    CASE
      WHEN m.relationship_type IN ('prospective_buyer','prospective_seller') THEN 'prospecting'
      WHEN m.relationship_type = 'referrer' THEN 'person_level'
      WHEN m.property_id IS NULL THEN 'opportunity_intelligence:no_property'
      WHEN m.relationship_type IN ('seller','vendor') THEN 'review:seller_vendor_no_aml'
      WHEN m.relationship_type IN ('co_owner','former_owner','occupier','appraisal_contact','investor','developer','related_party')
        THEN 'review:' || m.relationship_type
      WHEN m.relationship_type LIKE 'unknown%' THEN 'review:unknown'
      WHEN m.target_role IS NULL THEN 'review:unrecognised_type'
      WHEN m.status <> 'Active' OR m.valid_to IS NOT NULL THEN 'keep:not_active'
      WHEN pr.id IS NULL OR pa.id IS NULL
        OR pr.brokerage_id IS DISTINCT FROM m.brokerage_id
        OR pa.brokerage_id IS DISTINCT FROM m.brokerage_id THEN 'review:brokerage_mismatch'
      WHEN m.confidence_score IS NOT NULL AND m.confidence_score < 0.9 THEN 'review:unverified_property'
      WHEN EXISTS (SELECT 1 FROM property_parties pp WHERE pp.property_id = m.property_id AND pp.party_id = m.party_id AND pp.role = m.target_role)
        THEN 'skip:already_linked'
      ELSE 'insert'
    END AS action
  FROM m
  LEFT JOIN properties pr ON pr.id = m.property_id
  LEFT JOIN parties pa ON pa.id = m.party_id
)
SELECT action, target_role, count(*) AS rows FROM c GROUP BY action, target_role ORDER BY action, target_role;

-- G3. Rows that would be inserted, de-duplicated (several grow rows can map to
-- one property_parties row, e.g. two Active owner rows for the same party and property).
WITH m AS (
  SELECT gr.id, gr.brokerage_id, gr.property_id, gr.party_id, gr.is_primary, gr.confidence_score,
    CASE gr.relationship_type
      WHEN 'owner' THEN 'Owner' WHEN 'landlord' THEN 'Landlord'
      WHEN 'tenant' THEN 'Tenant' WHEN 'buyer' THEN 'Buyer'
    END AS target_role
  FROM grow_relationships gr
  WHERE gr.property_id IS NOT NULL AND gr.status = 'Active' AND gr.valid_to IS NULL
)
, cand AS (
  SELECT m.property_id, m.party_id, m.target_role AS role, bool_or(m.is_primary) AS wants_primary,
         array_agg(m.id ORDER BY m.id) AS source_grow_relationship_ids
  FROM m
  JOIN properties pr ON pr.id = m.property_id AND pr.brokerage_id = m.brokerage_id
  JOIN parties pa ON pa.id = m.party_id AND pa.brokerage_id = m.brokerage_id
  WHERE m.target_role IS NOT NULL
    AND (m.confidence_score IS NULL OR m.confidence_score >= 0.9)
    AND NOT EXISTS (SELECT 1 FROM property_parties pp WHERE pp.property_id = m.property_id AND pp.party_id = m.party_id AND pp.role = m.target_role)
  GROUP BY m.property_id, m.party_id, m.target_role
)
SELECT c.property_id, c.party_id, c.role,
       (c.wants_primary
         AND NOT EXISTS (SELECT 1 FROM property_parties pp WHERE pp.property_id = c.property_id AND pp.role = c.role AND pp.is_primary)
         AND (SELECT count(*) FROM cand c2 WHERE c2.property_id = c.property_id AND c2.role = c.role AND c2.wants_primary) = 1) AS is_primary,
       c.source_grow_relationship_ids
FROM cand c
ORDER BY c.property_id, c.party_id, c.role;

-- G4. property_parties links with no grow_relationships counterpart (the gap
-- t226u found: contact detail could not see these). Informational.
SELECT pp.role, count(*) AS links
FROM property_parties pp
WHERE NOT EXISTS (SELECT 1 FROM grow_relationships gr WHERE gr.property_id = pp.property_id AND gr.party_id = pp.party_id)
GROUP BY pp.role ORDER BY links DESC;

-- R0. ROLLBACK REHEARSAL (read-only). An approved consolidation run would tag
-- each inserted property_parties row via an audit_logs entry
-- (action 'property_party_reconciled', record_id = property_parties.id,
-- provider_reference = runId). Rolling back = delete
-- exactly the property_parties ids recorded for that runId and nothing else.
-- This query shows what such a rollback would remove for a given run id.
-- (No run has ever executed, so it returns 0 rows.)
SELECT al.record_id AS property_party_id
FROM audit_logs al
WHERE al.action = 'property_party_reconciled'
  AND al.provider_reference = 'REPLACE-WITH-RUN-ID';
