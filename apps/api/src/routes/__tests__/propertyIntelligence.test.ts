import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, growRelationships, growOpportunitySignals, growOpportunities } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { recordObservation } from "../../lib/propertyIntelligence/observations.js";
import { proposeMatch } from "../../lib/propertyIntelligence/matches.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

/* ---------------------------------------------------------------------
 * AE GROW Priority 5 Remediation — HTTP-integration coverage for the
 * Property Intelligence API (routes/propertyIntelligence.ts) and the
 * service/rule-engine layer underneath it
 * (lib/propertyIntelligence/{observations,matches,signals,service}.ts),
 * following the exact conventions established by growAppraisals.test.ts:
 * real Express app, real Postgres, real dev-login cookies, real fetch()
 * calls — never a mocked request/response.
 *
 * Fixture strategy, per data source (see the remediation tracking report
 * for why each one is seeded the way it is):
 *   - long_ownership_tenure:      real HTTP relationship (POST
 *                                 /grow/relationships) + a direct
 *                                 db.update backdating validFrom — no HTTP
 *                                 route exposes validFrom, by design (see
 *                                 packages/db/src/schema/grow.ts).
 *   - stale_previous_appraisal:   entirely real HTTP — the appraisal
 *                                 status lifecycle + POST .../follow-up
 *                                 with an explicit past followUpAt, exactly
 *                                 as growAppraisals.test.ts already
 *                                 demonstrates is supported.
 *   - recent_nearby_sales_activity (observation-driven): the
 *                                 recordObservation() lib function,
 *                                 imported directly — the write path a
 *                                 future provider-ingestion job would call;
 *                                 no HTTP route creates this row today (by
 *                                 design — Priority 5 remains mock-only).
 *   - property_external_identifiers (match candidates): the proposeMatch()
 *                                 lib function, imported directly — same
 *                                 reasoning, the counterpart write path for
 *                                 a future provider-matching job.
 *
 * Three brokerages:
 *   A — full grow.access + grow.relationships.manage +
 *       grow.propertyIntelligence.read + grow.propertyIntelligence.manage.
 *       Primary fixture owner.
 *   B — the same full entitlement set as A. Tenant-isolation counterpart —
 *       having every entitlement A has means a 404 against A's data can
 *       only be tenant isolation, never an entitlement decision.
 *   C — grow.access only, no propertyIntelligence entitlements at all.
 *       Entitlement-denial tests; read/manage are granted and revoked on
 *       C over the course of the entitlement test to exercise both gates
 *       independently.
 * -----------------------------------------------------------------*/

let server: Server;
let baseUrl: string;

const suffix = Date.now();
const brokerageAName = `Property Intelligence A ${suffix}`;
const brokerageBName = `Property Intelligence B ${suffix}`;
const brokerageCName = `Property Intelligence C ${suffix}`;

let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let C: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

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

  A = await createBrokerageWithUsers(baseUrl, brokerageAName);
  B = await createBrokerageWithUsers(baseUrl, brokerageBName);
  C = await createBrokerageWithUsers(baseUrl, brokerageCName);

  for (const brokerageId of [A.brokerageId, B.brokerageId]) {
    await grant(brokerageId, "grow.access");
    await grant(brokerageId, "grow.relationships.manage");
    await grant(brokerageId, "grow.propertyIntelligence.read");
    await grant(brokerageId, "grow.propertyIntelligence.manage");
    // Needed only by the Relationship Timeline integration test below (GET
    // /grow/contacts/:partyId is gated on this, independently of every
    // grow.propertyIntelligence.* key above) — granted to both A and B so a
    // 404 there can only mean tenant isolation, never an entitlement
    // decision, matching this file's own tenant-isolation convention.
    await grant(brokerageId, "grow.contacts.read");
  }
  await grant(C.brokerageId, "grow.access");
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId, C?.brokerageId]);
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

function piUrl(path: string) {
  return `${baseUrl}/api/grow/property-intelligence${path}`;
}
function growUrl(path: string) {
  return `${baseUrl}/api/grow${path}`;
}

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

async function createParty(cookie: string, propertyId: number, overrides: Record<string, unknown> = {}): Promise<number> {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, role: "Seller", firstName: "Test", lastName: "Contact", ...overrides }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  const { party } = (await res.json()) as { party: { id: number } };
  return party.id;
}

async function createRelationship(cookie: string, partyId: number, propertyId: number, relationshipType: string): Promise<number> {
  const res = await fetch(growUrl("/relationships"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ partyId, propertyId, relationshipType }),
  });
  if (res.status !== 201) throw new Error(`create relationship failed: ${res.status} ${await res.text()}`);
  const { relationship } = (await res.json()) as { relationship: { id: number } };
  return relationship.id;
}

/** Backdates a relationship's validFrom directly — no HTTP route exposes this column (see module header comment). */
async function backdateRelationship(relationshipId: number, yearsAgo: number): Promise<void> {
  await db
    .update(growRelationships)
    .set({ validFrom: new Date(Date.now() - yearsAgo * 365 * 24 * 60 * 60 * 1000) })
    .where(eq(growRelationships.id, relationshipId));
}

