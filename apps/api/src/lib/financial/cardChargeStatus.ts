// Owner t181u(D): provider status lookup for an UNKNOWN stored-card charge,
// used by Brokerage Administrator reconciliation. Mock/test provider only
// (t180u): the MockPaymentProvider records each idempotency key it actually
// charged, so "Succeeded" means the card was charged and "NotFound" means it
// never was. Any other provider, or a mock without that record, answers
// "Unavailable" and resolution is refused (fail closed). A live provider
// needs a retrieve-by-idempotency-key call in @aee/integration-payments
// (QA-shared package, not changed here) before this can be enabled.
// Read-only: never charges, never logs the key or any token.
import { paymentProvider } from "../paymentProvider.js";
import { cardProviderPermitted } from "./pcFeeCardCharges.js";

export type CardChargeProviderStatus = "Succeeded" | "NotFound" | "Unavailable";

export function lookupCardChargeProviderStatus(idempotencyKey: string): CardChargeProviderStatus {
  if (!cardProviderPermitted()) return "Unavailable";
  const record = (paymentProvider as unknown as { charged?: unknown }).charged;
  if (!(record instanceof Set)) return "Unavailable";
  return record.has(idempotencyKey) ? "Succeeded" : "NotFound";
}

/** The only resolution consistent with the provider's answer (null when it cannot answer). */
export function outcomeForProviderStatus(s: CardChargeProviderStatus): "SUCCEEDED" | "FAILED" | null {
  return s === "Succeeded" ? "SUCCEEDED" : s === "NotFound" ? "FAILED" : null;
}
