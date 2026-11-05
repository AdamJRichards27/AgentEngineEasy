// Owner t275u item 1-3 (replaces the t274u blanket bar): Pit Crew changes contact
// relationships, contact details, imports and exports ONLY on recorded contact-owner
// authority (X-AE-On-Behalf-Of + X-AE-Authority-Ref), validated server-side (owner
// exists, same brokerage, an agent, owns the contact), scoped to the owner's contacts and
// listings, and audited (requester, performer, time, before/after). Brokerage entitlement
// alone grants nothing; ownership never moves; offers stay linked-buyer-only; sending is
// agent-only. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { and } from "drizzle-orm";
import { db, entitlementGrants, users, properties, parties, auditLogs, ENTITLEMENT_KEYS, growRelationships, growContactRelationships, propertyParties, GROW_CONTACT_RELATIONSHIP_TYPES, GROW_RELATIONSHIP_TYPES } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin } from "./testSupport.js";
import { openAuditValue } from "../../lib/auditValueVault.js";

// t276u: before/after values are encrypted at rest; synthetic test-only key.
process.env.AE_AUDIT_VALUE_KEY = "3".repeat(64);

const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const tag = `pcauth-${Date.now()}`;
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

async function call(cookie: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const r = await fetch(`${base}/api${path}`, {
    method,
    headers: { cookie, connection: "close", ...(body ? { "content-type": "application/json" } : {}), ...extra },
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
const linkRows = (propertyId: number) => db.select().from(propertyParties).where(eq(propertyParties.propertyId, propertyId));
const REQUIRED = "CONTACT_OWNER_AUTHORITY_REQUIRED";
const INVALID = "CONTACT_OWNER_AUTHORITY_INVALID";
const OUT = "CONTACT_OWNER_AUTHORITY_OUT_OF_SCOPE";
const auth = (ownerId: number, ref = "INSTR-2026-001 phone instruction") => ({ "x-ae-on-behalf-of": String(ownerId), "x-ae-authority-ref": ref });
const auditFor = async (action: string) =>
  (await db.select().from(auditLogs).where(eq(auditLogs.action, action))).map((r) => {
    // t276u: stored values are envelopes; the raw row never carries plaintext values.
    const v = JSON.parse(r.updatedValue ?? "{}");
    if (typeof v.after === "string") v.after = openAuditValue(v.after);
    const p = r.previousValue ? (r.previousValue.startsWith("enc:v1:") ? openAuditValue(r.previousValue) : JSON.parse(r.previousValue)) : null;
    return { ...r, v, p };
  });

test("t275u authority: without authority every Pit Crew change is 403 AUTHORITY_REQUIRED and nothing is written (all entitlements held)", async () => {
  const w = await world("NoAuth");
  const made = await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Buyer" });
  assert.equal(made.status, 201, made.text);
  const [row] = await linkRows(w.adminProp);
  const other = await call(w.admin.cookie, "POST", "/grow/contacts", { name: "Hal Household", email: `hal-noauth-${tag}@example.com` });
  const attempts: Array<[string, string, unknown]> = [
    ["POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Seller" }],
    ["POST", "/parties", { propertyId: w.adminProp, role: "Seller", partyType: "Person", firstName: "Nora", lastName: "New" }],
    ["PATCH", `/parties/link/${row.id}`, { role: "Seller" }],
    ["DELETE", `/parties/link/${row.id}`, undefined],
    ["POST", "/grow/relationships", { partyId: w.partyId, propertyId: w.adminProp, relationshipType: GROW_RELATIONSHIP_TYPES[0] }],
    ["POST", `/grow/contacts/${w.partyId}/relationships`, { relatedPartyId: other.json.contact.id, relationshipType: GROW_CONTACT_RELATIONSHIP_TYPES[0] }],
    ["PATCH", `/grow/contacts/${w.partyId}`, { email: `changed-${tag}@example.com` }],
    ["POST", "/grow/contacts", { name: "Pat Crewmade", email: `pat-${tag}@example.com` }],
    ["GET", "/grow/contacts/export", undefined],
    ["GET", "/import/jobs", undefined],
    ["POST", "/import/jobs/999999/execute", {}],
    ["POST", "/parties/duplicate-check", { email: "x@example.com" }],
  ];
  for (const [m, p, b] of attempts) {
    const r = await call(w.pc.cookie, m, p, b);
    assert.equal(r.status, 403, `${m} ${p}: ${r.text}`);
    assert.equal(r.json?.code, REQUIRED, `${m} ${p}`);
  }
  assert.equal((await linkRows(w.adminProp)).length, 1);
  assert.equal((await growRowsFor(w.partyId)).length, 0);
  const [p] = await db.select().from(parties).where(eq(parties.id, w.partyId));
  assert.match(String(p.email), /^lena-/);
  // Reads keep their existing access without authority.
  assert.equal((await call(w.pc.cookie, "GET", `/parties/by-property/${w.adminProp}`)).status, 200);
  assert.equal((await call(w.pc.cookie, "GET", `/grow/contacts/${w.partyId}`)).status, 200);
});

test("t275u authority: the named owner is validated server-side (missing ref, unknown user, other brokerage, Pit Crew, self)", async () => {
  const w = await world("Owner");
  const o = await world("OwnerOther");
  const body = { propertyId: w.adminProp, partyId: w.partyId, role: "Buyer" };
  const cases: Array<[Record<string, string>, string]> = [
    [{ "x-ae-on-behalf-of": String(w.admin.user.id) }, REQUIRED],
    [{ "x-ae-on-behalf-of": String(w.admin.user.id), "x-ae-authority-ref": "x" }, REQUIRED],
    [auth(99999999), INVALID],
    [auth(o.admin.user.id), INVALID],
    [auth(w.pc.user.id), INVALID],
  ];
  for (const [h, code] of cases) {
    const r = await call(w.pc.cookie, "POST", "/parties", body, h);
    assert.equal(r.status, 403, `${JSON.stringify(h)} ${r.text}`);
    assert.equal(r.json?.code, code, JSON.stringify(h));
  }
  const pc2 = await devLogin(base, { email: `pc2-${tag}@example.com`, firstName: "Pit", lastName: "Two", brokerageName: `${tag} Owner` });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pc2.user.id));
  const r = await call(w.pc.cookie, "POST", "/parties", body, auth(pc2.user.id));
  assert.equal(r.json?.code, INVALID, "another Pit Crew user is not a contact owner");
  assert.equal((await linkRows(w.adminProp)).length, 0);
});

