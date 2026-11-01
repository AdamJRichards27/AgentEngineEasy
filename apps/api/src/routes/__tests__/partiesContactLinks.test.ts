// t228u Priority 2: GET /parties/by-contact/:partyId and PATCH /parties/link/:linkId
// (property_parties is the authoritative contact <-> property relationship).
// Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, entitlementGrants, users, ENTITLEMENT_KEYS } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin } from "./testSupport.js";

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


test("by-contact lists every linked property with role and primary, both directions agree, edits propagate", async () => {
  const b = await setup("Two", ["run.access", ...GROW]);
  const c2 = await call(b.admin.cookie, "POST", "/grow/contacts", { name: "Dana Dual", email: `dana-${tag}@example.com` });
  assert.equal(c2.status, 201);
  const dana = c2.json.contact.id as number;
  // Contact on two properties (two roles on one), and the property holds two contacts.
  assert.equal((await call(b.admin.cookie, "POST", "/parties", { propertyId: b.adminProp, partyId: dana, role: "Buyer", isPrimary: true })).status, 201);
  assert.equal((await call(b.admin.cookie, "POST", "/parties", { propertyId: b.agentProp, partyId: dana, role: "Seller" })).status, 201);
  assert.equal((await call(b.admin.cookie, "POST", "/parties", { propertyId: b.agentProp, partyId: dana, role: "Other" })).status, 201);
  const mine = await call(b.admin.cookie, "GET", `/parties/by-contact/${dana}`);
  assert.equal(mine.status, 200);
  const got = mine.json.properties.map((p: any) => `${p.propertyId}:${p.role}:${p.isPrimary}`).sort();
  assert.deepEqual(got, [`${b.adminProp}:Buyer:true`, `${b.agentProp}:Other:false`, `${b.agentProp}:Seller:false`].sort());
  assert.ok(mine.json.properties.every((p: any) => typeof p.formattedAddress === "string" && p.linkId > 0));
  const onProp = (await call(b.admin.cookie, "GET", `/parties/by-property/${b.adminProp}`)).json.parties.map((x: any) => x.party.id).sort();
  assert.deepEqual(onProp, [b.partyId, dana].sort((x, y) => x - y));
  // Agent sees only links on their own property.
  const agentView = await call(b.agent.cookie, "GET", `/parties/by-contact/${dana}`);
  assert.equal(agentView.status, 200);
  assert.deepEqual([...new Set(agentView.json.properties.map((p: any) => p.propertyId))], [b.agentProp]);
  // Contact edits show on both sides (one party row, live join).
  assert.equal((await call(b.admin.cookie, "PATCH", `/grow/contacts/${dana}`, { name: "Dana Renamed" })).status, 200);
  const renamed = (await call(b.agent.cookie, "GET", `/parties/by-property/${b.agentProp}`)).json.parties.find((x: any) => x.party.id === dana);
  assert.equal(renamed.party.firstName, "Dana");
  assert.equal(renamed.party.lastName, "Renamed");
});

test("PATCH link changes role and primary; duplicate role 409; validation 400", async () => {
  const b = await setup("Patch", ["run.access", ...GROW]);
  const l = await call(b.agent.cookie, "POST", "/parties", { propertyId: b.agentProp, partyId: b.partyId, role: "Buyer" });
  const l2 = await call(b.agent.cookie, "POST", "/parties", { propertyId: b.agentProp, partyId: b.partyId, role: "Other" });
  const id = l.json.link.id;
  const p1 = await call(b.agent.cookie, "PATCH", `/parties/link/${id}`, { isPrimary: true });
  assert.equal(p1.status, 200);
  assert.equal(p1.json.link.isPrimary, true);
  const p2 = await call(b.agent.cookie, "PATCH", `/parties/link/${id}`, { role: "Solicitor" });
  assert.equal(p2.status, 200);
  assert.equal(p2.json.link.role, "Solicitor");
  assert.equal(p2.json.link.isPrimary, true);
  const dup = await call(b.agent.cookie, "PATCH", `/parties/link/${l2.json.link.id}`, { role: "Solicitor" });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.code, "PROPERTY_PARTY_LINK_EXISTS");
  assert.equal((await call(b.agent.cookie, "PATCH", `/parties/link/${id}`, {})).status, 400);
  assert.equal((await call(b.agent.cookie, "PATCH", `/parties/link/${id}`, { role: "Occupier" })).status, 400);
  assert.equal((await call(b.agent.cookie, "PATCH", `/parties/link/${id}`, { role: "Seller", propertyId: 1 })).status, 400, "strict body");
  // Unlink removes only the link; the contact remains and other links stay.
  assert.equal((await call(b.agent.cookie, "DELETE", `/parties/link/${id}`)).status, 204);
  const left = (await call(b.admin.cookie, "GET", `/parties/by-contact/${b.partyId}`)).json.properties.map((p: any) => p.role).sort();
  assert.deepEqual(left, ["Other", "Seller"]);
});

