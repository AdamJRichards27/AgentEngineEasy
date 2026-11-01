// AE GROW Completion W2-D — CONTACT-ANCHORED SIGNALS ON CONTACT 360.
//
// THE DEFECT. getContactPropertyIntelligenceSummary() opened with
// `if (s.propertyId === null) continue`. Because re_engagement_opportunity is
// ALWAYS contact-anchored (evaluation.ts sets propertyId: null unconditionally
// — "the subject of this signal is the PERSON"), every re-engagement signal AE
// raised was invisible on the contact record built to show it. The flagship
// future-seller signal, unreachable on its own surface, dropped silently.
//
// THE DECISION THIS PROVES. A signal with a party and no property is not
// broken — it is CONTACT-ANCHORED, and it must answer: who, why they are
// surfaced, what evidence AE has, what AE does NOT know, and what the agent
// might consider doing. It must carry no property link and no property-
// specific action, and the absence of a property must be represented as an
// absence — never as a fabricated, inferred or null property association.
//
// THE THIRD CATEGORY. A signal whose RULE is about a property, arriving
// without one, is a data-integrity problem rather than intelligence about a
// person. It is counted and reported, never surfaced as contact-anchored.
// Which category a row falls in comes from the rule registry itself
// (classifySignalAnchor), not from a null check at the call site.
//
// Real Postgres, real fixtures, and the REAL sweep — the signals asserted on
// below are produced by the shipping rules, not hand-written to match the
// assertion. Everything is scoped to this file's own brokerages.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  db,
  growOpportunitySignals,
  growRelationships,
  growContactDncrStatuses,
  entitlementGrants,
  parties,
  properties,
  type GrowOpportunitySignal,
} from "@aee/db";
import {
  getContactPropertyIntelligenceSummary,
  CONTACT_ANCHORED_MISSING_PROPERTY,
  SIGNAL_ONLY_RELATIONSHIP_TYPE,
  PropertyIntelligenceAccessError,
} from "../service.js";
import { classifySignalAnchor, CONTACT_ANCHORABLE_SIGNAL_TYPES, CONTACT_ANCHORABLE_RULE_NAMES } from "../evaluation.js";
import { resetSweepResumePointForTests } from "../sweep.js";
// Cross-file contention on the sweep lock: see sweepLockContention.ts.
import { sweepWhenLockFree, acquireSweepLockForTest } from "./sweepLockContention.js";
import { invalidateEntitlementCache } from "../../entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

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

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * MS_PER_DAY);
const yearsAgo = (n: number) => new Date(Date.now() - n * 365 * MS_PER_DAY);

/** Long enough that the re-engagement rule treats the contact as dormant. */
const DORMANT_DAYS = 900;

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { createApp } = await import("../../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `W2D Contact Anchored A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `W2D Contact Anchored B ${suffix}`);
  // The HTTP test below asserts a foreign tenant gets 404 rather than 403.
  // That is only meaningful if the foreign tenant IS entitled — otherwise the
  // entitlement middleware answers first and the tenancy boundary is never
  // exercised. Both tenants are therefore granted the read entitlement.
  for (const t of [A, B]) await grant(t.brokerageId, "grow.propertyIntelligence.read");
  resetSweepResumePointForTests();
});

