// AE GROW Completion W2-D — THE ADVERSARIAL PROOF.
//
// =====================================================================
// WHAT THIS FILE EXISTS TO PROVE, AND WHY ASSERTING IT IS NOT ENOUGH
// =====================================================================
//
// Decision gate 19 reversed a fail-closed behaviour. `listActiveSignalsForParty`
// used to return [] for a DNC-listed or fully-suppressed contact, which erased
// legitimate relationship intelligence from an authorised internal user rather
// than merely removing the outreach they must not perform:
//
//     SIGNAL EXISTS  !=  CONTACT MAY BE CONTACTED.
//
// A suppressed contact's signals are now READABLE. That is only safe if the
// second half of the invariant holds absolutely:
//
//     ROWS MAY BE READ FOR DISPLAY.
//     NO OUTREACH AFFORDANCE MAY BE DERIVED FROM THEM.
//
// The gate's condition was "there is no pathway to actual outreach — PROVE
// this, do not assert it". A comment saying "this response contains no email
// address" is an assertion. This file is the proof: it takes the position of
// somebody who WANTS to reach a suppressed contact, starts from the surface
// this slice widened, and tries every route out of it.
//
// THE ROUTES TRIED, and why each one is the one worth trying:
//
//   1. READ THE PAYLOAD. Recursively walk every key and every string in the
//      real HTTP response for a suppressed contact, looking for anything that
//      could BE a destination (an email address, a phone number) or NAME one
//      (a `mailto:`/`tel:`/`sms:` URI, a channel action). If a destination is
//      not in the payload, a client cannot render a send from it however it
//      behaves.
//   2. PROMOTE THE SIGNAL. The one control on this surface that leads
//      anywhere: promotion creates a grow_opportunities row, and an
//      opportunity is the INPUT to the follow-up funnel — Grow Today renders
//      opportunity cards with email/SMS buttons, and an opportunity can be
//      converted into an appraisal, which sends. Cut here, the whole chain is
//      unreachable from a signal.
//   3. COUNT THE SIDE EFFECTS. No communication message, no delivery attempt,
//      no activity row may be created by ANY of the above. "No communication
//      activity is created automatically" is checked by counting rows before
//      and after, not by reading the code.
//   4. TRY THE CHANNEL THAT REALLY DIALS. The telephony path is party-keyed
//      and independent of everything this slice touches. If it refuses a
//      suppressed contact, the call channel is closed no matter what this
//      surface shows.
//   5. KEEP THE EXISTING CONTROLS. Tenancy and entitlement must be exactly as
//      strict as before; a visibility widening must not become an access
//      widening.
//
// Real Postgres, real HTTP, real fixtures, real sweep. Everything is scoped to
// this file's own brokerages.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  growOpportunitySignals,
  growOpportunities,
  growActivities,
  growRelationships,
  growContactDncrStatuses,
  growContactChannelSuppressions,
  communicationMessages,
  entitlementGrants,
  parties,
  properties,
  GROW_CONSENT_CHANNELS,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../entitlements/resolver.js";
