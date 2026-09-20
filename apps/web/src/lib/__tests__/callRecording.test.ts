import assert from "node:assert/strict";
import test from "node:test";
import {
  RECORDING_ENABLED_STATUS,
  RECORDING_NOT_ENABLED_MESSAGE,
  describeRecordingRefusal,
  isRecordingEnabled,
  recordingRefusalDetail,
} from "../callRecording";

// AE GROW Pilot Readiness WP8 — D11: the call panel must say something when
// POST /grow/calls/:id/recording/confirm comes back 200 with recording still
// off (the server's fail-closed outcome), instead of silently re-offering
// "Disclose recording".

// The five-gate shape the session read returns, with every gate passing.
function gates(overrides: Record<string, { passed: boolean; reason: string }> = {}) {
  return {
    gates: {
      entitlement: { passed: true, reason: "ENTITLEMENT_ACTIVE" },
      legalPolicy: { passed: true, reason: "RECORDING_POLICY_ALLOWED" },
      legacyConsentAndDisclosure: { passed: true, reason: "LEGACY_CONSENT_AND_DISCLOSURE_CONFIRMED" },
      adapterCapability: { passed: true, reason: "ADAPTER_RECORDING_CAPABLE" },
      operationalApproval: { passed: true, reason: "OPERATIONAL_RECORDING_APPROVED" },
      ...overrides,
    },
  };
}

test("recording is only 'enabled' in the state the server actually permits it in", () => {
  assert.equal(isRecordingEnabled({ recordingStatus: RECORDING_ENABLED_STATUS }), true);
  assert.equal(isRecordingEnabled({ recordingStatus: "UNRECORDED", recordingPermitted: true }), true);
  assert.equal(isRecordingEnabled({ recordingStatus: "UNRECORDED", recordingPermitted: false }), false);
  for (const recordingStatus of ["UNRECORDED", "DISCLOSURE_REQUIRED", "DISCLOSED", "CONFIRMED", "DECLINED", "DENIED"]) {
    assert.equal(isRecordingEnabled({ recordingStatus }), false, recordingStatus);
  }
  assert.equal(isRecordingEnabled(null), false);
  assert.equal(isRecordingEnabled(undefined), false);
});

test("a confirmation that enabled recording produces no message at all", () => {
  assert.equal(describeRecordingRefusal({ recordingStatus: RECORDING_ENABLED_STATUS, recordingPermitted: true }, gates()), null);
});

test("the default-off operational approval gate (the live smoke failure) is explained in plain words", () => {
  const message = describeRecordingRefusal(
    { recordingStatus: "UNRECORDED", recordingPermitted: false },
    gates({ operationalApproval: { passed: false, reason: "OPERATIONAL_RECORDING_NOT_APPROVED" } }),
  );
  assert.ok(message);
  assert.ok(message.startsWith(RECORDING_NOT_ENABLED_MESSAGE), message);
  assert.ok(message.includes("Brokerage Administrator"), message);
  // The call is never blocked — the agent must be told so explicitly.
  assert.ok(message.includes("The call can continue"), message);
});

test("each recognised gate refusal maps to its own agent-facing sentence", () => {
  const cases: [string, { passed: boolean; reason: string }, string][] = [
    ["legacyConsentAndDisclosure", { passed: false, reason: "LEGACY_RECORDING_CONSENT_INVALID" }, "hasn't given consent"],
    ["legacyConsentAndDisclosure", { passed: false, reason: "IN_CALL_DISCLOSURE_REQUIRED" }, "disclosure hasn't been read"],
    ["legacyConsentAndDisclosure", { passed: false, reason: "IN_CALL_CONFIRMATION_REQUIRED" }, "hasn't confirmed"],
    ["legalPolicy", { passed: false, reason: "RECORDING_POLICY_NOT_CONFIGURED" }, "no approved recording policy"],
    ["legalPolicy", { passed: false, reason: "RECORDING_POLICY_JURISDICTION_MISMATCH" }, "doesn't cover this contact's country"],
    ["legalPolicy", { passed: false, reason: "RECORDING_POLICY_NOT_ALLOWED" }, "isn't allowed for this contact's country"],
    ["entitlement", { passed: false, reason: "ENTITLEMENT_MISSING" }, "brokerage's plan"],
    ["adapterCapability", { passed: false, reason: "ADAPTER_RECORDING_UNAVAILABLE" }, "phone system"],
  ];
  for (const [key, gate, expected] of cases) {
    const detail = recordingRefusalDetail(gates({ [key]: gate }));
    assert.ok(detail, `${gate.reason} produced no detail`);
    assert.ok(detail.includes(expected), `${gate.reason} -> ${detail}`);
  }
});

test("when several gates deny, the one the agent can act on is named first", () => {
  const detail = recordingRefusalDetail(
    gates({
      legacyConsentAndDisclosure: { passed: false, reason: "LEGACY_RECORDING_CONSENT_INVALID" },
      operationalApproval: { passed: false, reason: "OPERATIONAL_RECORDING_NOT_APPROVED" },
      entitlement: { passed: false, reason: "ENTITLEMENT_MISSING" },
    }),
  );
  assert.equal(detail, "This contact hasn't given consent to be recorded.");
});

test("an unrecognised reason code never leaks — the headline is shown on its own", () => {
  const message = describeRecordingRefusal(
    { recordingStatus: "UNRECORDED", recordingPermitted: false },
    gates({ legalPolicy: { passed: false, reason: "SOME_NEW_INTERNAL_CODE_v2" } }),
  );
  assert.equal(message, RECORDING_NOT_ENABLED_MESSAGE);
  assert.ok(!message.includes("SOME_NEW_INTERNAL_CODE_v2"));
  assert.ok(!message.includes("_"));
});

test("a refusal with no gate result available still says recording is off", () => {
  const session = { recordingStatus: "UNRECORDED", recordingPermitted: false };
  assert.equal(describeRecordingRefusal(session, null), RECORDING_NOT_ENABLED_MESSAGE);
  assert.equal(describeRecordingRefusal(session, undefined), RECORDING_NOT_ENABLED_MESSAGE);
  assert.equal(describeRecordingRefusal(session, { gates: {} }), RECORDING_NOT_ENABLED_MESSAGE);
  assert.equal(recordingRefusalDetail(null), undefined);
  assert.equal(recordingRefusalDetail(gates()), undefined, "nothing failed, so nothing to explain");
});

test("an unknown gate key that fails is still explained if its reason is recognised", () => {
  // Forward-compatibility: a sixth gate added server-side must not be skipped
  // just because it is not in the priority list.
  const detail = recordingRefusalDetail({
    gates: { somethingNew: { passed: false, reason: "ENTITLEMENT_MISSING" } },
  });
  assert.equal(detail, "Call recording isn't part of this brokerage's plan.");
});
