// t228u Priority 1: /parties property-contact routes require an active Grow or
// Run entitlement, and link/unlink require access to the specific property
// (own-property scope #147: hidden = 404), with brokerage isolation kept.
// Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, entitlementGrants, users, ENTITLEMENT_KEYS } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin, removeRelationshipManageFixture } from "./testSupport.js";

const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const tag = `pacc-${Date.now()}`;
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
  return { status: r.status, json };
}

async function setup(label: string, keys: readonly string[]) {
  const name = `${tag} ${label}`;
  const b = await createBrokerageWithUsers(base, name);
  ids.push(b.brokerageId);
  await setGrants(b.brokerageId, ["run.access", ...GROW]);
  const pc = await devLogin(base, { email: `pc-${name.replace(/\s+/g, "-").toLowerCase()}@example.com`, firstName: "Pit", lastName: "Crew", brokerageName: name });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pc.user.id));
  const mk = async (cookie: string, n: string) => {
    const r = await call(cookie, "POST", "/properties", { formattedAddress: `${n} ${name} St, Testville`, state: "NSW", suburb: "Testville", postcode: "2000" });
    assert.equal(r.status, 201, `create property: ${JSON.stringify(r.json)}`);
    return r.json.property.id as number;
  };
  const adminProp = await mk(b.admin.cookie, "1");
  const agentProp = await mk(b.agent.cookie, "2");
  const c = await call(b.admin.cookie, "POST", "/parties", { propertyId: adminProp, role: "Seller", firstName: "Sam", lastName: "Synthetic" });
  assert.equal(c.status, 201);
  await setGrants(b.brokerageId, keys);
  return { ...b, pc, adminProp, agentProp, partyId: c.json.party.id as number, adminLinkId: c.json.link.id as number };
}

for (const [label, keys] of [["Grow", GROW], ["Run", ["run.access", "grow.relationships.manage"]]] as const) {
  test(`${label}: Admin and Agent can read, link and unlink on properties they can access`, async () => {
    const b = await setup(label, keys);
    // Admin on own (admin) property.
    assert.equal((await call(b.admin.cookie, "GET", `/parties/by-property/${b.adminProp}`)).status, 200);
    const l1 = await call(b.admin.cookie, "POST", "/parties", { propertyId: b.agentProp, partyId: b.partyId, role: "Buyer" });
    assert.equal(l1.status, 201);
    // Agent on own property: read, link existing, create+link, unlink.
    assert.equal((await call(b.agent.cookie, "GET", `/parties/by-property/${b.agentProp}`)).status, 200);
    const l2 = await call(b.agent.cookie, "POST", "/parties", { propertyId: b.agentProp, partyId: b.partyId, role: "Solicitor" });
    assert.equal(l2.status, 201);
    assert.equal((await call(b.agent.cookie, "POST", "/parties", { propertyId: b.agentProp, role: "Other", firstName: "Ola" })).status, 201);
    assert.equal((await call(b.agent.cookie, "DELETE", `/parties/link/${l2.json.link.id}`)).status, 204);
    // Pit Crew reads brokerage-wide but (Owner t274u) never links or unlinks,
    // even with grow.relationships.manage.
    assert.equal((await call(b.pc.cookie, "GET", `/parties/by-property/${b.adminProp}`)).status, 200);
    const l3 = await call(b.pc.cookie, "POST", "/parties", { propertyId: b.adminProp, partyId: b.partyId, role: "Other" });
    assert.equal(l3.status, 403);
    assert.equal((await call(b.pc.cookie, "DELETE", `/parties/link/${b.adminLinkId}`)).status, 403);
  });
}

test("Agent gets 404 reading, linking, creating or unlinking on a property they cannot see", async () => {
  const b = await setup("Scope", ["run.access", ...GROW]);
  const before = (await call(b.admin.cookie, "GET", `/parties/by-property/${b.adminProp}`)).json.parties.length;
  assert.equal((await call(b.agent.cookie, "GET", `/parties/by-property/${b.adminProp}`)).status, 404);
  assert.equal((await call(b.agent.cookie, "POST", "/parties", { propertyId: b.adminProp, partyId: b.partyId, role: "Other" })).status, 404);
  assert.equal((await call(b.agent.cookie, "POST", "/parties", { propertyId: b.adminProp, role: "Other", firstName: "Sneaky" })).status, 404);
  assert.equal((await call(b.agent.cookie, "DELETE", `/parties/link/${b.adminLinkId}`)).status, 404);
  const afterRows = (await call(b.admin.cookie, "GET", `/parties/by-property/${b.adminProp}`)).json.parties;
  assert.equal(afterRows.length, before, "no link was added or removed");
});

