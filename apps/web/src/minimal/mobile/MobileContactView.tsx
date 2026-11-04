import { ALSO_LISTED_LABEL, GROW_INTEREST_NOTE, GROW_INTEREST_TITLE } from "./mobileGrowInterest";
import type { ReactNode } from "react";
import { Link } from "wouter";
import { CallReturnPrompt } from "./CallReturnPrompt";
import { MobileLinkPicker, type MobileLinkPickerProps } from "./MobileLinkPicker";
import type { CallOption, PendingCall } from "./mobileCalling";
import { formDefinition, type ContactFormField, type ContactFormKind, type ContactFormState } from "./mobileContactForms";
import { NOT_AVAILABLE_YET, unlinkConfirmText, type LinkingCapabilities } from "./mobileLinking";
import type { MobileCommitmentRow, MobileContactLayout } from "./mobileContactLayout";

// AE Mobile (CC Task #64, M4): the phone Contact 360. Presentational: no hooks, no network. The container
// supplies the data and the handlers. Order: who they are, how to reach them, the one next step, the few
// things this phone can do with a verified route, what else is promised, where they are linked, and what has
// happened. Everything else is the full record, one tap away: no button is offered that does not work.

export type ContactLinkPanel = { kind: "link" } | { kind: "edit"; relationshipId: number } | { kind: "unlink"; relationshipId: number };

export interface ContactLinkingProps {
  capabilities: LinkingCapabilities;
  panel: ContactLinkPanel | null;
  /** A failed link, edit or unlink, in plain words. */
  error: string | null;
  submitting: boolean;
  /** The role chosen in the change-role form. */
  roleValue: string;
  /** The roles the phone offers (the server's list, plus Owner, Landlord and Tenant once validated). */
  roleOptions: Array<{ value: string; label: string }>;
  /** The picker, when the Link a property panel is open. */
  picker: MobileLinkPickerProps | null;
  onOpen: (panel: ContactLinkPanel) => void;
  onClose: () => void;
  onRoleChange: (value: string) => void;
  onSubmitRole: () => void;
  onConfirmUnlink: () => void;
  /** Make this link the property's primary contact. Off until the backend supports it. */
  onMakePrimary: (linkId: number) => void;
}

const OFF = { enabled: false, reason: NOT_AVAILABLE_YET };
/** Every link control disabled, for a screen that has not been given the backend's go-ahead. */
export const LINKING_OFF: ContactLinkingProps = {
  capabilities: { contactLinkProperty: OFF, contactEditRole: OFF, contactUnlink: OFF, contactEditPrimary: OFF, contactCanonicalRead: OFF, propertyLinkContact: OFF, propertyUnlink: OFF, propertyEditRole: OFF, propertyEditPrimary: OFF },
  panel: null, error: null, submitting: false, roleValue: "", roleOptions: [], picker: null,
  onOpen: () => {}, onClose: () => {}, onRoleChange: () => {}, onSubmitRole: () => {}, onConfirmUnlink: () => {}, onMakePrimary: () => {},
};

export interface MobileContactViewProps {
  linking: ContactLinkingProps;
  /** A call link was tapped: lets the container remember it, so "Log call" can be offered on return. The link still opens the dialler. */
  onCall?: (option: CallOption) => void;
  /** Set when the agent has come back from a call. Offers Log call; saves nothing. */
  callOffer?: PendingCall | null;
  onLogOffer?: () => void;
  onDismissOffer?: () => void;
  sectionsSlot: ReactNode;
  backHref: string;
  layout: MobileContactLayout;
  historyExpanded: boolean;
  onToggleHistory: () => void;
  /** Try the by-contact request again after a failure (canonical read ON only). */
  onRetryProperties?: () => void;
  form: ContactFormState | null;
  formError: string | null;
  submitting: boolean;
  /** A success or failure line for the last action. */
  notice: { text: string; failed: boolean } | null;
  pendingCommitmentId: number | null;
  onOpenForm: (kind: ContactFormKind, commitmentId?: number) => void;
  onCloseForm: () => void;
  onField: (name: string, value: string) => void;
  onSubmit: () => void;
  onComplete: (commitmentId: number) => void;
}

