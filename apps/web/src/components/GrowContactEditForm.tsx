import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiErrorMessage, apiFetch } from "../lib/api";
import { growContactPath } from "../lib/growWorkspace";

// GP-2 — correct a contact from Contact 360. PATCH /grow/contacts/:partyId
// uses grow.contacts.manage, the same key as contact creation. Legacy
// marketing consent is keyed by destination (trim + lowercase email, digits
// with a leading + kept for phone — the same rules as normalizeDestination
// in apps/api/src/lib/communications/consent.ts). A spacing-only phone edit
// is still the same destination. A new destination is not consented.

export interface GrowContactEditSource {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  organisationName: string | null;
  email: string | null;
  mobile: string | null;
  residentialAddress: string | null;
}

interface GrowContactEditFormProps {
  partyId: number;
  contact: GrowContactEditSource;
  canEdit: boolean;
}

type FormError =
  | { kind: "validation" | "error"; message: string }
  | { kind: "conflict"; message: string; contactId?: number };

function blank(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/** Legacy EMAIL consent destination. */
function emailDestination(value: string | null | undefined): string {
  return blank(value).toLowerCase();
}

/** Legacy SMS consent destination. */
function phoneDestination(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return "";
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

function newDestination(previous: string, next: string): boolean {
  return next.length > 0 && next !== previous;
}

function consentSentence(emailChanged: boolean, phoneChanged: boolean, saved: boolean): string | null {
  if (!emailChanged && !phoneChanged) return null;
  const what = emailChanged && phoneChanged ? "email and phone" : emailChanged ? "email" : "phone";
  return `${saved ? "Saved. " : ""}Consent for the new ${what} must be recorded separately.`;
}

export function GrowContactEditForm({ partyId, contact, canEdit }: GrowContactEditFormProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [middleName, setMiddleName] = useState("");
  const [lastName, setLastName] = useState("");
  const [organisationName, setOrganisationName] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [address, setAddress] = useState("");
  const [formError, setFormError] = useState<FormError | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const emailChanged = newDestination(emailDestination(contact.email), emailDestination(email));
  const phoneChanged = newDestination(phoneDestination(contact.mobile), phoneDestination(mobile));
  const draftConsentNote = consentSentence(emailChanged, phoneChanged, false);

  const save = useMutation({
    mutationFn: (body: Record<string, string>) =>
      apiFetch(`/grow/contacts/${partyId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: (_result, body) => {
      void queryClient.invalidateQueries({ queryKey: ["grow-contact", partyId] });
      void queryClient.invalidateQueries({ queryKey: ["grow-contacts"] });
      setOpen(false);
      setFormError(null);
      setSavedNote(
        consentSentence(
          newDestination(emailDestination(contact.email), emailDestination(body.email)),
          newDestination(phoneDestination(contact.mobile), phoneDestination(body.mobile)),
          true,
        ),
      );
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setFormError({
          kind: "conflict",
          message: apiErrorMessage(error, "A contact with these details already exists."),
          contactId: error.contactId,
        });
        return;
      }
      setFormError({ kind: "error", message: apiErrorMessage(error, "Couldn't save that contact.") });
    },
  });

  if (!canEdit) return null;

  function openEditor() {
    setFirstName(contact.firstName ?? "");
    setMiddleName(contact.middleName ?? "");
    setLastName(contact.lastName ?? "");
    setOrganisationName(contact.organisationName ?? "");
    setEmail(contact.email ?? "");
    setMobile(contact.mobile ?? "");
    setAddress(contact.residentialAddress ?? "");
    setFormError(null);
    setSavedNote(null);
    setOpen(true);
  }

  function onSubmit(event: { preventDefault: () => void }) {
    event.preventDefault();
    setFormError(null);
    const body = {
      firstName: firstName.trim(),
      middleName: middleName.trim(),
      lastName: lastName.trim(),
      organisationName: organisationName.trim(),
      email: email.trim(),
      mobile: mobile.trim(),
      residentialAddress: address.trim(),
    };
    if (!body.firstName && !body.lastName && !body.organisationName && !body.email && !body.mobile) {
      setFormError({ kind: "validation", message: "A contact needs a name, email, or phone." });
      return;
    }
    const unchanged =
      body.firstName === blank(contact.firstName) &&
      body.middleName === blank(contact.middleName) &&
      body.lastName === blank(contact.lastName) &&
      body.organisationName === blank(contact.organisationName) &&
      body.email === blank(contact.email) &&
      body.mobile === blank(contact.mobile) &&
      body.residentialAddress === blank(contact.residentialAddress);
    if (unchanged) {
      setOpen(false);
      setSavedNote(null);
      return;
    }
    save.mutate(body);
  }

  function bind(setter: (value: string) => void) {
    return (value: string) => {
      setFormError(null);
      setter(value);
    };
  }

  return (
    <div className="grow-contact-edit">
      {!open ? (
        <button type="button" className="btn btn-secondary btn-small" onClick={openEditor}>
          Edit contact
        </button>
      ) : (
        <form
          className="stack grow-inline-form"
          aria-labelledby="contact-edit-heading"
          onSubmit={onSubmit}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              setFormError(null);
            }
          }}
        >
          <h3 id="contact-edit-heading">Edit contact</h3>
          <label htmlFor="contact-edit-first-name">First name</label>
          <input
            id="contact-edit-first-name"
            type="text"
            value={firstName}
            autoComplete="given-name"
            autoFocus
            aria-invalid={formError?.kind === "validation" ? true : undefined}
            onChange={(event) => bind(setFirstName)(event.target.value)}
          />
          <label htmlFor="contact-edit-middle-name">Middle name</label>
          <input
            id="contact-edit-middle-name"
            type="text"
            value={middleName}
            autoComplete="additional-name"
            onChange={(event) => bind(setMiddleName)(event.target.value)}
          />
          <label htmlFor="contact-edit-last-name">Last name</label>
          <input
            id="contact-edit-last-name"
            type="text"
            value={lastName}
            autoComplete="family-name"
            aria-invalid={formError?.kind === "validation" ? true : undefined}
            onChange={(event) => bind(setLastName)(event.target.value)}
          />
          <label htmlFor="contact-edit-organisation">Organisation</label>
          <input
            id="contact-edit-organisation"
            type="text"
            value={organisationName}
            autoComplete="organization"
            aria-invalid={formError?.kind === "validation" ? true : undefined}
            onChange={(event) => bind(setOrganisationName)(event.target.value)}
          />
          <label htmlFor="contact-edit-email">Email</label>
          <input
            id="contact-edit-email"
            type="email"
            inputMode="email"
            value={email}
            autoComplete="email"
            aria-invalid={formError?.kind === "validation" || formError?.kind === "conflict" ? true : undefined}
            aria-describedby={draftConsentNote ? "contact-edit-consent-note" : undefined}
            onChange={(event) => bind(setEmail)(event.target.value)}
          />
          <label htmlFor="contact-edit-mobile">Mobile phone</label>
          <input
            id="contact-edit-mobile"
            type="tel"
            inputMode="tel"
            value={mobile}
            autoComplete="tel"
            aria-invalid={formError?.kind === "validation" || formError?.kind === "conflict" ? true : undefined}
            aria-describedby={draftConsentNote ? "contact-edit-consent-note" : undefined}
            onChange={(event) => bind(setMobile)(event.target.value)}
          />
          <label htmlFor="contact-edit-address">Address</label>
          <input
            id="contact-edit-address"
            type="text"
            value={address}
            autoComplete="street-address"
            onChange={(event) => bind(setAddress)(event.target.value)}
          />
          {draftConsentNote ? (
            <p id="contact-edit-consent-note" className="grow-contact-edit-note muted">
              {draftConsentNote}
            </p>
          ) : null}
          {formError ? (
            <p id="contact-edit-error" className="error-text" role="alert">
              {formError.message}
              {formError.kind === "conflict" && formError.contactId ? (
                <>
                  {" "}
                  <Link href={growContactPath(formError.contactId)} className="btn btn-link btn-small">
                    View the existing contact
                  </Link>
                </>
              ) : null}
            </p>
          ) : null}
          <div className="grow-contact-edit-actions">
            <button className="btn btn-primary btn-small" type="submit" disabled={save.isPending}>
              Save contact
            </button>
            <button
              className="btn btn-small"
              type="button"
              onClick={() => {
                setOpen(false);
                setFormError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {savedNote ? <p className="grow-contact-edit-note muted">{savedNote}</p> : null}
    </div>
  );
}
