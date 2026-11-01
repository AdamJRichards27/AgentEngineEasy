import type { ReactNode } from "react";
import { Link } from "wouter";
import { CallReturnPrompt } from "./CallReturnPrompt";
import type { CallOption, PendingCall } from "./mobileCalling";
import type { ContactCallState, MobileLinkedContact } from "./mobilePropertyContactRows";
import { MobileLinkPicker, type MobileLinkPickerProps } from "./MobileLinkPicker";
import { unlinkConfirmText, type LinkingCapabilities } from "./mobileLinking";

// AE Mobile (CC Task #64, M4 linking): the contacts linked to a property, with their roles, on a phone. Presentational: no hooks,
// no network. Link, change role and unlink are the CANONICAL operations (property_parties), the same ones Contact 360 uses;
// each is shown disabled with its reason until the backend supports it in both directions, and a change appears only after the
// server accepts it. Unlinking asks first.
//
// Start appraisal and Add new contact are the existing panel's functions, preserved. They are not link controls and are not
// behind the link flags: they work as they do on the desktop panel, by their own permissions.

export type PropertyLinkPanel = { kind: "link" } | { kind: "unlink"; linkId: number } | { kind: "role"; linkId: number };

/** The existing "Start appraisal" block: candidates come from the linked contacts; one appraisal per property. */
export interface PropertyAppraisalProps {
  existingHref: string | null;
  candidates: Array<{ partyId: number; name: string }>;
  canStart: boolean;
  starting: boolean;
  error: string | null;
  onStart: (partyId: number) => void;
}

export interface MobilePropertyContactsViewProps {
  propertyLabel: string;
  contacts: MobileLinkedContact[];
  /** Per link: one call button per usable number. A contact with no usable number has none. */
  callState: Record<number, ContactCallState>;
  /** A call link was tapped (the dialler still opens): the container remembers it to offer Log call on return. */
  onCall: (contact: MobileLinkedContact, option: CallOption) => void;
  callOffer: PendingCall | null;
  onDismissOffer: () => void;
  onMakePrimary: (linkId: number) => void;
  /**
   * The existing panel (link a contact, Add new contact), preserved while the canonical link controls are off, so nothing that works today
   * is removed from a phone. Shown inside a disclosure. Omitted once the link controls are on.
   */
  legacyActions?: ReactNode;
  loading: boolean;
  error: { text: string; onRetry: () => void } | null;
  capabilities: LinkingCapabilities;
  panel: PropertyLinkPanel | null;
  submitting: boolean;
  /** A failed link, role change or unlink, in plain words. */
  opError: string | null;
  notice: string | null;
  roleValue: string;
  roleOptions: Array<{ value: string; label: string }>;
  appraisal: PropertyAppraisalProps;
  picker: MobileLinkPickerProps | null;
  onOpen: (panel: PropertyLinkPanel) => void;
  onClose: () => void;
  onRoleChange: (value: string) => void;
  onSubmitRole: () => void;
  onConfirmUnlink: () => void;
}

