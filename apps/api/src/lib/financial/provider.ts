// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage D.
//
// A single module-scope provider instance, shared by paymentOutbox.ts and
// paymentWebhooks.ts. This matters specifically because
// SandboxMandatePaymentProvider keeps its idempotency/dedup state in an
// in-memory Map: two independently-constructed instances would each have
// their own disjoint state, silently breaking the very idempotency
// guarantee the sandbox provider exists to model. Mirrors lib/payments.ts's
// own `const paymentProvider = createPaymentProvider();` module-scope
// singleton, generalised across two consuming files instead of one.

import { createMandatePaymentProvider } from "@aee/integration-mandate-payments";

export const mandatePaymentProvider = createMandatePaymentProvider();

/**
 * Owner t183u item 6 (#245 S5): only the sandbox mandate provider may process. The factory can only
 * build the sandbox today; this is the defence-in-depth gate every debit call site checks first.
 */
export function mandateProviderPermitted(): boolean {
  return mandatePaymentProvider.name === "sandbox";
}
