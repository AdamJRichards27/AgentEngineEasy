// Moved unchanged from PropertyWorkspace.tsx so a later shell can reuse this panel.

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";
import type { ServiceOrderBlock, PaymentBlock } from "./types";
import { formatCents } from "./types";

// One ServiceOrder (e.g. the AML check) plus its own payment attempts —
// shown as a clean cost summary + Confirm & Continue rather than raw
// provider-reference fields (staging brief's Payment UX).
export function ServiceOrderRow({
  serviceOrder,
  onCharge,
  charging,
  chargeError,
  onRefund,
  refundError,
}: {
  serviceOrder: ServiceOrderBlock;
  onCharge: () => void;
  charging: boolean;
  chargeError: string | null;
  onRefund: (paymentId: number) => void;
  refundError: string | null;
}) {
  const { data } = useQuery({
    queryKey: ["service-order-payments", serviceOrder.id],
    queryFn: () => apiFetch<{ payments: PaymentBlock[] }>(`/payments/service-orders/${serviceOrder.id}/payments`),
  });
  const latest = data?.payments?.[0] ?? null;
  const total = serviceOrder.customerPriceCents + serviceOrder.gstCents;

  return (
    <li>
      <div className="cost-summary">
        <div className="line">
          <span>{serviceOrder.serviceType}</span>
          <span>{formatCents(serviceOrder.customerPriceCents)}</span>
        </div>
        <div className="line">
          <span>GST</span>
          <span>{formatCents(serviceOrder.gstCents)}</span>
        </div>
        <div className="line total">
          <span>Total</span>
          <span>{formatCents(total)}</span>
        </div>
      </div>
      <span className={serviceOrder.paymentStatus === "Charged" ? "pill pill-success" : serviceOrder.paymentStatus === "Failed" ? "pill pill-danger" : "pill"}>
        {serviceOrder.paymentStatus}
      </span>
      {(serviceOrder.paymentStatus === "Pending" || serviceOrder.paymentStatus === "Failed") && (
        <button className="btn btn-primary btn-small" onClick={onCharge} disabled={charging} style={{ marginLeft: "0.5rem" }}>
          {charging ? "Charging…" : serviceOrder.paymentStatus === "Failed" ? "Retry Charge" : "Confirm & Continue"}
        </button>
      )}
      {chargeError && <p className="error-text">{chargeError}</p>}
      {latest?.failureReason && <p className="error-text">Last attempt failed: {latest.failureReason}</p>}
      {latest?.receiptUrl && (
        <p>
          <a href={latest.receiptUrl} target="_blank" rel="noreferrer">
            View receipt
          </a>
        </p>
      )}
      {latest && latest.status === "Succeeded" && (
        <button className="btn btn-link" onClick={() => onRefund(latest.id)}>
          Refund
        </button>
      )}
      {refundError && <p className="error-text">{refundError}</p>}
    </li>
  );
}
