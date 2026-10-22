import { Link } from "wouter";
import type { GrowOpportunityManualStage } from "@aee/domain";
import {
  MARKET_ACTIVITY_DEFERRED,
  MINIMAL_OPPORTUNITIES_CLASSIC_HREF,
  type MinimalOpportunityRow,
  type PipelineColumn,
  opportunityActions,
} from "./minimalOpportunitiesModel";

// Presentational AE Minimal A Opportunities: the existing Grow pipeline,
// re-skinned (D3), with the deferred Market Activity notice. No hooks.

export interface LostDraft {
  id: number;
  reason: string;
}

export interface MinimalOpportunitiesViewProps {
  board: PipelineColumn[];
  rowsById: Map<number, MinimalOpportunityRow>;
  total: number;
  loading: boolean;
  error: string | null;
  actionError: { id: number; text: string } | null;
  canManage: boolean;
  showClosed: boolean;
  lostDraft: LostDraft | null;
  pendingId: number | null;
  /** Last lifecycle change, read out by the polite live region. */
  announcement: string | null;
  onToggleClosed(): void;
  onStage(id: number, stage: GrowOpportunityManualStage): void;
  onStartLost(id: number): void;
  onLostReason(text: string): void;
  onConfirmLost(): void;
  onCancelLost(): void;
  onClose(id: number): void;
  onRetry(): void;
}

function cardActions(p: MinimalOpportunitiesViewProps, id: number) {
  const row = p.rowsById.get(id);
  if (!row || !p.canManage) return null;
  const actions = opportunityActions(row);
  if (actions.lockedReason) return <p className="am-ws2-locked">{actions.lockedReason}</p>;
  const pending = p.pendingId === id;
  if (p.lostDraft && p.lostDraft.id === id) {
    return (
      <div className="am-ws2-lost-form">
        <label className="am-form-field">
          Why was it lost? *
          <textarea value={p.lostDraft.reason} onChange={(e) => p.onLostReason(e.target.value)} autoFocus />
        </label>
        <span className="am-card-actions">
          <button type="button" className="is-danger" disabled={pending || p.lostDraft.reason.trim().length === 0} onClick={p.onConfirmLost}>
            Mark lost
          </button>
          <button type="button" onClick={p.onCancelLost}>
            Cancel
          </button>
        </span>
      </div>
    );
  }
  return (
    <span className="am-card-actions">
      <label className="am-data-select">
        <span>Stage</span>
        <select
          value=""
          disabled={pending}
          aria-label={`Move opportunity ${id} to stage`}
          onChange={(e) => {
            const next = e.target.value as GrowOpportunityManualStage;
            if (actions.stages.includes(next)) p.onStage(id, next);
          }}
        >
          <option value="">Move to…</option>
          {actions.stages.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      {actions.canMarkLost ? (
        <button type="button" disabled={pending} onClick={() => p.onStartLost(id)}>
          Mark lost
        </button>
      ) : null}
      {actions.canClose ? (
        <button type="button" disabled={pending} onClick={() => p.onClose(id)}>
          Close
        </button>
      ) : null}
    </span>
  );
}

export function MinimalOpportunitiesView(p: MinimalOpportunitiesViewProps) {
  const columns = p.board.filter((c) => p.showClosed || !c.closed);
  const shown = p.board.reduce((n, c) => n + c.count, 0);
  return (
    <section className="am-data-screen am-ws2-opportunities" data-ae-opportunities="minimal" aria-labelledby="am-opportunities-title">
      <header className="am-data-heading">
        <div>
          <div className="am-eyebrow">Grow · Opportunities</div>
          <h1 id="am-opportunities-title">Opportunities</h1>
          <p>Your pipeline from AE records: who, why, and the next step.</p>
        </div>
        <div className="am-data-actions">
          <Link href={MINIMAL_OPPORTUNITIES_CLASSIC_HREF} className="am-data-button am-ws2-classic-link">
            Classic view
          </Link>
          <button type="button" className="am-data-button" aria-pressed={p.showClosed} onClick={p.onToggleClosed}>
            Show closed
          </button>
        </div>
      </header>
      <aside className="am-data-banner am-ws2-market-deferred" aria-label={MARKET_ACTIVITY_DEFERRED.title}>
        <span>
          <strong>{MARKET_ACTIVITY_DEFERRED.title}.</strong> {MARKET_ACTIVITY_DEFERRED.body}
        </span>
      </aside>
      <p className="ae-ws2-vh" role="status" aria-live="polite">
        {p.announcement ?? ""}
      </p>
      {p.loading ? <p className="am-empty-note">Loading opportunities…</p> : null}
      {p.error ? (
        <div className="am-rail-section" role="alert">
          <p className="am-switch-error">{p.error}</p>
          <button type="button" className="am-classic-switch" onClick={p.onRetry}>
            Try again
          </button>
        </div>
      ) : null}
      {!p.loading && !p.error && shown === 0 ? <p className="am-data-empty">No opportunities yet.</p> : null}
      {!p.loading && !p.error && p.total > shown ? (
        <p className="am-empty-note">
          Showing the latest {shown} of {p.total}. Switch to Classic view for the full, searchable list.
        </p>
      ) : null}
      <div className="am-ws2-board" role="list" aria-label="Pipeline stages">
        {columns.map((col) => (
          <section key={col.key} className="am-ws2-column" role="listitem" aria-labelledby={`am-ws2-col-${col.key}`} data-column={col.key}>
            <h2 id={`am-ws2-col-${col.key}`} className="am-eyebrow">
              {col.label} <span className="am-nav-tag">{col.count}</span>
            </h2>
            {col.cards.length === 0 ? <p className="am-empty-note">None</p> : null}
            {col.cards.map((card) => (
              <article key={card.id} className="am-data-card" data-opportunity-id={card.id}>
                <div className="am-data-card-top">
                  <div style={{ minWidth: 0 }}>
                    <span className="am-data-pill">{card.typeLabel}</span>
                    <h3>
                      <Link href={card.contactHref}>{card.contactName}</Link>
                    </h3>
                    {card.reason ? <div className="am-data-card-sub">{card.reason}</div> : null}
                  </div>
                </div>
                <div className="am-data-card-meta">
                  <span>{card.nextAction ?? "No next action set"}</span>
                  {card.propertyHref ? <Link href={card.propertyHref}>Property</Link> : <span>No property linked</span>}
                  {card.appraisalHref ? <Link href={card.appraisalHref}>Appraisal</Link> : null}
                </div>
                {p.actionError && p.actionError.id === card.id ? (
                  <p className="am-switch-error" role="alert">
                    {p.actionError.text}
                  </p>
                ) : null}
                <div className="am-data-card-footer">{cardActions(p, card.id)}</div>
              </article>
            ))}
          </section>
        ))}
      </div>
    </section>
  );
}
