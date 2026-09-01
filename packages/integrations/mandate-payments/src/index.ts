// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage D.
//
// Provider-neutral debit-mandate payment interface (Section 31). Deliberately
// a SEPARATE interface from @aee/integration-payments and
// @aee/integration-billing: those two charge an already-tokenized card
// (PaymentIntents-shaped, one-off) and manage a recurring card subscription
// (Checkout Sessions-shaped) respectively — this one schedules a debit
// against an already-established general-account debit mandate (an AU
// Direct-Debit-Request shape: authorise once, then a scheduled debit that
// clears some business days later, never an instant card charge). Same
// "different shape, different adapter, same architectural pattern" reasoning
// billing/src/index.ts's own header comment gives for its own split from
// payments.
//
// Custody boundary (financial.ts's own header comment, Section 3): this
// package only ever talks to an external provider's REST/webhook surface —
// it never holds funds, never stores raw bank credentials, and the mandate
// itself (mandateProviderRef) is captured by an external, already-authorised
// process before anything here is called, exactly as payments.ts's
// StripePaymentProvider only ever charges an *already-tokenized* stored
// payment method and never captures raw card data.
//
// No real bank-debit vendor is procured for this build — unlike Stripe
// (named and referenced since Phase 1 for cards/subscriptions), there is no
// equivalent named AU direct-debit vendor anywhere else in this codebase —
// so only the sandbox adapter ships. createMandatePaymentProvider() is
// still written provider-neutral (an env var selects the implementation)
// so swapping in a real adapter later is a config change, not a rewrite.

import { randomUUID } from "node:crypto";

export interface DebitRequest {
  mandateProviderRef: string;
  amountCents: number;
  currency: "AUD";
  idempotencyKey: string;
  description: string;
}

export type MandateDebitStatus = "Scheduled" | "Processing" | "Paid" | "Failed";

export interface DebitResult {
  providerRequestRef: string;
  status: MandateDebitStatus;
  scheduledFor?: Date;
  failureReason?: string;
}

export type MandateWebhookStatus = "Processing" | "Paid" | "Failed" | "Reversed" | "Disputed";

export interface MandateWebhookResult {
  providerEventId: string;
  providerRequestRef: string;
  status: MandateWebhookStatus;
  failureReason?: string;
  disputeReason?: string;
}

export interface MandatePaymentProvider {
  name: string;
  scheduleDebit(input: DebitRequest): Promise<DebitResult>;
  /** Only valid while the debit is still "Scheduled" — once it has started Processing there is nothing left to cancel, only reverseDebit. */
  cancelScheduledDebit(providerRequestRef: string): Promise<void>;
  /** Unwinds an already-cleared ("Paid") debit. */
  reverseDebit(providerRequestRef: string, amountCents: number, reason: string): Promise<void>;
  // Same shape as PaymentProvider/BillingProvider's own verifyWebhookSignature — payload should
  // be the raw request body whenever the provider signs raw bytes.
  verifyWebhookSignature(payload: unknown, signature: string): boolean;
  parseWebhook(payload: unknown): MandateWebhookResult;
}

/**
 * Sandbox provider — ships by default (and, for now, exclusively) so the
 * PC success-fee debit lifecycle works end-to-end without real bank
 * credentials, mirroring MockPaymentProvider/MockBillingProvider. Unlike
 * those two mocks (which throw on a re-used idempotency key, or don't model
 * idempotency at all), scheduleDebit here deliberately REPLAYS the cached
 * result for a repeated idempotencyKey instead of erroring — that's the
 * behaviour a real provider's own idempotency-key handling gives, and it's
 * exactly what the durable outbox (lib/financial/paymentOutbox.ts) depends
 * on: a dispatch that crashes after the provider call succeeds but before
 * the local DB write is retried safely, because retrying calls
 * scheduleDebit again with the SAME key and gets the SAME providerRequestRef
 * back rather than a duplicate debit or a thrown error.
 *
 * providerRequestRef is generated with randomUUID() rather than an
 * incrementing in-process counter. This class is a fresh singleton every
 * time the Node process restarts (see ./provider.js), so a counter that
 * starts back at 1 on every run is only unique WITHIN one process's
 * lifetime — against the same shared dev database every local/test run
 * reuses, two different process runs' first scheduleDebit() call would
 * both mint "sandbox-debit-1", and lib/financial/paymentWebhooks.ts's
 * `where(eq(financialPaymentRequests.providerRequestRef, ...))` lookup
 * has no way to tell those two rows apart — a webhook for THIS run's
 * debit could silently update a stale row left over from an earlier run
 * instead, leaving the real row stuck and the webhook falsely reporting
 * processed:true. A random ref removes the possibility of that collision
 * outright, matching how a real provider's opaque request ids behave.
 */
