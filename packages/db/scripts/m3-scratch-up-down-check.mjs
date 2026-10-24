#!/usr/bin/env node
// M3 (0037_m3_offer_share_links) up / data-preservation / down / re-up check.
// LOCAL SCRATCH ONLY. Refuses any DATABASE_URL that is not a loopback host
// with a database name starting "scratch_m3". Never point this at staging or
// production: the Owner approved M3 for development and review only.
//
//   DATABASE_URL=postgres://user@127.0.0.1:PORT/scratch_m3_x node scripts/m3-scratch-up-down-check.mjs
//
// Steps (each prints PASS/FAIL; exit 1 on any FAIL):
//  1. migrate a copy of the journal truncated before 0037 (state "0036").
//  2. seed synthetic offers (tokens incl. one NULL) and fingerprint offers.
//  3. apply the real journal (0037): offers fingerprint unchanged; one active,
//     non-expiring link per non-null token with the same token and
//     issued_at = offers.created_at; no link for the NULL token.
//  4. re-run migrate: no-op (row counts unchanged).
//  5. run rollback/0037_m3_offer_share_links.down.sql: table gone, offers
//     fingerprint unchanged, 0037 bookkeeping row removed, 0036 intact.
//  6. re-apply: backfill reproduced exactly.
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
if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname) || !url.pathname.slice(1).startsWith("scratch_m3")) {
  console.error("REFUSED: DATABASE_URL must be a loopback scratch database named scratch_m3*");
  process.exit(2);
}
const TAG = "0037_m3_offer_share_links";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const db = drizzle(pool);
let failed = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const offersFingerprint = async () =>
  crypto.createHash("sha256").update(JSON.stringify(await q(`select id, property_id, buyer_party_id, offer_price_cents, conditions, status, share_token, created_at from offers order by id`))).digest("hex");

const journalPath = path.join(root, "migrations", "meta", "_journal.json");
const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
const before = journal.entries.filter((e) => e.tag < TAG);
check(journal.entries.at(-1).tag === TAG, "journal ends with " + TAG);

// 1. state 0036
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "m3-"));
fs.mkdirSync(path.join(tmp, "meta"));
for (const e of before) fs.copyFileSync(path.join(root, "migrations", `${e.tag}.sql`), path.join(tmp, `${e.tag}.sql`));
fs.writeFileSync(path.join(tmp, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: before }));
await migrate(db, { migrationsFolder: tmp });
const rows0036 = Number((await q(`select count(*)::int n from drizzle.__drizzle_migrations`))[0].n);
check(rows0036 === before.length, "state 0036 migrated", `${rows0036} bookkeeping rows`);
check((await q(`select to_regclass('public.offer_share_links') r`))[0].r === null, "offer_share_links absent before 0037");

// 2. synthetic seed (no real PII)
const [{ id: b }] = await q(`insert into brokerages(name) values('M3 Scratch Brokerage') returning id`);
const [{ id: u }] = await q(`insert into users(email, auth_provider_id, first_name, last_name, role, brokerage_id) values('m3-agent@example.invalid','m3-scratch-agent','M3','Agent','Agent',$1) returning id`, [b]);
const [{ id: p }] = await q(`insert into properties(brokerage_id, agent_id, formatted_address) values($1,$2,'1 Synthetic St, Testville') returning id`, [b, u]);
const tokens = ["a".repeat(32), "b".repeat(32), "c".repeat(32), null];
for (const [i, t] of tokens.entries()) {
  await q(`insert into offers(property_id, offer_price_cents, status, share_token, created_at) values($1,$2,$3,$4, now() - ($5 || ' days')::interval)`, [p, 50_000_000 + i, ["Received", "Declined", "Withdrawn", "Received"][i], t, String(10 - i)]);
}
const fp0 = await offersFingerprint();
check(true, "seeded 4 synthetic offers (1 without token)", fp0.slice(0, 16));

// 3. up
await migrate(db, { migrationsFolder: path.join(root, "migrations") });
check(Number((await q(`select count(*)::int n from drizzle.__drizzle_migrations`))[0].n) === journal.entries.length, "0037 applied (bookkeeping +1)");
check((await offersFingerprint()) === fp0, "offers rows byte-identical after up (tokens, statuses, prices, timestamps)");
const links = await q(`select l.offer_id, l.token, l.issued_at = o.created_at same_time, l.expires_at, l.revoked_at, o.share_token from offer_share_links l join offers o on o.id = l.offer_id order by l.offer_id`);
check(links.length === 3, "one link per non-null token", `${links.length}`);
check(links.every((l) => l.token === l.share_token && l.same_time && l.expires_at === null && l.revoked_at === null), "backfilled links: same token, issued_at = offer created_at, active, no expiry");
check(Number((await q(`select count(*)::int n from offers o where share_token is null and exists (select 1 from offer_share_links l where l.offer_id=o.id)`))[0].n) === 0, "no link for the offer without a token");

// 4. idempotent re-run
await migrate(db, { migrationsFolder: path.join(root, "migrations") });
check(Number((await q(`select count(*)::int n from offer_share_links`))[0].n) === 3, "re-running migrate is a no-op");

// 5. down
const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "migrations", `${TAG}.sql`), "utf8")).digest("hex");
const downSql = fs.readFileSync(path.join(root, "rollback", `${TAG}.down.sql`), "utf8").replace(":'m3_hash'", `'${hash}'`);
await pool.query(downSql);
check((await q(`select to_regclass('public.offer_share_links') r`))[0].r === null, "down: offer_share_links dropped");
check((await offersFingerprint()) === fp0, "down: offers rows byte-identical");
check(Number((await q(`select count(*)::int n from drizzle.__drizzle_migrations`))[0].n) === rows0036, "down: 0037 bookkeeping row removed, earlier rows intact");

// 6. re-up
await migrate(db, { migrationsFolder: path.join(root, "migrations") });
const relinks = await q(`select l.token = o.share_token same from offer_share_links l join offers o on o.id=l.offer_id`);
check(relinks.length === 3 && relinks.every((r) => r.same), "re-up after rollback reproduces the backfill");
check((await offersFingerprint()) === fp0, "re-up: offers rows byte-identical");

fs.rmSync(tmp, { recursive: true, force: true });
await pool.end();
console.log(failed ? `RESULT FAIL (${failed})` : "RESULT PASS");
process.exit(failed ? 1 : 0);
