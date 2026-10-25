import { Link } from "wouter";
import { MinimalGrowSections } from "../MinimalGrowSections";
import {
  MARKET_EVENT_TYPES,
  MARKET_RANGES,
  MARKET_SCOPE_NOTE,
  MARKET_TYPE_LABELS,
  marketActivityHref,
  type MarketEventRow,
  type MarketEventType,
  type MarketFilters,
} from "./minimalMarketActivityModel";

// Presentational AE Minimal A Market Activity list. No hooks, no network.

export type MinimalMarketActivityState =
  | { kind: "loading" }
  | { kind: "error"; text: string; onRetry?: () => void }
  | { kind: "ready"; rows: MarketEventRow[]; counts: { type: MarketEventType; label: string; value: number }[]; truncated: boolean };

function Frame({ filters, children }: { filters: MarketFilters; children: unknown }) {
  return (
    <section className="am-data-screen" data-ae-market-activity="minimal" aria-labelledby="am-market-title">
      <MinimalGrowSections current="today" />
      <header className="am-data-heading">
        <div>
          <div className="am-eyebrow">Grow · Market Activity</div>
          <h1 id="am-market-title">Market Activity</h1>
          <p>{MARKET_SCOPE_NOTE}</p>
        </div>
      </header>
      <ul className="mm-tabs" aria-label="Date range">
        {MARKET_RANGES.map((r) => (
          <li key={r.key}>
            <Link href={marketActivityHref({ ...filters, range: r.key })} className="am-chip" aria-current={r.key === filters.range ? "page" : undefined}>
              {r.label}
            </Link>
          </li>
        ))}
      </ul>
      <ul className="mm-tabs" aria-label="Type">
        <li>
          <Link href={marketActivityHref({ ...filters, type: null })} className="am-chip" aria-current={filters.type === null ? "page" : undefined}>
            All types
          </Link>
        </li>
        {MARKET_EVENT_TYPES.map((t) => (
          <li key={t}>
            <Link href={marketActivityHref({ ...filters, type: t })} className="am-chip" aria-current={filters.type === t ? "page" : undefined}>
              {MARKET_TYPE_LABELS[t]}
            </Link>
          </li>
        ))}
      </ul>
      {children as never}
    </section>
  );
}

export function MinimalMarketActivityView({ state, filters }: { state: MinimalMarketActivityState; filters: MarketFilters }) {
  if (state.kind === "loading") {
    return (
      <Frame filters={filters}>
        <p className="am-empty-note" role="status">Loading market activity…</p>
      </Frame>
    );
  }
  if (state.kind === "error") {
    return (
      <Frame filters={filters}>
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
  return (
    <Frame filters={filters}>
      <section className="am-rail-section" aria-label="Counts">
        {state.counts.map((c) => (
          <div className="am-metric-line" key={c.type}>
            <div className="am-metric-label">
              <i className="am-mini-dot" /> {c.label}
            </div>
            <span className="am-metric-number">{c.value}</span>
          </div>
        ))}
      </section>
      {state.rows.length === 0 ? (
        <section className="am-rail-section">
          <p className="am-empty-note">No activity in your AE records for this range.</p>
        </section>
      ) : (
        <div className="am-agenda" aria-label="Market events" data-mm-events={state.rows.length}>
          {state.rows.map((r) => (
            <div className="am-agenda-row" key={r.key} data-mm-event={r.key}>
              <div className="am-time">{r.date}</div>
              <div>
                <div className="am-agenda-title">
                  {r.label} · {r.address}
                </div>
                <div className="am-agenda-sub">
                  {r.suburb} · Source: {r.source}
                </div>
              </div>
              {r.href ? (
                <Link href={r.href} className="am-row-open">
                  Open
                </Link>
              ) : (
                <span className="am-row-status is-pending">{r.source}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {state.truncated ? <p className="am-empty-note">Showing the latest 100 events. Narrow the range or type to see the rest.</p> : null}
    </Frame>
  );
}
