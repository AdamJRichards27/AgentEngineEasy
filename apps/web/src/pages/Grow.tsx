import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../lib/api";
import { useSession } from "../lib/session";

interface GrowAccess {
  entitled: boolean;
  entitlements: string[];
  billingProviderName: string;
}

interface GrowOverview {
  relationshipCount: number;
  activityCount: number;
  openOpportunityCount: number;
}

interface GrowRelationship {
  id: number;
  relationshipType: string;
  role: string | null;
  status: string;
  isPrimary: boolean;
  partyFirstName: string | null;
  partyLastName: string | null;
  partyOrganisationName: string | null;
  propertyAddress: string;
}

interface GrowActivity {
  id: number;
  activityType: string;
  occurredAt: string;
  summary: string;
}

interface GrowOpportunity {
  id: number;
  opportunityType: string;
  status: string;
  stage: string;
  reason: string;
}

// Minimal proving UI for Stage A (ARCHITECTURE.md Grow Subscription/Entitlement/Core Data
// build): a locked upgrade screen for brokerages without grow.access, and a read-only shell
// once entitled. This page's own /grow/access check is a rendering convenience only - every
// data-bearing request below is independently re-checked server-side via requireEntitlement.
export default function Grow() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const access = useQuery<GrowAccess>({
    queryKey: ["grow-access"],
    queryFn: () => apiFetch("/grow/access"),
  });

  const checkout = useMutation({
    mutationFn: () =>
      apiFetch("/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ productCode: "grow" }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grow-access"] });
    },
  });

  if (access.isLoading) {
    return <div className="app-loading">Loading…</div>;
  }

  if (!access.data?.entitled) {
    return (
      <div>
        <h1>Grow</h1>
        <section className="card grow-locked">
          <h2>Grow is not active for your brokerage</h2>
          <p className="muted">
            Grow turns every appraisal, buyer enquiry, and past client into a tracked relationship
            and a visible next action - no separate contact database, no unexplained scores.
          </p>
          {access.data?.billingProviderName === "mock" && (
            <p className="muted pilot-mode-note">
              Sandbox billing — this is test-mode only. No real card is charged and no real subscription is created.
            </p>
          )}
          {user?.role === "Brokerage Administrator" ? (
            <>
              <button className="btn btn-primary" onClick={() => checkout.mutate()} disabled={checkout.isPending}>
                {checkout.isPending ? "Starting checkout…" : "Add Grow"}
              </button>
              {checkout.isError && <p className="error-text">{(checkout.error as ApiError).friendly}</p>}
            </>
          ) : (
            <p className="muted">Ask a Brokerage Administrator to add Grow from Settings → Billing.</p>
          )}
        </section>
      </div>
    );
  }

  return <GrowWorkspace />;
}

function GrowWorkspace() {
  // Re-uses the "grow-access" query the outer Grow() component already fetched (react-query
  // dedupes by key, so this is not a second network request) purely to read
  // billingProviderName for the sandbox-billing note below.
  const access = useQuery<GrowAccess>({
    queryKey: ["grow-access"],
    queryFn: () => apiFetch("/grow/access"),
  });
  const overview = useQuery<GrowOverview>({
    queryKey: ["grow-overview"],
    queryFn: () => apiFetch("/grow/overview"),
  });
  const relationships = useQuery<{ relationships: GrowRelationship[] }>({
    queryKey: ["grow-relationships"],
    queryFn: () => apiFetch("/grow/relationships"),
  });
  const activities = useQuery<{ activities: GrowActivity[] }>({
    queryKey: ["grow-activities"],
    queryFn: () => apiFetch("/grow/activities"),
  });
  const opportunities = useQuery<{ opportunities: GrowOpportunity[] }>({
    queryKey: ["grow-opportunities"],
    queryFn: () => apiFetch("/grow/opportunities"),
  });

  return (
    <div>
      <h1>Grow</h1>
        <p className="muted"><Link href="/grow/import">Import contacts &amp; properties &rarr;</Link></p>
        {access.data?.billingProviderName === "mock" && (
          <p className="muted pilot-mode-note">Sandbox billing is active — no real charge or subscription exists behind this workspace.</p>
        )}

      <div className="stat-tiles">
        <div className="stat-tile">
          <div className="stat-tile-label">Relationships</div>
          <div className="stat-tile-value">{overview.data?.relationshipCount ?? "–"}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile-label">Activities logged</div>
          <div className="stat-tile-value">{overview.data?.activityCount ?? "–"}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile-label">Open opportunities</div>
          <div className="stat-tile-value">{overview.data?.openOpportunityCount ?? "–"}</div>
        </div>
      </div>

      <section className="card">
        <h2>Relationships</h2>
        <p className="muted">Every person linked to a property, with why the link exists - never just an owner field.</p>
        {relationships.data?.relationships.length === 0 && <p className="empty-state">No relationships yet.</p>}
        {relationships.data && relationships.data.relationships.length > 0 && (
          <table className="grow-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Property</th>
                <th>Type</th>
                <th>Role</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {relationships.data.relationships.map((r) => (
                <tr key={r.id}>
                  <td>{r.partyOrganisationName ?? `${r.partyFirstName ?? ""} ${r.partyLastName ?? ""}`.trim()}</td>
                  <td>{r.propertyAddress}</td>
                  <td>{r.relationshipType}</td>
                  <td>{r.role ?? "–"}</td>
                  <td>
                    <span
                      className={`pill ${r.status === "Active" ? "pill-success" : r.status === "PendingReview" ? "pill-warning" : ""}`}
                    >
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Recent activity</h2>
        {activities.data?.activities.length === 0 && <p className="empty-state">No activity logged yet.</p>}
        {activities.data && activities.data.activities.length > 0 && (
          <ul className="timeline">
            {activities.data.activities.map((a) => (
              <li key={a.id}>
                <span className="when">{new Date(a.occurredAt).toLocaleString()}</span>
                <div className="eyebrow">{a.activityType}</div>
                <p>{a.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Opportunities</h2>
        <p className="muted">Explainable by design - every opportunity carries a reason, never just a score.</p>
        {opportunities.data?.opportunities.length === 0 && <p className="empty-state">No opportunities yet.</p>}
        {opportunities.data && opportunities.data.opportunities.length > 0 && (
          <table className="grow-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Stage</th>
                <th>Status</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {opportunities.data.opportunities.map((o) => (
                <tr key={o.id}>
                  <td>{o.opportunityType}</td>
                  <td>{o.stage}</td>
                  <td>
                    <span className={`pill ${o.status === "Open" ? "pill-success" : o.status === "Lost" ? "pill-danger" : ""}`}>
                      {o.status}
                    </span>
                  </td>
                  <td>{o.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
