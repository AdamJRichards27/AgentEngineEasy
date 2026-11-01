// t234u item 4: legacy route guards. Synthetic data only.
// Older appraisal routes, property thread creation/reads, messages,
// templates, and property list/detail/workspace/timeline now require a
// Grow or Run subscription, respect read-only grants, hide other agents'
// properties (404) and stay brokerage-isolated (404).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, entitlementGrants, ENTITLEMENT_KEYS } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages } from "./testSupport.js";

const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const READ_ONLY = ["grow.access", "grow.contacts.read"] as const;
const tag = `lrg-${Date.now()}`;
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

async function setup(label: string) {
  const name = `${tag} ${label}`;
  const b = await createBrokerageWithUsers(base, name);
  ids.push(b.brokerageId);
  await setGrants(b.brokerageId, ["run.access", ...GROW]);
  const mk = async (cookie: string, n: string) => {
    const r = await call(cookie, "POST", "/properties", { formattedAddress: `${n} ${name} St, Testville`, state: "NSW", suburb: "Testville", postcode: "2000" });
    assert.equal(r.status, 201, `create property: ${JSON.stringify(r.json)}`);
    return r.json.property.id as number;
  };
  const adminProp = await mk(b.admin.cookie, "1");
  const agentProp = await mk(b.agent.cookie, "2");
  const t = await call(b.admin.cookie, "POST", `/properties/${adminProp}/communications/threads`, { subject: "Synthetic thread" });
  assert.equal(t.status, 201, JSON.stringify(t.json));
  const tpl = await call(b.admin.cookie, "POST", "/communications/templates", {
    templateKey: `lrg-${label}-${Date.now()}`, name: "Synthetic", channel: "EMAIL", classification: "SERVICE", category: "GENERAL", bodyText: "Hello",
  });
  assert.equal(tpl.status, 201, JSON.stringify(tpl.json));
  return { ...b, adminProp, agentProp, threadId: t.json.id as number, templateId: tpl.json.id as number };
}

const reads = (b: Awaited<ReturnType<typeof setup>>) => [
  ["GET", "/properties"],
  ["GET", `/properties/${b.adminProp}`],
  ["GET", `/properties/${b.adminProp}/workspace`],
  ["GET", `/properties/${b.adminProp}/timeline`],
  ["GET", `/appraisals/by-property/${b.adminProp}`],
  ["GET", `/properties/${b.adminProp}/communications/threads`],
  ["GET", `/properties/${b.adminProp}/communications/recipients`],
  ["GET", `/communications/threads/${b.threadId}`],
  ["GET", "/communications/templates"],
  ["GET", "/communications/hub"],
] as const;

const writes = (b: Awaited<ReturnType<typeof setup>>) => [
  ["POST", `/appraisals/by-property/${b.adminProp}/start`, {}],
  ["POST", `/properties/${b.adminProp}/communications/threads`, { subject: "More" }],
  ["POST", "/communications/templates", { templateKey: `lrg-w-${Date.now()}`, name: "W", channel: "EMAIL", classification: "SERVICE", category: "GENERAL", bodyText: "x" }],
  ["POST", `/communications/templates/${b.templateId}/versions`, { bodyText: "v2" }],
] as const;

test("subscription: unsubscribed brokerage gets 403 on every legacy read and write", async () => {
  const b = await setup("Unsub");
  await setGrants(b.brokerageId, []);
  for (const [m, p] of reads(b)) assert.equal((await call(b.admin.cookie, m, p)).status, 403, `${m} ${p}`);
  for (const [m, p, body] of writes(b)) assert.equal((await call(b.admin.cookie, m, p, body)).status, 403, `${m} ${p}`);
});

