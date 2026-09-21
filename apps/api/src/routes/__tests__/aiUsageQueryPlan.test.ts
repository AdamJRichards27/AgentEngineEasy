// AE GROW COMPLETION PROGRAM — SLICE W2-C remediation. The QUERY PLAN of the
// ai_usage read-back, asserted rather than asserted-about.
//
// THE DEFECT THIS PINS. ai_usage.interaction_id is a plain foreign key
// (packages/db/src/schema/ai.ts) and POSTGRES CREATES NO INDEX FOR A FOREIGN
// KEY. Until migration 0029 the only index on ai_usage was its primary key on
// `id` — and nothing in lib/ai/dailyUsage.ts joins to `id`. All three reads
// behind GET /api/ai/usage join ON interaction_id, so each one sequentially
// scanned the whole tenant-mixed table to reach the few hundred rows belonging
// to today. An agent paid that once per request; a brokerage administrator
// paid it three times.
//
// It is the wrong shape for this table in particular: ai_usage gains a row per
// successful AI request forever and has no retention policy, so the cost of a
// user-facing endpoint grew with LIFETIME PLATFORM USAGE rather than with
// today's traffic. Measured at 200k interactions / 100k usage rows before the
// fix: a Parallel Seq Scan reading all 100,000 rows to return 250.
//
// WHY THIS FILE EXISTS. The section comment in dailyUsage.ts previously
// justified shipping with no migration by claiming the join was "to ai_usage
// by primary key" and covered by PR #50's index. Both halves were false, and
// nothing in the suite contradicted them — a plan regression is invisible in a
// diff and invisible in a result-equality test, because the numbers stay right
// while the cost goes wrong. So this file asserts the plan.
//
// HOW IT AVOIDS BEING FLAKY. Index CHOICE is cost-driven, so pinning a plan
// string would be pinning a planner decision that is allowed to change. What
// is asserted instead is the STRUCTURAL fact: ai_usage is reached through an
// index whose Index Cond constrains interaction_id, and no node in the plan
// scans the whole ai_usage table. The statement being explained is not a copy
// of the query — it is captured from the implementation through the package's
// own test-only statement observer, bind parameters and all, so it cannot
// drift from what dailyUsage.ts actually issues.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, pool, brokerages, users, setDbQueryObserver } from "@aee/db";
import { sumAiTokenUsageToday, getAiUsageSnapshot } from "../../lib/ai/dailyUsage.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";

/** The index this file exists to defend. */
const INDEX_NAME = "ai_usage_interaction_idx";

// Fixture size. Deliberately modest — the planner's preference for the index
// over a full scan is established from roughly a thousand rows upward, so
// there is nothing to buy by making CI insert a hundred thousand. The control
// test below MEASURES that this fixture really is in the regime where a scan
// would otherwise be chosen, rather than trusting these constants to stay
// large enough forever.
const TOTAL_INTERACTIONS = 6_000;
/** How many of those are today's, for the tenant under test — the only rows any of these reads needs. */
const TODAY_INTERACTIONS = 30;

let brokerageId: number;
let otherBrokerageId: number;
let userId: number;

before(async () => {
  const suffix = `${Date.now()}-${process.pid}`;
  const [b] = await db.insert(brokerages).values({ name: `W2C Plan ${suffix}` }).returning({ id: brokerages.id });
  const [other] = await db
    .insert(brokerages)
    .values({ name: `W2C Plan Other ${suffix}` })
    .returning({ id: brokerages.id });
  brokerageId = b.id;
  otherBrokerageId = other.id;

  const [u] = await db
    .insert(users)
    .values({ authProviderId: `w2c-plan-${suffix}`, email: `w2c-plan-${suffix}@example.test`, brokerageId })
    .returning({ id: users.id });
  userId = u.id;

  // Bulk-inserted in two statements rather than row by row: this fixture is
  // about table SIZE, and 6,000 round trips would dominate the suite's runtime
  // for no additional coverage.
  //
  // The rows are tenant-mixed and spread over 300 days on purpose. A table
  // that is all one tenant and all one day is not a table a sequential scan is
  // wrong for — the whole claim is that only today's slice is needed.
  await db.execute(sql`
    insert into ai_interactions (request_id, brokerage_id, user_id, ai_role, status, created_at)
    select ${`w2c-plan-${suffix}-`} || g,
           case when g <= ${TODAY_INTERACTIONS} then ${brokerageId}::int else ${otherBrokerageId}::int end,
           ${userId}::int,
           case when g % 3 = 0 then 'BUSINESS_COACH' else 'GROW_ASSISTANT' end,
           'success',
           case when g <= ${TODAY_INTERACTIONS}
                then date_trunc('day', now() at time zone 'utc') + interval '1 hour'
                else now() - ((g % 300) + 1) * interval '1 day' end
    from generate_series(1, ${TOTAL_INTERACTIONS}) g`);

  await db.execute(sql`
    insert into ai_usage (interaction_id, provider, model, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, latency_ms, created_at)
    select i.id, 'mock', 'mock-model', 1000, 500, 1500, 0.01, 900, i.created_at
    from ai_interactions i
    where i.request_id like ${`w2c-plan-${suffix}-%`}`);

  // Without fresh statistics the planner is choosing from stale row estimates
  // and the plan under assertion is not the plan production would get.
  await db.execute(sql`analyze ai_usage`);
  await db.execute(sql`analyze ai_interactions`);
});

