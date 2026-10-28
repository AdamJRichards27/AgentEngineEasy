// AE GROW "Brokerage-wide Signal Sweep" — stage 2 (SIGNAL GENERATION) coverage.
//
// Real Postgres, real fixtures, no mocks — the convention every suite in this
// repository follows. Everything is SCOPED to this file's own brokerages
// (runSignalSweep's brokerageIds option) so a concurrently running test file
// sharing the database is never evaluated, created, expired or suppressed by
// it.
//
// WHAT THIS FILE IS FOR. Stage 1's sweep.test.ts proves the ENGINE (single
// flight, expiry, re-review, bounds, isolation). This file proves the RULES:
// that the tenure rule is actually functional on realistic data and abstains
// when it should, that a contact with no property genuinely gets signals,
// that every signal carries evidence an agent could act on, and that
// fingerprints do not churn.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  db,
  growOpportunitySignals,
  growRelationships,
  growActivities,
  growOpportunities,
  growCommitments,
  growContactRoles,
  growContactDncrStatuses,
  growContactChannelSuppressions,
  parties,
  properties,
  GROW_CONSENT_CHANNELS,
  type GrowOpportunitySignal,
} from "@aee/db";
import { resetSweepResumePointForTests, type SweepSummary } from "../sweep.js";
// Cross-file contention on the sweep lock: see sweepLockContention.ts.
import { sweepWhenLockFree } from "./sweepLockContention.js";
import { evaluateCandidates, EVALUATION_RULE_NAMES } from "../evaluation.js";
import { readActiveSignalsForParty } from "../signals.js";
import { recordObservation, ownershipStartCoverage } from "../observations.js";
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

  A = await createBrokerageWithUsers(baseUrl, `Signal Rules A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Signal Rules B ${suffix}`);
  resetSweepResumePointForTests();
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number"));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

/* ---------------------------------------------------------------------
 * Fixtures.
 * -----------------------------------------------------------------*/

interface Tenant {
  brokerageId: number;
  admin: DevLoginResult;
}

/**
 * A contact created `createdDaysAgo` ago. The creation date matters to the
 * re_engagement rule: it is the "last touch" anchor for a contact who has
 * never been contacted, which is what stops a freshly imported database from
 * raising a re-engagement signal for every row on day one.
 */
async function createParty(brokerageId: number, label: string, createdDaysAgo = 0): Promise<number> {
  const [row] = await db
    .insert(parties)
    .values({ brokerageId, partyType: "Person", firstName: "Rules", lastName: `${label}-${suffix}`, createdAt: daysAgo(createdDaysAgo) })
    .returning({ id: parties.id });
  return row.id;
}

async function createProperty(tenant: Tenant, label: string): Promise<number> {
  const [row] = await db
    .insert(properties)
    .values({ brokerageId: tenant.brokerageId, agentId: tenant.admin.user.id, formattedAddress: `${label} ${suffix}`, state: "NSW", suburb: "Testville", postcode: "2000" })
    .returning({ id: properties.id });
  return row.id;
}

async function createRelationship(input: {
  brokerageId: number;
  partyId: number;
  propertyId?: number | null;
  relationshipType: string;
  status?: string;
  ownershipStartDate?: Date | null;
  ownershipStartSource?: string | null;
  ownershipStartPrecision?: string | null;
  validTo?: Date | null;
  createdDaysAgo?: number;
}): Promise<number> {
  const created = daysAgo(input.createdDaysAgo ?? 0);
  const [row] = await db
    .insert(growRelationships)
    .values({
      brokerageId: input.brokerageId,
      partyId: input.partyId,
      propertyId: input.propertyId ?? null,
      relationshipType: input.relationshipType,
      status: input.status ?? "Active",
      // validFrom is defaultNow() in production. Back-dating it here is
      // deliberate: several tests below assert the tenure rule does NOT read
      // it, which is only meaningful if it holds a plausible-looking value.
      validFrom: created,
      validTo: input.validTo ?? null,
      ownershipStartDate: input.ownershipStartDate ?? null,
      ownershipStartSource: input.ownershipStartSource ?? null,
      ownershipStartPrecision: input.ownershipStartPrecision ?? null,
      createdAt: created,
      updatedAt: created,
    })
    .returning({ id: growRelationships.id });
  return row.id;
}

async function sweep(brokerageIds: number[], options: { force?: boolean } = {}): Promise<SweepSummary> {
  const result = await sweepWhenLockFree({ brokerageIds, force: true, ...options });
  return result.summary;
}

async function signalsFor(brokerageId: number, where?: { partyId?: number; propertyId?: number }): Promise<GrowOpportunitySignal[]> {
  const conditions = [eq(growOpportunitySignals.brokerageId, brokerageId)];
  if (where?.partyId !== undefined) conditions.push(eq(growOpportunitySignals.partyId, where.partyId));
  if (where?.propertyId !== undefined) conditions.push(eq(growOpportunitySignals.propertyId, where.propertyId));
  return db.select().from(growOpportunitySignals).where(and(...conditions));
}

interface EvidenceEnvelope {
  schemaVersion?: number;
  rule?: string;
  ruleVersion?: number;
  observations?: Array<{ what: string; recordType: string; recordId: number | string | null; observedAt: string | null; source: string; detail?: Record<string, unknown> }>;
  basis?: Record<string, unknown>;
  unknowns?: string[];
  agentAction?: string;
  [key: string]: unknown;
}

/**
 * THE EXPLAINABILITY BAR, asserted the same way for every rule in this file.
 * A signal that cannot answer these questions is a bare score with a title on
 * it, which is exactly what this stage exists to prevent.
 */
