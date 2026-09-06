import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "@aee/events";

export interface ChargeRequest {
  paymentMethodProviderRef: string;
  providerCustomerRef: string;
  amountCents: number;
  currency: "AUD";
  idempotencyKey: string; // required on every charge (Build Brief §21)
  description: string;
}

export interface ChargeResult {
  providerChargeRef: string;
  status: "Succeeded" | "Failed";
  receiptUrl?: string;
  failureReason?: string;
}

export interface PaymentWebhookResult {
  providerChargeRef: string;
  status: "Succeeded" | "Failed" | "Refunded";
  receiptUrl?: string;
  failureReason?: string;
}

export interface PaymentProvider {
  chargeStoredMethod(input: ChargeRequest): Promise<ChargeResult>;
  refund(providerChargeRef: string, amountCents: number): Promise<void>;
  // Same shape as the AML/ESign providers (packages/integrations/aml, /esign)
  // — `payload` should be the raw request body whenever the provider signs
  // raw bytes, which is the normal case for HMAC-based webhook signatures.
  verifyWebhookSignature(payload: unknown, signature: string): boolean;
  parseWebhook(payload: unknown): PaymentWebhookResult;
}

/**
 * Mock provider — ships by default so charging a ServiceOrder works
 * end-to-end without real credentials. Real adapter is StripePaymentProvider
 * below.
 */
export class MockPaymentProvider implements PaymentProvider {
  private charged = new Set<string>(); // idempotency guard, in-memory for the mock

  async chargeStoredMethod(input: ChargeRequest): Promise<ChargeResult> {
    if (this.charged.has(input.idempotencyKey)) {
      throw new Error(`Duplicate charge attempt for idempotencyKey=${input.idempotencyKey}`);
    }
    this.charged.add(input.idempotencyKey);
    return {
      providerChargeRef: `mock-charge-${input.idempotencyKey}`,
      status: "Succeeded",
      receiptUrl: undefined,
    };
  }

  async refund(_providerChargeRef: string, _amountCents: number): Promise<void> {
    // no-op for the mock provider
  }

  verifyWebhookSignature(_payload: unknown, _signature: string): boolean {
    return true;
  }

  parseWebhook(payload: unknown): PaymentWebhookResult {
    const p = payload as Partial<PaymentWebhookResult>;
    return {
      providerChargeRef: p.providerChargeRef ?? "unknown",
      status: p.status ?? "Succeeded",
      receiptUrl: p.receiptUrl,
      failureReason: p.failureReason,
    };
  }
}

export interface StripePaymentProviderConfig {
  secretKey: string;
  webhookSecret: string;
  // Overridable so this can be pointed at a local fake-Stripe HTTP server
  // for live verification — mirrors AML_API_BASE_URL/ESIGN_API_BASE_URL.
  // Real Stripe SDKs support the same kind of host override for testing.
  apiBaseUrl: string;
}

/**
 * Real Stripe REST + webhook adapter (Phase 6, ARCHITECTURE.md §10). Unlike
 * HttpAMLProvider/HttpESignProvider (generic documented-shape contracts —
 * no AML/e-sign vendor procured yet), Stripe is a specifically named vendor
 * already referenced in .env.example since Phase 1, so this targets
 * Stripe's actual REST API shape (form-encoded bodies, Idempotency-Key
 * header, PaymentIntents) rather than a placeholder contract.
 *
 * Scope limitation, stated plainly: real card capture has to happen
 * client-side via Stripe Elements/PaymentSheet (raw card data must never
 * transit this server — a hard requirement, not a style choice). This
 * adapter charges an *already-tokenized* stored payment method
 * (providerPaymentMethodRef) against an already-created Stripe customer
 * (providerCustomerRef); building the client-side card-capture flow is a
 * separate, later piece of work, same as how HttpAMLProvider/HttpESignProvider
 * ship without a procured vendor contract.
 */
export class StripePaymentProvider implements PaymentProvider {
  constructor(private readonly config: StripePaymentProviderConfig) {}

  private authHeaders(idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    return headers;
  }

  async chargeStoredMethod(input: ChargeRequest): Promise<ChargeResult> {
    const body = new URLSearchParams({
      amount: String(input.amountCents),
      currency: input.currency.toLowerCase(),
      customer: input.providerCustomerRef,
      payment_method: input.paymentMethodProviderRef,
      off_session: "true",
      confirm: "true",
      description: input.description,
    });

    const res = await fetch(`${this.config.apiBaseUrl}/v1/payment_intents`, {
      method: "POST",
      headers: this.authHeaders(input.idempotencyKey),
      body: body.toString(),
    });

    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      status?: string;
      charges?: { data?: Array<{ receipt_url?: string }> };
      last_payment_error?: { message?: string; code?: string };
      error?: { message?: string; code?: string };
    };

