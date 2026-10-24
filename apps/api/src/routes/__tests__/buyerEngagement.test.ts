// CC #34 slice B-2 — buyer engagement timeline, Run sources only.
// GET /api/offers/buyers/:partyId/engagement?propertyId=N merges the
// property_parties link, this buyer's offers and their decisions (audit_logs),
// and transaction milestones where the buyer is in buyer_party_ids. Read-only,
// no migration, no Grow rows (growHistoryAvailable: false), no email/mobile/
// address. Gates: requireAuth, run.access (403 entitlementKey), role (Agent /
// Brokerage Administrator; Pit Crew 403 until Owner BE-Q3), tenant 404 with the
// R-F8 metric counted once. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, users } from "@aee/db";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { canSeeOfferTerms, getBuyerEngagementTimeline } from "../../lib/buyerEngagement.js";
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
let pitCrew: DevLoginResult;

// Scenario on A's property P: buyer X offers (withdraws), offers again
// (accepted -> transaction -> contract signed, finance approved, settlement
// scheduled then rescheduled). Buyer Y offers and is auto-declined.
let P: number;
let sellerPartyId: number;
let X: number;
let Y: number;
let xOffer1: number;
let xOffer2: number;
let yOffer: number;
let txId: number;
let bProperty: number;
let bBuyer: number;
const X_EMAIL = `x-engagement-${suffix}@example.com`;
const X_MOBILE = "0499000111";

type Body = Record<string, unknown>;
interface Ev { type: string; at: string; source: string; offerId?: number; transactionId?: number; dueAt?: string; offerStatus?: string; offerPriceCents?: number }

async function call(method: "GET" | "POST", path: string, cookie: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: body !== undefined ? { cookie, "content-type": "application/json" } : { cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Body) : {} };
}

const engagement = (partyId: number | string, propertyId: number | string | null, cookie: string) =>
  call("GET", `/offers/buyers/${partyId}/engagement${propertyId === null ? "" : `?propertyId=${propertyId}`}`, cookie);

