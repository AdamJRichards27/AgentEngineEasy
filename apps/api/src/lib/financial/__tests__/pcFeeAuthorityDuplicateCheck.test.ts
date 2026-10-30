// scripts/sql/pc-fee-authority-duplicate-check.sql (CC #57): the read-only
// detection script finds agents with more than one ACTIVE PC fee authority and
// authorities activated more than once, and reports nothing for clean data.
//
// Local throwaway test DB ONLY: the suite refuses to run unless DATABASE_URL
// points at a loopback host and NODE_ENV=test. Every run of the script happens
// inside a READ ONLY transaction.
//
// Exact cases run against empty session-temporary copies of the two tables,
// which shadow the real ones (pg_temp comes first on the search_path and the
// script uses unqualified names). Postgres allows writes to temporary tables
// inside a READ ONLY transaction, so each case seeds, runs the script and rolls
// back, and the output is exact, unaffected by other test files sharing the DB.
// A final case runs against the real tables, through the real activation path.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
// (pool client type taken from @aee/db: pg ships no declarations here)
import { eq } from "drizzle-orm";
import { db, pcFeeAuthorities, pool } from "@aee/db";
/** The pooled client the race test already uses (pg ships no declarations here). */
async function connect() {
  return pool.connect();
}
type PoolClient = Awaited<ReturnType<typeof connect>>;
import { createBrokerageWithUsers, devLogin, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";
import { createPcFeeAuthority, activatePcFeeAuthority } from "../pcFeeAuthorities.js";

const SCRIPT_PATH = fileURLToPath(new URL("../../../../../../scripts/sql/pc-fee-authority-duplicate-check.sql", import.meta.url));
const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");

type Finding = {
  check_name: "MULTIPLE_ACTIVE" | "ACTIVATED_TWICE_LEDGER" | "SHARED_SUPERSEDES";
  brokerage_id: number | null;
  agent_user_id: number | null;
  authority_ids: number[];
  occurrences: number;
  ledger_event_ids: number[] | null;
};
const COLUMNS = ["check_name", "brokerage_id", "agent_user_id", "authority_ids", "occurrences", "ledger_event_ids"];

/** Refuse anything that is not a local throwaway test database. */
function assertLocalTestDatabase(): void {
  const raw = process.env.DATABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(raw).hostname;
  } catch {
    host = "";
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  if (process.env.NODE_ENV !== "test" || !loopback) {
    throw new Error("pc-fee duplicate check test runs only against a local throwaway test DB (NODE_ENV=test, loopback DATABASE_URL)");
  }
}

/** Runs the script inside a READ ONLY transaction; `seed` runs first in the same transaction. */
async function runScriptReadOnly(client: PoolClient, seed?: (c: PoolClient) => Promise<void>): Promise<Finding[]> {
  await client.query("begin transaction read only");
  try {
    const ro = await client.query<{ transaction_read_only: string }>("show transaction_read_only");
    assert.equal(ro.rows[0].transaction_read_only, "on");
    if (seed) await seed(client);
    const r = await client.query<Finding>(SCRIPT);
    assert.deepEqual(r.fields.map((f: { name: string }) => f.name), COLUMNS, "output is IDs and counts only");
    return r.rows;
  } finally {
    await client.query("rollback");
  }
}

describe("pc-fee authority duplicate check script (static)", () => {
  test("the script is a single SELECT: no writes, DDL, locks or transaction control", () => {
    const code = SCRIPT.replace(/--[^\n]*/g, " ");
    assert.match(code.trim(), /^SELECT\b/i);
    assert.equal(code.split(";").filter((s) => s.trim()).length, 1, "exactly one statement");
    assert.doesNotMatch(code, /\b(insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|copy|lock|begin|commit|set|call|do|vacuum|for\s+update)\b/i);
    assert.doesNotMatch(code, /\bpublic\./i, "unqualified table names");
  });

  test("the script selects no customer data columns", () => {
    const code = SCRIPT.replace(/--[^\n]*/g, " ");
    assert.doesNotMatch(code, /email|first_name|last_name|phone|address|mandate_provider_ref|signed_evidence_ref|card|reason|metadata/i);
  });
});

describe("pc-fee authority duplicate check script (temporary fixture tables)", () => {
  let client: PoolClient;

  before(async () => {
    assertLocalTestDatabase();
    client = await connect();
    // Session-temporary, empty, same columns and defaults. Created outside the read-only transactions.
    await client.query("create temporary table pc_fee_authorities (like public.pc_fee_authorities including defaults)");
    await client.query("create temporary table financial_ledger_events (like public.financial_ledger_events including defaults)");
  });

  after(async () => {
    if (!client) return;
    await client.query("drop table if exists pg_temp.pc_fee_authorities");
    await client.query("drop table if exists pg_temp.financial_ledger_events");
    client.release();
  });

  const auth = (c: PoolClient, id: number, agent: number, version: number, status: string, supersedesId: number | null = null) =>
    c.query(
      "insert into pc_fee_authorities (id, brokerage_id, agent_user_id, version, status, supersedes_id) values ($1, 900, $2, $3, $4, $5)",
      [id, agent, version, status, supersedesId],
    );
  const event = (c: PoolClient, id: number, eventType: string, sourceId: string, sourceType = "PC_FEE_AUTHORITY") =>
    c.query(
      "insert into financial_ledger_events (id, brokerage_id, event_type, source_record_type, source_record_id, actor_type) values ($1, 900, $2, $3, $4, 'SYSTEM')",
      [id, eventType, sourceType, sourceId],
    );

  test("the temporary tables shadow the real ones for this connection", async () => {
    const r = await client.query<{ p: string }>(
      "select c.relpersistence as p from pg_class c where c.oid in ('pc_fee_authorities'::regclass, 'financial_ledger_events'::regclass)",
    );
    assert.deepEqual(r.rows.map((x: { p: string }) => x.p), ["t", "t"]);
  });

  test("clean data: one ACTIVE per agent, one activation event each, a normal supersession chain -> empty output", async () => {
    const rows = await runScriptReadOnly(client, async (c) => {
      // Agent 1: v1 activated, then v2 activated (replaced v1), then v3 pending.
      await auth(c, 1, 1, 1, "REPLACED");
      await auth(c, 2, 1, 2, "ACTIVE", 1);
      await auth(c, 3, 1, 3, "PENDING");
      // Agent 2: one ACTIVE, one REVOKED, one EXPIRED.
      await auth(c, 4, 2, 1, "REVOKED");
      await auth(c, 5, 2, 2, "EXPIRED", 4);
      await auth(c, 6, 2, 3, "ACTIVE", 5);
      for (const [eid, aid] of [[1, 1], [2, 2], [3, 4], [4, 5], [5, 6]] as const) await event(c, eid, "PC_FEE_AUTHORITY_ACTIVATED", String(aid));
      // Other event types for the same authority, and the same id under another source type, are not activations.
      await event(c, 6, "PC_FEE_AUTHORITY_REVOKED", "4");
      await event(c, 7, "PC_FEE_AUTHORITY_CREATED", "3");
      await event(c, 8, "PC_FEE_AUTHORITY_ACTIVATED", "2", "PAYMENT");
    });
    assert.deepEqual(rows, []);
  });

  test("empty tables -> empty output", async () => {
    assert.deepEqual(await runScriptReadOnly(client), []);
  });

  test("duplicates: two and three ACTIVE per agent, a double activation, a shared supersedes -> each reported with IDs only", async () => {
    const rows = await runScriptReadOnly(client, async (c) => {
      await auth(c, 10, 7, 1, "ACTIVE");
      await auth(c, 11, 7, 2, "ACTIVE");
      await auth(c, 20, 8, 1, "REPLACED");
      await auth(c, 21, 8, 2, "ACTIVE", 20);
      await auth(c, 22, 8, 3, "ACTIVE", 20);
      await auth(c, 23, 8, 4, "ACTIVE");
      await auth(c, 30, 9, 1, "ACTIVE");
      await event(c, 100, "PC_FEE_AUTHORITY_ACTIVATED", "30");
      await event(c, 101, "PC_FEE_AUTHORITY_ACTIVATED", "30");
      await event(c, 102, "PC_FEE_AUTHORITY_ACTIVATED", "10");
    });
    assert.deepEqual(rows, [
      { check_name: "ACTIVATED_TWICE_LEDGER", brokerage_id: 900, agent_user_id: 9, authority_ids: [30], occurrences: 2, ledger_event_ids: [100, 101] },
      { check_name: "MULTIPLE_ACTIVE", brokerage_id: 900, agent_user_id: 7, authority_ids: [10, 11], occurrences: 2, ledger_event_ids: null },
      { check_name: "MULTIPLE_ACTIVE", brokerage_id: 900, agent_user_id: 8, authority_ids: [21, 22, 23], occurrences: 3, ledger_event_ids: null },
      { check_name: "SHARED_SUPERSEDES", brokerage_id: 900, agent_user_id: 8, authority_ids: [21, 22], occurrences: 2, ledger_event_ids: null },
    ]);
  });

  test("an activation event whose authority row is missing is still reported (ledger event IDs kept)", async () => {
    const rows = await runScriptReadOnly(client, async (c) => {
      await event(c, 200, "PC_FEE_AUTHORITY_ACTIVATED", "999");
      await event(c, 201, "PC_FEE_AUTHORITY_ACTIVATED", "999");
    });
    assert.deepEqual(rows, [
      { check_name: "ACTIVATED_TWICE_LEDGER", brokerage_id: 900, agent_user_id: null, authority_ids: [], occurrences: 2, ledger_event_ids: [200, 201] },
    ]);
  });

  test("the script cannot write: an INSERT in the same READ ONLY transaction against a real table is refused", async () => {
    await client.query("begin transaction read only");
    try {
      await assert.rejects(
        client.query("insert into public.financial_ledger_events (brokerage_id, event_type, source_record_type, source_record_id, actor_type) values (1, 'X', 'X', 'X', 'SYSTEM')"),
        /read-only transaction/,
      );
    } finally {
      await client.query("rollback");
    }
  });
});

describe("pc-fee authority duplicate check script (real tables, local test DB)", () => {
  let server: Server;
  let baseUrl: string;
  const suffix = Date.now();
  const brokerageName = `PCF Duplicate Check ${suffix}`;
  let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
  let activator: DevLoginResult;
  let n = 0;

  before(async () => {
    assertLocalTestDatabase();
    process.env.SESSION_SECRET =
      process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
    process.env.ALLOW_DEV_AUTH = "true";
    const { configureEvents } = await import("../../events.js");
    configureEvents();
    const { createApp } = await import("../../../app.js");
    server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    A = await createBrokerageWithUsers(baseUrl, brokerageName);
    activator = await devLogin(baseUrl, { email: `pcf-dup-activator-${suffix}@example.com`, firstName: "Second", lastName: "Admin", brokerageName });
  });

  after(async () => {
    await cleanupBrokerages([A?.brokerageId].filter((id): id is number => typeof id === "number"));
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  const freshAgent = async () =>
    (await devLogin(baseUrl, { email: `pcf-dup-agent-${suffix}-${++n}@example.com`, firstName: "Dup", lastName: `Agent${n}`, brokerageName })).user.id;
  const draft = (agentUserId: number) => createPcFeeAuthority({ brokerageId: A.brokerageId, agentUserId, rateBps: 690, createdByUserId: A.admin.user.id });
  const mine = (rows: Finding[]) => rows.filter((r) => r.brokerage_id === A.brokerageId);

  test("activations through activatePcFeeAuthority are clean; a directly-forced second ACTIVE is detected", async () => {
    const clean = await freshAgent();
    const a1 = await draft(clean);
    await activatePcFeeAuthority(a1.id, A.brokerageId, activator.user.id, `dup-check-${suffix}-1`, "sandbox");
    const a2 = await draft(clean);
    await activatePcFeeAuthority(a2.id, A.brokerageId, activator.user.id, `dup-check-${suffix}-2`, "sandbox");

    const client = await connect();
    try {
      assert.deepEqual(mine(await runScriptReadOnly(client)), [], "real activation path leaves nothing to report");

      // Legacy/raced state, written the way the #245 scheduler fixture does: status set straight to ACTIVE.
      const dirty = await freshAgent();
      const d1 = await draft(dirty);
      const d2 = await draft(dirty);
      await db.update(pcFeeAuthorities).set({ status: "ACTIVE" }).where(eq(pcFeeAuthorities.id, d1.id));
      await db.update(pcFeeAuthorities).set({ status: "ACTIVE" }).where(eq(pcFeeAuthorities.id, d2.id));

      const found = mine(await runScriptReadOnly(client));
      assert.deepEqual(found, [
        { check_name: "MULTIPLE_ACTIVE", brokerage_id: A.brokerageId, agent_user_id: dirty, authority_ids: [d1.id, d2.id].sort((x, y) => x - y), occurrences: 2, ledger_event_ids: null },
      ]);
    } finally {
      client.release();
    }
  });
});
