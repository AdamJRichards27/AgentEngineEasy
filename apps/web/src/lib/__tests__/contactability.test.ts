// AE GROW Completion W3-A (A-7) — the display rules behind Contact 360's
// contactability panel.
//
// These are the rules that decide what a human is told when AE refuses to
// contact someone. The pilot's normal answer is REVIEW_REQUIRED — no consent
// policy row is approved, so the evaluator's contact window is unset — and
// PHONE_CALL cannot be eligible in AU/NZ at all while Do Not Call Register
// washing has no integration. The assertions below exist to stop that being
// rendered as a bare failure, an unexplained enum, or a fabricated "fine".

import assert from "node:assert/strict";
import test from "node:test";
import {
  GROW_CONSENT_CAPTURABLE_STATES,
  canWithdrawStream,
  captureConsentBody,
  captureConsentError,
  captureConsentWarning,
  channelNotices,
  contactabilityHeadline,
  contactabilityStatusPillClass,
  explainReasonCode,
  hasReasonExplanation,
  historyEntryDetail,
  historyEntryLabel,
  withdrawConsentBody,
  withdrawConsentError,
  type CaptureConsentInput,
  type GrowConsentStreamView,
  type GrowContactability,
  type GrowContactabilityChannel,
} from "../contactability";

/**
 * Every reason code apps/api/src/lib/consentControls.ts can return, copied
 * from GROW_CONSENT_REASON_CODES. If the evaluator gains a code and this list
 * is updated without adding a sentence, the first test below fails — which is
 * the point: a code with no sentence puts a raw enum on a compliance screen.
 */
const ALL_REASON_CODES = [
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
];

function channel(overrides: Partial<GrowContactabilityChannel> = {}): GrowContactabilityChannel {
  return {
    channel: "EMAIL",
    status: "REVIEW_REQUIRED",
    reasonCode: "UNKNOWN_CONSENT",
    decision: {
      recorded: false,
      decision: "REVIEW_REQUIRED",
      reasonCode: "UNKNOWN_CONSENT",
      reasonCodes: ["UNKNOWN_CONSENT"],
      jurisdiction: null,
      policyVersion: null,
      purpose: "EMAIL",
      scope: "OUTBOUND",
      streamRecorded: false,
      evaluatedAt: "2026-09-21T00:00:00.000Z",
    },
    lastRecordedDecision: null,
    consentState: "UNKNOWN",
    consent: null,
    streams: [],
    dncrStatus: "NOT_CHECKED",
    dncr: null,
    suppressed: false,
    suppression: null,
    ...overrides,
  };
}

