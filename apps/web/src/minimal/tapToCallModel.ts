// t236u Tap-to-Call view model. The server decides; this only maps its answer.
export type TapToCallStatus = {
  available: boolean;
  reason: "AVAILABLE" | "NO_PHONE" | "NO_CONSENT" | "CONSENT_WITHDRAWN" | "DO_NOT_CALL" | "SUPPRESSED" | "DNCR_LISTED";
  telHref?: string;
  restrictions?: string | null;
};

export type TapToCallView =
  | { kind: "call"; href: string; restrictions: string | null }
  | { kind: "unavailable"; text: string }
  | { kind: "hidden" };

const UNAVAILABLE: Record<string, string> = {
  NO_CONSENT: "Calling not confirmed for this contact",
  CONSENT_WITHDRAWN: "Consent to call withdrawn",
  DO_NOT_CALL: "Do not call",
  SUPPRESSED: "Calls suppressed",
  DNCR_LISTED: "On the Do Not Call Register",
};

export function tapToCallPath(partyId: number): string {
  return `/parties/${partyId}/tap-to-call`;
}

/** Only a server-issued tel: href is ever rendered; anything else is never a link. */
export function tapToCallView(status: TapToCallStatus | null | undefined): TapToCallView {
  if (!status || status.reason === "NO_PHONE") return { kind: "hidden" };
  if (status.available && typeof status.telHref === "string" && /^tel:\+?\d{6,}$/.test(status.telHref)) {
    return { kind: "call", href: status.telHref, restrictions: status.restrictions ?? null };
  }
  return { kind: "unavailable", text: UNAVAILABLE[status.reason] ?? "Calling unavailable" };
}
