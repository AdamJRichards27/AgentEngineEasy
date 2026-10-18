// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch, apiErrorMessage } from "../lib/api";
import { useEntitlements } from "../lib/session";
import { GROW_OPPORTUNITY_TYPES } from "@aee/domain";
import type { LinkableProperty, GrowContactListItem, NewOpportunityInput } from "./types";

// G-UAT-5 — blank "New opportunity" on the Opportunities tab and on Contact 360.
// Posts to the existing POST /grow/opportunities. Shown only with
// grow.opportunities.manage, the key that route already requires.
// Contact 360 passes fixedParty so the contact is pre-filled and has no editor.
// Property is optional. The Opportunities tab searches GET /properties, which
// is already limited to properties this user can see. Contact 360 offers the
// contact's linked properties from the Contact 360 read, which is the same
// visibility filter.
export function GrowNewOpportunityForm({
  fixedParty,
  linkedProperties,
}: {
  fixedParty?: { id: number; displayName: string };
  linkedProperties?: Array<{ propertyId: number | null; propertyAddress: string | null }>;
}) {
  const queryClient = useQueryClient();
  const { hasEntitlement } = useEntitlements();
  const canCreate = hasEntitlement("grow.opportunities.manage");
  const [open, setOpen] = useState(false);
  const [contactSearch, setContactSearch] = useState("");
  const [contactResults, setContactResults] = useState<GrowContactListItem[] | null>(null);
  const [selectedPartyId, setSelectedPartyId] = useState<number | null>(null);
  const [opportunityType, setOpportunityType] = useState<string>(GROW_OPPORTUNITY_TYPES[0]);
  const [reason, setReason] = useState("");
  const [propertySearch, setPropertySearch] = useState("");
  const [propertyResults, setPropertyResults] = useState<LinkableProperty[] | null>(null);
  const [selectedPropertyId, setSelectedPropertyId] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const propertyChoices = linkedProperties === undefined ? null : linkedPropertyChoices(linkedProperties);

  const searchContacts = useMutation({
    mutationFn: (query: string) =>
      apiFetch<{ contacts: GrowContactListItem[] }>(`/grow/contacts?search=${encodeURIComponent(query)}`),
    onSuccess: (result) => {
      const contacts = result.contacts ?? [];
      setContactResults(contacts);
      setSelectedPartyId((current) => (contacts.some((contact) => contact.id === current) ? current : null));
      setErrorMessage(null);
    },
    onError: (error) => setErrorMessage(apiErrorMessage(error, "Couldn't search contacts.")),
  });

  const searchProperties = useMutation({
    mutationFn: (query: string) => {
      const path = query.length > 0 ? `/properties?q=${encodeURIComponent(query)}` : "/properties";
      return apiFetch<{ properties: LinkableProperty[] }>(path);
    },
    onSuccess: (result) => {
      const properties = result.properties ?? [];
      setPropertyResults(properties);
      setSelectedPropertyId((current) => (properties.some((property) => property.id === current) ? current : null));
      setErrorMessage(null);
    },
    onError: (error) => setErrorMessage(apiErrorMessage(error, "Couldn't load properties.")),
  });

  const createOpportunity = useMutation({
    mutationFn: (input: NewOpportunityInput) => {
      const body: NewOpportunityInput = {
        partyId: input.partyId,
        opportunityType: input.opportunityType,
        reason: input.reason,
      };
      if (input.propertyId !== undefined) body.propertyId = input.propertyId;
      return apiFetch("/grow/opportunities", { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: (_result, input) => {
      // Opportunities tab, this contact's Contact 360, and Grow Today's open
      // opportunities all read these queries.
      queryClient.invalidateQueries({ queryKey: ["grow-opportunities"] });
      queryClient.invalidateQueries({ queryKey: ["grow-contact", input.partyId] });
      queryClient.invalidateQueries({ queryKey: ["grow-today"] });
      setSuccessMessage("Opportunity created.");
      setErrorMessage(null);
      setOpen(false);
      setContactSearch("");
      setContactResults(null);
      setSelectedPartyId(null);
      setOpportunityType(GROW_OPPORTUNITY_TYPES[0]);
      setReason("");
      setPropertySearch("");
      setPropertyResults(null);
      setSelectedPropertyId(null);
    },
    onError: (error) => setErrorMessage(newOpportunityErrorMessage(error)),
  });

  if (!canCreate) return null;

  const partyId = fixedParty?.id ?? selectedPartyId;
  const trimmedReason = reason.trim();

  return (
    <div className="grow-new-opportunity">
      {successMessage ? <p role="status">{successMessage}</p> : null}
      <button
        type="button"
        className="btn btn-primary btn-small"
        onClick={() => {
          setOpen((value) => !value);
          setErrorMessage(null);
        }}
      >
        {open ? "Cancel" : "New opportunity"}
      </button>
      {open && (
        <form
          className="stack grow-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (partyId === null || !trimmedReason) return;
            setErrorMessage(null);
            setSuccessMessage(null);
            createOpportunity.mutate({
              partyId,
              opportunityType,
              reason: trimmedReason,
              ...(selectedPropertyId !== null ? { propertyId: selectedPropertyId } : {}),
            });
          }}
        >
          <h3>New opportunity</h3>
          {fixedParty ? (
            <p id="grow-new-opportunity-contact">
              Contact: <strong>{fixedParty.displayName}</strong>
            </p>
          ) : (
            <>
              <label htmlFor="grow-new-opportunity-contact-search">Contact</label>
              <div className="grow-inline-form-row">
                <input
                  id="grow-new-opportunity-contact-search"
                  type="search"
                  placeholder="Search by name, organisation, or email"
                  value={contactSearch}
                  onChange={(event) => setContactSearch(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={!contactSearch.trim() || searchContacts.isPending}
                  onClick={() => searchContacts.mutate(contactSearch.trim())}
                >
                  Search contacts
                </button>
              </div>
              {contactResults !== null && contactResults.length === 0 && <p className="muted">No contacts matched that search.</p>}
              {contactResults !== null && contactResults.length > 0 && (
                <ul className="item-list">
                  {contactResults.map((contact) => (
                    <li key={contact.id}>
                      <button
                        type="button"
                        className={`btn btn-link btn-small${selectedPartyId === contact.id ? " active" : ""}`}
                        onClick={() => setSelectedPartyId(contact.id)}
                      >
                        {selectedPartyId === contact.id ? "✓ " : ""}
                        {contact.displayName}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <label htmlFor="grow-new-opportunity-type">Type</label>
          <select
            id="grow-new-opportunity-type"
            value={opportunityType}
            onChange={(event) => setOpportunityType(event.target.value)}
          >
            {GROW_OPPORTUNITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <label htmlFor="grow-new-opportunity-reason">Reason</label>
          <input
            id="grow-new-opportunity-reason"
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
          />
          {propertyChoices !== null ? (
            <>
              <label htmlFor="grow-new-opportunity-property">Property (optional)</label>
              <select
                id="grow-new-opportunity-property"
                value={selectedPropertyId ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "") {
                    setSelectedPropertyId(null);
                    return;
                  }
                  const id = Number(value);
                  setSelectedPropertyId(Number.isInteger(id) && id > 0 ? id : null);
                }}
              >
                <option value="">No property</option>
                {propertyChoices.map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.label}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <label htmlFor="grow-new-opportunity-property-search">Property (optional)</label>
              <div className="grow-inline-form-row">
                <input
                  id="grow-new-opportunity-property-search"
                  type="search"
                  placeholder="Address, suburb, or postcode"
                  value={propertySearch}
                  onChange={(event) => setPropertySearch(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={searchProperties.isPending}
                  onClick={() => searchProperties.mutate(propertySearch.trim())}
                >
                  Search properties
                </button>
              </div>
              {propertyResults !== null && propertyResults.length === 0 && <p className="muted">No properties matched that search.</p>}
              {propertyResults !== null && propertyResults.length > 0 && (
                <ul className="item-list">
                  {propertyResults.map((property) => (
                    <li key={property.id}>
                      <button
                        type="button"
                        className={`btn btn-link btn-small${selectedPropertyId === property.id ? " active" : ""}`}
                        onClick={() => setSelectedPropertyId(property.id)}
                      >
                        {selectedPropertyId === property.id ? "✓ " : ""}
                        {property.formattedAddress}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <button
            className="btn btn-primary btn-small"
            type="submit"
            disabled={partyId === null || !trimmedReason || createOpportunity.isPending}
          >
            Create opportunity
          </button>
        </form>
      )}
      {errorMessage ? (
        <p className="error-text" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
function linkedPropertyChoices(
  properties: Array<{ propertyId: number | null; propertyAddress: string | null }>,
): Array<{ id: number; label: string }> {
  const seen = new Set<number>();
  const choices: Array<{ id: number; label: string }> = [];
  for (const property of properties) {
    if (property.propertyId === null || seen.has(property.propertyId)) continue;
    seen.add(property.propertyId);
    const address = property.propertyAddress?.trim();
    choices.push({
      id: property.propertyId,
      label: address && address.length > 0 ? address : `Property ${property.propertyId}`,
    });
  }
  return choices;
}
function newOpportunityErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) return "That contact or property couldn't be found.";
  if (error instanceof ApiError && error.status === 403) {
    return apiErrorMessage(error, "You don't have permission to create an opportunity.");
  }
  if (error instanceof ApiError && error.status === 400) {
    return apiErrorMessage(error, "Check the contact, type, and reason, then try again.");
  }
  return apiErrorMessage(error, "Couldn't create that opportunity.");
}
