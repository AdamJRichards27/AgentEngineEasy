// GOPF — GET /grow/opportunities?propertyId= (server-side property filter).
// Decision: filter semantics, not lookup semantics. propertyId is one more AND
// on the existing brokerage + owner-or-own-property predicates, so a foreign,
// missing, or invisible property gives 200 with a byte-identical empty page,
// the same as `?id=` on this list. Isolation cases copy the GR-ISO matrix
// approach (growRouteIsolationMatrix.test.ts on #250): foreign == missing
// byte-for-byte, no victim marker, no row changes. Synthetic data only.
import { before, after, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { asc, eq } from "drizzle-orm";
import { db, entitlementGrants, growOpportunities } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const GROW_KEYS = ["grow.access", "grow.contacts.read", "grow.contacts.manage", "grow.properties.link", "grow.opportunities.manage"] as const;
const MISSING = 2147480000;
const suffix = Date.now();

let server: Server;
let baseUrl: string;
type Org = { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let victim: Org;
let attacker: Org;
let unentitled: Org;
const ids = {} as {
  vProp: number; vProp2: number; vAgentProp: number; vOpp1: number; vOpp2: number; vOppOther: number;
  vAgentOpp: number; vAgentOwnOnHidden: number; aProp: number;
};

async function send(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers: body === undefined ? { cookie } : { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function ok<T>(res: Response, status = 201): Promise<T> {
  assert.equal(res.status, status, await res.clone().text());
  return (await res.json()) as T;
}
async function grantAll(id: number) {
  for (const key of GROW_KEYS) {
    await db.insert(entitlementGrants).values({ brokerageId: id, entitlementKey: key, granteeType: "brokerage", granteeId: id, sourceType: "manual", status: "Active" });
  }
  invalidateEntitlementCache(id);
}
async function snapshot(brokerageId: number): Promise<string> {
  return JSON.stringify(await db.select().from(growOpportunities).where(eq(growOpportunities.brokerageId, brokerageId)).orderBy(asc(growOpportunities.id)));
}
async function list(cookie: string, query: string) {
  const res = await send("GET", `/grow/opportunities${query}`, cookie);
  const text = await res.text();
  return { status: res.status, text, header: res.headers.get("x-ae-grow-filters") };
}
function oppIds(text: string): number[] {
  return ((JSON.parse(text) as { opportunities: { id: number }[] }).opportunities.map((o) => o.id)).sort((x, y) => x - y);
}

describe("GOPF GET /grow/opportunities?propertyId=", { concurrency: 1 }, () => {
  before(async () => {
    const { configureEvents } = await import("../../lib/events.js");
    configureEvents();
    const { createApp } = await import("../../app.js");
    server = createApp().listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("bad address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
    victim = await createBrokerageWithUsers(baseUrl, `GOPF Victim ${suffix}`);
    attacker = await createBrokerageWithUsers(baseUrl, `GOPF Attacker ${suffix}`);
    unentitled = await createBrokerageWithUsers(baseUrl, `GOPF None ${suffix}`);
    await grantAll(victim.brokerageId);
    await grantAll(attacker.brokerageId);

    const prop = async (ck: string, tag: string) =>
      (await ok<{ property: { id: number } }>(await send("POST", "/properties", ck, { formattedAddress: `${tag} Synthetic St`, state: "NSW", suburb: "Testville", postcode: "2000" }))).property.id;
    const contact = async (ck: string, tag: string) =>
      (await ok<{ contact: { id: number } }>(await send("POST", "/grow/contacts", ck, { firstName: tag, lastName: `C${suffix}`, email: `${tag.toLowerCase()}-${suffix}@example.com` }))).contact.id;
    const opp = async (ck: string, partyId: number, propertyId: number | undefined, reason: string) =>
      (await ok<{ opportunity: { id: number } }>(await send("POST", "/grow/opportunities", ck, { partyId, propertyId, opportunityType: "Appraisal", reason }))).opportunity.id;

    const vck = victim.admin.cookie;
    ids.vProp = await prop(vck, "Victim 1");
    ids.vProp2 = await prop(vck, "Victim 2");
    ids.vAgentProp = await prop(victim.agent.cookie, "Victim Agent 3");
    const vc = await contact(vck, "Victim");
    ids.vOpp1 = await opp(vck, vc, ids.vProp, "Victim p1 a");
    ids.vOpp2 = await opp(vck, vc, ids.vProp, "Victim p1 b");
    ids.vOppOther = await opp(vck, vc, ids.vProp2, "Victim p2");
    ids.vAgentOpp = await opp(victim.agent.cookie, vc, ids.vAgentProp, "Victim agent own prop");
    // An Agent-owned opportunity on an admin property the Agent cannot see (stays hidden).
    ids.vAgentOwnOnHidden = await opp(vck, vc, ids.vProp2, "Victim agent owner hidden prop");
    await db.update(growOpportunities).set({ ownerUserId: victim.agent.user.id }).where(eq(growOpportunities.id, ids.vAgentOwnOnHidden));
    ids.aProp = await prop(attacker.admin.cookie, "Attacker 1");
  });

  after(async () => {
    await cleanupBrokerages([victim?.brokerageId, attacker?.brokerageId, unentitled?.brokerageId]);
    await new Promise<void>((r) => server.close(() => r()));
  });

  test("positive: admin gets exactly the property's opportunities, count agrees, header set", async () => {
    const r = await list(victim.admin.cookie, `?propertyId=${ids.vProp}`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(oppIds(r.text), [ids.vOpp1, ids.vOpp2].sort((x, y) => x - y));
    assert.equal((JSON.parse(r.text) as { total: number }).total, 2);
    assert.equal(r.header, "propertyId");
    const r2 = await list(victim.admin.cookie, `?propertyId=${ids.vProp2}`);
    assert.deepEqual(oppIds(r2.text), [ids.vOppOther, ids.vAgentOwnOnHidden].sort((x, y) => x - y));
  });

  test("positive: composes with type, search, id and paging", async () => {
    assert.deepEqual(oppIds((await list(victim.admin.cookie, `?propertyId=${ids.vProp}&search=p1%20a`)).text), [ids.vOpp1]);
    assert.deepEqual(oppIds((await list(victim.admin.cookie, `?propertyId=${ids.vProp}&type=property_management`)).text), []);
    assert.deepEqual(oppIds((await list(victim.admin.cookie, `?propertyId=${ids.vProp}&id=${ids.vOppOther}`)).text), []);
    const p1 = JSON.parse((await list(victim.admin.cookie, `?propertyId=${ids.vProp}&limit=1`)).text) as { opportunities: { id: number }[]; nextCursor: string | null; total: number };
    assert.equal(p1.opportunities.length, 1);
    assert.equal(p1.total, 2);
    assert.ok(p1.nextCursor);
    const p2 = JSON.parse((await list(victim.admin.cookie, `?propertyId=${ids.vProp}&limit=1&cursor=${encodeURIComponent(p1.nextCursor!)}`)).text) as { opportunities: { id: number }[] };
    assert.equal(p2.opportunities.length, 1);
    assert.notEqual(p2.opportunities[0].id, p1.opportunities[0].id);
  });

  test("absent param: unchanged list behaviour and no header", async () => {
    const r = await list(victim.admin.cookie, "");
    assert.equal(r.status, 200);
    assert.equal(r.header, null);
    assert.equal(oppIds(r.text).length, 5);
  });

  test("validation: bad propertyId is 400", async () => {
    for (const bad of ["0", "-1", "abc", "1.5", "1e3", "2147483648", "01"]) {
      const r = await list(victim.admin.cookie, `?propertyId=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 400, `${bad}: ${r.text}`);
      assert.deepEqual(JSON.parse(r.text), { error: "propertyId must be a positive integer" });
    }
    const arr = await list(victim.admin.cookie, `?propertyId=1&propertyId=2`);
    assert.equal(arr.status, 400);
  });

  for (const role of ["admin", "agent"] as const) {
    test(`isolation: foreign propertyId == missing propertyId (byte-identical empty page), no side effects — attacker ${role}`, async () => {
      const ck = attacker[role].cookie;
      const vBefore = await snapshot(victim.brokerageId);
      const aBefore = await snapshot(attacker.brokerageId);
      for (const foreignProp of [ids.vProp, ids.vProp2, ids.vAgentProp]) {
        const foreign = await list(ck, `?propertyId=${foreignProp}`);
        const missing = await list(ck, `?propertyId=${MISSING}`);
        assert.equal(foreign.status, 200, foreign.text);
        assert.equal(foreign.status, missing.status);
        assert.equal(foreign.text, missing.text, "body differs (existence hint)");
        assert.equal(foreign.header, missing.header);
        assert.ok(!foreign.text.includes("Victim"), "leaked victim marker");
        assert.deepEqual(JSON.parse(foreign.text).opportunities, []);
        assert.equal(JSON.parse(foreign.text).total, 0);
      }
      assert.equal(await snapshot(victim.brokerageId), vBefore);
      assert.equal(await snapshot(attacker.brokerageId), aBefore);
    });
  }

  test("isolation: unentitled brokerage is refused 403 with the filter", async () => {
    for (const role of ["admin", "agent"] as const) {
      const r = await list(unentitled[role].cookie, `?propertyId=${ids.vProp}`);
      assert.equal(r.status, 403, r.text);
      assert.equal((JSON.parse(r.text) as { error: string }).error, "Not entitled");
      assert.ok(!r.text.includes("Victim"));
    }
  });

  test("visibility (same brokerage): Agent sees own-property opps, hidden property == missing, filter never widens visibility", async () => {
    const ck = victim.agent.cookie;
    assert.deepEqual(oppIds((await list(ck, `?propertyId=${ids.vAgentProp}`)).text), [ids.vAgentOpp]);
    const hidden = await list(ck, `?propertyId=${ids.vProp}`);
    const missing = await list(ck, `?propertyId=${MISSING}`);
    assert.equal(hidden.status, 200);
    assert.equal(hidden.text, missing.text, "hidden property must look like a missing one");
    assert.ok(!hidden.text.includes("Victim p1"));
    // Existing rule (visibleOwnedOrLinkedPropertySql): a property-linked row
    // needs the property in the Agent's own-property set, even when the Agent
    // is the opportunity owner. The filter must not widen that.
    const ownHidden = await list(ck, `?propertyId=${ids.vProp2}`);
    assert.equal(ownHidden.text, missing.text);
    // Same row set as the unfiltered list narrowed client-side.
    const all = JSON.parse((await list(ck, "?limit=100")).text) as { opportunities: { id: number; propertyId: number | null }[] };
    for (const p of [ids.vProp, ids.vProp2, ids.vAgentProp]) {
      const expected = all.opportunities.filter((o) => o.propertyId === p).map((o) => o.id).sort((x, y) => x - y);
      assert.deepEqual(oppIds((await list(ck, `?propertyId=${p}`)).text), expected, `property ${p}`);
    }
  });
});
