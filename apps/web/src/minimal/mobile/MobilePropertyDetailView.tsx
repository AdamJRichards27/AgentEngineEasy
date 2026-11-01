import { Link } from "wouter";
import { MINIMAL_PROPERTIES_LIST_HREF } from "../properties/minimalPropertyDetailModel";
import type { MinimalPropertyDetailState } from "../properties/MinimalPropertyDetailView";

// AE Mobile (CC Task #64, M5): one property on a phone. Presentational: no hooks, no network.
//
// It takes exactly the state the existing detail container already builds (MinimalPropertyDetailState), so the existing container keeps
// every query and action: Open in Run, the appraisal list, the opportunities, and the contacts slot (which, on a phone, is the mobile
// contacts section: linked contacts with roles and a call button, Start appraisal, link controls). The order is the order an agent needs
// it in: the address, who to call, the appraisal, the opportunities. The property record's four facts are one tap away, not on the
// screen by default.

function Back() {
  return (
    <Link href={MINIMAL_PROPERTIES_LIST_HREF} className="am-back-link mob-p-back">
      ← Properties
    </Link>
  );
}

export function MobilePropertyDetailView({ state }: { state: MinimalPropertyDetailState }) {
  if (state.kind === "loading") {
    return (
      <section className="mob-p" data-ae-property-detail="mobile">
        <Back />
        <p className="mob-p-note" role="status">
          Loading property…
        </p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section className="mob-p" data-ae-property-detail="mobile">
        <Back />
        <div className="mob-p-card" role="alert">
          <p className="mob-p-error">{state.text}</p>
          {state.onRetry ? (
            <button type="button" className="mob-p-button" onClick={state.onRetry}>
              Try again
            </button>
          ) : null}
        </div>
      </section>
    );
  }
  const m = state.model;
  return (
    <section className="mob-p" data-ae-property-detail="mobile" data-property-id={m.id} aria-labelledby="mob-p-detail-title">
      <Back />
      <header className="mob-p-head mob-p-head-detail">
        <div>
          <h1 id="mob-p-detail-title" className="mob-p-title">
            {m.address}
          </h1>
          <p className="mob-p-sub">
            {m.location} <span className="mob-p-pill">{m.stage}</span>
          </p>
        </div>
        {m.runHref ? (
          <Link href={m.runHref} className="mob-p-button mob-p-run">
            Open in Run
          </Link>
        ) : null}
      </header>

      {state.contacts ?? null}

      {state.relatedLoading ? (
        <p className="mob-p-note" role="status">
          Loading appraisals and opportunities…
        </p>
      ) : null}
      {state.relatedError ? (
        <p className="mob-p-error" role="alert">
          {state.relatedError}
        </p>
      ) : null}

      <section className="mob-p-block" aria-label="Appraisals">
        <h2 className="mob-p-section">Appraisals</h2>
        {m.appraisals.length === 0 ? (
          <p className="mob-p-note">No appraisal yet.</p>
        ) : (
          <ul className="mob-p-rows">
            {m.appraisals.map((a) => (
              <li key={a.id} data-appraisal-id={a.id}>
                <Link href={a.href} className="mob-p-row">
                  <span className="mob-p-row-title">Appraisal · {a.statusLabel}</span>
                  <span className="mob-p-sub">
                    {a.contact}
                    {a.updated ? ` · Updated ${a.updated}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mob-p-block" aria-label="Opportunities">
        <h2 className="mob-p-section">Opportunities</h2>
        {m.opportunities.length === 0 ? (
          <p className="mob-p-note">No opportunity linked to this property.</p>
        ) : (
          <ul className="mob-p-rows">
            {m.opportunities.map((o) => (
              <li key={o.id} data-opportunity-id={o.id} className="mob-p-rowline">
                <Link href={o.href} className="mob-p-row">
                  <span className="mob-p-row-title">{o.contact}</span>
                  <span className="mob-p-sub">
                    {o.stage}
                    {o.open ? "" : " · Closed"}
                  </span>
                </Link>
                <Link href={o.contactHref} className="mob-p-button mob-p-contactlink" aria-label={`Open contact ${o.contact}`}>
                  Contact
                </Link>
              </li>
            ))}
          </ul>
        )}
        {m.opportunitiesTruncated ? (
          <p className="mob-p-note">
            {m.opportunitiesScope === "property"
              ? "Showing this property's latest 100 opportunities. Older ones are in the full pipeline."
              : "Showing opportunities from your latest 100. Older ones are in the full pipeline."}
          </p>
        ) : null}
      </section>

      <details className="mob-p-details">
        <summary className="mob-p-button mob-p-wide">Property record</summary>
        <dl className="mob-p-facts">
          <dt>Stage</dt>
          <dd>{m.stage}</dd>
          <dt>Listing status</dt>
          <dd>{m.listingStatus}</dd>
          <dt>Sales method</dt>
          <dd>{m.salesMethod}</dd>
          <dt>Price display</dt>
          <dd>{m.priceDisplay}</dd>
        </dl>
      </details>
    </section>
  );
}
