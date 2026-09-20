import { TIER_CAPABILITIES } from "./entitlements.js";
import type { SubscriptionTier } from "./types.js";

/**
 * AE GROW post-merge hardening — configurable AI usage limits.
 *
 * This module owns ONE question, purely and without touching the database: given a
 * brokerage's subscription tier and the process environment, what daily AI request limits
 * apply, and were they actually configured by an operator?
 *
 * Why it exists: before this module the only limit was a single per-BROKERAGE daily cap read
 * straight out of TIER_CAPABILITIES.maxAiRequestsPerDay (Starter 20 / Grow 200 / Pro 1000).
 * Those numbers are PROVISIONAL TECHNICAL SAFETY LIMITS, not commercial allowances — they were
 * written when nothing read them (see docs/AE_GROW_PILOT_READINESS_REPORT.md §6.1). They are
 * kept here ONLY as a fallback default for the brokerage-level safety ceiling, and they are
 * explicitly NOT allowed to stand in for a real allowance once a live AI provider is approved
 * (see aiUsageLimitsConfigurationError below).
 *
 * Two independent limits, either of which may be unset or explicitly disabled:
 *
 *   - PER USER      — how many provider-reaching AI requests one authenticated user may make
 *                     in a UTC day. No fallback default: unset means "no per-user limit".
 *   - PER BROKERAGE — a safety ceiling for the whole tenant in a UTC day. Falls back to the
 *                     provisional per-tier number when nothing is configured.
 *
 * A request is refused if it would exceed EITHER (see dailyUsage.ts, which does the counting
 * and the refusing; this module never queries anything).
 *
 * Configuration (environment variables, same style as every other operator knob in this app —
 * a scope-wide default plus optional per-tier overrides):
 *
 *   AI_DAILY_LIMIT_PER_USER                 default per-user limit for every tier
 *   AI_DAILY_LIMIT_PER_USER_STARTER         per-tier override (wins over the default above)
 *   AI_DAILY_LIMIT_PER_USER_GROW
 *   AI_DAILY_LIMIT_PER_USER_PRO
 *   AI_DAILY_LIMIT_PER_BROKERAGE            default brokerage ceiling for every tier
 *   AI_DAILY_LIMIT_PER_BROKERAGE_STARTER    per-tier override (wins over the default above)
 *   AI_DAILY_LIMIT_PER_BROKERAGE_GROW
 *   AI_DAILY_LIMIT_PER_BROKERAGE_PRO
 *
 * Each accepts a positive integer, or one of "off" / "none" / "unlimited" / "disabled" to run
 * that scope with NO limit. "Explicitly disabled" and "never configured" resolve to the same
 * runtime behaviour (no limit) but are deliberately distinguishable — only the former counts as
 * an operator decision for the live-activation check below.
 *
 * Enforcement (whether a resolved limit actually refuses anything) is unchanged from the
 * pre-existing behaviour and lives in isDailyAiCapEnforced() below: AI_DAILY_CAP_ENFORCED wins
 * when set, otherwise the limits apply exactly when a live AI provider is approved. With the
 * pilot's mock provider nothing is throttled — but usage is still metered, because metering is
 * a property of the audit layer (lib/ai/audit.ts writes an ai_interactions row for every
 * request regardless of any of this) and never of enforcement.
 */

export const AI_DAILY_LIMIT_PER_USER_ENV = "AI_DAILY_LIMIT_PER_USER";
export const AI_DAILY_LIMIT_PER_BROKERAGE_ENV = "AI_DAILY_LIMIT_PER_BROKERAGE";

/** The env var carrying a tier-specific override for a scope, e.g. AI_DAILY_LIMIT_PER_USER_GROW. */
export function tierLimitEnvVar(scope: AiUsageLimitScope, tier: SubscriptionTier): string {
  const base = scope === "user" ? AI_DAILY_LIMIT_PER_USER_ENV : AI_DAILY_LIMIT_PER_BROKERAGE_ENV;
  return `${base}_${tier}`;
}

export type AiUsageLimitScope = "user" | "brokerage";

export type EnvSource = Record<string, string | undefined>;

