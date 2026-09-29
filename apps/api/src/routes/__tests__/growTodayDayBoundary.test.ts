// UAT-TZ — Grow Today buckets Open commitments on the brokerage's local day.
// Pacific/Auckland is far enough ahead of UTC that just after local midnight
// is still the previous UTC day. Null and invalid stored zones fall back to
// Australia/Brisbane. The read does not create a settings row.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, brokerages, users, parties, growCommitments, communicationSettings } from "@aee/db";
import { getGrowTodaySummary, type GrowTodayAction } from "../../lib/growToday.js";
import { DEFAULT_TIME_ZONE, isOverdueLocal, isToday, startOfLocalDay } from "../../lib/commandCentre/timezone.js";
import { cleanupBrokerages } from "./testSupport.js";

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
});

async function seed(
  timeZone: string | null | undefined,
  commitments: { description: string; dueAt: Date }[],
): Promise<{ brokerageId: number; ids: number[] }> {
  const suffix = randomUUID();
  const [brokerage] = await db.insert(brokerages).values({ name: `TZ Grow ${suffix}` }).returning({ id: brokerages.id });
  const [user] = await db
    .insert(users)
    .values({
      brokerageId: brokerage.id,
      email: `tz-grow-${suffix}@example.test`,
      authProviderId: `tz-grow-${suffix}`,
      firstName: "Casey",
      lastName: "Zone",
      role: "Agent",
    })
    .returning({ id: users.id });
  const [party] = await db
    .insert(parties)
    .values({ brokerageId: brokerage.id, firstName: "Casey", lastName: "Committed" })
    .returning({ id: parties.id });
  if (timeZone !== undefined) {
    await db.insert(communicationSettings).values({ brokerageId: brokerage.id, timeZone });
  }
  const ids: number[] = [];
  for (const commitment of commitments) {
    const [row] = await db
      .insert(growCommitments)
      .values({
        brokerageId: brokerage.id,
        partyId: party.id,
        description: commitment.description,
        dueAt: commitment.dueAt,
        status: "Open",
        createdBy: user.id,
      })
      .returning({ id: growCommitments.id });
    ids.push(row.id);
  }
  return { brokerageId: brokerage.id, ids };
}

function card(actions: GrowTodayAction[], id: number): GrowTodayAction | undefined {
  return actions.find((action) => action.id === `commitment:${id}`);
}

// 15 July 2026, mid-afternoon in both Auckland (NZST, UTC+12) and Brisbane
// (UTC+10). Pinned so "just after Auckland midnight" is unambiguously the
// previous Brisbane day. A wall-clock `now` is not: for the two or three
// hours after Auckland midnight and before Brisbane midnight, that instant
// is already today in Brisbane too.
const WINTER_NOW = new Date("2026-07-15T02:00:00.000Z");

test("Pacific/Auckland files a commitment just after local midnight as due today, and one from before local midnight stays overdue", async () => {
  const now = WINTER_NOW;
  const start = startOfLocalDay(now, "Pacific/Auckland");
  const justAfter = new Date(start.getTime() + 60 * 1000);
  const justBefore = new Date(start.getTime() - 1);
  const future = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  assert.equal(isToday(justAfter, now, "Pacific/Auckland"), true);
  assert.equal(isOverdueLocal(justAfter, now, DEFAULT_TIME_ZONE), true, "Auckland midnight is still the previous Brisbane day");

  const seeded = await seed("Pacific/Auckland", [
    { description: "Just after local midnight", dueAt: justAfter },
    { description: "Before local midnight", dueAt: justBefore },
    { description: "Three days out", dueAt: future },
  ]);
  try {
    const summary = await getGrowTodaySummary(seeded.brokerageId, { now });
    const after = card(summary.priorityActions, seeded.ids[0]);
    const before = card(summary.priorityActions, seeded.ids[1]);
    assert.ok(after, "a commitment just after local midnight is on Today");
    assert.equal(after.priority, "DoToday");
    assert.equal(after.type, "commitment");
    assert.ok(before, "an Open commitment from before today's local start is still listed");
    assert.equal(before.priority, "DoNow");
    assert.equal(card(summary.priorityActions, seeded.ids[2]), undefined);
  } finally {
    await cleanupBrokerages([seeded.brokerageId]);
  }
});

