import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch, apiErrorMessage } from "../lib/api";

interface Property {
  id: number;
  formattedAddress: string;
  workflowStage: string;
}

const SEARCH_DEBOUNCE_MS = 300;

export default function PropertiesList() {
  const [searchText, setSearchText] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchText), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  const query = debouncedSearch.trim();
  const path = query.length > 0 ? `/properties?q=${encodeURIComponent(query)}` : "/properties";

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["properties", query],
    queryFn: () => apiFetch<{ properties: Property[] }>(path),
  });

  const properties = data?.properties ?? [];
  const showEmpty = !isLoading && !isError && properties.length === 0;

  return (
    <div>
      <h1>Properties</h1>
      <label>
        Search
        <input
          type="search"
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder="Address, suburb, or postcode"
          aria-label="Search properties"
        />
      </label>
      {isLoading && <p className="muted">Loading…</p>}
      {isError && <p className="error-text">{apiErrorMessage(error, "Couldn't load properties. Try again.")}</p>}
      {showEmpty && query.length > 0 && <p className="muted">No properties match</p>}
      {showEmpty && query.length === 0 && (
        <p className="muted">
          No properties yet.{" "}
          <Link href="/properties/start" className="btn btn-primary btn-small">
            + Start Property
          </Link>
        </p>
      )}
      <ul className="item-list">
        {properties.map((p) => (
          <li key={p.id}>
            <Link href={`/properties/${p.id}`}>
              {p.formattedAddress} <span className="pill">{p.workflowStage}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
