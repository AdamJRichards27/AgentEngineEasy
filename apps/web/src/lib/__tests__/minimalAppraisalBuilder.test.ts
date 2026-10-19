// WS2 — AE Minimal A seven-step Appraisal Builder, manual path (UX a49f7717,
// AppraisalBuilder.tsx APPRAISAL_STEPS and handleStepContinue). The builder
// edits a server appraisal through the existing /grow/appraisals routes; it
// keeps no browser drafts. Attestations (steps 2, 4, range approval) are
// UI-only gates (feasibility D7) and are not stored.
import assert from "node:assert/strict";
import test from "node:test";
import {
  MINIMAL_APPRAISAL_STEPS,
  type BuilderContext,
  type BuilderWorkspace,
  builderPath,
  builderReadOnlyMessage,
  builderStepGate,
  comparableBody,
  competitionBody,
  continueBuilder,
  followUpBody,
  goToBuilderStep,
  initialBuilderState,
  parseMoney,
  rangeDraftFrom,
  rangeIsSaved,
  rangePatchBody,
  rangeValidation,
  selectAppraisalBuilderView,
} from "../../minimal/appraisal/appraisalBuilderModel";

function workspace(overrides: Partial<BuilderWorkspace["appraisal"]> = {}, extra: Partial<BuilderWorkspace> = {}): BuilderWorkspace {
  return {
    appraisal: {
      id: 41,
      propertyId: 7,
      partyId: 3,
      status: "DRAFT",
      isFinalised: false,
      priceRangeLow: null,
      priceRangeHigh: null,
      pricingCommentary: null,
      marketPositionNarrative: null,
      presentationDocumentId: null,
      followUpAt: null,
      ...overrides,
    },
    comparableSales: [],
    marketCompetition: [],
    ...extra,
  };
}

function ctx(ws: BuilderWorkspace, over: Partial<BuilderContext> = {}): BuilderContext {
  return {
    workspace: ws,
    attest: { propertyFactsConfirmed: false, competitionReviewed: false, rangeApproved: false },
    rangeDraft: rangeDraftFrom(ws.appraisal),
    ...over,
  };
}

const comp = { id: 1, address: "4 Park Rd, Milton", salePrice: "1200000.00", saleDate: "2026-08-01T00:00:00.000Z", bedrooms: 3, bathrooms: 2, carSpaces: 1, notes: "Same street" };

test("seven steps in the approved order and labels", () => {
  assert.equal(MINIMAL_APPRAISAL_STEPS.length, 7);
  assert.deepEqual(
    MINIMAL_APPRAISAL_STEPS.map((s) => s.title),
    [
      "Select Property",
      "Enrich Property",
      "Review Comparables",
      "Review Competition",
      "Establish Appraisal Range",
      "Build Appraisal",
      "Save and Follow Up",
    ],
  );
  assert.deepEqual(
    MINIMAL_APPRAISAL_STEPS.map((s) => s.short),
    ["Property", "Enrich", "Sold comps", "Competition", "Range", "Preview", "Save"],
  );
});

test("no step offers a simulated range or a live provider (D2, Pricefinder deferred)", () => {
  const copy = MINIMAL_APPRAISAL_STEPS.map((s) => `${s.title} ${s.summary}`).join(" ");
  assert.doesNotMatch(copy, /simulat/i);
  assert.doesNotMatch(copy, /pricefinder/i);
});

test("step 1 passes for a server appraisal with a property", () => {
  assert.equal(builderStepGate(1, ctx(workspace())), null);
});

test("step 2 needs the agent to confirm the property facts (UI attestation)", () => {
  const ws = workspace();
  assert.match(builderStepGate(2, ctx(ws)) ?? "", /confirm/i);
  assert.equal(
    builderStepGate(2, ctx(ws, { attest: { propertyFactsConfirmed: true, competitionReviewed: false, rangeApproved: false } })),
    null,
  );
});

test("step 3 needs at least one sold comparable on the server", () => {
  assert.match(builderStepGate(3, ctx(workspace())) ?? "", /at least one/i);
  assert.equal(builderStepGate(3, ctx(workspace({}, { comparableSales: [comp] }))), null);
});

test("step 4 needs the competition review attestation, even with no listings", () => {
  const ws = workspace();
  assert.match(builderStepGate(4, ctx(ws)) ?? "", /competition/i);
  assert.equal(
    builderStepGate(4, ctx(ws, { attest: { propertyFactsConfirmed: true, competitionReviewed: true, rangeApproved: false } })),
    null,
  );
});

