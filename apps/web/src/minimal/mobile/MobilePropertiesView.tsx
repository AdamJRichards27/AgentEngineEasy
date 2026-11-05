import { Link } from "wouter";
import type { AddPropertyForm, MinimalPropertiesViewProps } from "../properties/MinimalPropertiesView";

// AE Mobile (CC Task #64, M5): the Properties list on a phone. Presentational: no hooks, no network.
//
// It takes exactly the props the existing Properties page already produces (MinimalPropertiesViewProps), so the existing container keeps
// every query and every action: search, Add Property (Run flow or the Grow-only form), Create / Open Appraisal with the contact chooser,
// and the open-opportunity count. Only the layout is different: one tap target per property, the information an agent scans for (address,
// suburb, stage, appraisal), and nothing else. The desktop page's heading sentence, its explanatory banner and its record count are not
// repeated on a phone.

function AddPropertyPanel({ form }: { form: AddPropertyForm }) {
  return (
    <form
      className="mob-p-form"
      aria-label="Add property"
      onSubmit={(event: { preventDefault: () => void; currentTarget: unknown }) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget as HTMLFormElement);
        const v = (k: string) => String(data.get(k) ?? "").trim() || undefined;
        const formattedAddress = v("formattedAddress");
        if (!formattedAddress) return;
        form.onSubmit({ formattedAddress, suburb: v("suburb"), state: v("state"), postcode: v("postcode") });
      }}
    >
      <label className="mob-p-label">
        Address
        <input name="formattedAddress" required autoComplete="off" className="mob-p-input" />
      </label>
      <label className="mob-p-label">
        Suburb
        <input name="suburb" autoComplete="off" className="mob-p-input" />
      </label>
      <div className="mob-p-pair">
        <label className="mob-p-label">
          State
          <input name="state" autoComplete="off" className="mob-p-input" />
        </label>
        <label className="mob-p-label">
          Postcode
          <input name="postcode" inputMode="numeric" autoComplete="off" className="mob-p-input" />
        </label>
      </div>
      {form.error ? (
        <p className="mob-p-error" role="alert">
          {form.error}
        </p>
      ) : null}
      <div className="mob-p-actions">
        <button type="submit" className="mob-p-primary" disabled={form.saving}>
          {form.saving ? "Saving…" : "Save property"}
        </button>
        <button type="button" className="mob-p-button" onClick={form.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function MobilePropertiesView(p: MinimalPropertiesViewProps) {
  const query = p.search.trim();
  return (
    <section className="mob-p" data-ae-properties="mobile" aria-labelledby="mob-p-title">
      <header className="mob-p-head">
        <h1 id="mob-p-title" className="mob-p-title">
          Properties
        </h1>
        {p.runAccess ? (
          <Link href="/properties/start" className="mob-p-primary mob-p-add">
            Add property
          </Link>
        ) : (
          <button type="button" className="mob-p-primary mob-p-add" onClick={p.onOpenAddProperty}>
            Add property
          </button>
        )}
      </header>

      {!p.runAccess && p.addForm?.open ? <AddPropertyPanel form={p.addForm} /> : null}

      <input type="search" className="mob-p-search" value={p.search} onChange={(event: { target: { value: string } }) => p.onSearch(event.target.value)} placeholder="Search address, suburb or postcode" aria-label="Search properties" autoComplete="off" />

      {p.loading ? (
        <p className="mob-p-note" role="status">
          Loading properties…
        </p>
      ) : null}
      {p.error ? (
        <div className="mob-p-card" role="alert">
          <p className="mob-p-error">{p.error}</p>
          <button type="button" className="mob-p-button" onClick={p.onRetry}>
            Try again
          </button>
        </div>
      ) : null}
      {!p.loading && !p.error && p.cards.length === 0 ? <p className="mob-p-note">{query ? "No properties match." : "No properties yet. Add one to get started."}</p> : null}

      <div className="mob-p-list" role="list">
        {p.cards.map((card) => (
          <article className="mob-p-card" role="listitem" key={card.id} data-property-id={card.id}>
            <Link href={card.href} className="mob-p-open" aria-label={`Open ${card.address}`}>
              <span className="mob-p-address">{card.address}</span>
              <span className="mob-p-sub">{card.location}</span>
              <span className="mob-p-meta">
                <span className="mob-p-pill">{card.stage}</span>
                <span>{card.appraisal ? `Appraisal · ${card.appraisal.statusLabel}` : "No appraisal yet"}</span>
                {card.openOpportunityCount > 0 ? <span>{`${card.openOpportunityCount} open opportunit${card.openOpportunityCount === 1 ? "y" : "ies"}`}</span> : null}
              </span>
            </Link>

            {p.notice && p.notice.propertyId === card.id ? (
              <p className="mob-p-note" role="status">
                {p.notice.text}
                {p.notice.href ? (
                  <>
                    {" "}
                    <Link href={p.notice.href} className="mob-p-inline">
                      {p.notice.hrefLabel ?? "Open"}
                    </Link>
                  </>
                ) : null}
              </p>
            ) : null}

            {p.chooser && p.chooser.propertyId === card.id ? (
              <fieldset className="mob-p-chooser" aria-label="Choose the contact for this appraisal">
                <legend>Who is this appraisal for?</legend>
                {p.chooser.choices.map((c) => (
                  <button key={c.partyId} type="button" className="mob-p-button" disabled={p.pendingPropertyId === card.id} onClick={() => p.onChooseContact(card.id, c.partyId)}>
                    {c.label}
                  </button>
                ))}
                <button type="button" className="mob-p-button" onClick={p.onCancelChooser}>
                  Cancel
                </button>
              </fieldset>
            ) : null}

            {p.canCreateAppraisal ? (
              <button type="button" className="mob-p-button mob-p-appraisal" data-appraisal-property={card.id} disabled={p.pendingPropertyId === card.id} onClick={() => p.onCreateAppraisal(card.id)}>
                {card.appraisal && !card.appraisal.closed ? "Open appraisal" : "Create appraisal"}
              </button>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
