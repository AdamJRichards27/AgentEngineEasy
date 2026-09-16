// AE GROW Priority 6 Stage F2 step 1 — pure consent-control invariants and
// policy evaluation. Persistence and audit integration live in
// consentControlsPersistence.ts so these rules can be tested without a
// database or any live DNCR/provider capability.

export const GROW_CONSENT_CHANNELS = ["EMAIL", "SMS", "PHONE_CALL", "VOICE_CALL", "EXTERNAL_MESSAGE"] as const;
export type GrowConsentChannel = (typeof GROW_CONSENT_CHANNELS)[number];

export const GROW_CONSENT_STATES = ["EXPRESS", "INFERRED", "NONE", "WITHDRAWN", "UNKNOWN", "NOT_REQUIRED"] as const;
export type GrowConsentState = (typeof GROW_CONSENT_STATES)[number];

export const GROW_CONSENT_DECISIONS = ["ELIGIBLE", "BLOCKED", "REVIEW_REQUIRED"] as const;
export type GrowConsentDecision = (typeof GROW_CONSENT_DECISIONS)[number];

export const GROW_CONSENT_REASON_CODES = [
  "WITHDRAWN",
  "NO_VALID_DNCR_CLEARED_CONSENT",
  "DNCR_LISTED",
  "DNCR_STATUS_UNKNOWN",
  "DNCR_JURISDICTION_UNKNOWN",
  "DNCR_REVIEW_DUE",
  "SUPPRESSED",
  "OUTSIDE_ALLOWED_HOURS",
  "UNKNOWN_CONSENT",
  "NO_CONSENT",
  "CONSENT_EXPIRED",
  "CONSENT_REVIEW_DUE",
  "UNKNOWN_JURISDICTION",
  "JURISDICTION_MISMATCH",
  "POLICY_NOT_FOUND",
  "POLICY_INVALID_WINDOW",
  "NOT_REQUIRED_JUSTIFIED",
  "NOT_REQUIRED_JUSTIFICATION_MISSING",
  "NOT_REQUIRED_NOT_ENABLED_BY_POLICY",
  "INFERRED_CONSENT_ELIGIBLE",
  "EXPRESS_CONSENT_ELIGIBLE",
  "INFERRED_EVIDENCE_MISSING",
  "INFERRED_NOT_ENABLED_BY_POLICY",
  "NO_VALID_CONSENT",
  "POLICY_INVALID_DNCR_CONFIG",
  "POLICY_INVALID_EFFECTIVE_AT",
  "POLICY_NOT_CURRENT",
  "UNSUPPORTED_CHANNEL",
] as const;
export type GrowConsentReasonCode = (typeof GROW_CONSENT_REASON_CODES)[number];

export const GROW_DNCR_STATUSES = ["CLEARED", "LISTED", "UNKNOWN", "NOT_CHECKED"] as const;
export type GrowDncrStatus = (typeof GROW_DNCR_STATUSES)[number];

export const GROW_CONSENT_SUPPRESSION_STATES = ["SUPPRESSED", "RELEASED"] as const;
export type GrowConsentSuppressionState = (typeof GROW_CONSENT_SUPPRESSION_STATES)[number];

export interface ConsentCaptureEvidence {
  state: GrowConsentState;
  inferredReasoning?: string | null;
  relationshipEvidence?: unknown;
  inferredEvidenceReviewedAt?: Date | string | null;
  inferredEvidenceReviewedByUserId?: number | null;
  evidenceReference?: string | null;
  notRequiredJustification?: string | null;
  withdrawnAt?: Date | string | null;
  withdrawnByUserId?: number | null;
  withdrawalReason?: string | null;
}

export class ConsentControlsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsentControlsValidationError";
  }
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Relationship evidence must point to an actual recorded source. A label
 * such as "they know each other" is not sufficient evidence for INFERRED.
 * The source can be a relationship row, activity, document, import reference,
 * or another durable project record; this library does not invent one.
 */
