import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import type { ObjectStorageProvider } from "@aee/integration-object-storage";
import { and, eq } from "drizzle-orm";
import { db, appraisals, entitlementGrants } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { setDocumentStorageProviderForTests } from "../../lib/documentStorage.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin, type DevLoginResult } from "./testSupport.js";

/* ---------------------------------------------------------------------
 * AE GROW Pilot Readiness WP1 -- Appraisal Workspace hardening.
 *
 * P1-1: every /grow/appraisals route requires grow.access; every mutation
 *       additionally requires grow.opportunities.manage; /:id/run-handoff
 *       requires grow.access AND run.access.
 * P1-2: an appraisal owner must belong to the appraisal's brokerage, and a
 *       (pre-existing) bad row pointing at a foreign user never exposes that
 *       user's name in the pipeline or the generated presentation.
 *
 * Same conventions as growAppraisals.test.ts: real app, real Postgres, real
 * dev-login cookies. Note: dev-login auto-grants run.access, so a freshly
 * created brokerage with no further grants is exactly a RUN/Starter-only
 * brokerage.
 * -----------------------------------------------------------------*/

class MemoryStorage implements ObjectStorageProvider {
  readonly objects = new Map<string, Buffer>();
  async putObject(key: string, content: string | Buffer) {
    this.objects.set(key, Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content));
    return { key };
  }
  async getObject(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) {
      const error = new Error(`Missing object ${key}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return Buffer.from(bytes);
  }
  async headObject(key: string) {
    const bytes = await this.getObject(key);
    return { key, size: bytes.length, checksumSha256: createHash("sha256").update(bytes).digest("hex") };
  }
  async deleteObject(key: string) {
    this.objects.delete(key);
  }
  async createSignedDownload(key: string, expiresInSeconds = 300) {
    await this.headObject(key);
    return { url: `memory://${encodeURIComponent(key)}`, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
  }
  async verifyIntegrity(key: string) {
    const bytes = await this.getObject(key);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    return { valid: true, expectedChecksum: checksum, actualChecksum: checksum };
  }
  async checkReadiness() {
    return { ready: true };
  }
}

let server: Server;
let baseUrl: string;
const storage = new MemoryStorage();
const suffix = Date.now();

let GROW: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let FOREIGN: DevLoginResult;
const FOREIGN_FIRST = "Zebulon";
const FOREIGN_LAST = `Foreignowner${suffix}`;
const cleanupIds: number[] = [];

before(async () => {
  setDocumentStorageProviderForTests(storage);
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  GROW = await createBrokerageWithUsers(baseUrl, `WP1 Appraisals Grow ${suffix}`);
  cleanupIds.push(GROW.brokerageId);
  await grant(GROW.brokerageId, "grow.access");
  await grant(GROW.brokerageId, "grow.opportunities.manage");

  FOREIGN = await devLogin(baseUrl, {
    email: `wp1-foreign-owner-${suffix}@example.com`,
    firstName: FOREIGN_FIRST,
    lastName: FOREIGN_LAST,
    brokerageName: `WP1 Appraisals Foreign ${suffix}`,
  });
  cleanupIds.push(FOREIGN.user.brokerageId);
});

