// t256u: POST /grow/contacts duplicate 409 reveals the matched contactId only with contact-read; Create anyway (confirmDuplicate) still works.
// Matching stays brokerage-scoped. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, entitlementGrants, ENTITLEMENT_KEYS } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages } from "./testSupport.js";

const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const tag = `cdup-${Date.now()}`;
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

const WITHOUT = (...drop: string[]) => GROW.filter((k) => !drop.includes(k));
const CASES = [
  { label: "read+relmanage", keys: GROW, visible: true },
  { label: "read-no-relmanage", keys: WITHOUT("grow.relationships.manage"), visible: true },
  { label: "noread+relmanage", keys: WITHOUT("grow.contacts.read"), visible: false },
  { label: "noread-no-relmanage", keys: WITHOUT("grow.contacts.read", "grow.relationships.manage"), visible: false },
] as const;

for (const c of CASES) {
  test(`t256u: create duplicate (${c.label}) — contactId ${c.visible ? "returned" : "omitted"}, Create anyway creates`, async () => {
    const b = await createBrokerageWithUsers(base, `${tag} ${c.label}`);
    ids.push(b.brokerageId);
    await setGrants(b.brokerageId, GROW);
    const email = `dup-${c.label}-${tag}@example.com`;
    const first = await call(b.admin.cookie, "POST", "/grow/contacts", { name: "Orig Inal", email, phone: "0413555666" });
    assert.equal(first.status, 201);
    const originalId = first.json.contact.id as number;
    await setGrants(b.brokerageId, c.keys);

    const dup = await call(b.admin.cookie, "POST", "/grow/contacts", { name: "Dup Licate", email: email.toUpperCase() });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.code, "POTENTIAL_DUPLICATE_CONTACT");
    assert.equal(dup.json.canConfirm, true);
    if (c.visible) assert.equal(dup.json.contactId, originalId);
    else {
      assert.equal("contactId" in dup.json, false, "no identity without contact-read");
      assert.equal(JSON.stringify(dup.json).includes(String(originalId)), false);
    }
    assert.equal(/link existing/i.test(JSON.stringify(dup.json)), false);

    const phoneDup = await call(b.admin.cookie, "POST", "/grow/contacts", { name: "Dup Phone", phone: "0413555666" });
    assert.equal(phoneDup.status, 409);
    assert.equal("contactId" in phoneDup.json, c.visible);

    const anyway = await call(b.admin.cookie, "POST", "/grow/contacts", { name: "Dup Licate", email, confirmDuplicate: true });
    assert.equal(anyway.status, 201, JSON.stringify(anyway.json));
    assert.notEqual(anyway.json.contact.id, originalId);
    const w = anyway.json.warnings as { code: string; contactId?: number }[];
    assert.ok(Array.isArray(w) && w.length >= 1);
    for (const x of w) {
      assert.equal(x.code, "POTENTIAL_DUPLICATE_CONTACT");
      if (c.visible) assert.equal(typeof x.contactId, "number");
      else assert.equal("contactId" in x, false);
    }
  });
}

test("t256u: duplicate match stays brokerage-scoped; no-dup create unaffected; no manage still 403", async () => {
  const a = await createBrokerageWithUsers(base, `${tag} scopeA`);
  const o = await createBrokerageWithUsers(base, `${tag} scopeB`);
  ids.push(a.brokerageId, o.brokerageId);
  await setGrants(a.brokerageId, GROW);
  await setGrants(o.brokerageId, GROW);
  const email = `scope-${tag}@example.com`;
  assert.equal((await call(a.admin.cookie, "POST", "/grow/contacts", { name: "A One", email })).status, 201);
  const other = await call(o.admin.cookie, "POST", "/grow/contacts", { name: "B One", email });
  assert.equal(other.status, 201, "other brokerage never matches");
  assert.equal(other.json.warnings, undefined);
  await setGrants(o.brokerageId, WITHOUT("grow.contacts.manage"));
  assert.equal((await call(o.admin.cookie, "POST", "/grow/contacts", { name: "B Two", email: `x-${email}` })).status, 403);
});
