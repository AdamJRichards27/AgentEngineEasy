// I-16 — the contactability filter evaluates each party id once per pass.
//
// Grow Today concatenates party ids from several rule reads. The sweep can
// hand the same party more than once. Before this was locked, a repeated id
// was another bind slot and could push a later id into another 5,000-id
// chunk, and the two statements in a chunk ran one after the other.
//
// This file uses the test-only statement observer to pin the waste that a
// reviewer cannot see from the result set alone:
//
//   1. A repeated id is one slot in the bind array, and a list that would
//      span several chunks if the copies were kept is still one chunk.
//   2. An id that belongs in a later chunk is still read. Deduping does not
//      drop the tail.
//   3. Outcomes stay fail-closed. LISTED and a suppression on every channel
//      block. DNCR UNKNOWN (the register was checked and could not answer —
//      the consent engine's DNCR_STATUS_UNKNOWN / REVIEW_REQUIRED posture)
//      and an unrecognised suppression state also block. NOT_CHECKED,
//      CLEARED, a single-channel suppression, an in-force RELEASED, and no
//      rows at all stay allowed. A listing in another brokerage does not
//      count. No live provider is involved; these rows are fixtures.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  db,
  brokerages,
  users,
  parties,
  growRelationships,
  growOpportunities,
  growContactDncrStatuses,
  growContactChannelSuppressions,
  GROW_CONSENT_CHANNELS,
  setDbQueryObserver,
} from "@aee/db";
import { loadContactabilityFilter, CONTACTABILITY_CHUNK_SIZE } from "../contactability.js";
import { getGrowTodaySummary } from "../../growToday.js";
import { cleanupBrokerages } from "../../../routes/__tests__/testSupport.js";

type Observed = { query: string; params: unknown[] };

const brokerageIds: number[] = [];

async function createBrokerage(name: string): Promise<number> {
  const [row] = await db.insert(brokerages).values({ name }).returning({ id: brokerages.id });
  brokerageIds.push(row.id);
  return row.id;
}

async function createUser(brokerageId: number): Promise<number> {
  const suffix = randomUUID();
  const [row] = await db
    .insert(users)
    .values({
      brokerageId,
      email: `i16-${suffix}@example.test`,
      authProviderId: `i16-${suffix}`,
      firstName: "I16",
      lastName: "Fixture",
      role: "Agent",
    })
    .returning({ id: users.id });
  return row.id;
}

async function createParty(brokerageId: number, firstName: string): Promise<number> {
  const [row] = await db.insert(parties).values({ brokerageId, firstName, lastName: "I16" }).returning({ id: parties.id });
  return row.id;
}

function parseIdArray(param: unknown): number[] | null {
  if (Array.isArray(param) && param.every((value) => typeof value === "number" && Number.isInteger(value))) return param;
  if (typeof param !== "string" || !param.trim().startsWith("[")) return null;
  try {
    const parsed = JSON.parse(param) as unknown;
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "number" && Number.isInteger(value))) return parsed;
  } catch {
    return null;
  }
  return null;
}

function bindsFor(statements: Observed[], table: string): number[][] {
  const hits = statements.filter((statement) => new RegExp(`from\\s+"?${table}"?`, "i").test(statement.query));
  return hits.map((statement) => {
    const arrays = statement.params.flatMap((param) => {
      const ids = parseIdArray(param);
      return ids ? [ids] : [];
    });
    assert.equal(
      arrays.length,
      1,
      `expected one id-array bind on ${table}; params=${JSON.stringify(statement.params)} query=${statement.query}`,
    );
    assert.match(statement.query, /brokerage_id/i, `${table} must stay brokerage-scoped`);
    return arrays[0];
  });
}

async function capture(run: () => Promise<unknown>): Promise<Observed[]> {
  const statements: Observed[] = [];
  const uninstall = setDbQueryObserver((query, params) => statements.push({ query, params }));
  try {
    await run();
  } finally {
    uninstall();
  }
  return statements;
}

