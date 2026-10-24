// M3 revocable offer links (Owner t165u, migration 0037 offer_share_links;
// approved for development and review, executed only on local scratch).
// Existing links keep working until revoked; revoke and reissue are audited;
// revoked, expired and unknown tokens get the same public 404; managing a
// link follows the offer-price rule (listing agent or Brokerage
// Administrator; other agents and Pit Crew 403); tenant 404 + R-F8 metric.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, entitlementGrants, offerShareLinks, offers, users } from "@aee/db";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let otherAgent: DevLoginResult;
let pitCrew: DevLoginResult;
let propertyId: number;
let seq = 0;

type Res = { status: number; body: Record<string, unknown>; text: string };
async function call(method: "GET" | "POST", path: string, cookie?: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${baseUrl}/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed, text };
}

async function newOffer(): Promise<{ id: number; token: string }> {
  seq += 1;
  const r = await call("POST", `/offers/by-property/${propertyId}`, A.agent.cookie, {
    offerPriceCents: 65_000_000 + seq,
    conditions: {},
    buyer: { firstName: "Link", lastName: `Buyer${seq}`, email: `m3-${seq}-${suffix}@example.com` },
  });
  assert.equal(r.status, 201, r.text);
  const offer = r.body.offer as { id: number; shareToken: string };
  return { id: offer.id, token: offer.shareToken };
}

const publicStatus = async (token: string) => (await call("GET", `/offers/public/${token}`)).status;

