// AE GROW W2-C (C-9) — DB-integration coverage for the ONE bounded fetch in
// coaching/metrics.ts that had no orderBy.
//
// metrics.ts's own header states the discipline: "every list is capped by one
// of the *_ROW_CAP constants before it reaches a compute function". A cap
// without an order is not a bound, it is a sample: above ACTIVITY_ROW_CAP,
// Postgres was free to hand fetchRecentActivityByParty ANY 2000 of the
// matching rows, and a different 2000 on the next call (plan flips, heap
// order changes after vacuum/updates, parallel workers). Which contacts
// counted as "recently engaged" therefore varied run to run, and
// noRecentActivityContacts over-reported by an amount nobody could predict.
//
// Kept out of metrics.test.ts deliberately: that file is pure by design and
// says so in its own header ("never the database"). The defect here is
// precisely in the part a pure test cannot see — the SQL — so it needs a real
// Postgres, following the same throwaway-brokerage fixture convention as
// __tests__/coachOrchestrator.test.ts.
import { randomUUID } from "node:crypto";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, brokerages, growActivities, parties } from "@aee/db";
import {
  ACTIVITY_ROW_CAP,
  computeRelationshipEngagement,
  fetchRecentActivityByParty,
  type RelationshipRow,
} from "../metrics.js";

// Comfortably over the cap, so the rows that must be dropped are unambiguous.
const OVER_CAP_BY = 250;
const TOTAL_ACTIVITY_ROWS = ACTIVITY_ROW_CAP + OVER_CAP_BY;
const PARTY_COUNT = 25;

// Every fixture activity falls inside this window, so `since` never does any
// of the filtering work the cap is supposed to be doing.
const SINCE = new Date("2026-01-01T00:00:00.000Z");
const BASE = new Date("2026-02-01T00:00:00.000Z").getTime();

let brokerageId: number;
let partyIds: number[] = [];

before(async () => {
  const [brokerage] = await db.insert(brokerages).values({ name: `W2C Bounding Test (${randomUUID()})` }).returning();
  brokerageId = brokerage.id;

  const partyRows = await db
    .insert(parties)
    .values(
      Array.from({ length: PARTY_COUNT }, (_, i) => ({
        brokerageId,
        partyType: "Person",
        firstName: "Bound",
        lastName: `Party${i}`,
      })),
    )
    .returning({ id: parties.id });
  partyIds = partyRows.map((row) => row.id);

  // Deliberately inserted OLDEST FIRST. An unordered `limit` over a freshly
  // populated heap tends to return rows in insertion order, so this fixture
  // makes the missing-orderBy bug visible rather than accidentally passing:
  // without the fix the query returns the 2000 OLDEST rows, and the newest
  // 250 activities — the ones that actually establish recent engagement —
  // are the set thrown away.
  //
  // Each row's occurredAt is one minute apart, EXCEPT that rows are inserted
  // in pairs sharing a timestamp, which is what a bulk import produces and
  // what makes occurredAt alone a partial rather than total order.
  const values = Array.from({ length: TOTAL_ACTIVITY_ROWS }, (_, i) => ({
    brokerageId,
    partyId: partyIds[i % PARTY_COUNT],
    activityType: "Call",
    occurredAt: new Date(BASE + Math.floor(i / 2) * 60_000),
    summary: `fixture activity ${i}`,
  }));
  for (let i = 0; i < values.length; i += 500) {
    await db.insert(growActivities).values(values.slice(i, i + 500));
  }
});

after(async () => {
  if (brokerageId === undefined) return;
  await db.delete(growActivities).where(eq(growActivities.brokerageId, brokerageId));
  await db.delete(parties).where(eq(parties.brokerageId, brokerageId));
  await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
});

function relationshipsForEveryParty(): RelationshipRow[] {
  return partyIds.map((partyId, i) => ({ id: i + 1, partyId, relationshipType: "Owner", isPrimary: true }));
}

test("fetchRecentActivityByParty: above ACTIVITY_ROW_CAP the SAME rows come back on every call", async () => {
  const first = await fetchRecentActivityByParty(brokerageId, SINCE);
  const second = await fetchRecentActivityByParty(brokerageId, SINCE);
  const third = await fetchRecentActivityByParty(brokerageId, SINCE);

  assert.equal(first.length, ACTIVITY_ROW_CAP, "the cap must actually bite for this fixture to prove anything");
  assert.deepEqual(second, first, "repeated reads of unchanged data must return an identical row set");
  assert.deepEqual(third, first);
});

test("fetchRecentActivityByParty: the rows kept are the MOST RECENT ones, in a total order", async () => {
  const rows = await fetchRecentActivityByParty(brokerageId, SINCE);

  for (let i = 1; i < rows.length; i++) {
    assert.ok(
      rows[i - 1].occurredAt.getTime() >= rows[i].occurredAt.getTime(),
      `rows must be returned newest first; row ${i} is newer than row ${i - 1}`,
    );
  }

  // The newest fixture timestamp must be present and the oldest absent: this
  // is the assertion that fails outright without the orderBy, because an
  // unordered limit keeps the oldest rows instead.
  const newestFixture = BASE + Math.floor((TOTAL_ACTIVITY_ROWS - 1) / 2) * 60_000;
  assert.equal(rows[0].occurredAt.getTime(), newestFixture, "the single most recent activity must never be the one dropped");
  const oldestKept = rows[rows.length - 1].occurredAt.getTime();
  assert.ok(oldestKept > BASE, "the oldest activities are the ones the cap should drop, not the newest");
});

test("computeRelationshipEngagement: activity-row truncation is disclosed, and the metric is stable across runs", async () => {
  const relationships = relationshipsForEveryParty();
  const first = computeRelationshipEngagement(relationships, await fetchRecentActivityByParty(brokerageId, SINCE));
  const second = computeRelationshipEngagement(relationships, await fetchRecentActivityByParty(brokerageId, SINCE));

  assert.deepEqual(second, first, "the whole metric, not just the row set, must be reproducible");

  assert.equal(first.activityTruncated, true);
  assert.equal(first.truncated, false, "relationship rows are well under their own cap here — the two truncations are reported separately");

  const disclosure = first.limitations.find((l) => l.includes("activity record"));
  assert.ok(
    disclosure !== undefined,
    `activity-row truncation must be disclosed in limitations the same way relationship-row truncation is; got ${JSON.stringify(first.limitations)}`,
  );
  assert.ok(disclosure.includes(String(ACTIVITY_ROW_CAP)), "the disclosure must name the cap that was hit");
  assert.ok(
    /no recent activity may be overstated/.test(disclosure),
    "the disclosure must say WHICH WAY the truncation biases the numbers, not merely that it happened",
  );
});
