import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiErrorMessage, apiFetch } from "../../lib/api";
import type { GrowContactListItem, GrowContactListPage } from "../../lib/growContactList";
import { builderPath } from "../appraisal/appraisalBuilderModel";
import { resolveStartFailure, startAppraisalBody } from "./minimalPropertiesModel";
import {
  appraisalCandidates,
  buildLinkedContacts,
  contactSearchPath,
  isAlreadyLinked,
  isPropertyPartyRole,
  LINK_ALREADY_EXISTS,
  LINK_ROLE_REQUIRED,
  linkContactBody,
  linkedPartiesPath,
  linkFailureText,
  PROPERTY_PARTY_ROLE_LABELS,
  PROPERTY_PARTY_ROLES,
  type LinkedPartyRow,
} from "./minimalPropertyContactsModel";

// AE Minimal v1.0 (Owner t148u/t149u): Linked contacts + Link a Contact +
// Start Appraisal on the Grow property detail. Server enforces tenant scope,
// roles and duplicates; the checks here only give better messages sooner.

export interface MinimalPropertyContactsProps {
  propertyId: number;
  canSearch: boolean;
  canCreateContact: boolean;
  canStartAppraisal: boolean;
  /** An appraisal already exists for this property (one per property). */
  existingAppraisalHref: string | null;
}

