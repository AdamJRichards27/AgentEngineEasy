import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "@aee/events";

export interface DocumentPackageInput {
  packageId: number;
  documents: Array<{ documentId: number; title: string; objectStorageKey: string }>;
  signatories: Array<{ partyId: number; name: string; email: string }>;
}

export interface ESignWebhookResult {
  providerReference: string;
  status: "PartiallySigned" | "Completed" | "Voided";
  completedDocuments?: Array<{
    documentId: number;
    contentBase64: string;
    filename: string;
    contentType: string;
  }>;
}

export interface ESignProvider {
  createEnvelope(pkg: DocumentPackageInput): Promise<{ providerReference: string }>;
  // See the AML provider's equivalent comment (packages/integrations/aml) —
  // `payload` should be the raw request body whenever the provider signs
  // raw bytes, which is the normal case for HMAC-based webhook signatures.
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
      completedDocuments: p.completedDocuments,
    };
  }
}

export interface HttpESignProviderConfig {
  baseUrl: string;
  apiKey: string;
  webhookSecret: string;
}

/**
 * Generic REST + HMAC-webhook adapter (Phase 5, ARCHITECTURE.md §10) —
 * same shape and same caveat as HttpAMLProvider (packages/integrations/aml):
 * no specific e-sign vendor procured yet, so this targets a plain
 * documented-shape REST contract (POST /envelopes, HMAC-SHA256-signed
 * webhook) rather than a named vendor's exact API. The request/response
 * handling and signature verification are genuine; `parseWebhook`'s field
 * mapping will need adjusting once a real vendor contract exists.
 */
export class HttpESignProvider implements ESignProvider {
  constructor(private readonly config: HttpESignProviderConfig) {}

  async createEnvelope(pkg: DocumentPackageInput): Promise<{ providerReference: string }> {
    const res = await fetch(`${this.config.baseUrl}/envelopes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        externalReference: `package:${pkg.packageId}`,
        documents: pkg.documents.map((d) => ({ id: d.documentId, title: d.title })),
        signatories: pkg.signatories.map((s) => ({ id: s.partyId, name: s.name, email: s.email })),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ESign provider createEnvelope failed: ${res.status} ${body}`);
    }

    const body = (await res.json()) as { id?: string; reference?: string };
    const providerReference = body.id ?? body.reference;
    if (!providerReference) {
      throw new Error("ESign provider response did not include an envelope reference");
    }
    return { providerReference };
  }

  verifyWebhookSignature(payload: unknown, signature: string): boolean {
    if (!signature) return false;
    const raw = Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
    const expected = createHmac("sha256", this.config.webhookSecret).update(raw).digest("hex");
    const expectedBuf = Buffer.from(expected, "utf8");
    const givenBuf = Buffer.from(signature, "utf8");
    if (expectedBuf.length !== givenBuf.length) return false;
    return timingSafeEqual(expectedBuf, givenBuf);
  }

  parseWebhook(payload: unknown): ESignWebhookResult {
    const p = (payload ?? {}) as Record<string, unknown>;
    const rawStatus = String(p.status ?? "").toLowerCase();
    const rawDocuments = Array.isArray(p.completedDocuments ?? p.completed_documents)
      ? (p.completedDocuments ?? p.completed_documents) as unknown[]
      : p.completedDocument ?? p.completed_document
        ? [p.completedDocument ?? p.completed_document]
        : [];

    const statusMap: Record<string, ESignWebhookResult["status"]> = {
      partially_signed: "PartiallySigned",
      in_progress: "PartiallySigned",
      completed: "Completed",
      signed: "Completed",
      voided: "Voided",
      declined: "Voided",
    };

    return {
      providerReference: String(p.id ?? p.reference ?? p.providerReference ?? "unknown"),
      status: statusMap[rawStatus] ?? "PartiallySigned",
      completedDocuments: rawDocuments
        .map((value) => value as Record<string, unknown>)
        .filter(
          (document) =>
            Number.isInteger(Number(document.documentId ?? document.document_id)) &&
            typeof (document.contentBase64 ?? document.content_base64) === "string" &&
            typeof document.filename === "string" &&
            typeof (document.contentType ?? document.content_type) === "string",
        )
        .map((document) => ({
          documentId: Number(document.documentId ?? document.document_id),
          contentBase64: String(document.contentBase64 ?? document.content_base64),
          filename: String(document.filename),
          contentType: String(document.contentType ?? document.content_type),
        })),
    };
  }
}

// Critical Blocker Remediation, Phase 10 — external-action lock. Same check
// (and same reasoning for why it's repeated locally rather than imported)
// as packages/integrations/payments/src/index.ts's own
// mustForceMockExternalProvider() — see that file's comment and
// docs/gate-evidence/PHASE10_BILLING_AND_EXTERNAL_ACTION_LOCKS.md.
function mustForceMockExternalProvider(): boolean {
  return process.env.NODE_ENV === "production" && process.env.LIVE_EXTERNAL_TRANSACTIONS_APPROVED !== "true";
}

export function createESignProvider(): ESignProvider {
  const provider = process.env.ESIGN_PROVIDER ?? "mock";

  if (provider === "http") {
    if (mustForceMockExternalProvider()) {
      logger.warn("esign_provider_locked_to_mock_pilot_policy", {
        reason: "ESIGN_PROVIDER=http was requested but LIVE_EXTERNAL_TRANSACTIONS_APPROVED is not \"true\" in production — no real e-signature action is authorised for this pilot.",
      });
      return new MockESignProvider();
    }
    const baseUrl = process.env.ESIGN_API_BASE_URL;
    const apiKey = process.env.ESIGN_PROVIDER_API_KEY;
    const webhookSecret = process.env.ESIGN_WEBHOOK_SECRET;
    if (baseUrl && apiKey && webhookSecret) {
      return new HttpESignProvider({ baseUrl, apiKey, webhookSecret });
    }
    logger.warn("esign_provider_fallback_to_mock", {
      reason: "ESIGN_PROVIDER=http but ESIGN_API_BASE_URL/ESIGN_PROVIDER_API_KEY/ESIGN_WEBHOOK_SECRET are not all set",
    });
  }

  return new MockESignProvider();
}
