// t236u B: access matrix for /parties (both directions, link, unlink, role,
// primary) and Tap-to-Call, for Run, Grow-only, unsubscribed, read-only and
// cross-brokerage callers. Plus Tap-to-Call consent behaviour. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, entitlementGrants, users, growActivities, growContactChannelConsents, growContactChannelSuppressions, growContactDncrStatuses, ENTITLEMENT_KEYS } from "@aee/db";
import { and } from "drizzle-orm";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin } from "./testSupport.js";

const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const tag = `pmx-${Date.now()}`;
const READ_ONLY = ["grow.access", "grow.contacts.read"];
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

async function world(label: string) {
  const name = `${tag} ${label}`;
  const b = await createBrokerageWithUsers(base, name);
  ids.push(b.brokerageId);
  await setGrants(b.brokerageId, ["run.access", ...GROW]);
  const prop = await call(b.admin.cookie, "POST", "/properties", { formattedAddress: `1 ${name} St, Testville`, state: "NSW", suburb: "Testville", postcode: "2000" });
  assert.equal(prop.status, 201);
  const propertyId = prop.json.property.id as number;
  const c = await call(b.admin.cookie, "POST", "/parties", { propertyId, role: "Seller", firstName: "Mat", mobile: "0400 000 111", callConsent: { confirmed: true } });
  assert.equal(c.status, 201);
  const spare = await call(b.admin.cookie, "POST", "/grow/contacts", { name: `Spare ${label}`, email: `spare-${label.toLowerCase()}-${tag}@example.com` });
  assert.equal(spare.status, 201);
  return { ...b, propertyId, partyId: c.json.party.id as number, linkId: c.json.link.id as number, spareId: spare.json.contact.id as number };
}

type W = Awaited<ReturnType<typeof world>>;
// Each op runs as `who` against target world `t`; returns the status.
const OPS: Record<string, (who: W, t: W) => Promise<number>> = {
  "create+link": async (who, t) => (await call(who.admin.cookie, "POST", "/parties", { propertyId: t.propertyId, role: "Other", firstName: "New" })).status,
  "link existing": async (who, t) => (await call(who.admin.cookie, "POST", "/parties", { propertyId: t.propertyId, partyId: t.spareId, role: "Tenant" })).status,
  "property->contacts": async (who, t) => (await call(who.admin.cookie, "GET", `/parties/by-property/${t.propertyId}`)).status,
  "contact->properties": async (who, t) => (await call(who.admin.cookie, "GET", `/parties/by-contact/${t.partyId}`)).status,
  "role": async (who, t) => (await call(who.admin.cookie, "PATCH", `/parties/link/${t.linkId}`, { role: "Owner" })).status,
  "primary": async (who, t) => (await call(who.admin.cookie, "PATCH", `/parties/link/${t.linkId}`, { isPrimary: true })).status,
  "tap-to-call": async (who, t) => (await call(who.admin.cookie, "GET", `/parties/${t.partyId}/tap-to-call`)).status,
  "unlink": async (who, t) => (await call(who.admin.cookie, "DELETE", `/parties/link/${t.linkId}`)).status,
};
const READS = new Set(["property->contacts", "contact->properties"]);

for (const [persona, keys] of [["Run", ["run.access"]], ["Grow-only", GROW], ["unsubscribed", []], ["read-only", READ_ONLY]] as const) {
  test(`access matrix: ${persona}`, async () => {
    const w = await world(`M-${persona}`);
    await setGrants(w.brokerageId, keys);
    const got: Record<string, number> = {};
    for (const [op, fn] of Object.entries(OPS)) got[op] = await fn(w, w);
    const expected: Record<string, number> = {};
    for (const op of Object.keys(OPS)) {
      if (persona === "unsubscribed") expected[op] = 403;
      else if (persona === "read-only") expected[op] = READS.has(op) ? 200 : 403;
      else expected[op] = op === "create+link" || op === "link existing" ? 201 : op === "unlink" ? 204 : 200;
    }
    assert.deepEqual(got, expected);
  });
}

test("access matrix: cross-brokerage caller gets 404 on every op against another brokerage's ids", async () => {
  const a = await world("X-A");
  const o = await world("X-B");
  const got: Record<string, number> = {};
  for (const [op, fn] of Object.entries(OPS)) got[op] = await fn(o, a);
  assert.deepEqual(got, Object.fromEntries(Object.keys(OPS).map((k) => [k, 404])));
  // Nothing changed on a's side.
  const rows = (await call(a.admin.cookie, "GET", `/parties/by-property/${a.propertyId}`)).json.parties;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, "Seller");
});

