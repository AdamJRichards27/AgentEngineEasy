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
 *   0044 one ACTIVE pc_fee_authorities row per agent (partial unique index)
 *   0035 platform_owners / platform_owner_audit present when the journal
 *        when has already been passed (silent-skip hazard)
 *   0036 appraisals / communication_participants tenant backfill: row
 *        counts, missing parents, null parent brokerages, and party rows
 *        that belong to another brokerage. Read-only. Does not add the
 *        column.
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

/**
 * Read-only decision for migration 0036. Counts are informational. Orphans,
 * a null parent brokerage, a cross-tenant party, or a null brokerage_id
 * after the column already exists are blocking. A missing parent is a stop,
 * not a guessed brokerage.
 */
export function e9TenantPreflightDecision(input) {
  if (input.appraisalsMissing && input.participantsMissing) {
    return {
      outcome: "skip",
      message: "appraisals and communication_participants do not exist yet.",
      lines: [],
    };
  }
  const lines = [];
  const blocking = [];
  if (!input.appraisalsMissing) {
    lines.push(`appraisals rows: ${input.appraisalRows}`);
    if (input.appraisalOrphans > 0) {
      blocking.push(`appraisals rows with no property parent: ${input.appraisalOrphans}`);
    }
    if (input.appraisalNullParentBrokerage > 0) {
      blocking.push(`appraisals whose property brokerage_id is null: ${input.appraisalNullParentBrokerage}`);
    }
    if (input.appraisalPartyConflicts > 0) {
      blocking.push(`appraisals whose party belongs to another brokerage: ${input.appraisalPartyConflicts}`);
    }
    if (input.appraisalBrokerageColumnPresent && input.appraisalNullBrokerage > 0) {
      blocking.push(`appraisals.brokerage_id is null: ${input.appraisalNullBrokerage}`);
    }
  } else {
    lines.push("appraisals table is missing");
  }
  if (!input.participantsMissing) {
    lines.push(`communication_participants rows: ${input.participantRows}`);
    if (input.participantOrphans > 0) {
      blocking.push(`communication_participants rows with no thread parent: ${input.participantOrphans}`);
    }
    if (input.participantNullParentBrokerage > 0) {
      blocking.push(`communication_participants whose thread brokerage_id is null: ${input.participantNullParentBrokerage}`);
    }
    if (input.participantPartyConflicts > 0) {
      blocking.push(`communication_participants whose party belongs to another brokerage: ${input.participantPartyConflicts}`);
    }
    if (input.participantBrokerageColumnPresent && input.participantNullBrokerage > 0) {
      blocking.push(`communication_participants.brokerage_id is null: ${input.participantNullBrokerage}`);
    }
  } else {
    lines.push("communication_participants table is missing");
  }
  if (blocking.length > 0) {
    return {
      outcome: "fail",
      message: `0036 would stop. ${blocking.join("; ")}. Fix those rows before db:migrate. Do not guess a brokerage.`,
      lines,
    };
  }
  return { outcome: "ok", message: "0036 tenant backfill preflight is clear.", lines };
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
  {
    migration: "0044",
    table: "pc_fee_authorities",
    description: "one ACTIVE PC fee authority per agent (pc_fee_authorities_one_active_per_agent_idx)",
    sql: `select count(*)::int as count from (
            select 1 from pc_fee_authorities
            where status = 'ACTIVE'
            group by agent_user_id having count(*) > 1
          ) duplicates`,
    remedy: "Run scripts/sql/pc-fee-authority-duplicate-check.sql, then have a Brokerage Administrator keep one ACTIVE authority per agent (mark the others REPLACED) before migrating.",
  },
];

async function countQuery(client, sql) {
  const { rows } = await client.query(sql);
  return rows[0]?.count ?? 0;
}

async function columnExists(client, table, column) {
  const { rows } = await client.query(
    `select 1 from information_schema.columns
     where table_schema = 'public' and table_name = $1 and column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

export async function readE9TenantPreflight(client) {
  const appraisalsMissing = !(await tableExists(client, "appraisals"));
  const participantsMissing = !(await tableExists(client, "communication_participants"));
  const input = {
    appraisalsMissing,
    participantsMissing,
    appraisalRows: 0,
    appraisalOrphans: 0,
    appraisalNullParentBrokerage: 0,
    appraisalPartyConflicts: 0,
    appraisalBrokerageColumnPresent: false,
    appraisalNullBrokerage: 0,
    participantRows: 0,
    participantOrphans: 0,
    participantNullParentBrokerage: 0,
    participantPartyConflicts: 0,
    participantBrokerageColumnPresent: false,
    participantNullBrokerage: 0,
  };
  if (!appraisalsMissing) {
    input.appraisalRows = await countQuery(client, "select count(*)::int as count from appraisals");
    input.appraisalOrphans = await countQuery(
      client,
      `select count(*)::int as count from appraisals a
       left join properties p on p.id = a.property_id
       where p.id is null`,
    );
    input.appraisalNullParentBrokerage = await countQuery(
      client,
      `select count(*)::int as count from appraisals a
       join properties p on p.id = a.property_id
       where p.brokerage_id is null`,
    );
    input.appraisalPartyConflicts = await countQuery(
      client,
      `select count(*)::int as count from appraisals a
       join properties p on p.id = a.property_id
       join parties y on y.id = a.party_id
       where a.party_id is not null and y.brokerage_id <> p.brokerage_id`,
    );
    input.appraisalBrokerageColumnPresent = await columnExists(client, "appraisals", "brokerage_id");
    if (input.appraisalBrokerageColumnPresent) {
      input.appraisalNullBrokerage = await countQuery(
        client,
        "select count(*)::int as count from appraisals where brokerage_id is null",
      );
    }
  }
  if (!participantsMissing) {
    input.participantRows = await countQuery(client, "select count(*)::int as count from communication_participants");
    input.participantOrphans = await countQuery(
      client,
      `select count(*)::int as count from communication_participants cp
       left join communication_threads t on t.id = cp.thread_id
       where t.id is null`,
    );
    input.participantNullParentBrokerage = await countQuery(
      client,
      `select count(*)::int as count from communication_participants cp
       join communication_threads t on t.id = cp.thread_id
       where t.brokerage_id is null`,
    );
    input.participantPartyConflicts = await countQuery(
      client,
      `select count(*)::int as count from communication_participants cp
       join communication_threads t on t.id = cp.thread_id
       join parties y on y.id = cp.party_id
       where cp.party_id is not null and y.brokerage_id <> t.brokerage_id`,
    );
    input.participantBrokerageColumnPresent = await columnExists(client, "communication_participants", "brokerage_id");
    if (input.participantBrokerageColumnPresent) {
      input.participantNullBrokerage = await countQuery(
        client,
        "select count(*)::int as count from communication_participants where brokerage_id is null",
      );
    }
  }
  return input;
}

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

    const e9 = e9TenantPreflightDecision(await readE9TenantPreflight(client));
    for (const line of e9.lines) console.log(`INFO  0036  ${line}`);
    if (e9.outcome === "fail") {
      blocking += 1;
      console.error(`FAIL  0036  ${e9.message}`);
    } else if (e9.outcome === "skip") {
      console.log(`SKIP  0036  ${e9.message}`);
    } else {
      console.log(`OK    0036  ${e9.message}`);
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
