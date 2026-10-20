import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { GrowTodayAction, GrowTodaySummary } from "../growToday";
import { buildMinimalTodayModel, minimalTodayDestination } from "../../minimal/minimalTodayModel";

const NOW = new Date("2026-10-14T01:00:00.000Z");

function action(overrides: Partial<GrowTodayAction> = {}): GrowTodayAction {
  return {
    id: "commitment:1",
    type: "commitment",
    priority: "DoNow",
    partyId: 9,
    contactName: "Ada Allow",
    contactEmail: "ada@example.com",
    contactMobile: "+61400000001",
    relationshipType: null,
    propertyId: 3,
    propertyLabel: "18 Campbell St",
    opportunityId: null,
    appraisalId: null,
    commitmentId: 4,
    reason: "A price guide was promised.",
    recommendedAction: "Deliver the price guide.",
    dueAt: "2026-10-13T00:00:00.000Z",
    lastActivityAt: null,
    availableActions: [
      { action: "ask_ae" },
      { action: "email", partyId: 9 },
      { action: "sms", partyId: 9 },
      { action: "view_contact", partyId: 9 },
    ],
    rankScore: 10,
    confidenceBand: null,
    contactability: "contactable",
    contactabilityNote: null,
    whyItMatters: {
      headline: "Keep a recorded commitment",
      talkingPoint: null,
      caution: "This is a date, not a prediction.",
      confidenceBand: null,
      confidenceBandLabel: null,
      factors: [],
    },
    ...overrides,
  };
}

function summary(actions: GrowTodayAction[], overrides: Partial<GrowTodaySummary> = {}): GrowTodaySummary {
  return {
    generatedAt: "2026-10-14T00:30:00.000Z",
    hasAnyGrowData: true,
    counts: {
      priorityActions: actions.length,
      followUpsDue: 2,
      openOpportunities: 1,
      contactsNeedingAttention: 4,
    },
    priorityActions: actions,
    signalSummary: {
      surfaced: 0,
      emergingSurfaced: 0,
      emergingWithheld: 0,
      withheldDoNotContact: 0,
    },
    ...overrides,
  };
}

test("the hero is the first ranked action and channel buttons are not navigation", () => {
  const model = buildMinimalTodayModel(summary([action()]), NOW);
  assert.equal(model.hero?.title, "Ada Allow");
  assert.equal(model.hero?.whyItMatters, "Keep a recorded commitment");
  assert.equal(model.hero?.nextStep, "Deliver the price guide.");
  assert.equal(model.hero?.reason, "A price guide was promised.");
  assert.equal(model.hero?.destination?.href, "/grow/contacts/9");
  assert.equal(model.hero?.destination?.href.includes("compose="), false);
  assert.equal(model.hero?.overdue, true);
  assert.equal(model.queueLabel, "1 priority action");
  assert.equal(minimalTodayDestination(action({ availableActions: [{ action: "email", partyId: 9 }, { action: "sms", partyId: 9 }, { action: "ask_ae" }] })), null);
});

test("later cards split into the day list, signals, and the next appraisal", () => {
  const followUp = action({
    id: "appraisal:2",
    type: "appraisal_follow_up",
    priority: "DoToday",
    contactName: "Bea Other",
    dueAt: "2026-10-20T00:00:00.000Z",
    appraisalId: 15,
    availableActions: [{ action: "view_appraisal", appraisalId: 15 }, { action: "view_contact", partyId: 9 }],
    whyItMatters: null,
    recommendedAction: "Prepare the appointment.",
  });
  const signal = action({
    id: "signal:3",
    type: "property_intelligence_signal",
    contactName: "Cy Signal",
    dueAt: null,
    availableActions: [{ action: "view_property", propertyId: 3 }],
  });
  const model = buildMinimalTodayModel(summary([action(), followUp, signal]), NOW);
  assert.equal(model.queueLabel, "1 of 3 priority actions");
  assert.deepEqual(model.alsoOnYourDay.map((item) => item.id), []);
  assert.equal(model.comingUp?.id, "appraisal:2");
  assert.equal(model.comingUp?.destination?.href, "/grow/appraisals/15");
  assert.equal(model.comingUp?.overdue, false);
  assert.deepEqual(model.signals.map((item) => item.id), ["signal:3"]);
  assert.equal(model.counts[0]?.value, 3);
  assert.equal(model.counts[1]?.label, "Due follow-ups & commitments");
  assert.equal("momentum" in model, false);
  assert.equal(JSON.stringify(model).includes("±4%"), false);
  assert.equal(JSON.stringify(model).includes("My Momentum"), false);
});

test("an empty day stays empty and a brokerage with no Grow data is named as such", () => {
  const caughtUp = buildMinimalTodayModel(summary([]), NOW);
  assert.equal(caughtUp.hero, null);
  assert.equal(caughtUp.caughtUp, true);
  assert.equal(caughtUp.noGrowData, false);
  const fresh = buildMinimalTodayModel(summary([], { hasAnyGrowData: false }), NOW);
  assert.equal(fresh.noGrowData, true);
  assert.equal(fresh.caughtUp, false);
});

test("getting started only links the existing import route", () => {
  const model = buildMinimalTodayModel(
    summary([], {
      hasAnyGrowData: true,
      firstRun: { contact: false, propertyLink: false, activity: true, commitment: true, opportunity: true, appraisal: true },
    }),
    NOW,
    (key) => key === "grow.import.execute" || key === "grow.contacts.manage",
  );
  const contact = model.setupSteps.find((step) => step.id === "contact");
  const link = model.setupSteps.find((step) => step.id === "propertyLink");
  assert.equal(contact?.href, "/grow/import");
  assert.equal(link?.href, null);
  assert.equal(model.setupSteps.some((step) => step.href !== null && step.href !== "/grow/import"), false);
});

test("the Today screen is flag-gated and does not render unconnected actions or deferred cards", () => {
  const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
  const screen = readFileSync(new URL("../../minimal/MinimalToday.tsx", import.meta.url), "utf8");
  const model = readFileSync(new URL("../../minimal/minimalTodayModel.ts", import.meta.url), "utf8");
  assert.match(app, /lazy\(\(\) => import\("\.\/minimal\/MinimalToday"\)\)/);
  assert.match(app, /shouldRenderMinimalShell\(useMinimalUx\(\)\)/);
  assert.match(app, /minimalShell \? <MinimalToday \/> : <Grow \/>/);
  assert.match(app, /lazy\(\(\) => import\("\.\/pages\/Grow"\)\)/);
  assert.match(screen, /apiFetch\("\/grow\/today"\)/);
  assert.equal(screen.includes("localStorage"), false);
  for (const banned of ["Start call", "Ask AE", "My Momentum", "Market Activity", "Simulate", "compose=email", "compose=sms"]) {
    assert.equal(screen.includes(banned), false, banned);
    assert.equal(model.includes(banned), false, banned);
  }
});