function assertExplainable(signal: GrowOpportunitySignal, expectedRule: string): EvidenceEnvelope {
  const evidence = signal.evidence as EvidenceEnvelope;
  assert.equal(evidence.schemaVersion, 1, `${expectedRule}: evidence carries the envelope version`);
  assert.equal(evidence.rule, expectedRule, `${expectedRule}: evidence names the rule that produced it`);
  assert.ok(typeof evidence.ruleVersion === "number", `${expectedRule}: evidence names the rule VERSION`);

  assert.ok(Array.isArray(evidence.observations) && evidence.observations.length > 0, `${expectedRule}: at least one structured observation`);
  for (const observation of evidence.observations) {
    assert.ok(observation.what && observation.what.length > 10, `${expectedRule}: every observation says WHAT was seen in plain words`);
    assert.ok(observation.recordType.length > 0, `${expectedRule}: every observation names the table it came from`);
    assert.ok(observation.source.length > 0, `${expectedRule}: every observation names its source`);
    // recordId may legitimately be null — that is how an ABSENCE is recorded
    // ("no opportunity exists"). observedAt may be null for the same reason.
  }

  assert.ok(evidence.basis && Object.keys(evidence.basis).length > 0, `${expectedRule}: the band's inputs are recorded`);
  assert.ok(Array.isArray(evidence.unknowns), `${expectedRule}: what AE did NOT know is an explicit list, even when empty`);
  assert.ok(typeof evidence.agentAction === "string" && evidence.agentAction.length > 10, `${expectedRule}: a human-facing suggested action`);

  // The explanation must stand alone, and must never assert a prediction.
  assert.ok(signal.explanation.length > 80, `${expectedRule}: the explanation is a real sentence, not a label`);
  assert.match(signal.explanation, /not a prediction/i, `${expectedRule}: every explanation carries the non-prediction caveat`);
  assert.ok(signal.title.length > 0);
  return evidence;
}

/* =====================================================================
 * 1. THE TENURE RULE — functional on real data, and abstaining otherwise.
 * ===================================================================*/

test("tenure — abstains entirely when no ownership start date is known, however old the row is", async () => {
  const partyId = await createParty(A.brokerageId, "TenureUnknown");
  const propertyId = await createProperty(A, "1a Unknown Tenure St");
  // The exact shape stage 1 would have fired on: an owner relationship whose
  // validFrom is 11 years ago. validFrom is defaultNow() in production, so
  // "11 years ago" here can only mean "AE has known about this row for 11
  // years" — it says nothing about when anybody bought anything.
  await createRelationship({
    brokerageId: A.brokerageId,
    partyId,
    propertyId,
    relationshipType: "owner",
    createdDaysAgo: 11 * 365,
    ownershipStartDate: null,
  });

  await sweep([A.brokerageId]);

  const tenure = (await signalsFor(A.brokerageId, { propertyId })).filter((s) => s.signalType === "long_ownership_tenure");
  assert.equal(tenure.length, 0, "with no observed ownership start, the rule must produce nothing — not a guess from validFrom");
});

test("tenure — fires on a real observed ownership start, bands by it, and explains what it saw", async () => {
  const partyId = await createParty(A.brokerageId, "TenureKnown");
  const propertyId = await createProperty(A, "1b Known Tenure St");
  const relationshipId = await createRelationship({
    brokerageId: A.brokerageId,
    partyId,
    propertyId,
    relationshipType: "owner",
    // The row itself is BRAND NEW — imported today — while the ownership
    // started 11 years ago. This is the realistic import case, and it is
    // exactly the case stage 1 got backwards.
    createdDaysAgo: 0,
    ownershipStartDate: yearsAgo(11),
    ownershipStartSource: "import",
    ownershipStartPrecision: "day",
  });

  await sweep([A.brokerageId]);

  const [tenure] = (await signalsFor(A.brokerageId, { propertyId })).filter((s) => s.signalType === "long_ownership_tenure");
  assert.ok(tenure, "a freshly imported row with an 11-year observed ownership start IS a long tenure");
  assert.equal(tenure.confidenceBand, "StrongIndicator");
  assert.equal(tenure.partyId, partyId);

  const evidence = assertExplainable(tenure, "long_ownership_tenure");
  assert.equal(evidence.basis?.ownershipStartSource, "import", "the evidence says WHERE the date came from");
  assert.equal(evidence.basis?.approximateTenureYears, 11);
  assert.equal(evidence.observations?.[0].recordType, "grow_relationships");
  assert.equal(evidence.observations?.[0].recordId, relationshipId, "the evidence points at the exact record");
  assert.ok(evidence.observations?.[0].observedAt, "the observation is dated by the ownership start, not by the row");
  // The legacy flat key stage 1 readers index on is still present.
  assert.equal(evidence.relationshipId, relationshipId);
});

test("tenure — bands escalate with the observed start date, and a short tenure produces nothing", async () => {
  const cases: Array<{ years: number; band: string | null; label: string }> = [
    { years: 3, band: null, label: "TooShort" },
    { years: 6, band: "Emerging", label: "Emerging" },
    { years: 8, band: "WorthReviewing", label: "WorthReviewing" },
    { years: 12, band: "StrongIndicator", label: "Strong" },
  ];
  const created: Array<{ propertyId: number; expected: string | null; label: string }> = [];
  for (const c of cases) {
    const partyId = await createParty(A.brokerageId, `TenureBand${c.label}`);
    const propertyId = await createProperty(A, `1c-${c.label} Band St`);
    await createRelationship({
      brokerageId: A.brokerageId,
      partyId,
      propertyId,
      relationshipType: "owner",
      ownershipStartDate: yearsAgo(c.years),
      ownershipStartSource: "import",
      ownershipStartPrecision: "day",
    });
    created.push({ propertyId, expected: c.band, label: c.label });
  }

  await sweep([A.brokerageId]);

  for (const c of created) {
    const tenure = (await signalsFor(A.brokerageId, { propertyId: c.propertyId })).filter((s) => s.signalType === "long_ownership_tenure");
    if (c.expected === null) {
      assert.equal(tenure.length, 0, `${c.label}: below the lowest threshold, no signal at all`);
    } else {
      assert.equal(tenure.length, 1, `${c.label}: exactly one tenure signal`);
      assert.equal(tenure[0].confidenceBand, c.expected, `${c.label}: band`);
    }
  }
});

