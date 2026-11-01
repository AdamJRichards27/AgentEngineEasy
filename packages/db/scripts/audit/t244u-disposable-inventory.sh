#!/usr/bin/env bash
# t244u: disposable loopback PG16 only. Synthetic data. Runs the read-only inventory
# (G1/G2/G3/G4 aggregates from #284's dry run), then rehearses proposed 0050 (additive
# provenance) + its rollback. The DB is deleted on exit.
set -euo pipefail
export PATH=/home/box/.local/bin:/workspace/tools/node-v24.22.0-linux-x64/bin:$PATH
PGBIN=/usr/lib/postgresql/16/bin; WT=/workspace/run-lane/wt-t228-c
port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
data=$(mktemp -d); $PGBIN/initdb -D $data -U e2e --auth=trust >/dev/null
$PGBIN/pg_ctl -D $data -o "-p $port -h 127.0.0.1 -k $data" -l $data/pg.log start -w >/dev/null
trap '$PGBIN/pg_ctl -D $data stop -m fast >/dev/null; rm -rf $data' EXIT
export DATABASE_URL="postgresql://e2e@127.0.0.1:$port/postgres"
(cd $WT/packages/db && npx tsx src/migrate.ts) >/dev/null 2>$data/mig.err || { tail -5 $data/mig.err; exit 1; }
P="psql -X -q -h 127.0.0.1 -p $port -U e2e postgres -v ON_ERROR_STOP=1"
$P <<'SQL'
-- SYNTHETIC fixture: 2 brokerages, 6 properties, 40 parties, 120 grow rows across every type/status.
INSERT INTO brokerages (name) VALUES ('SYNTH-A'),('SYNTH-B');
INSERT INTO users (auth_provider_id, email, brokerage_id) SELECT 'synth-'||b.id, 'synth'||b.id||'@example.invalid', b.id FROM brokerages b;
INSERT INTO properties (brokerage_id, agent_id, formatted_address) SELECT u.brokerage_id, u.id, 'SYNTH '||g||' Example St' FROM users u, generate_series(1,3) g;
INSERT INTO parties (brokerage_id, first_name) SELECT b.id, 'Synth'||g FROM brokerages b, generate_series(1,20) g;
WITH types(t) AS (VALUES ('owner'),('co_owner'),('tenant'),('landlord'),('buyer'),('seller'),('vendor'),('former_owner'),('occupier'),('appraisal_contact'),('investor'),('developer'),('related_party'),('unknown_pending_review'),('prospective_buyer'),('prospective_seller'),('referrer'),('owner'),('tenant'),('buyer'))
INSERT INTO grow_relationships (brokerage_id, party_id, property_id, relationship_type, status, is_primary, confidence_score, valid_to)
SELECT pa.brokerage_id, pa.id,
  CASE WHEN n % 7 = 0 THEN NULL ELSE (SELECT id FROM properties pr WHERE pr.brokerage_id = CASE WHEN n % 11 = 0 THEN 3 - pa.brokerage_id ELSE pa.brokerage_id END ORDER BY id OFFSET (n % 3) LIMIT 1) END,
  t, CASE WHEN n % 5 = 0 THEN 'Historical' WHEN n % 13 = 0 THEN 'PendingReview' ELSE 'Active' END,
  n % 4 = 0, CASE WHEN n % 6 = 0 THEN 0.5 ELSE NULL END, CASE WHEN n % 17 = 0 THEN now() ELSE NULL END
