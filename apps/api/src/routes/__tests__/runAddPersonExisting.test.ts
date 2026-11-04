// Owner t274u item 1 (R03). Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { and } from "drizzle-orm";
import { db, entitlementGrants, users, properties, parties, ENTITLEMENT_KEYS, growRelationships, growContactRelationships, propertyParties, GROW_CONTACT_RELATIONSHIP_TYPES, GROW_RELATIONSHIP_TYPES } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin } from "./testSupport.js";

const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const tag = `r03-${Date.now()}`;
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


const linkRows = (propertyId: number) => db.select().from(propertyParties).where(eq(propertyParties.propertyId, propertyId));

// Owner t274u R03: Run "+ Add Person" search/select, and server-side duplicate
// prevention (duplicateGuard "confirm"). Synthetic data only.
test("t274u R03: POST /parties/search finds existing contacts by name, brokerage-scoped; Run-only gets masked email/mobile and no email/phone matching", async () => {
  const w = await world("Search");
  const o = await world("SearchOther");
  // Full-Grow admin: full details; email match works.
  const full = await call(w.admin.cookie, "POST", "/parties/search", { q: "lena" });
  assert.equal(full.status, 200, full.text);
  assert.deepEqual(full.json.contacts.map((c: any) => c.id), [w.partyId]);
  assert.match(full.json.contacts[0].email, /^lena-/);
  assert.equal((await call(w.admin.cookie, "POST", "/parties/search", { q: "0400 000 111" })).json.contacts.length, 1);
  assert.equal((await call(w.admin.cookie, "POST", "/parties/search", { q: "lena linkform" })).json.contacts.length, 1, "full name");
  // Other brokerage never sees it.
  assert.deepEqual((await call(o.admin.cookie, "POST", "/parties/search", { q: "Linkform" })).json.contacts.map((c: any) => c.id), [o.partyId]);
  // Run-only (no grow.contacts.read): name match, masked details, no email/mobile probing.
  await setGrants(w.brokerageId, ["run.access"]);
  const masked = await call(w.agent.cookie, "POST", "/parties/search", { q: "Lena" });
  assert.equal(masked.status, 200, masked.text);
  assert.equal(masked.json.contacts.length, 1);
  assert.doesNotMatch(String(masked.json.contacts[0].email), /^lena-/);
  assert.notEqual(masked.json.contacts[0].mobile, "0400 000 111");
  assert.equal((await call(w.agent.cookie, "POST", "/parties/search", { q: `lena-search-${tag}` })).json.contacts.length, 0, "no email probing");
  // Pit Crew refused; too-short query refused.
  assert.equal((await call(w.pc.cookie, "POST", "/parties/search", { q: "Lena" })).status, 403);
  assert.equal((await call(w.agent.cookie, "POST", "/parties/search", { q: "L" })).status, 400);
});

test("t274u R03: selecting an existing contact links it (no new party); duplicateGuard confirm refuses a duplicate create with 409 until Create anyway", async () => {
  const w = await world("Guard");
  const before = (await db.select().from(parties).where(eq(parties.brokerageId, w.brokerageId))).length;
  const link = await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Buyer" });
  assert.equal(link.status, 201, link.text);
  assert.equal((await db.select().from(parties).where(eq(parties.brokerageId, w.brokerageId))).length, before, "no new contact");
  const email = `lena-guard-${tag}@example.com`;
  const dup = await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, role: "Seller", partyType: "Person", firstName: "Lena", lastName: "Again", email, duplicateGuard: "confirm" });
  assert.equal(dup.status, 409, dup.text);
  assert.equal(dup.json.code, "POTENTIAL_DUPLICATE_CONTACT");
  assert.equal(dup.json.warnings[0].contactId, w.partyId);
  assert.equal((await db.select().from(parties).where(eq(parties.brokerageId, w.brokerageId))).length, before, "nothing created on 409");
  assert.equal((await linkRows(w.adminProp)).length, 1);
  const anyway = await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, role: "Seller", partyType: "Person", firstName: "Lena", lastName: "Again", email, duplicateGuard: "confirm", confirmNewContact: true });
  assert.equal(anyway.status, 201, anyway.text);
  assert.notEqual(anyway.json.party.id, w.partyId);
  // No match: guard does not block.
  const fresh = await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, role: "Other", partyType: "Person", firstName: "Nova", email: `nova-${tag}@example.com`, duplicateGuard: "confirm" });
  assert.equal(fresh.status, 201, fresh.text);
  // Callers without the guard keep the t234u warn-only behaviour.
  const legacy = await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, role: "Other", partyType: "Person", firstName: "Legacy", email });
  assert.equal(legacy.status, 201);
  assert.equal(legacy.json.warnings.length, 1);
});

test("t274u R03: Run-only caller gets the 409 without the matched contactId (masking)", async () => {
  const w = await world("GuardMasked");
  await setGrants(w.brokerageId, ["run.access"]);
  const dup = await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, role: "Seller", partyType: "Person", firstName: "M", mobile: "0400 000 111", duplicateGuard: "confirm" });
  assert.equal(dup.status, 409, dup.text);
  assert.deepEqual(dup.json.warnings, [{ code: "POTENTIAL_DUPLICATE_CONTACT", kind: "phone" }]);
  const pre = await call(w.admin.cookie, "POST", "/parties/duplicate-check", { mobile: "0400 000 111" });
  assert.deepEqual(pre.json.warnings, [{ code: "POTENTIAL_DUPLICATE_CONTACT", kind: "phone" }]);
});