import { getContactPropertyIntelligenceSummary, readActiveSignalsForParty, isOutreachRestrictedForParty } from "../service.js";
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
  A = await createBrokerageWithUsers(baseUrl, `W2D Outreach Pathway A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `W2D Outreach Pathway B ${suffix}`);
  // BOTH tenants are fully entitled, deliberately. The tenancy assertions
  // below must fail on TENANCY, not on a missing entitlement — an unentitled
  // 403 would look like a pass while proving nothing about brokerage scoping.
  for (const t of [A, B]) {
    await grant(t.brokerageId, "grow.propertyIntelligence.read");
    await grant(t.brokerageId, "grow.propertyIntelligence.manage");
  }
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
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number"));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

/* ---------------------------------------------------------------------
 * Fixtures.
 *
 * THE CONTACT IS DELIBERATELY REACHABLE ON PAPER. They are given a real
 * email and a real mobile, so that "no destination appeared in the payload"
 * is a fact about the payload rather than a fact about an empty contact
 * record. A fixture with no contact details would make every assertion below
 * pass for the wrong reason.
 * -----------------------------------------------------------------*/

let seq = 0;

const FIXTURE_EMAIL = `w2d-reachable-${suffix}@example.com`;
const FIXTURE_MOBILE = "+61400111222";

async function createReachableParty(brokerageId: number, label: string): Promise<number> {
  const [row] = await db
    .insert(parties)
    .values({
      brokerageId,
      partyType: "Person",
      firstName: "W2D",
      lastName: `${label}-${suffix}`,
      email: `${label.toLowerCase()}-${FIXTURE_EMAIL}`,
      mobile: FIXTURE_MOBILE,
      createdAt: daysAgo(900),
    })
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

async function createRelationship(brokerageId: number, partyId: number, propertyId: number | null, relationshipType: string): Promise<void> {
  const created = daysAgo(900);
  await db.insert(growRelationships).values({
    brokerageId,
    partyId,
    propertyId,
    relationshipType,
    status: "Active",
    validFrom: created,
    createdAt: created,
    updatedAt: created,
  });
}

async function insertSignal(input: { brokerageId: number; partyId: number; propertyId: number | null; signalType: string }): Promise<number> {
  const [row] = await db
    .insert(growOpportunitySignals)
    .values({
      brokerageId: input.brokerageId,
      partyId: input.partyId,
      propertyId: input.propertyId,
      signalType: input.signalType,
      title: "Worth a look",
      explanation: "Recorded from AE's own records. This is not a prediction that anybody will sell.",
      evidence: {
        schemaVersion: 1,
        rule: input.signalType,
        observations: [{ what: "An enquiry was recorded in AE.", recordType: "grow_relationship", recordId: 1, observedAt: null, source: "internal" }],
        unknowns: ["Whether their plans have changed since."],
        // A GENERATED OUTREACH ACTION, deliberately. Several assertions below
        // exist to prove this exact string never reaches a suppressed
        // contact's response.
        agentAction: "Consider a genuine, useful reason to get back in touch.",
      },
      source: "internal",
      confidenceBand: "WorthReviewing",
      status: "Active",
      dedupeKey: `w2d-pathway-${suffix}-${seq++}`,
    })
    .returning({ id: growOpportunitySignals.id });
  return row.id;
}

/** DNC-lists a contact on one channel, which is all it takes. */
async function dncList(brokerageId: number, partyId: number, adminUserId: number): Promise<void> {
  await db.insert(growContactDncrStatuses).values({
    brokerageId,
    partyId,
    channel: "PHONE_CALL",
    status: "LISTED",
    source: "test-fixture",
    checkedAt: new Date(),
    recordedByUserId: adminUserId,
  });
}

/** Suppresses a contact on every channel — the other route to the same restriction. */
async function suppressEverywhere(brokerageId: number, partyId: number, adminUserId: number): Promise<void> {
  await db.insert(growContactChannelSuppressions).values(
    GROW_CONSENT_CHANNELS.map((channel) => ({
      brokerageId,
      partyId,
      channel,
      state: "SUPPRESSED",
      reason: "test-fixture",
      recordedByUserId: adminUserId,
    })),
  );
}

/* ---------------------------------------------------------------------
 * The payload scanner.
 *
 * Walks EVERY node of the parsed response — objects, arrays, strings,
 * numbers — rather than checking the keys this slice happens to know it
 * added. A field added later by anyone, at any depth, is scanned by the same
 * pass with no test change required. That is the point: the assertion is
 * about the payload as a whole, not about a list of fields somebody
 * remembered to enumerate.
 * -----------------------------------------------------------------*/

interface ScanHit {
  path: string;
  value: string;
  why: string;
}

/**
 * ISO-8601 timestamps, removed before the phone scan.
 *
 * `computedAt`, `createdAt` and `updatedAt` are legitimately on every signal
 * row and are long runs of punctuated digits. Stripping them first is what
 * lets the phone pattern below stay aggressive without drowning a real hit in
 * four false ones per signal.
 */
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g;

/**
 * Patterns for something that IS a destination or NAMES one.
 *
 * The phone pattern is deliberately broad — international (+61…), local
 * (0400…), and spaced or bracketed forms — but anchored so it cannot fire on
 * a digit run that is part of a longer token. `(?<![\w-])` is what keeps it
 * off `w2d-pathway-1789974663757-10`: a dedupe key's digits are preceded by a
 * hyphen inside a larger identifier and are not a number anyone could dial.
 *
 * Erring toward over-matching is correct here. A false positive costs one
 * tightening like this one; a false negative means shipping a destination on a
 * DNC contact's record.
 */
const DESTINATION_PATTERNS: Array<{ why: string; re: RegExp }> = [
  { why: "an email address", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { why: "a channel URI that would place a call or open a composer", re: /\b(?:mailto|tel|sms|callto|whatsapp):/i },
  { why: "a phone number", re: /(?<![\w-])(?:\+\d[\d\s()-]{6,}\d|0\d[\d\s()-]{6,}\d)/ },
];

/** Keys that would carry a destination or a channel action, whatever their value. */
const FORBIDDEN_KEY = /^(?:email|mobile|phone|phoneNumber|mobileNumber|contactEmail|contactMobile|recipient|recipientDestination|destination|destinationRaw|e164|smsTo|emailTo|to|cc|bcc)$/i;

/** Action verbs that would mean "AE is offering to contact this person". */
const OUTREACH_ACTION = /\b(?:send_?(?:email|sms)|email|sms|call|dial|text|outreach|compose)\b/i;

function scanForDestinations(node: unknown, path = "$", hits: ScanHit[] = []): ScanHit[] {
  if (node === null || node === undefined) return hits;

  if (Array.isArray(node)) {
    node.forEach((item, i) => scanForDestinations(item, `${path}[${i}]`, hits));
    return hits;
  }

  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(key)) {
        hits.push({ path: `${path}.${key}`, value: JSON.stringify(value), why: `a destination-bearing key (${key})` });
      }
      scanForDestinations(value, `${path}.${key}`, hits);
    }
    return hits;
  }

  // Numbers are stringified and scanned too — a mobile stored as an integer is
  // still a mobile.
  const raw = typeof node === "string" ? node : typeof node === "number" ? String(node) : "";
  if (raw === "") return hits;
  const text = raw.replace(ISO_TIMESTAMP, " ");

  for (const { why, re } of DESTINATION_PATTERNS) {
    if (re.test(text)) hits.push({ path, value: raw, why });
  }
  return hits;
}

function describe(hits: ScanHit[]): string {
  return hits.map((h) => `${h.path} contains ${h.why}: ${h.value}`).join("\n");
}

/**
 * THE SCANNER MUST BE ABLE TO FAIL, and must not cry wolf.
 *
 * A proof resting on a check that cannot fail is not a proof — so the
 * positives below are as load-bearing as anything in this file. The negatives
 * matter just as much: a scanner that flagged every timestamp would have been
 * silenced within a week, and a silenced scanner proves nothing at all.
 */
test("W2-D pathway: the payload scanner actually detects destinations, and only destinations", () => {
  // MUST FIRE.
  assert.equal(scanForDestinations({ a: { b: "reach them at bob@example.com" } }).length, 1, "finds an email in nested prose");
  assert.ok(scanForDestinations({ deep: [{ href: "tel:+61400111222" }] }).length >= 1, "finds a tel: URI");
  assert.ok(scanForDestinations({ note: "ring +61400111222 today" }).length >= 1, "finds an international mobile in prose");
  assert.ok(scanForDestinations({ note: "ring 0400 111 222 today" }).length >= 1, "finds a spaced local mobile in prose");
  assert.ok(scanForDestinations({ note: "office is (07) 3000 1234" }).length >= 1, "finds a bracketed landline");
  assert.equal(scanForDestinations({ mobile: null }).length, 1, "flags a destination-bearing KEY even when its value is null");
  assert.ok(scanForDestinations({ availableActions: [{ action: "sms", partyId: 3 }] }).length === 0, "an action key is checked separately, not by this scanner");

  // MUST NOT FIRE — the shapes a signal row legitimately carries.
  assert.deepEqual(scanForDestinations({ note: "Call them" }), [], "does not fire on ordinary prose");
  assert.deepEqual(scanForDestinations({ id: 42, title: "Long ownership tenure" }), [], "does not fire on ordinary ids and titles");
  assert.deepEqual(scanForDestinations({ computedAt: "2026-09-21T07:11:04.889Z" }), [], "does not fire on an ISO timestamp");
  assert.deepEqual(scanForDestinations({ dedupeKey: "w2d-pathway-1789974663757-10" }), [], "does not fire on a dedupe key's embedded digits");
  assert.deepEqual(scanForDestinations({ postcode: "4000", propertyId: 12345 }), [], "does not fire on a postcode or a row id");
});

/* =====================================================================
 * 1. THE PAYLOAD. No destination, at any depth, for a suppressed contact.
 * ===================================================================*/

test("W2-D pathway: a suppressed contact's response carries the intelligence and NO destination of any kind", async () => {
  const partyId = await createReachableParty(A.brokerageId, "PayloadScan");
  const propertyId = await createProperty(A.brokerageId, A.admin.user.id, "1 Pathway St");
  await createRelationship(A.brokerageId, partyId, propertyId, "owner");
  await insertSignal({ brokerageId: A.brokerageId, partyId, propertyId: null, signalType: "re_engagement_opportunity" });
  await insertSignal({ brokerageId: A.brokerageId, partyId, propertyId, signalType: "long_ownership_tenure" });

  await dncList(A.brokerageId, partyId, A.admin.user.id);

  const res = await fetch(`${baseUrl}/api/grow/property-intelligence/contact/${partyId}`, { headers: { cookie: A.admin.cookie } });
  assert.equal(res.status, 200, "an entitled internal user may still read this contact's intelligence");
  const raw = await res.text();
  const body = JSON.parse(raw) as Record<string, unknown>;

  // (a) THE INTELLIGENCE IS THERE. Without this, everything below passes
  //     trivially by the old behaviour of returning nothing.
  const contactAnchored = body.contactAnchoredSignals as Array<Record<string, unknown>>;
  assert.equal(contactAnchored.length, 1, "the contact-anchored signal is surfaced, not erased");
  const properties_ = body.properties as Array<Record<string, unknown>>;
  assert.ok((properties_[0].activeSignals as unknown[]).length > 0, "and so is their property-anchored signal");

  // (b) THE RESTRICTION IS THERE, AND UNMISTAKABLE.
  const restriction = body.outreachRestriction as Record<string, unknown> | null;
  assert.ok(restriction, "the restriction is on the wire");
  assert.equal(restriction!.outreachProhibited, true);
  assert.equal(restriction!.reason, "contactability_suppressed");
  assert.match(String(restriction!.notice), /do-not-contact/i);
  assert.match(String(restriction!.recommendedAction), /^Do not contact\./);
  assert.deepEqual([...(restriction!.blockedChannels as string[])].sort(), [...GROW_CONSENT_CHANNELS].sort(), "every channel is blocked; this restriction is never partial");

  // (c) NO GENERATED OUTREACH ACTION SURVIVED — ANYWHERE.
  //
  // The field-level check is the obvious one and is NOT sufficient on its
  // own: `agentAction` also lives inside the raw `evidence` jsonb, which is
  // returned whole on every signal, in BOTH the contact-anchored list and
  // each property entry's activeSignals. Nulling the field while leaving the
  // sentence one dereference away in `signal.evidence.agentAction` is a real
  // leak that this assertion caught during development.
  //
  // So the check is against the RAW RESPONSE TEXT. Do not relax it to a
  // field comparison — the whole point is that it does not need to know
  // where the string might be hiding.
  assert.equal(contactAnchored[0].agentAction, null, "the rule's suggested approach is stripped from the entry");
  assert.equal(
    raw.includes("Consider a genuine, useful reason to get back in touch."),
    false,
    "and the exact string the fixture seeded appears NOWHERE in the response, at any depth, in any collection",
  );
  // Named explicitly so a regression points at the right place.
  assert.equal(
    (contactAnchored[0].signal as Record<string, Record<string, unknown>>).evidence.agentAction,
    undefined,
    "not in the contact-anchored signal's raw evidence",
  );
  for (const p of properties_) {
    for (const s of p.activeSignals as Array<Record<string, Record<string, unknown>>>) {
      assert.equal(s.evidence.agentAction, undefined, "nor in a property-anchored signal's raw evidence — the restriction follows the PERSON");
    }
  }

  // And the evidence proper is PRESERVED, which gate 19 requires. Redacting
  // the suggestion must not have degraded the record of what was observed.
  const evidence = (contactAnchored[0].signal as Record<string, Record<string, unknown>>).evidence;
  assert.ok(Array.isArray(evidence.observations) && (evidence.observations as unknown[]).length > 0, "observations preserved");
  assert.ok(Array.isArray(evidence.unknowns) && (evidence.unknowns as unknown[]).length > 0, "unknowns preserved");
  assert.equal(evidence.schemaVersion, 1, "the evidence envelope is intact, not rebuilt");

  // (d) THE WHOLE-PAYLOAD SCAN. Nothing anywhere is, or names, a destination.
  const hits = scanForDestinations(body);
  assert.deepEqual(hits, [], `a suppressed contact's response must contain no destination:\n${describe(hits)}`);

  // (e) And specifically not the details this contact demonstrably HAS — so
  //     (d) passed because the payload excludes them, not because the fixture
  //     had none.
  const [fixture] = await db.select({ email: parties.email, mobile: parties.mobile }).from(parties).where(eq(parties.id, partyId));
  assert.ok(fixture.email && fixture.mobile, "the fixture contact really is reachable on paper");
  assert.equal(raw.includes(fixture.email!), false, "their email address is not in the response");
  assert.equal(raw.includes(fixture.mobile!), false, "their mobile number is not in the response");

  // (f) No channel action is offered under any key.
  for (const entry of contactAnchored) {
    for (const [key, value] of Object.entries(entry)) {
      if (typeof value === "string" && OUTREACH_ACTION.test(value) && key !== "missingPropertyAnchor") {
        assert.fail(`a contact-anchored entry offers an outreach action at ${key}: ${value}`);
      }
    }
  }
});

