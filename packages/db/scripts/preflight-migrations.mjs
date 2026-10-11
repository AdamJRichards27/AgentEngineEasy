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
 *   0035 platform_owners / platform_owner_audit present when the journal
 *        when has already been passed (silent-skip hazard)
 *
 * Usage: DATABASE_URL=... node scripts/preflight-migrations.mjs
 */
import pg from "pg";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const PLATFORM_OWNER_TAG = "0035_platform_owner_access";

/**
 * Hazard C: drizzle skips 0035 when max(created_at) is already >= its
 * journal `when` (staging 0034's when is later). A fresh database, or one
 * that has not yet reached that when, must not fail — db:migrate creates
 * the tables. A database that is already past the when and is missing
 * either table must fail before migrate, which would otherwise no-op.
 */
export function platformOwnerPreflightDecision(input) {
  const entry = input.journalEntry;
  if (!entry) {
    return { outcome: "skip", message: "Journal has no 0035_platform_owner_access entry; nothing to check." };
  }
  if (input.maxCreatedAt === null || input.maxCreatedAt === undefined) {
    return {
      outcome: "skip",
      message: "No migrations recorded yet. db:migrate will apply 0035_platform_owner_access and create platform_owners and platform_owner_audit.",
    };
  }
  if (input.maxCreatedAt < entry.when) {
    return {
      outcome: "skip",
      message: `0035_platform_owner_access (when ${entry.when}) is still ahead of applied history (${input.maxCreatedAt}). db:migrate will create the platform owner tables.`,
    };
  }
  const missing = [];
  if (!input.platformOwnersExists) missing.push("platform_owners");
  if (!input.platformOwnerAuditExists) missing.push("platform_owner_audit");
  if (missing.length > 0) {
    return {
      outcome: "fail",
      message:
        `Journal contains 0035_platform_owner_access (when ${entry.when}) but ${missing.join(" and ")} ` +
        `is missing, and drizzle.__drizzle_migrations max(created_at)=${input.maxCreatedAt} is already at or past that when. ` +
        "The migrator will silently skip 0035. Restore the tables or repair the migration history before db:migrate.",
    };
  }
  return { outcome: "ok", message: "platform_owners and platform_owner_audit exist." };
}

function readPlatformOwnerJournalEntry() {
  const journal = JSON.parse(readFileSync(join(scriptDir, "../migrations/meta/_journal.json"), "utf8"));
  return journal.entries.find((entry) => entry.tag === PLATFORM_OWNER_TAG) ?? null;
}

function invokedAsCli() {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === resolve(entry);
}

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
    const journalEntry = readPlatformOwnerJournalEntry();
    let maxCreatedAt = null;
    const migrationsTable = await client.query("select to_regclass('drizzle.__drizzle_migrations') as oid");
    if (migrationsTable.rows[0]?.oid) {
      const max = await client.query("select max(created_at)::text as max from drizzle.__drizzle_migrations");
      const raw = max.rows[0]?.max;
      maxCreatedAt = raw === null || raw === undefined ? null : Number(raw);
    }
    const decision = platformOwnerPreflightDecision({
      journalEntry,
      maxCreatedAt,
      platformOwnersExists: await tableExists(client, "platform_owners"),
      platformOwnerAuditExists: await tableExists(client, "platform_owner_audit"),
    });
    if (decision.outcome === "fail") {
      blocking += 1;
      console.error(`FAIL  0035  ${decision.message}`);
    } else if (decision.outcome === "skip") {
      console.log(`SKIP  0035  ${decision.message}`);
    } else {
      console.log(`OK    0035  ${decision.message}`);
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

if (invokedAsCli()) {
  main().catch((error) => {
    console.error("Pre-flight check could not complete:", error instanceof Error ? error.message : error);
    process.exit(2);
  });
}
