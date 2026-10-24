import type { BillingProvider } from "@aee/integration-billing";
import { MockBillingProvider, StripeBillingProvider } from "@aee/integration-billing";
import { logger } from "@aee/events";
import { mustForceMockExternalProvider } from "../env.js";
import { guardOutboundProvider } from "../outboundGuard.js";

export interface BillingGatewayConfig {
  providerName: "mock" | "stripe";
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripeApiBaseUrl: string;
}

export function loadBillingGatewayConfig(): BillingGatewayConfig {
  const raw = (process.env.BILLING_PROVIDER ?? "mock").toLowerCase();
  return {
    providerName: raw === "stripe" ? "stripe" : "mock",
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    stripeApiBaseUrl: process.env.STRIPE_API_BASE_URL ?? "https://api.stripe.com",
  };
}

let cachedProvider: BillingProvider | null = null;

// Lazy singleton with fail-closed fallback - same shape as the AI Gateway's buildProvider().
// If BILLING_PROVIDER=stripe is set without a secret key, we never throw at boot; we log and
// fall back to the Mock provider so the app stays usable and Grow checkout stays demoable.
// WS4-09: AEE_RESTORED_ENVIRONMENT refuses this outbound seam (lib/outboundGuard.ts).
const guardBilling = (p: BillingProvider): BillingProvider => guardOutboundProvider("billing", p, ["createCheckoutSession", "cancelSubscription"], (b) => b.name);

export function getBillingProvider(): BillingProvider {
  if (cachedProvider) return cachedProvider;

  const config = loadBillingGatewayConfig();
  if (config.providerName === "stripe") {
    // Critical Blocker Remediation, Phase 10 — commercial lock. Checked
    // BEFORE the credential check below, and independent of it: a real
    // STRIPE_SECRET_KEY being present must never be sufficient on its own
    // to start a real subscription in this pilot. See env.ts's
    // mustForceMockExternalProvider() and
    // docs/gate-evidence/PHASE10_BILLING_AND_EXTERNAL_ACTION_LOCKS.md.
    if (mustForceMockExternalProvider()) {
      logger.warn("billing_provider_locked_to_mock_pilot_policy", {
        reason: "BILLING_PROVIDER=stripe was requested but LIVE_EXTERNAL_TRANSACTIONS_APPROVED is not \"true\" in production — no real subscription/checkout is authorised for this pilot.",
      });
      cachedProvider = guardBilling(new MockBillingProvider());
      return cachedProvider;
    }
    if (!config.stripeSecretKey) {
      logger.warn("billing_provider_stripe_secret_key_missing_fallback_to_mock", {});
      cachedProvider = guardBilling(new MockBillingProvider());
      return cachedProvider;
    }
    cachedProvider = guardBilling(new StripeBillingProvider({
      secretKey: config.stripeSecretKey,
      webhookSecret: config.stripeWebhookSecret ?? "",
      apiBaseUrl: config.stripeApiBaseUrl,
    }));
    return cachedProvider;
  }

  cachedProvider = guardBilling(new MockBillingProvider());
  return cachedProvider;
}

// Test-only escape hatch so a suite can force a fresh provider between cases.
export function resetBillingProviderCacheForTests(): void {
  cachedProvider = null;
}
