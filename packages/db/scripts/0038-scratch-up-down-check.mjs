#!/usr/bin/env node
// 0038_financial_amendment_authorities up / constraints / down / re-up check.
// LOCAL SCRATCH ONLY (Owner t174u: write the migration and test it on local
// scratch databases only). Refuses any DATABASE_URL that is not a loopback
// host with a database name starting "scratch_0038". Never point this at
// Replit, staging, production or any shared database.
//
//   DATABASE_URL=postgres://user@127.0.0.1:PORT/scratch_0038_x node scripts/0038-scratch-up-down-check.mjs
//
// Steps (each prints PASS/FAIL; exit 1 on any FAIL):
//  1. migrate a copy of the journal truncated before 0038 (state "0036").
//  2. seed synthetic rows and fingerprint the existing tables 0038 references.
//  3. ordering: record a simulated M3 (0037, when 1792837396131) bookkeeping
//     row, then apply the real journal: 0038 is APPLIED, not skipped.
//  4. constraints: scope, grantor role, evidence, expiry, target pair, revoke
//     pair and self-grant CHECKs reject bad rows; a valid grant inserts.
//  5. re-run migrate: no-op.
//  6. rollback/0038_financial_amendment_authorities.down.sql: table gone,
//     referenced tables byte-identical, only 0038's bookkeeping row removed.
//  7. re-apply: table back, empty, constraints present.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const url = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname) || !url.pathname.slice(1).startsWith("scratch_0038")) {
  console.error("REFUSED: DATABASE_URL must be a loopback scratch database named scratch_0038*");
  process.exit(2);
}
const TAG = "0038_financial_amendment_authorities";
const M3_WHEN = 1792837396131;
const REFUND_LEDGER_WHEN = 1792530000000;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const db = drizzle(pool);
let failed = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const fingerprint = async () => {
  const parts = [];
  for (const t of ["brokerages", "users", "properties", "transactions", "documents", "audit_logs"]) {
    parts.push(JSON.stringify(await q(`select * from ${t} order by id`)));
  }
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
};
const accepts = async (label, sql, params) => {
  try {
    await q(sql, params);
    check(true, label);
    await q(`delete from financial_amendment_authorities`);
  } catch (e) {
    check(false, label, e.code);
  }
};
const rejects = async (label, sql, params) => {
  try {
    await q(sql, params);
    check(false, label, "insert unexpectedly succeeded");
  } catch (e) {
    check(e.code === "23514" || e.code === "23503", label, e.code);
  }
};

const journal = JSON.parse(fs.readFileSync(path.join(root, "migrations", "meta", "_journal.json"), "utf8"));
const entry = journal.entries.find((e) => e.tag === TAG);
check(journal.entries.at(-1).tag === TAG, "journal ends with " + TAG);
check(entry && entry.idx === 38, "journal idx 38");
check(entry && entry.when > M3_WHEN, "0038 when is later than M3 0037 when", `${entry?.when} > ${M3_WHEN}`);
check(entry && entry.when > Math.max(...journal.entries.filter((e) => e.tag !== TAG).map((e) => e.when)), "0038 when is later than every earlier journal entry");
console.log(`NOTE refund ledger 0037_payment_refunds when ${REFUND_LEDGER_WHEN} < ${entry?.when}: it must be renumbered 0039+ with a later when, or a DB that applied 0038 skips it silently.`);
const before = journal.entries.filter((e) => e.tag < TAG);

// 1. state 0036
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "m38-"));
fs.mkdirSync(path.join(tmp, "meta"));
for (const e of before) fs.copyFileSync(path.join(root, "migrations", `${e.tag}.sql`), path.join(tmp, `${e.tag}.sql`));
fs.writeFileSync(path.join(tmp, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: before }));
await migrate(db, { migrationsFolder: tmp });
const rowsBefore = Number((await q(`select count(*)::int n from drizzle.__drizzle_migrations`))[0].n);
check(rowsBefore === before.length, "state 0036 migrated", `${rowsBefore} bookkeeping rows`);
check((await q(`select to_regclass('public.financial_amendment_authorities') r`))[0].r === null, "table absent before 0038");

// 2. synthetic seed (no real PII)
const [{ id: b }] = await q(`insert into brokerages(name) values('0038 Scratch Brokerage') returning id`);
const mkUser = async (tag, role) =>
  (await q(`insert into users(email, auth_provider_id, first_name, last_name, role, brokerage_id) values($1,$2,'S',$3,$4,$5) returning id`, [`${tag}@example.invalid`, `m38-${tag}`, tag, role, b]))[0].id;
const agent = await mkUser("agent", "Agent");
const crew = await mkUser("crew", "Pit Crew");
const [{ id: p }] = await q(`insert into properties(brokerage_id, agent_id, formatted_address) values($1,$2,'38 Synthetic St, Testville') returning id`, [b, agent]);
const [{ id: t }] = await q(`insert into transactions(property_id, status, seller_party_ids, buyer_party_ids, purchase_price_cents) values($1,'ContractPreparation','[]','[]',80000000) returning id`, [p]);
await q(`insert into audit_logs(brokerage_id, user_id, action, record_type, record_id) values($1,$2,'scratch_seed','transaction',$3)`, [b, agent, String(t)]);
const fp0 = await fingerprint();
check(true, "seeded synthetic brokerage, users, property, transaction, audit row", fp0.slice(0, 16));

