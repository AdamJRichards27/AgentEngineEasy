import { test } from "node:test";
import assert from "node:assert/strict";
import { isDailyAiCapEnforced } from "../dailyUsage.js";

/**
 * The per-tier daily numbers were never tuned for real use and are per
 * brokerage, so enforcing them unconditionally would be a product change.
 * They apply exactly when a real AI provider is approved, unless an operator
 * says otherwise.
 */
function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the daily AI cap is not enforced while the mock provider is in use (no approved live provider)", () => {
  withEnv({ AI_DAILY_CAP_ENFORCED: undefined, LIVE_AI_PROVIDER_APPROVED: undefined }, () => {
    assert.equal(isDailyAiCapEnforced(), false);
  });
  withEnv({ AI_DAILY_CAP_ENFORCED: undefined, LIVE_AI_PROVIDER_APPROVED: "false" }, () => {
    assert.equal(isDailyAiCapEnforced(), false);
  });
});

test("approving a live AI provider enforces the cap without any extra configuration", () => {
  withEnv({ AI_DAILY_CAP_ENFORCED: undefined, LIVE_AI_PROVIDER_APPROVED: "true" }, () => {
    assert.equal(isDailyAiCapEnforced(), true);
  });
});

test("an explicit AI_DAILY_CAP_ENFORCED setting always wins, in both directions", () => {
  withEnv({ AI_DAILY_CAP_ENFORCED: "true", LIVE_AI_PROVIDER_APPROVED: undefined }, () => {
    assert.equal(isDailyAiCapEnforced(), true);
  });
  withEnv({ AI_DAILY_CAP_ENFORCED: "TRUE ", LIVE_AI_PROVIDER_APPROVED: "false" }, () => {
    assert.equal(isDailyAiCapEnforced(), true);
  });
  withEnv({ AI_DAILY_CAP_ENFORCED: "false", LIVE_AI_PROVIDER_APPROVED: "true" }, () => {
    assert.equal(isDailyAiCapEnforced(), false);
  });
  withEnv({ AI_DAILY_CAP_ENFORCED: "yes", LIVE_AI_PROVIDER_APPROVED: "true" }, () => {
    assert.equal(isDailyAiCapEnforced(), true, "an unrecognised value falls through to the provider gate");
  });
});
