import { test } from "node:test";
import assert from "node:assert/strict";
import { countOpenOpportunities, opportunityLifecycleOpen, opportunityStatusLabel } from "../growContact360";

test("opportunityLifecycleOpen: only Open at a non-terminal stage", () => {
  assert.equal(opportunityLifecycleOpen("Open", "Qualify"), true);
  assert.equal(opportunityLifecycleOpen("Open", "Lost"), false);
  assert.equal(opportunityLifecycleOpen("Open", "Converted"), false);
  assert.equal(opportunityLifecycleOpen("Lost", "Qualify"), false);
});

test("opportunityStatusLabel: Lost names a trimmed stored reason", () => {
  assert.equal(opportunityStatusLabel("Open", "x"), "Open");
  assert.equal(opportunityStatusLabel("Lost", "  Listed elsewhere "), "Lost: Listed elsewhere");
  assert.equal(opportunityStatusLabel("Lost", "   "), "Lost");
  assert.equal(opportunityStatusLabel("Lost", null), "Lost");
  assert.equal(opportunityStatusLabel("Lost", undefined), "Lost");
});

test("countOpenOpportunities: Lost and Converted are never open (Owner t388u)", () => {
  assert.equal(countOpenOpportunities([]), 0);
  assert.equal(
    countOpenOpportunities([
      { status: "Open", stage: "New" },
      { status: "Open", stage: "Lost" },
      { status: "Open", stage: "Converted" },
      { status: "Lost", stage: "Lost" },
    ]),
    1,
  );
});
