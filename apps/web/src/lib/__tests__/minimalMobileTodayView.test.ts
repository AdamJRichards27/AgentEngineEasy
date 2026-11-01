import { test } from "node:test";
import assert from "node:assert/strict";
import { Link } from "wouter";
import { MobileTodayView, type MobileTodayViewProps } from "../../minimal/mobile/MobileTodayView";
import { MobileSearchBar } from "../../minimal/mobile/MobileSearchBar";
import { buildMinimalTodayModel } from "../../minimal/minimalTodayModel";
import { buildMobileTodayLayout, type MobileTodayExtras } from "../../minimal/mobile/mobileTodayLayout";
import type { GrowTodayAction, GrowTodaySummary } from "../growToday";
import { all, hrefs, links, text } from "./mobileTreeHelpers";

// AE Mobile (CC Task #64, M3): the phone Today screen, as drawn.

const NOW = new Date("2026-11-02T09:00:00Z");
const OVERDUE = "2026-10-30T00:00:00Z";
const LATER = "2026-11-02T14:00:00Z";
const EXTRAS: MobileTodayExtras = { momentum: { score: 64, changeLabel: "+12 on last week", milestoneLabel: "", unavailableCount: 0 }, market: null, askAeAvailable: false };

function action(o: Partial<GrowTodayAction> = {}): GrowTodayAction {
  const partyId = o.partyId === undefined ? 1 : o.partyId;
  return {
    id: "a1", type: "opportunity_follow_up", priority: "DoNow", partyId, contactName: "Maya Okafor", contactEmail: null, contactMobile: null, relationshipType: null,
    propertyId: null, propertyLabel: null, opportunityId: null, appraisalId: null, commitmentId: null, reason: "", recommendedAction: "", dueAt: null, lastActivityAt: null,
    availableActions: partyId === null ? [] : [{ action: "view_contact", partyId }], rankScore: 50, confidenceBand: null, contactability: "contactable", contactabilityNote: null, whyItMatters: null, ...o,
  };
}
const person = (id: number, name: string, o: Partial<GrowTodayAction> = {}) => action({ id: `p${id}`, partyId: id, contactName: name, ...o });
function summary(actions: GrowTodayAction[], o: Partial<GrowTodaySummary> = {}): GrowTodaySummary {
  return { generatedAt: "2026-11-02T07:00:00Z", hasAnyGrowData: true, counts: { priorityActions: actions.length, followUpsDue: 0, openOpportunities: 0, contactsNeedingAttention: 0 }, priorityActions: actions, signalSummary: { surfaced: 0, emergingSurfaced: 0, emergingWithheld: 0, withheldDoNotContact: 0 }, ...o };
}

function view(s: GrowTodaySummary | null, o: Partial<MobileTodayViewProps> = {}, expanded = false) {
  const layout = s ? buildMobileTodayLayout(buildMinimalTodayModel(s, NOW), EXTRAS, expanded) : null;
  const props: MobileTodayViewProps = {
    searchSlot: MobileSearchBar(), sectionsSlot: null, dateLabel: "Monday 2 November", greeting: "Hi Sam — Grow Today", loading: false, error: null,
    layout, asOf: "2 Nov, 7:00 pm", expanded, onToggleExpanded: () => {}, onRefresh: () => {}, ...o,
  };
  return MobileTodayView(props);
}

const day = summary([
  person(1, "Maya Okafor", { recommendedAction: "Call about the appraisal you sent on Tuesday.", reason: "Appraisal sent Tuesday, opened twice", dueAt: OVERDUE, propertyLabel: "7 Jacaranda Street" }),
  person(5, "Olivia Brandt", { id: "c1", type: "commitment", commitmentId: 8, recommendedAction: "Send the market update", dueAt: OVERDUE }),
  person(3, "Priya Nair", { recommendedAction: "Appraisal appointment", dueAt: LATER, propertyLabel: "18 Coral Court" }),
  person(2, "Daniel Reyes", { id: "c2", type: "commitment", commitmentId: 9, recommendedAction: "Send comparable sales", dueAt: LATER }),
]);

