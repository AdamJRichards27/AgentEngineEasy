// Outbound-message recovery policy (specs/outbound-message-recovery.md).
//
// A row whose dispatch outcome is UNCERTAIN (its claim/lease expired, or a
// communications message has sat in SENDING past the stale threshold) is
// never blindly re-sent. What happens depends only on what the provider
// adapter declares it can do. The declaration is fail-closed: an adapter
// that declares nothing is treated as "cannot dedupe, cannot look up".

export type RecoveryLookupResult = "DELIVERED" | "NOT_FOUND" | "UNKNOWN";

export interface ProviderRecoveryCapability {
  /** A resend with the SAME idempotency key provably cannot create a second effect at the provider. */
  dedupesOnIdempotencyKey: boolean;
  /** Ask the provider what happened to the send made with this key. */
  lookupByIdempotencyKey?: (idempotencyKey: string) => Promise<RecoveryLookupResult>;
}

export const NO_RECOVERY_CAPABILITY: ProviderRecoveryCapability = Object.freeze({ dedupesOnIdempotencyKey: false });

export type RecoveryDecision =
  | { action: "MARK_SENT"; reason: "LOOKUP_DELIVERED" }
  | { action: "RESEND_SAME_KEY"; reason: "LOOKUP_NOT_FOUND" | "PROVIDER_DEDUPES" }
  | { action: "MANUAL_REVIEW"; reason: "LOOKUP_UNKNOWN" | "LOOKUP_FAILED" | "NO_DEDUPE_NO_LOOKUP" };

export const MANUAL_REVIEW_STATUS = "MANUAL_REVIEW" as const;

export function capabilityOf(adapter: { recovery?: ProviderRecoveryCapability } | null | undefined): ProviderRecoveryCapability {
  return adapter?.recovery ?? NO_RECOVERY_CAPABILITY;
}

/**
 * Decide what to do with an uncertain send. Lookup first (it can prove
 * delivery); otherwise resend only if the provider dedupes on our key;
 * otherwise MANUAL_REVIEW. A lookup that throws is itself uncertain.
 */
export async function decideRecovery(capability: ProviderRecoveryCapability, idempotencyKey: string): Promise<RecoveryDecision> {
  if (capability.lookupByIdempotencyKey) {
    let found: RecoveryLookupResult;
    try {
      found = await capability.lookupByIdempotencyKey(idempotencyKey);
    } catch {
      return { action: "MANUAL_REVIEW", reason: "LOOKUP_FAILED" };
    }
    if (found === "DELIVERED") return { action: "MARK_SENT", reason: "LOOKUP_DELIVERED" };
    if (found === "NOT_FOUND") return { action: "RESEND_SAME_KEY", reason: "LOOKUP_NOT_FOUND" };
    return { action: "MANUAL_REVIEW", reason: "LOOKUP_UNKNOWN" };
  }
  if (capability.dedupesOnIdempotencyKey) return { action: "RESEND_SAME_KEY", reason: "PROVIDER_DEDUPES" };
  return { action: "MANUAL_REVIEW", reason: "NO_DEDUPE_NO_LOOKUP" };
}
