import { Link } from "wouter";
import AppraisalBrandingCard from "../../components/branding/AppraisalBrandingCard";
import { appraisalPricingLockedMessage, appraisalReadOnlyMessage, formatAppraisalDate, formatAppraisalDateTime, formatAppraisalMoney } from "../../lib/appraisalUi";
import { appraisalStatusLabel } from "../../lib/growAppraisals";
import { SAVE_DUE_FOLLOW_UP_LABEL } from "../../lib/growTerms";
import {
  builderStepsSaved,
  APPRAISAL_BUILDER_DISCLAIMER,
  BUILDER_NO_ATTESTATIONS_NOTE,
  MINIMAL_APPRAISAL_STEPS,
  MINIMAL_APPRAISAL_STEP_COUNT,
  RANGE_RATIONALE_MIN,
  type BuilderState,
  type BuilderWorkspace,
  type ComparableForm,
  type CompetitionForm,
  type RangeDraft,
  parseMoney,
  rangeIsSaved,
  rangeValidation,
} from "./appraisalBuilderModel";

// Presentational AE Minimal A Appraisal Builder (UX a49f7717 AppraisalBuilder.tsx
// markup and ae-appraisal-* classes). No hooks and no network: the page
// container (MinimalAppraisalBuilder.tsx) owns state and the existing API calls.
// Rendered as a plain function call in tests.

export interface FollowUpForm {
  date: string;
  time: string;
  notes: string;
}

export interface BuilderHandlers {
  continueStep(): void;
  back(): void;
  goTo(step: number): void;
  setRange(patch: Partial<RangeDraft>): void;
  saveRange(): void;
  setComparable(patch: Partial<ComparableForm>): void;
  addComparable(): void;
  removeComparable(id: number): void;
  setCompetition(patch: Partial<CompetitionForm>): void;
  addCompetition(): void;
  removeCompetition(id: number): void;
  setNarrative(text: string): void;
  saveNarrative(): void;
  buildPreview(): void;
  setFollowUp(patch: Partial<FollowUpForm>): void;
  saveFollowUp(): void;
}

export interface BuilderSubject {
  address: string;
  location: string | null;
  propertyHref: string;
  contactName: string | null;
  contactHref: string | null;
}

export interface BuilderViewProps {
  workspace: BuilderWorkspace;
  subject: BuilderSubject;
  state: BuilderState;
  rangeDraft: RangeDraft;
  narrativeDraft: string;
  comparableForm: ComparableForm;
  competitionForm: CompetitionForm;
  followUpForm: FollowUpForm;
  message: string | null;
  notice: string | null;
  busy: boolean;
  /** grow.opportunities.manage — the entitlement the write routes require. */
  canWrite: boolean;
  /** run.access (D5): the subject property link opens the Run property workspace. */
  runAccess: boolean;
  on: BuilderHandlers;
}

function money(value: string | null): string {
  return formatAppraisalMoney(value) ?? "Not recorded";
}

function field(label: string, value: string, onChange: (v: string) => void, opts: { disabled: boolean; type?: string; hint?: string; required?: boolean; multiline?: boolean } ) {
  return (
    <label className="ae-appraisal-label" key={label}>
      {label}
      {opts.required ? " *" : ""}
      {opts.multiline ? (
        <textarea value={value} disabled={opts.disabled} onChange={(e) => onChange(e.target.value)} aria-label={label} />
      ) : (
        <input type={opts.type ?? "text"} value={value} disabled={opts.disabled} onChange={(e) => onChange(e.target.value)} aria-label={label} />
      )}
      {opts.hint ? <span className="ae-appraisal-form-hint">{opts.hint}</span> : null}
    </label>
  );
}

function reviewOnlyNote(text: string) {
  return (
    <p className="ae-appraisal-fineprint" role="note">
      {text} Nothing on this step is recorded as an attestation.
    </p>
  );
}

