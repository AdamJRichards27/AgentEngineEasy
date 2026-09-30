// AE GROW COMPLETION PROGRAM — SLICE W2-A. Route-level regression coverage for
// GROW TODAY'S BOUNDS, ITS PER-PARTY SIGNAL CONSOLIDATION (the Project Owner's
// DECISION 3) and the evidence that has to survive both.
//
// A third Grow Today file, following the convention the first two already set
// (growToday.test.ts owns Rules A-E, growSignalSurface.test.ts owns the signal
// sweep's stage 3): each feature keeps the fixtures it needs self-contained
// and readable on their own, rather than threading a fourth concern through a
// file whose narrative is already about something else.
//
// WHAT THIS FILE IS ACTUALLY PROTECTING. Every test below fails without its
// fix, and every one of them covers a defect whose symptom is INVISIBLE in a
// small fixture and catastrophic in a real brokerage:
//
//   - one person appearing on the day twice because two rules both had
//     something to say about them, with no rule for which one wins;
//   - a cap that silently deletes evidence instead of reporting it;
//   - a card order that changes between two identical requests, because a
//     comparator tie fell through to whatever order Postgres returned;
//   - a de-duplication that "works" by collapsing every property-anchored
//     signal in the tenant into one phantom card.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { db, entitlementGrants, growOpportunitySignals, growRelationships, parties } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { MAX_PRIORITY_ACTIONS } from "../../lib/growToday.js";
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

  A = await createBrokerageWithUsers(baseUrl, `W2A Consolidation A ${suffix}`);
  for (const key of [
    "grow.access",
    "grow.relationships.manage",
    "grow.properties.link",
    "grow.activities.manage",
    "grow.opportunities.manage",
    "grow.propertyIntelligence.read",
  ]) {
    await grant(A.brokerageId, key);
  }
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId]);
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

async function createRelationship(cookie: string, body: Record<string, unknown>) {
  const res = await fetch(growUrl("/relationships"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`create relationship failed: ${res.status} ${await res.text()}`);
  const { relationship } = (await res.json()) as { relationship: { id: number } };
  return relationship.id;
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
      brokerageId: A.brokerageId,
      title: "Long ownership tenure",
      signalType: "long_ownership_tenure",
      explanation: "Fixture explanation.",
      evidence: {},
      source: "internal",
      confidenceBand: "WorthReviewing",
      dedupeKey: `w2a-${suffix}-${signalSeq}`,
      ...values,
    } as any)
    .returning();
  return row;
}

/* =====================================================================
 * F-3 / DECISION 3 — ONE PERSON, ONE CARD, WITH THE EVIDENCE PRESERVED.
 * ===================================================================*/

