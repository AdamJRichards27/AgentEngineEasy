import type { BillingProvider } from "@aee/integration-billing";
import { MockBillingProvider, StripeBillingProvider } from "@aee/integration-billing";

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
export function getBillingProvider(): BillingProvider {
  if (cachedProvider) return cachedProvider;

  const config = loadBillingGatewayConfig();
  if (config.providerName === "stripe") {
    if (!config.stripeSecretKey) {
      console.error(
        "BILLING_PROVIDER=stripe but STRIPE_SECRET_KEY is not set - falling back to MockBillingProvider",
      );
      cachedProvider = new MockBillingProvider();
      return cachedProvider;
    }
    cachedProvider = new StripeBillingProvider({
      secretKey: config.stripeSecretKey,
      webhookSecret: config.stripeWebhookSecret ?? "",
      apiBaseUrl: config.stripeApiBaseUrl,
    });
    return cachedProvider;
  }

  cachedProvider = new MockBillingProvider();
  return cachedProvider;
}

// Test-only escape hatch so a suite can force a fresh provider between cases.
export function resetBillingProviderCacheForTests(): void {
  cachedProvider = null;
}