function isolationSeries(): string[] {
  return renderMetricsText().split("\n").filter((l) => l.startsWith("tenant_isolation_rejection_total{"));
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `M3 Links A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `M3 Links B ${suffix}`);
  otherAgent = await devLogin(baseUrl, { email: `m3-other-agent-${suffix}@example.com`, firstName: "Other", lastName: "Agent", brokerageName: `M3 Links A ${suffix}` });
  pitCrew = await devLogin(baseUrl, { email: `m3-pitcrew-${suffix}@example.com`, firstName: "Pat", lastName: "Crew", brokerageName: `M3 Links A ${suffix}` });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));
  // The agent who creates the property is its listing agent (properties.agent_id).
  propertyId = (await createListedProperty(baseUrl, A.agent.cookie, { address: `3 Link St ${suffix}, Testville`, sellerEmail: `m3-seller-${suffix}@example.com` })).propertyId;
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("a new offer's link works publicly and is recorded as its first, non-expiring link", async () => {
  const { id, token } = await newOffer();
  assert.equal(await publicStatus(token), 200);
  const rows = await db.select().from(offerShareLinks).where(eq(offerShareLinks.offerId, id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token, token);
  assert.equal(rows[0].expiresAt, null);
  assert.equal(rows[0].revokedAt, null);
  const status = await call("GET", `/offers/${id}/share-link`, A.agent.cookie);
  assert.equal(status.status, 200);
  assert.equal((status.body.shareLink as { active: boolean }).active, true);
  assert.ok(!status.text.includes(token), "status never returns the token");
});

test("revoke: the link stops working with the same 404 as an unknown token; idempotent; audited without the token", async () => {
  const { id, token } = await newOffer();
  const unknown = await call("GET", `/offers/public/${"f".repeat(32)}`);
  const r = await call("POST", `/offers/${id}/share-link/revoke`, A.agent.cookie);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.revoked, 1);
  const after = await call("GET", `/offers/public/${token}`);
  assert.equal(after.status, 404);
  assert.deepEqual(after.body, unknown.body, "revoked and unknown tokens are indistinguishable");
  assert.equal((await call("POST", `/offers/${id}/share-link/revoke`, A.admin.cookie)).body.revoked, 0);
  const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "offer_share_link_revoked"), eq(auditLogs.recordId, String(id))));
  assert.equal(audits.length, 2);
  assert.ok(audits.every((a) => !JSON.stringify(a).includes(token)), "token never written to the audit log");
  const [offer] = await db.select().from(offers).where(eq(offers.id, id));
  assert.equal(offer.shareToken, token, "offers.share_token itself is not rewritten");
});

test("reissue: new token returned once and works; previous links revoked (rows kept, reason reissued); audited without the token", async () => {
  const { id, token } = await newOffer();
  const r1 = await call("POST", `/offers/${id}/share-link/reissue`, A.admin.cookie, {});
  assert.equal(r1.status, 201, r1.text);
  const t1 = r1.body.shareToken as string;
  assert.match(t1, /^[0-9a-f]{32}$/);
  assert.notEqual(t1, token);
  assert.equal(r1.body.expiresAt, null);
  assert.equal(r1.body.revokedPrevious, 1);
  assert.equal(await publicStatus(token), 404);
  assert.equal(await publicStatus(t1), 200);

  const r2 = await call("POST", `/offers/${id}/share-link/reissue`, A.agent.cookie, { expiresInDays: 7 });
  assert.equal(r2.status, 201);
  const t2 = r2.body.shareToken as string;
  const expires = new Date(r2.body.expiresAt as string).getTime();
  assert.ok(Math.abs(expires - (Date.now() + 7 * 86_400_000)) < 60_000, "expires in 7 days");
  assert.equal(await publicStatus(t1), 404);
  assert.equal(await publicStatus(t2), 200);

  const rows = await db.select().from(offerShareLinks).where(eq(offerShareLinks.offerId, id));
  assert.equal(rows.length, 3, "no row is ever overwritten or deleted");
  assert.deepEqual(rows.filter((r) => r.revokedAt).map((r) => r.revokeReason).sort(), ["reissued", "reissued"]);
  const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "offer_share_link_reissued"), eq(auditLogs.recordId, String(id))));
  assert.equal(audits.length, 2);
  assert.ok(audits.every((a) => !JSON.stringify(a).includes(t1) && !JSON.stringify(a).includes(t2)));
  const status = await call("GET", `/offers/${id}/share-link`, A.agent.cookie);
  assert.equal((status.body.shareLink as { linksIssued: number }).linksIssued, 3);
});

test("expiry: an expired link gets the same 404", async () => {
  const { id } = await newOffer();
  const r = await call("POST", `/offers/${id}/share-link/reissue`, A.agent.cookie, { expiresInDays: 1 });
  const t = r.body.shareToken as string;
  assert.equal(await publicStatus(t), 200);
  await db.update(offerShareLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(offerShareLinks.token, t));
  assert.equal(await publicStatus(t), 404);
  assert.equal(((await call("GET", `/offers/${id}/share-link`, A.agent.cookie)).body.shareLink as { active: boolean }).active, false);
});

test("legacy fallback: a token only in offers.share_token works while the offer has no link rows, and never after a link exists", async () => {
  const { id, token } = await newOffer();
  await db.delete(offerShareLinks).where(eq(offerShareLinks.offerId, id)); // as if written by pre-M3 code
  assert.equal(await publicStatus(token), 200, "existing links keep working");
  const r = await call("POST", `/offers/${id}/share-link/revoke`, A.agent.cookie);
  assert.equal(r.body.revoked, 0);
  // Revoking with no rows does not block the legacy link; reissue does.
  await call("POST", `/offers/${id}/share-link/reissue`, A.agent.cookie, {});
  assert.equal(await publicStatus(token), 404, "once the offer has a link row the legacy token is dead");
});

test("validation: expiresInDays must be 1..90 and no other fields", async () => {
  const { id } = await newOffer();
  for (const body of [{ expiresInDays: 0 }, { expiresInDays: 91 }, { expiresInDays: 1.5 }, { expiresInDays: "7" }, { token: "x" }]) {
    assert.equal((await call("POST", `/offers/${id}/share-link/reissue`, A.agent.cookie, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call("POST", `/offers/abc/share-link/revoke`, A.agent.cookie)).status, 400);
});

test("access: listing agent and brokerage admin allowed; other agent and Pit Crew 403; nothing changes", async () => {
  const { id, token } = await newOffer();
  for (const [label, cookie] of [["another agent", otherAgent.cookie], ["Pit Crew", pitCrew.cookie]] as Array<[string, string]>) {
    for (const [method, path] of [["GET", `/offers/${id}/share-link`], ["POST", `/offers/${id}/share-link/revoke`], ["POST", `/offers/${id}/share-link/reissue`]] as Array<["GET" | "POST", string]>) {
      const r = await call(method, path, cookie, method === "POST" ? {} : undefined);
      assert.equal(r.status, 403, `${label} ${method} ${path}: ${r.text}`);
      assert.ok(!r.text.includes(token));
    }
  }
  assert.equal(await publicStatus(token), 200, "denied calls changed nothing");
  assert.equal((await call("GET", `/offers/${id}/share-link`, A.agent.cookie)).status, 200);
  assert.equal((await call("GET", `/offers/${id}/share-link`, A.admin.cookie)).status, 200);
});

test("tenant: another brokerage gets 404 and R-F8 counts once; unauthenticated 401; run.access revoked 403", async () => {
  const { id, token } = await newOffer();
  resetMetricsForTesting();
  for (const path of [`/offers/${id}/share-link/revoke`]) {
    const r = await call("POST", path, B.admin.cookie);
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: "Not found" });
  }
  assert.deepEqual(isolationSeries(), ['tenant_isolation_rejection_total{boundary="transaction"} 1']);
  assert.equal((await call("POST", `/offers/${id}/share-link/reissue`, undefined, {})).status, 401);
  await db.update(entitlementGrants).set({ status: "Revoked" }).where(and(eq(entitlementGrants.brokerageId, A.brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(A.brokerageId);
  try {
    const r = await call("POST", `/offers/${id}/share-link/revoke`, A.admin.cookie);
    assert.equal(r.status, 403);
    assert.equal(r.body.entitlementKey, "run.access");
  } finally {
    await db.update(entitlementGrants).set({ status: "Active" }).where(and(eq(entitlementGrants.brokerageId, A.brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
    invalidateEntitlementCache(A.brokerageId);
  }
  assert.equal(await publicStatus(token), 200);
});

test("authenticated offer reads still never include a share token (BE-Q1 unchanged)", async () => {
  const { id, token } = await newOffer();
  await call("POST", `/offers/${id}/share-link/reissue`, A.agent.cookie, {});
  for (const path of [`/offers/${id}`, `/offers/by-property/${propertyId}`, `/offers/${id}/share-link`]) {
    const r = await call("GET", path, A.admin.cookie);
    assert.equal(r.status, 200);
    assert.ok(!/shareToken|"token"/.test(r.text), `${path} leaks a token`);
    assert.ok(!r.text.includes(token));
  }
});
