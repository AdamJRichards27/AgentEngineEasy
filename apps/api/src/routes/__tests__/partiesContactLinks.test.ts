// t228u Priority 2: GET /parties/by-contact/:partyId and PATCH /parties/link/:linkId
// (property_parties is the authoritative contact <-> property relationship).
// Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { db, entitlementGrants, users, auditLogs, workflows, amlVerifications, ENTITLEMENT_KEYS, PROPERTY_PARTY_ROLES, properties as propertiesTable, propertyParties as propertyPartiesTable } from "@aee/db";
import { BY_CONTACT_LIMIT } from "../parties.js";
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
  // t246u: a Run-only (legacy) Brokerage Administrator has Run contact-management
  // rights, so the relationship permission is derived (Pit Crew is covered in partiesAccess).
  await setGrants(a.brokerageId, ["run.access"]);
  assert.equal((await call(a.admin.cookie, "GET", `/parties/by-contact/${a.partyId}`)).status, 200);
  assert.equal((await call(a.admin.cookie, "PATCH", `/parties/link/${a.adminLinkId}`, { isPrimary: true })).status, 200);
  // Grow (incl. grow.relationships.manage), and Run with the relationship key, both allowed.
  for (const keys of [GROW, ["run.access", "grow.relationships.manage"]]) {
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

test("t238u: setting a new primary atomically replaces the old one in the same (property, role); previous keeps the relationship; audited from/to; Other exempt", async () => {
  const b = await setup("Primary", ["run.access", ...GROW]);
  const p = b.adminProp;
  const s1 = await call(b.admin.cookie, "POST", "/parties", { propertyId: p, role: "Seller", firstName: "Pri", isPrimary: true });
  assert.equal(s1.status, 201);
  assert.deepEqual(s1.json.changed, []);
  // Create path: a second primary Seller replaces the first.
  const s2 = await call(b.admin.cookie, "POST", "/parties", { propertyId: p, role: "Seller", firstName: "Pri2", isPrimary: true });
  assert.equal(s2.status, 201);
  assert.deepEqual(s2.json.changed, [{ id: s1.json.link.id, linkId: s1.json.link.id, role: "Seller", isPrimary: false }]);
  const sellers = () => call(b.admin.cookie, "GET", `/parties/by-property/${p}`).then((r) => r.json.parties.filter((x: any) => x.role === "Seller"));
  let now = await sellers();
  assert.equal(now.length, 3, "previous primary keeps its Seller relationship");
  assert.deepEqual(now.filter((x: any) => x.isPrimary).map((x: any) => x.linkId), [s2.json.link.id]);
  const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "party_link_primary_replaced"), eq(auditLogs.recordId, String(s1.json.link.id))));
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0].previousValue!), { role: "Seller", isPrimary: true });
  assert.deepEqual(JSON.parse(audit[0].updatedValue!), { role: "Seller", isPrimary: false, replacedByLinkId: s2.json.link.id });
  assert.equal(audit[0].userId, b.admin.user.id);
  // A different role is independent.
  const bea = await call(b.admin.cookie, "POST", "/parties", { propertyId: p, role: "Buyer", firstName: "Bea", isPrimary: true });
  assert.deepEqual(bea.json.changed, []);
  // Link-existing path replaces too.
  const le = await call(b.admin.cookie, "POST", "/parties", { propertyId: p, partyId: b.partyId, role: "Owner", isPrimary: true });
  assert.equal(le.status, 201);
  const own2 = await call(b.admin.cookie, "POST", "/parties", { propertyId: p, role: "Owner", firstName: "Own2", isPrimary: true });
  assert.equal(own2.status, 201);
  assert.deepEqual(own2.json.changed, [{ id: le.json.link.id, linkId: le.json.link.id, role: "Owner", isPrimary: false }]);
  // PATCH path: promoting the setup Seller replaces s2, with from/to on the update.
  const pr = await call(b.admin.cookie, "PATCH", `/parties/link/${b.adminLinkId}`, { isPrimary: true });
  assert.equal(pr.status, 200);
  assert.deepEqual(pr.json.changed, [
    { id: s2.json.link.id, linkId: s2.json.link.id, role: "Seller", isPrimary: false },
    { id: b.adminLinkId, linkId: b.adminLinkId, role: "Seller", isPrimary: true },
  ]);
  now = await sellers();
  assert.deepEqual(now.filter((x: any) => x.isPrimary).map((x: any) => x.linkId), [b.adminLinkId]);
  const upd = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "party_link_updated"), eq(auditLogs.recordId, String(b.adminLinkId))));
  assert.equal(upd.length, 1);
  assert.deepEqual(JSON.parse(upd[0].previousValue!), { role: "Seller", isPrimary: false });
  assert.deepEqual(JSON.parse(upd[0].updatedValue!), { role: "Seller", isPrimary: true });
  // Re-saving the same values: 200, nothing changed, no extra audit row.
  const same = await call(b.admin.cookie, "PATCH", `/parties/link/${b.adminLinkId}`, { isPrimary: true });
  assert.equal(same.status, 200);
  assert.deepEqual(same.json.changed, []);
  assert.equal((await db.select().from(auditLogs).where(and(eq(auditLogs.action, "party_link_updated"), eq(auditLogs.recordId, String(b.adminLinkId))))).length, 1);
  // Role change of a primary link onto a role with a primary replaces that one.
  const rc = await call(b.admin.cookie, "PATCH", `/parties/link/${own2.json.link.id}`, { role: "Buyer" });
  assert.equal(rc.status, 200);
  assert.deepEqual(rc.json.changed, [
    { id: bea.json.link.id, linkId: bea.json.link.id, role: "Buyer", isPrimary: false },
    { id: own2.json.link.id, linkId: own2.json.link.id, role: "Buyer", isPrimary: true },
  ]);
  // Invariant: at most one primary per non-exempt (property, role).
  const all = (await call(b.admin.cookie, "GET", `/parties/by-property/${p}`)).json.parties;
  for (const role of ["Seller", "Buyer", "Owner"]) assert.ok(all.filter((x: any) => x.role === role && x.isPrimary).length <= 1, role);
  // Other is exempt: two primaries allowed, nothing replaced.
  assert.deepEqual((await call(b.admin.cookie, "POST", "/parties", { propertyId: p, role: "Other", firstName: "O1", isPrimary: true })).json.changed, []);
  assert.deepEqual((await call(b.admin.cookie, "POST", "/parties", { propertyId: p, role: "Other", firstName: "O2", isPrimary: true })).json.changed, []);
});

