// AE GROW Completion W3-A (A-7) — Contact 360's contactability/consent surface,
// frontend types + display rules.
//
// WHY THIS FILE EXISTS. Two reasons, both load-bearing.
//
// 1. IT IS THE HAND-MIRROR of the `contactability` block that
//    apps/api/src/routes/contacts.ts now returns from GET
//    /grow/contacts/:partyId. The web app does not share a package with the
//    API, so this mirror needs a matching hand-edit whenever that block
//    changes — the same convention lib/growToday.ts already documents for
//    Grow Today's payload.
//
// 2. IT IS WHERE THE HONEST-RENDERING RULES LIVE, as pure functions, so they
//    are testable without rendering anything and so there is exactly one place
//    that decides what a reason code means to a human.
//
// THE RULE THIS FILE ENFORCES. AE's consent engine is fail-closed and, in the
// pilot, almost nothing is ELIGIBLE: no consent policy row has been approved,
// so timeZone and the allowed/quiet hours are null and the evaluator correctly
// returns POLICY_INVALID_WINDOW -> REVIEW_REQUIRED; and PHONE_CALL cannot be
// eligible in AU/NZ at all today, because a Do Not Call Register wash is
// required and AE has no register integration. The screen's job is to make
// that UNDERSTANDABLE — "awaiting policy approval", "nobody has checked the
// register" — not to hide it behind a generic failure and not to paper over it
// with a fabricated eligible state. Every reason code the evaluator can return
// therefore has a sentence here, and explainReasonCode() never returns an
// empty string for a code it does not recognise.
//
// WHAT THIS FILE DOES NOT DO. It does not evaluate anything. The server is the
// only authority on whether a contact may be reached; nothing below recomputes
// a decision, and nothing below can turn a REVIEW_REQUIRED into an ELIGIBLE.

export const GROW_CONSENT_CHANNELS = ["EMAIL", "SMS", "PHONE_CALL", "VOICE_CALL", "EXTERNAL_MESSAGE"] as const;
export type GrowConsentChannel = (typeof GROW_CONSENT_CHANNELS)[number];

export const GROW_CONSENT_STATES = ["EXPRESS", "INFERRED", "NONE", "WITHDRAWN", "UNKNOWN", "NOT_REQUIRED"] as const;
export type GrowConsentState = (typeof GROW_CONSENT_STATES)[number];

export type GrowContactabilityStatus = "ELIGIBLE" | "BLOCKED" | "REVIEW_REQUIRED";

export type GrowDncrStatus = "CLEARED" | "LISTED" | "UNKNOWN" | "NOT_CHECKED";

/**
 * The capture methods this panel offers. The API accepts any non-blank string;
 * these are the values AE's own tests and imports already use, offered as a
 * closed list so an agent records a comparable value rather than free text.
 */
export const GROW_CONSENT_CAPTURE_METHODS = ["WRITTEN", "VERBAL", "DIGITAL", "IMPORTED"] as const;
export type GrowConsentCaptureMethod = (typeof GROW_CONSENT_CAPTURE_METHODS)[number];

/**
 * States this panel can capture.
 *
 * INFERRED IS DELIBERATELY ABSENT. The consent model requires inferred consent
 * to carry reviewed relationship evidence pointing at a durable record, plus a
 * named reviewer and a review time (schema/consentControls.ts's
 * inferred_evidence_check, and validateConsentCaptureEvidence). A quick form
 * that auto-filled the reviewer with whoever happened to be signed in would
 * turn that attestation into a rubber stamp, which is the same reason
 * routes/growConsent.ts refuses to default withdrawal metadata. Recording
 * inferred consent stays an explicit API call until it has a surface that
 * collects the evidence properly.
 */
export const GROW_CONSENT_CAPTURABLE_STATES = ["EXPRESS", "NOT_REQUIRED", "NONE", "UNKNOWN"] as const;
export type GrowConsentCapturableState = (typeof GROW_CONSENT_CAPTURABLE_STATES)[number];