test("by-contact and PATCH: hidden property, unsubscribed brokerage and other brokerage are refused", async () => {
  const a = await setup("NegA", ["run.access", ...GROW]);
  const o = await setup("NegB", ["run.access", ...GROW]);
  // Agent: contact readable, but links on the admin's property are omitted; PATCH on it is 404.
  assert.deepEqual((await call(a.agent.cookie, "GET", `/parties/by-contact/${a.partyId}`)).json.properties, []);
  assert.equal((await call(a.agent.cookie, "PATCH", `/parties/link/${a.adminLinkId}`, { isPrimary: true })).status, 404);
  // Other brokerage.
  assert.equal((await call(o.admin.cookie, "GET", `/parties/by-contact/${a.partyId}`)).status, 404);
  assert.equal((await call(o.pc.cookie, "PATCH", `/parties/link/${a.adminLinkId}`, { role: "Buyer" })).status, 404);
  // Unsubscribed.
  await setGrants(a.brokerageId, []);
  assert.equal((await call(a.admin.cookie, "GET", `/parties/by-contact/${a.partyId}`)).status, 403);
  assert.equal((await call(a.admin.cookie, "PATCH", `/parties/link/${a.adminLinkId}`, { isPrimary: true })).status, 403);
  // Grow-only and Run-only both allowed.
  for (const keys of [GROW, ["run.access"]]) {
    await setGrants(a.brokerageId, keys);
    assert.equal((await call(a.admin.cookie, "GET", `/parties/by-contact/${a.partyId}`)).status, 200);
    assert.equal((await call(a.admin.cookie, "PATCH", `/parties/link/${a.adminLinkId}`, { isPrimary: true })).status, 200);
  }
  const link = (await call(a.admin.cookie, "GET", `/parties/by-contact/${a.partyId}`)).json.properties[0];
  assert.equal(link.isPrimary, true, "unsubscribed PATCH changed nothing; later entitled PATCH did");
});

test("t234u: matching email/phone is a warning, never a rejection; existing contact id offered for reuse; Owner/Landlord/Tenant valid; Create Contact + Start Appraisal still work", async () => {
  const b = await setup("Dedupe", ["run.access", ...GROW]);
  const email = `dup-${tag}@example.com`;
  const first = await call(b.admin.cookie, "POST", "/parties", { propertyId: b.adminProp, role: "Owner", firstName: "Uma", email, mobile: "0412 345 678" });
  assert.equal(first.status, 201);
  assert.deepEqual(first.json.warnings, []);
  // Pre-flight check: warnings with the reusable id, nothing created.
  const check = await call(b.admin.cookie, "POST", "/parties/duplicate-check", { email: email.toUpperCase(), mobile: "+61412345678" });
  assert.equal(check.status, 200);
  assert.deepEqual(check.json.warnings.map((w: any) => [w.code, w.kind, w.contactId]), [
    ["POTENTIAL_DUPLICATE_CONTACT", "email", first.json.party.id],
    ["POTENTIAL_DUPLICATE_CONTACT", "phone", first.json.party.id],
  ]);
  // Shared household email: created (not rejected), with a warning — even if a client still sends the old opt-in flag.
  const byEmail = await call(b.admin.cookie, "POST", "/parties", { propertyId: b.agentProp, role: "Tenant", firstName: "Uma2", email: email.toUpperCase(), rejectDuplicateContact: true });
  assert.equal(byEmail.status, 201);
  assert.notEqual(byEmail.json.party.id, first.json.party.id);
  assert.deepEqual(byEmail.json.warnings, [{ code: "POTENTIAL_DUPLICATE_CONTACT", kind: "email", contactId: first.json.party.id }]);
  const byPhone = await call(b.admin.cookie, "POST", "/parties", { propertyId: b.agentProp, role: "Other", firstName: "Household", mobile: "+61412345678" });
  assert.equal(byPhone.status, 201);
  assert.equal(byPhone.json.warnings[0].kind, "phone");
  // Other brokerage never sees this brokerage's contact as a duplicate (isolation).
  const o = await setup("DedupeOther", ["run.access", ...GROW]);
  assert.deepEqual((await call(o.admin.cookie, "POST", "/parties/duplicate-check", { email })).json.warnings, []);
  // Unsubscribed brokerage cannot probe.
  await setGrants(o.brokerageId, []);
  assert.equal((await call(o.admin.cookie, "POST", "/parties/duplicate-check", { email })).status, 403);
  // The client links the existing contact instead: no duplicate party row.
  const linked = await call(b.admin.cookie, "POST", "/parties", { propertyId: b.agentProp, partyId: first.json.party.id, role: "Landlord" });
  assert.equal(linked.status, 201);
  assert.equal((await call(b.admin.cookie, "POST", "/parties", { propertyId: b.agentProp, partyId: first.json.party.id, role: "Landlord" })).status, 409, "duplicate link");
  assert.equal((await call(b.admin.cookie, "POST", "/parties", { propertyId: b.agentProp, partyId: first.json.party.id, role: "Occupier" })).status, 400, "unknown relationship type");
  // People "Create contact" (unchanged route) still dedupes and still creates.
  const warned = await call(b.admin.cookie, "POST", "/grow/contacts", { name: "Uma Again", email });
  assert.equal(warned.status, 409);
  assert.equal(warned.json.code, "POTENTIAL_DUPLICATE_CONTACT");
  assert.equal(warned.json.contactId, first.json.party.id);
  const confirmed = await call(b.admin.cookie, "POST", "/grow/contacts", { name: "Uma Again", email, confirmDuplicate: true });
  assert.equal(confirmed.status, 201, "confirmed shared email is created, not rejected");
  assert.equal(confirmed.json.warnings[0].contactId, first.json.party.id);
  const fresh = await call(b.agent.cookie, "POST", "/grow/contacts", { name: "Vic Fresh", email: `vic-${tag}@example.com` });
  assert.equal(fresh.status, 201);
  const vic = fresh.json.contact.id;
  assert.equal((await call(b.agent.cookie, "POST", "/parties", { propertyId: b.agentProp, partyId: vic, role: "Seller" })).status, 201);
  // Start Appraisal from the property screen's linked contact still works.
  const appr = await call(b.agent.cookie, "POST", "/grow/appraisals/from-contact", { partyId: vic, propertyId: b.agentProp, entry: "property" });
  assert.ok(appr.status === 201 || appr.status === 200, `start appraisal ${appr.status} ${JSON.stringify(appr.json)}`);
  assert.ok(appr.json.appraisal.id > 0);
});