test("W2-D pathway: the same holds for a full-channel suppression, the other route to the restriction", async () => {
  const partyId = await createReachableParty(A.brokerageId, "SuppressedEverywhere");
  await createRelationship(A.brokerageId, partyId, null, "prospective_seller");
  await insertSignal({ brokerageId: A.brokerageId, partyId, propertyId: null, signalType: "re_engagement_opportunity" });

  await suppressEverywhere(A.brokerageId, partyId, A.admin.user.id);

  const summary = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
  assert.equal(summary.contactAnchoredSignals.length, 1, "the intelligence is readable");
  assert.ok(summary.outreachRestriction, "and outreach is restricted");
  assert.equal(summary.contactAnchoredSignals[0].agentAction, null, "with no suggested approach");

  const hits = scanForDestinations(summary);
  assert.deepEqual(hits, [], `no destination may appear for a fully suppressed contact:\n${describe(hits)}`);
});

/* =====================================================================
 * 2. PROMOTION — the funnel entrance, and the only control that leads anywhere.
 * ===================================================================*/

test("W2-D pathway: a suppressed contact's signal cannot be promoted to an opportunity, over HTTP", async () => {
  const partyId = await createReachableParty(A.brokerageId, "CannotPromote");
  const propertyId = await createProperty(A.brokerageId, A.admin.user.id, "2 Pathway St");
  await createRelationship(A.brokerageId, partyId, propertyId, "owner");
  const contactAnchoredId = await insertSignal({ brokerageId: A.brokerageId, partyId, propertyId: null, signalType: "re_engagement_opportunity" });
  const propertyAnchoredId = await insertSignal({ brokerageId: A.brokerageId, partyId, propertyId, signalType: "long_ownership_tenure" });

  await dncList(A.brokerageId, partyId, A.admin.user.id);

  const opportunitiesBefore = await db.select({ id: growOpportunities.id }).from(growOpportunities).where(eq(growOpportunities.brokerageId, A.brokerageId));

  // BOTH anchors, because the restriction is a property of the PERSON. A
  // suppressed contact's property-anchored signal is just as much a funnel
  // entrance as their contact-anchored one — and the property-anchored one is
  // reachable from the Property Workspace, where the panel does not even
  // fetch the restriction. The server is what closes it.
  for (const [label, signalId] of [
    ["contact-anchored", contactAnchoredId],
    ["property-anchored", propertyAnchoredId],
  ] as const) {
    const res = await fetch(`${baseUrl}/api/grow/property-intelligence/signals/${signalId}/promote`, {
      method: "POST",
      headers: { cookie: A.admin.cookie, "content-type": "application/json" },
    });
    assert.equal(res.status, 409, `${label}: promotion is refused with a conflict, not silently accepted`);
    const body = (await res.json()) as { error: string };
    // REFUSED WITH A REASON. The agent must be able to tell "AE will not let
    // me" from "AE is broken".
    assert.match(body.error, /do-not-contact|suppressed/i, `${label}: the refusal names the reason`);
    assert.match(body.error, /cannot be promoted/i, `${label}: and names what was refused`);
  }

  // NOTHING WAS CREATED. Not a rolled-back row, not an orphan: none at all.
  const opportunitiesAfter = await db.select({ id: growOpportunities.id }).from(growOpportunities).where(eq(growOpportunities.brokerageId, A.brokerageId));
  assert.equal(opportunitiesAfter.length, opportunitiesBefore.length, "no opportunity row was created — the funnel was never entered");

  // And the signals are untouched: refusing is not dismissing.
  const rows = await db
    .select()
    .from(growOpportunitySignals)
    .where(inArray(growOpportunitySignals.id, [contactAnchoredId, propertyAnchoredId]));
  for (const row of rows) {
    assert.equal(row.status, "Active", "the signal is left exactly as it was");
    assert.equal(row.promotedOpportunityId, null, "and is not linked to any opportunity");
  }

  // THE CONTROL CASE. The same request, the same code path, a contactable
  // contact — it succeeds. So the refusals above are the restriction doing its
  // job, not the endpoint being broken for everyone.
  const okParty = await createReachableParty(A.brokerageId, "MayPromote");
  await createRelationship(A.brokerageId, okParty, null, "prospective_seller");
  const okSignal = await insertSignal({ brokerageId: A.brokerageId, partyId: okParty, propertyId: null, signalType: "re_engagement_opportunity" });
  const okRes = await fetch(`${baseUrl}/api/grow/property-intelligence/signals/${okSignal}/promote`, {
    method: "POST",
    headers: { cookie: A.admin.cookie, "content-type": "application/json" },
  });
  assert.equal(okRes.status, 200, "a contactable contact's signal still promotes normally");
});

