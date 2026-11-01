import type { ReactNode } from "react";
import { Link } from "wouter";
import type { MobileTodayHero, MobileTodayLayout, MobileTodayRow } from "./mobileTodayLayout";

// AE Mobile (CC Task #64, M3): the phone Today screen. Presentational: no hooks, no network. The
// container (MobileToday) supplies the data and handlers. Order, top to bottom: search, greeting,
// the one next action, then Overdue and Today, signals, three quiet shortcuts, and one footer line.
// Every row is one tap target that opens that person's record.

export interface MobileTodayViewProps {
  /** The M2 search bar, passed in so this view does not depend on it. */
  searchSlot: ReactNode;
  /** The Grow section bar while its destinations are unverified. Null once it is retired. */
  sectionsSlot: ReactNode;
  dateLabel: string;
  greeting: string;
  loading: boolean;
  error: { text: string; onRetry: () => void } | null;
  layout: MobileTodayLayout | null;
  asOf: string | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  onRefresh: () => void;
}

function Row({ row }: { row: MobileTodayRow }) {
  const body = (
    <>
      <span className="mob-t-avatar" aria-hidden="true">
        {row.initials}
      </span>
      <span className="mob-t-main">
        <span className="mob-t-name">{row.name}</span>
        {row.kind ? <span className="mob-t-kind">{row.kind}</span> : null}
        <span className="mob-t-action">{row.action}</span>
        {row.context ? <span className="mob-t-context">{row.context}</span> : null}
        {row.warning ? <span className="mob-t-warning">{row.warning}</span> : null}
      </span>
      <span className="mob-t-side">
        <span className={`mob-t-when${row.overdue ? " is-overdue" : ""}`}>{row.when}</span>
      </span>
    </>
  );
  if (!row.href) return <div className="mob-t-row mob-t-row-static">{body}</div>;
  return (
    <Link href={row.href} className="mob-t-row" aria-label={`${row.actionLabel ?? "Open"}: ${row.name}. ${row.action}`}>
      {body}
    </Link>
  );
}

function Hero({ hero }: { hero: MobileTodayHero }) {
  const hasDetail = hero.reason !== null || hero.why.length > 0 || hero.notes.length > 0;
  return (
    <article className="mob-t-hero" aria-label="Do this next">
      <div className="mob-t-kicker">
        <span className="mob-t-kicker-label">Do this next</span>
        <span className={`mob-t-when${hero.overdue ? " is-overdue" : ""}`}>{hero.when}</span>
      </div>
      <h2 className="mob-t-hero-name">{hero.name}</h2>
      {hero.context ? <div className="mob-t-context">{hero.context}</div> : null}
      <p className="mob-t-hero-action">{hero.action}</p>
      {hero.warning ? (
        <p className="mob-t-warning" role="alert">
          {hero.warning}
        </p>
      ) : null}
      {hero.href ? (
        <Link href={hero.href} className="mob-t-primary">
          {hero.actionLabel ?? "Open"}
        </Link>
      ) : null}
      {hasDetail ? (
        <details className="mob-t-details">
          <summary>Why this?</summary>
          <div className="mob-t-details-body">
            {hero.reason ? <p>{hero.reason}</p> : null}
            {hero.why.map((item) => (
              <p key={item.label}>
                <span className="mob-t-details-label">{item.label}</span>
                {item.text}
              </p>
            ))}
            {hero.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}

export function MobileTodayView(p: MobileTodayViewProps) {
  const { layout } = p;
  return (
    <div className="mob-t" data-ae-today="mobile">
      {p.searchSlot}
      {p.sectionsSlot}
      <header className="mob-t-head">
        <div className="mob-t-date">{p.dateLabel}</div>
        <h1 className="mob-t-title">{p.greeting}</h1>
      </header>

      {p.loading ? (
        <p className="mob-t-note" role="status">
          Loading today's priorities…
        </p>
      ) : null}
      {p.error ? (
        <div className="mob-t-card" role="alert">
          <p className="mob-t-error">{p.error.text}</p>
          <button type="button" className="mob-t-button" onClick={p.error.onRetry}>
            Try again
          </button>
        </div>
      ) : null}

      {layout ? (
        <>
          {layout.state === "no-data" ? (
            <section className="mob-t-card" aria-label="Get started">
              <h2 className="mob-t-section">Let's find your next opportunity</h2>
              <p className="mob-t-note">Grow turns every appraisal, buyer enquiry, and past client into a tracked relationship and a visible next action.</p>
              <Link href="/grow/import" className="mob-t-primary">
                Import contacts and properties
              </Link>
            </section>
          ) : null}

          {layout.setupSteps.length > 0 ? (
            <section className="mob-t-section-block" aria-label="Getting started">
              <h2 className="mob-t-section">Getting started</h2>
              <div className="mob-t-list">
                {layout.setupSteps.map((step) =>
                  step.href ? (
                    <Link key={step.id} href={step.href} className="mob-t-row">
                      <span className="mob-t-main">
                        <span className="mob-t-name">{step.title}</span>
                        <span className="mob-t-action">{step.hint}</span>
                      </span>
                      <span className="mob-t-side">
                        <span className="mob-t-kind">Import</span>
                      </span>
                    </Link>
                  ) : (
                    <div key={step.id} className="mob-t-row mob-t-row-static">
                      <span className="mob-t-main">
                        <span className="mob-t-name">{step.title}</span>
                        <span className="mob-t-action">{step.hint}</span>
                      </span>
                    </div>
                  ),
                )}
              </div>
            </section>
          ) : null}

          {layout.state === "caught-up" ? (
            <p className="mob-t-card mob-t-note">You're all caught up — nothing needs your attention right now.</p>
          ) : null}

          {layout.hero ? <Hero hero={layout.hero} /> : null}

          {layout.groups.map((group) => (
            <section key={group.key} className="mob-t-section-block" aria-label={group.title}>
              <h2 className="mob-t-section">{group.title}</h2>
              <div className="mob-t-list">
                {group.rows.map((row) => (
                  <Row key={row.id} row={row} />
                ))}
              </div>
            </section>
          ))}
          {layout.totalRows > 0 && (layout.hiddenCount > 0 || p.expanded) ? (
            <button type="button" className="mob-t-button" aria-expanded={p.expanded} onClick={p.onToggleExpanded}>
              {p.expanded ? "Show fewer" : `Show all ${layout.totalRows}`}
            </button>
          ) : null}

          {layout.signals.length > 0 ? (
            <section className="mob-t-section-block" aria-label="Signals">
              <h2 className="mob-t-section">Signals</h2>
              <div className="mob-t-list">
                {layout.signals.map((row) => (
                  <Row key={row.id} row={row} />
                ))}
              </div>
              {layout.signalsNote ? <p className="mob-t-note">{layout.signalsNote}</p> : null}
            </section>
          ) : null}

          {layout.shortcuts.length > 0 ? (
            <section className="mob-t-section-block" aria-label="Shortcuts">
              <h2 className="mob-t-section">Shortcuts</h2>
              <div className="mob-t-list">
                {layout.shortcuts.map((s) => (
                  <Link key={s.key} href={s.href} className="mob-t-row mob-t-shortcut">
                    <span className="mob-t-main">
                      <span className="mob-t-name">{s.label}</span>
                      {s.subtitle ? <span className="mob-t-action">{s.subtitle}</span> : null}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      <div className="mob-t-foot">
        <span>{p.asOf ? `Updated ${p.asOf}` : ""}</span>
        <button type="button" className="mob-t-link" onClick={p.onRefresh}>
          Refresh
        </button>
      </div>
    </div>
  );
}
