// AB-6: each step saves on its own; save-and-resume across all seven steps.
import assert from "node:assert/strict";
import test from "node:test";
import {
  type BuilderWorkspace,
  UNSAVED_NARRATIVE_MESSAGE,
  UNSAVED_RANGE_MESSAGE,
  builderStepsSaved,
  continueBuilder,
  rangeDraftFrom,
  resumeBuilderState,
  unsavedStepEdits,
} from "../../minimal/appraisal/appraisalBuilderModel";

const RATIONALE = "Three recent sales on the same street support this range.";

function ws(over: Partial<BuilderWorkspace["appraisal"]> = {}, comps = 0, listings = 0): BuilderWorkspace {
  return {
    appraisal: {
      id: 1, propertyId: 7, partyId: 3, status: "DRAFT", isFinalised: false,
      priceRangeLow: null, priceRangeHigh: null, pricingCommentary: null,
      marketPositionNarrative: null, presentationDocumentId: null, followUpAt: null, ...over,
    },
    comparableSales: Array.from({ length: comps }, (_, i) => ({ id: i + 1 }) as BuilderWorkspace["comparableSales"][number]),
    marketCompetition: Array.from({ length: listings }, (_, i) => ({ id: i + 1 }) as BuilderWorkspace["marketCompetition"][number]),
  };
}

// The server state after each step's own save, in order.
const progression: Array<{ after: string; w: BuilderWorkspace; resume: number; saved: number[] }> = [
  { after: "created (step 1)", w: ws(), resume: 2, saved: [1] },
  { after: "step 3 comparable saved", w: ws({}, 1), resume: 4, saved: [1, 2, 3] },
  { after: "step 4 listing saved", w: ws({}, 1, 1), resume: 5, saved: [1, 2, 3, 4] },
  { after: "step 5 range saved", w: ws({ priceRangeLow: "800000.00", priceRangeHigh: "860000.00", pricingCommentary: RATIONALE }, 1, 1), resume: 6, saved: [1, 2, 3, 4, 5] },
  { after: "step 6 document built", w: ws({ priceRangeLow: "800000.00", priceRangeHigh: "860000.00", pricingCommentary: RATIONALE, presentationDocumentId: 99 }, 1, 1), resume: 7, saved: [1, 2, 3, 4, 5, 6] },
  { after: "step 7 follow-up saved", w: ws({ priceRangeLow: "800000.00", priceRangeHigh: "860000.00", pricingCommentary: RATIONALE, presentationDocumentId: 99, followUpAt: "2026-11-02T00:00:00Z" }, 1, 1), resume: 7, saved: [1, 2, 3, 4, 5, 6, 7] },
];

for (const p of progression) {
  test(`resume after ${p.after}: lands at step ${p.resume}; saved steps ${p.saved.join(",")}`, () => {
    const r = resumeBuilderState(p.w);
    assert.equal(r.step, p.resume);
    assert.equal(r.highestStep, p.resume);
    const saved = builderStepsSaved(p.w);
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].filter((n) => saved[n]), p.saved);
  });
}

test("each step's save is independent: one save never marks a later step saved", () => {
  const onlyRange = ws({ priceRangeLow: "800000.00", priceRangeHigh: "860000.00", pricingCommentary: RATIONALE });
  const s = builderStepsSaved(onlyRange);
  assert.equal(s[3], false, "no comparable → step 3 not saved");
  assert.equal(s[5], true);
  assert.equal(s[6], false);
  assert.equal(resumeBuilderState(onlyRange).step, 3, "resume at the first unsaved step, never past a gap");
  const onlyFollowUp = builderStepsSaved(ws({ followUpAt: "2026-11-02T00:00:00Z" }));
  assert.equal(onlyFollowUp[7], true);
  assert.equal(onlyFollowUp[5], false);
});

test("an invalid stored range (too-short explanation) does not count as saved", () => {
  const w = ws({ priceRangeLow: "800000.00", priceRangeHigh: "860000.00", pricingCommentary: "short" }, 1, 1);
  assert.equal(builderStepsSaved(w)[5], false);
  assert.equal(resumeBuilderState(w).step, 5);
});

test("resumed state lets Continue proceed from every completed step and gates the first incomplete one", () => {
  const full = progression[4].w;
  let state = { step: 1, highestStep: 1 };
  for (let n = 1; n < 7; n++) {
    const r = continueBuilder(state, { workspace: full, rangeDraft: rangeDraftFrom(full.appraisal) });
    assert.equal(r.message, null, `step ${n}`);
    state = r.state;
  }
  assert.equal(state.step, 7);
  const noComps = progression[0].w;
  const gated = continueBuilder({ step: 3, highestStep: 3 }, { workspace: noComps, rangeDraft: rangeDraftFrom(noComps.appraisal) });
  assert.equal(gated.state.step, 3);
  assert.ok(gated.message);
});

test("read-only (finished/finalised) appraisals can browse all seven steps", () => {
  assert.equal(resumeBuilderState(ws({ status: "WON" })).highestStep, 7);
  assert.equal(resumeBuilderState(ws({ isFinalised: true })).highestStep, 7);
});

test("unsaved typing on step 5/6 warns before leaving; saved or untouched does not", () => {
  const a = progression[3].w.appraisal;
  assert.equal(unsavedStepEdits(5, { range: null, narrative: null }, a), null);
  assert.equal(unsavedStepEdits(5, { range: rangeDraftFrom(a), narrative: null }, a), null);
  assert.equal(unsavedStepEdits(5, { range: { ...rangeDraftFrom(a), high: "900000" }, narrative: null }, a), UNSAVED_RANGE_MESSAGE);
  assert.equal(unsavedStepEdits(6, { range: null, narrative: "New commentary" }, a), UNSAVED_NARRATIVE_MESSAGE);
  assert.equal(unsavedStepEdits(6, { range: null, narrative: "" }, a), null);
  assert.equal(unsavedStepEdits(3, { range: { low: "1", high: "2", commentary: "" }, narrative: "x" }, a), null);
});
