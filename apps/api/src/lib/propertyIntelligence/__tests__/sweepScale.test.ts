// AE GROW "Brokerage-wide Signal Sweep" — stage 1 scale sanity.
//
// Seeds a realistically sized single brokerage (SCALE_PARTIES contacts, each
// with a property and a long-tenure owner relationship) and asserts the
// central design claim end to end: ONE sweep over ~2,000 candidates
// completes within a sane bound and issues a BOUNDED number of statements —
// not one per candidate, which is what the pre-sweep implementation did.
//
// Kept in its own file so the ordinary sweep suite stays fast; this one
// deliberately does real bulk work. Everything is scoped to its own
// brokerage and cleaned up afterwards.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, setDbQueryObserver, growOpportunitySignals, growRelationships, parties, properties } from "@aee/db";
import { resetSweepResumePointForTests } from "../sweep.js";
// Cross-file contention on the sweep lock: see sweepLockContention.ts.
import { sweepWhenLockFree } from "./sweepLockContention.js";
import { UPSERT_CHUNK_SIZE } from "../persistence.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

/** Contacts (and properties, and relationships) seeded for the single brokerage under test. */
const SCALE_PARTIES = 2000;
const SEED_BATCH = 500;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Wall-clock ceiling for one sweep over SCALE_PARTIES candidates. Deliberately
 * generous — this is a "has it gone quadratic?" guard on shared CI hardware,
 * not a performance benchmark. The pre-sweep implementation would have issued
 * ~4,000 round trips for this fixture and could not have finished anywhere
 * near it.
 */
const SWEEP_TIME_BUDGET_MS = 60_000;

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let T: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

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
  T = await createBrokerageWithUsers(baseUrl, `Signal Sweep Scale ${suffix}`);
  resetSweepResumePointForTests();
});