export interface GrowConsentStreamView {
  consentId: number;
  channel: string;
  purpose: string;
  scope: string;
  state: string;
  source: string;
  captureMethod: string;
  jurisdiction: string | null;
  capturedAt: string;
  expiresAt: string | null;
  reviewAt: string | null;
  evidenceReference: string | null;
  hasEvidencePayload: boolean;
  inferredReasoning: string | null;
  notRequiredJustification: string | null;
  withdrawnAt: string | null;
  withdrawnByUserId: number | null;
  withdrawalReason: string | null;
  supersedesConsentId: number | null;
  recordedByUserId: number;
  recordedAt: string;
}

export interface GrowDncrView {
  dncrStatusId: number;
  channel: string;
  status: string;
  jurisdiction: string | null;
  checkedAt: string;
  validUntil: string | null;
  reviewAt: string | null;
  source: string;
  reference: string | null;
  recordedByUserId: number;
  recordedAt: string;
}

export interface GrowSuppressionView {
  suppressionId: number;
  channel: string;
  state: string;
  reason: string;
  effectiveAt: string;
  expiresAt: string | null;
  reference: string | null;
  active: boolean;
  recordedByUserId: number;
  recordedAt: string;
}

export interface GrowContactabilityDecision {
  recorded: false;
  decision: GrowContactabilityStatus;
  reasonCode: string;
  reasonCodes: string[];
  jurisdiction: string | null;
  policyVersion: string | null;
  purpose: string;
  scope: string;
  streamRecorded: boolean;
  evaluatedAt: string;
}

export interface GrowRecordedDecision {
  id: number;
  decision: string;
  reasonCode: string;
  jurisdiction: string | null;
  policyVersion: string | null;
  evaluatedAt: string;
  decidedByUserId: number | null;
}

export interface GrowContactabilityChannel {
  channel: string;
  status: GrowContactabilityStatus;
  reasonCode: string;
  decision: GrowContactabilityDecision;
  lastRecordedDecision: GrowRecordedDecision | null;
  consentState: string;
  consent: GrowConsentStreamView | null;
  streams: GrowConsentStreamView[];
  dncrStatus: string;
  dncr: GrowDncrView | null;
  suppressed: boolean;
  suppression: GrowSuppressionView | null;
}

export interface GrowConsentPolicyView {
  policyVersionId: number;
  jurisdiction: string;
  version: string;
  effectiveAt: string;
  retiredAt: string | null;
  allowInferredConsent: boolean;
  allowNotRequiredConsent: boolean;
  dncrRequired: boolean;
  suppressionEnabled: boolean;
  timeZone: string | null;
  allowedHoursStart: string | null;
  allowedHoursEnd: string | null;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  callingWindowConfigured: boolean;
}

export type GrowContactabilityHistoryEntry =
  | ({ kind: "CONSENT"; id: number; occurredAt: string } & GrowConsentStreamView)
  | ({ kind: "DNCR"; id: number; occurredAt: string } & GrowDncrView)
  | ({ kind: "SUPPRESSION"; id: number; occurredAt: string } & GrowSuppressionView);

export interface GrowContactability {
  evaluatedAt: string;
  status: GrowContactabilityStatus;
  statusReasonCode: string;
  hasConsentRecords: boolean;
  awaitingPolicyApproval: boolean;
  policies: GrowConsentPolicyView[];
  channels: GrowContactabilityChannel[];
  activeSuppressions: GrowSuppressionView[];
  history: GrowContactabilityHistoryEntry[];
  historyTruncated: boolean;
}

/* ---------------------------------------------------------------------
 * Labels.
 * -----------------------------------------------------------------*/

const CHANNEL_LABELS: Record<string, string> = {
  EMAIL: "Email",
  SMS: "SMS",
  PHONE_CALL: "Phone call",
  VOICE_CALL: "Voice call",
  EXTERNAL_MESSAGE: "External message",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel.replace(/_/g, " ").toLowerCase();
}

