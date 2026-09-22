// AE GROW COMPLETION PROGRAM — SLICE W2-A. The QUERY SHAPE of
// GET /grow/today, asserted rather than asserted-about.
//
// I-2 was the single worst scale problem in Grow: getGrowTodaySummary() read
// EVERY row of grow_activities for the brokerage and computed a max-per-party
// in a JavaScript loop. grow_activities is the only Grow table that grows with
// USAGE rather than with inventory, and this is the landing surface every
// agent hits every morning — and, via lib/ai/context/growContext.ts, the
// surface underneath every Grow "Ask AE" question.
//
// A performance fix with no test is a performance fix that lasts until the
// next person adds a convenient await inside a loop. This file uses the
// package's own test-only statement observer (setDbQueryObserver, packages/db)
// to pin the two properties that actually matter and that a reviewer cannot
// check by reading a diff:
//
//   1. THE STATEMENT COUNT IS FIXED. It does not grow with the number of
//      contacts, activities, opportunities or signals in the tenant. This is
//      the same claim, and the same instrument, the signal sweep uses for its
//      own bounded-statement guarantee.
//   2. THE ACTIVITY READ IS AN AGGREGATE, SCOPED TO THE PARTIES ACTUALLY IN
//      PLAY. Not a tenant-wide scan whose result is reduced in Node.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, brokerages, growActivities, growRelationships, parties, setDbQueryObserver } from "@aee/db";
import { getGrowTodaySummary } from "../../lib/growToday.js";
import { cleanupBrokerages } from "./testSupport.js";

// This file calls getGrowTodaySummary() directly rather than through HTTP —
// it is asserting the SHAPE of the statements that function issues, and a
// route, a session and an entitlement lookup in between would put their own
// statements into the observer's output for no benefit. The route-level
// behaviour is covered by the three sibling Grow Today test files. No users
// are therefore needed either, only tenants.
async function createBrokerage(name: string): Promise<number> {
  const [row] = await db.insert(brokerages).values({ name }).returning({ id: brokerages.id });
  return row.id;
}

const DAY = 24 * 60 * 60 * 1000;

/** Contacts in the fixture. Small enough to stay fast, large enough that a per-row statement would be unmistakable. */
const CONTACT_COUNT = 40;
/** Activities per contact. The product is what the old implementation dragged into Node on every request. */
const ACTIVITIES_PER_CONTACT = 25;

let brokerageId: number;
let smallBrokerageId: number;

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();

  brokerageId = await createBrokerage(`W2A Query Shape ${Date.now()}`);
  smallBrokerageId = await createBrokerage(`W2A Query Shape Small ${Date.now()}`);

  // No properties at all in this fixture, deliberately: growRelationships and
  // growActivities both allow a null propertyId (the pre-property prospecting
  // contact this product is built around), and leaving properties out keeps
  // the statement shapes being measured free of anything incidental.
  const contactRows = Array.from({ length: CONTACT_COUNT }, (_, i) => ({
    brokerageId,
    firstName: "Shape",
    lastName: `Contact${i}`,
  }));
  const contacts = await db.insert(parties).values(contactRows).returning({ id: parties.id });

  await db.insert(growRelationships).values(
    contacts.map((c) => ({
      brokerageId,
      partyId: c.id,
      propertyId: null,
      relationshipType: "owner",
      status: "Active",
      validFrom: new Date(Date.now() - 400 * DAY),
    })) as any,
  );

  const activityRows: Array<Record<string, unknown>> = [];
  for (const contact of contacts) {
    for (let j = 0; j < ACTIVITIES_PER_CONTACT; j++) {
      activityRows.push({
        brokerageId,
        partyId: contact.id,
        propertyId: null,
        activityType: "Call",
        summary: `Fixture activity ${j}`,
        occurredAt: new Date(Date.now() - (30 + j) * DAY),
      });
    }
  }
  await db.insert(growActivities).values(activityRows as any);

  // The small tenant exists only to prove the statement count does NOT scale
  // with tenant size: one contact, one activity, same shape.
  const [smallContact] = await db
    .insert(parties)
    .values({ brokerageId: smallBrokerageId, firstName: "Tiny", lastName: "Tenant" })
    .returning();
  await db.insert(growRelationships).values({
    brokerageId: smallBrokerageId,
    partyId: smallContact.id,
    propertyId: null,
    relationshipType: "owner",
    status: "Active",
    validFrom: new Date(Date.now() - 400 * DAY),
  } as any);
  await db.insert(growActivities).values({
    brokerageId: smallBrokerageId,
    partyId: smallContact.id,
    propertyId: null,
    activityType: "Call",
    summary: "Only activity",
    occurredAt: new Date(Date.now() - 40 * DAY),
  } as any);
});

after(async () => {
  await cleanupBrokerages([brokerageId, smallBrokerageId]);
});

/** Runs one Grow Today read with the statement tap installed, and returns the statements it issued. */
async function captureStatements(id: number, options?: { includePropertyIntelligenceSignals?: boolean }): Promise<string[]> {
  const statements: string[] = [];
  const uninstall = setDbQueryObserver((query) => statements.push(query));
  try {
    await getGrowTodaySummary(id, options);
  } finally {
    uninstall();
  }
  return statements;
}