test("subscription: Grow-only and Run-only both reach the legacy reads and writes", async () => {
  const b = await setup("Either");
  for (const keys of [GROW, ["run.access"]]) {
    await setGrants(b.brokerageId, keys);
    for (const [m, p] of reads(b)) assert.equal((await call(b.admin.cookie, m, p)).status, 200, `${keys.length} ${m} ${p}`);
    const t = await call(b.admin.cookie, "POST", `/properties/${b.adminProp}/communications/threads`, { subject: "Either" });
    assert.equal(t.status, 201);
    const a = await call(b.admin.cookie, "POST", `/appraisals/by-property/${b.adminProp}/start`, {});
    assert.ok(a.status === 200 || a.status === 201, `appraisal start ${a.status}`);
  }
});

test("read-only grant: can view, cannot change (appraisal, thread, template, message cancel)", async () => {
  const b = await setup("ReadOnly");
  await setGrants(b.brokerageId, READ_ONLY);
  for (const [m, p] of reads(b)) assert.equal((await call(b.admin.cookie, m, p)).status, 200, `${m} ${p}`);
  for (const [m, p, body] of writes(b)) assert.equal((await call(b.admin.cookie, m, p, body)).status, 403, `${m} ${p}`);
  assert.equal((await call(b.admin.cookie, "POST", `/communications/templates/${b.templateId}/archive`)).status, 403);
  assert.equal((await call(b.admin.cookie, "POST", `/communications/templates/${b.templateId}/activate`)).status, 403);
  assert.equal((await call(b.admin.cookie, "POST", `/communications/threads/${b.threadId}/participants/manual`, {})).status, 403);
});

test("property visibility: an Agent gets 404 on another agent's property threads, appraisal, detail and timeline; list omits it", async () => {
  const b = await setup("Vis");
  for (const [m, p] of reads(b)) {
    if (p === "/properties" || p === "/communications/templates" || p === "/communications/hub") continue;
    assert.equal((await call(b.agent.cookie, m, p)).status, 404, `${m} ${p}`);
  }
  assert.equal((await call(b.agent.cookie, "POST", `/properties/${b.adminProp}/communications/threads`, { subject: "x" })).status, 404);
  assert.equal((await call(b.agent.cookie, "POST", `/appraisals/by-property/${b.adminProp}/start`, {})).status, 404);
  assert.equal((await call(b.agent.cookie, "POST", `/communications/threads/${b.threadId}/participants/manual`, {})).status, 404);
  const list = (await call(b.agent.cookie, "GET", "/properties")).json.properties.map((p: any) => p.id);
  assert.ok(list.includes(b.agentProp) && !list.includes(b.adminProp));
  // Own property still works.
  assert.equal((await call(b.agent.cookie, "POST", `/properties/${b.agentProp}/communications/threads`, { subject: "Mine" })).status, 201);
});

test("brokerage isolation: another brokerage gets 404 on property, appraisal, thread, template ids", async () => {
  const a = await setup("IsoA");
  const o = await setup("IsoB");
  for (const [m, p] of reads(a)) {
    if (p === "/properties" || p === "/communications/templates" || p === "/communications/hub") continue;
    assert.equal((await call(o.admin.cookie, m, p)).status, 404, `${m} ${p}`);
  }
  assert.equal((await call(o.admin.cookie, "POST", `/properties/${a.adminProp}/communications/threads`, { subject: "x" })).status, 404);
  assert.equal((await call(o.admin.cookie, "POST", `/appraisals/by-property/${a.adminProp}/start`, {})).status, 404);
  const v = (await call(o.admin.cookie, "POST", `/communications/templates/${a.templateId}/versions`, { bodyText: "x" })).status;
  assert.ok(v === 404 || v === 422, `template version cross-brokerage ${v}`);
  const theirs = (await call(o.admin.cookie, "GET", "/properties")).json.properties.map((p: any) => p.id);
  assert.ok(!theirs.includes(a.adminProp) && !theirs.includes(a.agentProp));
  const tpls = (await call(o.admin.cookie, "GET", "/communications/templates")).json.templates.map((t: any) => t.id);
  assert.ok(!tpls.includes(a.templateId));
});
