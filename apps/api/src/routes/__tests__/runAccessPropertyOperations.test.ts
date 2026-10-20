// RUN-ACCESS-OPS (Owner t95u, 2026-10-20 16:41): operation-level entitlement on the four property routes shared by
// Grow and Run: POST /properties, GET /properties, GET /properties/:id, GET /properties/:id/timeline.
//
// Decision (server-side, routes/properties.ts):
// - Any of grow.access or run.access is required; neither -> 403 "Not entitled" (no property read or write).
// - run.access: unchanged full behaviour.
// - Grow-only (grow.access, no run.access):
//   * property rows are returned as a Grow projection: the Run-only fields (workflowStage, amlStatusSummary,
//     listingStatus, salesMethod, priceDisplay, campaignStartDate, campaignEndDate, ownership*, isDraft) are omitted;
//   * POST /properties creates the property but never runs the Run ownership lookup (ownershipData stays null);
//   * the timeline keeps only Grow-safe entries (Property creation, Party, Appraisal); entries from the Run stages
//     (AML, Listing, Document, Offer, Transaction, Task, Compliance, ownership review) are omitted at every stage.
// - Cross-tenant and hidden ids answer exactly as before (same status and body), whatever the entitlements.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, properties } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { cleanupBrokerages, createBrokerageWithUsers, createListedProperty, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const RUN_ONLY_FIELDS = [
  "workflowStage",
  "amlStatusSummary",
  "listingStatus",
  "salesMethod",
  "priceDisplay",
  "campaignStartDate",
  "campaignEndDate",
  "ownershipData",
  "ownershipReviewRequired",
  "ownershipReviewedBy",
  "ownershipReviewedAt",
  "ownershipReviewNotes",
  "isDraft",
];
const GROW_SAFE_CATEGORIES = new Set(["Property", "Party", "Appraisal"]);

