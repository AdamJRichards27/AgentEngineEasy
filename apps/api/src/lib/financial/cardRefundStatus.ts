// Owner t181u phase 2b (G15): provider status of an UNKNOWN Pit Crew service
// fee card refund, for Brokerage Administrator resolution. Mock provider
// only, read-only, and NAMESPACED: it looks up exactly one PC-fee refund
// idempotency key ("pcf-card-refund:<chargeId>:<hash>") in the mock refund
// record. It never matches by the numeric refund id, which service-order
// refunds (payment_refunds) can share, so a service-order refund can never
// answer for a PC-fee refund. Any other key, provider or missing record ->
// "Unavailable" (fail closed). @aee/integration-payments is NOT changed (QA
// shared); a live provider needs a namespaced lookup there first (G16).
import { MockPaymentProvider } from "@aee/integration-payments";
import { cardProviderPermitted } from "./pcFeeCardCharges.js";

export const PC_FEE_REFUND_KEY_NAMESPACE = "pcf-card-refund:";
const KEY_SHAPE = /^pcf-card-refund:\d+:[0-9a-f]{32}$/;

export type CardRefundProviderStatus = "Succeeded" | "Failed" | "Pending" | "NotFound" | "Unavailable";

export function lookupCardRefundProviderStatus(idempotencyKey: string): CardRefundProviderStatus {
  if (typeof idempotencyKey !== "string" || !KEY_SHAPE.test(idempotencyKey)) return "Unavailable";
  if (!cardProviderPermitted()) return "Unavailable";
  const record = (MockPaymentProvider as unknown as { refundsByKey?: unknown }).refundsByKey;
  if (!(record instanceof Map)) return "Unavailable";
  const hit = record.get(idempotencyKey) as { status?: string } | undefined;
  if (!hit) return "NotFound";
  return hit.status === "Succeeded" ? "Succeeded" : hit.status === "Failed" ? "Failed" : hit.status === "Pending" ? "Pending" : "Unavailable";
}

/** The only resolution consistent with the provider (null: no definite answer -> refuse). */
export function refundOutcomeForProviderStatus(s: CardRefundProviderStatus): "SUCCEEDED" | "FAILED" | null {
  return s === "Succeeded" ? "SUCCEEDED" : s === "Failed" || s === "NotFound" ? "FAILED" : null;
}

/** Provider reference recorded by the mock for this key (never the key itself). */
export function mockRefundRefFor(idempotencyKey: string): string | null {
  if (!KEY_SHAPE.test(idempotencyKey)) return null;
  const record = (MockPaymentProvider as unknown as { refundsByKey?: unknown }).refundsByKey;
  if (!(record instanceof Map)) return null;
  const hit = record.get(idempotencyKey) as { providerRefundRef?: string } | undefined;
  return hit?.providerRefundRef ?? null;
}
