// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch, apiErrorMessage } from "../lib/api";
import { useEntitlements } from "../lib/session";
import { growContactPath } from "../lib/growWorkspace";
import type { NewContactNotice } from "./types";

// G-UAT-2 — New contact on the Contacts tab. Creates a party with no property
// (POST /grow/contacts). Property linking stays a separate action. Hidden
// without grow.contacts.manage, the same key the route enforces.
export function GrowNewContactForm() {
  const { hasEntitlement } = useEntitlements();
  const canCreateContact = hasEntitlement("grow.contacts.manage");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notice, setNotice] = useState<NewContactNotice | null>(null);
  const queryClient = useQueryClient();

  const createContact = useMutation<{ contact: { id: number } }, unknown, { name: string; email: string; phone: string }>({
    mutationFn: (input) =>
      apiFetch("/grow/contacts", {
        method: "POST",
        body: JSON.stringify({ name: input.name, email: input.email, phone: input.phone }),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["grow-contacts"] });
      // Getting started reads firstRun from grow-today. Without this the
      // checklist stays "0 of 6" until a reload (UAT D5).
      void queryClient.invalidateQueries({ queryKey: ["grow-today"] });
      setNotice({ kind: "created", contactId: result.contact.id });
      setName("");
      setEmail("");
      setPhone("");
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409 && error.contactId) {
        setNotice({ kind: "duplicate", contactId: error.contactId });
        return;
      }
      setNotice({ kind: "error", message: apiErrorMessage(error, "Couldn't create that contact.") });
    },
  });

  if (!canCreateContact) return null;

  return (
    <div className="grow-new-contact">
      {!open ? (
        <button type="button" className="btn btn-primary btn-small" onClick={() => setOpen(true)}>
          New contact
        </button>
      ) : (
        <form
          className="stack grow-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            setNotice(null);
            createContact.mutate({ name: name.trim(), email: email.trim(), phone: phone.trim() });
          }}
        >
          <h3>New contact</h3>
          <label htmlFor="new-contact-name">Name</label>
          <input id="new-contact-name" type="text" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
          <label htmlFor="new-contact-email">Email</label>
          <input id="new-contact-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
          <label htmlFor="new-contact-phone">Phone</label>
          <input id="new-contact-phone" type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} autoComplete="tel" />
          <button className="btn btn-primary btn-small" type="submit" disabled={createContact.isPending}>
            Create contact
          </button>
        </form>
      )}
      {notice?.kind === "created" && (
        <p>
          Contact created.{" "}
          <Link href={growContactPath(notice.contactId)} className="btn btn-link btn-small">
            View Contact 360
          </Link>
        </p>
      )}
      {notice?.kind === "duplicate" && (
        <p role="alert">
          This contact already exists.{" "}
          <Link href={growContactPath(notice.contactId)} className="btn btn-link btn-small">
            View Contact 360
          </Link>
        </p>
      )}
      {notice?.kind === "error" && (
        <p className="error-text" role="alert">
          {notice.message}
        </p>
      )}
    </div>
  );
}
