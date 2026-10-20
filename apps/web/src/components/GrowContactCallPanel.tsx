// Contact 360 call panel (moved verbatim from pages/Grow.tsx, Contact 360 PR3). No behaviour change.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";
import { describeRecordingRefusal } from "../lib/callRecording";
import { growErrorMessage } from "../lib/growErrors";
import { recordingGateName, sandboxCallStatusLabel, TERMINAL_CALL_STATUSES } from "../lib/growCall";
import type { GrowCallEligibility, GrowCallFiveGateResult, GrowCallSession, GrowCallSessionRead } from "../lib/growCall";

function RecordingGateReasons({ result }: { result: GrowCallFiveGateResult }) {
  return (
    <ul className="grow-call-gates">
      {Object.entries(result.gates).map(([key, gate]) => (
        <li key={key}>
          <div>
            <strong>{recordingGateName(key)}</strong>
            <div className="muted">{gate.humanReason}</div>
          </div>
          <span className={gate.passed ? "text-success" : "muted"}>{gate.passed ? "Passed" : "Not passed"}</span>
        </li>
      ))}
    </ul>
  );
}

export function GrowContactCallPanel({ partyId, contactName }: { partyId: number; contactName: string }) {
  const queryClient = useQueryClient();
  const [recordingRequested, setRecordingRequested] = useState(false);
  const [assumedCountry, setAssumedCountry] = useState<"" | "AU" | "NZ">("");
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [sessionFromMutation, setSessionFromMutation] = useState<GrowCallSession | null>(null);

  const eligibility = useQuery<GrowCallEligibility>({
    queryKey: ["grow-call-eligibility", partyId, assumedCountry],
    queryFn: () =>
      apiFetch(
        `/grow/calls/contacts/${partyId}/eligibility${assumedCountry ? `?assumedCountry=${assumedCountry}` : ""}`,
      ),
  });

  const session = useQuery<GrowCallSessionRead>({
    queryKey: ["grow-call-session", activeSessionId],
    queryFn: () => apiFetch(`/grow/calls/${activeSessionId}`),
    enabled: activeSessionId !== null,
    refetchInterval: (query) => {
      const currentStatus = query.state.data?.callSession.status;
      return activeSessionId !== null && (!currentStatus || !TERMINAL_CALL_STATUSES.has(currentStatus)) ? 3000 : false;
    },
  });

  function refreshSession(sessionId: number) {
    queryClient.invalidateQueries({ queryKey: ["grow-call-session", sessionId] });
  }

  const createCall = useMutation<{ callSession: GrowCallSession }, unknown, void>({
    mutationFn: () =>
      apiFetch("/grow/calls", {
        method: "POST",
        body: JSON.stringify({
          partyId,
          ...(assumedCountry ? { assumedCountry } : {}),
          recordingRequested,
        }),
      }),
    onSuccess: (result) => {
      setActiveSessionId(result.callSession.id);
      setSessionFromMutation(result.callSession);
    },
  });

  const confirmCall = useMutation<{ callSession: GrowCallSession }, unknown, number>({
    mutationFn: (sessionId) => apiFetch(`/grow/calls/${sessionId}/confirm`, { method: "POST" }),
    onSuccess: (result, sessionId) => {
      setSessionFromMutation(result.callSession);
      refreshSession(sessionId);
    },
  });

  const cancelCall = useMutation<{ callSession: GrowCallSession }, unknown, number>({
    mutationFn: (sessionId) =>
      apiFetch(`/grow/calls/${sessionId}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: "Cancelled from Contact 360." }),
      }),
    onSuccess: (result, sessionId) => {
      setSessionFromMutation(result.callSession);
      refreshSession(sessionId);
    },
  });

  // AE GROW Pilot Readiness WP8 — D11. This route answers 200 whether or not
  // recording was actually enabled: the server records the attestation,
  // re-evaluates the five recording gates and settles on either
  // PERMITTED_NOT_CAPTURED (on) or UNRECORDED (refused), because a denied gate
  // must never fail the call itself. The refusal therefore never reaches the
  // mutationError path below, which is why the panel used to drop straight
  // back to "Disclose recording" with nothing said. `.data` is kept and read
  // back out via describeRecordingRefusal() at render time.
  const confirmRecording = useMutation<{ callSession: GrowCallSession }, unknown, number>({
    mutationFn: (sessionId) => apiFetch(`/grow/calls/${sessionId}/recording/confirm`, { method: "POST" }),
    onSuccess: (result, sessionId) => {
      setSessionFromMutation(result.callSession);
      refreshSession(sessionId);
    },
  });

  const discloseRecording = useMutation<{ callSession: GrowCallSession }, unknown, number>({
    mutationFn: (sessionId) => apiFetch(`/grow/calls/${sessionId}/recording/disclosure`, { method: "POST" }),
    // A fresh disclosure starts a new recording attempt, so the previous
    // attempt's refusal message must not linger over it.
    onMutate: () => confirmRecording.reset(),
    onSuccess: (result, sessionId) => {
      setSessionFromMutation(result.callSession);
      refreshSession(sessionId);
    },
  });

  const declineRecording = useMutation<{ callSession: GrowCallSession }, unknown, number>({
    mutationFn: (sessionId) => apiFetch(`/grow/calls/${sessionId}/recording/decline`, { method: "POST" }),
    // Declining settles the recording question outright — an earlier refusal
    // is no longer the reason recording is off.
    onMutate: () => confirmRecording.reset(),
    onSuccess: (result, sessionId) => {
      setSessionFromMutation(result.callSession);
      refreshSession(sessionId);
    },
  });

  const activeSession = session.data?.callSession ?? sessionFromMutation;
  const recordingPresentation = session.data?.recording;
  // Present only after a confirmation attempt that came back with recording
  // still off. The gate result comes from the session read refreshed by that
  // same attempt, so the reason shown is the post-confirmation one (the
  // in-call disclosure/confirmation gates have already been satisfied by
  // then), not the stale pre-confirmation evaluation.
  const recordingRefusal = describeRecordingRefusal(
    confirmRecording.data?.callSession ?? null,
    recordingPresentation?.fiveGateResult ?? null,
  );
  const mutationError =
    createCall.error ??
    confirmCall.error ??
    cancelCall.error ??
    discloseRecording.error ??
    confirmRecording.error ??
    declineRecording.error;
  const isMutating =
    createCall.isPending ||
    confirmCall.isPending ||
    cancelCall.isPending ||
    discloseRecording.isPending ||
    confirmRecording.isPending ||
    declineRecording.isPending;
  const eligibilityStatus = eligibility.data?.status;
  const statusPillClass =
    eligibilityStatus === "Ready to call" ? "pill-success" : eligibilityStatus ? "pill-warning" : "";

  function startAnotherSandboxCall() {
    setActiveSessionId(null);
    setSessionFromMutation(null);
    setRecordingRequested(false);
    setAssumedCountry("");
    createCall.reset();
    confirmCall.reset();
    cancelCall.reset();
    discloseRecording.reset();
    confirmRecording.reset();
    declineRecording.reset();
  }

  return (
    <section className="card grow-call-panel">
      <div className="grow-call-panel-header">
        <div>
          <h2>Call {contactName}</h2>
          <p className="muted">Sandbox only — no live call is placed.</p>
        </div>
        {!activeSession && eligibilityStatus && <span className={`pill ${statusPillClass}`}>{eligibilityStatus}</span>}
      </div>

      {eligibility.isLoading && <p className="muted">Checking call eligibility…</p>}
      {eligibility.isError && (
        <p className="error-text">
          {growErrorMessage(eligibility.error, "Call eligibility could not be loaded. Refresh and try again.")}
        </p>
      )}
      {eligibility.data && !activeSession && (
        <>
          <p className="muted">
            {eligibility.data.displayNumber ? `Number on file: ${eligibility.data.displayNumber}` : "No callable phone number on file."}
          </p>
          <p className="muted">
            Recording: <strong>{eligibility.data.recording.status}</strong>. {eligibility.data.recording.reason}
          </p>
          <RecordingGateReasons result={eligibility.data.recording.fiveGateResult} />
          {eligibility.data.requiresCountryConfirmation && (
            <label className="grow-call-country">
              Phone country
              <select value={assumedCountry} onChange={(event) => setAssumedCountry(event.target.value as "" | "AU" | "NZ")} disabled={isMutating}>
                <option value="">Select country</option>
                <option value="AU">Australia (AU)</option>
                <option value="NZ">New Zealand (NZ)</option>
              </select>
              <span className="muted">The server will re-validate the selected country and consent before preparing the call.</span>
            </label>
          )}
          {eligibility.data.eligible && (
            <label className="grow-call-recording-request">
              <input
                type="checkbox"
                checked={recordingRequested}
                onChange={(event) => setRecordingRequested(event.target.checked)}
                disabled={isMutating}
              />{" "}
              Request recording (the server re-checks this in-call)
            </label>
          )}
          <div className="grow-call-actions">
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={!eligibility.data.eligible || (eligibility.data.requiresCountryConfirmation && !assumedCountry) || isMutating}
              onClick={() => createCall.mutate()}
            >
              {createCall.isPending ? "Preparing…" : "Call"}
            </button>
          </div>
        </>
      )}

      {activeSession && (
        <div className="grow-call-session">
          <div className="grow-call-session-header">
            <div>
              <div className="eyebrow">Call status</div>
              <strong>{sandboxCallStatusLabel(activeSession.status)}</strong>
            </div>
            <span className="pill">{activeSession.provider === "sandbox" ? "Sandbox" : activeSession.provider}</span>
          </div>
          <p className="muted">
            Number prepared by the server: {activeSession.destinationNormalized}
          </p>
          {activeSession.status === "READY" && (
            <p className="muted">
              Confirm to request the sandbox dial. The number is checked again by the server before dialling.
            </p>
          )}
          {activeSession.status === "DIAL_REQUESTED" || activeSession.status === "RINGING" ? (
            <p className="muted">Sandbox lifecycle updates appear here when the server receives them; no live connection is promised.</p>
          ) : null}
          {activeSession.status === "CONNECTED" && <p className="muted">The sandbox reports this call as connected.</p>}
          {activeSession.status === "FAILED" && activeSession.failureReason && <p className="error-text">{activeSession.failureReason}</p>}
          {activeSession.status === "CANCELLED" && activeSession.cancelledReason && <p className="muted">{activeSession.cancelledReason}</p>}
          {activeSession.status === "COMPLETED" && activeSession.durationSeconds !== null && (
            <p className="muted">Sandbox duration: {activeSession.durationSeconds}s</p>
          )}

          {session.isLoading && <p className="muted">Refreshing call status…</p>}
          {session.isError && (
            <p className="error-text">
              {growErrorMessage(session.error, "Call status could not be refreshed. Try again.")}
            </p>
          )}
          {activeSession.status === "READY" && (
            <div className="grow-call-actions">
              <button
                type="button"
                className="btn btn-primary btn-small"
                disabled={isMutating}
                onClick={() => confirmCall.mutate(activeSession.id)}
              >
                {confirmCall.isPending ? "Confirming…" : "Confirm Call"}
              </button>
              <button type="button" className="btn btn-secondary btn-small" disabled={isMutating} onClick={() => cancelCall.mutate(activeSession.id)}>
                Cancel
              </button>
            </div>
          )}

          <div className="grow-call-recording">
            <div className="eyebrow">Recording decision</div>
            {!recordingPresentation && session.isLoading && <p className="muted">Checking the server recording gates…</p>}
            {/* AE GROW Pilot Readiness WP8 (D11) — a confirmation the server
                accepted but which did not turn recording on. Rendered outside
                the recordingPresentation block below so it still appears if the
                follow-up session read is slow or fails, and styled as a notice
                rather than an error: the call itself is unaffected. */}
            {recordingRefusal && (
              <p className="grow-call-recording-notice" role="status">
                {recordingRefusal}
              </p>
            )}
            {recordingPresentation && (
              <>
                <p>
                  <strong>{recordingPresentation.status}</strong>
                  <span className="muted"> · {recordingPresentation.provider} provider</span>
                </p>
                <RecordingGateReasons result={recordingPresentation.fiveGateResult} />
                {activeSession.status === "CONNECTED" && activeSession.recordingRequested && (
                  <div className="grow-call-actions">
                    {(recordingPresentation.statusCode === "DISCLOSURE_REQUIRED" ||
                      recordingPresentation.statusCode === "UNRECORDED") && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={isMutating}
                        onClick={() => discloseRecording.mutate(activeSession.id)}
                      >
                        {discloseRecording.isPending ? "Saving disclosure…" : "Disclose recording"}
                      </button>
                    )}
                    {recordingPresentation.statusCode === "DISCLOSED" && (
                      <>
                        <button
                          type="button"
                          className="btn btn-primary btn-small"
                          disabled={isMutating}
                          onClick={() => confirmRecording.mutate(activeSession.id)}
                        >
                          {confirmRecording.isPending ? "Checking gates…" : "Confirm recording"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          disabled={isMutating}
                          onClick={() => declineRecording.mutate(activeSession.id)}
                        >
                          {declineRecording.isPending ? "Saving…" : "Decline recording"}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {mutationError ? (
            <p className="error-text">{growErrorMessage(mutationError, "The server did not apply that call action. Refresh and try again.")}</p>
          ) : null}
          {TERMINAL_CALL_STATUSES.has(activeSession.status) && (
            <button type="button" className="btn btn-link btn-small" onClick={startAnotherSandboxCall}>
              Start another sandbox call
            </button>
          )}
        </div>
      )}
    </section>
  );
}
