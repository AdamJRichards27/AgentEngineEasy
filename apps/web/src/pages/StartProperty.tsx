import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiFetch } from "../lib/api";

interface AddressCandidate {
  placeId: string;
  formattedAddress: string;
  state?: string;
}

// Build Brief §3: search an address, allow "Not this address? → Create New
// Address", establish the Property Record immediately on selection — no
// large property-creation form up front.
export default function StartProperty() {
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<AddressCandidate[]>([]);
  const [manualMode, setManualMode] = useState(false);

  const search = async () => {
    const result = await apiFetch<{ candidates: AddressCandidate[] }>(
      `/properties/address-search?q=${encodeURIComponent(query)}`,
    );
    setCandidates(result.candidates);
  };

  const createProperty = useMutation({
    mutationFn: (input: { formattedAddress: string; placeId?: string; isManualAddress?: boolean }) =>
      apiFetch<{ property: { id: number } }>("/properties", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (data) => setLocation(`/properties/${data.property.id}`),
  });

  return (
    <div>
      <h1>Start Property</h1>
      {!manualMode ? (
        <>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search an address…"
          />
          <button onClick={search}>Search</button>
          <ul>
            {candidates.map((c) => (
              <li key={c.placeId}>
                {c.formattedAddress}{" "}
                <button
                  onClick={() =>
                    createProperty.mutate({ formattedAddress: c.formattedAddress, placeId: c.placeId })
                  }
                >
                  Select
                </button>
              </li>
            ))}
          </ul>
          <button onClick={() => setManualMode(true)}>Not this address? Create New Address</button>
        </>
      ) : (
        <>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Enter address manually…"
          />
          <button
            onClick={() =>
              createProperty.mutate({ formattedAddress: query, isManualAddress: true })
            }
          >
            Create Property
          </button>
        </>
      )}
    </div>
  );
}
