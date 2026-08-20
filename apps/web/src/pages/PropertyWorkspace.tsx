import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

interface PropertyOverview {
  id: number;
  formattedAddress: string;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
  isManualAddress: boolean;
  workflowStage: string;
  amlStatusSummary: string;
  listingStatus: string;
}

interface OwnershipRecord {
  ownerName: string;
  ownershipType?: string;
}

interface OwnershipBlock {
  data: OwnershipRecord[] | null;
  reviewRequired: boolean;
  reviewedBy: number | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
}

interface PartyLink {
  linkId: number;
  role: string;
  isPrimary: boolean;
  partyId: number;
  party: { firstName?: string; lastName?: string; organisationName?: string; email?: string; mobile?: string } | null;
  amlStatus: string | null;
  amlVerificationId: number | null;
  amlException: { outcome: string | null; riskLevel: string | null } | null;
}

interface DocumentPackageBlock {
  id: number;
  status: string;
  documents: Array<{ id: number; documentType: string; title: string; status: string }>;
  signatureRequest: { id: number; status: string; sentAt: string | null; completedAt: string | null } | null;
}

interface AgencyAgreementTermsBlock {
  id: number;
  commissionType: string;
  commissionRateBps: number | null;
  flatFeeCents: number | null;
  marketingFeeCents: number | null;
  agreementTermDays: number;
}

interface ServiceOrderBlock {
  id: number;
  propertyId: number;
  serviceType: string;
  provider: string;
  customerPriceCents: number;
  gstCents: number;
  paymentStatus: string;
  status: string;
}

interface PaymentMethodBlock {
  id: number;
  payerType: string;
  payerId: number;
  provider: string;
  label: string | null;
  isDefault: boolean;
}

interface PaymentBlock {
  id: number;
  status: string;
  amountCents: number;
  receiptUrl: string | null;
  failureReason: string | null;
}

interface OfferBlock {
  id: number;
  propertyId: number;
  buyerPartyId: number | null;
  offerPriceCents: number;
  status: string;
  shareToken: string | null;
  createdAt: string;
}

interface TransactionBlock {
  id: number;
  propertyId: number;
  purchasePriceCents: number;
  contractDate: string | null;
  financeApprovedAt: string | null;
  settlementDate: string | null;
  settlementCompletedAt: string | null;
  status: string;
  grossCommissionCents: number | null;
  gstCents: number | null;
  commissionCalculatedAt: string | null;
  fundsReceivedCents: number;
  fundsReceivedAt: string | null;
  agentPaidAt: string | null;
  closedAt: string | null;
}

interface WorkspaceResponse {
  property: PropertyOverview;
  ownership: OwnershipBlock;
  parties: PartyLink[];
  nextActions: Array<{ label: string; status: string; blockedReason?: string | null }>;
  documentPackage: DocumentPackageBlock | null;
  agencyAgreementTerms: AgencyAgreementTermsBlock | null;
}

const ROLES = ["Seller", "Buyer", "Solicitor", "PowerOfAttorney", "Other"] as const;
const PARTY_TYPES = ["Person", "Organisation", "Trust", "Estate", "Other"] as const;

