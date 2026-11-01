import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMinimalTodayModel } from "../../minimal/minimalTodayModel";
import { buildMobileTodayLayout, initialsOf, type MobileTodayExtras } from "../../minimal/mobile/mobileTodayLayout";
import { MOBILE_MARKET_HREF, MOBILE_MOMENTUM_HREF, TODAY_SIGNAL_LIMIT, TODAY_VISIBLE_ROWS } from "../../minimal/mobile/mobileTodayConfig";
import type { GrowTodayAction, GrowTodaySummary } from "../growToday";

// AE Mobile (CC Task #64, M3): the phone Today layout, built from the REAL buildMinimalTodayModel,
// so these tests exercise the existing Today data (GET /grow/today), commitments included.

const NOW = new Date("2026-11-02T09:00:00Z");
const OVERDUE = "2026-10-30T00:00:00Z";
const LATER_TODAY = "2026-11-02T14:00:00Z";
const NO_EXTRAS: MobileTodayExtras = { momentum: null, market: null, askAeAvailable: false };

function action(o: Partial<GrowTodayAction> = {}): GrowTodayAction {
  return {
    id: "a1", type: "opportunity_follow_up", priority: "DoNow", partyId: 1, contactName: "Maya Okafor", contactEmail: null, contactMobile: null,
    relationshipType: null, propertyId: null, propertyLabel: null, opportunityId: null, appraisalId: null, commitmentId: null, reason: "", recommendedAction: "",
    dueAt: null, lastActivityAt: null, availableActions: [{ action: "view_contact", partyId: o.partyId ?? 1 }], rankScore: 50, confidenceBand: null,
    contactability: "contactable", contactabilityNote: null, whyItMatters: null, ...o,
  };
}
function summary(actions: GrowTodayAction[], o: Partial<GrowTodaySummary> = {}): GrowTodaySummary {
  return {
    generatedAt: "2026-11-02T07:00:00Z", hasAnyGrowData: true,
    counts: { priorityActions: actions.length, followUpsDue: 0, openOpportunities: 0, contactsNeedingAttention: 0 },
    priorityActions: actions, signalSummary: { surfaced: 0, emergingSurfaced: 0, emergingWithheld: 0, withheldDoNotContact: 0 }, ...o,
  };
}
const layoutOf = (s: GrowTodaySummary, extras = NO_EXTRAS, expanded = false, entitlements: string[] = []) =>
  buildMobileTodayLayout(buildMinimalTodayModel(s, NOW, (k) => entitlements.includes(k)), extras, expanded);
const person = (id: number, name: string, o: Partial<GrowTodayAction> = {}) =>
  action({ id: `p${id}`, partyId: id, contactName: name, availableActions: [{ action: "view_contact", partyId: id }], ...o });

test("state: no data, caught up, ready", () => {
  assert.equal(layoutOf(summary([], { hasAnyGrowData: false })).state, "no-data");
  assert.equal(layoutOf(summary([])).state, "caught-up");
  assert.equal(layoutOf(summary([person(1, "Maya Okafor")])).state, "ready");
  assert.equal(layoutOf(summary([])).hero, null);
});

test("the next action says what to do once", () => {
  const dup = layoutOf(summary([person(1, "Maya Okafor", { recommendedAction: "Call about the appraisal", reason: "Call about the appraisal", whyItMatters: { headline: "She opened the appraisal twice", talkingPoint: null, caution: "", confidenceBand: null, confidenceBandLabel: null, factors: [] } })]));
  assert.equal(dup.hero?.action, "Call about the appraisal");
  assert.equal(dup.hero?.reason, null, "a reason that repeats the action is dropped");
  assert.deepEqual(dup.hero?.why, [{ label: "Why it matters", text: "She opened the appraisal twice" }]);
  const distinct = layoutOf(summary([person(1, "Maya", { recommendedAction: "Call her", reason: "No contact for 12 days" })]));
  assert.equal(distinct.hero?.reason, "No contact for 12 days");
  const reasonOnly = layoutOf(summary([person(1, "Maya", { recommendedAction: "", reason: "Appraisal sent Tuesday" })]));
  assert.equal(reasonOnly.hero?.action, "Appraisal sent Tuesday");
  assert.equal(reasonOnly.hero?.reason, null);
  assert.equal(layoutOf(summary([person(1, "Maya", { recommendedAction: "", reason: "" })])).hero?.action, "Review this record");
});

test("the hero keeps the ranking line and a no-contact note behind Why this, and a consent warning visible", () => {
  const why = { headline: "Likely selling", talkingPoint: null, caution: "", confidenceBand: "likely", confidenceBandLabel: "Likely", factors: [] };
  const l = layoutOf(summary([action({ id: "s1", type: "property_intelligence_signal", partyId: null, contactName: "", availableActions: [], whyItMatters: why, rankScore: 72, recommendedAction: "Review the property" }), person(2, "Tom")]));
  assert.equal(l.hero?.why.some((w) => w.label === "Ranking"), true);
  assert.equal(l.hero?.notes.length, 1, "unlinked-contact note");
  assert.equal(l.hero?.href, null);
  const blocked = layoutOf(summary([person(1, "Maya", { contactability: "do_not_contact", contactabilityNote: "Must not be contacted." })]));
  assert.equal(blocked.hero?.warning, "Must not be contacted.");
});