function stepPropertyBody(p: BuilderViewProps) {
  return (
    <div className="ae-appraisal-step-body" data-step="property">
      <div className="ae-appraisal-save-summary">
        <div>
          <span>Subject property</span>
          <strong>{p.subject.address}</strong>
          <small>{p.subject.location ?? "Location not recorded"}</small>
        </div>
        <div>
          <span>Contact</span>
          <strong>{p.subject.contactName ?? "No contact linked"}</strong>
          <small>{p.subject.contactName ? "Linked on the server appraisal" : "Start appraisals from a contact or a property with a linked contact."}</small>
        </div>
        <div>
          <span>Status</span>
          <strong>{appraisalStatusLabel(p.workspace.appraisal.status)}</strong>
          <small>Saved in AE as you go. There is no separate browser draft.</small>
        </div>
      </div>
      <p className="ae-appraisal-fineprint">
        To appraise a different property, start from that property's card or the contact's record. AE keeps one appraisal per property.
      </p>
    </div>
  );
}

function stepEnrichBody(p: BuilderViewProps, locked: boolean) {
  return (
    <div className="ae-appraisal-step-body" data-step="enrich">
      <div className="ae-appraisal-local-notice" role="note">
        No property-data provider is connected. AE records the address only; bedrooms, land area and sale history are not stored on the property, so check them against your own records.
      </div>
      <dl className="ae-appraisal-field-list">
        <div className="ae-appraisal-field-row">
          <dt>Full property address</dt>
          <dd>{p.subject.address}</dd>
        </div>
        <div className="ae-appraisal-field-row">
          <dt>Suburb, state and postcode</dt>
          <dd>{p.subject.location ?? "Not recorded"}</dd>
        </div>
      </dl>
      {reviewOnlyNote("Check these facts against your own records before you rely on them.")}
    </div>
  );
}

