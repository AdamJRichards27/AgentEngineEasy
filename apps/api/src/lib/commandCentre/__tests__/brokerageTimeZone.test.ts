// UAT-TZ — Command Centre sections follow communication_settings.time_zone.
// A missing or invalid value falls back to Australia/Brisbane. The read does
// not create a settings row. An invalid stored value is one debug log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, brokerages, users, properties, launchPlans, campaignItems, communicationSettings } from "@aee/db";
import { getCommandCentre, type CommandCentreActor } from "../queries.js";
import { resolveTimeZone } from "../timezone.js";
import type { CommandCentreResponse } from "../types.js";
import { cleanupBrokerages } from "../../../routes/__tests__/testSupport.js";

const AUCKLAND_NOW = new Date("2026-07-15T02:00:00.000Z");
// 00:01 on 15 July in Auckland (NZST, UTC+12). Still 14 July in Brisbane.
const JUST_AFTER_AUCKLAND_MIDNIGHT = new Date("2026-07-14T12:01:00.000Z");
// 00:30 on 16 July in Auckland. 22:30 on 15 July in Brisbane.
const JUST_AFTER_NEXT_AUCKLAND_MIDNIGHT = new Date("2026-07-15T12:30:00.000Z");

async function withCampaignItems(
  timeZone: string | null | undefined,
  now: Date,
  items: { title: string; dueAt: Date }[],
  run: (result: CommandCentreResponse, brokerageId: number) => void | Promise<void>,
): Promise<void> {
  const suffix = randomUUID();
  const [brokerage] = await db.insert(brokerages).values({ name: `TZ CC ${suffix}` }).returning({ id: brokerages.id });
  const [user] = await db
    .insert(users)
    .values({
      brokerageId: brokerage.id,
      email: `tz-cc-${suffix}@example.test`,
      authProviderId: `tz-cc-${suffix}`,
      firstName: "Taylor",
      lastName: "Zone",
      role: "Brokerage Administrator",
    })
    .returning({ id: users.id });
  const [property] = await db
    .insert(properties)
    .values({
      brokerageId: brokerage.id,
      agentId: user.id,
      formattedAddress: `1 Zone St ${suffix}`,
      workflowStage: "Listed",
    })
    .returning({ id: properties.id });
  if (timeZone !== undefined) {
    await db.insert(communicationSettings).values({ brokerageId: brokerage.id, timeZone });
  }
  const [plan] = await db
    .insert(launchPlans)
    .values({
      brokerageId: brokerage.id,
      propertyId: property.id,
      templateType: "STANDARD_PRIVATE_TREATY",
      status: "PLANNING",
      createdBy: user.id,
    })
    .returning({ id: launchPlans.id });
  if (items.length > 0) {
    await db.insert(campaignItems).values(
      items.map((item) => ({
        launchPlanId: plan.id,
        propertyId: property.id,
        brokerageId: brokerage.id,
        itemType: "PHOTOGRAPHY",
        title: item.title,
        status: "TO_ORGANISE",
        dueAt: item.dueAt,
      })),
    );
  }
  const actor: CommandCentreActor = {
    id: user.id,
    role: "Brokerage Administrator",
    brokerageId: brokerage.id,
    firstName: "Taylor",
  };
  try {
    const result = await getCommandCentre(actor, { now, canViewFinancials: false, restrictToPropertyIds: null });
    await run(result, brokerage.id);
  } finally {
    await cleanupBrokerages([brokerage.id]);
  }
}

function titlesIn(result: CommandCentreResponse, section: "today" | "overdue" | "comingUp"): string[] {
  return result[section].map((item) => item.title);
}

test("a stored Pacific/Auckland zone puts just-after-local-midnight on today and the next local day in coming up", async () => {
  await withCampaignItems(
    "Pacific/Auckland",
    AUCKLAND_NOW,
    [
      { title: "Just after Auckland midnight", dueAt: JUST_AFTER_AUCKLAND_MIDNIGHT },
      { title: "Just after the next Auckland midnight", dueAt: JUST_AFTER_NEXT_AUCKLAND_MIDNIGHT },
    ],
    (result) => {
      assert.equal(result.timeZone, "Pacific/Auckland");
      assert.equal(result.timeZoneSource, "brokerage");
      assert.deepEqual(titlesIn(result, "today"), ["Just after Auckland midnight"]);
      assert.deepEqual(titlesIn(result, "comingUp"), ["Just after the next Auckland midnight"]);
      assert.deepEqual(titlesIn(result, "overdue"), []);
    },
  );
});