test("t275u authority: property links — Pit Crew acting for the listing agent links, changes and unlinks; audited with requester, performer, before/after; out of scope refused", async () => {
  const w = await world("Links");
  const h = auth(w.admin.user.id);
  const linked = await call(w.pc.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Buyer" }, h);
  assert.equal(linked.status, 201, linked.text);
  const linkId = linked.json.link.id as number;
  const changed = await call(w.pc.cookie, "PATCH", `/parties/link/${linkId}`, { role: "Seller" }, h);
  assert.equal(changed.status, 200, changed.text);
  const upd = (await auditFor("party_link_updated_on_authority")).find((a) => a.recordId === String(linkId))!;
  assert.deepEqual(upd.p, { role: "Buyer", isPrimary: false });
  assert.equal(upd.v.after.role, "Seller");
  assert.equal(upd.v.requestedBy.userId, w.admin.user.id);
  assert.equal(upd.v.performedBy.userId, w.pc.user.id);
  assert.equal(upd.v.authorityRef, "INSTR-2026-001 phone instruction");
  assert.equal(upd.userId, w.pc.user.id);
  assert.ok(upd.createdAt instanceof Date);
  // Out of scope: the agent's listing is not the admin's; acting for the agent, the admin's contact is not theirs.
  const wrongProp = await call(w.pc.cookie, "POST", "/parties", { propertyId: w.agentProp, partyId: w.partyId, role: "Buyer" }, h);
  assert.equal(wrongProp.json?.code, OUT, wrongProp.text);
  const wrongOwner = await call(w.pc.cookie, "POST", "/parties", { propertyId: w.agentProp, partyId: w.partyId, role: "Buyer" }, auth(w.agent.user.id));
  assert.equal(wrongOwner.json?.code, OUT, wrongOwner.text);
  const wrongPatch = await call(w.pc.cookie, "PATCH", `/parties/link/${linkId}`, { role: "Buyer" }, auth(w.agent.user.id));
  assert.equal(wrongPatch.json?.code, OUT);
  const unlinked = await call(w.pc.cookie, "DELETE", `/parties/link/${linkId}`, undefined, h);
  assert.equal(unlinked.status, 204, unlinked.text);
  const del = (await auditFor("party_link_removed_on_authority")).find((a) => a.recordId === String(linkId))!;
  assert.equal(del.p.role, "Seller");
  assert.equal(del.v.after, null);
  assert.equal((await linkRows(w.adminProp)).length, 0);
});

test("t275u authority: new contact on the owner's listing is created for the owner (duplicate service applies); ownership recorded to the owner, not Pit Crew", async () => {
  const w = await world("NewContact");
  const h = auth(w.admin.user.id);
  const r = await call(w.pc.cookie, "POST", "/parties", { propertyId: w.adminProp, role: "Seller", partyType: "Person", firstName: "Nora", lastName: `New${tag}`, email: `nora-${tag}@example.com` }, h);
  assert.equal(r.status, 201, r.text);
  const own = (await auditFor("contact_owner_recorded")).find((a) => a.recordId === String(r.json.party.id))!;
  assert.equal(own.providerReference, `owner:${w.admin.user.id}`);
  assert.equal(own.v.performedBy.userId, w.pc.user.id);
  // Duplicate of Lena: 409 by default; Pit Crew with authority may override with a reason.
  const dup = await call(w.pc.cookie, "POST", "/parties", { propertyId: w.adminProp, role: "Buyer", partyType: "Person", firstName: "Lena", lastName: "Linkform" }, h);
  assert.equal(dup.status, 409, dup.text);
  assert.equal(dup.json.code, "POTENTIAL_DUPLICATE_CONTACT");
});

test("t275u authority: Grow interest and household relationships for the owner's contact; created by (owned by) the owner; audited; other contacts out of scope", async () => {
  const w = await world("Grow");
  const h = auth(w.admin.user.id);
  const type = GROW_RELATIONSHIP_TYPES[0];
  // Grow interest may be on another agent's listing: only the contact must be the owner's.
  const r = await call(w.pc.cookie, "POST", "/grow/relationships", { partyId: w.partyId, propertyId: w.agentProp, relationshipType: type }, h);
  assert.equal(r.status, 201, r.text);
  const [g] = await growRowsFor(w.partyId);
  assert.equal(g.createdBy, w.admin.user.id, "relationship belongs to the owner, not Pit Crew");
  const p = await call(w.pc.cookie, "PATCH", `/grow/relationships/${g.id}`, { status: "Historical" }, h);
  assert.equal(p.status, 200, p.text);
  const [g2] = await growRowsFor(w.partyId);
  assert.equal(g2.createdBy, w.admin.user.id, "ownership unchanged");
  assert.ok((await auditFor("grow_relationship_updated_on_authority")).some((a) => a.recordId === String(g.id) && a.p !== null));
  // Household
  const other = await call(w.admin.cookie, "POST", "/grow/contacts", { name: "Hal Household", email: `hal-${tag}@example.com` });
  const relatedPartyId = other.json.contact.id as number;
  const relationshipType = GROW_CONTACT_RELATIONSHIP_TYPES[0];
  const hh = await call(w.pc.cookie, "POST", `/grow/contacts/${w.partyId}/relationships`, { relatedPartyId, relationshipType }, h);
  assert.equal(hh.status, 201, hh.text);
  const d = await call(w.pc.cookie, "DELETE", `/grow/contacts/relationships/${hh.json.relationship.id}`, undefined, h);
  assert.equal(d.status, 204, d.text);
  assert.ok((await auditFor("grow_contact_relationship_removed_on_authority")).some((a) => a.recordId === String(hh.json.relationship.id)));
  // The agent's own contact is not the admin's.
  const agentContact = await call(w.agent.cookie, "POST", "/grow/contacts", { name: "Ada Agentown", email: `ada-${tag}@example.com` });
  const out = await call(w.pc.cookie, "POST", "/grow/relationships", { partyId: agentContact.json.contact.id, propertyId: w.adminProp, relationshipType: type }, h);
  assert.equal(out.json?.code, OUT, out.text);
});

test("t275u authority: contact details edit audits before/after; owner without the entitlement refuses (brokerage entitlement alone grants nothing)", async () => {
  const w = await world("Edit");
  const h = auth(w.admin.user.id);
  const newEmail = `lena-new-${tag}@example.com`;
  const r = await call(w.pc.cookie, "PATCH", `/grow/contacts/${w.partyId}`, { email: newEmail }, h);
  assert.equal(r.status, 200, r.text);
  const a = (await auditFor("grow_contact_updated_on_authority")).find((x) => x.recordId === String(w.partyId))!;
  assert.match(String(a.p.email), /^lena-edit-/);
  assert.equal(a.v.after.email, newEmail);
  assert.equal(a.v.requestedBy.userId, w.admin.user.id);
  // Run-only brokerage: the owner lacks grow.contacts.manage, so Pit Crew cannot edit on their authority.
  await setGrants(w.brokerageId, ["run.access"]);
  const r2 = await call(w.pc.cookie, "PATCH", `/grow/contacts/${w.partyId}`, { email: `x-${newEmail}` }, h);
  assert.equal(r2.status, 403, r2.text);
  assert.equal(r2.json?.code, "CONTACT_OWNER_NOT_ENTITLED");
});

test("t275u: offers stay linked-buyer-only for Pit Crew; an already-linked buyer is allowed and adds no link", async () => {
  const w = await world("Offer");
  await db.update(properties).set({ workflowStage: "Listed" }).where(eq(properties.id, w.adminProp));
  const r = await call(w.pc.cookie, "POST", `/offers/by-property/${w.adminProp}`, { offerPriceCents: 100000000, buyer: { firstName: "Bea", lastName: "Buyer" } }, auth(w.admin.user.id));
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json?.code, "PIT_CREW_LINKED_BUYER_ONLY");
  const r2 = await call(w.pc.cookie, "POST", `/offers/by-property/${w.adminProp}`, { offerPriceCents: 100000000, buyerPartyId: w.partyId });
  assert.equal(r2.status, 403, r2.text);
  assert.equal((await linkRows(w.adminProp)).length, 0);
  assert.equal((await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Buyer" })).status, 201);
  const r3 = await call(w.pc.cookie, "POST", `/offers/by-property/${w.adminProp}`, { offerPriceCents: 100000000, buyerPartyId: w.partyId });
  assert.equal(r3.status, 201, r3.text);
  const links = await db.select().from(propertyParties).where(and(eq(propertyParties.propertyId, w.adminProp), eq(propertyParties.role, "Buyer")));
  assert.equal(links.length, 1);
});

test("t275u: sending is agent-only — Pit Crew cannot send an appraisal or a document package even with authority; agents reach the route", async () => {
  const w = await world("Send");
  for (const path of ["/grow/appraisals/999999/send", "/documents/packages/999999/send-for-signature"]) {
    for (const h of [{}, auth(w.admin.user.id)]) {
      const r = await call(w.pc.cookie, "POST", path, {}, h);
      assert.equal(r.status, 403, `${path}: ${r.text}`);
      assert.equal(r.json?.code, "SEND_AUTHORISATION_REQUIRED", path);
    }
    // t276u: administrators review but do not send by role.
    const adm = await call(w.admin.cookie, "POST", path, {});
    assert.deepEqual([adm.status, adm.json?.code, adm.json?.reason], [403, "SEND_AUTHORISATION_REQUIRED", "ADMIN_REVIEW_ONLY"], path);
    const a = await call(w.agent.cookie, "POST", path, {});
    assert.notEqual(a.json?.code, "SEND_AUTHORISATION_REQUIRED", path);
  }
  // Preparing listing agreements needs authority, scoped to the owner's listing.
  const terms = await call(w.pc.cookie, "PUT", `/documents/agency-agreement-terms/${w.adminProp}`, {});
  assert.equal(terms.json?.code, REQUIRED, terms.text);
});

test("t275u: appraisals (proposals) — Pit Crew prepares on the owner's authority, created for the owner; another agent's appraisal is out of scope", async () => {
  const w = await world("Appraisal");
  const h = auth(w.admin.user.id);
  assert.equal((await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Seller" })).status, 201);
  const noAuth = await call(w.pc.cookie, "POST", "/grow/appraisals/from-contact", { partyId: w.partyId, propertyId: w.adminProp });
  assert.equal(noAuth.json?.code, REQUIRED, noAuth.text);
  const made = await call(w.pc.cookie, "POST", "/grow/appraisals/from-contact", { partyId: w.partyId, propertyId: w.adminProp }, h);
  assert.equal(made.status, 201, made.text);
  const id = made.json.appraisal.id as number;
  assert.ok((await auditFor("appraisal_created_on_authority")).some((a) => a.recordId === String(id)));
  const viaAgent = await call(w.pc.cookie, "GET", `/grow/appraisals/${id}`, undefined, auth(w.agent.user.id));
  assert.equal(viaAgent.status, 404, viaAgent.text);
});

test("t275u: import jobs and contact export are scoped to the owner Pit Crew acts for, and audited", async () => {
  const w = await world("Export");
  // The agent's own contact (linked to the agent's listing) must never appear in the admin's export.
  const agentNew = await call(w.agent.cookie, "POST", "/parties", { propertyId: w.agentProp, role: "Seller", partyType: "Person", firstName: "Ada", lastName: `Agentown${tag}`, email: `ada-export-${tag}@example.com` });
  assert.equal(agentNew.status, 201, agentNew.text);
  // t276u: Pit Crew prepares on authority; the export is delivered to the owner, never to Pit Crew.
  const direct = await call(w.pc.cookie, "GET", "/grow/contacts/export", undefined, auth(w.admin.user.id));
  assert.deepEqual([direct.status, direct.json?.code], [403, "EXPORT_DELIVERED_TO_OWNER"]);
  const prepAdmin = await call(w.pc.cookie, "POST", "/grow/contacts/exports", {}, auth(w.admin.user.id));
  assert.equal(prepAdmin.status, 201, prepAdmin.text);
  assert.equal(prepAdmin.json.deliveredTo, w.admin.user.id);
  assert.equal(prepAdmin.text.includes("Linkform"), false, "prepare returns metadata only");
  const pcDl = await call(w.pc.cookie, "GET", `/grow/contacts/exports/${prepAdmin.json.exportId}/download`, undefined, auth(w.admin.user.id));
  assert.deepEqual([pcDl.status, pcDl.json?.code], [403, "EXPORT_DELIVERED_TO_OWNER"]);
  const asAdmin = await call(w.admin.cookie, "GET", `/grow/contacts/exports/${prepAdmin.json.exportId}/download`);
  assert.equal(asAdmin.status, 200, asAdmin.text);
  assert.match(asAdmin.text, /^id,partyType,firstName,lastName,organisationName,email,mobile\r\n/);
  assert.ok(asAdmin.text.includes(String(w.partyId)), "owner's contact exported");
  assert.equal(asAdmin.text.includes(`Agentown${tag}`), false, "another agent's contact never exported");
  assert.equal(/notes|consent/i.test(asAdmin.text.split("\r\n")[0]), false, "field-level limit");
  const prepAgent = await call(w.pc.cookie, "POST", "/grow/contacts/exports", {}, auth(w.agent.user.id));
  const asAgent = await call(w.agent.cookie, "GET", `/grow/contacts/exports/${prepAgent.json.exportId}/download`);
  assert.ok(asAgent.text.includes(`Agentown${tag}`));
  assert.equal(asAgent.text.includes("Linkform"), false);
  const ex = (await auditFor("contacts_exported")).filter((a) => a.v.initiatedBy === w.pc.user.id);
  assert.equal(ex.length, 2);
  assert.deepEqual(new Set(ex.map((a) => a.v.recipient.userId)), new Set([w.admin.user.id, w.agent.user.id]));
  // Agents export only their own contacts.
  const own = await call(w.agent.cookie, "GET", "/grow/contacts/export");
  assert.equal(own.status, 200);
  assert.equal(own.text.includes("Linkform"), false);
  // Import: a job uploaded for the admin is invisible when acting for the agent.
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(`First Name,Last Name,Email\nImo,Port${tag},imo-${tag}@example.com\n`)], { type: "text/csv" }), "c.csv");
  const up = await fetch(`${base}/api/import/jobs`, { method: "POST", headers: { cookie: w.pc.cookie, ...auth(w.admin.user.id) }, body: form });
  assert.equal(up.status, 201, await up.clone().text());
  const job = ((await up.json()) as { job: { id: number } }).job.id;
  assert.equal((await call(w.pc.cookie, "GET", `/import/jobs/${job}`, undefined, auth(w.admin.user.id))).status, 200);
  const other = await call(w.pc.cookie, "GET", `/import/jobs/${job}`, undefined, auth(w.agent.user.id));
  assert.equal(other.status, 404, other.text);
  const listAgent = await call(w.pc.cookie, "GET", "/import/jobs", undefined, auth(w.agent.user.id));
  assert.equal(listAgent.json.jobs.some((j: { id: number }) => j.id === job), false);
  assert.equal((await call(w.pc.cookie, "GET", `/import/jobs/${job}/rejected.csv`, undefined, auth(w.agent.user.id))).status, 404);
  assert.equal((await call(w.pc.cookie, "POST", `/import/jobs/${job}/execute`, {}, auth(w.agent.user.id))).status, 404);
});
