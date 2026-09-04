// Agent Engine 2.0 — AE Step 5 remediation — Proof B (Communications Hub).
//
// A deterministic, in-process mock of an SMS gateway integration — same
// construction as adapters/mockPortal.ts (see that file's own header
// comment for the general shape): behaviour is driven entirely by
// caller-supplied flags on the command payload, never by real network
// conditions, wall-clock timing, or randomness beyond a reference id.
//
//   - default: succeeds immediately, echoing back payload.externalMessageId
//     as its providerReference (the caller mints this id itself before
//     dispatch — see commsProof.ts — so the mapping it records afterwards
//     is exact, not a guess at what the adapter generated).
//   - __forcePermanentRejection: always fails, PERMANENT_REJECTION
//     (simulates e.g. an invalid/blocked destination number).
//   - __forceRateLimit: fails RATE_LIMITED on the first attempt for a given
//     idempotencyKey, then succeeds.
//   - __failUntilAttempt: <n> — fails TRANSIENT_PROVIDER_ERROR until the
//     n-th attempt for a given idempotencyKey, then succeeds. Proof D's
//     retry-to-dead-letter scenario drives this past maxAttempts to force a
//     genuine dead-letter deterministically.
//   - __validationProbe: true — the harmless connectivity check
//     model.ts's validateConnection sends; always succeeds.

import type { AdapterSendContext, AdapterSendResult, IntegrationAdapter, IntegrationCapability } from "../types.js";

const attemptCounters = new Map<string, number>();

export function clearMockSmsStateForTesting(): void {
  attemptCounters.clear();
}

export const MOCK_SMS_PROVIDER_ID = "mock_sms_v1";

export const mockSmsAdapter: IntegrationAdapter = {
  providerId: MOCK_SMS_PROVIDER_ID,
  version: 1,
  capabilities: ["comms.sendSms"] as IntegrationCapability[],

  async send(capability: IntegrationCapability, payload: Record<string, unknown>, ctx: AdapterSendContext): Promise<AdapterSendResult> {
    if (payload.__validationProbe === true) {
      return { status: "SENT", providerReference: `mock-sms-validation-${ctx.idempotencyKey}`, failureCategory: null, failureDetail: null, responseSummary: "Validation probe accepted — connection is reachable." };
    }

    const attempt = (attemptCounters.get(ctx.idempotencyKey) ?? 0) + 1;
    attemptCounters.set(ctx.idempotencyKey, attempt);

    if (payload.__forcePermanentRejection === true) {
      return { status: "FAILED", providerReference: null, failureCategory: "PERMANENT_REJECTION", failureDetail: "Mock SMS gateway permanently rejected this destination (simulated).", responseSummary: "Permanently rejected." };
    }

    if (payload.__forceRateLimit === true && attempt === 1) {
      return { status: "FAILED", providerReference: null, failureCategory: "RATE_LIMITED", failureDetail: "Mock SMS gateway rate limit exceeded (simulated) — retry after backoff.", responseSummary: "Rate limited." };
    }

    const failUntil = typeof payload.__failUntilAttempt === "number" ? payload.__failUntilAttempt : null;
    if (failUntil !== null && attempt < failUntil) {
      return { status: "FAILED", providerReference: null, failureCategory: "TRANSIENT_PROVIDER_ERROR", failureDetail: `Mock SMS gateway transient error (simulated), attempt ${attempt} of ${failUntil}.`, responseSummary: "Transient provider error." };
    }

    const externalMessageId = typeof payload.externalMessageId === "string" ? payload.externalMessageId : `mock-sms-${ctx.idempotencyKey}`;
    return {
      status: "SENT",
      providerReference: externalMessageId,
      failureCategory: null,
      failureDetail: null,
      responseSummary: `Accepted for capability ${capability}.`,
    };
  },
};