test("Tap-to-Call: consent captured at create (timestamp + agent + restrictions); tel: shown without per-call re-confirmation; hidden on withdrawal, do-not-call, suppression, DNCR listed or no consent", async () => {
  const w = await world("TTC");
  const s1 = await call(w.agent.cookie, "GET", `/parties/${w.partyId}/tap-to-call`);
  assert.equal(s1.status, 200);
  assert.equal(s1.json.available, true);
  assert.equal(s1.json.telHref, "tel:0400000111");
  assert.equal(s1.json.confirmedByUserId, w.admin.user.id);
  assert.ok(!Number.isNaN(Date.parse(s1.json.confirmedAt)));
  // No re-confirmation per call: repeated reads stay available and write nothing.
  const before = (await db.select().from(growContactChannelConsents).where(eq(growContactChannelConsents.partyId, w.partyId))).length;
  for (let i = 0; i < 3; i++) assert.equal((await call(w.agent.cookie, "GET", `/parties/${w.partyId}/tap-to-call`)).json.available, true);
  assert.equal((await db.select().from(growContactChannelConsents).where(eq(growContactChannelConsents.partyId, w.partyId))).length, before);

  // Restrictions recorded via People create; restriction text returned.
  const g = await call(w.agent.cookie, "POST", "/grow/contacts", { name: "Rae Restricted", mobile: "+61 400 222 333", callConsent: { confirmed: true, restrictions: "Weekdays after 5pm only" } });
  assert.equal(g.status, 201);
  const gs = (await call(w.agent.cookie, "GET", `/parties/${g.json.contact.id}/tap-to-call`)).json;
  assert.equal(gs.available, true);
  assert.equal(gs.telHref, "tel:+61400222333");
  assert.equal(gs.restrictions, "Weekdays after 5pm only");

  // No consent / no phone.
  const n = await call(w.agent.cookie, "POST", "/grow/contacts", { name: "Ned NoConsent", mobile: "0400 333 444" });
  assert.equal((await call(w.agent.cookie, "GET", `/parties/${n.json.contact.id}/tap-to-call`)).json.reason, "NO_CONSENT");
  assert.equal((await call(w.agent.cookie, "GET", `/parties/${w.spareId}/tap-to-call`)).json.reason, "NO_PHONE");

  // Do-not-call preference recorded later hides it.
  const d = await call(w.agent.cookie, "POST", `/parties/${g.json.contact.id}/call-consent`, { confirmed: false, doNotCall: true, restrictions: "Asked not to be called" });
  assert.equal(d.status, 201);
  assert.deepEqual([d.json.available, d.json.reason], [false, "DO_NOT_CALL"]);
  assert.equal(d.json.telHref, undefined);

  // Withdrawal (existing consent model) hides it.
  await db.insert(growContactChannelConsents).values({ brokerageId: w.brokerageId, partyId: w.partyId, channel: "PHONE_CALL", state: "WITHDRAWN", source: "MANUAL", captureMethod: "test", purpose: "TAP_TO_CALL", scope: "PHONE_CALL", recordedByUserId: w.admin.user.id, withdrawnAt: new Date(), withdrawnByUserId: w.admin.user.id, withdrawalReason: "synthetic" });
  assert.equal((await call(w.agent.cookie, "GET", `/parties/${w.partyId}/tap-to-call`)).json.reason, "CONSENT_WITHDRAWN");

  // Suppression and DNCR listing hide it, even with fresh consent.
  const sp = await call(w.admin.cookie, "POST", "/parties", { propertyId: w.propertyId, role: "Other", firstName: "Sup", mobile: "0400 555 666", callConsent: { confirmed: true } });
  await db.insert(growContactChannelSuppressions).values({ brokerageId: w.brokerageId, partyId: sp.json.party.id, channel: "PHONE_CALL", state: "SUPPRESSED", reason: "synthetic", recordedByUserId: w.admin.user.id });
  assert.equal((await call(w.agent.cookie, "GET", `/parties/${sp.json.party.id}/tap-to-call`)).json.reason, "SUPPRESSED");
  const dn = await call(w.admin.cookie, "POST", "/parties", { propertyId: w.propertyId, role: "Other", firstName: "Dnc", mobile: "0400 777 888", callConsent: { confirmed: true } });
  await db.insert(growContactDncrStatuses).values({ brokerageId: w.brokerageId, partyId: dn.json.party.id, channel: "PHONE_CALL", status: "LISTED", source: "MANUAL", recordedByUserId: w.admin.user.id });
  assert.equal((await call(w.agent.cookie, "GET", `/parties/${dn.json.party.id}/tap-to-call`)).json.reason, "DNCR_LISTED");
});

test("Tap-to-Call: optional post-call note is a plain activity; never a recording or completion; read-only cannot add one", async () => {
  const w = await world("Note");
  const r = await call(w.agent.cookie, "POST", `/parties/${w.partyId}/call-notes`, { note: "Spoke briefly; call back Tuesday", propertyId: w.propertyId });
  // The agent cannot see the admin's property (own-property scope) -> 404; without a property it works.
  assert.equal(r.status, 404);
  const ok = await call(w.agent.cookie, "POST", `/parties/${w.partyId}/call-notes`, { note: "Spoke briefly; call back Tuesday" });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.activity.activityType, "call_note");
  assert.deepEqual(ok.json.activity.details, { via: "tap_to_call", recorded: false, outcome: null });
  const acts = await db.select().from(growActivities).where(and(eq(growActivities.partyId, w.partyId), eq(growActivities.source, "tap_to_call")));
  assert.equal(acts.length, 1, "only the note the agent chose to add; nothing automatic");
  assert.equal((await call(w.admin.cookie, "POST", `/parties/${w.partyId}/call-notes`, { note: "x", propertyId: w.propertyId })).status, 201);
  await setGrants(w.brokerageId, READ_ONLY);
  assert.equal((await call(w.admin.cookie, "POST", `/parties/${w.partyId}/call-notes`, { note: "x" })).status, 403);
  assert.equal((await call(w.admin.cookie, "POST", `/parties/${w.partyId}/call-consent`, { confirmed: true })).status, 403);
});

test("t237u: a contact created before Tap-to-Call (no consent row) is NO_CONSENT; reading status never creates consent", async () => {
  const w = await world("Hist");
  const h = await call(w.admin.cookie, "POST", "/grow/contacts", { name: "Hal Historical", mobile: "0400 999 000" });
  const id = h.json.contact.id as number;
  for (let i = 0; i < 2; i++) assert.equal((await call(w.admin.cookie, "GET", `/parties/${id}/tap-to-call`)).json.reason, "NO_CONSENT");
  assert.equal((await db.select().from(growContactChannelConsents).where(eq(growContactChannelConsents.partyId, id))).length, 0);
});