export interface ResolvedAiUsageLimit {
  /** The effective limit, or null when no limit applies to this scope. */
  limit: number | null;
  /** The env var the value came from; null when nothing was configured for this scope. */
  source: string | null;
  /**
   * True when an operator explicitly configured this scope (a number, or an explicit "off").
   * False when the value is a fallback — for the brokerage ceiling, the provisional per-tier
   * number; for the per-user limit, "no limit at all".
   */
  configured: boolean;
  /** True when the value came from TIER_CAPABILITIES rather than any environment variable. */
  provisionalFallback: boolean;
}

export interface InvalidAiUsageLimitSetting {
  name: string;
  raw: string;
}

export interface ResolvedAiUsageLimits {
  tier: SubscriptionTier;
  /** Whether a breached limit actually refuses a request (see isDailyAiCapEnforced). */
  enforced: boolean;
  /** LIVE_AI_PROVIDER_APPROVED, resolved from the SAME env source as everything else here. */
  liveProviderApproved: boolean;
  perUser: ResolvedAiUsageLimit;
  perBrokerage: ResolvedAiUsageLimit;
  /** Environment variables set to something this module could not use. Never silently ignored. */
  invalid: InvalidAiUsageLimitSetting[];
}

type ParsedLimit =
  | { kind: "unset" }
  | { kind: "disabled" }
  | { kind: "limit"; value: number }
  | { kind: "invalid"; raw: string };

const EXPLICITLY_DISABLED_VALUES = new Set(["off", "none", "unlimited", "disabled"]);

/**
 * A deliberately strict parser: anything that is neither a positive integer nor a recognised
 * "no limit" word is INVALID rather than quietly ignored, so a typo in an operator's limit
 * (AI_DAILY_LIMIT_PER_USER=50/day, or =-1) can never read as "unlimited" while enforcement is
 * on. See aiUsageLimitsConfigurationError for what an invalid value actually causes.
 */
export function parseAiUsageLimitValue(raw: string | undefined): ParsedLimit {
  if (raw === undefined) return { kind: "unset" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "unset" };
  if (EXPLICITLY_DISABLED_VALUES.has(trimmed.toLowerCase())) return { kind: "disabled" };
  if (!/^\d+$/.test(trimmed)) return { kind: "invalid", raw: trimmed };
  const value = Number(trimmed);
  // 0 is rejected rather than read as either "unlimited" or "block everything": both readings
  // are plausible, so it must be spelled out ("off", or a real number) instead of guessed.
  if (!Number.isSafeInteger(value) || value <= 0) return { kind: "invalid", raw: trimmed };
  return { kind: "limit", value };
}

function resolveScope(
  scope: AiUsageLimitScope,
  tier: SubscriptionTier,
  env: EnvSource,
  invalid: InvalidAiUsageLimitSetting[],
): ResolvedAiUsageLimit {
  const tierVar = tierLimitEnvVar(scope, tier);
  const defaultVar = scope === "user" ? AI_DAILY_LIMIT_PER_USER_ENV : AI_DAILY_LIMIT_PER_BROKERAGE_ENV;

  // Most specific first: a per-tier override always wins over the scope-wide default.
  for (const name of [tierVar, defaultVar]) {
    const parsed = parseAiUsageLimitValue(env[name]);
    if (parsed.kind === "invalid") {
      invalid.push({ name, raw: parsed.raw });
      continue;
    }
    if (parsed.kind === "unset") continue;
    return {
      limit: parsed.kind === "disabled" ? null : parsed.value,
      source: name,
      configured: true,
      provisionalFallback: false,
    };
  }

  if (scope === "brokerage") {
    // The only fallback default in this module, and only for the safety ceiling: the
    // provisional per-tier number. Never treated as "configured".
    return {
      limit: TIER_CAPABILITIES[tier].maxAiRequestsPerDay,
      source: null,
      configured: false,
      provisionalFallback: true,
    };
  }

  return { limit: null, source: null, configured: false, provisionalFallback: false };
}

/**
 * Whether a breached limit actually refuses a request.
 *
 * Unchanged from the pre-existing per-brokerage cap (this function moved here from
 * dailyUsage.ts, which still re-exports it):
 *
 * - AI_DAILY_CAP_ENFORCED=true / false always wins when set.
 * - Otherwise the limits apply exactly when a real AI provider is approved
 *   (LIVE_AI_PROVIDER_APPROVED=true, see lib/env.ts). With the mock provider — the pilot
 *   default — no provider spend exists, so nothing is throttled.
 *
 * Counting, refusal, audit and 429 paths are always built and tested; only whether the refusal
 * fires depends on this. Metering never depends on it (see this module's header).
 */
