-- t234u READ-ONLY per-environment count summary for 0047/0048/0049 (one row per check).
-- Run once per environment (dev, staging, pilot, production) by an operator with
-- existing read-only access:  BEGIN READ ONLY; \i this-file; ROLLBACK;
-- Output: counts only. No ids, names, emails, phones or addresses. Attach the
-- output, labelled with the environment name and run time, to 0047-IMPACT.md.
SELECT 'D2_total_links' AS check_name, count(*)::bigint AS value FROM property_parties
UNION ALL SELECT 'D1_duplicate_groups_blocks_0047', count(*) FROM (SELECT 1 FROM property_parties GROUP BY property_id, party_id, role HAVING count(*) > 1) d
UNION ALL SELECT 'D1_surplus_rows', coalesce(sum(n - 1), 0) FROM (SELECT count(*) AS n FROM property_parties GROUP BY property_id, party_id, role HAVING count(*) > 1) d
UNION ALL SELECT 'D1_brokerages_affected', count(DISTINCT pr.brokerage_id) FROM (SELECT property_id FROM property_parties GROUP BY property_id, party_id, role HAVING count(*) > 1) d JOIN properties pr ON pr.id = d.property_id
UNION ALL SELECT 'R1_disallowed_role_rows_blocks_0048', count(*) FROM property_parties WHERE role NOT IN ('Seller','Buyer','Solicitor','PowerOfAttorney','Owner','Landlord','Tenant','Other')
UNION ALL SELECT 'P1_multi_primary_groups_blocks_0049', count(*) FROM (SELECT 1 FROM property_parties WHERE is_primary AND role <> 'Other' GROUP BY property_id, role HAVING count(*) > 1) d
UNION ALL SELECT 'I1_cross_brokerage_links', count(*) FROM property_parties pp JOIN properties pr ON pr.id = pp.property_id JOIN parties pa ON pa.id = pp.party_id WHERE pa.brokerage_id IS DISTINCT FROM pr.brokerage_id;
