// AE GROW "Brokerage-wide Signal Sweep" stage 3 — route-level regression
// coverage for PRIORITISATION, EXPLAINABILITY, THE DAILY COMMAND CENTRE and
// READ-TIME CONSENT (lib/growToday.ts + lib/grow/signalRanking.ts).
//
// A separate file from growToday.test.ts, following that file's own stated
// convention: each feature keeps its fixtures (specific signal shapes,
// specific consent rows, specific ranking inputs) self-contained and readable
// on their own. growToday.test.ts keeps Rules A-E's permanent regression
// coverage; this file owns stage 3's.
//
// EVERY TEST BELOW FAILS WITHOUT ITS FIX. That is the point of the file — the
// four defects it covers were all "the write path is correct and the read
// path silently discards it", which is exactly the class of bug that passes
// a unit test of the writer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import {
  db,
  entitlementGrants,
  growContactChannelSuppressions,
  growContactDncrStatuses,
  growOpportunitySignals,
  GROW_CONSENT_CHANNELS,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

const DAY = 24 * 60 * 60 * 1000;

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

  A = await createBrokerageWithUsers(baseUrl, `Signal Surface A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Signal Surface B ${suffix}`);

  for (const key of [
    "grow.access",
    "grow.relationships.manage",
    "grow.activities.manage",
    "grow.opportunities.manage",
    "grow.propertyIntelligence.read",
  ]) {
    await grant(A.brokerageId, key);
  }
  await grant(B.brokerageId, "grow.access");
  await grant(B.brokerageId, "grow.propertyIntelligence.read");
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

async function createProperty(cookie: string, address: string) {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

async function createParty(cookie: string, propertyId: number, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, role: "Buyer", firstName: "Test", lastName: "Contact", ...overrides }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  const { party } = (await res.json()) as { party: { id: number } };
  return party.id;
}

