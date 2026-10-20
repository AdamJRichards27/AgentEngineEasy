// TISO-17 (Owner t101u, 2026-10-20): cross-brokerage tenant-isolation regression suite. TESTS ONLY.
// A victim brokerage V (run.access + grow.access) owns a property that went through the Run listing stages.
// Callers come from OTHER brokerages, one per user type: Grow-only, Run-only, both, none.
// For every property / home / command-centre route, and the other Run routes already gated, a foreign id must answer
// exactly like a non-existent id (same status, same body), so nothing is leaked and existence is not revealed.
// Lists (properties, home summary, command centre, exceptions) must never contain V's data; writes on V's id
// must not change V's row.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, properties } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { cleanupBrokerages, createBrokerageWithUsers, createListedProperty, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const MARK = `TISO${suffix}`;
const MISSING = 2_000_000_000;
type Tenant = { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let V: Tenant;
const callers: Record<string, Tenant> = {};
let vPropertyId: number;
let vSellerPartyId: number;
let vExceptionId: number | undefined;

async function call(method: string, path: string, cookie?: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function grant(brokerageId: number, key: string) {
  await db.insert(entitlementGrants).values({ brokerageId, entitlementKey: key, granteeType: "brokerage", granteeId: brokerageId, sourceType: "manual", status: "Active" });
  invalidateEntitlementCache(brokerageId);
}
async function revoke(brokerageId: number, key: string) {
  await db.update(entitlementGrants).set({ status: "Revoked" }).where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, key)));
  invalidateEntitlementCache(brokerageId);
}
const norm = (t: string) => t.replaceAll(String(vPropertyId), "<ID>").replaceAll(String(MISSING), "<ID>").replaceAll(String(vExceptionId ?? "x"), "<ID>");
async function snapshot(res: Response) {
  return { status: res.status, body: norm(await res.text()) };
}
async function vRow() {
  const [row] = await db.select().from(properties).where(eq(properties.id, vPropertyId));
  return JSON.stringify(row);
}

const ID_READS = (id: number) => [
  `/properties/${id}`,
  `/properties/${id}/timeline`,
  `/properties/${id}/workspace`,
  `/properties/${id}/launch`,
  `/properties/${id}/exceptions`,
  `/properties/${id}/financial/summary`,
  `/properties/${id}/communications/threads`,
  `/properties/${id}/communications/recipients`,
  `/documents/packages/by-property/${id}`,
  `/aml/service-orders/by-property/${id}`,
];
const ID_WRITES = (id: number): Array<[string, unknown]> => [
  [`/properties/${id}/ownership-review`, { notes: "tiso" }],
  [`/properties/${id}/listing-details`, { salesMethod: "Auction", priceDisplay: "TISO" }],
  [`/properties/${id}/ready-to-list`, {}],
  [`/properties/${id}/go-live`, {}],
  [`/properties/${id}/launch`, {}],
  [`/properties/${id}/communications/threads`, { subject: "tiso" }],
];
const LISTS = ["/properties", "/home/summary", "/command-centre", "/exceptions"];

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  V = await createBrokerageWithUsers(baseUrl, `TISO Victim ${suffix}`);
  for (const t of ["grow", "run", "both", "none"]) callers[t] = await createBrokerageWithUsers(baseUrl, `TISO ${t} ${suffix}`);
  const growKeys = ["grow.access", "grow.contacts.read", "grow.contacts.manage", "grow.opportunities.manage"];
  for (const key of growKeys) for (const b of [V, callers.grow, callers.both]) await grant(b.brokerageId, key);
  await revoke(callers.grow.brokerageId, "run.access");
  await revoke(callers.none.brokerageId, "run.access");
  const listed = await createListedProperty(baseUrl, V.agent.cookie, { address: `${MARK} Victim Listed St` });
  vPropertyId = listed.propertyId;
  vSellerPartyId = listed.sellerPartyId;
  const ex = await call("GET", "/exceptions", V.admin.cookie);
  if (ex.ok) {
    const body = (await ex.json()) as { exceptions?: Array<{ id: number }> } | Array<{ id: number }>;
    const rows = Array.isArray(body) ? body : body.exceptions ?? [];
    vExceptionId = rows[0]?.id;
  }
});

