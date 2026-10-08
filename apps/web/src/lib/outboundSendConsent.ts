// GP-4 — pre-check for the Email/SMS send actions on Contact 360.
//
// The server remains the authority (a 409 still says why a send was refused).
// This only disables the action when Contact 360 already knows consent is
// absent, or the contact is on the do-not-contact list. An EXPRESS or
// INFERRED head stays enabled even when the evaluator is REVIEW_REQUIRED
// because no policy has been approved: destination consent is still enforced
// when the message is sent.

import type { GrowContactability } from "./contactability";

export const OUTBOUND_CONSENT_REQUIRED_MESSAGE = "Can't send: no recorded consent for this email/mobile.";
export const OUTBOUND_DNC_BLOCKED_MESSAGE = "Can't send: this contact is on the do-not-contact list.";

const AFFIRMATIVE_CONSENT_STATES = new Set(["EXPRESS", "INFERRED"]);

export function knownOutboundSendBlock(
  contactability: GrowContactability | null | undefined,
  channel: "EMAIL" | "SMS",
  now = Date.now(),
): string | null {
  if (!contactability) return null;
  const channels = contactability.channels ?? [];
  if (channels.some((row) => row.dncrStatus === "LISTED")) return OUTBOUND_DNC_BLOCKED_MESSAGE;

  const row = channels.find((candidate) => candidate.channel === channel);
  if (!row) return OUTBOUND_CONSENT_REQUIRED_MESSAGE;
  if (row.suppressed) return OUTBOUND_DNC_BLOCKED_MESSAGE;
  if (row.dncrStatus === "UNKNOWN") return OUTBOUND_CONSENT_REQUIRED_MESSAGE;
  if (!AFFIRMATIVE_CONSENT_STATES.has(row.consentState)) return OUTBOUND_CONSENT_REQUIRED_MESSAGE;

  const expiresAt = row.consent?.expiresAt;
  const reviewAt = row.consent?.reviewAt;
  if (expiresAt && Date.parse(expiresAt) <= now) return OUTBOUND_CONSENT_REQUIRED_MESSAGE;
  if (reviewAt && Date.parse(reviewAt) <= now) return OUTBOUND_CONSENT_REQUIRED_MESSAGE;
  return null;
}
