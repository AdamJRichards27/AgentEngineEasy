// Owner t274u item 4: Pit Crew never creates, edits or unlinks relationship
// records on any route, regardless of entitlements. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { and } from "drizzle-orm";
import { db, entitlementGrants, users, properties, ENTITLEMENT_KEYS, growRelationships, growContactRelationships, propertyParties, GROW_CONTACT_RELATIONSHIP_TYPES, GROW_RELATIONSHIP_TYPES } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin } from "./testSupport.js";

const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const tag = `pcbar-${Date.now()}`;
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
const BAR = "RELATIONSHIP_WRITE_ROLE_BARRED";
const linkRows = (propertyId: number) => db.select().from(propertyParties).where(eq(propertyParties.propertyId, propertyId));

// Every route that mutates property_parties, grow_relationships or
// grow_contact_relationships, with Pit Crew holding EVERY entitlement
// (grow.relationships.manage included). Each must refuse and leave no write.
test("t274u Pit Crew bar: POST /parties (link existing contact) is refused even with grow.relationships.manage", async () => {
  const w = await world("PostLink");
  const r = await call(w.pc.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Buyer" });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json?.code, BAR);
  assert.equal((await linkRows(w.adminProp)).length, 0);
});

test("t274u Pit Crew bar: POST /parties (new contact) is refused", async () => {
  const w = await world("PostNew");
  const r = await call(w.pc.cookie, "POST", "/parties", { propertyId: w.adminProp, role: "Seller", partyType: "Person", firstName: "Nora", lastName: "New" });
  assert.equal(r.status, 403, r.text);
  assert.equal((await linkRows(w.adminProp)).length, 0);
});

test("t274u Pit Crew bar: PATCH and DELETE /parties/link/:id are refused; link unchanged", async () => {
  const w = await world("Link");
  const made = await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Buyer" });
  assert.equal(made.status, 201, made.text);
  const [row] = await linkRows(w.adminProp);
  const p = await call(w.pc.cookie, "PATCH", `/parties/link/${row.id}`, { role: "Seller" });
  assert.equal(p.status, 403, p.text);
  const d = await call(w.pc.cookie, "DELETE", `/parties/link/${row.id}`);
  assert.equal(d.status, 403, d.text);
  const after = await linkRows(w.adminProp);
  assert.equal(after.length, 1);
  assert.equal(after[0].role, "Buyer");
  // control: an admin may still change it
  assert.equal((await call(w.admin.cookie, "PATCH", `/parties/link/${row.id}`, { role: "Seller" })).status, 200);
});

test("t274u Pit Crew bar: POST and PATCH /grow/relationships are refused", async () => {
  const w = await world("Grow");
  const type = GROW_RELATIONSHIP_TYPES[0];
  const r = await call(w.pc.cookie, "POST", "/grow/relationships", { partyId: w.partyId, propertyId: w.adminProp, relationshipType: type });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json?.code, BAR);
  assert.equal((await growRowsFor(w.partyId)).length, 0);
  const ok = await call(w.admin.cookie, "POST", "/grow/relationships", { partyId: w.partyId, propertyId: w.adminProp, relationshipType: type });
  assert.equal(ok.status, 201, ok.text);
  const [g] = await growRowsFor(w.partyId);
  const p = await call(w.pc.cookie, "PATCH", `/grow/relationships/${g.id}`, { status: "Inactive" });
  assert.equal(p.status, 403, p.text);
  const [g2] = await growRowsFor(w.partyId);
  assert.deepEqual({ s: g2.status, t: g2.relationshipType }, { s: g.status, t: g.relationshipType });
});

test("t274u Pit Crew bar: household POST /grow/contacts/:id/relationships and DELETE /grow/contacts/relationships/:id are refused", async () => {
  const w = await world("House");
  const other = await call(w.admin.cookie, "POST", "/grow/contacts", { name: "Hal Household", email: `hal-${tag}@example.com` });
  assert.equal(other.status, 201, other.text);
  const relatedPartyId = other.json.contact.id as number;
  const relationshipType = GROW_CONTACT_RELATIONSHIP_TYPES[0];
  const r = await call(w.pc.cookie, "POST", `/grow/contacts/${w.partyId}/relationships`, { relatedPartyId, relationshipType });
  assert.equal(r.status, 403, r.text);
  const rows = () => db.select().from(growContactRelationships).where(eq(growContactRelationships.partyId, w.partyId));
  assert.equal((await rows()).length, 0);
  const ok = await call(w.admin.cookie, "POST", `/grow/contacts/${w.partyId}/relationships`, { relatedPartyId, relationshipType });
  assert.equal(ok.status, 201, ok.text);
  const [h] = await rows();
  const d = await call(w.pc.cookie, "DELETE", `/grow/contacts/relationships/${h.id}`);
  assert.equal(d.status, 403, d.text);
  assert.equal((await rows()).length, 1);
});

test("t274u Pit Crew bar: recording an offer that would link a new buyer is refused; an already-linked buyer is allowed and adds no link", async () => {
  const w = await world("Offer");
  await db.update(properties).set({ workflowStage: "Listed" }).where(eq(properties.id, w.adminProp));
  const r = await call(w.pc.cookie, "POST", `/offers/by-property/${w.adminProp}`, { offerPriceCents: 100000000, buyer: { firstName: "Bea", lastName: "Buyer" } });
  assert.equal(r.status, 403, r.text);
  const r2 = await call(w.pc.cookie, "POST", `/offers/by-property/${w.adminProp}`, { offerPriceCents: 100000000, buyerPartyId: w.partyId });
  assert.equal(r2.status, 403, r2.text);
  assert.equal((await linkRows(w.adminProp)).length, 0);
  assert.equal((await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Buyer" })).status, 201);
  const r3 = await call(w.pc.cookie, "POST", `/offers/by-property/${w.adminProp}`, { offerPriceCents: 100000000, buyerPartyId: w.partyId });
  assert.equal(r3.status, 201, r3.text);
  const links = await db.select().from(propertyParties).where(and(eq(propertyParties.propertyId, w.adminProp), eq(propertyParties.role, "Buyer")));
  assert.equal(links.length, 1);
});

test("t274u Pit Crew bar: appraisal run-handoff and import execute/rollback are refused before any lookup", async () => {
  const w = await world("Misc");
  for (const path of ["/grow/appraisals/999999/run-handoff", "/import/jobs/999999/execute", "/import/jobs/999999/rollback"]) {
    const r = await call(w.pc.cookie, "POST", path, {});
    assert.equal(r.status, 403, `${path}: ${r.text}`);
    assert.equal(r.json?.code, BAR, path);
    // control: the admin reaches the route (not barred by role)
    const a = await call(w.admin.cookie, "POST", path, {});
    assert.notEqual(a.json?.code, BAR, path);
  }
});
