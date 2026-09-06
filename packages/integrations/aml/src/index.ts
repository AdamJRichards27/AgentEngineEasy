import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "@aee/events";

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
  /** Optional correlation fields returned by providers.  They are checked
   * against the verification we created; they are never used as authority. */
  propertyId?: number;
  partyId?: number;
  brokerageId?: number;
  provider?: string;
}

export interface AMLProvider {
  requestVerification(input: AMLVerificationRequest): Promise<{ providerReference: string }>;
  // `payload` should be the raw request body (Buffer/string) whenever the
  // provider signs raw bytes, which is the normal case for HMAC-based
  // webhook signatures — re-serialising parsed JSON can byte-for-byte
  // differ from what was actually signed and silently break verification.
  verifyWebhookSignature(payload: unknown, signature: string, timestamp: string): boolean;
  parseWebhook(payload: unknown): AMLWebhookResult;
}

/**
 * Mock provider — ships by default. A real adapter (matching the swappable
 * factory/interface pattern already proven for AML in Agent Engine Staging)
 * implements the same interface; workflow code never changes.
 */
export class MockAMLProvider implements AMLProvider {
  // Keep the mock's secret lookup lazy: route test helpers configure their
  // sandbox secret after importing shared fixtures, while production still
  // fails closed when no secret has been configured.
  constructor(private readonly webhookSecret?: string) {}

  async requestVerification(input: AMLVerificationRequest): Promise<{ providerReference: string }> {
    return { providerReference: `mock-aml-${input.partyId}-${Date.now()}` };
  }

  verifyWebhookSignature(payload: unknown, signature: string, timestamp: string): boolean {
    return verifyTimestampedSignature(payload, signature, timestamp, this.webhookSecret ?? process.env.AML_WEBHOOK_SECRET ?? "");
  }

  parseWebhook(payload: unknown): AMLWebhookResult {
    const p = (payload ?? {}) as Partial<AMLWebhookResult>;
    if (
      typeof p.providerReference !== "string" ||
      !p.providerReference ||
      (p.outcome !== "VERIFIED" && p.outcome !== "PARTIALLY_VERIFIED" && p.outcome !== "UNABLE_TO_VERIFY") ||
      typeof p.reviewRequired !== "boolean"
    ) {
      throw new Error("Malformed AML webhook payload: providerReference, outcome and reviewRequired are required.");
    }
    return {
      providerReference: p.providerReference,
      outcome: p.outcome,
      riskLevel: p.riskLevel,
      reviewRequired: p.reviewRequired,
      propertyId: p.propertyId,
      partyId: p.partyId,
      brokerageId: p.brokerageId,
      provider: p.provider,
    };
  }
}

export interface HttpAMLProviderConfig {
  baseUrl: string;
  apiKey: string;
  webhookSecret: string;
}

/**
 * Generic REST + HMAC-webhook adapter (Phase 4, ARCHITECTURE.md §10).
 *
 * No specific AML/KYC vendor has been procured yet, so this targets a
 * plain, documented-shape REST contract (POST /verifications to start a
 * check, an HMAC-SHA256-signed webhook to report the outcome) rather than
 * a named vendor's exact API — the field mapping in `parseWebhook` below
 * will need adjusting once a real vendor contract exists, but the
 * request/response handling, error handling, and signature verification
 * are genuine, not mocked. Swapping vendors should only ever mean editing
 * this one file — the `AMLProvider` interface and every caller stay the
 * same, matching the proven Agent Engine Staging pattern.
 */
export class HttpAMLProvider implements AMLProvider {
  constructor(private readonly config: HttpAMLProviderConfig) {}

  async requestVerification(input: AMLVerificationRequest): Promise<{ providerReference: string }> {
    const res = await fetch(`${this.config.baseUrl}/verifications`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        verificationType: input.verificationType,
        subject: {
          firstName: input.partyDetails.firstName,
          middleName: input.partyDetails.middleName,
          lastName: input.partyDetails.lastName,
          email: input.partyDetails.email,
          mobile: input.partyDetails.mobile,
          address: input.partyDetails.residentialAddress,
        },
        // Lets the provider's dashboard/support correlate a case back to
        // AgentEngineEasy without us having to store their internal IDs
        // anywhere except providerReference.
        externalReference: `property:${input.propertyId}:party:${input.partyId}`,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`AML provider requestVerification failed: ${res.status} ${body}`);
    }

