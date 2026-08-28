import { test } from "node:test";
import assert from "node:assert/strict";
import { isRoleEntitled, resolveBrokerageTier, TIER_CAPABILITIES } from "../entitlements.js";

test("resolveBrokerageTier always returns STARTER (no subscription concept exists yet)", () => {
  assert.equal(resolveBrokerageTier(1), "STARTER");
  assert.equal(resolveBrokerageTier(999), "STARTER");
});

test("STARTER tier is entitled to copilot but not to any other role", () => {
  assert.equal(isRoleEntitled("STARTER", "copilot"), true);
  assert.equal(isRoleEntitled("STARTER", "proactive_intelligence"), false);
  assert.equal(isRoleEntitled("STARTER", "business_coach"), false);
  assert.equal(isRoleEntitled("STARTER", "workflow_ai"), false);
  assert.equal(isRoleEntitled("STARTER", "pitcrew_ai"), false);
});

test("PRO tier is entitled to every role", () => {
  for (const role of Object.keys(TIER_CAPABILITIES.PRO.roles)) {
    assert.equal(isRoleEntitled("PRO", role as keyof typeof TIER_CAPABILITIES.PRO.roles), true);
  }
});

test("GROW tier sits strictly between STARTER and PRO", () => {
  assert.equal(isRoleEntitled("GROW", "copilot"), true);
  assert.equal(isRoleEntitled("GROW", "business_coach"), true);
  assert.equal(isRoleEntitled("GROW", "workflow_ai"), false);
  assert.equal(isRoleEntitled("GROW", "pitcrew_ai"), false);
});