test("F-3 — two qualifying signals for the SAME contact produce exactly ONE card, and the losing signal rides on it as evidence rather than disappearing", async () => {
  // The exact shape DECISION 3 describes and the exact shape that produced two
  // cards before this change: a long-tenure owner who has also gone dormant
  // long enough for the re-engagement rule to fire. Both signals are genuinely
  // about this one person, and before W2-A the read path ranked and emitted
  // each of them independently — `partyIdsWithOpportunityAction` suppressed
  // only Rule D, never a sibling signal.
  const propertyId = await createProperty(A.agent.cookie, `1 Two Signals One Person St ${suffix}`);
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Dora", lastName: "DoubleSignal" });

  const strong = await insertSignal({
    partyId,
    propertyId,
    signalType: "long_ownership_tenure",
    title: "Long ownership tenure",
    explanation: "Recorded as the owner of this property for approximately 14 years.",
    evidence: { approximateTenureYears: 14 },
    confidenceBand: "StrongIndicator",
  });
  const weaker = await insertSignal({
    partyId,
    propertyId: null,
    signalType: "re_engagement_opportunity",
    title: "Long-dormant contact worth re-engaging",
    explanation: "The last contact of any kind recorded with this person was about 7 months ago.",
    evidence: { dormantDays: 210 },
    confidenceBand: "WorthReviewing",
  });

  const { status, body } = await fetchToday(A.agent.cookie);
  assert.equal(status, 200);

  const cardsForParty = body.priorityActions.filter((a: any) => a.partyId === partyId);
  assert.equal(
    cardsForParty.length,
    1,
    "DECISION 3: a contact with two qualifying signals must surface ONE best item, never one card per signal",
  );

  const [card] = cardsForParty;
  assert.equal(card.id, `signal:${strong.id}`, "the higher-scoring signal is the card");
  assert.ok(!body.priorityActions.some((a: any) => a.id === `signal:${weaker.id}`), "the weaker sibling must not also emit its own card");

  // ...AND THE EVIDENCE SURVIVES. This is the half of DECISION 3 that a naive
  // "keep the best, drop the rest" implementation silently fails: the Owner
  // asked for one item WITH the evidence preserved, so AE can explain why this
  // is the card and not the other one.
  const related = card.whyItMatters?.relatedSignals ?? [];
  assert.equal(related.length, 1, "the losing signal must be carried on the winning card, not discarded");
  assert.equal(related[0].signalId, weaker.id);
  assert.equal(related[0].signalType, "re_engagement_opportunity");
  assert.equal(related[0].relationship, "consolidated_into_this_card");
  assert.equal(
    related[0].explanation,
    "The last contact of any kind recorded with this person was about 7 months ago.",
    "the sibling's own stored explanation is preserved verbatim, never re-worded by the read path",
  );
  assert.ok(related[0].rankScore > 0, "the sibling keeps the score it earned, so the choice between them is auditable");

  assert.ok(
    body.signalSummary.consolidatedIntoStrongerSignal >= 1,
    "a merged signal is reported as merged, so the surface can say nobody appears twice",
  );
});

test("F-3 — PARTY-LESS signals are never collapsed into one another: each property-anchored signal keeps its own card", async () => {
  // THE TRAP THIS EXISTS TO CATCH. Grouping signals by partyId to pick one per
  // person folds every signal whose partyId is NULL into a single "null"
  // bucket and keeps exactly one of them — deleting every other
  // property-anchored signal in the brokerage. Those signals are anchored to
  // DIFFERENT PROPERTIES and are not "the same person" in any sense; there is
  // no person at all.
  const propertyOne = await createProperty(A.agent.cookie, `2 Phantom Bucket One St ${suffix}`);
  const propertyTwo = await createProperty(A.agent.cookie, `3 Phantom Bucket Two St ${suffix}`);
  const propertyThree = await createProperty(A.agent.cookie, `4 Phantom Bucket Three St ${suffix}`);

  const partyLess = [];
  for (const propertyId of [propertyOne, propertyTwo, propertyThree]) {
    partyLess.push(
      await insertSignal({
        partyId: null,
        propertyId,
        signalType: "recent_nearby_sales_activity",
        title: "Recent nearby sales activity",
        explanation: "A provider observation recorded recent sales activity relevant to this property.",
        evidence: { observationId: 1, provider: "mock", observationType: "sales_history", payload: {} },
        source: "mock",
        sourceTimestamp: new Date(Date.now() - 3 * DAY),
        confidenceBand: "StrongIndicator",
      }),
    );
  }

  const { body } = await fetchToday(A.agent.cookie);
  for (const signal of partyLess) {
    const card = body.priorityActions.find((a: any) => a.id === `signal:${signal.id}`);
    assert.ok(card, `party-less signal ${signal.id} must keep its own card — it is about a property, not a person`);
    assert.equal(card.partyId, null);
    assert.deepEqual(
      card.whyItMatters.relatedSignals,
      [],
      "a party-less signal never consolidates anything, because it never entered the grouping",
    );
  }

  const partyLessCards = body.priorityActions.filter((a: any) => a.type === "property_intelligence_signal" && a.partyId === null);
  assert.ok(
    partyLessCards.length >= 3,
    "all three property-anchored signals must survive; collapsing them on a null key would leave one",
  );
});

