-- t228u READ-ONLY audit of property_parties. SELECTs only; safe on any DB.
-- Output carries ids and counts only: no names, emails, phones or addresses.
-- Run in a read-only transaction:  BEGIN READ ONLY; \i this-file; ROLLBACK;

-- D1. Duplicate (property, party, role) groups: blocks 0047 if any row.
SELECT property_id, party_id, role, count(*) AS links, array_agg(id ORDER BY id) AS link_ids,
       bool_or(is_primary) AS any_primary
FROM property_parties
GROUP BY property_id, party_id, role
HAVING count(*) > 1
ORDER BY links DESC, property_id, party_id;

-- D2. Totals for the impact report.
SELECT count(*) AS links,
       count(DISTINCT property_id) AS properties,
       count(DISTINCT party_id) AS parties,
       (SELECT count(*) FROM (SELECT 1 FROM property_parties GROUP BY property_id, party_id, role HAVING count(*) > 1) d) AS duplicate_groups,
       (SELECT coalesce(sum(n - 1), 0) FROM (SELECT count(*) AS n FROM property_parties GROUP BY property_id, party_id, role HAVING count(*) > 1) d) AS surplus_rows
FROM property_parties;

-- R1. Role values in use (0048 blocks on any value outside the list).
SELECT role, count(*) AS links,
       role IN ('Seller','Buyer','Solicitor','PowerOfAttorney','Owner','Landlord','Tenant','Other') AS allowed
FROM property_parties GROUP BY role ORDER BY links DESC;

-- I1. Cross-brokerage links (party and property in different brokerages). Expect 0.
SELECT pp.id AS link_id, pp.property_id, pp.party_id
FROM property_parties pp
JOIN properties pr ON pr.id = pp.property_id
JOIN parties pa ON pa.id = pp.party_id
WHERE pa.brokerage_id IS DISTINCT FROM pr.brokerage_id
ORDER BY pp.id;

-- P1. Properties with more than one primary for the same role (informational; not constrained).
SELECT property_id, role, count(*) AS primaries
FROM property_parties WHERE is_primary GROUP BY property_id, role HAVING count(*) > 1
ORDER BY primaries DESC;
