import type { TelephonyDialRequest, TelephonyDialResult, TelephonyProvider } from "./provider.js";

// AE GROW Priority 6 Stage F1 — Call Foundation.
//
// §10 — the ONLY TelephonyProvider implementation F1 constructs. Makes NO
// external network calls, dials NO real number, records NO audio.
// Provider ids are deterministic (derived from the call session's own id,
// which is already globally unique) rather than random, so tests and the
// webhook route below can address a specific sandbox call session
// predictably without needing to capture a randomly generated id first.
//
// Lifecycle transitions (RINGING/CONNECTED/COMPLETED/FAILED) are NOT
// simulated by a timer inside this class — they are driven by explicit,
// signed events posted to POST /grow/calls/webhooks/sandbox (see
// routes/growCallsWebhooks.ts), exactly matching §10's "support
// deterministic webhook/test events" requirement and §15's "implement
// telephony webhook handling only for sandbox/test events in F1". This
// also keeps CI deterministic — no background timers running during the
// test suite.
export function sandboxProviderCallId(callSessionId: number): string {
  return `sandbox_call_${callSessionId}`;
}

export class SandboxTelephonyProvider implements TelephonyProvider {
  readonly name = "sandbox";

  async dial(request: TelephonyDialRequest): Promise<TelephonyDialResult> {
    return { providerCallId: sandboxProviderCallId(request.callSessionId) };
  }
}
