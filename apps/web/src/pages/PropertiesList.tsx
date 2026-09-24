import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch, apiErrorMessage } from "../lib/api";

interface Property {
  id: number;
  formattedAddress: string;
  workflowStage: string;
}

export default function PropertiesList() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["properties"],
    queryFn: () => apiFetch<{ properties: Property[] }>("/properties"),
  });

  return (
    <div>
      <h1>Properties</h1>
      {isLoading && <p className="muted">Loading…</p>}
      {isError && <p className="error-text">{apiErrorMessage(error, "Couldn't load properties. Try again.")}</p>}
      {!isLoading && !isError && (data?.properties.length ?? 0) === 0 && (
        <p className="muted">
          No properties yet.{" "}
          <Link href="/properties/start" className="btn btn-primary btn-small">
            + Start Property
          </Link>
        </p>
      )}
      <ul className="item-list">
        {data?.properties.map((p) => (
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
