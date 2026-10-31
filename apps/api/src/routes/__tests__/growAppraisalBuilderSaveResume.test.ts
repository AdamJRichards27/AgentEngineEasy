import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import type { ObjectStorageProvider } from "@aee/integration-object-storage";
import { db, entitlementGrants } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { setDocumentStorageProviderForTests } from "../../lib/documentStorage.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

/* ---------------------------------------------------------------------
 * AB-6 (CC #25/#26): AE Minimal Appraisal Builder save-and-resume, end to
 * end against the real API. Each of the seven steps saves on its own
 * existing route; after every save the server workspace is reloaded and
 * fed to the web builder model, which must resume at the furthest
 * completed step. Tenant permissions: another brokerage gets 404 on the
 * read and on every step's write; a grow.access-only user can read but
 * every step's write is 403. No migration; existing routes only.
 * -----------------------------------------------------------------*/

class MemoryStorage implements ObjectStorageProvider {
  readonly objects = new Map<string, Buffer>();
  async putObject(key: string, content: string | Buffer) {
    this.objects.set(key, Buffer.from(content));
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

type Model = {
  resumeBuilderState(w: unknown): { step: number; highestStep: number };
  builderStepsSaved(w: unknown): Record<number, boolean>;
};
// The web builder model is pure TypeScript (no React); loaded by path so the
// API project's type check does not pull in the web project.
const MODEL_PATH = "../../../../web/src/minimal/appraisal/appraisalBuilderModel.ts";

let server: Server;
let baseUrl: string;
let model: Model;
const suffix = Date.now();
type B = { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let A: B;
let FOREIGN: B;
let VIEW: B;
const cleanupIds: number[] = [];

async function grant(brokerageId: number, key: string) {
  await db.insert(entitlementGrants).values({ brokerageId, entitlementKey: key, granteeType: "brokerage", granteeId: brokerageId, sourceType: "manual", status: "Active" });
  invalidateEntitlementCache(brokerageId);
}

before(async () => {
  setDocumentStorageProviderForTests(new MemoryStorage());
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  model = (await import(MODEL_PATH)) as Model;
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `AB6 A ${suffix}`);
  FOREIGN = await createBrokerageWithUsers(baseUrl, `AB6 Foreign ${suffix}`);
  VIEW = await createBrokerageWithUsers(baseUrl, `AB6 View ${suffix}`);
  cleanupIds.push(A.brokerageId, FOREIGN.brokerageId, VIEW.brokerageId);
  for (const x of [A, FOREIGN]) {
    await grant(x.brokerageId, "grow.access");
    await grant(x.brokerageId, "grow.opportunities.manage");
  }
  await grant(VIEW.brokerageId, "grow.access");
});

after(async () => {
  setDocumentStorageProviderForTests(null);
  await cleanupBrokerages(cleanupIds);
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});

function call(method: string, path: string, cookie: string, body?: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json<T>(res: Response, expect: number): Promise<T> {
  const text = await res.text();
  assert.equal(res.status, expect, text);
  return JSON.parse(text) as T;
}

async function newAppraisal(cookie: string, label: string): Promise<{ appraisalId: number; propertyId: number }> {
  const p = await json<{ property: { id: number } }>(
    await call("POST", "/properties", cookie, { formattedAddress: `${label} ${suffix}`, state: "QLD", suburb: "Testville", postcode: "4000" }),
    201,
  );
  const party = await json<{ party: { id: number } }>(
    await call("POST", "/parties", cookie, { propertyId: p.property.id, role: "Seller", firstName: "AB6", lastName: "Seller" }),
    201,
  );
  const created = await json<{ appraisal: { id: number } }>(
    await call("POST", "/grow/appraisals/from-contact", cookie, { partyId: party.party.id, propertyId: p.property.id, entry: "property" }),
    201,
  );
  return { appraisalId: created.appraisal.id, propertyId: p.property.id };
}

const RATIONALE = "Three recent sales on the same street support this range.";

/** Each step's own save, through the route the builder uses. */
function stepWrites(id: number): Array<{ step: number; method: string; path: string; body: unknown }> {
  return [
    { step: 3, method: "POST", path: `/grow/appraisals/${id}/comparable-sales`, body: { address: "5 Sold St", salePrice: "820000", saleDate: "2026-09-01", source: "manual", notes: "" } },
    { step: 4, method: "POST", path: `/grow/appraisals/${id}/market-competition`, body: { address: "9 Listed St", askingPriceDisplay: "$850,000" } },
    { step: 5, method: "PATCH", path: `/grow/appraisals/${id}`, body: { priceRangeLow: "800000", priceRangeHigh: "860000", pricingCommentary: RATIONALE } },
    { step: 6, method: "POST", path: `/grow/appraisals/${id}/presentation/generate`, body: {} },
    { step: 7, method: "POST", path: `/grow/appraisals/${id}/follow-up`, body: { followUpAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), followUpNotes: null } },
  ];
}

test("save-and-resume across all seven steps: each save persists alone and resume lands at the furthest completed step", async () => {
  const { appraisalId } = await newAppraisal(A.agent.cookie, "1 Resume St");
  const expected: Record<number, { resume: number; saved: number[] }> = {
    0: { resume: 2, saved: [1] },
    3: { resume: 4, saved: [1, 2, 3] },
    4: { resume: 5, saved: [1, 2, 3, 4] },
    5: { resume: 6, saved: [1, 2, 3, 4, 5] },
    6: { resume: 7, saved: [1, 2, 3, 4, 5, 6] },
    7: { resume: 7, saved: [1, 2, 3, 4, 5, 6, 7] },
  };
  const check = async (after: number) => {
    const w = await json<unknown>(await call("GET", `/grow/appraisals/${appraisalId}`, A.agent.cookie), 200);
    const saved = model.builderStepsSaved(w);
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].filter((n) => saved[n]), expected[after].saved, `after step ${after}`);
    assert.equal(model.resumeBuilderState(w).step, expected[after].resume, `resume after step ${after}`);
  };
  await check(0);
  for (const w of stepWrites(appraisalId)) {
    const res = await call(w.method, w.path, A.agent.cookie, w.body);
    assert.ok(res.status === 200 || res.status === 201, `step ${w.step}: ${res.status} ${await res.text()}`);
    await check(w.step);
  }
});

