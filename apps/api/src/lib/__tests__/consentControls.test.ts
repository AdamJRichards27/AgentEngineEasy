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

test("consent decision matrix keeps express eligible and inferred consent review-required without proof", () => {
  const express = evaluateConsentDecision({
    channel: "EMAIL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: { ...AU_POLICY, dncrRequired: false },
    consent: {
      state: "EXPRESS",
      jurisdiction: "AU",
      purpose: "outreach",
      scope: "standing",
    },
    now: NOW,
  });
  assert.deepEqual(
    { decision: express.decision, reasonCode: express.reasonCode },
    { decision: "ELIGIBLE", reasonCode: "EXPRESS_CONSENT_ELIGIBLE" },
  );

  const inferredWithoutProof = evaluateConsentDecision({
    channel: "EMAIL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: { ...AU_POLICY, dncrRequired: false },
    consent: {
      state: "INFERRED",
      jurisdiction: "AU",
      purpose: "outreach",
      scope: "standing",
      inferredReasoning: "The contact probably knows the owner.",
    },
    now: NOW,
  });
  assert.deepEqual(
    { decision: inferredWithoutProof.decision, reasonCode: inferredWithoutProof.reasonCode },
    { decision: "REVIEW_REQUIRED", reasonCode: "INFERRED_EVIDENCE_MISSING" },
  );
});

test("DNCR status matrix fails closed for missing, listed, unknown, unchecked, expired, due, mismatched, future, and unreferenced observations", () => {
  const scenarios = [
    {
      name: "missing observation",
      dncr: null,
      decision: "BLOCKED",
      reasonCode: "NO_VALID_DNCR_CLEARED_CONSENT",
    },
    {
      name: "listed",
      dncr: { status: "LISTED", jurisdiction: "AU" },
      decision: "BLOCKED",
      reasonCode: "DNCR_LISTED",
    },
    {
      name: "provider status unknown",
      dncr: { status: "UNKNOWN", jurisdiction: "AU", checkedAt: NOW },
      decision: "REVIEW_REQUIRED",
      reasonCode: "DNCR_STATUS_UNKNOWN",
    },
    {
      name: "not checked",
      dncr: { status: "NOT_CHECKED", jurisdiction: "AU", checkedAt: NOW },
      decision: "BLOCKED",
      reasonCode: "NO_VALID_DNCR_CLEARED_CONSENT",
    },
    {
      name: "cleared observation expired",
      dncr: { ...CLEARED_DNCR, validUntil: new Date("2026-01-15T11:59:59.000Z") },
      decision: "BLOCKED",
      reasonCode: "NO_VALID_DNCR_CLEARED_CONSENT",
    },
    {
      name: "cleared observation review due",
      dncr: { ...CLEARED_DNCR, reviewAt: new Date("2026-01-15T11:59:59.000Z") },
      decision: "REVIEW_REQUIRED",
      reasonCode: "DNCR_REVIEW_DUE",
    },
    {
      name: "cleared observation jurisdiction mismatch",
      dncr: { ...CLEARED_DNCR, jurisdiction: "NZ" },
      decision: "REVIEW_REQUIRED",
      reasonCode: "JURISDICTION_MISMATCH",
    },
    {
      name: "cleared observation checked in the future",
      dncr: { ...CLEARED_DNCR, checkedAt: new Date("2026-01-15T12:00:01.000Z") },
      decision: "REVIEW_REQUIRED",
      reasonCode: "DNCR_STATUS_UNKNOWN",
    },
    {
      name: "cleared observation has no provider reference",
      dncr: { ...CLEARED_DNCR, reference: null },
      decision: "BLOCKED",
      reasonCode: "NO_VALID_DNCR_CLEARED_CONSENT",
    },
    {
      name: "valid cleared observation",
      dncr: CLEARED_DNCR,
      decision: "ELIGIBLE",
      reasonCode: "EXPRESS_CONSENT_ELIGIBLE",
    },
  ] as const;

  for (const scenario of scenarios) {
    const outcome = evaluateConsentDecision({
      channel: "PHONE_CALL",
      purpose: "outreach",
      scope: "standing",
      jurisdiction: "AU",
      policy: AU_POLICY,
      consent: {
        state: "EXPRESS",
        jurisdiction: "AU",
        purpose: "outreach",
        scope: "standing",
      },
      dncr: scenario.dncr,
      now: NOW,
    });
    assert.equal(outcome.decision, scenario.decision, scenario.name);
    assert.equal(outcome.reasonCode, scenario.reasonCode, scenario.name);
  }
});

test("explicit NONE consent is blocked rather than treated as unknown", () => {
  const outcome = evaluateConsentDecision({
    channel: "EMAIL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: { ...AU_POLICY, dncrRequired: false },
    consent: {
      state: "NONE",
      jurisdiction: "AU",
      purpose: "outreach",
      scope: "standing",
    },
    now: NOW,
  });
  assert.equal(outcome.decision, "BLOCKED");
  assert.equal(outcome.reasonCode, "NO_CONSENT");
});

test("a cleared DNCR observation without jurisdiction requires review", () => {
  const outcome = evaluateConsentDecision({
    channel: "PHONE_CALL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: AU_POLICY,
    consent: {
      state: "EXPRESS",
      jurisdiction: "AU",
      purpose: "outreach",
      scope: "standing",
    },
    dncr: { ...CLEARED_DNCR, jurisdiction: null },
    now: NOW,
  });
  assert.equal(outcome.decision, "REVIEW_REQUIRED");
  assert.equal(outcome.reasonCode, "DNCR_JURISDICTION_UNKNOWN");
});

