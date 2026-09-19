import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  isLiveCallTranscriptionApproved,
  mustForceMockCallTranscriptionProvider,
} from "../../env.js";
import {
  CALL_TRANSCRIPTION_FAILURE_REASONS,
  CALL_TRANSCRIPTION_MAX_RETRIES,
  classifyCallTranscriptionFailure,
  isRetryableCallTranscriptionFailure,
} from "../callTranscriptionPolicy.js";

const approvalKeys = [
  "LIVE_CALL_TRANSCRIPTION_APPROVED",
  "LIVE_VOICE_TRANSCRIPTION_APPROVED",
  "LIVE_TELEPHONY_APPROVED",
] as const;
const savedApprovals = new Map(approvalKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of approvalKeys) {
    const value = savedApprovals.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("LIVE_CALL_TRANSCRIPTION_APPROVED defaults false and is independent of voice and telephony approvals", () => {
  delete process.env.LIVE_CALL_TRANSCRIPTION_APPROVED;
  process.env.LIVE_VOICE_TRANSCRIPTION_APPROVED = "true";
  process.env.LIVE_TELEPHONY_APPROVED = "true";

  assert.equal(isLiveCallTranscriptionApproved(), false);
  assert.equal(mustForceMockCallTranscriptionProvider(), true);

  for (const nonApproval of ["false", "TRUE", "1", "yes", " true"]) {
    process.env.LIVE_CALL_TRANSCRIPTION_APPROVED = nonApproval;
    assert.equal(isLiveCallTranscriptionApproved(), false, `${JSON.stringify(nonApproval)} must remain locked`);
    assert.equal(mustForceMockCallTranscriptionProvider(), true);
  }

  process.env.LIVE_CALL_TRANSCRIPTION_APPROVED = "true";
  delete process.env.LIVE_VOICE_TRANSCRIPTION_APPROVED;
  delete process.env.LIVE_TELEPHONY_APPROVED;
  assert.equal(isLiveCallTranscriptionApproved(), true);
  assert.equal(mustForceMockCallTranscriptionProvider(), false);
});

test("documented failureReason vocabulary is exact and only three terminal reasons consume the bounded retry budget", () => {
  assert.deepEqual(CALL_TRANSCRIPTION_FAILURE_REASONS, [
    "RECORDING_UNAVAILABLE",
    "RECORDING_DELETED",
    "TRANSCRIPTION_TIMEOUT",
    "PROVIDER_ERROR",
    "MALFORMED_PROVIDER_RESPONSE",
    "PROCESSING_ABANDONED",
    "TENANT_MISMATCH",
    "ACCESS_DENIED",
    "ENTITLEMENT_REQUIRED",
    "INVALID_INPUT",
    "RECORDING_REFERENCE_MISMATCH",
    "F2_EVIDENCE_MISSING",
    "F2_EVIDENCE_INVALID",
    "CONSENT_WITHDRAWN",
    "LIVE_PROVIDER_DISABLED",
    "MISSING_PROVIDER_CREDENTIALS",
    "PROVIDER_CONFIGURATION_ERROR",
    "INVALID_AUDIO",
    "AUDIT_FAILURE",
  ]);
  assert.equal(CALL_TRANSCRIPTION_MAX_RETRIES, 3);
  assert.deepEqual(
    CALL_TRANSCRIPTION_FAILURE_REASONS.filter(isRetryableCallTranscriptionFailure),
    ["TRANSCRIPTION_TIMEOUT", "PROVIDER_ERROR", "MALFORMED_PROVIDER_RESPONSE"],
  );
});

test("provider failure classification reaches every provider-origin terminal failureReason", () => {
  const cases: Array<[unknown, string]> = [
    [{ name: "AbortError" }, "TRANSCRIPTION_TIMEOUT"],
    [{ code: "malformed_response" }, "MALFORMED_PROVIDER_RESPONSE"],
    [{ code: "live_provider_disabled" }, "LIVE_PROVIDER_DISABLED"],
    [{ code: "missing_credentials" }, "MISSING_PROVIDER_CREDENTIALS"],
    [{ code: "unsupported_audio_type" }, "INVALID_AUDIO"],
    [new Error("Unknown transcription provider: synthetic-unknown"), "PROVIDER_CONFIGURATION_ERROR"],
    [new Error("opaque provider outage"), "PROVIDER_ERROR"],
  ];
  for (const [error, expected] of cases) {
    assert.equal(classifyCallTranscriptionFailure(error), expected);
  }
});
