// C-6 — qualifying Comms Hub messages count toward Grow Today recency and
// coach activity totals. Read-side only.
//
// Qualifying (lib/qualifyingCommunications.ts): EMAIL, SMS, or PHONE_CALL
// that was actually sent or delivered outbound, or received inbound, and
// linked to the contact through communication_participants.party_id.
// Failed, draft, and queued messages do not count. A message stamped with
// party_id but with no participant row does not count.
//
// Migration 0036 stores communication_participants.brokerage_id from the
// thread and rejects a party from another brokerage. The two mismatched
// participant shapes are no longer storable. Their messages stay, with no
// participant row, and still must not move recency or the coach count.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  db,
  brokerages,
  communicationMessages,
  communicationParticipants,
  communicationThreads,
  growRelationships,
  parties,
  setDbQueryObserver,
} from "@aee/db";
import { getGrowTodaySummary } from "../growToday.js";
import { computeActivityConsistency, fetchActivityRows } from "../ai/coaching/metrics.js";
import type { ResolvedPeriod } from "../ai/coaching/period.js";
import { cleanupBrokerages } from "../../routes/__tests__/testSupport.js";

const DAY = 24 * 60 * 60 * 1000;

let homeId: number;
let foreignId: number;
let emailedId: number;
let textedId: number;
let calledId: number;
let repliedId: number;
let failedId: number;
let unsentId: number;
let unlinkedId: number;
let monthAgoId: number;
let badRowId: number;
let foreignPartyId: number;

before(async () => {
  const { configureEvents } = await import("../events.js");
  configureEvents();

  const [home] = await db.insert(brokerages).values({ name: `C6 home ${Date.now()}` }).returning();
  const [foreign] = await db.insert(brokerages).values({ name: `C6 foreign ${Date.now()}` }).returning();
  homeId = home.id;
  foreignId = foreign.id;

  emailedId = await insertContact(homeId, "Emailed");
  textedId = await insertContact(homeId, "Texted");
  calledId = await insertContact(homeId, "Called");
  repliedId = await insertContact(homeId, "Replied");
  failedId = await insertContact(homeId, "Failed");
  unsentId = await insertContact(homeId, "Unsent");
  unlinkedId = await insertContact(homeId, "Unlinked");
  monthAgoId = await insertContact(homeId, "MonthAgo");
  badRowId = await insertContact(homeId, "BadRow");
  foreignPartyId = await insertContact(foreignId, "Foreign");

  const yesterday = new Date(Date.now() - DAY);
  // A little past 30 days so daysSince stays 30 for the length of this test.
  const monthAgo = new Date(Date.now() - (30 * DAY + 2 * 60 * 60 * 1000));

  await insertMessage({
    threadBrokerageId: homeId,
    messageBrokerageId: homeId,
    partyId: emailedId,
    channel: "EMAIL",
    direction: "OUTBOUND",
    status: "DELIVERED",
    sentAt: yesterday,
    deliveredAt: yesterday,
    createdAt: yesterday,
    withParticipant: true,
  });
  await insertMessage({
    threadBrokerageId: homeId,
    messageBrokerageId: homeId,
    partyId: textedId,
    channel: "SMS",
    direction: "OUTBOUND",
    status: "SENT",
    sentAt: yesterday,
    createdAt: yesterday,
    withParticipant: true,
  });
  await insertMessage({
    threadBrokerageId: homeId,
    messageBrokerageId: homeId,
    partyId: calledId,
    channel: "PHONE_CALL",
    direction: "OUTBOUND",
    status: "SENT",
    sentAt: yesterday,
    createdAt: yesterday,
    withParticipant: true,
  });
  await insertMessage({
    threadBrokerageId: homeId,
    messageBrokerageId: homeId,
    partyId: repliedId,
    channel: "EMAIL",
    direction: "INBOUND",
    status: "RECEIVED",
    createdAt: yesterday,
    withParticipant: true,
  });
  await insertMessage({
    threadBrokerageId: homeId,
    messageBrokerageId: homeId,
    partyId: failedId,
    channel: "EMAIL",
    direction: "OUTBOUND",
    status: "FAILED",
    failedAt: yesterday,
    createdAt: yesterday,
    withParticipant: true,
  });
  await insertMessage({
    threadBrokerageId: homeId,
    messageBrokerageId: homeId,
    partyId: unsentId,
    channel: "EMAIL",
    direction: "OUTBOUND",
    status: "DRAFT",
    createdAt: yesterday,
    withParticipant: true,
  });
  await insertMessage({
    threadBrokerageId: homeId,
    messageBrokerageId: homeId,
    partyId: unsentId,
    channel: "SMS",
    direction: "OUTBOUND",
    status: "QUEUED",
    createdAt: yesterday,
    withParticipant: true,
  });
  // Denormalised party anchor, no participant. Must not count.
  await insertMessage({
    threadBrokerageId: homeId,
    messageBrokerageId: homeId,
    partyId: unlinkedId,
    channel: "EMAIL",
    direction: "OUTBOUND",
    status: "SENT",
    sentAt: yesterday,
    createdAt: yesterday,
    withParticipant: false,
  });
  await insertMessage({
    threadBrokerageId: homeId,
    messageBrokerageId: homeId,
    partyId: monthAgoId,
    channel: "EMAIL",
    direction: "OUTBOUND",
    status: "SENT",
    sentAt: monthAgo,
    createdAt: monthAgo,
    withParticipant: true,
  });

  // 0036 refuses a participant whose party brokerage disagrees with the
  // thread. The message is still inserted, without that participant.
  await insertMessage({
    threadBrokerageId: foreignId,
    messageBrokerageId: homeId,
    partyId: badRowId,
    channel: "EMAIL",
    direction: "OUTBOUND",
    status: "SENT",
    sentAt: yesterday,
    createdAt: yesterday,
    withParticipant: false,
  });
  await assert.rejects(
    () =>
      insertMessage({
        threadBrokerageId: foreignId,
        messageBrokerageId: homeId,
        partyId: badRowId,
        channel: "EMAIL",
        direction: "OUTBOUND",
        status: "SENT",
        sentAt: yesterday,
        createdAt: yesterday,
        withParticipant: true,
      }),
    (err: unknown) => constraintViolation(err, "communication_participants_party_brokerage_fk"),
  );
  await insertMessage({
    threadBrokerageId: homeId,
    messageBrokerageId: homeId,
    partyId: foreignPartyId,
    channel: "EMAIL",
    direction: "OUTBOUND",
    status: "SENT",
    sentAt: yesterday,
    createdAt: yesterday,
    withParticipant: false,
  });
  await assert.rejects(
    () =>
      insertMessage({
        threadBrokerageId: homeId,
        messageBrokerageId: homeId,
        partyId: foreignPartyId,
        channel: "EMAIL",
        direction: "OUTBOUND",
        status: "SENT",
        sentAt: yesterday,
        createdAt: yesterday,
        withParticipant: true,
      }),
    (err: unknown) => constraintViolation(err, "communication_participants_party_brokerage_fk"),
  );
});