    if (!res.ok) {
      const message = json.error?.message ?? `Stripe request failed: ${res.status}`;
      throw new Error(message);
    }

    if (!json.id) {
      throw new Error("Stripe payment_intents response did not include an id");
    }

    if (json.status === "succeeded") {
      return {
        providerChargeRef: json.id,
        status: "Succeeded",
        receiptUrl: json.charges?.data?.[0]?.receipt_url,
      };
    }

    // Anything other than "succeeded" (requires_action, requires_payment_method,
    // canceled, etc.) is treated as a failed off-session charge here — a full
    // implementation would need to bring the customer back on-session for
    // 3DS/SCA (authentication_required), which is out of scope for this phase.
    return {
      providerChargeRef: json.id,
      status: "Failed",
      failureReason: json.last_payment_error?.message ?? `Stripe status: ${json.status ?? "unknown"}`,
    };
  }

  async refund(providerChargeRef: string, amountCents: number): Promise<void> {
    const body = new URLSearchParams({
      payment_intent: providerChargeRef,
      amount: String(amountCents),
    });

    const res = await fetch(`${this.config.apiBaseUrl}/v1/refunds`, {
      method: "POST",
      headers: this.authHeaders(),
      body: body.toString(),
    });

    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(json.error?.message ?? `Stripe refund failed: ${res.status}`);
    }
  }

  // Real Stripe signature scheme: header is "t=<timestamp>,v1=<hex hmac>"
  // (and sometimes an older "v0="); the signed payload is
  // "<timestamp>.<raw body>", HMAC-SHA256'd with the webhook signing secret.
  // A 5-minute tolerance window matches Stripe's own documented default.
  verifyWebhookSignature(payload: unknown, signature: string): boolean {
    if (!signature) return false;
    const raw = Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");

    const parts = Object.fromEntries(
      signature.split(",").map((kv) => {
        const [k, v] = kv.split("=");
        return [k, v];
      }),
    );
    const timestamp = parts.t;
    const v1 = parts.v1;
    if (!timestamp || !v1) return false;

    const toleranceSeconds = 300;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return false;

    const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), raw]);
    const expected = createHmac("sha256", this.config.webhookSecret).update(signedPayload).digest("hex");
    const expectedBuf = Buffer.from(expected, "utf8");
    const givenBuf = Buffer.from(v1, "utf8");
    if (expectedBuf.length !== givenBuf.length) return false;
    return timingSafeEqual(expectedBuf, givenBuf);
  }

  parseWebhook(payload: unknown): PaymentWebhookResult {
    const event = (payload ?? {}) as {
      type?: string;
      data?: { object?: Record<string, unknown> };
    };
    const object = event.data?.object ?? {};
    const type = event.type ?? "";

    if (type === "charge.refunded") {
      return {
        providerChargeRef: String(object.payment_intent ?? "unknown"),
        status: "Refunded",
      };
    }

    if (type === "payment_intent.payment_failed") {
      const lastError = object.last_payment_error as { message?: string } | undefined;
      return {
        providerChargeRef: String(object.id ?? "unknown"),
        status: "Failed",
        failureReason: lastError?.message ?? "Payment failed",
      };
    }

    // payment_intent.succeeded (and anything else unrecognised — treated as
    // an outcome-aware no-op-until-different rather than a silent success).
    const charges = object.charges as { data?: Array<{ receipt_url?: string }> } | undefined;
    return {
      providerChargeRef: String(object.id ?? "unknown"),
      status: "Succeeded",
      receiptUrl: charges?.data?.[0]?.receipt_url,
    };
  }
}

export function createPaymentProvider(): PaymentProvider {
  const provider = process.env.PAYMENT_PROVIDER ?? "mock";

  if (provider === "stripe") {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const apiBaseUrl = process.env.STRIPE_API_BASE_URL ?? "https://api.stripe.com";
    if (secretKey && webhookSecret) {
      return new StripePaymentProvider({ secretKey, webhookSecret, apiBaseUrl });
    }
    logger.warn("payment_provider_fallback_to_mock", {
      reason: "PAYMENT_PROVIDER=stripe but STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET are not both set",
    });
  }

  return new MockPaymentProvider();
}
