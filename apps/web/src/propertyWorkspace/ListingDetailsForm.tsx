// Moved unchanged from PropertyWorkspace.tsx so a later shell can reuse this panel.

import { useState } from "react";

// Stage C (#116) — listing preparation fields. Purely descriptive; never
// publishes a listing, orders a supplier, or incurs a cost.
export function ListingDetailsForm({
  initial,
  onSave,
  error,
}: {
  initial: {
    salesMethod: string | null;
    priceDisplay: string | null;
    campaignStartDate: string | null;
    campaignEndDate: string | null;
  };
  onSave: (input: Record<string, unknown>) => void;
  error: string | null;
}) {
  const [salesMethod, setSalesMethod] = useState(initial.salesMethod ?? "");
  const [priceDisplay, setPriceDisplay] = useState(initial.priceDisplay ?? "");
  const [campaignStartDate, setCampaignStartDate] = useState(initial.campaignStartDate ? initial.campaignStartDate.slice(0, 10) : "");
  const [campaignEndDate, setCampaignEndDate] = useState(initial.campaignEndDate ? initial.campaignEndDate.slice(0, 10) : "");

  const submit = () => {
    onSave({
      salesMethod: salesMethod || undefined,
      priceDisplay: priceDisplay || undefined,
      campaignStartDate: campaignStartDate || undefined,
      campaignEndDate: campaignEndDate || undefined,
    });
  };

  return (
    <div className="stack">
      <div className="inline-form">
        <label>
          Sales method
          <input value={salesMethod} onChange={(e) => setSalesMethod(e.target.value)} placeholder="e.g. Auction, Private Treaty" />
        </label>
        <label>
          Price display
          <input value={priceDisplay} onChange={(e) => setPriceDisplay(e.target.value)} placeholder="e.g. Contact Agent, $800,000+" />
        </label>
      </div>
      <div className="inline-form">
        <label>
          Campaign start
          <input type="date" value={campaignStartDate} onChange={(e) => setCampaignStartDate(e.target.value)} />
        </label>
        <label>
          Campaign end
          <input type="date" value={campaignEndDate} onChange={(e) => setCampaignEndDate(e.target.value)} />
        </label>
      </div>
      <button className="btn btn-secondary" onClick={submit}>
        Save Listing Details
      </button>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
