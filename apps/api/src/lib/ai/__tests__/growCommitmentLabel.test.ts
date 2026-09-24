import assert from "node:assert/strict";
import test from "node:test";
import { ACTION_REGISTRY } from "../actions/registry.js";

// G-6 — the proposal the agent reads is a commitment. The sentence used to
// call that record a "follow-up commitment", which is a different Grow record
// (an opportunity or appraisal due follow-up). Governance is unchanged.

test("G-6: CREATE_GROW_COMMITMENT's shown name is a commitment", () => {
  const action = ACTION_REGISTRY.CREATE_GROW_COMMITMENT!;
  assert.equal(action.name, "Create Grow commitment");
  assert.equal(/follow-up/i.test(action.name), false);
  assert.match(action.description, /not an opportunity or appraisal due follow-up/);
  assert.equal(/follow-up commitment/i.test(action.description), false);
  const summary = action.summarize({
    partyId: 289,
    description: "Call back",
    dueAt: "2026-09-25T00:00:00.000Z",
    reason: "They asked",
  });
  assert.equal(summary, 'Create a commitment for contact #289: "Call back" (due 2026-09-25T00:00:00.000Z)');
  assert.equal(/follow-up/i.test(summary), false);
});
