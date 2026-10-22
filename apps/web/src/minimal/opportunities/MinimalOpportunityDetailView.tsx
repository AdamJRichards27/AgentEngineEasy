import type { GrowOpportunityManualStage } from "@aee/domain";
import { Link } from "wouter";
import { MinimalGrowSections } from "../MinimalGrowSections";
import { MINIMAL_PIPELINE_COLUMNS } from "./minimalOpportunitiesModel";
import { MINIMAL_OPPORTUNITIES_HREF, type MinimalOpportunityDetailModel } from "./minimalOpportunityDetailModel";

// Presentational AE Minimal A opportunity detail. No hooks, no network.

export type MinimalOpportunityDetailState =
  | { kind: "loading" }
  | { kind: "error"; text: string; onRetry?: () => void }
  | { kind: "ready"; model: MinimalOpportunityDetailModel };

export interface MinimalOpportunityDetailViewProps {
  state: MinimalOpportunityDetailState;
  canManage: boolean;
  pending: boolean;
  actionError: string | null;
  announcement: string | null;
  lostReason: string | null;
  onStage(stage: GrowOpportunityManualStage): void;
  onStartLost(): void;
  onLostReason(text: string): void;
  onConfirmLost(): void;
  onCancelLost(): void;
  onClose(): void;
}

function stageLabel(stage: string): string {
  return MINIMAL_PIPELINE_COLUMNS.find((c) => c.key === stage)?.label ?? stage;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <section className="am-data-screen" data-ae-opportunity-detail="minimal">
      <MinimalGrowSections current="opportunities" />
      <Link href={MINIMAL_OPPORTUNITIES_HREF} className="am-back-link">
        ← Back to Opportunities
      </Link>
      {children}
    </section>
  );
}

export function MinimalOpportunityDetailView(p: MinimalOpportunityDetailViewProps) {
  const { state } = p;
  if (state.kind === "loading") {
    return (
      <Frame>
        <p className="am-empty-note" role="status">
          Loading opportunity…
        </p>
      </Frame>
    );
  }
  if (state.kind === "error") {
    return (
      <Frame>
        <div className="am-rail-section" role="alert">
          <p className="am-switch-error">{state.text}</p>
          {state.onRetry ? (
            <button type="button" className="am-classic-switch" onClick={state.onRetry}>
              Try again
            </button>
          ) : null}
        </div>
      </Frame>
    );
  }
  const m = state.model;
  const a = m.actions;
  return (
    <Frame>
      <header className="am-data-heading" data-opportunity-id={m.id}>
        <div>
          <div className="am-eyebrow">Grow · Opportunity</div>
          <h1>{m.contactName}</h1>
          <p>
            <span className="am-data-pill">{m.stageLabel}</span> {m.typeLabel}
          </p>
        </div>
        <div className="am-data-actions">
          <Link href={m.contactHref} className="am-data-button is-quiet">
            Open contact
          </Link>
        </div>
      </header>

      <section className="am-rail-section" aria-label="Opportunity details">
        <dl className="am-facts">
          <dt>Why</dt>
          <dd>{m.reason ?? "Not recorded"}</dd>
          <dt>Next action</dt>
          <dd>{m.nextAction ? `${m.nextAction}${m.nextActionDue ? ` · ${m.nextActionDue}` : ""}` : m.nextActionDue ?? "None set"}</dd>
          {m.lostReason ? (
            <>
              <dt>Lost because</dt>
              <dd>{m.lostReason}</dd>
            </>
          ) : null}
          {m.created ? (
            <>
              <dt>Created</dt>
              <dd>{m.created}</dd>
            </>
          ) : null}
          <dt>Property</dt>
          <dd>{m.propertyHref ? <Link href={m.propertyHref}>Open the property</Link> : "No property linked"}</dd>
          <dt>Appraisal</dt>
          <dd>{m.appraisalHref ? <Link href={m.appraisalHref}>Open the appraisal</Link> : "None yet"}</dd>
        </dl>
      </section>

      <div className="am-sr-only" role="status" aria-live="polite">
        {p.announcement ?? ""}
      </div>

      {p.canManage ? (
        <section className="am-rail-section" aria-labelledby="am-opportunity-actions">
          <h2 id="am-opportunity-actions" className="am-eyebrow">
            Move this opportunity
          </h2>
          {a.lockedReason ? <p className="am-empty-note">{a.lockedReason}</p> : null}
          {a.stages.length > 0 ? (
            <div className="am-card-actions">
              {a.stages.map((s) => (
                <button key={s} type="button" className="am-data-button is-quiet" disabled={p.pending} onClick={() => p.onStage(s)}>
                  {stageLabel(s)}
                </button>
              ))}
            </div>
          ) : null}
          {p.lostReason !== null ? (
            <div className="am-data-inline">
              <label className="am-form-field">
                Why was it lost?
                <input type="text" value={p.lostReason} autoFocus onChange={(e) => p.onLostReason(e.target.value)} />
              </label>
              <button type="button" className="am-data-button is-primary" disabled={p.pending} onClick={p.onConfirmLost}>
                Mark lost
              </button>
              <button type="button" className="am-data-button is-quiet" onClick={p.onCancelLost}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="am-card-actions">
              {a.canMarkLost ? (
                <button type="button" className="am-data-button is-quiet" disabled={p.pending} onClick={p.onStartLost}>
                  Mark lost…
                </button>
              ) : null}
              {a.canClose ? (
                <button type="button" className="am-data-button is-quiet" disabled={p.pending} onClick={p.onClose}>
                  Close
                </button>
              ) : null}
            </div>
          )}
          {p.actionError ? (
            <p className="am-switch-error" role="alert">
              {p.actionError}
            </p>
          ) : null}
        </section>
      ) : null}
    </Frame>
  );
}
