import type { GrowOpportunityListTypeFilter } from "@aee/domain";
import { Link } from "wouter";
import { OPPORTUNITY_TYPE_FILTER_OPTIONS, parseTypeFilter, type OpportunitySearchResult } from "./minimalOpportunityDetailModel";

export interface MinimalOpportunitySearchViewProps {
  search: string;
  type: GrowOpportunityListTypeFilter;
  active: boolean;
  loading: boolean;
  error: string | null;
  results: OpportunitySearchResult[];
  total: number;
  onSearch(text: string): void;
  onType(type: GrowOpportunityListTypeFilter): void;
  onRetry(): void;
}

export function MinimalOpportunitySearchView(p: MinimalOpportunitySearchViewProps) {
  return (
    <section className="am-opportunity-search" data-ae-opportunity-search="minimal" aria-label="Find an opportunity">
      <div className="am-data-toolbar">
        <label className="am-data-search">
          <input
            type="search"
            value={p.search}
            onChange={(e) => p.onSearch(e.target.value)}
            placeholder="Search contact or reason"
            aria-label="Search opportunities"
          />
        </label>
        <select
          className="am-data-select"
          aria-label="Opportunity type"
          value={p.type}
          onChange={(e) => p.onType(parseTypeFilter(e.target.value))}
        >
          {OPPORTUNITY_TYPE_FILTER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {p.active && !p.loading && !p.error ? (
          <span className="am-data-count">
            {p.total} match{p.total === 1 ? "" : "es"}
          </span>
        ) : null}
      </div>
      {p.loading ? <p className="am-empty-note" role="status">Searching…</p> : null}
      {p.error ? (
        <div className="am-rail-section" role="alert">
          <p className="am-switch-error">{p.error}</p>
          <button type="button" className="am-classic-switch" onClick={p.onRetry}>
            Try again
          </button>
        </div>
      ) : null}
      {p.active && !p.loading && !p.error && p.results.length === 0 ? <p className="am-data-empty">No opportunities match.</p> : null}
      {p.active && p.results.length > 0 ? (
        <ul className="am-agenda">
          {p.results.map((r) => (
            <li key={r.id} className="am-agenda-row" data-opportunity-id={r.id}>
              <div>
                <Link href={r.href} className="am-agenda-title">
                  {r.contactName}
                </Link>
                <div className="am-agenda-sub">
                  {r.stageLabel} · {r.typeLabel}
                  {r.reason ? ` · ${r.reason}` : ""}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
