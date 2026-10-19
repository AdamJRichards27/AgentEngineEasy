// WS2 — presentational AE Minimal A views for the Appraisal Builder,
// Properties and Opportunities. Rendered as plain function calls; the
// returned element tree is walked (no DOM, no network), as in
// minimalContact360View.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { Link } from "wouter";
import { MinimalAppraisalBuilderView, type BuilderViewProps } from "../../minimal/appraisal/MinimalAppraisalBuilderView";
import {
  EMPTY_COMPARABLE_FORM,
  EMPTY_COMPETITION_FORM,
  type BuilderWorkspace,
} from "../../minimal/appraisal/appraisalBuilderModel";
import { MinimalPropertiesView, type MinimalPropertiesViewProps } from "../../minimal/properties/MinimalPropertiesView";
import { MinimalOpportunitiesView, type MinimalOpportunitiesViewProps } from "../../minimal/opportunities/MinimalOpportunitiesView";
import { buildPipelineBoard, type MinimalOpportunityRow } from "../../minimal/opportunities/minimalOpportunitiesModel";

interface El { type?: unknown; props?: Record<string, unknown> & { children?: unknown } }
function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (!node || typeof node !== "object") return "";
  return text((node as El).props?.children);
}
function all(node: unknown, pred: (e: El) => boolean): El[] {
  if (Array.isArray(node)) return node.flatMap((c) => all(c, pred));
  if (!node || typeof node !== "object") return [];
  const e = node as El;
  return (pred(e) ? [e] : []).concat(all(e.props?.children, pred));
}
const buttons = (tree: unknown) => all(tree, (e) => e.type === "button");
const button = (tree: unknown, label: string) => buttons(tree).find((b) => text(b).trim() === label);
const links = (tree: unknown) => all(tree, (e) => e.type === Link).map((e) => ({ href: String(e.props?.href), text: text(e) }));

const noop = () => {};
function ws(over: Partial<BuilderWorkspace["appraisal"]> = {}, extra: Partial<BuilderWorkspace> = {}): BuilderWorkspace {
  return {
    appraisal: {
      id: 41, propertyId: 7, partyId: 3, status: "DRAFT", isFinalised: false,
      priceRangeLow: null, priceRangeHigh: null, pricingCommentary: null,
      marketPositionNarrative: null, presentationDocumentId: null, followUpAt: null, ...over,
    },
    comparableSales: [],
    marketCompetition: [],
    ...extra,
  };
}
function builderProps(over: Partial<BuilderViewProps> = {}): BuilderViewProps {
  const calls: string[] = [];
  const on = new Proxy({}, { get: (_t, k) => (...args: unknown[]) => calls.push(`${String(k)}:${JSON.stringify(args)}`) }) as BuilderViewProps["on"];
  return {
    workspace: ws(),
    subject: { address: "7 Park Rd, Milton QLD 4064", location: "Milton QLD 4064", propertyHref: "/properties/7", contactName: "Jo Smith", contactHref: "/grow/contacts/3" },
    state: { step: 1, highestStep: 1 },
    rangeDraft: { low: "", high: "", commentary: "" },
    narrativeDraft: "",
    comparableForm: EMPTY_COMPARABLE_FORM,
    competitionForm: EMPTY_COMPETITION_FORM,
    followUpForm: { date: "", time: "", notes: "" },
    message: null,
    notice: null,
    busy: false,
    canWrite: true,
    runAccess: false,
    on,
    ...over,
  };
}

test("builder: seven-step stepper, only reached steps are clickable", () => {
  const tree = MinimalAppraisalBuilderView(builderProps({ state: { step: 2, highestStep: 3 } }));
  const steps = buttons(tree).filter((b) => text(b).startsWith("Step "));
  assert.equal(steps.length, 7);
  assert.deepEqual(steps.map((s) => Boolean(s.props?.disabled)), [false, false, false, true, true, true, true]);
  assert.equal(steps[1].props?.["aria-current"], "step");
  assert.match(text(tree), /STEP 2 OF 7/);
  assert.match(text(tree), /Enrich Property/);
});

test("builder: step 2 states plainly that no property-data provider is connected", () => {
  const tree = MinimalAppraisalBuilderView(builderProps({ state: { step: 2, highestStep: 2 } }));
  assert.match(text(tree), /No property-data provider is connected/);
  assert.doesNotMatch(text(tree), /Pricefinder|simulat/i);
  assert.equal(all(tree, (e) => e.type === "input" && e.props?.type === "checkbox").length, 0);
});

