// activatePcFeeAuthority supersession (CC #57): activation must leave exactly
// one ACTIVE authority per agent. It must replace EVERY prior ACTIVE row (not
// just the first one a query happens to return) and stay correct when two
// activations for the same agent run at the same time on separate connections.
//
// The concurrency cases are deterministic. A separate pg connection (the
// "holder", its own pooled connection) takes row locks on the target authorities, both activations are
// started on the app's pool (two other connections) and run until they block
// on a lock, then the holder releases. Synthetic data only; scratch DB only.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { db, financialLedgerEvents, pcFeeAuthorities, pool } from "@aee/db";
import { createBrokerageWithUsers, devLogin, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";
import { createPcFeeAuthority, activatePcFeeAuthority } from "../pcFeeAuthorities.js";
import { FinancialControlError } from "../agreements.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageName = `PCF Activation Race ${suffix}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let activator: DevLoginResult;
let agentN = 0;

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { createApp } = await import("../../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, brokerageName);
  activator = await devLogin(baseUrl, { email: `pcf-race-activator-${suffix}@example.com`, firstName: "Second", lastName: "Admin", brokerageName });
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId].filter((id): id is number => typeof id === "number"));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

/** A fresh agent per case so no case sees another's authorities. */
async function freshAgent(): Promise<number> {
  const u = await devLogin(baseUrl, { email: `pcf-race-agent-${suffix}-${++agentN}@example.com`, firstName: "Race", lastName: `Agent${agentN}`, brokerageName });
  return u.user.id;
}
const draft = (agentUserId: number, rateBps = 690) => createPcFeeAuthority({ brokerageId: A.brokerageId, agentUserId, rateBps, createdByUserId: A.admin.user.id });
const activate = (id: number, ref: string) => activatePcFeeAuthority(id, A.brokerageId, activator.user.id, ref, "sandbox");
const rowsFor = (agentUserId: number) => db.select().from(pcFeeAuthorities).where(eq(pcFeeAuthorities.agentUserId, agentUserId)).orderBy(pcFeeAuthorities.id);
const activeFor = async (agentUserId: number) => (await rowsFor(agentUserId)).filter((r) => r.status === "ACTIVE");

