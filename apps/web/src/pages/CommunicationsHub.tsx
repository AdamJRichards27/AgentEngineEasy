// Agent Engine 2.0 -- Communications Hub (Priority 8), Section 32's "Hub
// route": a brokerage-wide, most-recent-first feed of communication
// messages, leading with what needs attention (awaiting approval, blocked,
// or failed/bounced) before the full recent activity list. Deliberately
// read-only and deep-linking-only -- App.tsx's shallow route table keeps
// message composition and thread detail inside the Property Workspace
// (Section 10), so every row here links through to its property rather
// than duplicating that UI.
//
// AE GROW Completion W2-B: a message is no longer necessarily property-first
// (Priority 3 made propertyId nullable), so the "every row links through to its
// property" rule above now has a second case — a contact-first row links into
// Contact 360 (/grow/contacts/:id) instead. See HubRow at the bottom of this file.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
// AE GROW Completion W2-B (G-4) — the shared loading/failed/empty region
// presentation. Named for Grow because that is where the defect was first
// fixed, but nothing in it is Grow-specific and the failure it prevents (a
// card that renders nothing at all when its query fails) was live here too.
import { GrowDataRegionStatus } from "../components/GrowDataRegion";
import {
  channelLabel,
  classificationLabel,
  communicationStatusLabel,
  communicationStatusPillClass,
  fetchCommunicationsHub,
  type RecentCommunicationRow,
} from "../lib/communications";
import { growContactPath } from "../lib/growWorkspace";

type HubFilter = "all" | "needs-attention";

export default function CommunicationsHub() {
  const [filter, setFilter] = useState<HubFilter>("needs-attention");

  const hub = useQuery({
    queryKey: ["communications-hub", filter],
    queryFn: () => fetchCommunicationsHub(filter),
    refetchInterval: 30000,
  });
  const { data, isLoading } = hub;

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
        {/* AE GROW Completion W2-B (G-4) — this chain used to end at "!data ||
            length === 0", so a failed fetch was presented as "nothing needs
            attention right now": the Hub told the agent they were clear when it
            had simply not loaded. An error now says so, and offers a retry. */}
        <GrowDataRegionStatus
          query={hub}
          itemCount={data?.messages.length}
          loadingMessage="Loading communications…"
          errorFallback="Couldn't load the Communications Hub."
          emptyMessage={filter === "needs-attention" ? "Nothing needs attention right now." : "No communications recorded yet."}
          onRetry={() => void hub.refetch()}
        />
        {data && data.messages.length > 0 && (
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

// AE GROW Completion W2-B (E-6) — where a row goes when it is opened.
//
// A property-first message keeps the existing behaviour exactly: through to the
// Property Workspace, where its thread already lives. A contact-first message
// (propertyId null, partyId set — the shape Priority 3 introduced) goes to
// Contact 360 instead, which is where ITS thread lives. The previous single
// unconditional `/properties/${message.propertyId}` produced "/properties/null"
// for that second case, and the API answers Number("null") = NaN with a 400.
//
// A row with neither anchor is not linked at all rather than linked somewhere
// wrong — there is nowhere honest to send it.
export function hubRowDestination(row: RecentCommunicationRow): string | null {
  if (row.message.propertyId !== null) return `/properties/${row.message.propertyId}`;
  if (row.message.partyId !== null) return growContactPath(row.message.partyId);
  return null;
}

// The summary line's first segment: a property-first row shows its address (as
// before); a contact-first row has no address to show, so it shows who the
// message is with, which is what the API's partyDisplayName was added for.
export function hubRowContextLabel(row: RecentCommunicationRow): string {
  return row.propertyAddress ?? row.partyDisplayName ?? "No property or contact on file";
}

function HubRow({ row }: { row: RecentCommunicationRow }) {
  const { message } = row;
  const destination = hubRowDestination(row);
  return (
    <li className="pc-item">
      <div className="pc-item-header">
        {destination !== null ? (
          <Link href={destination} className="pc-item-title">
            <strong>{row.threadSubject}</strong>
          </Link>
        ) : (
          <span className="pc-item-title">
            <strong>{row.threadSubject}</strong>
          </span>
        )}
        <span className={communicationStatusPillClass(message.status)}>{communicationStatusLabel(message.status)}</span>
      </div>
      <p className="muted">
        {hubRowContextLabel(row)} · {channelLabel(message.channel)} · {classificationLabel(message.classification)}
      </p>
      <p>
        To {message.recipientDisplayName ?? message.recipientDestination ?? "unresolved recipient"}
        {message.failureDetail ? ` — ${message.failureDetail}` : ""}
      </p>
      <p className="muted">{new Date(message.createdAt).toLocaleString()}</p>
    </li>
  );
}
