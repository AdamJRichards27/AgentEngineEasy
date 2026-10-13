// E9-DP. Direct brokerage_id predicates on appraisals and
// communication_participants, kept beside the parent join. Same-brokerage
// rows still resolve. A foreign id is not found, a foreign webhook
// destination resolves to null, a foreign participant is
// CommunicationTenancyError, and an update through appraisalInBrokerage
// changes 0 rows. This file does not migrate and does not close E-9.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { renderMetricsText } from "@aee/events";
import {
  appraisals,
  brokerages,
  communicationParticipants,
  communicationThreads,
  communicationWebhookEvents,
  db,
  growOpportunities,
  parties,
  properties,
  setDbQueryObserver,
  users,
} from "@aee/db";
import { appraisalInBrokerage, finaliseAppraisal, getAppraisalByProperty } from "../appraisals.js";
import {
  AppraisalAccessError,
  assertAppraisalInBrokerage,
  listAppraisalPipeline,
  recordAppraisalOutcome,
  scheduleAppraisalFollowUp,
} from "../growAppraisals.js";
import { noteGrowAppraisalIsolationRejection } from "../grow/isolationRejection.js";
import { getRelationshipTimeline } from "../relationshipTimeline.js";
import { getGrowTodaySummary } from "../growToday.js";
import { opportunityHasActiveAppraisal } from "../../routes/grow.js";
import { evaluateCandidates } from "../propertyIntelligence/evaluation.js";
import { probeBrokerage } from "../propertyIntelligence/sweep.js";
import { fetchAppraisalsCreatedInPeriod, fetchStaleAppraisals } from "../ai/coaching/metrics.js";
import type { ResolvedPeriod } from "../ai/coaching/period.js";
import { createDraftMessage, listParticipants } from "../communications/messages.js";
import { outboundConsentReads } from "../communications/outboundConsent.js";
import { processInboundWebhook } from "../communications/webhooks.js";
import { CommunicationTenancyError } from "../communications/types.js";
import { fetchQualifyingCommunicationActivityRows } from "../qualifyingCommunications.js";
import { cleanupBrokerages } from "../../routes/__tests__/testSupport.js";

const APPRAISAL_EQ = /"appraisals"\."brokerage_id"\s*=\s*\$\d+/;
const APPRAISAL_NE = /"appraisals"\."brokerage_id"\s*<>\s*\$\d+/;
const PROPERTY_EQ = /"properties"\."brokerage_id"\s*=\s*\$\d+/;
const PARTICIPANT_EQ = /"communication_participants"\."brokerage_id"\s*=\s*\$\d+/;
const THREAD_EQ = /"communication_threads"\."brokerage_id"\s*=\s*\$\d+/;

const stamp = `e9dp-${Date.now()}-${process.pid}`;
const webhookProvider = `e9-dp-${stamp}`;
const created: number[] = [];

let homeId: number;
let otherId: number;
let homeUserId: number;
let homePropertyId: number;
let otherPropertyId: number;
let homePartyId: number;
let otherPartyId: number;
let homeAppraisalId: number;
let otherAppraisalId: number;
let homeOpportunityId: number;
let otherOpportunityId: number;
let homeThreadId: number;
let otherThreadId: number;
let homeParticipantId: number;
let otherParticipantId: number;
const otherEmail = `only-b-${stamp}@example.test`;

const period: ResolvedPeriod = {
  key: "custom",
  label: "e9-dp",
  start: new Date(Date.now() - 24 * 60 * 60 * 1000),
  end: new Date(Date.now() + 24 * 60 * 60 * 1000),
  isComplete: true,
  durationDays: 2,
  timeZone: "Australia/Brisbane",
  timeZoneSource: "fallback",
};

