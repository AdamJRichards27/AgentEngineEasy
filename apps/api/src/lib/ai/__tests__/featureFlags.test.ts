import { test } from "node:test";
import assert from "node:assert/strict";
import { isAiEnabled, isGrowCallSummaryEnabled, isRoleEnabled } from "../featureFlags.js";

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    run();
  } finally {
    for (const key of Object.keys(previous)) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("copilot defaults to enabled, every other role defaults to disabled", () => {
  withEnv(
    {
      AI_ENABLED: undefined,
      AI_COPILOT_ENABLED: undefined,
      AI_PROACTIVE_INTELLIGENCE_ENABLED: undefined,
      AI_BUSINESS_COACH_ENABLED: undefined,
      AI_WORKFLOW_AI_ENABLED: undefined,
      AI_PITCREW_AI_ENABLED: undefined,
    },
    () => {
      assert.equal(isAiEnabled(), true);
      assert.equal(isRoleEnabled("copilot"), true);
      assert.equal(isRoleEnabled("proactive_intelligence"), false);
      assert.equal(isRoleEnabled("business_coach"), false);
      assert.equal(isRoleEnabled("workflow_ai"), false);
      assert.equal(isRoleEnabled("pitcrew_ai"), false);
    }
  );
});

test("the master AI_ENABLED switch overrides every per-role flag - never UI-only", () => {
  withEnv({ AI_ENABLED: "false", AI_COPILOT_ENABLED: "true" }, () => {
    assert.equal(isRoleEnabled("copilot"), false);
  });
});

test("a role flag explicitly set to true is honored when AI_ENABLED is on", () => {
  withEnv({ AI_ENABLED: "true", AI_BUSINESS_COACH_ENABLED: "true" }, () => {
    assert.equal(isRoleEnabled("business_coach"), true);
  });
});

test("call summary drafting defaults off and uses the existing boolean parser", () => {
  for (const value of [undefined, "", "false", "1", "yes", " true "]) {
    withEnv({ AI_ENABLED: undefined, AI_GROW_CALL_SUMMARY_ENABLED: value }, () => {
      assert.equal(isGrowCallSummaryEnabled(), false);
    });
  }
  for (const value of ["true", "TRUE", "True"]) {
    withEnv({ AI_ENABLED: undefined, AI_GROW_CALL_SUMMARY_ENABLED: value }, () => {
      assert.equal(isGrowCallSummaryEnabled(), true);
    });
  }
});

test("the master switch overrides call summary drafting independently of role flags", () => {
  withEnv({ AI_ENABLED: "false", AI_GROW_CALL_SUMMARY_ENABLED: "true" }, () => {
    assert.equal(isGrowCallSummaryEnabled(), false);
  });
  withEnv({
    AI_ENABLED: "true",
    AI_GROW_CALL_SUMMARY_ENABLED: "true",
    AI_COPILOT_ENABLED: "false",
    AI_PITCREW_AI_ENABLED: "false",
  }, () => {
    assert.equal(isGrowCallSummaryEnabled(), true);
    assert.equal(isRoleEnabled("copilot"), false);
    assert.equal(isRoleEnabled("pitcrew_ai"), false);
  });
});