test("I-2 — the activity read is a grouped aggregate scoped to the parties in play, not a tenant-wide scan reduced in Node", async () => {
  const statements = await captureStatements(brokerageId);

  const activityStatements = statements.filter((s) => /from\s+"?grow_activities"?/i.test(s));
  assert.equal(activityStatements.length, 1, "exactly one statement may touch grow_activities");

  const [activity] = activityStatements;
  assert.match(activity, /max\(/i, "the max-per-party must be computed by the database");
  assert.match(activity, /group by/i, "...as an aggregate, returning one row per party rather than every activity row");
  assert.match(
    activity,
    /party_id"?\s*=\s*any/i,
    "and scoped to the party ids the other rules actually asked about, which is what bounds it",
  );
  assert.match(activity, /brokerage_id/i, "tenant scoping is never optional");
});

test("I-2 — the aggregate returns one row per contact, not one row per activity", async () => {
  // The claim being measured: the old implementation shipped
  // CONTACT_COUNT * ACTIVITIES_PER_CONTACT rows to Node to produce a map of
  // CONTACT_COUNT entries. This asserts the map is built from the smaller
  // number by checking both against the data that exists.
  const everyActivityRow = await db
    .select({ partyId: growActivities.partyId })
    .from(growActivities)
    .where(eq(growActivities.brokerageId, brokerageId));
  assert.equal(
    everyActivityRow.length,
    CONTACT_COUNT * ACTIVITIES_PER_CONTACT,
    "sanity: the fixture really does hold one row per contact per activity",
  );

  const summary = await getGrowTodaySummary(brokerageId);
  // Every contact is cold (their most recent activity is 30+ days old) and
  // none has an opportunity, so each one produces exactly one Rule D card
  // carrying the aggregate's answer.
  const coldCards = summary.priorityActions.filter((a) => a.type === "relationship_cold");
  assert.equal(coldCards.length, CONTACT_COUNT, "every contact resolved to a card");
  assert.ok(
    coldCards.every((c) => c.lastActivityAt !== null),
    "every card got a last-activity timestamp, so the aggregate answered for every party it was asked about",
  );
  assert.ok(
    coldCards.every((c) => /No contact recorded for 30 days\./.test(c.reason)),
    "and it answered with the MOST RECENT activity (30 days), not the oldest (54)",
  );
});

test("the statement count is FIXED — it does not grow with the size of the tenant", async () => {
  const large = await captureStatements(brokerageId);
  const small = await captureStatements(smallBrokerageId);

  assert.equal(
    large.length,
    small.length,
    `a 1,000-activity tenant and a 1-activity tenant must issue the same number of statements; got ${large.length} vs ${small.length}`,
  );

  // THE EXACT COUNTS, pinned so a future change that adds a read has to come
  // here and say so rather than quietly costing every agent an extra round
  // trip every morning.
  //
  // These are also the numbers that make the W2-A rewrite's "statement count
  // unchanged" claim checkable. Before the rewrite: four parallel rule reads
  // (one of them the tenant-wide activity scan) plus contactability's two
  // serial statements. After: three parallel rule reads, then the bounded
  // activity aggregate and contactability's two — six statements, with the
  // activity read no longer tenant-wide and contactability's pair no longer
  // serial.
  //
  // F-1 adds exactly one bounded grow_commitments read to that first wave.
  assert.equal(
    large.length,
    7,
    `expected 7 statements without Property Intelligence; got ${large.length}:\n${large.join("\n---\n")}`,
  );

  const withSignals = await captureStatements(brokerageId, { includePropertyIntelligenceSignals: true });
  assert.equal(
    withSignals.length,
    8,
    `Rule F adds exactly one statement and no more; got ${withSignals.length}:\n${withSignals.join("\n---\n")}`,
  );
});

test("every unbounded tenant read is gone: each rule read carries a limit, and the response carries the cap it was read under", async () => {
  const statements = await captureStatements(brokerageId, { includePropertyIntelligenceSignals: true });

  for (const table of ["grow_relationships", "grow_opportunities", "appraisals", "grow_commitments", "grow_opportunity_signals"]) {
    const matching = statements.filter((s) => new RegExp(`from\\s+"?${table}"?`, "i").test(s));
    assert.equal(matching.length, 1, `exactly one statement may read ${table}`);
    assert.match(matching[0], /limit/i, `the ${table} read must be bounded — this was an unbounded tenant read (I-4)`);
    assert.match(matching[0], /order by/i, `...and ordered, so the cap drops the least relevant rows deterministically`);
  }

  // Entitlement gating still short-circuits the signal read entirely, at zero
  // DB cost, exactly as before.
  const withoutSignals = await captureStatements(brokerageId, { includePropertyIntelligenceSignals: false });
  assert.ok(
    !withoutSignals.some((s) => /from\s+"?grow_opportunity_signals"?/i.test(s)),
    "an unentitled caller must still cost nothing for Rule F",
  );
});

test("the summary reports no truncation for a tenant comfortably under every cap", async () => {
  const summary = await getGrowTodaySummary(brokerageId);
  assert.deepEqual(
    summary.signalSummary.limitations,
    [],
    "a bound that is not reached must say nothing — a permanent 'results may be incomplete' banner teaches agents to ignore it",
  );
  assert.equal(summary.signalSummary.withheldByActionCap, 0);
  assert.equal(summary.counts.priorityActions, summary.priorityActions.length);
});
