-- PC fee authority duplicate check (read-only). See docs/PC_FEE_AUTHORITY_DUPLICATE_DETECTION.md.
--
-- One SELECT, no writes. Output is IDs and counts only: no names, emails,
-- mandate references or card details. Run it in a read-only session, e.g.
--   PGOPTIONS='-c default_transaction_read_only=on' psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/pc-fee-authority-duplicate-check.sql
-- Only point it at a database you are authorised to read. Table names are
-- deliberately unqualified (search_path), so the test can run it against
-- session-temporary fixture tables.
--
-- supersedes_id is only written by activatePcFeeAuthority, so a shared value
-- means two activations both replaced the same prior authority.
--
-- Rows (an empty result means nothing found):
--   MULTIPLE_ACTIVE          an agent has more than one ACTIVE authority.
--   ACTIVATED_TWICE_LEDGER   one authority has more than one PC_FEE_AUTHORITY_ACTIVATED ledger event.
--   SHARED_SUPERSEDES        more than one authority claims to supersede the same prior authority
--                            (two activations each replaced it): investigate alongside the rows above.
SELECT check_name, brokerage_id, agent_user_id, authority_ids, occurrences, ledger_event_ids
FROM (
  SELECT
    'MULTIPLE_ACTIVE'::text                       AS check_name,
    min(a.brokerage_id)                           AS brokerage_id,
    a.agent_user_id                               AS agent_user_id,
    array_agg(a.id ORDER BY a.id)                 AS authority_ids,
    count(*)::int                                 AS occurrences,
    NULL::int[]                                   AS ledger_event_ids
  FROM pc_fee_authorities a
  WHERE a.status = 'ACTIVE'
  GROUP BY a.agent_user_id
  HAVING count(*) > 1

  UNION ALL

  SELECT
    'ACTIVATED_TWICE_LEDGER'::text,
    min(e.brokerage_id),
    min(a.agent_user_id),
    array_remove(ARRAY[min(a.id)], NULL),
    count(*)::int,
    array_agg(e.id ORDER BY e.id)
  FROM financial_ledger_events e
  LEFT JOIN pc_fee_authorities a ON a.id::text = e.source_record_id
  WHERE e.event_type = 'PC_FEE_AUTHORITY_ACTIVATED'
    AND e.source_record_type = 'PC_FEE_AUTHORITY'
  GROUP BY e.source_record_id
  HAVING count(*) > 1

  UNION ALL

  SELECT
    'SHARED_SUPERSEDES'::text,
    min(a.brokerage_id),
    min(a.agent_user_id),
    array_agg(a.id ORDER BY a.id),
    count(*)::int,
    NULL::int[]
  FROM pc_fee_authorities a
  WHERE a.supersedes_id IS NOT NULL
  GROUP BY a.supersedes_id
  HAVING count(*) > 1
) findings
ORDER BY check_name, brokerage_id, agent_user_id, authority_ids;