let homeId: number;
let otherId: number;
let todayId: number;
let userId: number;
let listedId: number;
let unknownId: number;
let suppressedId: number;
let unrecognisedId: number;
let clearedId: number;
let notCheckedId: number;
let partialId: number;
let releasedId: number;
let plainId: number;
let foreignListedId: number;

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();

  const suffix = randomUUID();
  homeId = await createBrokerage(`I16 home ${suffix}`);
  otherId = await createBrokerage(`I16 other ${suffix}`);
  todayId = await createBrokerage(`I16 today ${suffix}`);
  userId = await createUser(homeId);
  const otherUserId = await createUser(otherId);

  listedId = await createParty(homeId, "Listed");
  unknownId = await createParty(homeId, "Unknown");
  suppressedId = await createParty(homeId, "Suppressed");
  unrecognisedId = await createParty(homeId, "Unrecognised");
  clearedId = await createParty(homeId, "Cleared");
  notCheckedId = await createParty(homeId, "NotChecked");
  partialId = await createParty(homeId, "Partial");
  releasedId = await createParty(homeId, "Released");
  plainId = await createParty(homeId, "Plain");
  foreignListedId = await createParty(otherId, "ForeignListed");

  await db.insert(growContactDncrStatuses).values([
    { brokerageId: homeId, partyId: listedId, channel: "PHONE_CALL", status: "LISTED", source: "i16-fixture", recordedByUserId: userId },
    { brokerageId: homeId, partyId: unknownId, channel: "PHONE_CALL", status: "UNKNOWN", source: "i16-fixture", recordedByUserId: userId },
    {
      brokerageId: homeId,
      partyId: clearedId,
      channel: "PHONE_CALL",
      status: "CLEARED",
      source: "i16-fixture",
      reference: "i16-cleared-ref",
      recordedByUserId: userId,
    },
    { brokerageId: homeId, partyId: notCheckedId, channel: "PHONE_CALL", status: "NOT_CHECKED", source: "i16-fixture", recordedByUserId: userId },
    {
      brokerageId: otherId,
      partyId: foreignListedId,
      channel: "PHONE_CALL",
      status: "LISTED",
      source: "i16-fixture",
      recordedByUserId: otherUserId,
    },
  ]);

  await db.insert(growContactChannelSuppressions).values([
    ...GROW_CONSENT_CHANNELS.map((channel) => ({
      brokerageId: homeId,
      partyId: suppressedId,
      channel,
      state: "SUPPRESSED",
      reason: "i16-fixture",
      recordedByUserId: userId,
    })),
    ...GROW_CONSENT_CHANNELS.map((channel) => ({
      brokerageId: homeId,
      partyId: unrecognisedId,
      channel,
      state: "QUARANTINED_PENDING_REVIEW",
      reason: "i16-fixture-unrecognised",
      recordedByUserId: userId,
    })),
    {
      brokerageId: homeId,
      partyId: partialId,
      channel: "SMS",
      state: "SUPPRESSED",
      reason: "i16-fixture-partial",
      recordedByUserId: userId,
    },
    ...GROW_CONSENT_CHANNELS.flatMap((channel) => [
      {
        brokerageId: homeId,
        partyId: releasedId,
        channel,
        state: "SUPPRESSED",
        reason: "i16-fixture-before-release",
        effectiveAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        recordedByUserId: userId,
      },
      {
        brokerageId: homeId,
        partyId: releasedId,
        channel,
        state: "RELEASED",
        reason: "i16-fixture-released",
        effectiveAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        recordedByUserId: userId,
      },
    ]),
  ]);
});

after(async () => {
  await cleanupBrokerages(brokerageIds);
});

test("I-16 — duplicate ids are one bind slot and one chunk, and the suppressed set matches the unique pass", async () => {
  const unique = [listedId, unknownId, plainId, null, 1.5];
  const repeated = Array.from({ length: CONTACTABILITY_CHUNK_SIZE * 2 + 3 }, (_, index) => unique[index % unique.length]);
  assert.ok(repeated.length > CONTACTABILITY_CHUNK_SIZE * 2, "the fixture must be large enough to span chunks if copies were kept");

  const once = await loadContactabilityFilter(homeId, unique);
  const statements = await capture(() => loadContactabilityFilter(homeId, repeated));
  const again = await loadContactabilityFilter(homeId, repeated);

  const dncr = bindsFor(statements, "grow_contact_dncr_statuses");
  const suppressions = bindsFor(statements, "grow_contact_channel_suppressions");
  assert.equal(dncr.length, 1, "repeated copies must not open a second DNCR chunk");
  assert.equal(suppressions.length, 1, "repeated copies must not open a second suppression chunk");
  assert.deepEqual(dncr[0], [listedId, unknownId, plainId]);
  assert.deepEqual(suppressions[0], [listedId, unknownId, plainId]);
  assert.deepEqual([...again.suppressedPartyIds].sort((a, b) => a - b), [...once.suppressedPartyIds].sort((a, b) => a - b));
  assert.equal(again.isSuppressed(listedId), true);
  assert.equal(again.isSuppressed(plainId), false);
  assert.equal(again.isSuppressed(null), false);

  const contactabilityStatements = statements.filter((statement) =>
    /grow_contact_dncr_statuses|grow_contact_channel_suppressions/i.test(statement.query),
  );
  assert.equal(contactabilityStatements.length, 2, "one chunk is two statements, not two per copy");
});

