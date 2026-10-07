// E-5 Option B. Finalising freezes pricing. It does not close the
// opportunity. These tests hit the real routes and the Grow Today / sweep
// reads. Each test name is one required regression.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, appraisals, entitlementGrants } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { getGrowTodaySummary } from "../../lib/growToday.js";
import { evaluateCandidates } from "../../lib/propertyIntelligence/evaluation.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let seq = 0;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

const PRICING_LOCKED = "APPRAISAL_PRICING_LOCKED";
const LIFECYCLE_CLOSED = "APPRAISAL_LIFECYCLE_CLOSED";

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

  A = await createBrokerageWithUsers(baseUrl, `E5 Pricing Lock A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `E5 Pricing Lock B ${suffix}`);
  for (const brokerageId of [A.brokerageId, B.brokerageId]) {
    await grant(brokerageId, "grow.access");
    await grant(brokerageId, "grow.opportunities.manage");
  }
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
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

function growUrl(path: string) {
  return `${baseUrl}/api/grow${path}`;
}

function address(label: string) {
  seq += 1;
  return `${label} ${suffix}-${seq}`;
}

async function createProperty(cookie: string, label: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address(label), state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

async function createParty(cookie: string, propertyId: number, overrides: Record<string, unknown> = {}): Promise<number> {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, role: "Seller", firstName: "Lou", lastName: "Vendor", ...overrides }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  const { party } = (await res.json()) as { party: { id: number } };
  return party.id;
}

async function postJson(cookie: string, path: string, body?: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function growSend(cookie: string, method: string, path: string, body?: unknown) {
  return fetch(growUrl(path), {
    method,
    headers: { "content-type": "application/json", cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createAppraisal(cookie: string, label: string, partyOverrides: Record<string, unknown> = {}) {
  const propertyId = await createProperty(cookie, label);
  const partyId = await createParty(cookie, propertyId, partyOverrides);
  const res = await growSend(cookie, "POST", "/appraisals/from-contact", { partyId, propertyId });
  assert.equal(res.status, 201, await res.clone().text());
  const { appraisal } = (await res.json()) as { appraisal: { id: number; status: string } };
  return { propertyId, partyId, appraisalId: appraisal.id };
}

async function patchWorkspace(cookie: string, appraisalId: number, body: Record<string, unknown>) {
  return growSend(cookie, "PATCH", `/appraisals/${appraisalId}`, body);
}

async function setPrice(cookie: string, appraisalId: number, low = "700000", high = "760000") {
  const res = await patchWorkspace(cookie, appraisalId, {
    priceRangeLow: low,
    priceRangeHigh: high,
    priceRangeCurrency: "AUD",
    pricingCommentary: "Quiet street",
    commissionRatePercent: "2.20",
    commissionProposal: "Standard fee",
  });
  assert.equal(res.status, 200, await res.clone().text());
}

async function moveStatus(cookie: string, appraisalId: number, toStatus: string) {
  const res = await growSend(cookie, "POST", `/appraisals/${appraisalId}/status`, { toStatus });
  assert.equal(res.status, 200, `${toStatus}: ${await res.clone().text()}`);
}

async function finalise(cookie: string, propertyId: number) {
  const res = await postJson(cookie, `/appraisals/by-property/${propertyId}/finalise`);
  assert.equal(res.status, 200, await res.clone().text());
  const { appraisal } = (await res.json()) as { appraisal: { isFinalised: boolean } };
  assert.equal(appraisal.isFinalised, true);
}

async function stored(appraisalId: number) {
  const [row] = await db.select().from(appraisals).where(eq(appraisals.id, appraisalId));
  if (!row) throw new Error(`appraisal ${appraisalId} missing`);
  return row;
}

async function assertPricingLocked(res: Response, label: string) {
  const text = await res.text();
  assert.equal(res.status, 409, `${label}: ${text}`);
  const body = JSON.parse(text) as { error: string; code?: string };
  assert.equal(body.code, PRICING_LOCKED, label);
  assert.match(body.error, /already finalised/i, label);
}

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function scheduleFollowUp(cookie: string, appraisalId: number, when = daysAgo(20)) {
  const res = await growSend(cookie, "POST", `/appraisals/${appraisalId}/follow-up`, {
    followUpAt: when,
    followUpNotes: "Check in with the vendor.",
  });
  assert.equal(res.status, 200, await res.clone().text());
  return res;
}

test("pricing is editable before finalisation", async () => {
  const cookie = A.admin.cookie;
  const { propertyId, appraisalId } = await createAppraisal(cookie, "Editable");

  const patched = await patchWorkspace(cookie, appraisalId, {
    priceRangeLow: "700000",
    priceRangeHigh: "760000",
    priceRangeCurrency: "AUD",
    pricingCommentary: "Before finalise",
    commissionRatePercent: "2.00",
    commissionProposal: "Open fee",
  });
  assert.equal(patched.status, 200, await patched.clone().text());

  const sale = await growSend(cookie, "POST", `/appraisals/${appraisalId}/comparable-sales`, {
    address: "1 Before St",
    salePrice: "720000",
  });
  assert.equal(sale.status, 201, await sale.clone().text());

  const competition = await growSend(cookie, "POST", `/appraisals/${appraisalId}/market-competition`, {
    address: "2 Before St",
    askingPriceDisplay: "$740,000",
  });
  assert.equal(competition.status, 201, await competition.clone().text());

  const runSave = await postJson(cookie, `/appraisals/by-property/${propertyId}`, {
    priceRangeLow: "710000",
    priceRangeHigh: "770000",
    comparableSales: [{ address: "Run comp", price: 730000 }],
  });
  assert.equal(runSave.status, 200, await runSave.clone().text());

  const row = await stored(appraisalId);
  assert.equal(row.isFinalised, false);
  assert.equal(Number(row.priceRangeLow), 710000);
  assert.equal(Number(row.priceRangeHigh), 770000);
  assert.equal(row.pricingCommentary, "Before finalise");
});

test("pricing is immutable after finalisation", async () => {
  const cookie = A.admin.cookie;
  const { propertyId, appraisalId } = await createAppraisal(cookie, "Immutable");
  await setPrice(cookie, appraisalId);
  await finalise(cookie, propertyId);
  const before = await stored(appraisalId);

  const res = await patchWorkspace(cookie, appraisalId, { priceRangeLow: "900000", priceRangeHigh: "960000" });
  await assertPricingLocked(res, "price range");

  const after = await stored(appraisalId);
  assert.equal(after.priceRangeLow, before.priceRangeLow);
  assert.equal(after.priceRangeHigh, before.priceRangeHigh);
  assert.equal(after.priceRangeCurrency, before.priceRangeCurrency);
  assert.equal(after.isFinalised, true);
  const snapshot = after.finalisedSnapshot as { priceRangeLow: string; priceRangeHigh: string };
  assert.equal(snapshot.priceRangeLow, after.priceRangeLow);
  assert.equal(snapshot.priceRangeHigh, after.priceRangeHigh);
});

test("a direct API pricing edit cannot bypass the finalised pricing lock", async () => {
  const cookie = A.admin.cookie;
  const { propertyId, appraisalId } = await createAppraisal(cookie, "Direct");
  await setPrice(cookie, appraisalId);
  const saleRes = await growSend(cookie, "POST", `/appraisals/${appraisalId}/comparable-sales`, {
    address: "1 Locked St",
    salePrice: "680000",
  });
  assert.equal(saleRes.status, 201, await saleRes.clone().text());
  const { comparableSale } = (await saleRes.json()) as { comparableSale: { id: number } };
  const competitionRes = await growSend(cookie, "POST", `/appraisals/${appraisalId}/market-competition`, {
    address: "2 Locked St",
    askingPriceDisplay: "$700,000",
  });
  assert.equal(competitionRes.status, 201, await competitionRes.clone().text());
  const { marketCompetition } = (await competitionRes.json()) as { marketCompetition: { id: number } };
  await finalise(cookie, propertyId);
  const before = await stored(appraisalId);

  await assertPricingLocked(
    await patchWorkspace(cookie, appraisalId, { priceRangeCurrency: "USD" }),
    "currency",
  );
  await assertPricingLocked(
    await patchWorkspace(cookie, appraisalId, { pricingCommentary: "Changed after finalise" }),
    "commentary",
  );
  await assertPricingLocked(
    await patchWorkspace(cookie, appraisalId, { commissionRatePercent: "9.99", commissionProposal: "New fee" }),
    "commission",
  );
  await assertPricingLocked(
    await growSend(cookie, "POST", `/appraisals/${appraisalId}/comparable-sales`, { address: "3 New St", salePrice: "1" }),
    "add comparable",
  );
  await assertPricingLocked(
    await growSend(cookie, "PATCH", `/appraisals/${appraisalId}/comparable-sales/${comparableSale.id}`, { salePrice: "1" }),
    "update comparable",
  );
  await assertPricingLocked(
    await growSend(cookie, "DELETE", `/appraisals/${appraisalId}/comparable-sales/${comparableSale.id}`),
    "delete comparable",
  );
  await assertPricingLocked(
    await growSend(cookie, "POST", `/appraisals/${appraisalId}/market-competition`, { address: "4 New St" }),
    "add competition",
  );
  await assertPricingLocked(
    await growSend(cookie, "PATCH", `/appraisals/${appraisalId}/market-competition/${marketCompetition.id}`, {
      askingPriceDisplay: "$1",
    }),
    "update competition",
  );
  await assertPricingLocked(
    await growSend(cookie, "DELETE", `/appraisals/${appraisalId}/market-competition/${marketCompetition.id}`),
    "delete competition",
  );

  const after = await stored(appraisalId);
  assert.equal(after.priceRangeCurrency, before.priceRangeCurrency);
  assert.equal(after.pricingCommentary, before.pricingCommentary);
  assert.equal(after.commissionRatePercent, before.commissionRatePercent);
  assert.equal(after.commissionProposal, before.commissionProposal);

  const workspaceRes = await growSend(cookie, "GET", `/appraisals/${appraisalId}`);
  assert.equal(workspaceRes.status, 200);
  const workspace = (await workspaceRes.json()) as { comparableSales: unknown[]; marketCompetition: unknown[] };
  assert.equal(workspace.comparableSales.length, 1);
  assert.equal(workspace.marketCompetition.length, 1);
});

test("Run updateAppraisal cannot bypass the finalised pricing lock", async () => {
  const cookie = A.admin.cookie;
  const { propertyId, appraisalId } = await createAppraisal(cookie, "Run lock");
  await setPrice(cookie, appraisalId);

  // Stage A still finalises a DRAFT. The save that precedes it is allowed.
  const stageA = await postJson(cookie, `/appraisals/by-property/${propertyId}`, {
    priceRangeLow: "705000",
    priceRangeHigh: "765000",
  });
  assert.equal(stageA.status, 200, await stageA.clone().text());
  await finalise(cookie, propertyId);

  const blocked = await postJson(cookie, `/appraisals/by-property/${propertyId}`, {
    priceRangeLow: "999999",
    priceRangeHigh: "1000000",
    comparableSales: [{ address: "Bypass", price: 1 }],
  });
  await assertPricingLocked(blocked, "Run update after finalise");
  const locked = await stored(appraisalId);
  assert.equal(Number(locked.priceRangeLow), 705000);
  assert.equal(Number(locked.priceRangeHigh), 765000);

  // A closed lifecycle is refused even when the row was never finalised.
  const won = await createAppraisal(cookie, "Run closed");
  await setPrice(cookie, won.appraisalId, "400000", "450000");
  await moveStatus(cookie, won.appraisalId, "APPOINTMENT_SCHEDULED");
  await moveStatus(cookie, won.appraisalId, "PRESENTED");
  const outcome = await growSend(cookie, "POST", `/appraisals/${won.appraisalId}/outcome`, {
    outcome: "WON",
    outcomeReason: "relationship",
  });
  assert.equal(outcome.status, 200, await outcome.clone().text());
  assert.equal((await stored(won.appraisalId)).isFinalised, false);

  const closed = await postJson(cookie, `/appraisals/by-property/${won.propertyId}`, {
    priceRangeLow: "1",
    priceRangeHigh: "2",
  });
  const closedText = await closed.text();
  assert.equal(closed.status, 409, closedText);
  const closedBody = JSON.parse(closedText) as { code?: string; error: string };
  assert.equal(closedBody.code, LIFECYCLE_CLOSED);
  assert.match(closedBody.error, /WON/);
  assert.equal(Number((await stored(won.appraisalId)).priceRangeLow), 400000);
});

test("non-pricing lifecycle and status activity still work after finalisation", async () => {
  const cookie = A.admin.cookie;
  const { propertyId, appraisalId } = await createAppraisal(cookie, "Lifecycle");
  await setPrice(cookie, appraisalId);
  await finalise(cookie, propertyId);

  const narrative = await patchWorkspace(cookie, appraisalId, {
    sellingStrategy: "Auction",
    marketPositionNarrative: "Still drafting the story.",
    marketingProposal: "Local campaign",
    recommendedNextSteps: "Book the appointment",
  });
  assert.equal(narrative.status, 200, await narrative.clone().text());
  const saved = (await narrative.json()) as { appraisal: { sellingStrategy: string; status: string; isFinalised: boolean } };
  assert.equal(saved.appraisal.sellingStrategy, "Auction");
  assert.equal(saved.appraisal.status, "DRAFT");
  assert.equal(saved.appraisal.isFinalised, true);

  const mixed = await patchWorkspace(cookie, appraisalId, {
    sellingStrategy: "Should not stick",
    priceRangeLow: "1",
    priceRangeHigh: "2",
  });
  await assertPricingLocked(mixed, "mixed pricing patch");
  assert.equal((await stored(appraisalId)).sellingStrategy, "Auction");
  assert.equal(Number((await stored(appraisalId)).priceRangeLow), 700000);

  await moveStatus(cookie, appraisalId, "APPOINTMENT_SCHEDULED");
  assert.equal((await stored(appraisalId)).status, "APPOINTMENT_SCHEDULED");
  assert.equal((await stored(appraisalId)).isFinalised, true);
});

test("follow-up continues after finalisation", async () => {
  const cookie = A.admin.cookie;
  const { propertyId, appraisalId } = await createAppraisal(cookie, "Follow up");
  await setPrice(cookie, appraisalId);
  await moveStatus(cookie, appraisalId, "APPOINTMENT_SCHEDULED");
  await moveStatus(cookie, appraisalId, "PRESENTED");
  await finalise(cookie, propertyId);

  const first = await scheduleFollowUp(cookie, appraisalId, daysAgo(2));
  const firstBody = (await first.json()) as { appraisal: { status: string; followUpNotes: string | null } };
  assert.equal(firstBody.appraisal.status, "FOLLOW_UP");
  assert.equal(firstBody.appraisal.followUpNotes, "Check in with the vendor.");

  const later = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const second = await scheduleFollowUp(cookie, appraisalId, later);
  const secondBody = (await second.json()) as { appraisal: { status: string; followUpAt: string } };
  assert.equal(secondBody.appraisal.status, "FOLLOW_UP");
  assert.equal(new Date(secondBody.appraisal.followUpAt).toISOString(), later);

  const row = await stored(appraisalId);
  assert.equal(row.isFinalised, true);
  assert.equal(Number(row.priceRangeLow), 700000);
  assert.equal(Number(row.priceRangeHigh), 760000);
});

test("finalising a follow-up does not leave a Grow Today card that cannot be cleared", async () => {
  const cookie = A.admin.cookie;
  const { propertyId, appraisalId } = await createAppraisal(cookie, "Today card");
  await setPrice(cookie, appraisalId);
  await moveStatus(cookie, appraisalId, "APPOINTMENT_SCHEDULED");
  await scheduleFollowUp(cookie, appraisalId, daysAgo(20));
  await finalise(cookie, propertyId);
  assert.equal((await stored(appraisalId)).status, "FOLLOW_UP");
  assert.equal((await stored(appraisalId)).isFinalised, true);

  const before = await getGrowTodaySummary(A.brokerageId);
  const card = before.priorityActions.filter(
    (action) => action.type === "appraisal_follow_up" && action.appraisalId === appraisalId,
  );
  assert.equal(card.length, 1);

  const won = await growSend(cookie, "POST", `/appraisals/${appraisalId}/outcome`, {
    outcome: "WON",
    outcomeReason: "relationship",
  });
  assert.equal(won.status, 200, await won.clone().text());

  const after = await getGrowTodaySummary(A.brokerageId);
  const remaining = after.priorityActions.filter(
    (action) => action.type === "appraisal_follow_up" && action.appraisalId === appraisalId,
  );
  assert.equal(remaining.length, 0);
});

test("finalising a follow-up does not leave a stale-appraisal sweep item that cannot be cleared", async () => {
  const cookie = A.admin.cookie;
  const { propertyId, appraisalId } = await createAppraisal(cookie, "Sweep");
  await setPrice(cookie, appraisalId);
  await moveStatus(cookie, appraisalId, "APPOINTMENT_SCHEDULED");
  await scheduleFollowUp(cookie, appraisalId, daysAgo(20));
  await finalise(cookie, propertyId);

  async function staleForProperty() {
    const result = await evaluateCandidates({
      brokerageId: A.brokerageId,
      propertyIds: [propertyId],
      now: new Date(),
      maxCandidates: 100,
    });
    return result.candidates.filter(
      (candidate) => candidate.signalType === "stale_previous_appraisal" && candidate.propertyId === propertyId,
    );
  }

  assert.equal((await staleForProperty()).length, 1);

  const lost = await growSend(cookie, "POST", `/appraisals/${appraisalId}/outcome`, {
    outcome: "LOST",
    outcomeReason: "timing_delayed",
  });
  assert.equal(lost.status, 200, await lost.clone().text());
  assert.equal((await stored(appraisalId)).status, "LOST");
  assert.equal((await stored(appraisalId)).isFinalised, true);
  assert.equal((await staleForProperty()).length, 0);
});

test("a finalised appraisal can later be marked WON", async () => {
  const cookie = A.admin.cookie;
  const { propertyId, appraisalId } = await createAppraisal(cookie, "Later won");
  await setPrice(cookie, appraisalId);
  await moveStatus(cookie, appraisalId, "APPOINTMENT_SCHEDULED");
  await moveStatus(cookie, appraisalId, "PRESENTED");
  await finalise(cookie, propertyId);

  const res = await growSend(cookie, "POST", `/appraisals/${appraisalId}/outcome`, {
    outcome: "WON",
    outcomeReason: "relationship",
    outcomeNotes: "Instructed after the price was finalised.",
  });
  assert.equal(res.status, 200, await res.clone().text());
  const row = await stored(appraisalId);
  assert.equal(row.status, "WON");
  assert.equal(row.outcome, "WON");
  assert.equal(row.isFinalised, true);
  assert.equal(Number(row.priceRangeLow), 700000);
});

test("a finalised appraisal can later be marked LOST", async () => {
  const cookie = A.admin.cookie;
  const { propertyId, appraisalId } = await createAppraisal(cookie, "Later lost");
  await setPrice(cookie, appraisalId);
  await moveStatus(cookie, appraisalId, "APPOINTMENT_SCHEDULED");
  await moveStatus(cookie, appraisalId, "PRESENTED");
  await finalise(cookie, propertyId);

  const res = await growSend(cookie, "POST", `/appraisals/${appraisalId}/outcome`, {
    outcome: "LOST",
    outcomeReason: "pricing_disagreement",
  });
  assert.equal(res.status, 200, await res.clone().text());
  const row = await stored(appraisalId);
  assert.equal(row.status, "LOST");
  assert.equal(row.outcome, "LOST");
  assert.equal(row.isFinalised, true);
  assert.equal(Number(row.priceRangeHigh), 760000);
});

test("a finalised appraisal marked WON can be handed off to Run", async () => {
  const cookie = A.admin.cookie;
  const { propertyId, appraisalId } = await createAppraisal(cookie, "Handoff", { role: "Buyer", firstName: "Win", lastName: "Vendor" });
  await setPrice(cookie, appraisalId);
  await moveStatus(cookie, appraisalId, "APPOINTMENT_SCHEDULED");
  await moveStatus(cookie, appraisalId, "PRESENTED");
  await finalise(cookie, propertyId);
  const outcome = await growSend(cookie, "POST", `/appraisals/${appraisalId}/outcome`, {
    outcome: "WON",
    outcomeReason: "relationship",
  });
  assert.equal(outcome.status, 200, await outcome.clone().text());

  const handoff = await growSend(cookie, "POST", `/appraisals/${appraisalId}/run-handoff`);
  assert.equal(handoff.status, 200, await handoff.clone().text());
  const body = (await handoff.json()) as { propertyId: number; sellerLinkCreated: boolean };
  assert.equal(body.propertyId, propertyId);
  assert.equal(body.sellerLinkCreated, true);
  const row = await stored(appraisalId);
  assert.equal(row.outcome, "WON");
  assert.equal(row.isFinalised, true);
  assert.equal(Number(row.priceRangeLow), 700000);
});

test("cross-brokerage appraisal writes stay refused", async () => {
  const owner = A.admin.cookie;
  const outsider = B.admin.cookie;
  const { propertyId, appraisalId } = await createAppraisal(owner, "Tenant");
  await setPrice(owner, appraisalId);
  await finalise(owner, propertyId);
  const before = await stored(appraisalId);

  const patch = await patchWorkspace(outsider, appraisalId, { priceRangeLow: "1", priceRangeHigh: "2" });
  assert.equal(patch.status, 404, await patch.clone().text());

  const narrative = await patchWorkspace(outsider, appraisalId, { sellingStrategy: "Stolen" });
  assert.equal(narrative.status, 404, await narrative.clone().text());

  const sale = await growSend(outsider, "POST", `/appraisals/${appraisalId}/comparable-sales`, { address: "Foreign St" });
  assert.equal(sale.status, 404, await sale.clone().text());

  const status = await growSend(outsider, "POST", `/appraisals/${appraisalId}/status`, { toStatus: "PREPARING" });
  assert.equal(status.status, 404, await status.clone().text());

  const outcome = await growSend(outsider, "POST", `/appraisals/${appraisalId}/outcome`, { outcome: "WON" });
  assert.equal(outcome.status, 404, await outcome.clone().text());

  const run = await postJson(outsider, `/appraisals/by-property/${propertyId}`, { priceRangeLow: "1", priceRangeHigh: "2" });
  assert.equal(run.status, 404, await run.clone().text());

  const after = await stored(appraisalId);
  assert.equal(after.priceRangeLow, before.priceRangeLow);
  assert.equal(after.priceRangeHigh, before.priceRangeHigh);
  assert.equal(after.sellingStrategy, before.sellingStrategy);
  assert.equal(after.status, before.status);
  assert.equal(after.isFinalised, true);
});