export function MobilePropertyContactsView(p: MobilePropertyContactsViewProps) {
  const caps = p.capabilities;
  const reason = caps.propertyLinkContact.reason ?? caps.propertyEditRole.reason ?? caps.propertyUnlink.reason ?? null;
  const anyOff = !caps.propertyLinkContact.enabled || !caps.propertyEditRole.enabled || !caps.propertyUnlink.enabled;
  const ap = p.appraisal;
  return (
    <section className="mob-c-block" aria-label="Contacts" data-ae-property-contacts="mobile">
      <h2 className="mob-c-section">Contacts</h2>

      {p.loading ? (
        <p className="mob-c-note" role="status">
          Loading contacts…
        </p>
      ) : null}
      {p.error ? (
        <div className="mob-c-card" role="alert">
          <p className="mob-c-error">{p.error.text}</p>
          <button type="button" className="mob-c-button" onClick={p.error.onRetry}>
            Try again
          </button>
        </div>
      ) : null}
      {p.notice ? (
        <p className="mob-c-status" role="status">
          {p.notice}
        </p>
      ) : null}

      {!p.loading && !p.error && p.contacts.length === 0 ? <p className="mob-c-note">No contact linked yet. Link a contact to start an appraisal.</p> : null}

      {p.contacts.length > 0 ? (
        <div className="mob-c-list">
          {p.contacts.map((c) => (
            <div key={c.linkId} className="mob-c-linkblock">
              <div className="mob-c-contactline">
                <Link href={c.contactHref} className="mob-c-row mob-c-link-row" aria-label={`Open ${c.name}`}>
                  <span className="mob-c-row-main">
                    <span className="mob-c-row-title">
                      {c.name}
                      {c.isPrimary ? <span className="mob-c-primary-chip">Primary</span> : null}
                    </span>
                    <span className="mob-c-row-sub">{c.roleLabel}</span>
                    {c.detail ? <span className="mob-c-row-sub">{c.detail}</span> : null}
                  </span>
                </Link>
                {(p.callState[c.linkId]?.options ?? []).map((option, i, all) => (
                  <a key={option.href} href={option.href} className="mob-c-callbtn" aria-label={option.aria} data-ae-call-contact={c.partyId} onClick={() => p.onCall(c, option)}>
                    {all.length > 1 ? `Call ${option.label.toLowerCase()}` : "Call"}
                  </a>
                ))}
              </div>
              <details className="mob-c-manage" open={p.panel !== null && "linkId" in p.panel && p.panel.linkId === c.linkId}>
                <summary className="mob-c-button mob-c-wide">Manage</summary>
              <div className="mob-c-row-actions mob-c-pad">
                <button type="button" className="mob-c-button" disabled={!caps.propertyEditRole.enabled} onClick={() => p.onOpen({ kind: "role", linkId: c.linkId })}>
                  Edit role
                </button>
                <button type="button" className="mob-c-button" disabled={!caps.propertyUnlink.enabled} onClick={() => p.onOpen({ kind: "unlink", linkId: c.linkId })}>
                  Unlink
                </button>
                {c.isPrimary ? null : (
                  <button type="button" className="mob-c-button" disabled={!caps.propertyEditPrimary.enabled} onClick={() => p.onMakePrimary(c.linkId)}>
                    Make primary
                  </button>
                )}
              </div>
              </details>
              {p.panel?.kind === "role" && p.panel.linkId === c.linkId ? (
                <form
                  className="mob-c-card mob-c-form"
                  aria-label="Edit role"
                  onSubmit={(event: { preventDefault: () => void }) => {
                    event.preventDefault();
                    p.onSubmitRole();
                  }}
                >
                  <label className="mob-c-label">
                    Role
                    <select className="mob-c-input" aria-label="Role" value={p.roleValue} onChange={(event: { target: { value: string } }) => p.onRoleChange(event.target.value)}>
                      <option value="">Choose…</option>
                      {p.roleOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="mob-c-note">Currently: {c.roleLabel}.</p>
                  {p.opError ? (
                    <p className="mob-c-warning" role="alert">
                      {p.opError}
                    </p>
                  ) : null}
                  <div className="mob-c-form-actions">
                    <button type="submit" className="mob-c-primary" disabled={p.submitting}>
                      {p.submitting ? "Saving…" : "Save role"}
                    </button>
                    <button type="button" className="mob-c-button" onClick={p.onClose}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : null}
              {p.panel?.kind === "unlink" && p.panel.linkId === c.linkId ? (
                <div className="mob-c-card mob-c-confirm" role="alertdialog" aria-label="Confirm unlink">
                  <p className="mob-c-next-title">{unlinkConfirmText(c.name, p.propertyLabel)}</p>
                  {p.opError ? (
                    <p className="mob-c-warning" role="alert">
                      {p.opError}
                    </p>
                  ) : null}
                  <div className="mob-c-form-actions">
                    <button type="button" className="mob-c-primary" disabled={p.submitting} onClick={p.onConfirmUnlink}>
                      {p.submitting ? "Unlinking…" : "Unlink"}
                    </button>
                    <button type="button" className="mob-c-button" onClick={p.onClose}>
                      Keep link
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {ap.existingHref ? (
        <p className="mob-c-note">This property already has an appraisal.</p>
      ) : null}
      {ap.existingHref ? (
        <Link href={ap.existingHref} className="mob-c-row mob-c-link-row" data-ae-open-appraisal>
          <span className="mob-c-row-main">
            <span className="mob-c-row-title">Open the appraisal</span>
          </span>
        </Link>
      ) : ap.canStart && ap.candidates.length > 0 ? (
        <div className="mob-c-form-actions" data-ae-start-appraisal-actions>
          {ap.candidates.map((c) => (
            <button key={c.partyId} type="button" className="mob-c-primary" data-ae-start-appraisal={c.partyId} disabled={ap.starting} onClick={() => ap.onStart(c.partyId)}>
              {ap.starting ? "Starting…" : ap.candidates.length === 1 ? "Start appraisal" : `Start appraisal with ${c.name}`}
            </button>
          ))}
        </div>
      ) : null}
      {ap.error ? (
        <p className="mob-c-warning" role="alert">
          {ap.error}
        </p>
      ) : null}

      {p.callOffer ? <CallReturnPrompt offer={p.callOffer} onDismiss={p.onDismissOffer} /> : null}

      {p.legacyActions && !caps.propertyLinkContact.enabled ? (
        <details className="mob-c-legacy" data-ae-legacy-contact-actions>
          <summary className="mob-c-button mob-c-wide">Link or add a contact</summary>
          {p.legacyActions}
        </details>
      ) : (
        <button type="button" className="mob-c-button mob-c-wide" disabled={!caps.propertyLinkContact.enabled} onClick={() => p.onOpen({ kind: "link" })}>
          Link a contact
        </button>
      )}
      {anyOff && reason !== null ? (
        <p className="mob-c-note" id="mob-c-link-reason">
          {reason}
        </p>
      ) : null}
      {p.panel?.kind === "link" && p.picker ? <MobileLinkPicker {...p.picker} /> : null}
    </section>
  );
}