async function createOpportunity(cookie: string, body: Record<string, unknown>) {
  const res = await fetch(growUrl("/opportunities"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`create opportunity failed: ${res.status} ${await res.text()}`);
  const { opportunity } = (await res.json()) as { opportunity: { id: number } };
  return opportunity.id;
}

async function fetchToday(cookie: string) {
  const res = await fetch(growUrl("/today"), { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as any };
}

let signalSeq = 0;
async function insertSignal(values: Record<string, unknown>) {
  signalSeq += 1;
  const [row] = await db
    .insert(growOpportunitySignals)
    .values({
      title: "Long ownership tenure",
      signalType: "long_ownership_tenure",
      explanation: "Fixture explanation.",
      evidence: {},
      source: "internal",
      confidenceBand: "WorthReviewing",
      dedupeKey: `stage3-${suffix}-${signalSeq}`,
      ...values,
    } as any)
    .returning();
  return row;
}

/* =====================================================================
 * DEFECT 1 — party-less / property-less signals were silently dropped.
 * ===================================================================*/

test("stage 3 defect 1 — a signal with NO linked contact surfaces on Today (the old innerJoin(parties) deleted it from the read path)", async () => {
  const propertyId = await createProperty(A.agent.cookie, `1 Observation Only St ${suffix}`);
  // Exactly the shape lib/propertyIntelligence/evaluation.ts's
  // observationCandidates() produces: property-anchored, partyId NULL.
  const signal = await insertSignal({
    brokerageId: A.brokerageId,
    partyId: null,
    propertyId,
    signalType: "recent_nearby_sales_activity",
    title: "Recent nearby sales activity",
    explanation: "A provider observation recorded recent sales activity relevant to this property.",
    evidence: { observationId: 1, provider: "mock", observationType: "sales_history", payload: {} },
    source: "mock",
    sourceTimestamp: new Date(Date.now() - 5 * DAY),
    confidenceBand: "StrongIndicator",
  });

  const { status, body } = await fetchToday(A.agent.cookie);
  assert.equal(status, 200);
  const card = body.priorityActions.find((a: any) => a.id === `signal:${signal.id}`);
  assert.ok(card, "a signal with no linked contact must reach Today — stage 1 deliberately allows it to exist");
  assert.equal(card.partyId, null);
  assert.equal(card.propertyId, propertyId);
  assert.equal(card.contactName, `1 Observation Only St ${suffix}`, "a contact-less card is named by its property, never 'Unknown contact'");
  // No contact means no contact-anchored affordance may be offered.
  assert.ok(!card.availableActions.some((b: any) => b.action === "view_contact"));
  assert.ok(!card.availableActions.some((b: any) => b.action === "email"));
  assert.ok(!card.availableActions.some((b: any) => b.action === "sms"));
  assert.ok(!card.availableActions.some((b: any) => b.action === "add_note"));
  assert.ok(card.availableActions.some((b: any) => b.action === "view_property" && b.propertyId === propertyId));
});

test("stage 3 defect 1 — a PARTY-anchored signal with no property at all surfaces on Today (the future-seller-without-a-property case stage 1 was built for)", async () => {
  const anchorPropertyId = await createProperty(A.agent.cookie, `2 Anchor Only St ${suffix}`);
  const partyId = await createParty(A.agent.cookie, anchorPropertyId, { firstName: "Priya", lastName: "NoProperty" });

  const signal = await insertSignal({
    brokerageId: A.brokerageId,
    partyId,
    // The whole point: prospecting starts with a PERSON, not a property.
    propertyId: null,
    signalType: "past_buyer_interest",
    title: "Past buyer interest, not yet followed up",
    explanation:
      "This contact was recorded as an interested buyer, but no opportunity has been created for them yet and no property is linked to that interest.",
    evidence: { relationshipId: 1, relationshipType: "prospective_buyer" },
    confidenceBand: "Emerging",
  });

  const { body } = await fetchToday(A.agent.cookie);
  const card = body.priorityActions.find((a: any) => a.id === `signal:${signal.id}`);
  assert.ok(card, "a party-anchored, property-less signal must reach Today");
  assert.equal(card.partyId, partyId);
  assert.equal(card.propertyId, null);
  assert.equal(card.contactName, "Priya NoProperty");
  assert.ok(card.availableActions.some((b: any) => b.action === "view_contact" && b.partyId === partyId));
  assert.ok(!card.availableActions.some((b: any) => b.action === "view_property"));
});

/* =====================================================================
 * DEFECT 2 — signals were stranded behind every dated item by dueAt: null.
 * ===================================================================*/

test("stage 3 defect 2 — a strong signal is NOT stranded behind a dated item in the same band; ordering is by rank, with the priority band still decided first", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Signal Ordering ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.opportunities.manage");
    await grant(fresh.brokerageId, "grow.propertyIntelligence.read");

    // A DATED Do Today item: an opportunity whose next action falls today.
    const datedPropertyId = await createProperty(fresh.agent.cookie, `3 Dated Today St ${suffix}`);
    const datedPartyId = await createParty(fresh.agent.cookie, datedPropertyId, { firstName: "Dana", lastName: "Dated" });
    const datedOppId = await createOpportunity(fresh.agent.cookie, {
      partyId: datedPartyId,
      propertyId: datedPropertyId,
      opportunityType: "Listing",
      reason: "Dated Do Today fixture.",
    });
    const patchRes = await fetch(growUrl(`/opportunities/${datedOppId}`), {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: fresh.agent.cookie },
      body: JSON.stringify({ nextActionDueAt: new Date().toISOString() }),
    });
    assert.equal(patchRes.status, 200);

    // An UNDATED but strongly-evidenced signal: a stale appraisal the
    // homeowner themselves invited, 120 days overdue.
    const signalPropertyId = await createProperty(fresh.agent.cookie, `4 Strong Signal St ${suffix}`);
    const signalPartyId = await createParty(fresh.agent.cookie, signalPropertyId, { firstName: "Stella", lastName: "Strong" });
    const strongSignal = await insertSignal({
      brokerageId: fresh.brokerageId,
      partyId: signalPartyId,
      propertyId: signalPropertyId,
      signalType: "stale_previous_appraisal",
      title: "Stale previous appraisal",
      explanation: "An appraisal follow-up on this property is overdue (120 days) — worth a check-in.",
      evidence: { appraisalId: 1, status: "FOLLOW_UP", outcome: null, overdueDays: 120 },
      confidenceBand: "StrongIndicator",
    });

    const { body } = await fetchToday(fresh.agent.cookie);
    const datedCard = body.priorityActions.find((a: any) => a.id === `opportunity:${datedOppId}`);
    const signalCard = body.priorityActions.find((a: any) => a.id === `signal:${strongSignal.id}`);
    assert.ok(datedCard && signalCard);
    assert.equal(datedCard.priority, "DoToday");
    assert.equal(signalCard.priority, "DoToday", "a strongly-evidenced signal earns a Do Today card");

    // The defect: with dueAt null, the signal used to sort behind EVERY dated
    // item in its band unconditionally. It now wins on rank.
    assert.ok(
      signalCard.rankScore > datedCard.rankScore,
      `expected the strong signal to outrank the dated item (signal ${signalCard.rankScore} vs dated ${datedCard.rankScore})`,
    );
    const signalIndex = body.priorityActions.findIndex((a: any) => a.id === `signal:${strongSignal.id}`);
    const datedIndex = body.priorityActions.findIndex((a: any) => a.id === `opportunity:${datedOppId}`);
    assert.ok(signalIndex < datedIndex, "the higher-ranked signal must appear before the lower-ranked dated item");

    // ...but the band itself is still decided first, so nothing can jump a
    // Do Now commitment the agent already made.
    const priorityOrder: Record<string, number> = { DoNow: 0, DoToday: 1, KeepWarm: 2 };
    for (let i = 1; i < body.priorityActions.length; i++) {
      assert.ok(
        priorityOrder[body.priorityActions[i - 1].priority] <= priorityOrder[body.priorityActions[i].priority],
        "the returned list must remain sorted by priority band end to end",
      );
    }
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("stage 3 defect 2 — a signal is NEVER promoted to Do Now, however strong: Do Now is reserved for a dated commitment the agent already made", async () => {
  const propertyId = await createProperty(A.agent.cookie, `5 Never Do Now St ${suffix}`);
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Nora", lastName: "NeverDoNow" });
  const signal = await insertSignal({
    brokerageId: A.brokerageId,
    partyId,
    propertyId,
    signalType: "stale_previous_appraisal",
    title: "Stale previous appraisal",
    explanation: "Maximal-evidence fixture.",
    evidence: { appraisalId: 2, status: "FOLLOW_UP", outcome: null, overdueDays: 9999 },
    confidenceBand: "StrongIndicator",
    reRaiseCount: 5,
  });

  const { body } = await fetchToday(A.agent.cookie);
  const card = body.priorityActions.find((a: any) => a.id === `signal:${signal.id}`);
  assert.ok(card);
  assert.notEqual(card.priority, "DoNow", "an inference must never outrank a promise a human actually made");
  assert.equal(card.priority, "DoToday");
  assert.ok(card.rankScore <= 100, "the score is bounded");
});

/* =====================================================================
 * DEFECT 3 — the Emerging band was filtered out entirely.
 * ===================================================================*/

test("stage 3 defect 3 — Emerging-band signals surface (ranked below stronger bands) and the daily cap reports what it held back instead of silently dropping it", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Signal Emerging ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.propertyIntelligence.read");

    const propertyId = await createProperty(fresh.agent.cookie, `6 Emerging St ${suffix}`);
    // 14 Emerging signals against a cap of 10.
    const emergingIds: number[] = [];
    for (let i = 0; i < 14; i++) {
      const partyId = await createParty(fresh.agent.cookie, propertyId, { firstName: `Em${i}`, lastName: "Emerging" });
      const row = await insertSignal({
        brokerageId: fresh.brokerageId,
        partyId,
        propertyId: null,
        signalType: "past_buyer_interest",
        title: "Past buyer interest, not yet followed up",
        explanation: "Emerging fixture.",
        evidence: { relationshipId: 100 + i, relationshipType: "prospective_buyer" },
        confidenceBand: "Emerging",
      });
      emergingIds.push(row.id);
    }
    const strongPartyId = await createParty(fresh.agent.cookie, propertyId, { firstName: "Stan", lastName: "Strong" });
    const strong = await insertSignal({
      brokerageId: fresh.brokerageId,
      partyId: strongPartyId,
      propertyId,
      signalType: "long_ownership_tenure",
      explanation: "Strong fixture.",
      evidence: { relationshipId: 1, relationshipType: "owner", approximateTenureYears: 14 },
      confidenceBand: "StrongIndicator",
    });

    const { body } = await fetchToday(fresh.agent.cookie);

    assert.equal(body.signalSummary.emergingSurfaced, 10, "the Emerging cap surfaces the top 10");
    assert.equal(body.signalSummary.emergingWithheld, 4, "and reports the remainder rather than discarding it invisibly");
    assert.equal(body.signalSummary.withheldDoNotContact, 0);
    assert.equal(body.signalSummary.surfaced, 11, "10 Emerging + the StrongIndicator");

    const surfacedEmerging = body.priorityActions.filter(
      (a: any) => a.type === "property_intelligence_signal" && a.confidenceBand === "Emerging",
    );
    assert.equal(surfacedEmerging.length, 10);
    for (const card of surfacedEmerging) {
      assert.equal(card.priority, "KeepWarm", "Emerging is surfaced quietly — it is a nurture prompt, not today's work");
    }

    const strongCard = body.priorityActions.find((a: any) => a.id === `signal:${strong.id}`);
    assert.ok(strongCard);
    assert.equal(strongCard.priority, "DoToday");
    for (const card of surfacedEmerging) {
      assert.ok(strongCard.rankScore > card.rankScore, "every Emerging signal must rank below the StrongIndicator one");
    }
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

/* =====================================================================
 * DEFECT 4 — no prioritisation, and no explanation an agent can use.
 * ===================================================================*/

test("stage 3 defect 4 — every surfaced signal carries an agent-readable explanation derived from its stored evidence, and the score is never surfaced without its factors", async () => {
  const propertyId = await createProperty(A.agent.cookie, `7 Explain St ${suffix}`);
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Xavier", lastName: "Explain" });
  const signal = await insertSignal({
    brokerageId: A.brokerageId,
    partyId,
    propertyId,
    signalType: "long_ownership_tenure",
    explanation: "This contact has been recorded as the owner of this property for approximately 11 years.",
    // The number 11 lives ONLY in the evidence blob — proving the narrative is
    // genuinely derived from stored evidence rather than hard-coded.
    evidence: { relationshipId: 7, relationshipType: "owner", validFrom: "2015-01-01T00:00:00.000Z", approximateTenureYears: 11 },
    confidenceBand: "StrongIndicator",
    reRaiseCount: 2,
  });

  const { body } = await fetchToday(A.agent.cookie);
  const card = body.priorityActions.find((a: any) => a.id === `signal:${signal.id}`);
  assert.ok(card);

  const why = card.whyItMatters;
  assert.ok(why, "a surfaced signal without an explanation is not acceptable — a bare score is not an explanation");
  assert.equal(why.confidenceBand, "StrongIndicator");
  assert.equal(why.confidenceBandLabel, "Strong indicator");

  // Derived from evidence.approximateTenureYears.
  assert.match(why.headline, /11 years/, "the headline must be built from the signal's own stored evidence");
  // Something the agent can actually say — and phrased as a question, never
  // as a claim about the homeowner's intentions.
  assert.ok(typeof why.talkingPoint === "string" && why.talkingPoint.length > 0);
  assert.match(why.talkingPoint, /\?/, "a talking point must be a question the agent may choose to ask, never an assertion");
  assert.match(why.talkingPoint, new RegExp(`7 Explain St ${suffix}`), "the talking point is made concrete with the real property");
  // The limit of what AE knows is always stated.
  assert.match(why.caution, /no information about this contact's private intentions/i);

  // The score is itemised, not opaque.
  assert.ok(Array.isArray(why.factors) && why.factors.length >= 4, "the rank must be itemised into the factors that produced it");
  const labels = why.factors.map((f: any) => f.label).join(" | ");
  assert.match(labels, /Evidence strength: Strong indicator/);
  assert.match(labels, /Owned for about 11 years/, "the per-rule evidence depth factor must read from the evidence blob");
  assert.match(labels, /Raised again after a previous decision \(2×\)/, "re_raise_count is a genuine ranking input");
  assert.match(labels, /No open opportunity/, "existing relationship state is a genuine ranking input");
  assert.ok(
    why.factors.every((f: any) => typeof f.detail === "string" && f.detail.length > 0),
    "every factor explains itself in prose, not just a number",
  );
  assert.ok(typeof card.rankScore === "number" && card.rankScore > 0 && card.rankScore <= 100);
});

test("stage 3 defect 4 — nearby-activity signals rank BELOW relationship signals, so Grow Today cannot become an area-activity alert engine", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Signal Area ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.propertyIntelligence.read");

    const areaPropertyId = await createProperty(fresh.agent.cookie, `8 Area Activity St ${suffix}`);
    const areaSignal = await insertSignal({
      brokerageId: fresh.brokerageId,
      partyId: null,
      propertyId: areaPropertyId,
      signalType: "recent_nearby_sales_activity",
      title: "Recent nearby sales activity",
      explanation: "A provider observation recorded recent sales activity relevant to this property.",
      evidence: { observationId: 9, provider: "mock", observationType: "sales_history", payload: {} },
      source: "mock",
      // Deliberately as fresh as possible, so freshness cannot be the reason
      // it loses.
      sourceTimestamp: new Date(),
      confidenceBand: "StrongIndicator",
    });

    const ownerPropertyId = await createProperty(fresh.agent.cookie, `9 Real Owner St ${suffix}`);
    const ownerPartyId = await createParty(fresh.agent.cookie, ownerPropertyId, { firstName: "Olive", lastName: "Owner" });
    const ownerSignal = await insertSignal({
      brokerageId: fresh.brokerageId,
      partyId: ownerPartyId,
      propertyId: ownerPropertyId,
      signalType: "long_ownership_tenure",
      explanation: "Long tenure fixture.",
      evidence: { relationshipId: 3, relationshipType: "owner", approximateTenureYears: 12 },
      // Deliberately the SAME band, so the comparison isolates signal type.
      confidenceBand: "StrongIndicator",
    });

    const { body } = await fetchToday(fresh.agent.cookie);
    const areaCard = body.priorityActions.find((a: any) => a.id === `signal:${areaSignal.id}`);
    const ownerCard = body.priorityActions.find((a: any) => a.id === `signal:${ownerSignal.id}`);
    assert.ok(areaCard && ownerCard);
    assert.ok(
      ownerCard.rankScore > areaCard.rankScore,
      `a relationship with a real owner must outrank what the neighbours are doing (owner ${ownerCard.rankScore} vs area ${areaCard.rankScore})`,
    );
    assert.equal(areaCard.priority, "KeepWarm", "area activity is background context, never today's work");
    // And the copy itself says so, in the agent's own language.
    assert.match(areaCard.whyItMatters.headline, /not a reason to contact anyone/i);
    assert.equal(areaCard.whyItMatters.talkingPoint, null, "AE offers nothing to say about a neighbour's sale");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

/* =====================================================================
 * SECURITY FINDING P1-3 — contactability was enforced only at raise time.
 * ===================================================================*/

test("finding P1-3 — a signal raised BEFORE the contact was recorded DNC LISTED is withheld from Today, and no email/mobile for that contact is returned anywhere in the response", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Signal DNC ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.propertyIntelligence.read");

    const propertyId = await createProperty(fresh.agent.cookie, `10 DNC Later St ${suffix}`);
    const partyId = await createParty(fresh.agent.cookie, propertyId, {
      firstName: "Dennis",
      lastName: "DoNotCall",
      email: `dennis-dnc-${suffix}@example.com`,
      mobile: "+61400000111",
    });

    // STEP 1 — no consent rows exist, so the sweep legitimately raises an
    // Active signal. expiresAt is NULL, exactly as every internal rule sets it.
    const signal = await insertSignal({
      brokerageId: fresh.brokerageId,
      partyId,
      propertyId,
      signalType: "long_ownership_tenure",
      explanation: "Raised while the contact had no consent records at all.",
      evidence: { relationshipId: 11, relationshipType: "owner", approximateTenureYears: 12 },
      confidenceBand: "StrongIndicator",
      expiresAt: null,
    });

    const beforeDnc = await fetchToday(fresh.agent.cookie);
    const cardBefore = beforeDnc.body.priorityActions.find((a: any) => a.id === `signal:${signal.id}`);
    assert.ok(cardBefore, "with no consent rows on file the signal is surfaced normally — that is the pre-condition of the defect");
    assert.equal(cardBefore.contactEmail, `dennis-dnc-${suffix}@example.com`);

    // STEP 2 — the contact goes on the Do Not Call register. Nothing retires
    // the existing row: the sweep drops the candidate before the write, keeps
    // it in its `supported` set so expireUnsupportedSignals leaves it alone,
    // and expires_at IS NULL so the expiry pass cannot touch it either. The
    // row is frozen Active forever.
    await db.insert(growContactDncrStatuses).values({
      brokerageId: fresh.brokerageId,
      partyId,
      channel: "PHONE_CALL",
      status: "LISTED",
      source: "test-fixture",
      recordedByUserId: fresh.agent.user.id,
    });

    const afterDnc = await fetchToday(fresh.agent.cookie);
    assert.equal(afterDnc.status, 200);
    assert.ok(
      !afterDnc.body.priorityActions.some((a: any) => a.id === `signal:${signal.id}`),
      "a signal for a DNC-listed contact must not be surfaced, whenever it was raised",
    );
    // Nothing about this contact leaks through any other rule either.
    assert.ok(
      !afterDnc.body.priorityActions.some((a: any) => a.partyId === partyId),
      "a DNC-listed contact must not be surfaced as a prospect by any rule",
    );
    const serialised = JSON.stringify(afterDnc.body);
    assert.ok(!serialised.includes(`dennis-dnc-${suffix}@example.com`), "the contact's email must not appear anywhere in the response");
    assert.ok(!serialised.includes("+61400000111"), "the contact's mobile must not appear anywhere in the response");
    assert.ok(!serialised.includes("DoNotCall"), "the contact's name must not appear anywhere in the response");

    // The row itself is untouched — "hide, never silently retire their
    // history" is the sweep's own stated design, and this is the half of it
    // that was missing.
    const [stored] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, signal.id));
    assert.equal(stored.status, "Active", "hiding on the read path must not mutate or retire the signal row");

    // And Today is honest that something was held back.
    assert.equal(afterDnc.body.signalSummary.withheldDoNotContact, 1);
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("finding P1-3 — a contact suppressed on EVERY channel is withheld too, while a PARTIAL suppression deliberately changes nothing", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Signal Suppression ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.propertyIntelligence.read");

    const propertyId = await createProperty(fresh.agent.cookie, `11 Suppressed St ${suffix}`);
    const fullyPartyId = await createParty(fresh.agent.cookie, propertyId, {
      firstName: "Fiona",
      lastName: "FullySuppressed",
      email: `fiona-full-${suffix}@example.com`,
    });
    const partialPartyId = await createParty(fresh.agent.cookie, propertyId, {
      firstName: "Pat",
      lastName: "PartiallySuppressed",
      email: `pat-partial-${suffix}@example.com`,
    });

    const fullySignal = await insertSignal({
      brokerageId: fresh.brokerageId,
      partyId: fullyPartyId,
      propertyId,
      explanation: "Fully suppressed fixture.",
      evidence: { relationshipId: 21, relationshipType: "owner", approximateTenureYears: 9 },
      confidenceBand: "StrongIndicator",
    });
    const partialSignal = await insertSignal({
      brokerageId: fresh.brokerageId,
      partyId: partialPartyId,
      propertyId,
      explanation: "Partially suppressed fixture.",
      evidence: { relationshipId: 22, relationshipType: "owner", approximateTenureYears: 9 },
      confidenceBand: "StrongIndicator",
    });

    for (const channel of GROW_CONSENT_CHANNELS) {
      await db.insert(growContactChannelSuppressions).values({
        brokerageId: fresh.brokerageId,
        partyId: fullyPartyId,
        channel,
        state: "SUPPRESSED",
        reason: "test fixture: suppressed everywhere",
        recordedByUserId: fresh.agent.user.id,
      });
    }
    // SMS only. The agent can still reach this contact another way, so
    // withholding would lose information they are entitled to see.
    await db.insert(growContactChannelSuppressions).values({
      brokerageId: fresh.brokerageId,
      partyId: partialPartyId,
      channel: "SMS",
      state: "SUPPRESSED",
      reason: "test fixture: one channel only",
      recordedByUserId: fresh.agent.user.id,
    });

    const { body } = await fetchToday(fresh.agent.cookie);
    assert.ok(
      !body.priorityActions.some((a: any) => a.id === `signal:${fullySignal.id}`),
      "a contact suppressed on every channel must be withheld",
    );
    assert.ok(!JSON.stringify(body).includes(`fiona-full-${suffix}@example.com`));

    const partialCard = body.priorityActions.find((a: any) => a.id === `signal:${partialSignal.id}`);
    assert.ok(partialCard, "a partial suppression must NOT hide the signal — that is the documented stage 1 rule");
    assert.equal(partialCard.contactability, "contactable");
    assert.equal(partialCard.contactEmail, `pat-partial-${suffix}@example.com`);
    assert.equal(body.signalSummary.withheldDoNotContact, 1);
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("finding P1-3 — an agent's own dated commitment for a do-not-contact person is still shown, but never as outreach: no email/mobile, no channel buttons, and the recommendation is replaced", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Signal DNC Commitment ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.opportunities.manage");

    const propertyId = await createProperty(fresh.agent.cookie, `12 Owed A Callback St ${suffix}`);
    const partyId = await createParty(fresh.agent.cookie, propertyId, {
      firstName: "Cara",
      lastName: "Committed",
      email: `cara-committed-${suffix}@example.com`,
      mobile: "+61400000222",
    });
    const oppId = await createOpportunity(fresh.agent.cookie, {
      partyId,
      propertyId,
      opportunityType: "Listing",
      reason: "The agent promised this person a callback.",
    });
    await fetch(growUrl(`/opportunities/${oppId}`), {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: fresh.agent.cookie },
      body: JSON.stringify({ nextActionDueAt: new Date(Date.now() - 3 * DAY).toISOString(), recommendedNextAction: "Ring Cara back." }),
    });

    await db.insert(growContactDncrStatuses).values({
      brokerageId: fresh.brokerageId,
      partyId,
      channel: "PHONE_CALL",
      status: "LISTED",
      source: "test-fixture",
      recordedByUserId: fresh.agent.user.id,
    });

    const { body } = await fetchToday(fresh.agent.cookie);
    const card = body.priorityActions.find((a: any) => a.id === `opportunity:${oppId}`);
    assert.ok(card, "an obligation a human actually made is not deleted by a suppression — the agent must be able to see it");
    assert.equal(card.contactability, "do_not_contact");
    assert.ok(typeof card.contactabilityNote === "string" && card.contactabilityNote.length > 0);
    assert.equal(card.contactEmail, null, "the API itself withholds the channel, so no frontend can render an affordance for it");
    assert.equal(card.contactMobile, null);
    assert.ok(!card.availableActions.some((b: any) => b.action === "email"));
    assert.ok(!card.availableActions.some((b: any) => b.action === "sms"));
    assert.ok(card.availableActions.some((b: any) => b.action === "view_contact"), "reviewing the record is still allowed, and is the point");
    assert.match(card.recommendedAction, /Do not contact/i);
    assert.ok(!card.recommendedAction.includes("Ring Cara back."), "the agent's own outreach instruction must not be echoed back");
    assert.equal(card.rankScore, 0, "a do-not-contact item is pinned to the bottom of its band");
    assert.ok(!JSON.stringify(body).includes(`cara-committed-${suffix}@example.com`));
    assert.ok(!JSON.stringify(body).includes("+61400000222"));
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

/* =====================================================================
 * Tenant isolation.
 * ===================================================================*/

test("stage 3 — signals are never read across brokerages, and a cross-tenant party id can never contribute a name or contact detail", async () => {
  const propertyA = await createProperty(A.agent.cookie, `13 Tenant A St ${suffix}`);
  const partyA = await createParty(A.agent.cookie, propertyA, {
    firstName: "Tanya",
    lastName: "TenantA",
    email: `tanya-a-${suffix}@example.com`,
  });
  const aSignal = await insertSignal({
    brokerageId: A.brokerageId,
    partyId: partyA,
    propertyId: propertyA,
    explanation: "Brokerage A's own signal.",
    evidence: { relationshipId: 31, relationshipType: "owner", approximateTenureYears: 10 },
    confidenceBand: "StrongIndicator",
  });

  // A row owned by brokerage B that POINTS AT brokerage A's party. The old
  // innerJoin had no tenant predicate at all, so the name/email would have
  // been joined in; the leftJoin now carries eq(parties.brokerageId, ...).
  const bSignal = await insertSignal({
    brokerageId: B.brokerageId,
    partyId: partyA,
    propertyId: null,
    explanation: "Cross-tenant pointer fixture.",
    evidence: { relationshipId: 32, relationshipType: "owner", approximateTenureYears: 10 },
    confidenceBand: "StrongIndicator",
  });

  const bToday = await fetchToday(B.agent.cookie);
  assert.equal(bToday.status, 200);
  assert.ok(
    !bToday.body.priorityActions.some((a: any) => a.id === `signal:${aSignal.id}`),
    "brokerage B must never see brokerage A's signal",
  );
  const leaked = JSON.stringify(bToday.body);
  assert.ok(!leaked.includes(`tanya-a-${suffix}@example.com`), "a cross-tenant party id must not contribute an email");
  assert.ok(!leaked.includes("TenantA"), "a cross-tenant party id must not contribute a name");
  const bCard = bToday.body.priorityActions.find((a: any) => a.id === `signal:${bSignal.id}`);
  assert.ok(bCard, "B's own row is still returned — it is just joined to nothing");
  assert.equal(bCard.contactEmail, null);
  assert.equal(bCard.contactMobile, null);

  const aToday = await fetchToday(A.agent.cookie);
  assert.ok(
    !aToday.body.priorityActions.some((a: any) => a.id === `signal:${bSignal.id}`),
    "and brokerage A must never see brokerage B's signal, even though it names A's party",
  );
});

test("stage 3 — signalSummary is always present and all-zero when the caller has no grow.propertyIntelligence.read", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Signal Unentitled ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const propertyId = await createProperty(fresh.agent.cookie, `14 Unentitled St ${suffix}`);
    const partyId = await createParty(fresh.agent.cookie, propertyId, { firstName: "Una", lastName: "Unentitled" });
    await insertSignal({
      brokerageId: fresh.brokerageId,
      partyId,
      propertyId,
      explanation: "Should never be visible without the entitlement.",
      evidence: { relationshipId: 41, relationshipType: "owner", approximateTenureYears: 20 },
      confidenceBand: "StrongIndicator",
    });

    const { body } = await fetchToday(fresh.agent.cookie);
    // W2-A extends this summary with consolidatedIntoStrongerSignal,
    // withheldByActionCap and limitations. The assertion is still EXHAUSTIVE
    // on purpose — that is what makes it catch a field quietly appearing with
    // a non-zero value for an unentitled caller — so the new fields are listed
    // here with the same all-zero expectation the original four carry.
    assert.deepEqual(body.signalSummary, {
      surfaced: 0,
      emergingSurfaced: 0,
      emergingWithheld: 0,
      withheldDoNotContact: 0,
      consolidatedIntoStrongerSignal: 0,
      withheldByActionCap: 0,
      limitations: [],
    });
    assert.ok(!body.priorityActions.some((a: any) => a.type === "property_intelligence_signal"));
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});
