// Owner t274u item 3. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { and } from "drizzle-orm";
import { db, entitlementGrants, users, properties, ENTITLEMENT_KEYS, growRelationships, growContactRelationships, propertyParties, GROW_CONTACT_RELATIONSHIP_TYPES, GROW_RELATIONSHIP_TYPES } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin } from "./testSupport.js";

const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const tag = `gint-${Date.now()}`;
let server: Server;
let base = "";
const ids: number[] = [];

before(async () => {
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  try {
    await cleanupBrokerages(ids);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

async function setGrants(brokerageId: number, keys: readonly string[]) {
  await db.delete(entitlementGrants).where(eq(entitlementGrants.brokerageId, brokerageId));
  for (const k of keys) {
    await db.insert(entitlementGrants).values({ brokerageId, entitlementKey: k, granteeType: "brokerage", granteeId: brokerageId, sourceType: "admin_override", status: "Active" });
  }
  invalidateEntitlementCache(brokerageId);
}

async function call(cookie: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api${path}`, {
    method,
    headers: { cookie, connection: "close", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: r.status, json, text };
}

async function world(label: string) {
  const name = `${tag} ${label}`;
  const b = await createBrokerageWithUsers(base, name);
  ids.push(b.brokerageId);
  await setGrants(b.brokerageId, ["run.access", ...GROW]);
  const pc = await devLogin(base, { email: `pc-${name.replace(/\s+/g, "-").toLowerCase()}@example.com`, firstName: "Pit", lastName: "Crew", brokerageName: name });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pc.user.id));
  const mk = async (cookie: string, n: string) => {
    const r = await call(cookie, "POST", "/properties", { formattedAddress: `${n} ${name} St, Testville`, state: "NSW", suburb: "Testville", postcode: "2000" });
    assert.equal(r.status, 201, `create property: ${r.text}`);
    return r.json.property.id as number;
  };
  const adminProp = await mk(b.admin.cookie, "1");
  const agentProp = await mk(b.agent.cookie, "2");
  const c = await call(b.admin.cookie, "POST", "/grow/contacts", { name: "Lena Linkform", email: `lena-${label.toLowerCase()}-${tag}@example.com`, mobile: "0400 000 111" });
  assert.equal(c.status, 201, c.text);
  return { ...b, pc, adminProp, agentProp, partyId: c.json.contact.id as number };
}


const growRowsFor = async (partyId: number) => db.select().from(growRelationships).where(eq(growRelationships.partyId, partyId));

// Owner t274u item 3: "Record Grow interest" writes one Grow relationship only,
// never twice, and never a canonical link. Synthetic data only.
test("t274u item 3: recording a Grow interest writes only grow_relationships, and the same interest is never recorded twice (with or without a property)", async () => {
  const w = await world("Interest");
  const body = { partyId: w.partyId, propertyId: w.adminProp, relationshipType: "prospective_seller", sourceType: "manual" };
  const first = await call(w.admin.cookie, "POST", "/grow/relationships", body);
  assert.equal(first.status, 201, first.text);
  const again = await call(w.admin.cookie, "POST", "/grow/relationships", body);
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.relationshipId, first.json.relationship.id);
  const noProp = { partyId: w.partyId, relationshipType: "prospective_buyer", sourceType: "manual" };
  assert.equal((await call(w.admin.cookie, "POST", "/grow/relationships", noProp)).status, 201);
  assert.equal((await call(w.admin.cookie, "POST", "/grow/relationships", noProp)).status, 409, "pre-property duplicate");
  // A different interest on the same property is a different record.
  assert.equal((await call(w.admin.cookie, "POST", "/grow/relationships", { ...body, relationshipType: "investor" })).status, 201);
  assert.equal((await growRowsFor(w.partyId)).length, 3);
  const links = await db.select().from(propertyParties).where(eq(propertyParties.partyId, w.partyId));
  assert.equal(links.length, 0, "no canonical property_parties link from a Grow interest");
});

test("t274u item 3: concurrent identical submissions record the interest once", async () => {
  const w = await world("Race");
  const body = { partyId: w.partyId, propertyId: w.adminProp, relationshipType: "prospective_buyer" };
  const rs = await Promise.all([1, 2, 3].map(() => call(w.admin.cookie, "POST", "/grow/relationships", body)));
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409]);
  assert.equal((await growRowsFor(w.partyId)).length, 1);
});

test("t274u item 3: Link property (canonical) still writes no Grow row, so one action never creates both record types", async () => {
  const w = await world("Separate");
  assert.equal((await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Seller" })).status, 201);
  assert.equal((await growRowsFor(w.partyId)).length, 0);
});
