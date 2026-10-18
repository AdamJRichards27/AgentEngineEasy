// Moved unchanged from PropertyWorkspace.tsx so a later shell can reuse this panel.

import { useState } from "react";
import type { OfferBlock } from "./types";
import { formatCents } from "./types";

function offerStatusLabel(o: OfferBlock): string {
  return `${formatCents(o.offerPriceCents)} — ${o.status}`;
}
// Offer capture + acceptance (Phase 7).
export function OffersBlock({
  offers,
  onCreate,
  createError,
  onAccept,
  acceptError,
  onDecline,
  onWithdraw,
}: {
  offers: OfferBlock[];
  onCreate: (input: Record<string, unknown>) => void;
  createError: string | null;
  onAccept: (offerId: number) => void;
  acceptError: string | null;
  onDecline: (offerId: number) => void;
  onWithdraw: (offerId: number) => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [offerPrice, setOfferPrice] = useState("");
  const [deposit, setDeposit] = useState("");
  const [settlementDate, setSettlementDate] = useState("");
  const [conditions, setConditions] = useState("");
  const [additionalTerms, setAdditionalTerms] = useState("");
  const [buyerFirstName, setBuyerFirstName] = useState("");
  const [buyerLastName, setBuyerLastName] = useState("");
  const [buyerEmail, setBuyerEmail] = useState("");
  const [buyerMobile, setBuyerMobile] = useState("");

  const submit = () => {
    onCreate({
      offerPriceCents: Math.round(Number(offerPrice) * 100),
      conditions: {
        depositCents: deposit ? Math.round(Number(deposit) * 100) : undefined,
        settlementDate: settlementDate || undefined,
        conditions: conditions || undefined,
        additionalTerms: additionalTerms || undefined,
      },
      buyer: {
        firstName: buyerFirstName || undefined,
        lastName: buyerLastName || undefined,
        email: buyerEmail || undefined,
        mobile: buyerMobile || undefined,
      },
    });
    setShowAdd(false);
    setOfferPrice("");
    setDeposit("");
    setSettlementDate("");
    setConditions("");
    setAdditionalTerms("");
    setBuyerFirstName("");
    setBuyerLastName("");
    setBuyerEmail("");
    setBuyerMobile("");
  };

  const hasAccepted = offers.some((o) => o.status === "Accepted");

  return (
    <div>
      {offers.length === 0 ? (
        <p className="muted">No offers recorded yet.</p>
      ) : (
        <ul className="item-list">
          {offers.map((o) => (
            <li key={o.id}>
              {offerStatusLabel(o)}
              {o.status === "Received" && (
                <div className="inline-form" style={{ marginTop: "0.4rem" }}>
                  <button className="btn btn-primary btn-small" onClick={() => onAccept(o.id)} disabled={hasAccepted}>
                    Accept
                  </button>
                  <button className="btn btn-small" onClick={() => onDecline(o.id)}>
                    Decline
                  </button>
                  <button className="btn btn-link" onClick={() => onWithdraw(o.id)}>
                    Withdraw
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {acceptError && <p className="error-text">{acceptError}</p>}

      {!hasAccepted &&
        (!showAdd ? (
          <button className="btn btn-secondary" onClick={() => setShowAdd(true)}>
            + Record Offer
          </button>
        ) : (
          <div className="stack card">
            <div className="inline-form">
              <label>
                Offer price ($)
                <input value={offerPrice} onChange={(e) => setOfferPrice(e.target.value)} />
              </label>
              <label>
                Deposit ($)
                <input value={deposit} onChange={(e) => setDeposit(e.target.value)} />
              </label>
            </div>
            <div className="inline-form">
              <label>
                Settlement date
                <input type="date" value={settlementDate} onChange={(e) => setSettlementDate(e.target.value)} />
              </label>
              <label>
                Conditions
                <input value={conditions} onChange={(e) => setConditions(e.target.value)} placeholder="e.g. Subject to finance" />
              </label>
            </div>
            <label>
              Additional terms
              <input value={additionalTerms} onChange={(e) => setAdditionalTerms(e.target.value)} />
            </label>
            <h3 style={{ marginTop: "0.5rem" }}>Buyer</h3>
            <div className="inline-form">
              <label>
                First name
                <input value={buyerFirstName} onChange={(e) => setBuyerFirstName(e.target.value)} />
              </label>
              <label>
                Last name
                <input value={buyerLastName} onChange={(e) => setBuyerLastName(e.target.value)} />
              </label>
            </div>
            <div className="inline-form">
              <label>
                Email
                <input value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} />
              </label>
              <label>
                Mobile
                <input value={buyerMobile} onChange={(e) => setBuyerMobile(e.target.value)} />
              </label>
            </div>
            <div className="inline-form">
              <button className="btn btn-primary" onClick={submit} disabled={!offerPrice || !buyerFirstName}>
                Save
              </button>
              <button className="btn btn-link" onClick={() => setShowAdd(false)}>
                Cancel
              </button>
            </div>
          </div>
        ))}
      {createError && <p className="error-text">{createError}</p>}
    </div>
  );
}