test("unsubscribed brokerage gets 403 on property-contact reads and mutations", async () => {
  const b = await setup("Unsub", []);
  for (const cookie of [b.admin.cookie, b.agent.cookie, b.pc.cookie]) {
    assert.equal((await call(cookie, "GET", `/parties/by-property/${b.adminProp}`)).status, 403);
    assert.equal((await call(cookie, "POST", "/parties", { propertyId: b.adminProp, partyId: b.partyId, role: "Other" })).status, 403);
    assert.equal((await call(cookie, "POST", "/parties", { propertyId: b.adminProp, role: "Other", firstName: "X" })).status, 403);
    assert.equal((await call(cookie, "DELETE", `/parties/link/${b.adminLinkId}`)).status, 403);
  }
  await setGrants(b.brokerageId, ["run.access"]);
  assert.equal((await call(b.admin.cookie, "GET", `/parties/by-property/${b.adminProp}`)).json.parties.length, 1, "nothing changed while unsubscribed");
});

test("other brokerage gets 404 on read, link, create and unlink", async () => {
  const a = await setup("IsoA", ["run.access", ...GROW]);
  const o = await setup("IsoB", ["run.access", ...GROW]);
  assert.equal((await call(o.admin.cookie, "GET", `/parties/by-property/${a.adminProp}`)).status, 404);
  assert.equal((await call(o.admin.cookie, "POST", "/parties", { propertyId: a.adminProp, partyId: o.partyId, role: "Other" })).status, 404);
  assert.equal((await call(o.admin.cookie, "POST", "/parties", { propertyId: o.adminProp, partyId: a.partyId, role: "Other" })).status, 404, "foreign contact");
  assert.equal((await call(o.admin.cookie, "POST", "/parties", { propertyId: a.adminProp, role: "Other", firstName: "X" })).status, 404);
  assert.equal((await call(o.admin.cookie, "DELETE", `/parties/link/${a.adminLinkId}`)).status, 404);
  // t274u: a foreign Pit Crew is refused by role first (403, no existence leak either way).
  assert.equal((await call(o.pc.cookie, "DELETE", `/parties/link/${a.adminLinkId}`)).status, 403);
});

test("t233u: read-only user (grow.contacts.read without manage, no Run) can read but cannot link, create, unlink or create a property", async () => {
  const b = await setup("ReadOnly", ["grow.access", "grow.contacts.read"]);
  assert.equal((await call(b.admin.cookie, "GET", `/parties/by-property/${b.adminProp}`)).status, 200);
  for (const cookie of [b.admin.cookie, b.agent.cookie]) {
    assert.equal((await call(cookie, "POST", "/parties", { propertyId: b.adminProp, partyId: b.partyId, role: "Other" })).status, 403);
    assert.equal((await call(cookie, "POST", "/parties", { propertyId: b.adminProp, role: "Other", firstName: "RO" })).status, 403);
    assert.equal((await call(cookie, "DELETE", `/parties/link/${b.adminLinkId}`)).status, 403);
    assert.equal((await call(cookie, "POST", "/properties", { formattedAddress: `RO ${cookie.length} ${tag} St, Testville`, state: "NSW", suburb: "Testville", postcode: "2000" })).status, 403);
  }
  assert.equal((await call(b.admin.cookie, "GET", `/parties/by-property/${b.adminProp}`)).json.parties.length, 1, "nothing changed");
});

test("t233u: POST /properties needs an active Grow or Run grant; an expired trial is refused", async () => {
  const b = await setup("PropGate", []);
  const body = (n: string) => ({ formattedAddress: `${n} ${tag} Gate St, Testville`, state: "NSW", suburb: "Testville", postcode: "2000" });
  assert.equal((await call(b.admin.cookie, "POST", "/properties", body("U1"))).status, 403, "unsubscribed");
  await db.insert(entitlementGrants).values({ brokerageId: b.brokerageId, entitlementKey: "grow.contacts.manage", granteeType: "brokerage", granteeId: b.brokerageId, sourceType: "admin_override", status: "Active", endsAt: new Date(Date.now() - 60_000) });
  invalidateEntitlementCache(b.brokerageId);
  assert.equal((await call(b.admin.cookie, "POST", "/properties", body("T1"))).status, 403, "expired trial");
  await setGrants(b.brokerageId, ["grow.access", "grow.contacts.read", "grow.contacts.manage"]);
  await db.update(entitlementGrants).set({ endsAt: new Date(Date.now() + 864e5) }).where(eq(entitlementGrants.brokerageId, b.brokerageId));
  invalidateEntitlementCache(b.brokerageId);
  assert.equal((await call(b.agent.cookie, "POST", "/properties", body("T2"))).status, 201, "current trial");
  await setGrants(b.brokerageId, ["run.access"]);
  assert.equal((await call(b.agent.cookie, "POST", "/properties", body("R1"))).status, 201, "Run");
});