export function isDailyAiCapEnforced(env: EnvSource = process.env): boolean {
  const explicit = env.AI_DAILY_CAP_ENFORCED?.trim().toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return isLiveAiProviderApprovedIn(env);
}

/**
 * The same literal-"true" gate as lib/env.ts's isLiveAiProviderApproved(), read from the
 * caller-supplied env source so this module's resolution stays pure and unit-testable without a
 * process-global. dailyUsage.ts's original isDailyAiCapEnforced() already read this variable
 * directly for exactly the same reason, so this is the established shape rather than a second,
 * competing notion of "is a live provider approved" — the authoritative gate that actually
 * decides which provider is constructed remains lib/env.ts's own function, which this never
 * widens (a value this accepts but env.ts would not only ever makes limits MORE strict).
 */
function isLiveAiProviderApprovedIn(env: EnvSource): boolean {
  return env.LIVE_AI_PROVIDER_APPROVED?.trim() === "true";
}

/** Pure, unit-testable resolution. Never reads the database and never throws. */
export function resolveAiUsageLimits(tier: SubscriptionTier, env: EnvSource = process.env): ResolvedAiUsageLimits {
  const invalid: InvalidAiUsageLimitSetting[] = [];
  const perUser = resolveScope("user", tier, env, invalid);
  const perBrokerage = resolveScope("brokerage", tier, env, invalid);
  return {
    tier,
    enforced: isDailyAiCapEnforced(env),
    liveProviderApproved: isLiveAiProviderApprovedIn(env),
    perUser,
    perBrokerage,
    invalid,
  };
}

/**
 * Raised instead of silently falling back to a provisional number. Mapped to a 503 by the AI
 * routes: this is an operator configuration fault, not a client error and not a quota refusal.
 */
export class AiUsageLimitsNotConfiguredError extends Error {
  readonly tier: SubscriptionTier;
  readonly missing: string[];
  constructor(tier: SubscriptionTier, missing: string[], message: string) {
    super(message);
    this.name = "AiUsageLimitsNotConfiguredError";
    this.tier = tier;
    this.missing = missing;
  }
}

function describeConfigurationFault(limits: ResolvedAiUsageLimits): { missing: string[]; reasons: string[] } | null {
  const missing: string[] = [];
  const reasons: string[] = [];

  for (const setting of limits.invalid) {
    missing.push(setting.name);
    reasons.push(
      `${setting.name} is set to ${JSON.stringify(setting.raw)}, which is neither a positive integer nor ` +
        `one of ${[...EXPLICITLY_DISABLED_VALUES].join(" / ")}`,
    );
  }

  // Live activation must be explicit: an approved live provider must never run on the
  // provisional per-tier numbers, and must never run with an accidentally-absent per-user
  // allowance. Either may still be turned off — but only by saying so.
  if (limits.liveProviderApproved) {
    if (!limits.perUser.configured) {
      missing.push(AI_DAILY_LIMIT_PER_USER_ENV);
      reasons.push(
        `no per-user daily AI allowance is configured for the ${limits.tier} tier ` +
          `(set ${AI_DAILY_LIMIT_PER_USER_ENV} or ${tierLimitEnvVar("user", limits.tier)})`,
      );
    }
    if (!limits.perBrokerage.configured) {
      missing.push(AI_DAILY_LIMIT_PER_BROKERAGE_ENV);
      reasons.push(
        `no brokerage daily AI safety ceiling is configured for the ${limits.tier} tier ` +
          `(set ${AI_DAILY_LIMIT_PER_BROKERAGE_ENV} or ${tierLimitEnvVar("brokerage", limits.tier)}); ` +
          "the provisional per-tier numbers in TIER_CAPABILITIES.maxAiRequestsPerDay are technical " +
          "safety defaults, not a commercial allowance, and are not used once a live provider is approved",
      );
    }
  }

  return missing.length === 0 ? null : { missing, reasons };
}