test("t238u: concurrent primary requests on one (property, role) end with exactly one primary", async () => {
  const b = await setup("PrimaryRace", ["run.access", ...GROW]);
  const p = b.adminProp;
  const rs = await Promise.all([1, 2, 3, 4, 5].map((n) => call(b.admin.cookie, "POST", "/parties", { propertyId: p, role: "Seller", firstName: `Race${n}`, isPrimary: true })));
  assert.ok(rs.every((r) => r.status === 201));
  const rows = (await call(b.admin.cookie, "GET", `/parties/by-property/${p}`)).json.parties.filter((x: any) => x.role === "Seller");
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((x: any) => x.isPrimary).length, 1);
});

test("t238u contract items 4-6: INVALID_ROLE with allowedRoles; NOTHING_TO_CHANGE; by-contact links[] + truncated", async () => {
  const b = await setup("Contract", ["run.access", ...GROW]);
  const bad = await call(b.admin.cookie, "POST", "/parties", { propertyId: b.adminProp, role: "Occupier", firstName: "X" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "INVALID_ROLE");
  assert.deepEqual(bad.json.allowedRoles, [...PROPERTY_PARTY_ROLES]);
  const badPatch = await call(b.admin.cookie, "PATCH", `/parties/link/${b.adminLinkId}`, { role: "Occupier" });
  assert.equal(badPatch.json.code, "INVALID_ROLE");
  const empty = await call(b.admin.cookie, "PATCH", `/parties/link/${b.adminLinkId}`, {});
  assert.equal(empty.status, 400);
  assert.equal(empty.json.code, "NOTHING_TO_CHANGE");
  const bc = await call(b.admin.cookie, "GET", `/parties/by-contact/${b.partyId}`);
  assert.equal(bc.json.truncated, false);
  assert.equal(bc.json.links.length, 1);
  assert.equal(bc.json.links[0].linkId, b.adminLinkId);
  assert.equal(bc.json.links[0].property.id, b.adminProp);
  assert.equal(bc.json.links[0].property.postcode, "2000");
  assert.equal(bc.json.properties.length, 1, "flat shape kept for the web client");
});

test("t238u: Grow-only agents record Seller relationships with no AML, ownership review, Run or Pit Crew side effects; Run callers keep them", async () => {
  const b = await setup("GrowSeller", ["run.access", ...GROW]);
  // A Ready-to-List workflow exists (the condition under which a Run seller triggers AML).
  await db.insert(workflows).values({ propertyId: b.adminProp, workflowType: "ReadyToList" });
  await setGrants(b.brokerageId, GROW);
  const g = await call(b.admin.cookie, "POST", "/parties", { propertyId: b.adminProp, role: "Seller", firstName: "Grow", lastName: "Seller" });
  assert.equal(g.status, 201, JSON.stringify(g.json));
  const contact = await call(b.agent.cookie, "POST", "/grow/contacts", { name: "Gina Grow", email: `gina-${tag}@example.com` });
  const le = await call(b.agent.cookie, "POST", "/parties", { propertyId: b.agentProp, partyId: contact.json.contact.id, role: "Seller" });
  assert.equal(le.status, 201);
  const re = await call(b.admin.cookie, "PATCH", `/parties/link/${g.json.link.id}`, { role: "Owner" });
  assert.equal(re.status, 200);
  assert.equal((await call(b.admin.cookie, "PATCH", `/parties/link/${g.json.link.id}`, { role: "Seller" })).status, 200);
  const aml = await db.select().from(amlVerifications).where(inArray(amlVerifications.propertyId, [b.adminProp, b.agentProp]));
  assert.equal(aml.length, 0, "no AML for Grow-only");
  // Grow-only still cannot reach Run-only or Pit Crew surfaces.
  assert.equal((await call(b.pc.cookie, "GET", "/pit-crew/workspace")).status, 403, "Pit Crew surface stays Run-only");
  // Positive control: with run.access the same action initiates AML.
  await setGrants(b.brokerageId, ["run.access", ...GROW]);
  const r = await call(b.admin.cookie, "POST", "/parties", { propertyId: b.adminProp, role: "Seller", firstName: "Run", lastName: "Seller", email: `run-${tag}@example.com` });
  assert.equal(r.status, 201);
  const amlRun = await db.select().from(amlVerifications).where(eq(amlVerifications.partyId, r.json.party.id));
  assert.equal(amlRun.length, 1, "Run caller keeps AML initiation");
});

test("t238u: one role vocabulary — API re-exports the @aee/db constant; the web model lists the same roles", async () => {
  const { PROPERTY_PARTY_ROLES: apiRoles } = await import("../parties.js");
  assert.equal(apiRoles, PROPERTY_PARTY_ROLES);
  const fs = await import("node:fs");
  const url = await import("node:url");
  const root = url.fileURLToPath(new URL("../../../../../", import.meta.url));
  const web = fs.readFileSync(`${root}apps/web/src/minimal/properties/minimalPropertyContactsModel.ts`, "utf8");
  const m = web.match(/export const PROPERTY_PARTY_ROLES = \[([^\]]*)\]/);
  assert.ok(m, "web constant found");
  assert.deepEqual(m![1].split(",").map((x) => x.trim().replace(/"/g, "")).filter(Boolean), [...PROPERTY_PARTY_ROLES]);
});

test("t242u PII minimisation: property-contact endpoints return only the summary fields the UI/mobile v5 need; address and entity details never leave", async () => {
  const b = await setup("Pii", ["run.access", ...GROW]);
  const SUMMARY = ["email", "firstName", "id", "lastName", "mobile", "organisationName", "partyType"];
  const created = await call(b.admin.cookie, "POST", "/parties", {
    propertyId: b.adminProp, role: "Buyer", firstName: "Pia", lastName: "Synthetic", email: "pia.synthetic@example.com", mobile: "+61400000001",
    residentialAddress: "1 Synthetic Secret St, Testville NSW 2000", entityDetails: { acn: "000000000", trustDeed: "synthetic" },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.json.party).sort(), SUMMARY);
  const list = await call(b.admin.cookie, "GET", `/parties/by-property/${b.adminProp}`);
  assert.equal(list.status, 200);
  for (const row of list.json.parties) {
    assert.deepEqual(Object.keys(row).sort(), ["isPrimary", "linkId", "party", "role"]);
    assert.deepEqual(Object.keys(row.party).sort(), SUMMARY);
  }
  const body = JSON.stringify(list.json) + JSON.stringify(created.json);
  for (const leak of ["Synthetic Secret St", "residentialAddress", "entityDetails", "trustDeed", "brokerageId", "middleName"]) assert.ok(!body.includes(leak), `leaked ${leak}`);
  const pia = list.json.parties.find((r: any) => r.party.firstName === "Pia");
  assert.equal(pia.party.mobile, "+61400000001", "mobile v5 rows and Call still get the number");
  assert.equal(pia.party.email, "pia.synthetic@example.com");
});

test("t244u E: full contact details (email/mobile) require contact-read access; Run without grow.contacts.read sees masks", async () => {
  const b = await setup("PiiMask", ["run.access", ...GROW]);
  const created = await call(b.admin.cookie, "POST", "/parties", { propertyId: b.adminProp, role: "Buyer", firstName: "Mia", lastName: "Synthetic", email: "mia.synthetic@example.com", mobile: "+61400000123" });
  assert.equal(created.status, 201);
  await setGrants(b.brokerageId, ["run.access"]);
  const masked = await call(b.admin.cookie, "GET", `/parties/by-property/${b.adminProp}`);
  assert.equal(masked.status, 200);
  const m = masked.json.parties.find((r: any) => r.party.firstName === "Mia");
  assert.equal(m.party.email, "m***@example.com");
  assert.equal(m.party.mobile, "***123");
  assert.ok(!JSON.stringify(masked.json).includes("mia.synthetic@"));
  assert.ok(!JSON.stringify(masked.json).includes("400000123"));
  await setGrants(b.brokerageId, ["grow.contacts.read"]);
  const full = await call(b.admin.cookie, "GET", `/parties/by-property/${b.adminProp}`);
  const f = full.json.parties.find((r: any) => r.party.firstName === "Mia");
  assert.equal(f.party.email, "mia.synthetic@example.com");
  assert.equal(f.party.mobile, "+61400000123");
});

test("t253u: by-contact pagination — links capped at limit with truncated, total = caller-visible links only, legacy properties[] stays uncapped", async () => {
  const b = await setup("Cap", ["run.access", ...GROW]);
  assert.equal(BY_CONTACT_LIMIT, 100);
  const [adminRow] = await db.select({ id: users.id }).from(users).where(eq(users.id, b.admin.user.id));
  const extra = BY_CONTACT_LIMIT + 4; // + the setup link on adminProp = 105 admin-visible links
  const props = await db
    .insert(propertiesTable)
    .values(Array.from({ length: extra }, (_, i) => ({ brokerageId: b.brokerageId, agentId: adminRow.id, formattedAddress: `${i + 10} Cap ${tag} St, Testville`, suburb: "Testville", state: "NSW", postcode: "2000" })))
    .returning({ id: propertiesTable.id });
  await db.insert(propertyPartiesTable).values(props.map((p) => ({ propertyId: p.id, partyId: b.partyId, role: "Owner" })));
  // One link on the AGENT's own property: the only one the agent (own-property scope) can see.
  assert.equal((await call(b.agent.cookie, "POST", "/parties", { propertyId: b.agentProp, partyId: b.partyId, role: "Tenant" })).status, 201);
  const all = await call(b.admin.cookie, "GET", `/parties/by-contact/${b.partyId}`);
  assert.equal(all.status, 200);
  assert.equal(all.json.limit, 100);
  assert.equal(all.json.total, extra + 2);
  assert.equal(all.json.truncated, true);
  assert.equal(all.json.links.length, 100);
  assert.equal(all.json.properties.length, extra + 2, "legacy flat array stays uncapped");
  const agent = await call(b.agent.cookie, "GET", `/parties/by-contact/${b.partyId}`);
  assert.equal(agent.status, 200);
  assert.deepEqual([agent.json.total, agent.json.truncated, agent.json.links.length, agent.json.limit], [1, false, 1, 100], "hidden-property links are never counted");
});

test("t253u: duplicate-check stays brokerage-scoped and omits the matched contactId for callers without contact-read", async () => {
  const b = await setup("DupRead", ["run.access", ...GROW]);
  const email = `dupread-${tag}@example.com`;
  const first = await call(b.admin.cookie, "POST", "/parties", { propertyId: b.adminProp, role: "Owner", firstName: "Ola", email, mobile: "0413 222 333" });
  assert.equal(first.status, 201);
  const full = await call(b.admin.cookie, "POST", "/parties/duplicate-check", { email, mobile: "0413222333" });
  assert.deepEqual(full.json.warnings, [
    { code: "POTENTIAL_DUPLICATE_CONTACT", kind: "email", contactId: first.json.party.id },
    { code: "POTENTIAL_DUPLICATE_CONTACT", kind: "phone", contactId: first.json.party.id },
  ]);
  await setGrants(b.brokerageId, ["run.access"]); // Run-only: may create, but sees masked contact PII
  const runOnly = await call(b.admin.cookie, "POST", "/parties/duplicate-check", { email, mobile: "0413222333" });
  assert.equal(runOnly.status, 200);
  assert.deepEqual(runOnly.json.warnings, [
    { code: "POTENTIAL_DUPLICATE_CONTACT", kind: "email" },
    { code: "POTENTIAL_DUPLICATE_CONTACT", kind: "phone" },
  ]);
  assert.ok(!JSON.stringify(runOnly.json).includes(String(first.json.party.id)) || String(first.json.party.id).length < 2, "no contact id");
  const o = await setup("DupReadOther", ["run.access", ...GROW]);
  assert.deepEqual((await call(o.admin.cookie, "POST", "/parties/duplicate-check", { email, mobile: "0413222333" })).json.warnings, [], "other brokerage never matches");
});