test("order, top to bottom: search, sections, greeting, next action, Overdue, Today, shortcuts, footer", () => {
  const sections = { type: "nav", props: { "aria-label": "SECTIONS", children: null } } as never;
  const tree = view(day, { sectionsSlot: sections });
  const marker = (e: { type?: unknown; props?: Record<string, unknown> }) => {
    const cls = String(e.props?.className ?? "");
    if (cls.includes("mob-searchbar")) return "search";
    if (e.props?.["aria-label"] === "SECTIONS") return "sections";
    if (e.type === "h1") return "greeting";
    if (e.type === "article") return "next action";
    if (e.type === "section" && ["Overdue", "Today", "Shortcuts"].includes(String(e.props?.["aria-label"]))) return String(e.props?.["aria-label"]);
    if (cls.includes("mob-t-foot")) return "footer";
    return null;
  };
  const seq = all(tree, (e) => marker(e) !== null).map((e) => marker(e));
  assert.deepEqual(seq, ["search", "sections", "greeting", "next action", "Overdue", "Today", "Shortcuts", "footer"]);
});

test("one heading level one, and the greeting is it", () => {
  const h1 = all(view(day), (e) => e.type === "h1");
  assert.equal(h1.length, 1);
  assert.equal(text(h1[0]), "Hi Sam — Grow Today");
});

test("the search bar is the M2 link to /search, first on the screen", () => {
  const tree = view(day);
  assert.equal(hrefs(tree)[0], "/search");
});

test("the next action: one obvious button, the action said once, detail behind Why this", () => {
  const tree = view(day);
  const hero = all(tree, (e) => e.type === "article")[0];
  const heroText = text(hero);
  assert.match(heroText, /Maya Okafor/);
  assert.match(heroText, /7 Jacaranda Street/);
  assert.match(heroText, /Overdue/);
  const buttons = links(hero);
  assert.equal(buttons.length, 1);
  assert.equal(text(buttons[0]), "Open contact");
  assert.equal(buttons[0].props?.href, "/grow/contacts/1");
  const summaryEl = all(hero, (e) => e.type === "summary")[0];
  assert.equal(text(summaryEl), "Why this?");
  const outsideDetails = text(all(hero, (e) => e.type === "p" && e.props?.className === "mob-t-hero-action"));
  assert.equal(outsideDetails, "Call about the appraisal you sent on Tuesday.");
  assert.equal(heroText.split("Call about the appraisal you sent on Tuesday.").length - 1, 1, "said once");
});

test("no Why this disclosure when there is nothing more to say", () => {
  const bare = summary([person(1, "Maya", { recommendedAction: "Call her" })]);
  assert.equal(all(view(bare), (e) => e.type === "details").length, 0);
});

test("a consent warning on the next action is visible and announced", () => {
  const blocked = summary([person(1, "Maya", { recommendedAction: "Call her", contactability: "do_not_contact", contactabilityNote: "Must not be contacted." })]);
  const alert = all(view(blocked), (e) => e.props?.role === "alert");
  assert.equal(alert.length, 1);
  assert.equal(text(alert[0]), "Must not be contacted.");
});

test("commitments: Overdue then Today, each row one link to that person's record, in the product's words", () => {
  const tree = view(day);
  const sections = all(tree, (e) => e.type === "section" && ["Overdue", "Today"].includes(String(e.props?.["aria-label"])));
  assert.deepEqual(sections.map((s) => s.props?.["aria-label"]), ["Overdue", "Today"]);
  const overdue = text(sections[0]);
  assert.match(overdue, /Olivia Brandt/);
  assert.match(overdue, /Send the market update/);
  assert.match(overdue, /Commitment/);
  assert.match(overdue, /Overdue/);
  assert.deepEqual(hrefs(sections[0]), ["/grow/contacts/5"]);
  assert.deepEqual(hrefs(sections[1]), ["/grow/contacts/3", "/grow/contacts/2"]);
  assert.match(text(sections[1]), /Send comparable sales/);
  const row = links(sections[0])[0];
  assert.equal(row.props?.["aria-label"], "Open contact: Olivia Brandt. Send the market update");
});

