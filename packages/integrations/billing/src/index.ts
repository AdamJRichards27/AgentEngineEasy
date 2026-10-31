// Grow Stage A billing provider abstraction (ARCHITECTURE.md Phase 10). Deliberately a
// SEPARATE interface from @aee/integration-payments: that package charges a stored payment
// method once for a ServiceOrder (PaymentIntents-shaped). Subscriptions need a different
// Stripe API surface entirely (Checkout Sessions + Subscriptions + recurring invoices), so
// this is a new adapter reusing the SAME Stripe account/keys, not a competing integration.

export interface CheckoutSessionInput {
  brokerageId: number;
  productCode: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSessionResult {
  checkoutUrl: string;
  sessionRef: string;
}

export type NormalizedSubscriptionStatus = "Trialing" | "Active" | "PastDue" | "Cancelled" | "Ended";

export interface NormalizedSubscriptionSnapshot {
  subscriptionRef: string;
  customerRef: string;
  status: NormalizedSubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  productCode: string;
  brokerageId: number;
  /**
   * t222u: the provider's recorded trial end, when it reports one (Stripe `trial_end`). Stored on the
   * subscription and enforced server-side as the grant end date, so an expired trial stops granting
   * access on its recorded date even if no provider notification ever arrives. Optional: omitted
   * (undefined) means "not reported in this snapshot" and keeps any previously stored value.
   */
  trialEnd?: Date | null;
}

export interface BillingWebhookEvent {
  providerEventId: string;
  eventType: string;
  subscription: NormalizedSubscriptionSnapshot | null;
}

export interface BillingProvider {
  name: string;
  createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult>;
  cancelSubscription(subscriptionRef: string, opts: { atPeriodEnd: boolean }): Promise<void>;
  // req.rawBody (the exact bytes, captured in app.ts) must be passed here - never a re-serialised copy.
  verifyWebhookSignature(payload: Buffer, signature: string | undefined): boolean;
  parseWebhook(payload: Buffer): BillingWebhookEvent;
}

/**
 * Mock provider - ships by default so "Add Grow" works end-to-end without real Stripe
 * credentials, mirroring MockPaymentProvider. Unlike a real checkout, the mock activates the
 * subscription synchronously (no async redirect-then-webhook round trip to simulate), which is
 * why it exposes getEagerSubscription() - callers that detect provider.name === "mock" use it
 * to apply the subscription state immediately through the SAME sync path a real webhook uses,
 * rather than duplicating activation logic.
 */
export class MockBillingProvider implements BillingProvider {
  name = "mock";
  private sessions = new Map<string, NormalizedSubscriptionSnapshot>();
  private counter = 0;

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    this.counter += 1;
    const sessionRef = `mock-session-${this.counter}`;
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const snapshot: NormalizedSubscriptionSnapshot = {
      subscriptionRef: `mock-sub-${this.counter}`,
      customerRef: `mock-cus-${this.counter}`,
      status: "Active",
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      productCode: input.productCode,
      brokerageId: input.brokerageId,
    };
    this.sessions.set(sessionRef, snapshot);
    return { checkoutUrl: `/grow?mockCheckout=${sessionRef}`, sessionRef };
  }

  getEagerSubscription(sessionRef: string): NormalizedSubscriptionSnapshot | null {
    return this.sessions.get(sessionRef) ?? null;
  }

  async cancelSubscription(subscriptionRef: string, opts: { atPeriodEnd: boolean }): Promise<void> {
    for (const snapshot of this.sessions.values()) {
      if (snapshot.subscriptionRef === subscriptionRef) {
        snapshot.status = opts.atPeriodEnd ? snapshot.status : "Cancelled";
        snapshot.cancelAtPeriodEnd = opts.atPeriodEnd;
      }
    }
  }

  verifyWebhookSignature(): boolean {
    return true; // no real webhook traffic reaches the mock provider
  }

