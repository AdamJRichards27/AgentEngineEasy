// C-9 — SQL shape of fetchRecentActivityByParty.
//
// coaching/metrics.ts caps every list before a compute function sees it.
// A cap without an order is a sample: above ACTIVITY_ROW_CAP, Postgres may
// return any 2000 matching rows, and a different 2000 on the next run.
// computeRelationshipEngagement treats the rows it is given as the
// recent-engagement set, so the rows kept have to be the most recent ones.
// id ascending is the tiebreak, because a bulk import stamps many activities
// with the same occurredAt and a partial order is not a deterministic one.
//
// The ordered query landed in #55 (deff17d). This file is the lock that
// fails when that orderBy or the limit changes shape. It is listed on the
// API test script (apps/api/package.json) because the coaching test
// directory is not part of that script's directory globs, so a test that
// only lives here would not run in CI.
//
// Captured through setDbQueryObserver. No fixture rows: the shape is in the
// SQL, not in which rows happen to come back. metricsBounding.test.ts is
// the behavioural companion (newest rows kept, truncation disclosed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setDbQueryObserver } from "@aee/db";
import { ACTIVITY_ROW_CAP, fetchRecentActivityByParty } from "../metrics.js";

const SINCE = new Date("2026-01-01T00:00:00.000Z");

test("fetchRecentActivityByParty: order by occurred_at desc, id asc, limit ACTIVITY_ROW_CAP", async () => {
  const statements: Array<{ query: string; params: unknown[] }> = [];
  const uninstall = setDbQueryObserver((query, params) => statements.push({ query, params }));
  try {
    await fetchRecentActivityByParty(1, SINCE);
  } finally {
    uninstall();
  }

  const activity = statements.filter((statement) => /from\s+"grow_activities"/i.test(statement.query));
  assert.equal(
    activity.length,
    1,
    `expected exactly one grow_activities read; got ${JSON.stringify(statements.map((statement) => statement.query))}`,
  );

  const { query, params } = activity[0];
  const sql = query.replace(/\s+/g, " ").trim();

  // Most recent first, then id, then the cap. Optional NULLS LAST is what
  // drizzle's desc() emits; the columns and directions are the contract.
  const order = sql.match(
    /order by "grow_activities"\."occurred_at" desc(?: nulls last)?, "grow_activities"\."id" asc(?: nulls last)? limit \$(\d+)/i,
  );
  assert.ok(
    order,
    `recent-activity read must be most-recent-first with an id tiebreak and a limit; got ${sql}`,
  );

  const limitSlot = Number(order[1]);
  assert.equal(
    params[limitSlot - 1],
    ACTIVITY_ROW_CAP,
    `limit bind $${limitSlot} must be ACTIVITY_ROW_CAP (${ACTIVITY_ROW_CAP}); params=${JSON.stringify(params)}`,
  );

  assert.doesNotMatch(
    sql,
    /order by "grow_activities"\."occurred_at" asc/i,
    "oldest-first would keep the rows the cap is supposed to drop",
  );
});
