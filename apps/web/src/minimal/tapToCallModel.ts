// Tap-to-Call view model. t239u (Owner, FINAL): no consent, DNC, suppression
// or preference blocking and no warnings; the agent is responsible for
// compliance. The server only answers for authorised callers; this maps its answer.
export type TapToCallStatus = {
  available: boolean;
  reason: "AVAILABLE" | "NO_PHONE" | "MASKED";
  /** t249u proposal: true when the caller lacks contact-read access; never callable. */
  masked?: boolean;
  display?: string | null;
  telHref?: string | null;
};

export type TapToCallView = { kind: "call"; href: string } | { kind: "hidden" };

export function tapToCallPath(partyId: number): string {
  return `/parties/${partyId}/tap-to-call`;
}

/** Only a server-issued tel: href is ever rendered; anything else is never a link. */
export function tapToCallView(status: TapToCallStatus | null | undefined): TapToCallView {
  if (status && status.available && status.masked !== true && status.reason !== "MASKED" && typeof status.telHref === "string" && /^tel:\+?\d{6,}$/.test(status.telHref)) {
    return { kind: "call", href: status.telHref };
  }
  return { kind: "hidden" };
}
