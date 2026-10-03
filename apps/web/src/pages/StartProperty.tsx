import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiFetch, apiErrorMessage } from "../lib/api";

interface AddressCandidate {
  placeId: string;
  formattedAddress: string;
  suburb?: string;
  state?: string;
  postcode?: string;
}

function addressPartsFromCandidate(candidate: AddressCandidate): { suburb?: string; state?: string; postcode?: string } {
  const part = (value: string | undefined) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };
  const suburb = part(candidate.suburb);
  const state = part(candidate.state);
  const postcode = part(candidate.postcode);
  return {
    ...(suburb ? { suburb } : {}),
    ...(state ? { state } : {}),
    ...(postcode ? { postcode } : {}),
  };
}

interface SellerDraft {
  firstName: string;
  lastName: string;
  mobile: string;
  email: string;
  residentialAddress: string;
}

const BLANK_SELLER: SellerDraft = { firstName: "", lastName: "", mobile: "", email: "", residentialAddress: "" };

// Debounce + minimum-length guard before hitting GET /properties/address-search
// as the agent types — keeps this responsive without spamming the Google
// Places quota (or the mock provider) on every keystroke.
const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 3;

// Start Property (staging brief): search an address with live-as-you-type
// suggestions (a proper autocomplete dropdown, not a type-then-click-Search
// step), allow "Not this address? → Create New Address", create the
// Property Record immediately on selection, then capture sellers on their
// own minimal step — no large property-creation form up front, and no
// compliance terminology (AML, roles, entity types) at this stage. That
// belongs in the Property Workspace once the property exists.
export default function StartProperty() {
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<AddressCandidate[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [manualMode, setManualMode] = useState(false);
  const [propertyId, setPropertyId] = useState<number | null>(null);
  const [sellers, setSellers] = useState<SellerDraft[]>([{ ...BLANK_SELLER }]);
  const [searchError, setSearchError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  const createProperty = useMutation({
    mutationFn: (input: {
      formattedAddress: string;
      placeId?: string;
      suburb?: string;
      state?: string;
      postcode?: string;
      isManualAddress?: boolean;
    }) => apiFetch<{ property: { id: number } }>("/properties", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (data) => setPropertyId(data.property.id),
  });

  const runSearch = async (q: string) => {
    const requestId = ++requestIdRef.current;
    try {
      const result = await apiFetch<{ candidates: AddressCandidate[] }>(
        `/properties/address-search?q=${encodeURIComponent(q)}`,
      );
      if (requestId !== requestIdRef.current) return; // a newer keystroke superseded this response
      setCandidates(result.candidates);
      setShowDropdown(true);
      setSearchError(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setCandidates([]);
      setSearchError(apiErrorMessage(err, "Couldn't search that address. Try again."));
    } finally {
      if (requestId === requestIdRef.current) setIsSearching(false);
    }
  };

  // Debounced live search, fired on every keystroke while in search mode.
  useEffect(() => {
    if (manualMode) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      requestIdRef.current++; // invalidate any in-flight request
      setCandidates([]);
      setShowDropdown(false);
      setIsSearching(false);
      setSearchError(null);
      return;
    }

    setIsSearching(true);
    debounceRef.current = setTimeout(() => {
      runSearch(trimmed);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, manualMode]);

  // Reset keyboard highlight whenever the suggestion set changes.
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [candidates]);

  // Click outside the input/dropdown closes it, like any normal autocomplete.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectCandidate = (c: AddressCandidate) => {
    setShowDropdown(false);
    setQuery(c.formattedAddress);
    createProperty.mutate({
      formattedAddress: c.formattedAddress,
      placeId: c.placeId,
      ...addressPartsFromCandidate(c),
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDropdown || candidates.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((i) => (i + 1) % candidates.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((i) => (i - 1 + candidates.length) % candidates.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectCandidate(candidates[highlightedIndex >= 0 ? highlightedIndex : 0]);
    } else if (e.key === "Escape") {
      setShowDropdown(false);
    }
  };

  const addSellers = useMutation({
    mutationFn: async () => {
      const filled = sellers.filter((s) => s.firstName || s.lastName || s.email || s.mobile);
      for (const s of filled) {
        await apiFetch("/parties", {
          method: "POST",
          body: JSON.stringify({
            propertyId,
            role: "Seller",
            partyType: "Person",
            firstName: s.firstName || undefined,
            lastName: s.lastName || undefined,
            mobile: s.mobile || undefined,
            email: s.email || undefined,
            residentialAddress: s.residentialAddress || undefined,
          }),
        });
      }
    },
    onSuccess: () => setLocation(`/properties/${propertyId}`),
  });

  const updateSeller = (index: number, field: keyof SellerDraft, value: string) => {
    setSellers((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  };

  // Step 2: "Who is selling the property?" — the property already exists;
  // this only captures sellers, nothing else.
  if (propertyId !== null) {
    return (
      <div>
        <div className="primary-action">
          <h1>Who is selling the property?</h1>
          <p className="muted">Enter each seller's details. You can add more later if needed.</p>
        </div>

        <div className="stack">
          {sellers.map((s, i) => (
            <div className="card" key={i}>
              <div className="inline-form">
                <label>
                  First Name
                  <input value={s.firstName} onChange={(e) => updateSeller(i, "firstName", e.target.value)} />
                </label>
                <label>
                  Last Name
                  <input value={s.lastName} onChange={(e) => updateSeller(i, "lastName", e.target.value)} />
                </label>
              </div>
              <div className="inline-form">
                <label>
                  Mobile
                  <input value={s.mobile} onChange={(e) => updateSeller(i, "mobile", e.target.value)} />
                </label>
                <label>
                  Email
                  <input value={s.email} onChange={(e) => updateSeller(i, "email", e.target.value)} />
                </label>
              </div>
              <label>
                Residential Address
                <input
                  value={s.residentialAddress}
                  onChange={(e) => updateSeller(i, "residentialAddress", e.target.value)}
                />
              </label>
            </div>
          ))}
        </div>

        <button className="btn btn-secondary" onClick={() => setSellers((prev) => [...prev, { ...BLANK_SELLER }])}>
          + Add Another Seller
        </button>

        <div style={{ marginTop: "1rem" }}>
          <button className="btn btn-primary btn-block" onClick={() => addSellers.mutate()} disabled={addSellers.isPending}>
            {addSellers.isPending ? "Saving…" : "Continue"}
          </button>
          {addSellers.isError && <p className="error-text">{apiErrorMessage(addSellers.error, "Couldn't save those sellers. Try again.")}</p>}
        </div>
      </div>
    );
  }

  // Step 1: address.
  return (
    <div>
      <h1>Start Property</h1>
      {!manualMode ? (
        <div className="stack">
          <div className="address-autocomplete" ref={containerRef}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => candidates.length > 0 && setShowDropdown(true)}
              onKeyDown={handleKeyDown}
              placeholder="Search an address…"
              autoComplete="off"
              disabled={createProperty.isPending}
            />
            {isSearching && <span className="address-search-status">Searching…</span>}

            {showDropdown && candidates.length > 0 && (
              <ul className="address-suggestions" role="listbox">
                {candidates.map((c, i) => (
                  <li
                    key={c.placeId}
                    role="option"
                    aria-selected={i === highlightedIndex}
                    className={`address-suggestion${i === highlightedIndex ? " highlighted" : ""}`}
                    onMouseEnter={() => setHighlightedIndex(i)}
                    onClick={() => selectCandidate(c)}
                  >
                    {c.formattedAddress}
                  </li>
                ))}
              </ul>
            )}

            {showDropdown && !isSearching && candidates.length === 0 && query.trim().length >= MIN_QUERY_LENGTH && (
              <div className="address-suggestions address-suggestions-empty">
                No matches for "{query.trim()}".
              </div>
            )}
          </div>

          {searchError && <p className="error-text">{searchError}</p>}
          {createProperty.isPending && <p className="muted">Creating property…</p>}

          <button
            className="btn btn-link"
            onClick={() => {
              setShowDropdown(false);
              setManualMode(true);
            }}
          >
            Not this address? Create New Address
          </button>
          {createProperty.isError && <p className="error-text">{apiErrorMessage(createProperty.error, "Couldn't create that property. Try again.")}</p>}
        </div>
      ) : (
        <div className="stack">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Enter address manually…" />
          <button
            className="btn btn-primary"
            onClick={() => createProperty.mutate({ formattedAddress: query, isManualAddress: true })}
            disabled={!query || createProperty.isPending}
          >
            Create Property
          </button>
          {createProperty.isError && <p className="error-text">{apiErrorMessage(createProperty.error, "Couldn't create that property. Try again.")}</p>}
        </div>
      )}
    </div>
  );
}
