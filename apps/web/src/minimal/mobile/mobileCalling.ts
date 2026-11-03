// AE Mobile (CC Task #64, M4/M5): Tap-to-Call. Pure rules, no React, no network, no storage.
//
// FINAL PRODUCT DIRECTIVE (owner, 2 Nov 2026), superseding every earlier consent rule for calling:
//   - Agent Engine is a business operating platform, not a consent enforcement or Do Not Call Register policing service.
//   - A Call button is shown for every usable telephone number the agent can already see, and it opens the device's own dialler through tel:.
//   - Nothing about consent blocks, hides, disables or warns about a call: not missing consent, withdrawn consent, a Do Not Call Register
//     status, a suppression, or a communication preference. There is no confirmation step. This file does not read any of them.
//   - Existing consent and preference records are untouched: nothing here deletes, edits or falsifies them.
//   - Authentication, brokerage isolation and contact-access permissions are unchanged: a number is shown, and so callable, only where
//     the agent is already allowed to see the contact.
//   - Logging a call is optional. Nothing is recorded or marked completed automatically.
// The agent is responsible for complying with applicable consent, privacy, telemarketing and Do Not Call requirements.

import { GROW_CONTACTS_READ } from "./mobilePeopleConfig";

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
  /** A number is recorded, but none is usable (too short, too long, or not a number). */
  unusable: boolean;
}

const MIN_DIGITS = 6;
const MAX_DIGITS = 15;

/**
 * True when the text is a number the server has MASKED because the user may not see it (#296 returns "***123", and a mask can be partial:
 * "0491 570 ***", "04** *** 156", "XXXX XXX 156", "••• 123"). Mask characters, or a run of two or more X, mean "hidden": such text is never a
 * telephone number, however many digits remain.
 */
export function isMaskedNumber(raw: string | null | undefined): boolean {
  return typeof raw === "string" && /[*•●∗⁎·…]|[xX]{2,}/.test(raw);
}

/**
 * A number the dialler can use, or null. Text from the first letter on is an extension or a note ("0491 570 156 ext 12", "n/a") and is
 * never dialled. A leading + is kept; every other symbol is dropped. 6 to 15 digits; not one digit repeated ("0000000").
 */
export function usableNumber(raw: string | null | undefined): { display: string; dial: string } | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // A masked number is NEVER dialled, whatever digits survive the mask: "0491 570 ***" must not become tel:0491570.
  if (isMaskedNumber(trimmed)) return null;
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
 * Who sees Call beside a property's linked contacts: an agent who may READ CONTACTS (`grow.contacts.read`, a read-only agent included), and
 * nobody else. Run access alone is not enough: a Run-only user is shown masked numbers and is never offered a call. Display only: the server
 * masks the number for such a user and the phone never relies on that. Contact 360 needs no rule here because the server only returns the
 * contact to someone who may read it. Consent is not part of it.
 */
export function mayCallFromProperty(entitlements: readonly string[] | null | undefined): boolean {
  return Array.isArray(entitlements) && entitlements.includes(GROW_CONTACTS_READ);
}

/** One Call option for every usable number, in the order given; the same number held twice is one button. */
export function callPlan(numbers: readonly PhoneNumber[], contactName?: string): CallPlan {
  const present = numbers.filter((n) => n.number !== null && n.number !== undefined && n.number.trim().length > 0);
  const seen = new Set<string>();
  const options: CallOption[] = [];
  for (const n of present) {
    const u = usableNumber(n.number);
    if (u === null || seen.has(u.dial)) continue;
    seen.add(u.dial);
    options.push({
      label: n.label,
      display: u.display,
      href: `tel:${u.dial}`,
      text: `Call ${n.label.toLowerCase()} ${u.display}`,
      aria: contactName ? `Call ${contactName}, ${n.label.toLowerCase()} ${u.display}` : `Call ${n.label.toLowerCase()} ${u.display}`,
    });
  }
  return { options, unusable: present.length > 0 && options.length === 0 };
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
