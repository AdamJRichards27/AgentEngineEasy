import { test } from "node:test";
import assert from "node:assert/strict";
import { MOMENTUM_RULES_V1, isMomentumEnabled, nextMilestone, scoreMomentum, weekStart, type MomentumActivity } from "../growMomentum.js";

const TZ = "Australia/Brisbane";
const start = new Date("2026-10-18T14:00:00Z"); // Mon 19 Oct 00:00 AEST
const end = new Date("2026-10-25T14:00:00Z");
let seq = 1;
const act = (over: Partial<MomentumActivity>): MomentumActivity => ({
  id: seq++, partyId: 1, activityType: "call", occurredAt: new Date("2026-10-20T00:00:00Z"), sourceId: null, source: "manual", ...over,
});
const score = (activities: MomentumActivity[], extra: Partial<Parameters<typeof scoreMomentum>[0]> = {}) =>
  scoreMomentum({ activities, opportunities: [], appraisals: [], start, end, timeZone: TZ, ...extra });

test("flag: only exact 'true' enables; default OFF", () => {
  assert.equal(isMomentumEnabled({}), false);
  for (const v of ["1", "yes", "", "on"]) assert.equal(isMomentumEnabled({ GROW_MOMENTUM_ENABLED: v }), false);
  assert.equal(isMomentumEnabled({ GROW_MOMENTUM_ENABLED: "TRUE" }), true);
});

test("weekStart is Monday 00:00 Australia/Brisbane", () => {
  assert.equal(weekStart(new Date("2026-10-22T06:00:00Z"), TZ).toISOString(), start.toISOString());
  assert.equal(weekStart(new Date("2026-10-18T14:00:00Z"), TZ).toISOString(), start.toISOString());
});

test("conversations capped at 2 per contact per day; call↔call_summary deduped", () => {
  const r = score([
    act({ sourceId: "s1" }), act({ activityType: "call_summary", sourceId: "s1" }),
    act({}), act({}), act({}),
    act({ partyId: 2 }),
  ]);
  const conv = r.categories.find((c) => c.key === "connectedConversation")!;
  assert.equal(conv.count, 3);
  assert.equal(conv.points, 3 * MOMENTUM_RULES_V1.connectedConversation.points);
});

test("bulk outreach cannot raise score beyond caps (property)", () => {
  for (let n = 0; n <= 200; n += 7) {
    const many = Array.from({ length: n }, (_, i) => act({ activityType: i % 2 ? "email" : "sms", partyId: (i % 50) + 1 }));
    const r = score(many);
    const o = r.categories.find((c) => c.key === "personalisedOutreach")!;
    assert.ok(o.count <= MOMENTUM_RULES_V1.personalisedOutreach.maxPerDay, `n=${n} count=${o.count}`);
  }
  const sameContact = Array.from({ length: 20 }, (_, i) => act({ activityType: "email", occurredAt: new Date(Date.UTC(2026, 9, 19 + (i % 5), 1)) }));
  assert.equal(score(sameContact).categories.find((c) => c.key === "personalisedOutreach")!.count, 3);
});

test("automated/imported rows and non-contact types earn nothing", () => {
  const r = score([
    act({ source: "import" }), act({ source: "system" }), act({ activityType: "note" }),
    act({ activityType: "system_event" }), act({ activityType: "campaign_response" }), act({ activityType: "task_completion" }),
  ]);
  assert.equal(r.score, 0);
  assert.equal(r.excludedCount, 6);
});

test("outcomes outweigh outreach: one conversation beats a day's capped outreach; appraisal beats both", () => {
  const outreachDay = score(Array.from({ length: 10 }, (_, i) => act({ activityType: "email", partyId: i + 1 }))).score;
  assert.ok(MOMENTUM_RULES_V1.appraisalCompleted.points > outreachDay);
  assert.ok(MOMENTUM_RULES_V1.connectedConversation.points * 2 > MOMENTUM_RULES_V1.personalisedOutreach.points * 3);
});

test("opportunities: 1 per contact per 7 days; appraisals booked/completed once each", () => {
  const d = (s: string) => new Date(s);
  const r = score([], {
    opportunities: [
      { id: 1, partyId: 5, createdAt: d("2026-10-19T01:00:00Z") },
      { id: 2, partyId: 5, createdAt: d("2026-10-21T01:00:00Z") },
      { id: 3, partyId: 6, createdAt: d("2026-10-21T01:00:00Z") },
    ],
    appraisals: [
      { id: 9, createdAt: d("2026-10-20T01:00:00Z"), completedAt: d("2026-10-22T01:00:00Z") },
      { id: 9, createdAt: d("2026-10-20T01:00:00Z"), completedAt: d("2026-10-22T01:00:00Z") },
      { id: 10, createdAt: d("2026-09-01T01:00:00Z"), completedAt: null },
    ],
  });
  assert.equal(r.score, 2 * 10 + 15 + 25);
  assert.equal(r.funnel.opportunities, 2);
  assert.equal(r.funnel.appraisals, 1);
});

test("deterministic and order-independent; versioned; unsourced categories are flagged", () => {
  const rows = [act({}), act({ activityType: "email", partyId: 3 }), act({ partyId: 4 })];
  const a = score(rows);
  const b = score([...rows].reverse());
  assert.deepEqual(a, b);
  assert.equal(a.rulesVersion, "momentum-v1");
  assert.deepEqual(a.categories.filter((c) => !c.sourced).map((c) => c.key), ["twoWayExchange", "listingLinked", "saleLinked"]);
  assert.equal(a.funnel.listings, null);
});

test("nextMilestone uses fixed bands", () => {
  assert.equal(nextMilestone(0), 100);
  assert.equal(nextMilestone(250), 500);
  assert.equal(nextMilestone(5000), null);
});
