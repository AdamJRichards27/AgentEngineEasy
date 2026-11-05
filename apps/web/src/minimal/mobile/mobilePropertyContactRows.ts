import { buildLinkedContacts, type LinkedContact, type LinkedPartyRow } from "../properties/minimalPropertyContactsModel";
import type { CallOption } from "./mobileCalling";
import { linkRoleLabel } from "./mobileLinking";

// AE Mobile (CC Task #64, M5): the property page's contact rows, with what a phone needs beside each: whether the contact is the primary
// contact, and the number to call. Built from GET /parties/by-property/:id (the rows the existing panel reads); nothing is added.

export interface MobileLinkedContact extends LinkedContact {
  isPrimary: boolean;
  /** The recorded mobile number, or null. */
  mobile: string | null;
}

export function mobileLinkedContacts(rows: readonly LinkedPartyRow[]): MobileLinkedContact[] {
  const base = buildLinkedContacts([...rows]);
  const byLink = new Map(rows.map((r) => [r.linkId, r]));
  return base.map((c) => {
    const row = byLink.get(c.linkId);
    const mobile = typeof (row?.party as { mobile?: unknown } | undefined)?.mobile === "string" ? (row?.party as { mobile: string }).mobile : null;
    // The role words are the phone's one list (LINK_ROLE_LABELS), the same as the picker and Contact 360, whatever wording the desktop model uses.
    return { ...c, roleLabel: linkRoleLabel(c.role), isPrimary: row?.isPrimary === true, mobile: mobile !== null && mobile.trim().length > 0 ? mobile.trim() : null };
  });
}

/** What the view needs beside one contact: one Call option per usable number. No usable number, no option. */
export interface ContactCallState {
  options: CallOption[];
}
