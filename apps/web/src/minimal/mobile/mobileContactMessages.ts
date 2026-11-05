// AE Mobile (CC Task #64, M4): what the Contact 360 screen says when the contact cannot be shown. No React, no network.
// Found in the real app: a contact in another brokerage answers 404, and the screen said "couldn't be found, try again".
// Trying again cannot help a contact that is not there or not yours, and the wording must not reveal which it is.

export interface ContactLoadMessage {
  text: string;
  /** Offer "Try again" only when trying again can work. */
  retry: boolean;
}

export const CONTACT_NOT_FOUND = "That contact couldn’t be found. It may have been removed, or it may not be available to you.";
export const CONTACT_NO_ACCESS = "You don’t have access to contacts.";

export function contactLoadMessage(status: number | null | undefined, fallback: string): ContactLoadMessage {
  if (status === 404) return { text: CONTACT_NOT_FOUND, retry: false };
  if (status === 403) return { text: CONTACT_NO_ACCESS, retry: false };
  return { text: fallback, retry: true };
}