test("step 5: valid range, 20+ character rationale, saved to the server, then agent approval", () => {
  const empty = workspace();
  assert.match(builderStepGate(5, ctx(empty)) ?? "", /range/i);

  const draft = { low: "$1,150,000", high: "$1,250,000", commentary: "Three recent sales on Park Rd support this." };
  // Valid but not yet saved.
  assert.match(builderStepGate(5, ctx(empty, { rangeDraft: draft })) ?? "", /save/i);

  const saved = workspace({ priceRangeLow: "1150000.00", priceRangeHigh: "1250000.00", pricingCommentary: draft.commentary });
  assert.match(builderStepGate(5, ctx(saved, { rangeDraft: draft })) ?? "", /approve/i);
  assert.equal(
    builderStepGate(5, ctx(saved, { rangeDraft: draft, attest: { propertyFactsConfirmed: true, competitionReviewed: true, rangeApproved: true } })),
    null,
  );
});

test("step 6 needs the presentation document to exist on the server", () => {
  assert.match(builderStepGate(6, ctx(workspace())) ?? "", /document preview/i);
  assert.equal(builderStepGate(6, ctx(workspace({ presentationDocumentId: 9 }))), null);
});

test("continue moves forward one step only when the gate passes, and records the highest step", () => {
  const ws = workspace();
  const s1 = continueBuilder(initialBuilderState(), ctx(ws));
  assert.equal(s1.message, null);
  assert.equal(s1.state.step, 2);
  assert.equal(s1.state.highestStep, 2);
  const blocked = continueBuilder(s1.state, ctx(ws));
  assert.equal(blocked.state.step, 2);
  assert.ok(blocked.message);
  const last = continueBuilder({ step: 7, highestStep: 7 }, ctx(ws));
  assert.equal(last.state.step, 7);
});

test("the stepper only jumps to steps already reached", () => {
  const state = { step: 3, highestStep: 4 };
  assert.equal(goToBuilderStep(state, 2).step, 2);
  assert.equal(goToBuilderStep(state, 4).step, 4);
  assert.equal(goToBuilderStep(state, 5).step, 3);
  assert.equal(goToBuilderStep(state, 0).step, 3);
});

test("read-only appraisals (finished or finalised) can be reviewed without the gates", () => {
  const won = workspace({ status: "WON" });
  assert.ok(builderReadOnlyMessage(won.appraisal));
  assert.equal(continueBuilder({ step: 3, highestStep: 3 }, ctx(won)).state.step, 4);
  const finalised = workspace({ isFinalised: true });
  assert.match(builderReadOnlyMessage(finalised.appraisal) ?? "", /finalised|locked/i);
  assert.equal(builderReadOnlyMessage(workspace().appraisal), null);
});

test("a viewer without the manage entitlement browses the steps without the gates", () => {
  const ws = workspace();
  assert.ok(continueBuilder({ step: 2, highestStep: 2 }, ctx(ws)).message);
  assert.equal(continueBuilder({ step: 2, highestStep: 2 }, ctx(ws), { reviewOnly: true }).state.step, 3);
});

test("parseMoney accepts en-AU money text and rejects nonsense", () => {
  assert.equal(parseMoney("$1,250,000"), 1250000);
  assert.equal(parseMoney(" 980000.50 "), 980000.5);
  assert.equal(parseMoney(""), null);
  assert.equal(parseMoney("1.2m"), null);
  assert.equal(parseMoney("-5"), null);
  assert.equal(parseMoney("0"), null);
});

test("rangeValidation: low ≤ high and a 20-character rationale", () => {
  assert.match(rangeValidation({ low: "", high: "1", commentary: "x".repeat(20) }) ?? "", /low/i);
  assert.match(rangeValidation({ low: "2", high: "1", commentary: "x".repeat(20) }) ?? "", /lower|higher/i);
  assert.match(rangeValidation({ low: "1", high: "2", commentary: "too short" }) ?? "", /20/);
  assert.equal(rangeValidation({ low: "1", high: "1", commentary: "x".repeat(20) }), null);
});

test("rangePatchBody sends the existing PATCH fields as plain decimal strings", () => {
  assert.deepEqual(rangePatchBody({ low: "$1,150,000", high: "1,250,000", commentary: "  Three sales support this range.  " }), {
    priceRangeLow: "1150000",
    priceRangeHigh: "1250000",
    pricingCommentary: "Three sales support this range.",
  });
  assert.equal(rangePatchBody({ low: "x", high: "1", commentary: "x".repeat(20) }), null);
});

