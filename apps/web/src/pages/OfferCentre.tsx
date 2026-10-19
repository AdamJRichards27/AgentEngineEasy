// #34 slice 2 — Offer Centre (Run). Read-only list of offers across the
// brokerage's properties, from GET /api/offers/centre (requireAuth +
// run.access). No accept/decline/withdraw here: those stay on the property's
// Transaction panel. No share tokens or buyer contact details are rendered.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch, apiErrorMessage } from "../lib/api";
import { formatCents, formatDate } from "../lib/financial";
import {
  OFFER_CENTRE_STATUSES,
  fetchBuyerList,
  fetchOfferCentre,
  offerCentrePaging,
  offerStatusPillClass,
  toBuyerView,
  toOfferCentreView,
  type BuyerView,
  type OfferCentreStatus,
  type OfferCentreView,
} from "../lib/offerCentre";

export function OfferCentreList(props: {
  rows: OfferCentreView[];
  total: number;
  limit: number;
  offset: number;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const paging = offerCentrePaging(props);
  if (props.rows.length === 0)
    return <p className="muted">No offers match these filters.</p>;
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
              <td>{formatDate(row.createdAt) ?? "—"}</td>
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
}) {
  const paging = offerCentrePaging(props);
  if (props.rows.length === 0)
    return <p className="muted">No buyers match these filters.</p>;
  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>Buyer</th>
            <th>Property</th>
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
              <td>{formatDate(row.linkedAt) ?? "—"}</td>
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

export default function OfferCentre() {
  const [status, setStatus] = useState<OfferCentreStatus | "">("");
  const [propertyId, setPropertyId] = useState("");
  const [page, setPage] = useState(0);
  const [tab, setTab] = useState<"offers" | "buyers">("offers");
  const [buyerPage, setBuyerPage] = useState(0);
  const filters = { status, propertyId, page };

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["offer-centre", status, propertyId, page],
    queryFn: () => fetchOfferCentre(filters),
    enabled: tab === "offers",
  });
  const buyers = useQuery({
    queryKey: ["offer-centre-buyers", propertyId, buyerPage],
    queryFn: () => fetchBuyerList({ propertyId, page: buyerPage }),
    enabled: tab === "buyers",
  });
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
        buyers.isLoading ? (
          <p className="muted">Loading…</p>
        ) : buyers.isError ? (
          <p className="error-text">
            {apiErrorMessage(buyers.error, "Couldn't load buyers. Try again.")}
          </p>
        ) : (
          <BuyerList
            rows={(buyers.data?.buyers ?? []).map(toBuyerView)}
            total={buyers.data?.total ?? 0}
            limit={buyers.data?.limit ?? 25}
            offset={buyers.data?.offset ?? 0}
            onPrev={() => setBuyerPage((p) => Math.max(0, p - 1))}
            onNext={() => setBuyerPage((p) => p + 1)}
          />
        )
      ) : isLoading ? (
        <p className="muted">Loading…</p>
      ) : isError ? (
        <p className="error-text">
          {apiErrorMessage(error, "Couldn't load offers. Try again.")}
        </p>
      ) : (
        <OfferCentreList
          rows={(data?.offers ?? []).map(toOfferCentreView)}
          total={data?.total ?? 0}
          limit={data?.limit ?? 25}
          offset={data?.offset ?? 0}
          onPrev={() => setPage((p) => Math.max(0, p - 1))}
          onNext={() => setPage((p) => p + 1)}
        />
      )}
    </section>
  );
}
