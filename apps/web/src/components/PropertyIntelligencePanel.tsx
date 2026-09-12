import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../lib/api";
import { useEntitlements } from "../lib/session";

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

  const query = useQuery<PropertyIntelligenceSummary | { properties: ContactPropertyIntelligenceEntry[] }, ApiError>({
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

  function renderSignal(signal: GrowOpportunitySignal) {
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
        {canManage && (
          <div className="action-row">
            <button type="button" className="btn btn-secondary btn-small" onClick={() => reviewSignal.mutate(signal.id)} disabled={reviewSignal.isPending}>
              Mark reviewed
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => promoteSignal.mutate(signal.id)}
              disabled={promoteSignal.isPending || signal.partyId === null}
              title={signal.partyId === null ? "No linked contact — cannot promote to an opportunity" : undefined}
            >
              Promote to opportunity
            </button>
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
  const entries = (query.data as { properties: ContactPropertyIntelligenceEntry[] }).properties;

  return (
    <section className="card">
      <h2>Property Intelligence</h2>
      <p className="muted">Facts and opportunity signals for properties connected to this contact — never a second contact record.</p>
      {entries.length === 0 && <p className="empty-state">No property intelligence connected to this contact yet.</p>}
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
          {entry.activeSignals.length > 0 && <ul className="plain">{entry.activeSignals.map((s) => renderSignal(s))}</ul>}
        </div>
      ))}
    </section>
  );
}