test("builder: gate message is announced as an alert", () => {
  const tree = MinimalAppraisalBuilderView(builderProps({ message: "Add at least one relevant sold comparable." }));
  const alert = all(tree, (e) => e.props?.role === "alert")[0];
  assert.match(text(alert), /sold comparable/);
});

test("builder: step 3 lists server comparables with en-AU money and a remove control", () => {
  const tree = MinimalAppraisalBuilderView(
    builderProps({
      state: { step: 3, highestStep: 3 },
      workspace: ws({}, { comparableSales: [{ id: 5, address: "4 Park Rd", salePrice: "1200000.00", saleDate: "2026-08-01T00:00:00.000Z", bedrooms: 3, bathrooms: 2, carSpaces: null, notes: "Same street" }] }),
    }),
  );
  assert.match(text(tree), /\$1,200,000 · 1 Aug 2026 · 3 bed · 2 bath/);
  assert.ok(buttons(tree).find((b) => b.props?.["aria-label"] === "Remove 4 Park Rd"));
  assert.ok(button(tree, "Add comparable"));
  assert.match(text(tree), /coordinates/);
});

test("builder: step 5 saves the range to the server; there is no browser-only approve control (D7)", () => {
  const unsaved = MinimalAppraisalBuilderView(
    builderProps({ state: { step: 5, highestStep: 5 }, rangeDraft: { low: "1150000", high: "1250000", commentary: "Three Park Rd sales support this." } }),
  );
  assert.equal(button(unsaved, "Save range")?.props?.disabled, false);
  assert.equal(all(unsaved, (e) => e.props?.id === "ae-builder-approve").length, 0);

  const saved = MinimalAppraisalBuilderView(
    builderProps({
      state: { step: 5, highestStep: 5 },
      workspace: ws({ priceRangeLow: "1150000.00", priceRangeHigh: "1250000.00", pricingCommentary: "Three Park Rd sales support this." }),
      rangeDraft: { low: "1150000", high: "1250000", commentary: "Three Park Rd sales support this." },
    }),
  );
  assert.equal(button(saved, "Range saved")?.props?.disabled, true);
  assert.match(text(saved), /\$1,150,000 – \$1,250,000 · low ≤ high/);
  assert.match(text(saved), /Saved in AE/);
});

test("builder D7: no step renders a browser-only attestation, and the page says nothing here is a recorded attestation", () => {
  const full = ws(
    { priceRangeLow: "1150000.00", priceRangeHigh: "1250000.00", pricingCommentary: "Three Park Rd sales support this.", presentationDocumentId: 9 },
  );
  for (let step = 1; step <= 7; step++) {
    const tree = MinimalAppraisalBuilderView(builderProps({ state: { step, highestStep: 7 }, workspace: full }));
    assert.equal(all(tree, (e) => e.type === "input" && e.props?.type === "checkbox").length, 0, `step ${step} checkbox`);
    assert.equal(buttons(tree).filter((b) => /approv|confirm|attest/i.test(text(b))).length, 0, `step ${step} approve button`);
    const out = text(tree);
    assert.doesNotMatch(out, /Agent approval|Range approved|Property facts checked|confirm them again/i, `step ${step} copy`);
    assert.match(out, /records no attestations or approvals/, `step ${step} disclosure`);
  }
});

test("builder: step 6 shows the disclaimer and builds the preview through the existing route", () => {
  const tree = MinimalAppraisalBuilderView(builderProps({ state: { step: 6, highestStep: 6 } }));
  assert.match(text(tree), /not a formal valuation/);
  assert.ok(button(tree, "Build document preview"));
  assert.equal(text(button(tree, "Continue to save")), "Continue to save");
});

test("builder: step 7 sets a due follow-up (G-6 wording) and points to the full workspace for finalise/send", () => {
  const tree = MinimalAppraisalBuilderView(builderProps({ state: { step: 7, highestStep: 7 } }));
  assert.equal(button(tree, "Save due follow-up")?.props?.disabled, true);
  assert.match(text(tree), /No due follow-up set yet/);
  assert.ok(links(tree).some((l) => l.href === "/grow/appraisals/41" && /full appraisal/.test(l.text)));
  assert.equal(button(tree, "Continue"), undefined);
});