// 3. ordering: simulate a DB that has applied M3 (0037) first
await q(`insert into drizzle.__drizzle_migrations(hash, created_at) values('simulated-m3-0037', $1)`, [M3_WHEN]);
await migrate(db, { migrationsFolder: path.join(root, "migrations") });
check((await q(`select to_regclass('public.financial_amendment_authorities') r`))[0].r !== null, "0038 applied after a simulated M3 row (not skipped)");
check(Number((await q(`select count(*)::int n from drizzle.__drizzle_migrations`))[0].n) === rowsBefore + 2, "bookkeeping: simulated M3 + 0038");
check((await fingerprint()) === fp0, "up: referenced tables byte-identical");

// 4. constraints
const base = `insert into financial_amendment_authorities(brokerage_id, property_id, transaction_id, grantee_user_id, granted_by_user_id, granted_by_role, scope, target_record_type, target_record_id, evidence_document_id, evidence_note, expires_at, revoked_at, revoked_by_user_id)`;
const vals = (o = {}) => {
  const d = { grantee: crew, grantor: agent, role: "Agent", scope: "AGENCY_TERMS", tt: null, ti: null, doc: null, note: "Signed instruction 25 Oct", exp: "now() + interval '7 days'", ra: null, rb: null, ...o };
  return [`${base} values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${d.exp},$12,$13)`, [b, p, t, d.grantee, d.grantor, d.role, d.scope, d.tt, d.ti, d.doc, d.note, d.ra, d.rb]];
};
await rejects("CHECK scope (INVOICE rejected)", ...vals({ scope: "INVOICE" }));
await accepts("CHECK scope accepts COMMISSION_AGREEMENT (t177u)", ...vals({ scope: "COMMISSION_AGREEMENT" }));
await accepts("CHECK scope accepts COMMISSION_CALCULATION (t177u)", ...vals({ scope: "COMMISSION_CALCULATION" }));
await rejects("CHECK grantor role (Pit Crew rejected)", ...vals({ role: "Pit Crew" }));
await rejects("CHECK evidence required (no document, blank note)", ...vals({ note: "   " }));
await rejects("CHECK expiry after creation", ...vals({ exp: "now() - interval '1 minute'" }));
await rejects("CHECK target type and id together", ...vals({ tt: "campaign_item" }));
await rejects("CHECK revoked_at and revoked_by together", ...vals({ ra: new Date() }));
await rejects("CHECK no self-grant", ...vals({ grantee: agent }));
await rejects("FK transaction must exist", `${base} values($1,$2,999999999,$3,$4,'Agent','AGENCY_TERMS',null,null,null,'x',now()+interval '1 day',null,null)`, [b, p, crew, agent]);
await q(...vals());
check(Number((await q(`select count(*)::int n from financial_amendment_authorities`))[0].n) === 1, "valid grant inserts");
const idx = (await q(`select indexname from pg_indexes where tablename='financial_amendment_authorities' order by 1`)).map((r) => r.indexname);
check(["fin_amend_auth_brokerage_created_idx", "fin_amend_auth_grantee_txn_scope_idx", "fin_amend_auth_transaction_idx"].every((i) => idx.includes(i)), "lookup indexes present", idx.join(","));
await q(`delete from financial_amendment_authorities`);

// 5. idempotent re-run
await migrate(db, { migrationsFolder: path.join(root, "migrations") });
check(Number((await q(`select count(*)::int n from drizzle.__drizzle_migrations`))[0].n) === rowsBefore + 2, "re-running migrate is a no-op");

// 6. down
const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "migrations", `${TAG}.sql`), "utf8")).digest("hex");
const downSql = fs.readFileSync(path.join(root, "rollback", `${TAG}.down.sql`), "utf8").replace(":'m38_hash'", `'${hash}'`);
await pool.query(downSql);
check((await q(`select to_regclass('public.financial_amendment_authorities') r`))[0].r === null, "down: table dropped");
check((await fingerprint()) === fp0, "down: referenced tables byte-identical");
check(Number((await q(`select count(*)::int n from drizzle.__drizzle_migrations`))[0].n) === rowsBefore + 1, "down: only 0038 bookkeeping row removed (earlier + simulated M3 intact)");

// 7. re-up
await migrate(db, { migrationsFolder: path.join(root, "migrations") });
check((await q(`select to_regclass('public.financial_amendment_authorities') r`))[0].r !== null, "re-up: table recreated");
check(Number((await q(`select count(*)::int n from financial_amendment_authorities`))[0].n) === 0, "re-up: empty");
check(Number((await q(`select count(*)::int n from pg_constraint where conrelid='public.financial_amendment_authorities'::regclass and contype='c'`))[0].n) === 7, "re-up: 7 CHECK constraints");
check((await fingerprint()) === fp0, "re-up: referenced tables byte-identical");

fs.rmSync(tmp, { recursive: true, force: true });
await pool.end();
console.log(failed ? `RESULT FAIL (${failed})` : "RESULT PASS");
process.exit(failed ? 1 : 0);
