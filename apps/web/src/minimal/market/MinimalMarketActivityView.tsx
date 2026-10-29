import { Link } from "wouter";
import { MinimalGrowSections } from "../MinimalGrowSections";
import {
  MARKET_EVENT_TYPES,
  MARKET_RANGES,
  MARKET_SCOPE_NOTE,
  MARKET_TYPE_LABELS,
  marketActivityHref,
  marketEventDetailHref,
  type MarketAreaChip,
  type MarketEventDetail,
  type MarketEventRow,
  type MarketEventType,
  type MarketFilters,
} from "./minimalMarketActivityModel";
import { COMMITMENT_ADD_LABEL, MARKET_COMMITMENT_HINT } from "./minimalMarketActivityModel";
import { MAP_PRIVACY_NOTICE, OSM_REPORT_ISSUE_URL, mapCoverageNote, marketViewTabs, type MarketAreaPinPoint, type MarketMapPoint } from "./marketMap";

// Presentational AE Minimal A Market Activity list (V4: area chips + event
// detail panel). No hooks, no network.

export const MARKET_EVENT_PANEL_ID = "am-market-event-panel";
export const MARKET_EVENT_TITLE_ID = "am-market-event-title";

export type MinimalMarketActivityState =
  | { kind: "loading" }
  | { kind: "error"; text: string; onRetry?: () => void }
  | {
      kind: "ready";
      rows: MarketEventRow[];
      counts: { type: MarketEventType; label: string; value: number }[];
      truncated: boolean;
      detail?: MarketEventDetail | null;
      /** v1.0 "Create Follow-Up": the Add commitment block for an open AE property event (container-rendered). */
      followUp?: unknown;
      /** V5 Map tab (filters.view === "map"): points the viewer may see, and the lazily loaded map (container-rendered). */
      map?: MarketMapState;
    };

export interface MarketMapState {
  points: MarketMapPoint[];
  /** Other agents' public events by area only (type + area text, coarse point). */
  areaPins?: MarketAreaPinPoint[];
  total: number;
  canvas: unknown;
}

export interface MarketAreaProps {
  chips: MarketAreaChip[];
  note: string | null;
}

function chipFilters(filters: MarketFilters): MarketFilters {
  // Changing a range or type chip closes the detail panel but keeps the area.
  return { range: filters.range, type: filters.type, ...(filters.area ? { area: filters.area } : {}), ...(filters.view ? { view: filters.view } : {}) };
}

