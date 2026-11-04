// t257u: every shared vector through BOTH Tap-to-Call paths (GET status and the call-consent 201), which share
// one helper (tapToCallStatus -> usableNumber). Plus: Cache-Control no-store, no number digits in headers,
// unauthenticated 401, Run-only and Pit Crew without contact-read get MASKED, masked display from the dialled part.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, entitlementGrants, parties, users, ENTITLEMENT_KEYS } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { VECTORS } from "../../lib/__tests__/tapToCallSharedVectors.test.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin } from "./testSupport.js";

const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const tag = `ttcv-${Date.now()}`;
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
async function call(cookie: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api${path}`, { method, headers: { ...(cookie ? { cookie } : {}), connection: "close", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: r.status, json, text, headers: r.headers };
}
const party = async (brokerageId: number, mobile: string) => (await db.insert(parties).values({ brokerageId, partyType: "Person", firstName: "Vec", lastName: "Tor", mobile }).returning({ id: parties.id }))[0].id;
function noDigitsInHeaders(h: Headers, digits: string) {
  if (digits.length < 6) return;
  h.forEach((v, k) => assert.equal(v.replace(/\D/g, "").includes(digits), false, `header ${k} carries the number`));
}

test("t257u: all 24 vectors give the expected telHref on GET status AND the call-consent 201 (full contact-read)", async () => {
  assert.equal(VECTORS.length, 24);
  const b = await createBrokerageWithUsers(base, `${tag} full`);
  ids.push(b.brokerageId);
  await setGrants(b.brokerageId, ["run.access", ...GROW]);
  for (const v of VECTORS) {
    const id = await party(b.brokerageId, v.input);
    const g = await call(b.admin.cookie, "GET", `/parties/${id}/tap-to-call`);
    assert.equal(g.status, 200, v.input);
    assert.equal(g.json.telHref ?? null, v.expected_telHref, `GET ${JSON.stringify(v.input)}`);
    assert.equal(g.json.available, v.expected_telHref !== null);
    assert.equal(g.headers.get("cache-control"), "no-store");
    const c = await call(b.admin.cookie, "POST", `/parties/${id}/call-consent`, { confirmed: true });
    assert.equal(c.status, 201, v.input);
    assert.equal(c.json.telHref ?? null, v.expected_telHref, `call-consent ${JSON.stringify(v.input)}`);
    assert.deepEqual(c.json, g.json, "both paths agree exactly");
    assert.equal(c.headers.get("cache-control"), "no-store");
  }
});

test("t257u: unauthenticated 401 on both paths", async () => {
  assert.equal((await call(null, "GET", `/parties/1/tap-to-call`)).status, 401);
  assert.equal((await call(null, "POST", `/parties/1/call-consent`, { confirmed: true })).status, 401);
});

test("t257u: Run-only and Pit Crew without contact-read get MASKED (no number, no tel:, no digits in headers); masked display from the dialled part", async () => {
  const b = await createBrokerageWithUsers(base, `${tag} masked`);
  ids.push(b.brokerageId);
  const name = `${tag} masked`;
  const pc = await devLogin(base, { email: `pc-${tag}@example.com`, firstName: "Pit", lastName: "Crew", brokerageName: name });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pc.user.id));
  await setGrants(b.brokerageId, ["run.access"]);
  const id = await party(b.brokerageId, "0491 570 156 ext 12");
  const results: Record<string, number> = {};
  for (const [who, cookie] of [["Run agent", b.agent.cookie], ["Pit Crew", pc.cookie]] as const) {
    const g = await call(cookie, "GET", `/parties/${id}/tap-to-call`);
    results[who] = g.status;
    if (g.status !== 200) continue; // reported below
    assert.equal(g.json.reason, "MASKED", who);
    assert.equal(g.json.telHref, null);
    assert.equal(g.json.display, "***156");
    assert.equal(g.text.includes("0491570156") || g.text.includes("570 156") || g.text.includes("12"), false, `${who} body carries no number or extension`);
    noDigitsInHeaders(g.headers, "0491570156");
    assert.equal(g.headers.get("cache-control"), "no-store");
    const c = await call(cookie, "POST", `/parties/${id}/call-consent`, { confirmed: true });
    if (c.status === 201) {
      assert.equal(c.json.reason, "MASKED");
      assert.equal(c.json.telHref, null);
      assert.equal(c.json.display, "***156");
      noDigitsInHeaders(c.headers, "0491570156");
    }
  }
  assert.equal(results["Run agent"], 200, "Run agent without contact-read is MASKED, not denied");
  assert.equal(results["Pit Crew"], 200, "Pit Crew without contact-read is MASKED, not denied");
  console.log(`t257u Pit Crew tap-to-call status without contact-read: ${results["Pit Crew"]}`);
});

test("t257u D3: POST /parties create-new 201 warnings omit contactId without contact-read; kept with it", async () => {
  const b = await createBrokerageWithUsers(base, `${tag} d3`);
  ids.push(b.brokerageId);
  await setGrants(b.brokerageId, ["run.access", ...GROW]);
  const email = `d3-${tag}@example.com`;
  const orig = await call(b.admin.cookie, "POST", "/grow/contacts", { name: "Orig D3", email });
  assert.equal(orig.status, 201);
  const prop = await call(b.admin.cookie, "POST", "/properties", { formattedAddress: `1 ${tag} St, Testville`, state: "NSW", suburb: "Testville", postcode: "2000" });
  assert.equal(prop.status, 201);
  const withRead = await call(b.admin.cookie, "POST", "/parties", { propertyId: prop.json.property.id, role: "Buyer", firstName: "Dup", lastName: "One", email, duplicateOverride: { reason: "t275u: a genuinely different person" } });
  assert.equal(withRead.status, 201, JSON.stringify(withRead.json));
  assert.equal(withRead.json.warnings[0].contactId, orig.json.contact.id);
  await setGrants(b.brokerageId, ["run.access"]);
  const runOnly = await call(b.admin.cookie, "POST", "/parties", { propertyId: prop.json.property.id, role: "Buyer", firstName: "Dup", lastName: "Two", email, duplicateOverride: { reason: "t275u: a genuinely different person" } });
  assert.equal(runOnly.status, 201, JSON.stringify(runOnly.json));
  assert.ok(runOnly.json.warnings.length >= 1);
  for (const w of runOnly.json.warnings) assert.equal("contactId" in w, false);
  assert.equal(JSON.stringify(runOnly.json.warnings).includes(String(orig.json.contact.id)), false);
});
