// t227u (Owner, 1 Nov 2026) — Grow/Run server boundary on property-linked data, by role and brokerage.
// Grow keeps shared property relationships (parties), historical appraisals and permitted property communications.
// Run-only: agreements/documents, AML/compliance, transactions, financials, the workspace and listing operations.
// Synthetic brokerages only (throwaway PG). Payments routes are covered by #282 (runAccessServiceOrdersPayments).
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { GROW_SAFE_PROPERTY_FIELDS } from "../properties.js";
import { cleanupBrokerages, createBrokerageWithUsers, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
type Tenant = { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let GROW: Tenant;
let GROW_B: Tenant; // second Grow-only brokerage (isolation)
let RUN: Tenant;
let growPropertyId: number;
let runPropertyId: number;

async function call(method: string, path: string, cookie?: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function grant(brokerageId: number, key: string) {
  await db.insert(entitlementGrants).values({ brokerageId, entitlementKey: key, granteeType: "brokerage", granteeId: brokerageId, sourceType: "manual", status: "Active" });
  invalidateEntitlementCache(brokerageId);
}
async function revoke(brokerageId: number, key: string) {
  await db.update(entitlementGrants).set({ status: "Revoked" }).where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, key)));
  invalidateEntitlementCache(brokerageId);
}
async function makeProperty(cookie: string, label: string): Promise<number> {
  const res = await call("POST", "/properties", cookie, { formattedAddress: `${suffix} ${label} Boundary Rd`, state: "QLD", suburb: "Testville", postcode: "4000" });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { property: { id: number } }).property.id;
}
async function addSeller(cookie: string, propertyId: number, label: string) {
  const res = await call("POST", "/parties", cookie, { propertyId, role: "Seller", partyType: "Person", firstName: "Synthetic", lastName: `${label}${suffix}`, email: `synthetic.${label.toLowerCase()}.${suffix}@example.test`, mobile: "0400000000" });
  assert.ok(res.status === 201 || res.status === 200, `add seller ${label} -> ${res.status} ${await res.clone().text()}`);
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  GROW = await createBrokerageWithUsers(baseUrl, `GRB Grow ${suffix}`);
  GROW_B = await createBrokerageWithUsers(baseUrl, `GRB GrowB ${suffix}`);
  RUN = await createBrokerageWithUsers(baseUrl, `GRB Run ${suffix}`);
  for (const t of [GROW, GROW_B]) {
    for (const key of ["grow.access", "grow.contacts.read", "grow.contacts.manage", "grow.opportunities.manage"]) await grant(t.brokerageId, key);
    await revoke(t.brokerageId, "run.access");
  }
  growPropertyId = await makeProperty(GROW.agent.cookie, "Grow");
  await addSeller(GROW.agent.cookie, growPropertyId, "GrowSeller");
  runPropertyId = await makeProperty(RUN.agent.cookie, "Run");
});

after(async () => {
  await cleanupBrokerages([GROW, GROW_B, RUN].map((t) => t?.brokerageId).filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

const RUN_ONLY_READS = (id: number) => [
  `/properties/${id}/workspace`,
  `/documents/agency-agreement-terms/${id}`,
  `/documents/packages/by-property/${id}`,
  `/aml/by-property/${id}`,
  `/aml/service-orders/by-property/${id}`,
  `/transactions/by-property/${id}`,
];

describe("t227u Grow/Run boundary", { concurrency: false }, () => {
  test("Grow-only agent and admin keep parties, appraisal and property communications", async () => {
    for (const [who, u] of [["agent", GROW.agent], ["admin", GROW.admin]] as const) {
      const parties = await call("GET", `/parties/by-property/${growPropertyId}`, u.cookie);
      assert.equal(parties.status, 200, `${who} parties`);
      const body = (await parties.json()) as { parties: Array<{ role: string }> };
      assert.ok(body.parties.some((p) => p.role === "Seller"), `${who} sees the seller relationship`);
      assert.equal((await call("GET", `/appraisals/by-property/${growPropertyId}`, u.cookie)).status, 200, `${who} appraisal`);
      assert.equal((await call("GET", `/properties/${growPropertyId}/communications/threads`, u.cookie)).status, 200, `${who} comms threads`);
      const prop = await call("GET", `/properties/${growPropertyId}`, u.cookie);
      assert.equal(prop.status, 200);
      const row = ((await prop.json()) as { property: Record<string, unknown> }).property;
      for (const key of Object.keys(row)) assert.ok((GROW_SAFE_PROPERTY_FIELDS as readonly string[]).includes(key), `${who}: ${key} not Grow-safe`);
    }
  });

  test("Grow-only agent and admin are refused every Run-only read (agreements, compliance, transactions, workspace)", async () => {
    for (const [who, u] of [["agent", GROW.agent], ["admin", GROW.admin]] as const) {
      for (const path of RUN_ONLY_READS(growPropertyId)) {
        const res = await call("GET", path, u.cookie);
        assert.equal(res.status, 403, `${who} ${path} -> ${res.status}`);
      }
    }
  });

  test("Grow-only admin is refused financials (role is not enough without run.access)", async () => {
    assert.equal((await call("GET", `/properties/${growPropertyId}/financial/summary`, GROW.admin.cookie)).status, 403);
    assert.equal((await call("GET", `/financial/commission-agreements`, GROW.admin.cookie)).status, 403);
  });

  test("Run agent: Run-only reads are not entitlement-refused; financials still need the admin role", async () => {
    for (const path of RUN_ONLY_READS(runPropertyId)) {
      const res = await call("GET", path, RUN.agent.cookie);
      const text = await res.text();
      assert.ok(!(res.status === 403 && text.includes("Not entitled")), `run agent ${path} -> ${res.status} ${text}`);
    }
    assert.equal((await call("GET", `/financial/commission-agreements`, RUN.agent.cookie)).status, 403, "agent role refused");
    assert.notEqual((await call("GET", `/financial/commission-agreements`, RUN.admin.cookie)).status, 403, "Run admin allowed");
  });

  test("brokerage isolation: another Grow brokerage and a Run brokerage get 404 on the Grow property's shared data", async () => {
    for (const [who, u] of [["growB", GROW_B.agent], ["run", RUN.agent]] as const) {
      assert.equal((await call("GET", `/properties/${growPropertyId}`, u.cookie)).status, 404, `${who} property`);
      assert.equal((await call("GET", `/parties/by-property/${growPropertyId}`, u.cookie)).status, 404, `${who} parties`);
      assert.equal((await call("GET", `/appraisals/by-property/${growPropertyId}`, u.cookie)).status, 404, `${who} appraisal`);
      const comms = await call("GET", `/properties/${growPropertyId}/communications/threads`, u.cookie);
      assert.ok(comms.status === 404 || comms.status === 403, `${who} comms -> ${comms.status}`);
    }
  });
});