test("I-16 — blocked, inconclusive, and allowed outcomes stay fail-closed and brokerage-scoped", async () => {
  const ids = [
    listedId,
    unknownId,
    suppressedId,
    unrecognisedId,
    clearedId,
    notCheckedId,
    partialId,
    releasedId,
    plainId,
    foreignListedId,
    null,
  ];
  const filter = await loadContactabilityFilter(homeId, ids);

  assert.equal(filter.isSuppressed(listedId), true, "DNCR LISTED blocks");
  assert.equal(filter.isSuppressed(suppressedId), true, "a suppression on every channel blocks");
  assert.equal(filter.isSuppressed(unknownId), true, "DNCR UNKNOWN fails closed — the review-required posture, not an allow");
  assert.equal(filter.isSuppressed(unrecognisedId), true, "an unrecognised suppression state fails closed");

  assert.equal(filter.isSuppressed(clearedId), false, "CLEARED stays allowed");
  assert.equal(filter.isSuppressed(notCheckedId), false, "NOT_CHECKED is missing data, not a block");
  assert.equal(filter.isSuppressed(partialId), false, "a single-channel suppression does not hide the contact");
  assert.equal(filter.isSuppressed(releasedId), false, "an in-force RELEASED restores the contact");
  assert.equal(filter.isSuppressed(plainId), false, "no consent rows stays allowed");
  assert.equal(filter.isSuppressed(null), false, "a property-only signal has no contact to protect");
  assert.equal(filter.isSuppressed(foreignListedId), false, "another brokerage's LISTED row is not read");

  const foreign = await loadContactabilityFilter(otherId, [foreignListedId, listedId]);
  assert.equal(foreign.isSuppressed(foreignListedId), true, "the same LISTED row blocks inside its own brokerage");
  assert.equal(foreign.isSuppressed(listedId), false, "home's LISTED row does not block the other brokerage");
});

test("I-16 — an id past the chunk boundary is still evaluated exactly once", async () => {
  const syntheticBase = 1_500_000_000;
  const leading = Array.from({ length: CONTACTABILITY_CHUNK_SIZE }, (_, index) => syntheticBase + index);
  const ids = [...leading, listedId];
  assert.equal(new Set(ids).size, ids.length, "the boundary fixture must already be unique");

  const statements = await capture(async () => {
    const filter = await loadContactabilityFilter(homeId, ids);
    assert.equal(filter.isSuppressed(listedId), true, "a LISTED id in the second chunk is still blocked");
    assert.equal(filter.isSuppressed(syntheticBase), false);
  });

  const dncr = bindsFor(statements, "grow_contact_dncr_statuses");
  assert.equal(dncr.length, 2, "5,001 distinct ids are two chunks");
  assert.equal(dncr[0].length, CONTACTABILITY_CHUNK_SIZE);
  assert.deepEqual(dncr[1], [listedId]);
  assert.equal(dncr.flat().filter((id) => id === listedId).length, 1);
  const suppressions = bindsFor(statements, "grow_contact_channel_suppressions");
  assert.deepEqual(suppressions, dncr);
});

test("I-16 — Grow Today evaluates an overlapping party once across the concatenated rule reads", async () => {
  const shared = await createParty(todayId, "Shared");
  const relationshipOnly = await createParty(todayId, "RelationshipOnly");
  const opportunityOnly = await createParty(todayId, "OpportunityOnly");
  const expected = [shared, relationshipOnly, opportunityOnly];

  await db.insert(growRelationships).values([
    { brokerageId: todayId, partyId: shared, relationshipType: "owner", status: "Active", validFrom: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) },
    { brokerageId: todayId, partyId: relationshipOnly, relationshipType: "owner", status: "Active", validFrom: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) },
  ]);
  await db.insert(growOpportunities).values([
    { brokerageId: todayId, partyId: shared, opportunityType: "Listing", status: "Open", reason: "i16 overlap" },
    { brokerageId: todayId, partyId: opportunityOnly, opportunityType: "Listing", status: "Open", reason: "i16 opportunity only" },
  ]);

  const statements = await capture(() => getGrowTodaySummary(todayId));
  // G-UAT-7's existence probe also names grow_activities. It is not the
  // party-scoped aggregate this assertion measures.
  const ruleStatements = statements.filter((statement) => !/first_run_probe/i.test(statement.query));
  const dncr = bindsFor(ruleStatements, "grow_contact_dncr_statuses");
  const activity = bindsFor(ruleStatements, "grow_activities");
  assert.equal(dncr.length, 1);
  assert.equal(activity.length, 1);
  assert.deepEqual([...dncr[0]].sort((a, b) => a - b), [...expected].sort((a, b) => a - b));
  assert.equal(dncr[0].filter((id) => id === shared).length, 1, "the shared party is one contactability slot, not one per rule");
  assert.deepEqual([...activity[0]].sort((a, b) => a - b), [...dncr[0]].sort((a, b) => a - b));
});