after(async () => {
  // t223u: never leave the HTTP server listening if teardown fails (a throwing cleanup used to
  // skip server.close, the child process never exited, and the runner waited until the CI job timeout).
  try {
    await cleanupBrokerages([T?.brokerageId].filter((id): id is number => typeof id === "number"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test(`scale sanity — one sweep over ~${SCALE_PARTIES} candidates completes within budget and issues a bounded number of statements`, async () => {
  // Stage 2: the tenure rule reads ownershipStartDate (an observed
  // acquisition date), not validFrom (row age) — so the fixture has to supply
  // one or the rule correctly abstains and this file would measure nothing.
  const ownershipStartDate = new Date(Date.now() - 11 * 365 * MS_PER_DAY);

  const seedStarted = Date.now();
  for (let offset = 0; offset < SCALE_PARTIES; offset += SEED_BATCH) {
    const size = Math.min(SEED_BATCH, SCALE_PARTIES - offset);
    const partyRows = await db
      .insert(parties)
      .values(Array.from({ length: size }, (_, i) => ({ brokerageId: T.brokerageId, partyType: "Person", firstName: "Scale", lastName: `Contact-${offset + i}` })))
      .returning({ id: parties.id });
    const propertyRows = await db
      .insert(properties)
      .values(
        Array.from({ length: size }, (_, i) => ({
          brokerageId: T.brokerageId,
          agentId: T.admin.user.id,
          formattedAddress: `${offset + i} Scale St ${suffix}`,
          state: "NSW",
          suburb: "Testville",
          postcode: "2000",
        })),
      )
      .returning({ id: properties.id });
    await db.insert(growRelationships).values(
      partyRows.map((p, i) => ({
        brokerageId: T.brokerageId,
        partyId: p.id,
        propertyId: propertyRows[i].id,
        relationshipType: "owner",
        status: "Active",
        validFrom: ownershipStartDate,
        ownershipStartDate,
        ownershipStartSource: "import",
        ownershipStartPrecision: "day",
      })),
    );
  }
  const seedMs = Date.now() - seedStarted;

  // --- the measured sweep ---
  let statements = 0;
  const uninstall = setDbQueryObserver(() => {
    statements += 1;
  });
  let startedAt = Date.now();
  let result;
  try {
    // STAGE 2: maxCandidatesPerBrokerage is now divided FAIRLY BETWEEN RULES
    // rather than being a single shared pool the first rule can drain (see
    // evaluation.ts's "PER-RULE BUDGETING"). This file's whole purpose is to
    // measure ONE sweep that actually processes SCALE_PARTIES candidates, so
    // it states a cap generous enough for that to happen — otherwise the
    // tenure rule would correctly stop at its ~1/7 share and this test would
    // be measuring a seventh of the work it claims to.
    //
    // The fair-share and continuation behaviour itself is covered in
    // __tests__/rules.test.ts, where a deliberately tiny cap makes it
    // observable.
    // Waits out a sibling file holding the sweep lock. Only the attempt that
    // runs is measured: statements and the clock restart before each try.
    result = await sweepWhenLockFree(
      {
        brokerageIds: [T.brokerageId],
        force: true,
        maxCandidatesPerBrokerage: SCALE_PARTIES * 10,
      },
      () => {
        statements = 0;
        startedAt = Date.now();
      },
    );
  } finally {
    uninstall();
  }
  const elapsedMs = Date.now() - startedAt;

  assert.ok(result.ok, "the sweep must not be skipped");
  const summary = result.ok ? result.summary : null;
  assert.ok(summary);
  assert.equal(summary.brokeragesEvaluated, 1);
  assert.equal(summary.candidatesEvaluated, SCALE_PARTIES, "every seeded contact produces exactly one candidate");
  assert.equal(summary.signalsCreated, SCALE_PARTIES);
  assert.equal(summary.truncated, false, "2,000 candidates is well inside the stated per-brokerage bound");

  const persisted = await db.select({ id: growOpportunitySignals.id }).from(growOpportunitySignals).where(eq(growOpportunitySignals.brokerageId, T.brokerageId));
  assert.equal(persisted.length, SCALE_PARTIES);

  // The bound. Per brokerage the sweep issues a small fixed set of
  // statements (cursor read, change-detection probe, expiry, ONE QUERY PER
  // RULE — EVALUATION_STATEMENTS_PER_SCOPE of them — two contactability
  // queries, unsupported-expiry, cursor write) plus ONE upsert per
  // UPSERT_CHUNK_SIZE candidates, plus a handful for the run's own
  // bookkeeping. Anything per-candidate would be ~2 x 2,000.
  //
  // Note the rules run SEQUENTIALLY as of stage 2 (a shared decrementing
  // budget, to stop one rule starving the others and to bound peak memory).
  // That changes latency, not the statement count: it is still exactly one
  // statement per rule.
  const upsertStatements = Math.ceil(SCALE_PARTIES / UPSERT_CHUNK_SIZE);
  const statementCeiling = upsertStatements + 30;
  assert.ok(
    statements <= statementCeiling,
    `sweep issued ${statements} statements for ${SCALE_PARTIES} candidates; the bound is ${statementCeiling} (${upsertStatements} batched upserts + fixed overhead). A per-candidate implementation would issue thousands.`,
  );
  assert.ok(elapsedMs < SWEEP_TIME_BUDGET_MS, `sweep took ${elapsedMs}ms, budget ${SWEEP_TIME_BUDGET_MS}ms`);

  // Reported so the numbers appear in the test run, not just in an assertion.
  console.log(
    JSON.stringify({
      event: "signal_sweep_scale_sanity",
      candidates: SCALE_PARTIES,
      seedMs,
      sweepMs: elapsedMs,
      statements,
      statementCeiling,
      statementsPerCandidate: Number((statements / SCALE_PARTIES).toFixed(4)),
      signalsCreated: summary.signalsCreated,
    }),
  );

  // --- a steady-state second sweep costs almost nothing ---
  let steadyStatements = 0;
  const uninstallSteady = setDbQueryObserver(() => {
    steadyStatements += 1;
  });
  let steadyStarted = Date.now();
  try {
    await sweepWhenLockFree({ brokerageIds: [T.brokerageId] }, () => {
      steadyStatements = 0;
      steadyStarted = Date.now();
    });
  } finally {
    uninstallSteady();
  }
  const steadyMs = Date.now() - steadyStarted;
  assert.ok(steadyStatements < 15, `a steady-state sweep of an unchanged brokerage must be near-free, got ${steadyStatements} statements`);
  console.log(JSON.stringify({ event: "signal_sweep_steady_state", statements: steadyStatements, sweepMs: steadyMs }));
});