test("t234u: at most one primary per property per role (Other exempt); primary optional; enforced on create, link-existing and PATCH", async () => {
  const b = await setup("Primary", ["run.access", ...GROW]);
  const p = b.adminProp;
  // setup's Seller link is not primary; primary is optional.
  const s1 = await call(b.admin.cookie, "POST", "/parties", { propertyId: p, role: "Seller", firstName: "Pri", isPrimary: true });
  assert.equal(s1.status, 201);
  const s2 = await call(b.admin.cookie, "POST", "/parties", { propertyId: p, role: "Seller", firstName: "Pri2", isPrimary: true });
  assert.equal(s2.status, 409);
  assert.equal(s2.json.code, "PROPERTY_PARTY_PRIMARY_EXISTS");
  assert.equal(s2.json.existingLinkId, s1.json.link.id);
  // The refused create left no orphan contact behind.
  const sellers = (await call(b.admin.cookie, "GET", `/parties/by-property/${p}`)).json.parties.filter((x: any) => x.role === "Seller");
  assert.equal(sellers.length, 2);
  // Non-primary second seller is fine; a primary Buyer is fine (different role).
  assert.equal((await call(b.admin.cookie, "POST", "/parties", { propertyId: p, role: "Seller", firstName: "Co" })).status, 201);
  assert.equal((await call(b.admin.cookie, "POST", "/parties", { propertyId: p, role: "Buyer", firstName: "Bea", isPrimary: true })).status, 201);
  // Link-existing path.
  const le = await call(b.admin.cookie, "POST", "/parties", { propertyId: p, partyId: b.partyId, role: "Owner", isPrimary: true });
  assert.equal(le.status, 201);
  const other = await call(b.admin.cookie, "POST", "/parties", { propertyId: p, role: "Owner", firstName: "Own2", isPrimary: true });
  assert.equal(other.status, 409);
  // PATCH: promoting the setup Seller link clashes; demote first then promote works.
  assert.equal((await call(b.admin.cookie, "PATCH", `/parties/link/${b.adminLinkId}`, { isPrimary: true })).json.code, "PROPERTY_PARTY_PRIMARY_EXISTS");
  assert.equal((await call(b.admin.cookie, "PATCH", `/parties/link/${s1.json.link.id}`, { isPrimary: false })).status, 200);
  assert.equal((await call(b.admin.cookie, "PATCH", `/parties/link/${b.adminLinkId}`, { isPrimary: true })).status, 200);
  // Re-saving the current primary is not a clash with itself.
  assert.equal((await call(b.admin.cookie, "PATCH", `/parties/link/${b.adminLinkId}`, { isPrimary: true })).status, 200);
  // Role change onto a role that already has a primary is refused.
  const ownLink = le.json.link.id;
  assert.equal((await call(b.admin.cookie, "PATCH", `/parties/link/${ownLink}`, { role: "Buyer" })).status, 409);
  // Other is exempt: two primaries allowed.
  assert.equal((await call(b.admin.cookie, "POST", "/parties", { propertyId: p, role: "Other", firstName: "O1", isPrimary: true })).status, 201);
  assert.equal((await call(b.admin.cookie, "POST", "/parties", { propertyId: p, role: "Other", firstName: "O2", isPrimary: true })).status, 201);
});
