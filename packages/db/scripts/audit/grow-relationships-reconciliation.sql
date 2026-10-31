-- t228u READ-ONLY dry run: how grow_relationships would map into property_parties.
-- SELECTs only. Executes NO data migration. Ids and counts only (no PII).
-- Mapping (docs/migrations/proposed/GROW_RELATIONSHIPS_RECONCILIATION.md):
--   owner, co_owner -> Owner | landlord -> Landlord | tenant -> Tenant
--   seller, vendor  -> Seller | buyer -> Buyer
--   everything else, property-less rows, and non-Active rows -> not mapped (kept as-is)

-- G1. Inventory by type and status, with/without property.
SELECT relationship_type, status, (property_id IS NOT NULL) AS has_property, count(*) AS rows
FROM grow_relationships
GROUP BY relationship_type, status, (property_id IS NOT NULL)
ORDER BY relationship_type, status, has_property;

-- G2. Per-row classification (counts).
WITH m AS (
  SELECT gr.*,
    CASE gr.relationship_type
      WHEN 'owner' THEN 'Owner' WHEN 'co_owner' THEN 'Owner'
      WHEN 'landlord' THEN 'Landlord' WHEN 'tenant' THEN 'Tenant'
      WHEN 'seller' THEN 'Seller' WHEN 'vendor' THEN 'Seller'
      WHEN 'buyer' THEN 'Buyer'
    END AS target_role
  FROM grow_relationships gr
), c AS (
  SELECT m.*,
    CASE
      WHEN m.property_id IS NULL THEN 'keep:no_property'
      WHEN m.target_role IS NULL THEN 'keep:type_not_mapped'
      WHEN m.status <> 'Active' OR m.valid_to IS NOT NULL THEN 'keep:not_active'
      WHEN pr.id IS NULL OR pa.id IS NULL
        OR pr.brokerage_id IS DISTINCT FROM m.brokerage_id
        OR pa.brokerage_id IS DISTINCT FROM m.brokerage_id THEN 'review:brokerage_mismatch'
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
-- one property_parties row, e.g. owner + co_owner both -> Owner).
WITH m AS (
  SELECT gr.id, gr.brokerage_id, gr.property_id, gr.party_id, gr.is_primary,
    CASE gr.relationship_type
      WHEN 'owner' THEN 'Owner' WHEN 'co_owner' THEN 'Owner'
      WHEN 'landlord' THEN 'Landlord' WHEN 'tenant' THEN 'Tenant'
      WHEN 'seller' THEN 'Seller' WHEN 'vendor' THEN 'Seller'
      WHEN 'buyer' THEN 'Buyer'
    END AS target_role
  FROM grow_relationships gr
  WHERE gr.property_id IS NOT NULL AND gr.status = 'Active' AND gr.valid_to IS NULL
)
SELECT m.property_id, m.party_id, m.target_role AS role, bool_or(m.is_primary) AS is_primary,
       array_agg(m.id ORDER BY m.id) AS source_grow_relationship_ids
FROM m
JOIN properties pr ON pr.id = m.property_id AND pr.brokerage_id = m.brokerage_id
JOIN parties pa ON pa.id = m.party_id AND pa.brokerage_id = m.brokerage_id
WHERE m.target_role IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM property_parties pp WHERE pp.property_id = m.property_id AND pp.party_id = m.party_id AND pp.role = m.target_role)
GROUP BY m.property_id, m.party_id, m.target_role
ORDER BY m.property_id, m.party_id, role;

-- G4. property_parties links with no grow_relationships counterpart (the gap
-- t226u found: contact detail could not see these). Informational.
SELECT pp.role, count(*) AS links
FROM property_parties pp
WHERE NOT EXISTS (SELECT 1 FROM grow_relationships gr WHERE gr.property_id = pp.property_id AND gr.party_id = pp.party_id)
GROUP BY pp.role ORDER BY links DESC;