test("tenure — a year-only source is never presented as a specific day, and says so in `unknowns`", async () => {
  const partyId = await createParty(A.brokerageId, "TenureYearOnly");
  const propertyId = await createProperty(A, "1d Year Only St");
  const ownershipStartDate = new Date(Date.UTC(new Date().getUTCFullYear() - 11, 0, 1));
  await createRelationship({
    brokerageId: A.brokerageId,
    partyId,
    propertyId,
    relationshipType: "owner",
    ownershipStartDate,
    ownershipStartSource: "import",
    ownershipStartPrecision: "year",
  });

  await sweep([A.brokerageId]);

  const [tenure] = (await signalsFor(A.brokerageId, { propertyId })).filter((s) => s.signalType === "long_ownership_tenure");
  assert.ok(tenure);
  const year = String(ownershipStartDate.getUTCFullYear());
  assert.ok(tenure.explanation.includes(`since ${year}`), `a year-precision source reads back as "${year}", got: ${tenure.explanation}`);
  assert.ok(!/1 January/i.test(tenure.explanation), "a year-only source must never be presented as 1 January");
  const evidence = assertExplainable(tenure, "long_ownership_tenure");
  assert.ok((evidence.unknowns ?? []).some((u) => /nearest year/i.test(u)), "the imprecision is stated, not hidden");
});

test("tenure — a provider ownership observation fills a GAP but never overwrites an agent-sourced date", async () => {
  // (a) A relationship AE knows nothing about: the provider fills it.
  const gapParty = await createParty(A.brokerageId, "OwnershipGap");
  const gapProperty = await createProperty(A, "1e Provider Gap St");
  const gapRelationship = await createRelationship({
    brokerageId: A.brokerageId,
    partyId: gapParty,
    propertyId: gapProperty,
    relationshipType: "owner",
    ownershipStartDate: null,
  });

  // (b) A relationship the agent already has a date for: the provider must
  //     not touch it, even though the provider disagrees.
  const agentParty = await createParty(A.brokerageId, "OwnershipAgentOwned");
  const agentProperty = await createProperty(A, "1f Agent Owned St");
  const agentDate = yearsAgo(11);
  const agentRelationship = await createRelationship({
    brokerageId: A.brokerageId,
    partyId: agentParty,
    propertyId: agentProperty,
    relationshipType: "owner",
    ownershipStartDate: agentDate,
    ownershipStartSource: "import",
    ownershipStartPrecision: "day",
  });

  const providerDate = "2013-06-15";
  await recordObservation({
    brokerageId: A.brokerageId,
    propertyId: gapProperty,
    observationType: "ownership",
    provider: "mock",
    payload: { owners: ["A Person"], acquisitionDate: providerDate },
    sourceTimestamp: daysAgo(2),
  });
  await recordObservation({
    brokerageId: A.brokerageId,
    propertyId: agentProperty,
    observationType: "ownership",
    provider: "mock",
    payload: { owners: ["A Person"], acquisitionDate: "2020-01-01" },
    sourceTimestamp: daysAgo(2),
  });

  const [filled] = await db.select().from(growRelationships).where(eq(growRelationships.id, gapRelationship));
  assert.ok(filled.ownershipStartDate, "a provider observation with an explicit acquisition date fills an unknown");
  assert.equal(filled.ownershipStartDate.toISOString().slice(0, 10), providerDate);
  assert.equal(filled.ownershipStartSource, "provider_observation");
  assert.equal(filled.ownershipStartPrecision, "day");

  const [untouched] = await db.select().from(growRelationships).where(eq(growRelationships.id, agentRelationship));
  assert.equal(untouched.ownershipStartDate?.getTime(), agentDate.getTime(), "an agent-sourced ownership start is never overwritten by a provider");
  assert.equal(untouched.ownershipStartSource, "import");
});

test("tenure — a provider's SALE-history date is deliberately not treated as an ownership start", async () => {
  const partyId = await createParty(A.brokerageId, "SaleHistoryOnly");
  const propertyId = await createProperty(A, "1g Sale History St");
  const relationshipId = await createRelationship({
    brokerageId: A.brokerageId,
    partyId,
    propertyId,
    relationshipType: "owner",
    ownershipStartDate: null,
  });

  // "The property last sold in 2011" is a fact about the PROPERTY. Treating
  // it as "the contact AE has recorded as owner acquired it in 2011" is an
  // inference, and a wrong one exactly when AE's owner record is stale.
  await recordObservation({
    brokerageId: A.brokerageId,
    propertyId,
    observationType: "ownership",
    provider: "mock",
    payload: { owners: ["A Person"], lastSaleDate: "2011-05-05", saleDate: "2011-05-05" },
    sourceTimestamp: daysAgo(1),
  });

  const [row] = await db.select().from(growRelationships).where(eq(growRelationships.id, relationshipId));
  assert.equal(row.ownershipStartDate, null, "sale-history keys must not populate an ownership start");
});

test("tenure — ownership-start coverage is reportable, so 'no signals' can be told apart from 'no data'", async () => {
  const coverage = await ownershipStartCoverage(A.brokerageId);
  assert.ok(coverage.ownerRelationships > 0);
  assert.ok(coverage.withOwnershipStart > 0);
  assert.ok(coverage.withOwnershipStart <= coverage.ownerRelationships);
  assert.ok(coverage.bySource.import > 0, "coverage is broken down by provenance");
});

/* =====================================================================
 * 2. CONTACTS WITH NO PROPERTY.
 * ===================================================================*/