/** Owner relationship, backdated far enough for a StrongIndicator long_ownership_tenure candidate (>= 10 years). */
async function createLongTenureOwner(cookie: string, propertyId: number, relationshipType: "owner" | "co_owner" = "owner"): Promise<{ partyId: number; relationshipId: number }> {
  const partyId = await createParty(cookie, propertyId);
  const relationshipId = await createRelationship(cookie, partyId, propertyId, relationshipType);
  await backdateRelationship(relationshipId, 11);
  return { partyId, relationshipId };
}

async function recalculate(cookie: string, propertyId: number) {
  const res = await fetch(piUrl(`/property/${propertyId}/recalculate`), { method: "POST", headers: { cookie } });
  if (res.status !== 200) throw new Error(`recalculate failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { signals: Array<{ id: number; signalType: string; confidenceBand: string; partyId: number | null; status: string }> };
}

test("unauthenticated requests to every property intelligence endpoint are rejected", async () => {
  const paths: Array<[string, string]> = [
    ["GET", piUrl("/property/1")],
    ["GET", piUrl("/contact/1")],
    ["GET", piUrl("/property/1/matches")],
    ["GET", piUrl("/property/1/signals")],
    ["POST", piUrl("/matches/1/confirm")],
    ["POST", piUrl("/matches/1/reject")],
    ["POST", piUrl("/signals/1/review")],
    ["POST", piUrl("/signals/1/dismiss")],
    ["POST", piUrl("/signals/1/promote")],
    ["POST", piUrl("/property/1/recalculate")],
  ];
  for (const [method, url] of paths) {
    const res = await fetch(url, { method });
    assert.equal(res.status, 401, `${method} ${url} should require authentication`);
  }
});

test("entitlement gating — grow.propertyIntelligence.read and .manage are enforced independently, and independently of grow.access", async () => {
  // C has grow.access but neither propertyIntelligence key yet.
  const readRes = await fetch(piUrl("/property/999999"), { headers: { cookie: C.admin.cookie } });
  assert.equal(readRes.status, 403);
  const manageRes = await fetch(piUrl("/property/999999/recalculate"), { method: "POST", headers: { cookie: C.admin.cookie } });
  assert.equal(manageRes.status, 403);

  await grant(C.brokerageId, "grow.propertyIntelligence.read");

  // Read now allowed (404 for the nonexistent property id, not 403 — proves the entitlement gate passed).
  const readAfterGrantRes = await fetch(piUrl("/property/999999"), { headers: { cookie: C.admin.cookie } });
  assert.equal(readAfterGrantRes.status, 404);
  // Manage still denied — the two keys are independent.
  const manageStillDeniedRes = await fetch(piUrl("/property/999999/recalculate"), { method: "POST", headers: { cookie: C.admin.cookie } });
  assert.equal(manageStillDeniedRes.status, 403);

  await grant(C.brokerageId, "grow.propertyIntelligence.manage");
  const manageAfterGrantRes = await fetch(piUrl("/property/999999/recalculate"), { method: "POST", headers: { cookie: C.admin.cookie } });
  assert.equal(manageAfterGrantRes.status, 404); // entitled, just no such property in this brokerage.

  // grow.access itself is never checked by this router — revoking it must not change the outcome above.
  await revokeEntitlement(C.brokerageId, "grow.access");
  const readWithoutGrowAccessRes = await fetch(piUrl("/property/999999"), { headers: { cookie: C.admin.cookie } });
  assert.equal(readWithoutGrowAccessRes.status, 404);

  // Leave C clean for later tests in this file.
  await revokeEntitlement(C.brokerageId, "grow.propertyIntelligence.read");
  await revokeEntitlement(C.brokerageId, "grow.propertyIntelligence.manage");
  await grant(C.brokerageId, "grow.access");
});

test("a fresh property has an empty summary, and recalculating it is a safe no-op", async () => {
  const cookie = A.admin.cookie;
  const propertyId = await createProperty(cookie, `1 Fresh Property St ${suffix}`);

  const summaryRes = await fetch(piUrl(`/property/${propertyId}`), { headers: { cookie } });
  assert.equal(summaryRes.status, 200);
  const summary = (await summaryRes.json()) as {
    propertyId: number;
    dataQualityStatus: string | null;
    lastEnrichedAt: string | null;
    currentObservations: unknown[];
    pendingMatches: unknown[];
    activeSignals: unknown[];
  };
  assert.equal(summary.propertyId, propertyId);
  assert.equal(summary.dataQualityStatus, null);
  assert.equal(summary.lastEnrichedAt, null);
  assert.deepEqual(summary.currentObservations, []);
  assert.deepEqual(summary.pendingMatches, []);
  assert.deepEqual(summary.activeSignals, []);

  const first = await recalculate(cookie, propertyId);
  assert.deepEqual(first.signals, []);
  const second = await recalculate(cookie, propertyId);
  assert.deepEqual(second.signals, []);
});

test("long ownership tenure — deterministic StrongIndicator band, idempotent recalculation, second recalculation produces the same row (not a duplicate)", async () => {
  const cookie = A.admin.cookie;
  const propertyId = await createProperty(cookie, `2 Long Tenure St ${suffix}`);
  const { partyId, relationshipId } = await createLongTenureOwner(cookie, propertyId);

  const first = await recalculate(cookie, propertyId);
  assert.equal(first.signals.length, 1);
  const [signal] = first.signals;
  assert.equal(signal.signalType, "long_ownership_tenure");
  assert.equal(signal.confidenceBand, "StrongIndicator");
  assert.equal(signal.partyId, partyId);
  assert.equal(signal.status, "Active");

  const second = await recalculate(cookie, propertyId);
  assert.equal(second.signals.length, 1);
  assert.equal(second.signals[0].id, signal.id, "recalculation must upsert the same row, not insert a duplicate");

  const listRes = await fetch(piUrl(`/property/${propertyId}/signals`), { headers: { cookie } });
  const { signals: listed } = (await listRes.json()) as { signals: Array<{ id: number }> };
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, signal.id);

  // Sanity check the underlying evidence really is what the rule read.
  const [relationship] = await db.select().from(growRelationships).where(eq(growRelationships.id, relationshipId));
  assert.ok(relationship);
  assert.equal(relationship!.relationshipType, "owner");
});

test("long ownership tenure — confidence bands scale with tenure (Emerging / WorthReviewing / StrongIndicator)", async () => {
  const cookie = A.admin.cookie;

  async function tenureBandFor(yearsAgo: number): Promise<string> {
    const propertyId = await createProperty(cookie, `Tenure Band ${yearsAgo}y ${suffix}`);
    const partyId = await createParty(cookie, propertyId);
    const relationshipId = await createRelationship(cookie, partyId, propertyId, "owner");
    await backdateRelationship(relationshipId, yearsAgo);
    const { signals } = await recalculate(cookie, propertyId);
    assert.equal(signals.length, 1);
    return signals[0].confidenceBand;
  }

  assert.equal(await tenureBandFor(6), "Emerging");
  assert.equal(await tenureBandFor(8), "WorthReviewing");
  assert.equal(await tenureBandFor(11), "StrongIndicator");
});

test("stale previous appraisal — seeded entirely through the real appraisal lifecycle and /follow-up endpoint", async () => {
  const cookie = A.admin.cookie;
  const propertyId = await createProperty(cookie, `3 Stale Appraisal St ${suffix}`);
  const partyId = await createParty(cookie, propertyId);

  const createRes = await fetch(growUrl("/appraisals/from-contact"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ partyId, propertyId }),
  });
  assert.equal(createRes.status, 201);
  const { appraisal } = (await createRes.json()) as { appraisal: { id: number } };

  for (const toStatus of ["PREPARING", "READY", "SENT", "VIEWED", "PRESENTED"]) {
    const res = await fetch(growUrl(`/appraisals/${appraisal.id}/status`), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ toStatus }),
    });
    assert.equal(res.status, 200, `transition to ${toStatus} should succeed`);
  }

  const followUpAt = new Date(Date.now() - 70 * 24 * 60 * 60 * 1000).toISOString();
  const followUpRes = await fetch(growUrl(`/appraisals/${appraisal.id}/follow-up`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ followUpAt, followUpNotes: "70 days overdue fixture." }),
  });
  assert.equal(followUpRes.status, 200);

  const { signals } = await recalculate(cookie, propertyId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].signalType, "stale_previous_appraisal");
  assert.equal(signals[0].confidenceBand, "StrongIndicator");
  assert.equal(signals[0].partyId, partyId);
});

test("provider-observation-driven signal (recent_nearby_sales_activity) — no linked contact, freshness drives the confidence band", async () => {
  const cookie = A.admin.cookie;
  const propertyId = await createProperty(cookie, `4 Observation Driven St ${suffix}`);

  await recordObservation({
    brokerageId: A.brokerageId,
    propertyId,
    observationType: "sales_history",
    provider: "mock",
    payload: { nearbySales: [{ address: "6 Nearby St", price: 900000 }] },
    sourceTimestamp: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
  });

  const { signals } = await recalculate(cookie, propertyId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].signalType, "recent_nearby_sales_activity");
  assert.equal(signals[0].confidenceBand, "StrongIndicator");
  assert.equal(signals[0].partyId, null, "an observation-driven signal has no linked contact by design");

  // market_activity maps onto the same signal type (see signals.ts's OBSERVATION_SIGNAL_MAP) —
  // recorded against a second property so it doesn't collide with the fixture above.
  const propertyId2 = await createProperty(cookie, `4b Market Activity St ${suffix}`);
  await recordObservation({
    brokerageId: A.brokerageId,
    propertyId: propertyId2,
    observationType: "market_activity",
    provider: "mock",
    payload: { trend: "rising demand" },
    sourceTimestamp: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
  });
  const second = await recalculate(cookie, propertyId2);
  assert.equal(second.signals.length, 1);
  assert.equal(second.signals[0].signalType, "recent_nearby_sales_activity");
});

test("match review — propose (fixture), list pending, confirm, cannot re-confirm/re-reject; a separate proposal can be rejected with a reason", async () => {
  const cookie = A.admin.cookie;
  const propertyId = await createProperty(cookie, `5 Match Review St ${suffix}`);

  const toConfirm = await proposeMatch({
    brokerageId: A.brokerageId,
    propertyId,
    provider: "mock",
    externalId: `mock-ext-${suffix}-confirm`,
    matchConfidence: 0.72,
    matchReasons: ["exact postcode + street number match"],
  });
  assert.equal(toConfirm.status, "PendingReview");

  // proposeMatch refreshes an existing PendingReview row on a (provider, externalId) collision
  // rather than inserting a duplicate.
  const refreshed = await proposeMatch({
    brokerageId: A.brokerageId,
    propertyId,
    provider: "mock",
    externalId: `mock-ext-${suffix}-confirm`,
    matchConfidence: 0.91,
    matchReasons: ["exact postcode + street number + unit number match"],
  });
  assert.equal(refreshed.id, toConfirm.id);
  assert.equal(Number(refreshed.matchConfidence), 0.91);

  const toReject = await proposeMatch({
    brokerageId: A.brokerageId,
    propertyId,
    provider: "mock",
    externalId: `mock-ext-${suffix}-reject`,
  });

  const listRes = await fetch(piUrl(`/property/${propertyId}/matches?status=PendingReview`), { headers: { cookie } });
  const { matches: pending } = (await listRes.json()) as { matches: Array<{ id: number }> };
  assert.deepEqual(
    pending.map((m) => m.id).sort(),
    [toConfirm.id, toReject.id].sort(),
  );

  const confirmRes = await fetch(piUrl(`/matches/${toConfirm.id}/confirm`), { method: "POST", headers: { cookie } });
  assert.equal(confirmRes.status, 200);
  const { match: confirmed } = (await confirmRes.json()) as { match: { status: string } };
  assert.equal(confirmed.status, "Confirmed");

  const reconfirmRes = await fetch(piUrl(`/matches/${toConfirm.id}/confirm`), { method: "POST", headers: { cookie } });
  assert.equal(reconfirmRes.status, 409);
  const rejectAfterConfirmRes = await fetch(piUrl(`/matches/${toConfirm.id}/reject`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({}),
  });
  assert.equal(rejectAfterConfirmRes.status, 409);

  const rejectRes = await fetch(piUrl(`/matches/${toReject.id}/reject`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ rejectedReason: "Address does not actually match on inspection" }),
  });
  assert.equal(rejectRes.status, 200);
  const { match: rejected } = (await rejectRes.json()) as { match: { status: string; rejectedReason: string | null } };
  assert.equal(rejected.status, "Rejected");
  assert.equal(rejected.rejectedReason, "Address does not actually match on inspection");

  const rerejectRes = await fetch(piUrl(`/matches/${toReject.id}/reject`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({}),
  });
  assert.equal(rerejectRes.status, 409);

  const confirmedListRes = await fetch(piUrl(`/property/${propertyId}/matches?status=Confirmed`), { headers: { cookie } });
  const { matches: confirmedList } = (await confirmedListRes.json()) as { matches: Array<{ id: number }> };
  assert.deepEqual(confirmedList.map((m) => m.id), [toConfirm.id]);
});

test("signal lifecycle — review, dismiss requires a non-empty reason, promote creates a real opportunity and prevents duplicate promotion, promote requires a linked contact", async () => {
  const cookie = A.admin.cookie;

  // Three independent long-tenure fixtures so review/dismiss/promote don't interfere with each other.
  const reviewPropertyId = await createProperty(cookie, `6a Review St ${suffix}`);
  await createLongTenureOwner(cookie, reviewPropertyId);
  const { signals: reviewSignals } = await recalculate(cookie, reviewPropertyId);
  const reviewSignalId = reviewSignals[0].id;

  const dismissPropertyId = await createProperty(cookie, `6b Dismiss St ${suffix}`);
  await createLongTenureOwner(cookie, dismissPropertyId);
  const { signals: dismissSignals } = await recalculate(cookie, dismissPropertyId);
  const dismissSignalId = dismissSignals[0].id;

  const promotePropertyId = await createProperty(cookie, `6c Promote St ${suffix}`);
  const { partyId: promotePartyId } = await createLongTenureOwner(cookie, promotePropertyId);
  const { signals: promoteSignals } = await recalculate(cookie, promotePropertyId);
  const promoteSignalId = promoteSignals[0].id;

  // --- review ---
  const reviewRes = await fetch(piUrl(`/signals/${reviewSignalId}/review`), { method: "POST", headers: { cookie } });
  assert.equal(reviewRes.status, 200);
  const { signal: reviewed } = (await reviewRes.json()) as { signal: { status: string } };
  assert.equal(reviewed.status, "Reviewed");
  const rereviewRes = await fetch(piUrl(`/signals/${reviewSignalId}/review`), { method: "POST", headers: { cookie } });
  assert.equal(rereviewRes.status, 409);

  // --- dismiss ---
  const dismissNoBodyRes = await fetch(piUrl(`/signals/${dismissSignalId}/dismiss`), { method: "POST", headers: { cookie } });
  assert.equal(dismissNoBodyRes.status, 400);
  const dismissEmptyReasonRes = await fetch(piUrl(`/signals/${dismissSignalId}/dismiss`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ dismissedReason: "" }),
  });
  assert.equal(dismissEmptyReasonRes.status, 400);
  const dismissRes = await fetch(piUrl(`/signals/${dismissSignalId}/dismiss`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ dismissedReason: "Owner already spoken to; not selling." }),
  });
  assert.equal(dismissRes.status, 200);
  const { signal: dismissed } = (await dismissRes.json()) as { signal: { status: string; dismissedReason: string | null } };
  assert.equal(dismissed.status, "Dismissed");
  assert.equal(dismissed.dismissedReason, "Owner already spoken to; not selling.");
  const redismissRes = await fetch(piUrl(`/signals/${dismissSignalId}/dismiss`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ dismissedReason: "Trying again." }),
  });
  assert.equal(redismissRes.status, 409);

  // Recalculation must never resurrect a dismissed signal.
  await recalculate(cookie, dismissPropertyId);
  const [dismissedAfterRecalc] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, dismissSignalId));
  assert.equal(dismissedAfterRecalc!.status, "Dismissed");

  // --- promote ---
  const promoteRes = await fetch(piUrl(`/signals/${promoteSignalId}/promote`), { method: "POST", headers: { cookie } });
  assert.equal(promoteRes.status, 200);
  const promoteBody = (await promoteRes.json()) as { signal: { status: string; promotedOpportunityId: number | null }; opportunityId: number };
  assert.equal(promoteBody.signal.status, "Superseded");
  assert.equal(promoteBody.signal.promotedOpportunityId, promoteBody.opportunityId);

  const [opportunity] = await db.select().from(growOpportunities).where(eq(growOpportunities.id, promoteBody.opportunityId));
  assert.ok(opportunity, "promote must create a real growOpportunities row");
  assert.equal(opportunity!.brokerageId, A.brokerageId);
  assert.equal(opportunity!.partyId, promotePartyId);
  assert.equal(opportunity!.propertyId, promotePropertyId);
  assert.equal(opportunity!.status, "Open");

  const repromoteRes = await fetch(piUrl(`/signals/${promoteSignalId}/promote`), { method: "POST", headers: { cookie } });
  assert.equal(repromoteRes.status, 409);

  // --- promote requires a linked contact ---
  const noContactPropertyId = await createProperty(cookie, `6d No Contact St ${suffix}`);
  await recordObservation({
    brokerageId: A.brokerageId,
    propertyId: noContactPropertyId,
    observationType: "sales_history",
    provider: "mock",
    payload: {},
    sourceTimestamp: new Date(),
  });
  const { signals: noContactSignals } = await recalculate(cookie, noContactPropertyId);
  assert.equal(noContactSignals[0].partyId, null);
  const promoteNoContactRes = await fetch(piUrl(`/signals/${noContactSignals[0].id}/promote`), { method: "POST", headers: { cookie } });
  assert.equal(promoteNoContactRes.status, 409);
});

test("recalculation raises a distinct new signal for a genuinely new piece of evidence, alongside an already-dismissed one", async () => {
  const cookie = A.admin.cookie;
  const propertyId = await createProperty(cookie, `7 New Evidence St ${suffix}`);
  const { relationshipId: firstRelationshipId } = await createLongTenureOwner(cookie, propertyId, "owner");

  const { signals: initial } = await recalculate(cookie, propertyId);
  assert.equal(initial.length, 1);

  const dismissRes = await fetch(piUrl(`/signals/${initial[0].id}/dismiss`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ dismissedReason: "Not interested." }),
  });
  assert.equal(dismissRes.status, 200);

  // A second, distinct owner relationship on the SAME property is a genuinely new piece of
  // evidence (a different growRelationships row -> a different dedupeKey) — it must raise its
  // own new Active signal without disturbing the dismissed one.
  const { relationshipId: secondRelationshipId } = await createLongTenureOwner(cookie, propertyId, "co_owner");
  assert.notEqual(secondRelationshipId, firstRelationshipId);

  const { signals: afterNewEvidence } = await recalculate(cookie, propertyId);
  assert.equal(afterNewEvidence.length, 2);
  const statuses = afterNewEvidence.map((s) => s.status).sort();
  assert.deepEqual(statuses, ["Active", "Dismissed"]);
});

test("tenant isolation — brokerage B cannot read or mutate brokerage A's property intelligence data despite holding every relevant entitlement", async () => {
  const cookie = A.admin.cookie;
  const otherCookie = B.admin.cookie;

  const propertyId = await createProperty(cookie, `8 Tenant Isolation St ${suffix}`);
  const partyId = await createParty(cookie, propertyId);
  const relationshipId = await createRelationship(cookie, partyId, propertyId, "owner");
  await backdateRelationship(relationshipId, 11);
  const { signals } = await recalculate(cookie, propertyId);
  const signalId = signals[0].id;
  const match = await proposeMatch({ brokerageId: A.brokerageId, propertyId, provider: "mock", externalId: `mock-ext-${suffix}-tenant` });

  const summaryRes = await fetch(piUrl(`/property/${propertyId}`), { headers: { cookie: otherCookie } });
  assert.equal(summaryRes.status, 404);
  const contactRes = await fetch(piUrl(`/contact/${partyId}`), { headers: { cookie: otherCookie } });
  assert.equal(contactRes.status, 404);
  const matchesRes = await fetch(piUrl(`/property/${propertyId}/matches`), { headers: { cookie: otherCookie } });
  assert.equal(matchesRes.status, 404);
  const signalsRes = await fetch(piUrl(`/property/${propertyId}/signals`), { headers: { cookie: otherCookie } });
  assert.equal(signalsRes.status, 404);
  const recalcRes = await fetch(piUrl(`/property/${propertyId}/recalculate`), { method: "POST", headers: { cookie: otherCookie } });
  assert.equal(recalcRes.status, 404);
  const confirmRes = await fetch(piUrl(`/matches/${match.id}/confirm`), { method: "POST", headers: { cookie: otherCookie } });
  assert.equal(confirmRes.status, 404);
  const rejectRes = await fetch(piUrl(`/matches/${match.id}/reject`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: otherCookie },
    body: JSON.stringify({}),
  });
  assert.equal(rejectRes.status, 404);
  const reviewRes = await fetch(piUrl(`/signals/${signalId}/review`), { method: "POST", headers: { cookie: otherCookie } });
  assert.equal(reviewRes.status, 404);
  const dismissRes = await fetch(piUrl(`/signals/${signalId}/dismiss`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: otherCookie },
    body: JSON.stringify({ dismissedReason: "Should not apply." }),
  });
  assert.equal(dismissRes.status, 404);
  const promoteRes = await fetch(piUrl(`/signals/${signalId}/promote`), { method: "POST", headers: { cookie: otherCookie } });
  assert.equal(promoteRes.status, 404);

  // Brokerage A itself can still read/act on it — proving the 404s above are tenant isolation,
  // not a broken fixture.
  const ownSummaryRes = await fetch(piUrl(`/property/${propertyId}`), { headers: { cookie } });
  assert.equal(ownSummaryRes.status, 200);
});

test("Contact 360 property-intelligence summary — one entry per property the contact has an Active relationship to, each carrying its own active signals and pending matches", async () => {
  const cookie = A.admin.cookie;
  const propertyId = await createProperty(cookie, `9 Contact 360 St ${suffix}`);
  const partyId = await createParty(cookie, propertyId);
  const relationshipId = await createRelationship(cookie, partyId, propertyId, "owner");
  await backdateRelationship(relationshipId, 11);
  await recalculate(cookie, propertyId);
  const match = await proposeMatch({ brokerageId: A.brokerageId, propertyId, provider: "mock", externalId: `mock-ext-${suffix}-contact360` });

  const res = await fetch(piUrl(`/contact/${partyId}`), { headers: { cookie } });
  assert.equal(res.status, 200);
  const { properties: entries } = (await res.json()) as {
    properties: Array<{ propertyId: number; relationshipType: string; activeSignals: Array<{ signalType: string }>; pendingMatches: Array<{ id: number }> }>;
  };
  assert.equal(entries.length, 1);
  assert.equal(entries[0].propertyId, propertyId);
  assert.equal(entries[0].relationshipType, "owner");
  assert.equal(entries[0].activeSignals.length, 1);
  assert.equal(entries[0].activeSignals[0].signalType, "long_ownership_tenure");
  assert.deepEqual(entries[0].pendingMatches.map((m) => m.id), [match.id]);

  // A contact with no recorded relationships gets an empty list, not an error.
  const lonelyPartyId = await createParty(cookie, propertyId, { firstName: "Lonely", lastName: "Contact" });
  const lonelyRes = await fetch(piUrl(`/contact/${lonelyPartyId}`), { headers: { cookie } });
  assert.equal(lonelyRes.status, 200);
  const lonelyBody = (await lonelyRes.json()) as { properties: unknown[] };
  assert.deepEqual(lonelyBody.properties, []);

  // A contact belonging to another brokerage is not found, not exposed.
  const crossTenantRes = await fetch(piUrl(`/contact/${partyId}`), { headers: { cookie: B.admin.cookie } });
  assert.equal(crossTenantRes.status, 404);
});

function propertyTimelineUrl(propertyId: number) {
  return `${baseUrl}/api/properties/${propertyId}/timeline`;
}

async function getContactTimeline(partyId: number, cookie: string) {
  const res = await fetch(growUrl(`/contacts/${partyId}`), { headers: { cookie } });
  return res;
}

async function getPropertyTimelineHttp(propertyId: number, cookie: string) {
  const res = await fetch(propertyTimelineUrl(propertyId), { headers: { cookie } });
  return res;
}

test("Relationship Timeline and Property Timeline integration — signal review/dismiss/promote and match confirm/reject each produce exactly the right event, a merely-Active signal produces none, and tenant isolation holds on both surfaces", async () => {
  const cookie = A.admin.cookie;

  // --- signal reviewed ---
  const reviewPropertyId = await createProperty(cookie, `10a Timeline Review St ${suffix}`);
  const { partyId: reviewPartyId } = await createLongTenureOwner(cookie, reviewPropertyId);
  const { signals: reviewSignals } = await recalculate(cookie, reviewPropertyId);
  const reviewSignalId = reviewSignals[0].id;
  const reviewActionRes = await fetch(piUrl(`/signals/${reviewSignalId}/review`), { method: "POST", headers: { cookie } });
  assert.equal(reviewActionRes.status, 200);

  const reviewContactRes = await getContactTimeline(reviewPartyId, cookie);
  assert.equal(reviewContactRes.status, 200);
  const reviewContactBody = (await reviewContactRes.json()) as {
    timeline: Array<{ type: string; propertyId: number | null; sourceType: string; sourceId: number }>;
  };
  const reviewContactSignalEvents = reviewContactBody.timeline.filter((e) => e.sourceType === "property_intelligence_signal");
  assert.equal(reviewContactSignalEvents.length, 1, "reviewing a signal must raise exactly one Relationship Timeline event, never zero or two");
  assert.equal(reviewContactSignalEvents[0].type, "PROPERTY_INTELLIGENCE_SIGNAL_REVIEWED");
  assert.equal(reviewContactSignalEvents[0].propertyId, reviewPropertyId);
  assert.equal(reviewContactSignalEvents[0].sourceId, reviewSignalId);

  const reviewPropertyRes = await getPropertyTimelineHttp(reviewPropertyId, cookie);
  assert.equal(reviewPropertyRes.status, 200);
  const reviewPropertyBody = (await reviewPropertyRes.json()) as { timeline: Array<{ entryType: string; propertyId: number }> };
  const reviewPropertyEntries = reviewPropertyBody.timeline.filter((e) => e.entryType === "property_intelligence_signal_reviewed");
  assert.equal(reviewPropertyEntries.length, 1);
  assert.equal(reviewPropertyEntries[0].propertyId, reviewPropertyId);

  // --- signal dismissed ---
  const dismissPropertyId = await createProperty(cookie, `10b Timeline Dismiss St ${suffix}`);
  const { partyId: dismissPartyId } = await createLongTenureOwner(cookie, dismissPropertyId);
  const { signals: dismissSignals } = await recalculate(cookie, dismissPropertyId);
  const dismissSignalId = dismissSignals[0].id;
  const dismissActionRes = await fetch(piUrl(`/signals/${dismissSignalId}/dismiss`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ dismissedReason: "Timeline integration fixture." }),
  });
  assert.equal(dismissActionRes.status, 200);

  const dismissContactRes = await getContactTimeline(dismissPartyId, cookie);
  const dismissContactBody = (await dismissContactRes.json()) as {
    timeline: Array<{ type: string; propertyId: number | null; sourceType: string; sourceId: number }>;
  };
  const dismissContactSignalEvents = dismissContactBody.timeline.filter((e) => e.sourceType === "property_intelligence_signal");
  assert.equal(dismissContactSignalEvents.length, 1);
  assert.equal(dismissContactSignalEvents[0].type, "PROPERTY_INTELLIGENCE_SIGNAL_DISMISSED");
  assert.equal(dismissContactSignalEvents[0].sourceId, dismissSignalId);

  const dismissPropertyRes = await getPropertyTimelineHttp(dismissPropertyId, cookie);
  const dismissPropertyBody = (await dismissPropertyRes.json()) as { timeline: Array<{ entryType: string; propertyId: number }> };
  const dismissPropertyEntries = dismissPropertyBody.timeline.filter((e) => e.entryType === "property_intelligence_signal_dismissed");
  assert.equal(dismissPropertyEntries.length, 1);
  assert.equal(dismissPropertyEntries[0].propertyId, dismissPropertyId);

  // --- signal promoted ---
  const promotePropertyId = await createProperty(cookie, `10c Timeline Promote St ${suffix}`);
  const { partyId: promotePartyId } = await createLongTenureOwner(cookie, promotePropertyId);
  const { signals: promoteSignals } = await recalculate(cookie, promotePropertyId);
  const promoteSignalId = promoteSignals[0].id;
  const promoteActionRes = await fetch(piUrl(`/signals/${promoteSignalId}/promote`), { method: "POST", headers: { cookie } });
  assert.equal(promoteActionRes.status, 200);
  const { opportunityId: promotedOpportunityId } = (await promoteActionRes.json()) as { opportunityId: number };

  const promoteContactRes = await getContactTimeline(promotePartyId, cookie);
  const promoteContactBody = (await promoteContactRes.json()) as {
    timeline: Array<{ type: string; propertyId: number | null; sourceType: string; sourceId: number; opportunityId: number | null }>;
  };
  const promoteContactSignalEvents = promoteContactBody.timeline.filter((e) => e.sourceType === "property_intelligence_signal");
  assert.equal(promoteContactSignalEvents.length, 1);
  assert.equal(promoteContactSignalEvents[0].type, "PROPERTY_INTELLIGENCE_SIGNAL_PROMOTED");
  assert.equal(promoteContactSignalEvents[0].sourceId, promoteSignalId);
  assert.equal(promoteContactSignalEvents[0].opportunityId, promotedOpportunityId);

  const promotePropertyRes = await getPropertyTimelineHttp(promotePropertyId, cookie);
  const promotePropertyBody = (await promotePropertyRes.json()) as { timeline: Array<{ entryType: string; propertyId: number }> };
  const promotePropertyEntries = promotePropertyBody.timeline.filter((e) => e.entryType === "property_intelligence_signal_promoted");
  assert.equal(promotePropertyEntries.length, 1);
  assert.equal(promotePropertyEntries[0].propertyId, promotePropertyId);

  // --- a merely-Active signal (never reviewed/dismissed/promoted) raises no event on either
  // surface — the "no technical refresh noise, only meaningful business events" requirement.
  const activeOnlyPropertyId = await createProperty(cookie, `10d Timeline Active Only St ${suffix}`);
  const { partyId: activeOnlyPartyId } = await createLongTenureOwner(cookie, activeOnlyPropertyId);
  await recalculate(cookie, activeOnlyPropertyId);

  const activeOnlyContactRes = await getContactTimeline(activeOnlyPartyId, cookie);
  const activeOnlyContactBody = (await activeOnlyContactRes.json()) as { timeline: Array<{ sourceType: string }> };
  assert.equal(
    activeOnlyContactBody.timeline.filter((e) => e.sourceType === "property_intelligence_signal").length,
    0,
    "an Active (not yet reviewed) signal must not appear on the Relationship Timeline",
  );

  const activeOnlyPropertyRes = await getPropertyTimelineHttp(activeOnlyPropertyId, cookie);
  const activeOnlyPropertyBody = (await activeOnlyPropertyRes.json()) as { timeline: Array<{ entryType: string }> };
  assert.equal(
    activeOnlyPropertyBody.timeline.filter((e) => e.entryType.startsWith("property_intelligence_signal_")).length,
    0,
    "an Active (not yet reviewed) signal must not appear on the Property Timeline either",
  );

  // --- match confirmed / rejected — Property Timeline only; matches have no partyId of their
  // own, so they are never expected on the Relationship Timeline (see relationshipTimeline.ts,
  // which never imports propertyExternalIdentifiers).
  const matchPropertyId = await createProperty(cookie, `10e Timeline Match St ${suffix}`);
  const toConfirm = await proposeMatch({
    brokerageId: A.brokerageId,
    propertyId: matchPropertyId,
    provider: "mock",
    externalId: `mock-ext-${suffix}-timeline-confirm`,
  });
  const toReject = await proposeMatch({
    brokerageId: A.brokerageId,
    propertyId: matchPropertyId,
    provider: "mock",
    externalId: `mock-ext-${suffix}-timeline-reject`,
  });
  const confirmActionRes = await fetch(piUrl(`/matches/${toConfirm.id}/confirm`), { method: "POST", headers: { cookie } });
  assert.equal(confirmActionRes.status, 200);
  const rejectActionRes = await fetch(piUrl(`/matches/${toReject.id}/reject`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ rejectedReason: "Timeline integration fixture." }),
  });
  assert.equal(rejectActionRes.status, 200);

  const matchPropertyRes = await getPropertyTimelineHttp(matchPropertyId, cookie);
  const matchPropertyBody = (await matchPropertyRes.json()) as { timeline: Array<{ entryType: string; propertyId: number }> };
  const confirmedEntries = matchPropertyBody.timeline.filter((e) => e.entryType === "property_intelligence_match_confirmed");
  const rejectedEntries = matchPropertyBody.timeline.filter((e) => e.entryType === "property_intelligence_match_rejected");
  assert.equal(confirmedEntries.length, 1);
  assert.equal(confirmedEntries[0].propertyId, matchPropertyId);
  assert.equal(rejectedEntries.length, 1);
  assert.equal(rejectedEntries[0].propertyId, matchPropertyId);

  // --- tenant isolation on both surfaces: brokerage B holds grow.contacts.read (granted in
  // before()) and every grow.propertyIntelligence.* key A has, so a 404 here can only be tenant
  // isolation, never an entitlement decision — the same discipline this file's other tenant
  // isolation checks already follow.
  const otherCookie = B.admin.cookie;
  const crossContactRes = await getContactTimeline(reviewPartyId, otherCookie);
  assert.equal(crossContactRes.status, 404);
  const crossPropertyRes = await getPropertyTimelineHttp(reviewPropertyId, otherCookie);
  assert.equal(crossPropertyRes.status, 404);
  const crossMatchPropertyRes = await getPropertyTimelineHttp(matchPropertyId, otherCookie);
  assert.equal(crossMatchPropertyRes.status, 404);

  // Brokerage A itself can still read both — proving the 404s above are tenant isolation, not a
  // broken fixture.
  const ownContactRes = await getContactTimeline(reviewPartyId, cookie);
  assert.equal(ownContactRes.status, 200);
  const ownPropertyRes = await getPropertyTimelineHttp(reviewPropertyId, cookie);
  assert.equal(ownPropertyRes.status, 200);
});