const OPERATOR_GUIDANCE =
  `Set ${AI_DAILY_LIMIT_PER_USER_ENV} and ${AI_DAILY_LIMIT_PER_BROKERAGE_ENV} (or their per-tier ` +
  `overrides ${AI_DAILY_LIMIT_PER_USER_ENV}_STARTER/_GROW/_PRO and ` +
  `${AI_DAILY_LIMIT_PER_BROKERAGE_ENV}_STARTER/_GROW/_PRO) to a positive integer, or to "off" to run ` +
  "that scope without a limit.";

/**
 * Returns the fault to fail closed on, or null when this configuration is usable.
 *
 * Two distinct faults, both deliberate:
 *   - an UNUSABLE value (a typo) is a fault whenever limits are enforced, whatever the provider:
 *     an enforced limiter must never quietly ignore what an operator wrote;
 *   - MISSING configuration is a fault only once a live AI provider is approved — the pilot's
 *     mock-provider default keeps working with no new environment variables at all.
 */
export function aiUsageLimitsConfigurationError(limits: ResolvedAiUsageLimits): AiUsageLimitsNotConfiguredError | null {
  // Nothing is being refused, so neither an unusable value nor a missing allowance can silently
  // change any outcome yet; an unusable value is still surfaced at boot by
  // assertAiUsageLimitsConfigured() rather than by failing every request in the pilot.
  if (!limits.enforced) return null;
  const fault = describeConfigurationFault(limits);
  if (fault === null) return null;
  return new AiUsageLimitsNotConfiguredError(
    limits.tier,
    [...new Set(fault.missing)],
    `Daily AI usage limits are not usable for the ${limits.tier} tier: ${fault.reasons.join("; ")}. ` +
      `Refusing to serve AI requests rather than fall back to an unconfigured limit. ${OPERATOR_GUIDANCE}`,
  );
}

/**
 * Resolution plus the fail-closed check, for use at the point of use. Throws
 * AiUsageLimitsNotConfiguredError rather than returning a limit nobody decided on.
 */
export function getEffectiveAiUsageLimits(tier: SubscriptionTier, env: EnvSource = process.env): ResolvedAiUsageLimits {
  const limits = resolveAiUsageLimits(tier, env);
  const error = aiUsageLimitsConfigurationError(limits);
  if (error !== null) throw error;
  return limits;
}

const ALL_TIERS: SubscriptionTier[] = ["STARTER", "GROW", "PRO"];

/**
 * Boot-time fail-closed check, in the same style as assertSessionSecretConfigured() /
 * assertMetricsAuthConfigured() / assertAuthEmailProviderConfigured() (see index.ts): a process
 * approved to send real brokerage and contact data to a real model provider must not start
 * without an explicit decision about how much of that it may do per user and per brokerage.
 *
 * Checks every tier, because a brokerage's tier is only known per request: setting just the two
 * scope-wide defaults satisfies this for all three tiers, as does setting all six per-tier vars.
 *
 * Deliberately a no-op when limits are not enforced — including the one explicit escape hatch,
 * AI_DAILY_CAP_ENFORCED=false with a live provider, which is an operator saying "no daily limits"
 * out loud. That case is logged as a warning rather than silently accepted.
 */
export function assertAiUsageLimitsConfigured(
  env: EnvSource = process.env,
  warn: (event: string, detail: Record<string, unknown>) => void = () => {},
): void {
  if (isLiveAiProviderApprovedIn(env) && !isDailyAiCapEnforced(env)) {
    warn("ai_daily_limits_explicitly_disabled", {
      detail:
        "LIVE_AI_PROVIDER_APPROVED=true with AI_DAILY_CAP_ENFORCED=false: no per-user or per-brokerage " +
        "daily AI limit will be enforced against a real provider. This is an explicit operator decision.",
    });
    return;
  }
  for (const tier of ALL_TIERS) {
    const error = aiUsageLimitsConfigurationError(resolveAiUsageLimits(tier, env));
    if (error !== null) {
      throw new Error(`Refusing to start: ${error.message}`);
    }
  }
  // An unusable value while nothing is enforced cannot change an outcome today, but it is still
  // wrong and will start refusing requests the moment enforcement is switched on.
  for (const tier of ALL_TIERS) {
    for (const setting of resolveAiUsageLimits(tier, env).invalid) {
      warn("ai_daily_limit_value_unusable", { name: setting.name, raw: setting.raw, detail: OPERATOR_GUIDANCE });
    }
  }
}
