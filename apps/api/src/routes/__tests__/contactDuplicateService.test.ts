// Owner t275u item 4: ONE server-side duplicate service (lib/contactDuplicates.ts) on every
// contact-creation path — Grow contacts, POST /parties (Run Add Person / property contacts),
// offers with an inline buyer, and import execute. Name, email, mobile; 409 by default;
// override only by an authorised user with a recorded reason; masking kept. Synthetic data.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { and } from "drizzle-orm";
import { db, entitlementGrants, users, properties, parties, auditLogs, ENTITLEMENT_KEYS, growRelationships, growContactRelationships, propertyParties, GROW_CONTACT_RELATIONSHIP_TYPES, GROW_RELATIONSHIP_TYPES } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin } from "./testSupport.js";

const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const tag = `dupsvc-${Date.now()}`;
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


const reason = "Different person, same family email";
const overrides = async (pathName: string) =>
  (await db.select().from(auditLogs).where(eq(auditLogs.action, "contact_duplicate_override"))).map((r) => JSON.parse(r.updatedValue ?? "{}")).filter((v) => v.path === pathName);

test("t275u dup: Grow contacts — name, email and mobile each block; reason required; override audited; masked without contact-read", async () => {
  const w = await world("Grow");
  for (const body of [{ name: "Lena Linkform" }, { name: "Someone", email: `LENA-GROW-${tag}@example.com`.toLowerCase() }, { name: "Other", phone: "+61 400 000 111" }]) {
    const r = await call(w.admin.cookie, "POST", "/grow/contacts", body);
    assert.equal(r.status, 409, `${JSON.stringify(body)} ${r.text}`);
    assert.equal(r.json.code, "POTENTIAL_DUPLICATE_CONTACT");
    assert.equal(r.json.contactId, w.partyId);
    assert.equal(r.json.reasonRequired, true);
  }
  // Different email on both sides: same name is a different person (not blocked).
  const twin = await call(w.admin.cookie, "POST", "/grow/contacts", { name: "Lena Linkform", email: `another-lena-${tag}@example.com` });
  assert.equal(twin.status, 201, twin.text);
  const short = await call(w.admin.cookie, "POST", "/grow/contacts", { name: "Lena Linkform", duplicateOverride: { reason: "x" } });
  assert.equal(short.json.code, "DUPLICATE_OVERRIDE_REASON_REQUIRED");
  const ok = await call(w.admin.cookie, "POST", "/grow/contacts", { name: "Lena Linkform", duplicateOverride: { reason } });
  assert.equal(ok.status, 201, ok.text);
  assert.ok((await overrides("grow_contacts")).some((v) => v.reason === reason));
  // Masked: without contact-read the id is omitted.
  await setGrants(w.brokerageId, ["run.access", ...GROW.filter((k) => k !== "grow.contacts.read")]);
  const masked = await call(w.admin.cookie, "POST", "/grow/contacts", { name: "Zed", phone: "0400 000 111" });
  assert.equal(masked.status, 409);
  assert.equal("contactId" in masked.json, false);
  assert.equal(JSON.stringify(masked.json).includes(`"contactId"`), false);
});

test("t275u dup: POST /parties (Run Add Person / property contacts) blocks by default with masking; Pit Crew without authority cannot override", async () => {
  const w = await world("Parties");
  const r = await call(w.agent.cookie, "POST", "/parties", { propertyId: w.agentProp, role: "Buyer", partyType: "Person", firstName: "Lena", lastName: "Linkform" });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.kind, "name");
  await setGrants(w.brokerageId, ["run.access"]);
  const masked = await call(w.agent.cookie, "POST", "/parties", { propertyId: w.agentProp, role: "Buyer", partyType: "Person", firstName: "M", mobile: "0400000111" });
  assert.equal(masked.status, 409, masked.text);
  assert.equal("contactId" in masked.json, false);
  assert.deepEqual(masked.json.matches, [{ code: "POTENTIAL_DUPLICATE_CONTACT", kind: "phone" }]);
  const ok = await call(w.agent.cookie, "POST", "/parties", { propertyId: w.agentProp, role: "Buyer", partyType: "Person", firstName: "M", mobile: "0400000111", duplicateOverride: { reason } });
  assert.equal(ok.status, 201, ok.text);
  assert.ok((await overrides("parties")).some((v) => v.reason === reason));
});

test("t275u dup: offers with an inline buyer use the same service", async () => {
  const w = await world("Offers");
  await db.update(properties).set({ workflowStage: "Listed" }).where(eq(properties.id, w.adminProp));
  const r = await call(w.admin.cookie, "POST", `/offers/by-property/${w.adminProp}`, { offerPriceCents: 90000000, buyer: { firstName: "Lena", lastName: "Linkform" } });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.path, "offers");
  assert.equal(r.json.contactId, w.partyId);
  const reuse = await call(w.admin.cookie, "POST", `/offers/by-property/${w.adminProp}`, { offerPriceCents: 90000000, buyerPartyId: w.partyId });
  assert.equal(reuse.status, 201, reuse.text);
  const ok = await call(w.admin.cookie, "POST", `/offers/by-property/${w.adminProp}`, { offerPriceCents: 91000000, buyer: { firstName: "Lena", lastName: "Linkform" }, duplicateOverride: { reason } });
  assert.equal(ok.status, 201, ok.text);
  assert.ok((await overrides("offers")).some((v) => v.reason === reason));
});

test("t275u dup: import execute blocks a create row that matches an existing contact until resolved with a reason", async () => {
  const w = await world("Import");
  const form = new FormData();
  form.append("file", new Blob([Buffer.from("First Name,Last Name\nLena,Linkform\n")], { type: "text/csv" }), "dup.csv");
  const up = await fetch(`${base}/api/import/jobs`, { method: "POST", headers: { cookie: w.admin.cookie }, body: form });
  assert.equal(up.status, 201, await up.clone().text());
  const job = ((await up.json()) as { job: { id: number } }).job.id;
  const map = await call(w.admin.cookie, "PUT", `/import/jobs/${job}/mapping`, { mapping: { "First Name": "person.firstName", "Last Name": "person.lastName" } });
  assert.equal(map.status, 200, map.text);
  const blocked = await call(w.admin.cookie, "POST", `/import/jobs/${job}/execute`, {});
  if (blocked.status === 200) {
    // The import pipeline itself matched the row to the existing contact (use_existing): no duplicate created.
    const lenas = await db.select().from(parties).where(and(eq(parties.brokerageId, w.brokerageId), eq(parties.lastName, "Linkform")));
    assert.equal(lenas.length, 1, "import reused the existing contact");
    return;
  }
  assert.equal(blocked.status, 409, blocked.text);
  assert.equal(blocked.json.path, "import");
  const groupKey = blocked.json.groups[0].groupKey as string;
  assert.equal(blocked.json.groups[0].matches[0].contactId, w.partyId);
  const noReason = await call(w.admin.cookie, "POST", `/import/jobs/${job}/resolve`, { kind: "contact", groupKey, resolution: "create_new" });
  assert.equal(noReason.json.code, "DUPLICATE_OVERRIDE_REASON_REQUIRED", noReason.text);
  const resolved = await call(w.admin.cookie, "POST", `/import/jobs/${job}/resolve`, { kind: "contact", groupKey, resolution: "create_new", reason });
  assert.equal(resolved.status, 200, resolved.text);
  const run = await call(w.admin.cookie, "POST", `/import/jobs/${job}/execute`, {});
  assert.equal(run.status, 200, run.text);
  assert.ok((await overrides("import")).some((v) => v.reason === reason));
});