test("property-less contact — a long-dormant contact with only a relationship gets a fully explained re-engagement signal", async () => {
  const partyId = await createParty(A.brokerageId, "DormantNoProperty", 900);
  // Property-LESS, and recorded long ago. Nothing has ever happened.
  await createRelationship({
    brokerageId: A.brokerageId,
    partyId,
    propertyId: null,
    relationshipType: "prospective_seller",
    createdDaysAgo: 900,
  });

  await sweep([A.brokerageId]);

  const rows = await signalsFor(A.brokerageId, { partyId });
  const reEngagement = rows.find((s) => s.signalType === "re_engagement_opportunity");
  assert.ok(reEngagement, "a contact with no property at all holds a signal");
  assert.equal(reEngagement.propertyId, null, "the signal is genuinely contact-anchored");
  assert.equal(reEngagement.partyId, partyId);
  assert.equal(reEngagement.dedupeKey, `${A.brokerageId}:re_engagement_opportunity:party:${partyId}:contact`);
  assert.equal(reEngagement.confidenceBand, "StrongIndicator", "900 days of silence is the strongest overdue band");

  const evidence = assertExplainable(reEngagement, "re_engagement_opportunity");
  assert.equal(evidence.basis?.lastTouchBasis, "contact_record_created_at", "AE says which anchor it used for 'last touch'");
  assert.ok((evidence.unknowns ?? []).some((u) => /RECORDED in Grow/i.test(u)), "AE admits it only knows about logged contact");
  assert.ok((evidence.unknowns ?? []).some((u) => /No property is linked/i.test(u)));

  // The same contact also holds the agent-recorded-motivation signal, and it
  // is equally property-less.
  const motivation = rows.find((s) => s.signalType === "agent_recorded_motivation");
  assert.ok(motivation, "a prospective seller with no property still produces a motivation signal");
  assert.equal(motivation.propertyId, null);
  assert.equal(motivation.confidenceBand, "StrongIndicator");
  assertExplainable(motivation, "agent_recorded_motivation");
});

test("re-engagement — a freshly created contact is NOT raised, so an import does not light up the whole database", async () => {
  const partyId = await createParty(A.brokerageId, "FreshlyImported", 0);
  await createRelationship({ brokerageId: A.brokerageId, partyId, propertyId: null, relationshipType: "owner", createdDaysAgo: 0 });

  await sweep([A.brokerageId]);

  const rows = await signalsFor(A.brokerageId, { partyId });
  assert.equal(rows.filter((s) => s.signalType === "re_engagement_opportunity").length, 0, "an import is not a period of neglect");
});

test("re-engagement — recent contact, an open opportunity, or an open commitment each suppress it", async () => {
  // (a) Contacted recently.
  const recentParty = await createParty(A.brokerageId, "ContactedRecently", 900);
  await createRelationship({ brokerageId: A.brokerageId, partyId: recentParty, propertyId: null, relationshipType: "owner", createdDaysAgo: 900 });
  await db.insert(growActivities).values({
    brokerageId: A.brokerageId,
    partyId: recentParty,
    activityType: "call",
    occurredAt: daysAgo(3),
    summary: "Spoke about the market.",
  });

  // (b) Dormant, but somebody already has an opportunity open for them.
  const opportunityParty = await createParty(A.brokerageId, "HasOpenOpportunity", 900);
  await createRelationship({ brokerageId: A.brokerageId, partyId: opportunityParty, propertyId: null, relationshipType: "owner", createdDaysAgo: 900 });
  await db.insert(growOpportunities).values({
    brokerageId: A.brokerageId,
    partyId: opportunityParty,
    opportunityType: "Listing",
    status: "Open",
    stage: "New",
    ownerUserId: A.admin.user.id,
    reason: "Already being worked.",
  });

  // (c) Dormant, but an agent has already promised to call them.
  const commitmentParty = await createParty(A.brokerageId, "HasOpenCommitment", 900);
  await createRelationship({ brokerageId: A.brokerageId, partyId: commitmentParty, propertyId: null, relationshipType: "owner", createdDaysAgo: 900 });
  await db.insert(growCommitments).values({
    brokerageId: A.brokerageId,
    partyId: commitmentParty,
    description: "Call them next month.",
    dueAt: new Date(Date.now() + 20 * MS_PER_DAY),
    status: "Open",
    createdBy: A.admin.user.id,
  });

  // (d) The control: dormant, nothing in the way.
  const controlParty = await createParty(A.brokerageId, "DormantControl", 900);
  await createRelationship({ brokerageId: A.brokerageId, partyId: controlParty, propertyId: null, relationshipType: "owner", createdDaysAgo: 900 });

  await sweep([A.brokerageId]);

  const reEngagementCount = async (partyId: number) =>
    (await signalsFor(A.brokerageId, { partyId })).filter((s) => s.signalType === "re_engagement_opportunity").length;

  assert.equal(await reEngagementCount(recentParty), 0, "recent contact is not dormancy");
  assert.equal(await reEngagementCount(opportunityParty), 0, "an open opportunity means somebody is already on it");
  assert.equal(await reEngagementCount(commitmentParty), 0, "an open commitment is an agent's own promise; AE must not nag about it");
  assert.equal(await reEngagementCount(controlParty), 1, "the control case still fires, so the test is not vacuous");
});

test("re-engagement — a contact with NO recorded connection at all is never raised", async () => {
  // A bare `parties` row. No relationship, no role. Raising this would be
  // "every row in the database", the opposite of prioritisation.
  const partyId = await createParty(A.brokerageId, "BareContactRow", 900);

  await sweep([A.brokerageId]);

  assert.equal((await signalsFor(A.brokerageId, { partyId })).length, 0, "a contact with no recorded connection is not a lead");
});

test("re-engagement — a contact whose only connection is a recorded ROLE is still reachable", async () => {
  const partyId = await createParty(A.brokerageId, "RoleOnly", 400);
  await db.insert(growContactRoles).values({ brokerageId: A.brokerageId, partyId, role: "PastClient", assignedByUserId: A.admin.user.id });

  await sweep([A.brokerageId]);

  const [signal] = (await signalsFor(A.brokerageId, { partyId })).filter((s) => s.signalType === "re_engagement_opportunity");
  assert.ok(signal, "a past client with a role and no relationship row is exactly the population this rule is for");
  assert.equal(signal.confidenceBand, "WorthReviewing", "400 days of silence sits in the middle band");
  const evidence = assertExplainable(signal, "re_engagement_opportunity");
  assert.deepEqual(evidence.basis?.roles, ["PastClient"]);
});

