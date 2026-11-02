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
const READS = new Set(["property->contacts", "contact->properties", "tap-to-call"]); // t242u: read-only can Call

// testing/r1 (#297 t246u): the matrix acts as the Brokerage Administrator, whose run.access now DERIVES
// relationship management (legacy Run). Pit Crew/read-only denial is covered in partiesAccess.test.ts.
const RUN_ONLY_DENIED = new Set<string>();
for (const [persona, keys] of [["Run", ["run.access", "grow.relationships.manage"]], ["Run-only", ["run.access"]], ["Grow-only", GROW], ["unsubscribed", []], ["read-only", READ_ONLY]] as const) {
  test(`access matrix: ${persona}`, async () => {
    const w = await world(`M-${persona}`);
    await setGrants(w.brokerageId, keys);
    const got: Record<string, number> = {};
    for (const [op, fn] of Object.entries(OPS)) got[op] = await fn(w, w);
    const expected: Record<string, number> = {};
    for (const op of Object.keys(OPS)) {
      if (persona === "unsubscribed") expected[op] = 403;
      else if (persona === "read-only") expected[op] = READS.has(op) ? 200 : 403;
      else if (persona.startsWith("Run-only") && RUN_ONLY_DENIED.has(op)) expected[op] = 403;
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

test("t239u: Call (tel:) is shown for every accessible phone despite DNC, suppression, DNCR listing, withdrawn or absent consent; reading never writes consent", async () => {
  const w = await world("TTC");
  // t249u: Call visibility mirrors contact-read visibility (GET /grow/contacts/:id), which is brokerage-wide for the agent.
  assert.equal((await call(w.agent.cookie, "GET", `/grow/contacts/${w.partyId}`)).status, 200);
  const s1 = await call(w.agent.cookie, "GET", `/parties/${w.partyId}/tap-to-call`);
  assert.equal(s1.status, 200);
  assert.deepEqual(s1.json, { available: true, reason: "AVAILABLE", masked: false, display: "0400 000 111", telHref: "tel:0400000111" });
  // No consent record at all (historical or never captured): still callable.
  const n = await call(w.agent.cookie, "POST", "/grow/contacts", { name: "Ned NoConsent", mobile: "0400 333 444" });
  const ns = (await call(w.agent.cookie, "GET", `/parties/${n.json.contact.id}/tap-to-call`)).json;
  assert.deepEqual([ns.available, ns.telHref], [true, "tel:0400333444"]);
  assert.equal((await db.select().from(growContactChannelConsents).where(eq(growContactChannelConsents.partyId, n.json.contact.id))).length, 0, "nothing backfilled");
  // Do-not-call preference: still callable, no warning fields.
  const g = await call(w.agent.cookie, "POST", "/grow/contacts", { name: "Rae Restricted", mobile: "+61 400 222 333" });
  const d = await call(w.agent.cookie, "POST", `/parties/${g.json.contact.id}/call-consent`, { confirmed: false, doNotCall: true, restrictions: "Asked not to be called" });
  assert.equal(d.status, 201);
  assert.deepEqual(d.json, { available: true, reason: "AVAILABLE", masked: false, display: "+61 400 222 333", telHref: "tel:+61400222333" });
  // Withdrawn consent: still callable; the withdrawal row is left untouched.
  await db.insert(growContactChannelConsents).values({ brokerageId: w.brokerageId, partyId: w.partyId, channel: "PHONE_CALL", state: "WITHDRAWN", source: "MANUAL", captureMethod: "test", purpose: "TAP_TO_CALL", scope: "PHONE_CALL", recordedByUserId: w.admin.user.id, withdrawnAt: new Date(), withdrawnByUserId: w.admin.user.id, withdrawalReason: "synthetic" });
  const consentRows = await db.select().from(growContactChannelConsents).where(eq(growContactChannelConsents.partyId, w.partyId));
  assert.equal((await call(w.agent.cookie, "GET", `/parties/${w.partyId}/tap-to-call`)).json.available, true);
  assert.deepEqual(await db.select().from(growContactChannelConsents).where(eq(growContactChannelConsents.partyId, w.partyId)), consentRows, "consent rows unchanged");
  // Active suppression and DNCR LISTED: still callable.
  const sp = await call(w.admin.cookie, "POST", "/parties", { propertyId: w.propertyId, role: "Other", firstName: "Sup", mobile: "0400 555 666" });
  await db.insert(growContactChannelSuppressions).values({ brokerageId: w.brokerageId, partyId: sp.json.party.id, channel: "PHONE_CALL", state: "SUPPRESSED", reason: "synthetic", recordedByUserId: w.admin.user.id });
  assert.equal((await call(w.agent.cookie, "GET", `/parties/${sp.json.party.id}/tap-to-call`)).json.telHref, "tel:0400555666");
  const dn = await call(w.admin.cookie, "POST", "/parties", { propertyId: w.propertyId, role: "Other", firstName: "Dnc", mobile: "0400 777 888" });
  await db.insert(growContactDncrStatuses).values({ brokerageId: w.brokerageId, partyId: dn.json.party.id, channel: "PHONE_CALL", status: "LISTED", source: "MANUAL", recordedByUserId: w.admin.user.id });
  assert.equal((await call(w.agent.cookie, "GET", `/parties/${dn.json.party.id}/tap-to-call`)).json.telHref, "tel:0400777888");
  // No phone: nothing to call.
  assert.deepEqual((await call(w.agent.cookie, "GET", `/parties/${w.spareId}/tap-to-call`)).json, { available: false, reason: "NO_PHONE", masked: false, display: null, telHref: null });
  // Repeated reads write nothing (no auto-record / auto-complete).
  const acts = (await db.select().from(growActivities).where(eq(growActivities.partyId, w.partyId))).length;
  for (let i = 0; i < 3; i++) await call(w.agent.cookie, "GET", `/parties/${w.partyId}/tap-to-call`);
  assert.equal((await db.select().from(growActivities).where(eq(growActivities.partyId, w.partyId))).length, acts);
});

test("t242u: unauthorised callers still get no number: unsubscribed 403, cross-brokerage 404, unauthenticated 401 (read-only now CAN call)", async () => {
  const w = await world("TTCDeny");
  const x = await world("TTCOther");
  const other = await call(x.admin.cookie, "GET", `/parties/${w.partyId}/tap-to-call`);
  assert.equal(other.status, 404);
  assert.equal(other.json.telHref, undefined);
  const anon = await fetch(`${base}/api/parties/${w.partyId}/tap-to-call`, { headers: { connection: "close" } });
  assert.equal(anon.status, 401);
  await setGrants(w.brokerageId, []);
  const un = await call(w.admin.cookie, "GET", `/parties/${w.partyId}/tap-to-call`);
  assert.equal(un.status, 403);
  assert.equal(un.json.telHref, undefined);
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


test("t242u: read-only users can Call a contact they can view (number + tel action) but still cannot edit, link, note or confirm", async () => {
  const w = await world("TTCReadOnly");
  await setGrants(w.brokerageId, READ_ONLY);
  const ro = await call(w.admin.cookie, "GET", `/parties/${w.partyId}/tap-to-call`);
  assert.equal(ro.status, 200);
  assert.equal(ro.json.available, true);
  assert.match(ro.json.telHref, /^tel:/);
  assert.equal((await call(w.admin.cookie, "POST", `/parties/${w.partyId}/call-notes`, { note: "x" })).status, 403);
  assert.equal((await call(w.admin.cookie, "POST", `/parties/${w.partyId}/call-consent`, { confirmed: true })).status, 403);
  assert.equal((await call(w.admin.cookie, "PATCH", `/parties/link/${w.linkId}`, { isPrimary: true })).status, 403);
  assert.equal((await call(w.admin.cookie, "DELETE", `/parties/link/${w.linkId}`)).status, 403);
});

test("t249u: Run access without contact-read gets an explicit masked state: no telHref, no full number in ANY field, consistent with the #296 list mask", async () => {
  const w = await world("TTCMasked");
  await setGrants(w.brokerageId, ["run.access"]);
  const r = await call(w.admin.cookie, "GET", `/parties/${w.partyId}/tap-to-call`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { available: false, reason: "MASKED", masked: true, display: "***111", telHref: null });
  assert.ok(!JSON.stringify(r.json).includes("0400"), "no full-number fragment anywhere in the body");
  const list = await call(w.admin.cookie, "GET", `/parties/by-property/${w.propertyId}`);
  const row = list.json.parties.find((p: { party: { id: number } }) => p.party.id === w.partyId);
  assert.equal(row.party.mobile, r.json.display, "same mask as the property-contact list");
  // call-consent (manage via run.access) must not leak through its status body either.
  const cc = await call(w.admin.cookie, "POST", `/parties/${w.partyId}/call-consent`, { confirmed: true });
  assert.equal(cc.status, 201);
  assert.equal(cc.json.telHref, null);
  assert.ok(!JSON.stringify(cc.json).includes("0400"));
});

test("t249u: contact-read callers (incl. read-only) get the full number and tel:; the shape is explicit", async () => {
  const w = await world("TTCFull");
  await setGrants(w.brokerageId, READ_ONLY);
  const r = await call(w.admin.cookie, "GET", `/parties/${w.partyId}/tap-to-call`);
  assert.deepEqual(r.json, { available: true, reason: "AVAILABLE", masked: false, display: "0400 000 111", telHref: "tel:0400000111" });
});

test("t249u: visibility — Call is available exactly where the contact itself is readable (GET /grow/contacts/:id); cross-brokerage 404 with no number", async () => {
  const w = await world("TTCVis");
  const x = await world("TTCVisOther");
  assert.equal((await call(w.agent.cookie, "GET", `/grow/contacts/${w.partyId}`)).status, 200);
  assert.equal((await call(w.agent.cookie, "GET", `/parties/${w.partyId}/tap-to-call`)).status, 200);
  const o = await call(x.admin.cookie, "GET", `/parties/${w.partyId}/tap-to-call`);
  assert.equal(o.status, 404);
  assert.ok(!JSON.stringify(o.json).includes("0400"));
});
