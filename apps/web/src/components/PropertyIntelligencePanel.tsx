import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../lib/api";
import { useEntitlements } from "../lib/session";
import { CONTACT_ANCHORED_SECTION_BLURB, unusableSignalNotice } from "../lib/contactAnchoredSignals";

// AE GROW Priority 5 Remediation — Property Intelligence. The reusable panel Contact 360
// (Grow.tsx) and the Property Workspace (PropertyWorkspace.tsx) both embed, rather than either
// screen growing its own bespoke Property Intelligence UI — see the remediation objective's own
// "extend the existing Contact 360 view... do not create another contact screen" / "extend the
// existing property view" instructions. Types below hand-mirror
// apps/api/src/lib/propertyIntelligence/service.ts's response shapes and
// packages/db/src/schema/propertyIntelligence.ts's own $inferSelect column names exactly — the
// same "the web app doesn't share a package with the API, so this needs a matching hand-edit if
// the backend shape ever changes" convention lib/growToday.ts's frontend mirror already
// documents in Grow.tsx's own header comment.
//
// This is deliberately decision support, never a raw provider-data dump (remediation
// objective's own words) — every signal's explanation is rendered as-authored (already
// carefully hedged, never a bare percentage or "likely to sell" claim — see signals.ts), and
// nothing here ever contacts a consumer, creates an appraisal/campaign/transaction, or performs
// any action a human didn't explicitly click.

interface PropertyProviderObservation {
  id: number;
  observationType: string;
  provider: string;
  providerReference: string | null;
  sourceTimestamp: string | null;
  retrievedAt: string;
  isCurrent: boolean;
}

interface PropertyExternalIdentifier {
  id: number;
  propertyId: number;
  provider: string;
  externalId: string;
  matchConfidence: string | null;
  matchReasons: unknown;
  status: "PendingReview" | "Confirmed" | "Rejected";
  rejectedReason: string | null;
}

type PropertySignalConfidenceBand = "Emerging" | "WorthReviewing" | "StrongIndicator";

interface GrowOpportunitySignal {
  id: number;
  partyId: number | null;
  propertyId: number | null;
  signalType: string;
  title: string;
  explanation: string;
  source: string;
  sourceTimestamp: string | null;
  computedAt: string;
  confidenceBand: PropertySignalConfidenceBand;
  expiresAt: string | null;
  promotedOpportunityId: number | null;
}

interface PropertyIntelligenceSummary {
  propertyId: number;
  dataQualityStatus: string | null;
  lastEnrichedAt: string | null;
  currentObservations: PropertyProviderObservation[];
  pendingMatches: PropertyExternalIdentifier[];
  activeSignals: GrowOpportunitySignal[];
}

interface ContactPropertyIntelligenceEntry {
  propertyId: number;
  propertyAddress: string;
  relationshipType: string;
  activeSignals: GrowOpportunitySignal[];
  pendingMatches: PropertyExternalIdentifier[];
}

// AE GROW Completion W2-D. Hand-mirrors service.ts's ContactAnchoredSignalEntry
// / ContactIntelligenceSummary exactly, per this file's header convention.
//
// Note what is NOT here: no propertyId, no propertyAddress, no
// relationshipType, no pendingMatches. A contact-anchored signal has no
// property, so this shape has nowhere to put one — which is deliberate. If it
// carried `propertyId: number | null` the very next thing written would be a
// `/properties/${propertyId}` link that renders `/properties/null` the day
// somebody forgets the guard.
interface SignalObservation {
  what: string;
  recordType: string;
  recordId: number | string | null;
  observedAt: string | null;
  source: string;
}

interface ContactAnchoredSignalEntry {
  anchor: "contact";
  signal: GrowOpportunitySignal;
  observations: SignalObservation[];
  unknowns: string[];
  missingPropertyAnchor: string;
  agentAction: string | null;
}