    const body = (await res.json()) as { id?: string; reference?: string };
    const providerReference = body.id ?? body.reference;
    if (!providerReference) {
      throw new Error("AML provider response did not include a verification reference");
    }
    return { providerReference };
  }

  verifyWebhookSignature(payload: unknown, signature: string, timestamp: string): boolean {
    return verifyTimestampedSignature(payload, signature, timestamp, this.config.webhookSecret);
  }

  parseWebhook(payload: unknown): AMLWebhookResult {
    const p = (payload ?? {}) as Record<string, unknown>;
    const rawOutcome = String(p.status ?? p.outcome ?? "").toLowerCase();

    const outcomeMap: Record<string, AMLWebhookResult["outcome"]> = {
      verified: "VERIFIED",
      passed: "VERIFIED",
      partial: "PARTIALLY_VERIFIED",
      partially_verified: "PARTIALLY_VERIFIED",
      manual_review: "PARTIALLY_VERIFIED",
      failed: "UNABLE_TO_VERIFY",
      unable_to_verify: "UNABLE_TO_VERIFY",
      declined: "UNABLE_TO_VERIFY",
    };
    const providerReference = p.id ?? p.reference ?? p.providerReference;
    if (typeof providerReference !== "string" || !providerReference || !outcomeMap[rawOutcome]) {
      throw new Error("Malformed AML webhook payload: provider reference and a recognised outcome are required.");
    }

    return {
      providerReference,
      outcome: outcomeMap[rawOutcome],
      riskLevel: typeof p.riskLevel === "string" ? p.riskLevel : typeof p.risk_level === "string" ? p.risk_level : undefined,
      reviewRequired: Boolean(p.reviewRequired ?? p.review_required ?? rawOutcome === "manual_review"),
      propertyId: typeof p.propertyId === "number" ? p.propertyId : undefined,
      partyId: typeof p.partyId === "number" ? p.partyId : undefined,
      brokerageId: typeof p.brokerageId === "number" ? p.brokerageId : undefined,
      provider: typeof p.provider === "string" ? p.provider : undefined,
    };
  }
}

function verifyTimestampedSignature(payload: unknown, signature: string, timestamp: string, secret: string): boolean {
  if (!signature || !timestamp || !secret) return false;
  const raw = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const givenBuf = Buffer.from(signature, "utf8");
  // Different-length buffers must still short-circuit safely — comparing
  // unequal-length buffers with timingSafeEqual throws rather than
  // returning false.
  if (expectedBuf.length !== givenBuf.length) return false;
  return timingSafeEqual(expectedBuf, givenBuf);
}

// Critical Blocker Remediation, Phase 10 — external-action lock. Same check
// (and same reasoning for why it's repeated locally rather than imported)
// as packages/integrations/payments/src/index.ts's own
// mustForceMockExternalProvider() — see that file's comment and
// docs/gate-evidence/PHASE10_BILLING_AND_EXTERNAL_ACTION_LOCKS.md.
function mustForceMockExternalProvider(): boolean {
  return process.env.NODE_ENV === "production" && process.env.LIVE_EXTERNAL_TRANSACTIONS_APPROVED !== "true";
}

export function createAMLProvider(): AMLProvider {
  const provider = process.env.AML_PROVIDER ?? "mock";

  if (provider === "http") {
    if (mustForceMockExternalProvider()) {
      logger.warn("aml_provider_locked_to_mock_pilot_policy", {
        reason: "AML_PROVIDER=http was requested but LIVE_EXTERNAL_TRANSACTIONS_APPROVED is not \"true\" in production — no real AML verification action is authorised for this pilot.",
      });
      return new MockAMLProvider();
    }
    const baseUrl = process.env.AML_API_BASE_URL;
    const apiKey = process.env.AML_PROVIDER_API_KEY;
    const webhookSecret = process.env.AML_WEBHOOK_SECRET;
    if (baseUrl && apiKey && webhookSecret) {
      return new HttpAMLProvider({ baseUrl, apiKey, webhookSecret });
    }
    logger.warn("aml_provider_fallback_to_mock", {
      reason: "AML_PROVIDER=http but AML_API_BASE_URL/AML_PROVIDER_API_KEY/AML_WEBHOOK_SECRET are not all set",
    });
  }

  return new MockAMLProvider();
}
