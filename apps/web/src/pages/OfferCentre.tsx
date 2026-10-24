// #34 slice 2 — Offer Centre (Run). Read-only list of offers across the
// brokerage's properties, from GET /api/offers/centre (requireAuth +
// run.access). No accept/decline/withdraw here: those stay on the property's
// Transaction panel. No share tokens or buyer contact details are rendered.
import { useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch } from "../lib/api";
import { offerCentreGateState, type OfferCentreGateState } from "../lib/offerCentreAccess";
import { useEntitlements, useSession } from "../lib/session";
import { formatCents } from "../lib/financial";
import {
  OFFER_CENTRE_STATUSES,
  fetchBuyerList,
  fetchOfferCentre,
  formatOfferCentreDate,
  offerCentreEmptyMessage,
  offerCentreErrorText,
  offerCentreRegionState,
  offerCentrePaging,
  offerStatusPillClass,
  toBuyerView,
  toOfferCentreView,
  type BuyerView,
  type OfferCentreKind,
  type OfferCentreRegionState,
  type OfferCentreStatus,
  type OfferCentreView,
} from "../lib/offerCentre";

// R-05 follow-up — a later page can come back empty (rows removed since the
// count, or a stale offset). Say so and offer a way back to page 1.
function EmptyLaterPage(props: { kind: OfferCentreKind; onFirst?: () => void }) {
  return (
    <div>
      <p className="empty-state" role="status">
        No {props.kind} on this page.
      </p>
      <button
        type="button"
        className="btn btn-secondary btn-small"
        onClick={props.onFirst}
      >
        Back to first page
      </button>
    </div>
  );
}

export function OfferCentreList(props: {
  rows: OfferCentreView[];
  total: number;
  limit: number;
  offset: number;
  onPrev?: () => void;
  onNext?: () => void;
  filtered?: boolean;
  onFirst?: () => void;
}) {
  const paging = offerCentrePaging(props);
  if (props.rows.length === 0 && props.offset > 0)
    return <EmptyLaterPage kind="offers" onFirst={props.onFirst} />;
  if (props.rows.length === 0)
    return (
      <p className="empty-state" role="status">
        {offerCentreEmptyMessage("offers", props.filtered ?? true)}
      </p>
    );
  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>Property</th>
            <th>Buyer</th>
            <th>Price</th>
            <th>Status</th>
            <th>Received</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr key={row.id}>
              <td>
                <Link href={`/properties/${row.propertyId}`}>
                  {row.propertyAddress}
                </Link>
              </td>
              <td>{row.buyerName ?? "—"}</td>
              <td>{formatCents(row.offerPriceCents)}</td>
              <td>
                <span className={offerStatusPillClass(row.status)}>
                  {row.status}
                </span>
              </td>
              <td>{formatOfferCentreDate(row.createdAt) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="inline-form">
        <button
          className="btn btn-small"
          onClick={props.onPrev}
          disabled={!paging.hasPrev}
        >
          Previous
        </button>
        <span className="muted">
          Showing {paging.from}–{paging.to} of {props.total}
        </span>
        <button
          className="btn btn-small"
          onClick={props.onNext}
          disabled={!paging.hasNext}
        >
          Next
        </button>
      </div>
    </>
  );
}

export function BuyerList(props: {
  rows: BuyerView[];
  total: number;
  limit: number;
  offset: number;
  onPrev?: () => void;
  onNext?: () => void;
  filtered?: boolean;
  onFirst?: () => void;
}) {
  const paging = offerCentrePaging(props);
  if (props.rows.length === 0 && props.offset > 0)
    return <EmptyLaterPage kind="buyers" onFirst={props.onFirst} />;
  if (props.rows.length === 0)
    return (
      <p className="empty-state" role="status">
        {offerCentreEmptyMessage("buyers", props.filtered ?? true)}
      </p>
    );
  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>Buyer</th>
            <th>Property</th>
            <th>Offers</th>
            <th>Linked</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr key={row.linkId}>
              <td>{row.buyerName ?? "—"}</td>
              <td>
                <Link href={`/properties/${row.propertyId}`}>
                  {row.propertyAddress}
                </Link>
              </td>
              <td>{row.offerCount}</td>
              <td>{formatOfferCentreDate(row.linkedAt) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="inline-form">
        <button
          className="btn btn-small"
          onClick={props.onPrev}
          disabled={!paging.hasPrev}
        >
          Previous
        </button>
        <span className="muted">
          Showing {paging.from}–{paging.to} of {props.total}
        </span>
        <button
          className="btn btn-small"
          onClick={props.onNext}
          disabled={!paging.hasNext}
        >
          Next
        </button>
      </div>
    </>
  );
}

// R-05 — the results region for one tab. aria-busy is true while its query
// is fetching (first load or a background page change); loading and empty
// are polite role=status messages, a failure is role=alert with a Try again
// that refetches only this tab's query.
export function OfferCentreRegion(props: {
  kind: OfferCentreKind;
  state: OfferCentreRegionState;
  busy: boolean;
  error?: unknown;
  onRetry: () => void;
  children?: ReactNode;
}) {
  let body: ReactNode = props.children;
  if (props.state === "loading") {
    body = (
      <p className="muted" role="status" aria-live="polite">
        Loading {props.kind}…
      </p>
    );
  } else if (props.state === "error") {
    const { message, reference } = offerCentreErrorText(props.error, props.kind);
    body = (
      <div role="alert">
        <p className="error-text">{message}</p>
        {reference !== undefined && (
          <p className="muted">
            If this keeps happening, contact support and quote{" "}
            <strong>{reference}</strong>.
          </p>
        )}
        <button
          type="button"
          className="btn btn-secondary btn-small"
          onClick={props.onRetry}
        >
          Try again
        </button>
      </div>
    );
  }
  return <div aria-busy={props.busy ? "true" : "false"}>{body}</div>;
}