function partyName(p: PartyLink["party"]): string {
  if (!p) return "—";
  return p.organisationName || `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || "—";
}

// The Property Action Screen (Build Brief §13 / ARCHITECTURE.md §4) — the
// screen the whole build orients around. Answers "what needs to happen
// next?" with one primary action, not a module menu.
export default function PropertyWorkspace({ params }: { params: { id: string } }) {
  const propertyId = Number(params.id);
  const queryClient = useQueryClient();
  const [showAddParty, setShowAddParty] = useState(false);
  const [reviewNotes, setReviewNotes] = useState("");
  const [exceptionNotes, setExceptionNotes] = useState<Record<number, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: ["property-workspace", propertyId],
    queryFn: () => apiFetch<WorkspaceResponse>(`/properties/${propertyId}/workspace`),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["property-workspace", propertyId] });

  const readyToList = useMutation({
    mutationFn: () => apiFetch(`/properties/${propertyId}/ready-to-list`, { method: "POST" }),
    onSuccess: invalidate,
  });

  const resolveOwnershipReview = useMutation({
    mutationFn: () =>
      apiFetch(`/properties/${propertyId}/ownership-review`, {
        method: "POST",
        body: JSON.stringify({ notes: reviewNotes || undefined }),
      }),
    onSuccess: () => {
      setReviewNotes("");
      invalidate();
    },
  });

  const removeParty = useMutation({
    mutationFn: (linkId: number) => apiFetch(`/parties/link/${linkId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  // AML exception handling (Phase 4): retry re-runs the check; resolve
  // records a Brokerage Administrator's compliance decision (mandatory
  // notes, enforced server-side too) rather than silently overriding a
  // failed/flagged outcome.
  const retryAml = useMutation({
    mutationFn: (verificationId: number) => apiFetch(`/aml/${verificationId}/retry`, { method: "POST" }),
    onSuccess: invalidate,
  });

  const resolveAmlException = useMutation({
    mutationFn: ({ verificationId, notes }: { verificationId: number; notes: string }) =>
      apiFetch(`/aml/${verificationId}/resolve-exception`, { method: "POST", body: JSON.stringify({ notes }) }),
    onSuccess: (_data, variables) => {
      setExceptionNotes((prev) => ({ ...prev, [variables.verificationId]: "" }));
      invalidate();
    },
  });

  const addParty = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch("/parties", { method: "POST", body: JSON.stringify({ propertyId, ...input }) }),
    onSuccess: () => {
      setShowAddParty(false);
      invalidate();
    },
  });

  // Phase 5: agency agreement terms capture, template population, and
  // send-for-signature.
  const saveAgencyTerms = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch(`/documents/agency-agreement-terms/${propertyId}`, { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: invalidate,
  });

  const populatePackage = useMutation({
    mutationFn: (packageId: number) => apiFetch(`/documents/packages/${packageId}/populate`, { method: "POST" }),
    onSuccess: invalidate,
  });

  const sendForSignature = useMutation({
    mutationFn: (packageId: number) => apiFetch(`/documents/packages/${packageId}/send-for-signature`, { method: "POST" }),
    onSuccess: invalidate,
  });

  // Phase 6: service charges (AML etc., billed via ServiceOrder) + stored
  // payment methods. Actual charging goes through the same idempotent
  // chokepoint pattern as the rest of the app — see lib/payments.ts.
  const { data: serviceOrdersData } = useQuery({
    queryKey: ["service-orders", propertyId],
    queryFn: () => apiFetch<{ serviceOrders: ServiceOrderBlock[] }>(`/aml/service-orders/by-property/${propertyId}`),
  });

  const { data: paymentMethodsData } = useQuery({
    queryKey: ["payment-methods"],
    queryFn: () => apiFetch<{ mine: PaymentMethodBlock[]; brokerage: PaymentMethodBlock[] }>("/payments/payment-methods"),
  });

  const invalidateServiceOrders = () => queryClient.invalidateQueries({ queryKey: ["service-orders", propertyId] });

  const addPaymentMethod = useMutation({
    mutationFn: (input: Record<string, unknown>) => apiFetch("/payments/payment-methods", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["payment-methods"] }),
  });

  const chargeServiceOrder = useMutation({
    mutationFn: (serviceOrderId: number) => apiFetch(`/payments/service-orders/${serviceOrderId}/charge`, { method: "POST" }),
    onSuccess: (_data, serviceOrderId) => {
      invalidateServiceOrders();
      queryClient.invalidateQueries({ queryKey: ["service-order-payments", serviceOrderId] });
    },
  });

  const refundPayment = useMutation({
    mutationFn: ({ paymentId, serviceOrderId }: { paymentId: number; serviceOrderId: number }) =>
      apiFetch(`/payments/${paymentId}/refund`, { method: "POST" }).then((r) => ({ result: r, serviceOrderId })),
    onSuccess: ({ serviceOrderId }) => {
      invalidateServiceOrders();
      queryClient.invalidateQueries({ queryKey: ["service-order-payments", serviceOrderId] });
    },
  });

  // Phase 7: Go Live, offer capture/acceptance, and the Transaction
  // lifecycle (contract → settlement → payout → close). Mirrors the
  // idempotent-chokepoint pattern used everywhere else — accepting an
  // already-accepted offer, or closing an already-closed transaction, is
  // just a no-op response from the server, not a client-side guess.
  const goLive = useMutation({
    mutationFn: () => apiFetch(`/properties/${propertyId}/go-live`, { method: "POST" }),
    onSuccess: invalidate,
  });

  const { data: offersData } = useQuery({
    queryKey: ["offers", propertyId],
    queryFn: () => apiFetch<{ offers: OfferBlock[] }>(`/offers/by-property/${propertyId}`),
  });
  const invalidateOffers = () => queryClient.invalidateQueries({ queryKey: ["offers", propertyId] });

  const { data: transactionData } = useQuery({
    queryKey: ["transaction", propertyId],
    queryFn: () => apiFetch<{ transaction: TransactionBlock | null }>(`/transactions/by-property/${propertyId}`),
  });
  const invalidateTransaction = () => queryClient.invalidateQueries({ queryKey: ["transaction", propertyId] });

  const createOffer = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch(`/offers/by-property/${propertyId}`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: invalidateOffers,
  });

  const acceptOffer = useMutation({
    mutationFn: (offerId: number) => apiFetch(`/offers/${offerId}/accept`, { method: "POST" }),
    onSuccess: () => {
      invalidateOffers();
      invalidateTransaction();
      invalidate();
    },
  });

  const declineOffer = useMutation({
    mutationFn: (offerId: number) => apiFetch(`/offers/${offerId}/decline`, { method: "POST" }),
    onSuccess: invalidateOffers,
  });

  const withdrawOffer = useMutation({
    mutationFn: (offerId: number) => apiFetch(`/offers/${offerId}/withdraw`, { method: "POST" }),
    onSuccess: invalidateOffers,
  });

  const transactionAction = useMutation({
    mutationFn: ({ transactionId, action, body }: { transactionId: number; action: string; body?: Record<string, unknown> }) =>
      apiFetch(`/transactions/${transactionId}/${action}`, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
    onSuccess: () => {
      invalidateTransaction();
      invalidate();
    },
  });

  const [preview, setPreview] = useState<{ documentId: number; content: string } | null>(null);
  const previewDocument = async (documentId: number) => {
    const res = await fetch(`/api/documents/${documentId}/content`);
    const content = res.ok ? await res.text() : `Could not load content (${res.status}).`;
    setPreview({ documentId, content });
  };

  if (isLoading || !data) return <p>Loading…</p>;

  const sellers = data.parties.filter((p) => p.role === "Seller");
  const others = data.parties.filter((p) => p.role !== "Seller");

  return (
    <div>
      <h1>{data.property.formattedAddress}</h1>

      {/* Property overview (ARCHITECTURE.md §10 Phase 2) */}
      <section>
        <h2>Overview</h2>
        <p>Stage: {data.property.workflowStage}</p>
        <p>
          {[data.property.suburb, data.property.state, data.property.postcode].filter(Boolean).join(", ") ||
            (data.property.isManualAddress ? "Manually entered address — no further detail available." : "—")}
        </p>
        <p>AML: {data.property.amlStatusSummary} · Listing: {data.property.listingStatus}</p>
      </section>

      {/* Ownership review — review, not block (Build Brief §8) */}
      {data.ownership.reviewRequired && (
        <section style={{ border: "1px solid", padding: "0.75rem" }}>
          <h2>Ownership review</h2>
          <p>
            The seller(s) entered don't clearly match the title ownership data on file. This does not block
            progress — trusts, companies, estates, and powers of attorney can legitimately differ. Review and
            clear when satisfied.
          </p>
          {data.ownership.data && (
            <ul>
              {data.ownership.data.map((o, i) => (
                <li key={i}>
                  {o.ownerName}
                  {o.ownershipType ? ` (${o.ownershipType})` : ""}
                </li>
              ))}
            </ul>
          )}
          <input
            value={reviewNotes}
            onChange={(e) => setReviewNotes(e.target.value)}
            placeholder="Optional note (e.g. selling via Power of Attorney)"
          />
          <button onClick={() => resolveOwnershipReview.mutate()}>Mark Reviewed</button>
        </section>
      )}
      {!data.ownership.reviewRequired && data.ownership.reviewNotes && (
        <p>Ownership reviewed: {data.ownership.reviewNotes}</p>
      )}

      <section>
        <h2>People</h2>

        <h3>Sellers</h3>
        {sellers.length === 0 ? <p>No sellers captured yet.</p> : null}
        <ul>
          {sellers.map((p) => (
            <li key={p.linkId}>
              {partyName(p.party)}
              {p.isPrimary ? " (primary)" : ""}
              {p.amlStatus ? ` — AML: ${p.amlStatus}` : ""}
              <button onClick={() => removeParty.mutate(p.linkId)}>Remove</button>

              {/* AML exception (Phase 4): Review Required / Failed never
                  silently clears — retry re-runs the check, resolving
                  requires a note and is a Brokerage Administrator action. */}
              {p.amlException && p.amlVerificationId && (
                <div style={{ border: "1px solid", padding: "0.5rem", marginTop: "0.25rem" }}>
                  <p>
                    AML exception{p.amlException.outcome ? ` (${p.amlException.outcome})` : ""}
                    {p.amlException.riskLevel ? ` — risk: ${p.amlException.riskLevel}` : ""}
                  </p>
                  <button onClick={() => retryAml.mutate(p.amlVerificationId!)}>Retry check</button>
                  <input
                    value={exceptionNotes[p.amlVerificationId] ?? ""}
                    onChange={(e) =>
                      setExceptionNotes((prev) => ({ ...prev, [p.amlVerificationId!]: e.target.value }))
                    }
                    placeholder="Compliance note (required to resolve)"
                  />
                  <button
                    onClick={() =>
                      resolveAmlException.mutate({
                        verificationId: p.amlVerificationId!,
                        notes: exceptionNotes[p.amlVerificationId!] ?? "",
                      })
                    }
                    disabled={!(exceptionNotes[p.amlVerificationId] ?? "").trim()}
                  >
                    Mark Resolved
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>

        {others.length > 0 && (
          <>
            <h3>Other parties</h3>
            <ul>
              {others.map((p) => (
                <li key={p.linkId}>
                  {p.role}: {partyName(p.party)}
                  <button onClick={() => removeParty.mutate(p.linkId)}>Remove</button>
                </li>
              ))}
            </ul>
          </>
        )}

        {!showAddParty ? (
          <button onClick={() => setShowAddParty(true)}>+ Add Person</button>
        ) : (
          <AddPartyForm onCancel={() => setShowAddParty(false)} onSubmit={(input) => addParty.mutate(input)} />
        )}
      </section>

      <section>
        <h2>Next Actions</h2>
        {data.nextActions.length === 0 ? (
          <p>No active workflow yet.</p>
        ) : (
          <ul>
            {data.nextActions.map((a, i) => (
              <li key={i}>
                {a.label} — {a.status}
                {a.blockedReason ? ` (${a.blockedReason})` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Agency agreement terms (Phase 5) — real structured fields (Build
          Brief §3 explicitly rejected the legacy app's opaque-JSON
          commission storage). Required before the AgencyAgreement document
          itself can be generated — see the "not yet captured" note below. */}
      {data.documentPackage && (
        <section>
          <h2>Agency agreement terms</h2>
          <AgencyTermsForm
            initial={data.agencyAgreementTerms}
            onSubmit={(input) => saveAgencyTerms.mutate(input)}
          />
        </section>
      )}

      {/* Required documents (ARCHITECTURE.md §10 Phase 3/5) — determined by
          Ready to List, generated and sent for signature here. Every
          generated document is a placeholder — see the disclaimer banner in
          its content — pending real legal review. */}
      {data.documentPackage && (
        <section>
          <h2>Required Documents</h2>
          <p>Package status: {data.documentPackage.status}</p>
          <ul>
            {data.documentPackage.documents.map((d) => (
              <li key={d.id}>
                {d.title} — {d.status}
                {(d.status === "Generated" || d.status === "Signed") && (
                  <button onClick={() => previewDocument(d.id)}>Preview</button>
                )}
              </li>
            ))}
          </ul>
          <button onClick={() => populatePackage.mutate(data.documentPackage!.id)}>Generate Documents</button>
          {((populatePackage.data as any)?.skipped?.length ?? 0) > 0 && (
            <p>
              {(populatePackage.data as any).skipped
                .map((s: { reason: string }) => s.reason)
                .join(" ")}
            </p>
          )}
          {populatePackage.isError && <p>{(populatePackage.error as Error).message}</p>}

          <button
            onClick={() => sendForSignature.mutate(data.documentPackage!.id)}
            disabled={data.documentPackage.status !== "Ready"}
          >
            Send for Signature
          </button>
          {data.documentPackage.status !== "Ready" && data.documentPackage.status !== "Sent" && data.documentPackage.status !== "Completed" && (
            <p>Generate every document before sending for signature.</p>
          )}
          {sendForSignature.isError && <p>{(sendForSignature.error as Error).message}</p>}

          {data.documentPackage.signatureRequest && (
            <p>
              Signature status: {data.documentPackage.signatureRequest.status}
              {data.documentPackage.signatureRequest.completedAt
                ? ` (completed ${data.documentPackage.signatureRequest.completedAt})`
                : ""}
            </p>
          )}

          {preview && (
            <div style={{ border: "1px solid", padding: "0.5rem", marginTop: "0.5rem" }}>
              <button onClick={() => setPreview(null)}>Close preview</button>
              <pre style={{ whiteSpace: "pre-wrap" }}>{preview.content}</pre>
            </div>
          )}
        </section>
      )}

      {/* Service charges & payment methods (Phase 6, ARCHITECTURE.md §10) —
          ServiceOrder rows (e.g. the AML check) get created elsewhere
          (lib/aml.ts); this is where they're actually charged. Charging
          resolves to the listing agent's own default stored method. */}
      <section>
        <h2>Payment methods</h2>
        <PaymentMethodsBlock
          mine={paymentMethodsData?.mine ?? []}
          brokerage={paymentMethodsData?.brokerage ?? []}
          onAdd={(input) => addPaymentMethod.mutate(input)}
          error={addPaymentMethod.isError ? (addPaymentMethod.error as Error).message : null}
        />
      </section>

      {serviceOrdersData && serviceOrdersData.serviceOrders.length > 0 && (
        <section>
          <h2>Service charges</h2>
          <ul>
            {serviceOrdersData.serviceOrders.map((so) => (
              <ServiceOrderRow
                key={so.id}
                serviceOrder={so}
                onCharge={() => chargeServiceOrder.mutate(so.id)}
                charging={chargeServiceOrder.isPending && chargeServiceOrder.variables === so.id}
                chargeError={
                  chargeServiceOrder.isError && chargeServiceOrder.variables === so.id
                    ? (chargeServiceOrder.error as Error).message
                    : null
                }
                onRefund={(paymentId) => refundPayment.mutate({ paymentId, serviceOrderId: so.id })}
                refundError={refundPayment.isError ? (refundPayment.error as Error).message : null}
              />
            ))}
          </ul>
        </section>
      )}

      {data.property.workflowStage === "Appraisal" && (
        <div>
          <button onClick={() => readyToList.mutate()} disabled={sellers.length === 0}>
            Ready to List
          </button>
          {sellers.length === 0 && <p>Capture at least one seller before Ready to List.</p>}
          {readyToList.isError && <p>{(readyToList.error as Error).message}</p>}
        </div>
      )}

      {/* Go Live (Phase 7) — gated server-side on every Ready to List step
          being Complete, not just on having been clicked. */}
      {data.property.workflowStage === "Ready to List" && (
        <div>
          <button onClick={() => goLive.mutate()}>Go Live</button>
          {goLive.isError && (
            <p>
              {(goLive.error as Error).message} — check every Next Action above is Complete (Ready to List must fully
              finish before a property can go live).
            </p>
          )}
        </div>
      )}

      {/* Offers (Phase 7) — agent-entered (a buyer submits to the agent by
          phone/email/in person, not via a public form); accepting one
          auto-declines every other open offer and creates the Transaction. */}
      {(data.property.listingStatus === "Listed" || (offersData?.offers.length ?? 0) > 0) && (
        <section>
          <h2>Offers</h2>
          <OffersBlock
            offers={offersData?.offers ?? []}
            onCreate={(input) => createOffer.mutate(input)}
            createError={createOffer.isError ? (createOffer.error as Error).message : null}
            onAccept={(id) => acceptOffer.mutate(id)}
            acceptError={acceptOffer.isError ? (acceptOffer.error as Error).message : null}
            onDecline={(id) => declineOffer.mutate(id)}
            onWithdraw={(id) => withdrawOffer.mutate(id)}
          />
        </section>
      )}

      {/* Transaction (Phase 7) — created the moment an offer is accepted;
          walks contract signing → settlement → payout → close. Agent-paid
          and close are Brokerage Administrator actions server-side — the
          buttons here are shown to everyone (this app has no client-side
          role awareness yet, same as the refund button in Payments above)
          and the server's 403 surfaces as the action's error message. */}
      {transactionData?.transaction && (
        <section>
          <h2>Transaction</h2>
          <TransactionBlockView
            transaction={transactionData.transaction}
            onAction={(action, body) => transactionAction.mutate({ transactionId: transactionData.transaction!.id, action, body })}
            error={transactionAction.isError ? (transactionAction.error as Error).message : null}
          />
        </section>
      )}
    </div>
  );
}

// Minimal one-time capture form (Build Brief §4) — every field here is
// captured once against the property and reused everywhere downstream
// (AML, agency agreement, contract) via the PropertyParty join.
function AddPartyForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (input: Record<string, unknown>) => void;
}) {
  const [role, setRole] = useState<(typeof ROLES)[number]>("Seller");
  const [partyType, setPartyType] = useState<(typeof PARTY_TYPES)[number]>("Person");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [organisationName, setOrganisationName] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");

  const submit = () => {
    onSubmit({
      role,
      partyType,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      organisationName: organisationName || undefined,
      email: email || undefined,
      mobile: mobile || undefined,
    });
  };

  return (
    <div>
      <select value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <select value={partyType} onChange={(e) => setPartyType(e.target.value as (typeof PARTY_TYPES)[number])}>
        {PARTY_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      {partyType === "Person" ? (
        <>
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First name" />
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" />
        </>
      ) : (
        <input
          value={organisationName}
          onChange={(e) => setOrganisationName(e.target.value)}
          placeholder={`${partyType} name`}
        />
      )}
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
      <input value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="Mobile" />
      <button onClick={submit}>Save</button>
      <button onClick={onCancel}>Cancel</button>
    </div>
  );
}

const COMMISSION_TYPES = ["Percentage", "FlatFee"] as const;

// Real structured agency-agreement terms capture (Phase 5) — feeds directly
// into the AgencyAgreement document template (apps/api/src/lib/
// documentTemplates.ts); the document can't be generated until these are
// saved at least once.
function AgencyTermsForm({
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
    <div>
      {!initial && <p>Not yet captured — the Agency Agreement document can't be generated until these are saved.</p>}
      <select value={commissionType} onChange={(e) => setCommissionType(e.target.value as (typeof COMMISSION_TYPES)[number])}>
        {COMMISSION_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      {commissionType === "Percentage" ? (
        <input value={commissionRate} onChange={(e) => setCommissionRate(e.target.value)} placeholder="Commission rate (%)" />
      ) : (
        <input value={flatFee} onChange={(e) => setFlatFee(e.target.value)} placeholder="Flat fee ($)" />
      )}
      <input value={marketingFee} onChange={(e) => setMarketingFee(e.target.value)} placeholder="Marketing fee ($, optional)" />
      <input value={termDays} onChange={(e) => setTermDays(e.target.value)} placeholder="Agreement term (days)" />
      <button onClick={submit}>Save Terms</button>
    </div>
  );
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// One ServiceOrder (e.g. the AML check) plus its own payment attempts —
// fetched per-row rather than folded into the workspace response, since
// most properties will only ever have a couple of these.
function ServiceOrderRow({
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

  return (
    <li>
      {serviceOrder.serviceType} — {formatCents(serviceOrder.customerPriceCents + serviceOrder.gstCents)} (incl. GST) —{" "}
      {serviceOrder.paymentStatus}
      {(serviceOrder.paymentStatus === "Pending" || serviceOrder.paymentStatus === "Failed") && (
        <button onClick={onCharge} disabled={charging}>
          {charging ? "Charging…" : serviceOrder.paymentStatus === "Failed" ? "Retry Charge" : "Charge"}
        </button>
      )}
      {chargeError && <p>{chargeError}</p>}
      {latest?.failureReason && <p>Last attempt failed: {latest.failureReason}</p>}
      {latest?.receiptUrl && (
        <p>
          <a href={latest.receiptUrl} target="_blank" rel="noreferrer">
            View receipt
          </a>
        </p>
      )}
      {latest && latest.status === "Succeeded" && (
        <button onClick={() => onRefund(latest.id)}>Refund</button>
      )}
      {refundError && <p>{refundError}</p>}
    </li>
  );
}

// Add-a-stored-method form (Phase 6). Real card capture must happen
// client-side via Stripe Elements/PaymentSheet — this only ever accepts the
// resulting tokenized references, never raw card data, matching the hard
// requirement that card numbers never transit this server.
function PaymentMethodsBlock({
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
      <p>My methods: {mine.length === 0 ? "none on file" : mine.map((m) => m.label ?? `#${m.id}`).join(", ")}</p>
      <p>Brokerage methods: {brokerage.length === 0 ? "none on file" : brokerage.map((m) => m.label ?? `#${m.id}`).join(", ")}</p>
      {!showAdd ? (
        <button onClick={() => setShowAdd(true)}>+ Add Payment Method</button>
      ) : (
        <div>
          <select value={scope} onChange={(e) => setScope(e.target.value as "Mine" | "Brokerage")}>
            <option value="Mine">Mine</option>
            <option value="Brokerage">Brokerage</option>
          </select>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. Visa ending 4242)" />
          <input
            value={providerCustomerRef}
            onChange={(e) => setProviderCustomerRef(e.target.value)}
            placeholder="Provider customer reference"
          />
          <input
            value={providerPaymentMethodRef}
            onChange={(e) => setProviderPaymentMethodRef(e.target.value)}
            placeholder="Provider payment method reference"
          />
          <button onClick={submit} disabled={!providerCustomerRef || !providerPaymentMethodRef}>
            Save
          </button>
          <button onClick={() => setShowAdd(false)}>Cancel</button>
        </div>
      )}
      {error && <p>{error}</p>}
    </div>
  );
}

function offerStatusLabel(o: OfferBlock): string {
  return `${formatCents(o.offerPriceCents)} — ${o.status}`;
}

// Offer capture + acceptance (Phase 7). The buyer is either an already
// captured Party (buyerPartyId) or minimum contact fields entered inline —
// same "enter once" pattern as AddPartyForm above.
function OffersBlock({
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
  const [buyerFirstName, setBuyerFirstName] = useState("");
  const [buyerLastName, setBuyerLastName] = useState("");
  const [buyerEmail, setBuyerEmail] = useState("");
  const [buyerMobile, setBuyerMobile] = useState("");

  const submit = () => {
    onCreate({
      offerPriceCents: Math.round(Number(offerPrice) * 100),
      buyer: {
        firstName: buyerFirstName || undefined,
        lastName: buyerLastName || undefined,
        email: buyerEmail || undefined,
        mobile: buyerMobile || undefined,
      },
    });
    setShowAdd(false);
    setOfferPrice("");
    setBuyerFirstName("");
    setBuyerLastName("");
    setBuyerEmail("");
    setBuyerMobile("");
  };

  const hasAccepted = offers.some((o) => o.status === "Accepted");

  return (
    <div>
      {offers.length === 0 ? (
        <p>No offers recorded yet.</p>
      ) : (
        <ul>
          {offers.map((o) => (
            <li key={o.id}>
              {offerStatusLabel(o)}
              {o.status === "Received" && (
                <>
                  <button onClick={() => onAccept(o.id)} disabled={hasAccepted}>
                    Accept
                  </button>
                  <button onClick={() => onDecline(o.id)}>Decline</button>
                  <button onClick={() => onWithdraw(o.id)}>Withdraw</button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {acceptError && <p>{acceptError}</p>}

      {!hasAccepted &&
        (!showAdd ? (
          <button onClick={() => setShowAdd(true)}>+ Record Offer</button>
        ) : (
          <div>
            <input value={offerPrice} onChange={(e) => setOfferPrice(e.target.value)} placeholder="Offer price ($)" />
            <input value={buyerFirstName} onChange={(e) => setBuyerFirstName(e.target.value)} placeholder="Buyer first name" />
            <input value={buyerLastName} onChange={(e) => setBuyerLastName(e.target.value)} placeholder="Buyer last name" />
            <input value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} placeholder="Buyer email" />
            <input value={buyerMobile} onChange={(e) => setBuyerMobile(e.target.value)} placeholder="Buyer mobile" />
            <button onClick={submit} disabled={!offerPrice || !buyerFirstName}>
              Save
            </button>
            <button onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        ))}
      {createError && <p>{createError}</p>}
    </div>
  );
}

// Transaction lifecycle (Phase 7) — contract signing → settlement →
// payout → close, matching lib/transactions.ts's chokepoints one for one.
function TransactionBlockView({
  transaction,
  onAction,
  error,
}: {
  transaction: TransactionBlock;
  onAction: (action: string, body?: Record<string, unknown>) => void;
  error: string | null;
}) {
  const [settlementDate, setSettlementDate] = useState("");
  const [fundsAmount, setFundsAmount] = useState("");

  return (
    <div>
      <p>
        Purchase price: {formatCents(transaction.purchasePriceCents)} · Status: {transaction.status}
      </p>

      <p>
        Contract: {transaction.contractDate ? `signed ${transaction.contractDate}` : "not yet signed"}
        {!transaction.contractDate && <button onClick={() => onAction("contract-signed")}>Mark Contract Signed</button>}
      </p>

      <p>
        Finance: {transaction.financeApprovedAt ? `approved ${transaction.financeApprovedAt}` : "not recorded"}
        {!transaction.financeApprovedAt && (
          <button onClick={() => onAction("finance-approved")}>Mark Finance Approved</button>
        )}
      </p>

      <p>
        Settlement:{" "}
        {transaction.settlementCompletedAt
          ? `completed ${transaction.settlementCompletedAt}`
          : transaction.settlementDate
            ? `scheduled ${transaction.settlementDate}`
            : "not yet scheduled"}
      </p>
      {!transaction.settlementCompletedAt && (
        <div>
          <input type="date" value={settlementDate} onChange={(e) => setSettlementDate(e.target.value)} />
          <button
            onClick={() => settlementDate && onAction("settlement-schedule", { settlementDate })}
            disabled={!settlementDate}
          >
            Schedule Settlement
          </button>
          {transaction.settlementDate && (
            <button onClick={() => onAction("settlement-complete")}>Mark Settlement Completed</button>
          )}
        </div>
      )}

      <p>
        Commission:{" "}
        {transaction.commissionCalculatedAt
          ? `${formatCents(transaction.grossCommissionCents ?? 0)} + ${formatCents(transaction.gstCents ?? 0)} GST`
          : "not yet calculated"}
        {!transaction.commissionCalculatedAt && (
          <button onClick={() => onAction("calculate-commission")}>Calculate Commission</button>
        )}
      </p>

      <p>
        Funds received: {formatCents(transaction.fundsReceivedCents)}
        <input value={fundsAmount} onChange={(e) => setFundsAmount(e.target.value)} placeholder="Amount ($)" />
        <button
          onClick={() => {
            if (!fundsAmount) return;
            onAction("funds-received", { amountCents: Math.round(Number(fundsAmount) * 100) });
            setFundsAmount("");
          }}
          disabled={!fundsAmount}
        >
          Record Funds Received
        </button>
      </p>

      <p>
        Agent paid: {transaction.agentPaidAt ?? "not yet"}
        {!transaction.agentPaidAt && <button onClick={() => onAction("agent-paid")}>Mark Agent Paid</button>}
      </p>

      <p>
        {transaction.status === "Closed" ? (
          `Closed ${transaction.closedAt}`
        ) : (
          <button onClick={() => onAction("close")} disabled={transaction.status !== "Settled"}>
            Close Transaction
          </button>
        )}
      </p>

      {error && <p>{error}</p>}
    </div>
  );
}
