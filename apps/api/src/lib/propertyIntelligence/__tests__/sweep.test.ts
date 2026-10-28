// AE GROW "Brokerage-wide Signal Sweep" — stage 1 (FOUNDATION) coverage.
//
// Real Postgres, real fixtures, no mocks — the convention every suite in
// this repository follows. Fixtures that a route genuinely exposes are
// created over HTTP (brokerages/users via dev-login); everything the sweep
// reads that no route writes (back-dated relationships, DNC rows,
// suppressions, provider observations) is inserted directly, exactly as
// routes/__tests__/propertyIntelligence.test.ts already does for validFrom.
//
// Every sweep in this file is SCOPED to this file's own brokerages
// (runSignalSweep's brokerageIds option), so a concurrently running test
// file sharing the database is never evaluated, created, expired or
// suppressed by it. The single-flight advisory lock is global either way,
// which is exactly what the single-flight test exercises.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  setDbQueryObserver,
  growOpportunitySignals,
  growRelationships,
  growOpportunities,
  growSignalSweepRuns,
  growSignalSweepCursors,
  growContactDncrStatuses,
  growContactChannelSuppressions,
  parties,
  properties,
  GROW_CONSENT_CHANNELS,
  type GrowOpportunitySignal,
} from "@aee/db";
import {
  runSignalSweep,
  resetSweepResumePointForTests,
  type SweepSummary,
} from "../sweep.js";
// Cross-file contention on the sweep lock: see sweepLockContention.ts. Every
// sweep that must run, and every lock this file holds, waits out a sibling
// file that holds the lock instead of failing on the first refusal.
import { acquireSweepLockForTest, sweepWhenLockFree } from "./sweepLockContention.js";
import { dismissSignal, reviewSignal, DISMISS_QUIET_PERIOD_DAYS } from "../signals.js";
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

  A = await createBrokerageWithUsers(baseUrl, `Signal Sweep A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Signal Sweep B ${suffix}`);
  resetSweepResumePointForTests();
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number"));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

/* ---------------------------------------------------------------------
 * Fixtures.
 * -----------------------------------------------------------------*/

async function createParty(brokerageId: number, label: string): Promise<number> {
  const [row] = await db.insert(parties).values({ brokerageId, partyType: "Person", firstName: "Sweep", lastName: label }).returning({ id: parties.id });
  return row.id;
}

async function createProperty(tenant: { brokerageId: number; admin: DevLoginResult }, label: string): Promise<number> {
  const [row] = await db
    .insert(properties)
    .values({ brokerageId: tenant.brokerageId, agentId: tenant.admin.user.id, formattedAddress: `${label} ${suffix}`, state: "NSW", suburb: "Testville", postcode: "2000" })
    .returning({ id: properties.id });
  return row.id;
}

/**
 * An Active owner relationship with an OBSERVED ownership start `years` ago —
 * the long_ownership_tenure rule's input.
 *
 * STAGE 2 CHANGED WHAT THIS FIXTURE HAS TO SET. It used to back-date
 * validFrom, which is what the rule read. validFrom is defaultNow() and means
 * "when AE learned of this row", so the rule was measuring row age; it now
 * reads ownershipStartDate, an explicitly observed acquisition date, and
 * abstains entirely when that is NULL. validFrom is still back-dated here so
 * the two remain distinguishable in tests that care.
 */
async function createTenureRelationship(brokerageId: number, partyId: number, propertyId: number | null, years: number, relationshipType = "owner"): Promise<number> {
  const ownershipStartDate = new Date(Date.now() - years * 365 * MS_PER_DAY);
  const [row] = await db
    .insert(growRelationships)
    .values({
      brokerageId,
      partyId,
      propertyId,
      relationshipType,
      status: "Active",
      validFrom: ownershipStartDate,
      ownershipStartDate,
      ownershipStartSource: "import",
      ownershipStartPrecision: "day",
    })
    .returning({ id: growRelationships.id });
  return row.id;
}

