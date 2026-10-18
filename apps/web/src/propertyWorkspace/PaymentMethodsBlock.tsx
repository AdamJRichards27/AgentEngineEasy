// Moved unchanged from PropertyWorkspace.tsx so a later shell can reuse this panel.

import { useState } from "react";
import type { PaymentMethodBlock } from "./types";

// Add-a-stored-method form (Phase 6). Real card capture must happen
// client-side via Stripe Elements/PaymentSheet — this only ever accepts the
// resulting tokenized references, never raw card data.
export function PaymentMethodsBlock({
  mine,
  brokerage,
  onAdd,
  error,
}: {
  mine: PaymentMethodBlock[];
  brokerage: PaymentMethodBlock[];
  onAdd: (input: Record<string, unknown>) => void;
  error: string | null;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [scope, setScope] = useState<"Mine" | "Brokerage">("Mine");
  const [label, setLabel] = useState("");
  const [providerCustomerRef, setProviderCustomerRef] = useState("");
  const [providerPaymentMethodRef, setProviderPaymentMethodRef] = useState("");

  const submit = () => {
    onAdd({ scope, label: label || undefined, providerCustomerRef, providerPaymentMethodRef });
    setShowAdd(false);
    setLabel("");
    setProviderCustomerRef("");
    setProviderPaymentMethodRef("");
  };

  return (
    <div>
      <p>Payment method: {mine.length === 0 ? "none on file" : mine.map((m) => m.label ?? `#${m.id}`).join(", ")}</p>
      {brokerage.length > 0 && <p className="muted">Brokerage methods: {brokerage.map((m) => m.label ?? `#${m.id}`).join(", ")}</p>}
      {!showAdd ? (
        <button className="btn btn-secondary" onClick={() => setShowAdd(true)}>
          + Add Payment Method
        </button>
      ) : (
        <div className="stack">
          <p className="muted">
            Card capture happens through the payment provider directly, not this app — paste the resulting reference here for now
            (real in-app card entry is a follow-up build).
          </p>
          <select value={scope} onChange={(e) => setScope(e.target.value as "Mine" | "Brokerage")}>
            <option value="Mine">Mine</option>
            <option value="Brokerage">Brokerage</option>
          </select>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. Visa ending 4242)" />
          <input value={providerCustomerRef} onChange={(e) => setProviderCustomerRef(e.target.value)} placeholder="Provider customer reference" />
          <input
            value={providerPaymentMethodRef}
            onChange={(e) => setProviderPaymentMethodRef(e.target.value)}
            placeholder="Provider payment method reference"
          />
          <div className="inline-form">
            <button className="btn btn-primary" onClick={submit} disabled={!providerCustomerRef || !providerPaymentMethodRef}>
              Save
            </button>
            <button className="btn btn-link" onClick={() => setShowAdd(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
