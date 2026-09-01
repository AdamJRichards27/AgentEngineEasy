// Agent Engine 2.0 -- Communications Hub (Priority 8), Section 32's "Hub
// route": a brokerage-wide, most-recent-first feed of communication
// messages, leading with what needs attention (awaiting approval, blocked,
// or failed/bounced) before the full recent activity list. Deliberately
// read-only and deep-linking-only -- App.tsx's shallow route table keeps
// message composition and thread detail inside the Property Workspace
// (Section 10), so every row here links through to its property rather
// than duplicating that UI.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ApiError } from "../lib/api";
import {
  channelLabel,
  classificationLabel,
  communicationStatusLabel,
  communicationStatusPillClass,
  fetchCommunicationsHub,
  type RecentCommunicationRow,
} from "../lib/communications";

type HubFilter = "all" | "needs-attention";

export default function CommunicationsHub() {
  const [filter, setFilter] = useState<HubFilter>("needs-attention");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["communications-hub", filter],
    queryFn: () => fetchCommunicationsHub(filter),
    refetchInterval: 30000,
  });

  return (
    <div className="stack">
      <div className="primary-action">
        <div>
          <p className="eyebrow">Communications</p>
          <h2>Hub</h2>
        </div>
      </div>

      <section className="card">
        <div className="stat-tiles">
          <StatTile label="Needs Attention" value={data?.needsAttentionCount ?? (isLoading ? "…" : 0)} />
        </div>
        <p className="muted">
          Awaiting approval, blocked by consent or cost control, or failed/bounced — across every property in the
          brokerage.
        </p>
      </section>

      <nav className="pc-tabs">
        <button type="button" className={`pc-tab${filter === "needs-attention" ? " active" : ""}`} onClick={() => setFilter("needs-attention")}>
          Needs Attention
        </button>
        <button type="button" className={`pc-tab${filter === "all" ? " active" : ""}`} onClick={() => setFilter("all")}>
          Recent Activity
        </button>
      </nav>

      <section className="card">
        {isLoading ? (
          <p className="muted">Loading communications…</p>
        ) : isError ? (
          <p className="error-text">{error instanceof ApiError ? error.friendly : "Couldn't load the Communications Hub."}</p>
        ) : !data || data.messages.length === 0 ? (
          <p className="muted">
            {filter === "needs-attention" ? "Nothing needs attention right now." : "No communications recorded yet."}
          </p>
        ) : (
          <ul className="item-list">
            {data.messages.map((row) => (
              <HubRow key={row.message.id} row={row} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat-tile">
      <span className="stat-tile-label">{label}</span>
      <span className="stat-tile-value">{value}</span>
    </div>
  );
}

function HubRow({ row }: { row: RecentCommunicationRow }) {
  const { message } = row;
  return (
    <li className="pc-item">
      <div className="pc-item-header">
        <Link href={`/properties/${message.propertyId}`} className="pc-item-title">
          <strong>{row.threadSubject}</strong>
        </Link>
        <span className={communicationStatusPillClass(message.status)}>{communicationStatusLabel(message.status)}</span>
      </div>
      <p className="muted">
        {row.propertyAddress} · {channelLabel(message.channel)} · {classificationLabel(message.classification)}
      </p>
      <p>
        To {message.recipientDisplayName ?? message.recipientDestination ?? "unresolved recipient"}
        {message.failureDetail ? ` — ${message.failureDetail}` : ""}
      </p>
      <p className="muted">{new Date(message.createdAt).toLocaleString()}</p>
    </li>
  );
}