/** A property-LESS prospective-buyer relationship — the one contact-anchored input stage 1 implements. */
async function createPropertylessBuyerRelationship(brokerageId: number, partyId: number): Promise<number> {
  const [row] = await db
    .insert(growRelationships)
    .values({ brokerageId, partyId, propertyId: null, relationshipType: "prospective_buyer", status: "Active" })
    .returning({ id: growRelationships.id });
  return row.id;
}

async function sweep(brokerageIds: number[], options: { force?: boolean; maxBrokerages?: number; afterBrokerageId?: number } = {}): Promise<SweepSummary> {
  const result = await sweepWhenLockFree({ brokerageIds, force: true, ...options });
  return result.summary;
}

async function signalsFor(brokerageId: number, where?: { partyId?: number; propertyId?: number }): Promise<GrowOpportunitySignal[]> {
  const conditions = [eq(growOpportunitySignals.brokerageId, brokerageId)];
  if (where?.partyId !== undefined) conditions.push(eq(growOpportunitySignals.partyId, where.partyId));
  if (where?.propertyId !== undefined) conditions.push(eq(growOpportunitySignals.propertyId, where.propertyId));
  return db.select().from(growOpportunitySignals).where(and(...conditions));
}

/* ---------------------------------------------------------------------
 * 1. Contact-anchored signals.
 * -----------------------------------------------------------------*/

test("contact-anchored — a contact with NO property gets a party-anchored signal, deduped across sweeps", async () => {
  const partyId = await createParty(A.brokerageId, "PropertyLess");
  const relationshipId = await createPropertylessBuyerRelationship(A.brokerageId, partyId);

  const first = await sweep([A.brokerageId]);
  assert.ok(first.signalsCreated >= 1);

  const rows = await signalsFor(A.brokerageId, { partyId });
  assert.equal(rows.length, 1, "exactly one signal for a contact with no property");
  const [signal] = rows;
  assert.equal(signal.propertyId, null, "property_id is nullable and genuinely null for a contact-anchored signal");
  assert.equal(signal.partyId, partyId);
  assert.equal(signal.signalType, "past_buyer_interest");
  assert.equal(signal.status, "Active");
  assert.equal(
    signal.dedupeKey,
    `${A.brokerageId}:past_buyer_interest:party:${partyId}:${relationshipId}`,
    "party-anchored dedupe keys use the explicit `party` namespace segment",
  );
  assert.ok(signal.evidenceFingerprint && signal.evidenceFingerprint.length > 0, "a fingerprint is recorded so re-review has something to compare");
  assert.equal(signal.reRaiseCount, 0);

  // Idempotency: a second sweep upserts the same row, never a duplicate.
  await sweep([A.brokerageId]);
  const afterSecond = await signalsFor(A.brokerageId, { partyId });
  assert.equal(afterSecond.length, 1);
  assert.equal(afterSecond[0].id, signal.id);
});

test("property-anchored dedupe keys are byte-identical to the pre-sweep format", async () => {
  const partyId = await createParty(A.brokerageId, "PropertyAnchored");
  const propertyId = await createProperty(A, "1 Property Anchored St");
  const relationshipId = await createTenureRelationship(A.brokerageId, partyId, propertyId, 11);

  await sweep([A.brokerageId]);

  const rows = await signalsFor(A.brokerageId, { propertyId });
  const tenure = rows.find((r) => r.signalType === "long_ownership_tenure");
  assert.ok(tenure, "the brokerage-wide sweep raises the same tenure signal the per-property recalculation did");
  assert.equal(tenure.dedupeKey, `${A.brokerageId}:long_ownership_tenure:${propertyId}:${relationshipId}`);
  assert.equal(tenure.confidenceBand, "StrongIndicator");
});

/* ---------------------------------------------------------------------
 * 2. Re-review policy.
 * -----------------------------------------------------------------*/