after(async () => {
  await cleanupBrokerages([V, ...Object.values(callers)].map((t) => t?.brokerageId).filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("TISO-17: cross-brokerage tenant isolation (Grow-only / Run-only / both / none)", { concurrency: false }, () => {
  test("fixture sanity: victim sees its own property", async () => {
    const res = await call("GET", `/properties/${vPropertyId}`, V.agent.cookie);
    assert.equal(res.status, 200, await res.clone().text());
    assert.ok((await res.text()).includes(MARK));
  });

  for (const type of ["grow", "run", "both", "none"]) {
    for (const role of ["agent", "admin"] as const) {
      test(`${type}/${role}: id substitution on reads answers like a missing id (incl. timeline)`, async () => {
        const cookie = callers[type][role].cookie;
        const foreign = ID_READS(vPropertyId);
        const missing = ID_READS(MISSING);
        for (let i = 0; i < foreign.length; i++) {
          const f = await snapshot(await call("GET", foreign[i], cookie));
          const m = await snapshot(await call("GET", missing[i], cookie));
          assert.notEqual(f.status, 200, `${foreign[i]} returned 200: ${f.body.slice(0, 200)}`);
          assert.ok(!f.body.includes(MARK), `${foreign[i]} leaked victim data`);
          assert.deepEqual(f, m, `${foreign[i]}: existence leak (foreign vs missing differ)`);
        }
        if (vExceptionId !== undefined) {
          const f = await snapshot(await call("GET", `/exceptions/${vExceptionId}`, cookie));
          const m = await snapshot(await call("GET", `/exceptions/${MISSING}`, cookie));
          assert.notEqual(f.status, 200);
          assert.deepEqual(f, m, "/exceptions/:id existence leak");
        }
        const pf = await snapshot(await call("GET", `/parties/${vSellerPartyId}`, cookie));
        const pm = await snapshot(await call("GET", `/parties/${MISSING}`, cookie));
        assert.notEqual(pf.status, 200, "/parties/:id returned victim party");
        assert.ok(!pf.body.includes(MARK));
        assert.equal(pf.status, pm.status, "/parties/:id existence leak (status)");
      });

      test(`${type}/${role}: lists never include victim data`, async () => {
        const cookie = callers[type][role].cookie;
        for (const path of LISTS) {
          const res = await call("GET", path, cookie);
          const text = await res.text();
          assert.ok(!text.includes(MARK), `${path} leaked victim address`);
          if (res.status === 200) assert.ok(!new RegExp(`"(propertyId|id)":${vPropertyId}[,}]`).test(text), `${path} leaked victim property id`);
        }
      });

      test(`${type}/${role}: write attempts on a foreign id are refused like a missing id and change nothing`, async () => {
        const cookie = callers[type][role].cookie;
        const beforeRow = await vRow();
        const foreign = ID_WRITES(vPropertyId);
        const missing = ID_WRITES(MISSING);
        for (let i = 0; i < foreign.length; i++) {
          const f = await snapshot(await call("POST", foreign[i][0], cookie, foreign[i][1]));
          const m = await snapshot(await call("POST", missing[i][0], cookie, missing[i][1]));
          assert.ok(f.status >= 400, `${foreign[i][0]} accepted (${f.status})`);
          assert.deepEqual(f, m, `${foreign[i][0]}: existence leak on write`);
        }
        const created = await call("POST", "/parties", cookie, { propertyId: vPropertyId, role: "Seller", firstName: "Tiso", lastName: "Probe", email: `tiso-${suffix}@example.com` });
        const createdText = await created.text();
        if (created.status < 300) {
          const body = JSON.parse(createdText) as { party?: { propertyId?: number | null } };
          assert.notEqual(body.party?.propertyId, vPropertyId, "POST /parties attached a party to a foreign property");
        }
        assert.equal(await vRow(), beforeRow, "victim property row changed");
      });
    }
  }

  test("victim cannot see caller properties either (reverse direction, both-entitled caller)", async () => {
    const res = await call("POST", "/properties", callers.both.agent.cookie, { formattedAddress: `${MARK}B Caller St`, state: "NSW", suburb: "Testville", postcode: "2000" });
    assert.equal(res.status, 201, await res.clone().text());
    const id = ((await res.json()) as { property: { id: number } }).property.id;
    const f = await call("GET", `/properties/${id}`, V.agent.cookie);
    const m = await call("GET", `/properties/${MISSING}`, V.agent.cookie);
    assert.equal(f.status, m.status);
    const list = await (await call("GET", "/properties", V.agent.cookie)).text();
    assert.ok(!list.includes(`${MARK}B`));
  });
});