test("F-3 — the winning card is chosen by total rankScore, the surface's own ordering authority, and the choice is single-sourced", async () => {
  // "Stronger signal" was undefined in code before W2-A, and the two candidate
  // definitions disagree: SIGNAL_TYPE_POINTS ranks long_ownership_tenure (18)
  // above re_engagement_opportunity (10), while total rankScore can put the
  // re-engagement ahead when its evidence band is stronger. This fixture is
  // built so the two authorities give OPPOSITE answers, which is what makes it
  // a real assertion about which one is implemented rather than a coincidence.
  const propertyId = await createProperty(A.agent.cookie, `5 Selector Conflict St ${suffix}`);
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Sel", lastName: "Selector" });

  // Loses on type weight (10 vs 18), wins on band (StrongIndicator 40 vs
  // Emerging 12) and therefore on total score.
  const strongBandWeakType = await insertSignal({
    partyId,
    propertyId: null,
    signalType: "re_engagement_opportunity",
    title: "Long-dormant contact worth re-engaging",
    explanation: "No contact of any kind has been recorded with this person for a long time.",
    evidence: { dormantDays: 400 },
    confidenceBand: "StrongIndicator",
  });
  const weakBandStrongType = await insertSignal({
    partyId,
    propertyId,
    signalType: "long_ownership_tenure",
    title: "Long ownership tenure",
    explanation: "Recorded as the owner of this property for approximately 6 years.",
    evidence: { approximateTenureYears: 6 },
    confidenceBand: "Emerging",
  });

  const { body } = await fetchToday(A.agent.cookie);
  const cardsForParty = body.priorityActions.filter((a: any) => a.partyId === partyId);
  assert.equal(cardsForParty.length, 1, "still exactly one card for the contact");

  const [card] = cardsForParty;
  assert.equal(
    card.id,
    `signal:${strongBandWeakType.id}`,
    "rankScore is the selector: the higher-scoring signal wins even though the other has the heavier signal-type weight",
  );
  // The chosen card must also be the one that sorts highest — that is the
  // whole reason rankScore rather than type weight was chosen. If the winner
  // could sort below a card it had just beaten, the list would contradict
  // itself.
  const losing = card.whyItMatters.relatedSignals.find((r: any) => r.signalId === weakBandStrongType.id);
  assert.ok(losing, "the type-heavier signal is preserved as evidence, not deleted for losing on score");
  assert.ok(card.rankScore >= losing.rankScore, "the card AE kept must be the card AE ranks highest");
});

/* =====================================================================
 * F-5 — RULE D EXPLAINS ITSELF WHEN IT WINS.
 * ===================================================================*/

test("F-5 — a cold-contact card carries an explanation, with NO confidence band, so the web mirror cannot render a bare priority score for it", async () => {
  const propertyId = await createProperty(A.agent.cookie, `6 Cold Card Explains Itself St ${suffix}`);
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Cora", lastName: "ColdCard" });
  const relationshipId = await createRelationship(A.agent.cookie, { partyId, propertyId, relationshipType: "owner" });

  const { body } = await fetchToday(A.agent.cookie);
  const card = body.priorityActions.find((a: any) => a.id === `relationship:${relationshipId}`);
  assert.ok(card, "a never-contacted Active relationship is a Rule D cold card");
  assert.equal(card.type, "relationship_cold");

  assert.ok(card.whyItMatters, "F-5: a cold card used to emit whyItMatters: null and could not explain why AE chose it");
  assert.match(card.whyItMatters.headline, /no recorded contact/i);
  assert.equal(
    card.whyItMatters.confidenceBand,
    null,
    "a cold card is a date comparison, not a scored inference, so it has no evidence band",
  );
  assert.equal(card.whyItMatters.confidenceBandLabel, null, "the null band is what keeps 'priority N/100' off this card in the UI");
  assert.deepEqual(card.whyItMatters.factors, [], "there is no itemised score to itemise on a threshold rule");
  assert.equal(card.whyItMatters.talkingPoint, null, "a gap in a record is not something to put in an agent's mouth");
  assert.match(card.whyItMatters.caution, /does not know that none happened/i, "the caution names the limit of what AE actually knows");
  // The card itself still carries no confidence band either, exactly as before.
  assert.equal(card.confidenceBand, null);
});

const RELATED_SIGNAL_SHAPE = [
  "confidenceBand",
  "confidenceBandLabel",
  "explanation",
  "rankScore",
  "relationship",
  "signalId",
  "signalType",
  "title",
];

