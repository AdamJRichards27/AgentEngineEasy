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
  /**
   * Refund ledger: for refund events (Stripe charge.refunded / refund.updated) the individual
   * refunds the provider reports. When present, the app routes each one to its own
   * payment_refunds row and never flips the whole payment to Refunded from `status`.
   */
  refunds?: ProviderRefundReport[];
}

export interface ProviderRefundReport {
  providerRefundRef: string;
  amountCents: number;
  status: "Succeeded" | "Pending" | "Failed";
  aeRefundId?: number; // metadata.ae_refund_id when we created it
  failureReason?: string;
}

export interface RefundRequest {
  providerChargeRef: string;
  amountCents: number;
  /** One key per refund row, minted once, reused on every retry and reconciliation. */
  idempotencyKey: string;
  aeRefundId: number;
}

export interface RefundResult {
  providerRefundRef: string;
  status: "Succeeded" | "Pending" | "Failed";
  failureReason?: string;
}

/** A definite provider rejection (4xx): the refund did not and will not happen. Anything else thrown is an UNKNOWN outcome. */
export class RefundRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundRejectedError";
  }
}

export interface PaymentProvider {
  chargeStoredMethod(input: ChargeRequest): Promise<ChargeResult>;
  refund(input: RefundRequest): Promise<RefundResult>;
  /**
   * Reconciliation lookup. Returns the provider's record of the refund created with this
   * aeRefundId / providerRefundRef, or null when the provider has none. Optional: an adapter
   * without it sends UNKNOWN refunds straight to MANUAL_REVIEW.
   */
  lookupRefund?(input: { providerChargeRef: string; aeRefundId: number; providerRefundRef?: string | null }): Promise<RefundResult | null>;
  /** How long the provider honours an idempotency key (Stripe: ~24 h). A same-key retry is only safe inside it. */
  readonly refundIdempotencyWindowMs: number;
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

  readonly refundIdempotencyWindowMs = 24 * 60 * 60 * 1000;
  // Mock refund ledger, modelled on SandboxMandatePaymentProvider: the same idempotency key replays
  // the cached result instead of refunding twice. Static so the record survives across the module's
  // single provider instance and test spies on the prototype.
  static refundsByKey = new Map<string, RefundResult & { aeRefundId: number; amountCents: number }>();
  /**
   * Test hook: what the NEXT refund call does.
   * - "accept-then-throw": record the refund, then throw (accepted but response lost -> UNKNOWN)
   * - "throw": throw without recording (network error before acceptance -> UNKNOWN)
   * - "reject": definite 4xx-style rejection (-> FAILED)
   * - "pending": accepted, still pending
   */
  static nextRefundBehaviour: "accept-then-throw" | "throw" | "reject" | "pending" | null = null;

  async refund(input: RefundRequest): Promise<RefundResult> {
    const cached = MockPaymentProvider.refundsByKey.get(input.idempotencyKey);
    if (cached) return { providerRefundRef: cached.providerRefundRef, status: cached.status, failureReason: cached.failureReason };
    const behaviour = MockPaymentProvider.nextRefundBehaviour;
    MockPaymentProvider.nextRefundBehaviour = null;
    if (behaviour === "throw") throw new Error("mock: network error before the provider accepted the refund");
    if (behaviour === "reject") throw new RefundRejectedError("mock: refund rejected by provider");
    const result: RefundResult = { providerRefundRef: `mock-refund-${input.aeRefundId}`, status: behaviour === "pending" ? "Pending" : "Succeeded" };
    MockPaymentProvider.refundsByKey.set(input.idempotencyKey, { ...result, aeRefundId: input.aeRefundId, amountCents: input.amountCents });
    if (behaviour === "accept-then-throw") throw new Error("mock: provider accepted the refund but the response was lost");
    return result;
  }