async function createOffer(cookie: string, propertyId: number, body: Body): Promise<{ offerId: number; partyId: number }> {
  const r = await call("POST", `/offers/by-property/${propertyId}`, cookie, body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const offer = r.body.offer as { id: number; buyerPartyId: number };
  return { offerId: offer.id, partyId: offer.buyerPartyId };
}

async function ok(r: Promise<{ status: number; body: Body }>, label: string): Promise<Body> {
  const res = await r;
  assert.ok(res.status === 200 || res.status === 201, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function setRunAccess(brokerageId: number, active: boolean): Promise<void> {
  await db
    .update(entitlementGrants)
    .set({ status: active ? "Active" : "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(brokerageId);
}

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
  A = await createBrokerageWithUsers(baseUrl, `Engagement A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Engagement B ${suffix}`);
  pitCrew = await devLogin(baseUrl, { email: `pitcrew-engagement-${suffix}@example.com`, firstName: "Pat", lastName: "Crew", brokerageName: `Engagement A ${suffix}` });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));

  const listed = await createListedProperty(baseUrl, A.agent.cookie, { address: `1 Timeline St ${suffix}, Testville`, sellerEmail: `seller-eng-${suffix}@example.com` });
  P = listed.propertyId;
  sellerPartyId = listed.sellerPartyId;

  ({ offerId: xOffer1, partyId: X } = await createOffer(A.agent.cookie, P, {
    offerPriceCents: 70_000_000,
    conditions: {},
    buyer: { firstName: "Xena", lastName: "Engaged", email: X_EMAIL, mobile: X_MOBILE },
  }));
  await ok(call("POST", `/offers/${xOffer1}/withdraw`, A.agent.cookie), "withdraw x1");
  ({ offerId: xOffer2 } = await createOffer(A.agent.cookie, P, { offerPriceCents: 72_000_000, conditions: {}, buyerPartyId: X }));
  ({ offerId: yOffer, partyId: Y } = await createOffer(A.agent.cookie, P, {
    offerPriceCents: 71_000_000,
    conditions: {},
    buyer: { firstName: "Yuri", lastName: "Other", email: `y-engagement-${suffix}@example.com` },
  }));
  const accepted = await ok(call("POST", `/offers/${xOffer2}/accept`, A.admin.cookie), "accept x2");
  txId = (accepted.transaction as { id: number }).id;
  await ok(call("POST", `/transactions/${txId}/contract-signed`, A.admin.cookie), "contract signed");
  await ok(call("POST", `/transactions/${txId}/finance-approved`, A.admin.cookie), "finance approved");
  await ok(call("POST", `/transactions/${txId}/settlement-schedule`, A.admin.cookie, { settlementDate: "2027-02-01T00:00:00.000Z" }), "schedule");
  await ok(call("POST", `/transactions/${txId}/settlement-schedule`, A.admin.cookie, { settlementDate: "2027-02-15T00:00:00.000Z" }), "reschedule");

  bProperty = (await createListedProperty(baseUrl, B.agent.cookie, { address: `9 Other Brokerage St ${suffix}, Testville`, sellerEmail: `seller-engb-${suffix}@example.com` })).propertyId;
  ({ partyId: bBuyer } = await createOffer(B.agent.cookie, bProperty, {
    offerPriceCents: 60_000_000,
    conditions: {},
    buyer: { firstName: "Bea", lastName: "Foreign", email: `b-engagement-${suffix}@example.com` },
  }));
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("the accepted buyer's timeline merges link, both offers, decisions and transaction milestones in time order", async () => {
  const r = await engagement(X, P, A.agent.cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.propertyId, P);
  assert.equal(r.body.partyId, X);
  assert.equal(r.body.buyerName, "Xena Engaged");
  assert.equal(r.body.growHistoryAvailable, false);
  const events = r.body.events as Ev[];
  assert.deepEqual(
    events.map((e) => [e.type, e.offerId ?? null, e.transactionId ?? null]),
    [
      ["buyer_linked", null, null],
      ["offer_received", xOffer1, null],
      ["offer_withdrawn", xOffer1, null],
      ["offer_received", xOffer2, null],
      ["offer_accepted", xOffer2, null],
      ["transaction_created", xOffer2, txId],
      ["contract_signed", null, txId],
      ["finance_approved", null, txId],
      ["settlement_scheduled", null, txId],
      ["settlement_scheduled", null, txId],
    ],
  );
  for (let i = 1; i < events.length; i += 1) assert.ok(events[i - 1].at <= events[i].at, `events sorted by time at ${i}`);
  const received = events.filter((e) => e.type === "offer_received");
  assert.deepEqual(received.map((e) => [e.offerPriceCents, e.offerStatus]), [[70_000_000, "Withdrawn"], [72_000_000, "Accepted"]]);
  assert.deepEqual(events.filter((e) => e.type === "settlement_scheduled").map((e) => e.dueAt), ["2027-02-01T00:00:00.000Z", "2027-02-15T00:00:00.000Z"]);
});

test("another buyer on the same property sees only their own offer and its auto-decline, no transaction", async () => {
  const r = await engagement(Y, P, A.admin.cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((r.body.events as Ev[]).map((e) => [e.type, e.offerId ?? null]), [
    ["buyer_linked", null],
    ["offer_received", yOffer],
    ["offer_auto_declined", yOffer],
  ]);
});

test("no email, mobile, residential address or share token anywhere in the response", async () => {
  const r = await engagement(X, P, A.agent.cookie);
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes(X_EMAIL), "email leaked");
  assert.ok(!text.includes(X_MOBILE), "mobile leaked");
  for (const key of ["email", "mobile", "phone", "residentialAddress", "address", "shareToken", "grossCommissionCents", "fundsReceivedCents"]) {
    assert.ok(!new RegExp(`"${key}"`).test(text), `key ${key} must not appear`);
  }
});

test("tenant isolation: another brokerage's property is 404 and counts R-F8 once; unlinked, foreign or seller parties are the same 404", async () => {
  resetMetricsForTesting();
  const foreign = await engagement(bBuyer, bProperty, A.agent.cookie);
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, { error: "Not found" });
  assert.deepEqual(isolationSeries(), ['tenant_isolation_rejection_total{boundary="transaction"} 1']);

  resetMetricsForTesting();
  for (const [label, partyId] of [
    ["B's buyer named on A's property", bBuyer],
    ["the seller party", sellerPartyId],
    ["a party id that does not exist", 2147483646],
  ] as Array<[string, number]>) {
    const r = await engagement(partyId, P, A.agent.cookie);
    assert.equal(r.status, 404, label);
    assert.deepEqual(r.body, { error: "Not found" }, label);
  }
  const missing = await engagement(X, 2147483646, A.agent.cookie);
  assert.equal(missing.status, 404);
  assert.deepEqual(isolationSeries(), [], "unlinked parties and a missing property do not count as isolation rejections");

  const reverse = await engagement(X, P, B.admin.cookie);
  assert.equal(reverse.status, 404, "B cannot read A's buyer timeline");
});

test("input validation: propertyId is required and ids must be positive integers", async () => {
  assert.equal((await engagement(X, null, A.agent.cookie)).status, 400);
  assert.equal((await engagement(X, "abc", A.agent.cookie)).status, 400);
  assert.equal((await engagement("0", P, A.agent.cookie)).status, 400);
  assert.equal((await engagement("x1", P, A.agent.cookie)).status, 400);
});

test("gates: unauthenticated 401, run.access revoked 403 with entitlementKey, Pit Crew 403 until BE-Q3", async () => {
  const anon = await fetch(`${baseUrl}/api/offers/buyers/${X}/engagement?propertyId=${P}`);
  assert.equal(anon.status, 401);

  const pc = await engagement(X, P, pitCrew.cookie);
  assert.equal(pc.status, 403);
  assert.deepEqual(pc.body, { error: "Forbidden" });

  await setRunAccess(A.brokerageId, false);
  try {
    for (const cookie of [A.agent.cookie, A.admin.cookie]) {
      const r = await engagement(X, P, cookie);
      assert.equal(r.status, 403);
      assert.equal(r.body.entitlementKey, "run.access");
    }
  } finally {
    await setRunAccess(A.brokerageId, true);
  }
  assert.equal((await engagement(X, P, A.agent.cookie)).status, 200);
});

test("read-only: fetching the timeline writes nothing", async () => {
  const before1 = await engagement(X, P, A.agent.cookie);
  const before2 = await engagement(X, P, A.admin.cookie);
  assert.deepEqual(before1.body, before2.body);
});

// Confidentiality: offer prices/conditions only for Agents and Brokerage
// Administrators, never Pit Crew.
test("confidentiality: Agents and Brokerage Administrators see offer prices; conditions are never in the timeline", async () => {
  for (const cookie of [A.agent.cookie, A.admin.cookie]) {
    const r = await engagement(X, P, cookie);
    assert.equal(r.status, 200);
    assert.equal(r.body.offerTermsVisible, true);
    const prices = (r.body.events as Ev[]).filter((e) => e.type === "offer_received").map((e) => e.offerPriceCents);
    assert.deepEqual(prices, [70_000_000, 72_000_000]);
    assert.ok(!/"conditions"/.test(JSON.stringify(r.body)), "offer conditions must never be in the timeline");
  }
});

test("confidentiality: Pit Crew gets 403 with no timeline, price or conditions in the body", async () => {
  const res = await fetch(`${baseUrl}/api/offers/buyers/${X}/engagement?propertyId=${P}`, { headers: { cookie: pitCrew.cookie } });
  const text = await res.text();
  assert.equal(res.status, 403);
  assert.deepEqual(JSON.parse(text), { error: "Forbidden" });
  for (const leak of ["70000000", "72000000", "offerPriceCents", "events", "Xena"]) {
    assert.ok(!text.includes(leak), `Pit Crew 403 body leaked ${leak}`);
  }
});

test("confidentiality (second line): a Pit Crew viewer reaching the timeline builder gets no offer prices", async () => {
  assert.equal(canSeeOfferTerms("Agent"), true);
  assert.equal(canSeeOfferTerms("Brokerage Administrator"), true);
  assert.equal(canSeeOfferTerms("Pit Crew"), false);
  assert.equal(canSeeOfferTerms("Something Else"), false);

  const t = await getBuyerEngagementTimeline({ brokerageId: A.brokerageId, propertyId: P, partyId: X, viewerRole: "Pit Crew" });
  assert.ok(t, "timeline exists for a linked buyer");
  assert.equal(t.offerTermsVisible, false);
  const text = JSON.stringify(t);
  assert.ok(!text.includes("offerPriceCents"), "no price key for Pit Crew");
  assert.ok(!text.includes("70000000") && !text.includes("72000000"), "no price values for Pit Crew");
  assert.ok(!/"conditions"/.test(text));
  // Same events otherwise: only the terms are withheld.
  const full = await getBuyerEngagementTimeline({ brokerageId: A.brokerageId, propertyId: P, partyId: X, viewerRole: "Agent" });
  assert.deepEqual(t.events.map((e) => e.type), full!.events.map((e) => e.type));
});
