// I-15 index lock — property timeline predicates on domain_events and audit_logs.
//
// #103 closed the O(N²) label finds. The predicates themselves were indexed
// in migration 0028 (W1-D / #50). A later note that they "stay unindexed" is
// stale: the same CREATE INDEX names are already in that file, and a second
// copy would fail on apply. This lock fails if the read drifts away from
// those indexes, or if the indexes are dropped or declared twice.
//
// relationshipTimeline and contactIntelligence do not read these tables.
// getPropertyTimeline is the production timeline read. It filters; it does
// not ORDER BY. Sort is in memory, so a brokerage + time index is not the
// predicate these queries use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../../..");

function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  return withoutBlocks.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function readRepo(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function sliceFunction(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const next = source.indexOf("\nexport ", start + signature.length);
  return source.slice(start, next === -1 ? source.length : next);
}

const DOMAIN_INDEX = "domain_events_property_brokerage_event_type_idx";
const AUDIT_INDEX = "audit_logs_property_action_idx";

const timelineSource = stripComments(readRepo("apps/api/src/lib/timeline.ts"));
const getPropertyTimeline = sliceFunction(timelineSource, "export async function getPropertyTimeline(");

test("I-15 — getPropertyTimeline filters domain_events by property, brokerage, and event type", () => {
  const property = getPropertyTimeline.indexOf("eq(domainEvents.propertyId, propertyId)");
  const brokerage = getPropertyTimeline.indexOf("eq(domainEvents.brokerageId, brokerageId)");
  const eventType = getPropertyTimeline.indexOf("inArray(domainEvents.eventType, DOMAIN_EVENT_ENTRY_TYPES)");
  assert.ok(property !== -1 && brokerage > property && eventType > brokerage);
  assert.doesNotMatch(getPropertyTimeline, /orderBy\s*\(/);
  assert.doesNotMatch(getPropertyTimeline, /domainEvents\.occurredAt/);
  assert.doesNotMatch(getPropertyTimeline, /domainEvents\.partyId/);
});

test("I-15 — getPropertyTimeline filters audit_logs by property and action", () => {
  assert.match(
    getPropertyTimeline,
    /eq\(auditLogs\.propertyId, propertyId\),\s*inArray\(auditLogs\.action, AUDIT_LOG_ENTRY_TYPES\)/,
  );
  assert.doesNotMatch(getPropertyTimeline, /auditLogs\.brokerageId/);
  assert.doesNotMatch(getPropertyTimeline, /auditLogs\.createdAt/);
  assert.doesNotMatch(getPropertyTimeline, /orderBy\s*\(/);
});

test("I-15 — relationship timeline and contact intelligence do not read these tables", () => {
  const relationship = stripComments(readRepo("apps/api/src/lib/relationshipTimeline.ts"));
  const intelligence = stripComments(readRepo("apps/api/src/lib/contactIntelligence.ts"));
  assert.doesNotMatch(relationship, /domainEvents|auditLogs|domain_events|audit_logs/);
  assert.doesNotMatch(intelligence, /domainEvents|auditLogs|domain_events|audit_logs/);
});

test("I-15 — schema indexes match the timeline predicates and are not duplicated", () => {
  const events = readRepo("packages/db/src/schema/events.ts");
  const audit = readRepo("packages/db/src/schema/audit.ts");
  assert.match(
    events,
    /index\("domain_events_property_brokerage_event_type_idx"\)\.on\(table\.propertyId, table\.brokerageId, table\.eventType\)/,
  );
  assert.match(
    audit,
    /index\("audit_logs_property_action_idx"\)\.on\(table\.propertyId, table\.action\)/,
  );

  const migrationDir = join(repoRoot, "packages/db/migrations");
  const sqlFiles = readdirSync(migrationDir).filter((name) => name.endsWith(".sql"));
  const domainCreates: string[] = [];
  const auditCreates: string[] = [];
  for (const name of sqlFiles) {
    const sql = readFileSync(join(migrationDir, name), "utf8");
    assert.doesNotMatch(sql, new RegExp(`DROP INDEX[^;]*${DOMAIN_INDEX}`, "i"));
    assert.doesNotMatch(sql, new RegExp(`DROP INDEX[^;]*${AUDIT_INDEX}`, "i"));
    if (sql.includes(`"${DOMAIN_INDEX}"`)) domainCreates.push(name);
    if (sql.includes(`"${AUDIT_INDEX}"`)) auditCreates.push(name);
  }
  assert.deepEqual(domainCreates, ["0028_ae_grow_wave1_operability_and_scale_indexes.sql"]);
  assert.deepEqual(auditCreates, ["0028_ae_grow_wave1_operability_and_scale_indexes.sql"]);

  const migration = readRepo("packages/db/migrations/0028_ae_grow_wave1_operability_and_scale_indexes.sql");
  assert.match(
    migration,
    /CREATE INDEX "domain_events_property_brokerage_event_type_idx" ON "domain_events" USING btree \("property_id","brokerage_id","event_type"\)/,
  );
  assert.match(
    migration,
    /CREATE INDEX "audit_logs_property_action_idx" ON "audit_logs" USING btree \("property_id","action"\)/,
  );
});

test("I-15 — a migrated database has both timeline indexes", async (t) => {
  if (!process.env.DATABASE_URL) {
    t.skip("DATABASE_URL is not set. CI applies migrations before this suite; this check does not migrate.");
    return;
  }
  const { db } = await import("@aee/db");
  const { sql } = await import("drizzle-orm");
  const result = await db.execute(sql`
    select indexname, indexdef
    from pg_indexes
    where schemaname = 'public'
      and indexname in (${DOMAIN_INDEX}, ${AUDIT_INDEX})
    order by indexname`);
  const rows = result.rows as Array<{ indexname: string; indexdef: string }>;
  const byName = new Map(rows.map((row) => [row.indexname, row.indexdef.replace(/\s+/g, "")]));
  assert.equal(byName.size, 2, "migration 0028 must already be applied; this test does not create indexes");
  assert.match(byName.get(AUDIT_INDEX) ?? "", /\("property_id","action"\)/);
  assert.match(byName.get(DOMAIN_INDEX) ?? "", /\("property_id","brokerage_id","event_type"\)/);
});