test("W2-D pathway: promotion becomes possible again only when the listing is lifted", async () => {
  const partyId = await createReachableParty(A.brokerageId, "ListedThenCleared");
  await createRelationship(A.brokerageId, partyId, null, "prospective_seller");
  const signalId = await insertSignal({ brokerageId: A.brokerageId, partyId, propertyId: null, signalType: "re_engagement_opportunity" });

  await dncList(A.brokerageId, partyId, A.admin.user.id);
  assert.ok(await isOutreachRestrictedForParty(partyId, A.brokerageId), "restricted while listed");

  const blocked = await fetch(`${baseUrl}/api/grow/property-intelligence/signals/${signalId}/promote`, { method: "POST", headers: { cookie: A.admin.cookie } });
  assert.equal(blocked.status, 409);

  // The restriction tracks the record, and nothing was destroyed while it was
  // in force — so lifting it restores the full behaviour with no repair step.
  await db.delete(growContactDncrStatuses).where(and(eq(growContactDncrStatuses.brokerageId, A.brokerageId), eq(growContactDncrStatuses.partyId, partyId)));
  assert.equal(await isOutreachRestrictedForParty(partyId, A.brokerageId), null, "the restriction lifts with the listing");

  const allowed = await fetch(`${baseUrl}/api/grow/property-intelligence/signals/${signalId}/promote`, { method: "POST", headers: { cookie: A.admin.cookie } });
  assert.equal(allowed.status, 200, "and the same signal promotes normally afterwards");
});

