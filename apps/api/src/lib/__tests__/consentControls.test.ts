import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ConsentControlsValidationError,
  evaluateConsentDecision,
  validateConsentCaptureEvidence,
} from "../consentControls.js";

const NOW = new Date("2026-01-15T12:00:00.000Z");
const AU_POLICY = {
  jurisdiction: "AU",
  version: "au-2026-01",
  effectiveAt: new Date("2025-01-01T00:00:00.000Z"),
  dncrRequired: true,
  allowInferredConsent: true,
  allowNotRequiredConsent: false,
  suppressionEnabled: true,
  timeZone: "Etc/UTC",
  allowedHoursStart: "00:00",
  allowedHoursEnd: "23:59",
};

const CLEARED_DNCR = {
  status: "CLEARED" as const,
  reference: "mock-dncr-check-001",
  checkedAt: NOW,
  validUntil: new Date("2026-02-15T12:00:00.000Z"),
  reviewAt: new Date("2026-02-01T12:00:00.000Z"),
  jurisdiction: "AU",
};

test("missing consent defaults to review-required rather than eligible", () => {
  const decision = evaluateConsentDecision({
    channel: "PHONE_CALL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: AU_POLICY,
    dncr: CLEARED_DNCR,
    consent: null,
    now: NOW,
  });
  assert.equal(decision.decision, "REVIEW_REQUIRED");
  assert.equal(decision.reasonCode, "UNKNOWN_CONSENT");
});

test("express consent is eligible only with a valid cleared DNCR observation", () => {
  const consent = {
    state: "EXPRESS" as const,
    jurisdiction: "AU",
    purpose: "outreach",
    scope: "standing",
    evidenceReference: "capture-001",
  };
  const eligible = evaluateConsentDecision({
    channel: "PHONE_CALL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: AU_POLICY,
    dncr: CLEARED_DNCR,
    consent,
    now: NOW,
  });
  assert.equal(eligible.decision, "ELIGIBLE");
  assert.equal(eligible.reasonCode, "EXPRESS_CONSENT_ELIGIBLE");

  const noDncr = evaluateConsentDecision({
    channel: "PHONE_CALL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: AU_POLICY,
    consent,
    now: NOW,
  });
  assert.equal(noDncr.decision, "BLOCKED");
  assert.equal(noDncr.reasonCode, "NO_VALID_DNCR_CLEARED_CONSENT");
});

test("inferred consent rejects an assumed relationship and accepts durable relationship evidence", () => {
  assert.throws(
    () =>
      validateConsentCaptureEvidence({
        state: "INFERRED",
        inferredReasoning: "The contact is probably related to the owner.",
        evidenceReference: "note-001",
        relationshipEvidence: { relationship: "family" },
      }),
    (error: unknown) => error instanceof ConsentControlsValidationError,
  );

  assert.doesNotThrow(() =>
    validateConsentCaptureEvidence({
      state: "INFERRED",
      inferredReasoning: "A recorded relationship links this contact to the referral source.",
      evidenceReference: "grow-relationship-42",
      relationshipEvidence: { source: "grow_relationships", sourceId: "42" },
        inferredEvidenceReviewedAt: NOW,
        inferredEvidenceReviewedByUserId: 7,
    }),
  );

  const eligible = evaluateConsentDecision({
    channel: "PHONE_CALL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: AU_POLICY,
    dncr: CLEARED_DNCR,
    consent: {
      state: "INFERRED",
      jurisdiction: "AU",
      purpose: "outreach",
      scope: "standing",
      inferredReasoning: "A recorded relationship links this contact to the referral source.",
      evidenceReference: "grow-relationship-42",
      relationshipEvidence: { source: "grow_relationships", sourceId: "42" },
      inferredEvidenceReviewedAt: NOW,
      inferredEvidenceReviewedByUserId: 7,
    },
    now: NOW,
  });
  assert.equal(eligible.reasonCode, "INFERRED_CONSENT_ELIGIBLE");
});

test("inferred consent requires explicit reviewed-evidence metadata", () => {
  assert.throws(
    () =>
      validateConsentCaptureEvidence({
        state: "INFERRED",
        inferredReasoning: "A recorded relationship is documented.",
        evidenceReference: "grow-relationship-43",
        relationshipEvidence: { source: "grow_relationships", sourceId: "43" },
      }),
    (error: unknown) => error instanceof ConsentControlsValidationError,
  );
});

test("withdrawal and suppression fail closed", () => {
  const withdrawn = evaluateConsentDecision({
    channel: "PHONE_CALL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: AU_POLICY,
    consent: { state: "WITHDRAWN", jurisdiction: "AU" },
    now: NOW,
  });
  assert.equal(withdrawn.decision, "BLOCKED");
  assert.equal(withdrawn.reasonCode, "WITHDRAWN");

  const suppressed = evaluateConsentDecision({
    channel: "PHONE_CALL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: AU_POLICY,
    dncr: CLEARED_DNCR,
    consent: { state: "EXPRESS", jurisdiction: "AU", purpose: "outreach", scope: "standing" },
    suppression: { state: "SUPPRESSED", effectiveAt: NOW },
    now: NOW,
  });
  assert.equal(suppressed.decision, "BLOCKED");
  assert.equal(suppressed.reasonCode, "SUPPRESSED");
});

