import { Link } from "wouter";
import type { PickerRow } from "./useLinkPicker";
import type { DuplicateContactWarning } from "./mobileLinking";

// AE Mobile (CC Task #64, M4 linking): choose an existing property or contact, say how they relate, and link them.
// Presentational: no hooks, no network. The agent searches, taps one result (nothing is pre-selected), chooses the
// relationship (nothing defaults), and only then can Link be pressed. It links an EXISTING record: there is no
// "create" here, so a duplicate contact or property cannot be made from this panel.

/** The existing panel's "Add new contact": Name, Email, Phone, POST /grow/contacts, then the new contact is selected for linking. */
export interface PickerCreateProps {
  open: boolean;
  name: string;
  email: string;
  phone: string;
  creating: boolean;
  error: string | null;
  /**
   * After a 409 duplicate. ONE warning with up to three actions, whatever the user may see:
   *  - "Open existing contact": only when the server revealed the contact's id (it does so only to a caller with contact-read), so `existingHref` is set;
   *  - "Use <name>" (link the existing contact): only when `onUseExisting` is given, i.e. the user may manage relationships AND the id is known;
   *  - "Create anyway": always.
   * Without an id nothing about the existing contact is shown: no name, no id, no link.
   */
  duplicate?: DuplicateContactWarning | null;
  /** The existing contact's name once known (only ever fetched when the id was revealed). */
  duplicateName?: string | null;
  onUseExisting?: (() => void) | null;
  onCreateAnyway?: () => void;
  onOpen: () => void;
  onField: (field: "name" | "email" | "phone", value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export interface MobileLinkPickerProps {
  /** Present only where creating a contact is allowed (a contact picker, with grow.contacts.manage). */
  create?: PickerCreateProps | null;
  /** A contact just created in this panel: listed first, selected through the same tap. */
  createdRow?: PickerRow | null;
  title: string;
  searchLabel: string;
  searchPlaceholder: string;
  query: string;
  rows: PickerRow[];
  /** A short query, no results, or a failed search, in plain words. */
  message: string | null;
  loading: boolean;
  selectedId: number | null;
  choiceLabel: string;
  choices: Array<{ value: string; label: string }>;
  choice: string;
  submitLabel: string;
  submitting: boolean;
  error: string | null;
  onQuery: (text: string) => void;
  onSelect: (id: number) => void;
  onChoice: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function MobileLinkPicker(p: MobileLinkPickerProps) {
  const ready = p.selectedId !== null && p.choice !== "" && !p.submitting;
  return (
    <form
      className="mob-c-card mob-c-form"
      aria-label={p.title}
      onSubmit={(event: { preventDefault: () => void }) => {
        event.preventDefault();
        if (ready) p.onSubmit();
      }}
    >
      <h2 className="mob-c-section">{p.title}</h2>
      <label className="mob-c-label">
        {p.searchLabel}
        <input
          type="search"
          className="mob-c-input"
          aria-label={p.searchLabel}
          placeholder={p.searchPlaceholder}
          autoComplete="off"
          value={p.query}
          onChange={(event: { target: { value: string } }) => p.onQuery(event.target.value)}
        />
      </label>
      {p.loading ? (
        <p className="mob-c-note" role="status">
          Searching…
        </p>
      ) : null}
      {p.message ? (
        <p className="mob-c-note" role="status">
          {p.message}
        </p>
      ) : null}
      {p.rows.length > 0 || p.createdRow ? (
        <div className="mob-c-list" role="listbox" aria-label="Results">
          {[...(p.createdRow ? [p.createdRow] : []), ...p.rows].map((row) => (
            <button
              key={row.id}
              type="button"
              role="option"
              aria-selected={p.selectedId === row.id}
              className={`mob-c-pick${p.selectedId === row.id ? " is-selected" : ""}`}
              onClick={() => p.onSelect(row.id)}
            >
              <span className="mob-c-row-title">{row.title}</span>
              {row.subtitle ? <span className="mob-c-row-sub">{row.subtitle}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {p.create ? (
        p.create.open ? (
          <div className="mob-c-card mob-c-form" data-ae-new-contact-form>
            <h3 className="mob-c-section">New contact</h3>
            <label className="mob-c-label">
              Name
              <input className="mob-c-input" aria-label="Name" autoComplete="off" value={p.create.name} onChange={(event: { target: { value: string } }) => p.create?.onField("name", event.target.value)} />
            </label>
            <label className="mob-c-label">
              Email
              <input className="mob-c-input" aria-label="Email" type="email" autoComplete="off" value={p.create.email} onChange={(event: { target: { value: string } }) => p.create?.onField("email", event.target.value)} />
            </label>
            <label className="mob-c-label">
              Phone
              <input className="mob-c-input" aria-label="Phone" type="tel" autoComplete="off" value={p.create.phone} onChange={(event: { target: { value: string } }) => p.create?.onField("phone", event.target.value)} />
            </label>
            {p.create.error ? (
              <p className="mob-c-warning" role="alert">
                {p.create.error}
              </p>
            ) : null}
            {p.create.duplicate ? (
              <div className="mob-c-warning" role="alert" data-ae-duplicate-warning>
                <p>
                  {p.create.duplicate.existingContactId !== null && p.create.duplicateName ? `${p.create.duplicateName} is already a contact with that email or phone.` : p.create.duplicate.text}
                  {p.create.duplicate.existingContactId !== null ? <span data-ae-existing-contact-id> Contact #{p.create.duplicate.existingContactId}.</span> : null}
                </p>
                <div className="mob-c-form-actions">
                  {p.create.duplicate.existingHref ? (
                    <Link href={p.create.duplicate.existingHref} className="mob-c-button" data-ae-open-existing-contact>
                      Open existing contact
                    </Link>
                  ) : null}
                  {p.create.onUseExisting && p.create.duplicate.existingContactId !== null ? (
                    <button type="button" className="mob-c-primary" data-ae-use-existing onClick={p.create.onUseExisting}>
                      {p.create.duplicateName ? `Use ${p.create.duplicateName}` : "Use existing contact"}
                    </button>
                  ) : null}
                  <button type="button" className="mob-c-button" data-ae-create-anyway disabled={p.create.creating} onClick={p.create.onCreateAnyway}>
                    Create anyway
                  </button>
                </div>
              </div>
            ) : null}
            <div className="mob-c-form-actions">
              <button type="button" className="mob-c-primary" disabled={p.create.creating || p.create.duplicate != null} onClick={p.create.onSubmit}>
                {p.create.creating ? "Creating…" : "Create contact"}
              </button>
              <button type="button" className="mob-c-button" onClick={p.create.onCancel}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="mob-c-button mob-c-wide" data-ae-new-contact onClick={p.create.onOpen}>
            Add new contact
          </button>
        )
      ) : null}
      <label className="mob-c-label">
        {p.choiceLabel}
        <select className="mob-c-input" aria-label={p.choiceLabel} value={p.choice} onChange={(event: { target: { value: string } }) => p.onChoice(event.target.value)}>
          <option value="">Choose…</option>
          {p.choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {p.error ? (
        <p className="mob-c-warning" role="alert">
          {p.error}
        </p>
      ) : null}
      <div className="mob-c-form-actions">
        <button type="submit" className="mob-c-primary" disabled={!ready}>
          {p.submitting ? "Linking…" : p.submitLabel}
        </button>
        <button type="button" className="mob-c-button" onClick={p.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