test("steps save independently: a later step saved alone does not mark earlier gaps saved, and resume stops at the gap", async () => {
  const { appraisalId } = await newAppraisal(A.agent.cookie, "2 Gap St");
  const range = stepWrites(appraisalId).find((w) => w.step === 5)!;
  await json(await call(range.method, range.path, A.agent.cookie, range.body), 200);
  const w = await json<unknown>(await call("GET", `/grow/appraisals/${appraisalId}`, A.agent.cookie), 200);
  const saved = model.builderStepsSaved(w);
  assert.equal(saved[3], false);
  assert.equal(saved[5], true);
  assert.equal(model.resumeBuilderState(w).step, 3);
});

test("tenant permissions: another brokerage gets 404 on read and every step write; nothing changes", async () => {
  const { appraisalId } = await newAppraisal(A.agent.cookie, "3 Isolated St");
  const before = await json<unknown>(await call("GET", `/grow/appraisals/${appraisalId}`, A.agent.cookie), 200);
  assert.equal((await call("GET", `/grow/appraisals/${appraisalId}`, FOREIGN.agent.cookie)).status, 404);
  for (const w of stepWrites(appraisalId)) {
    const res = await call(w.method, w.path, FOREIGN.agent.cookie, w.body);
    assert.equal(res.status, 404, `foreign step ${w.step}: ${res.status}`);
  }
  const afterW = await json<unknown>(await call("GET", `/grow/appraisals/${appraisalId}`, A.agent.cookie), 200);
  assert.deepEqual(model.builderStepsSaved(afterW), model.builderStepsSaved(before));
});

test("tenant permissions: grow.access without manage can resume (read) but every step write is 403", async () => {
  // Seed with a short-lived manage grant, then revoke it so the user is grow.access-only.
  await grant(VIEW.brokerageId, "grow.opportunities.manage");
  const { appraisalId } = await newAppraisal(VIEW.agent.cookie, "4 Viewer St");
  const { eq, and } = await import("drizzle-orm");
  await db
    .update(entitlementGrants)
    .set({ status: "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, VIEW.brokerageId), eq(entitlementGrants.entitlementKey, "grow.opportunities.manage")));
  invalidateEntitlementCache(VIEW.brokerageId);
  const w = await json<unknown>(await call("GET", `/grow/appraisals/${appraisalId}`, VIEW.agent.cookie), 200);
  assert.equal(model.resumeBuilderState(w).step, 2);
  for (const s of stepWrites(appraisalId)) {
    const res = await call(s.method, s.path, VIEW.agent.cookie, s.body);
    assert.equal(res.status, 403, `viewer step ${s.step}: ${res.status}`);
  }
});
