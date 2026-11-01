import { buildLinkedContacts, type LinkedContact, type LinkedPartyRow } from "../properties/minimalPropertyContactsModel";
import type { CallOption } from "./mobileCalling";

// AE Mobile (CC Task #64, M5): the property page's contact rows, with what a phone needs beside each: whether the contact is the primary
// contact, and the number to call. Built from GET /parties/by-property/:id (the rows the existing panel reads); nothing is added.

export interface MobileLinkedContact extends LinkedContact {
  isPrimary: boolean;
  /** The recorded mobile number, or null. Whether it may be called is decided by the contact's own contactability, not here. */
  mobile: string | null;
}

export function mobileLinkedContacts(rows: readonly LinkedPartyRow[]): MobileLinkedContact[] {
  const base = buildLinkedContacts([...rows]);
  const byLink = new Map(rows.map((r) => [r.linkId, r]));
  return base.map((c) => {
    const row = byLink.get(c.linkId);
    const mobile = typeof (row?.party as { mobile?: unknown } | undefined)?.mobile === "string" ? (row?.party as { mobile: string }).mobile : null;
    return { ...c, isPrimary: row?.isPrimary === true, mobile: mobile !== null && mobile.trim().length > 0 ? mobile.trim() : null };
  });
}

/** What the view needs beside one contact. Empty options with `restricted` false means "not known yet or no usable number": no button either way. */
export interface ContactCallState {
  options: CallOption[];
  /** An explicit restriction applies: say "Do not call" instead of a button. */
  restricted: boolean;
}
