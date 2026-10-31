// CC #34 / decisions pack BE-Q1 (Owner direction t113u D8: revocable,
// audited buyer links, no silent replacement). Pilot step that needs no
// migration: authenticated offer reads and offer-mutation responses stop
// returning `shareToken` (the unauthenticated buyer status link), so any
// other user in the same brokerage can no longer harvest every buyer's link.
//
// Kept deliberately as-is (no Owner decision yet, see BE-Q1):
//   - POST /offers/by-property/:propertyId still returns the new offer's
//     shareToken to the user who recorded it (the only place an agent can
//     obtain the link until the share-link issue/revoke routes, which need a
//     migration, are approved);
//   - the token is not rotated, so links already sent keep working;
//   - GET /offers/public/:shareToken is unchanged and still answers without
//     a session.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, offers } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

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
let propertyId: number;
/** offer id -> token, as the creating agent received it from POST. */
const created = new Map<number, string>();
let toAccept: number;
let toDecline: number;
let toWithdraw: number;

function headers(cookie: string, json = false): Record<string, string> {
  return json ? { cookie, "content-type": "application/json" } : { cookie };
}

async function getJson(path: string, cookie: string) {
  return fetch(`${baseUrl}/api${path}`, { headers: headers(cookie) });
}

async function postJson(path: string, cookie: string, body?: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: headers(cookie, true),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function setRunAccess(brokerageId: number, active: boolean): Promise<void> {
  await db
    .update(entitlementGrants)
    .set({ status: active ? "Active" : "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(brokerageId);
}

/** No key named shareToken anywhere, and none of the issued tokens appear in the raw body. */
function assertNoShareToken(rawBody: string, label: string): void {
  assert.equal(/"shareToken"\s*:/.test(rawBody), false, `${label}: body must not carry a shareToken key`);
  for (const token of created.values()) {
    assert.equal(rawBody.includes(token), false, `${label}: body must not contain an issued share token`);
  }
}

async function createOffer(cookie: string, priceCents: number): Promise<{ id: number; shareToken: string; raw: string }> {
  const res = await postJson(`/offers/by-property/${propertyId}`, cookie, {
    offerPriceCents: priceCents,
    conditions: { conditions: "Subject to finance" },
    buyer: { firstName: "Synthetic", lastName: `Buyer${priceCents}`, email: `buyer-${priceCents}-${suffix}@example.com` },
  });
  const raw = await res.text();
  assert.equal(res.status, 201, raw);
  const { offer } = JSON.parse(raw) as { offer: { id: number; shareToken: string } };
  return { id: offer.id, shareToken: offer.shareToken, raw };
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `Offer Token A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Offer Token B ${suffix}`);
  ({ propertyId } = await createListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Share Token St, Testville`,
    sellerEmail: `seller-token-${suffix}@example.com`,
  }));
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("POST /offers/by-property/:id still hands the new offer's link to the user who recorded it (unchanged)", async () => {
  const one = await createOffer(A.agent.cookie, 81_000_000);
  const two = await createOffer(A.agent.cookie, 82_000_000);
  const three = await createOffer(A.agent.cookie, 83_000_000);
  for (const o of [one, two, three]) {
    assert.match(o.shareToken, /^[0-9a-f]{32}$/);
    created.set(o.id, o.shareToken);
  }
  // Each creator only ever sees the token of the offer they just recorded.
  assert.equal(one.raw.includes(two.shareToken), false);
  toAccept = one.id;
  toDecline = two.id;
  toWithdraw = three.id;
  const [stored] = await db.select().from(offers).where(eq(offers.id, one.id));
  assert.equal(stored.shareToken, one.shareToken, "token is stored as issued (no rotation)");
});

test("GET /offers/by-property/:id omits shareToken for every same-brokerage reader and keeps the other fields", async () => {
  for (const [who, cookie] of [
    ["agent (creator)", A.agent.cookie],
    ["brokerage administrator", A.admin.cookie],
  ] as const) {
    const res = await getJson(`/offers/by-property/${propertyId}`, cookie);
    const raw = await res.text();
    assert.equal(res.status, 200, `${who}: ${raw}`);
    assertNoShareToken(raw, `by-property as ${who}`);
    const { offers: rows } = JSON.parse(raw) as { offers: Array<Record<string, unknown>> };
    assert.equal(rows.length, 3, who);
    for (const row of rows) {
      for (const key of ["id", "propertyId", "buyerPartyId", "offerPriceCents", "conditions", "status", "createdAt"]) {
        assert.ok(key in row, `${who}: offer row keeps ${key}`);
      }
    }
  }
});

test("GET /offers/:id omits shareToken for the creator and for another same-brokerage user", async () => {
  for (const cookie of [A.agent.cookie, A.admin.cookie]) {
    const res = await getJson(`/offers/${toAccept}`, cookie);
    const raw = await res.text();
    assert.equal(res.status, 200, raw);
    assertNoShareToken(raw, "GET /offers/:id");
    const { offer } = JSON.parse(raw) as { offer: { id: number; status: string; offerPriceCents: number } };
    assert.equal(offer.id, toAccept);
    assert.equal(offer.status, "Received");
    assert.equal(offer.offerPriceCents, 81_000_000);
  }
});

test("decline, withdraw and accept responses omit shareToken (accept keeps the transaction)", async () => {
  const declined = await postJson(`/offers/${toDecline}/decline`, A.admin.cookie);
  const declinedRaw = await declined.text();
  assert.equal(declined.status, 200, declinedRaw);
  assertNoShareToken(declinedRaw, "decline");
  assert.equal((JSON.parse(declinedRaw) as { offer: { status: string } }).offer.status, "Declined");

  const withdrawn = await postJson(`/offers/${toWithdraw}/withdraw`, A.admin.cookie);
  const withdrawnRaw = await withdrawn.text();
  assert.equal(withdrawn.status, 200, withdrawnRaw);
  assertNoShareToken(withdrawnRaw, "withdraw");
  assert.equal((JSON.parse(withdrawnRaw) as { offer: { status: string } }).offer.status, "Withdrawn");

  const accepted = await postJson(`/offers/${toAccept}/accept`, A.admin.cookie);
  const acceptedRaw = await accepted.text();
  assert.equal(accepted.status, 201, acceptedRaw);
  assertNoShareToken(acceptedRaw, "accept");
  const body = JSON.parse(acceptedRaw) as { offer: { id: number; status: string }; transaction: { id: number }; created: boolean };
  assert.equal(body.offer.id, toAccept);
  assert.equal(body.offer.status, "Accepted");
  assert.equal(body.created, true);
  assert.ok(Number.isInteger(body.transaction.id));

  // Idempotent replay (200, created=false) is stripped too.
  const replay = await postJson(`/offers/${toAccept}/accept`, A.agent.cookie);
  const replayRaw = await replay.text();
  assert.equal(replay.status, 200, replayRaw);
  assertNoShareToken(replayRaw, "accept replay");
});

test("the public buyer link still works without a session and reveals no ids or token", async () => {
  for (const [id, token] of created) {
    const res = await fetch(`${baseUrl}/api/offers/public/${token}`);
    const raw = await res.text();
    assert.equal(res.status, 200, raw);
    const body = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["createdAt", "offerPriceCents", "propertyAddress", "status"]);
    assert.equal(raw.includes(token), false);
    assert.equal(id > 0, true);
  }
  const unknown = await fetch(`${baseUrl}/api/offers/public/${"0".repeat(32)}`);
  assert.equal(unknown.status, 404);
});

test("another brokerage still gets 404 with no token, and run.access is still required", async () => {
  for (const path of [`/offers/${toAccept}`, `/offers/by-property/${propertyId}`]) {
    const res = await getJson(path, B.admin.cookie);
    const raw = await res.text();
    assert.equal(res.status, 404, `${path}: ${raw}`);
    assert.deepEqual(JSON.parse(raw), { error: "Not found" });
    assertNoShareToken(raw, `cross-brokerage ${path}`);
  }

  await setRunAccess(A.brokerageId, false);
  try {
    for (const path of [`/offers/${toAccept}`, `/offers/by-property/${propertyId}`]) {
      const res = await getJson(path, A.admin.cookie);
      assert.equal(res.status, 403, path);
      const body = (await res.json()) as { error?: string; entitlementKey?: string };
      assert.equal(body.entitlementKey, "run.access");
    }
  } finally {
    await setRunAccess(A.brokerageId, true);
  }
});