test("lease milestone — abstains with no recorded end date, fires within the window, and covers a property-less landlord", async () => {
  // (a) No end date: no milestone, ever.
  const openEndedParty = await createParty(A.brokerageId, "OpenEndedTenancy");
  const openEndedProperty = await createProperty(A, "2a Open Ended St");
  await createRelationship({ brokerageId: A.brokerageId, partyId: openEndedParty, propertyId: openEndedProperty, relationshipType: "tenant", validTo: null });

  // (b) Ending soon, property-anchored.
  const soonParty = await createParty(A.brokerageId, "TenancyEndingSoon");
  const soonProperty = await createProperty(A, "2b Ending Soon St");
  await createRelationship({
    brokerageId: A.brokerageId,
    partyId: soonParty,
    propertyId: soonProperty,
    relationshipType: "landlord",
    validTo: new Date(Date.now() + 20 * MS_PER_DAY),
  });

  // (c) Ending soon, with NO property linked at all.
  const propertylessParty = await createParty(A.brokerageId, "PropertylessLandlord");
  await createRelationship({
    brokerageId: A.brokerageId,
    partyId: propertylessParty,
    propertyId: null,
    relationshipType: "landlord",
    validTo: new Date(Date.now() + 20 * MS_PER_DAY),
  });

  // (d) Far in the future: outside the window.
  const farParty = await createParty(A.brokerageId, "TenancyFarOff");
  const farProperty = await createProperty(A, "2c Far Off St");
  await createRelationship({
    brokerageId: A.brokerageId,
    partyId: farParty,
    propertyId: farProperty,
    relationshipType: "landlord",
    validTo: new Date(Date.now() + 400 * MS_PER_DAY),
  });

  await sweep([A.brokerageId]);

  const milestones = async (partyId: number) =>
    (await signalsFor(A.brokerageId, { partyId })).filter((s) => s.signalType === "lease_tenancy_milestone");

  assert.equal((await milestones(openEndedParty)).length, 0, "no recorded end date means no invented milestone");
  assert.equal((await milestones(farParty)).length, 0, "400 days away is outside the window");

  const [soon] = await milestones(soonParty);
  assert.ok(soon, "a tenancy ending in 20 days is a milestone");
  assert.equal(soon.confidenceBand, "StrongIndicator");
  assert.equal(soon.propertyId, soonProperty);
  assert.ok(soon.expiresAt, "a milestone genuinely ages out, so it carries its own expiry");
  assertExplainable(soon, "lease_tenancy_milestone");

  const [propertyless] = await milestones(propertylessParty);
  assert.ok(propertyless, "a landlord with no property linked still gets the milestone");
  assert.equal(propertyless.propertyId, null);
  assert.equal(propertyless.dedupeKey.includes(":party:"), true, "with no property, the key is party-anchored");
});

test("agent-recorded motivation — retires as soon as someone opens an opportunity for that contact", async () => {
  const partyId = await createParty(A.brokerageId, "MotivationThenOpportunity", 30);
  await createRelationship({ brokerageId: A.brokerageId, partyId, propertyId: null, relationshipType: "prospective_seller", createdDaysAgo: 30 });

  await sweep([A.brokerageId]);
  const [raised] = (await signalsFor(A.brokerageId, { partyId })).filter((s) => s.signalType === "agent_recorded_motivation");
  assert.ok(raised);
  assert.equal(raised.status, "Active");

  await db.insert(growOpportunities).values({
    brokerageId: A.brokerageId,
    partyId,
    opportunityType: "Listing",
    status: "Open",
    stage: "New",
    ownerUserId: A.admin.user.id,
    reason: "Picked up from the signal.",
  });

  await sweep([A.brokerageId]);
  const [after] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, raised.id));
  assert.equal(after.status, "Expired", "once an agent is working the contact, the signal is retired rather than repeated");
});

/* =====================================================================
 * 3. FINGERPRINT STABILITY.
 * ===================================================================*/

test("fingerprints are stable across sweeps when nothing about the evidence changed", async () => {
  // One contact exercising several rules at once, so this covers the whole
  // rule set rather than a single easy case.
  const partyId = await createParty(A.brokerageId, "FingerprintStability", 800);
  const propertyId = await createProperty(A, "3a Fingerprint St");
  await createRelationship({
    brokerageId: A.brokerageId,
    partyId,
    propertyId,
    relationshipType: "owner",
    createdDaysAgo: 800,
    ownershipStartDate: yearsAgo(12),
    ownershipStartSource: "import",
    ownershipStartPrecision: "day",
  });
  await createRelationship({
    brokerageId: A.brokerageId,
    partyId,
    propertyId,
    relationshipType: "landlord",
    createdDaysAgo: 800,
    validTo: new Date(Date.now() + 15 * MS_PER_DAY),
  });
  await recordObservation({
    brokerageId: A.brokerageId,
    propertyId,
    observationType: "sales_history",
    provider: "mock",
    payload: { comparableSales: [{ address: "next door", price: 1_000_000 }] },
    sourceTimestamp: daysAgo(5),
  });

  await sweep([A.brokerageId]);
  const first = await signalsFor(A.brokerageId, { partyId });
  const firstProperty = await signalsFor(A.brokerageId, { propertyId });
  const before = new Map([...first, ...firstProperty].map((s) => [s.dedupeKey, s.evidenceFingerprint]));
  assert.ok(before.size >= 3, `expected several rules to fire for this fixture, got ${before.size}`);
  for (const [key, fingerprint] of before) {
    assert.ok(fingerprint && fingerprint.length > 0, `${key}: a fingerprint is recorded`);
  }

  // Sweep twice more. Wall-clock time advances (dormancy days, tenure days
  // and observation age all move), but no RECORD changes — so no fingerprint
  // may move either, or the re-review policy would be defeated by the clock.
  await sweep([A.brokerageId]);
  await sweep([A.brokerageId]);

  const second = await signalsFor(A.brokerageId, { partyId });
  const secondProperty = await signalsFor(A.brokerageId, { propertyId });
  const after = new Map([...second, ...secondProperty].map((s) => [s.dedupeKey, s.evidenceFingerprint]));

  assert.equal(after.size, before.size, "the same signals are present, not duplicated");
  for (const [key, fingerprint] of before) {
    assert.equal(after.get(key), fingerprint, `${key}: fingerprint must not churn while the underlying records are unchanged`);
  }
});

