// Moved unchanged from PropertyWorkspace.tsx so a later shell can reuse this panel.

import { useState } from "react";
import type { PartyLink } from "./types";
import { partyName } from "./types";

// Stage D/F (#117) — legal representatives, picked from parties already
// linked to the property with role "Solicitor" (reuses the existing
// party-capture UI/flow rather than inventing a second solicitor entry
// path).
export function LegalRepresentativesForm({
  initial,
  solicitors,
  editable,
  onSave,
}: {
  initial: { sellerSolicitorPartyId?: number | null; buyerSolicitorPartyId?: number | null } | null;
  solicitors: PartyLink[];
  editable: boolean;
  onSave: (input: Record<string, unknown>) => void;
}) {
  const [sellerSolicitorPartyId, setSellerSolicitorPartyId] = useState(
    initial?.sellerSolicitorPartyId ? String(initial.sellerSolicitorPartyId) : "",
  );
  const [buyerSolicitorPartyId, setBuyerSolicitorPartyId] = useState(
    initial?.buyerSolicitorPartyId ? String(initial.buyerSolicitorPartyId) : "",
  );

  if (!editable) {
    const labelFor = (partyId: number | null | undefined) => {
      if (!partyId) return "not recorded";
      const match = solicitors.find((solicitor) => solicitor.partyId === partyId);
      return match ? partyName(match.party) : "not recorded";
    };
    return (
      <div>
        <h3 style={{ marginBottom: "0.4rem" }}>Legal representatives</h3>
        <p className="muted">Seller's solicitor: {labelFor(initial?.sellerSolicitorPartyId)}</p>
        <p className="muted">Buyer's solicitor: {labelFor(initial?.buyerSolicitorPartyId)}</p>
      </div>
    );
  }

  if (solicitors.length === 0 && !initial?.sellerSolicitorPartyId && !initial?.buyerSolicitorPartyId) {
    return (
      <p className="muted">
        No solicitors captured yet — add one under Sellers/Other parties above (role: Solicitor) to record legal representatives here.
      </p>
    );
  }

  const submit = () => {
    onSave({
      sellerSolicitorPartyId: sellerSolicitorPartyId ? Number(sellerSolicitorPartyId) : null,
      buyerSolicitorPartyId: buyerSolicitorPartyId ? Number(buyerSolicitorPartyId) : null,
    });
  };

  return (
    <div>
      <h3 style={{ marginBottom: "0.4rem" }}>Legal representatives</h3>
      <div className="inline-form">
        <label>
          Seller's solicitor
          <select value={sellerSolicitorPartyId} onChange={(e) => setSellerSolicitorPartyId(e.target.value)}>
            <option value="">— none —</option>
            {solicitors.map((s) => (
              <option key={s.partyId} value={s.partyId}>
                {partyName(s.party)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Buyer's solicitor
          <select value={buyerSolicitorPartyId} onChange={(e) => setBuyerSolicitorPartyId(e.target.value)}>
            <option value="">— none —</option>
            {solicitors.map((s) => (
              <option key={s.partyId} value={s.partyId}>
                {partyName(s.party)}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-small" onClick={submit}>
          Save
        </button>
      </div>
    </div>
  );
}
