// Agent Engine 2.0 — AE Step 5 remediation — Proof C (Financial Transaction
// Engine).
//
// A deterministic, in-process mock of a payment processor's STATUS feed —
// same construction as adapters/mockPortal.ts / adapters/mockSms.ts.
// Registered so the connection lifecycle's validateConnection probe
// (model.ts) has a real adapter to call — this build's Proof C scenario
// itself is driven entirely through the INBOUND webhook half
// (financialProof.ts / lib/financial/mockPaymentStatusSync.ts); nothing in
// this codebase ever calls this adapter's send() for a real outbound
// payments.statusSync command. Kept structurally complete (not a stub)
// because "adapters must be replaceable" (Section 4) applies equally to an
// adapter that happens to be inbound-only today.
//
// This adapter — and this provider category — deliberately has NO
// capability beyond payments.statusSync. It is structurally incapable of
// initiating a debit, transfer, or any other money movement: there is no
// "pay"/"debit"/"transfer" capability verb anywhere in this file, in
// PROVIDER_CATALOGUE's mock_payment_status_v1 entry, or in
// INTEGRATION_CAPABILITIES.

import type { AdapterSendContext, AdapterSendResult, IntegrationAdapter, IntegrationCapability } from "../types.js";

export const MOCK_PAYMENT_STATUS_PROVIDER_ID = "mock_payment_status_v1";

export const mockPaymentStatusAdapter: IntegrationAdapter = {
  providerId: MOCK_PAYMENT_STATUS_PROVIDER_ID,
  version: 1,
  // Inbound-only: every outbound command is refused, so nothing is ever uncertain. Declared fail-closed anyway.
  recovery: { dedupesOnIdempotencyKey: false },
  capabilities: ["payments.statusSync"] as IntegrationCapability[],

  async send(capability: IntegrationCapability, payload: Record<string, unknown>, ctx: AdapterSendContext): Promise<AdapterSendResult> {
    if (payload.__validationProbe === true) {
      return { status: "SENT", providerReference: `mock-payment-status-validation-${ctx.idempotencyKey}`, failureCategory: null, failureDetail: null, responseSummary: "Validation probe accepted — connection is reachable." };
    }
    // No genuine outbound command exists for this capability in this
    // build (see this file's own header comment) — any actual dispatch
    // attempt is refused rather than silently pretending to succeed.
    return {
      status: "FAILED",
      providerReference: null,
      failureCategory: "VALIDATION_ERROR",
      failureDetail: `mock_payment_status_v1 does not support an outbound ${capability} command in this build — status sync is inbound-only.`,
      responseSummary: "Outbound dispatch not supported.",
    };
  },
};
