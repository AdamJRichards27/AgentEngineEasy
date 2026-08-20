export interface AMLVerificationRequest {
  propertyId: number;
  partyId: number;
  verificationType: string;
  partyDetails: {
    firstName?: string;
    middleName?: string;
    lastName?: string;
    email?: string;
    mobile?: string;
    residentialAddress?: string;
  };
}

export interface AMLWebhookResult {
  providerReference: string;
  outcome: "VERIFIED" | "PARTIALLY_VERIFIED" | "UNABLE_TO_VERIFY";
  riskLevel?: string;
  reviewRequired: boolean;
}

export interface AMLProvider {
  requestVerification(input: AMLVerificationRequest): Promise<{ providerReference: string }>;
  verifyWebhookSignature(payload: unknown, signature: string): boolean;
  parseWebhook(payload: unknown): AMLWebhookResult;
}

/**
 * Mock provider — ships by default. A real adapter (matching the swappable
 * factory/interface pattern already proven for AML in Agent Engine Staging)
 * implements the same interface; workflow code never changes.
 */
export class MockAMLProvider implements AMLProvider {
  async requestVerification(input: AMLVerificationRequest): Promise<{ providerReference: string }> {
    return { providerReference: `mock-aml-${input.partyId}-${Date.now()}` };
  }

  verifyWebhookSignature(_payload: unknown, _signature: string): boolean {
    return true; // mock provider — no real signature to verify
  }

  parseWebhook(payload: unknown): AMLWebhookResult {
    const p = payload as Partial<AMLWebhookResult>;
    return {
      providerReference: p.providerReference ?? "unknown",
      outcome: p.outcome ?? "VERIFIED",
      riskLevel: p.riskLevel,
      reviewRequired: p.reviewRequired ?? false,
    };
  }
}

export function createAMLProvider(): AMLProvider {
  const provider = process.env.AML_PROVIDER ?? "mock";
  switch (provider) {
    case "mock":
    default:
      return new MockAMLProvider();
  }
}