test("a row with no permitted record is a plain row, not a dead link", () => {
  const s = summary([person(1, "Hero", { recommendedAction: "Call" }), action({ id: "pp", partyId: null, contactName: "7 Main St", propertyId: 5, availableActions: [{ action: "view_property", propertyId: 5 }], recommendedAction: "Review", dueAt: LATER })]);
  const tree = view(s);
  assert.equal(hrefs(tree).includes("/properties/5"), false);
  assert.equal(all(tree, (e) => e.props?.className === "mob-t-row mob-t-row-static").length, 1);
});

test("Show all appears only when rows are held back, and reports its state", () => {
  const eight = Array.from({ length: 8 }, (_, i) => person(i + 2, `P${i + 2}`, { dueAt: LATER, recommendedAction: "Call" }));
  const many = summary([person(1, "Hero"), ...eight]);
  let toggled = 0;
  const collapsed = view(many, { onToggleExpanded: () => { toggled++; } });
  const btn = all(collapsed, (e) => e.type === "button" && /Show/.test(text(e)))[0];
  assert.equal(text(btn), "Show all 8");
  assert.equal(btn.props?.["aria-expanded"], false);
  (btn.props?.onClick as () => void)();
  assert.equal(toggled, 1);
  const open = view(many, {}, true);
  const btn2 = all(open, (e) => e.type === "button" && /Show/.test(text(e)))[0];
  assert.equal(text(btn2), "Show fewer");
  assert.equal(btn2.props?.["aria-expanded"], true);
  assert.equal(all(view(day), (e) => e.type === "button" && /Show/.test(text(e))).length, 0);
});

test("My Momentum is one quiet shortcut; Ask AE is absent until verified; no Performance anywhere", () => {
  const tree = view(day);
  const shortcuts = all(tree, (e) => e.type === "section" && e.props?.["aria-label"] === "Shortcuts")[0];
  assert.deepEqual(hrefs(shortcuts), ["/grow/momentum"]);
  assert.match(text(shortcuts), /My Momentum/);
  assert.match(text(shortcuts), /64 pts this week · \+12 on last week/);
  assert.doesNotMatch(text(tree), /Ask AE|performance/i);
});

test("signals and the footer", () => {
  const s = summary([person(1, "Hero"), action({ id: "sg", type: "property_intelligence_signal", partyId: null, contactName: "7 Main St", availableActions: [] })], { signalSummary: { surfaced: 1, emergingSurfaced: 0, emergingWithheld: 2, withheldDoNotContact: 0 } });
  const tree = view(s);
  assert.match(text(tree), /Signals/);
  assert.match(text(tree), /held back/);
  let refreshed = 0;
  const foot = view(day, { onRefresh: () => { refreshed++; } });
  const refresh = all(foot, (e) => e.type === "button" && text(e) === "Refresh")[0];
  (refresh.props?.onClick as () => void)();
  assert.equal(refreshed, 1);
  assert.match(text(foot), /Updated 2 Nov, 7:00 pm/);
});

test("no statistics or desktop clutter: no counts, no At a glance, no Property delivery, no purpose paragraph", () => {
  const body = text(view(day));
  for (const gone of ["At a glance", "Priority actions", "priority actions", "Open opportunities", "Contacts needing attention", "Property delivery", "Relationships, follow-ups, and opportunities", "Your next valuable action"]) {
    assert.equal(body.includes(gone), false, gone);
  }
});

test("loading, error with Try again, and the empty states keep the existing wording", () => {
  assert.match(text(view(null, { loading: true })), /Loading today's priorities…/);
  let retried = 0;
  const err = view(null, { error: { text: "Couldn't load Today.", onRetry: () => { retried++; } } });
  assert.equal(all(err, (e) => e.props?.role === "alert").length, 1);
  (all(err, (e) => e.type === "button" && text(e) === "Try again")[0].props?.onClick as () => void)();
  assert.equal(retried, 1);
  const noData = view(summary([], { hasAnyGrowData: false }));
  assert.match(text(noData), /Let's find your next opportunity/);
  assert.deepEqual(hrefs(noData).filter((h) => h === "/grow/import"), ["/grow/import"]);
  assert.match(text(view(summary([]))), /You're all caught up — nothing needs your attention right now\./);
  const setup = view(summary([], { firstRun: { contact: false, propertyLink: true, activity: true, commitment: true, opportunity: true, appraisal: true } }));
  assert.match(text(setup), /Getting started/);
  assert.match(text(setup), /Add a contact/);
});
