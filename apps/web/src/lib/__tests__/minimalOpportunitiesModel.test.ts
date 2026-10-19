// WS2 — AE Minimal A Opportunities: the existing pipeline keeps the name
// "Opportunities" (D3); the prototype's map is "Market Activity" and is
// deferred (D10), so it is a labelled notice, not a map.
import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKET_ACTIVITY_DEFERRED,
  MINIMAL_PIPELINE_COLUMNS,
  buildPipelineBoard,
  lifecycleBody,
  opportunityActions,
  selectOpportunitiesView,
  type MinimalOpportunityRow,
} from "../../minimal/opportunities/minimalOpportunitiesModel";

const opp = (id: number, over: Partial<MinimalOpportunityRow> = {}): MinimalOpportunityRow => ({
  id,
  partyId: 3,
  propertyId: 7,
  opportunityType: "Listing",
  status: "Open",
  stage: "New",
  reason: "Mentioned selling next year",
  nextActionDueAt: null,
  recommendedNextAction: null,
  convertedAppraisalId: null,
  contactName: "Jo Smith",
  ...over,
});

test("open columns follow the stored stages; closed outcomes are grouped after", () => {
  assert.deepEqual(
    MINIMAL_PIPELINE_COLUMNS.map((c) => c.label),
    ["New", "Contacted", "Qualified", "Appraisal booked", "Converted", "Lost", "Closed"],
  );
});

test("board places each row once, by status first then stage", () => {
  const board = buildPipelineBoard([
    opp(1),
    opp(2, { stage: "Qualified" }),
    opp(3, { stage: "AppraisalBooked", convertedAppraisalId: 44 }),
    opp(4, { status: "Lost", stage: "Lost" }),
    opp(5, { status: "Closed", stage: "Qualified" }),
    opp(6, { status: "Converted", stage: "Converted", convertedAppraisalId: 45 }),
  ]);
  const ids = (key: string) => board.find((c) => c.key === key)!.cards.map((c) => c.id);
  assert.deepEqual(ids("New"), [1]);
  assert.deepEqual(ids("Qualified"), [2]);
  assert.deepEqual(ids("AppraisalBooked"), [3]);
  assert.deepEqual(ids("Lost"), [4]);
  assert.deepEqual(ids("Closed"), [5]);
  assert.deepEqual(ids("Converted"), [6]);
  const booked = board.find((c) => c.key === "AppraisalBooked")!.cards[0];
  assert.equal(booked.appraisalHref, "/grow/appraisals/44");
  assert.equal(booked.contactHref, "/grow/contacts/3");
  assert.equal(booked.typeLabel, "Listing");
  assert.equal(board.find((c) => c.key === "New")!.count, 1);
});

test("next action date is shown in Brisbane time", () => {
  const board = buildPipelineBoard([opp(1, { nextActionDueAt: "2026-10-25T23:30:00.000Z", recommendedNextAction: "Call" })]);
  const card = board.find((c) => c.key === "New")!.cards[0];
  assert.match(card.nextAction ?? "", /^Call · 26 Oct 2026/);
});

test("actions mirror the domain lifecycle: manual stages, lost with reason, close", () => {
  assert.deepEqual(opportunityActions(opp(1, { stage: "Contacted" })), {
    stages: ["New", "Qualified"],
    canMarkLost: true,
    canClose: true,
    lockedReason: null,
  });
  const booked = opportunityActions(opp(1, { stage: "AppraisalBooked" }));
  assert.deepEqual(booked.stages, []);
  assert.match(booked.lockedReason ?? "", /appraisal/i);
  const lost = opportunityActions(opp(1, { status: "Lost", stage: "Lost" }));
  assert.equal(lost.canMarkLost, false);
  assert.equal(lost.canClose, false);
  assert.match(lost.lockedReason ?? "", /reopened/i);
});

test("lifecycleBody sends the existing PATCH /lifecycle shapes", () => {
  assert.deepEqual(lifecycleBody({ kind: "stage", stage: "Qualified" }), { ok: true, body: { stage: "Qualified" } });
  assert.deepEqual(lifecycleBody({ kind: "lost", lostReason: "  Sold privately " }), { ok: true, body: { status: "Lost", lostReason: "Sold privately" } });
  assert.equal(lifecycleBody({ kind: "lost", lostReason: "  " }).ok, false);
  assert.equal(lifecycleBody({ kind: "lost", lostReason: "x".repeat(2001) }).ok, false);
  assert.deepEqual(lifecycleBody({ kind: "close" }), { ok: true, body: { status: "Closed" } });
});

test("Market Activity is a deferred, labelled notice", () => {
  assert.equal(MARKET_ACTIVITY_DEFERRED.title, "Market Activity");
  assert.match(MARKET_ACTIVITY_DEFERRED.body, /not connected|deferred/i);
});

test("flag-gated view selector", () => {
  assert.equal(selectOpportunitiesView(false), "classic");
  assert.equal(selectOpportunitiesView(true), "minimal");
});
