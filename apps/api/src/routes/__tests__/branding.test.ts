import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { and, eq, inArray, like } from "drizzle-orm";
import type { ObjectStorageProvider } from "@aee/integration-object-storage";
import { appraisals, db, documentObjectVersions, documents, entitlementGrants } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { setDocumentStorageProviderForTests } from "../../lib/documentStorage.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

// CC #52 branding S1 — /api/branding end to end: type/size rejection, EXIF
// stripping on stored bytes, cross-tenant denial, unauthenticated denial,
// per-appraisal override, and existing appraisal drafts left untouched.

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

let server: Server;
let baseUrl: string;
const suffix = Date.now();
type B = { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let A: B;
let FOREIGN: B;
const cleanupIds: number[] = [];
let draftId: number;
let draftBefore: Record<string, unknown>;

async function grant(brokerageId: number, key: string) {
  await db.insert(entitlementGrants).values({ brokerageId, entitlementKey: key, granteeType: "brokerage", granteeId: brokerageId, sourceType: "manual", status: "Active" });
  invalidateEntitlementCache(brokerageId);
}

function call(method: string, path: string, cookie: string | null, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return fetch(`${baseUrl}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function uploadImage(path: string, cookie: string | null, bytes: Buffer, type: string, filename: string, crop?: unknown) {
  const form = new FormData();
  if (crop !== undefined) form.append("crop", JSON.stringify(crop));
  form.append("file", new Blob([bytes], { type }), filename);
  return fetch(`${baseUrl}/api${path}`, { method: "POST", headers: cookie ? { cookie } : {}, body: form });
}

async function json<T>(res: Response, expect: number): Promise<T> {
  const text = await res.text();
  assert.equal(res.status, expect, text);
  return JSON.parse(text) as T;
}

async function newAppraisal(cookie: string, label: string): Promise<number> {
  const p = await json<{ property: { id: number } }>(
    await call("POST", "/properties", cookie, { formattedAddress: `${label} ${suffix}`, state: "QLD", suburb: "Testville", postcode: "4000" }),
    201,
  );
  const party = await json<{ party: { id: number } }>(
    await call("POST", "/parties", cookie, { propertyId: p.property.id, role: "Seller", firstName: "Brand", lastName: "Seller" }),
    201,
  );
  const created = await json<{ appraisal: { id: number } }>(
    await call("POST", "/grow/appraisals/from-contact", cookie, { partyId: party.party.id, propertyId: p.property.id, entry: "property" }),
    201,
  );
  return created.appraisal.id;
}

async function appraisalRow(id: number) {
  const [row] = await db.select().from(appraisals).where(eq(appraisals.id, id));
  return row as unknown as Record<string, unknown>;
}

before(async () => {
  setDocumentStorageProviderForTests(new MemoryStorage());
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `Branding A ${suffix}`);
  FOREIGN = await createBrokerageWithUsers(baseUrl, `Branding Foreign ${suffix}`);
  cleanupIds.push(A.brokerageId, FOREIGN.brokerageId);
  for (const x of [A, FOREIGN]) {
    await grant(x.brokerageId, "grow.access");
    await grant(x.brokerageId, "grow.opportunities.manage");
  }
  draftId = await newAppraisal(A.agent.cookie, "1 Branding St");
  // A real saved draft: range + narrative, exactly as the builder writes them.
  await json(await call("PATCH", `/grow/appraisals/${draftId}`, A.agent.cookie, {
    priceRangeLow: "800000", priceRangeHigh: "860000", pricingCommentary: "Three recent sales on the same street support this range.",
  }), 200);
  draftBefore = await appraisalRow(draftId);
});

after(async () => {
  const docs = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(inArray(documents.brokerageId, cleanupIds), like(documents.logicalOwnerType, "branding_%")));
  const ids = docs.map((d) => d.id);
  if (ids.length) {
    await db.delete(documentObjectVersions).where(inArray(documentObjectVersions.documentId, ids));
    await db.delete(documents).where(inArray(documents.id, ids));
  }
  setDocumentStorageProviderForTests(null);
  await cleanupBrokerages(cleanupIds);
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});

const PROFILE = {
  fullName: "Agent User",
  title: "Sales Agent",
  agencyName: "Branding A",
  mobilePhone: "+61 400 000 000",
  officePhone: null,
  email: "agent@example.com",
  website: "https://example.com",
  address: null,
  licence: null,
  bio: null,
};

test("unauthenticated requests are refused on every branding route", async () => {
  for (const [method, path] of [
    ["GET", "/branding/me"], ["PUT", "/branding/me"], ["GET", "/branding/me/logo"], ["GET", "/branding/me/photo"],
    ["GET", `/branding/appraisals/${draftId}`], ["PUT", `/branding/appraisals/${draftId}`], ["DELETE", `/branding/appraisals/${draftId}`],
    ["GET", `/branding/appraisals/${draftId}/logo`],
  ] as const) {
    const res = await call(method, path, null, method === "GET" || method === "DELETE" ? undefined : { fullName: "x" });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  const png = await sharp({ create: { width: 300, height: 100, channels: 3, background: "#fff" } }).png().toBuffer();
  assert.equal((await uploadImage("/branding/me/logo", null, png, "image/png", "logo.png")).status, 401);
});

test("agent saves own profile; nothing is invented; other users don't see it", async () => {
  const empty = await json<{ profile: unknown; logo: unknown; suggestions: { fullName: string | null } }>(await call("GET", "/branding/me", A.agent.cookie), 200);
  assert.equal(empty.profile, null);
  assert.equal(empty.logo, null);
  assert.equal(empty.suggestions.fullName, "Agent User");
  assert.equal((await call("PUT", "/branding/me", A.agent.cookie, { ...PROFILE, website: "javascript:alert(1)" })).status, 400);
  assert.equal((await call("PUT", "/branding/me", A.agent.cookie, { ...PROFILE, userId: A.admin.user.id })).status, 400);
  const saved = await json<{ profile: typeof PROFILE }>(await call("PUT", "/branding/me", A.agent.cookie, PROFILE), 200);
  assert.equal(saved.profile.licence, null);
  const again = await json<{ profile: typeof PROFILE }>(await call("GET", "/branding/me", A.agent.cookie), 200);
  assert.deepEqual(again.profile, PROFILE);
  // Same-brokerage admin: their own (empty) profile, not the agent's (v1: admins can't edit agent profiles).
  const admin = await json<{ profile: unknown }>(await call("GET", "/branding/me", A.admin.cookie), 200);
  assert.equal(admin.profile, null);
  const foreign = await json<{ profile: unknown }>(await call("GET", "/branding/me", FOREIGN.agent.cookie), 200);
  assert.equal(foreign.profile, null);
});

test("type and size rejection on upload", async () => {
  const gif = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#fff" } }).gif().toBuffer();
  const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#fff" } }).png().toBuffer();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
  assert.equal((await uploadImage("/branding/me/logo", A.agent.cookie, gif, "image/gif", "logo.gif")).status, 415);
  assert.equal((await uploadImage("/branding/me/logo", A.agent.cookie, svg, "image/svg+xml", "logo.svg")).status, 415);
  assert.equal((await uploadImage("/branding/me/photo", A.agent.cookie, png, "image/jpeg", "photo.jpg")).status, 415, "spoofed MIME");
  const big = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]);
  const tooBig = await uploadImage("/branding/me/logo", A.agent.cookie, big, "image/png", "logo.png");
  assert.equal(tooBig.status, 413);
  assert.equal(((await tooBig.json()) as { code: string }).code, "IMAGE_TOO_LARGE");
  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), "a.png");
  form.append("file2", new Blob([png], { type: "image/png" }), "b.png");
  assert.equal((await fetch(`${baseUrl}/api/branding/me/logo`, { method: "POST", headers: { cookie: A.agent.cookie }, body: form })).status, 413);
  const me = await json<{ logo: unknown; photo: unknown }>(await call("GET", "/branding/me", A.agent.cookie), 200);
  assert.equal(me.logo, null, "nothing stored after rejections");
  assert.equal(me.photo, null);
});

test("photo upload strips EXIF/GPS from the stored bytes; served only via the authenticated route", async () => {
  const input = await sharp({ create: { width: 900, height: 700, channels: 3, background: "#225588" } })
    .withExif({ IFD0: { Make: "LeakyCam", Copyright: "Private Person" }, IFD3: { GPSLatitudeRef: "S", GPSLatitude: "27/1 28/1 0/1" } })
    .jpeg()
    .toBuffer();
  const up = await json<{ photo: { version: number; width: number; height: number } }>(
    await uploadImage("/branding/me/photo", A.agent.cookie, input, "image/jpeg", "me.jpg", { x: 100, y: 0, width: 700, height: 700 }),
    201,
  );
  assert.deepEqual([up.photo.width, up.photo.height], [600, 600]);
  const res = await fetch(`${baseUrl}/api/branding/me/photo`, { headers: { cookie: A.agent.cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("cache-control") ?? "", /private/);
  const stored = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(stored).metadata();
  assert.equal(meta.exif, undefined);
  for (const s of ["LeakyCam", "Private Person", "GPS"]) assert.equal(stored.includes(Buffer.from(s)), false, s);
  // The stored version row is the re-encoded file, under the branding source, never property-backed.
  const [doc] = await db.select().from(documents).where(and(eq(documents.brokerageId, A.brokerageId), eq(documents.logicalOwnerType, "branding_agent_photo"), eq(documents.logicalOwnerId, A.agent.user.id)));
  assert.equal(doc.propertyId, null);
  const [v] = await db.select().from(documentObjectVersions).where(eq(documentObjectVersions.documentId, doc.id));
  assert.equal(v.source, "branding");
  assert.equal(v.detectedMimeType, "image/jpeg");
  assert.equal(v.contentSha256, createHash("sha256").update(stored).digest("hex"));
  // The generic document routes can't reach a logical branding document.
  assert.equal((await call("GET", `/documents/${doc.id}/download`, A.agent.cookie)).status >= 400, true);
  // No URL to the image appears in the JSON (no public or signed links).
  const me = await (await call("GET", "/branding/me", A.agent.cookie)).text();
  assert.doesNotMatch(me.replace("https://example.com", ""), /https?:\/\/|local-object:|memory:|objectStorageKey|storageObjectKey/);
});

test("WebP logo upload accepted and stored as PNG", async () => {
  const webp = await sharp({ create: { width: 1600, height: 400, channels: 4, background: "#E8590C" } }).webp().toBuffer();
  const up = await json<{ logo: { width: number; height: number } }>(await uploadImage("/branding/me/logo", A.agent.cookie, webp, "image/webp", "logo.webp"), 201);
  assert.deepEqual([up.logo.width, up.logo.height], [1200, 300]);
  const res = await fetch(`${baseUrl}/api/branding/me/logo`, { headers: { cookie: A.agent.cookie } });
  assert.equal(res.headers.get("content-type"), "image/png");
});

test("per-appraisal override: effective branding, closed/finalised refusal path, drafts untouched", async () => {
  const before = await json<{ effective: Record<string, string | null>; sources: Record<string, string>; logo: unknown }>(
    await call("GET", `/branding/appraisals/${draftId}`, A.agent.cookie), 200);
  assert.equal(before.effective.fullName, "Agent User");
  assert.equal(before.sources.fullName, "agent");
  assert.ok(before.logo, "the owner's logo is referenced");
  assert.equal((await call("PUT", `/branding/appraisals/${draftId}`, A.agent.cookie, { override: { title: "<b>" } })).status, 400);
  await json(await call("PUT", `/branding/appraisals/${draftId}`, A.agent.cookie, { override: { title: "Principal" } }), 200);
  const after = await json<{ effective: Record<string, string | null>; sources: Record<string, string> }>(
    await call("GET", `/branding/appraisals/${draftId}`, A.agent.cookie), 200);
  assert.equal(after.effective.title, "Principal");
  assert.equal(after.sources.title, "appraisal");
  // The agent's default is unchanged by "apply to this appraisal only".
  const me = await json<{ profile: typeof PROFILE }>(await call("GET", "/branding/me", A.agent.cookie), 200);
  assert.equal(me.profile.title, "Sales Agent");
  const img = await fetch(`${baseUrl}/api/branding/appraisals/${draftId}/logo`, { headers: { cookie: A.admin.cookie } });
  assert.equal(img.status, 200, "same-brokerage reader sees the appraisal's branding image");
  // Existing draft row byte-for-byte unchanged by every branding write above.
  assert.deepEqual(await appraisalRow(draftId), draftBefore);
  await json(await call("DELETE", `/branding/appraisals/${draftId}`, A.agent.cookie), 200);
  assert.deepEqual(await appraisalRow(draftId), draftBefore);
});

test("finalised appraisals show only the issue snapshot and refuse overrides", async () => {
  const id = await newAppraisal(A.agent.cookie, "2 Finalised St");
  await db.update(appraisals).set({ isFinalised: true, finalisedSnapshot: { finalisedAt: new Date().toISOString() } }).where(eq(appraisals.id, id));
  const res = await json<{ finalised: boolean; snapshot: unknown; effective?: unknown }>(await call("GET", `/branding/appraisals/${id}`, A.agent.cookie), 200);
  assert.equal(res.finalised, true);
  assert.equal(res.snapshot, null);
  assert.equal(res.effective, undefined);
  assert.equal((await call("PUT", `/branding/appraisals/${id}`, A.agent.cookie, { override: { title: "X" } })).status, 409);
  assert.equal((await fetch(`${baseUrl}/api/branding/appraisals/${id}/logo`, { headers: { cookie: A.agent.cookie } })).status, 404);
});

test("cross-tenant: another brokerage gets 404 on read, write and images", async () => {
  assert.equal((await call("GET", `/branding/appraisals/${draftId}`, FOREIGN.admin.cookie)).status, 404);
  assert.equal((await call("PUT", `/branding/appraisals/${draftId}`, FOREIGN.admin.cookie, { override: { title: "Hijack" } })).status, 404);
  assert.equal((await call("DELETE", `/branding/appraisals/${draftId}`, FOREIGN.admin.cookie)).status, 404);
  for (const kind of ["logo", "photo"]) {
    assert.equal((await fetch(`${baseUrl}/api/branding/appraisals/${draftId}/${kind}`, { headers: { cookie: FOREIGN.agent.cookie } })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/branding/me/${kind}`, { headers: { cookie: FOREIGN.agent.cookie } })).status, 404);
  }
  assert.equal((await call("GET", "/branding/appraisals/abc", A.agent.cookie)).status, 400);
  assert.deepEqual(await appraisalRow(draftId), draftBefore);
});
