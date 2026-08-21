import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch, ApiError } from "../lib/api";

interface HomeSummaryItem {
  propertyId: number;
  propertyAddress: string;
  workflowStage: string;
  label: string;
  detail?: string;
}

interface DashboardProperty {
  id: number;
  address: string;
  workflowStage: string;
}

interface DashboardSettlement {
  propertyId: number;
  address: string;
  settlementDate: string;
}

interface HomeSummaryResponse {
  exceptions: HomeSummaryItem[];
  nextActions: HomeSummaryItem[];
  activeProperties: DashboardProperty[];
  upcomingSettlements: DashboardSettlement[];
}

function ItemRow({ item }: { item: HomeSummaryItem }) {
  return (
    <li>
      <Link href={`/properties/${item.propertyId}`}>
        <strong>{item.label}</strong> — {item.propertyAddress} ({item.workflowStage})
      </Link>
      {item.detail && <div className="muted">{item.detail}</div>}
    </li>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// "What needs my attention today?" — Build Brief §13/§26 UI principle: one
// or two decisions, not a menu of modules. A stat-tile row (matching the
// reference Agent Engine app's dashboard layout) gives an at-a-glance
// summary of the same counts the sections below spell out in full;
// everything comes from one GET /home/summary call (lib/homeSummary.ts).
export default function Home() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["home-summary"],
    queryFn: () => apiFetch<HomeSummaryResponse>("/home/summary"),
  });

  const hasNothingUrgent =
    !isLoading && !isError && (data?.exceptions.length ?? 0) === 0 && (data?.nextActions.length ?? 0) === 0;

  return (
    <div>
      <div className="primary-action">
        <div className="eyebrow">Dashboard</div>
        <h1>Home</h1>
        <Link href="/properties/start" className="btn btn-primary">
          + Start Property
        </Link>
      </div>

      {isLoading && <p className="muted">Loading…</p>}
      {isError && <p className="error-text">{(error as ApiError).friendly}</p>}

      {!isLoading && !isError && (
        <>
          <div className="stat-tiles">
            <Link href="/properties" className="stat-tile">
              <div>
                <div className="stat-tile-label">Active Properties</div>
                <div className="stat-tile-value">{data?.activeProperties.length ?? 0}</div>
              </div>
              <span className="stat-tile-icon" aria-hidden="true">
                🏠
              </span>
            </Link>
            <div className="stat-tile">
              <div>
                <div className="stat-tile-label">Needs Attention</div>
                <div className="stat-tile-value">{data?.exceptions.length ?? 0}</div>
              </div>
              <span className="stat-tile-icon" aria-hidden="true">
                ⚠️
              </span>
            </div>
            <div className="stat-tile">
              <div>
                <div className="stat-tile-label">Next Actions</div>
                <div className="stat-tile-value">{data?.nextActions.length ?? 0}</div>
              </div>
              <span className="stat-tile-icon" aria-hidden="true">
                ➡️
              </span>
            </div>
            <div className="stat-tile">
              <div>
                <div className="stat-tile-label">Settlements</div>
                <div className="stat-tile-value">{data?.upcomingSettlements.length ?? 0}</div>
              </div>
              <span className="stat-tile-icon" aria-hidden="true">
                📅
              </span>
            </div>
          </div>

          <section className="card">
            <h2>Needs Attention</h2>
            {hasNothingUrgent ? (
              <p className="muted">Nothing needs your attention right now.</p>
            ) : (data?.exceptions.length ?? 0) === 0 ? (
              <p className="muted">No exceptions right now.</p>
            ) : (
              <ul className="item-list">
                {data!.exceptions.map((item, i) => (
                  <ItemRow key={`ex-${item.propertyId}-${i}`} item={item} />
                ))}
              </ul>
            )}
          </section>

          {(data?.nextActions.length ?? 0) > 0 && (
            <section className="card">
              <h2>Next Actions</h2>
              <ul className="item-list">
                {data!.nextActions.map((item, i) => (
                  <ItemRow key={`na-${item.propertyId}-${i}`} item={item} />
                ))}
              </ul>
            </section>
          )}

          <section className="card">
            <h2>Active Properties</h2>
            {(data?.activeProperties.length ?? 0) === 0 ? (
              <p className="muted">No active properties yet — start one above.</p>
            ) : (
              <ul className="item-list">
                {data!.activeProperties.map((p) => (
                  <li key={p.id}>
                    <Link href={`/properties/${p.id}`}>
                      {p.address} <span className="pill">{p.workflowStage}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <h2>Settlements</h2>
            {(data?.upcomingSettlements.length ?? 0) === 0 ? (
              <p className="muted">No settlements scheduled.</p>
            ) : (
              <ul className="item-list">
                {data!.upcomingSettlements.map((s) => (
                  <li key={s.propertyId}>
                    <Link href={`/properties/${s.propertyId}`}>{s.address}</Link>
                    <span className="muted"> — {formatDate(s.settlementDate)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
