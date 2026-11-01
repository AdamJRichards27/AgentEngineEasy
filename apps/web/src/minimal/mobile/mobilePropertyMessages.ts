// AE Mobile (CC Task #64, M4): what the property page says when the property cannot be shown. No React, no network.
// Same rule as the contact screen: a property in another brokerage answers 404, trying again cannot help a property that is not
// there or not yours, and the words must not say which it is.

export interface PropertyLoadMessage {
  text: string;
  /** Offer "Try again" only when trying again can work. */
  retry: boolean;
}

export const PROPERTY_NOT_FOUND = "That property couldn’t be found. It may have been removed, or it may not be available to you.";
export const PROPERTY_NO_ACCESS = "You don’t have access to properties.";

export function propertyLoadMessage(status: number | null | undefined, fallback: string): PropertyLoadMessage {
  if (status === 404) return { text: PROPERTY_NOT_FOUND, retry: false };
  if (status === 403) return { text: PROPERTY_NO_ACCESS, retry: false };
  return { text: fallback, retry: true };
}