test("builder: a finished appraisal is read-only and says why", () => {
  const tree = MinimalAppraisalBuilderView(builderProps({ workspace: ws({ status: "WON" }), state: { step: 3, highestStep: 7 } }));
  assert.match(text(tree), /finished and cannot be changed/);
  assert.equal(button(tree, "Add comparable")?.props?.disabled, true);
});

test("builder: without the manage entitlement every write control is disabled", () => {
  const tree = MinimalAppraisalBuilderView(builderProps({ canWrite: false, state: { step: 6, highestStep: 6 } }));
  assert.match(text(tree), /view this appraisal but not change it/);
  assert.equal(button(tree, "Build document preview")?.props?.disabled, true);
});

function propsFor(over: Partial<MinimalPropertiesViewProps> = {}): MinimalPropertiesViewProps {
  return {
    cards: [
      { id: 1, address: "1 Park Rd, Milton QLD 4064", location: "Milton QLD 4064", stage: "Appraisal", listingStatus: "Not Listed", href: "/properties/1", appraisal: null, openOpportunityCount: 2 },
      { id: 2, address: "2 Hale St", location: "Location not recorded", stage: "Live", listingStatus: "Listed", href: "/properties/2", appraisal: { id: 9, statusLabel: "Presented", href: "/grow/appraisals/9", closed: false }, openOpportunityCount: 0 },
    ],
    search: "",
    loading: false,
    error: null,
    notice: null,
    chooser: null,
    pendingPropertyId: null,
    canCreateAppraisal: true,
    runAccess: false,
    onSearch: noop, onCreateAppraisal: noop, onChooseContact: noop, onCancelChooser: noop, onRetry: noop,
    ...over,
  };
}

test("properties: cards show stage, appraisal link and open opportunity count", () => {
  const tree = MinimalPropertiesView(propsFor());
  const out = text(tree);
  assert.match(out, /2 property records/);
  assert.match(out, /2 open opportunities/);
  assert.match(out, /No open opportunity/);
  assert.ok(links(tree).some((l) => l.href === "/grow/appraisals/9" && /Presented/.test(l.text)));
  const actions = all(tree, (e) => e.type === "button" && e.props?.className === "am-property-appraisal-action").map(text);
  assert.deepEqual(actions, ["Create Appraisal", "Open Appraisal"]);
});

test("properties D5: the property link opens Run only for users with Run access", () => {
  const withRun = MinimalPropertiesView(propsFor({ runAccess: true }));
  const cards = all(withRun, (e) => e.type === "article");
  assert.deepEqual(links(cards[0]).filter((l) => l.href === "/properties/1").map((l) => l.text), ["Open in Run"]);
  const without = MinimalPropertiesView(propsFor({ runAccess: false }));
  const plain = all(without, (e) => e.type === "article");
  assert.deepEqual(links(plain[0]).filter((l) => l.href === "/properties/1").map((l) => l.text), ["Details"]);
  assert.doesNotMatch(text(without), /\bRun\b/);
});

test("builder D5: the subject property link opens Run only with Run access", () => {
  const withRun = MinimalAppraisalBuilderView(builderProps({ runAccess: true }));
  assert.ok(links(withRun).some((l) => l.href === "/properties/7" && l.text === "Open in Run"));
  const without = MinimalAppraisalBuilderView(builderProps({ runAccess: false }));
  assert.ok(links(without).some((l) => l.href === "/properties/7" && l.text === "Open property"));
  assert.ok(!links(without).some((l) => /Run/.test(l.text)));
});

test("properties: Create Appraisal is hidden without the manage entitlement", () => {
  const tree = MinimalPropertiesView(propsFor({ canCreateAppraisal: false }));
  assert.equal(all(tree, (e) => e.props?.className === "am-property-appraisal-action").length, 0);
});

test("properties: contact chooser and inline notice render on the right card", () => {
  const tree = MinimalPropertiesView(
    propsFor({
      chooser: { propertyId: 1, choices: [{ partyId: 3, label: "Jo Smith · Owner" }, { partyId: 4, label: "Acme Pty Ltd · Owner" }] },
      notice: { propertyId: 2, text: "Link a contact to this property first.", href: "/properties/2", hrefLabel: "Open the property" },
    }),
  );
  const cards = all(tree, (e) => e.type === "article");
  assert.match(text(cards[0]), /Who is this appraisal for\?/);
  assert.ok(button(cards[0], "Jo Smith · Owner"));
  assert.match(text(cards[1]), /Link a contact/);
  assert.doesNotMatch(text(cards[1]), /Who is this appraisal for/);
});