function stepComparablesBody(p: BuilderViewProps, locked: boolean) {
  const f = p.comparableForm;
  const set = p.on.setComparable;
  return (
    <div className="ae-appraisal-step-body" data-step="comparables">
      {p.workspace.comparableSales.length === 0 ? (
        <p className="ae-appraisal-empty-inline">No sold comparables yet. Add at least one verified sale.</p>
      ) : (
        <ul className="ae-appraisal-comparable-list" aria-label="Sold comparables">
          {p.workspace.comparableSales.map((c, i) => (
            <li key={c.id} className="ae-appraisal-comparable-card">
              <span className="ae-appraisal-comparable-index">{i + 1}</span>
              <div className="ae-appraisal-comparable-main">
                <strong className="ae-appraisal-comparable-title">{c.address}</strong>
                <span className="ae-appraisal-comp-stats">
                  {money(c.salePrice)} · {formatAppraisalDate(c.saleDate) ?? "Date not recorded"}
                  {c.bedrooms != null ? ` · ${c.bedrooms} bed` : ""}
                  {c.bathrooms != null ? ` · ${c.bathrooms} bath` : ""}
                  {c.carSpaces != null ? ` · ${c.carSpaces} car` : ""}
                </span>
                {c.notes ? <p className="ae-appraisal-comp-note">{c.notes}</p> : null}
              </div>
              <div className="ae-appraisal-comp-actions">
                <button type="button" className="ae-appraisal-quiet-button" disabled={locked || p.busy} onClick={() => p.on.removeComparable(c.id)} aria-label={`Remove ${c.address}`}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <fieldset className="ae-appraisal-manual-comp-form" disabled={locked}>
        <legend>Add a sold comparable</legend>
        <div className="ae-appraisal-form-grid">
          {field("Address", f.address, (v) => set({ address: v }), { disabled: locked, required: true })}
          {field("Sale price", f.salePrice, (v) => set({ salePrice: v }), { disabled: locked, required: true, hint: "Verified price, for example $1,200,000" })}
          {field("Sale date", f.saleDate, (v) => set({ saleDate: v }), { disabled: locked, required: true, type: "date" })}
          {field("Bedrooms", f.bedrooms, (v) => set({ bedrooms: v }), { disabled: locked })}
          {field("Bathrooms", f.bathrooms, (v) => set({ bathrooms: v }), { disabled: locked })}
          {field("Car spaces", f.carSpaces, (v) => set({ carSpaces: v }), { disabled: locked })}
          {field("Land area (m²)", f.landSizeSqm, (v) => set({ landSizeSqm: v }), { disabled: locked })}
          {field("Property type", f.propertyType, (v) => set({ propertyType: v }), { disabled: locked })}
        </div>
        {field("Why it is relevant", f.notes, (v) => set({ notes: v }), { disabled: locked, required: true, multiline: true })}
        <button type="button" className="ae-appraisal-button" disabled={locked || p.busy} onClick={p.on.addComparable}>
          Add comparable
        </button>
      </fieldset>
      <p className="ae-appraisal-fineprint">Distance and map filters need property coordinates, which AE does not store yet.</p>
    </div>
  );
}

function stepCompetitionBody(p: BuilderViewProps, locked: boolean) {
  const f = p.competitionForm;
  const set = p.on.setCompetition;
  return (
    <div className="ae-appraisal-step-body" data-step="competition">
      {p.workspace.marketCompetition.length === 0 ? (
        <p className="ae-appraisal-empty-inline">No current listings recorded.</p>
      ) : (
        <ul className="ae-appraisal-competition-list" aria-label="Current competition">
          {p.workspace.marketCompetition.map((c) => (
            <li key={c.id} className="ae-appraisal-competition-card">
              <strong className="ae-appraisal-competition-title">{c.address}</strong>
              <span>
                {c.askingPriceDisplay ?? "Asking price not recorded"}
                {c.status ? ` · ${c.status}` : ""}
                {c.daysOnMarket != null ? ` · ${c.daysOnMarket} days on market` : ""}
              </span>
              <button type="button" className="ae-appraisal-quiet-button" disabled={locked || p.busy} onClick={() => p.on.removeCompetition(c.id)} aria-label={`Remove ${c.address}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <fieldset className="ae-appraisal-manual-comp-form" disabled={locked}>
        <legend>Add a current listing</legend>
        <div className="ae-appraisal-form-grid">
          {field("Listing address", f.address, (v) => set({ address: v }), { disabled: locked, required: true })}
          {field("Asking price as advertised", f.askingPriceDisplay, (v) => set({ askingPriceDisplay: v }), { disabled: locked })}
          {field("Asking price low", f.askingPriceLow, (v) => set({ askingPriceLow: v }), { disabled: locked })}
          {field("Asking price high", f.askingPriceHigh, (v) => set({ askingPriceHigh: v }), { disabled: locked })}
          {field("Listing status", f.status, (v) => set({ status: v }), { disabled: locked })}
          {field("Days on market", f.daysOnMarket, (v) => set({ daysOnMarket: v }), { disabled: locked })}
        </div>
        {field("Notes", f.notes, (v) => set({ notes: v }), { disabled: locked, multiline: true })}
        <button type="button" className="ae-appraisal-button" disabled={locked || p.busy} onClick={p.on.addCompetition}>
          Add listing
        </button>
      </fieldset>
      {reviewOnlyNote("Asking prices are not sold evidence.")}
    </div>
  );
}

function stepRangeBody(p: BuilderViewProps, pricingLocked: boolean) {
  const invalid = rangeValidation(p.rangeDraft);
  const saved = rangeIsSaved(p.rangeDraft, p.workspace.appraisal);
  return (
    <div className="ae-appraisal-step-body" data-step="range">
      <div className="ae-appraisal-range-evidence">
        <span className="ae-appraisal-eyebrow">Evidence</span>
        <p>
          {p.workspace.comparableSales.length} sold comparable{p.workspace.comparableSales.length === 1 ? "" : "s"} · {p.workspace.marketCompetition.length} current listing
          {p.workspace.marketCompetition.length === 1 ? "" : "s"}
        </p>
      </div>
      <div className="ae-appraisal-range-entry">
        <div className="ae-appraisal-range-inputs">
          {field("Low range ($)", p.rangeDraft.low, (v) => p.on.setRange({ low: v }), { disabled: pricingLocked, required: true })}
          <span aria-hidden="true">to</span>
          {field("High range ($)", p.rangeDraft.high, (v) => p.on.setRange({ high: v }), { disabled: pricingLocked, required: true })}
        </div>
        <p className={`ae-appraisal-range-validation${invalid ? " is-error" : ""}`} aria-live="polite">
          {invalid ?? `${money(String(parseMoney(p.rangeDraft.low)))} – ${money(String(parseMoney(p.rangeDraft.high)))} · low ≤ high`}
        </p>
        {field("Why does this range fit the evidence?", p.rangeDraft.commentary, (v) => p.on.setRange({ commentary: v }), {
          disabled: pricingLocked,
          required: true,
          multiline: true,
          hint: `At least ${RANGE_RATIONALE_MIN} characters, from your evidence.`,
        })}
        <div className="ae-appraisal-range-actions">
          <button type="button" className="ae-appraisal-button" disabled={pricingLocked || p.busy || invalid !== null || saved} onClick={p.on.saveRange}>
            {saved ? "Range saved" : "Save range"}
          </button>
          <span>{saved ? "Saved in AE. This range stays agent-prepared and preliminary." : "Save the range and explanation before continuing."}</span>
        </div>
      </div>
      <div className="ae-appraisal-preliminary-note">
        <span>
          <strong>Not a formal valuation.</strong> The range is agent-prepared market advice. Nothing is sent from this step.
        </span>
      </div>
    </div>
  );
}

function stepBuildBody(p: BuilderViewProps, locked: boolean) {
  const a = p.workspace.appraisal;
  return (
    <div className="ae-appraisal-step-body" data-step="build">
      {field("Market commentary", p.narrativeDraft, p.on.setNarrative, { disabled: locked, multiline: true })}
      <button
        type="button"
        className="ae-appraisal-button"
        disabled={locked || p.busy || p.narrativeDraft.trim() === (a.marketPositionNarrative ?? "").trim()}
        onClick={p.on.saveNarrative}
      >
        Save commentary
      </button>
      <article className="ae-appraisal-document" aria-label="Document preview">
        <header className="ae-appraisal-document-header">
          <span className="ae-appraisal-document-tag">Agent-prepared market appraisal</span>
          <h3 className="ae-appraisal-document-title">{p.subject.address}</h3>
        </header>
        <section className="ae-appraisal-document-range">
          <span>Appraisal range</span>
          <strong>
            {money(a.priceRangeLow)} – {money(a.priceRangeHigh)}
          </strong>
        </section>
        <section className="ae-appraisal-document-section">
          <p>{a.pricingCommentary ?? "No range explanation saved."}</p>
          <p>{a.marketPositionNarrative ?? "No market commentary saved."}</p>
        </section>
        <footer className="ae-appraisal-document-footer">{APPRAISAL_BUILDER_DISCLAIMER}</footer>
      </article>
      <div className="ae-appraisal-document-actions">
        {a.presentationDocumentId != null ? (
          <span className="ae-appraisal-approval-pill is-approved">Document preview built</span>
        ) : null}
        <button type="button" className="ae-appraisal-button is-primary" disabled={locked || p.busy} onClick={p.on.buildPreview}>
          {a.presentationDocumentId != null ? "Rebuild document preview" : "Build document preview"}
        </button>
      </div>
      <AppraisalBrandingCard appraisalId={a.id} canWrite={!locked} />
    </div>
  );
}

function stepSaveBody(p: BuilderViewProps, locked: boolean) {
  const a = p.workspace.appraisal;
  const f = p.followUpForm;
  return (
    <div className="ae-appraisal-step-body" data-step="save">
      <div className="ae-appraisal-save-summary">
        <div>
          <span>Subject property</span>
          <strong>{p.subject.address}</strong>
        </div>
        <div>
          <span>Contact</span>
          <strong>{p.subject.contactName ?? "No contact linked"}</strong>
        </div>
        <div>
          <span>Agent-approved range</span>
          <strong>
            {money(a.priceRangeLow)} – {money(a.priceRangeHigh)}
          </strong>
          <small>
            {p.workspace.comparableSales.length} sold comparable{p.workspace.comparableSales.length === 1 ? "" : "s"}
          </small>
        </div>
      </div>
      <div className="ae-appraisal-followup-card">
        <div className="ae-appraisal-followup-heading">
          <span className="ae-appraisal-eyebrow">Due follow-up</span>
          <h3>Set the next step on this appraisal</h3>
          <p>{a.followUpAt ? `Due follow-up set for ${formatAppraisalDateTime(a.followUpAt)} (Brisbane time).` : "No due follow-up set yet."}</p>
        </div>
        <div className="ae-appraisal-form-grid">
          {field("Follow-up date", f.date, (v) => p.on.setFollowUp({ date: v }), { disabled: locked, type: "date", required: true })}
          {field("Time (Brisbane)", f.time, (v) => p.on.setFollowUp({ time: v }), { disabled: locked, type: "time", hint: "Defaults to 9:00 am" })}
        </div>
        {field("Follow-up notes", f.notes, (v) => p.on.setFollowUp({ notes: v }), { disabled: locked, multiline: true })}
      </div>
      <div className="ae-appraisal-final-controls">
        <span>Nothing is emailed or sent to the contact from here.</span>
        <button type="button" className="ae-appraisal-button is-primary" disabled={locked || p.busy || !f.date} onClick={p.on.saveFollowUp}>
          {SAVE_DUE_FOLLOW_UP_LABEL}
        </button>
      </div>
      <p className="ae-appraisal-fineprint">
        Finalising pricing, sending and handing over to Run stay in the full appraisal workspace.{" "}
        <Link href={`/grow/appraisals/${a.id}`}>Open the full appraisal</Link>
      </p>
    </div>
  );
}

export function MinimalAppraisalBuilderView(p: BuilderViewProps) {
  const a = p.workspace.appraisal;
  const readOnly = appraisalReadOnlyMessage(a);
  const locked = readOnly !== null || !p.canWrite;
  const pricingLocked = locked || appraisalPricingLockedMessage(a) !== null;
  const step = p.state.step;
  const saved = builderStepsSaved(p.workspace);
  const def = MINIMAL_APPRAISAL_STEPS[step - 1];
  return (
    <section className="ae-appraisal-workspace ae-appraisal-editor" data-ae-appraisal="minimal" aria-labelledby="ae-appraisal-editor-title">
      <header className="ae-appraisal-editor-heading">
        <div>
          <div className="ae-appraisal-eyebrow">Grow · Appraisals</div>
          <h1 id="ae-appraisal-editor-title">{p.subject.address}</h1>
          <p>{def.summary}</p>
        </div>
        <div className="ae-appraisal-editor-actions">
          <span className="ae-appraisal-saved-status">Saved in AE</span>
          <Link href="/grow/appraisals" className="ae-appraisal-button">
            Leave builder
          </Link>
        </div>
      </header>
      {readOnly || appraisalPricingLockedMessage(a) || !p.canWrite ? (
        <div className="ae-appraisal-privacy-strip" role="note">
          {readOnly ?? appraisalPricingLockedMessage(a) ?? "You can view this appraisal but not change it."}
        </div>
      ) : null}
      <nav className="ae-appraisal-stepper" aria-label="Seven-step appraisal preparation">
        {MINIMAL_APPRAISAL_STEPS.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-current={step === item.n ? "step" : undefined}
            disabled={item.n > p.state.highestStep}
            className={`${step === item.n ? "is-active" : ""}${item.n < step ? " is-done" : ""}${saved[item.n] ? " is-saved" : ""}`}
            data-step-saved={saved[item.n] ? "true" : "false"}
            onClick={() => p.on.goTo(item.n)}
          >
            <span className="ae-appraisal-vh">Step </span>
            <span className="ae-appraisal-step-number">{item.n}</span>
            <span className="ae-appraisal-vh">: </span>
            <span className="ae-appraisal-step-label">{item.short}</span>
          </button>
        ))}
      </nav>
      {p.message ? (
        <div className="ae-appraisal-feedback" role="alert">
          {p.message}
        </div>
      ) : null}
      {p.notice ? (
        <div className="ae-appraisal-saved-banner" role="status">
          {p.notice}
        </div>
      ) : null}
      <div className="ae-appraisal-editor-grid">
        <main className="ae-appraisal-step-panel" aria-labelledby="ae-appraisal-step-title">
          <header className="ae-appraisal-step-heading">
            <div>
              <span>
                STEP {step} OF {MINIMAL_APPRAISAL_STEP_COUNT}
              </span>
              <h2 id="ae-appraisal-step-title" tabIndex={-1}>
                {def.title}
              </h2>
            </div>
            <span className="ae-appraisal-step-count" aria-hidden="true">
              {String(step).padStart(2, "0")} / {String(MINIMAL_APPRAISAL_STEP_COUNT).padStart(2, "0")}
            </span>
          </header>
          {step === 1 && stepPropertyBody(p)}
          {step === 2 && stepEnrichBody(p, locked)}
          {step === 3 && stepComparablesBody(p, locked)}
          {step === 4 && stepCompetitionBody(p, locked)}
          {step === 5 && stepRangeBody(p, pricingLocked)}
          {step === 6 && stepBuildBody(p, locked)}
          {step === 7 && stepSaveBody(p, locked)}
          <footer className="ae-appraisal-step-actions">
            <button type="button" className="ae-appraisal-button" disabled={step === 1} onClick={p.on.back}>
              Back
            </button>
            <span>
              Step {step} of {MINIMAL_APPRAISAL_STEP_COUNT}
            </span>
            {step < MINIMAL_APPRAISAL_STEP_COUNT ? (
              <button type="button" className="ae-appraisal-button is-primary" disabled={p.busy} onClick={p.on.continueStep}>
                {step === 6 ? "Continue to save" : "Continue"}
              </button>
            ) : (
              <span />
            )}
          </footer>
        </main>
        <aside className="ae-appraisal-context-rail" aria-label="Appraisal context">
          <section className="ae-appraisal-context-card">
            <div className="ae-appraisal-context-heading">
              <h3>Subject</h3>
            </div>
            <strong>{p.subject.address}</strong>
            <p>{p.subject.location ?? "Location not recorded"}</p>
            <Link href={p.subject.propertyHref}>{p.runAccess ? "Open in Run" : "Open property"}</Link>
          </section>
          <section className="ae-appraisal-context-card">
            <div className="ae-appraisal-context-heading">
              <h3>Relationship</h3>
            </div>
            <strong>{p.subject.contactName ?? "No contact linked"}</strong>
            {p.subject.contactHref ? <Link href={p.subject.contactHref}>Open contact</Link> : null}
          </section>
          <section className="ae-appraisal-context-card ae-appraisal-context-summary">
            <div className="ae-appraisal-context-heading">
              <h3>Saved in AE</h3>
            </div>
            <div>
              <span>Sold evidence</span>
              <strong>{p.workspace.comparableSales.length}</strong>
            </div>
            <div>
              <span>Current range</span>
              <strong>
                {a.priceRangeLow && a.priceRangeHigh ? `${money(a.priceRangeLow)}–${money(a.priceRangeHigh)}` : "Not entered"}
              </strong>
            </div>
            <div>
              <span>Current listings</span>
              <strong>{p.workspace.marketCompetition.length}</strong>
            </div>
            <div>
              <span>Document preview</span>
              <strong>{a.presentationDocumentId != null ? "Built" : "Not built"}</strong>
            </div>
          </section>
          <section className="ae-appraisal-context-card ae-appraisal-provenance-card">
            <p>{APPRAISAL_BUILDER_DISCLAIMER}</p>
            <p>{BUILDER_NO_ATTESTATIONS_NOTE}</p>
          </section>
        </aside>
      </div>
    </section>
  );
}

export function MinimalAppraisalBuilderMessage({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <section className="ae-appraisal-workspace" data-ae-appraisal="minimal">
      <Link href="/grow/appraisals" className="ae-appraisal-quiet-button">
        ← Back to Appraisals
      </Link>
      <div className="ae-appraisal-feedback" role="alert">
        {text}
      </div>
      {onRetry ? (
        <button type="button" className="ae-appraisal-button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </section>
  );
}