export function hasRealRelationshipEvidence(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const record = value as Record<string, unknown>;
  const durableReferenceKeys = ["reference", "source", "sourceId", "recordId", "relationshipId", "activityId", "documentId"];
  return durableReferenceKeys.some((key) => nonBlank(record[key]));
}

export function validateConsentCaptureEvidence(input: ConsentCaptureEvidence): void {
  if (input.state === "INFERRED") {
    if (!nonBlank(input.inferredReasoning)) {
      throw new ConsentControlsValidationError("INFERRED consent requires explicit inferred reasoning.");
    }
    if (!nonBlank(input.evidenceReference)) {
      throw new ConsentControlsValidationError("INFERRED consent requires an evidence reference.");
    }
    if (!hasRealRelationshipEvidence(input.relationshipEvidence)) {
      throw new ConsentControlsValidationError(
        "INFERRED consent requires real relationship evidence with a durable source reference; a presumed relationship is not enough.",
      );
    }
    if (!asValidDate(input.inferredEvidenceReviewedAt) || !input.inferredEvidenceReviewedByUserId || input.inferredEvidenceReviewedByUserId < 1) {
      throw new ConsentControlsValidationError(
        "INFERRED consent requires reviewed-evidence time and reviewer metadata.",
      );
    }
  }

  if (input.state === "NOT_REQUIRED" && !nonBlank(input.notRequiredJustification)) {
    throw new ConsentControlsValidationError("NOT_REQUIRED consent requires a justification.");
  }

  if (input.state === "WITHDRAWN") {
    if (!input.withdrawnAt || !input.withdrawnByUserId || !nonBlank(input.withdrawalReason)) {
      throw new ConsentControlsValidationError("WITHDRAWN consent requires withdrawal time, actor, and reason.");
    }
  }
}

export interface ConsentPolicyForEvaluation {
  jurisdiction: string;
  version: string;
  effectiveAt?: Date | string | null;
  retiredAt?: Date | string | null;
  allowInferredConsent?: boolean;
  allowNotRequiredConsent?: boolean;
  dncrRequired?: boolean;
  suppressionEnabled?: boolean;
  timeZone?: string | null;
  allowedHoursStart?: string | null;
  allowedHoursEnd?: string | null;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
}

export interface ConsentRecordForEvaluation extends ConsentCaptureEvidence {
  id?: number;
  purpose?: string | null;
  scope?: string | null;
  jurisdiction?: string | null;
  expiresAt?: Date | string | null;
  reviewAt?: Date | string | null;
}

export interface DncrStatusForEvaluation {
  id?: number;
  status: GrowDncrStatus | string;
  checkedAt?: Date | string | null;
  validUntil?: Date | string | null;
  reviewAt?: Date | string | null;
  jurisdiction?: string | null;
  reference?: string | null;
}

export interface SuppressionForEvaluation {
  id?: number;
  state: GrowConsentSuppressionState | string;
  effectiveAt?: Date | string | null;
  expiresAt?: Date | string | null;
}

export interface EvaluateConsentDecisionInput {
  channel: GrowConsentChannel | string;
  purpose: string;
  scope: string;
  jurisdiction?: string | null;
  consent?: ConsentRecordForEvaluation | null;
  dncr?: DncrStatusForEvaluation | null;
  suppression?: SuppressionForEvaluation | null;
  policy?: ConsentPolicyForEvaluation | null;
  now?: Date;
}