after(async () => {
  // Targeted teardown rather than cleanupBrokerages(): that helper deletes
  // ai_usage by an inArray() of every interaction id, which for a 6,000-row
  // fixture is a 6,000-parameter statement. Two scoped deletes do the same job.
  if (brokerageId === undefined) return;
  await db.execute(sql`
    delete from ai_usage u using ai_interactions i
    where u.interaction_id = i.id and i.brokerage_id in (${brokerageId}, ${otherBrokerageId})`);
  await db.execute(sql`delete from ai_interactions where brokerage_id in (${brokerageId}, ${otherBrokerageId})`);
  await db.execute(sql`delete from users where id = ${userId}`);
  await db.execute(sql`delete from brokerages where id in (${brokerageId}, ${otherBrokerageId})`);
  // Leave the statistics describing the table as it is now, not as the fixture
  // left it, so nothing downstream inherits this file's row estimates.
  await db.execute(sql`analyze ai_usage`);
  await db.execute(sql`analyze ai_interactions`);
});

interface CapturedStatement {
  query: string;
  params: unknown[];
}

/** Runs `body` with the statement tap installed and returns every statement it issued, with bind parameters. */
async function capture(body: () => Promise<unknown>): Promise<CapturedStatement[]> {
  const statements: CapturedStatement[] = [];
  const uninstall = setDbQueryObserver((query, params) => statements.push({ query, params }));
  try {
    await body();
  } finally {
    uninstall();
  }
  return statements;
}

/** The statements from `body` that read ai_usage — the ones whose plan this file is about. */
async function captureAiUsageStatements(body: () => Promise<unknown>): Promise<CapturedStatement[]> {
  const statements = await capture(body);
  return statements.filter((s) => /\bai_usage\b/i.test(s.query));
}

/**
 * EXPLAINs a captured statement THROUGH THE POOL, with its real bind
 * parameters. Not db.execute(sql.raw(...)): the captured text still carries
 * `$1`/`$2` placeholders, and drizzle's raw escape hatch sends no parameters
 * for them. Explaining the statement with the values the implementation
 * actually bound is also the more faithful measurement — a generic plan for
 * unknown parameters is not necessarily the plan this query gets.
 */
async function explain(statement: CapturedStatement, client?: { query: typeof pool.query }): Promise<string> {
  const runner = client ?? pool;
  const result = await runner.query(
    `explain (analyze, buffers, costs off) ${statement.query}`,
    statement.params as unknown[],
  );
  return (result.rows as Array<Record<string, string>>).map((r) => r["QUERY PLAN"]).join("\n");
}

/** Plan lines describing a scan node on ai_usage, with their following Index Cond if any. */
function aiUsageScanNodes(plan: string): string[] {
  return plan
    .split("\n")
    .filter((line) => /\bon ai_usage\b/i.test(line))
    .map((line) => line.trim().replace(/^->\s*/, ""));
}

test(`migration 0029 is applied: ${INDEX_NAME} exists on ai_usage (interaction_id)`, async () => {
  // The plan assertions below are meaningless if the index simply is not
  // there, and a plan failure would not say so. This one does.
  const result = await db.execute(sql`
    select indexdef from pg_indexes
    where schemaname = 'public' and tablename = 'ai_usage' and indexname = ${INDEX_NAME}`);
  const rows = result.rows as Array<{ indexdef: string }>;
  assert.equal(rows.length, 1, `${INDEX_NAME} is missing — migration 0029 has not been applied to this database`);
  assert.match(
    rows[0].indexdef,
    /\(interaction_id\)/,
    "the index must be on interaction_id — the column the join actually uses, not the primary key",
  );
});