test("fingerprint DOES move when the underlying record genuinely changes", async () => {
  const partyId = await createParty(A.brokerageId, "FingerprintChanges");
  const propertyId = await createProperty(A, "3b Fingerprint Change St");
  const relationshipId = await createRelationship({
    brokerageId: A.brokerageId,
    partyId,
    propertyId,
    relationshipType: "owner",
    ownershipStartDate: yearsAgo(6),
    ownershipStartSource: "import",
    ownershipStartPrecision: "day",
  });

  await sweep([A.brokerageId]);
  const [before] = (await signalsFor(A.brokerageId, { propertyId })).filter((s) => s.signalType === "long_ownership_tenure");
  assert.equal(before.confidenceBand, "Emerging");

  // A corrected acquisition date — a real change to a real record.
  await db.update(growRelationships).set({ ownershipStartDate: yearsAgo(12) }).where(eq(growRelationships.id, relationshipId));
  await sweep([A.brokerageId]);

  const [after] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, before.id));
  assert.equal(after.confidenceBand, "StrongIndicator");
  assert.notEqual(after.evidenceFingerprint, before.evidenceFingerprint, "a genuine change to the evidence must move the fingerprint");
});

/* =====================================================================
 * 4. PER-RULE BUDGETING (the starvation fix).
 * ===================================================================*/

test("budgeting — a tiny cap is shared across rules rather than consumed entirely by the first one", async () => {
  // A brokerage where the FIRST rule in the list alone could fill any cap.
  const tenant = await createBrokerageWithUsers(baseUrl, `Signal Rules Budget ${suffix}`);
  try {
    for (let i = 0; i < 6; i += 1) {
      const partyId = await createParty(tenant.brokerageId, `BudgetTenure-${i}`);
      const propertyId = await createProperty(tenant, `4-${i} Budget St`);
      await createRelationship({
        brokerageId: tenant.brokerageId,
        partyId,
        propertyId,
        relationshipType: "owner",
        ownershipStartDate: yearsAgo(12),
        ownershipStartSource: "import",
        ownershipStartPrecision: "day",
      });
    }
    // ...and a single contact that only a LATER rule can see.
    const motivationParty = await createParty(tenant.brokerageId, "BudgetMotivation", 30);
    await createRelationship({
      brokerageId: tenant.brokerageId,
      partyId: motivationParty,
      propertyId: null,
      relationshipType: "prospective_seller",
      createdDaysAgo: 30,
    });

    // Under stage 1's shared slice(0, maxCandidates) this cap would have been
    // entirely consumed by the tenure rule and agent_recorded_motivation
    // would have produced nothing — on this run and on every run after it.
    const result = await evaluateCandidates({ brokerageId: tenant.brokerageId, now: new Date(), maxCandidates: 7 });

    assert.equal(result.truncated, true, "the cap is genuinely binding for this fixture");
    const types = new Set(result.candidates.map((c) => c.signalType));
    assert.ok(types.has("agent_recorded_motivation"), "a rule late in the list is NOT starved by an earlier rule with more data");

    const tenureReport = result.ruleReports.find((r) => r.rule === "long_ownership_tenure");
    assert.ok(tenureReport);
    assert.equal(tenureReport.truncated, true, "the over-budget rule is the one reported as truncated");
    assert.ok(tenureReport.nextCursor > 0, "it records where to resume");
    assert.ok(tenureReport.produced <= tenureReport.budget, "no rule exceeds its share");

    // Every rule was given a budget and reported on, so a future rule added
    // without a budget cannot slip through unnoticed.
    assert.deepEqual(
      result.ruleReports.map((r) => r.rule).sort(),
      [...EVALUATION_RULE_NAMES].sort(),
      "every rule reports, so none can be silently skipped",
    );

    // Truncation names the rules it is NOT authoritative for, so a caller can
    // still safely expire the types whose rules ran to completion.
    assert.ok(!result.authoritativeSignalTypes.includes("long_ownership_tenure"));
    assert.ok(result.authoritativeSignalTypes.includes("agent_recorded_motivation"));

    // CONTINUATION: resuming from the reported cursor returns DIFFERENT rows,
    // rather than re-reading the same head of the table forever.
    const firstKeys = new Set(result.candidates.filter((c) => c.signalType === "long_ownership_tenure").map((c) => c.dedupeKey));
    const resumed = await evaluateCandidates({
      brokerageId: tenant.brokerageId,
      now: new Date(),
      maxCandidates: 7,
      ruleCursors: result.nextRuleCursors,
    });
    const resumedKeys = resumed.candidates.filter((c) => c.signalType === "long_ownership_tenure").map((c) => c.dedupeKey);
    assert.ok(resumedKeys.length > 0, "the next pass makes progress through the same rule");
    assert.ok(resumedKeys.every((k) => !firstKeys.has(k)), "a continuation returns rows the previous pass did not reach");
  } finally {
    await cleanupBrokerages([tenant.brokerageId]);
  }
});

test("budgeting — an oversized provider payload is bounded in evidence and points at the full value", async () => {
  const propertyId = await createProperty(A, "4z Big Payload St");
  const big: Record<string, unknown> = { note: "x".repeat(20_000) };
  for (let i = 0; i < 80; i += 1) big[`field_${String(i).padStart(3, "0")}`] = `value-${i}`;

  await recordObservation({
    brokerageId: A.brokerageId,
    propertyId,
    observationType: "planning_development",
    provider: "mock",
    payload: big,
    sourceTimestamp: daysAgo(3),
  });

  await sweep([A.brokerageId]);

  const [signal] = (await signalsFor(A.brokerageId, { propertyId })).filter((s) => s.signalType === "development_planning_activity");
  assert.ok(signal);
  const evidence = assertExplainable(signal, "development_planning_activity");
  assert.equal(evidence.basis?.payloadBounded, true, "an oversized payload is bounded rather than embedded whole");
  const stored = JSON.stringify(signal.evidence);
  assert.ok(stored.length < 20_000, `evidence must not carry the whole 20KB payload, got ${stored.length} bytes`);
  const fullPayloadAt = evidence.basis?.fullPayloadAt as { recordType: string; recordId: number } | undefined;
  assert.equal(fullPayloadAt?.recordType, "property_provider_observations", "the complete payload is still pointed at, not lost");
  assert.ok((evidence.unknowns ?? []).some((u) => /too large/i.test(u)), "the agent is told the payload was trimmed");
});

