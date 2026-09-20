// AE GROW Pilot Readiness WP8 — D11: recording confirmation must never fail
// closed silently.
//
// POST /grow/calls/:id/recording/confirm (apps/api/src/routes/growCalls.ts)
// answers 200 whether or not recording was actually enabled: the service
// (apps/api/src/lib/telephony/callSessions.ts confirmInCallRecording) records
// the agent's attestation, re-evaluates all five recording gates, and then
// settles the session on "PERMITTED_NOT_CAPTURED" (recording on) or
// "UNRECORDED" (recording refused). That is deliberate — the product rule is
// that a call is never blocked, only recording is — but it means a refusal is
// a *successful* HTTP response, so the panel's existing error path (which only
// renders ApiError.friendly) showed nothing at all and the agent was silently
// dropped back to "Disclose recording".
//
// This module turns that settled state plus the five-gate result the session
// read already returns into one short sentence an agent can act on. It is
// pure and dependency-free so it can be unit tested with `tsx --test` like
// every other lib/ module here.

// The recording state machine's "recording is on" state. Everything else
// ("UNRECORDED", "DISCLOSED", "DECLINED", "DENIED", …) means it is not.
export const RECORDING_ENABLED_STATUS = "PERMITTED_NOT_CAPTURED";

export interface RecordingSessionState {
  recordingStatus: string;
  recordingPermitted?: boolean;
}

export interface RecordingGateView {
  passed: boolean;
  reason: string;
}

export interface RecordingGateResultView {
  gates: Record<string, RecordingGateView>;
}

export function isRecordingEnabled(session: RecordingSessionState | null | undefined): boolean {
  if (!session) return false;
  return session.recordingStatus === RECORDING_ENABLED_STATUS || session.recordingPermitted === true;
}

// The headline. Deliberately reassuring about the call itself: an agent who
// sees "recording could not be enabled" mid-call must not think the call is
// in jeopardy, because it never is (see the module header).
export const RECORDING_NOT_ENABLED_MESSAGE =
  "Recording couldn't be turned on for this call. The call can continue as normal — it just won't be recorded.";

// The gate reason codes (apps/api/src/lib/telephony/recordingGates.ts) that
// mean something an agent can understand or act on, in plain words. Only
// failures are mapped: a code with no entry here is an internal detail and is
// never shown — the headline alone is used instead, and the per-gate list the
// panel already renders carries the server's own humanReason text.
const REFUSAL_DETAIL_BY_REASON: Readonly<Record<string, string>> = {
  LEGACY_RECORDING_CONSENT_INVALID: "This contact hasn't given consent to be recorded.",
  IN_CALL_DISCLOSURE_REQUIRED: "The recording disclosure hasn't been read out on this call yet.",
  IN_CALL_CONFIRMATION_REQUIRED: "The contact hasn't confirmed they're happy to be recorded.",
  RECORDING_POLICY_NOT_CONFIGURED: "There's no approved recording policy for this contact's country.",
  RECORDING_POLICY_JURISDICTION_MISMATCH: "The approved recording policy doesn't cover this contact's country.",
  RECORDING_POLICY_NOT_ALLOWED: "Recording isn't allowed for this contact's country.",
  ENTITLEMENT_MISSING: "Call recording isn't part of this brokerage's plan.",
  ADAPTER_RECORDING_UNAVAILABLE: "The phone system used for this call can't record.",
  OPERATIONAL_RECORDING_NOT_APPROVED:
    "Recording hasn't been switched on for your brokerage yet — a Brokerage Administrator can arrange it.",
};

// Which failing gate to name when more than one denies. Ordered by what an
// agent can actually do next rather than by the server's evaluation order:
// the contact's own consent and the in-call steps come first (the agent owns
// those), then the legal policy and plan, then the two purely operational
// gates nobody on the call can change.
const REFUSAL_GATE_PRIORITY: readonly string[] = [
  "legacyConsentAndDisclosure",
  "legalPolicy",
  "entitlement",
  "adapterCapability",
  "operationalApproval",
];

// The plain sentence for the highest-priority failing gate whose reason maps
// to agent-facing copy, or undefined when nothing maps (an unrecognised or
// newly-added reason code must degrade to the headline, never leak).
export function recordingRefusalDetail(result: RecordingGateResultView | null | undefined): string | undefined {
  const gates = result?.gates;
  if (!gates) return undefined;
  const keys = [...REFUSAL_GATE_PRIORITY, ...Object.keys(gates).filter((key) => !REFUSAL_GATE_PRIORITY.includes(key))];
  for (const key of keys) {
    const gate = gates[key];
    if (!gate || gate.passed) continue;
    const detail = REFUSAL_DETAIL_BY_REASON[gate.reason];
    if (detail) return detail;
  }
  return undefined;
}

// The whole message to show on the call panel after a confirmation attempt
// came back without recording enabled, or null when recording IS enabled (the
// caller renders nothing in that case).
export function describeRecordingRefusal(
  session: RecordingSessionState | null | undefined,
  result: RecordingGateResultView | null | undefined,
): string | null {
  if (!session || isRecordingEnabled(session)) return null;
  const detail = recordingRefusalDetail(result);
  return detail ? `${RECORDING_NOT_ENABLED_MESSAGE} ${detail}` : RECORDING_NOT_ENABLED_MESSAGE;
}
