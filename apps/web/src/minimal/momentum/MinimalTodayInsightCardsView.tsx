import { Link } from "wouter";
import { MINIMAL_MARKET_ACTIVITY_HREF, MARKET_SCOPE_NOTE } from "../market/minimalMarketActivityModel";
import { MINIMAL_MOMENTUM_HREF } from "./minimalMomentumModel";

// Presentational Today cards for My Momentum and Market Activity. No hooks, no network.
// "hidden" renders nothing (flag off / no access), so a disabled feature leaves no trace.

export type InsightCardState<T> =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "error"; text: string; onRetry?: () => void }
  | { kind: "ready"; data: T };

export interface MomentumCardData {
  score: number;
  changeLabel: string;
  milestoneLabel: string;
  unavailableCount: number;
}

export interface MarketCardData {
  total: number;
  lines: { label: string; value: number }[];
}

function CardShell({ title, href, linkLabel, attr, children }: { title: string; href: string; linkLabel: string; attr: string; children: unknown }) {
  return (
    <section className="am-rail-section" {...{ [attr]: "card" }}>
      <div className="am-rail-heading">
        <h3>{title}</h3>
        <Link href={href} className="am-row-open">
          {linkLabel}
        </Link>
      </div>
      {children as never}
    </section>
  );
}

function Status({ state, loading }: { state: { kind: "loading" } | { kind: "error"; text: string; onRetry?: () => void }; loading: string }) {
  if (state.kind === "loading") return <p className="am-empty-note" role="status">{loading}</p>;
  return (
    <div role="alert">
      <p className="am-switch-error">{state.text}</p>
      {state.onRetry ? (
        <button type="button" className="am-classic-switch" onClick={state.onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function MomentumTodayCard({ state }: { state: InsightCardState<MomentumCardData> }) {
  if (state.kind === "hidden") return null;
  return (
    <CardShell title="My Momentum" href={MINIMAL_MOMENTUM_HREF} linkLabel="Open" attr="data-ae-today-momentum">
      {state.kind === "ready" ? (
        <>
          <div className="mm-score">
            <span className="mm-score-number">{state.data.score}</span>
            <span>pts this week</span>
          </div>
          <p className="am-empty-note">
            {state.data.changeLabel} · {state.data.milestoneLabel}
          </p>
          {state.data.unavailableCount > 0 ? (
            <p className="am-empty-note mm-unavailable">{state.data.unavailableCount} measures not yet available.</p>
          ) : null}
          <p className="am-empty-note">Private to you.</p>
        </>
      ) : (
        <Status state={state} loading="Loading your momentum…" />
      )}
    </CardShell>
  );
}

export function MarketActivityTodayCard({ state }: { state: InsightCardState<MarketCardData> }) {
  if (state.kind === "hidden") return null;
  return (
    <CardShell title="Market Activity" href={MINIMAL_MARKET_ACTIVITY_HREF} linkLabel="View all" attr="data-ae-today-market">
      {state.kind === "ready" ? (
        <>
          {state.data.total === 0 ? <p className="am-empty-note">No activity in your AE records in the last 7 days.</p> : null}
          {state.data.lines.map((l) => (
            <div className="am-metric-line" key={l.label}>
              <div className="am-metric-label">{l.label}</div>
              <span className="am-metric-number">{l.value}</span>
            </div>
          ))}
          <p className="am-empty-note">{MARKET_SCOPE_NOTE}</p>
        </>
      ) : (
        <Status state={state} loading="Loading market activity…" />
      )}
    </CardShell>
  );
}

export function TodayInsightCardsView({ momentum, market }: { momentum: InsightCardState<MomentumCardData>; market: InsightCardState<MarketCardData> }) {
  if (momentum.kind === "hidden" && market.kind === "hidden") return null;
  return (
    <div className="mm-today-cards" aria-label="Momentum and market activity">
      <MomentumTodayCard state={momentum} />
      <MarketActivityTodayCard state={market} />
    </div>
  );
}