test("the fixture is genuinely one where a full scan of ai_usage would otherwise be chosen", async () => {
  // THE CONTROL. Everything else in this file asserts "the index is used",
  // which is trivially satisfiable by a fixture too small for the planner to
  // have considered anything else. This measures the counterfactual directly:
  // inside a transaction that is rolled back, drop the index and ask the
  // planner what it would do — which is exactly the schema the committed tree
  // had before migration 0029.
  const [statement] = await captureAiUsageStatements(() => sumAiTokenUsageToday(brokerageId));
  assert.ok(statement !== undefined, "sumAiTokenUsageToday must issue a statement reading ai_usage");

  // One dedicated connection, held for the whole transaction: DROP INDEX and
  // the EXPLAIN that must observe it have to be the same session, and the
  // pool would otherwise be free to hand them different ones.
  const client = await pool.connect();
  let planWithoutIndex = "";
  try {
    await client.query("begin");
    await client.query(`drop index ${INDEX_NAME}`);
    planWithoutIndex = await explain(statement, client as unknown as { query: typeof pool.query });
  } finally {
    // ROLLBACK in `finally`, not at the end of `try`: if the EXPLAIN throws,
    // the index must still come back, and the connection must not return to
    // the pool inside an aborted transaction.
    await client.query("rollback");
    client.release();
  }

  // The index must still be there afterwards: a control that leaves the
  // database changed would silently invalidate every later test in the run.
  const still = await db.execute(sql`
    select 1 from pg_indexes where schemaname = 'public' and tablename = 'ai_usage' and indexname = ${INDEX_NAME}`);
  assert.equal(still.rows.length, 1, "the control transaction must have rolled its DROP INDEX back");

  const nodes = aiUsageScanNodes(planWithoutIndex);
  assert.ok(
    nodes.some((n) => /Seq Scan on ai_usage/i.test(n)),
    `without ${INDEX_NAME} the planner must fall back to a sequential scan of ai_usage — if it no longer does, ` +
      `this fixture is too small to prove anything and TOTAL_INTERACTIONS must grow.\n${planWithoutIndex}`,
  );

  // ...and that scan reads the whole table, not today's slice of it. This is
  // the number that grows forever with platform usage.
  const scanned = /Seq Scan on ai_usage[^\n]*rows=(\d+)[^\n]*loops=(\d+)/i.exec(planWithoutIndex);
  assert.ok(scanned !== null, `expected row counts on the fallback scan:\n${planWithoutIndex}`);
  const rowsRead = Number(scanned[1]) * Number(scanned[2]);
  assert.ok(
    rowsRead > TODAY_INTERACTIONS * 10,
    `the fallback scan must read far more than the ${TODAY_INTERACTIONS} rows the query needs; it read ${rowsRead}`,
  );
});

test("sumAiTokenUsageToday reaches ai_usage through the interaction_id index, not a full scan", async () => {
  const statements = await captureAiUsageStatements(() => sumAiTokenUsageToday(brokerageId, userId));
  assert.equal(statements.length, 1, "the token totals are one statement, both scopes in one round trip");

  const plan = await explain(statements[0]);
  const nodes = aiUsageScanNodes(plan);
  assert.ok(nodes.length > 0, `expected a node reading ai_usage:\n${plan}`);

  assert.ok(
    !nodes.some((n) => /Seq Scan on ai_usage/i.test(n)),
    `ai_usage must not be sequentially scanned — this is the defect:\n${plan}`,
  );
  assert.ok(
    nodes.every((n) => new RegExp(`using ${INDEX_NAME}`, "i").test(n)),
    `every ai_usage access must go through ${INDEX_NAME}:\n${plan}`,
  );

  // The structural fact, not the plan string: whatever node type the planner
  // picks, interaction_id is the constrained leading column.
  assert.match(
    plan,
    /Index Cond: \(interaction_id =/i,
    `the index must be driven by the join predicate on interaction_id:\n${plan}`,
  );
});

test("the administrator breakdown joins ai_usage through the index on BOTH of its extra aggregates", async () => {
  // The finding's real cost lives here: a brokerage administrator's snapshot
  // pays this join three times, so a fix that only helped the totals query
  // would leave two thirds of it in place.
  const statements = await captureAiUsageStatements(() =>
    getAiUsageSnapshot({ brokerageId, userId, includeUserBreakdown: true }),
  );
  assert.equal(
    statements.length,
    3,
    `an administrator snapshot reads ai_usage exactly three times (totals, per-user, per-role); got ${statements.length}`,
  );

  for (const statement of statements) {
    const plan = await explain(statement);
    const nodes = aiUsageScanNodes(plan);
    assert.ok(nodes.length > 0, `expected a node reading ai_usage:\n${statement.query}\n${plan}`);
    assert.ok(
      !nodes.some((n) => /Seq Scan on ai_usage/i.test(n)),
      `no ai_usage read behind GET /api/ai/usage may be a full scan:\n${statement.query}\n${plan}`,
    );
    assert.match(
      plan,
      /Index Cond: \(interaction_id =/i,
      `the join predicate must be the index condition:\n${statement.query}\n${plan}`,
    );
  }
});