test("unknown consent defaults to review and withdrawal blocks a formerly valid consent", () => {
  const unknown = evaluateConsentDecision({
    channel: "EMAIL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: { ...AU_POLICY, dncrRequired: false },
    consent: { state: "UNKNOWN", jurisdiction: "AU", purpose: "outreach", scope: "standing" },
    now: NOW,
  });
  assert.equal(unknown.decision, "REVIEW_REQUIRED");
  assert.equal(unknown.reasonCode, "UNKNOWN_CONSENT");

  const withdrawn = evaluateConsentDecision({
    channel: "EMAIL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: { ...AU_POLICY, dncrRequired: false },
    consent: {
      state: "WITHDRAWN",
      jurisdiction: "AU",
      purpose: "outreach",
      scope: "standing",
      withdrawnAt: new Date("2026-01-15T11:00:00.000Z"),
      withdrawnByUserId: 7,
      withdrawalReason: "Contact requested no further messages.",
    },
    now: NOW,
  });
  assert.equal(withdrawn.decision, "BLOCKED");
  assert.equal(withdrawn.reasonCode, "WITHDRAWN");
});

test("allowed hours handle a midnight-crossing window and the policy timezone", () => {
  const midnightWindow = {
    ...AU_POLICY,
    dncrRequired: false,
    timeZone: "Etc/UTC",
    allowedHoursStart: "22:00",
    allowedHoursEnd: "06:00",
  };
  const atMidnight = evaluateConsentDecision({
    channel: "EMAIL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: midnightWindow,
    consent: { state: "EXPRESS", jurisdiction: "AU", purpose: "outreach", scope: "standing" },
    now: new Date("2026-01-16T00:30:00.000Z"),
  });
  assert.equal(atMidnight.decision, "ELIGIBLE");
  assert.equal(atMidnight.reasonCode, "EXPRESS_CONSENT_ELIGIBLE");

  const outsideMidnightWindow = evaluateConsentDecision({
    channel: "EMAIL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: midnightWindow,
    consent: { state: "EXPRESS", jurisdiction: "AU", purpose: "outreach", scope: "standing" },
    now: new Date("2026-01-16T12:00:00.000Z"),
  });
  assert.equal(outsideMidnightWindow.decision, "BLOCKED");
  assert.equal(outsideMidnightWindow.reasonCode, "OUTSIDE_ALLOWED_HOURS");

  const newYorkBusinessHours = evaluateConsentDecision({
    channel: "EMAIL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: {
      ...AU_POLICY,
      dncrRequired: false,
      timeZone: "America/New_York",
      allowedHoursStart: "09:00",
      allowedHoursEnd: "17:00",
    },
    consent: { state: "EXPRESS", jurisdiction: "AU", purpose: "outreach", scope: "standing" },
    now: new Date("2026-01-15T14:00:00.000Z"),
  });
  assert.equal(newYorkBusinessHours.decision, "ELIGIBLE");
  assert.equal(newYorkBusinessHours.reasonCode, "EXPRESS_CONSENT_ELIGIBLE");
});

test("AU and NZ evaluate the same instant against explicit jurisdiction policies independently", () => {
  // In July, Sydney is UTC+10 (17:00) and Auckland is UTC+12 (19:00) at
  // this instant. The identical 09:00-18:00 window therefore produces
  // different outcomes solely from the jurisdiction-specific timezone.
  const sameInstant = new Date("2026-07-15T07:00:00.000Z");
  const sharedPolicy = {
    version: "same-hours-comparison-v1",
    effectiveAt: new Date("2025-01-01T00:00:00.000Z"),
    dncrRequired: true,
    allowInferredConsent: false,
    allowNotRequiredConsent: false,
    suppressionEnabled: true,
    allowedHoursStart: "09:00",
    allowedHoursEnd: "18:00",
  };
  const sharedDncr = {
    ...CLEARED_DNCR,
    checkedAt: new Date("2026-07-15T06:00:00.000Z"),
    validUntil: new Date("2026-08-15T07:00:00.000Z"),
    reviewAt: new Date("2026-08-01T07:00:00.000Z"),
  };
  const au = evaluateConsentDecision({
    channel: "EMAIL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "AU",
    policy: {
      ...sharedPolicy,
      jurisdiction: "AU",
      timeZone: "Australia/Sydney",
    },
    consent: {
      state: "EXPRESS",
      jurisdiction: "AU",
      purpose: "outreach",
      scope: "standing",
    },
    dncr: { ...sharedDncr, jurisdiction: "AU" },
    now: sameInstant,
  });
  const nz = evaluateConsentDecision({
    channel: "EMAIL",
    purpose: "outreach",
    scope: "standing",
    jurisdiction: "NZ",
    policy: {
      ...sharedPolicy,
      jurisdiction: "NZ",
      timeZone: "Pacific/Auckland",
    },
    consent: {
      state: "EXPRESS",
      jurisdiction: "NZ",
      purpose: "outreach",
      scope: "standing",
    },
    dncr: { ...sharedDncr, jurisdiction: "NZ" },
    now: sameInstant,
  });
  assert.equal(au.decision, "ELIGIBLE");
  assert.equal(au.reasonCode, "EXPRESS_CONSENT_ELIGIBLE");
  assert.equal(nz.decision, "BLOCKED");
  assert.equal(nz.reasonCode, "OUTSIDE_ALLOWED_HOURS");
  assert.equal(au.policyVersion, sharedPolicy.version);
  assert.equal(nz.policyVersion, sharedPolicy.version);
});