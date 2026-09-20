// AE GROW post-merge hardening — unit coverage for the AI usage-limit RESOLVER
// (lib/ai/usageLimits.ts). Deliberately pure: every case below passes an explicit env object
// rather than mutating process.env, which is what makes this module unit-testable at all and
// is the reason limit resolution was pulled out of dailyUsage.ts/routes in the first place.
//
// Enforcement-gate coverage (isDailyAiCapEnforced) lives in dailyCapEnforcement.test.ts, which
// is unchanged — that function moved here but kept its behaviour and its re-export from
// dailyUsage.ts exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_DAILY_LIMIT_PER_BROKERAGE_ENV,
  AI_DAILY_LIMIT_PER_USER_ENV,
  AiUsageLimitsNotConfiguredError,
  aiUsageLimitsConfigurationError,
  assertAiUsageLimitsConfigured,
  getEffectiveAiUsageLimits,
  parseAiUsageLimitValue,
  resolveAiUsageLimits,
  tierLimitEnvVar,
} from "../usageLimits.js";
import { TIER_CAPABILITIES } from "../entitlements.js";

const ENFORCED = { AI_DAILY_CAP_ENFORCED: "true" };
const LIVE = { LIVE_AI_PROVIDER_APPROVED: "true" };

test("a value is a positive integer, an explicit off-switch, or invalid — never guessed", () => {
  assert.deepEqual(parseAiUsageLimitValue(undefined), { kind: "unset" });
  assert.deepEqual(parseAiUsageLimitValue("   "), { kind: "unset" });
  assert.deepEqual(parseAiUsageLimitValue(" 50 "), { kind: "limit", value: 50 });
  for (const off of ["off", "OFF", "none", "unlimited", "disabled"]) {
    assert.deepEqual(parseAiUsageLimitValue(off), { kind: "disabled" }, off);
  }
  // 0 is ambiguous (unlimited? block everything?) and a typo must never read as "unlimited".
  for (const bad of ["0", "-1", "50/day", "1e3", "20.5", "twenty"]) {
    assert.equal(parseAiUsageLimitValue(bad).kind, "invalid", bad);
  }
});

test("with no configuration at all: no per-user limit, and the brokerage ceiling falls back to the provisional per-tier number", () => {
  for (const tier of ["STARTER", "GROW", "PRO"] as const) {
    const limits = resolveAiUsageLimits(tier, {});
    assert.equal(limits.perUser.limit, null);
    assert.equal(limits.perUser.configured, false);
    assert.equal(limits.perBrokerage.limit, TIER_CAPABILITIES[tier].maxAiRequestsPerDay);
    assert.equal(limits.perBrokerage.configured, false, "a fallback is never an operator decision");
    assert.equal(limits.perBrokerage.provisionalFallback, true);
    assert.equal(limits.enforced, false, "the pilot's mock-provider default throttles nothing");
  }
});

test("the two limits resolve independently, and either may be explicitly disabled", () => {
  const limits = resolveAiUsageLimits("GROW", {
    [AI_DAILY_LIMIT_PER_USER_ENV]: "25",
    [AI_DAILY_LIMIT_PER_BROKERAGE_ENV]: "off",
  });
  assert.deepEqual(limits.perUser, {
    limit: 25,
    source: AI_DAILY_LIMIT_PER_USER_ENV,
    configured: true,
    provisionalFallback: false,
  });
  assert.deepEqual(limits.perBrokerage, {
    limit: null,
    source: AI_DAILY_LIMIT_PER_BROKERAGE_ENV,
    configured: true,
    provisionalFallback: false,
  });

  const other = resolveAiUsageLimits("GROW", { [AI_DAILY_LIMIT_PER_BROKERAGE_ENV]: "900" });
  assert.equal(other.perUser.limit, null, "configuring one scope must not configure the other");
  assert.equal(other.perBrokerage.limit, 900);
});

test("a per-tier override wins over the scope-wide default, per scope and per tier", () => {
  const env = {
    [AI_DAILY_LIMIT_PER_USER_ENV]: "10",
    [tierLimitEnvVar("user", "PRO")]: "400",
    [AI_DAILY_LIMIT_PER_BROKERAGE_ENV]: "500",
    [tierLimitEnvVar("brokerage", "STARTER")]: "40",
  };
  assert.equal(resolveAiUsageLimits("STARTER", env).perUser.limit, 10);
  assert.equal(resolveAiUsageLimits("GROW", env).perUser.limit, 10);
  assert.equal(resolveAiUsageLimits("PRO", env).perUser.limit, 400);
  assert.equal(resolveAiUsageLimits("PRO", env).perUser.source, tierLimitEnvVar("user", "PRO"));
  assert.equal(resolveAiUsageLimits("STARTER", env).perBrokerage.limit, 40);
  assert.equal(resolveAiUsageLimits("PRO", env).perBrokerage.limit, 500);
});

test("an unusable value is recorded, never silently ignored — and falls through to the next source", () => {
  const env = { [tierLimitEnvVar("user", "GROW")]: "50/day", [AI_DAILY_LIMIT_PER_USER_ENV]: "30" };
  const limits = resolveAiUsageLimits("GROW", env);
  assert.equal(limits.perUser.limit, 30);
  assert.deepEqual(limits.invalid, [{ name: tierLimitEnvVar("user", "GROW"), raw: "50/day" }]);
});