before(async () => {
  const { configureEvents } = await import("../events.js");
  configureEvents();

  const [home] = await db.insert(brokerages).values({ name: `E9DP home ${stamp}` }).returning();
  const [other] = await db.insert(brokerages).values({ name: `E9DP other ${stamp}` }).returning();
  created.push(home.id, other.id);
  homeId = home.id;
  otherId = other.id;

  const [homeUser] = await db
    .insert(users)
    .values({
      authProviderId: `e9dp-home-${stamp}`,
      email: `e9dp-home-${stamp}@example.test`,
      firstName: "Home",
      lastName: "Agent",
      brokerageId: home.id,
    })
    .returning();
  const [otherUser] = await db
    .insert(users)
    .values({
      authProviderId: `e9dp-other-${stamp}`,
      email: `e9dp-other-${stamp}@example.test`,
      firstName: "Other",
      lastName: "Agent",
      brokerageId: other.id,
    })
    .returning();
  homeUserId = homeUser.id;

  const [homeProperty] = await db
    .insert(properties)
    .values({ brokerageId: home.id, agentId: homeUser.id, formattedAddress: `1 Home St ${stamp}` })
    .returning();
  const [otherProperty] = await db
    .insert(properties)
    .values({ brokerageId: other.id, agentId: otherUser.id, formattedAddress: `2 Other St ${stamp}` })
    .returning();
  homePropertyId = homeProperty.id;
  otherPropertyId = otherProperty.id;

  const [homeParty] = await db
    .insert(parties)
    .values({ brokerageId: home.id, firstName: "Ada", lastName: "Home" })
    .returning();
  const [otherParty] = await db
    .insert(parties)
    .values({ brokerageId: other.id, firstName: "Bea", lastName: "Other" })
    .returning();
  homePartyId = homeParty.id;
  otherPartyId = otherParty.id;

  const [homeAppraisal] = await db
    .insert(appraisals)
    .values({
      propertyId: homeProperty.id,
      brokerageId: home.id,
      partyId: homeParty.id,
      status: "DRAFT",
      shareToken: `e9dp-home-${stamp}`,
    })
    .returning();
  const [otherAppraisal] = await db
    .insert(appraisals)
    .values({
      propertyId: otherProperty.id,
      brokerageId: other.id,
      partyId: otherParty.id,
      status: "DRAFT",
      shareToken: `e9dp-other-${stamp}`,
    })
    .returning();
  homeAppraisalId = homeAppraisal.id;
  otherAppraisalId = otherAppraisal.id;

  const [homeOpportunity] = await db
    .insert(growOpportunities)
    .values({
      brokerageId: home.id,
      partyId: homeParty.id,
      propertyId: homeProperty.id,
      opportunityType: "Appraisal",
      status: "Open",
      stage: "AppraisalBooked",
      convertedAppraisalId: homeAppraisal.id,
    })
    .returning();
  const [otherOpportunity] = await db
    .insert(growOpportunities)
    .values({
      brokerageId: other.id,
      partyId: otherParty.id,
      propertyId: otherProperty.id,
      opportunityType: "Appraisal",
      status: "Open",
      stage: "AppraisalBooked",
      convertedAppraisalId: otherAppraisal.id,
    })
    .returning();
  homeOpportunityId = homeOpportunity.id;
  otherOpportunityId = otherOpportunity.id;
  await db
    .update(appraisals)
    .set({ opportunityId: homeOpportunity.id })
    .where(eq(appraisals.id, homeAppraisal.id));
  await db
    .update(appraisals)
    .set({ opportunityId: otherOpportunity.id })
    .where(eq(appraisals.id, otherAppraisal.id));

  const [homeThread] = await db
    .insert(communicationThreads)
    .values({
      brokerageId: home.id,
      propertyId: homeProperty.id,
      subject: `Home ${stamp}`,
      createdByUserId: homeUser.id,
    })
    .returning();
  const [otherThread] = await db
    .insert(communicationThreads)
    .values({
      brokerageId: other.id,
      propertyId: otherProperty.id,
      subject: `Other ${stamp}`,
      createdByUserId: otherUser.id,
    })
    .returning();
  homeThreadId = homeThread.id;
  otherThreadId = otherThread.id;

  const [homeParticipant] = await db
    .insert(communicationParticipants)
    .values({
      threadId: homeThread.id,
      brokerageId: home.id,
      partyId: homeParty.id,
      role: "Owner",
      displayName: "Ada Home",
      email: `ada-${stamp}@example.test`,
      addedByUserId: homeUser.id,
    })
    .returning();
  const [otherParticipant] = await db
    .insert(communicationParticipants)
    .values({
      threadId: otherThread.id,
      brokerageId: other.id,
      partyId: otherParty.id,
      role: "Owner",
      displayName: "Bea Other",
      email: otherEmail,
      addedByUserId: otherUser.id,
    })
    .returning();
  homeParticipantId = homeParticipant.id;
  otherParticipantId = otherParticipant.id;
});

after(async () => {
  await db.delete(communicationWebhookEvents).where(eq(communicationWebhookEvents.provider, webhookProvider));
  if (created.length > 0) await cleanupBrokerages(created);
});

async function capture(run: () => Promise<unknown>): Promise<string[]> {
  const statements: string[] = [];
  const uninstall = setDbQueryObserver((query) => statements.push(query));
  try {
    await run();
  } finally {
    uninstall();
  }
  return statements;
}

function oneMatching(statements: string[], pattern: RegExp, label: string): string {
  const hits = statements.filter((statement) => pattern.test(statement));
  assert.equal(hits.length, 1, `${label}: expected one statement, got ${hits.length}`);
  return hits[0];
}

