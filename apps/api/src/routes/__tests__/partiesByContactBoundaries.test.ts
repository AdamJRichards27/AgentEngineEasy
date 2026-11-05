// t266u (Owner-approved B-1): by-contact total/limit/truncated are exact at 0, 99, 100 and 101 links, and links hidden by the own-property rule are excluded from both links and total.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, entitlementGrants, parties, properties, propertyParties, ENTITLEMENT_KEYS } from "@aee/db";
import { BY_CONTACT_LIMIT } from "../parties.js";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages } from "./testSupport.js";

const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const tag = `bcb-${Date.now()}`;
let server: Server; let base = ""; const ids: number[] = [];
before(async () => { const { createApp } = await import("../../app.js"); server = createApp().listen(0); await new Promise<void>((r) => server.once("listening", () => r())); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
after(async () => { try { await cleanupBrokerages(ids); } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); } });
async function setGrants(brokerageId: number, keys: readonly string[]) {
  await db.delete(entitlementGrants).where(eq(entitlementGrants.brokerageId, brokerageId));
  for (const k of keys) await db.insert(entitlementGrants).values({ brokerageId, entitlementKey: k, granteeType: "brokerage", granteeId: brokerageId, sourceType: "admin_override", status: "Active" });
  invalidateEntitlementCache(brokerageId);
}
async function get(cookie: string, path: string) { const r = await fetch(`${base}/api${path}`, { headers: { cookie, connection: "close" } }); return { status: r.status, json: await r.json() as any }; }

async function contactWith(n: number, label: string, ownerUserId: number, brokerageId: number) {
  const [p] = await db.insert(parties).values({ brokerageId, partyType: "Person", firstName: "Bound", lastName: label }).returning({ id: parties.id });
  for (let i = 0; i < n; i++) {
    const [prop] = await db.insert(properties).values({ brokerageId, agentId: ownerUserId, formattedAddress: `${i} ${label} ${tag} St`, suburb: "Testville", state: "QLD", postcode: "4000", isManualAddress: true }).returning({ id: properties.id });
    await db.insert(propertyParties).values({ propertyId: prop.id, partyId: p.id, role: "Buyer", isPrimary: false });
  }
  return p.id;
}

test("boundaries 0 / 99 / 100 / 101 (admin sees all)", async () => {
  const b = await createBrokerageWithUsers(base, `${tag} bounds`); ids.push(b.brokerageId);
  await setGrants(b.brokerageId, ["run.access", ...GROW]);
  assert.equal(BY_CONTACT_LIMIT, 100);
  for (const n of [0, 99, 100, 101]) {
    const id = await contactWith(n, `n${n}`, b.admin.user.id, b.brokerageId);
    const r = await get(b.admin.cookie, `/parties/by-contact/${id}`);
    assert.equal(r.status, 200);
    assert.deepEqual({ total: r.json.total, limit: r.json.limit, truncated: r.json.truncated, links: r.json.links.length, properties: r.json.properties.length },
      { total: n, limit: 100, truncated: n > 100, links: Math.min(n, 100), properties: n }, `n=${n}`);
    // invariants
    assert.equal(r.json.truncated, r.json.total > r.json.links.length);
    assert.equal(new Set(r.json.links.map((l: any) => l.linkId)).size, r.json.links.length, "no duplicate links");
  }
});

test("hidden links excluded from total: agent sees only own-property links (0/1/101 hidden around the limit)", async () => {
  const b = await createBrokerageWithUsers(base, `${tag} hidden`); ids.push(b.brokerageId);
  await setGrants(b.brokerageId, ["run.access", ...GROW]);
  const id = await contactWith(101, "hid", b.admin.user.id, b.brokerageId); // 101 links on admin-owned properties
  const [own] = await db.insert(properties).values({ brokerageId: b.brokerageId, agentId: b.agent.user.id, formattedAddress: `agent ${tag} St`, suburb: "Testville", state: "QLD", postcode: "4000", isManualAddress: true }).returning({ id: properties.id });
  const admin0 = await get(b.admin.cookie, `/parties/by-contact/${id}`);
  const agent0 = await get(b.agent.cookie, `/parties/by-contact/${id}`);
  assert.deepEqual([agent0.json.total, agent0.json.truncated, agent0.json.links.length, agent0.json.properties.length], [0, false, 0, 0], "agent: 0 visible");
  assert.deepEqual([admin0.json.total, admin0.json.truncated], [101, true]);
  await db.insert(propertyParties).values({ propertyId: own.id, partyId: id, role: "Buyer", isPrimary: true });
  const agent1 = await get(b.agent.cookie, `/parties/by-contact/${id}`);
  assert.deepEqual([agent1.json.total, agent1.json.truncated, agent1.json.links.length], [1, false, 1]);
  assert.equal(agent1.json.links[0].property.id, own.id);
  assert.equal(JSON.stringify(agent1.json).includes("hid "), false, "no hidden address leaks");
  const admin1 = await get(b.admin.cookie, `/parties/by-contact/${id}`);
  assert.deepEqual([admin1.json.total, admin1.json.links.length, admin1.json.truncated], [102, 100, true]);
});