/* =====================================================================
 * 3. SIDE EFFECTS — nothing was sent, and nothing was recorded as sent.
 * ===================================================================*/

test("W2-D pathway: reading, and attempting to promote, a suppressed contact creates no communication or activity whatsoever", async () => {
  const partyId = await createReachableParty(A.brokerageId, "NoSideEffects");
  const propertyId = await createProperty(A.brokerageId, A.admin.user.id, "3 Pathway St");
  await createRelationship(A.brokerageId, partyId, propertyId, "owner");
  const signalId = await insertSignal({ brokerageId: A.brokerageId, partyId, propertyId: null, signalType: "re_engagement_opportunity" });
  await dncList(A.brokerageId, partyId, A.admin.user.id);

  const countRows = async () => ({
    messages: (await db.select({ id: communicationMessages.id }).from(communicationMessages).where(eq(communicationMessages.brokerageId, A.brokerageId))).length,
    activities: (await db.select({ id: growActivities.id }).from(growActivities).where(eq(growActivities.brokerageId, A.brokerageId))).length,
    opportunities: (await db.select({ id: growOpportunities.id }).from(growOpportunities).where(eq(growOpportunities.brokerageId, A.brokerageId))).length,
  });

  const before = await countRows();

  // Everything an agent can do to this contact from this surface, several
  // times over — reads are not supposed to be side-effecting, which is
  // exactly the kind of claim worth checking rather than believing.
  for (let i = 0; i < 3; i++) {
    await fetch(`${baseUrl}/api/grow/property-intelligence/contact/${partyId}`, { headers: { cookie: A.admin.cookie } });
    await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
    await readActiveSignalsForParty(partyId, A.brokerageId);
    await fetch(`${baseUrl}/api/grow/property-intelligence/signals/${signalId}/promote`, { method: "POST", headers: { cookie: A.admin.cookie } });
  }

  const after = await countRows();
  assert.equal(after.messages, before.messages, "no communication message row was created");
  assert.equal(after.activities, before.activities, "no activity row was created");
  assert.equal(after.opportunities, before.opportunities, "no opportunity row was created");
});

