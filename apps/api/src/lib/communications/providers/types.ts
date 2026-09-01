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
  send(input: SendEmailInput): Promise<ProviderSendResult>;
}

export interface SmsProvider {
  readonly name: string;
  send(input: SendSmsInput): Promise<ProviderSendResult>;
}