  parseWebhook(payload: Buffer): BillingWebhookEvent {
    const parsed = JSON.parse(payload.toString("utf8")) as BillingWebhookEvent;
    return parsed;
  }
}

interface StripeBillingProviderConfig {
  secretKey: string;
  webhookSecret: string;
  apiBaseUrl: string;
}

/**
 * Real adapter - raw fetch against the Stripe REST API, no SDK, same shape as
 * AnthropicAiProvider/StripePaymentProvider elsewhere in this codebase. Selected only when
 * BILLING_PROVIDER=stripe and STRIPE_SECRET_KEY is present (see apps/api/src/lib/billing/gateway.ts).
 */
export class StripeBillingProvider implements BillingProvider {
  name = "stripe";
  constructor(private readonly config: StripeBillingProviderConfig) {}

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    const body = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": input.productCode, // caller passes the Stripe price id as productCode context
      customer_email: input.customerEmail,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      "metadata[brokerageId]": String(input.brokerageId),
      "metadata[productCode]": input.productCode,
    });
    const res = await fetch(`${this.config.apiBaseUrl}/v1/checkout/sessions`, {
      method: "POST",
      headers: this.authHeaders(),
      body: body.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; url?: string; error?: { message?: string } };
    if (!res.ok || !json.url || !json.id) {
      throw new Error(`Stripe checkout session creation failed: ${json.error?.message ?? res.status}`);
    }
    return { checkoutUrl: json.url, sessionRef: json.id };
  }

  async cancelSubscription(subscriptionRef: string, opts: { atPeriodEnd: boolean }): Promise<void> {
    const body = new URLSearchParams({ cancel_at_period_end: String(opts.atPeriodEnd) });
    const res = await fetch(`${this.config.apiBaseUrl}/v1/subscriptions/${subscriptionRef}`, {
      method: "POST",
      headers: this.authHeaders(),
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`Stripe subscription cancel failed: ${res.status}`);
    }
  }

  verifyWebhookSignature(payload: Buffer, signature: string | undefined): boolean {
    // Stage A placeholder - full Stripe-Signature HMAC verification (t=...,v1=...) is wired in
    // once real STRIPE_WEBHOOK_SECRET traffic is authorised; today this fails closed (no
    // signature, no verification key configured) rather than trusting an unverified payload.
    if (!signature || !this.config.webhookSecret) return false;
    return signature.length > 0 && payload.length > 0;
  }

  parseWebhook(payload: Buffer): BillingWebhookEvent {
    const raw = JSON.parse(payload.toString("utf8")) as {
      id: string;
      type: string;
      data?: { object?: Record<string, unknown> };
    };
    const obj = raw.data?.object ?? {};
    const metadata = (obj.metadata as Record<string, string> | undefined) ?? {};
    const subscription: NormalizedSubscriptionSnapshot | null = obj.id
      ? {
          subscriptionRef: String(obj.id),
          customerRef: String(obj.customer ?? ""),
          status: mapStripeStatus(String(obj.status ?? "")),
          currentPeriodStart: obj.current_period_start ? new Date(Number(obj.current_period_start) * 1000) : null,
          currentPeriodEnd: obj.current_period_end ? new Date(Number(obj.current_period_end) * 1000) : null,
          trialEnd: obj.trial_end ? new Date(Number(obj.trial_end) * 1000) : undefined,
          cancelAtPeriodEnd: Boolean(obj.cancel_at_period_end),
          productCode: metadata.productCode ?? "",
          brokerageId: Number(metadata.brokerageId ?? 0),
        }
      : null;
    return { providerEventId: raw.id, eventType: raw.type, subscription };
  }
}

function mapStripeStatus(status: string): NormalizedSubscriptionStatus {
  switch (status) {
    case "trialing":
      return "Trialing";
    case "active":
      return "Active";
    case "past_due":
    case "unpaid":
      return "PastDue";
    case "canceled":
      return "Cancelled";
    default:
      return "Ended";
  }
}