test("a dismissed signal is not re-raised before next_review_at, and after it only when the evidence materially changed", async () => {
  const partyId = await createParty(A.brokerageId, "Dismissed");
  const propertyId = await createProperty(A, "2 Quiet Period St");
  // Emerging band (5-7 years) so the band has room to escalate later.
  const relationshipId = await createTenureRelationship(A.brokerageId, partyId, propertyId, 6);

  await sweep([A.brokerageId]);
  const [raised] = (await signalsFor(A.brokerageId, { propertyId })).filter((s) => s.signalType === "long_ownership_tenure");
  assert.ok(raised);
  assert.equal(raised.confidenceBand, "Emerging");

  const dismissed = await dismissSignal({ signalId: raised.id, brokerageId: A.brokerageId, userId: A.admin.user.id, dismissedReason: "Spoken to; not selling." });
  assert.equal(dismissed.status, "Dismissed");
  assert.equal(dismissed.dismissedReason, "Spoken to; not selling.");
  assert.ok(dismissed.nextReviewAt, "dismissal sets a bounded quiet period rather than a permanent tombstone");
  const quietDays = Math.round((dismissed.nextReviewAt.getTime() - Date.now()) / MS_PER_DAY);
  assert.ok(Math.abs(quietDays - DISMISS_QUIET_PERIOD_DAYS) <= 1, `dismissal quiet period is ~${DISMISS_QUIET_PERIOD_DAYS} days, got ${quietDays}`);

  // (a) Within the quiet period — never re-raised, whatever the sweep sees.
  await sweep([A.brokerageId]);
  const [stillDismissed] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, raised.id));
  assert.equal(stillDismissed.status, "Dismissed", "a dismissal must never be silently overridden before its quiet period");
  assert.equal(stillDismissed.reRaiseCount, 0);

  // (b) Quiet period elapsed but the evidence is UNCHANGED — still not re-raised.
  await db.update(growOpportunitySignals).set({ nextReviewAt: new Date(Date.now() - MS_PER_DAY) }).where(eq(growOpportunitySignals.id, raised.id));
  await sweep([A.brokerageId]);
  const [unchangedEvidence] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, raised.id));
  assert.equal(unchangedEvidence.status, "Dismissed", "time passing alone is not a material change");
  assert.equal(unchangedEvidence.reRaiseCount, 0);

  // (c) Quiet period elapsed AND the evidence materially changed (the tenure
  //     crossed into StrongIndicator) — re-raised exactly once.
  await db
    .update(growRelationships)
    .set({ ownershipStartDate: new Date(Date.now() - 11 * 365 * MS_PER_DAY) })
    .where(eq(growRelationships.id, relationshipId));
  await sweep([A.brokerageId]);
  const [reRaised] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, raised.id));
  assert.equal(reRaised.status, "Active", "a materially changed signal returns after its quiet period");
  assert.equal(reRaised.confidenceBand, "StrongIndicator");
  assert.equal(reRaised.reRaiseCount, 1);
  assert.equal(reRaised.nextReviewAt, null, "the quiet period has been consumed");
  assert.equal(reRaised.dismissedReason, null, "an Active signal never keeps presenting a superseded dismissal reason as current");
  const prior = reRaised.priorDecision as { status?: string; dismissedReason?: string } | null;
  assert.equal(prior?.status, "Dismissed", "the superseded decision is preserved on the row");
  assert.equal(prior?.dismissedReason, "Spoken to; not selling.");

  // And a sweep immediately afterwards does not keep incrementing.
  await sweep([A.brokerageId]);
  const [settled] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, raised.id));
  assert.equal(settled.reRaiseCount, 1);
});

