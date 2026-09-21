import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../lib/api";
import { useEntitlements } from "../lib/session";
import {
  GROW_CONSENT_CAPTURABLE_STATES,
  GROW_CONSENT_CAPTURE_METHODS,
  GROW_CONSENT_CHANNELS,
  canWithdrawStream,
  captureConsentBody,
  captureConsentError,
  captureConsentWarning,
  channelLabel,
  channelNotices,
  consentStateLabel,
  contactabilityHeadline,
  contactabilityStatusLabel,
  contactabilityStatusPillClass,
  dncrStatusLabel,
  historyEntryDetail,
  historyEntryLabel,
  withdrawConsentBody,
  withdrawConsentError,
  type CaptureConsentInput,
  type GrowConsentStreamView,
  type GrowContactability,
  type WithdrawConsentInput,
} from "../lib/contactability";

// AE GROW Completion W3-A (A-7) — Contact 360's contactability and consent
// panel.
//
// WHY THIS IS ITS OWN COMPONENT. pages/Grow.tsx is already ~2,200 lines and is
// simultaneously the Daily Command Centre, Contact 360 and the call panel.
// Extracting this surface rather than growing that file further is the
// explicit mitigation recorded in the roadmap for this slice, and it is why
// this panel takes the block it renders as a prop: GET /grow/contacts/:partyId
// already carries it, so Contact 360 stays one request rather than becoming
// two.
//
// WHAT THIS PANEL IS. Before it, AE had no consent management UI anywhere. The
// engine was complete — five append-only tables, a fail-closed evaluator with
// 28 reason codes, and, since PR #52, HTTP writers — and the only related
// things that rendered were a read-only "Do not contact." notice on Grow Today
// cards, a BLOCKED_BY_CONSENT status label, and the call panel's separate
// recording-consent controls. A human could not see, let alone use, any of it.
//
// WHAT IT DELIBERATELY DOES NOT DO.
//
//   * It does not decide anything. Every status, reason code and channel state
//     below is the server's answer, rendered. hasEntitlement() gates what is
//     OFFERED, and this repository documents that as a UX signal only — the
//     entitlement middleware on each route is the authority, and a user who
//     gets past this UI still gets a 403.
//
//   * It does not fabricate an eligible state. No consent policy row is
//     approved, so the evaluator returns REVIEW_REQUIRED for essentially
//     everything and PHONE_CALL cannot be eligible in AU/NZ at all while
//     Do Not Call Register washing has no integration. The panel explains that
//     (see lib/contactability.ts's reason-code sentences and the pilot notice)
//     instead of showing a bare failure or pretending otherwise.
//
//   * It does not implement contact-wide withdrawal. Withdrawal here supersedes
//     ONE (channel, purpose, scope) head stream, exactly as the model does;
//     whether it should apply across a whole contact is an open Project Owner
//     decision and is not pre-empted here.
//
//   * It does not work around the re-consent guard. A withdrawn stream offers
//     no further action, because consentControlsPersistence.ts deliberately
//     refuses to append after a WITHDRAWN head and that refusal is correct.
//
//   * It does not touch recording consent, which already has its own working
//     surface on the call panel, and does not try to reconcile the three
//     consent models in this codebase — that is a later slice.

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDay(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function actionError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.friendly;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

const EMPTY_CAPTURE: CaptureConsentInput = {
  channel: "EMAIL",
  state: "EXPRESS",
  purpose: "",
  scope: "",
  source: "",
  captureMethod: "WRITTEN",
  jurisdiction: "AU",
  evidenceReference: "",
  notRequiredJustification: "",
};

const EMPTY_WITHDRAWAL: WithdrawConsentInput = { reason: "", source: "", captureMethod: "VERBAL" };

export function GrowContactConsentPanel({
  partyId,
  contactability,
  onChanged,
}: {
  partyId: number;
  contactability: GrowContactability;
  /** Refetch Contact 360. The panel never mutates its own copy of the block. */
  onChanged: () => void;
}) {
  const { hasEntitlement } = useEntitlements();
  const canManage = hasEntitlement("grow.contacts.manage");

  const [showCapture, setShowCapture] = useState(false);
  const [capture, setCapture] = useState<CaptureConsentInput>(EMPTY_CAPTURE);
  const [withdrawingConsentId, setWithdrawingConsentId] = useState<number | null>(null);
  const [withdrawal, setWithdrawal] = useState<WithdrawConsentInput>(EMPTY_WITHDRAWAL);
  const [showHistory, setShowHistory] = useState(false);

  const post = (body: unknown) =>
    apiFetch(`/grow/contacts/${partyId}/consent`, { method: "POST", body: JSON.stringify(body) });

  const captureConsent = useMutation({
    mutationFn: (body: unknown) => post(body),
    onSuccess: () => {
      setShowCapture(false);
      setCapture(EMPTY_CAPTURE);
      onChanged();
    },
  });

  const withdrawConsent = useMutation({
    mutationFn: (body: unknown) => post(body),
    onSuccess: () => {
      setWithdrawingConsentId(null);
      setWithdrawal(EMPTY_WITHDRAWAL);
      onChanged();
    },
  });

  const headline = contactabilityHeadline(contactability);
  const captureValidation = captureConsentError(capture);
  const captureAdvice = captureConsentWarning(capture);
  const withdrawalValidation = withdrawConsentError(withdrawal);

  // Every append after the first on a (channel, purpose, scope) stream must
  // supersede that stream's head, so the form resolves it from what is already
  // on screen rather than asking the agent for an id.
  const captureHead =
    contactability.channels
      .find((c) => c.channel === capture.channel)
      ?.streams.find((s) => s.purpose === capture.purpose.trim() && s.scope === capture.scope.trim()) ?? null;
  const captureHeadWithdrawn = captureHead?.state === "WITHDRAWN";

  const withdrawingStream: GrowConsentStreamView | null =
    withdrawingConsentId === null
      ? null
      : contactability.channels.flatMap((c) => c.streams).find((s) => s.consentId === withdrawingConsentId) ?? null;

  return (
    <section className="card">
      <h2>Contactability &amp; consent</h2>
      <p className="muted">
        What AE has recorded about reaching this contact — consent, the Do Not Call Register, and any suppression. Every
        record below is append-only: nothing is edited or deleted, and a later record supersedes an earlier one.
      </p>

      <p>
        <span className={contactabilityStatusPillClass(headline.status)}>{headline.label}</span>
      </p>
      <p>{headline.detail}</p>
      {headline.pilotNotice && <p className="muted">{headline.pilotNotice}</p>}
      <p className="muted">Evaluated {formatWhen(contactability.evaluatedAt)}. Viewing this screen does not record a decision.</p>

      {/* ------------------------------------------------------------
          Per-channel state.
          ----------------------------------------------------------*/}
      <ul className="item-list">
        {contactability.channels.map((channel) => {
          const notices = channelNotices(channel);
          return (
            <li key={channel.channel}>
              <div>
                <strong>{channelLabel(channel.channel)}</strong>{" "}
                <span className={contactabilityStatusPillClass(channel.status)}>{contactabilityStatusLabel(channel.status)}</span>
              </div>
              <p className="muted">
                Consent: {consentStateLabel(channel.consentState)} · Do Not Call Register: {dncrStatusLabel(channel.dncrStatus)} ·{" "}
                {channel.suppressed ? "Suppressed" : "Not suppressed"}
              </p>
              {notices.map((notice, index) => (
                <p key={index}>{notice}</p>
              ))}

              {channel.dncr && (
                <p className="muted">
                  Register check {formatDay(channel.dncr.checkedAt)} from {channel.dncr.source}
                  {channel.dncr.reference ? ` (${channel.dncr.reference})` : ""}
                  {channel.dncr.validUntil ? ` · valid until ${formatDay(channel.dncr.validUntil)}` : ""}
                </p>
              )}
              {channel.suppression?.active && (
                <p className="muted">
                  Suppressed from {formatDay(channel.suppression.effectiveAt)}
                  {channel.suppression.expiresAt ? ` until ${formatDay(channel.suppression.expiresAt)}` : " with no end date"} — {channel.suppression.reason}
                </p>
              )}

              {channel.streams.length === 0 && <p className="empty-state">No consent recorded on this channel.</p>}
              {channel.streams.length > 0 && (
                <ul className="item-list">
                  {channel.streams.map((stream) => (
                    <li key={stream.consentId}>
                      <div>
                        <strong>{consentStateLabel(stream.state)}</strong> — {stream.purpose} / {stream.scope}
                        {stream.jurisdiction ? ` · ${stream.jurisdiction}` : " · no jurisdiction recorded"}
                      </div>
                      <p className="muted">
                        {stream.source} ({stream.captureMethod.toLowerCase()}) · captured {formatDay(stream.capturedAt)}
                        {stream.expiresAt ? ` · expires ${formatDay(stream.expiresAt)}` : ""}
                        {stream.reviewAt ? ` · review due ${formatDay(stream.reviewAt)}` : ""}
                      </p>
                      <p className="muted">
                        {stream.evidenceReference ? `Evidence: ${stream.evidenceReference}` : "No evidence reference recorded"}
                        {stream.hasEvidencePayload ? " · supporting evidence attached" : ""}
                        {stream.supersedesConsentId !== null ? ` · supersedes record #${stream.supersedesConsentId}` : ""}
                      </p>
                      {stream.state === "WITHDRAWN" && (
                        <p>
                          Withdrawn {formatWhen(stream.withdrawnAt)} — {stream.withdrawalReason}. This stream cannot be
                          re-consented from AE; a new consent has to be captured under a different purpose or scope.
                        </p>
                      )}
                      {stream.notRequiredJustification && <p className="muted">Justification: {stream.notRequiredJustification}</p>}
                      {stream.inferredReasoning && <p className="muted">Inferred because: {stream.inferredReasoning}</p>}

                      {canManage && canWithdrawStream(stream) && withdrawingConsentId !== stream.consentId && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          onClick={() => {
                            setWithdrawingConsentId(stream.consentId);
                            setWithdrawal(EMPTY_WITHDRAWAL);
                          }}
                        >
                          Withdraw consent
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {channel.lastRecordedDecision && (
                <p className="muted">
                  Last recorded decision: {channel.lastRecordedDecision.decision} ({channel.lastRecordedDecision.reasonCode}) on{" "}
                  {formatWhen(channel.lastRecordedDecision.evaluatedAt)}.
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {/* ------------------------------------------------------------
          Withdrawal. A reason is a form requirement, not a failed request.
          ----------------------------------------------------------*/}
      {canManage && withdrawingStream && (
        <form
          className="stack grow-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (withdrawalValidation) return;
            withdrawConsent.mutate(withdrawConsentBody(withdrawingStream, withdrawal, new Date()));
          }}
        >
          <h3>
            Withdraw {channelLabel(withdrawingStream.channel)} consent — {withdrawingStream.purpose} / {withdrawingStream.scope}
          </h3>
          <p className="muted">
            This withdraws one purpose and scope, not the whole contact, and it cannot be undone: AE will not let this stream
            be re-consented.
          </p>

          <label htmlFor="grow-consent-withdraw-reason">Why is consent being withdrawn? (required)</label>
          <textarea
            id="grow-consent-withdraw-reason"
            rows={2}
            value={withdrawal.reason}
            onChange={(e) => setWithdrawal((w) => ({ ...w, reason: e.target.value }))}
          />

          <label htmlFor="grow-consent-withdraw-source">Where did the withdrawal come from? (required)</label>
          <input
            id="grow-consent-withdraw-source"
            type="text"
            placeholder="Inbound phone call"
            value={withdrawal.source}
            onChange={(e) => setWithdrawal((w) => ({ ...w, source: e.target.value }))}
          />

          <label htmlFor="grow-consent-withdraw-method">How was it received?</label>
          <select
            id="grow-consent-withdraw-method"
            value={withdrawal.captureMethod}
            onChange={(e) => setWithdrawal((w) => ({ ...w, captureMethod: e.target.value }))}
          >
            {GROW_CONSENT_CAPTURE_METHODS.map((method) => (
              <option key={method} value={method}>
                {method.toLowerCase()}
              </option>
            ))}
          </select>

          {withdrawalValidation && <p className="error-text">{withdrawalValidation}</p>}
          {withdrawConsent.isError && <p className="error-text">{actionError(withdrawConsent.error, "Couldn't withdraw this consent.")}</p>}

          <div className="grow-inline-form-row">
            <button type="submit" className="btn btn-primary btn-small" disabled={withdrawalValidation !== null || withdrawConsent.isPending}>
              Save withdrawal
            </button>
            <button type="button" className="btn btn-link btn-small" onClick={() => setWithdrawingConsentId(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* ------------------------------------------------------------
          Capture.
          ----------------------------------------------------------*/}
      {canManage && (
        <>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setShowCapture((v) => !v)}>
            {showCapture ? "Cancel" : "Record consent"}
          </button>
          {showCapture && (
            <form
              className="stack grow-inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (captureValidation || captureHeadWithdrawn) return;
                captureConsent.mutate(captureConsentBody(capture, captureHead));
              }}
            >
              <p className="muted">
                Consent is recorded against one channel, purpose and scope. Inferred consent is not offered here: it has to
                carry reviewed relationship evidence and a named reviewer, which this form deliberately does not collect on
                someone's behalf.
              </p>

              <label htmlFor="grow-consent-channel">Channel</label>
              <select id="grow-consent-channel" value={capture.channel} onChange={(e) => setCapture((c) => ({ ...c, channel: e.target.value }))}>
                {GROW_CONSENT_CHANNELS.map((channel) => (
                  <option key={channel} value={channel}>
                    {channelLabel(channel)}
                  </option>
                ))}
              </select>

              <label htmlFor="grow-consent-state">Consent state</label>
              <select id="grow-consent-state" value={capture.state} onChange={(e) => setCapture((c) => ({ ...c, state: e.target.value }))}>
                {GROW_CONSENT_CAPTURABLE_STATES.map((state) => (
                  <option key={state} value={state}>
                    {consentStateLabel(state)}
                  </option>
                ))}
              </select>

              <label htmlFor="grow-consent-purpose">Purpose</label>
              <input
                id="grow-consent-purpose"
                type="text"
                placeholder="MARKETING"
                value={capture.purpose}
                onChange={(e) => setCapture((c) => ({ ...c, purpose: e.target.value }))}
              />

              <label htmlFor="grow-consent-scope">Scope</label>
              <input
                id="grow-consent-scope"
                type="text"
                placeholder="BROKERAGE"
                value={capture.scope}
                onChange={(e) => setCapture((c) => ({ ...c, scope: e.target.value }))}
              />

              <label htmlFor="grow-consent-source">Source</label>
              <input
                id="grow-consent-source"
                type="text"
                placeholder="Signed appraisal authority"
                value={capture.source}
                onChange={(e) => setCapture((c) => ({ ...c, source: e.target.value }))}
              />

              <label htmlFor="grow-consent-method">How was it captured?</label>
              <select
                id="grow-consent-method"
                value={capture.captureMethod}
                onChange={(e) => setCapture((c) => ({ ...c, captureMethod: e.target.value }))}
              >
                {GROW_CONSENT_CAPTURE_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {method.toLowerCase()}
                  </option>
                ))}
              </select>

              <label htmlFor="grow-consent-jurisdiction">Jurisdiction</label>
              <select
                id="grow-consent-jurisdiction"
                value={capture.jurisdiction}
                onChange={(e) => setCapture((c) => ({ ...c, jurisdiction: e.target.value }))}
              >
                <option value="AU">Australia</option>
                <option value="NZ">New Zealand</option>
                <option value="">Not recorded</option>
              </select>

              <label htmlFor="grow-consent-evidence">Evidence reference (optional)</label>
              <input
                id="grow-consent-evidence"
                type="text"
                placeholder="Document or form reference"
                value={capture.evidenceReference}
                onChange={(e) => setCapture((c) => ({ ...c, evidenceReference: e.target.value }))}
              />

              {capture.state === "NOT_REQUIRED" && (
                <>
                  <label htmlFor="grow-consent-justification">Why isn't consent required?</label>
                  <textarea
                    id="grow-consent-justification"
                    rows={2}
                    value={capture.notRequiredJustification}
                    onChange={(e) => setCapture((c) => ({ ...c, notRequiredJustification: e.target.value }))}
                  />
                </>
              )}

              {captureHead && !captureHeadWithdrawn && (
                <p className="muted">This will supersede the current {consentStateLabel(captureHead.state).toLowerCase()} record on that purpose and scope.</p>
              )}
              {captureHeadWithdrawn && (
                <p className="error-text">
                  Consent was withdrawn for that purpose and scope, and AE does not support re-consenting a withdrawn stream.
                  Record the new consent under a different purpose or scope.
                </p>
              )}
              {captureValidation && <p className="error-text">{captureValidation}</p>}
              {!captureValidation && captureAdvice && <p className="muted">{captureAdvice}</p>}
              {captureConsent.isError && <p className="error-text">{actionError(captureConsent.error, "Couldn't record this consent.")}</p>}

              <button
                type="submit"
                className="btn btn-primary btn-small"
                disabled={captureValidation !== null || captureHeadWithdrawn || captureConsent.isPending}
              >
                Save consent
              </button>
            </form>
          )}
        </>
      )}

      {!canManage && (
        <p className="muted">
          Recording or withdrawing consent needs Grow contact management access — ask a Brokerage Administrator.
        </p>
      )}

      {/* ------------------------------------------------------------
          Audit history.
          ----------------------------------------------------------*/}
      <button type="button" className="btn btn-link btn-small" onClick={() => setShowHistory((v) => !v)}>
        {showHistory ? "Hide full history" : "Show full history"}
      </button>
      {showHistory && (
        <>
          {contactability.history.length === 0 && <p className="empty-state">Nothing has been recorded for this contact yet.</p>}
          {contactability.history.length > 0 && (
            <ul className="timeline">
              {contactability.history.map((entry) => (
                <li key={`${entry.kind}-${entry.id}`}>
                  <span className="when">{formatWhen(entry.occurredAt)}</span>
                  <div className="eyebrow">{historyEntryLabel(entry)}</div>
                  {historyEntryDetail(entry) && <p style={{ whiteSpace: "pre-wrap" }}>{historyEntryDetail(entry)}</p>}
                </li>
              ))}
            </ul>
          )}
          {contactability.historyTruncated && (
            <p className="muted">Only the most recent records are shown. The full history is retained — nothing here is ever deleted.</p>
          )}
        </>
      )}
    </section>
  );
}
