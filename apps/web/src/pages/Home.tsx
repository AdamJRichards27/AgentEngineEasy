import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch } from "../lib/api";

interface HomeSummaryItem {
  propertyId: number;
  propertyAddress: string;
  workflowStage: string;
  label: string;
  detail?: string;
}

interface HomeSummaryResponse {
  exceptions: HomeSummaryItem[];
  nextActions: HomeSummaryItem[];
}

function ItemRow({ item }: { item: HomeSummaryItem }) {
  return (
    <li>
      <Link href={`/properties/${item.propertyId}`}>
        <strong>{item.label}</strong> — {item.propertyAddress} ({item.workflowStage})
      </Link>
      {item.detail && <div>{item.detail}</div>}
    </li>
  );
}

// "What needs my attention today?" — Build Brief §13/§26 UI principle: one
// or two decisions, not a menu of modules. Phase 8 (ARCHITECTURE.md §10)
// pulls this from live domain state across every property via
// GET /home/summary (lib/homeSummary.ts) — no BI dashboards, no counts or
// charts, just the concrete items that need a human decision right now.
export default function Home() {
  const { data, isLoading } = useQuery({
    queryKey: ["home-summary"],
    queryFn: () => apiFetch<HomeSummaryResponse>("/home/summary"),
  });

  const hasNothing = !isLoading && (data?.exceptions.length ?? 0) === 0 && (data?.nextActions.length ?? 0) === 0;

  return (
    <div>
      <h1>Home</h1>
      <Link href="/properties/start">
        <button>+ Start Property</button>
      </Link>

      {isLoading && <p>Loading…</p>}

      {hasNothing && <p>Nothing needs your attention right now.</p>}

      {!!data?.exceptions.length && (
        <section>
          <h2>Exceptions</h2>
          <ul>
            {data.exceptions.map((item, i) => (
              <ItemRow key={`${item.propertyId}-${i}`} item={item} />
            ))}
          </ul>
        </section>
      )}

      {!!data?.nextActions.length && (
        <section>
          <h2>Next Actions</h2>
          <ul>
            {data.nextActions.map((item, i) => (
              <ItemRow key={`${item.propertyId}-${i}`} item={item} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
