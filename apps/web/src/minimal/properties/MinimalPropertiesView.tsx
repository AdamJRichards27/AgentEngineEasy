import { Link } from "wouter";
import type { MinimalPropertyCard } from "./minimalPropertiesModel";

// Presentational AE Minimal A Properties (UX a49f7717 Minimal.tsx properties
// workspace, am-data-* classes from minimal.css). No hooks, no network.

export interface PropertyChooser {
  propertyId: number;
  choices: { partyId: number; label: string }[];
}

export interface MinimalPropertiesViewProps {
  cards: MinimalPropertyCard[];
  search: string;
  loading: boolean;
  error: string | null;
  notice: { propertyId: number; text: string; href?: string; hrefLabel?: string } | null;
  chooser: PropertyChooser | null;
  pendingPropertyId: number | null;
  canCreateAppraisal: boolean;
  /** run.access (D5): the property link opens the Run property workspace. */
  runAccess: boolean;
  onSearch(text: string): void;
  onCreateAppraisal(propertyId: number): void;
  onChooseContact(propertyId: number, partyId: number): void;
  onCancelChooser(): void;
  onRetry(): void;
}

export function MinimalPropertiesView(p: MinimalPropertiesViewProps) {
  const query = p.search.trim();
  return (
    <section className="am-data-screen" data-ae-properties="minimal" aria-labelledby="am-properties-title">
      <header className="am-data-heading">
        <div>
          <div className="am-eyebrow">Grow · Properties</div>
          <h1 id="am-properties-title">Every property has a place.</h1>
          <p>Property records in your brokerage, with their appraisal and open opportunities.</p>
        </div>
        <div className="am-data-actions">
          <Link href="/properties/start" className="am-data-button is-primary">
            Add Property
          </Link>
        </div>
      </header>
      <div className="am-data-banner">
        <span>
          <strong>Stand-alone records, not assumed leads.</strong> An address alone does not confirm ownership or seller intent. No property-data provider is connected.
        </span>
      </div>
      <div className="am-data-toolbar">
        <label className="am-data-search">
          <input
            type="search"
            value={p.search}
            onChange={(e) => p.onSearch(e.target.value)}
            placeholder="Search address, suburb or postcode"
            aria-label="Search properties"
          />
        </label>
        <span className="am-data-count">
          {p.cards.length} property record{p.cards.length === 1 ? "" : "s"}
        </span>
      </div>
      {p.loading ? <p className="am-empty-note">Loading properties…</p> : null}
      {p.error ? (
        <div className="am-rail-section" role="alert">
          <p className="am-switch-error">{p.error}</p>
          <button type="button" className="am-classic-switch" onClick={p.onRetry}>
            Try again
          </button>
        </div>
      ) : null}
      {!p.loading && !p.error && p.cards.length === 0 ? (
        <p className="am-data-empty">{query ? "No properties match." : "No properties yet. Add one to get started."}</p>
      ) : null}
      <div className="am-data-grid" role="list">
        {p.cards.map((card) => (
          <article className="am-data-card" role="listitem" key={card.id} data-property-id={card.id}>
            <div className="am-data-card-top">
              <div style={{ minWidth: 0 }}>
                <span className="am-data-pill">{card.stage}</span>
                <h2>{card.address}</h2>
                <div className="am-data-card-sub">
                  {card.location} · {card.listingStatus}
                </div>
              </div>
              <Link href={card.href} className="am-data-button is-quiet">
                {p.runAccess ? "Open in Run" : "Details"}
              </Link>
            </div>
            <div className="am-data-card-meta">
              <span>
                {card.appraisal ? (
                  <Link href={card.appraisal.href}>Appraisal · {card.appraisal.statusLabel}</Link>
                ) : (
                  "No appraisal yet"
                )}
              </span>
              <span>
                {card.openOpportunityCount === 0
                  ? "No open opportunity"
                  : `${card.openOpportunityCount} open opportunit${card.openOpportunityCount === 1 ? "y" : "ies"}`}
              </span>
            </div>
            {p.notice && p.notice.propertyId === card.id ? (
              <p className="am-empty-note" role="status">
                {p.notice.text}
                {p.notice.href ? (
                  <>
                    {" "}
                    <Link href={p.notice.href}>{p.notice.hrefLabel ?? "Open"}</Link>
                  </>
                ) : null}
              </p>
            ) : null}
            {p.chooser && p.chooser.propertyId === card.id ? (
              <fieldset className="am-data-inline" aria-label="Choose the contact for this appraisal">
                <legend>Who is this appraisal for?</legend>
                {p.chooser.choices.map((c) => (
                  <button
                    key={c.partyId}
                    type="button"
                    className="am-data-button is-quiet"
                    disabled={p.pendingPropertyId === card.id}
                    onClick={() => p.onChooseContact(card.id, c.partyId)}
                  >
                    {c.label}
                  </button>
                ))}
                <button type="button" className="am-data-button is-quiet" onClick={p.onCancelChooser}>
                  Cancel
                </button>
              </fieldset>
            ) : null}
            <div className="am-data-card-footer am-property-card-footer">
              <span>Property record</span>
              <span className="am-card-actions am-property-card-actions">
                {p.canCreateAppraisal ? (
                  <button
                    type="button"
                    className="am-property-appraisal-action"
                    data-appraisal-property={card.id}
                    disabled={p.pendingPropertyId === card.id}
                    onClick={() => p.onCreateAppraisal(card.id)}
                  >
                    {card.appraisal && !card.appraisal.closed ? "Open Appraisal" : "Create Appraisal"}
                  </button>
                ) : null}
              </span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