function stream(overrides: Partial<GrowConsentStreamView> = {}): GrowConsentStreamView {
  return {
    consentId: 41,
    channel: "EMAIL",
    purpose: "MARKETING",
    scope: "BROKERAGE",
    state: "EXPRESS",
    source: "Signed appraisal authority",
    captureMethod: "WRITTEN",
    jurisdiction: "AU",
    capturedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: null,
    reviewAt: null,
    evidenceReference: "authority-4471",
    hasEvidencePayload: false,
    inferredReasoning: null,
    notRequiredJustification: null,
    withdrawnAt: null,
    withdrawnByUserId: null,
    withdrawalReason: null,
    supersedesConsentId: null,
    recordedByUserId: 7,
    recordedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function contactability(overrides: Partial<GrowContactability> = {}): GrowContactability {
  return {
    evaluatedAt: "2026-09-21T00:00:00.000Z",
    status: "REVIEW_REQUIRED",
    statusReasonCode: "UNKNOWN_CONSENT",
    hasConsentRecords: false,
    awaitingPolicyApproval: true,
    policies: [],
    channels: [channel()],
    activeSuppressions: [],
    history: [],
    historyTruncated: false,
    ...overrides,
  };
}

/* ---------------------------------------------------------------------
 * Reason codes.
 * -----------------------------------------------------------------*/

test("every reason code the consent evaluator can return has a plain-English explanation", () => {
  const missing = ALL_REASON_CODES.filter((code) => !hasReasonExplanation(code));
  assert.deepEqual(missing, [], "a reason code with no sentence would render as a bare enum");
  for (const code of ALL_REASON_CODES) {
    const sentence = explainReasonCode(code);
    assert.ok(sentence.length > 20, `${code} needs a real sentence`);
    assert.ok(!sentence.includes(code), `${code}'s explanation must not just restate the code`);
  }
});

test("an unrecognised reason code still produces something a human can read and quote", () => {
  const sentence = explainReasonCode("SOME_FUTURE_CODE");
  assert.ok(sentence.includes("SOME_FUTURE_CODE"), "support needs the code itself");
  assert.ok(sentence.includes("Nothing has been sent."), "and the reader needs to know nothing happened");
});

test("REVIEW_REQUIRED is styled as a warning, never as success", () => {
  assert.equal(contactabilityStatusPillClass("ELIGIBLE"), "pill pill-success");
  assert.equal(contactabilityStatusPillClass("BLOCKED"), "pill pill-danger");
  assert.equal(contactabilityStatusPillClass("REVIEW_REQUIRED"), "pill pill-warning");
  assert.equal(contactabilityStatusPillClass("SOMETHING_NEW"), "pill pill-warning", "an unknown status must not read as cleared");
});

/* ---------------------------------------------------------------------
 * The pilot state, rendered honestly.
 * -----------------------------------------------------------------*/

test("with no approved policy and no consent data, the headline explains the pilot state instead of reporting a failure", () => {
  const headline = contactabilityHeadline(contactability());

  assert.equal(headline.status, "REVIEW_REQUIRED");
  assert.equal(headline.label, "Needs review before contacting");
  // The contact-specific half: nothing on file, and an empty record is not
  // permission.
  assert.ok(headline.detail.includes("Nothing has been recorded"));
  assert.ok(headline.detail.includes("never as 'allowed'"));
  // The system-wide half, kept separate so it doesn't read as this contact's
  // fault.
  assert.ok(headline.pilotNotice !== null);
  assert.ok(headline.pilotNotice!.includes("No consent policy has been approved"));
  assert.ok(headline.pilotNotice!.includes("expected pilot state, not a fault"));
});

test("a policy that exists but defines no contact window is reported as awaiting approval, not as a fault in the record", () => {
  const headline = contactabilityHeadline(
    contactability({
      hasConsentRecords: true,
      statusReasonCode: "POLICY_INVALID_WINDOW",
      awaitingPolicyApproval: true,
      policies: [
        {
          policyVersionId: 3,
          jurisdiction: "AU",
          version: "2026-01",
          effectiveAt: "2026-01-01T00:00:00.000Z",
          retiredAt: null,
          allowInferredConsent: false,
          allowNotRequiredConsent: false,
          dncrRequired: true,
          suppressionEnabled: true,
          timeZone: null,
          allowedHoursStart: null,
          allowedHoursEnd: null,
          quietHoursStart: null,
          quietHoursEnd: null,
          callingWindowConfigured: false,
        },
      ],
    }),
  );

  assert.ok(headline.pilotNotice!.includes("doesn't define a time zone and contact window"));
  assert.ok(headline.pilotNotice!.includes("awaiting AU/NZ legal approval"));
  assert.ok(headline.detail.includes("deliberately unset"), "the detail is the reason code's own sentence");
});

test("once a policy defines a contact window, the pilot notice disappears rather than nagging forever", () => {
  const headline = contactabilityHeadline(contactability({ awaitingPolicyApproval: false, hasConsentRecords: true, statusReasonCode: "EXPRESS_CONSENT_ELIGIBLE", status: "ELIGIBLE" }));
  assert.equal(headline.pilotNotice, null);
  assert.equal(headline.label, "Cleared to contact");
});

/* ---------------------------------------------------------------------
 * Per-channel notices — the fail-closed evaluator only reports its FIRST
 * failing gate, so recorded restrictions behind it still have to be said.
 * -----------------------------------------------------------------*/

test("a phone channel nobody has register-checked says so, because AE has no register integration", () => {
  const notices = channelNotices(channel({ channel: "PHONE_CALL", decision: { ...channel().decision, purpose: "PHONE_CALL" } }));
  assert.ok(notices.some((n) => n.includes("Nobody has checked the Do Not Call Register")));
  assert.ok(notices.some((n) => n.includes("cannot be cleared until a manual check is recorded")));
});

test("a suppression hidden behind an earlier fail-closed reason is still reported", () => {
  const notices = channelNotices(
    channel({
      reasonCode: "UNKNOWN_CONSENT",
      status: "BLOCKED",
      suppressed: true,
      suppression: {
        suppressionId: 9,
        channel: "EMAIL",
        state: "SUPPRESSED",
        reason: "Asked not to be emailed.",
        effectiveAt: "2026-09-01T00:00:00.000Z",
        expiresAt: null,
        reference: null,
        active: true,
        recordedByUserId: 7,
        recordedAt: "2026-09-01T00:00:00.000Z",
      },
    }),
  );
  assert.ok(notices[0].includes("No consent has been recorded"), "the server's own reason comes first");
  assert.ok(notices.some((n) => n === "Also suppressed: Asked not to be emailed."));
});

test("a register listing hidden behind an earlier reason is still reported, and is not repeated when it IS the reason", () => {
  const behind = channelNotices(channel({ reasonCode: "UNKNOWN_CONSENT", dncrStatus: "LISTED" }));
  assert.equal(behind.filter((n) => n.includes("Also listed on the Do Not Call Register")).length, 1);

  const primary = channelNotices(channel({ reasonCode: "DNCR_LISTED", dncrStatus: "LISTED" }));
  assert.equal(primary.filter((n) => n.includes("Also listed")).length, 0);
  assert.ok(primary[0].includes("on the Do Not Call Register"));
});

/* ---------------------------------------------------------------------
 * Withdrawal.
 * -----------------------------------------------------------------*/

test("withdrawal requires a reason, and the form says so rather than letting the request fail", () => {
  assert.ok(withdrawConsentError({ reason: "", source: "Phone call", captureMethod: "VERBAL" })!.includes("withdrawal reason is required"));
  assert.ok(withdrawConsentError({ reason: "   ", source: "Phone call", captureMethod: "VERBAL" }) !== null, "whitespace is not a reason");
  assert.ok(withdrawConsentError({ reason: "x".repeat(1001), source: "Phone call", captureMethod: "VERBAL" }) !== null);
  assert.ok(withdrawConsentError({ reason: "Asked to stop.", source: "", captureMethod: "VERBAL" }) !== null);
  assert.ok(withdrawConsentError({ reason: "Asked to stop.", source: "Phone call", captureMethod: "" }) !== null);
  assert.equal(withdrawConsentError({ reason: "Asked to stop.", source: "Phone call", captureMethod: "VERBAL" }), null);
});

test("a withdrawal supersedes exactly one (channel, purpose, scope) stream and never names its own actor", () => {
  const body = withdrawConsentBody(
    stream({ consentId: 88, channel: "SMS", purpose: "MARKETING", scope: "BROKERAGE", jurisdiction: "AU" }),
    { reason: "  Asked to stop.  ", source: "  Inbound call  ", captureMethod: "VERBAL" },
    new Date("2026-09-21T01:02:03.000Z"),
  );

  assert.deepEqual(body, {
    channel: "SMS",
    state: "WITHDRAWN",
    purpose: "MARKETING",
    scope: "BROKERAGE",
    source: "Inbound call",
    captureMethod: "VERBAL",
    jurisdiction: "AU",
    withdrawnAt: "2026-09-21T01:02:03.000Z",
    withdrawalReason: "Asked to stop.",
    supersedesConsentId: 88,
  });
  // The server takes the actor from the session; a client-supplied one would
  // let a caller attribute a legally significant act to somebody else.
  assert.ok(!("withdrawnByUserId" in body));
});

test("an already-withdrawn stream offers no further action — the no-re-consent rule is not worked around", () => {
  assert.equal(canWithdrawStream(stream({ state: "EXPRESS" })), true);
  assert.equal(canWithdrawStream(stream({ state: "UNKNOWN" })), true);
  assert.equal(canWithdrawStream(stream({ state: "WITHDRAWN" })), false);
});

/* ---------------------------------------------------------------------
 * Capture.
 * -----------------------------------------------------------------*/

const VALID_CAPTURE: CaptureConsentInput = {
  channel: "EMAIL",
  state: "EXPRESS",
  purpose: "MARKETING",
  scope: "BROKERAGE",
  source: "Signed appraisal authority",
  captureMethod: "WRITTEN",
  jurisdiction: "AU",
  evidenceReference: "authority-4471",
  notRequiredJustification: "",
};

test("capture requires a purpose and a scope — consent is never recorded for the contact as a whole", () => {
  assert.equal(captureConsentError(VALID_CAPTURE), null);
  assert.ok(captureConsentError({ ...VALID_CAPTURE, purpose: "  " })!.includes("purpose is required"));
  assert.ok(captureConsentError({ ...VALID_CAPTURE, scope: "" })!.includes("scope is required"));
  assert.ok(captureConsentError({ ...VALID_CAPTURE, source: "" })!.includes("Say where this consent came from"));
  assert.ok(captureConsentError({ ...VALID_CAPTURE, channel: "CARRIER_PIGEON" }) !== null);
});

test("inferred consent is not offered, and \"not required\" cannot be saved without its justification", () => {
  assert.ok(!(GROW_CONSENT_CAPTURABLE_STATES as readonly string[]).includes("INFERRED"));
  assert.ok(captureConsentError({ ...VALID_CAPTURE, state: "INFERRED" }) !== null);
  assert.ok(captureConsentError({ ...VALID_CAPTURE, state: "NOT_REQUIRED" })!.includes("justification"));
  assert.equal(captureConsentError({ ...VALID_CAPTURE, state: "NOT_REQUIRED", notRequiredJustification: "Existing client file." }), null);
});

test("consent without a jurisdiction is allowed but warned about, because no policy can apply to it", () => {
  assert.equal(captureConsentWarning(VALID_CAPTURE), null);
  const warning = captureConsentWarning({ ...VALID_CAPTURE, jurisdiction: "" });
  assert.ok(warning!.includes("stay in review"));
  // A warning, not a block: a truthful record beats no record.
  assert.equal(captureConsentError({ ...VALID_CAPTURE, jurisdiction: "" }), null);
});

test("a capture on a stream that already has a head supersedes it, and omits optional fields it was not given", () => {
  const first = captureConsentBody(VALID_CAPTURE, null);
  assert.equal(first.supersedesConsentId, undefined);
  assert.equal(first.jurisdiction, "AU");
  assert.equal(first.evidenceReference, "authority-4471");
  assert.equal(first.notRequiredJustification, undefined);

  const next = captureConsentBody({ ...VALID_CAPTURE, jurisdiction: "", evidenceReference: "  " }, stream({ consentId: 12 }));
  assert.equal(next.supersedesConsentId, 12);
  assert.equal(next.jurisdiction, undefined, "an unrecorded jurisdiction is omitted, never guessed");
  assert.equal(next.evidenceReference, undefined);
});

/* ---------------------------------------------------------------------
 * Audit history.
 * -----------------------------------------------------------------*/

test("history lines name the record type, the channel and the stream, and show the reason a record exists", () => {
  const withdrawn = {
    kind: "CONSENT" as const,
    id: 2,
    occurredAt: "2026-09-10T00:00:00.000Z",
    ...stream({ state: "WITHDRAWN", withdrawalReason: "Asked to be removed.", supersedesConsentId: 1 }),
  };
  assert.equal(historyEntryLabel(withdrawn), "Email · Withdrawn · MARKETING / BROKERAGE");
  assert.equal(historyEntryDetail(withdrawn), "Asked to be removed.");

  const dncr = {
    kind: "DNCR" as const,
    id: 5,
    occurredAt: "2026-09-11T00:00:00.000Z",
    dncrStatusId: 5,
    channel: "PHONE_CALL",
    status: "LISTED",
    jurisdiction: "AU",
    checkedAt: "2026-09-11T00:00:00.000Z",
    validUntil: null,
    reviewAt: null,
    source: "Manual register check",
    reference: "ref-1",
    recordedByUserId: 7,
    recordedAt: "2026-09-11T00:00:00.000Z",
  };
  assert.equal(historyEntryLabel(dncr), "Phone call · Do Not Call Register: Listed — do not call");
  assert.equal(historyEntryDetail(dncr), "Manual register check · ref-1");

  const released = {
    kind: "SUPPRESSION" as const,
    id: 8,
    occurredAt: "2026-09-12T00:00:00.000Z",
    suppressionId: 8,
    channel: "SMS",
    state: "RELEASED",
    reason: "Contact opted back in by phone.",
    effectiveAt: "2026-09-12T00:00:00.000Z",
    expiresAt: null,
    reference: null,
    active: false,
    recordedByUserId: 7,
    recordedAt: "2026-09-12T00:00:00.000Z",
  };
  assert.equal(historyEntryLabel(released), "SMS · Suppression released");
  assert.equal(historyEntryDetail(released), "Contact opted back in by phone.");
});
