// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
//
// A deterministic, in-process mock of a real-estate portal integration
// (Section 12/13's required mock scenarios). This is the ONLY adapter this
// build registers — proving the adapter contract, connection lifecycle,
// outbox, and webhook gateway end to end without any live third-party
// connection (Section 18).
//
// Deterministic by construction: behaviour is driven entirely by
// caller-supplied flags on the command payload (never by real network
// conditions, wall-clock timing, or randomness beyond a reference id) so
// every test scenario below is 100% reproducible:
//   - default: succeeds immediately.
//   - __forcePermanentRejection: always fails, PERMANENT_REJECTION.
//   - __forceRateLimit: fails RATE_LIMITED on the first attempt for a given
//     idempotencyKey, then succeeds — proves the retryable-then-succeeds path.
//   - __failUntilAttempt: <n> — fails TRANSIENT_PROVIDER_ERROR until the
//     n-th attempt for a given idempotencyKey, then succeeds.
//   - __validationProbe: true — the harmless connectivity check
//     model.ts's validateConnection sends; always succeeds and is never
//     otherwise treated as a real command.

import { randomUUID } from "node:crypto";
import type { AdapterSendContext, AdapterSendResult, IntegrationAdapter, IntegrationCapability } from "../types.js";

// Keyed by idempotencyKey so a genuinely new command starts a fresh attempt
// count, while a retried dispatch of the SAME command continues counting
// — this is what makes "fails twice, then succeeds on retry" deterministic
// and reproducible across a real dispatch-then-redispatch test flow.
const attemptCounters = new Map<string, number>();

export function clearMockPortalStateForTesting(): void {
  attemptCounters.clear();
}

export const MOCK_PORTAL_PROVIDER_ID = "mock_portal_v1";

export const mockPortalAdapter: IntegrationAdapter = {
  providerId: MOCK_PORTAL_PROVIDER_ID,
  version: 1,
  capabilities: ["portal.publishListing", "portal.updateListingStatus"] as IntegrationCapability[],

  async send(capability: IntegrationCapability, payload: Record<string, unknown>, ctx: AdapterSendContext): Promise<AdapterSendResult> {
    if (payload.__validationProbe === true) {
      return { status: "SENT", providerReference: `mock-portal-validation-${randomUUID()}`, failureCategory: null, failureDetail: null, responseSummary: "Validation probe accepted — connection is reachable." };
    }

    const attempt = (attemptCounters.get(ctx.idempotencyKey) ?? 0) + 1;
    attemptCounters.set(ctx.idempotencyKey, attempt);

    if (payload.__forcePermanentRejection === true) {
      return { status: "FAILED", providerReference: null, failureCategory: "PERMANENT_REJECTION", failureDetail: "Mock portal permanently rejected this listing submission (simulated).", responseSummary: "Permanently rejected." };
    }

    if (payload.__forceRateLimit === true && attempt === 1) {
      return { status: "FAILED", providerReference: null, failureCategory: "RATE_LIMITED", failureDetail: "Mock portal rate limit exceeded (simulated) — retry after backoff.", responseSummary: "Rate limited." };
    }

    const failUntil = typeof payload.__failUntilAttempt === "number" ? payload.__failUntilAttempt : null;
    if (failUntil !== null && attempt < failUntil) {
      return { status: "FAILED", providerReference: null, failureCategory: "TRANSIENT_PROVIDER_ERROR", failureDetail: `Mock portal transient error (simulated), attempt ${attempt} of ${failUntil}.`, responseSummary: "Transient provider error." };
    }

    return {
      status: "SENT",
      providerReference: `mock-portal-ref-${randomUUID()}`,
      failureCategory: null,
      failureDetail: null,
      responseSummary: `Accepted for capability ${capability}.`,
    };
  },
};