function assertAppraisalShape(sql: string, label: string): void {
  assert.match(sql, APPRAISAL_EQ, `${label} keeps appraisals.brokerage_id`);
  assert.match(sql, PROPERTY_EQ, `${label} keeps the property parent predicate`);
}

function assertParticipantShape(sql: string, label: string): void {
  assert.match(sql, PARTICIPANT_EQ, `${label} keeps communication_participants.brokerage_id`);
  assert.match(sql, THREAD_EQ, `${label} keeps the thread parent predicate`);
}

test("query shape: each E9-DP read keeps the direct brokerage predicate and the parent predicate", async () => {
  const byId = await capture(() => assertAppraisalInBrokerage(homeAppraisalId, homeId));
  assertAppraisalShape(oneMatching(byId, /from "appraisals"/, "assertAppraisalInBrokerage"), "assertAppraisalInBrokerage");

  const listed = await capture(() => listAppraisalPipeline({ brokerageId: homeId }));
  assertAppraisalShape(oneMatching(listed, /from "appraisals"/, "listAppraisalPipeline"), "listAppraisalPipeline");

  const byProperty = await capture(() => getAppraisalByProperty(homePropertyId, homeId));
  assertAppraisalShape(oneMatching(byProperty, /from "appraisals"/, "selectAppraisalForBrokerageProperty"), "selectAppraisalForBrokerageProperty");

  const fragment = await capture(() =>
    db
      .select({ id: appraisals.id })
      .from(appraisals)
      .where(and(eq(appraisals.id, homeAppraisalId), appraisalInBrokerage(homeId))),
  );
  assertAppraisalShape(oneMatching(fragment, /from "appraisals"/, "appraisalInBrokerage"), "appraisalInBrokerage");

  const timeline = await capture(() => getRelationshipTimeline(homeId, homePartyId));
  assertAppraisalShape(oneMatching(timeline, /from "appraisals"/, "timeline appraisals"), "timeline appraisals");
  assertParticipantShape(
    oneMatching(timeline, /from "communication_participants"/, "timeline participants"),
    "timeline participants",
  );

  const today = await capture(() => getGrowTodaySummary(homeId));
  const probe = oneMatching(today, /first_run_probe/, "first-run probe");
  assertAppraisalShape(probe, "first-run probe");
  const ruleE = today.filter((statement) => /from "appraisals"/.test(statement) && !/first_run_probe/.test(statement));
  assert.equal(ruleE.length, 1, "Rule E is one appraisal read");
  assertAppraisalShape(ruleE[0], "Rule E");

  const linked = await capture(() => opportunityHasActiveAppraisal(homeId, homeOpportunityId, homeAppraisalId));
  assertAppraisalShape(oneMatching(linked, /from "appraisals"/, "opportunityHasActiveAppraisal"), "opportunityHasActiveAppraisal");

  const sweep = await capture(() =>
    evaluateCandidates({ brokerageId: homeId, now: new Date(), maxCandidates: 20 }),
  );
  assertAppraisalShape(oneMatching(sweep, /from "appraisals"/, "stale appraisal sweep"), "stale appraisal sweep");

  const createdInPeriod = await capture(() => fetchAppraisalsCreatedInPeriod(homeId, period));
  assertAppraisalShape(oneMatching(createdInPeriod, /from "appraisals"/, "fetchAppraisalsCreatedInPeriod"), "fetchAppraisalsCreatedInPeriod");

  const stale = await capture(() => fetchStaleAppraisals(homeId, new Date()));
  assertAppraisalShape(oneMatching(stale, /from "appraisals"/, "fetchStaleAppraisals"), "fetchStaleAppraisals");

  const highWater = await capture(() => probeBrokerage(homeId, new Date()));
  const highWaterSql = oneMatching(highWater, /from appraisals a/, "probeBrokerage");
  assert.match(highWaterSql, /a\.brokerage_id\s*=\s*\$\d+/, "probe keeps appraisals.brokerage_id");
  assert.match(highWaterSql, /p\.brokerage_id\s*=\s*\$\d+/, "probe keeps the property parent predicate");

  const participants = await capture(() => listParticipants(homeThreadId, homeId));
  assertParticipantShape(oneMatching(participants, /from "communication_participants"/, "listParticipants"), "listParticipants");

  const draftStatements: string[] = [];
  const uninstallDraft = setDbQueryObserver((query) => draftStatements.push(query));
  try {
    await assert.rejects(
      () =>
        createDraftMessage({
          threadId: homeThreadId,
          brokerageId: homeId,
          channel: "INTERNAL_NOTE",
          classification: "TRANSACTIONAL",
          senderUserId: homeUserId,
          createdByUserId: homeUserId,
          recipientParticipantId: otherParticipantId,
        }),
      (err: unknown) => err instanceof CommunicationTenancyError,
    );
  } finally {
    uninstallDraft();
  }
  assertParticipantShape(
    oneMatching(draftStatements, /from "communication_participants"/, "createDraftMessage"),
    "createDraftMessage",
  );

  const consentStatements: string[] = [];
  const uninstallConsent = setDbQueryObserver((query) => consentStatements.push(query));
  try {
    await assert.rejects(
      () =>
        outboundConsentReads.load({
          id: 1,
          brokerageId: homeId,
          threadId: homeThreadId,
          channel: "EMAIL",
          classification: "TRANSACTIONAL",
          recipientDestination: otherEmail,
          recipientParticipantId: otherParticipantId,
          partyId: null,
        }),
      (err: unknown) => err instanceof CommunicationTenancyError,
    );
  } finally {
    uninstallConsent();
  }
  assertParticipantShape(
    oneMatching(consentStatements, /from "communication_participants"/, "resolveRecipientPartyId"),
    "resolveRecipientPartyId",
  );

  const qualifying = await capture(() =>
    fetchQualifyingCommunicationActivityRows(homeId, period.start, period.end, null, 10),
  );
  assertParticipantShape(
    oneMatching(qualifying, /communication_participants/, "qualifying exists"),
    "qualifying exists",
  );

  const rejection = await capture(() => noteGrowAppraisalIsolationRejection(otherAppraisalId, homeId));
  const rejectionSql = oneMatching(rejection, /from "appraisals"/, "noteGrowAppraisalIsolationRejection");
  assert.match(rejectionSql, APPRAISAL_NE, "elsewhere uses appraisals.brokerage_id");
  assert.match(rejectionSql, /"properties"/, "the property join stays");
});

