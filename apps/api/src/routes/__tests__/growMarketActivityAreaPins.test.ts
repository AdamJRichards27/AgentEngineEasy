import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { appraisalComparableSales, appraisals, db, entitlementGrants, properties, users } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { cleanupBrokerages, createBrokerageWithUsers, devLogin, type DevLoginResult } from "./testSupport.js";

// Owner 28 Oct 09:19 (V5 #274): map pins for OTHER agents' public Just listed
// and Sold events, carrying only the event type and the area (suburb), at a
// coarse server-computed location. Exact coordinates of other agents'
// properties must never reach the client. Assertions run on the whole
// serialized payload. Synthetic data only; no outbound calls.

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const day = 86_400_000;
let admin: DevLoginResult, agent1: DevLoginResult, agent2: DevLoginResult, pitCrew: DevLoginResult, otherAdmin: DevLoginResult;
const cleanupIds: number[] = [];
const prev = process.env.GROW_MARKET_ACTIVITY_ENABLED;
const ids: Record<string, number> = {};
let theirAppraisalId = 0;

// Exact coordinates, all distinct, none on the 0.02° grid centres.
const A2 = {
  ashListed1: [-27.4452, 152.9813], ashListed2: [-27.4488, 152.9867], ashSold: [-27.4471, 152.9902],
  bardonSingle: [-27.4583, 152.9771], ashWithdrawn: [-27.4413, 152.9751],
} as const;
const A1 = { padListed: [-27.4603, 153.0012] } as const;
const B = { foreign: [-27.4466, 152.9888] } as const;
const exactOf = (o: Record<string, readonly [number, number]>) => Object.values(o).flat();

async function grant(b: number, key: string) {
  await db.insert(entitlementGrants).values({ brokerageId: b, entitlementKey: key, granteeType: "brokerage", granteeId: b, sourceType: "manual", status: "Active" });
  invalidateEntitlementCache(b);
}
async function prop(brokerageId: number, agentId: number, label: string, suburb: string | null, status: string, ll: readonly [number, number] | null, startAgo: number, endAgo: number | null) {
  const now = Date.now();
  const [p] = await db.insert(properties).values({
    brokerageId, agentId, formattedAddress: `${label} ${suffix}`, suburb, state: "QLD", postcode: "4000", listingStatus: status,
    campaignStartDate: new Date(now - startAgo * day), campaignEndDate: endAgo == null ? null : new Date(now - endAgo * day),
    latitude: ll ? ll[0].toFixed(7) : null, longitude: ll ? ll[1].toFixed(7) : null,
  } as typeof properties.$inferInsert).returning();
  return p.id;
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const name = `PIN A ${suffix}`;
  const A = await createBrokerageWithUsers(baseUrl, name);
  admin = A.admin; agent1 = A.agent;
  agent2 = await devLogin(baseUrl, { email: `agent2-pin-${suffix}@example.com`, firstName: "Pinny", lastName: "Otheragent", brokerageName: name });
  pitCrew = await devLogin(baseUrl, { email: `pc-pin-${suffix}@example.com`, firstName: "Pit", lastName: "Crew", brokerageName: name });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));
  const OTHER = await createBrokerageWithUsers(baseUrl, `PIN Other ${suffix}`);
  otherAdmin = OTHER.admin;
  cleanupIds.push(A.brokerageId, OTHER.brokerageId);
  await grant(A.brokerageId, "grow.access");
  await grant(OTHER.brokerageId, "grow.access");
  const a1 = agent1.user.id, a2 = agent2.user.id, bA = A.brokerageId;
  ids.padListed = await prop(bA, a1, "1 Own Listed St", "Paddington", "Listed", A1.padListed, 2, null);
  ids.ashListed1 = await prop(bA, a2, "10 Hidden Listed St", "Ashgrove", "Listed", A2.ashListed1, 1, null);
  ids.ashListed2 = await prop(bA, a2, "11 Hidden Listed St", "Ashgrove", "Listed", A2.ashListed2, 3, null);
  ids.ashSold = await prop(bA, a2, "12 Hidden Sold St", "Ashgrove", "Sold", A2.ashSold, 60, 2);
  ids.bardonSingle = await prop(bA, a2, "13 Hidden Single St", "Bardon", "Listed", A2.bardonSingle, 1, null);
  ids.ashWithdrawn = await prop(bA, a2, "14 Hidden Withdrawn St", "Ashgrove", "Withdrawn", A2.ashWithdrawn, 60, 2);
  ids.kelvinNoCoords = await prop(bA, a2, "15 Hidden Uncoded St", "Kelvin Grove", "Listed", null, 1, null);
  const [appr] = await db.insert(appraisals).values({ propertyId: ids.ashListed1, brokerageId: bA } as typeof appraisals.$inferInsert).returning();
  theirAppraisalId = appr.id;
  await db.insert(appraisalComparableSales).values({ appraisalId: appr.id, address: `16 Hidden Comparable Ct ${suffix}`, source: "manual", saleDate: new Date(Date.now() - 4 * day) });
  ids.foreign = await prop(OTHER.brokerageId, OTHER.agent.user.id, "99 Foreign Listed St", "Ashgrove", "Listed", B.foreign, 1, null);
});

