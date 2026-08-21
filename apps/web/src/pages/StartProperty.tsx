import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiFetch, ApiError } from "../lib/api";

interface AddressCandidate {
  placeId: string;
  formattedAddress: string;
  state?: string;
}

interface SellerDraft {
  firstName: string;
  lastName: string;
  mobile: string;
  email: string;
  residentialAddress: string;
}

const BLANK_SELLER: SellerDraft = { firstName: "", lastName: "", mobile: "", email: "", residentialAddress: "" };

// Start Property (staging brief): search an address, allow "Not this
// address? → Create New Address", create the Property Record immediately
// on selection, then capture sellers on their own minimal step — no large
// property-creation form up front, and no compliance terminology (AML,
// roles, entity types) at this stage. That belongs in the Property
// Workspace once the property exists.
export default function StartProperty() {
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<AddressCandidate[]>([]);
  const [manualMode, setManualMode] = useState(false);
  const [propertyId, setPropertyId] = useState<number | null>(null);
  const [sellers, setSellers] = useState<SellerDraft[]>([{ ...BLANK_SELLER }]);
  const [searchError, setSearchError] = useState<string | null>(null);

  const search = async () => {
    setSearchError(null);
    try {
      const result = await apiFetch<{ candidates: AddressCandidate[] }>(
        `/properties/address-search?q=${encodeURIComponent(query)}`,
      );
      setCandidates(result.candidates);
    } catch (err) {
      setSearchError((err as ApiError).friendly ?? "Couldn't search that address. Try again.");
    }
  };

  const createProperty = useMutation({
    mutationFn: (input: { formattedAddress: string; placeId?: string; isManualAddress?: boolean }) =>
      apiFetch<{ property: { id: number } }>("/properties", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (data) => setPropertyId(data.property.id),
  });

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
          {addSellers.isError && <p className="error-text">{(addSellers.error as ApiError).friendly}</p>}
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
          <div className="inline-form">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search an address…" />
            <button className="btn btn-primary" onClick={search}>
              Search
            </button>
          </div>
          {searchError && <p className="error-text">{searchError}</p>}
          <ul className="item-list">
            {candidates.map((c) => (
              <li key={c.placeId}>
                {c.formattedAddress}{" "}
                <button
                  className="btn btn-small"
                  onClick={() => createProperty.mutate({ formattedAddress: c.formattedAddress, placeId: c.placeId })}
                >
                  Select
                </button>
              </li>
            ))}
          </ul>
          <button className="btn btn-link" onClick={() => setManualMode(true)}>
            Not this address? Create New Address
          </button>
          {createProperty.isError && <p className="error-text">{(createProperty.error as ApiError).friendly}</p>}
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
          {createProperty.isError && <p className="error-text">{(createProperty.error as ApiError).friendly}</p>}
        </div>
      )}
    </div>
  );
}