function Frame({ filters, area, children }: { filters: MarketFilters; area?: MarketAreaProps; children: unknown }) {
  const base = chipFilters(filters);
  return (
    <section className="am-data-screen" data-ae-market-activity="minimal" aria-labelledby="am-market-title">
      <MinimalGrowSections current="today" />
      <header className="am-data-heading">
        <div>
          <div className="am-eyebrow">Grow · Market Activity</div>
          <h1 id="am-market-title">Market Activity</h1>
          <p>{MARKET_SCOPE_NOTE}</p>
        </div>
      </header>
      {area ? (
        <>
          <ul className="mm-tabs" aria-label="Area" data-mm-area-chips={area.chips.length}>
            {area.chips.map((c) => (
              <li key={c.key}>
                <Link href={c.href} className="am-chip" aria-current={c.current ? "page" : undefined}>
                  {c.label}
                </Link>
              </li>
            ))}
          </ul>
          {area.note ? <p className="am-empty-note mm-area-note" data-mm-area-note>{area.note}</p> : null}
        </>
      ) : null}
      <ul className="mm-tabs" aria-label="Date range">
        {MARKET_RANGES.map((r) => (
          <li key={r.key}>
            <Link href={marketActivityHref({ ...base, range: r.key })} className="am-chip" aria-current={r.key === filters.range ? "page" : undefined}>
              {r.label}
            </Link>
          </li>
        ))}
      </ul>
      <ul className="mm-tabs" aria-label="Type">
        <li>
          <Link href={marketActivityHref({ ...base, type: null })} className="am-chip" aria-current={filters.type === null ? "page" : undefined}>
            All types
          </Link>
        </li>
        {MARKET_EVENT_TYPES.map((t) => (
          <li key={t}>
            <Link href={marketActivityHref({ ...base, type: t })} className="am-chip" aria-current={filters.type === t ? "page" : undefined}>
              {MARKET_TYPE_LABELS[t]}
            </Link>
          </li>
        ))}
      </ul>
      <ul className="mm-tabs" aria-label="View" data-mm-view-tabs>
        {marketViewTabs(filters).map((t) => (
          <li key={t.key}>
            <Link href={t.href} className="am-chip" aria-current={t.current ? "page" : undefined} data-mm-view-tab={t.key}>
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
      {children as never}
    </section>
  );
}

export function MarketEventDetailView({ detail, followUp }: { detail: MarketEventDetail; followUp?: unknown }) {
  return (
    <aside
      id={MARKET_EVENT_PANEL_ID}
      className="am-rail-section mm-event-panel"
      role="region"
      aria-labelledby={MARKET_EVENT_TITLE_ID}
      data-mm-event-panel={detail.key}
    >
      <div className="am-eyebrow">Event details</div>
      <h2 id={MARKET_EVENT_TITLE_ID} tabIndex={-1}>
        {detail.title}
      </h2>
      <dl className="mm-event-facts">
        <dt>Event</dt>
        <dd>{detail.label}</dd>
        <dt>Address</dt>
        <dd>{detail.address}</dd>
        <dt>Suburb</dt>
        <dd>{detail.suburb}</dd>
        <dt>Date</dt>
        <dd>{detail.date}</dd>
        {detail.recorded ? (
          <>
            <dt>Recorded in AE</dt>
            <dd>{detail.recorded}</dd>
          </>
        ) : null}
        <dt>Source</dt>
        <dd data-mm-event-source={detail.agentEntered ? "agent-entered" : detail.publicOnly ? "public" : "ae-record"}>{detail.source}</dd>
      </dl>
      {detail.agentEntered ? (
        <p className="am-empty-note" data-mm-agent-entered>
          Entered by an agent as a comparable sale in an appraisal. It is not an AE property record, so there is no property to open or add a commitment against here.
        </p>
      ) : null}
      {detail.publicOnly ? (
        <p className="am-empty-note" data-mm-public-only>
          Another agent's listing in your brokerage. Only the public market details are shown.
        </p>
      ) : null}
      <div className="mm-event-actions">
        {detail.propertyHref ? (
          <Link href={detail.propertyHref} className="am-primary-action mm-event-action" data-mm-view-property>
            View Property
          </Link>
        ) : null}
        <Link href={detail.closeHref} className="am-classic-switch mm-event-action" data-mm-close-event>
          Close details
        </Link>
      </div>
      {detail.propertyId != null && followUp ? (followUp as never) : null}
    </aside>
  );
}

export interface MarketFollowUpContact {
  partyId: number;
  name: string;
  roleLabel: string;
}

export type MarketFollowUpState =
  | { kind: "loading" }
  | { kind: "error"; text: string }
  | { kind: "no-contacts"; propertyHref: string }
  | { kind: "closed"; onOpen: () => void; done?: string | null }
  | {
      kind: "form";
      contacts: MarketFollowUpContact[];
      partyId: number | null;
      description: string;
      dueDate: string;
      minDate: string;
      submitting: boolean;
      error: string | null;
      onParty: (id: number) => void;
      onDescription: (v: string) => void;
      onDueDate: (v: string) => void;
      onSubmit: () => void;
      onCancel: () => void;
    };

export function MarketFollowUpView({ state }: { state: MarketFollowUpState }) {
  if (state.kind === "loading") {
    return <p className="am-empty-note" role="status">Loading linked contacts…</p>;
  }
  if (state.kind === "error") {
    return <p className="am-switch-error" role="alert">{state.text}</p>;
  }
  if (state.kind === "no-contacts") {
    return (
      <p className="am-empty-note" data-mm-follow-up="no-contacts">
        No contact is linked to this property yet. Link one on the property, then add the commitment.
      </p>
    );
  }
  if (state.kind === "closed") {
    return (
      <div className="mm-follow-up" data-mm-follow-up="closed">
        {state.done ? (
          <p className="am-empty-note" role="status" data-mm-follow-up-done>
            {state.done}
          </p>
        ) : null}
        <button type="button" className="am-classic-switch" onClick={state.onOpen} data-mm-create-follow-up>
          {COMMITMENT_ADD_LABEL}
        </button>
      </div>
    );
  }
  return (
    <form
      className="mm-follow-up"
      data-mm-follow-up="form"
      aria-labelledby="am-market-follow-up-title"
      onSubmit={(e) => {
        e.preventDefault();
        state.onSubmit();
      }}
    >
      <h3 id="am-market-follow-up-title">{COMMITMENT_ADD_LABEL}</h3>
      <p className="am-empty-note">{MARKET_COMMITMENT_HINT}</p>
      <label htmlFor="am-market-follow-up-contact">Contact</label>
      <select
        id="am-market-follow-up-contact"
        value={state.partyId ?? ""}
        required
        onChange={(e) => state.onParty(Number(e.target.value))}
      >
        <option value="" disabled>
          Choose a linked contact
        </option>
        {state.contacts.map((c) => (
          <option key={c.partyId} value={c.partyId}>
            {c.name} ({c.roleLabel})
          </option>
        ))}
      </select>
      <label htmlFor="am-market-follow-up-description">Commitment</label>
      <textarea
        id="am-market-follow-up-description"
        value={state.description}
        maxLength={500}
        rows={3}
        required
        onChange={(e) => state.onDescription(e.target.value)}
      />
      <label htmlFor="am-market-follow-up-due">Due date</label>
      <input
        id="am-market-follow-up-due"
        type="date"
        value={state.dueDate}
        min={state.minDate}
        required
        onChange={(e) => state.onDueDate(e.target.value)}
      />
      {state.error ? (
        <p className="am-switch-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <div className="mm-event-actions">
        <button type="submit" className="am-primary-action mm-event-action" disabled={state.submitting || state.partyId == null}>
          {state.submitting ? "Saving…" : "Save commitment"}
        </button>
        <button type="button" className="am-classic-switch mm-event-action" onClick={state.onCancel} disabled={state.submitting}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function MinimalMarketActivityView({ state, filters, area }: { state: MinimalMarketActivityState; filters: MarketFilters; area?: MarketAreaProps }) {
  if (state.kind === "loading") {
    return (
      <Frame filters={filters} area={area}>
        <p className="am-empty-note" role="status">Loading market activity…</p>
      </Frame>
    );
  }
  if (state.kind === "error") {
    return (
      <Frame filters={filters} area={area}>
        <div className="am-rail-section" role="alert">
          <p className="am-switch-error">{state.text}</p>
          {state.onRetry ? (
            <button type="button" className="am-classic-switch" onClick={state.onRetry}>
              Try again
            </button>
          ) : null}
        </div>
      </Frame>
    );
  }
  const detail = state.detail ?? null;
  return (
    <Frame filters={filters} area={area}>
      <section className="am-rail-section" aria-label="Counts">
        {state.counts.map((c) => (
          <div className="am-metric-line" key={c.type}>
            <div className="am-metric-label">
              <i className="am-mini-dot" /> {c.label}
            </div>
            <span className="am-metric-number">{c.value}</span>
          </div>
        ))}
      </section>
      <div className={detail ? "mm-market-layout has-panel" : "mm-market-layout"}>
        {detail ? <MarketEventDetailView detail={detail} followUp={state.followUp} /> : null}
        {filters.view === "map" ? (
          <MarketMapSection map={state.map} />
        ) : state.rows.length === 0 ? (
          <section className="am-rail-section">
            <p className="am-empty-note">No activity in your AE records for this range.</p>
          </section>
        ) : (
          <div className="am-agenda" aria-label="Market events" data-mm-events={state.rows.length}>
            {state.rows.map((r) => {
              const open = detail?.key === r.key;
              return (
                <div className={open ? "am-agenda-row is-open" : "am-agenda-row"} key={r.key} data-mm-event={r.key}>
                  <div className="am-time">{r.date}</div>
                  <div>
                    <div className="am-agenda-title">
                      {r.label} · {r.address}
                    </div>
                    <div className="am-agenda-sub">
                      {r.suburb} · Source: {r.source}
                    </div>
                  </div>
                  <div className="mm-event-row-actions">
                    <Link
                      href={marketEventDetailHref(filters, r.key)}
                      className="mm-event-details"
                      aria-label={`Details: ${r.label} at ${r.address}`}
                      aria-controls={open ? MARKET_EVENT_PANEL_ID : undefined}
                      aria-current={open ? "true" : undefined}
                      data-mm-event-details={r.key}
                    >
                      Details
                    </Link>
                    {r.href ? (
                      <Link href={r.href} className="am-row-open" aria-label={`View Property: ${r.address}`}>
                        View Property
                      </Link>
                    ) : (
                      <span className="am-row-status is-pending">{r.source}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {state.truncated ? <p className="am-empty-note">Showing the latest 100 events. Narrow the range or type to see the rest.</p> : null}
    </Frame>
  );
}

/** V5 Map tab: privacy notice (exact Owner text), the map, mapped-event links for keyboard users, and the OSM issue link. */
export function MarketMapSection({ map }: { map?: MarketMapState }) {
  const points = map?.points ?? [];
  const areaPins = map?.areaPins ?? [];
  return (
    <section className="am-rail-section mm-market-map" aria-label="Market map" data-mm-map>
      <p className="mm-map-privacy" data-mm-map-privacy>{MAP_PRIVACY_NOTICE}</p>
      {points.length + areaPins.length > 0 ? (map?.canvas as never) : null}
      <p className="am-empty-note" data-mm-map-coverage>{mapCoverageNote(map?.total ?? 0, points.length, areaPins.length)}</p>
      {points.length > 0 ? (
        <ul className="mm-map-points" aria-label="Mapped events">
          {points.map((p) => (
            <li key={p.key}>
              <Link href={p.detailHref} className="mm-event-details" data-mm-map-point={p.key} aria-label={`Details: ${p.label} at ${p.address}`}>
                {p.label} · {p.address}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {areaPins.length > 0 ? (
        <ul className="mm-map-points mm-map-area-pins" aria-label="Other agents' activity by area">
          {areaPins.map((a) => (
            <li key={a.key} data-mm-area-pin={a.key}>{a.popupText}</li>
          ))}
        </ul>
      ) : null}
      <p className="mm-map-credit">
        <a href={OSM_REPORT_ISSUE_URL} target="_blank" rel="noopener noreferrer" data-mm-map-report>
          Report a map issue
        </a>
      </p>
    </section>
  );
}
