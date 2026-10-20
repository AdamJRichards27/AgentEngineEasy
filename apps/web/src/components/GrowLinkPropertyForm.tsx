// Contact 360 "Link property" form (moved verbatim from pages/Grow.tsx, Contact 360 PR4). No behaviour change.
// Import specifiers use "../lib/..." so the behaviour-test module mocks still match.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch, apiErrorMessage } from "../lib/api";
import { useEntitlements } from "../lib/session";
import { GROW_PROPERTY_RELATIONSHIP_OPTIONS, type LinkableProperty } from "../lib/growContact360";


// G-UAT-3 — Contact 360 "Link property". Posts partyId, propertyId and
// relationshipType to POST /grow/relationships. The route requires
// grow.relationships.manage for every relationship and grow.properties.link
// when a property id is present, so the form is shown only when both are
// held. The property list is GET /properties (already own-property scoped
// for Agents). The route has no notes field, so this form does not collect
// one. Household "Add related contact" stays a separate list.
export function GrowLinkPropertyForm({ partyId, onLinked }: { partyId: number; onLinked: () => void }) {
  const queryClient = useQueryClient();
  const { hasEntitlement } = useEntitlements();
  const canLink = hasEntitlement("grow.properties.link") && hasEntitlement("grow.relationships.manage");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<LinkableProperty[]>([]);
  const [propertyId, setPropertyId] = useState<number | null>(null);
  const [relationshipType, setRelationshipType] = useState<string>(GROW_PROPERTY_RELATIONSHIP_OPTIONS[0][0]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const searchProperties = useMutation({
    mutationFn: (query: string) => {
      const path = query.length > 0 ? `/properties?q=${encodeURIComponent(query)}` : "/properties";
      return apiFetch<{ properties: LinkableProperty[] }>(path);
    },
    onSuccess: (result) => {
      const properties = result.properties ?? [];
      setResults(properties);
      setPropertyId((current) => (properties.some((property) => property.id === current) ? current : null));
      setErrorMessage(null);
    },
    onError: (error) => setErrorMessage(apiErrorMessage(error, "Couldn't load properties.")),
  });

  const linkProperty = useMutation({
    mutationFn: () =>
      apiFetch("/grow/relationships", {
        method: "POST",
        body: JSON.stringify({ partyId, propertyId, relationshipType }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grow-contact", partyId] });
      queryClient.invalidateQueries({ queryKey: ["grow-contacts"] });
      // The Relationships card and the checklist's property step stay on
      // screen (or remount within staleTime) unless these are invalidated (UAT D5).
      queryClient.invalidateQueries({ queryKey: ["grow-relationships"] });
      queryClient.invalidateQueries({ queryKey: ["grow-today"] });
      onLinked();
      setOpen(false);
      setSearch("");
      setResults([]);
      setPropertyId(null);
      setRelationshipType(GROW_PROPERTY_RELATIONSHIP_OPTIONS[0][0]);
      setErrorMessage(null);
    },
    onError: (error) => setErrorMessage(linkPropertyErrorMessage(error)),
  });

  if (!canLink) return null;

  return (
    <div className="grow-link-property">
      <button type="button" className="btn btn-secondary btn-small" onClick={() => setOpen((value) => !value)}>
        {open ? "Cancel" : "Link property"}
      </button>
      {open && (
        <form
          className="stack grow-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (propertyId === null) return;
            setErrorMessage(null);
            linkProperty.mutate();
          }}
        >
          <label htmlFor="grow-link-property-search">Property</label>
          <div className="grow-inline-form-row">
            <input
              id="grow-link-property-search"
              type="search"
              placeholder="Address, suburb, or postcode"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button
              type="button"
              className="btn btn-secondary btn-small"
              disabled={searchProperties.isPending}
              onClick={() => searchProperties.mutate(search.trim())}
            >
              Search
            </button>
          </div>
          {results.length > 0 && (
            <ul className="item-list">
              {results.map((property) => (
                <li key={property.id}>
                  <button
                    type="button"
                    className={`btn btn-link btn-small${propertyId === property.id ? " active" : ""}`}
                    onClick={() => setPropertyId(property.id)}
                  >
                    {propertyId === property.id ? "✓ " : ""}
                    {property.formattedAddress}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label htmlFor="grow-link-property-type">Relationship</label>
          <select
            id="grow-link-property-type"
            value={relationshipType}
            onChange={(event) => setRelationshipType(event.target.value)}
          >
            {GROW_PROPERTY_RELATIONSHIP_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button className="btn btn-primary btn-small" type="submit" disabled={propertyId === null || linkProperty.isPending}>
            Save link
          </button>
        </form>
      )}
      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
    </div>
  );
}

function linkPropertyErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) return "That property couldn't be found.";
  if (error instanceof ApiError && error.status === 403) {
    return apiErrorMessage(error, "You don't have permission to link a property.");
  }
  if (error instanceof ApiError && error.status === 409) {
    return apiErrorMessage(error, "This contact is already linked to that property.");
  }
  return apiErrorMessage(error, "Couldn't link that property.");
}