test("t233u: Run-only property mutations (ownership-review, listing-details) need run.access and property visibility", async () => {
  const b = await setup("RunMut", ["run.access", ...GROW]);
  const lst = { salesMethod: "PrivateTreaty" };
  // Hidden property for the Agent: 404 (before validation of the body matters).
  assert.equal((await call(b.agent.cookie, "POST", `/properties/${b.adminProp}/ownership-review`, { notes: "x" })).status, 404);
  assert.equal((await call(b.agent.cookie, "POST", `/properties/${b.adminProp}/listing-details`, lst)).status, 404);
  await setGrants(b.brokerageId, GROW);
  assert.equal((await call(b.admin.cookie, "POST", `/properties/${b.adminProp}/ownership-review`, { notes: "x" })).status, 403, "Grow-only");
  assert.equal((await call(b.admin.cookie, "POST", `/properties/${b.adminProp}/listing-details`, lst)).status, 403, "Grow-only");
});

test("t246u: legacy Run brokerage (run.access only, no grow.* keys, no fixture grant): Admin and Agent can link, create, change role/primary and unlink on accessible properties", async () => {
  const b = await setup("LegacyRun", ["run.access"]);
  await removeRelationshipManageFixture(b.brokerageId);
  const ok = async (r: Promise<{ status: number; json: any }>, status: number, what: string) => {
    const x = await r;
    assert.equal(x.status, status, `${what}: ${JSON.stringify(x.json)}`);
    return x;
  };
  const l1 = await ok(call(b.admin.cookie, "POST", "/parties", { propertyId: b.adminProp, partyId: b.partyId, role: "Buyer" }), 201, "admin link existing");
  await ok(call(b.admin.cookie, "POST", "/parties", { propertyId: b.adminProp, role: "Other", firstName: "Legacy" }), 201, "admin create + link");
  await ok(call(b.admin.cookie, "PATCH", `/parties/link/${l1.json.link.id}`, { role: "Owner" }), 200, "admin role change");
  await ok(call(b.admin.cookie, "PATCH", `/parties/link/${l1.json.link.id}`, { isPrimary: true }), 200, "admin primary change");
  await ok(call(b.admin.cookie, "DELETE", `/parties/link/${l1.json.link.id}`), 204, "admin unlink");
  const l2 = await ok(call(b.agent.cookie, "POST", "/parties", { propertyId: b.agentProp, partyId: b.partyId, role: "Solicitor" }), 201, "agent link on own property");
  await ok(call(b.agent.cookie, "PATCH", `/parties/link/${l2.json.link.id}`, { role: "Buyer" }), 200, "agent role change");
  await ok(call(b.agent.cookie, "DELETE", `/parties/link/${l2.json.link.id}`), 204, "agent unlink");
  // Property scope still holds for the derived permission.
  await ok(call(b.agent.cookie, "POST", "/parties", { propertyId: b.adminProp, partyId: b.partyId, role: "Other" }), 404, "agent on hidden property");
  await ok(call(b.agent.cookie, "DELETE", `/parties/link/${b.adminLinkId}`), 404, "agent unlink on hidden property");
});

