// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
//
// Typed, versioned adapter contracts (Section 3) and the connection
// lifecycle's transition table (Section 4's "no connection without
// approval" state machine) — mirrors lib/exceptions/types.ts /
// lib/communications/types.ts's own schema-owns-the-enum,
// lib-owns-the-transitions split: packages/db/src/schema/integrations.ts
// declares INTEGRATION_CONNECTION_STATUSES as the enum, this file owns
// which moves between them are legal.

import type { IntegrationConnectionStatus } from "@aee/db";
import { incrementCounter } from "@aee/events";

export interface ActorRef {
  id: number;
  role: string;
}

export type IntegrationErrorReason =
  | "NOT_FOUND"
  | "TENANT_MISMATCH"
  | "INVALID_STATUS"
  | "VALIDATION"
  | "SCOPE_NOT_APPROVED"
  | "CAPABILITY_NOT_SUPPORTED"
  | "CONNECTION_NOT_USABLE"
  | "ENVIRONMENT_NOT_ALLOWED"
  | "ENTITLEMENT_DENIED"
  | "BROKERAGE_DISABLED"
  | "CONCURRENCY";

export class IntegrationError extends Error {
  reason: IntegrationErrorReason;
  constructor(reason: IntegrationErrorReason, message: string) {
    super(message);
    this.name = "IntegrationError";
    this.reason = reason;
    // AE Step 2 closure — Part B: every NOT_FOUND/TENANT_MISMATCH throw
    // site in this domain resolves a record scoped to the caller's
    // brokerageId and — like every other domain in this app — treats
    // "doesn't exist" and "belongs to another tenant" identically (never a
    // hint which case it was). Incrementing here, at the one constructor
    // every throw site shares, covers the whole domain without touching
    // each call site individually. See docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md.
    if (reason === "NOT_FOUND" || reason === "TENANT_MISMATCH") {
      incrementCounter("tenant_isolation_rejection_total", { boundary: "integrations" });
    }
  }
}

// ---------------------------------------------------------------------
// Connection lifecycle transition table (Section 4 / packages/db/src/
// schema/integrations.ts's own comment on INTEGRATION_CONNECTION_STATUSES).
// REJECTED/REVOKED/EXPIRED are terminal — no outgoing edges.
// VALIDATION_FAILED loops back to CONFIGURING only, never forward to
// ACTIVE, so a failed validation can never be silently bypassed.
// ---------------------------------------------------------------------

const CONNECTION_TRANSITIONS: Record<IntegrationConnectionStatus, IntegrationConnectionStatus[]> = {
  DRAFT: ["PENDING_APPROVAL", "REVOKED"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED"],
  REJECTED: [],
  APPROVED: ["CONFIGURING"],
  CONFIGURING: ["VALIDATING"],
  VALIDATING: ["ACTIVE", "VALIDATION_FAILED"],
  VALIDATION_FAILED: ["CONFIGURING"],
  ACTIVE: ["SUSPENDED", "REVOKED", "EXPIRED"],
  SUSPENDED: ["ACTIVE", "REVOKED"],
  REVOKED: [],
  EXPIRED: [],
};

export function isValidConnectionTransition(from: IntegrationConnectionStatus, to: IntegrationConnectionStatus): boolean {
  return CONNECTION_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------
// Capability verb catalogue (Section 4: "domain code depends on AE
// capability verbs ... never a named provider SDK directly"). Additive —
// a new provider category adds new verbs here, never a raw provider
// method/endpoint name.
// ---------------------------------------------------------------------

export const INTEGRATION_CAPABILITIES = {
  PORTAL_PUBLISH_LISTING: "portal.publishListing",
  PORTAL_UPDATE_LISTING_STATUS: "portal.updateListingStatus",
  // AE Step 5 remediation — Proof B (Communications Hub): an outbound SMS
  // send routed through the integration foundation's own outbox/adapter/
  // mapping/webhook machinery, instead of Communications' synchronous
  // sandbox provider. See lib/integrations/commsProof.ts.
  COMMS_SEND_SMS: "comms.sendSms",
  // AE Step 5 remediation — Proof C (Financial Transaction Engine): inbound
  // mock payment-STATUS sync only (never a debit/transfer capability — see
  // lib/financial/mockPaymentStatusSync.ts's own header comment on the
  // explicit money-movement boundary).
  PAYMENTS_STATUS_SYNC: "payments.statusSync",
} as const;
export type IntegrationCapability = (typeof INTEGRATION_CAPABILITIES)[keyof typeof INTEGRATION_CAPABILITIES];

// ---------------------------------------------------------------------
// Outbound command result + failure taxonomy (Section 8's error taxonomy).
// TRANSIENT_PROVIDER_ERROR/RATE_LIMITED are retryable; everything else is
// permanent (dead-lettered immediately, no wasted retry budget).
// ---------------------------------------------------------------------

export const INTEGRATION_FAILURE_CATEGORIES = [
  "TRANSIENT_PROVIDER_ERROR",
  "RATE_LIMITED",
  "PERMANENT_REJECTION",
  "VALIDATION_ERROR",
  "AUTH_ERROR",
] as const;
export type IntegrationFailureCategory = (typeof INTEGRATION_FAILURE_CATEGORIES)[number];

const RETRYABLE_FAILURE_CATEGORIES: IntegrationFailureCategory[] = ["TRANSIENT_PROVIDER_ERROR", "RATE_LIMITED"];
export function isRetryableIntegrationFailure(category: IntegrationFailureCategory | null | undefined): boolean {
  return category != null && RETRYABLE_FAILURE_CATEGORIES.includes(category);
}

export interface AdapterSendResult {
  status: "SENT" | "FAILED";
  providerReference: string | null;
  failureCategory: IntegrationFailureCategory | null;
  failureDetail: string | null;
  // A short, non-sensitive summary only — an adapter must never return a
  // full raw payload here (that would defeat outbox.ts's own redaction
  // discipline at the point it gets logged into integrationOutboxAttempts).
  responseSummary: string;
}

export interface AdapterSendContext {
  connectionId: string;
  brokerageId: number;
  idempotencyKey: string;
}

/**
 * Every mock (and, later, real) provider integration implements exactly
 * this shape. A capability not in `capabilities` must be refused by the
 * adapter itself as a defence-in-depth check, even though registry.ts's
 * resolveActiveConnection already refuses to dispatch it first (Section 4:
 * "adapters must be replaceable" — swapping an adapter implementation must
 * never require a domain-code change, only a registry.ts registration change).
 */
export interface IntegrationAdapter {
  providerId: string;
  version: number;
  capabilities: IntegrationCapability[];
  send(capability: IntegrationCapability, payload: Record<string, unknown>, ctx: AdapterSendContext): Promise<AdapterSendResult>;
}

// ---------------------------------------------------------------------
// Inbound webhook envelope (Section 6). What a webhook route hands to
// webhooks.ts's processInboundWebhook — never the provider's raw request
// object, so the gateway itself stays provider-neutral.
// ---------------------------------------------------------------------

export interface InboundIntegrationWebhookInput {
  /** Resolved from the URL path — never taken from the payload (tenant-safety). */
  connectionId: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  signatureValid: boolean;
}

export interface ProcessIntegrationWebhookResult {
  status: "PROCESSED" | "DUPLICATE" | "REJECTED" | "FAILED";
  inboxId: number;
  detail: string;
}