after(async () => {
  setDocumentStorageProviderForTests(null);
  await cleanupBrokerages(cleanupIds);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function grant(brokerageId: number, entitlementKey: string) {
  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey,
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerageId);
}

async function revokeEntitlement(brokerageId: number, entitlementKey: string) {
  await db
    .update(entitlementGrants)
    .set({ status: "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, entitlementKey)));
  invalidateEntitlementCache(brokerageId);
}

function growUrl(path: string) {
  return `${baseUrl}/api/grow${path}`;
}

function call(method: string, path: string, cookie: string, body?: unknown) {
  return fetch(growUrl(path), {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { property: { id: number } }).property.id;
}

async function createParty(cookie: string, propertyId: number): Promise<number> {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, role: "Seller", firstName: "Hardening", lastName: "Contact" }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { party: { id: number } }).party.id;
}

async function createAppraisal(cookie: string, label: string): Promise<{ appraisalId: number; propertyId: number; partyId: number }> {
  const propertyId = await createProperty(cookie, `${label} ${suffix}`);
  const partyId = await createParty(cookie, propertyId);
  const res = await call("POST", "/appraisals/from-contact", cookie, { partyId, propertyId });
  if (res.status !== 201) throw new Error(`create appraisal failed: ${res.status} ${await res.text()}`);
  return { appraisalId: ((await res.json()) as { appraisal: { id: number } }).appraisal.id, propertyId, partyId };
}

/** Every mutating appraisal route, against a given appraisal id. */
function mutationCalls(appraisalId: number, propertyId: number, partyId: number): Array<[string, string, unknown]> {
  return [
    ["POST", "/appraisals/from-contact", { partyId, propertyId }],
    ["POST", "/appraisals/from-opportunity", { opportunityId: 1 }],
    ["PATCH", `/appraisals/${appraisalId}`, { pricingCommentary: "x" }],
    ["POST", `/appraisals/${appraisalId}/status`, { toStatus: "PREPARING" }],
    ["POST", `/appraisals/${appraisalId}/outcome`, { outcome: "LOST" }],
    ["POST", `/appraisals/${appraisalId}/follow-up`, { followUpAt: new Date().toISOString() }],
    ["POST", `/appraisals/${appraisalId}/send`, {}],
    ["POST", `/appraisals/${appraisalId}/market-position/generate`, {}],
    ["POST", `/appraisals/${appraisalId}/presentation/generate`, {}],
    ["POST", `/appraisals/${appraisalId}/comparable-sales`, { address: "1 Comp St" }],
    ["PATCH", `/appraisals/${appraisalId}/comparable-sales/1`, { notes: "x" }],
    ["DELETE", `/appraisals/${appraisalId}/comparable-sales/1`, undefined],
    ["POST", `/appraisals/${appraisalId}/market-competition`, { address: "1 Comp St" }],
    ["PATCH", `/appraisals/${appraisalId}/market-competition/1`, { notes: "x" }],
    ["DELETE", `/appraisals/${appraisalId}/market-competition/1`, undefined],
  ];
}

test("WP1 P1-1: a RUN/Starter-only brokerage (run.access, no grow.access) gets 403 on every appraisal read and mutation route, including run-handoff", async () => {
  const run = await createBrokerageWithUsers(baseUrl, `WP1 Appraisals RunOnly ${suffix}`);
  cleanupIds.push(run.brokerageId);
  const cookie = run.admin.cookie;
  // A property/party of its own, so the 403 cannot be explained by a missing row.
  const propertyId = await createProperty(cookie, `1 Run Only St ${suffix}`);
  const partyId = await createParty(cookie, propertyId);

  for (const [method, path] of [
    ["GET", "/appraisals/pipeline"],
    ["GET", "/appraisals/1"],
  ] as const) {
    const res = await call(method, path, cookie);
    assert.equal(res.status, 403, `${method} ${path}`);
    const body = (await res.json()) as { entitlementKey: string };
    assert.equal(body.entitlementKey, "grow.access");
  }
  for (const [method, path, body] of mutationCalls(1, propertyId, partyId)) {
    const res = await call(method, path, cookie, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(((await res.json()) as { entitlementKey: string }).entitlementKey, "grow.access", `${method} ${path}`);
  }
  const handoff = await call("POST", "/appraisals/1/run-handoff", cookie, {});
  assert.equal(handoff.status, 403, "run.access alone must not reach the Grow -> Run handoff");
  assert.equal(((await handoff.json()) as { entitlementKey: string }).entitlementKey, "grow.access");
});

test("WP1 P1-1: a Grow brokerage without grow.opportunities.manage can read appraisals but cannot mutate them", async () => {
  const readOnly = await createBrokerageWithUsers(baseUrl, `WP1 Appraisals ReadOnly ${suffix}`);
  cleanupIds.push(readOnly.brokerageId);
  await grant(readOnly.brokerageId, "grow.access");
  await grant(readOnly.brokerageId, "grow.opportunities.manage");
  const cookie = readOnly.admin.cookie;
  const { appraisalId, propertyId, partyId } = await createAppraisal(cookie, "2 Read Only St");
  await revokeEntitlement(readOnly.brokerageId, "grow.opportunities.manage");

  const pipeline = await call("GET", "/appraisals/pipeline", cookie);
  assert.equal(pipeline.status, 200);
  const { appraisals: rows } = (await pipeline.json()) as { appraisals: Array<{ id: number }> };
  assert.ok(rows.some((r) => r.id === appraisalId));
  const workspace = await call("GET", `/appraisals/${appraisalId}`, cookie);
  assert.equal(workspace.status, 200);

  for (const [method, path, body] of mutationCalls(appraisalId, propertyId, partyId)) {
    const res = await call(method, path, cookie, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(((await res.json()) as { entitlementKey: string }).entitlementKey, "grow.opportunities.manage", `${method} ${path}`);
  }

  // The appraisal itself is untouched by every refused mutation.
  const [row] = await db.select().from(appraisals).where(eq(appraisals.id, appraisalId));
  assert.equal(row.status, "DRAFT");
  assert.equal(row.pricingCommentary, null);
});

test("WP1 P1-1: run-handoff requires grow.access AND run.access -- a Grow-only brokerage (run.access revoked) is refused on run.access", async () => {
  const growOnly = await createBrokerageWithUsers(baseUrl, `WP1 Appraisals GrowOnly ${suffix}`);
  cleanupIds.push(growOnly.brokerageId);
  await grant(growOnly.brokerageId, "grow.access");
  await grant(growOnly.brokerageId, "grow.opportunities.manage");
  const { appraisalId } = await createAppraisal(growOnly.admin.cookie, "3 Grow Only St");
  await revokeEntitlement(growOnly.brokerageId, "run.access");

  const res = await call("POST", `/appraisals/${appraisalId}/run-handoff`, growOnly.admin.cookie, {});
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { entitlementKey: string }).entitlementKey, "run.access");
});

test("WP1 P1-2: PATCH /:id rejects an ownerUserId from another brokerage (404) and accepts one from the caller's own brokerage", async () => {
  const { appraisalId } = await createAppraisal(GROW.admin.cookie, "4 Owner Check St");

  const foreign = await call("PATCH", `/appraisals/${appraisalId}`, GROW.admin.cookie, { ownerUserId: FOREIGN.user.id });
  assert.equal(foreign.status, 404);
  const [afterForeign] = await db.select().from(appraisals).where(eq(appraisals.id, appraisalId));
  assert.notEqual(afterForeign.ownerUserId, FOREIGN.user.id, "a foreign owner id must never be written");

  const unknown = await call("PATCH", `/appraisals/${appraisalId}`, GROW.admin.cookie, { ownerUserId: 2147483000 });
  assert.equal(unknown.status, 404);

  const own = await call("PATCH", `/appraisals/${appraisalId}`, GROW.admin.cookie, { ownerUserId: GROW.agent.user.id });
  assert.equal(own.status, 200);
  const { appraisal } = (await own.json()) as { appraisal: { ownerUserId: number } };
  assert.equal(appraisal.ownerUserId, GROW.agent.user.id);

  // Clearing the owner (null) is still allowed.
  const cleared = await call("PATCH", `/appraisals/${appraisalId}`, GROW.admin.cookie, { ownerUserId: null });
  assert.equal(cleared.status, 200);
});

test("WP1 P1-2: a pre-existing bad row whose ownerUserId points at another brokerage's user never exposes that user's name in the pipeline or the generated presentation", async () => {
  const { appraisalId } = await createAppraisal(GROW.admin.cookie, "5 Bad Row St");
  // Simulate legacy/bad data written before this fix existed.
  await db.update(appraisals).set({ ownerUserId: FOREIGN.user.id }).where(eq(appraisals.id, appraisalId));
  try {
    const pipeline = await call("GET", "/appraisals/pipeline", GROW.admin.cookie);
    assert.equal(pipeline.status, 200);
    const text = await pipeline.text();
    assert.ok(!text.includes(FOREIGN_LAST), "pipeline must not contain the foreign owner's name");
    const row = (JSON.parse(text) as { appraisals: Array<{ id: number; ownerName: string | null }> }).appraisals.find(
      (r) => r.id === appraisalId,
    );
    assert.ok(row);
    assert.equal(row.ownerName, null);

    const before = new Set(storage.objects.keys());
    const presentation = await call("POST", `/appraisals/${appraisalId}/presentation/generate`, GROW.admin.cookie, {});
    assert.equal(presentation.status, 200, await presentation.clone().text());
    const newKeys = [...storage.objects.keys()].filter((k) => !before.has(k));
    assert.ok(newKeys.length > 0, "the presentation must have been written to storage");
    const rendered = newKeys.map((k) => storage.objects.get(k)!.toString("utf-8")).join("\n");
    assert.ok(!rendered.includes(FOREIGN_LAST), "presentation must not contain the foreign owner's name");
    assert.ok(!rendered.includes(FOREIGN_FIRST), "presentation must not contain the foreign owner's name");
    assert.ok(rendered.includes("Your agent"), "the owner falls back to the neutral placeholder");
  } finally {
    await db.update(appraisals).set({ ownerUserId: null }).where(eq(appraisals.id, appraisalId));
  }
});