test("a reviewed signal gets the shorter quiet period, and a promoted signal is permanently terminal", async () => {
  const reviewPartyId = await createParty(A.brokerageId, "Reviewed");
  const reviewPropertyId = await createProperty(A, "3a Reviewed St");
  await createTenureRelationship(A.brokerageId, reviewPartyId, reviewPropertyId, 11);
  await sweep([A.brokerageId]);
  const [toReview] = (await signalsFor(A.brokerageId, { propertyId: reviewPropertyId })).filter((s) => s.signalType === "long_ownership_tenure");
  const reviewed = await reviewSignal({ signalId: toReview.id, brokerageId: A.brokerageId, userId: A.admin.user.id });
  assert.equal(reviewed.status, "Reviewed");
  assert.ok(reviewed.nextReviewAt);
  const reviewDays = Math.round((reviewed.nextReviewAt.getTime() - Date.now()) / MS_PER_DAY);
  assert.ok(reviewDays > 0 && reviewDays < DISMISS_QUIET_PERIOD_DAYS, `review's quiet period (${reviewDays}d) is shorter than a dismissal's`);

  // A promoted signal keeps next_review_at NULL, which the upsert predicate
  // treats as "never" — the sweep can never resurrect it.
  const promotePartyId = await createParty(A.brokerageId, "Promoted");
  const promotePropertyId = await createProperty(A, "3b Promoted St");
  await createTenureRelationship(A.brokerageId, promotePartyId, promotePropertyId, 11);
  await sweep([A.brokerageId]);
  const [toPromote] = (await signalsFor(A.brokerageId, { propertyId: promotePropertyId })).filter((s) => s.signalType === "long_ownership_tenure");
  const { promoteSignal } = await import("../signals.js");
  const promoted = await promoteSignal({ signalId: toPromote.id, brokerageId: A.brokerageId, userId: A.admin.user.id });
  assert.equal(promoted.signal.status, "Superseded");
  assert.equal(promoted.signal.nextReviewAt, null);

  await sweep([A.brokerageId]);
  const [stillSuperseded] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, toPromote.id));
  assert.equal(stillSuperseded.status, "Superseded", "a promoted signal is permanently terminal");
  assert.equal(stillSuperseded.reRaiseCount, 0);
});

/* ---------------------------------------------------------------------
 * 3. Expiry, brokerage-wide.
 * -----------------------------------------------------------------*/

test("expiry is brokerage-wide and sweep-driven — both past-expiresAt and no-longer-supported signals, across many properties in one pass", async () => {
  const partyOne = await createParty(A.brokerageId, "ExpiryOne");
  const partyTwo = await createParty(A.brokerageId, "ExpiryTwo");
  const propertyOne = await createProperty(A, "4a Expiry St");
  const propertyTwo = await createProperty(A, "4b Expiry St");
  const relOne = await createTenureRelationship(A.brokerageId, partyOne, propertyOne, 11);
  await createTenureRelationship(A.brokerageId, partyTwo, propertyTwo, 11);

  await sweep([A.brokerageId]);
  const before = await signalsFor(A.brokerageId);
  const activeOne = before.find((s) => s.propertyId === propertyOne && s.signalType === "long_ownership_tenure");
  const activeTwo = before.find((s) => s.propertyId === propertyTwo && s.signalType === "long_ownership_tenure");
  assert.ok(activeOne && activeTwo);

  // Property one's evidence goes away (the relationship becomes Historical):
  // no longer supported -> Expired. Property two's evidence stands, so it
  // must be refreshed rather than expired — the two properties are handled
  // differently within ONE brokerage-wide pass, which is the point.
  await db.update(growRelationships).set({ status: "Historical" }).where(eq(growRelationships.id, relOne));

  // A third signal, on a third property, whose own expiresAt has passed and
  // which no rule currently produces — the past-expiresAt path.
  const propertyThree = await createProperty(A, "4c Expiry St");
  const [strayExpiring] = await db
    .insert(growOpportunitySignals)
    .values({
      brokerageId: A.brokerageId,
      partyId: partyTwo,
      propertyId: propertyThree,
      signalType: "recent_nearby_sales_activity",
      title: "Aged-out observation signal",
      explanation: "Seeded directly: its provider observation is older than the rule's freshness window.",
      evidence: { seeded: true },
      source: "mock",
      confidenceBand: "Emerging",
      status: "Active",
      dedupeKey: `${A.brokerageId}:recent_nearby_sales_activity:${propertyThree}:expired-${suffix}`,
      expiresAt: new Date(Date.now() - MS_PER_DAY),
    })
    .returning();

  const summary = await sweep([A.brokerageId]);
  assert.ok(summary.signalsExpired >= 2, `expected at least two expiries in ONE brokerage-wide pass, got ${summary.signalsExpired}`);

  const [expiredOne] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, activeOne.id));
  const [stillActiveTwo] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, activeTwo.id));
  const [expiredThree] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, strayExpiring.id));
  assert.equal(expiredOne.status, "Expired", "a signal whose evidence disappeared is expired, never deleted");
  assert.equal(stillActiveTwo.status, "Active", "a signal on another property whose evidence stands is refreshed in the same pass");
  assert.equal(expiredThree.status, "Expired", "a signal past its own expiresAt is expired brokerage-wide, without anyone reading its property");
});

