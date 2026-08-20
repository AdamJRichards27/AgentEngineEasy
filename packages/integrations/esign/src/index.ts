export interface DocumentPackageInput {
  packageId: number;
  documents: Array<{ documentId: number; title: string; objectStorageKey: string }>;
  signatories: Array<{ partyId: number; name: string; email: string }>;
}

export interface ESignWebhookResult {
  providerReference: string;
  status: "PartiallySigned" | "Completed" | "Voided";
  completedDocumentKey?: string;
}

export interface ESignProvider {
  createEnvelope(pkg: DocumentPackageInput): Promise<{ providerReference: string }>;
  verifyWebhookSignature(payload: unknown, signature: string): boolean;
  parseWebhook(payload: unknown): ESignWebhookResult;
}

/**
 * Mock provider — ships by default so Send for Signature works end-to-end
 * without real credentials. Real adapter (DocuSign/Adobe Sign-equivalent)
 * implements the same interface behind ESignProvider.
 */
export class MockESignProvider implements ESignProvider {
  async createEnvelope(pkg: DocumentPackageInput): Promise<{ providerReference: string }> {
    return { providerReference: `mock-envelope-${pkg.packageId}-${Date.now()}` };
  }

  verifyWebhookSignature(_payload: unknown, _signature: string): boolean {
    return true;
  }

  parseWebhook(payload: unknown): ESignWebhookResult {
    const p = payload as Partial<ESignWebhookResult>;
    return {
      providerReference: p.providerReference ?? "unknown",
      status: p.status ?? "Completed",
      completedDocumentKey: p.completedDocumentKey,
    };
  }
}

export function createESignProvider(): ESignProvider {
  const provider = process.env.ESIGN_PROVIDER ?? "mock";
  switch (provider) {
    case "mock":
    default:
      return new MockESignProvider();
  }
}
