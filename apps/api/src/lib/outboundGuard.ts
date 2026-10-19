// WS4-09 — request-path outbound block for restored environments.
//
// WS4-07 (lib/restoredEnvironment.ts) keeps every boot-time loop off when AEE_RESTORED_ENVIRONMENT is set. This module
// is the request-path half: with the same switch and the same parsing (unknown values fail closed), every outbound
// SEAM refuses before anything leaves the process — communications EMAIL/SMS provider resolution, auth email, the AI
// gateway and its Anthropic transport, voice/call transcription and the Deepgram transport, operational alerts and
// webhooks, e-sign, card payments, mandate payments, the payment-outbox dispatch (manual route and loop), billing and
// AML. The seams are the existing provider factories/singletons, so no route file changes: routes inherit the
// refusal and middlewares/errorHandler.ts turns it into HTTP 503 { code: RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED }.
//
// Why 503: the request is valid and authorised (not 4xx); the server is deliberately not performing a dependency in
// this environment, which is "service unavailable" in RFC 9110 §15.6.4 terms, and it matches the codebase's existing
// operator-condition refusals (routes/ai.ts AI_USAGE_LIMITS_NOT_CONFIGURED, routes/auth.ts un-auditable invitation).
// Not 403 (not an authorisation decision), not 501 (implemented), not 502/504 (no upstream was contacted).
//
// The sandbox/mock adapters are blocked too (they do not leave the process): the rule is "the seam refuses in a
// restored environment" regardless of which adapter is configured, because a restored copy of production config is
// exactly when a live adapter may be configured.
import { logger } from "@aee/events";
import { RESTORED_ENVIRONMENT_ENV, restoredEnvironmentMode, type RestoredEnvironmentReason } from "./restoredEnvironment.js";

export const RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED = "RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED" as const;
export const RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED_HTTP_STATUS = 503 as const;

/**
 * Every outbound channel: the file that holds its guard, and the files (repo-root relative) that actually open a
 * transport for it. The guard test in lib/__tests__/outboundGuard.test.ts fails if any file that calls fetch /
 * http(s).request / net|tls.connect / WebSocket / createTransport is missing from here (or NOT_GUARDED_TRANSPORTS),
 * or if a guard file stops calling the guard with its channel id.
 */
export const OUTBOUND_CHANNELS = {
  communications_email: { guard: "apps/api/src/lib/communications/providers/registry.ts", transports: [] as string[], note: "sandbox adapter only today; any live EMAIL adapter resolves through resolveEmailProvider()" },
  communications_sms: { guard: "apps/api/src/lib/communications/providers/registry.ts", transports: [] as string[], note: "sandbox adapter only today; any live SMS adapter resolves through resolveSmsProvider()" },
  auth_email: { guard: "apps/api/src/lib/auth/email.ts", transports: [] as string[], note: "invitation, password reset, administrator succession; sandbox only today" },
  ai_provider: { guard: "apps/api/src/lib/ai/gateway.ts", transports: ["apps/api/src/lib/ai/providers/anthropicProvider.ts"], note: "generateWithGateway (Copilot/Ask/Coach, call-transcription drafts)" },
  voice_transcription: { guard: "apps/api/src/lib/ai/voice/gateway.ts", transports: ["apps/api/src/lib/ai/voice/deepgramTranscriptionProvider.ts"], note: "voice input + call transcription" },
  operational_alerts: { guard: "apps/api/src/lib/operationalAlerts.ts", transports: ["apps/api/src/lib/operationalAlerts.ts"], note: "alert webhook; returns { status: 'blocked' } instead of throwing" },
  esign: { guard: "apps/api/src/lib/documents.ts", transports: ["packages/integrations/esign/src/index.ts"], note: "createEnvelope" },
  payments: { guard: "apps/api/src/lib/payments.ts", transports: ["packages/integrations/payments/src/index.ts"], note: "chargeStoredMethod, refund" },
  mandate_payments: { guard: "apps/api/src/lib/financial/provider.ts", transports: [] as string[], note: "scheduleDebit, cancelScheduledDebit, reverseDebit (mock-only package today)" },
  financial_payment_dispatch: { guard: "apps/api/src/lib/financial/paymentOutbox.ts", transports: [] as string[], note: "dispatchPendingPaymentOutbox: POST /financial/ops/dispatch-outbox and the WS4-07-gated loop" },
  billing: { guard: "apps/api/src/lib/billing/gateway.ts", transports: ["packages/integrations/billing/src/index.ts"], note: "createCheckoutSession, cancelSubscription" },
  aml: { guard: "apps/api/src/lib/aml.ts", transports: ["packages/integrations/aml/src/index.ts"], note: "requestVerification" },
} as const;
export type OutboundChannel = keyof typeof OUTBOUND_CHANNELS;

/** Transports deliberately NOT blocked, each with its reason (decisions in followups-3/README.md). */
export const NOT_GUARDED_TRANSPORTS: Record<string, string> = {
  "packages/integrations/object-storage/src/index.ts":
    "document object storage (reads + writes). A restored environment is pointed at its restored bucket by the restore runbook; blocking would make restored documents unreadable. Decision D-OS.",
};

export class RestoredEnvironmentOutboundBlockedError extends Error {
  readonly code = RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED;
  readonly httpStatus = RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED_HTTP_STATUS;
  constructor(readonly channel: OutboundChannel, readonly reason: RestoredEnvironmentReason) {
    super(`This is a restored environment (${RESTORED_ENVIRONMENT_ENV}); outbound ${channel} is disabled and nothing was sent.`);
    this.name = "RestoredEnvironmentOutboundBlockedError";
  }
}

export function isRestoredEnvironmentOutboundBlockedError(err: unknown): err is RestoredEnvironmentOutboundBlockedError {
  return err instanceof RestoredEnvironmentOutboundBlockedError;
}

/** The block for this channel (logged once per call as one structured warn line), or null when sending is allowed. */
export function outboundBlocked(channel: OutboundChannel, env: Record<string, string | undefined> = process.env): RestoredEnvironmentOutboundBlockedError | null {
  const mode = restoredEnvironmentMode(env);
  if (!mode.restored) return null;
  logger.warn("restored_environment_outbound_blocked", { channel, code: RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED, reason: mode.reason, env: RESTORED_ENVIRONMENT_ENV });
  return new RestoredEnvironmentOutboundBlockedError(channel, mode.reason);
}

/** Throws RestoredEnvironmentOutboundBlockedError when the environment is restored. */
export function assertOutboundAllowed(channel: OutboundChannel, env: Record<string, string | undefined> = process.env): void {
  const blocked = outboundBlocked(channel, env);
  if (blocked) throw blocked;
}

/**
 * Wraps a provider so the named (Promise-returning) send methods reject with the block before the real method runs;
 * every other member (webhook verification/parsing, kind, mock helpers) passes through untouched. The rejection is
 * a rejected Promise, never a synchronous throw, so callers using Promise.allSettled / .catch keep their semantics.
 */
export function guardOutboundProvider<T extends object>(channel: OutboundChannel, provider: T, sendMethods: readonly (keyof T & string)[]): T {
  const guarded = new Set<string>(sendMethods);
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || !guarded.has(prop) || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const blocked = outboundBlocked(channel);
        if (blocked) return Promise.reject(blocked);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