test("expireSignalsPastExpiry is brokerage-scoped, not property-scoped — the sweep-driven replacement for the lazy read-time expiry", async () => {
  const partyId = await createParty(A.brokerageId, "BrokerageWideExpiry");
  const propertyId = await createProperty(A, "4d Brokerage Wide St");
  const [row] = await db
    .insert(growOpportunitySignals)
    .values({
      brokerageId: A.brokerageId,
      partyId,
      propertyId,
      signalType: "recent_nearby_sales_activity",
      title: "Past its expiry",
      explanation: "Seeded directly for the brokerage-wide expiry test.",
      evidence: { seeded: true },
      source: "mock",
      confidenceBand: "Emerging",
      status: "Active",
      dedupeKey: `${A.brokerageId}:recent_nearby_sales_activity:${propertyId}:brokerage-wide-${suffix}`,
      expiresAt: new Date(Date.now() - MS_PER_DAY),
    })
    .returning();

  // No property filter at all — the caller never names a property, which is
  // precisely what the old lazy per-property expiry could not do.
  const { expireSignalsPastExpiry } = await import("../persistence.js");
  const expired = await expireSignalsPastExpiry(A.brokerageId, new Date());
  assert.ok(expired >= 1);
  const [after] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, row.id));
  assert.equal(after.status, "Expired");
});

/* ---------------------------------------------------------------------
 * 4. Contactability (read-only, minimum dependency).
 * -----------------------------------------------------------------*/

test("contactability — a DNC-LISTED contact and a fully suppressed contact get no signals; absence of consent data changes nothing", async () => {
  const listedParty = await createParty(A.brokerageId, "DncListed");
  const suppressedParty = await createParty(A.brokerageId, "FullySuppressed");
  const partialParty = await createParty(A.brokerageId, "PartiallySuppressed");
  const plainParty = await createParty(A.brokerageId, "NoConsentData");

  const listedProperty = await createProperty(A, "5a Listed St");
  const suppressedProperty = await createProperty(A, "5b Suppressed St");
  const partialProperty = await createProperty(A, "5c Partial St");
  const plainProperty = await createProperty(A, "5d Plain St");

  await createTenureRelationship(A.brokerageId, listedParty, listedProperty, 11);
  await createTenureRelationship(A.brokerageId, suppressedParty, suppressedProperty, 11);
  await createTenureRelationship(A.brokerageId, partialParty, partialProperty, 11);
  await createTenureRelationship(A.brokerageId, plainParty, plainProperty, 11);

  // Latest DNC row for the listed contact says LISTED.
  await db.insert(growContactDncrStatuses).values([
    { brokerageId: A.brokerageId, partyId: listedParty, channel: "PHONE_CALL", status: "NOT_CHECKED", source: "test-fixture", checkedAt: new Date(Date.now() - 2 * MS_PER_DAY), recordedByUserId: A.admin.user.id },
    { brokerageId: A.brokerageId, partyId: listedParty, channel: "PHONE_CALL", status: "LISTED", source: "test-fixture", checkedAt: new Date(), recordedByUserId: A.admin.user.id },
  ]);
  // Suppressed on EVERY channel.
  await db.insert(growContactChannelSuppressions).values(
    GROW_CONSENT_CHANNELS.map((channel) => ({
      brokerageId: A.brokerageId,
      partyId: suppressedParty,
      channel,
      state: "SUPPRESSED",
      reason: "test-fixture",
      recordedByUserId: A.admin.user.id,
    })),
  );
  // Suppressed on ONE channel only — deliberately still visible.
  await db.insert(growContactChannelSuppressions).values({
    brokerageId: A.brokerageId,
    partyId: partialParty,
    channel: "SMS",
    state: "SUPPRESSED",
    reason: "test-fixture",
    recordedByUserId: A.admin.user.id,
  });

  const summary = await sweep([A.brokerageId]);
  assert.ok(summary.candidatesSuppressed >= 2, `expected the two fully-blocked contacts to be withheld, got ${summary.candidatesSuppressed}`);

  assert.equal((await signalsFor(A.brokerageId, { partyId: listedParty })).length, 0, "a DNC-LISTED contact is never raised");
  assert.equal((await signalsFor(A.brokerageId, { partyId: suppressedParty })).length, 0, "a contact suppressed on every channel is never raised");
  assert.equal((await signalsFor(A.brokerageId, { partyId: partialParty })).length, 1, "a partially suppressed contact is still reachable another way, so their signal stands");
  assert.equal((await signalsFor(A.brokerageId, { partyId: plainParty })).length, 1, "absence of consent data changes nothing — the common pilot case");

  // No consent row was written by the sweep. Counting is enough: the sweep
  // holds no writer for these tables at all.
  const dncrRows = await db.select().from(growContactDncrStatuses).where(eq(growContactDncrStatuses.brokerageId, A.brokerageId));
  assert.equal(dncrRows.length, 2, "the sweep must never write a consent row");
});

