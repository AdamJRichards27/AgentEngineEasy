// t273u X10 fix: the desktop Contact 360 "Link property" form now makes a
// canonical property_parties link through the existing POST /parties path
// (body { propertyId, partyId, role }). These tests pin, at the API, what the
// form relies on: link, retrieval in every surface (by-contact = phone and
// desktop Contact 360, by-property = property page on phone and Grow desktop,
// the Run workspace), unlink, permission negatives, Run-only masking, no
// Grow-only write, and that older Grow-only rows are left alone (no
// migration). Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, entitlementGrants, users, ENTITLEMENT_KEYS, growRelationships, propertyParties } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin } from "./testSupport.js";

const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const tag = `x10-${Date.now()}`;
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

const byContact = async (cookie: string, partyId: number) => call(cookie, "GET", `/parties/by-contact/${partyId}`);
const byProperty = async (cookie: string, propertyId: number) => call(cookie, "GET", `/parties/by-property/${propertyId}`);
const workspace = async (cookie: string, propertyId: number) => call(cookie, "GET", `/properties/${propertyId}/workspace`);
const growRowsFor = async (partyId: number) => db.select().from(growRelationships).where(eq(growRelationships.partyId, partyId));
const canonicalRowsFor = async (partyId: number) => db.select().from(propertyParties).where(eq(propertyParties.partyId, partyId));