let server: Server;
let baseUrl: string;
const suffix = Date.now();
type Tenant = { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let RUN: Tenant; // run.access only (default)
let GROW: Tenant; // grow.access only
let BOTH: Tenant; // run.access + grow.access
let NONE: Tenant; // neither
let runListedPropertyId: number; // a property that went through the Run listing stages

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
async function setGrant(brokerageId: number, key: string, active: boolean) {
  await db
    .update(entitlementGrants)
    .set({ status: active ? "Active" : "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, key)));
  invalidateEntitlementCache(brokerageId);
}
async function createProperty(cookie: string, label: string, extra: Record<string, unknown> = {}) {
  return call("POST", "/properties", cookie, { formattedAddress: `${suffix} ${label} Ops Lane`, state: "NSW", suburb: "Testville", postcode: "2000", ...extra });
}
async function createdId(res: Response): Promise<number> {
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { property: { id: number } }).property.id;
}
function assertGrowProjection(row: Record<string, unknown>, label: string) {
  for (const field of RUN_ONLY_FIELDS) assert.ok(!(field in row), `${label}: Run-only field ${field} must be omitted`);
  for (const field of ["id", "brokerageId", "formattedAddress", "suburb", "state", "postcode"]) assert.ok(field in row, `${label}: ${field} kept`);
}
function assertFullRow(row: Record<string, unknown>, label: string) {
  for (const field of ["workflowStage", "listingStatus", "amlStatusSummary"]) assert.ok(field in row, `${label}: ${field} present with run.access`);
}
async function assertNotEntitled(res: Response, label: string) {
  const text = await res.text();
  assert.equal(res.status, 403, `${label} -> ${res.status} ${text}`);
  assert.equal((JSON.parse(text) as { error?: string }).error, "Not entitled", label);
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { registerLaunchEngine } = await import("../../lib/launch/bootstrap.js").catch(() => ({ registerLaunchEngine: () => undefined }));
  registerLaunchEngine?.();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  RUN = await createBrokerageWithUsers(baseUrl, `OPS Run ${suffix}`);
  GROW = await createBrokerageWithUsers(baseUrl, `OPS Grow ${suffix}`);
  BOTH = await createBrokerageWithUsers(baseUrl, `OPS Both ${suffix}`);
  NONE = await createBrokerageWithUsers(baseUrl, `OPS None ${suffix}`);
  for (const key of ["grow.access", "grow.contacts.read", "grow.contacts.manage", "grow.opportunities.manage"]) {
    await grant(GROW.brokerageId, key);
    await grant(BOTH.brokerageId, key);
  }
  await setGrant(GROW.brokerageId, "run.access", false);
  await setGrant(NONE.brokerageId, "run.access", false);
  const listed = await createListedProperty(baseUrl, RUN.agent.cookie, { address: `${suffix} Run Listed Ops St` });
  runListedPropertyId = listed.propertyId;
});

after(async () => {
  await cleanupBrokerages([RUN, GROW, BOTH, NONE].map((t) => t?.brokerageId).filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("RUN-ACCESS-OPS: entitlement x operation", { concurrency: false }, () => {
  test("unauthenticated: 401 on all four operations", async () => {
    for (const [m, p] of [["POST", "/properties"], ["GET", "/properties"], ["GET", "/properties/1"], ["GET", "/properties/1/timeline"]] as const) {
      assert.equal((await call(m, p, undefined, m === "POST" ? {} : undefined)).status, 401, `${m} ${p}`);
    }
  });

  test("no entitlement (neither grow.access nor run.access): 403 on all four, nothing created", async () => {
    const before = await db.select({ id: properties.id }).from(properties).where(eq(properties.brokerageId, NONE.brokerageId));
    await assertNotEntitled(await createProperty(NONE.agent.cookie, "None"), "POST /properties");
    const after = await db.select({ id: properties.id }).from(properties).where(eq(properties.brokerageId, NONE.brokerageId));
    assert.equal(after.length, before.length);
    const [own] = await db
      .insert(properties)
      .values({ brokerageId: NONE.brokerageId, agentId: NONE.agent.user.id, formattedAddress: `${suffix} None Fixture St` })
      .returning();
    await assertNotEntitled(await call("GET", "/properties", NONE.agent.cookie), "GET /properties");
    await assertNotEntitled(await call("GET", `/properties/${own.id}`, NONE.agent.cookie), "GET /properties/:id");
    await assertNotEntitled(await call("GET", `/properties/${own.id}/timeline`, NONE.agent.cookie), "GET /properties/:id/timeline");
  });

  test("Run-only: full rows and full timeline (unchanged)", async () => {
    const res = await call("GET", `/properties/${runListedPropertyId}`, RUN.agent.cookie);
    assert.equal(res.status, 200);
    assertFullRow(((await res.json()) as { property: Record<string, unknown> }).property, "Run GET /:id");
    const list = (await (await call("GET", "/properties", RUN.agent.cookie)).json()) as { properties: Record<string, unknown>[] };
    for (const row of list.properties) assertFullRow(row, "Run GET /");
    const timeline = (await (await call("GET", `/properties/${runListedPropertyId}/timeline`, RUN.agent.cookie)).json()) as { timeline: { category: string }[] };
    assert.ok(timeline.timeline.some((t) => !GROW_SAFE_CATEGORIES.has(t.category)), "Run sees Run-stage entries");
  });

  test("both entitlements: same as Run-only (full rows)", async () => {
    const id = await createdId(await createProperty(BOTH.agent.cookie, "Both"));
    const res = await call("GET", `/properties/${id}`, BOTH.agent.cookie);
    assertFullRow(((await res.json()) as { property: Record<string, unknown> }).property, "Both GET /:id");
  });

  test("Grow-only: create, list, search and read return the Grow projection (Run-only fields omitted)", async () => {
    const created = await createProperty(GROW.agent.cookie, "Grow", { placeId: `grow-place-${suffix}` });
    assert.equal(created.status, 201, await created.clone().text());
    const createdBody = (await created.json()) as { property: Record<string, unknown> };
    assertGrowProjection(createdBody.property, "POST /properties");
    const id = createdBody.property.id as number;
    const [row] = await db.select().from(properties).where(eq(properties.id, id));
    assert.equal(row.ownershipData, null, "the Run ownership lookup must not run for a Grow-only create");
    const list = (await (await call("GET", "/properties", GROW.agent.cookie)).json()) as { properties: Record<string, unknown>[] };
    assert.ok(list.properties.length >= 1);
    for (const r of list.properties) assertGrowProjection(r, "GET /properties");
    const search = (await (await call("GET", `/properties?q=${encodeURIComponent(`${suffix} Grow`)}`, GROW.agent.cookie)).json()) as { properties: Record<string, unknown>[] };
    assert.ok(search.properties.some((r) => r.id === id), "Grow.tsx property-link search still finds it");
    for (const r of search.properties) assertGrowProjection(r, "GET /properties?q=");
    const read = await call("GET", `/properties/${id}`, GROW.agent.cookie);
    assert.equal(read.status, 200);
    assertGrowProjection(((await read.json()) as { property: Record<string, unknown> }).property, "GET /properties/:id");
  });

  test("cross-tenant ids: same status and body for every entitlement mix (no existence leak)", async () => {
    const missing = 2_000_000_000;
    for (const t of [GROW, BOTH]) {
      for (const suffixPath of ["", "/timeline"]) {
        const foreign = await call("GET", `/properties/${runListedPropertyId}${suffixPath}`, t.agent.cookie);
        const absent = await call("GET", `/properties/${missing}${suffixPath}`, t.agent.cookie);
        assert.equal(foreign.status, 404);
        assert.equal(absent.status, 404);
        const fb = (await foreign.text()).replace(String(runListedPropertyId), "ID");
        const ab = (await absent.text()).replace(String(missing), "ID");
        assert.equal(fb, ab, `foreign vs missing body${suffixPath}`);
      }
    }
    // A Grow-only caller manipulating the id of another tenant's property cannot reach its Run data either way.
    const growList = (await (await call("GET", "/properties", GROW.agent.cookie)).json()) as { properties: { id: number }[] };
    assert.ok(!growList.properties.some((p) => p.id === runListedPropertyId));
  });
});

describe("RUN-ACCESS-OPS: Grow <-> Run property transitions", { concurrency: false }, () => {
  test("Grow appraisal flow works Grow-only; granting run.access exposes Run fields and Run surfaces only then", async () => {
    const cookie = GROW.agent.cookie;
    const propertyId = await createdId(await createProperty(cookie, "Transition"));
    const partyRes = await call("POST", "/parties", cookie, { propertyId, role: "Buyer", firstName: "Tess", lastName: "Transition", email: `ops-transition-${suffix}@example.com` });
    assert.equal(partyRes.status, 201, await partyRes.clone().text());
    const partyId = ((await partyRes.json()) as { party: { id: number } }).party.id;
    const appraisal = await call("POST", "/grow/appraisals/from-contact", cookie, { partyId, propertyId });
    assert.equal(appraisal.status, 201, await appraisal.clone().text());

    const tl = await call("GET", `/properties/${propertyId}/timeline`, cookie);
    assert.equal(tl.status, 200, "appraisal timeline readable Grow-only");
    const items = ((await tl.json()) as { timeline: { category: string; entryType: string }[] }).timeline;
    assert.ok(items.some((i) => i.category === "Appraisal"), "appraisal entries kept");
    for (const i of items) assert.ok(GROW_SAFE_CATEGORIES.has(i.category), `Grow-only timeline omits ${i.category}`);
    assert.equal((await call("GET", `/properties/${propertyId}/workspace`, cookie)).status, 403, "Run workspace not exposed early");

    // The property moves on to a Run stage while the brokerage is still Grow-only: still no Run fields.
    await db.update(properties).set({ workflowStage: "Listed", listingStatus: "Listed", priceDisplay: "$1" }).where(eq(properties.id, propertyId));
    const stillGrow = (await (await call("GET", `/properties/${propertyId}`, cookie)).json()) as { property: Record<string, unknown> };
    assertGrowProjection(stillGrow.property, "Grow-only on a Listed property");

    // Upgrade: run.access granted -> the same user keeps access and now sees the Run fields and workspace.
    await grant(GROW.brokerageId, "run.access");
    try {
      const full = (await (await call("GET", `/properties/${propertyId}`, cookie)).json()) as { property: Record<string, unknown> };
      assertFullRow(full.property, "after upgrade");
      assert.equal(full.property.workflowStage, "Listed");
      assert.equal((await call("GET", `/properties/${propertyId}/workspace`, cookie)).status, 200);
    } finally {
      await setGrant(GROW.brokerageId, "run.access", false);
    }
  });

  test("Run -> Grow-only downgrade: Run-stage timeline entries and fields disappear, Grow entries stay", async () => {
    await grant(RUN.brokerageId, "grow.access");
    await setGrant(RUN.brokerageId, "run.access", false);
    try {
      const tl = await call("GET", `/properties/${runListedPropertyId}/timeline`, RUN.agent.cookie);
      assert.equal(tl.status, 200);
      const items = ((await tl.json()) as { timeline: { category: string }[] }).timeline;
      for (const i of items) assert.ok(GROW_SAFE_CATEGORIES.has(i.category), `downgraded timeline omits ${i.category}`);
      const read = (await (await call("GET", `/properties/${runListedPropertyId}`, RUN.agent.cookie)).json()) as { property: Record<string, unknown> };
      assertGrowProjection(read.property, "downgraded GET /:id");
    } finally {
      await setGrant(RUN.brokerageId, "run.access", true);
    }
  });
});