/* =====================================================================
 * 4. THE CHANNEL THAT REALLY DIALS.
 *
 * The telephony path is the only place in this codebase that reaches a
 * provider with a party-keyed destination. It is entirely independent of
 * Property Intelligence, and it resolves consent from the SAME two tables
 * contactability.ts reads. Asserting here that it refuses the very contact
 * this slice made visible is what turns "the panel has no call button" into
 * "the call channel is closed for this person".
 * ===================================================================*/

test("W2-D pathway: a suppressed contact is refused by the outbound-call eligibility gate", async () => {
  const partyId = await createReachableParty(A.brokerageId, "CannotCall");
  await createRelationship(A.brokerageId, partyId, null, "prospective_seller");
  await insertSignal({ brokerageId: A.brokerageId, partyId, propertyId: null, signalType: "re_engagement_opportunity" });
  await suppressEverywhere(A.brokerageId, partyId, A.admin.user.id);

  // Their intelligence is visible...
  const summary = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
  assert.equal(summary.contactAnchoredSignals.length, 1, "the signal this slice surfaces is genuinely visible");
  assert.ok(summary.outreachRestriction);

  // ...and a call to them is refused, by a gate this slice does not touch.
  //
  // The READ-ONLY evaluator deliberately: asking "would this be allowed?"
  // must not itself write a consent decision row, which would make this test
  // a side effect of the kind section 3 above exists to forbid.
  const { evaluateOutboundCallEligibilityReadOnly } = await import("../../telephony/eligibility.js");

  async function callDecision(target: number): Promise<string> {
    try {
      const result = await evaluateOutboundCallEligibilityReadOnly({ brokerageId: A.brokerageId, partyId: target, decidedByUserId: A.admin.user.id });
      return result.evaluation.decision;
    } catch (err) {
      // Documented as fail-closed: a throw IS a refusal, and the error carries
      // the decision it refused with. What is never acceptable is ELIGIBLE.
      const decision = (err as { decision?: string }).decision;
      return decision ?? `threw:${err instanceof Error ? err.name : String(err)}`;
    }
  }

  assert.notEqual(await callDecision(partyId), "ELIGIBLE", "a suppressed contact must never be call-eligible");

  // AND THE HONEST NOTE ON WHAT THIS DOES AND DOES NOT SHOW.
  //
  // In a database with no consent rows — which is every pilot tenant, since
  // the consent tables' only writers are on the telephony path — this gate
  // refuses EVERY contact with REVIEW_REQUIRED / UNKNOWN_CONSENT, not only a
  // suppressed one. So the assertion above is not by itself evidence that the
  // gate discriminates on suppression; it is evidence of something stronger
  // and simpler, which is the claim actually being made here: THE CALL
  // CHANNEL IS CLOSED. A call cannot be placed to this contact, by this
  // surface or any other, without a consent record that does not exist.
  //
  // The contrast is asserted rather than assumed: an unsuppressed contact in
  // the same database reaches the same refusal, which is why no inference
  // about suppression is drawn from the line above.
  const unsuppressed = await createReachableParty(A.brokerageId, "AlsoNotCallable");
  const unsuppressedDecision = await callDecision(unsuppressed);
  assert.notEqual(unsuppressedDecision, "ELIGIBLE", "with no consent record on file, the call gate refuses everyone — it fails closed by default");
});