FROM (SELECT row_number() OVER () AS n, t FROM types, generate_series(1,6)) x
JOIN parties pa ON pa.id = 1 + (x.n % 40);
SQL
echo "== synthetic grow_relationships rows: $($P -t -c 'SELECT count(*) FROM grow_relationships')"
echo "== INVENTORY (read-only transaction; aggregates only)"
$P -c "BEGIN READ ONLY" -f $WT/packages/db/scripts/audit/grow-relationships-reconciliation.sql -c "ROLLBACK" 2>&1 | sed -n '1,400p' | awk 'BEGIN{q=0} /property_id \| party_id/{skip=1} skip&&/^\(/{skip=0; print "(G3 row-level output suppressed; count above)"; next} !skip'
echo "== G3 candidate count: $($P -t -c "SELECT count(*) FROM ($(sed -n '/^-- G3/,/^-- G4/p' $WT/packages/db/scripts/audit/grow-relationships-reconciliation.sql | grep -v '^--' | sed 's/;\s*$//')) z")"
echo "== Never Other / never Seller check:"; $P -t -c "SELECT count(*) FROM ($(sed -n '/^-- G3/,/^-- G4/p' $WT/packages/db/scripts/audit/grow-relationships-reconciliation.sql | grep -v '^--' | sed 's/;\s*$//')) z WHERE role IN ('Other','Seller')"
echo "== 0050 rehearsal"
BEFORE=$($P -t -c "SELECT md5(string_agg(column_name||data_type, ',' ORDER BY column_name)) FROM information_schema.columns WHERE table_name='property_parties'")
$P -f $WT/docs/migrations/proposed/0050_property_parties_provenance.sql
$P -f $WT/docs/migrations/proposed/0050_property_parties_provenance.sql && echo "re-apply idempotent: OK"
$P -c "BEGIN; INSERT INTO property_parties (property_id, party_id, role) VALUES (1, 1, 'Buyer'); ROLLBACK;" && echo "existing writer shape still works: OK"
G3=$(sed -n '/^-- G3/,/^-- G4/p' $WT/packages/db/scripts/audit/grow-relationships-reconciliation.sql | grep -v '^--' | sed 's/;\s*$//')
echo "== CONVERSION REHEARSAL (disposable only): insert G3 with provenance + audit tag, then roll back by runId"
PP0=$($P -t -c "SELECT count(*) FROM property_parties")
$P <<SQL
BEGIN;
WITH g3 AS ($G3), ins AS (
  INSERT INTO property_parties (property_id, party_id, role, is_primary, relationship_status, valid_from, valid_to, ownership_start_date, confidence_score, role_detail, source_grow_relationship_ids)
  SELECT g3.property_id, g3.party_id, g3.role, g3.is_primary, 'Active', min(gr.valid_from), NULL, min(gr.ownership_start_date), max(gr.confidence_score), max(gr.role), g3.source_grow_relationship_ids
  FROM g3 JOIN grow_relationships gr ON gr.id = ANY(g3.source_grow_relationship_ids)
  GROUP BY g3.property_id, g3.party_id, g3.role, g3.is_primary, g3.source_grow_relationship_ids
  RETURNING id, source_grow_relationship_ids)
INSERT INTO audit_logs (action, record_type, record_id, provider_reference, previous_value)
SELECT 'property_party_reconciled', 'property_party', id::text, 'synthetic-run-1', jsonb_build_object('source_grow_relationship_ids', source_grow_relationship_ids) FROM ins;
COMMIT;
SQL
echo "inserted: $(($($P -t -c "SELECT count(*) FROM property_parties") - PP0)), with provenance: $($P -t -c "SELECT count(*) FROM property_parties WHERE source_grow_relationship_ids IS NOT NULL")"
echo "AML/Pit Crew side effects: none (direct INSERT; no Seller rows: $($P -t -c "SELECT count(*) FROM property_parties WHERE source_grow_relationship_ids IS NOT NULL AND role IN ('Seller','Other')"))"
$P -c "DELETE FROM property_parties WHERE id IN (SELECT record_id::int FROM audit_logs WHERE action='property_party_reconciled' AND provider_reference='synthetic-run-1')"
echo "after rollback: property_parties delta = $(($($P -t -c "SELECT count(*) FROM property_parties") - PP0))"
$P -t -c "SELECT count(*) FROM information_schema.columns WHERE table_name='property_parties' AND column_name IN ('relationship_status','valid_from','valid_to','ownership_start_date','confidence_score','role_detail','source_grow_relationship_ids')" | sed 's/^/added columns: /'
$P -c "ALTER TABLE property_parties DROP COLUMN IF EXISTS source_grow_relationship_ids, DROP COLUMN IF EXISTS role_detail, DROP COLUMN IF EXISTS confidence_score, DROP COLUMN IF EXISTS ownership_start_date, DROP COLUMN IF EXISTS valid_to, DROP COLUMN IF EXISTS valid_from, DROP COLUMN IF EXISTS relationship_status"
AFTER=$($P -t -c "SELECT md5(string_agg(column_name||data_type, ',' ORDER BY column_name)) FROM information_schema.columns WHERE table_name='property_parties'")
[ "$BEFORE" = "$AFTER" ] && echo "rollback restores the original column set: OK" || echo "rollback MISMATCH"
echo "== grow_relationships untouched: $($P -t -c 'SELECT count(*) FROM grow_relationships') rows"