test("X10: the form's POST /parties body makes ONE canonical link, visible in by-contact, by-property and the Run workspace; no Grow-only row", async () => {
  const w = await world("Link");
  const r = await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Owner" });
  assert.equal(r.status, 201, r.text);
  const linkId = r.json.link.id as number;
  assert.equal((await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Owner" })).status, 409, "duplicate refused by the existing check");
  assert.equal((await canonicalRowsFor(w.partyId)).length, 1, "exactly one canonical link");
  assert.equal((await growRowsFor(w.partyId)).length, 0, "no Grow-only relationship (no dual-write)");

  const bc = await byContact(w.admin.cookie, w.partyId);
  assert.equal(bc.status, 200);
  assert.deepEqual(bc.json.properties.map((p: any) => [p.propertyId, p.role, p.isPrimary]), [[w.adminProp, "Owner", false]]);
  assert.deepEqual(bc.json.links.map((l: any) => l.linkId), [linkId]);

  const bp = await byProperty(w.admin.cookie, w.adminProp);
  assert.ok(bp.json.parties.some((p: any) => p.linkId === linkId && p.party.id === w.partyId && p.role === "Owner"));

  const ws = await workspace(w.admin.cookie, w.adminProp);
  assert.equal(ws.status, 200);
  const row = ws.json.parties.find((p: any) => p.linkId === linkId);
  assert.ok(row, "Run workspace lists the same link");
  assert.equal(row.role, "Owner");
  assert.equal(row.isPrimary, false);
});

test("X10/X12: making the canonical link primary shows isPrimary in all three surfaces (the field Run's marker reads)", async () => {
  const w = await world("Primary");
  const r = await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Owner" });
  const linkId = r.json.link.id as number;
  assert.equal((await call(w.admin.cookie, "PATCH", `/parties/link/${linkId}`, { isPrimary: true })).status, 200);
  assert.equal((await byContact(w.admin.cookie, w.partyId)).json.properties[0].isPrimary, true);
  assert.equal((await byProperty(w.admin.cookie, w.adminProp)).json.parties.find((p: any) => p.linkId === linkId).isPrimary, true);
  assert.equal((await workspace(w.admin.cookie, w.adminProp)).json.parties.find((p: any) => p.linkId === linkId).isPrimary, true);
});

test("X10: unlink acts on the canonical link only; the contact and the property survive", async () => {
  const w = await world("Unlink");
  const r = await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Buyer" });
  const linkId = r.json.link.id as number;
  const d = await call(w.admin.cookie, "DELETE", `/parties/link/${linkId}`);
  assert.ok(d.status === 204 || d.status === 200, `unlink ${d.status} ${d.text}`);
  assert.equal((await canonicalRowsFor(w.partyId)).length, 0);
  assert.equal((await byContact(w.admin.cookie, w.partyId)).json.properties.length, 0);
  assert.ok(!(await byProperty(w.admin.cookie, w.adminProp)).json.parties.some((p: any) => p.linkId === linkId));
  assert.ok(!(await workspace(w.admin.cookie, w.adminProp)).json.parties.some((p: any) => p.linkId === linkId));
  assert.equal((await call(w.admin.cookie, "GET", `/grow/contacts/${w.partyId}`)).status, 200, "contact still exists");
  assert.equal((await call(w.admin.cookie, "GET", `/properties/${w.adminProp}`)).status, 200, "property still exists");
});

test("X10 permission negatives: Pit Crew via run.access 403, read-only 403, Agent on another agent's property 404, other brokerage 404; nothing written", async () => {
  const w = await world("Perm");
  const other = await world("PermOther");
  assert.equal((await call(w.agent.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Owner" })).status, 404, "own-property rule");
  assert.equal((await call(other.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Owner" })).status, 404, "other brokerage gets the missing-property answer");
  assert.equal((await call(other.admin.cookie, "POST", "/parties", { propertyId: other.adminProp, partyId: w.partyId, role: "Owner" })).status, 404, "a contact from another brokerage cannot be linked");
  // Run-only brokerage: run.access lets Agent / Brokerage Administrator manage, never Pit Crew
  // (requireRelationshipManage; a grow.relationships.manage grant would allow any role).
  await setGrants(w.brokerageId, ["run.access"]);
  assert.equal((await call(w.pc.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Owner" })).status, 403, "Pit Crew cannot link through run.access");
  await setGrants(w.brokerageId, ["grow.access", "grow.contacts.read"]);
  assert.equal((await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Owner" })).status, 403, "read-only cannot link");
  assert.equal((await canonicalRowsFor(w.partyId)).length, 0);
  assert.equal((await growRowsFor(w.partyId)).length, 0);
  // the Agent may link on their own property
  await setGrants(w.brokerageId, ["run.access", ...GROW]);
  assert.equal((await call(w.agent.cookie, "POST", "/parties", { propertyId: w.agentProp, partyId: w.partyId, role: "Tenant" })).status, 201);
  // and cannot see or unlink the admin's link
  const adminLink = await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Owner" });
  assert.equal((await call(w.agent.cookie, "DELETE", `/parties/link/${adminLink.json.link.id}`)).status, 404);
  assert.deepEqual((await byContact(w.agent.cookie, w.partyId)).json.properties.map((p: any) => p.propertyId), [w.agentProp], "the Agent sees only their own property");
});

test("X10 Run-only masking: a Run-only caller sees the canonical link with the contact masked", async () => {
  const w = await world("Mask");
  assert.equal((await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Owner" })).status, 201);
  await setGrants(w.brokerageId, ["run.access"]);
  const bp = await byProperty(w.admin.cookie, w.adminProp);
  assert.equal(bp.status, 200);
  const row = bp.json.parties.find((p: any) => p.party.id === w.partyId);
  assert.ok(row, "the link is visible to Run");
  assert.ok(!JSON.stringify(row).includes("0400 000 111") && !JSON.stringify(row).includes("0400000111"), "no full number");
  assert.ok(!String(row.party.email ?? "").startsWith("lena-"), "email masked");
  const bc = await byContact(w.admin.cookie, w.partyId);
  assert.ok(bc.status === 403 || !bc.text.includes("0400"), `by-contact for Run-only is refused or masked (${bc.status})`);
});

test("X10 older Grow-only rows: left as Grow history, not migrated, not shown as canonical links; a new canonical link leaves them untouched", async () => {
  const w = await world("Legacy");
  const g = await call(w.admin.cookie, "POST", "/grow/relationships", { partyId: w.partyId, propertyId: w.adminProp, relationshipType: "prospective_seller" });
  assert.equal(g.status, 201, g.text);
  const before = await growRowsFor(w.partyId);
  assert.equal(before.length, 1);
  assert.equal((await canonicalRowsFor(w.partyId)).length, 0, "old path wrote no canonical link and nothing migrates it");
  assert.equal((await byContact(w.admin.cookie, w.partyId)).json.properties.length, 0);
  const c360 = await call(w.admin.cookie, "GET", `/grow/contacts/${w.partyId}`);
  assert.ok(JSON.stringify(c360.json).includes("prospective_seller"), "still listed as Grow interest");
  assert.equal((await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Seller" })).status, 201);
  const after = await growRowsFor(w.partyId);
  assert.deepEqual(after.map((r) => [r.id, r.relationshipType, r.status]), before.map((r) => [r.id, r.relationshipType, r.status]), "Grow row unchanged, not deleted");
  assert.equal((await canonicalRowsFor(w.partyId)).length, 1);
});

test("X10 Today first-run: a canonical link alone completes 'Link a property to a contact'", async () => {
  const w = await world("FirstRun");
  const t0 = await call(w.admin.cookie, "GET", "/grow/today");
  assert.equal(t0.json.firstRun.propertyLink, false);
  assert.equal((await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Owner" })).status, 201);
  const t1 = await call(w.admin.cookie, "GET", "/grow/today");
  assert.equal(t1.json.firstRun.propertyLink, true);
  const ta = await call(w.agent.cookie, "GET", "/grow/today");
  assert.equal(ta.json.firstRun.propertyLink, false, "an Agent does not count a link on a property they cannot see");
});
