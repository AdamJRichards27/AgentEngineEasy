// Owner t275u item 5: Business Coach and Ask AE are agent-only (lib/agentAiAccess.ts):
// not Pit Crew, not a read-only agent, not a Brokerage Administrator unless explicitly
// authorised (AE_AGENT_AI_ADMIN_USER_IDS). Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { and } from "drizzle-orm";
import { db, entitlementGrants, users, properties, parties, auditLogs, ENTITLEMENT_KEYS, growRelationships, growContactRelationships, propertyParties, GROW_CONTACT_RELATIONSHIP_TYPES, GROW_RELATIONSHIP_TYPES } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin } from "./testSupport.js";

const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const tag = `agentai-${Date.now()}`;
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


const AGENT_ONLY = "AGENT_AI_AGENT_ONLY";
const ask = (cookie: string, body: Record<string, unknown> = {}) => call(cookie, "POST", "/ai/ask", { question: "How am I tracking?", ...body });

test("t275u Ask AE / Business Coach: Pit Crew, admins (by default) and read-only agents are refused server-side; agents pass the gate", async () => {
  const w = await world("Roles");
  delete process.env.AE_AGENT_AI_ADMIN_USER_IDS;
  for (const body of [{}, { contextType: "grow", mode: "coach" }, { contextType: "grow" }]) {
    const pc = await ask(w.pc.cookie, body);
    assert.equal(pc.status, 403, pc.text);
    assert.deepEqual([pc.json.code, pc.json.reason], [AGENT_ONLY, "PIT_CREW"]);
    const admin = await ask(w.admin.cookie, body);
    assert.deepEqual([admin.status, admin.json.code, admin.json.reason], [403, AGENT_ONLY, "ADMIN_NOT_AUTHORISED"]);
    const agent = await ask(w.agent.cookie, body);
    assert.notEqual(agent.json?.code, AGENT_ONLY, agent.text);
  }
  const caps = async (cookie: string) => (await call(cookie, "GET", "/ai/capabilities")).json;
  assert.deepEqual([(await caps(w.pc.cookie)).agentAiAllowed, (await caps(w.pc.cookie)).businessCoachEnabled, (await caps(w.pc.cookie)).copilotEnabled], [false, false, false]);
  assert.equal((await caps(w.admin.cookie)).agentAiAllowed, false);
  assert.equal((await caps(w.agent.cookie)).agentAiAllowed, true);
  const voice = new FormData();
  voice.set("audio", new Blob([Buffer.alloc(100)], { type: "audio/wav" }), "a.wav");
  const v = await fetch(`${base}/api/ai/voice/transcribe`, { method: "POST", headers: { cookie: w.pc.cookie }, body: voice });
  assert.equal(v.status, 403);
  // Read-only agent (grow.contacts.read only).
  await setGrants(w.brokerageId, ["grow.contacts.read"]);
  const ro = await ask(w.agent.cookie);
  assert.deepEqual([ro.status, ro.json.code, ro.json.reason], [403, AGENT_ONLY, "READ_ONLY"]);
  await setGrants(w.brokerageId, ["run.access", ...GROW]);
  // An administrator separately and explicitly authorised passes the gate.
  process.env.AE_AGENT_AI_ADMIN_USER_IDS = String(w.admin.user.id);
  try {
    const admin = await ask(w.admin.cookie);
    assert.notEqual(admin.json?.code, AGENT_ONLY, admin.text);
    assert.equal((await caps(w.admin.cookie)).agentAiAllowed, true);
  } finally {
    delete process.env.AE_AGENT_AI_ADMIN_USER_IDS;
  }
});