test("properties: empty and error states", () => {
  assert.match(text(MinimalPropertiesView(propsFor({ cards: [], search: "zzz" }))), /No properties match/);
  assert.match(text(MinimalPropertiesView(propsFor({ cards: [] }))), /No properties yet/);
  const err = MinimalPropertiesView(propsFor({ cards: [], error: "Couldn't load properties. Try again." }));
  assert.ok(button(err, "Try again"));
  assert.doesNotMatch(text(err), /No properties yet/);
});

const opp = (id: number, over: Partial<MinimalOpportunityRow> = {}): MinimalOpportunityRow => ({
  id, partyId: 3, propertyId: 7, opportunityType: "Listing", status: "Open", stage: "New", reason: "Selling next year",
  nextActionDueAt: null, recommendedNextAction: null, convertedAppraisalId: null, contactName: "Jo Smith", ...over,
});
function oppProps(rows: MinimalOpportunityRow[], over: Partial<MinimalOpportunitiesViewProps> = {}): MinimalOpportunitiesViewProps {
  return {
    board: buildPipelineBoard(rows), rowsById: new Map(rows.map((r) => [r.id, r])), total: rows.length,
    loading: false, error: null, actionError: null, canManage: true, showClosed: false, lostDraft: null, pendingId: null, announcement: null,
    onToggleClosed: noop, onStage: noop, onStartLost: noop, onLostReason: noop, onConfirmLost: noop, onCancelLost: noop, onClose: noop, onRetry: noop,
    ...over,
  };
}

test("opportunities: pipeline is titled Opportunities; Market Activity is a deferred notice", () => {
  const tree = MinimalOpportunitiesView(oppProps([opp(1)]));
  const h1 = all(tree, (e) => e.type === "h1")[0];
  assert.equal(text(h1), "Opportunities");
  const aside = all(tree, (e) => e.type === "aside")[0];
  assert.equal(aside.props?.["aria-label"], "Market Activity");
  assert.match(text(aside), /deferred/);
});

test("opportunities: closed columns are hidden until asked for", () => {
  const rows = [opp(1), opp(2, { status: "Lost", stage: "Lost" })];
  const cols = (tree: unknown) => all(tree, (e) => typeof e.props?.["data-column"] === "string").map((e) => e.props?.["data-column"]);
  assert.deepEqual(cols(MinimalOpportunitiesView(oppProps(rows))), ["New", "Contacted", "Qualified", "AppraisalBooked"]);
  assert.deepEqual(cols(MinimalOpportunitiesView(oppProps(rows, { showClosed: true }))).length, 7);
});

test("opportunities: open card offers the manual stages, mark lost and close; booked card is locked", () => {
  const tree = MinimalOpportunitiesView(oppProps([opp(1, { stage: "Contacted" }), opp(2, { stage: "AppraisalBooked" })]));
  const cards = all(tree, (e) => e.type === "article");
  const options = all(cards[0], (e) => e.type === "option").map(text);
  assert.deepEqual(options, ["Move to…", "New", "Qualified"]);
  assert.ok(button(cards[0], "Mark lost"));
  assert.ok(button(cards[0], "Close"));
  assert.match(text(cards[1]), /active appraisal/);
  assert.equal(button(cards[1], "Close"), undefined);
});

test("opportunities: mark lost needs a reason before it can be confirmed", () => {
  const tree = MinimalOpportunitiesView(oppProps([opp(1)], { lostDraft: { id: 1, reason: "  " } }));
  assert.equal(button(tree, "Mark lost")?.props?.disabled, true);
  const ready = MinimalOpportunitiesView(oppProps([opp(1)], { lostDraft: { id: 1, reason: "Sold privately" } }));
  assert.equal(button(ready, "Mark lost")?.props?.disabled, false);
});

test("opportunities: read-only viewers see no lifecycle controls; truncation is disclosed", () => {
  const tree = MinimalOpportunitiesView(oppProps([opp(1)], { canManage: false, total: 140 }));
  assert.equal(button(tree, "Close"), undefined);
  assert.match(text(tree), /Showing the latest 1 of 140/);
});

// Accessibility and keyboard pass (19 Oct 2026): findings from axe-core and a
// keyboard walk against the real API, pinned here before the fixes.

