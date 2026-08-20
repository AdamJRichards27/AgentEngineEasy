export interface ChargeRequest {
  paymentMethodProviderRef: string;
  amountCents: number;
  currency: "AUD";
  idempotencyKey: string; // required on every charge (Build Brief §21)
  description: string;
}

export interface ChargeResult {
  providerChargeRef: string;
  status: "Succeeded" | "Failed";
  receiptUrl?: string;
}

export interface PaymentProvider {
  chargeStoredMethod(input: ChargeRequest): Promise<ChargeResult>;
  refund(providerChargeRef: string, amountCents: number): Promise<void>;
}

/**
 * Mock provider — ships by default. A real adapter (Stripe, matching the
 * factory/interface pattern already proven for payments in Agent Engine
 * Staging's AML module) implements the same interface.
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
}

export function createPaymentProvider(): PaymentProvider {
  const provider = process.env.PAYMENT_PROVIDER ?? "mock";
  switch (provider) {
    case "mock":
    default:
      return new MockPaymentProvider();
    // case "stripe": return new StripePaymentProvider(...);
  }
}