export function MobileContactMessage({ text, backHref, onRetry }: { text: string; backHref: string; onRetry?: () => void }) {
  return (
    <div className="mob-c" data-ae-contact="mobile">
      <Link href={backHref} className="mob-c-back">
        ← People
      </Link>
      <div className="mob-c-card" role="alert">
        <p className="mob-c-error">{text}</p>
        {onRetry ? (
          <button type="button" className="mob-c-button" onClick={onRetry}>
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Field({ field, value, onField }: { field: ContactFormField; value: string; onField: (name: string, value: string) => void }) {
  const change = (event: { target: { value: string } }) => onField(field.name, event.target.value);
  return (
    <label className="mob-c-label">
      {field.label}
      {field.type === "textarea" ? (
        <textarea className="mob-c-input mob-c-area" rows={4} aria-label={field.label} placeholder={field.hint} value={value} onChange={change} />
      ) : field.type === "select" ? (
        <select className="mob-c-input" aria-label={field.label} value={value} onChange={change}>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input className="mob-c-input" type="datetime-local" aria-label={field.label} value={value} onChange={change} />
      )}
    </label>
  );
}

function CommitmentRow({ row, p }: { row: MobileCommitmentRow; p: MobileContactViewProps }) {
  return (
    <div className="mob-c-row">
      <span className="mob-c-row-main">
        <span className="mob-c-row-title">{row.text}</span>
        <span className={`mob-c-row-sub${row.overdue ? " is-overdue" : ""}`}>{row.dueText}</span>
        {row.context ? <span className="mob-c-row-sub">{row.context}</span> : null}
      </span>
      {p.layout.canLog ? (
        <span className="mob-c-row-actions">
          <button type="button" className="mob-c-button" disabled={p.pendingCommitmentId === row.id} onClick={() => p.onComplete(row.id)}>
            Mark done
          </button>
          <button type="button" className="mob-c-button" onClick={() => p.onOpenForm("reschedule", row.id)}>
            Reschedule
          </button>
        </span>
      ) : null}
    </div>
  );
}

export function MobileContactView(p: MobileContactViewProps) {
  const { layout } = p;
  const next = layout.nextStep;
  const definition = p.form ? formDefinition(p.form.kind) : null;
  return (
    <div className="mob-c" data-ae-contact="mobile">
      {p.sectionsSlot}
      <Link href={p.backHref} className="mob-c-back">
        ← People
      </Link>

      <header className="mob-c-head">
        <span className="mob-c-avatar" aria-hidden="true">
          {layout.initials}
        </span>
        <div className="mob-c-head-main">
          <h1 className="mob-c-title">{layout.name}</h1>
          {layout.roleChips.length > 0 ? (
            <ul className="mob-c-chips" aria-label="Roles">
              {layout.roleChips.map((role) => (
                <li key={role} className="mob-c-chip">
                  {role}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </header>

      <section className="mob-c-card" aria-label="Contact details">
        {layout.call.options.map((option) => (
          <a key={option.href} href={option.href} className="mob-c-call" aria-label={option.aria} onClick={() => p.onCall?.(option)}>
            {option.text}
          </a>
        ))}
        {layout.call.options.length === 0 ? (
          <p className="mob-c-number">{layout.call.unusable ? "No usable phone number recorded" : "No phone number recorded"}</p>
        ) : null}
        <p className="mob-c-email">{layout.email ?? "No email recorded"}</p>
      </section>

      {p.callOffer ? <CallReturnPrompt offer={p.callOffer} onLog={p.onLogOffer} onDismiss={p.onDismissOffer ?? (() => {})} /> : null}


      <section className="mob-c-card mob-c-next" aria-label="Next step">
        <h2 className="mob-c-section">Next step</h2>
        <p className="mob-c-next-title">{next.title}</p>
        {next.detail ? <p className="mob-c-note">{next.detail}</p> : null}
        {next.when ? <p className={`mob-c-when${next.overdue ? " is-overdue" : ""}`}>{next.when}</p> : null}
        {next.primary?.kind === "complete" && next.commitmentId !== null ? (
          <button type="button" className="mob-c-primary" disabled={p.pendingCommitmentId === next.commitmentId} onClick={() => p.onComplete(next.commitmentId as number)}>
            {next.primary.label}
          </button>
        ) : null}
        {next.primary?.kind === "add-commitment" ? (
          <button type="button" className="mob-c-primary" onClick={() => p.onOpenForm("commitment")}>
            {next.primary.label}
          </button>
        ) : null}
        {next.primary?.kind === "full-record" ? (
          <Link href={layout.fullRecordHref} className="mob-c-primary">
            {next.primary.label}
          </Link>
        ) : null}
        {next.secondary && next.commitmentId !== null ? (
          <button type="button" className="mob-c-button" onClick={() => p.onOpenForm("reschedule", next.commitmentId as number)}>
            {next.secondary.label}
          </button>
        ) : null}
      </section>

      {p.notice ? (
        <p className={`mob-c-status${p.notice.failed ? " is-failed" : ""}`} role={p.notice.failed ? "alert" : "status"}>
          {p.notice.text}
        </p>
      ) : null}

      {layout.canLog ? (
        <div className="mob-c-actions">
          <button type="button" className="mob-c-button" onClick={() => p.onOpenForm("note")}>
            Add a note
          </button>
          <button type="button" className="mob-c-button" onClick={() => p.onOpenForm("call")}>
            Log a call or meeting
          </button>
          <button type="button" className="mob-c-button" onClick={() => p.onOpenForm("commitment")}>
            Add a commitment
          </button>
          <Link href={layout.fullRecordHref} className="mob-c-button">
            Open full record
          </Link>
        </div>
      ) : (
        <Link href={layout.fullRecordHref} className="mob-c-button mob-c-wide">
          Open full record
        </Link>
      )}

      {p.form && definition ? (
        <form
          className="mob-c-card mob-c-form"
          aria-label={definition.title}
          onSubmit={(event: { preventDefault: () => void }) => {
            event.preventDefault();
            p.onSubmit();
          }}
        >
          <h2 className="mob-c-section">{definition.title}</h2>
          {definition.note ? <p className="mob-c-note">{definition.note}</p> : null}
          {definition.fields.map((field) => (
            <Field key={field.name} field={field} value={p.form?.values[field.name] ?? ""} onField={p.onField} />
          ))}
          {p.formError ? (
            <p className="mob-c-warning" role="alert">
              {p.formError}
            </p>
          ) : null}
          <div className="mob-c-form-actions">
            <button type="submit" className="mob-c-primary" disabled={p.submitting}>
              {p.submitting ? "Saving…" : definition.submitLabel}
            </button>
            <button type="button" className="mob-c-button" onClick={p.onCloseForm}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {layout.commitments.length > 0 ? (
        <section className="mob-c-block" aria-label="Commitments">
          <h2 className="mob-c-section">{next.kind === "commitment" ? "Also promised" : "Commitments"}</h2>
          <div className="mob-c-list">
            {layout.commitments.map((row) => (
              <CommitmentRow key={row.id} row={row} p={p} />
            ))}
          </div>
        </section>
      ) : null}
      {layout.openCommitmentCount === 0 ? <p className="mob-c-note">No open commitments.</p> : null}
      {layout.closedCommitmentCount > 0 ? (
        <p className="mob-c-note">{layout.closedCommitmentCount} completed or cancelled. They are on the full record.</p>
      ) : null}

      <section className="mob-c-block" aria-label="Properties">
        <h2 className="mob-c-section">
          Properties
          {layout.propertiesCount !== null ? <span className="mob-c-count" data-ae-properties-count>{` (${layout.propertiesCount})`}</span> : null}
        </h2>
        {layout.propertiesNotice ? (
          <p className="mob-c-note" role={layout.propertiesState === "error" ? "alert" : "status"} data-ae-properties-notice>
            {layout.propertiesNotice}
            {layout.propertiesState === "error" && p.onRetryProperties ? (
              <>
                {" "}
                <button type="button" className="mob-c-link" onClick={p.onRetryProperties}>
                  Try again
                </button>
              </>
            ) : null}
            {layout.propertiesState === "ready" || layout.propertiesState === "error" ? (
              <>
                {" "}
                <Link href={layout.fullRecordHref} className="mob-c-link">
                  Open full record
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
        {layout.properties.length === 0 ? (
          layout.propertiesState === "legacy" ? (
            <p className="mob-c-note">No active property links.</p>
          ) : layout.propertiesState === "ready" ? (
            <p className="mob-c-note">No property links.</p>
          ) : null
        ) : (
          <div className="mob-c-list">
            {layout.properties.map((prop) => {
              const text = (
                <span className="mob-c-row-main">
                  <span className="mob-c-row-title">{prop.label}</span>
                  <span className="mob-c-row-sub">
                    {prop.relationship}
                    {prop.primary ? " · Primary" : ""}
                  </span>
                </span>
              );
              const lk = p.linking;
              const here = lk.panel !== null && lk.panel.kind !== "link" && lk.panel.relationshipId === prop.key ? lk.panel : null;
              return (
                <div key={prop.key} className="mob-c-linkblock">
                  {prop.href ? (
                    <Link href={prop.href} className="mob-c-row mob-c-link-row" aria-label={`Open ${prop.label}`}>
                      {text}
                    </Link>
                  ) : (
                    <div className="mob-c-row">{text}</div>
                  )}
                  <div className="mob-c-row-actions mob-c-pad">
                    <button type="button" className="mob-c-button" disabled={!lk.capabilities.contactEditRole.enabled || !prop.canonical} onClick={() => lk.onOpen({ kind: "edit", relationshipId: prop.key })}>
                      Edit role
                    </button>
                    <button type="button" className="mob-c-button" disabled={!lk.capabilities.contactUnlink.enabled || !prop.canonical} onClick={() => lk.onOpen({ kind: "unlink", relationshipId: prop.key })}>
                      Unlink
                    </button>
                    {prop.primary ? null : (
                      <button type="button" className="mob-c-button" disabled={!lk.capabilities.contactEditPrimary.enabled || !prop.canonical} onClick={() => lk.onMakePrimary(prop.key)}>
                        Make primary
                      </button>
                    )}
                  </div>
                  {here?.kind === "unlink" ? (
                    <div className="mob-c-card mob-c-confirm" role="alertdialog" aria-label="Confirm unlink">
                      <p className="mob-c-next-title">{unlinkConfirmText(layout.name, prop.label)}</p>
                      {lk.error ? (
                        <p className="mob-c-warning" role="alert">
                          {lk.error}
                        </p>
                      ) : null}
                      <div className="mob-c-form-actions">
                        <button type="button" className="mob-c-primary" disabled={lk.submitting} onClick={lk.onConfirmUnlink}>
                          {lk.submitting ? "Unlinking…" : "Unlink"}
                        </button>
                        <button type="button" className="mob-c-button" onClick={lk.onClose}>
                          Keep link
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {here?.kind === "edit" ? (
                    <form
                      className="mob-c-card mob-c-form"
                      aria-label="Edit role"
                      onSubmit={(event: { preventDefault: () => void }) => {
                        event.preventDefault();
                        lk.onSubmitRole();
                      }}
                    >
                      <label className="mob-c-label">
                        Role
                        <select className="mob-c-input" aria-label="Role" value={lk.roleValue} onChange={(event: { target: { value: string } }) => lk.onRoleChange(event.target.value)}>
                          <option value="">Choose…</option>
                          {lk.roleOptions.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className="mob-c-note">Currently: {prop.relationship}.</p>
                      {lk.error ? (
                        <p className="mob-c-warning" role="alert">
                          {lk.error}
                        </p>
                      ) : null}
                      <div className="mob-c-form-actions">
                        <button type="submit" className="mob-c-primary" disabled={lk.submitting}>
                          {lk.submitting ? "Saving…" : "Save role"}
                        </button>
                        <button type="button" className="mob-c-button" onClick={lk.onClose}>
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        <button type="button" className="mob-c-button mob-c-wide" disabled={!p.linking.capabilities.contactLinkProperty.enabled} onClick={() => p.linking.onOpen({ kind: "link" })}>
          Link a property
        </button>
        {!p.linking.capabilities.contactLinkProperty.enabled || !p.linking.capabilities.contactEditRole.enabled || !p.linking.capabilities.contactUnlink.enabled ? (
          <p className="mob-c-note" id="mob-c-link-reason">
            {p.linking.capabilities.contactLinkProperty.reason ?? p.linking.capabilities.contactEditRole.reason ?? p.linking.capabilities.contactUnlink.reason}
          </p>
        ) : null}
        {p.linking.panel?.kind === "link" && p.linking.picker ? <MobileLinkPicker {...p.linking.picker} /> : null}
      </section>

      {layout.propertiesState === "ready" && layout.interest.length > 0 ? (
        <section className="mob-c-block" aria-label={GROW_INTEREST_TITLE} data-ae-grow-interest>
          <h2 className="mob-c-section">
            {GROW_INTEREST_TITLE}
            <span className="mob-c-count" data-ae-interest-count>{` (${layout.interestCount})`}</span>
          </h2>
          <p className="mob-c-note">{GROW_INTEREST_NOTE}</p>
          {layout.interest.length > 0 ? (
            <div className="mob-c-list">
              {layout.interest.map((row) => {
                const text = (
                  <span className="mob-c-row-main">
                    <span className="mob-c-row-title">{row.label}</span>
                    <span className="mob-c-row-sub">
                      {row.relationship} · {row.kindLabel}
                    </span>
                    {row.alsoListed ? (
                      <span className="mob-c-row-sub" data-ae-also-listed>
                        {ALSO_LISTED_LABEL}
                      </span>
                    ) : null}
                  </span>
                );
                return row.href ? (
                  <Link key={row.key} href={row.href} className="mob-c-row mob-c-link-row" aria-label={`Open ${row.label}`}>
                    {text}
                  </Link>
                ) : (
                  <div key={row.key} className="mob-c-row">
                    {text}
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="mob-c-block" aria-label="History">
        <h2 className="mob-c-section">History</h2>
        {layout.history.length === 0 ? (
          <p className="mob-c-note">No activity recorded.</p>
        ) : (
          <div className="mob-c-list">
            {layout.history.map((h) => (
              <div key={h.id} className="mob-c-row">
                <span className="mob-c-row-main">
                  <span className="mob-c-row-sub">
                    <strong>{h.kind}</strong> · {h.when}
                  </span>
                  <span className="mob-c-row-text">{h.text}</span>
                  {h.context ? <span className="mob-c-row-sub">{h.context}</span> : null}
                </span>
              </div>
            ))}
          </div>
        )}
        {layout.historyHiddenCount > 0 || p.historyExpanded ? (
          <button type="button" className="mob-c-button" aria-expanded={p.historyExpanded} onClick={p.onToggleHistory}>
            {p.historyExpanded ? "Show fewer" : `Show all ${layout.history.length + layout.historyHiddenCount}`}
          </button>
        ) : null}
      </section>
    </div>
  );
}
