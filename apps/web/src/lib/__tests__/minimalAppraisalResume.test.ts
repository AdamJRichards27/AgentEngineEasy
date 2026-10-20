// AB-2: reopening the Minimal Appraisal Builder resumes at the furthest step
// the SERVER state supports (no browser drafts), not always at step 1.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as model from "../../minimal/appraisal/appraisalBuilderModel";
import type { BuilderWorkspace } from "../../minimal/appraisal/appraisalBuilderModel";

function ws(a: Partial<BuilderWorkspace["appraisal"]> = {}, extra: Partial<BuilderWorkspace> = {}): BuilderWorkspace {
  return {
    appraisal: { id: 41, propertyId: 7, partyId: 3, status: "DRAFT", isFinalised: false, priceRangeLow: null, priceRangeHigh: null,
      pricingCommentary: null, marketPositionNarrative: null, presentationDocumentId: null, followUpAt: null, ...a },
    comparableSales: [], marketCompetition: [], ...extra,
  };
}
const comp = { id: 1, address: "4 Park Rd", salePrice: "1200000.00", saleDate: "2026-08-01T00:00:00.000Z", bedrooms: 3, bathrooms: 2, carSpaces: 1, notes: null };
const listing = { id: 2, address: "9 Hill St", askingPriceDisplay: "$1.3m", status: "active", daysOnMarket: 12, notes: null };
const range = { priceRangeLow: "1300000.00", priceRangeHigh: "1400000.00", pricingCommentary: "Two close sold comparables support this range." };
const resume = (w: BuilderWorkspace) => (model as unknown as { resumeBuilderState: (w: BuilderWorkspace) => model.BuilderState }).resumeBuilderState(w);

test("AB-2: a new appraisal with only a property resumes at step 2 (Enrich)", () => {
  assert.deepEqual(resume(ws()), { step: 2, highestStep: 2 });
});

test("AB-2: saved comparables move the resume point to Competition (step 4)", () => {
  assert.deepEqual(resume(ws({}, { comparableSales: [comp] })), { step: 4, highestStep: 4 });
});

test("AB-2: comparables + competition resume at Range (step 5)", () => {
  assert.deepEqual(resume(ws({}, { comparableSales: [comp], marketCompetition: [listing] })), { step: 5, highestStep: 5 });
});

test("AB-2: a saved valid range resumes at Build (step 6), and a built document at Save (step 7)", () => {
  assert.deepEqual(resume(ws(range, { comparableSales: [comp] })), { step: 6, highestStep: 6 });
  assert.deepEqual(resume(ws({ ...range, presentationDocumentId: 9 }, { comparableSales: [comp] })), { step: 7, highestStep: 7 });
});

test("AB-2: never skips a failing gate — a saved range without comparables resumes at step 3", () => {
  assert.deepEqual(resume(ws(range)), { step: 3, highestStep: 3 });
});

test("AB-2: an invalid saved range (rationale too short) stops at step 5", () => {
  assert.deepEqual(resume(ws({ ...range, pricingCommentary: "short" }, { comparableSales: [comp], marketCompetition: [listing] })), { step: 5, highestStep: 5 });
});

test("AB-2: no property resumes at step 1", () => {
  assert.deepEqual(resume(ws({ propertyId: 0 as unknown as number })), { step: 1, highestStep: 1 });
});

test("AB-2: a finished appraisal opens at its furthest step with every step browsable", () => {
  const r = resume(ws({ ...range, presentationDocumentId: 9, status: "WON", isFinalised: true }, { comparableSales: [comp] }));
  assert.equal(r.highestStep, 7);
  assert.equal(r.step, 7);
});

test("AB-2: the page applies the server resume state once when the workspace first loads", () => {
  const src = readFileSync(new URL("../../minimal/appraisal/MinimalAppraisalBuilder.tsx", import.meta.url), "utf8");
  assert.match(src, /resumeBuilderState\(/);
  assert.match(src, /resumed\.current/);
});
