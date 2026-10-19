// WS4-09 / WS4-11 — request-path outbound policy for restored environments.
//
// WS4-07 (lib/restoredEnvironment.ts) keeps every boot-time loop off when AEE_RESTORED_ENVIRONMENT is set. This module
// is the request-path half, with the same switch and the same parsing (unknown values = restored, fail closed).
//
// Policy in a restored environment (WS4-11 D-MOCK):
//   * a provider classified IN_PROCESS (no network call; evidence in PROVIDERS) is allowed — so UAT can use mock AI,
//     mock transcription, the in-process sandbox comms/telephony adapters and the mock payment/e-sign/AML/billing/
//     mandate adapters;
//   * a provider classified NETWORK, or not classified at all (fail closed), is refused with
//     RestoredEnvironmentOutboundBlockedError unless its exact `channel:provider` pair is in
//     AEE_RESTORED_ENV_OUTBOUND_ALLOW (default empty);
//   * auth_email is refused whatever the provider (D-PR / D-INV: restored data holds real people's addresses and the
//     sandbox's pilot mode emits hand-deliverable credential links) and cannot be allow-listed;
//   * document object-storage WRITES (putObject/deleteObject) are refused unless AEE_RESTORED_ENV_STORAGE_ISOLATED is
//     exactly "true" (D-OS); reads are allowed.
//
// The refusal is code RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED; middlewares/errorHandler.ts maps it to HTTP 503 (the
// request is valid and authorised; the server deliberately does not perform the dependency here — RFC 9110 §15.6.4;
// matches routes/ai.ts AI_USAGE_LIMITS_NOT_CONFIGURED). Not 403 (no authorisation decision), not 501, not 502/504.
//
// AEE_RESTORED_ENV_OUTBOUND_ALLOW — name and format:
//   * AEE_ prefix like every switch here; RESTORED_ENV_ scopes it to restored environments, the same stem Grok chose
//     for AEE_RESTORED_ENV_STORAGE_ISOLATED; OUTBOUND_ALLOW says what it does (an allow-list, never a deny-list).
//   * value: comma-separated `channel:provider` pairs, e.g. `ai_provider:anthropic,operational_alerts:webhook`.
//     Pairs (not bare provider names) so allowing one provider never silently allows a same-named one on another
//     channel; exact, case-sensitive, no wildcards. Unknown channels, auth_email entries and malformed entries are
//     ignored (fail closed) with a logged reason. Unset/empty = nothing allow-listed.
import { logger } from "@aee/events";
import { RESTORED_ENVIRONMENT_ENV, restoredEnvironmentMode, type RestoredEnvironmentReason } from "./restoredEnvironment.js";

export const RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED = "RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED" as const;
export const RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED_HTTP_STATUS = 503 as const;
export const RESTORED_ENV_OUTBOUND_ALLOW_ENV = "AEE_RESTORED_ENV_OUTBOUND_ALLOW" as const;
export const RESTORED_ENV_STORAGE_ISOLATED_ENV = "AEE_RESTORED_ENV_STORAGE_ISOLATED" as const;

type Env = Record<string, string | undefined>;

/**
 * Every outbound channel, the file holding its guard, and the files (repo-root relative) that open a transport for
 * it. lib/__tests__/outboundGuard.test.ts fails on any transport file missing here or in NOT_GUARDED_TRANSPORTS.
 */