export class SandboxMandatePaymentProvider implements MandatePaymentProvider {
  name = "sandbox";
  private scheduled = new Map<string, { mandateProviderRef: string; amountCents: number; status: MandateDebitStatus }>();
  private idempotencyIndex = new Map<string, string>(); // idempotencyKey -> providerRequestRef

  async scheduleDebit(input: DebitRequest): Promise<DebitResult> {
    const existingRef = this.idempotencyIndex.get(input.idempotencyKey);
    if (existingRef) {
      const existing = this.scheduled.get(existingRef);
      if (existing) {
        return { providerRequestRef: existingRef, status: existing.status };
      }
    }

    const providerRequestRef = `sandbox-debit-${randomUUID()}`;
    // A real AU direct-debit scheme never clears same-day — a few business
    // days' notice-to-clearing lag is modelled deterministically here so
    // sandbox timing has the same shape as what it stands in for.
    const scheduledFor = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    this.scheduled.set(providerRequestRef, { mandateProviderRef: input.mandateProviderRef, amountCents: input.amountCents, status: "Scheduled" });
    this.idempotencyIndex.set(input.idempotencyKey, providerRequestRef);
    return { providerRequestRef, status: "Scheduled", scheduledFor };
  }

  async cancelScheduledDebit(providerRequestRef: string): Promise<void> {
    const entry = this.scheduled.get(providerRequestRef);
    if (!entry) throw new Error(`Unknown providerRequestRef: ${providerRequestRef}`);
    if (entry.status !== "Scheduled") {
      throw new Error(`Cannot cancel a debit in status ${entry.status} (only a still-Scheduled debit can be cancelled).`);
    }
    this.scheduled.delete(providerRequestRef);
  }

  async reverseDebit(providerRequestRef: string, _amountCents: number, _reason: string): Promise<void> {
    const entry = this.scheduled.get(providerRequestRef);
    if (!entry) throw new Error(`Unknown providerRequestRef: ${providerRequestRef}`);
    // The sandbox doesn't model post-reversal provider state beyond
    // acknowledging the call succeeded — the caller (lib/financial/
    // paymentOutbox.ts's reverseDebit) is the source of truth for the
    // resulting REVERSED status on the payment request itself.
  }

  verifyWebhookSignature(): boolean {
    return true; // no real webhook traffic reaches the sandbox provider
  }

  parseWebhook(payload: unknown): MandateWebhookResult {
    const p = payload as Partial<MandateWebhookResult>;
    if (!p.providerEventId || !p.providerRequestRef || !p.status) {
      throw new Error("Malformed sandbox mandate webhook payload: providerEventId, providerRequestRef and status are all required.");
    }
    return {
      providerEventId: p.providerEventId,
      providerRequestRef: p.providerRequestRef,
      status: p.status,
      failureReason: p.failureReason,
      disputeReason: p.disputeReason,
    };
  }
}

export function createMandatePaymentProvider(): MandatePaymentProvider {
  const provider = process.env.MANDATE_PAYMENT_PROVIDER ?? "sandbox";
  if (provider !== "sandbox") {
    // Section 3's custody boundary keeps AE out of actually moving money,
    // and no real bank-debit vendor is procured for this build — every
    // other requested value falls back to the sandbox rather than silently
    // pretending to be a real provider it cannot yet be.
    console.warn(`MANDATE_PAYMENT_PROVIDER=${provider} is not supported yet — falling back to SandboxMandatePaymentProvider.`);
  }
  return new SandboxMandatePaymentProvider();
}