/* =====================================================================
 * 5. TENANT ISOLATION, for the new contact-driven rules specifically.
 * ===================================================================*/

test("tenant isolation — the contact-driven rules never read or raise across brokerages", async () => {
  // Identical fixtures in both tenants, so a leak would be unmistakable.
  const partyA = await createParty(A.brokerageId, "IsolationContactA", 900);
  await createRelationship({ brokerageId: A.brokerageId, partyId: partyA, propertyId: null, relationshipType: "prospective_seller", createdDaysAgo: 900 });

  const partyB = await createParty(B.brokerageId, "IsolationContactB", 900);
  await createRelationship({ brokerageId: B.brokerageId, partyId: partyB, propertyId: null, relationshipType: "prospective_seller", createdDaysAgo: 900 });

  // B also gets an ownership-start gap and a provider observation, to prove
  // the capture path is tenant-scoped too.
  const propertyB = await createProperty(B, "5b Isolation St");
  const relationshipB = await createRelationship({
    brokerageId: B.brokerageId,
    partyId: partyB,
    propertyId: propertyB,
    relationshipType: "owner",
    ownershipStartDate: null,
  });

  // Sweep A only.
  await sweep([A.brokerageId]);

  const aSignals = await signalsFor(A.brokerageId);
  assert.ok(aSignals.length > 0);
  assert.ok(aSignals.every((s) => s.brokerageId === A.brokerageId), "every signal A's sweep wrote belongs to A");

  assert.equal((await signalsFor(B.brokerageId, { partyId: partyB })).length, 0, "sweeping A must not raise anything for B's identical contact");

  // Recording an observation in A must not fill B's ownership gap, even
  // though B has an identically shaped relationship.
  await recordObservation({
    brokerageId: A.brokerageId,
    propertyId: await createProperty(A, "5a Isolation St"),
    observationType: "ownership",
    provider: "mock",
    payload: { acquisitionDate: "2012-02-02" },
    sourceTimestamp: daysAgo(1),
  });
  const [bRelationship] = await db.select().from(growRelationships).where(eq(growRelationships.id, relationshipB));
  assert.equal(bRelationship.ownershipStartDate, null, "an observation recorded in A never touches B's relationships");

  // And the evaluation itself, called directly, only ever sees its own tenant.
  const bResult = await evaluateCandidates({ brokerageId: B.brokerageId, now: new Date(), maxCandidates: 500 });
  assert.ok(bResult.candidates.length > 0, "B genuinely has candidates of its own");
  assert.ok(bResult.candidates.every((c) => c.brokerageId === B.brokerageId));
  const bPartyIds = new Set(bResult.candidates.map((c) => c.partyId));
  assert.ok(!bPartyIds.has(partyA), "B's evaluation never returns A's contacts");
});

/* =====================================================================
 * 6. CONTACTABILITY ON THE READ PATH.
 *
 * Raising a signal consults the contactability filter, which only protects a
 * contact who was already DNC-listed or fully suppressed at that moment. A
 * contact listed AFTERWARDS leaves an already-Active row stranded: the sweep
 * drops their candidate so it is never refreshed, still counts it as
 * supported so it is never expired, and it carries no expires_at so the
 * expiry pass never sees it either. Without a read-side check that row is
 * surfaced as a prospecting suggestion forever.
 *
 * W2-D CHANGED WHAT "THE READ-SIDE CHECK" DOES, and these tests changed with
 * it. It used to answer by returning an empty array — erasing the
 * intelligence from an authorised internal user, not merely the outreach.
 * It now returns the rows AND the restriction, inseparably:
 *
 *     ROWS MAY BE READ FOR DISPLAY.
 *     NO OUTREACH AFFORDANCE MAY BE DERIVED FROM THEM.
 *
 * These two tests cover the first half and the definition of "suppressed".
 * The second half — that no affordance anywhere yields an email, SMS or call
 * — is proved exhaustively in ./contactabilityOutreachPathway.test.ts.
 * ===================================================================*/