after(async () => {
  if (prev === undefined) delete process.env.GROW_MARKET_ACTIVITY_ENABLED;
  else process.env.GROW_MARKET_ACTIVITY_ENABLED = prev;
  await cleanupBrokerages(cleanupIds);
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});

type Pin = { key: string; type: string; suburb: string; lat: number; lng: number };
type Body = { events: { address: string; propertyId: number | null; access?: string; lat?: number | null; lng?: number | null }[]; areaPins?: Pin[] };
async function list(u: DevLoginResult, q = "?range=30d"): Promise<{ body: Body; raw: string }> {
  const res = await fetch(`${baseUrl}/api/grow/market-activity${q}`, { headers: { cookie: u.cookie } });
  assert.equal(res.status, 200);
  const raw = await res.text();
  return { body: JSON.parse(raw) as Body, raw };
}
/** Every number anywhere in the serialized payload. */
function numbersIn(raw: string): number[] {
  const out: number[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "number") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(JSON.parse(raw));
  return out;
}
function assertNoExact(raw: string, exact: readonly number[], who: string) {
  const nums = numbersIn(raw);
  for (const x of exact) {
    assert.ok(!nums.some((n) => Math.abs(n - x) < 1e-9), `${who}: exact coordinate ${x} in payload`);
    assert.ok(!raw.includes(String(x)), `${who}: exact coordinate text ${x} in payload`);
  }
}
const metres = (a: readonly [number, number], b: readonly [number, number]) => {
  const R = 6_371_000, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const onGridCentre = (v: number) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6 && Math.abs(Math.round(v * 100)) % 2 === 1;
const pinSig = (p: Pin) => `${p.type}|${p.suburb}`;

test("flag off: 404 for every role and tenant (no pins either)", async () => {
  delete process.env.GROW_MARKET_ACTIVITY_ENABLED;
  for (const u of [admin, agent1, agent2, pitCrew, otherAdmin]) {
    const res = await fetch(`${baseUrl}/api/grow/market-activity?range=30d`, { headers: { cookie: u.cookie } });
    assert.equal(res.status, 404);
  }
});

test("Agent: other agents' public Just listed/Sold become area pins carrying only type + suburb + a coarse point", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  const { body, raw } = await list(agent1);
  const pins = body.areaPins ?? [];
  assert.deepEqual(pins.map(pinSig).sort(), ["justListed|Ashgrove", "justListed|Bardon", "sold|Ashgrove"]);
  for (const p of pins) {
    assert.deepEqual(Object.keys(p).sort(), ["key", "lat", "lng", "suburb", "type"], "pin carries only type, area and a coarse point");
    assert.match(p.key, /^area-\d+$/, "pin key carries no id");
    assert.ok(onGridCentre(p.lat) && onGridCentre(p.lng), `pin ${p.key} is not a 0.02° grid centre: ${p.lat},${p.lng}`);
  }
  // Whole payload: no exact coordinate of another agent's or another tenant's property, anywhere.
  assertNoExact(raw, [...exactOf(A2), ...exactOf(B)], "agent1");
  // Whole payload: no other-agent ids, appraisal ids, private events, agent identity or provider data.
  for (const id of [ids.ashListed1, ids.ashListed2, ids.ashSold, ids.bardonSingle, ids.ashWithdrawn, ids.kelvinNoCoords, ids.foreign]) {
    assert.ok(!raw.includes(`"propertyId":${id}`) && !/"(listed|sold|withdrawn)-${id}"/.test(raw), `property id ${id} leaked`);
  }
  assert.ok(!raw.includes(`"appraisalId":${theirAppraisalId}`));
  for (const s of ["Hidden Withdrawn", "Hidden Comparable", "Foreign", "Pinny", "Otheragent", `agent2-pin-${suffix}`, "agentId", "offer", "commitment"]) {
    assert.ok(!raw.includes(s), `payload contains ${s}`);
  }
  // Own record keeps its precise point.
  const own = body.events.find((e) => e.address.includes("1 Own Listed St"))!;
  assert.deepEqual([own.lat, own.lng], [...A1.padListed]);
  // A suburb whose public events have no coordinates gets no pin.
  assert.ok(!pins.some((p) => p.suburb === "Kelvin Grove"));
});