test("a11y builder: stepper names include their visible text (WCAG 2.5.3) and keep aria-current", () => {
  const tree = MinimalAppraisalBuilderView(builderProps({ state: { step: 2, highestStep: 3 } }));
  const steps = all(tree, (e) => e.type === "nav")[0];
  const stepButtons = buttons(steps);
  assert.equal(stepButtons.length, 7);
  for (const b of stepButtons) assert.equal(b.props?.["aria-label"], undefined);
  assert.deepEqual(stepButtons.map((b) => text(b)), [
    "Step 1: Property", "Step 2: Enrich", "Step 3: Sold comps", "Step 4: Competition", "Step 5: Range", "Step 6: Preview", "Step 7: Save",
  ]);
  assert.equal(stepButtons[1].props?.["aria-current"], "step");
});

test("a11y builder: the step heading can take focus after a step change; the decorative counter is hidden", () => {
  const tree = MinimalAppraisalBuilderView(builderProps({ state: { step: 3, highestStep: 3 } }));
  const h2 = all(tree, (e) => e.type === "h2" && e.props?.id === "ae-appraisal-step-title")[0];
  assert.equal(h2.props?.tabIndex, -1);
  const counter = all(tree, (e) => e.props?.className === "ae-appraisal-step-count")[0];
  assert.equal(counter.props?.["aria-hidden"], "true");
});

test("a11y opportunities: the lost-reason field is named by its visible label and takes focus", () => {
  const tree = MinimalOpportunitiesView(oppProps([opp(1)], { lostDraft: { id: 1, reason: "" } }));
  const area = all(tree, (e) => e.type === "textarea")[0];
  assert.equal(area.props?.["aria-label"], undefined);
  assert.equal(area.props?.autoFocus, true);
  const label = all(tree, (e) => e.type === "label" && all(e, (c) => c.type === "textarea").length > 0)[0];
  assert.match(text(label), /Why was it lost\?/);
});

test("a11y opportunities: the closed toggle keeps one label with aria-pressed, and lifecycle changes are announced", () => {
  const off = MinimalOpportunitiesView(oppProps([opp(1)]));
  const on = MinimalOpportunitiesView(oppProps([opp(1)], { showClosed: true, announcement: "Jo Smith moved to Contacted." }));
  const toggle = (t: unknown) => buttons(t).find((b) => b.props?.["aria-pressed"] !== undefined);
  assert.equal(text(toggle(off)), "Show closed");
  assert.equal(text(toggle(on)), "Show closed");
  assert.equal(toggle(on)?.props?.["aria-pressed"], true);
  const live = (t: unknown) => all(t, (e) => e.props?.role === "status" && e.props?.["aria-live"] === "polite");
  assert.equal(live(off).length, 1);
  assert.equal(text(live(off)[0]), "");
  assert.equal(text(live(on)[0]), "Jo Smith moved to Contacted.");
});

test("a11y properties: the contact chooser takes focus on its first choice", () => {
  const tree = MinimalPropertiesView(
    propsFor({ chooser: { propertyId: 1, choices: [{ partyId: 3, label: "Jo Smith · Owner" }, { partyId: 4, label: "Acme Pty Ltd · Owner" }] } }),
  );
  assert.equal(button(tree, "Jo Smith · Owner")?.props?.autoFocus, true);
  assert.notEqual(button(tree, "Acme Pty Ltd · Owner")?.props?.autoFocus, true);
});

test("opportunities: a visible, named 'Classic view' link goes to /grow/opportunities?view=full and has a focus ring", async () => {
  const tree = MinimalOpportunitiesView(oppProps([opp(1)]));
  const header = all(tree, (e) => e.type === "header")[0];
  const classic = all(header, (e) => e.type === Link && e.props?.href === "/grow/opportunities?view=full");
  assert.equal(classic.length, 1);
  assert.equal(text(classic[0]).trim(), "Classic view");
  const label = classic[0].props?.["aria-label"];
  if (label !== undefined) assert.match(String(label), /Classic view/);
  assert.match(String(classic[0].props?.className), /\bam-ws2-classic-link\b/);
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../../minimal/opportunities/opportunities.css", import.meta.url), "utf8");
  assert.match(css, /\.am-ws2-classic-link:focus-visible\s*\{[^}]*outline:\s*3px solid #C44F17/);
});