// Owner t165u: the page self-gates like Financial Operations. Until the session
// and entitlements say run.access + Agent/Brokerage Administrator, the content
// (and so every offer/buyer query) never mounts. The API stays authoritative.
export function OfferCentreGate(props: { state: OfferCentreGateState; children: ReactNode }) {
  if (props.state === "loading") return <p className="muted">Loading…</p>;
  if (props.state === "denied") {
    return (
      <div className="primary-action">
        <div className="eyebrow">Offer Centre</div>
        <h1>Not available</h1>
        <p className="muted">The Offer Centre is only available to Agents and Brokerage Administrators.</p>
      </div>
    );
  }
  return <>{props.children}</>;
}

export default function OfferCentre() {
  const { user, isLoading: sessionLoading } = useSession();
  const { entitlements, isLoading: entitlementsLoading } = useEntitlements();
  const state = offerCentreGateState({
    loading: sessionLoading || entitlementsLoading,
    role: user?.role,
    entitlements,
  });
  return (
    <OfferCentreGate state={state}>
      <OfferCentreContent />
    </OfferCentreGate>
  );
}

function OfferCentreContent() {
  const [status, setStatus] = useState<OfferCentreStatus | "">("");
  const [propertyId, setPropertyId] = useState("");
  const [page, setPage] = useState(0);
  const [tab, setTab] = useState<"offers" | "buyers">("offers");
  const [buyerPage, setBuyerPage] = useState(0);
  const filters = { status, propertyId, page };

  const offers = useQuery({
    queryKey: ["offer-centre", status, propertyId, page],
    queryFn: () => fetchOfferCentre(filters),
    enabled: tab === "offers",
    placeholderData: keepPreviousData,
  });
  const buyers = useQuery({
    queryKey: ["offer-centre-buyers", propertyId, buyerPage],
    queryFn: () => fetchBuyerList({ propertyId, page: buyerPage }),
    enabled: tab === "buyers",
    placeholderData: keepPreviousData,
  });
  const offersState = offerCentreRegionState(offers, offers.data?.offers.length);
  const buyersState = offerCentreRegionState(buyers, buyers.data?.buyers.length);
  const { data: propertiesData } = useQuery({
    queryKey: ["properties", ""],
    queryFn: () =>
      apiFetch<{ properties: Array<{ id: number; formattedAddress: string }> }>(
        "/properties",
      ),
  });

  return (
    <section className="card">
      <h1>Offer Centre</h1>
      <div className="inline-form">
        <button
          className={
            tab === "offers" ? "btn btn-small" : "btn btn-secondary btn-small"
          }
          onClick={() => setTab("offers")}
        >
          Offers
        </button>
        <button
          className={
            tab === "buyers" ? "btn btn-small" : "btn btn-secondary btn-small"
          }
          onClick={() => setTab("buyers")}
        >
          Buyers
        </button>
      </div>
      <p className="muted">
        Offers across your brokerage's properties. Open a property to accept,
        decline, or withdraw.
      </p>
      <div className="inline-form">
        {tab === "offers" && (
          <label>
            Status
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as OfferCentreStatus | "");
                setPage(0);
              }}
            >
              <option value="">All</option>
              {OFFER_CENTRE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Property
          <select
            value={propertyId}
            onChange={(e) => {
              setPropertyId(e.target.value);
              setPage(0);
              setBuyerPage(0);
            }}
          >
            <option value="">All properties</option>
            {(propertiesData?.properties ?? []).map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.formattedAddress}
              </option>
            ))}
          </select>
        </label>
      </div>
      {tab === "buyers" ? (
        <OfferCentreRegion
          kind="buyers"
          state={buyersState}
          busy={buyers.isFetching}
          error={buyers.error}
          onRetry={() => void buyers.refetch()}
        >
          <BuyerList
            rows={(buyers.data?.buyers ?? []).map(toBuyerView)}
            total={buyers.data?.total ?? 0}
            limit={buyers.data?.limit ?? 25}
            offset={buyers.data?.offset ?? 0}
            filtered={propertyId !== ""}
            onFirst={() => setBuyerPage(0)}
            onPrev={() => setBuyerPage((p) => Math.max(0, p - 1))}
            onNext={() => setBuyerPage((p) => p + 1)}
          />
        </OfferCentreRegion>
      ) : (
        <OfferCentreRegion
          kind="offers"
          state={offersState}
          busy={offers.isFetching}
          error={offers.error}
          onRetry={() => void offers.refetch()}
        >
          <OfferCentreList
            rows={(offers.data?.offers ?? []).map(toOfferCentreView)}
            total={offers.data?.total ?? 0}
            limit={offers.data?.limit ?? 25}
            offset={offers.data?.offset ?? 0}
            filtered={status !== "" || propertyId !== ""}
            onFirst={() => setPage(0)}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </OfferCentreRegion>
      )}
    </section>
  );
}
