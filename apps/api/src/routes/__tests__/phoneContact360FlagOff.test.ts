// Owner t274u item 2. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { and } from "drizzle-orm";
import { db, entitlementGrants, users, properties, ENTITLEMENT_KEYS, growRelationships, growContactRelationships, propertyParties, GROW_CONTACT_RELATIONSHIP_TYPES, GROW_RELATIONSHIP_TYPES } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin } from "./testSupport.js";

const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const tag = `phoneoff-${Date.now()}`;
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

// Owner t274u item 2: with contactCanonicalRead OFF the phone Contact 360 reads
// only GET /grow/contacts/:id (Grow). A desktop/Run canonical link must not
// change that payload (no bypass, no canonical read, no dual-write).
test("t274u item 2: GET /grow/contacts/:id (phone C360 read, flag OFF) is identical (apart from evaluatedAt) before and after canonical links from desktop C360 and Run", async () => {
  const w = await world("PhoneOff");
  const grow = await call(w.admin.cookie, "POST", "/grow/relationships", { partyId: w.partyId, propertyId: w.agentProp, relationshipType: "prospective_seller" });
  assert.equal(grow.status, 201, grow.text);
  const before = await call(w.admin.cookie, "GET", `/grow/contacts/${w.partyId}`);
  assert.equal(before.status, 200, before.text);
  const growBefore = await growRowsFor(w.partyId);
  // Desktop Contact 360 Link property (canonical) and Run select-existing (canonical).
  assert.equal((await call(w.admin.cookie, "POST", "/parties", { propertyId: w.adminProp, partyId: w.partyId, role: "Buyer" })).status, 201);
  assert.equal((await call(w.agent.cookie, "POST", "/parties", { propertyId: w.agentProp, partyId: w.partyId, role: "Seller" })).status, 201);
  const after = await call(w.admin.cookie, "GET", `/grow/contacts/${w.partyId}`);
  assert.equal(after.status, 200);
  // Only the computed-at clock (evaluatedAt) may differ between two reads.
  const strip = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "evaluatedAt").map(([k, x]) => [k, strip(x)])) : v;
  assert.deepEqual(strip(after.json), strip(before.json), "phone C360 payload unchanged by canonical links");
  assert.deepEqual(await growRowsFor(w.partyId), growBefore, "no Grow row written (no dual-write)");
  // The canonical links are visible only through the canonical read the phone does not call while OFF.
  const canon = await call(w.admin.cookie, "GET", `/parties/by-contact/${w.partyId}`);
  assert.equal(canon.status, 200);
  assert.equal(JSON.stringify(canon.json).includes(String(w.adminProp)), true);
});