/** Separate connection (not the app pool) that holds row locks on the given authorities in an open transaction. */
async function holdRowLocks(ids: number[]) {
  // A dedicated connection checked out of the pool for the whole hold (activations use other connections).
  const client = await pool.connect();
  await client.query("begin");
  await client.query("select id from pc_fee_authorities where id = any($1::int[]) for update", [ids]);
  const holderPid = (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
  return {
    /** Waits until `n` other backends are blocked on a lock behind activation work. */
    async waitForBlocked(n: number) {
      const until = Date.now() + 15_000;
      for (;;) {
        // The holder is inside a transaction, where pg_stat_activity is a snapshot taken on first
        // read; clear it so each poll sees the backends' current wait state.
        await client.query("select pg_stat_clear_snapshot()");
        const r = await client.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
            where datname = current_database() and pid <> $1 and wait_event_type = 'Lock'
              and (query ilike '%pc_fee_authorities%' or query ilike '%pg_advisory_xact_lock%')`,
          [holderPid],
        );
        if (r.rows[0].n >= n) return;
        if (Date.now() > until) {
          const seen = await client.query<{ s: string }>(
            `select coalesce(wait_event_type,'-') || ' ' || coalesce(wait_event,'-') || ' ' || state || ' | ' || left(regexp_replace(query, '\\s+', ' ', 'g'), 120) as s
               from pg_stat_activity where datname = current_database() and pid <> $1 and state <> 'idle'`,
            [holderPid],
          );
          throw new Error(`only ${r.rows[0].n} of ${n} activations reached a lock wait; active backends: ${JSON.stringify(seen.rows.map((x) => x.s))}`);
        }
        await new Promise((res) => setTimeout(res, 25));
      }
    },
    async release() {
      await client.query("commit");
      client.release();
    },
  };
}

describe("activatePcFeeAuthority: exactly one ACTIVE authority per agent", { concurrency: false }, () => {
  test("multiple prior ACTIVE rows (legacy or raced state): activation replaces every one of them", async () => {
    const agent = await freshAgent();
    const a = await draft(agent, 600);
    const b = await draft(agent, 650);
    // Simulate a state left by an earlier race: two ACTIVE rows for one agent.
    await db.update(pcFeeAuthorities).set({ status: "ACTIVE", mandateProviderRef: "sandbox-legacy", mandateProvider: "sandbox" }).where(inArray(pcFeeAuthorities.id, [a.id, b.id]));
    assert.equal((await activeFor(agent)).length, 2);
    const c = await draft(agent, 700);
    const activated = await activate(c.id, "sandbox-race-multi");
    assert.equal(activated.status, "ACTIVE");
    const rows = await rowsFor(agent);
    assert.deepEqual(rows.filter((r) => r.status === "ACTIVE").map((r) => r.id), [c.id], "only the new authority is ACTIVE");
    for (const id of [a.id, b.id]) assert.equal(rows.find((r) => r.id === id)?.status, "REPLACED", `prior ${id} replaced`);
    assert.ok([a.id, b.id].includes(activated.supersedesId ?? -1), "supersedesId points at a replaced prior authority");
  });

  test("two concurrent activations of different authorities for one agent (two connections): exactly one ACTIVE, the other REPLACED", async () => {
    const agent = await freshAgent();
    const x = await draft(agent, 600);
    const y = await draft(agent, 650);
    const holder = await holdRowLocks([x.id, y.id]);
    const runs = [activate(x.id, "sandbox-race-x"), activate(y.id, "sandbox-race-y")].map((p) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })));
    try {
      await holder.waitForBlocked(2);
    } finally {
      await holder.release();
    }
    const results = await Promise.all(runs);
    for (const r of results) assert.ok(r.ok, `activation failed: ${r.ok ? "" : String(r.e)}`);
    const rows = await rowsFor(agent);
    assert.equal(rows.filter((r) => r.status === "ACTIVE").length, 1, `exactly one ACTIVE: ${JSON.stringify(rows.map((r) => [r.id, r.status]))}`);
    assert.equal(rows.filter((r) => r.status === "REPLACED").length, 1);
  });

  test("two concurrent activations of the SAME authority: one succeeds, the other is refused; one activation ledger event", async () => {
    const agent = await freshAgent();
    const t = await draft(agent, 600);
    const holder = await holdRowLocks([t.id]);
    const runs = [activate(t.id, "sandbox-race-same-1"), activate(t.id, "sandbox-race-same-2")].map((p) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })));
    try {
      await holder.waitForBlocked(2);
    } finally {
      await holder.release();
    }
    const results = await Promise.all(runs);
    assert.equal(results.filter((r) => r.ok).length, 1, "exactly one activation succeeds");
    const refused = results.find((r) => !r.ok);
    assert.ok(refused && !refused.ok && refused.e instanceof FinancialControlError && refused.e.reason === "INVALID_STATUS", `the other is INVALID_STATUS: ${refused && !refused.ok ? String(refused.e) : ""}`);
    assert.equal((await activeFor(agent)).length, 1);
    const ledger = await db.select().from(financialLedgerEvents).where(and(eq(financialLedgerEvents.eventType, "PC_FEE_AUTHORITY_ACTIVATED"), eq(financialLedgerEvents.sourceRecordId, String(t.id))));
    assert.equal(ledger.length, 1, "one activation ledger event");
  });

  test("burst: 6 activations for one agent at once leave exactly one ACTIVE and the rest REPLACED", async () => {
    const agent = await freshAgent();
    const drafts = [];
    for (let i = 0; i < 6; i++) drafts.push(await draft(agent, 600 + i));
    const results = await Promise.allSettled(drafts.map((d, i) => activate(d.id, `sandbox-race-burst-${i}`)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 6);
    const rows = await rowsFor(agent);
    assert.equal(rows.filter((r) => r.status === "ACTIVE").length, 1, JSON.stringify(rows.map((r) => [r.id, r.status])));
    assert.equal(rows.filter((r) => r.status === "REPLACED").length, 5);
  });
});