test("contactability on read — a contact DNC-listed AFTER their signal was raised keeps the signal, and gains an outreach restriction", async () => {
  const partyId = await createParty(A.brokerageId, "ListedAfterRaise", 900);
  await createRelationship({ brokerageId: A.brokerageId, partyId, propertyId: null, relationshipType: "prospective_seller", createdDaysAgo: 900 });

  // 1. The signal is raised while the contact is perfectly contactable.
  await sweep([A.brokerageId]);
  const raised = await readActiveSignalsForParty(partyId, A.brokerageId);
  assert.ok(raised.signals.length > 0, "the contact is reachable, so their signals are visible");
  assert.equal(raised.outreachRestriction, null, "and nothing restricts contacting them");
  const raisedIds = raised.signals.map((s) => s.id);

  // 2. They are listed afterwards — the exact sequence the write-time filter
  //    cannot cover, because the listing happens after the write.
  await db.insert(growContactDncrStatuses).values({
    brokerageId: A.brokerageId,
    partyId,
    channel: "PHONE_CALL",
    status: "LISTED",
    source: "test-fixture",
    checkedAt: new Date(),
    recordedByUserId: A.admin.user.id,
  });

  // 3. THE READ NOW RESTRICTS OUTREACH — and does NOT erase the intelligence.
  //    SIGNAL EXISTS != CONTACT MAY BE CONTACTED. A DNC listing says the
  //    second thing; answering the first with it is what W2-D corrected.
  const restricted = await readActiveSignalsForParty(partyId, A.brokerageId);
  assert.deepEqual(
    restricted.signals.map((s) => s.id).sort(),
    [...raisedIds].sort(),
    "every signal the contact had is still readable — a contactability restriction does not delete legitimate intelligence",
  );
  assert.ok(restricted.outreachRestriction, "and the restriction is returned with them, in the same value");
  assert.equal(restricted.outreachRestriction?.outreachProhibited, true);
  assert.equal(restricted.outreachRestriction?.reason, "contactability_suppressed");
  // The restriction must be unmistakable, not a bare boolean a surface could
  // render as nothing.
  assert.match(restricted.outreachRestriction!.notice, /do-not-contact/i);
  assert.match(restricted.outreachRestriction!.recommendedAction, /^Do not contact\./);
  // Total by construction — this restriction is never partial.
  assert.deepEqual([...restricted.outreachRestriction!.blockedChannels].sort(), [...GROW_CONSENT_CHANNELS].sort());

  // 4. HIDDEN OUTREACH, NOT RETIRED DATA. The rows themselves are untouched —
  //    contactability restricts contact, it never silently destroys history.
  for (const id of raisedIds) {
    const [row] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, id));
    assert.equal(row.status, "Active", "the signal row is left Active; restricting is not expiring");
    assert.equal(row.dismissedReason, null, "restricting is not dismissing either");
  }

  // 5. And a sweep while they are listed must still not retire the rows, nor
  //    start refreshing them — the sweep's own write-time filter is unchanged.
  await sweep([A.brokerageId]);
  for (const id of raisedIds) {
    const [row] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, id));
    assert.equal(row.status, "Active", "a suppressed contact's history survives a sweep intact");
  }

  // 6. THE RESTRICTION LIFTS WITH THE LISTING. Nothing was destroyed while it
  //    was in force, so there is nothing to restore.
  await db.delete(growContactDncrStatuses).where(and(eq(growContactDncrStatuses.brokerageId, A.brokerageId), eq(growContactDncrStatuses.partyId, partyId)));
  const released = await readActiveSignalsForParty(partyId, A.brokerageId);
  assert.equal(released.outreachRestriction, null, "clearing the listing clears the restriction");
  assert.deepEqual(released.signals.map((s) => s.id).sort(), [...raisedIds].sort(), "with the same rows, untouched throughout");
});

test("contactability on read — suppression across EVERY channel restricts outreach; a single-channel suppression does not", async () => {
  const fullyParty = await createParty(A.brokerageId, "SuppressedEverywhere", 900);
  await createRelationship({ brokerageId: A.brokerageId, partyId: fullyParty, propertyId: null, relationshipType: "prospective_seller", createdDaysAgo: 900 });
  const partialParty = await createParty(A.brokerageId, "SuppressedOneChannel", 900);
  await createRelationship({ brokerageId: A.brokerageId, partyId: partialParty, propertyId: null, relationshipType: "prospective_seller", createdDaysAgo: 900 });

  await sweep([A.brokerageId]);
  assert.ok((await readActiveSignalsForParty(fullyParty, A.brokerageId)).signals.length > 0);
  assert.ok((await readActiveSignalsForParty(partialParty, A.brokerageId)).signals.length > 0);

  await db.insert(growContactChannelSuppressions).values(
    GROW_CONSENT_CHANNELS.map((channel) => ({
      brokerageId: A.brokerageId,
      partyId: fullyParty,
      channel,
      state: "SUPPRESSED",
      reason: "test-fixture",
      recordedByUserId: A.admin.user.id,
    })),
  );
  await db.insert(growContactChannelSuppressions).values({
    brokerageId: A.brokerageId,
    partyId: partialParty,
    channel: "SMS",
    state: "SUPPRESSED",
    reason: "test-fixture",
    recordedByUserId: A.admin.user.id,
  });

  const fully = await readActiveSignalsForParty(fullyParty, A.brokerageId);
  assert.ok(fully.outreachRestriction, "suppressed on every channel — outreach is restricted");
  assert.ok(fully.signals.length > 0, "and the intelligence itself is still readable by an entitled internal user");

  const partial = await readActiveSignalsForParty(partialParty, A.brokerageId);
  assert.equal(
    partial.outreachRestriction,
    null,
    "a partially suppressed contact is still reachable another way, so no blanket restriction applies — the surviving channel's own consent rules govern it",
  );
  assert.ok(partial.signals.length > 0);
});

/* =====================================================================
 * 7. THE PRODUCT GUARDRAIL.
 * ===================================================================*/

test("no rule can trigger customer communication — generation only", async () => {
  const partyId = await createParty(A.brokerageId, "NoOutboundEver", 900);
  await createRelationship({ brokerageId: A.brokerageId, partyId, propertyId: null, relationshipType: "prospective_seller", createdDaysAgo: 900 });

  const opportunitiesBefore = await db.select({ id: growOpportunities.id }).from(growOpportunities).where(eq(growOpportunities.brokerageId, A.brokerageId));
  const activitiesBefore = await db.select({ id: growActivities.id }).from(growActivities).where(eq(growActivities.brokerageId, A.brokerageId));
  const commitmentsBefore = await db.select({ id: growCommitments.id }).from(growCommitments).where(eq(growCommitments.brokerageId, A.brokerageId));

  await sweep([A.brokerageId]);

  const opportunitiesAfter = await db.select({ id: growOpportunities.id }).from(growOpportunities).where(eq(growOpportunities.brokerageId, A.brokerageId));
  const activitiesAfter = await db.select({ id: growActivities.id }).from(growActivities).where(eq(growActivities.brokerageId, A.brokerageId));
  const commitmentsAfter = await db.select({ id: growCommitments.id }).from(growCommitments).where(eq(growCommitments.brokerageId, A.brokerageId));

  assert.equal(opportunitiesAfter.length, opportunitiesBefore.length, "no opportunity is created by generation");
  assert.equal(activitiesAfter.length, activitiesBefore.length, "no activity (call/email/sms) is recorded by generation");
  assert.equal(commitmentsAfter.length, commitmentsBefore.length, "no commitment is created by generation");

  // The signals themselves only ever SUGGEST, and say so.
  const raised = await signalsFor(A.brokerageId, { partyId });
  assert.ok(raised.length > 0);
  for (const signal of raised) {
    const evidence = signal.evidence as EvidenceEnvelope;
    assert.match(String(evidence.agentAction), /^Consider /, "a suggested action is phrased for a human to choose, never as an action taken");
  }
});
