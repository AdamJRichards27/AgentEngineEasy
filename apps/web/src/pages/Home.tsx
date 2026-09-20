import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch } from "../lib/api";
import { AskAgentEngine } from "../components/AskAgentEngine";
// AE GROW Completion W2-B (G-4) — the shared loading/failed/empty region
// presentation (components/GrowDataRegion.tsx). Named for Grow because that is
// where it was first needed; the failure it prevents is not Grow-specific.
import { GrowDataRegionStatus } from "../components/GrowDataRegion";

// AE GROW Priority 0.5 — Workstream 5 (Grow "Today" preparation: architecture only, no UX built,
// no behaviour changed on this page). This is RUN's existing Home/Dashboard page, reading RUN's
// getHomeSummary()/getDashboardOverview() (apps/api/src/lib/homeSummary.ts) via GET /home/summary
// — property-workflow signals (exceptions, next actions, active properties, settlements). Grow's
// own future "Today" view (Priority 1, NOT built in this phase) is a SEPARATE page and a SEPARATE
// API surface reading the Grow domain (growRelationships/growActivities/growOpportunities), not
// this one. Per Workstream 2, Grow-entitled non-Pit-Crew users land on /grow (a distinct route),
// not here — this page is unchanged and continues to serve exactly the users it always has,
// including every existing RUN user regardless of Grow entitlement. This component, its query,
// and its rendering are not modified as part of Priority 0.5; this comment only records the
// intended Grow "Today" boundary ahead of Priority 1.

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
  const summary = useQuery({
    queryKey: ["home-summary"],
    queryFn: () => apiFetch<HomeSummaryResponse>("/home/summary"),
  });
  const { data, isLoading, isError } = summary;

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

      <AskAgentEngine contextType="business" contextId={null} />

      {/* AE GROW Completion W2-B (G-4/G-5): the error branch used to be
          `(error as ApiError).friendly` — the literal string "undefined" for
          any failure that is not an ApiError — with no retry. */}
      {(isLoading || isError) && (
        <GrowDataRegionStatus
          query={summary}
          itemCount={undefined}
          loadingMessage="Loading…"
          errorFallback="Couldn't load your dashboard."
          emptyMessage="Nothing to show yet."
          onRetry={() => void summary.refetch()}
        />
      )}

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