// Hand-mirrors signals.ts's ContactOutreachRestriction. Note there is no
// "allowed" shape: the field is the object or it is absent. A boolean would
// invite reading a missing key as permission.
interface ContactOutreachRestriction {
  outreachProhibited: true;
  reason: "contactability_suppressed";
  blockedChannels: string[];
  notice: string;
  recommendedAction: string;
}

interface ContactIntelligenceSummary {
  properties: ContactPropertyIntelligenceEntry[];
  contactAnchoredSignals: ContactAnchoredSignalEntry[];
  unusableSignalCount: number;
  outreachRestriction: ContactOutreachRestriction | null;
}

const CONFIDENCE_PILL_CLASS: Record<PropertySignalConfidenceBand, string> = {
  Emerging: "pill",
  WorthReviewing: "pill pill-warning",
  StrongIndicator: "pill pill-success",
};

const STALE_AFTER_DAYS = 90;

function humanize(value: string): string {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function formatDateShort(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function daysSinceIso(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
}

function formatConfidencePercent(raw: string | null): string | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (Number.isNaN(n)) return null;
  return `${Math.round(n * 100)}%`;
}

function humanReasons(matchReasons: unknown): string[] {
  if (!Array.isArray(matchReasons)) return [];
  return matchReasons.filter((r): r is string => typeof r === "string");
}

type PropertyIntelligenceAnchor = { anchor: "property"; propertyId: number } | { anchor: "contact"; partyId: number };

export function PropertyIntelligencePanel(props: PropertyIntelligenceAnchor) {
  const { hasEntitlement, isLoading: entitlementsLoading } = useEntitlements();
  const canRead = hasEntitlement("grow.propertyIntelligence.read");
  const canManage = hasEntitlement("grow.propertyIntelligence.manage");
  const queryClient = useQueryClient();

  const queryKey = props.anchor === "property" ? ["property-intelligence", "property", props.propertyId] : ["property-intelligence", "contact", props.partyId];

  const query = useQuery<PropertyIntelligenceSummary | ContactIntelligenceSummary, ApiError>({
    queryKey,
    queryFn: () =>
      props.anchor === "property"
        ? apiFetch(`/grow/property-intelligence/property/${props.propertyId}`)
        : apiFetch(`/grow/property-intelligence/contact/${props.partyId}`),
    // grow.propertyIntelligence.read is checked locally first (see the early return below) so a
    // user who doesn't have it never even fires this request — the Permission denied state is
    // rendered from that local check, and this `enabled` guard is defence-in-depth for the same
    // reason PropertyWorkspace/Grow.tsx's other panels never fire a query they already know is
    // pointless.
    enabled: canRead,
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey });
  }

  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [dismissingId, setDismissingId] = useState<number | null>(null);
  const [dismissReason, setDismissReason] = useState("");

  const confirmMatch = useMutation({
    mutationFn: (identifierId: number) => apiFetch(`/grow/property-intelligence/matches/${identifierId}/confirm`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const rejectMatch = useMutation({
    mutationFn: (vars: { identifierId: number; rejectedReason: string }) =>
      apiFetch(`/grow/property-intelligence/matches/${vars.identifierId}/reject`, {
        method: "POST",
        body: JSON.stringify({ rejectedReason: vars.rejectedReason.trim() || null }),
      }),
    onSuccess: () => {
      setRejectingId(null);
      setRejectReason("");
      invalidate();
    },
  });
  const reviewSignal = useMutation({
    mutationFn: (signalId: number) => apiFetch(`/grow/property-intelligence/signals/${signalId}/review`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const dismissSignal = useMutation({
    mutationFn: (vars: { signalId: number; dismissedReason: string }) =>
      apiFetch(`/grow/property-intelligence/signals/${vars.signalId}/dismiss`, {
        method: "POST",
        body: JSON.stringify({ dismissedReason: vars.dismissedReason }),
      }),
    onSuccess: () => {
      setDismissingId(null);
      setDismissReason("");
      invalidate();
    },
  });
  const promoteSignal = useMutation({
    mutationFn: (signalId: number) => apiFetch(`/grow/property-intelligence/signals/${signalId}/promote`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const recalculate = useMutation({
    mutationFn: (propertyId: number) => apiFetch(`/grow/property-intelligence/property/${propertyId}/recalculate`, { method: "POST" }),
    onSuccess: invalidate,
  });

  // Permission denied — checked locally before ever firing the query (see `enabled` above).
  if (!canRead && !entitlementsLoading) {
    return (
      <section className="card">
        <h2>Property Intelligence</h2>
        <p className="muted">You don't have permission to view Property Intelligence — ask a Brokerage Administrator.</p>
      </section>
    );
  }

  // Loading.
  if (entitlementsLoading || query.isLoading) {
    return (
      <section className="card">
        <h2>Property Intelligence</h2>
        <p className="muted">Loading property intelligence…</p>
      </section>
    );
  }

  // Recoverable API error — including a defensive 403 (e.g. a stale entitlement cache) even
  // though the local check above already covers the common case.
  if (query.isError || !query.data) {
    if (query.error instanceof ApiError && query.error.status === 403) {
      return (
        <section className="card">
          <h2>Property Intelligence</h2>
          <p className="muted">You don't have permission to view Property Intelligence — ask a Brokerage Administrator.</p>
        </section>
      );
    }
    return (
      <section className="card">
        <h2>Property Intelligence</h2>
        <p className="error-text">{query.error instanceof ApiError ? query.error.friendly : "Couldn't load Property Intelligence."}</p>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => query.refetch()}>
          Try again
        </button>
      </section>
    );
  }

  // `detail` is the W2-D extension point: a contact-anchored signal renders its
  // evidence and its unknowns here, between the explanation and the actions.
  // Every signal keeps the same title, band, explanation and action row, so a
  // signal without a property does not read as a lesser kind of signal.
  //
  // `outreachRestricted` removes the one action on this panel that leads
  // anywhere near outreach — see below.
  function renderSignal(signal: GrowOpportunitySignal, detail?: ReactNode, outreachRestricted = false) {
    const freshness = formatDateShort(signal.sourceTimestamp) ?? formatDateShort(signal.computedAt);
    return (
      <li key={signal.id} className="plain-item">
        <div>
          <strong>{signal.title}</strong>{" "}
          <span className={CONFIDENCE_PILL_CLASS[signal.confidenceBand]}>
            {signal.confidenceBand === "WorthReviewing" ? "Worth reviewing" : signal.confidenceBand === "StrongIndicator" ? "Strong indicator" : "Emerging"}
          </span>
        </div>
        <p className="muted">{signal.explanation}</p>
        <p className="muted">
          Source: {signal.source === "internal" ? "AE record" : humanize(signal.source)}
          {freshness ? ` · ${freshness}` : ""}
        </p>
        {detail}
        {canManage && (
          <div className="action-row">
            <button type="button" className="btn btn-secondary btn-small" onClick={() => reviewSignal.mutate(signal.id)} disabled={reviewSignal.isPending}>
              Mark reviewed
            </button>
            {/* AE GROW Completion W2-D — NOT RENDERED WHEN OUTREACH IS RESTRICTED.
                "Mark reviewed" and "Dismiss" stay: they are internal record-keeping
                about a signal, they reach no one, and taking them away would leave an
                agent unable to clear a signal they are not allowed to act on.
                "Promote to opportunity" is different in kind — an opportunity is the
                INPUT to the follow-up funnel (Grow Today renders opportunity cards, and
                an opportunity can be converted to an appraisal, which sends). It is the
                only control on this panel that moves a contact toward being contacted,
                so it is the only one removed.
                REMOVED, NOT DISABLED-AND-STYLED: there is no element to re-enable in a
                devtools console. And this is presentation only — the server refuses the
                same promotion independently (signals.ts promoteSignal), which is what
                makes it a defence. That server check also covers the Property Workspace
                embedding of this panel, where the restriction is not in scope to fetch
                and the button is therefore still rendered. */}
            {!outreachRestricted && (
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => promoteSignal.mutate(signal.id)}
                disabled={promoteSignal.isPending || signal.partyId === null}
                title={signal.partyId === null ? "No linked contact — cannot promote to an opportunity" : undefined}
              >
                Promote to opportunity
              </button>
            )}
            <button
              type="button"
              className="btn btn-small btn-danger"
              onClick={() => {
                setDismissingId(signal.id);
                setDismissReason("");
              }}
            >
              Dismiss
            </button>
          </div>
        )}
        {canManage && dismissingId === signal.id && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!dismissReason.trim()) return;
              dismissSignal.mutate({ signalId: signal.id, dismissedReason: dismissReason.trim() });
            }}
          >
            <input
              value={dismissReason}
              onChange={(ev) => setDismissReason(ev.target.value)}
              placeholder="Reason for dismissing (required)"
              autoFocus
            />
            <button type="submit" className="btn btn-secondary btn-small" disabled={!dismissReason.trim() || dismissSignal.isPending}>
              Confirm dismiss
            </button>
            <button type="button" className="btn btn-link btn-small" onClick={() => setDismissingId(null)}>
              Cancel
            </button>
          </form>
        )}
      </li>
    );
  }

  function renderMatch(match: PropertyExternalIdentifier) {
    const confidence = formatConfidencePercent(match.matchConfidence);
    const reasons = humanReasons(match.matchReasons);
    return (
      <li key={match.id} className="plain-item">
        <div>
          <span className="pill pill-warning">Pending match review</span> {humanize(match.provider)} record ({match.externalId})
          {confidence ? ` · ${confidence} confidence` : " · confidence not scored"}
        </div>
        {reasons.length > 0 && (
          <ul className="plain">
            {reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}
        {canManage && (
          <div className="action-row">
            <button type="button" className="btn btn-secondary btn-small" onClick={() => confirmMatch.mutate(match.id)} disabled={confirmMatch.isPending}>
              Confirm match
            </button>
            <button type="button" className="btn btn-small btn-danger" onClick={() => setRejectingId(match.id)}>
              Reject
            </button>
          </div>
        )}
        {canManage && rejectingId === match.id && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              rejectMatch.mutate({ identifierId: match.id, rejectedReason: rejectReason });
            }}
          >
            <input value={rejectReason} onChange={(ev) => setRejectReason(ev.target.value)} placeholder="Reason (optional)" autoFocus />
            <button type="submit" className="btn btn-secondary btn-small" disabled={rejectMatch.isPending}>
              Confirm reject
            </button>
            <button type="button" className="btn btn-link btn-small" onClick={() => setRejectingId(null)}>
              Cancel
            </button>
          </form>
        )}
      </li>
    );
  }

  if (props.anchor === "property") {
    const data = query.data as PropertyIntelligenceSummary;
    const isEmpty = data.currentObservations.length === 0 && data.pendingMatches.length === 0 && data.activeSignals.length === 0;
    const lastEnrichedLabel = formatDateShort(data.lastEnrichedAt);
    const isStale = data.lastEnrichedAt !== null && daysSinceIso(data.lastEnrichedAt) > STALE_AFTER_DAYS;

    return (
      <section className="card">
        <h2>Property Intelligence</h2>
        <p className="muted">
          {lastEnrichedLabel ? (
            <>
              Last refreshed {lastEnrichedLabel}
              {isStale ? " — this may be out of date." : "."}
            </>
          ) : (
            "Not yet enriched from any external provider — signals below (if any) come from AE's own records."
          )}
          {data.dataQualityStatus ? ` Data quality: ${humanize(data.dataQualityStatus)}.` : ""}
        </p>

        {canManage && (
          <button type="button" className="btn btn-link btn-small" onClick={() => recalculate.mutate(props.propertyId)} disabled={recalculate.isPending}>
            {recalculate.isPending ? "Refreshing…" : "Refresh signals"}
          </button>
        )}

        {isEmpty && <p className="empty-state">No property intelligence recorded for this property yet.</p>}

        {data.pendingMatches.length > 0 && (
          <>
            <h3>Pending matches</h3>
            <ul className="plain">{data.pendingMatches.map(renderMatch)}</ul>
          </>
        )}

        {data.activeSignals.length > 0 && (
          <>
            <h3>Opportunity signals</h3>
            <ul className="plain">{data.activeSignals.map((s) => renderSignal(s))}</ul>
          </>
        )}

        {data.currentObservations.length > 0 && (
          <>
            <h3>Provider observations</h3>
            <table className="grow-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Provider</th>
                  <th>Observed / retrieved</th>
                </tr>
              </thead>
              <tbody>
                {data.currentObservations.map((o) => (
                  <tr key={o.id}>
                    <td>{humanize(o.observationType)}</td>
                    <td>{humanize(o.provider)}</td>
                    <td>{formatDateShort(o.sourceTimestamp) ?? formatDateShort(o.retrievedAt) ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    );
  }

  // anchor === "contact"
  const contactData = query.data as ContactIntelligenceSummary;
  const entries = contactData.properties;
  // Tolerated as absent so the panel still renders against an API that has not
  // been deployed with W2-D yet — the same hand-mirror caution this file's
  // header describes. Absent is treated as "none", never as "unknown".
  const contactAnchored = contactData.contactAnchoredSignals ?? [];
  const withholdingNotice = unusableSignalNotice(contactData.unusableSignalCount ?? 0);
  const isEmpty = entries.length === 0 && contactAnchored.length === 0;
  // AE GROW Completion W2-D — non-null means this contact must not be
  // contacted. `?? null` because an API build predating W2-D omits the key;
  // absent means "no restriction is on file", which is the same thing that
  // build's own behaviour asserted (it withheld the signals entirely rather
  // than returning them with a restriction), so there is nothing to fail
  // closed about here.
  const outreachRestriction = contactData.outreachRestriction ?? null;

  /**
   * AE GROW Completion W2-D — what AE saw, and what AE does not know, for a
   * signal that has no property.
   *
   * Both halves are rendered, always and in that order. A contact-anchored
   * signal's whole claim on an agent's attention is that AE can say precisely
   * what it is working from; showing the evidence while hiding the gaps would
   * make it a worse signal than the property-anchored ones, not an equal one.
   */
  function renderContactAnchoredDetail(entry: ContactAnchoredSignalEntry): ReactNode {
    return (
      <div className="contact-anchored-detail">
        {entry.observations.length > 0 && (
          <>
            <p className="muted">
              <strong>What AE can see</strong>
            </p>
            <ul className="plain">
              {entry.observations.map((o, i) => (
                <li key={i}>
                  {o.what}
                  {formatDateShort(o.observedAt) ? <span className="muted"> · {formatDateShort(o.observedAt)}</span> : null}
                  <span className="muted"> · {o.source === "internal" ? "AE record" : humanize(o.source)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="muted">
          <strong>What AE does not know</strong>
        </p>
        <ul className="plain">
          {/* The defining unknown of this category, first and always. */}
          <li>{entry.missingPropertyAnchor}</li>
          {entry.unknowns.map((u, i) => (
            <li key={i}>{u}</li>
          ))}
        </ul>
        {/* The API nulls agentAction outright whenever outreach is restricted
            (service.ts applyOutreachRestriction), so there is normally nothing
            to render. The explicit guard is belt-and-braces against an API
            build that has not caught up: the restriction's own
            recommendedAction is shown in the banner above instead, and a
            "Consider a check-in" line must never appear on a DNC contact. */}
        {entry.agentAction && !outreachRestriction && (
          <p className="muted">
            <strong>You might consider:</strong> {entry.agentAction}
          </p>
        )}
      </div>
    );
  }

  return (
    <section className="card">
      <h2>Property Intelligence</h2>
      <p className="muted">Facts and opportunity signals connected to this contact — never a second contact record.</p>

      {/* =================================================================
          AE GROW Completion W2-D — THE OUTREACH RESTRICTION.
          FIRST, ABOVE EVERYTHING, AND UNMISSABLE.

          Rendered before the empty state, before the contact-anchored
          section and before any property, so it is not possible to read a
          single signal on this panel without having already read that this
          person must not be contacted. This is the condition on which
          showing a suppressed contact's intelligence at all was granted:
          the intelligence is visible, the restriction is louder.

          It is a statement of a record AE holds, not a judgement about the
          person, and it says what the agent should do instead.
          ============================================================= */}
      {outreachRestriction && (
        <div className="callout callout-warning grow-outreach-restriction" role="alert">
          <div>
            <strong>Do not contact</strong>
          </div>
          <p>{outreachRestriction.notice}</p>
          <p>{outreachRestriction.recommendedAction}</p>
          <p className="muted">
            Calling, SMS and email are not available for this contact anywhere in AE, and this signal cannot be promoted to an opportunity. The intelligence below is
            shown because it is a record of what has already happened — it is not a suggestion to get in touch.
          </p>
        </div>
      )}

      {isEmpty && <p className="empty-state">No property intelligence connected to this contact yet.</p>}

      {/* Contact-anchored first: this is intelligence about the person whose
          record the agent is already looking at, and it used to be dropped
          here entirely. No Link, no address, no "Refresh signals" — there is
          no property for any of those to point at. */}
      {contactAnchored.length > 0 && (
        <div className="plain-item">
          <div>
            <strong>About this contact</strong> <span className="pill">No property linked</span>
          </div>
          <p className="muted">{CONTACT_ANCHORED_SECTION_BLURB}</p>
          <ul className="plain">{contactAnchored.map((entry) => renderSignal(entry.signal, renderContactAnchoredDetail(entry), outreachRestriction !== null))}</ul>
        </div>
      )}

      {/* Honest about what is not shown, in Grow Today's own idiom. */}
      {withholdingNotice && <p className="muted grow-signal-withholding-notice">{withholdingNotice}</p>}

      {entries.map((entry) => (
        <div key={entry.propertyId} className="plain-item">
          <div>
            <Link href={`/properties/${entry.propertyId}`}>{entry.propertyAddress}</Link>{" "}
            <span className="muted">— recorded as {humanize(entry.relationshipType)}</span>
          </div>
          {entry.pendingMatches.length > 0 && (
            <p className="muted">
              <span className="pill pill-warning">Pending review</span> A provider record match for this property is pending review — property facts may
              be incomplete until reviewed.
            </p>
          )}
          {canManage && (
            <button type="button" className="btn btn-link btn-small" onClick={() => recalculate.mutate(entry.propertyId)} disabled={recalculate.isPending}>
              {recalculate.isPending ? "Refreshing…" : "Refresh signals"}
            </button>
          )}
          {entry.pendingMatches.length === 0 && entry.activeSignals.length === 0 && <p className="muted">No active signals for this property.</p>}
          {entry.pendingMatches.length > 0 && <ul className="plain">{entry.pendingMatches.map(renderMatch)}</ul>}
          {/* The contact's restriction applies to their property-anchored
              signals too — it is a property of the PERSON, not of which
              section of this panel their signal happens to be filed under. */}
          {entry.activeSignals.length > 0 && <ul className="plain">{entry.activeSignals.map((s) => renderSignal(s, undefined, outreachRestriction !== null))}</ul>}
        </div>
      ))}
    </section>
  );
}