export const OUTBOUND_CHANNELS = {
  communications_email: { guard: "apps/api/src/lib/communications/providers/registry.ts", transports: [] as string[] },
  communications_sms: { guard: "apps/api/src/lib/communications/providers/registry.ts", transports: [] as string[] },
  auth_email: { guard: "apps/api/src/lib/auth/email.ts", transports: [] as string[] },
  ai_provider: { guard: "apps/api/src/lib/ai/gateway.ts", transports: ["apps/api/src/lib/ai/providers/anthropicProvider.ts"] },
  voice_transcription: { guard: "apps/api/src/lib/ai/voice/gateway.ts", transports: ["apps/api/src/lib/ai/voice/deepgramTranscriptionProvider.ts"] },
  operational_alerts: { guard: "apps/api/src/lib/operationalAlerts.ts", transports: ["apps/api/src/lib/operationalAlerts.ts"] },
  esign: { guard: "apps/api/src/lib/documents.ts", transports: ["packages/integrations/esign/src/index.ts"] },
  payments: { guard: "apps/api/src/lib/payments.ts", transports: ["packages/integrations/payments/src/index.ts"] },
  mandate_payments: { guard: "apps/api/src/lib/financial/provider.ts", transports: [] as string[] },
  billing: { guard: "apps/api/src/lib/billing/gateway.ts", transports: ["packages/integrations/billing/src/index.ts"] },
  aml: { guard: "apps/api/src/lib/aml.ts", transports: ["packages/integrations/aml/src/index.ts"] },
  telephony: { guard: "apps/api/src/lib/telephony/callSessions.ts", transports: [] as string[] },
  object_storage_write: { guard: "apps/api/src/lib/documentStorage.ts", transports: ["packages/integrations/object-storage/src/index.ts"] },
} as const;
export type OutboundChannel = keyof typeof OUTBOUND_CHANNELS;

/** Channels refused in a restored environment whatever the provider, and never allow-listable. */
export const ALWAYS_BLOCKED_IN_RESTORED: ReadonlySet<OutboundChannel> = new Set<OutboundChannel>(["auth_email"]);

/** Transports deliberately NOT guarded, each with its reason. */
export const NOT_GUARDED_TRANSPORTS: Record<string, string> = {
  "packages/integrations/property-data/src/index.ts":
    "GooglePlacesProvider (network: fetchImpl, defaulting to the global HTTP client). Constructed only in apps/api/src/routes/properties.ts, a route file outside the WS4-11 lease — STOP; gap G-PD.",
};

export type ProviderKind = "in_process" | "network";
export interface ProviderClassification {
  channel: OutboundChannel;
  provider: string;
  kind: ProviderKind;
  /** Repo-root-relative file and the exported symbol whose body is the evidence (checked by the guard test). */
  file: string;
  symbol: string;
}