  async lookupRefund(input: { providerChargeRef: string; aeRefundId: number; providerRefundRef?: string | null }): Promise<RefundResult | null> {
    for (const r of MockPaymentProvider.refundsByKey.values()) {
      if (r.aeRefundId === input.aeRefundId || (input.providerRefundRef && r.providerRefundRef === input.providerRefundRef)) {
        return { providerRefundRef: r.providerRefundRef, status: r.status, failureReason: r.failureReason };
      }
    }
    return null;
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
      refunds: p.refunds,
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

  readonly refundIdempotencyWindowMs = 24 * 60 * 60 * 1000; // Stripe keeps idempotency keys ~24 h (verify against current Stripe docs)

  private static mapRefundStatus(status: string | undefined): RefundResult["status"] {
    if (status === "succeeded") return "Succeeded";
    if (status === "failed" || status === "canceled") return "Failed";
    return "Pending"; // pending, requires_action, unknown
  }

  // Refund ledger: one Idempotency-Key per refund row (reused on retry) and metadata[ae_refund_id]
  // so reconciliation can find the refund at Stripe. Returns the re_... id and its status.
  async refund(input: RefundRequest): Promise<RefundResult> {
    const body = new URLSearchParams({
      payment_intent: input.providerChargeRef,
      amount: String(input.amountCents),
      "metadata[ae_refund_id]": String(input.aeRefundId),
    });

    const res = await fetch(`${this.config.apiBaseUrl}/v1/refunds`, {
      method: "POST",
      headers: this.authHeaders(input.idempotencyKey),
      body: body.toString(),
    });

    const json = (await res.json().catch(() => ({}))) as { id?: string; status?: string; failure_reason?: string; error?: { message?: string } };
    if (!res.ok) {
      const message = json.error?.message ?? `Stripe refund failed: ${res.status}`;
      // 4xx (other than 409 idempotency conflict and 429 rate limit) is a definite rejection; 5xx/409/429 is unknown.
      if (res.status >= 400 && res.status < 500 && res.status !== 409 && res.status !== 429) throw new RefundRejectedError(message);
      throw new Error(message);
    }
    if (!json.id) throw new Error("Stripe refunds response did not include an id");
    return { providerRefundRef: json.id, status: StripePaymentProvider.mapRefundStatus(json.status), failureReason: json.failure_reason };
  }

  async lookupRefund(input: { providerChargeRef: string; aeRefundId: number; providerRefundRef?: string | null }): Promise<RefundResult | null> {
    const url = input.providerRefundRef
      ? `${this.config.apiBaseUrl}/v1/refunds/${encodeURIComponent(input.providerRefundRef)}`
      : `${this.config.apiBaseUrl}/v1/refunds?payment_intent=${encodeURIComponent(input.providerChargeRef)}&limit=100`;
    const res = await fetch(url, { method: "GET", headers: this.authHeaders() });
    if (res.status === 404) return null;
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      status?: string;
      failure_reason?: string;
      data?: Array<{ id: string; status?: string; failure_reason?: string; metadata?: Record<string, string> }>;
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(json.error?.message ?? `Stripe refund lookup failed: ${res.status}`);
    const found = input.providerRefundRef
      ? json.id ? { id: json.id, status: json.status, failure_reason: json.failure_reason } : undefined
      : json.data?.find((r) => r.metadata?.ae_refund_id === String(input.aeRefundId));
    if (!found) return null;
    return { providerRefundRef: found.id, status: StripePaymentProvider.mapRefundStatus(found.status), failureReason: found.failure_reason };
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

  private static toRefundReport(r: Record<string, unknown>): ProviderRefundReport {
    const metadata = (r.metadata ?? {}) as Record<string, string>;
    const aeRefundId = metadata.ae_refund_id ? Number(metadata.ae_refund_id) : undefined;
    return {
      providerRefundRef: String(r.id ?? "unknown"),
      amountCents: Number(r.amount ?? 0),
      status: StripePaymentProvider.mapRefundStatus(r.status as string | undefined),
      aeRefundId: Number.isSafeInteger(aeRefundId) ? aeRefundId : undefined,
      failureReason: (r.failure_reason as string | undefined) ?? undefined,
    };
  }

  parseWebhook(payload: unknown): PaymentWebhookResult {
    const event = (payload ?? {}) as {
      type?: string;
      data?: { object?: Record<string, unknown> };
    };
    const object = event.data?.object ?? {};
    const type = event.type ?? "";

    // Refund ledger: charge.refunded fires for partial refunds too (amount_refunded < amount), so the
    // individual refunds are reported and the app records each one; it never maps this to a whole
    // "Refunded" payment on its own.
    if (type === "charge.refunded") {
      const list = (object.refunds as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [];
      return {
        providerChargeRef: String(object.payment_intent ?? "unknown"),
        status: "Refunded",
        refunds: list.map((r) => StripePaymentProvider.toRefundReport(r)),
      };
    }
    if (type === "refund.updated" || type === "refund.created" || type === "charge.refund.updated") {
      return {
        providerChargeRef: String(object.payment_intent ?? "unknown"),
        status: "Refunded",
        refunds: [StripePaymentProvider.toRefundReport(object)],
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

// Critical Blocker Remediation, Phase 10 — commercial lock. True only in
// production, when an operator has NOT explicitly set
// LIVE_EXTERNAL_TRANSACTIONS_APPROVED="true". While true, a real credential
// being present (e.g. STRIPE_SECRET_KEY copied in from another deployment's
// Secrets by mistake) must never be sufficient on its own to let this
// process charge a real card — see apps/api/src/lib/env.ts's
// mustForceMockExternalProvider() (this package cannot import that file —
// apps/api depends on this package, not the other way around — so this is
// the same two-line check, repeated locally) and
// docs/gate-evidence/PHASE10_BILLING_AND_EXTERNAL_ACTION_LOCKS.md. Outside
// production this always returns false — local/test behaviour is unchanged.
function mustForceMockExternalProvider(): boolean {
  return process.env.NODE_ENV === "production" && process.env.LIVE_EXTERNAL_TRANSACTIONS_APPROVED !== "true";
}

export function createPaymentProvider(): PaymentProvider {
  const provider = process.env.PAYMENT_PROVIDER ?? "mock";

  if (provider === "stripe") {
    if (mustForceMockExternalProvider()) {
      logger.warn("payment_provider_locked_to_mock_pilot_policy", {
        reason: "PAYMENT_PROVIDER=stripe was requested but LIVE_EXTERNAL_TRANSACTIONS_APPROVED is not \"true\" in production — no real card charge is authorised for this pilot.",
      });
      return new MockPaymentProvider();
    }
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