/* =====================================================================
 * 5. THE CONTROLS THAT MUST NOT HAVE MOVED.
 *
 * Widening what a contact record SHOWS must not widen who may see it. These
 * assertions are deliberately the same ones that held before W2-D.
 * ===================================================================*/

test("W2-D pathway: tenancy and entitlement are exactly as strict as before, restriction or not", async () => {
  const partyId = await createReachableParty(A.brokerageId, "StillScoped");
  await createRelationship(A.brokerageId, partyId, null, "prospective_seller");
  const signalId = await insertSignal({ brokerageId: A.brokerageId, partyId, propertyId: null, signalType: "re_engagement_opportunity" });
  await dncList(A.brokerageId, partyId, A.admin.user.id);

  const readPath = `/api/grow/property-intelligence/contact/${partyId}`;
  const promotePath = `/api/grow/property-intelligence/signals/${signalId}/promote`;

  // Unauthenticated: nothing, and in particular the restriction is not an
  // excuse to answer a stranger.
  assert.equal((await fetch(`${baseUrl}${readPath}`)).status, 401, "no session, no read");
  assert.equal((await fetch(`${baseUrl}${promotePath}`, { method: "POST" })).status, 401, "no session, no promote");

  // Another tenant: 404, and no detail about the contact leaks — a suppressed
  // contact must not be MORE discoverable than any other.
  const foreign = await fetch(`${baseUrl}${readPath}`, { headers: { cookie: B.admin.cookie } });
  assert.equal(foreign.status, 404, "a foreign-tenant partyId is not found");
  const foreignBody = (await foreign.text()).toLowerCase();
  assert.equal(foreignBody.includes("w2d"), false, "no fixture detail crosses the tenancy boundary");
  assert.equal(foreignBody.includes("do-not-contact"), false, "and the restriction itself is not disclosed across tenants either");

  const foreignPromote = await fetch(`${baseUrl}${promotePath}`, { method: "POST", headers: { cookie: B.admin.cookie } });
  assert.equal(foreignPromote.status, 404, "and a foreign tenant cannot promote it either — 404, never the 409 that would confirm it exists");
});