test("rangeIsSaved compares numerically with the server's numeric(12,2) strings", () => {
  const appraisal = workspace({ priceRangeLow: "1150000.00", priceRangeHigh: "1250000.00", pricingCommentary: "Three sales support this range." }).appraisal;
  assert.equal(rangeIsSaved({ low: "$1,150,000", high: "1250000", commentary: "Three sales support this range. " }, appraisal), true);
  assert.equal(rangeIsSaved({ low: "1150001", high: "1250000", commentary: "Three sales support this range." }, appraisal), false);
  assert.deepEqual(rangeDraftFrom(appraisal), { low: "1150000", high: "1250000", commentary: "Three sales support this range." });
});

test("comparableBody maps the manual form onto POST /comparable-sales and needs a relevance note", () => {
  const ok = comparableBody({ address: " 4 Park Rd, Milton ", salePrice: "$1,200,000", saleDate: "2026-08-01", bedrooms: "3", bathrooms: "2", carSpaces: "", landSizeSqm: "405", propertyType: "House", notes: "Same street, renovated" });
  assert.deepEqual(ok, {
    ok: true,
    body: {
      address: "4 Park Rd, Milton",
      salePrice: "1200000",
      saleDate: "2026-08-01",
      bedrooms: 3,
      bathrooms: 2,
      carSpaces: null,
      landSizeSqm: "405",
      propertyType: "House",
      notes: "Same street, renovated",
      source: "manual",
    },
  });
  const base = { address: "4 Park Rd", salePrice: "1", saleDate: "2026-08-01", bedrooms: "", bathrooms: "", carSpaces: "", landSizeSqm: "", propertyType: "", notes: "Relevant" };
  assert.equal(comparableBody({ ...base, address: " " }).ok, false);
  assert.equal(comparableBody({ ...base, notes: "" }).ok, false);
  assert.equal(comparableBody({ ...base, salePrice: "" }).ok, false);
  assert.equal(comparableBody({ ...base, saleDate: "01/08/2026" }).ok, false);
  assert.equal(comparableBody({ ...base, bedrooms: "2.5" }).ok, false);
});

test("competitionBody keeps asking prices separate from sold evidence", () => {
  const ok = competitionBody({ address: "9 Hale St", askingPriceDisplay: "Offers over $1.1m", askingPriceLow: "1,100,000", askingPriceHigh: "", status: "Active", daysOnMarket: "12", notes: "" });
  assert.deepEqual(ok, {
    ok: true,
    body: {
      address: "9 Hale St",
      askingPriceDisplay: "Offers over $1.1m",
      askingPriceLow: "1100000",
      askingPriceHigh: null,
      status: "Active",
      daysOnMarket: 12,
      notes: null,
      source: "manual",
    },
  });
  assert.equal(competitionBody({ address: "", askingPriceDisplay: "", askingPriceLow: "", askingPriceHigh: "", status: "", daysOnMarket: "", notes: "" }).ok, false);
  assert.equal(competitionBody({ address: "9 Hale St", askingPriceDisplay: "", askingPriceLow: "2", askingPriceHigh: "1", status: "", daysOnMarket: "", notes: "" }).ok, false);
});

test("followUpBody converts a Brisbane wall-clock time to an ISO instant (UTC+10, no DST)", () => {
  assert.deepEqual(followUpBody({ date: "2026-10-26", time: "09:30", notes: " Call after the open home " }), {
    ok: true,
    body: { followUpAt: "2026-10-25T23:30:00.000Z", followUpNotes: "Call after the open home" },
  });
  assert.deepEqual(followUpBody({ date: "2026-10-26", time: "", notes: "" }), {
    ok: true,
    body: { followUpAt: "2026-10-25T23:00:00.000Z", followUpNotes: null },
  });
  assert.equal(followUpBody({ date: "", time: "", notes: "" }).ok, false);
  assert.equal(followUpBody({ date: "2026-02-30", time: "", notes: "" }).ok, false);
});

test("builder path and the flag-gated view selector (classic unless the Minimal shell is on)", () => {
  assert.equal(builderPath(41), "/grow/appraisals/41/build");
  assert.equal(selectAppraisalBuilderView(false), "classic");
  assert.equal(selectAppraisalBuilderView(true), "minimal");
});