async function grant(brokerageId: number, entitlementKey: string): Promise<void> {
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

after(async () => {
  // t223u: never leave the HTTP server listening if teardown fails (a throwing cleanup used to
  // skip server.close, the child process never exited, and the runner waited until the CI job timeout).
  try {
    await cleanupBrokerages([A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

/* ---------------------------------------------------------------------
 * Fixtures.
 * -----------------------------------------------------------------*/

let seq = 0;

async function createParty(brokerageId: number, label: string, createdDaysAgo = DORMANT_DAYS): Promise<number> {
  const [row] = await db
    .insert(parties)
    .values({ brokerageId, partyType: "Person", firstName: "W2D", lastName: `${label}-${suffix}`, createdAt: daysAgo(createdDaysAgo) })
    .returning({ id: parties.id });
  return row.id;
}

async function createProperty(brokerageId: number, agentId: number, label: string): Promise<number> {
  const [row] = await db
    .insert(properties)
    .values({ brokerageId, agentId, formattedAddress: `${label} ${suffix}`, state: "QLD", suburb: "Testville", postcode: "4000" })
    .returning({ id: properties.id });
  return row.id;
}

async function createRelationship(input: {
  brokerageId: number;
  partyId: number;
  propertyId?: number | null;
  relationshipType: string;
  ownershipStartDate?: Date | null;
  ownershipStartSource?: string | null;
  ownershipStartPrecision?: string | null;
}): Promise<void> {
  const created = daysAgo(DORMANT_DAYS);
  await db.insert(growRelationships).values({
    brokerageId: input.brokerageId,
    partyId: input.partyId,
    propertyId: input.propertyId ?? null,
    relationshipType: input.relationshipType,
    status: "Active",
    validFrom: created,
    ownershipStartDate: input.ownershipStartDate ?? null,
    ownershipStartSource: input.ownershipStartSource ?? null,
    ownershipStartPrecision: input.ownershipStartPrecision ?? null,
    createdAt: created,
    updatedAt: created,
  });
}

/** A hand-written signal row, for the cases the real rules cannot produce (a corrupt row). */
async function insertRawSignal(input: {
  brokerageId: number;
  partyId: number | null;
  propertyId: number | null;
  signalType: string;
}): Promise<number> {
  const [row] = await db
    .insert(growOpportunitySignals)
    .values({
      brokerageId: input.brokerageId,
      partyId: input.partyId,
      propertyId: input.propertyId,
      signalType: input.signalType,
      title: "Hand-written fixture row",
      explanation: "This row exists only to exercise a classification branch. It is not a prediction about anybody.",
      evidence: { schemaVersion: 1, rule: input.signalType, observations: [], unknowns: [], agentAction: "Nothing." },
      source: "internal",
      confidenceBand: "WorthReviewing",
      status: "Active",
      dedupeKey: `w2d-${suffix}-${seq++}`,
    })
    .returning({ id: growOpportunitySignals.id });
  return row.id;
}

async function sweep(brokerageIds: number[]): Promise<void> {
  const result = await sweepWhenLockFree({ brokerageIds, force: true });
  assert.ok(result.ok, "the sweep ran");
}

async function signalsFor(brokerageId: number, partyId: number): Promise<GrowOpportunitySignal[]> {
  return db
    .select()
    .from(growOpportunitySignals)
    .where(and(eq(growOpportunitySignals.brokerageId, brokerageId), eq(growOpportunitySignals.partyId, partyId)));
}

/* =====================================================================
 * 1. THE CLASSIFICATION, MADE DECLARATIVE.
 * ===================================================================*/

test("W2-D: exactly three rules may be contact-anchored, and the set comes from the registry", () => {
  assert.deepEqual(
    [...CONTACT_ANCHORABLE_RULE_NAMES].sort(),
    ["agent_recorded_motivation", "past_buyer_interest", "re_engagement_opportunity"],
    "widening this set is a product decision about what AE may claim without a property, not a refactor",
  );
  assert.deepEqual(
    [...CONTACT_ANCHORABLE_SIGNAL_TYPES].sort(),
    ["agent_recorded_motivation", "past_buyer_interest", "re_engagement_opportunity"],
    "the signal types follow from the rules, never hand-listed alongside them",
  );
});

test("W2-D: classifySignalAnchor sorts every case into exactly one of the three categories", () => {
  // A property anchor wins outright, whatever the rule.
  assert.equal(classifySignalAnchor({ signalType: "re_engagement_opportunity", partyId: 1, propertyId: 7 }), "property");
  assert.equal(classifySignalAnchor({ signalType: "long_ownership_tenure", partyId: 1, propertyId: 7 }), "property");
  assert.equal(classifySignalAnchor({ signalType: "recent_nearby_sales_activity", partyId: null, propertyId: 7 }), "property");

  // Contact-anchored: a contact, no property, and a rule that may be about a person.
  for (const signalType of ["re_engagement_opportunity", "past_buyer_interest", "agent_recorded_motivation"]) {
    assert.equal(classifySignalAnchor({ signalType, partyId: 1, propertyId: null }), "contact", `${signalType} may be about a person`);
  }

  // Unusable: a property-DEPENDENT rule with no property. The explanation is
  // about a property, and the property is missing — there is nothing to show.
  for (const signalType of [
    "long_ownership_tenure",
    "stale_previous_appraisal",
    "lease_tenancy_milestone",
    "recent_nearby_sales_activity",
    "development_planning_activity",
    "estimated_equity_band",
    "mortgage_refinancing_indicator",
    "property_ownership_change",
  ]) {
    assert.equal(classifySignalAnchor({ signalType, partyId: 1, propertyId: null }), "unusable", `${signalType} is about a property`);
  }

  // Unusable: neither anchor, and an unrecognised type with no property — the
  // case where AE cannot say what it is looking at, so it must not guess.
  assert.equal(classifySignalAnchor({ signalType: "re_engagement_opportunity", partyId: null, propertyId: null }), "unusable");
  assert.equal(classifySignalAnchor({ signalType: "a_rule_that_does_not_exist", partyId: 1, propertyId: null }), "unusable");
  assert.equal(classifySignalAnchor({ signalType: "land_use_zoning_change", partyId: 1, propertyId: null }), "unusable");
});

/* =====================================================================
 * 2. THE ACCEPTANCE CRITERION — a re-engagement signal, produced by the real
 *    rule, visible on its contact's own record.
 * ===================================================================*/

test("W2-D: a re_engagement_opportunity signal is visible on Contact 360, with evidence and unknowns, and no property", async () => {
  // A contact who OWNS a property AE knows about. This is the sharp case: the
  // contact has a verified property association, and the re-engagement signal
  // must still not be folded into it — its subject is the person.
  const partyId = await createParty(A.brokerageId, "DormantOwner");
  const propertyId = await createProperty(A.brokerageId, A.admin.user.id, "10 Dormant Owner St");
  await createRelationship({
    brokerageId: A.brokerageId,
    partyId,
    propertyId,
    relationshipType: "owner",
    ownershipStartDate: yearsAgo(11),
    ownershipStartSource: "agent_recorded",
    ownershipStartPrecision: "day",
  });

  await sweep([A.brokerageId]);

  const raw = await signalsFor(A.brokerageId, partyId);
  const reEngagement = raw.find((s) => s.signalType === "re_engagement_opportunity");
  assert.ok(reEngagement, "the real rule raised a re-engagement signal for this dormant contact");
  assert.equal(reEngagement.propertyId, null, "the shipping rule anchors it to the person, unconditionally");

  const summary = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);

  // THE FIX. Before W2-D this signal was dropped by `continue` and appeared
  // nowhere in this response.
  const surfaced = summary.contactAnchoredSignals.find((e) => e.signal.id === reEngagement.id);
  assert.ok(surfaced, "the contact's own re-engagement signal is visible on their own record");

  // WHO / WHY — the signal's own title and hedged explanation, unchanged.
  assert.ok(surfaced.signal.title.length > 0, "who and why: the signal says what it is");
  assert.match(surfaced.signal.explanation, /not a prediction/i, "the non-prediction caveat survives the new surface");

  // WHAT EVIDENCE AE HAS.
  assert.ok(surfaced.observations.length > 0, "what AE can see: the rule's own observations are carried through");
  for (const o of surfaced.observations) {
    assert.ok(o.what.length > 10, "each observation is a readable fact");
    assert.ok(o.recordType.length > 0, "each observation names the record it came from");
  }

  // WHAT AE DOES NOT KNOW — including, always, the missing property anchor.
  assert.equal(surfaced.missingPropertyAnchor, CONTACT_ANCHORED_MISSING_PROPERTY);
  assert.match(surfaced.missingPropertyAnchor, /no verified property association/i);
  assert.match(surfaced.missingPropertyAnchor, /not saying they own nothing/i, "an absence in AE's records, never a claim about the world");
  assert.ok(Array.isArray(surfaced.unknowns), "the rule's own unknowns are an explicit list, even when empty");

  // WHAT THE AGENT MIGHT DO — and it must not be a property action.
  assert.ok(surfaced.agentAction && surfaced.agentAction.length > 10, "what to consider doing next");
  assert.doesNotMatch(
    surfaced.agentAction,
    /this property|the property|appraisal of|list(ing)? (it|this)/i,
    "a contact-anchored signal must not suggest an action about a property AE cannot name",
  );

  // NO PROPERTY ASSOCIATION IS INVENTED. The contact owns a property, and the
  // entry still carries no property — not that one, not a placeholder.
  assert.equal(surfaced.anchor, "contact");
  assert.ok(!("propertyId" in surfaced), "the entry shape has nowhere to put a property, by design");
  assert.ok(!("propertyAddress" in surfaced), "and nowhere to put an address either");
  // The signal itself carries no property, and no key anywhere in the entry
  // holds one.
  //
  // Asserted structurally rather than as `JSON.stringify(entry).includes(String(propertyId))`,
  // which this line used to be. That substring form passes or fails on how
  // many digits the ids happen to have — with a small propertyId like 3 it
  // matches the "3" inside a timestamp or an unrelated row id and fails for a
  // reason that has nothing to do with property leakage. A check that depends
  // on sequence values is not a check.
  assert.equal(surfaced.signal.propertyId, null, "the signal row itself has no property");
  for (const [key, value] of Object.entries(surfaced)) {
    assert.equal(/propert/i.test(key) && typeof value === "number", false, `no property-shaped numeric field on the entry (${key})`);
  }

  // The property side is unaffected: the tenure signal is still on the property.
  const propertyEntry = summary.properties.find((e) => e.propertyId === propertyId);
  assert.ok(propertyEntry, "the owned property is still reported as its own entry");
  assert.equal(propertyEntry.relationshipType, "owner", "a real recorded relationship is still reported as itself");
  assert.equal(
    propertyEntry.activeSignals.some((s) => s.id === reEngagement.id),
    false,
    "the re-engagement signal is NOT attached to the contact's property — its subject is the person",
  );

  assert.equal(summary.unusableSignalCount, 0, "nothing the real rules produced is unusable");
});

test("W2-D: the other two contact-anchorable rules surface the same way when their relationship has no property", async () => {
  // grow_relationships.propertyId is nullable, and both of these rules pass it
  // straight through — so "we know the person, we do not know the property" is
  // an expected result, already phrased for in each rule's explanation.
  const buyerId = await createParty(A.brokerageId, "BuyerNoProperty");
  await createRelationship({ brokerageId: A.brokerageId, partyId: buyerId, propertyId: null, relationshipType: "prospective_buyer" });

  const sellerId = await createParty(A.brokerageId, "SellerNoProperty");
  await createRelationship({ brokerageId: A.brokerageId, partyId: sellerId, propertyId: null, relationshipType: "prospective_seller" });

  await sweep([A.brokerageId]);

  for (const [partyId, expectedType] of [
    [buyerId, "past_buyer_interest"],
    [sellerId, "agent_recorded_motivation"],
  ] as const) {
    const summary = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
    const entry = summary.contactAnchoredSignals.find((e) => e.signal.signalType === expectedType);
    assert.ok(entry, `${expectedType} with no property is surfaced as contact-anchored`);
    assert.equal(entry.signal.propertyId, null);
    assert.equal(entry.missingPropertyAnchor, CONTACT_ANCHORED_MISSING_PROPERTY);
    assert.ok(entry.observations.length > 0, `${expectedType} carries its evidence`);
    assert.doesNotMatch(entry.agentAction ?? "", /this property|the property/i, `${expectedType}'s suggested action is about the person`);

    assert.deepEqual(summary.properties, [], "a contact with no property relationship gets no property entries, and no invented one");
    assert.equal(summary.unusableSignalCount, 0);
  }
});

/* =====================================================================
 * 3. THE THIRD CATEGORY — invalid/unusable, not contact-anchored.
 * ===================================================================*/

test("W2-D: a property-dependent signal type with no property is unusable, never surfaced as contact-anchored", async () => {
  const partyId = await createParty(A.brokerageId, "BrokenRow", 1);
  // The real rules cannot produce this — a tenure signal is derived from a
  // property. A row like this can only arrive from a bug, a bad backfill, or a
  // newer build writing into the same database. Whatever the cause, AE cannot
  // explain it, because the thing the explanation is about is missing.
  const brokenId = await insertRawSignal({ brokerageId: A.brokerageId, partyId, propertyId: null, signalType: "long_ownership_tenure" });

  const summary = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);

  assert.equal(summary.unusableSignalCount, 1, "it is counted — silence is what W2-D exists to remove");
  assert.equal(
    summary.contactAnchoredSignals.some((e) => e.signal.id === brokenId),
    false,
    "a data-integrity problem must not be laundered into intelligence about a person",
  );
  assert.deepEqual(summary.properties, [], "and it certainly does not conjure a property entry");
  assert.equal(summary.contactAnchoredSignals.length, 0, "the contact-anchored list reports contact-anchored signals only");
});

test("W2-D: every category is accounted for — no signal is dropped on the floor", async () => {
  const partyId = await createParty(A.brokerageId, "AllThree");
  const propertyId = await createProperty(A.brokerageId, A.admin.user.id, "11 All Three Rd");
  await createRelationship({ brokerageId: A.brokerageId, partyId, propertyId, relationshipType: "owner" });

  const propertyAnchored = await insertRawSignal({ brokerageId: A.brokerageId, partyId, propertyId, signalType: "long_ownership_tenure" });
  const contactAnchored = await insertRawSignal({ brokerageId: A.brokerageId, partyId, propertyId: null, signalType: "re_engagement_opportunity" });
  const unusable = await insertRawSignal({ brokerageId: A.brokerageId, partyId, propertyId: null, signalType: "estimated_equity_band" });

  const summary = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);

  const surfacedPropertySignalIds = summary.properties.flatMap((e) => e.activeSignals.map((s) => s.id));
  assert.ok(surfacedPropertySignalIds.includes(propertyAnchored), "property-anchored: on its property");
  assert.ok(
    summary.contactAnchoredSignals.map((e) => e.signal.id).includes(contactAnchored),
    "contact-anchored: on the contact",
  );
  assert.equal(summary.unusableSignalCount, 1, "unusable: counted");
  assert.equal(surfacedPropertySignalIds.includes(unusable), false);
  assert.equal(summary.contactAnchoredSignals.some((e) => e.signal.id === unusable), false);

  // The conservation law. Every Active signal for this contact is in exactly
  // one bucket, and the three buckets add up to the row count.
  const all = await signalsFor(A.brokerageId, partyId);
  assert.equal(
    surfacedPropertySignalIds.length + summary.contactAnchoredSignals.length + summary.unusableSignalCount,
    all.length,
    "three buckets, every row in exactly one, nothing silently discarded",
  );
});

/* =====================================================================
 * 4. NO SYNTHETIC PROPERTY ASSOCIATION, ANYWHERE.
 * ===================================================================*/

test("W2-D: no entry anywhere in the response carries a null or invented property", async () => {
  const partyId = await createParty(A.brokerageId, "NoSynthetic");
  const propertyId = await createProperty(A.brokerageId, A.admin.user.id, "12 No Synthetic Way");
  await createRelationship({ brokerageId: A.brokerageId, partyId, propertyId, relationshipType: "owner" });
  await insertRawSignal({ brokerageId: A.brokerageId, partyId, propertyId: null, signalType: "re_engagement_opportunity" });

  const summary = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);

  // Every property entry names a REAL property — the thing the web panel links
  // to. A null here is how `/properties/null` gets shipped.
  for (const entry of summary.properties) {
    assert.equal(typeof entry.propertyId, "number", "a property entry always names a real property id");
    assert.ok(Number.isInteger(entry.propertyId) && entry.propertyId > 0);
    assert.ok(entry.propertyAddress.length > 0, "and a real address — never an empty affordance");
  }

  // And a contact-anchored entry has no property-shaped field AT ALL, so there
  // is nothing for a caller to accidentally render as a link.
  for (const entry of summary.contactAnchoredSignals) {
    for (const forbidden of ["propertyId", "propertyAddress", "relationshipType", "pendingMatches"]) {
      assert.equal(forbidden in entry, false, `a contact-anchored entry has no ${forbidden} — not even a null one`);
    }
  }
});

/* =====================================================================
 * 5. CONSENT AND TENANCY — unchanged, and proved unchanged.
 * ===================================================================*/

test("W2-D: a suppressed contact keeps their intelligence and loses every generated action", async () => {
  const partyId = await createParty(A.brokerageId, "Suppressed");
  const propertyId = await createProperty(A.brokerageId, A.admin.user.id, "13 Suppressed Pde");
  await createRelationship({ brokerageId: A.brokerageId, partyId, propertyId, relationshipType: "owner" });
  await insertRawSignal({ brokerageId: A.brokerageId, partyId, propertyId: null, signalType: "re_engagement_opportunity" });
  await insertRawSignal({ brokerageId: A.brokerageId, partyId, propertyId, signalType: "long_ownership_tenure" });

  // Visible, unrestricted, and carrying its rule's suggested action.
  const before = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
  assert.equal(before.contactAnchoredSignals.length, 1, "the fixture is visible to begin with");
  assert.equal(before.outreachRestriction, null, "and nothing restricts contacting them yet");
  assert.ok(before.contactAnchoredSignals[0].agentAction, "the rule's suggested action is present while they are contactable");

  await db.insert(growContactDncrStatuses).values({
    brokerageId: A.brokerageId,
    partyId,
    channel: "PHONE_CALL",
    status: "LISTED",
    source: "test-fixture",
    checkedAt: new Date(),
    recordedByUserId: A.admin.user.id,
  });

  // DECISION GATE 19. A contactability restriction must NOT erase legitimate
  // intelligence from an authorised internal user. The signals stay; the
  // ability to act on them goes.
  const after = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);

  assert.equal(after.contactAnchoredSignals.length, 1, "the contact-anchored signal is still shown — SIGNAL EXISTS != CONTACT MAY BE CONTACTED");
  assert.equal(after.contactAnchoredSignals[0].signal.id, before.contactAnchoredSignals[0].signal.id, "and it is the same row, not a redacted stand-in");

  // The evidence and the unknowns are preserved in full: a DNC listing is not
  // a reason to degrade the explanation of something that already happened.
  assert.deepEqual(after.contactAnchoredSignals[0].observations, before.contactAnchoredSignals[0].observations, "evidence preserved");
  assert.deepEqual(after.contactAnchoredSignals[0].unknowns, before.contactAnchoredSignals[0].unknowns, "unknowns preserved");
  assert.equal(after.contactAnchoredSignals[0].signal.explanation, before.contactAnchoredSignals[0].signal.explanation, "explanation preserved");

  // THE GENERATED OUTREACH ACTION IS GONE. This is the half that must go.
  assert.equal(after.contactAnchoredSignals[0].agentAction, null, "a suppressed contact is never given a suggested approach");

  // The restriction is present and unmistakable.
  assert.ok(after.outreachRestriction, "the restriction rides with the response");
  assert.equal(after.outreachRestriction?.outreachProhibited, true);
  assert.match(after.outreachRestriction!.notice, /do-not-contact/i);
  assert.match(after.outreachRestriction!.recommendedAction, /^Do not contact\./);

  // Property-anchored signals for the same contact are equally preserved.
  const propertyEntry = after.properties.find((e) => e.propertyId === propertyId);
  assert.ok(propertyEntry && propertyEntry.activeSignals.length > 0, "their property-anchored signals are readable too");

  // Restricted, not retired — the stage 1 rule, still true.
  const rows = await signalsFor(A.brokerageId, partyId);
  for (const row of rows) {
    assert.equal(row.status, "Active", "restricting outreach is not expiring the row");
    assert.equal(row.dismissedReason, null, "nor dismissing it");
  }
});

test("W2-D: a foreign-tenant partyId is rejected on every read this slice touches", async () => {
  const foreignPartyId = await createParty(B.brokerageId, "OtherTenant");
  const foreignPropertyId = await createProperty(B.brokerageId, B.admin.user.id, "14 Other Tenant Ct");
  await createRelationship({ brokerageId: B.brokerageId, partyId: foreignPartyId, propertyId: foreignPropertyId, relationshipType: "owner" });
  await insertRawSignal({ brokerageId: B.brokerageId, partyId: foreignPartyId, propertyId: null, signalType: "re_engagement_opportunity" });

  // Brokerage A asks for brokerage B's contact. The party is validated against
  // the brokerage BEFORE any signal is read, so nothing about that contact —
  // not their name, not their signals, not even whether they exist — is
  // distinguishable from a contact that is not there at all.
  await assert.rejects(
    () => getContactPropertyIntelligenceSummary(foreignPartyId, A.brokerageId),
    (err: unknown) => err instanceof PropertyIntelligenceAccessError && /Contact not found/.test((err as Error).message),
    "getContactPropertyIntelligenceSummary rejects a foreign-tenant partyId",
  );

  // The same id read by its OWN tenant works — proving the rejection above is
  // a tenancy boundary and not simply a missing row.
  const ownerView = await getContactPropertyIntelligenceSummary(foreignPartyId, B.brokerageId);
  assert.equal(ownerView.contactAnchoredSignals.length, 1, "B can see B's own contact-anchored signal");

  // And a contact-anchored signal row belonging to A can never be reached via
  // a foreign brokerage id on the same party.
  const ourParty = await createParty(A.brokerageId, "OurParty");
  await insertRawSignal({ brokerageId: A.brokerageId, partyId: ourParty, propertyId: null, signalType: "re_engagement_opportunity" });
  await assert.rejects(
    () => getContactPropertyIntelligenceSummary(ourParty, B.brokerageId),
    (err: unknown) => err instanceof PropertyIntelligenceAccessError,
    "and the boundary holds in the other direction too",
  );
});

test("W2-D: the HTTP contact endpoint is entitlement-controlled and brokerage-scoped", async () => {
  const partyId = await createParty(A.brokerageId, "OverHttp");
  await insertRawSignal({ brokerageId: A.brokerageId, partyId, propertyId: null, signalType: "re_engagement_opportunity" });

  const path = `/api/grow/property-intelligence/contact/${partyId}`;

  // Unauthenticated.
  const anonymous = await fetch(`${baseUrl}${path}`);
  assert.equal(anonymous.status, 401, "no session, no signals");

  // Entitled, own tenant.
  const mine = await fetch(`${baseUrl}${path}`, { headers: { cookie: A.admin.cookie } });
  assert.equal(mine.status, 200);
  const body = (await mine.json()) as { properties: unknown[]; contactAnchoredSignals: unknown[]; unusableSignalCount: number };
  assert.equal(body.contactAnchoredSignals.length, 1, "the new section is on the wire");
  assert.ok(Array.isArray(body.properties), "and the pre-W2-D `properties` key is unchanged, so an older client still works");
  assert.equal(body.unusableSignalCount, 0);

  // Another tenant's admin asking for the same partyId gets nothing, and
  // learns nothing about whether the contact exists.
  const theirs = await fetch(`${baseUrl}${path}`, { headers: { cookie: B.admin.cookie } });
  assert.equal(theirs.status, 404, "a foreign-tenant partyId is not found, not forbidden-but-confirmed");
  const theirBody = (await theirs.text()).toLowerCase();
  assert.equal(theirBody.includes("w2d"), false, "no fixture contact detail leaks across the tenancy boundary");
});

/* =====================================================================
 * 6. DETERMINISM.
 *
 * Contact 360 read its entries out of queries with no ORDER BY. Postgres
 * guarantees nothing about the order of such a result, so the same contact
 * could render the same properties in a different sequence on consecutive
 * loads. Nothing was lost — which is what made it easy to miss and corrosive
 * to trust: an agent watching a list reshuffle between refreshes cannot tell
 * "the data changed" from "the data moved".
 *
 * Same spirit as the determinism test in PR #55 for the coaching metrics.
 * ===================================================================*/

/**
 * A contact built specifically to be REORDERABLE, so a passing assertion means
 * something. Several properties whose addresses do not sort in insertion
 * order, several signals each, a property reached only by a signal, and two
 * Active relationships against one property so the dedupe has a real choice to
 * make.
 */
async function createReorderableContact(label: string): Promise<{ partyId: number; propertyIds: number[]; sharedPropertyId: number }> {
  const partyId = await createParty(A.brokerageId, label);

  // Deliberately NOT inserted in address order.
  const addresses = ["40 Mid St", "10 Alpha Ave", "70 Zulu Way", "25 Beta Blvd"];
  const propertyIds: number[] = [];
  for (const address of addresses) {
    const id = await createProperty(A.brokerageId, A.admin.user.id, address);
    propertyIds.push(id);
    await createRelationship({ brokerageId: A.brokerageId, partyId, propertyId: id, relationshipType: "owner" });
    for (let i = 0; i < 3; i++) {
      await insertRawSignal({ brokerageId: A.brokerageId, partyId, propertyId: id, signalType: "long_ownership_tenure" });
    }
  }

  // A SECOND Active relationship on one property. The dedupe keeps one row per
  // property, so without an ordered read Postgres picked which
  // relationshipType the panel displayed — and could pick differently next
  // time, relabelling the same contact "owner" then "landlord".
  const sharedPropertyId = propertyIds[0];
  await createRelationship({ brokerageId: A.brokerageId, partyId, propertyId: sharedPropertyId, relationshipType: "landlord" });

  // A property reached ONLY by a signal — the other source of entries, which
  // is concatenated onto the first and so cannot share its ORDER BY.
  const signalOnly = await createProperty(A.brokerageId, A.admin.user.id, "05 Signal Only Ct");
  await insertRawSignal({ brokerageId: A.brokerageId, partyId, propertyId: signalOnly, signalType: "long_ownership_tenure" });

  // And contact-anchored signals, which have their own ordering to keep.
  for (let i = 0; i < 3; i++) {
    await insertRawSignal({ brokerageId: A.brokerageId, partyId, propertyId: null, signalType: "re_engagement_opportunity" });
  }

  return { partyId, propertyIds, sharedPropertyId };
}

test("W2-D: repeated reads of the same contact return byte-identical output", async () => {
  const { partyId } = await createReorderableContact("Deterministic");
  // t223u: hold the database-wide sweep lock while reading, so a sibling file's UNSCOPED sweep
  // cannot add a signal for this contact between two reads (seen once in a parallel repro).
  const releaseSweepLock = await acquireSweepLockForTest();
  try {
  // Ten reads. One repeat could coincide; a planner free to reorder will
  // usually do so within ten, and any single divergence fails the assertion.
  const first = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
  for (let attempt = 0; attempt < 10; attempt++) {
    const again = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
    assert.deepEqual(again, first, `read ${attempt + 2} differs from the first — the response is not deterministic`);
  }

  // Byte-for-byte over the wire too, which is what a client actually receives.
  const bodies: string[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${baseUrl}/api/grow/property-intelligence/contact/${partyId}`, { headers: { cookie: A.admin.cookie } });
    assert.equal(res.status, 200);
    bodies.push(await res.text());
  }
  assert.equal(new Set(bodies).size, 1, "every HTTP response body is identical");
  } finally {
    await releaseSweepLock();
  }
});

test("W2-D: the entry order is TOTAL — recorded relationships first, then address, with a unique tiebreak", async () => {
  const { partyId } = await createReorderableContact("TotalOrder");
  const summary = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);

  // 1. Recorded relationships precede signal-only entries.
  const ranks = summary.properties.map((e) => (e.relationshipType === SIGNAL_ONLY_RELATIONSHIP_TYPE ? 1 : 0));
  assert.deepEqual(ranks, [...ranks].sort(), "signal-only entries never interleave with recorded relationships");
  assert.ok(ranks.includes(1), "the fixture really does include a signal-only entry");
  assert.ok(ranks.includes(0), "and a recorded one");

  // 2. Within a group, address order — and the fixture was NOT inserted in
  //    address order, so this is the sort doing the work.
  const recorded = summary.properties.filter((e) => e.relationshipType !== SIGNAL_ONLY_RELATIONSHIP_TYPE);
  assert.deepEqual(
    recorded.map((e) => e.propertyAddress),
    [...recorded.map((e) => e.propertyAddress)].sort((a, b) => a.localeCompare(b)),
    "recorded entries are in address order",
  );
  assert.notDeepEqual(recorded.map((e) => e.propertyAddress), ["40 Mid St", "10 Alpha Ave", "70 Zulu Way", "25 Beta Blvd"].map((a) => `${a} ${suffix}`), "and that is not merely insertion order");

  // 3. THE UNIQUE TIEBREAK. Two properties sharing an address would otherwise
  //    be free to swap — address and group rank are both non-unique, so
  //    without propertyId the order is not total.
  const duplicate = await createProperty(A.brokerageId, A.admin.user.id, "10 Alpha Ave");
  await createRelationship({ brokerageId: A.brokerageId, partyId, propertyId: duplicate, relationshipType: "owner" });

  const withDuplicate = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
  const sameAddress = withDuplicate.properties.filter((e) => e.propertyAddress === `10 Alpha Ave ${suffix}`);
  assert.equal(sameAddress.length, 2, "the fixture really does have two properties at one address");
  assert.deepEqual(
    sameAddress.map((e) => e.propertyId),
    [...sameAddress.map((e) => e.propertyId)].sort((a, b) => a - b),
    "entries sharing an address are ordered by propertyId",
  );
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.deepEqual(await getContactPropertyIntelligenceSummary(partyId, A.brokerageId), withDuplicate, "and that tie does not reorder between reads");
  }
});

test("W2-D: nested arrays are ordered too — a signal list is as reorderable as an entry list", async () => {
  const { partyId, propertyIds } = await createReorderableContact("NestedOrder");
  const summary = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);

  for (const entry of summary.properties) {
    assert.deepEqual(
      entry.activeSignals.map((s) => s.id),
      [...entry.activeSignals.map((s) => s.id)].sort((a, b) => a - b),
      `property ${entry.propertyId}'s signals are in a stable id order`,
    );
  }
  assert.ok(
    summary.properties.some((e) => e.propertyId === propertyIds[1] && e.activeSignals.length > 1),
    "the fixture gives at least one property several signals, so the ordering is exercised",
  );

  assert.deepEqual(
    summary.contactAnchoredSignals.map((e) => e.signal.id),
    [...summary.contactAnchoredSignals.map((e) => e.signal.id)].sort((a, b) => a - b),
    "contact-anchored entries are ordered too",
  );
  assert.ok(summary.contactAnchoredSignals.length > 1, "and there is more than one of them to order");
});

test("W2-D: which of two Active relationships on one property is displayed is deterministic", async () => {
  const { partyId, sharedPropertyId } = await createReorderableContact("DedupeWinner");

  // The dedupe keeps ONE row per property. Ordering by relationship id makes
  // that the earliest recorded relationship — "owner" here, inserted before
  // "landlord" — rather than whichever row the planner happened to return.
  const first = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
  const shared = first.properties.find((e) => e.propertyId === sharedPropertyId);
  assert.ok(shared, "the doubly-related property is present");
  assert.equal(shared.relationshipType, "owner", "the earliest recorded relationship wins, not an arbitrary one");

  for (let attempt = 0; attempt < 5; attempt++) {
    const again = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
    assert.equal(
      again.properties.find((e) => e.propertyId === sharedPropertyId)?.relationshipType,
      "owner",
      "and the same contact is never relabelled between reads",
    );
  }

  assert.equal(first.properties.filter((e) => e.propertyId === sharedPropertyId).length, 1, "still exactly one entry per property");
});

/* =====================================================================
 * 7. THE EMPTY STATE — the W2-D acceptance criterion.
 *
 * Before this slice, a contact whose only Active signal was contact-anchored
 * got `[]` from the summary, and Contact 360 rendered "No property
 * intelligence connected to this contact yet." That was affirmatively false:
 * AE held a signal about that person and said it held nothing. The count that
 * would have contradicted it was unreachable — no route field carried it.
 * ===================================================================*/

test("W2-D: a contact whose ONLY signal is contact-anchored is never reported as having nothing", async () => {
  const partyId = await createParty(A.brokerageId, "OnlyContactAnchored");
  // No relationships, no properties, no property-anchored signals. Exactly the
  // shape that produced the false empty state.
  const signalId = await insertRawSignal({ brokerageId: A.brokerageId, partyId, propertyId: null, signalType: "re_engagement_opportunity" });

  const summary = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);

  // The panel's own empty-state condition, mirrored here so this test fails if
  // the API ever stops satisfying it (PropertyIntelligencePanel.tsx renders the
  // empty state only when BOTH collections are empty).
  //
  // Evaluated BEFORE the assertions below, deliberately: asserting the length
  // first narrows it to a literal type, and the compiler then rejects the
  // `=== 0` comparison as provably false. That is a useful thing to know and a
  // useless thing to ship — it would delete the runtime check that catches a
  // future regression.
  const panelWouldShowEmptyState = summary.properties.length === 0 && summary.contactAnchoredSignals.length === 0;
  assert.equal(panelWouldShowEmptyState, false, "Contact 360 must not say 'no property intelligence' about a contact AE has a signal for");

  assert.deepEqual(summary.properties, [], "there genuinely is no property to report");
  assert.equal(summary.contactAnchoredSignals.length, 1, "but there IS intelligence, and it is on the wire");
  assert.equal(summary.contactAnchoredSignals[0].signal.id, signalId);

  // Over HTTP, which is what the panel actually reads.
  const res = await fetch(`${baseUrl}/api/grow/property-intelligence/contact/${partyId}`, { headers: { cookie: A.admin.cookie } });
  const body = (await res.json()) as { properties: unknown[]; contactAnchoredSignals: unknown[] };
  assert.equal(body.contactAnchoredSignals.length, 1, "the route carries it — there is now a field for it to travel in");
  assert.deepEqual(body.properties, []);
});

test("W2-D: a contact with genuinely nothing still reports nothing", async () => {
  // The other half: the empty state must still be reachable when it is TRUE.
  // A fix that simply never shows it would be its own kind of dishonest.
  const partyId = await createParty(A.brokerageId, "GenuinelyEmpty");
  const summary = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);

  const panelWouldShowEmptyState = summary.properties.length === 0 && summary.contactAnchoredSignals.length === 0;
  assert.equal(panelWouldShowEmptyState, true, "the empty state is still reachable when it is the truth");

  assert.deepEqual(summary.properties, []);
  assert.deepEqual(summary.contactAnchoredSignals, []);
  assert.equal(summary.unusableSignalCount, 0);
  assert.equal(summary.outreachRestriction, null);
});
