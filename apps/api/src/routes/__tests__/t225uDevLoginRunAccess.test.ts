// Owner t225u (31 Oct 2026): dev-login no longer auto-grants run.access on shared environments;
// t249u: only NODE_ENV=test (throwaway suites) keeps the grant; boot backfill is opt-in only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, brokerages, entitlementGrants } from "@aee/db";
import { devLoginGrantsRunAccess, maybeRunAccessBootBackfill, runAccessBootBackfillEnabled } from "../../lib/billing/devLoginRunAccess.js";
import { devLogin, cleanupBrokerages } from "./testSupport.js";

const tag = `t225u-dl-${process.pid}-${Date.now()}`;
let server: Server; let baseUrl = ""; const created: number[] = [];
before(async () => {
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const a = server.address(); if (!a || typeof a === "string") throw new Error("addr");
  baseUrl = `http://127.0.0.1:${a.port}`;
});
after(async () => {
  try { await cleanupBrokerages(created); } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("decision: dev-login grants Run only under NODE_ENV=test; no flag or allowlist re-enables it", () => {
  for (const NODE_ENV of ["production", "development", "staging", undefined]) {
    assert.deepEqual(devLoginGrantsRunAccess("Acme", { NODE_ENV }), { grant: false, reason: "NOT_AUTHORISED" }, String(NODE_ENV));
    assert.equal(devLoginGrantsRunAccess("QA Tenant", { NODE_ENV, AE_DEV_LOGIN_GRANTS_RUN_ACCESS: "true", AE_DEV_LOGIN_RUN_ACCESS_ALLOWLIST: "QA Tenant,Demo*" }).grant, false, "legacy flag/allowlist ignored");
  }
  assert.equal(devLoginGrantsRunAccess("Acme", { NODE_ENV: "test" }).grant, true);
});

test("boot backfill is disabled unless AE_RUN_ACCESS_BOOT_BACKFILL is the literal \"true\"", async () => {
  for (const v of [undefined, "", "false", "1", "TRUE", "yes", " true"]) {
    assert.equal(runAccessBootBackfillEnabled({ AE_RUN_ACCESS_BOOT_BACKFILL: v }), false, String(v));
    let called = false;
    assert.equal(await maybeRunAccessBootBackfill({ AE_RUN_ACCESS_BOOT_BACKFILL: v }, async () => { called = true; }), false);
    assert.equal(called, false, `backfill must not run for ${String(v)}`);
  }
  let called = false;
  assert.equal(await maybeRunAccessBootBackfill({ AE_RUN_ACCESS_BOOT_BACKFILL: "true" }, async () => { called = true; }), true);
  assert.equal(called, true, "explicit opt-in is effective");
});

test("boot with default env: Grow-only, unsubscribed and newly created brokerages get no run.access", async () => {
  const [growOnly] = await db.insert(brokerages).values({ name: `${tag} GrowOnly` }).returning({ id: brokerages.id });
  const [unsub] = await db.insert(brokerages).values({ name: `${tag} Unsubscribed` }).returning({ id: brokerages.id });
  created.push(growOnly.id, unsub.id);
  await db.insert(entitlementGrants).values({ brokerageId: growOnly.id, entitlementKey: "grow.access", granteeType: "brokerage", granteeId: growOnly.id, sourceType: "migration", status: "Active" });
  const ran = await maybeRunAccessBootBackfill({ NODE_ENV: "production" });
  assert.equal(ran, false);
  const [fresh] = await db.insert(brokerages).values({ name: `${tag} NewAfterBoot` }).returning({ id: brokerages.id });
  created.push(fresh.id);
  await maybeRunAccessBootBackfill({});
  for (const id of [growOnly.id, unsub.id, fresh.id]) assert.equal((await runGrants(id)).length, 0, `brokerage ${id} must not get run.access on boot`);
});

async function runGrants(brokerageId: number) {
  return db.select().from(entitlementGrants).where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
}

test("dev-login on a non-test environment creates the brokerage without run.access even if allowlisted or flagged", async () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, AL: process.env.AE_DEV_LOGIN_RUN_ACCESS_ALLOWLIST };
  try {
    process.env.NODE_ENV = "development";
    process.env.AE_DEV_LOGIN_RUN_ACCESS_ALLOWLIST = `${tag} QA*`; process.env.AE_DEV_LOGIN_GRANTS_RUN_ACCESS = "true";
    const plain = await devLogin(baseUrl, { email: `p-${tag}@example.com`, firstName: "S", lastName: "P", brokerageName: `${tag} Plain` });
    created.push(plain.user.brokerageId);
    assert.equal((await runGrants(plain.user.brokerageId)).length, 0, "shared env: no free Run");
    const qa = await devLogin(baseUrl, { email: `q-${tag}@example.com`, firstName: "S", lastName: "Q", brokerageName: `${tag} QA 1` });
    created.push(qa.user.brokerageId);
    assert.equal((await runGrants(qa.user.brokerageId)).length, 0, "legacy allowlist no longer grants Run");
  } finally {
    process.env.NODE_ENV = saved.NODE_ENV;
    delete process.env.AE_DEV_LOGIN_GRANTS_RUN_ACCESS; if (saved.AL === undefined) delete process.env.AE_DEV_LOGIN_RUN_ACCESS_ALLOWLIST; else process.env.AE_DEV_LOGIN_RUN_ACCESS_ALLOWLIST = saved.AL;
  }
  const t = await devLogin(baseUrl, { email: `t-${tag}@example.com`, firstName: "S", lastName: "T", brokerageName: `${tag} TestEnv` });
  created.push(t.user.brokerageId);
  assert.equal((await runGrants(t.user.brokerageId)).length, 1, "NODE_ENV=test keeps the automated-suite grant");
});