/* ---------------------------------------------------------------------
 * 5. Orchestration — single flight, bookkeeping, stale-run recovery,
 *    bounds, resumability, change detection.
 * -----------------------------------------------------------------*/

test("single flight — a second sweep is refused while one holds the advisory lock, and the run row records the outcome", async () => {
  const release = await acquireSweepLockForTest();
  try {
    const refused = await runSignalSweep("MANUAL", { brokerageIds: [A.brokerageId] });
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.skippedReason, /already running/i);
  } finally {
    await release();
  }

  // With the lock free again, the same call succeeds — proving the refusal
  // was the lock and not a latch left set.
  const summary = await sweep([A.brokerageId]);
  const [run] = await db.select().from(growSignalSweepRuns).where(eq(growSignalSweepRuns.id, summary.sweepRunId));
  assert.equal(run.status, "COMPLETED");
  assert.equal(run.trigger, "MANUAL");
  assert.ok(run.completedAt);
  assert.equal(run.brokeragesConsidered, 1);
});

test("stale-run recovery closes an abandoned RUNNING row without any wall-clock arithmetic", async () => {
  // A row left behind by a process that died mid-sweep. Its startedAt is
  // deliberately IN THE FUTURE: any recovery that worked by comparing
  // timestamps to "now" would refuse to touch it. Lock-based recovery does
  // not care, because holding the lock IS the proof that nothing is running.
  // Inserted while holding the lock, so it never appears in the middle of a
  // sibling file's "lock held, nothing RUNNING" test.
  const holder = await acquireSweepLockForTest();
  let abandoned: typeof growSignalSweepRuns.$inferSelect;
  try {
    [abandoned] = await db
      .insert(growSignalSweepRuns)
      .values({ status: "RUNNING", trigger: "SCHEDULED", startedAt: new Date(Date.now() + 10 * 60 * 1000) })
      .returning();
  } finally {
    await holder();
  }

  // Recovery only runs on the UNSCOPED production path (see sweep.ts), so
  // this one sweep is unscoped — bounded to a single brokerage so it stays
  // cheap, and forced so it does real work.
  // If a sibling file's unscoped sweep gets there first it recovers this
  // row the same way, so the assertions below hold either way.
  const result = await sweepWhenLockFree({ maxBrokerages: 1, afterBrokerageId: 0, force: true });
  assert.ok(result.ok);

  const [recovered] = await db.select().from(growSignalSweepRuns).where(eq(growSignalSweepRuns.id, abandoned.id));
  assert.equal(recovered.status, "FAILED");
  assert.match(recovered.errorMessage ?? "", /Abandoned/);
  assert.ok(recovered.completedAt);
});