function growRejections(): number {
  let total = 0;
  for (const line of renderMetricsText().split("\n")) {
    const match = /^tenant_isolation_rejection_total\{boundary="grow"\} (\d+)$/.exec(line);
    if (match) total += Number(match[1]);
  }
  return total;
}

test("behaviour: a foreign appraisal is not found, and the rejection is still counted", async () => {
  const own = await assertAppraisalInBrokerage(homeAppraisalId, homeId);
  assert.equal(own.id, homeAppraisalId);
  assert.equal(own.brokerageId, homeId);

  const before = growRejections();
  await assert.rejects(
    () => assertAppraisalInBrokerage(otherAppraisalId, homeId),
    (err: unknown) => err instanceof AppraisalAccessError && err.message === "Appraisal not found",
  );
  assert.ok(growRejections() >= before + 1, "a foreign appraisal id still counts a grow isolation rejection");

  const pipeline = await listAppraisalPipeline({ brokerageId: homeId });
  assert.ok(pipeline.some((row) => row.id === homeAppraisalId));
  assert.equal(pipeline.some((row) => row.id === otherAppraisalId), false);

  const ownByProperty = await getAppraisalByProperty(homePropertyId, homeId);
  assert.equal(ownByProperty?.id, homeAppraisalId);
  assert.equal(await getAppraisalByProperty(otherPropertyId, homeId), null);

  assert.equal(await opportunityHasActiveAppraisal(homeId, homeOpportunityId, homeAppraisalId), true);
  assert.equal(await opportunityHasActiveAppraisal(homeId, otherOpportunityId, otherAppraisalId), false);

  const timeline = await getRelationshipTimeline(homeId, homePartyId);
  const appraisalEvents = timeline.filter((event) => event.sourceType === "appraisal");
  assert.ok(appraisalEvents.some((event) => event.sourceId === homeAppraisalId));
  assert.equal(appraisalEvents.some((event) => event.sourceId === otherAppraisalId), false);
  assert.deepEqual(await getRelationshipTimeline(homeId, otherPartyId), []);
});