test("coarse point differs from every exact location, including the single-property suburb", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  const pins = (await list(agent1)).body.areaPins ?? [];
  const bardon = pins.find((p) => p.suburb === "Bardon")!;
  assert.notDeepEqual([bardon.lat, bardon.lng], [...A2.bardonSingle]);
  const d = metres([bardon.lat, bardon.lng], A2.bardonSingle);
  assert.ok(d > 100, `single-property pin only ${d.toFixed(0)} m from the property`);
  assert.ok(d < 2_000, "pin stays within its ~2 km grid cell");
  for (const p of pins) for (const e of Object.values(A2)) assert.ok(metres([p.lat, p.lng], e) > 100, `${p.key} within 100 m of an exact location`);
  const ashListed = pins.find((p) => p.suburb === "Ashgrove" && p.type === "justListed")!;
  assert.notDeepEqual([ashListed.lat, ashListed.lng], [(A2.ashListed1[0] + A2.ashListed2[0]) / 2, (A2.ashListed1[1] + A2.ashListed2[1]) / 2], "raw centroid is snapped too");
});

test("the other Agent gets the mirror image: agent1's public listing as an area pin, own records precise", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  const { body, raw } = await list(agent2);
  assert.deepEqual((body.areaPins ?? []).map(pinSig), ["justListed|Paddington"]);
  assertNoExact(raw, [...exactOf(A1), ...exactOf(B)], "agent2");
  const own = body.events.find((e) => e.address.includes("13 Hidden Single St"))!;
  assert.deepEqual([own.lat, own.lng], [...A2.bardonSingle]);
  assert.ok(!raw.includes(`"propertyId":${ids.padListed}`));
});

test("Brokerage Administrator and Pit Crew keep the brokerage-wide view (Owner t531u): precise records, no area pins", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  for (const u of [admin, pitCrew]) {
    const { body, raw } = await list(u);
    assert.deepEqual(body.areaPins, []);
    const theirs = body.events.find((e) => e.address.includes("13 Hidden Single St"))!;
    assert.equal(theirs.propertyId, ids.bardonSingle);
    assert.deepEqual([theirs.lat, theirs.lng], [...A2.bardonSingle]);
    assertNoExact(raw, exactOf(B), u.user.email);
  }
});

test("cross-tenant: no pins or coordinates cross brokerages", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  const { body, raw } = await list(otherAdmin);
  assert.deepEqual(body.areaPins, []);
  assertNoExact(raw, [...exactOf(A1), ...exactOf(A2)], "other tenant");
  assert.ok(!raw.includes("Hidden") && !raw.includes("Own Listed"));
});

test("filters apply to pins; private types never produce pins", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  assert.deepEqual(((await list(agent1, "?range=30d&suburbs=bardon")).body.areaPins ?? []).map(pinSig), ["justListed|Bardon"]);
  assert.deepEqual(((await list(agent1, "?range=30d&types=sold")).body.areaPins ?? []).map(pinSig), ["sold|Ashgrove"]);
  assert.deepEqual((await list(agent1, "?range=30d&types=withdrawn,agentEvidence")).body.areaPins, []);
});