test("t246u/t242u/t274u: Pit Crew gets 403 on every relationship change (run.access alone or with grow.relationships.manage) and nothing changes; reads still work", async () => {
  const b = await setup("RunOnly", ["run.access"]);
  await removeRelationshipManageFixture(b.brokerageId);
  const p = b.adminProp;
  assert.equal((await call(b.pc.cookie, "GET", `/parties/by-property/${p}`)).status, 200, "Pit Crew can still read");
  const deny = async (r: Promise<{ status: number; json: any }>, what: string) => {
    const x = await r;
    assert.equal(x.status, 403, what);
    assert.equal(x.json.code, "RELATIONSHIP_WRITE_ROLE_BARRED", what);
  };
  await deny(call(b.pc.cookie, "POST", "/parties", { propertyId: p, partyId: b.partyId, role: "Buyer" }), "link existing");
  await deny(call(b.pc.cookie, "POST", "/parties", { propertyId: p, role: "Other", firstName: "X" }), "create + link");
  await deny(call(b.pc.cookie, "PATCH", `/parties/link/${b.adminLinkId}`, { role: "Owner" }), "role change");
  await deny(call(b.pc.cookie, "PATCH", `/parties/link/${b.adminLinkId}`, { isPrimary: true }), "primary change");
  await deny(call(b.pc.cookie, "DELETE", `/parties/link/${b.adminLinkId}`), "unlink");
  const rows = (await call(b.admin.cookie, "GET", `/parties/by-property/${p}`)).json.parties;
  assert.deepEqual(rows.map((r: any) => [r.linkId, r.role, r.isPrimary]), [[b.adminLinkId, "Seller", false]], "nothing changed");
  // Owner t274u: an explicit grow.relationships.manage grant no longer authorises Pit Crew.
  await setGrants(b.brokerageId, ["run.access", "grow.relationships.manage"]);
  const l = await call(b.pc.cookie, "POST", "/parties", { propertyId: p, partyId: b.partyId, role: "Other" });
  assert.equal(l.status, 403);
  assert.equal(l.json.code, "RELATIONSHIP_WRITE_ROLE_BARRED");
});

test("t246u: a revoked/expired run.access grant does not derive relationship management (403)", async () => {
  const b = await setup("RunRevoked", ["run.access"]);
  await removeRelationshipManageFixture(b.brokerageId);
  await db.update(entitlementGrants).set({ status: "Revoked" }).where(eq(entitlementGrants.brokerageId, b.brokerageId));
  invalidateEntitlementCache(b.brokerageId);
  const r = await call(b.admin.cookie, "POST", "/parties", { propertyId: b.adminProp, partyId: b.partyId, role: "Buyer" });
  assert.equal(r.status, 403);
});

test("t246u: read-only Grow user (contacts.read, no manage, no Run) is still refused; cross-brokerage legacy Run admin still gets 404", async () => {
  const ro = await setup("LegacyRO", ["grow.access", "grow.contacts.read"]);
  for (const cookie of [ro.admin.cookie, ro.agent.cookie]) {
    assert.equal((await call(cookie, "POST", "/parties", { propertyId: ro.adminProp, partyId: ro.partyId, role: "Buyer" })).status, 403);
    assert.equal((await call(cookie, "PATCH", `/parties/link/${ro.adminLinkId}`, { isPrimary: true })).status, 403);
    assert.equal((await call(cookie, "DELETE", `/parties/link/${ro.adminLinkId}`)).status, 403);
  }
  const a = await setup("LegacyIsoA", ["run.access"]);
  const o = await setup("LegacyIsoB", ["run.access"]);
  await removeRelationshipManageFixture(a.brokerageId);
  await removeRelationshipManageFixture(o.brokerageId);
  assert.equal((await call(o.admin.cookie, "POST", "/parties", { propertyId: a.adminProp, partyId: o.partyId, role: "Other" })).status, 404);
  assert.equal((await call(o.admin.cookie, "POST", "/parties", { propertyId: o.adminProp, partyId: a.partyId, role: "Other" })).status, 404, "foreign contact");
  assert.equal((await call(o.admin.cookie, "PATCH", `/parties/link/${a.adminLinkId}`, { role: "Owner" })).status, 404);
  assert.equal((await call(o.admin.cookie, "DELETE", `/parties/link/${a.adminLinkId}`)).status, 404);
});

test("t242u: grow.contacts.manage without grow.relationships.manage cannot link; with it (plus property access) can; property scope still 404s", async () => {
  const b = await setup("NoRel", GROW.filter((k) => k !== "grow.relationships.manage"));
  assert.equal((await call(b.admin.cookie, "POST", "/parties", { propertyId: b.adminProp, partyId: b.partyId, role: "Buyer" })).status, 403);
  await setGrants(b.brokerageId, ["grow.access", "grow.contacts.read", "grow.relationships.manage"]);
  // Linking an existing contact needs only the relationship key + property access.
  assert.equal((await call(b.admin.cookie, "POST", "/parties", { propertyId: b.adminProp, partyId: b.partyId, role: "Buyer" })).status, 201);
  // Creating a new contact additionally needs contact-creation rights.
  const cn = await call(b.admin.cookie, "POST", "/parties", { propertyId: b.adminProp, role: "Other", firstName: "New" });
  assert.equal(cn.status, 403);
  assert.equal(cn.json.entitlementKey, "grow.contacts.manage");
  // Property access is still required: an agent on the admin's property gets 404.
  assert.equal((await call(b.agent.cookie, "POST", "/parties", { propertyId: b.adminProp, partyId: b.partyId, role: "Solicitor" })).status, 404);
});
