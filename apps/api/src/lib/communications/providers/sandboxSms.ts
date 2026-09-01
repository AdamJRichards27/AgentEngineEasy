// Agent Engine 2.0 — Communications Hub (Priority 8).
//
// Dev/sandbox SMS adapter (Section 17). Same contract as sandboxEmail.ts:
// no real network call, always labelled provider "sandbox_sms", only ever
// reports SENT/FAILED (never DELIVERED — that requires a real provider's
// delivery-receipt webhook). This is the placeholder a real SMS provider
// (e.g. Mobile Message) is wired in behind once credentials/authorization
// exist — see Section 5's explicit limit on production provider activation.

import { randomUUID } from "node:crypto";
import type { ProviderSendResult, SendSmsInput, SmsProvider } from "./types.js";

export const SANDBOX_SMS_PROVIDER_NAME = "sandbox_sms";

export const sandboxSmsProvider: SmsProvider = {
  name: SANDBOX_SMS_PROVIDER_NAME,

  async send(input: SendSmsInput): Promise<ProviderSendResult> {
    const to = input.to;
    const providerMessageId = `sandbox-sms-${randomUUID()}`;

    if (to.includes("0000000")) {
      return {
        provider: SANDBOX_SMS_PROVIDER_NAME,
        providerMessageId,
        status: "FAILED",
        failureCategory: "INVALID_DESTINATION",
        failureDetail: "Sandbox simulated rejection: destination number is not a deliverable mobile number.",
      };
    }
    if (to.includes("9999999")) {
      return {
        provider: SANDBOX_SMS_PROVIDER_NAME,
        providerMessageId,
        status: "FAILED",
        failureCategory: "PROVIDER_TIMEOUT",
        failureDetail: "Sandbox simulated failure: provider did not respond in time.",
      };
    }

    return { provider: SANDBOX_SMS_PROVIDER_NAME, providerMessageId, status: "SENT" };
  },
};