const CONSENT_STATE_LABELS: Record<string, string> = {
  EXPRESS: "Express consent",
  INFERRED: "Inferred consent",
  NONE: "No consent",
  WITHDRAWN: "Withdrawn",
  UNKNOWN: "Not recorded",
  NOT_REQUIRED: "Consent not required",
};

export function consentStateLabel(state: string): string {
  return CONSENT_STATE_LABELS[state] ?? state.replace(/_/g, " ");
}

const DNCR_STATUS_LABELS: Record<string, string> = {
  CLEARED: "Cleared",
  LISTED: "Listed — do not call",
  UNKNOWN: "Checked, inconclusive",
  NOT_CHECKED: "Never checked",
};

export function dncrStatusLabel(status: string): string {
  return DNCR_STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

const STATUS_LABELS: Record<GrowContactabilityStatus, string> = {
  ELIGIBLE: "Cleared to contact",
  BLOCKED: "Do not contact",
  REVIEW_REQUIRED: "Needs review before contacting",
};

export function contactabilityStatusLabel(status: string): string {
  return STATUS_LABELS[status as GrowContactabilityStatus] ?? status.replace(/_/g, " ");
}

/**
 * Pill styling. REVIEW_REQUIRED is a warning, never a success — an unreviewed
 * channel must not read as "fine" at a glance.
 */
export function contactabilityStatusPillClass(status: string): string {
  if (status === "ELIGIBLE") return "pill pill-success";
  if (status === "BLOCKED") return "pill pill-danger";
  return "pill pill-warning";
}

/* ---------------------------------------------------------------------
 * Reason codes — the honest explanation of why something is unavailable.
 * -----------------------------------------------------------------*/

/**
 * Every reason code lib/consentControls.ts can return, as a sentence an agent
 * can act on. Kept complete on purpose: a missing entry would put a bare enum
 * value on the screen, which is the "bare failure" this slice exists to remove.
 */
const REASON_EXPLANATIONS: Record<string, string> = {
  WITHDRAWN: "This contact withdrew consent for this purpose and scope. AE will not use this channel, and the withdrawal cannot be reversed from this screen.",
  NO_VALID_DNCR_CLEARED_CONSENT:
    "A current Do Not Call Register check has to be on file before this channel can be used, and there isn't one. AE has no register integration, so the result of a manual check must be recorded against this contact.",
  DNCR_LISTED: "This contact is on the Do Not Call Register for this channel.",
  DNCR_STATUS_UNKNOWN: "Someone checked the Do Not Call Register and could not get an answer. The check needs to be repeated before this channel is used.",
  DNCR_JURISDICTION_UNKNOWN: "The Do Not Call Register check on file doesn't record which jurisdiction it covers.",
  DNCR_REVIEW_DUE: "The Do Not Call Register check on file is past its review date and has to be repeated.",
  SUPPRESSED: "Someone recorded an explicit instruction not to use this channel for this contact.",
  OUTSIDE_ALLOWED_HOURS: "The approved policy's contact window is closed at the moment.",
  UNKNOWN_CONSENT: "No consent has been recorded for this contact on this channel, so AE cannot say contacting them is permitted.",
  NO_CONSENT: "Consent for this channel was recorded as 'none'.",
  CONSENT_EXPIRED: "The recorded consent has passed its expiry date and needs to be captured again.",
  CONSENT_REVIEW_DUE: "The recorded consent is past its review date and needs to be confirmed.",
  UNKNOWN_JURISDICTION: "The recorded consent doesn't say whether it was given under AU or NZ rules, so no policy can be applied to it.",
  JURISDICTION_MISMATCH: "The consent, the policy and the register check don't agree on a jurisdiction.",
  POLICY_NOT_FOUND: "No approved consent policy is in force for this jurisdiction, so nothing can be cleared for contact yet.",
  POLICY_INVALID_WINDOW:
    "The consent policy in force doesn't define a time zone and contact window yet. Those values are deliberately unset while AU/NZ legal approval is outstanding, so every channel stays in review.",
  NOT_REQUIRED_JUSTIFIED: "Consent isn't required for this purpose and scope, and the justification is on file.",
  NOT_REQUIRED_JUSTIFICATION_MISSING: "The record says consent isn't required but gives no justification for that.",
  NOT_REQUIRED_NOT_ENABLED_BY_POLICY: "The policy in force doesn't allow a 'consent not required' state.",
  INFERRED_CONSENT_ELIGIBLE: "Inferred consent, with reviewed relationship evidence on file.",
  EXPRESS_CONSENT_ELIGIBLE: "Express consent is on file and current.",
  INFERRED_EVIDENCE_MISSING: "Inferred consent needs reviewed relationship evidence pointing at a real record; what's on file is missing or incomplete.",
  INFERRED_NOT_ENABLED_BY_POLICY: "The policy in force doesn't allow inferred consent.",
  NO_VALID_CONSENT: "No consent record matches this purpose and scope.",
  POLICY_INVALID_DNCR_CONFIG: "The policy in force doesn't say whether a Do Not Call Register check is required.",
  POLICY_INVALID_EFFECTIVE_AT: "The policy in force has no valid effective date.",
  POLICY_NOT_CURRENT: "The policy version on file isn't in force right now.",
  UNSUPPORTED_CHANNEL: "AE doesn't support recording consent on this channel.",
};

/**
 * The sentence for a reason code. An unrecognised code (a newer server build,
 * say) still produces something a human can read and repeat to support, rather
 * than a blank space or a raw enum on its own.
 */
export function explainReasonCode(reasonCode: string): string {
  const known = REASON_EXPLANATIONS[reasonCode];
  if (known) return known;
  return `AE's consent engine returned "${reasonCode}", which this version of the screen doesn't have an explanation for. Nothing has been sent.`;
}

/** True for every reason code this build knows about. Used by the tests. */
export function hasReasonExplanation(reasonCode: string): boolean {
  return reasonCode in REASON_EXPLANATIONS;
}

/* ---------------------------------------------------------------------
 * The headline, and the per-channel notice.
 * -----------------------------------------------------------------*/

export interface ContactabilityHeadline {
  status: GrowContactabilityStatus;
  label: string;
  /** Why the contact is in this state, in one sentence. */
  detail: string;
  /**
   * The standing pilot caveat, or null once a policy with a contact window is
   * approved. Rendered separately from `detail` so it reads as a system-wide
   * condition rather than something about this particular contact.
   */
  pilotNotice: string | null;
}

export function contactabilityHeadline(contactability: GrowContactability): ContactabilityHeadline {
  const pilotNotice = contactability.awaitingPolicyApproval
    ? contactability.policies.length === 0
      ? "No consent policy has been approved for this brokerage yet, so AE holds every channel in review. This is the expected pilot state, not a fault — approving an AU/NZ policy (including its time zone and contact window) is what releases it."
      : "The consent policy in force doesn't define a time zone and contact window yet, so AE holds every channel in review. Those values are awaiting AU/NZ legal approval."
    : null;

  const detail = contactability.hasConsentRecords
    ? explainReasonCode(contactability.statusReasonCode)
    : "Nothing has been recorded for this contact — no consent, no Do Not Call Register check and no suppression. AE treats an empty record as 'not permitted', never as 'allowed'.";

  return {
    status: contactability.status,
    label: contactabilityStatusLabel(contactability.status),
    detail,
    pilotNotice,
  };
}

/**
 * The notes shown under one channel, in the order they should be read. Returns
 * the reason the channel is in its current state, plus any additional recorded
 * fact the evaluator's single reason code cannot express on its own.
 *
 * Nothing here can make a channel look more permissive than the server said it
 * is: every entry either restates the server's own reason or adds a further
 * restriction that is already recorded.
 */
export function channelNotices(channel: GrowContactabilityChannel): string[] {
  const notices = [explainReasonCode(channel.reasonCode)];

  // The evaluator is fail-closed and exits at its FIRST failing gate, so a
  // recorded suppression or register listing can be invisible behind an
  // earlier reason. Say it anyway.
  if (channel.suppressed && channel.reasonCode !== "SUPPRESSED" && channel.suppression) {
    notices.push(`Also suppressed: ${channel.suppression.reason}`);
  }
  if (channel.dncrStatus === "LISTED" && channel.reasonCode !== "DNCR_LISTED") {
    notices.push("Also listed on the Do Not Call Register for this channel.");
  }

  // The register point, stated once, on the channels it actually applies to.
  if ((channel.channel === "PHONE_CALL" || channel.channel === "VOICE_CALL") && channel.dncrStatus === "NOT_CHECKED") {
    notices.push(
      "Nobody has checked the Do Not Call Register for this number. AE has no register integration, so a call cannot be cleared until a manual check is recorded.",
    );
  }

  return notices;
}

/* ---------------------------------------------------------------------
 * Form rules.
 * -----------------------------------------------------------------*/

export interface WithdrawConsentInput {
  reason: string;
  source: string;
  captureMethod: string;
}

/**
 * Withdrawal requires a reason, and this is where that is enforced for the
 * user rather than by a failed request.
 *
 * The database says the same thing —
 * grow_contact_channel_consents_withdrawal_fields_check requires withdrawn_at,
 * withdrawn_by_user_id and a non-blank withdrawal_reason — and
 * routes/growConsent.ts deliberately refuses to invent any of them. So a
 * withdrawal submitted without a reason is rejected by the server no matter
 * what; surfacing it as a form requirement means the agent is told what is
 * missing instead of being handed a 400.
 */
export function withdrawConsentError(input: WithdrawConsentInput): string | null {
  if (input.reason.trim().length === 0) return "A withdrawal reason is required — AE records why consent was withdrawn, not just that it was.";
  if (input.reason.trim().length > 1000) return "The withdrawal reason must be 1000 characters or fewer.";
  if (input.source.trim().length === 0) return "Say where this withdrawal came from, for example \"inbound phone call\" or \"reply to marketing email\".";
  if (input.captureMethod.trim().length === 0) return "Choose how the withdrawal was received.";
  return null;
}

export interface CaptureConsentInput {
  channel: string;
  state: string;
  purpose: string;
  scope: string;
  source: string;
  captureMethod: string;
  jurisdiction: string;
  evidenceReference: string;
  notRequiredJustification: string;
}

export function captureConsentError(input: CaptureConsentInput): string | null {
  if (!(GROW_CONSENT_CHANNELS as readonly string[]).includes(input.channel)) return "Choose a channel.";
  if (!(GROW_CONSENT_CAPTURABLE_STATES as readonly string[]).includes(input.state)) return "Choose a consent state.";
  if (input.purpose.trim().length === 0) return "A purpose is required — consent is recorded for a specific purpose, never for the contact as a whole.";
  if (input.scope.trim().length === 0) return "A scope is required — consent is recorded for a specific scope, never for the contact as a whole.";
  if (input.source.trim().length === 0) return "Say where this consent came from, for example \"signed appraisal authority\".";
  if (input.captureMethod.trim().length === 0) return "Choose how the consent was captured.";
  if (input.state === "NOT_REQUIRED" && input.notRequiredJustification.trim().length === 0) {
    return "\"Consent not required\" has to carry a justification.";
  }
  // The evaluator can only apply a policy to AU or NZ consent; anything else
  // resolves to UNKNOWN_JURISDICTION. Recording it is still allowed — the
  // record is the point — but the agent should know what it will mean.
  return null;
}

/**
 * The warning shown alongside an otherwise-valid capture form, or null. This
 * is advice, never a block: a truthful record of consent given with no
 * jurisdiction noted is better than no record.
 */
export function captureConsentWarning(input: CaptureConsentInput): string | null {
  if (input.jurisdiction !== "AU" && input.jurisdiction !== "NZ") {
    return "Without a jurisdiction, AE can't apply a consent policy to this record and the channel will stay in review.";
  }
  return null;
}

/**
 * The body POSTed to /grow/contacts/:partyId/consent to withdraw one stream.
 *
 * Withdrawal is scoped to a single (channel, purpose, scope) head stream and
 * supersedes it — this build has no contact-wide withdrawal, and whether it
 * should is an open Project Owner decision, so this does not invent one. The
 * actor is never sent: the server takes it from the session.
 */
export function withdrawConsentBody(stream: GrowConsentStreamView, input: WithdrawConsentInput, now: Date) {
  return {
    channel: stream.channel,
    state: "WITHDRAWN" as const,
    purpose: stream.purpose,
    scope: stream.scope,
    source: input.source.trim(),
    captureMethod: input.captureMethod.trim(),
    jurisdiction: stream.jurisdiction,
    withdrawnAt: now.toISOString(),
    withdrawalReason: input.reason.trim(),
    supersedesConsentId: stream.consentId,
  };
}

/**
 * The body POSTed to capture consent. `supersedesConsentId` is required by the
 * model for every append after the first on a stream, so the caller passes the
 * current head for that (channel, purpose, scope) when there is one.
 */
export function captureConsentBody(input: CaptureConsentInput, currentHead: GrowConsentStreamView | null) {
  return {
    channel: input.channel,
    state: input.state,
    purpose: input.purpose.trim(),
    scope: input.scope.trim(),
    source: input.source.trim(),
    captureMethod: input.captureMethod.trim(),
    ...(input.jurisdiction === "AU" || input.jurisdiction === "NZ" ? { jurisdiction: input.jurisdiction } : {}),
    ...(input.evidenceReference.trim() ? { evidenceReference: input.evidenceReference.trim() } : {}),
    ...(input.state === "NOT_REQUIRED" ? { notRequiredJustification: input.notRequiredJustification.trim() } : {}),
    ...(currentHead ? { supersedesConsentId: currentHead.consentId } : {}),
  };
}

/**
 * Can this stream be withdrawn from the screen? Only a head that is not
 * already withdrawn. The model refuses to supersede a withdrawn row, and this
 * build deliberately does not work around the no-re-consent rule.
 */
export function canWithdrawStream(stream: GrowConsentStreamView): boolean {
  return stream.state !== "WITHDRAWN";
}

/** One audit-history line's heading. */
export function historyEntryLabel(entry: GrowContactabilityHistoryEntry): string {
  if (entry.kind === "CONSENT") {
    return `${channelLabel(entry.channel)} · ${consentStateLabel(entry.state)} · ${entry.purpose} / ${entry.scope}`;
  }
  if (entry.kind === "DNCR") {
    return `${channelLabel(entry.channel)} · Do Not Call Register: ${dncrStatusLabel(entry.status)}`;
  }
  return `${channelLabel(entry.channel)} · ${entry.state === "RELEASED" ? "Suppression released" : "Suppressed"}`;
}

/** One audit-history line's detail, or null when the entry says it all. */
export function historyEntryDetail(entry: GrowContactabilityHistoryEntry): string | null {
  if (entry.kind === "CONSENT") {
    if (entry.state === "WITHDRAWN") return entry.withdrawalReason;
    if (entry.notRequiredJustification) return entry.notRequiredJustification;
    return entry.evidenceReference ? `Evidence: ${entry.evidenceReference}` : entry.source;
  }
  if (entry.kind === "DNCR") return entry.reference ? `${entry.source} · ${entry.reference}` : entry.source;
  return entry.reason;
}
