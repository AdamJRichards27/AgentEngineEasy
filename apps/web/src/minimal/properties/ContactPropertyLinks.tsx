import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiErrorMessage, apiFetch } from "../../lib/api";
import { PropertyLinkControls } from "./PropertyLinkControls";
import {
  buildContactPropertyLinks,
  contactPropertiesPath,
  isPropertyAlreadyLinked,
  isPropertyPartyRole,
  LINK_ALREADY_EXISTS,
  LINK_ROLE_REQUIRED,
  linkContactBody,
  linkFailureText,
  PROPERTY_PARTY_ROLE_LABELS,
  PROPERTY_PARTY_ROLES,
  propertySearchPath,
  type ContactPropertyRow,
} from "./minimalPropertyContactsModel";

// t228u Priority 2: a contact's properties from property_parties (authoritative),
// with link-to-property, role/primary edit and unlink. Used on Minimal/mobile
// Contact 360 and the desktop Grow contact detail. The server enforces
// entitlement, brokerage and own-property scope; hidden links are never returned.
export function ContactPropertyLinks({ partyId, canManage, headingId = "am-contact-property-links" }: { partyId: number; canManage: boolean; headingId?: string }) {
  const queryClient = useQueryClient();
  const key = ["contact-property-links", partyId];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: number; formattedAddress: string }>>([]);
  const [propertyId, setPropertyId] = useState<number | null>(null);
  const [role, setRole] = useState("");
  const [error, setError] = useState<string | null>(null);

  const linksQuery = useQuery<{ properties: ContactPropertyRow[] }>({
    queryKey: key,
    queryFn: () => apiFetch(contactPropertiesPath(partyId)),
  });
  const links = buildContactPropertyLinks(linksQuery.data?.properties ?? []);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: ["minimal-property-parties"] });
  };

  const search = useMutation({
    mutationFn: (q: string) => apiFetch<{ properties: Array<{ id: number; formattedAddress: string }> }>(propertySearchPath(q)),
    onSuccess: (r) => setResults(r.properties ?? []),
    onError: (err) => setError(apiErrorMessage(err, "Couldn't search properties.")),
  });
  const link = useMutation({
    mutationFn: (body: ReturnType<typeof linkContactBody>) => apiFetch("/parties", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { refresh(); setOpen(false); setPropertyId(null); setRole(""); setResults([]); setQuery(""); },
    onError: (err) => { refresh(); setError(linkFailureText(err instanceof ApiError ? err : null, apiErrorMessage(err, "Couldn't link the property."))); },
  });

  function save() {
    setError(null);
    if (propertyId === null) return setError("Choose a property to link.");
    if (!isPropertyPartyRole(role)) return setError(LINK_ROLE_REQUIRED);
    if (isPropertyAlreadyLinked(links, propertyId, role)) return setError(LINK_ALREADY_EXISTS);
    link.mutate(linkContactBody(propertyId, partyId, role));
  }

  return (
    <section className="am-rail-section" aria-labelledby={headingId} data-ae-contact-property-links={partyId}>
      <div className="am-section-head">
        <h2 id={headingId} className="am-eyebrow">Properties</h2>
        {canManage && !open ? (
          <button type="button" className="am-data-button" data-ae-link-property="open" onClick={() => { setOpen(true); setError(null); }}>
            Link to a property
          </button>
        ) : null}
      </div>
      {error ? <p className="am-switch-error" role="alert">{error}</p> : null}
      {linksQuery.isLoading ? <p className="am-empty-note">Loading properties…</p> : null}
      {linksQuery.isError ? <p className="am-switch-error" role="alert">{apiErrorMessage(linksQuery.error, "Couldn't load linked properties.")}</p> : null}
      {linksQuery.isSuccess && links.length === 0 ? <p className="am-empty-note">Not linked to any property you can see.</p> : null}
      {links.length > 0 ? (
        <ul className="am-agenda">
          {links.map((l) => (
            <li key={l.linkId} className="am-agenda-row" data-contact-property={l.propertyId} data-contact-property-role={l.role}>
              <div>
                <Link href={l.propertyHref} className="am-agenda-title">{l.label}</Link>
                <div className="am-agenda-sub">{l.roleLabel}{l.isPrimary ? " · Primary" : ""}</div>
                {canManage ? <PropertyLinkControls linkId={l.linkId} role={l.role} isPrimary={l.isPrimary} onChanged={refresh} /> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <div className="am-link-contact" data-ae-link-property-panel>
          <form className="am-link-contact-search" role="search" onSubmit={(e) => { e.preventDefault(); setPropertyId(null); search.mutate(query); }}>
            <label htmlFor={`${headingId}-q`}>Search properties</label>
            <input id={`${headingId}-q`} type="search" value={query} placeholder="Address" onChange={(e) => setQuery(e.target.value)} />
            <button type="submit" className="am-data-button is-quiet" disabled={search.isPending}>Search</button>
          </form>
          {search.isSuccess && results.length === 0 ? <p className="am-empty-note">No matching properties.</p> : null}
          {results.length > 0 ? (
            <ul className="am-agenda" aria-label="Matching properties">
              {results.map((p) => (
                <li key={p.id} className="am-agenda-row">
                  <label>
                    <input type="radio" name={`${headingId}-choice`} data-ae-property-choice={p.id} checked={propertyId === p.id} onChange={() => setPropertyId(p.id)} /> {p.formattedAddress}
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
          <label htmlFor={`${headingId}-role`}>Relationship to the property</label>
          <select id={`${headingId}-role`} value={role} onChange={(e) => setRole(e.target.value)} data-ae-link-property-role>
            <option value="">Choose relationship…</option>
            {PROPERTY_PARTY_ROLES.map((r) => <option key={r} value={r}>{PROPERTY_PARTY_ROLE_LABELS[r]}</option>)}
          </select>
          <div className="am-data-actions">
            <button type="button" className="am-data-button" data-ae-link-property-save disabled={link.isPending} onClick={save}>Link property</button>
            <button type="button" className="am-data-button is-quiet" onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
