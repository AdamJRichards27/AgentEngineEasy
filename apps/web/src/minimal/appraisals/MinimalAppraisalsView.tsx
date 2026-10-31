import { Link } from "wouter";
import type { MinimalAppraisalsModel, MinimalAppraisalsTab } from "./minimalAppraisalsModel";

// Presentational AE Minimal A Appraisals list. No hooks, no network.

export interface MinimalAppraisalsViewProps {
  model: MinimalAppraisalsModel;
  search: string;
  loading: boolean;
  error: string | null;
  onSearch(text: string): void;
  onTab(tab: MinimalAppraisalsTab): void;
  onRetry(): void;
}

export function MinimalAppraisalsView(p: MinimalAppraisalsViewProps) {
  const { model } = p;
  const tabs: Array<[MinimalAppraisalsTab, string, number]> = [
    ["active", "In progress", model.counts.active],
    ["finished", "Finished", model.counts.finished],
  ];
  return (
    <section className="am-data-screen" data-ae-appraisals="minimal" aria-labelledby="am-appraisals-title">
      <header className="am-data-heading">
        <div>
          <div className="am-eyebrow">Grow · Appraisals</div>
          <h1 id="am-appraisals-title">Appraisals</h1>
          <p>Pick up where you left off. Start a new appraisal from a property and its linked contact.</p>
        </div>
        <div className="am-data-actions">
          <Link href="/properties" className="am-data-button is-primary">
            Start from a property
          </Link>
          <Link href="/grow/appraisals?view=full" className="am-data-button is-quiet">
            Classic view
          </Link>
        </div>
      </header>
      <div className="am-data-toolbar">
        <div role="tablist" aria-label="Appraisal status" className="am-data-inline">
          {tabs.map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={model.tab === key}
              className={`am-data-button ${model.tab === key ? "is-primary" : "is-quiet"}`}
              onClick={() => p.onTab(key)}
            >
              {label} ({count})
            </button>
          ))}
        </div>
        <label className="am-data-search">
          <input
            type="search"
            value={p.search}
            onChange={(e) => p.onSearch(e.target.value)}
            placeholder="Search address or contact"
            aria-label="Search appraisals"
          />
        </label>
      </div>
      {p.loading ? <p className="am-empty-note">Loading appraisals…</p> : null}
      {p.error ? (
        <div className="am-rail-section" role="alert">
          <p className="am-switch-error">{p.error}</p>
          <button type="button" className="am-classic-switch" onClick={p.onRetry}>
            Try again
          </button>
        </div>
      ) : null}
      {!p.loading && !p.error && model.rows.length === 0 ? (
        <p className="am-data-empty">
          {p.search.trim()
            ? "No appraisals match."
            : model.tab === "active"
              ? "No appraisals in progress. Start one from a property."
              : "No finished appraisals yet."}
        </p>
      ) : null}
      <div className="am-data-grid" role="list">
        {model.rows.map((row) => (
          <article className="am-data-card" role="listitem" key={row.id} data-appraisal-id={row.id}>
            <div className="am-data-card-top">
              <div style={{ minWidth: 0 }}>
                <span className="am-data-pill">{row.statusLabel}</span>
                <h2>{row.address}</h2>
                <div className="am-data-card-sub">
                  {row.contact}
                  {row.owner ? ` · ${row.owner}` : ""}
                </div>
              </div>
              <Link href={row.href} className="am-data-button is-quiet" aria-label={`${row.actionLabel} appraisal for ${row.address}`}>
                {row.actionLabel}
              </Link>
            </div>
            {row.nextStep || row.followUp ? (
              <div className="am-data-card-meta">
                {row.nextStep ? <span>{row.nextStep}</span> : null}
                {row.followUp ? (
                  <span className={row.followUpOverdue ? "is-overdue" : undefined}>
                    {row.followUpOverdue ? "Follow-up overdue · " : "Follow-up "}
                    {row.followUp}
                  </span>
                ) : null}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