export function MinimalPropertyContacts({ propertyId, canSearch, canCreateContact, canStartAppraisal, existingAppraisalHref }: MinimalPropertyContactsProps) {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [selected, setSelected] = useState<{ id: number; name: string } | null>(null);
  const [role, setRole] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");

  const linkedQuery = useQuery<{ parties: LinkedPartyRow[] }>({
    queryKey: ["minimal-property-parties", propertyId],
    queryFn: () => apiFetch(linkedPartiesPath(propertyId)),
  });
  const linked = buildLinkedContacts(linkedQuery.data?.parties ?? []);

  const search = useQuery<GrowContactListPage>({
    queryKey: ["minimal-link-contact-search", submitted],
    queryFn: () => apiFetch(contactSearchPath(submitted)),
    enabled: open && canSearch && submitted.trim().length > 0,
  });

  const link = useMutation({
    mutationFn: (body: ReturnType<typeof linkContactBody>) => apiFetch("/parties", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["minimal-property-parties", propertyId] });
      setNotice(`${selected?.name ?? "Contact"} linked to this property.`);
      setOpen(false);
      setSelected(null);
      setRole("");
      setQuery("");
      setSubmitted("");
    },
    onError: (err) => {
      void queryClient.invalidateQueries({ queryKey: ["minimal-property-parties", propertyId] });
      setError(linkFailureText(err instanceof ApiError ? err : null, apiErrorMessage(err, "Couldn't link the contact. Try again.")));
    },
  });

  const createContact = useMutation<{ contact: { id: number } }, unknown, { name: string; email: string; phone: string }>({
    mutationFn: (input) => apiFetch("/grow/contacts", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (result, input) => {
      setSelected({ id: result.contact.id, name: input.name });
      setNewOpen(false);
      setNewName("");
      setNewEmail("");
      setNewPhone("");
      setError(null);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409 && typeof err.contactId === "number") {
        setError("A contact with that email or phone already exists. Search for them and link the existing contact instead.");
        return;
      }
      setError(apiErrorMessage(err, "Couldn't create the contact. Try again."));
    },
  });

  const start = useMutation({
    mutationFn: (partyId: number) =>
      apiFetch<{ appraisal: { id: number } }>("/grow/appraisals/from-contact", { method: "POST", body: JSON.stringify(startAppraisalBody(partyId, propertyId)) }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["grow-appraisals"] });
      navigate(builderPath(result.appraisal.id));
    },
    onError: (err) => {
      const failure = resolveStartFailure(err instanceof ApiError ? err : null, propertyId, apiErrorMessage(err, "Couldn't start the appraisal. Try again."));
      if (failure.kind === "open-existing") {
        void queryClient.invalidateQueries({ queryKey: ["grow-appraisals"] });
        navigate(failure.builderHref);
        return;
      }
      setError(failure.text);
    },
  });

  function save() {
    setError(null);
    setNotice(null);
    if (!selected) return setError("Choose a contact to link.");
    if (!isPropertyPartyRole(role)) return setError(LINK_ROLE_REQUIRED);
    if (isAlreadyLinked(linked, selected.id, role)) return setError(LINK_ALREADY_EXISTS);
    link.mutate(linkContactBody(propertyId, selected.id, role));
  }

  const results: GrowContactListItem[] = search.data?.contacts ?? [];
  const candidates = appraisalCandidates(linked);

  return (
    <section className="am-rail-section" aria-labelledby="am-property-contacts" data-ae-property-contacts={propertyId}>
      <div className="am-section-head">
        <h2 id="am-property-contacts" className="am-eyebrow">
          Linked contacts
        </h2>
        {canSearch && !open ? (
          <button type="button" className="am-data-button" data-ae-link-contact="open" onClick={() => { setOpen(true); setError(null); setNotice(null); }}>
            Link a contact
          </button>
        ) : null}
      </div>
      {notice ? <p className="am-empty-note" role="status">{notice}</p> : null}
      {error ? <p className="am-switch-error" role="alert" data-ae-link-error>{error}</p> : null}
      {linkedQuery.isLoading ? <p className="am-empty-note">Loading linked contacts…</p> : null}
      {linkedQuery.isError ? <p className="am-switch-error" role="alert">{apiErrorMessage(linkedQuery.error, "Couldn't load linked contacts.")}</p> : null}
      {linkedQuery.isSuccess && linked.length === 0 ? <p className="am-empty-note">No contact linked yet. Link a contact to start an appraisal.</p> : null}
      {linked.length > 0 ? (
        <ul className="am-agenda">
          {linked.map((l) => (
            <li key={l.linkId} className="am-agenda-row am-linked-row" data-linked-party={l.partyId} data-linked-role={l.role}>
              <div>
                <Link href={l.contactHref} className="am-agenda-title">{l.name}</Link>
                <div className="am-agenda-sub">{l.roleLabel}{l.detail ? ` · ${l.detail}` : ""}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {existingAppraisalHref ? (
        <p className="am-empty-note">
          This property already has an appraisal. <Link href={existingAppraisalHref}>Open the appraisal</Link>
        </p>
      ) : canStartAppraisal && candidates.length > 0 ? (
        <div className="am-data-actions" data-ae-start-appraisal-actions>
          {candidates.map((c) => (
            <button key={c.partyId} type="button" className="am-data-button" data-ae-start-appraisal={c.partyId} disabled={start.isPending} onClick={() => { setError(null); start.mutate(c.partyId); }}>
              {candidates.length === 1 ? "Start appraisal" : `Start appraisal with ${c.name}`}
            </button>
          ))}
        </div>
      ) : null}

      {open ? (
        <div className="am-link-contact" data-ae-link-contact-panel>
          <form
            className="am-link-contact-search"
            role="search"
            onSubmit={(e) => { e.preventDefault(); setSelected(null); setSubmitted(query.trim()); }}
          >
            <label htmlFor="am-link-contact-q">Search Relationships contacts</label>
            <input id="am-link-contact-q" type="search" value={query} placeholder="Name or email" onChange={(e) => setQuery(e.target.value)} />
            <button type="submit" className="am-data-button is-quiet">Search</button>
          </form>
          {search.isFetching ? <p className="am-empty-note">Searching…</p> : null}
          {search.isError ? <p className="am-switch-error" role="alert">{apiErrorMessage(search.error, "Couldn't search contacts.")}</p> : null}
          {search.isSuccess && submitted && results.length === 0 ? <p className="am-empty-note">No matching contacts.</p> : null}
          {results.length > 0 ? (
            <ul className="am-agenda" aria-label="Matching contacts">
              {results.map((c) => (
                <li key={c.id} className="am-agenda-row">
                  <label>
                    <input type="radio" name="am-link-contact-choice" data-ae-contact-choice={c.id} checked={selected?.id === c.id} onChange={() => setSelected({ id: c.id, name: c.displayName })} />{" "}
                    {c.displayName}
                    <span className="am-agenda-sub"> {[c.email, c.mobile].filter(Boolean).join(" · ")}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
          {canCreateContact ? (
            newOpen ? (
              <form
                className="am-link-contact-new"
                data-ae-new-contact-form
                onSubmit={(e) => { e.preventDefault(); if (newName.trim()) createContact.mutate({ name: newName.trim(), email: newEmail.trim(), phone: newPhone.trim() }); }}
              >
                <label>Name <input value={newName} onChange={(e) => setNewName(e.target.value)} required /></label>
                <label>Email <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} /></label>
                <label>Phone <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} /></label>
                <button type="submit" className="am-data-button is-quiet" disabled={createContact.isPending}>Create contact</button>
                <button type="button" className="am-data-button is-quiet" onClick={() => setNewOpen(false)}>Cancel</button>
              </form>
            ) : (
              <button type="button" className="am-data-button is-quiet" data-ae-new-contact onClick={() => setNewOpen(true)}>Add new contact</button>
            )
          ) : null}
          {selected ? <p className="am-empty-note" data-ae-selected-contact={selected.id}>Selected: {selected.name}</p> : null}
          <label htmlFor="am-link-contact-role">Relationship to this property</label>
          <select id="am-link-contact-role" value={role} onChange={(e) => setRole(e.target.value)} data-ae-link-role>
            <option value="">Choose relationship…</option>
            {PROPERTY_PARTY_ROLES.map((r) => (
              <option key={r} value={r}>{PROPERTY_PARTY_ROLE_LABELS[r]}</option>
            ))}
          </select>
          <div className="am-data-actions">
            <button type="button" className="am-data-button" data-ae-link-save disabled={link.isPending} onClick={save}>Link contact</button>
            <button type="button" className="am-data-button is-quiet" onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