test("commitments appear as actionable priorities, overdue first, in the product's own words", () => {
  const l = layoutOf(summary([
    person(1, "Maya Okafor", { recommendedAction: "Call about the appraisal", dueAt: OVERDUE }),
    person(2, "Daniel Reyes", { id: "c-today", type: "commitment", commitmentId: 9, recommendedAction: "Send comparable sales", dueAt: LATER_TODAY }),
    person(3, "Olivia Brandt", { id: "c-over", type: "commitment", commitmentId: 8, recommendedAction: "Send the market update", dueAt: OVERDUE }),
    person(4, "Tom Hargreaves", { recommendedAction: "Check in", dueAt: LATER_TODAY }),
  ]));
  assert.deepEqual(l.groups.map((g) => g.key), ["overdue", "today"]);
  const overdue = l.groups[0].rows;
  assert.deepEqual(overdue.map((r) => r.id), ["c-over"]);
  assert.equal(overdue[0].kind, "Commitment");
  assert.equal(overdue[0].action, "Send the market update");
  assert.equal(overdue[0].when, "Overdue");
  assert.equal(overdue[0].href, "/grow/contacts/3");
  assert.equal(overdue[0].actionLabel, "Open contact");
  const today = l.groups[1].rows;
  assert.deepEqual(today.map((r) => r.id), ["c-today", "p4"], "server order kept inside a group");
  assert.equal(today[0].kind, "Commitment");
  assert.equal(today[0].overdue, false);
  assert.equal(today[1].kind, "Due follow-up");
});

test("overdue rows come first whatever order the server sent them in", () => {
  const l = layoutOf(summary([
    person(1, "Hero"),
    person(2, "Later A", { dueAt: LATER_TODAY }),
    person(3, "Over A", { dueAt: OVERDUE }),
    person(4, "Later B", { dueAt: LATER_TODAY }),
    person(5, "Over B", { dueAt: OVERDUE }),
  ]));
  assert.deepEqual(l.groups.map((g) => g.rows.map((r) => r.name)), [["Over A", "Over B"], ["Later A", "Later B"]]);
});

test("Coming up is merged into the one list, not shown a second time", () => {
  const l = layoutOf(summary([
    person(1, "Hero"),
    person(2, "Priya Nair", { id: "ap", type: "appraisal_follow_up", appraisalId: 31, recommendedAction: "Appraisal appointment", dueAt: LATER_TODAY, availableActions: [{ action: "view_contact", partyId: 2 }, { action: "view_appraisal", appraisalId: 31 }] }),
    person(3, "Daniel", { dueAt: LATER_TODAY }),
  ]));
  const rows = l.groups.flatMap((g) => g.rows);
  assert.deepEqual(rows.map((r) => r.id), ["p3", "ap"], "the appraisal follow-up joins the list");
  const ap = rows.find((r) => r.id === "ap")!;
  assert.equal(ap.kind, "Due follow-up");
  assert.match(ap.href ?? "", /\/31$/, "opens the appraisal, as the desktop does");
  assert.equal(ap.actionLabel, "Open appraisal");
});

test("nothing is shown twice: every action appears exactly once across the hero, list and signals", () => {
  const actions = [
    person(1, "Hero", { dueAt: OVERDUE }),
    person(2, "A", { dueAt: OVERDUE }), person(3, "B", { dueAt: LATER_TODAY }),
    person(4, "C", { id: "ap", type: "appraisal_follow_up", appraisalId: 4, dueAt: LATER_TODAY }),
    action({ id: "sig", type: "property_intelligence_signal", partyId: null, contactName: "7 Main St", availableActions: [] }),
    person(5, "D"), person(6, "E"), person(7, "F"), person(8, "G"),
  ];
  const l = layoutOf(summary(actions), NO_EXTRAS, true);
  const ids = [l.hero?.id, ...l.groups.flatMap((g) => g.rows.map((r) => r.id)), ...l.signals.map((r) => r.id)];
  assert.equal(new Set(ids).size, ids.length, "no repeats");
  assert.deepEqual([...ids].sort(), actions.map((a) => a.id).sort(), "none lost");
});

test("dropped on a phone: the counts, the queue line, the agenda summary and the Run cross-link", () => {
  const l = layoutOf(summary([person(1, "Hero"), person(2, "A")]), NO_EXTRAS, false, ["run.access"]);
  const keys = Object.keys(l);
  for (const gone of ["counts", "queueLabel", "agendaSummary", "runCrossLink"]) assert.equal(keys.includes(gone), false, gone);
  assert.doesNotMatch(JSON.stringify(l), /priority actions|Property delivery|Due follow-ups & commitments|Open opportunities/);
});