export interface ConsentDecisionResult {
  decision: GrowConsentDecision;
  outcome: GrowConsentDecision;
  eligible: boolean;
  requiresReview: boolean;
  reasonCode: GrowConsentReasonCode;
  reasonCodes: GrowConsentReasonCode[];
  jurisdiction: string | null;
  policyVersion: string | null;
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function asValidDate(value: Date | string | null | undefined): Date | null {
  return asDate(value);
}

function isPast(value: Date | string | null | undefined, now: Date): boolean {
  const date = asDate(value);
  return date !== null && date.getTime() <= now.getTime();
}

function isFuture(value: Date | string | null | undefined, now: Date): boolean {
  const date = asDate(value);
  return date !== null && date.getTime() > now.getTime();
}

interface HourMinute {
  hour: number;
  minute: number;
}

function parseHourMinute(value: string | null | undefined): HourMinute | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function localMinutes(now: Date, timeZone: string | null | undefined): number | null {
  try {
    if (!timeZone || !timeZone.trim()) return null;
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts: Record<string, string> = {};
    for (const part of formatter.formatToParts(now)) parts[part.type] = part.value;
    return Number(parts.hour) * 60 + Number(parts.minute);
  } catch {
    return null;
  }
}

function isWithinWindow(minutes: number, start: HourMinute, end: HourMinute): boolean {
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) return minutes >= startMinutes && minutes < endMinutes;
  return minutes >= startMinutes || minutes < endMinutes;
}

function isZeroWidthWindow(start: HourMinute, end: HourMinute): boolean {
  return start.hour === end.hour && start.minute === end.minute;
}

/**
 * Returns true when the configured policy allows an instant. `null` means the
 * policy supplied a malformed or incomplete pair, which is review-required
 * rather than silently treated as an open window.
 */
export function isWithinConsentHours(now: Date, policy: ConsentPolicyForEvaluation): boolean | null {
  if (!policy.timeZone || !policy.timeZone.trim()) return null;
  const allowedConfigured = Boolean(policy.allowedHoursStart || policy.allowedHoursEnd);
  const quietConfigured = Boolean(policy.quietHoursStart || policy.quietHoursEnd);
  if (!allowedConfigured) return null;

  const minutes = localMinutes(now, policy.timeZone);
  if (minutes === null) return null;

  if (allowedConfigured) {
    const start = parseHourMinute(policy.allowedHoursStart);
    const end = parseHourMinute(policy.allowedHoursEnd);
    if (!start || !end) return null;
    if (!isZeroWidthWindow(start, end) && !isWithinWindow(minutes, start, end)) return false;
  }

  if (quietConfigured) {
    const start = parseHourMinute(policy.quietHoursStart);
    const end = parseHourMinute(policy.quietHoursEnd);
    if (!start || !end) return null;
    if (!isZeroWidthWindow(start, end) && isWithinWindow(minutes, start, end)) return false;
  }

  return true;
}

function result(
  decision: GrowConsentDecision,
  reasonCode: GrowConsentReasonCode,
  jurisdiction: string | null,
  policyVersion: string | null,
): ConsentDecisionResult {
  return {
    decision,
    outcome: decision,
    eligible: decision === "ELIGIBLE",
    requiresReview: decision === "REVIEW_REQUIRED",
    reasonCode,
    reasonCodes: [reasonCode],
    jurisdiction,
    policyVersion,
  };
}

function policyIsCurrent(policy: ConsentPolicyForEvaluation, now: Date): boolean {
  const effectiveAt = asDate(policy.effectiveAt);
  const retiredAt = asDate(policy.retiredAt);
  if (!effectiveAt || effectiveAt.getTime() > now.getTime()) return false;
  if (policy.retiredAt !== null && policy.retiredAt !== undefined && !retiredAt) return false;
  return !retiredAt || retiredAt.getTime() > now.getTime();
}

function channelRequiresDncr(policy: ConsentPolicyForEvaluation): boolean {
  // The reviewed policy row is the source of truth. Missing configuration is
  // rejected before this function is called; there is no channel default.
  return policy.dncrRequired === true;
}

function activeSuppression(suppression: SuppressionForEvaluation | null | undefined, now: Date): boolean {
  if (!suppression || suppression.state !== "SUPPRESSED") return false;
  const effectiveAt = asDate(suppression.effectiveAt);
  if (effectiveAt && effectiveAt.getTime() > now.getTime()) return false;
  return !isPast(suppression.expiresAt, now);
}

