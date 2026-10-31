import { Link } from "wouter";
import { MinimalGrowSections } from "../MinimalGrowSections";
import { MINIMAL_MOMENTUM_HREF, type MinimalMomentumModel, type MomentumPeriod } from "./minimalMomentumModel";

// Presentational AE Minimal A My Momentum. No hooks, no network.
// Private to the signed-in agent: no leaderboard, ranking or comparison.

export type MinimalMomentumState =
  | { kind: "loading" }
  | { kind: "error"; text: string; onRetry?: () => void }
  | { kind: "ready"; period: MomentumPeriod; model: MinimalMomentumModel };

function Frame({ period, children }: { period: MomentumPeriod; children: unknown }) {
  return (
    <section className="am-data-screen" data-ae-momentum="minimal" aria-labelledby="am-momentum-title">
      <MinimalGrowSections current="today" />
      <header className="am-data-heading">
        <div>
          <div className="am-eyebrow">Grow · Private to you</div>
          <h1 id="am-momentum-title">My Momentum</h1>
          <p>Your own prospecting effort. Only you can see this. It is never compared with anyone else.</p>
        </div>
      </header>
      <ul className="mm-tabs" aria-label="Period">
        {(["week", "month"] as const).map((p) => (
          <li key={p}>
            <Link
              href={p === "week" ? MINIMAL_MOMENTUM_HREF : `${MINIMAL_MOMENTUM_HREF}?period=month`}
              className="am-chip"
              aria-current={p === period ? "page" : undefined}
            >
              {p === "week" ? "This week" : "This month"}
            </Link>
          </li>
        ))}
      </ul>
      {children as never}
    </section>
  );
}

export function MinimalMomentumView({ state, period }: { state: MinimalMomentumState; period: MomentumPeriod }) {
  if (state.kind === "loading") {
    return (
      <Frame period={period}>
        <p className="am-empty-note" role="status">Loading your momentum…</p>
      </Frame>
    );
  }
  if (state.kind === "error") {
    return (
      <Frame period={period}>
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
  return (
    <Frame period={state.period}>
      <section className="am-rail-section" aria-labelledby="mm-score-h">
        <div className="am-rail-heading">
          <h2 id="mm-score-h">{m.periodLabel}</h2>
          <span>{m.rangeLabel}</span>
        </div>
        <div className="mm-score">
          <span className="mm-score-number" data-mm-score>{m.score}</span>
          <span>pts</span>
          <span className={`mm-change is-${m.changeTone}`}>{m.changeLabel}</span>
        </div>
        <div className="am-metric-line">
          <div className="am-metric-label">Next milestone</div>
          <span className="am-metric-number">{m.milestoneLabel}</span>
        </div>
        <div className="am-metric-line">
          <div className="am-metric-label">Active-day streak</div>
          <span className="am-metric-number">{m.streakLabel}</span>
        </div>
        {m.empty ? (
          <p className="am-empty-note">Nothing counted yet for this period. Calls, meetings and personal emails or texts you log will show here.</p>
        ) : null}
        {m.truncatedNote ? <p className="am-empty-note">{m.truncatedNote}</p> : null}
      </section>

      <section className="am-rail-section" aria-labelledby="mm-cat-h">
        <div className="am-rail-heading">
          <h2 id="mm-cat-h">What counted</h2>
        </div>
        {m.categories.map((c) => (
          <div className="am-metric-line" key={c.key} data-mm-category={c.key} data-mm-available={c.available ? "yes" : "no"}>
            <div className="am-metric-label">{c.label}</div>
            <span className={c.available ? "am-metric-number" : "mm-unavailable"}>{c.value}</span>
          </div>
        ))}
      </section>

      <section className="am-rail-section" aria-labelledby="mm-funnel-h">
        <div className="am-rail-heading">
          <h2 id="mm-funnel-h">Your funnel</h2>
        </div>
        {m.funnel.map((f) => (
          <div className="am-metric-line" key={f.label} data-mm-available={f.available ? "yes" : "no"}>
            <div className="am-metric-label">{f.label}</div>
            <span className={f.available ? "am-metric-number" : "mm-unavailable"}>{f.value}</span>
          </div>
        ))}
      </section>

      <section className="am-rail-section" aria-labelledby="mm-trend-h">
        <div className="am-rail-heading">
          <h2 id="mm-trend-h">Your trend</h2>
        </div>
        {m.trend.map((t) => (
          <div className={`am-metric-line mm-trend-row${t.current ? " is-current" : ""}`} key={t.label}>
            <div className="am-metric-label">{t.label}</div>
            <span className="am-metric-number">{t.score}</span>
          </div>
        ))}
      </section>
      <p className="am-empty-note">Scoring rules {m.rulesVersion}. Weights are proposed and may change.</p>
    </Frame>
  );
}