test("bounded and resumable — a run stops at maxBrokerages and the next run continues after the last brokerage it reached", async () => {
  const first = await sweepWhenLockFree({ brokerageIds: [A.brokerageId, B.brokerageId], maxBrokerages: 1, force: true });
  assert.ok(first.ok);
  assert.equal(first.summary.brokeragesConsidered, 1, "the run stops at its bound");
  assert.equal(first.summary.boundedOut, true);
  const firstBrokerage = first.summary.lastBrokerageId;

  const second = await sweepWhenLockFree({ brokerageIds: [A.brokerageId, B.brokerageId], maxBrokerages: 1, afterBrokerageId: firstBrokerage, force: true });
  assert.ok(second.ok);
  assert.equal(second.summary.brokeragesConsidered, 1);
  assert.notEqual(second.summary.lastBrokerageId, firstBrokerage, "the second run resumes after the first, it does not restart");

  const third = await sweepWhenLockFree({ brokerageIds: [A.brokerageId, B.brokerageId], maxBrokerages: 5, afterBrokerageId: second.summary.lastBrokerageId, force: true });
  assert.ok(third.ok);
  assert.equal(third.summary.brokeragesConsidered, 0, "nothing is left after both brokerages have been swept");
  assert.equal(third.summary.boundedOut, false);
});

test("change detection — an unchanged brokerage is skipped on the next sweep, and a touched one is evaluated again", async () => {
  const partyId = await createParty(B.brokerageId, "ChangeDetection");
  const propertyId = await createProperty(B, "6 Cursor St");
  await createTenureRelationship(B.brokerageId, partyId, propertyId, 11);

  // First pass: forced, so the cursor is written with this brokerage's
  // current high-water marks.
  await sweep([B.brokerageId]);
  const [cursor] = await db.select().from(growSignalSweepCursors).where(eq(growSignalSweepCursors.brokerageId, B.brokerageId));
  assert.ok(cursor, "a cursor row is recorded per brokerage");
  assert.ok(cursor.lastFullEvaluationAt, "a real evaluation anchors the full-sweep interval");
  const marks = cursor.sourceHighWaterMarks as Record<string, string | null>;
  assert.ok(marks.growRelationships, "the relationship high-water mark is recorded");

  // Unforced and nothing changed -> skipped without evaluating.
  const skipped = await sweepWhenLockFree({ brokerageIds: [B.brokerageId] });
  assert.ok(skipped.ok);
  assert.equal(skipped.summary.brokeragesSkippedUnchanged, 1, "a steady-state brokerage is skipped entirely");
  assert.equal(skipped.summary.brokeragesEvaluated, 0);
  assert.equal(skipped.summary.candidatesEvaluated, 0);

  // Touch a source -> evaluated again, still unforced.
  await db.update(growRelationships).set({ updatedAt: new Date() }).where(and(eq(growRelationships.brokerageId, B.brokerageId), eq(growRelationships.partyId, partyId)));
  const reEvaluated = await sweepWhenLockFree({ brokerageIds: [B.brokerageId] });
  assert.ok(reEvaluated.ok);
  assert.equal(reEvaluated.summary.brokeragesEvaluated, 1, "a brokerage whose sources moved is evaluated");
  assert.equal(reEvaluated.summary.brokeragesSkippedUnchanged, 0);
});

/* ---------------------------------------------------------------------
 * 6. Set-based, not N+1.
 * -----------------------------------------------------------------*/