/** Every provider the API can reach, classified with file evidence. Anything not listed is treated as NETWORK. */
export const PROVIDERS: readonly ProviderClassification[] = [
  { channel: "communications_email", provider: "sandbox_email", kind: "in_process", file: "apps/api/src/lib/communications/providers/sandboxEmail.ts", symbol: "sandboxEmailProvider" },
  { channel: "communications_sms", provider: "sandbox_sms", kind: "in_process", file: "apps/api/src/lib/communications/providers/sandboxSms.ts", symbol: "sandboxSmsProvider" },
  { channel: "auth_email", provider: "sandbox_auth_email", kind: "in_process", file: "apps/api/src/lib/auth/email.ts", symbol: "sandboxAuthEmailProvider" },
  { channel: "ai_provider", provider: "mock", kind: "in_process", file: "apps/api/src/lib/ai/providers/mockProvider.ts", symbol: "MockAiProvider" },
  { channel: "ai_provider", provider: "anthropic", kind: "network", file: "apps/api/src/lib/ai/providers/anthropicProvider.ts", symbol: "AnthropicAiProvider" },
  { channel: "voice_transcription", provider: "mock", kind: "in_process", file: "apps/api/src/lib/ai/voice/mockTranscriptionProvider.ts", symbol: "MockTranscriptionProvider" },
  { channel: "voice_transcription", provider: "deepgram", kind: "network", file: "apps/api/src/lib/ai/voice/deepgramTranscriptionProvider.ts", symbol: "DeepgramTranscriptionProvider" },
  { channel: "operational_alerts", provider: "webhook", kind: "network", file: "apps/api/src/lib/operationalAlerts.ts", symbol: "transport" },
  { channel: "esign", provider: "mock", kind: "in_process", file: "packages/integrations/esign/src/index.ts", symbol: "MockESignProvider" },
  { channel: "esign", provider: "http", kind: "network", file: "packages/integrations/esign/src/index.ts", symbol: "HttpESignProvider" },
  { channel: "payments", provider: "mock", kind: "in_process", file: "packages/integrations/payments/src/index.ts", symbol: "MockPaymentProvider" },
  { channel: "payments", provider: "stripe", kind: "network", file: "packages/integrations/payments/src/index.ts", symbol: "StripePaymentProvider" },
  { channel: "mandate_payments", provider: "sandbox", kind: "in_process", file: "packages/integrations/mandate-payments/src/index.ts", symbol: "SandboxMandatePaymentProvider" },
  { channel: "billing", provider: "mock", kind: "in_process", file: "packages/integrations/billing/src/index.ts", symbol: "MockBillingProvider" },
  { channel: "billing", provider: "stripe", kind: "network", file: "packages/integrations/billing/src/index.ts", symbol: "StripeBillingProvider" },
  { channel: "aml", provider: "mock", kind: "in_process", file: "packages/integrations/aml/src/index.ts", symbol: "MockAMLProvider" },
  { channel: "aml", provider: "http", kind: "network", file: "packages/integrations/aml/src/index.ts", symbol: "HttpAMLProvider" },
  { channel: "telephony", provider: "sandbox", kind: "in_process", file: "apps/api/src/lib/telephony/sandboxProvider.ts", symbol: "SandboxTelephonyProvider" },
  // Object storage: classified for the record; writes follow the D-OS rule (isolation flag), not this kind.
  { channel: "object_storage_write", provider: "local", kind: "in_process", file: "packages/integrations/object-storage/src/index.ts", symbol: "LocalObjectStorageProvider" },
  { channel: "object_storage_write", provider: "s3", kind: "network", file: "packages/integrations/object-storage/src/index.ts", symbol: "S3ObjectStorageProvider" },
];

/** ObjectStorageProvider members: every interface method must be in exactly one set (guard test). */
export const STORAGE_READ_METHODS = ["getObject", "headObject", "createSignedDownload", "verifyIntegrity", "checkReadiness"] as const;
export const STORAGE_WRITE_METHODS = ["putObject", "deleteObject"] as const;

export type BlockReason = RestoredEnvironmentReason;
export class RestoredEnvironmentOutboundBlockedError extends Error {
  readonly code = RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED;
  readonly httpStatus = RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED_HTTP_STATUS;
  constructor(readonly channel: OutboundChannel, readonly reason: BlockReason, readonly provider: string | null = null, readonly rule: string = "restored_environment") {
    super(`This is a restored environment (${RESTORED_ENVIRONMENT_ENV}); outbound ${channel}${provider ? ` via "${provider}"` : ""} is disabled and nothing was sent.`);
    this.name = "RestoredEnvironmentOutboundBlockedError";
  }
}

export function isRestoredEnvironmentOutboundBlockedError(err: unknown): err is RestoredEnvironmentOutboundBlockedError {
  return err instanceof RestoredEnvironmentOutboundBlockedError;
}

export function classifyProvider(channel: OutboundChannel, provider: string): ProviderKind {
  return PROVIDERS.find((p) => p.channel === channel && p.provider === provider)?.kind ?? "network";
}

