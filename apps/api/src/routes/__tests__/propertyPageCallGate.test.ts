// t263u (1): end-to-end Call gate for every API that feeds a property page. Full numbers and tel: links only with
// grow.contacts.read; Run alone (Agent or Pit Crew) never. Endpoints: GET /parties/by-property/:id (property contacts
// list), POST /parties (link existing / create new 201 party), GET /parties/:id/tap-to-call, POST /parties/:id/call-consent.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, entitlementGrants, parties, users, ENTITLEMENT_KEYS } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin } from "./testSupport.js";

const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const READ_ONLY = ["grow.access", "grow.contacts.read"];
const tag = `pcg-${Date.now()}`;
const NUMBER = "0491 570 156 ext 12";
const DIGITS = "0491570156";
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
  try { await cleanupBrokerages(ids); } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
async function setGrants(brokerageId: number, keys: readonly string[]) {
  await db.delete(entitlementGrants).where(eq(entitlementGrants.brokerageId, brokerageId));
  for (const k of keys) await db.insert(entitlementGrants).values({ brokerageId, entitlementKey: k, granteeType: "brokerage", granteeId: brokerageId, sourceType: "admin_override", status: "Active" });
  invalidateEntitlementCache(brokerageId);
}
async function call(cookie: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api${path}`, { method, headers: { cookie, connection: "close", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty */ }
  const headerDigits: string[] = [];
  r.headers.forEach((v) => headerDigits.push(v.replace(/\D/g, "")));
  return { status: r.status, json, text, headerDigits: headerDigits.join("|") };
}
const leaks = (s: string) => s.replace(/\D/g, "").includes(DIGITS) || s.includes("570 156") || /ext\s*12/.test(s);

async function world(label: string) {
  const b = await createBrokerageWithUsers(base, `${tag} ${label}`);
  ids.push(b.brokerageId);
  const pc = await devLogin(base, { email: `pc-${label}-${tag}@example.com`, firstName: "Pit", lastName: "Crew", brokerageName: `${tag} ${label}` });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pc.user.id));
  await setGrants(b.brokerageId, ["run.access", ...GROW]);
  const prop = await call(b.agent.cookie, "POST", "/properties", { formattedAddress: `1 ${label} ${tag} St, Testville`, state: "QLD", suburb: "Testville", postcode: "4000" });
  assert.equal(prop.status, 201);
  const [party] = await db.insert(parties).values({ brokerageId: b.brokerageId, partyType: "Person", firstName: "Gate", lastName: "Contact", mobile: NUMBER, email: `gate-${label}@example.com` }).returning({ id: parties.id });
  const link = await call(b.admin.cookie, "POST", "/parties", { propertyId: prop.json.property.id, partyId: party.id, role: "Buyer" });
  assert.equal(link.status, 201, JSON.stringify(link.json));
  return { b, pc, propertyId: prop.json.property.id as number, partyId: party.id };
}

const AUDIENCES = [
  { who: "contact-read (Grow + Run)", keys: ["run.access", ...GROW], as: "agent", full: true },
  { who: "read-only contact user", keys: READ_ONLY, as: "agent", full: true },
  { who: "Run Agent without contact-read", keys: ["run.access"], as: "agent", full: false },
  { who: "Pit Crew (Run only)", keys: ["run.access"], as: "pc", full: false },
] as const;

for (const a of AUDIENCES) {
  test(`t263u property-page Call gate: ${a.who} — ${a.full ? "full number + tel:" : "masked, no tel:, no digits anywhere"}`, async () => {
    const w = await world(a.who.replace(/\W+/g, "-"));
    await setGrants(w.b.brokerageId, a.keys);
    const cookie = a.as === "pc" ? w.pc.cookie : w.b.agent.cookie;
    const list = await call(cookie, "GET", `/parties/by-property/${w.propertyId}`);
    assert.equal(list.status, 200, list.text);
    const row = (list.json.parties ?? list.json.links ?? []).find((r: any) => (r.party?.id ?? r.partyId) === w.partyId);
    assert.ok(row, "linked contact listed");
    const mobile = row.party?.mobile ?? row.mobile;
    const ttc = await call(cookie, "GET", `/parties/${w.partyId}/tap-to-call`);
    assert.equal(ttc.status, 200);
    if (a.full) {
      assert.equal(mobile, NUMBER);
      assert.equal(ttc.json.telHref, `tel:${DIGITS}`);
    } else {
      assert.equal(mobile, "***156", "mask from the dialled part, not the extension");
      assert.equal(leaks(list.text), false, "by-property body");
      assert.equal(ttc.json.telHref, null);
      assert.equal(ttc.json.reason, "MASKED");
      assert.equal(leaks(ttc.text), false, "tap-to-call body");
      assert.equal(ttc.headerDigits.includes(DIGITS), false);
    }
    const consent = await call(cookie, "POST", `/parties/${w.partyId}/call-consent`, { confirmed: true });
    if (consent.status === 201) {
      if (a.full) assert.equal(consent.json.telHref, `tel:${DIGITS}`);
      else { assert.equal(consent.json.telHref, null); assert.equal(leaks(consent.text), false, "call-consent body"); }
    } else assert.equal(consent.status, 403, `${a.who} call-consent ${consent.status}`);
  });
}

test("t263u: POST /parties 201 by a Run Agent without contact-read (relationship manager) never returns the full number", async () => {
  const w = await world("link-existing");
  await setGrants(w.b.brokerageId, ["run.access"]);
  const prop2 = await call(w.b.agent.cookie, "POST", "/properties", { formattedAddress: `2 link ${tag} St, Testville`, state: "QLD", suburb: "Testville", postcode: "4000" });
  assert.equal(prop2.status, 201);
  const existing = await call(w.b.agent.cookie, "POST", "/parties", { propertyId: prop2.json.property.id, partyId: w.partyId, role: "Buyer" });
  assert.equal(existing.status, 201, existing.text);
  assert.equal(existing.json.party.mobile, "***156");
  assert.equal(leaks(existing.text), false, "link-existing 201 body");
  assert.notEqual(existing.json.party.email, `gate-link-existing@example.com`);
  const created = await call(w.b.agent.cookie, "POST", "/parties", { propertyId: prop2.json.property.id, role: "Tenant", firstName: "New", lastName: "Person", mobile: "0491 570 157" });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.party.mobile, "***157");
  await setGrants(w.b.brokerageId, ["run.access", ...GROW]);
  const full = await call(w.b.agent.cookie, "POST", "/parties", { propertyId: prop2.json.property.id, partyId: w.partyId, role: "Tenant" });
  assert.equal(full.status, 201, full.text);
  assert.equal(full.json.party.mobile, NUMBER, "with contact-read the summary is full");
});
