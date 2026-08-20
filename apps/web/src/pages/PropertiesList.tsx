import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch } from "../lib/api";

interface Property {
  id: number;
  formattedAddress: string;
  workflowStage: string;
}

export default function PropertiesList() {
  const { data, isLoading } = useQuery({
    queryKey: ["properties"],
    queryFn: () => apiFetch<{ properties: Property[] }>("/properties"),
  });

  if (isLoading) return <p>Loading…</p>;

  return (
    <div>
      <h1>Properties</h1>
      <ul>
        {data?.properties.map((p) => (
          <li key={p.id}>
            <Link href={`/properties/${p.id}`}>
              {p.formattedAddress} — {p.workflowStage}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