test("W2-D pathway: an authorised internal user is exactly who this is for — the restriction is not a permission check", async () => {
  const partyId = await createReachableParty(A.brokerageId, "AgentCanSee");
  await createRelationship(A.brokerageId, partyId, null, "prospective_seller");
  await insertSignal({ brokerageId: A.brokerageId, partyId, propertyId: null, signalType: "re_engagement_opportunity" });
  await dncList(A.brokerageId, partyId, A.admin.user.id);

  // The Agent identity in the same brokerage — an authorised internal user
  // with the read entitlement, which is precisely the audience decision gate
  // 19 names. They see the intelligence and the restriction.
  const res = await fetch(`${baseUrl}/api/grow/property-intelligence/contact/${partyId}`, { headers: { cookie: A.agent.cookie } });
  assert.equal(res.status, 200);
  const raw = await res.text();
  const body = JSON.parse(raw) as Record<string, unknown>;
  assert.equal((body.contactAnchoredSignals as unknown[]).length, 1, "an entitled agent sees their brokerage's own intelligence");
  assert.ok(body.outreachRestriction, "and sees the restriction alongside it");

  // The payload rule holds for every reader, not just the admin.
  const hits = scanForDestinations(body);
  assert.deepEqual(hits, [], `no destination for any reader:\n${describe(hits)}`);
});
