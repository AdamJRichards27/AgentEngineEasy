// GP-5 — whether Contact 360 may show calling or call-transcript surfaces.
//
// The client already has the permission set from GET /auth/me (useEntitlements)
// and the Grow access payload from GET /grow/access. This does not start a new
// request. Missing grow.calling.access hides the call card (and its eligibility
// poll). Missing grow.calling.transcription hides the transcript card (and its
// list poll). An explicit callingEnabled or providerEnabled of false on the
// access payload hides both, even when a grant is present. Undefined flags
// mean the server did not report them, so a held grant still shows the surface.

export interface GrowCallingClientInfo {
  /** False while the session entitlement list has not arrived. Hide until then so no call request starts. */
  entitlementsKnown: boolean;
  hasEntitlement: (key: string) => boolean;
  /** From GET /grow/access when the server sends it. Undefined is not "off". */
  callingEnabled?: boolean;
  /** From GET /grow/access when the server sends it. Undefined is not "off". */
  providerEnabled?: boolean;
}

export interface GrowCallingSurfaces {
  call: boolean;
  transcripts: boolean;
}

export function growCallingSurfaces(info: GrowCallingClientInfo): GrowCallingSurfaces {
  if (!info.entitlementsKnown) return { call: false, transcripts: false };
  if (info.callingEnabled === false || info.providerEnabled === false) {
    return { call: false, transcripts: false };
  }
  return {
    call: info.hasEntitlement("grow.calling.access"),
    transcripts: info.hasEntitlement("grow.calling.transcription"),
  };
}