/**
 * The single provider-neutral eligibility gate. It never contacts a DNCR
 * service and never sends anything; callers provide a mockable, recorded
 * observation and a versioned policy.
 */
export function evaluateConsentDecision(input: EvaluateConsentDecisionInput): ConsentDecisionResult {
  const now = input.now ? new Date(input.now.getTime()) : new Date();
  const consent = input.consent ?? null;
  const policy = input.policy ?? null;
  const jurisdiction = input.jurisdiction ?? consent?.jurisdiction ?? null;
  const consentJurisdiction = consent?.jurisdiction ?? null;
  const policyVersion = policy?.version ?? null;

  if (!GROW_CONSENT_CHANNELS.includes(input.channel as GrowConsentChannel)) {
    return result("REVIEW_REQUIRED", "UNSUPPORTED_CHANNEL", consent?.jurisdiction ?? null, policyVersion);
  }

  if (consent?.state === "WITHDRAWN") {
    return result("BLOCKED", "WITHDRAWN", jurisdiction, policyVersion);
  }

  if (!consent) {
    return result("REVIEW_REQUIRED", "UNKNOWN_CONSENT", null, policyVersion);
  }
  if (!consentJurisdiction) {
    return result("REVIEW_REQUIRED", "UNKNOWN_JURISDICTION", null, policyVersion);
  }
  if (jurisdiction && jurisdiction !== consentJurisdiction) {
    return result("REVIEW_REQUIRED", "JURISDICTION_MISMATCH", consentJurisdiction, policyVersion);
  }
  const canonicalJurisdiction = consentJurisdiction;
  if (canonicalJurisdiction !== "AU" && canonicalJurisdiction !== "NZ") {
    return result("REVIEW_REQUIRED", "UNKNOWN_JURISDICTION", jurisdiction, policyVersion);
  }
  if (!policy) return result("REVIEW_REQUIRED", "POLICY_NOT_FOUND", canonicalJurisdiction, policyVersion);
  if (policy.jurisdiction !== canonicalJurisdiction) {
    return result("REVIEW_REQUIRED", "JURISDICTION_MISMATCH", canonicalJurisdiction, policyVersion);
  }
  if (!asDate(policy.effectiveAt)) {
    return result("REVIEW_REQUIRED", "POLICY_INVALID_EFFECTIVE_AT", canonicalJurisdiction, policyVersion);
  }
  if (!policyIsCurrent(policy, now)) {
    return result("REVIEW_REQUIRED", "POLICY_NOT_CURRENT", canonicalJurisdiction, policyVersion);
  }
  if (typeof policy.dncrRequired !== "boolean") {
    return result("REVIEW_REQUIRED", "POLICY_INVALID_DNCR_CONFIG", canonicalJurisdiction, policyVersion);
  }
  if (!consent || !consent.purpose || !consent.scope || consent.purpose !== input.purpose || consent.scope !== input.scope) {
    return result("REVIEW_REQUIRED", "NO_VALID_CONSENT", canonicalJurisdiction, policyVersion);
  }

  if (!consent || consent.state === "UNKNOWN") {
    return result("REVIEW_REQUIRED", "UNKNOWN_CONSENT", canonicalJurisdiction, policyVersion);
  }
  if (isPast(consent.expiresAt, now)) {
    return result("REVIEW_REQUIRED", "CONSENT_EXPIRED", canonicalJurisdiction, policyVersion);
  }
  if (isPast(consent.reviewAt, now)) {
    return result("REVIEW_REQUIRED", "CONSENT_REVIEW_DUE", canonicalJurisdiction, policyVersion);
  }

  if (policy.suppressionEnabled !== false && activeSuppression(input.suppression, now)) {
    return result("BLOCKED", "SUPPRESSED", canonicalJurisdiction, policyVersion);
  }

  if (channelRequiresDncr(policy)) {
    const dncr = input.dncr;
    if (!dncr || dncr.status === "NOT_CHECKED") {
      return result("BLOCKED", "NO_VALID_DNCR_CLEARED_CONSENT", canonicalJurisdiction, policyVersion);
    }
    if (dncr.status === "LISTED") return result("BLOCKED", "DNCR_LISTED", canonicalJurisdiction, policyVersion);
    if (dncr.status === "UNKNOWN") return result("REVIEW_REQUIRED", "DNCR_STATUS_UNKNOWN", canonicalJurisdiction, policyVersion);
    if (!dncr.jurisdiction) return result("REVIEW_REQUIRED", "DNCR_JURISDICTION_UNKNOWN", canonicalJurisdiction, policyVersion);
    if (dncr.jurisdiction !== canonicalJurisdiction) {
      return result("REVIEW_REQUIRED", "JURISDICTION_MISMATCH", canonicalJurisdiction, policyVersion);
    }
    if (!asDate(dncr.checkedAt) || isFuture(dncr.checkedAt, now)) {
      return result("REVIEW_REQUIRED", "DNCR_STATUS_UNKNOWN", canonicalJurisdiction, policyVersion);
    }
    if (dncr.status !== "CLEARED" || !asDate(dncr.validUntil) || isPast(dncr.validUntil, now) || !nonBlank(dncr.reference)) {
      return result("BLOCKED", "NO_VALID_DNCR_CLEARED_CONSENT", canonicalJurisdiction, policyVersion);
    }
    if (!asDate(dncr.reviewAt) || isPast(dncr.reviewAt, now)) {
      return result("REVIEW_REQUIRED", "DNCR_REVIEW_DUE", canonicalJurisdiction, policyVersion);
    }
  }

  const withinHours = isWithinConsentHours(now, policy);
  if (withinHours === null) return result("REVIEW_REQUIRED", "POLICY_INVALID_WINDOW", canonicalJurisdiction, policyVersion);
  if (!withinHours) return result("BLOCKED", "OUTSIDE_ALLOWED_HOURS", canonicalJurisdiction, policyVersion);

  switch (consent.state) {
    case "EXPRESS":
      return result("ELIGIBLE", "EXPRESS_CONSENT_ELIGIBLE", canonicalJurisdiction, policyVersion);
    case "INFERRED":
      if (
        !hasRealRelationshipEvidence(consent.relationshipEvidence) ||
        !nonBlank(consent.inferredReasoning) ||
        !nonBlank(consent.evidenceReference) ||
        !asValidDate(consent.inferredEvidenceReviewedAt) ||
        !consent.inferredEvidenceReviewedByUserId ||
        isFuture(consent.inferredEvidenceReviewedAt, now)
      ) {
        return result("REVIEW_REQUIRED", "INFERRED_EVIDENCE_MISSING", canonicalJurisdiction, policyVersion);
      }
      if (policy.allowInferredConsent !== true) {
        return result("REVIEW_REQUIRED", "INFERRED_NOT_ENABLED_BY_POLICY", canonicalJurisdiction, policyVersion);
      }
      return result("ELIGIBLE", "INFERRED_CONSENT_ELIGIBLE", canonicalJurisdiction, policyVersion);
    case "NOT_REQUIRED":
      if (!nonBlank(consent.notRequiredJustification)) {
        return result("REVIEW_REQUIRED", "NOT_REQUIRED_JUSTIFICATION_MISSING", canonicalJurisdiction, policyVersion);
      }
      if (policy.allowNotRequiredConsent !== true) {
        return result("REVIEW_REQUIRED", "NOT_REQUIRED_NOT_ENABLED_BY_POLICY", canonicalJurisdiction, policyVersion);
      }
      return result("ELIGIBLE", "NOT_REQUIRED_JUSTIFIED", canonicalJurisdiction, policyVersion);
    case "NONE":
      return result("BLOCKED", "NO_CONSENT", canonicalJurisdiction, policyVersion);
    default:
      return result("REVIEW_REQUIRED", "NO_VALID_CONSENT", canonicalJurisdiction, policyVersion);
  }
}