const warnedAllowEntries = new Set<string>();
/** Parsed allow-list: valid `channel:provider` pairs only; everything else ignored with a once-per-entry warning. */
export function restoredOutboundAllowList(env: Env = process.env): ReadonlySet<string> {
  const out = new Set<string>();
  for (const raw of (env[RESTORED_ENV_OUTBOUND_ALLOW_ENV] ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const m = /^([a-z_]+):([a-z0-9_.-]+)$/.exec(entry);
    const reason = !m ? "malformed" : !(m[1]! in OUTBOUND_CHANNELS) ? "unknown_channel" : ALWAYS_BLOCKED_IN_RESTORED.has(m[1] as OutboundChannel) ? "channel_not_allowlistable" : null;
    if (reason) {
      if (!warnedAllowEntries.has(entry)) {
        warnedAllowEntries.add(entry);
        logger.warn("restored_environment_outbound_allow_entry_ignored", { env: RESTORED_ENV_OUTBOUND_ALLOW_ENV, entry, reason });
      }
      continue;
    }
    out.add(entry);
  }
  return out;
}

export function restoredStorageIsolated(env: Env = process.env): boolean {
  return env[RESTORED_ENV_STORAGE_ISOLATED_ENV] === "true";
}

function block(channel: OutboundChannel, reason: BlockReason, provider: string | null, rule: string): RestoredEnvironmentOutboundBlockedError {
  logger.warn("restored_environment_outbound_blocked", { channel, provider, rule, code: RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED, reason, env: RESTORED_ENVIRONMENT_ENV });
  return new RestoredEnvironmentOutboundBlockedError(channel, reason, provider, rule);
}

/**
 * The block for this channel/provider, or null when allowed. `provider` null means "the channel itself" (used by
 * always-blocked channels). One structured warn line per block.
 */
export function outboundBlocked(channel: OutboundChannel, provider: string | null = null, env: Env = process.env): RestoredEnvironmentOutboundBlockedError | null {
  const mode = restoredEnvironmentMode(env);
  if (!mode.restored) return null;
  if (ALWAYS_BLOCKED_IN_RESTORED.has(channel)) return block(channel, mode.reason, provider, "channel_always_blocked");
  if (provider === null) return block(channel, mode.reason, null, "provider_unknown_fail_closed");
  if (classifyProvider(channel, provider) === "in_process") return null;
  if (restoredOutboundAllowList(env).has(`${channel}:${provider}`)) return null;
  return block(channel, mode.reason, provider, "network_provider_not_allowlisted");
}

/** Throws RestoredEnvironmentOutboundBlockedError when outboundBlocked() says so. */
export function assertOutboundAllowed(channel: OutboundChannel, provider: string | null = null, env: Env = process.env): void {
  const b = outboundBlocked(channel, provider, env);
  if (b) throw b;
}

/** D-OS: object-storage writes/deletes in a restored environment need AEE_RESTORED_ENV_STORAGE_ISOLATED=true exactly. */
export function storageWriteBlocked(provider: string, env: Env = process.env): RestoredEnvironmentOutboundBlockedError | null {
  const mode = restoredEnvironmentMode(env);
  if (!mode.restored || restoredStorageIsolated(env)) return null;
  return block("object_storage_write", mode.reason, provider, "storage_not_isolated");
}

/**
 * Wraps a provider so the named (Promise-returning) send methods reject with the block before the real method runs,
 * judged against the provider id that `providerId` returns at call time. Every other member passes through. The
 * rejection is a rejected Promise, never a synchronous throw, so Promise.allSettled / .catch callers keep working.
 */
export function guardOutboundProvider<T extends object>(channel: OutboundChannel, provider: T, sendMethods: readonly (keyof T & string)[], providerId: (p: T) => string): T {
  const guarded = new Set<string>(sendMethods);
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || !guarded.has(prop) || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const b = outboundBlocked(channel, providerId(target));
        if (b) return Promise.reject(b);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** D-OS wrapper for the API's document storage provider: STORAGE_WRITE_METHODS refused unless isolated. */
export function guardStorageWrites<T extends object>(provider: T, providerId: (p: T) => string): T {
  const writes = new Set<string>(STORAGE_WRITE_METHODS);
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || !writes.has(prop) || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const b = storageWriteBlocked(providerId(target));
        if (b) return Promise.reject(b);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