after(async () => {
  await cleanupBrokerages([homeId, foreignId]);
});

test("an email, SMS, call, or received message yesterday means the contact is not cold", async () => {
  const summary = await getGrowTodaySummary(homeId);
  for (const partyId of [emailedId, textedId, calledId, repliedId]) {
    assert.equal(
      summary.priorityActions.find((action) => action.partyId === partyId),
      undefined,
      `party ${partyId} was contacted yesterday and must not be a cold card`,
    );
  }
});

test("a failed, draft, or queued message does not count, and neither does a message with no participant", async () => {
  const summary = await getGrowTodaySummary(homeId);
  for (const partyId of [failedId, unsentId, unlinkedId, badRowId]) {
    const card = summary.priorityActions.find((action) => action.partyId === partyId);
    assert.ok(card, `party ${partyId} must still be cold`);
    assert.equal(card.type, "relationship_cold");
    assert.equal(card.reason, "No contact recorded yet.");
  }
});

test("a qualifying email thirty days ago is the last contact, and still cold", async () => {
  const summary = await getGrowTodaySummary(homeId);
  const card = summary.priorityActions.find((action) => action.partyId === monthAgoId);
  assert.ok(card);
  assert.equal(card.reason, "No contact recorded for 30 days.");
});

test("a foreign thread linked to this party, and a home thread linked to a foreign party, do not change either brokerage's recency", async () => {
  const home = await getGrowTodaySummary(homeId);
  const bad = home.priorityActions.find((action) => action.partyId === badRowId);
  assert.equal(bad?.reason, "No contact recorded yet.");
  assert.equal(
    home.priorityActions.find((action) => action.partyId === foreignPartyId),
    undefined,
    "the foreign party is not a home contact",
  );

  const foreign = await getGrowTodaySummary(foreignId);
  const foreignCard = foreign.priorityActions.find((action) => action.partyId === foreignPartyId);
  assert.ok(foreignCard, "the foreign brokerage's own contact must still be cold");
  assert.equal(foreignCard.reason, "No contact recorded yet.");
  assert.equal(
    foreign.priorityActions.find((action) => action.partyId === badRowId),
    undefined,
    "the home party must not appear on the foreign Today",
  );
});