test("behaviour: a webhook destination that matches only another brokerage resolves to null", async () => {
  const statements: string[] = [];
  const uninstall = setDbQueryObserver((query) => statements.push(query));
  let result: Awaited<ReturnType<typeof processInboundWebhook>>;
  try {
    result = await processInboundWebhook({
      brokerageId: homeId,
      provider: webhookProvider,
      providerEventId: `inbound-${stamp}`,
      eventType: "INBOUND_MESSAGE",
      payload: { bodyText: "reply" },
      destination: otherEmail,
      destinationChannel: "EMAIL",
    });
  } finally {
    uninstall();
  }

  assert.equal(result.status, "PROCESSED");
  assert.match(result.detail ?? "", /no conversation in this brokerage/);
  assertParticipantShape(
    oneMatching(statements, /from "communication_participants"/, "inbound reply match"),
    "inbound reply match",
  );

  const { communicationMessages } = await import("@aee/db");
  const written = await db
    .select({ id: communicationMessages.id, threadId: communicationMessages.threadId })
    .from(communicationMessages)
    .where(eq(communicationMessages.brokerageId, homeId));
  assert.equal(written.length, 0);
  const foreignThreadMessages = await db
    .select({ id: communicationMessages.id })
    .from(communicationMessages)
    .where(eq(communicationMessages.threadId, otherThreadId));
  assert.equal(foreignThreadMessages.length, 0);
});

test("behaviour: a foreign participant id is CommunicationTenancyError, and the home participant still lists", async () => {
  const listed = await listParticipants(homeThreadId, homeId);
  assert.ok(listed.some((row) => row.id === homeParticipantId));

  await assert.rejects(
    () => listParticipants(otherThreadId, homeId),
    (err: unknown) => err instanceof CommunicationTenancyError,
  );
  await assert.rejects(
    () =>
      createDraftMessage({
        threadId: homeThreadId,
        brokerageId: homeId,
        channel: "INTERNAL_NOTE",
        classification: "TRANSACTIONAL",
        senderUserId: homeUserId,
        createdByUserId: homeUserId,
        recipientParticipantId: otherParticipantId,
      }),
    (err: unknown) => err instanceof CommunicationTenancyError,
  );
});

test("behaviour: outcome, follow-up, finalise, and link backfill updates on a foreign id change 0 rows", async () => {
  const before = await db.select().from(appraisals).where(eq(appraisals.id, otherAppraisalId));
  assert.equal(before.length, 1);
  const original = before[0];

  async function foreignUpdate(set: Record<string, unknown>, label: string): Promise<void> {
    const statements: string[] = [];
    const uninstall = setDbQueryObserver((query) => statements.push(query));
    let rows: { id: number }[];
    try {
      rows = await db
        .update(appraisals)
        .set(set)
        .where(and(eq(appraisals.id, otherAppraisalId), appraisalInBrokerage(homeId)))
        .returning({ id: appraisals.id });
    } finally {
      uninstall();
    }
    assert.equal(rows.length, 0, `${label} updates 0 rows`);
    const sql = oneMatching(statements, /update "appraisals"/i, label);
    assertAppraisalShape(sql, label);
  }

  await foreignUpdate(
    { status: "LOST", outcome: "LOST", outcomeNotes: "foreign", outcomeAt: new Date(), updatedAt: new Date() },
    "outcome",
  );
  await foreignUpdate(
    { followUpAt: new Date(), followUpNotes: "foreign", status: "FOLLOW_UP", updatedAt: new Date() },
    "follow-up",
  );
  await foreignUpdate({ isFinalised: true, updatedAt: new Date() }, "finalise");
  await foreignUpdate({ partyId: homePartyId, updatedAt: new Date() }, "link backfill");

  const [afterRow] = await db.select().from(appraisals).where(eq(appraisals.id, otherAppraisalId));
  assert.equal(afterRow.status, original.status);
  assert.equal(afterRow.outcome, original.outcome);
  assert.equal(afterRow.followUpAt, original.followUpAt);
  assert.equal(afterRow.isFinalised, original.isFinalised);
  assert.equal(afterRow.partyId, original.partyId);
  assert.equal(afterRow.brokerageId, otherId);

  await assert.rejects(
    () =>
      recordAppraisalOutcome({
        appraisalId: otherAppraisalId,
        brokerageId: homeId,
        userId: homeUserId,
        outcome: "LOST",
      }),
    (err: unknown) => err instanceof AppraisalAccessError,
  );
  await assert.rejects(
    () =>
      scheduleAppraisalFollowUp({
        appraisalId: otherAppraisalId,
        brokerageId: homeId,
        userId: homeUserId,
        followUpAt: new Date().toISOString(),
      }),
    (err: unknown) => err instanceof AppraisalAccessError,
  );
  await assert.rejects(
    () => finaliseAppraisal({ propertyId: otherPropertyId, userId: homeUserId, brokerageId: homeId }),
    (err: unknown) => err instanceof Error && /not found/i.test(err.message),
  );

  const [still] = await db.select().from(appraisals).where(eq(appraisals.id, otherAppraisalId));
  assert.equal(still.status, "DRAFT");
  assert.equal(still.isFinalised, false);
  assert.equal(still.partyId, otherPartyId);
});
