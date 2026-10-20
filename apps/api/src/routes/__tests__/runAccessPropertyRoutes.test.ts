// RUN-ACCESS (Owner approved 2026-10-20 08:00 via Grok): the Run-only property routes, GET /home/summary and
// GET /command-centre require run.access, using the existing requireEntitlement("run.access") middleware (the same
// helper routes/properties.ts already applies to ready-to-list and go-live, R-F35b).
//
// Gated here (Run-only surfaces: PropertyWorkspace, StartProperty, Home, Command Centre):
//   GET  /properties/address-search, GET /properties/:id/workspace, POST /properties/:id/ownership-review,
//   POST /properties/:id/listing-details, GET /home/summary, GET /command-centre.
// Deliberately NOT gated (shared with Grow; flagged for an Owner decision, pinned open below):
//   POST /properties (Grow appraisal flow creates the property; pinned by runLaneRouteAccess.test.ts),
//   GET /properties (Grow.tsx property-link search), GET /properties/:id (pinned open by runLaneRouteAccess.test.ts),
//   GET /properties/:id/timeline (AppraisalWorkspace.tsx, a Grow page).
//
// Matrix: role (Brokerage Administrator, Agent, Pit Crew) x run.access (active / revoked) x gated route.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, users } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { cleanupBrokerages, createBrokerageWithUsers, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();

interface Tenant {
  brokerageId: number;
  roles: Record<"Brokerage Administrator" | "Agent" | "Pit Crew", DevLoginResult>;
  propertyId: number;
}
let RUN: Tenant; // run.access active (the default every new brokerage gets)
let GROW: Tenant; // Grow-only: grow.access granted, run.access revoked

async function call(method: string, path: string, cookie?: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function grant(brokerageId: number, entitlementKey: string): Promise<void> {
  await db.insert(entitlementGrants).values({ brokerageId, entitlementKey, granteeType: "brokerage", granteeId: brokerageId, sourceType: "manual", status: "Active" });
  invalidateEntitlementCache(brokerageId);
}

async function revoke(brokerageId: number, entitlementKey: string): Promise<void> {
  await db
    .update(entitlementGrants)
    .set({ status: "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, entitlementKey)));
  invalidateEntitlementCache(brokerageId);
}

async function createProperty(cookie: string, label: string): Promise<number> {
  const res = await call("POST", "/properties", cookie, { formattedAddress: `${suffix} ${label} Access Lane`, state: "NSW", suburb: "Testville", postcode: "2000" });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { property: { id: number } }).property.id;
}

async function tenant(label: string): Promise<Tenant> {
  const name = `RUN-ACCESS ${label} ${suffix}`;
  const { admin, agent, brokerageId } = await createBrokerageWithUsers(baseUrl, name);
  const pitCrew = await devLogin(baseUrl, { email: `pitcrew-${label.toLowerCase()}-${suffix}@example.com`, firstName: "Pit", lastName: "Crew", brokerageName: name });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));
  const propertyId = await createProperty(agent.cookie, label);
  return { brokerageId, roles: { "Brokerage Administrator": admin, Agent: agent, "Pit Crew": pitCrew }, propertyId };
}

const gated: Array<{ method: string; path: (t: Tenant) => string; body?: unknown; label: string }> = [
  { method: "GET", path: () => "/properties/address-search?q=12%20Example%20Street", label: "GET /properties/address-search" },
  { method: "GET", path: (t) => `/properties/${t.propertyId}/workspace`, label: "GET /properties/:id/workspace" },
  { method: "POST", path: (t) => `/properties/${t.propertyId}/ownership-review`, body: {}, label: "POST /properties/:id/ownership-review" },
  { method: "POST", path: (t) => `/properties/${t.propertyId}/listing-details`, body: {}, label: "POST /properties/:id/listing-details" },
  { method: "GET", path: () => "/home/summary", label: "GET /home/summary" },
  { method: "GET", path: () => "/command-centre", label: "GET /command-centre" },
];

