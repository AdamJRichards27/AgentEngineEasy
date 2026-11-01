import { contactabilityStatusLabel, explainReasonCode, type GrowContactability } from "../../lib/contactability";

// AE Mobile (CC Task #64, M4/M5): Tap-to-Call. Pure rules, no React, no network, no storage.
//
// The owner's rules (2 Nov 2026):
//   - The call is made with the phone's own dialler through tel:. AE does not place, record or time the call.
//   - Consent is confirmed when the contact is created, so the agent is NOT asked to reconfirm it, and there is no "needs review" prompt
//     before a call. Only an explicit restriction recorded afterwards stops the call: the contact marked do not contact, the phone channel
//     blocked, an active suppression, the Do Not Call Register listing, or withdrawn consent. A missing record is not a restriction.
//   - No usable number, no call button. With several numbers, each button names the number it will dial.
//   - Nothing is recorded automatically. After the agent comes back, they are offered "Log call"; nothing is saved unless they save it.
// The server remains the authority on restrictions: this reads its answer, and when it cannot be read the call is not offered.

export interface PhoneNumber {
  /** "Mobile", and later "Work", "Home". Names the number on the button. */
  label: string;
  number: string | null | undefined;
}

export interface CallOption {
  label: string;
  /** The number as the agent will recognise it. */
  display: string;
  href: string;
  /** The button text: names the number, always. */
  text: string;
  /** The accessible name, naming the person too when given. */
  aria: string;
}

export interface CallPlan {
  options: CallOption[];
  /** In the consent engine's own words, when an explicit restriction stops the call. Null when none. */
  restriction: string | null;
  /** A number is recorded, but none is usable (too short, too long, or not a number). */
  unusable: boolean;
}

const MIN_DIGITS = 6;
const MAX_DIGITS = 15;

/**
 * A number the dialler can use, or null. Text from the first letter on is an extension or a note ("0491 570 156 ext 12", "n/a") and is
 * never dialled. A leading + is kept; every other symbol is dropped. 6 to 15 digits; not one digit repeated ("0000000").
 */
export function usableNumber(raw: string | null | undefined): { display: string; dial: string } | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const cut = trimmed.search(/[A-Za-z#*]/);
  const dialled = cut === -1 ? trimmed : trimmed.slice(0, cut);
  const digits = dialled.replace(/\D/g, "");
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;
  if (/^(\d)\1+$/.test(digits)) return null;
  const dial = `${dialled.trim().startsWith("+") ? "+" : ""}${digits}`;
  return { display: dialled.trim().replace(/\s+/g, " "), dial };
}

/** Every telephone number the contact record holds. Today the record holds one (`mobile`); more are listed here as the record gains them. */
export function numbersOf(contact: { mobile?: string | null }): PhoneNumber[] {
  return [{ label: "Mobile", number: contact.mobile }];
}

/**
 * The explicit restriction on calling this contact, in the server's words, or null. NOT a restriction: no consent record, no approved
 * policy, no Do Not Call Register check recorded ("needs review"). The agent is not asked to reconfirm consent.
 * Unreadable (no contactability block): not offered, fails closed.
 */
export function callRestriction(contactability: GrowContactability | null | undefined): string | null {
  if (!contactability) return "AE couldn’t check whether this contact may be called.";
  if (contactability.status === "BLOCKED") return `${contactabilityStatusLabel("BLOCKED")}. ${explainReasonCode(contactability.statusReasonCode)}`;
  const phone = contactability.channels.find((c) => c.channel === "PHONE_CALL") ?? null;
  if (!phone) return null;
  if (phone.suppressed) return `${contactabilityStatusLabel("BLOCKED")}. ${explainReasonCode("SUPPRESSED")}`;
  if (phone.dncrStatus === "LISTED") return `${contactabilityStatusLabel("BLOCKED")}. ${explainReasonCode("DNCR_LISTED")}`;
  if (phone.consentState === "WITHDRAWN") return `${contactabilityStatusLabel("BLOCKED")}. ${explainReasonCode("WITHDRAWN")}`;
  if (phone.status === "BLOCKED") return `${contactabilityStatusLabel("BLOCKED")}. ${explainReasonCode(phone.reasonCode)}`;
  return null;
}

export function callPlan(numbers: readonly PhoneNumber[], contactability: GrowContactability | null | undefined, contactName?: string): CallPlan {
  const present = numbers.filter((n) => n.number !== null && n.number !== undefined && n.number.trim().length > 0);
  const usable = present.map((n) => ({ n, u: usableNumber(n.number) })).filter((x): x is { n: PhoneNumber; u: { display: string; dial: string } } => x.u !== null);
  const restriction = callRestriction(contactability);
  const seen = new Set<string>();
  const options: CallOption[] = [];
  if (restriction === null) {
    for (const { n, u } of usable) {
      if (seen.has(u.dial)) continue; // the same number held twice is one button
      seen.add(u.dial);
      options.push({
        label: n.label,
        display: u.display,
        href: `tel:${u.dial}`,
        text: `Call ${n.label.toLowerCase()} ${u.display}`,
        aria: contactName ? `Call ${contactName}, ${n.label.toLowerCase()} ${u.display}` : `Call ${n.label.toLowerCase()} ${u.display}`,
      });
    }
  }
  return { options, restriction, unusable: present.length > 0 && usable.length === 0 };
}

// ── After the call ───────────────────────────────────────────────────────

/** The agent must have been away at least this long for "Log call" to be offered: a dismissed dialler prompt is not a call. */
export const MIN_AWAY_MS = 3000;
/** The page must go to the background within this long of the tap: it is the dialler taking over. */
export const HIDE_WITHIN_MS = 15000;
/** After this long the offer is stale and is not shown. */
export const OFFER_WINDOW_MS = 4 * 60 * 60 * 1000;

export interface PendingCall {
  partyId: number;
  name: string;
  label: string;
  display: string;
  startedAt: number;
  hiddenAt: number | null;
}

export function startCall(c: Omit<PendingCall, "hiddenAt">): PendingCall {
  return { ...c, hiddenAt: null };
}

export function markHidden(c: PendingCall | null, now: number): PendingCall | null {
  if (c === null || c.hiddenAt !== null) return c;
  return now - c.startedAt <= HIDE_WITHIN_MS ? { ...c, hiddenAt: now } : null;
}

/** When the agent comes back: offer to log, or drop. Returns the offer (or null) and what to keep tracking (always nothing: one offer per tap). */
export function returned(c: PendingCall | null, now: number): { offer: PendingCall | null; keep: PendingCall | null } {
  if (c === null) return { offer: null, keep: null };
  if (c.hiddenAt === null) return { offer: null, keep: c };
  const away = now - c.hiddenAt;
  const fresh = now - c.startedAt <= OFFER_WINDOW_MS;
  return { offer: away >= MIN_AWAY_MS && fresh ? c : null, keep: null };
}

export function logCallHref(partyId: number): string {
  return `/grow/contacts/${partyId}?log=call`;
}