function assertRelatedSignalShape(related: any) {
  assert.deepEqual(
    Object.keys(related).sort(),
    RELATED_SIGNAL_SHAPE,
    "dropping a field from the related-signal shape drops the evidence an agent reads",
  );
  assert.equal(typeof related.explanation, "string");
  assert.ok(related.explanation.length > 0, "the stored explanation is the evidence; an empty string is a drop");
  assert.equal(typeof related.rankScore, "number");
  assert.equal(typeof related.signalId, "number");
}

test("F-5 — when Rule D outranks a signal, the cold card keeps that signal's explanation, and a second read returns the same evidence", async () => {
  // Two weak Emerging signals for one never-contacted owner. Both score below
  // Rule D's never-contacted rank (38): nearby sales is 34, planning activity
  // is 35. Before F-5 the higher of those two became the card and Rule D was
  // suppressed, so the cold card — when it was the survivor for any other
  // reason — did not carry the signal that lost. The sibling must survive
  // too: keeping only the winner's explanation would still drop evidence.
  const fresh = await createBrokerageWithUsers(baseUrl, `W2A F5 Score ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.propertyIntelligence.read");

    const [party] = await db
      .insert(parties)
      .values({ brokerageId: fresh.brokerageId, firstName: "Nora", lastName: "NeverContacted" })
      .returning({ id: parties.id });
    const [relationship] = await db
      .insert(growRelationships)
      .values({
        brokerageId: fresh.brokerageId,
        partyId: party.id,
        propertyId: null,
        relationshipType: "owner",
        status: "Active",
      })
      .returning({ id: growRelationships.id });

    const nearbyExplanation = "Nearby sales fixture kept as evidence when Rule D wins.";
    const planningExplanation = "Planning activity fixture kept as evidence when Rule D wins.";
    const [nearby, planning] = await db
      .insert(growOpportunitySignals)
      .values([
        {
          brokerageId: fresh.brokerageId,
          partyId: party.id,
          propertyId: null,
          signalType: "recent_nearby_sales_activity",
          title: "Recent nearby sales activity",
          explanation: nearbyExplanation,
          evidence: {},
          source: "internal",
          confidenceBand: "Emerging",
          dedupeKey: `f5-score-nearby-${suffix}`,
        },
        {
          brokerageId: fresh.brokerageId,
          partyId: party.id,
          propertyId: null,
          signalType: "development_planning_activity",
          title: "Development or planning activity",
          explanation: planningExplanation,
          evidence: {},
          source: "internal",
          confidenceBand: "Emerging",
          dedupeKey: `f5-score-planning-${suffix}`,
        },
      ] as any)
      .returning({ id: growOpportunitySignals.id });

    const first = await fetchToday(fresh.agent.cookie);
    assert.equal(first.status, 200);
    const cardsForParty = first.body.priorityActions.filter((a: any) => a.partyId === party.id);
    assert.equal(cardsForParty.length, 1, "Rule D and the signals are one card, not one card per signal");
    const card = cardsForParty[0];
    assert.equal(card.id, `relationship:${relationship.id}`);
    assert.equal(card.type, "relationship_cold");
    assert.equal(card.confidenceBand, null, "winning the contest must not put a signal band on the cold card");
    assert.deepEqual(card.whyItMatters.factors, []);
    assert.equal(card.whyItMatters.confidenceBand, null);
    assert.doesNotMatch(card.whyItMatters.headline, /nothing more specific/i);
    assert.match(card.whyItMatters.headline, /card that was kept/);

    const related = card.whyItMatters.relatedSignals;
    assert.equal(related.length, 2, "the losing signal and the sibling folded into it both stay on the cold card");
    for (const entry of related) {
      assertRelatedSignalShape(entry);
      assert.equal(entry.relationship, "consolidated_into_this_card");
      assert.ok(entry.rankScore < card.rankScore, "Rule D won on rank, so each carried signal scores below the cold card");
    }
    const byId = new Map<number, any>(related.map((entry: any) => [entry.signalId, entry]));
    assert.equal(byId.get(nearby.id)?.explanation, nearbyExplanation);
    assert.equal(byId.get(planning.id)?.explanation, planningExplanation);
    assert.equal(byId.get(nearby.id)?.signalType, "recent_nearby_sales_activity");
    assert.equal(byId.get(planning.id)?.signalType, "development_planning_activity");
    assert.ok(!first.body.priorityActions.some((a: any) => a.id === `signal:${nearby.id}` || a.id === `signal:${planning.id}`));

    const second = await fetchToday(fresh.agent.cookie);
    const again = second.body.priorityActions.find((a: any) => a.id === card.id);
    assert.deepEqual(
      again.whyItMatters.relatedSignals,
      related,
      "a second read of the same day must return the same signal evidence; dropping it on redelivery is the regression",
    );
    assert.equal(again.whyItMatters.headline, card.whyItMatters.headline);
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("F-5 — when the Emerging cap lets Rule D win over a stronger signal, the cold card still keeps that signal's explanation", async () => {
  // Eleven identical Emerging long-tenure signals, each on its own never-contacted
  // owner. Tenure of 20 years scores well above Rule D (60 vs 38), so the cold
  // card wins only because the cap of 10 holds the weakest back. The attachment
  // has to be the cap relationship, and the stored explanation has to survive
  // — a headline that merely says "held back" without the signal's own words
  // is the drop this test exists to fail on.
  const fresh = await createBrokerageWithUsers(baseUrl, `W2A F5 Cap ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.propertyIntelligence.read");

    const contactRows = Array.from({ length: 11 }, (_, i) => ({
      brokerageId: fresh.brokerageId,
      firstName: "Cap",
      lastName: `Owner${i}`,
    }));
    const insertedParties = await db.insert(parties).values(contactRows).returning({ id: parties.id });
    const relationshipRows = await db
      .insert(growRelationships)
      .values(
        insertedParties.map((party) => ({
          brokerageId: fresh.brokerageId,
          partyId: party.id,
          propertyId: null,
          relationshipType: "owner",
          status: "Active",
        })),
      )
      .returning({ id: growRelationships.id, partyId: growRelationships.partyId });

    const signalRows = insertedParties.map((party, i) => ({
      brokerageId: fresh.brokerageId,
      partyId: party.id,
      propertyId: null,
      signalType: "long_ownership_tenure",
      title: "Long ownership tenure",
      explanation: `Cap-held tenure explanation ${i} for party ${party.id}.`,
      evidence: { approximateTenureYears: 20 },
      source: "internal",
      confidenceBand: "Emerging",
      dedupeKey: `f5-cap-${suffix}-${i}`,
    }));
    const insertedSignals = await db
      .insert(growOpportunitySignals)
      .values(signalRows as any)
      .returning({ id: growOpportunitySignals.id, partyId: growOpportunitySignals.partyId, explanation: growOpportunitySignals.explanation });

    const withheld = insertedSignals.reduce((highest, row) => (row.id > highest.id ? row : highest));
    const withheldRelationship = relationshipRows.find((row) => row.partyId === withheld.partyId);
    assert.ok(withheldRelationship, "the withheld signal's party has the cold relationship Rule D will emit");

    const first = await fetchToday(fresh.agent.cookie);
    assert.equal(first.status, 200);
    assert.equal(first.body.signalSummary.emergingSurfaced, 10);
    assert.equal(first.body.signalSummary.emergingWithheld, 1);

    assert.ok(
      !first.body.priorityActions.some((a: any) => a.id === `signal:${withheld.id}`),
      "the capped signal must not also emit its own card",
    );
    const card = first.body.priorityActions.find((a: any) => a.id === `relationship:${withheldRelationship.id}`);
    assert.ok(card, "Rule D is the card that survives the cap");
    assert.equal(card.type, "relationship_cold");
    assert.equal(card.confidenceBand, null);
    assert.deepEqual(card.whyItMatters.factors, []);
    assert.match(card.whyItMatters.headline, /today's limit held back/);
    assert.doesNotMatch(card.whyItMatters.headline, /nothing more specific/i);

    const related = card.whyItMatters.relatedSignals;
    assert.equal(related.length, 1);
    assertRelatedSignalShape(related[0]);
    assert.equal(related[0].signalId, withheld.id);
    assert.equal(related[0].explanation, withheld.explanation);
    assert.equal(related[0].signalType, "long_ownership_tenure");
    assert.equal(related[0].relationship, "withheld_by_daily_cap");
    assert.ok(
      related[0].rankScore > card.rankScore,
      "the cap, not the rank, is why Rule D won — the signal still outscores the cold card",
    );

    for (const signal of insertedSignals) {
      if (signal.id === withheld.id) continue;
      assert.ok(first.body.priorityActions.some((a: any) => a.id === `signal:${signal.id}`), "a signal inside the cap still surfaces");
      const surfacedRelationship = relationshipRows.find((row) => row.partyId === signal.partyId);
      assert.ok(
        !first.body.priorityActions.some((a: any) => a.id === `relationship:${surfacedRelationship?.id}`),
        "a surfaced signal still suppresses Rule D for that contact",
      );
    }

    const second = await fetchToday(fresh.agent.cookie);
    const again = second.body.priorityActions.find((a: any) => a.id === card.id);
    assert.deepEqual(again.whyItMatters.relatedSignals, related, "redelivery of Today must not drop the capped signal's evidence");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

/* =====================================================================
 * F-2 — BOUNDING, AND SAYING SO.
 * ===================================================================*/

test("F-2 — priorityActions is bounded by MAX_PRIORITY_ACTIONS and everything cut is reported rather than silently dropped", async () => {
  // A brokerage whose signal population alone exceeds the response cap. This
  // is deliberately far smaller than the real scenario (a 5,000-contact
  // database importing two years dormant produces thousands of DoToday cards
  // on day one) and still proves the bound exists, because before W2-A the
  // ONLY cap in the pipeline protected the Emerging band — the weakest one.
  const fresh = await createBrokerageWithUsers(baseUrl, `W2A Cap ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.propertyIntelligence.read");

    // The contacts are inserted DIRECTLY rather than through POST /parties.
    // Two hundred-odd HTTP round trips to build one fixture is slow, and it
    // makes the test's outcome depend on the whole request stack staying
    // healthy under a burst that has nothing to do with what is being
    // asserted. These rows need only to exist and belong to the tenant —
    // Grow Today reads them through a brokerage-scoped join, and these
    // signals are party-anchored with no property at all.
    const contactRows = Array.from({ length: MAX_PRIORITY_ACTIONS + 25 }, (_, i) => ({
      brokerageId: fresh.brokerageId,
      firstName: "Capped",
      lastName: `Contact${i}`,
    }));
    const insertedParties = await db.insert(parties).values(contactRows).returning({ id: parties.id });

    const rows: Array<Record<string, unknown>> = [];
    for (const [i, party] of insertedParties.entries()) {
      rows.push({
        brokerageId: fresh.brokerageId,
        partyId: party.id,
        propertyId: null,
        signalType: "re_engagement_opportunity",
        title: "Long-dormant contact worth re-engaging",
        explanation: "Dormant for a long time, with nobody working the relationship.",
        evidence: { dormantDays: 800 },
        source: "internal",
        confidenceBand: "StrongIndicator",
        dedupeKey: `w2a-cap-${suffix}-${i}`,
      });
    }
    await db.insert(growOpportunitySignals).values(rows as any);

    const { body } = await fetchToday(fresh.agent.cookie);
    assert.ok(
      body.priorityActions.length <= MAX_PRIORITY_ACTIONS,
      `priorityActions must be bounded; got ${body.priorityActions.length} against a cap of ${MAX_PRIORITY_ACTIONS}`,
    );
    assert.equal(body.counts.priorityActions, body.priorityActions.length, "the count beside the list must describe the list");
    assert.ok(
      body.signalSummary.withheldByActionCap > 0,
      "what the cap removed is reported honestly, following emergingWithheld's own precedent",
    );
    // The cut happens AFTER the sort, so what survives is the top of the day,
    // never an arbitrary slice.
    const priorityOrder: Record<string, number> = { DoNow: 0, DoToday: 1, KeepWarm: 2 };
    for (let i = 1; i < body.priorityActions.length; i++) {
      assert.ok(
        priorityOrder[body.priorityActions[i - 1].priority] <= priorityOrder[body.priorityActions[i].priority],
        "the capped list is still sorted end to end, which is what makes the cut the lowest-ranked tail",
      );
    }
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

/* =====================================================================
 * DETERMINISM — the same request twice gives the same day.
 * ===================================================================*/

test("card ordering is identical across repeated identical requests, including for equally-scored signals", async () => {
  // WHY THIS NEEDS A TEST AT ALL. Several signals for different contacts can
  // score identically — the same rule, the same band, the same relationship
  // state produces the same number every time. Without an explicit row-id
  // tiebreak in the comparator, those cards order by whatever sequence the
  // database happened to return them in, so an agent refreshing Grow Today can
  // watch their day silently reshuffle. The tiebreak lives in
  // compareSignalStrength() in lib/grow/signalRanking.ts precisely so the
  // global sort and the per-party winner cannot drift apart.
  const propertyId = await createProperty(A.agent.cookie, `8 Deterministic Order St ${suffix}`);
  for (let i = 0; i < 6; i++) {
    const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Tie", lastName: `Break${i}` });
    // Identical in every input the ranker reads, so every one of these scores
    // exactly the same and only the tiebreak separates them.
    await insertSignal({
      partyId,
      propertyId: null,
      signalType: "long_ownership_tenure",
      title: "Long ownership tenure",
      explanation: "Identical fixture, so these six signals score identically.",
      evidence: { approximateTenureYears: 9 },
      confidenceBand: "WorthReviewing",
    });
  }

  const first = await fetchToday(A.agent.cookie);
  const second = await fetchToday(A.agent.cookie);
  const third = await fetchToday(A.agent.cookie);

  const ids = (body: any) => body.priorityActions.map((a: any) => a.id);
  assert.deepEqual(ids(second.body), ids(first.body), "two identical requests must return the same cards in the same order");
  assert.deepEqual(ids(third.body), ids(first.body), "and the third must agree with both");
  assert.ok(ids(first.body).length > 0, "the determinism assertion is only meaningful against a non-empty day");
});

/* =====================================================================
 * I-2 — THE ACTIVITY AGGREGATE STILL PRODUCES THE SAME ANSWER.
 * ===================================================================*/

test("I-2 — replacing the whole-tenant activity scan with a grouped max() leaves the cold-contact day count unchanged", async () => {
  // The rewrite has to be BEHAVIOUR-PRESERVING, not merely faster: the value
  // it computes drives Rule D's day count, Rule D's threshold decision and the
  // signal ranker's "no contact recorded for N days" factor. The specific risk
  // in moving a max() from a JavaScript loop into SQL is the timestamp round
  // trip — grow_activities.occurred_at is `timestamp without time zone`, so a
  // decoder that differed from the one the old row-by-row read used would
  // shift every date silently rather than fail.
  const propertyId = await createProperty(A.agent.cookie, `9 Activity Aggregate St ${suffix}`);
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Agatha", lastName: "Aggregate" });
  const relationshipId = await createRelationship(A.agent.cookie, { partyId, propertyId, relationshipType: "owner" });

  // Three activities for one contact. Only the MOST RECENT may decide the day
  // count — an aggregate that picked the wrong one, or that read only the
  // first row per party, would report 60 days here instead of 30.
  for (const daysAgo of [60, 30, 45]) {
    const res = await fetch(growUrl("/activities"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.agent.cookie },
      body: JSON.stringify({
        partyId,
        propertyId,
        activityType: "Call",
        summary: `Fixture activity ${daysAgo} days ago.`,
        occurredAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
      }),
    });
    if (res.status !== 201) throw new Error(`create activity failed: ${res.status} ${await res.text()}`);
  }

  const { body } = await fetchToday(A.agent.cookie);
  const card = body.priorityActions.find((a: any) => a.id === `relationship:${relationshipId}`);
  assert.ok(card, "a contact last spoken to 30 days ago is past the 21-day cold threshold");
  assert.match(
    card.reason,
    /No contact recorded for (29|30|31) days\./,
    "the day count must come from the MOST RECENT activity, not the first or the oldest",
  );
  assert.ok(card.lastActivityAt, "the aggregate's timestamp must survive the round trip through SQL");
  const reportedDaysAgo = Math.round((Date.now() - new Date(card.lastActivityAt).getTime()) / DAY);
  assert.ok(
    reportedDaysAgo >= 29 && reportedDaysAgo <= 31,
    `lastActivityAt must decode to the same instant the old row-by-row read produced; got ${reportedDaysAgo} days ago`,
  );
});