test("set-based — the statement count for one brokerage does not scale with the number of candidates", async () => {
  async function measure(candidateCount: number, label: string): Promise<number> {
    const tenant = await createBrokerageWithUsers(baseUrl, `Signal Sweep Statements ${label} ${suffix}`);
    try {
      for (let i = 0; i < candidateCount; i += 1) {
        const partyId = await createParty(tenant.brokerageId, `${label}-${i}`);
        const propertyId = await createProperty(tenant, `${label} ${i} St`);
        await createTenureRelationship(tenant.brokerageId, partyId, propertyId, 11);
      }
      let statements = 0;
      const uninstall = setDbQueryObserver(() => {
        statements += 1;
      });
      try {
        // Count only the attempt that ran: a refusal by a sibling file's
        // lock is one statement and must not be added to the total.
        await sweepWhenLockFree({ brokerageIds: [tenant.brokerageId], force: true }, () => {
          statements = 0;
        });
      } finally {
        uninstall();
      }
      return statements;
    } finally {
      await cleanupBrokerages([tenant.brokerageId]);
    }
  }

  const small = await measure(5, "Small");
  const large = await measure(60, "Large");

  // 12x the candidates must not mean meaningfully more statements. The only
  // legitimate growth is one extra upsert statement per UPSERT_CHUNK_SIZE
  // (250) candidates, which 60 candidates does not reach at all.
  assert.equal(large, small, `statement count must be flat in candidate count (5 candidates: ${small}, 60 candidates: ${large})`);
  assert.ok(small < 30, `a one-brokerage sweep must issue a small constant number of statements, got ${small}`);
});

/* ---------------------------------------------------------------------
 * 7. Tenant isolation.
 * -----------------------------------------------------------------*/

test("tenant isolation — sweeping brokerage A never reads or writes brokerage B's rows", async () => {
  const partyA = await createParty(A.brokerageId, "IsolationA");
  const propertyA = await createProperty(A, "7a Isolation St");
  await createTenureRelationship(A.brokerageId, partyA, propertyA, 11);

  const partyB = await createParty(B.brokerageId, "IsolationB");
  const propertyB = await createProperty(B, "7b Isolation St");
  await createTenureRelationship(B.brokerageId, partyB, propertyB, 11);

  // Give B an Active signal whose evidence no longer exists, so a sweep that
  // leaked across tenants would expire it.
  const [strayB] = await db
    .insert(growOpportunitySignals)
    .values({
      brokerageId: B.brokerageId,
      partyId: partyB,
      propertyId: propertyB,
      signalType: "long_ownership_tenure",
      title: "Pre-existing B signal",
      explanation: "Seeded directly for the tenant-isolation test.",
      evidence: { seeded: true },
      source: "internal",
      confidenceBand: "Emerging",
      status: "Active",
      dedupeKey: `${B.brokerageId}:long_ownership_tenure:${propertyB}:stray-${suffix}`,
    })
    .returning();

  const summary = await sweep([A.brokerageId]);
  assert.equal(summary.brokeragesConsidered, 1);

  const [untouched] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, strayB.id));
  assert.equal(untouched.status, "Active", "sweeping A must not expire B's unsupported signal");
  assert.equal(untouched.updatedAt.getTime(), strayB.updatedAt.getTime(), "sweeping A must not write to B's row at all");

  // And every signal A's sweep produced belongs to A.
  const aSignals = await signalsFor(A.brokerageId);
  assert.ok(aSignals.length > 0);
  assert.ok(aSignals.every((s) => s.brokerageId === A.brokerageId));

  // No cursor row was created for B by A's sweep in this pass beyond the one
  // B's own earlier test created — and certainly none for any other tenant.
  const cursors = await db.select().from(growSignalSweepCursors).where(inArray(growSignalSweepCursors.brokerageId, [A.brokerageId, B.brokerageId]));
  assert.ok(cursors.some((c) => c.brokerageId === A.brokerageId), "A's own cursor is written");
});

/* ---------------------------------------------------------------------
 * 8. The sweep never creates an opportunity or contacts anyone.
 * -----------------------------------------------------------------*/

test("the sweep writes signals only — it never creates an opportunity, and only a human promotion does", async () => {
  const partyId = await createParty(A.brokerageId, "NoAutoOpportunity");
  const propertyId = await createProperty(A, "8 No Opportunity St");
  await createTenureRelationship(A.brokerageId, partyId, propertyId, 11);

  const before = await db.select({ id: growOpportunities.id }).from(growOpportunities).where(eq(growOpportunities.brokerageId, A.brokerageId));
  await sweep([A.brokerageId]);
  const after = await db.select({ id: growOpportunities.id }).from(growOpportunities).where(eq(growOpportunities.brokerageId, A.brokerageId));
  assert.equal(after.length, before.length, "a sweep must never create a growOpportunities row");
});
