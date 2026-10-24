// Owner t165u — browser-side access check for /offers (the Offer Centre).
// The same rule as the API (GET /offers/centre, /offers/buyers): run.access plus
// Agent or Brokerage Administrator; never Pit Crew. This is a UX check only:
// the API's requireRole/requireEntitlement gates stay authoritative, and this
// check only stops the page from rendering (and fetching) for anyone else.
export const OFFER_CENTRE_ROLES = ["Agent", "Brokerage Administrator"] as const;

export function canAccessOfferCentre(role: string | undefined, entitlements: readonly string[]): boolean {
  return entitlements.includes("run.access") && (OFFER_CENTRE_ROLES as readonly string[]).includes(role ?? "");
}

export type OfferCentreGateState = "loading" | "denied" | "allowed";

// Fails closed: while the session or entitlements are loading nothing renders
// or fetches, and a missing user is denied.
export function offerCentreGateState(input: {
  loading: boolean;
  role: string | undefined;
  entitlements: readonly string[];
}): OfferCentreGateState {
  if (input.loading) return "loading";
  return canAccessOfferCentre(input.role, input.entitlements) ? "allowed" : "denied";
}