test("a missing row, a null zone, and an invalid zone fall back to Brisbane and do not create a settings row", async () => {
  const now = WINTER_NOW;
  const brisbaneStart = startOfLocalDay(now, DEFAULT_TIME_ZONE);
  const justAfterBrisbane = new Date(brisbaneStart.getTime() + 60 * 1000);
  const justBeforeBrisbane = new Date(brisbaneStart.getTime() - 1);
  const aucklandStart = startOfLocalDay(now, "Pacific/Auckland");
  const justAfterAuckland = new Date(aucklandStart.getTime() + 60 * 1000);

  async function expectBrisbane(timeZone: string | null | undefined) {
    const seeded = await seed(timeZone, [
      { description: "Just after Brisbane midnight", dueAt: justAfterBrisbane },
      { description: "Before Brisbane midnight", dueAt: justBeforeBrisbane },
      { description: "Just after Auckland midnight", dueAt: justAfterAuckland },
    ]);
    try {
      const summary = await getGrowTodaySummary(seeded.brokerageId, { now });
      const afterBrisbane = card(summary.priorityActions, seeded.ids[0]);
      const beforeBrisbane = card(summary.priorityActions, seeded.ids[1]);
      const afterAuckland = card(summary.priorityActions, seeded.ids[2]);
      assert.ok(afterBrisbane);
      assert.equal(afterBrisbane.priority, "DoToday");
      assert.ok(beforeBrisbane, "carry-forward: due before Brisbane midnight stays listed");
      assert.equal(beforeBrisbane.priority, "DoNow");
      assert.ok(afterAuckland);
      assert.equal(afterAuckland.priority, "DoNow", "Auckland midnight is still yesterday in Brisbane");
      if (timeZone === undefined) {
        const rows = await db
          .select({ id: communicationSettings.id })
          .from(communicationSettings)
          .where(eq(communicationSettings.brokerageId, seeded.brokerageId));
        assert.equal(rows.length, 0);
      }
    } finally {
      await cleanupBrokerages([seeded.brokerageId]);
    }
  }

  await expectBrisbane(undefined);
  await expectBrisbane(null);
  await expectBrisbane("Not/ARealZone");
});

test("Australia/Sydney DST: the spring-forward next morning is not today, and the fall-back day's last hour still is", async () => {
  const springNow = new Date("2026-10-03T16:30:00.000Z");
  const spring = await seed("Australia/Sydney", [
    { description: "Just after the transition day's midnight", dueAt: new Date("2026-10-03T14:01:00.000Z") },
    { description: "Before the transition day's midnight", dueAt: new Date("2026-10-03T13:59:00.000Z") },
    { description: "Half past midnight the next local day", dueAt: new Date("2026-10-04T13:30:00.000Z") },
  ]);
  const fallNow = new Date("2026-04-04T16:30:00.000Z");
  const fall = await seed("Australia/Sydney", [
    { description: "23:30 on the 25-hour day", dueAt: new Date("2026-04-05T13:30:00.000Z") },
    { description: "Before that day's midnight", dueAt: new Date("2026-04-04T12:59:00.000Z") },
  ]);
  try {
    const springSummary = await getGrowTodaySummary(spring.brokerageId, { now: springNow });
    const springAfter = card(springSummary.priorityActions, spring.ids[0]);
    const springBefore = card(springSummary.priorityActions, spring.ids[1]);
    assert.ok(springAfter);
    assert.equal(springAfter.priority, "DoToday");
    assert.ok(springBefore);
    assert.equal(springBefore.priority, "DoNow");
    assert.equal(card(springSummary.priorityActions, spring.ids[2]), undefined);

    const fallSummary = await getGrowTodaySummary(fall.brokerageId, { now: fallNow });
    const late = card(fallSummary.priorityActions, fall.ids[0]);
    const before = card(fallSummary.priorityActions, fall.ids[1]);
    assert.ok(late, "the last hour of the fall-back day is still today");
    assert.equal(late.priority, "DoToday");
    assert.ok(before);
    assert.equal(before.priority, "DoNow");
  } finally {
    await cleanupBrokerages([spring.brokerageId, fall.brokerageId]);
  }
});
