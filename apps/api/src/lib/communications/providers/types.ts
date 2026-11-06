// Agent Engine 2.0 — Communications Hub (Priority 8).
//
// Provider-neutral send interface (Sections 17-18). Every channel this app
// actually dispatches (EMAIL, SMS — see DISPATCHED_CHANNELS in ../types.ts)
// goes through one of these two interfaces; outbox.ts never talks to a
// concrete provider SDK directly. Only sandbox/dev adapters exist in this
// build (see sandboxEmail.ts / sandboxSms.ts) — a real production adapter
// (e.g. Mobile Message for SMS) is wired in later behind the same
// interface, once credentials/authorization exist (Section 5's explicit
// "no direct production provider activation without credentials" limit).

import type { FailureCategory } from "../types.js";
import type { ProviderRecoveryCapability } from "../../outboxRecovery/policy.js";

export interface SendEmailInput {
  to: string;
  subject: string | null;
  bodyText: string;
  bodyHtml: string | null;
  /** Passed straight from communicationMessages.idempotencyKey — a provider that supports idempotent send should be given this. */
  idempotencyKey: string;
}

export interface SendSmsInput {
  to: string;
  bodyText: string;
  idempotencyKey: string;
}

export interface ProviderSendResult {
  /** The adapter's own name, e.g. "sandbox_email" — never a real provider's name unless that provider actually processed the send. */
  provider: string;
  providerMessageId: string;
  status: "SENT" | "FAILED";
  failureCategory?: FailureCategory;
  failureDetail?: string;
}

export interface EmailProvider {
  readonly name: string;
  /** Outbound recovery capability; omitted means fail-closed (MANUAL_REVIEW). */
  readonly recovery?: ProviderRecoveryCapability;
  send(input: SendEmailInput): Promise<ProviderSendResult>;
}

export interface SmsProvider {
  readonly name: string;
  /** Outbound recovery capability; omitted means fail-closed (MANUAL_REVIEW). */
  readonly recovery?: ProviderRecoveryCapability;
  send(input: SendSmsInput): Promise<ProviderSendResult>;
}

/**
 * AE GROW W3-B — the dispatch seam's error taxonomy.
 *
 * Deliberately the same three codes as TelephonyProviderError in
 * ../../telephony/provider.ts and TranscriptionProviderError in
 * ../../ai/voice/types.js, so a reviewer comparing the outbound domains
 * reads one vocabulary rather than three:
 *
 *   live_provider_disabled — a non-sandbox provider was selected but
 *     LIVE_COMMUNICATIONS_APPROVED is not "true". This is the fail-closed
 *     default and the ONLY correct response to that configuration; the seam
 *     must never answer it by quietly substituting the sandbox (see
 *     registry.ts).
 *   missing_credentials  — the provider was selected and approved, but its
 *     credential is absent. No adapter in this build reaches this state; it
 *     is defined now so a future adapter has the code to raise rather than
 *     inventing a fourth one.
 *   provider_error       — anything else the seam itself can determine,
 *     including an unrecognised provider id. Note this is a RESOLUTION
 *     error, not a send failure: a send that reaches a provider and is
 *     rejected reports a FailureCategory on ProviderSendResult instead, so
 *     the outbox's retry classification keeps working unchanged.
 */
export type CommunicationProviderErrorCode = "provider_error" | "live_provider_disabled" | "missing_credentials";

export class CommunicationProviderError extends Error {
  readonly provider: string;
  readonly code: CommunicationProviderErrorCode;
  /** Which dispatched channel's resolution failed — EMAIL and SMS resolve independently. */
  readonly channel: "EMAIL" | "SMS";
  constructor(provider: string, channel: "EMAIL" | "SMS", code: CommunicationProviderErrorCode, message: string) {
    super(message);
    this.name = "CommunicationProviderError";
    this.provider = provider;
    this.channel = channel;
    this.code = code;
  }
}
