#!/usr/bin/env node
/**
 * Pre-flight check for migrations that can only fail on a database that
 * already holds rows. Run this against the target database BEFORE
 * `pnpm --filter @aee/db run db:migrate` on any persistent environment
 * (staging, pilot). Exits non-zero, and changes nothing, when a migration
 * would fail — so the operator fixes the data rather than discovering it
 * during a deployment.
 *
 * Covered:
 *   0020 grow_contact_channel_consents INFERRED evidence CHECK
 *   0022 documents ownership-mode CHECK
 *   0024 grow_call_transcriptions unique (call_session_id, recording_reference)
 *   0025 unique open CREATE_GROW_COMMITMENT proposal per (brokerage, resource)
 *
 * Usage: DATABASE_URL=... node scripts/preflight-migrations.mjs
 */
import pg from "pg";

const checks = [
  {
    migration: "0020",
    table: "grow_contact_channel_consents",
    description: "INFERRED consent rows must carry complete reviewed evidence",
    // Mirrors the CHECK 0020 adds: reasoning, evidence reference,
    // relationship evidence, reviewer and reviewed-at must all be present.
    sql: `select count(*)::int as count from grow_contact_channel_consents
          where state = 'INFERRED'
            and not (
              length(trim(coalesce(inferred_reasoning, ''))) > 0
              and length(trim(coalesce(evidence_reference, ''))) > 0
              and relationship_evidence is not null
              and inferred_evidence_reviewed_at is not null
              and inferred_evidence_reviewed_by_user_id is not null
            )`,
    remedy: "Complete the reviewed evidence on those rows (or remove them) before migrating.",
  },
  {
    migration: "0022",
    table: "documents",
    description: "every document is either property-backed or logically owned",
    sql: `select count(*)::int as count from documents
          where not (
            (property_id is not null and brokerage_id is null and logical_owner_type is null and logical_owner_id is null)
            or (property_id is null and package_id is null and brokerage_id is not null
                and logical_owner_type is not null and logical_owner_id is not null)
          )`,
    remedy: "Reconcile the offending document rows to exactly one ownership mode.",
  },
  {
    migration: "0024",
    table: "grow_call_transcriptions",
    description: "one transcription per (call session, recording reference)",
    sql: `select count(*)::int as count from (
            select 1 from grow_call_transcriptions
            group by call_session_id, recording_reference having count(*) > 1
          ) duplicates`,
    remedy: "Remove the duplicate transcription rows, keeping the authoritative one.",
  },
  {
    migration: "0025",
    table: "ai_action_requests",
    description: "one open CREATE_GROW_COMMITMENT proposal per (brokerage, resource)",
    sql: `select count(*)::int as count from (
            select 1 from ai_action_requests
            where action_key = 'CREATE_GROW_COMMITMENT' and resource_id is not null
              and status in ('AWAITING_APPROVAL', 'APPROVED', 'EXECUTING')
            group by action_key, brokerage_id, resource_id having count(*) > 1
          ) duplicates`,
    remedy: "Expire or reject the duplicate open proposals, keeping one per resource.",
  },
];

async function tableExists(client, table) {
  const { rows } = await client.query("select to_regclass($1) as oid", [`public.${table}`]);
  return rows[0]?.oid !== null;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set. Point it at the database you are about to migrate.");
    process.exit(2);
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  let blocking = 0;
  try {
    for (const check of checks) {
      if (!(await tableExists(client, check.table))) {
        console.log(`SKIP  ${check.migration}  ${check.table} does not exist yet (migration will create it)`);
        continue;
      }
      const { rows } = await client.query(check.sql);
      const count = rows[0]?.count ?? 0;
      if (count > 0) {
        blocking += 1;
        console.error(`FAIL  ${check.migration}  ${check.description}: ${count} conflicting row(s)`);
        console.error(`      ${check.remedy}`);
      } else {
        console.log(`OK    ${check.migration}  ${check.description}`);
      }
    }
  } finally {
    await client.end();
  }
  if (blocking > 0) {
    console.error(`\n${blocking} check(s) would fail. Do not run db:migrate until they are resolved.`);
    process.exit(1);
  }
  console.log("\nAll pre-flight checks passed; db:migrate can proceed.");
}

main().catch((error) => {
  console.error("Pre-flight check could not complete:", error instanceof Error ? error.message : error);
  process.exit(2);
});