test("the list shows five rows, then Show all; expanded shows every row; the order never changes", () => {
  const eight = Array.from({ length: 8 }, (_, i) => person(i + 2, `P${i + 2}`, { dueAt: i === 6 ? OVERDUE : LATER_TODAY }));
  const actions = [person(1, "Hero"), ...eight];
  const shown = layoutOf(summary(actions));
  assert.equal(TODAY_VISIBLE_ROWS, 5);
  assert.equal(shown.totalRows, 8);
  assert.equal(shown.hiddenCount, 3);
  assert.equal(shown.groups.flatMap((g) => g.rows).length, 5);
  assert.equal(shown.groups[0].key, "overdue", "an overdue row stays visible even though it was seventh");
  const all = layoutOf(summary(actions), NO_EXTRAS, true);
  assert.equal(all.hiddenCount, 0);
  assert.equal(all.groups.flatMap((g) => g.rows).length, 8);
  assert.equal(layoutOf(summary([person(1, "Hero"), person(2, "A")])).hiddenCount, 0);
});

test("a property link needs Run, exactly as on desktop: without it the row has no link", () => {
  const propertyOnly = (id: string) => action({ id, partyId: null, contactName: "7 Main St", propertyId: 5, availableActions: [{ action: "view_property", propertyId: 5 }] });
  const s = summary([person(1, "Hero"), propertyOnly("pp")]);
  const without = layoutOf(s).groups.flatMap((g) => g.rows)[0];
  assert.equal(without.href, null);
  assert.equal(without.actionLabel, null);
  const withRun = layoutOf(s, NO_EXTRAS, false, ["run.access"]).groups.flatMap((g) => g.rows)[0];
  assert.equal(withRun.href, "/properties/5");
});

test("signals: at most three, kept out of the list, with the server's withholding note", () => {
  const sig = (n: number) => action({ id: `sig${n}`, type: "property_intelligence_signal", partyId: null, contactName: `${n} Main St`, availableActions: [] });
  const l = layoutOf(summary([person(1, "Hero"), sig(1), sig(2), sig(3), sig(4), person(2, "A")], { signalSummary: { surfaced: 4, emergingSurfaced: 0, emergingWithheld: 2, withheldDoNotContact: 0 } }));
  assert.equal(TODAY_SIGNAL_LIMIT, 3);
  assert.equal(l.signals.length, 3);
  assert.equal(l.groups.flatMap((g) => g.rows).some((r) => r.id.startsWith("sig")), false);
  assert.match(l.signalsNote ?? "", /held back/);
  assert.equal(layoutOf(summary([person(1, "Hero")])).signalsNote, null);
});

test("shortcuts: My Momentum and Market Activity when their data arrived, Ask AE only when verified", () => {
  const s = summary([person(1, "Hero")]);
  assert.deepEqual(layoutOf(s).shortcuts, []);
  const full = layoutOf(s, { momentum: { score: 64, changeLabel: "+12 on last week", milestoneLabel: "36 pts to 100", unavailableCount: 2 }, market: { total: 9, lines: [] }, askAeAvailable: true });
  assert.deepEqual(full.shortcuts.map((x) => x.key), ["momentum", "ask-ae", "market"]);
  assert.deepEqual(full.shortcuts[0], { key: "momentum", label: "My Momentum", subtitle: "64 pts this week · +12 on last week", href: MOBILE_MOMENTUM_HREF });
  assert.equal(full.shortcuts[1].href, "/grow?tab=askAE");
  assert.deepEqual(full.shortcuts[2], { key: "market", label: "Market Activity", subtitle: "9 this week", href: MOBILE_MARKET_HREF });
  const noAsk = layoutOf(s, { momentum: { score: 3, changeLabel: "", milestoneLabel: "", unavailableCount: 0 }, market: null, askAeAvailable: false });
  assert.deepEqual(noAsk.shortcuts.map((x) => x.key), ["momentum"]);
  assert.equal(noAsk.shortcuts[0].subtitle, "3 pts this week", "no dangling separator");
});

test("getting-started steps pass through unchanged", () => {
  const s = summary([], { firstRun: { contact: true, propertyLink: false, activity: true, commitment: true, opportunity: true, appraisal: true } });
  const l = layoutOf(s, NO_EXTRAS, false, ["grow.properties.link", "grow.relationships.manage"]);
  assert.deepEqual(l.setupSteps.map((x) => x.id), ["propertyLink"]);
});

test("pure: a frozen model is not changed", () => {
  const model = buildMinimalTodayModel(summary([person(1, "Hero"), person(2, "A", { dueAt: OVERDUE }), person(3, "B")]), NOW);
  const frozen = JSON.parse(JSON.stringify(model));
  const deepFreeze = (v: unknown): unknown => { if (v && typeof v === "object") { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };
  deepFreeze(model);
  assert.doesNotThrow(() => buildMobileTodayLayout(model, NO_EXTRAS, true));
  assert.deepEqual(model, frozen);
});

test("initials", () => {
  assert.equal(initialsOf("Maya Okafor"), "MO");
  assert.equal(initialsOf("  daniel   reyes  "), "DR");
  assert.equal(initialsOf("Harbourside Property Group"), "HP");
  assert.equal(initialsOf("Cher"), "C");
  assert.equal(initialsOf(""), "?");
});