async function assertNotEntitled(res: Response, label: string): Promise<void> {
  const text = await res.text();
  assert.equal(res.status, 403, `${label} -> ${res.status} ${text}`);
  const body = JSON.parse(text) as { error?: string; reason?: string; entitlementKey?: string };
  assert.equal(body.error, "Not entitled", label);
  assert.equal(body.reason, "ENTITLEMENT_MISSING", label);
  assert.equal(body.entitlementKey, "run.access", label);
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
  RUN = await tenant("Run");
  GROW = await tenant("Grow");
  await grant(GROW.brokerageId, "grow.access");
  await revoke(GROW.brokerageId, "run.access");
});

after(async () => {
  await cleanupBrokerages([RUN?.brokerageId, GROW?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("RUN-ACCESS 403 matrix: role x run.access x gated route", { concurrency: false }, () => {
  for (const role of ["Brokerage Administrator", "Agent", "Pit Crew"] as const) {
    for (const route of gated) {
      test(`[revoked] ${role}: ${route.label} -> 403 Not entitled (run.access)`, async () => {
        const res = await call(route.method, route.path(GROW), GROW.roles[role].cookie, route.body);
        await assertNotEntitled(res, `${role} ${route.label}`);
      });
      test(`[active] ${role}: ${route.label} is not refused for entitlement`, async () => {
        const res = await call(route.method, route.path(RUN), RUN.roles[role].cookie, route.body);
        const text = await res.text();
        assert.notEqual(res.status, 401, `${role} ${route.label} -> ${res.status} ${text}`);
        assert.ok(!(res.status === 403 && text.includes("Not entitled")), `${role} ${route.label} -> ${res.status} ${text}`);
        assert.equal(res.status, 200, `${role} ${route.label} -> ${res.status} ${text}`); // unchanged behaviour with run.access
      });
    }
  }

  test("unauthenticated callers still get 401 (requireAuth runs first), not the entitlement 403", async () => {
    for (const route of gated) {
      const res = await call(route.method, route.path(RUN), undefined, route.body);
      assert.equal(res.status, 401, route.label);
    }
  });

  test("a refused gated write changes nothing (ownership review / listing details on the Grow-only tenant)", async () => {
    const before = await call("GET", `/properties/${GROW.propertyId}`, GROW.roles.Agent.cookie);
    assert.equal(before.status, 200);
    const snapshot = await before.text();
    for (const path of ["ownership-review", "listing-details"]) {
      const res = await call("POST", `/properties/${GROW.propertyId}/${path}`, GROW.roles.Agent.cookie, { ownershipConfirmed: true });
      await assertNotEntitled(res, path);
    }
    const after = await call("GET", `/properties/${GROW.propertyId}`, GROW.roles.Agent.cookie);
    assert.equal(await after.text(), snapshot);
  });
});

describe("RUN-ACCESS: Grow-only users are not regressed on Grow-used endpoints", { concurrency: false }, () => {
  test("Grow-shared property routes stay open without run.access (flagged, not gated)", async () => {
    const cookie = GROW.roles.Agent.cookie;
    const created = await call("POST", "/properties", cookie, { formattedAddress: `${suffix} Grow Only Lane`, state: "NSW", suburb: "Testville", postcode: "2000" });
    assert.equal(created.status, 201, await created.clone().text());
    const id = ((await created.json()) as { property: { id: number } }).property.id;
    for (const path of ["/properties", `/properties?q=${encodeURIComponent(`${suffix} Grow`)}`, `/properties/${id}`, `/properties/${id}/timeline`]) {
      const res = await call("GET", path, cookie);
      assert.equal(res.status, 200, `GET ${path} -> ${res.status} ${await res.clone().text()}`);
    }
  });

  test("Grow routes keep answering for every role of the Grow-only brokerage", async () => {
    for (const role of ["Brokerage Administrator", "Agent", "Pit Crew"] as const) {
      const cookie = GROW.roles[role].cookie;
      const access = await call("GET", "/grow/access", cookie);
      assert.equal(access.status, 200, `${role} /grow/access`);
      const body = (await access.json()) as { entitled: boolean; entitlements: string[] };
      assert.equal(body.entitled, true, role);
      assert.ok(!body.entitlements.includes("run.access"), role);
      for (const path of ["/grow/overview", "/grow/relationships", "/grow/activities", "/grow/opportunities"]) {
        const res = await call("GET", path, cookie);
        assert.equal(res.status, 200, `${role} GET ${path} -> ${res.status} ${await res.clone().text()}`);
      }
    }
  });
});