test("coach activity counts include qualifying messages and exclude the rest, including the bad rows", async () => {
  const period = periodCoveringYesterday();
  const rows = await fetchActivityRows(homeId, period);
  const metric = computeActivityConsistency(rows, period);

  assert.equal(metric.totalActivities, 4);
  assert.deepEqual(metric.activitiesByType, { email: 2, sms: 1, call: 1 });

  const foreignRows = await fetchActivityRows(foreignId, period);
  assert.equal(computeActivityConsistency(foreignRows, period).totalActivities, 0);
});

test("the coach activity read filters the thread and the party by brokerage", async () => {
  const statements: string[] = [];
  const uninstall = setDbQueryObserver((query) => statements.push(query));
  try {
    await fetchActivityRows(homeId, periodCoveringYesterday());
  } finally {
    uninstall();
  }

  const comms = statements.filter((query) => /from\s+"?communication_messages"?/i.test(query));
  assert.equal(comms.length, 1, `expected one Hub read; got ${statements.join("\n---\n")}`);
  const query = comms[0];
  assert.match(query, /communication_threads/i);
  assert.match(query, /communication_participants/i);
  assert.match(query, /"parties"/i);
  assert.match(query, /"communication_threads"\."brokerage_id"/i);
  assert.match(query, /"parties"\."brokerage_id"/i);
  assert.match(query, /"communication_messages"\."brokerage_id"/i);
  assert.doesNotMatch(query, /grow_activities/i);
});

function periodCoveringYesterday(): ResolvedPeriod {
  return {
    key: "custom",
    label: "c6",
    start: new Date(Date.now() - 3 * DAY),
    end: new Date(Date.now() + 60_000),
    isComplete: true,
    durationDays: 3,
    timeZone: "Australia/Brisbane",
    timeZoneSource: "fallback",
  };
}

async function insertContact(brokerageId: number, firstName: string): Promise<number> {
  const [party] = await db
    .insert(parties)
    .values({ brokerageId, firstName, lastName: "C6" })
    .returning({ id: parties.id });
  await db.insert(growRelationships).values({
    brokerageId,
    partyId: party.id,
    relationshipType: "owner",
    status: "Active",
  });
  return party.id;
}

async function insertMessage(input: {
  threadBrokerageId: number;
  messageBrokerageId: number;
  partyId: number;
  channel: "EMAIL" | "SMS" | "PHONE_CALL";
  direction: "OUTBOUND" | "INBOUND";
  status: string;
  createdAt: Date;
  sentAt?: Date;
  deliveredAt?: Date;
  failedAt?: Date;
  withParticipant: boolean;
}): Promise<void> {
  const [thread] = await db
    .insert(communicationThreads)
    .values({
      brokerageId: input.threadBrokerageId,
      partyId: input.partyId,
      subject: `${input.channel} ${input.status}`,
    })
    .returning({ id: communicationThreads.id });
  if (input.withParticipant) {
    await db.insert(communicationParticipants).values({
      threadId: thread.id,
      brokerageId: input.threadBrokerageId,
      partyId: input.partyId,
      role: "Seller",
      displayName: input.channel,
      email: "c6@example.com",
    });
  }
  await db.insert(communicationMessages).values({
    threadId: thread.id,
    brokerageId: input.messageBrokerageId,
    partyId: input.partyId,
    direction: input.direction,
    channel: input.channel,
    classification: "TRANSACTIONAL",
    status: input.status,
    bodyText: `${input.channel} ${input.status}`,
    sentAt: input.sentAt ?? null,
    deliveredAt: input.deliveredAt ?? null,
    failedAt: input.failedAt ?? null,
    createdAt: input.createdAt,
  });
}

function constraintViolation(err: unknown, constraint: string): boolean {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof Error) parts.push(current.message);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") parts.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  const text = parts.join(" ");
  return text.includes(constraint) || text.includes("23503");
}