test("unknown jurisdiction and outside configured hours require safe outcomes", () => {
  const unknownJurisdiction = evaluateConsentDecision({
    channel: "PHONE_CALL",
    purpose: "outreach",
    scope: "standing",
    policy: AU_POLICY,
    consent: { state: "EXPRESS" },
    dncr: CLEARED_DNCR,
    now: NOW,
  });
  assert.equal(unknownJurisdiction.decision, "REVIEW_REQUIRED");
  assert.equal(unknownJurisdiction.reasonCode, "UNKNOWN_JURISDICTION");

  const outsideHours = evaluateConsentDecision({
    channel: "PHONE_CALL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: { ...AU_POLICY, timeZone: "Etc/UTC", allowedHoursStart: "09:00", allowedHoursEnd: "10:00" },
    dncr: CLEARED_DNCR,
    consent: { state: "EXPRESS", jurisdiction: "AU", purpose: "outreach", scope: "standing" },
    now: NOW,
  });
  assert.equal(outsideHours.decision, "BLOCKED");
  assert.equal(outsideHours.reasonCode, "OUTSIDE_ALLOWED_HOURS");
});

test("NOT_REQUIRED is eligible only when its justification is present", () => {
  assert.throws(
    () => validateConsentCaptureEvidence({ state: "NOT_REQUIRED" }),
    (error: unknown) => error instanceof ConsentControlsValidationError,
  );
  const decision = evaluateConsentDecision({
    channel: "EMAIL",
    purpose: "internal",
    scope: "one-off",
    jurisdiction: "NZ",
    policy: {
      jurisdiction: "NZ",
      version: "nz-2026-01",
      effectiveAt: new Date("2025-01-01T00:00:00.000Z"),
      dncrRequired: false,
      allowNotRequiredConsent: true,
      timeZone: "Etc/UTC",
      allowedHoursStart: "00:00",
      allowedHoursEnd: "23:59",
    },
    consent: {
      state: "NOT_REQUIRED",
      jurisdiction: "NZ",
      purpose: "internal",
      scope: "one-off",
      notRequiredJustification: "Internal service record, no external delivery.",
    },
    now: NOW,
  });
  assert.equal(decision.decision, "ELIGIBLE");
  assert.equal(decision.reasonCode, "NOT_REQUIRED_JUSTIFIED");

  const policyDisabled = evaluateConsentDecision({
    channel: "EMAIL",
    purpose: "internal",
    scope: "one-off",
    jurisdiction: "NZ",
    policy: {
      jurisdiction: "NZ",
      version: "nz-2026-02",
      effectiveAt: new Date("2025-01-01T00:00:00.000Z"),
      dncrRequired: false,
      allowNotRequiredConsent: false,
      timeZone: "Etc/UTC",
      allowedHoursStart: "00:00",
      allowedHoursEnd: "23:59",
    },
    consent: {
      state: "NOT_REQUIRED",
      jurisdiction: "NZ",
      purpose: "internal",
      scope: "one-off",
      notRequiredJustification: "Internal service record.",
    },
    now: NOW,
  });
  assert.equal(policyDisabled.decision, "REVIEW_REQUIRED");
  assert.equal(policyDisabled.reasonCode, "NOT_REQUIRED_NOT_ENABLED_BY_POLICY");
});

test("missing timezone or allowed hours is review-required", () => {
  const decision = evaluateConsentDecision({
    channel: "EMAIL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: { ...AU_POLICY, timeZone: null, allowedHoursStart: null, allowedHoursEnd: null },
    dncr: CLEARED_DNCR,
    consent: { state: "EXPRESS", jurisdiction: "AU", purpose: "outreach", scope: "standing" },
    now: NOW,
  });
  assert.equal(decision.decision, "REVIEW_REQUIRED");
  assert.equal(decision.reasonCode, "POLICY_INVALID_WINDOW");
});

test("policy timing/configuration, unsupported channels, and future inferred review fail closed", () => {
  const missingEffectiveAt = evaluateConsentDecision({
    channel: "EMAIL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: { ...AU_POLICY, effectiveAt: "not-a-date" },
    consent: { state: "EXPRESS", jurisdiction: "AU", purpose: "outreach", scope: "standing" },
    now: NOW,
  });
  assert.equal(missingEffectiveAt.reasonCode, "POLICY_INVALID_EFFECTIVE_AT");

  const missingDncrConfig = evaluateConsentDecision({
    channel: "EMAIL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: { ...AU_POLICY, dncrRequired: undefined },
    consent: { state: "EXPRESS", jurisdiction: "AU", purpose: "outreach", scope: "standing" },
    now: NOW,
  });
  assert.equal(missingDncrConfig.reasonCode, "POLICY_INVALID_DNCR_CONFIG");

  const unsupportedChannel = evaluateConsentDecision({
    channel: "FAX",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: AU_POLICY,
    consent: { state: "EXPRESS", jurisdiction: "AU", purpose: "outreach", scope: "standing" },
    now: NOW,
  });
  assert.equal(unsupportedChannel.reasonCode, "UNSUPPORTED_CHANNEL");

  const futureReviewed = evaluateConsentDecision({
    channel: "PHONE_CALL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: AU_POLICY,
    dncr: CLEARED_DNCR,
    consent: {
      state: "INFERRED",
      jurisdiction: "AU",
      purpose: "outreach",
      scope: "standing",
      inferredReasoning: "Recorded relationship.",
      relationshipEvidence: { source: "grow_relationships", sourceId: "44" },
      evidenceReference: "grow-relationship-44",
      inferredEvidenceReviewedAt: new Date("2026-01-16T12:00:00.000Z"),
      inferredEvidenceReviewedByUserId: 7,
    },
    now: NOW,
  });
  assert.equal(futureReviewed.reasonCode, "INFERRED_EVIDENCE_MISSING");
});