test("no settings row, a null zone, and an invalid zone all fall back to Brisbane and do not create a row when none exists", async () => {
  const items = [
    { title: "Just after Auckland midnight", dueAt: JUST_AFTER_AUCKLAND_MIDNIGHT },
    { title: "Just after the next Auckland midnight", dueAt: JUST_AFTER_NEXT_AUCKLAND_MIDNIGHT },
  ];
  await withCampaignItems(undefined, AUCKLAND_NOW, items, async (result, brokerageId) => {
    assert.equal(result.timeZone, "Australia/Brisbane");
    assert.equal(result.timeZoneSource, "fallback");
    assert.deepEqual(titlesIn(result, "overdue"), ["Just after Auckland midnight"]);
    assert.deepEqual(titlesIn(result, "today"), ["Just after the next Auckland midnight"]);
    assert.deepEqual(titlesIn(result, "comingUp"), []);
    const rows = await db
      .select({ id: communicationSettings.id })
      .from(communicationSettings)
      .where(eq(communicationSettings.brokerageId, brokerageId));
    assert.equal(rows.length, 0, "resolving the zone must not insert a communication_settings row");
  });

  for (const timeZone of [null, "Not/ARealZone"] as const) {
    await withCampaignItems(timeZone, AUCKLAND_NOW, items, (result) => {
      assert.equal(result.timeZone, "Australia/Brisbane");
      assert.equal(result.timeZoneSource, "fallback");
      assert.deepEqual(titlesIn(result, "overdue"), ["Just after Auckland midnight"]);
      assert.deepEqual(titlesIn(result, "today"), ["Just after the next Auckland midnight"]);
    });
  }
});

test("an invalid stored zone is logged once at debug and does not throw", async () => {
  const suffix = randomUUID();
  const [brokerage] = await db.insert(brokerages).values({ name: `TZ log ${suffix}` }).returning({ id: brokerages.id });
  try {
    await db.insert(communicationSettings).values({ brokerageId: brokerage.id, timeZone: "Not/ARealZone" });
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "debug";
    const lines: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      const resolution = await resolveTimeZone({ brokerageId: brokerage.id });
      assert.equal(resolution.timeZone, "Australia/Brisbane");
      assert.equal(resolution.source, "fallback");
    } finally {
      process.stdout.write = original;
      if (previous === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previous;
    }
    const invalid = lines
      .flatMap((line) => line.split("\n"))
      .filter((line) => line.includes("brokerage_time_zone_invalid"))
      .map((line) => JSON.parse(line) as { level: string; message: string; brokerageId: number });
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0].level, "debug");
    assert.equal(invalid[0].message, "brokerage_time_zone_invalid");
    assert.equal(invalid[0].brokerageId, brokerage.id);
  } finally {
    await cleanupBrokerages([brokerage.id]);
  }
});

test("Australia/Sydney across the spring-forward still files the local day, not a fixed 24h window", async () => {
  const now = new Date("2026-10-03T16:30:00.000Z");
  await withCampaignItems(
    "Australia/Sydney",
    now,
    [
      { title: "Just after Sydney midnight", dueAt: new Date("2026-10-03T14:01:00.000Z") },
      { title: "Before Sydney midnight", dueAt: new Date("2026-10-03T13:59:00.000Z") },
      { title: "Half past midnight the next local day", dueAt: new Date("2026-10-04T13:30:00.000Z") },
    ],
    (result) => {
      assert.equal(result.timeZone, "Australia/Sydney");
      assert.equal(result.timeZoneSource, "brokerage");
      assert.deepEqual(titlesIn(result, "today"), ["Just after Sydney midnight"]);
      assert.deepEqual(titlesIn(result, "overdue"), ["Before Sydney midnight"]);
      assert.deepEqual(titlesIn(result, "comingUp"), ["Half past midnight the next local day"]);
    },
  );
});
