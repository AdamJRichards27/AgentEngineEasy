// Owner t225u (31 Oct 2026): dev-login no longer auto-grants run.access on shared environments;
// explicitly authorised test access (NODE_ENV=test, explicit flag, named allowlist) is preserved.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants } from "@aee/db";
import { devLoginGrantsRunAccess } from "../../lib/billing/devLoginRunAccess.js";
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

test("decision: shared environments get no grant by default; test, explicit flag and allowlist do", () => {
  for (const NODE_ENV of ["production", "development", "staging", undefined]) {
    assert.deepEqual(devLoginGrantsRunAccess("Acme", { NODE_ENV }), { grant: false, reason: "NOT_AUTHORISED" }, String(NODE_ENV));
  }
  assert.equal(devLoginGrantsRunAccess("Acme", { NODE_ENV: "test" }).grant, true);
  assert.equal(devLoginGrantsRunAccess("Acme", { NODE_ENV: "production", AE_DEV_LOGIN_GRANTS_RUN_ACCESS: "true" }).reason, "EXPLICIT_FLAG");
  assert.equal(devLoginGrantsRunAccess("Acme", { NODE_ENV: "production", AE_DEV_LOGIN_GRANTS_RUN_ACCESS: "1" }).grant, false, "only the literal true");
  const allow = { NODE_ENV: "production", AE_DEV_LOGIN_RUN_ACCESS_ALLOWLIST: " QA Tenant , Demo* " };
  assert.equal(devLoginGrantsRunAccess("QA Tenant", allow).reason, "ALLOWLIST");
  assert.equal(devLoginGrantsRunAccess("Demo Brokerage 7", allow).grant, true);
  assert.equal(devLoginGrantsRunAccess("QA Tenant 2", allow).grant, false, "exact names are exact");
  assert.equal(devLoginGrantsRunAccess("Acme", { NODE_ENV: "production", AE_DEV_LOGIN_RUN_ACCESS_ALLOWLIST: "*" }).grant, false, "a bare * is not a wildcard for everyone");
});

async function runGrants(brokerageId: number) {
  return db.select().from(entitlementGrants).where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
}

test("dev-login on a non-test environment creates the brokerage without run.access unless allowlisted", async () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, AL: process.env.AE_DEV_LOGIN_RUN_ACCESS_ALLOWLIST };
  try {
    process.env.NODE_ENV = "development";
    process.env.AE_DEV_LOGIN_RUN_ACCESS_ALLOWLIST = `${tag} QA*`;
    const plain = await devLogin(baseUrl, { email: `p-${tag}@example.com`, firstName: "S", lastName: "P", brokerageName: `${tag} Plain` });
    created.push(plain.user.brokerageId);
    assert.equal((await runGrants(plain.user.brokerageId)).length, 0, "shared env: no free Run");
    const qa = await devLogin(baseUrl, { email: `q-${tag}@example.com`, firstName: "S", lastName: "Q", brokerageName: `${tag} QA 1` });
    created.push(qa.user.brokerageId);
    assert.equal((await runGrants(qa.user.brokerageId)).length, 1, "allowlisted test tenant keeps Run");
  } finally {
    process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.AL === undefined) delete process.env.AE_DEV_LOGIN_RUN_ACCESS_ALLOWLIST; else process.env.AE_DEV_LOGIN_RUN_ACCESS_ALLOWLIST = saved.AL;
  }
  const t = await devLogin(baseUrl, { email: `t-${tag}@example.com`, firstName: "S", lastName: "T", brokerageName: `${tag} TestEnv` });
  created.push(t.user.brokerageId);
  assert.equal((await runGrants(t.user.brokerageId)).length, 1, "NODE_ENV=test keeps the automated-suite grant");
});
