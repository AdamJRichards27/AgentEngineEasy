// Agent Engine 2.0 — Communications Hub (Priority 8).
//
// Dev/sandbox EMAIL adapter (Section 18). Nothing here makes a network call
// to a real mail provider, and every result is labelled provider
// "sandbox_email" so it can never be mistaken for genuine delivery evidence
// (Section 42 — "must not fabricate delivery"). It only ever reports
// SENT ("the sandbox accepted the message") or FAILED ("the sandbox
// rejected it") — it never reports DELIVERED, because that confirmation can
// only come from a real provider's webhook (Section 19); sandbox_email has
// none, so a sandbox-sent message stays at SENT until a test explicitly
// simulates an inbound delivery-receipt webhook.
//
// A couple of magic destination substrings let tests and manual QA exercise
// the failure/retry paths (Section 38) deterministically without needing a
// real provider outage.

import { randomUUID } from "node:crypto";
import type { EmailProvider, ProviderSendResult, SendEmailInput } from "./types.js";

export const SANDBOX_EMAIL_PROVIDER_NAME = "sandbox_email";

export const sandboxEmailProvider: EmailProvider = {
  name: SANDBOX_EMAIL_PROVIDER_NAME,
  // A random message id per send; the idempotency key is not used. A resend would be a second email.
  recovery: { dedupesOnIdempotencyKey: false },

  async send(input: SendEmailInput): Promise<ProviderSendResult> {
    const to = input.to.toLowerCase();
    const providerMessageId = `sandbox-email-${randomUUID()}`;

    if (to.includes("sandboxfail+invalid")) {
      return {
        provider: SANDBOX_EMAIL_PROVIDER_NAME,
        providerMessageId,
        status: "FAILED",
        failureCategory: "INVALID_DESTINATION",
        failureDetail: "Sandbox simulated rejection: destination address is not deliverable.",
      };
    }
    if (to.includes("sandboxfail+timeout")) {
      return {
        provider: SANDBOX_EMAIL_PROVIDER_NAME,
        providerMessageId,
        status: "FAILED",
        failureCategory: "PROVIDER_TIMEOUT",
        failureDetail: "Sandbox simulated failure: provider did not respond in time.",
      };
    }

    return { provider: SANDBOX_EMAIL_PROVIDER_NAME, providerMessageId, status: "SENT" };
  },
};