test("nothing fails closed while limits are not enforced — the mock-provider pilot needs no new configuration", () => {
  assert.equal(aiUsageLimitsConfigurationError(resolveAiUsageLimits("STARTER", {})), null);
  // Even an unusable value cannot change an outcome while nothing is being refused.
  assert.equal(aiUsageLimitsConfigurationError(resolveAiUsageLimits("STARTER", { [AI_DAILY_LIMIT_PER_USER_ENV]: "oops" })), null);
  assert.doesNotThrow(() => assertAiUsageLimitsConfigured({}));
});

test("enforcement WITHOUT a live provider keeps using the provisional ceiling — the pre-existing cap, unchanged", () => {
  const limits = resolveAiUsageLimits("STARTER", ENFORCED);
  assert.equal(limits.enforced, true);
  assert.equal(limits.perBrokerage.limit, TIER_CAPABILITIES.STARTER.maxAiRequestsPerDay);
  assert.equal(aiUsageLimitsConfigurationError(limits), null);
  assert.doesNotThrow(() => assertAiUsageLimitsConfigured(ENFORCED));
});

test("an unusable value while enforced fails closed rather than quietly applying a different limit", () => {
  const env = { ...ENFORCED, [AI_DAILY_LIMIT_PER_BROKERAGE_ENV]: "-5" };
  const error = aiUsageLimitsConfigurationError(resolveAiUsageLimits("GROW", env));
  assert.ok(error instanceof AiUsageLimitsNotConfiguredError);
  assert.match(error.message, /-5/);
  assert.ok(error.missing.includes(AI_DAILY_LIMIT_PER_BROKERAGE_ENV));
  assert.throws(() => assertAiUsageLimitsConfigured(env), /Refusing to start/);
});

test("live activation without configuration fails closed, naming both missing variables", () => {
  const error = aiUsageLimitsConfigurationError(resolveAiUsageLimits("GROW", LIVE));
  assert.ok(error instanceof AiUsageLimitsNotConfiguredError);
  assert.deepEqual(error.missing.sort(), [AI_DAILY_LIMIT_PER_BROKERAGE_ENV, AI_DAILY_LIMIT_PER_USER_ENV].sort());
  assert.match(error.message, /not a commercial allowance/);
  assert.match(error.message, /Refusing to serve AI requests/);
  assert.throws(() => assertAiUsageLimitsConfigured(LIVE), /Refusing to start/);
  assert.throws(() => getEffectiveAiUsageLimits("GROW", LIVE), AiUsageLimitsNotConfiguredError);
});

test("live activation with only ONE of the two limits configured still fails closed", () => {
  const onlyUser = resolveAiUsageLimits("GROW", { ...LIVE, [AI_DAILY_LIMIT_PER_USER_ENV]: "25" });
  assert.deepEqual(aiUsageLimitsConfigurationError(onlyUser)?.missing, [AI_DAILY_LIMIT_PER_BROKERAGE_ENV]);
  assert.equal(
    onlyUser.perBrokerage.provisionalFallback,
    true,
    "the provisional number is still what resolution would have produced — which is exactly why it must not be served",
  );

  const onlyBrokerage = resolveAiUsageLimits("GROW", { ...LIVE, [AI_DAILY_LIMIT_PER_BROKERAGE_ENV]: "900" });
  assert.deepEqual(aiUsageLimitsConfigurationError(onlyBrokerage)?.missing, [AI_DAILY_LIMIT_PER_USER_ENV]);
});

test("live activation is satisfied by explicitly turning a scope off — a decision, not an omission", () => {
  const env = { ...LIVE, [AI_DAILY_LIMIT_PER_USER_ENV]: "off", [AI_DAILY_LIMIT_PER_BROKERAGE_ENV]: "2000" };
  const limits = resolveAiUsageLimits("PRO", env);
  assert.equal(limits.perUser.limit, null);
  assert.equal(limits.perUser.configured, true);
  assert.equal(aiUsageLimitsConfigurationError(limits), null);
  assert.doesNotThrow(() => assertAiUsageLimitsConfigured(env));
});

test("the boot check covers every tier, so a per-tier-only configuration must cover every tier", () => {
  const partial = {
    ...LIVE,
    [tierLimitEnvVar("user", "PRO")]: "400",
    [tierLimitEnvVar("brokerage", "PRO")]: "2000",
  };
  assert.equal(aiUsageLimitsConfigurationError(resolveAiUsageLimits("PRO", partial)), null);
  assert.throws(() => assertAiUsageLimitsConfigured(partial), /STARTER/);

  const complete = {
    ...partial,
    [AI_DAILY_LIMIT_PER_USER_ENV]: "25",
    [AI_DAILY_LIMIT_PER_BROKERAGE_ENV]: "500",
  };
  assert.doesNotThrow(() => assertAiUsageLimitsConfigured(complete));
});

test("a live provider with the cap explicitly switched off is allowed, but warned about rather than hidden", () => {
  const warnings: string[] = [];
  assert.doesNotThrow(() =>
    assertAiUsageLimitsConfigured({ ...LIVE, AI_DAILY_CAP_ENFORCED: "false" }, (event) => warnings.push(event)),
  );
  assert.deepEqual(warnings, ["ai_daily_limits_explicitly_disabled"]);
});

test("an unusable value that is not yet enforced is warned about at boot instead of failing every request", () => {
  const warnings: { event: string; detail: Record<string, unknown> }[] = [];
  assert.doesNotThrow(() =>
    assertAiUsageLimitsConfigured({ [AI_DAILY_LIMIT_PER_USER_ENV]: "20.5" }, (event, detail) => warnings.push({ event, detail })),
  );
  assert.ok(warnings.length > 0);
  assert.equal(warnings[0]?.event, "ai_daily_limit_value_unusable");
  assert.equal(warnings[0]?.detail.raw, "20.5");
});
