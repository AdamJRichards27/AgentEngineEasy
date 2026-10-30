import type { ReactNode } from "react";
import { Link } from "wouter";
import { MINIMAL_PROPERTIES_LIST_HREF, type MinimalPropertyDetailModel } from "./minimalPropertyDetailModel";

// Presentational AE Minimal A property detail. No hooks, no network.

export type MinimalPropertyDetailState =
  | { kind: "loading" }
  | { kind: "error"; text: string; onRetry?: () => void }
  | { kind: "ready"; model: MinimalPropertyDetailModel; relatedError?: string | null; relatedLoading?: boolean; contacts?: ReactNode };

function BackLink() {
  return (
    <Link href={MINIMAL_PROPERTIES_LIST_HREF} className="am-back-link">
      ← Back to Properties
    </Link>
  );
}

export function MinimalPropertyDetailView({ state }: { state: MinimalPropertyDetailState }) {
  if (state.kind === "loading") {
    return (
      <section className="am-data-screen" data-ae-property-detail="minimal">
        <BackLink />
        <p className="am-empty-note" role="status">
          Loading property…
        </p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section className="am-data-screen" data-ae-property-detail="minimal">
        <BackLink />
        <div className="am-rail-section" role="alert">
          <p className="am-switch-error">{state.text}</p>
          {state.onRetry ? (
            <button type="button" className="am-classic-switch" onClick={state.onRetry}>
              Try again
            </button>
          ) : null}
        </div>
      </section>
    );
  }
  const m = state.model;
  return (
    <section className="am-data-screen" data-ae-property-detail="minimal" data-property-id={m.id} aria-labelledby="am-property-detail-title">
      <BackLink />
      <header className="am-data-heading">
        <div>
          <div className="am-eyebrow">Grow · Property</div>
          <h1 id="am-property-detail-title">{m.address}</h1>
          <p>{m.location}</p>
        </div>
        {m.runHref ? (
          <div className="am-data-actions">
            <Link href={m.runHref} className="am-data-button is-quiet">
              Open in Run
            </Link>
          </div>
        ) : null}
      </header>

      <section className="am-rail-section" aria-labelledby="am-property-facts">
        <h2 id="am-property-facts" className="am-eyebrow">
          Record
        </h2>
        <dl className="am-facts">
          <dt>Stage</dt>
          <dd>
            <span className="am-data-pill">{m.stage}</span>
          </dd>
          <dt>Listing status</dt>
          <dd>{m.listingStatus}</dd>
          <dt>Sales method</dt>
          <dd>{m.salesMethod}</dd>
          <dt>Price display</dt>
          <dd>{m.priceDisplay}</dd>
        </dl>
      </section>

      {state.contacts ?? null}

      {state.relatedLoading ? <p className="am-empty-note">Loading appraisals and opportunities…</p> : null}
      {state.relatedError ? (
        <p className="am-switch-error" role="alert">
          {state.relatedError}
        </p>
      ) : null}

      <section className="am-rail-section" aria-labelledby="am-property-appraisals">
        <h2 id="am-property-appraisals" className="am-eyebrow">
          Appraisals
        </h2>
        {m.appraisals.length === 0 ? (
          <p className="am-empty-note">No appraisal yet.</p>
        ) : (
          <ul className="am-agenda">
            {m.appraisals.map((a) => (
              <li key={a.id} className="am-agenda-row" data-appraisal-id={a.id}>
                <div>
                  <Link href={a.href} className="am-agenda-title">
                    Appraisal · {a.statusLabel}
                  </Link>
                  <div className="am-agenda-sub">
                    {a.contact}
                    {a.updated ? ` · Updated ${a.updated}` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="am-rail-section" aria-labelledby="am-property-opportunities">
        <h2 id="am-property-opportunities" className="am-eyebrow">
          Opportunities
        </h2>
        {m.opportunities.length === 0 ? (
          <p className="am-empty-note">No opportunity linked to this property.</p>
        ) : (
          <ul className="am-agenda">
            {m.opportunities.map((o) => (
              <li key={o.id} className="am-agenda-row" data-opportunity-id={o.id}>
                <div>
                  <Link href={o.href} className="am-agenda-title">
                    {o.contact}
                  </Link>
                  <div className="am-agenda-sub">
                    {o.stage}
                    {o.open ? "" : " · Closed"} · <Link href={o.contactHref}>Contact</Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {m.opportunitiesTruncated ? (
          <p className="am-empty-note">
            {m.opportunitiesScope === "property"
              ? "Showing this property's latest 100 opportunities. Older ones are in the full pipeline."
              : "Showing opportunities from your latest 100. Older ones are in the full pipeline."}
          </p>
        ) : null}
      </section>
    </section>
  );
}
