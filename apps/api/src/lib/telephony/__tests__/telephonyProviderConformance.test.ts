// AE GROW W3-B — telephony conformance run.
//
// Proves the contract in telephonyProviderConformance.ts against the shipped
// SandboxTelephonyProvider, and then against a candidate adapter that did not
// exist when the contract was written — the same demonstration the
// communications suite makes, for the same reason: a conformance contract is
// only worth having if running it against a new adapter costs one subject
// literal and no product-code change.
//
// The candidate below is an in-memory object defined in this test file. It
// dials nothing, records nothing, and has no credential or vendor SDK. No
// live telephony provider is activated or made activatable here;
// LIVE_TELEPHONY_APPROVED is untouched and still gates any real adapter that
// might one day exist.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runTelephonyProviderConformance } from "./telephonyProviderConformance.js";
import { SandboxTelephonyProvider, sandboxProviderCallId } from "../sandboxProvider.js";
import { TelephonyProviderError, type TelephonyDialRequest, type TelephonyDialResult, type TelephonyProvider } from "../provider.js";

const sandbox = new SandboxTelephonyProvider();

runTelephonyProviderConformance({
  label: "sandbox",
  provider: sandbox,
});

test("sandbox telephony adapter derives its provider call id from this app's own session id", () => {
  // Why the sandbox satisfies clause 3 for free, stated explicitly so a
  // future adapter author sees what they must reproduce by other means: the
  // id is a pure function of a value this app already made globally unique,
  // so idempotency needs no provider-side state.
  assert.equal(sandboxProviderCallId(77), "sandbox_call_77");
});

test("sandbox telephony adapter claims neither recording nor transcription", () => {
  assert.equal(sandbox.capabilities.recording, false);
  assert.equal(sandbox.capabilities.transcription, false);
});

// ---------------------------------------------------------------------------
// A candidate adapter the contract has never seen.
// ---------------------------------------------------------------------------

const CANDIDATE_UNROUTABLE_SESSION = 9_001;

class CandidateTelephonyProvider implements TelephonyProvider {
  readonly name = "candidate_telephony";
  // Deliberately claims BOTH capabilities, so the harness's clause-2 check
  // exercises the case that matters: an adapter asserting it can record must
  // still not be able to cause a recording on its own.
  readonly capabilities = { recording: true, transcription: true } as const;

  private readonly placed = new Map<number, string>();

  async dial(request: TelephonyDialRequest): Promise<TelephonyDialResult> {
    if (request.callSessionId === CANDIDATE_UNROUTABLE_SESSION) {
      throw new TelephonyProviderError(this.name, "provider_error", "Candidate vendor reported an unroutable destination.");
    }
    // Provider-side idempotency by call session, the property clause 3 asks
    // a real vendor for.
    const existing = this.placed.get(request.callSessionId);
    if (existing) return { providerCallId: existing };
    const providerCallId = `candidate_call_${request.callSessionId}`;
    this.placed.set(request.callSessionId, providerCallId);
    return { providerCallId };
  }
}

runTelephonyProviderConformance({
  label: "candidate_telephony",
  provider: new CandidateTelephonyProvider(),
  refusal: {
    label: "unroutable destination",
    callSessionId: CANDIDATE_UNROUTABLE_SESSION,
    expectedCode: "provider_error",
  },
  normalizeWebhook: (payload) => ({
    providerCallId: String(payload.providerCallId ?? ""),
    eventType: String(payload.event ?? ""),
  }),
});
