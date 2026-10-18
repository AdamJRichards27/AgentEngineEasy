// Moved unchanged from PropertyWorkspace.tsx so a later shell can reuse this panel.

import { useState } from "react";

const COMMISSION_TYPES = ["Percentage", "FlatFee"] as const;
// Real structured agency-agreement terms capture (Phase 5).
export function AgencyTermsForm({
  initial,
  onSubmit,
}: {
  initial: {
    commissionType: string;
    commissionRateBps: number | null;
    flatFeeCents: number | null;
    marketingFeeCents: number | null;
    agreementTermDays: number;
  } | null;
  onSubmit: (input: Record<string, unknown>) => void;
}) {
  const [commissionType, setCommissionType] = useState<(typeof COMMISSION_TYPES)[number]>(
    (initial?.commissionType as (typeof COMMISSION_TYPES)[number]) ?? "Percentage",
  );
  const [commissionRate, setCommissionRate] = useState(initial?.commissionRateBps ? (initial.commissionRateBps / 100).toString() : "");
  const [flatFee, setFlatFee] = useState(initial?.flatFeeCents ? (initial.flatFeeCents / 100).toString() : "");
  const [marketingFee, setMarketingFee] = useState(initial?.marketingFeeCents ? (initial.marketingFeeCents / 100).toString() : "");
  const [termDays, setTermDays] = useState(String(initial?.agreementTermDays ?? 90));

  const submit = () => {
    onSubmit({
      commissionType,
      commissionRateBps: commissionType === "Percentage" && commissionRate ? Math.round(Number(commissionRate) * 100) : undefined,
      flatFeeCents: commissionType === "FlatFee" && flatFee ? Math.round(Number(flatFee) * 100) : undefined,
      marketingFeeCents: marketingFee ? Math.round(Number(marketingFee) * 100) : undefined,
      agreementTermDays: Number(termDays) || 90,
    });
  };

  return (
    <div className="stack">
      {!initial && <p className="muted">Not yet captured — the Agency Agreement document can't be generated until these are saved.</p>}
      <div className="inline-form">
        <label>
          Commission type
          <select value={commissionType} onChange={(e) => setCommissionType(e.target.value as (typeof COMMISSION_TYPES)[number])}>
            {COMMISSION_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {commissionType === "Percentage" ? (
          <label>
            Rate (%)
            <input value={commissionRate} onChange={(e) => setCommissionRate(e.target.value)} />
          </label>
        ) : (
          <label>
            Flat fee ($)
            <input value={flatFee} onChange={(e) => setFlatFee(e.target.value)} />
          </label>
        )}
      </div>
      <div className="inline-form">
        <label>
          Marketing fee ($, optional)
          <input value={marketingFee} onChange={(e) => setMarketingFee(e.target.value)} />
        </label>
        <label>
          Term (days)
          <input value={termDays} onChange={(e) => setTermDays(e.target.value)} />
        </label>
      </div>
      <button className="btn btn-secondary" onClick={submit}>
        Save Terms
      </button>
    </div>
  );
}
