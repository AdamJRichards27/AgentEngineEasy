import { useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AskAgentEngine } from "../components/AskAgentEngine";
import { apiFetch, ApiError } from "../lib/api";

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
  exchangedAt: string | null;
  unconditionalAt: string | null;
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
  legalRepresentatives: { sellerSolicitorPartyId?: number | null; buyerSolicitorPartyId?: number | null } | null;
}

interface TimelineEntry {
  id: number;
  at: string;
  label: string;
}

// Stage A (#114) — Appraisals. priceRangeLow/High come back as numeric
// strings (drizzle's convention for numeric(precision,scale) columns —
// see schema/appraisal.ts), not cents-integers like offers/transactions.
interface AppraisalBlock {
  id: number;
  propertyId: number;
  priceRangeLow: string | null;
  priceRangeHigh: string | null;
  comparableSales: unknown;
  isFinalised: boolean;
  finalisedSnapshot: unknown;
}

// Stage E (#118) — contract conditions.
interface ConditionBlock {
  id: number;
  transactionId: number;
  description: string;
  dueDate: string | null;
  status: string;
  notes: string | null;
  resolvedAt: string | null;
}

// #122 — agent-facing WAE task/attention-item visibility.
interface AutomationTaskBlock {
  id: string;
  kind: "TASK" | "REMINDER";
  title: string;
  detail: string | null;
  assignedRole: string | null;
  dueAt: string | null;
  status: string;
}

interface AttentionItemBlock {
  id: string;
  reasonCode: string;
  detail: string | null;
  status: string;
}

interface WorkspaceResponse {
  property: PropertyOverview & {
    salesMethod?: string | null;
    priceDisplay?: string | null;
    campaignStartDate?: string | null;
    campaignEndDate?: string | null;
  };
  ownership: OwnershipBlock;
  parties: PartyLink[];
  nextActions: Array<{ label: string; status: string; blockedReason?: string | null }>;
  documentPackage: DocumentPackageBlock | null;
  agencyAgreementTerms: AgencyAgreementTermsBlock | null;
  appraisal: AppraisalBlock | null;
  timeline: TimelineEntry[];
}

const ROLES = ["Seller", "Buyer", "Solicitor", "PowerOfAttorney", "Other"] as const;
const PARTY_TYPES = ["Person", "Organisation", "Trust", "Estate", "Other"] as const;

function partyName(p: PartyLink["party"]): string {
  if (!p) return "—";
  return p.organisationName || `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || "—";
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return isToday ? `Today ${time}` : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

// Clean, agent-facing AML status copy (staging brief's AML Status UX) —
// never the raw provider outcome/status string.
function amlStatusCopy(status: string): string {
  switch (status) {
    case "Not Started":
      return "Not started";
    case "Awaiting Seller":
    case "In Progress":
      return "Verification Sent";
    case "Complete":
      return "Ready";
    case "Review Required":
      return "Needs review";
    case "Failed":
      return "Failed";
    default:
      return status;
  }
}

function amlPillClass(status: string): string {
  if (status === "Complete") return "pill pill-success";
  if (status === "Review Required" || status === "Failed") return "pill pill-danger";
  return "pill";
}

// Clean document status copy (staging brief's Document UX) — Draft/Generated
// are implementation detail, not something an agent needs to parse.
function documentStatusCopy(status: string): string {
  if (status === "Signed") return "Signed";
  if (status === "Generated") return "Ready";
  return "Preparing";
}

// The Property Action Screen (Build Brief §13 / ARCHITECTURE.md §4) — the
// screen the whole build orients around. Answers "what needs to happen
// next?" with one primary action up top, then a compact People/Timeline
// view, then everything else tucked behind progressive-disclosure sections
// (staging brief: "avoid tabs... prioritise the current action").
export default function PropertyWorkspace({ params }: { params: { id: string } }) {
  const propertyId = Number(params.id);
  const queryClient = useQueryClient();
  const [showAddParty, setShowAddParty] = useState(false);
  const [reviewNotes, setReviewNotes] = useState("");
  const [exceptionNotes, setExceptionNotes] = useState<Record<number, string>>({});

  const { data, isLoading, isError, error } = useQuery({
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

  // Buyer/other-party AML/CTF (Property Timeline prerequisite): sellers get
  // AML initiated automatically via Ready to List, but that's a Seller-only
  // workflow concept — non-Seller parties have no equivalent automatic
  // trigger, so they need an explicit, authorised way to start the same
  // check. Reuses the identical generic backend path (POST /aml/request ->
  // initiateAmlIfNeeded) rather than a new AML request service; the same
  // idempotency and tenant/linkage checks sellers' automatic path already
  // relies on apply here too.
  const requestAml = useMutation({
    mutationFn: (partyId: number) => apiFetch("/aml/request", { method: "POST", body: JSON.stringify({ propertyId, partyId }) }),
    onSuccess: invalidate,
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
    onSuccess: () => {
      invalidateServiceOrders();
      queryClient.invalidateQueries({ queryKey: ["service-order-payments"] });
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
  // lifecycle (contract → settlement → payout → close).
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

  // Stage A (#114) — Appraisals. Additive/independent of workflowStage; an
  // unstarted appraisal shows as null and never blocks anything else.
  const startAppraisal = useMutation({
    mutationFn: () => apiFetch(`/appraisals/by-property/${propertyId}/start`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const saveAppraisal = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch(`/appraisals/by-property/${propertyId}`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: invalidate,
  });
  const finaliseAppraisalMut = useMutation({
    mutationFn: () => apiFetch(`/appraisals/by-property/${propertyId}/finalise`, { method: "POST" }),
    onSuccess: invalidate,
  });

  // Stage C (#116) — listing preparation fields.
  const saveListingDetails = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch(`/properties/${propertyId}/listing-details`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: invalidate,
  });

  // Stage E (#118) — contract conditions + exchange/unconditional.
  const { data: conditionsData } = useQuery({
    queryKey: ["conditions", transactionData?.transaction?.id],
    queryFn: () => apiFetch<{ conditions: ConditionBlock[] }>(`/transactions/${transactionData!.transaction!.id}/conditions`),
    enabled: !!transactionData?.transaction,
  });
  const invalidateConditions = () => queryClient.invalidateQueries({ queryKey: ["conditions", transactionData?.transaction?.id] });

  const addCondition = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch(`/transactions/${transactionData!.transaction!.id}/conditions`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: invalidateConditions,
  });
  const rescheduleCondition = useMutation({
    mutationFn: ({ conditionId, newDueDate }: { conditionId: number; newDueDate: string | null }) =>
      apiFetch(`/transactions/conditions/${conditionId}/reschedule`, { method: "POST", body: JSON.stringify({ newDueDate }) }),
    onSuccess: invalidateConditions,
  });
  const resolveConditionMut = useMutation({
    mutationFn: ({ conditionId, status, notes }: { conditionId: number; status: string; notes?: string }) =>
      apiFetch(`/transactions/conditions/${conditionId}/resolve`, { method: "POST", body: JSON.stringify({ status, notes }) }),
    onSuccess: invalidateConditions,
  });

  // #122 — agent-facing WAE task/attention-item visibility.
  const { data: tasksData } = useQuery({
    queryKey: ["tasks", propertyId],
    queryFn: () => apiFetch<{ tasks: AutomationTaskBlock[]; attentionItems: AttentionItemBlock[] }>(`/tasks/by-property/${propertyId}`),
  });
  const invalidateTasks = () => queryClient.invalidateQueries({ queryKey: ["tasks", propertyId] });

  const completeTask = useMutation({
    mutationFn: (taskId: string) => apiFetch(`/tasks/${taskId}/complete`, { method: "POST" }),
    onSuccess: invalidateTasks,
  });
  const resolveAttentionItemMut = useMutation({
    mutationFn: (itemId: string) => apiFetch(`/tasks/attention-items/${itemId}/resolve`, { method: "POST" }),
    onSuccess: invalidateTasks,
  });

  const [preview, setPreview] = useState<{ documentId: number; content: string } | null>(null);
  const previewDocument = async (documentId: number) => {
    const res = await fetch(`/api/documents/${documentId}/content`, { credentials: "include" });
    const content = res.ok ? await res.text() : "Could not load this document right now.";
    setPreview({ documentId, content });
  };

  if (isLoading || !data) {
    if (isError) return <p className="error-text">{(error as ApiError).friendly}</p>;
    return <p className="muted">Loading…</p>;
  }

  const sellers = data.parties.filter((p) => p.role === "Seller");
  const others = data.parties.filter((p) => p.role !== "Seller");
  const solicitors = data.parties.filter((p) => p.role === "Solicitor");
  const pendingServiceOrders = (serviceOrdersData?.serviceOrders ?? []).filter(
    (so) => so.paymentStatus === "Pending" || so.paymentStatus === "Failed",
  );
  const defaultPaymentMethod = paymentMethodsData?.mine.find((m) => m.isDefault) ?? paymentMethodsData?.mine[0] ?? null;
  const transaction = transactionData?.transaction ?? null;
  const offers = offersData?.offers ?? [];
  const activeTasks = tasksData?.tasks ?? [];
  const openAttentionItems = tasksData?.attentionItems ?? [];

  // "What happens next?" (staging brief's Next Action Design) — one
  // prominent primary action, derived from live state, instead of a grid of
  // module buttons. Falls through to the next-most-specific thing that's
  // actually true right now.
  let primary: { title: string; description?: string; action?: ReactNode } | null = null;

  if (data.property.workflowStage === "Appraisal") {
    primary = {
      title: "Verify Sellers & Get Ready to List",
      description:
        sellers.length > 0
          ? `${sellers.length} seller${sellers.length > 1 ? "s" : ""} captured.`
          : "Add at least one seller below before continuing.",
      action: (
        <button className="btn btn-primary" onClick={() => readyToList.mutate()} disabled={sellers.length === 0 || readyToList.isPending}>
          Ready to List
        </button>
      ),
    };
  } else if (data.property.workflowStage === "Ready to List") {
    const amlExceptionParty = sellers.find((p) => p.amlException);
    const pendingCharge = pendingServiceOrders[0];
    const incompleteStep = data.nextActions.find((a) => a.status !== "Complete");

    if (amlExceptionParty) {
      primary = {
        title: `AML review needed — ${partyName(amlExceptionParty.party)}`,
        description: "See People below to retry the check or resolve it.",
      };
    } else if (pendingCharge && defaultPaymentMethod) {
      primary = {
        title: "Pay for AML verification",
        description: `${pendingServiceOrders.length} service charge${pendingServiceOrders.length > 1 ? "s" : ""} awaiting payment.`,
        action: (
          <button className="btn btn-primary" onClick={() => chargeServiceOrder.mutate(pendingCharge.id)} disabled={chargeServiceOrder.isPending}>
            Confirm & Continue
          </button>
        ),
      };
    } else if (pendingCharge && !defaultPaymentMethod) {
      primary = { title: "Add a payment method", description: "Needed to pay for AML verification — see Payment methods below." };
    } else if (data.documentPackage && !data.agencyAgreementTerms) {
      primary = { title: "Add agency agreement terms", description: "Required before documents can be generated — see Documents below." };
    } else if (data.documentPackage && data.documentPackage.documents.some((d) => d.status === "Draft")) {
      primary = {
        title: "Generate required documents",
        action: (
          <button className="btn btn-primary" onClick={() => populatePackage.mutate(data.documentPackage!.id)} disabled={populatePackage.isPending}>
            Generate Documents
          </button>
        ),
      };
    } else if (data.documentPackage?.status === "Ready") {
      primary = {
        title: "Send Agency Documents",
        action: (
          <button className="btn btn-primary" onClick={() => sendForSignature.mutate(data.documentPackage!.id)} disabled={sendForSignature.isPending}>
            Send for Signature
          </button>
        ),
      };
    } else if (data.documentPackage?.status === "Sent") {
      primary = { title: "Awaiting signatures", description: "We'll update this automatically as each seller signs." };
    } else if (!incompleteStep) {
      primary = {
        title: "Ready to go live",
        action: (
          <button className="btn btn-primary" onClick={() => goLive.mutate()} disabled={goLive.isPending}>
            Go Live
          </button>
        ),
      };
    } else {
      primary = { title: incompleteStep.label, description: incompleteStep.blockedReason ?? undefined };
    }
  } else if (data.property.workflowStage === "Listed" && !transaction) {
    const received = offers.filter((o) => o.status === "Received");
    primary =
      received.length > 0
        ? { title: `Review ${received.length} offer${received.length > 1 ? "s" : ""}`, description: "See Offers below." }
        : { title: "Awaiting offers", description: "Record an offer as soon as a buyer submits one — see Offers below." };
  } else if (transaction) {
    if (!transaction.contractDate) {
      primary = {
        title: "Prepare Contract",
        action: (
          <button className="btn btn-primary" onClick={() => transactionAction.mutate({ transactionId: transaction.id, action: "contract-signed" })}>
            Mark Contract Signed
          </button>
        ),
      };
    } else if (!transaction.financeApprovedAt) {
      primary = {
        title: "Confirm Finance",
        action: (
          <button className="btn btn-primary" onClick={() => transactionAction.mutate({ transactionId: transaction.id, action: "finance-approved" })}>
            Mark Finance Approved
          </button>
        ),
      };
    } else if (!transaction.unconditionalAt) {
      primary = {
        title: transaction.exchangedAt ? "Resolve outstanding conditions" : "Exchange contracts",
        description: transaction.exchangedAt
          ? "See Transaction below to resolve remaining conditions and mark the contract unconditional."
          : "See Transaction below to record exchange of contracts.",
      };
    } else if (!transaction.settlementDate) {
      primary = { title: "Schedule settlement", description: "See Transaction below to set a date." };
    } else if (!transaction.settlementCompletedAt) {
      primary = {
        title: "Prepare Settlement",
        description: `Settlement due ${new Date(transaction.settlementDate).toLocaleDateString()}.`,
      };
    } else if (transaction.status !== "Closed") {
      primary = { title: "Wrap up the transaction", description: "See Transaction below for funds, payout, and close." };
    } else {
      primary = { title: "Transaction closed", description: "There's nothing further to action on this property." };
    }
  }

  return (
    <div>
      <h1>{data.property.formattedAddress}</h1>
      <p className="muted">
        {data.property.workflowStage}
        {[data.property.suburb, data.property.state, data.property.postcode].filter(Boolean).length > 0
          ? ` · ${[data.property.suburb, data.property.state, data.property.postcode].filter(Boolean).join(", ")}`
          : ""}
      </p>

      {/* Ownership review — review, not block (Build Brief §8). Always
          visible when it applies, since it's a standing prompt rather than
          part of the single "what happens next" flow. */}
      {data.ownership.reviewRequired && (
        <section className="card">
          <h2>Ownership review</h2>
          <p className="muted">
            The seller(s) entered don't clearly match the title ownership data on file. This does not block
            progress — trusts, companies, estates, and powers of attorney can legitimately differ. Review and
            clear when satisfied.
          </p>
          {data.ownership.data && (
            <ul className="plain">
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
          <button className="btn btn-secondary" onClick={() => resolveOwnershipReview.mutate()}>
            Mark Reviewed
          </button>
        </section>
      )}

      {/* What happens next — one primary action (staging brief's Next
          Action Design). */}
      <AskAgentEngine contextType="property" contextId={propertyId} />

      {primary && (
        <section className="primary-action">
          <div className="eyebrow">Next step</div>
          <h2>{primary.title}</h2>
          {primary.description && <p className="muted">{primary.description}</p>}
          {primary.action}
        </section>
      )}

      {/* #122 — agent-facing WAE task/reminder + attention-item
          visibility. Shown up top, next to the primary action, since these
          are exactly the kind of "what needs to happen" items the primary
          action slot can't always capture (WAE-originated, not
          workflow-stage-derived). */}
      {(activeTasks.length > 0 || openAttentionItems.length > 0) && (
        <section className="card">
          <h2>Tasks & Attention</h2>
          <TasksAttentionBlock
            tasks={activeTasks}
            attentionItems={openAttentionItems}
            onCompleteTask={(id) => completeTask.mutate(id)}
            onResolveAttentionItem={(id) => resolveAttentionItemMut.mutate(id)}
          />
        </section>
      )}

      {/* Sellers — the property-workspace example in the staging brief
          shows the seller list front and centre, not tucked away. */}
      <section className="card">
        <h2>Sellers</h2>
        {sellers.length === 0 ? (
          <p className="muted">No sellers captured yet.</p>
        ) : (
          <ul className="item-list">
            {sellers.map((p) => (
              <li key={p.linkId}>
                <div>
                  {partyName(p.party)}
                  {p.isPrimary ? " (primary)" : ""}
                  {p.amlStatus && <span className={amlPillClass(p.amlStatus)} style={{ marginLeft: "0.5rem" }}>{amlStatusCopy(p.amlStatus)}</span>}
                  <button className="btn btn-link" onClick={() => removeParty.mutate(p.linkId)}>
                    Remove
                  </button>
                </div>

                {/* AML exception (Phase 4): clean status by default; raw
                    outcome/risk detail is behind "View Details" rather than
                    shown up front (staging brief: "Do not expose raw AML
                    API responses"). */}
                {p.amlException && p.amlVerificationId && (
                  <div className="cost-summary">
                    <p className="muted" style={{ marginBottom: "0.4rem" }}>
                      We'll update this property automatically when {partyName(p.party)} completes verification.
                    </p>
                    <button className="btn btn-small" onClick={() => retryAml.mutate(p.amlVerificationId!)}>
                      Resend
                    </button>
                    <details style={{ marginTop: "0.5rem" }}>
                      <summary className="muted">View Details</summary>
                      <p className="muted">
                        {p.amlException.outcome ? `Outcome: ${p.amlException.outcome}` : ""}
                        {p.amlException.riskLevel ? ` · Risk: ${p.amlException.riskLevel}` : ""}
                      </p>
                      <input
                        value={exceptionNotes[p.amlVerificationId] ?? ""}
                        onChange={(e) => setExceptionNotes((prev) => ({ ...prev, [p.amlVerificationId!]: e.target.value }))}
                        placeholder="Compliance note (required to resolve)"
                      />
                      <button
                        className="btn btn-small"
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
                    </details>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {others.length > 0 && (
          <>
            <h3>Other parties</h3>
            <ul className="item-list">
              {others.map((p) => (
                <li key={p.linkId}>
                  <div>
                    {p.role}: {partyName(p.party)}
                    {p.amlStatus && <span className={amlPillClass(p.amlStatus)} style={{ marginLeft: "0.5rem" }}>{amlStatusCopy(p.amlStatus)}</span>}
                    <button className="btn btn-link" onClick={() => removeParty.mutate(p.linkId)}>
                      Remove
                    </button>
                  </div>

                  {!p.amlStatus && (
                    <button className="btn btn-small" onClick={() => requestAml.mutate(p.partyId)} disabled={requestAml.isPending}>
                      Request AML Verification
                    </button>
                  )}

                  {/* Same AML exception handling sellers get above (Resend /
                      View Details / Mark Resolved) — identical mutations,
                      identical exceptionNotes state, keyed by
                      amlVerificationId rather than role. */}
                  {p.amlException && p.amlVerificationId && (
                    <div className="cost-summary">
                      <p className="muted" style={{ marginBottom: "0.4rem" }}>
                        We'll update this property automatically when {partyName(p.party)} completes verification.
                      </p>
                      <button className="btn btn-small" onClick={() => retryAml.mutate(p.amlVerificationId!)}>
                        Resend
                      </button>
                      <details style={{ marginTop: "0.5rem" }}>
                        <summary className="muted">View Details</summary>
                        <p className="muted">
                          {p.amlException.outcome ? `Outcome: ${p.amlException.outcome}` : ""}
                          {p.amlException.riskLevel ? ` · Risk: ${p.amlException.riskLevel}` : ""}
                        </p>
                        <input
                          value={exceptionNotes[p.amlVerificationId] ?? ""}
                          onChange={(e) => setExceptionNotes((prev) => ({ ...prev, [p.amlVerificationId!]: e.target.value }))}
                          placeholder="Compliance note (required to resolve)"
                        />
                        <button
                          className="btn btn-small"
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
                      </details>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {!showAddParty ? (
          <button className="btn btn-secondary" onClick={() => setShowAddParty(true)}>
            + Add Person
          </button>
        ) : (
          <AddPartyForm onCancel={() => setShowAddParty(false)} onSubmit={(input) => addParty.mutate(input)} />
        )}
      </section>

      {/* Offers (Phase 7) */}
      {(data.property.listingStatus === "Listed" || offers.length > 0) && (
        <section className="card">
          <h2>Offers</h2>
          <OffersBlock
            offers={offers}
            onCreate={(input) => createOffer.mutate(input)}
            createError={createOffer.isError ? (createOffer.error as ApiError).friendly : null}
            onAccept={(id) => acceptOffer.mutate(id)}
            acceptError={acceptOffer.isError ? (acceptOffer.error as ApiError).friendly : null}
            onDecline={(id) => declineOffer.mutate(id)}
            onWithdraw={(id) => withdrawOffer.mutate(id)}
          />
        </section>
      )}

      {/* Transaction (Phase 7; Stage D/E/F/H additions this build) */}
      {transaction && (
        <section className="card">
          <h2>Transaction</h2>
          <TransactionBlockView
            transaction={transaction}
            onAction={(action, body) => transactionAction.mutate({ transactionId: transaction.id, action, body })}
            error={transactionAction.isError ? (transactionAction.error as ApiError).friendly : null}
            conditions={conditionsData?.conditions ?? []}
            onAddCondition={(input) => addCondition.mutate(input)}
            addConditionError={addCondition.isError ? (addCondition.error as ApiError).friendly : null}
            onRescheduleCondition={(conditionId, newDueDate) => rescheduleCondition.mutate({ conditionId, newDueDate })}
            onResolveCondition={(conditionId, status, notes) => resolveConditionMut.mutate({ conditionId, status, notes })}
            onExchange={() => transactionAction.mutate({ transactionId: transaction.id, action: "exchange" })}
            onMarkUnconditional={() => transactionAction.mutate({ transactionId: transaction.id, action: "unconditional" })}
            unconditionalError={
              transactionAction.isError && transactionAction.variables?.action === "unconditional"
                ? (transactionAction.error as ApiError).friendly
                : null
            }
            solicitors={solicitors}
            onSaveLegalReps={(input) => transactionAction.mutate({ transactionId: transaction.id, action: "legal-representatives", body: input })}
          />
        </section>
      )}

      {/* Timeline (staging brief) — a plain read projection over the audit
          log; every mutation above already writes to it. */}
      {data.timeline.length > 0 && (
        <details className="section" open>
          <summary>Timeline</summary>
          <ul className="timeline">
            {data.timeline.map((t) => (
              <li key={t.id}>
                <span className="when">{formatWhen(t.at)}</span>
                {t.label}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Everything below is detail, not the current action — tucked
          behind progressive disclosure (staging brief: "avoid tabs unless
          genuinely required"). */}

      {/* Stage A (#114) — Appraisal. Independent of workflowStage; purely
          additive valuation capture, never a blocker to any other stage. */}
      <details className="section">
        <summary>Appraisal</summary>
        <AppraisalSection
          appraisal={data.appraisal}
          onStart={() => startAppraisal.mutate()}
          onSave={(input) => saveAppraisal.mutate(input)}
          onFinalise={() => finaliseAppraisalMut.mutate()}
          saveError={saveAppraisal.isError ? (saveAppraisal.error as ApiError).friendly : null}
          finaliseError={finaliseAppraisalMut.isError ? (finaliseAppraisalMut.error as ApiError).friendly : null}
        />
      </details>

      {/* Stage C (#116) — listing preparation. Purely descriptive; never
          publishes a listing or incurs a cost. */}
      <details className="section">
        <summary>Listing details</summary>
        <ListingDetailsForm
          initial={{
            salesMethod: data.property.salesMethod ?? null,
            priceDisplay: data.property.priceDisplay ?? null,
            campaignStartDate: data.property.campaignStartDate ?? null,
            campaignEndDate: data.property.campaignEndDate ?? null,
          }}
          onSave={(input) => saveListingDetails.mutate(input)}
          error={saveListingDetails.isError ? (saveListingDetails.error as ApiError).friendly : null}
        />
      </details>

      {data.documentPackage && (
        <details className="section">
          <summary>Documents & Agency Agreement</summary>

          <h3>Agency agreement terms</h3>
          <AgencyTermsForm initial={data.agencyAgreementTerms} onSubmit={(input) => saveAgencyTerms.mutate(input)} />

          <h3 style={{ marginTop: "1rem" }}>Documents</h3>
          <ul className="item-list">
            {data.documentPackage.documents.map((d) => (
              <li key={d.id}>
                {d.title} <span className={d.status === "Signed" ? "pill pill-success" : "pill"}>{documentStatusCopy(d.status)}</span>
                {(d.status === "Generated" || d.status === "Signed") && (
                  <button className="btn btn-link" onClick={() => previewDocument(d.id)}>
                    Review
                  </button>
                )}
              </li>
            ))}
          </ul>
          {((populatePackage.data as any)?.skipped?.length ?? 0) > 0 && (
            <p className="muted">{(populatePackage.data as any).skipped.map((s: { reason: string }) => s.reason).join(" ")}</p>
          )}
          {populatePackage.isError && <p className="error-text">{(populatePackage.error as ApiError).friendly}</p>}
          {sendForSignature.isError && <p className="error-text">{(sendForSignature.error as ApiError).friendly}</p>}

          {data.documentPackage.signatureRequest && (
            <p className="muted">
              Signature status: {data.documentPackage.signatureRequest.status}
              {data.documentPackage.signatureRequest.completedAt ? ` (completed ${data.documentPackage.signatureRequest.completedAt})` : ""}
            </p>
          )}

          {preview && (
            <div className="card">
              <button className="btn btn-link" onClick={() => setPreview(null)}>
                Close
              </button>
              <pre style={{ whiteSpace: "pre-wrap" }}>{preview.content}</pre>
            </div>
          )}
        </details>
      )}

      <details className="section">
        <summary>Payment methods & service charges</summary>

        <PaymentMethodsBlock
          mine={paymentMethodsData?.mine ?? []}
          brokerage={paymentMethodsData?.brokerage ?? []}
          onAdd={(input) => addPaymentMethod.mutate(input)}
          error={addPaymentMethod.isError ? (addPaymentMethod.error as ApiError).friendly : null}
        />

        {serviceOrdersData && serviceOrdersData.serviceOrders.length > 0 && (
          <>
            <h3 style={{ marginTop: "1rem" }}>Service charges</h3>
            <ul className="item-list">
              {serviceOrdersData.serviceOrders.map((so) => (
                <ServiceOrderRow
                  key={so.id}
                  serviceOrder={so}
                  onCharge={() => chargeServiceOrder.mutate(so.id)}
                  charging={chargeServiceOrder.isPending && chargeServiceOrder.variables === so.id}
                  chargeError={chargeServiceOrder.isError && chargeServiceOrder.variables === so.id ? (chargeServiceOrder.error as ApiError).friendly : null}
                  onRefund={(paymentId) => refundPayment.mutate({ paymentId, serviceOrderId: so.id })}
                  refundError={refundPayment.isError ? (refundPayment.error as ApiError).friendly : null}
                />
              ))}
            </ul>
          </>
        )}
      </details>

      {/* Ready to List / Go Live fallback controls — normally reached via
          the primary action above; kept here too so nothing is lost if the
          primary action logic doesn't match a given state. */}
      {data.property.workflowStage === "Appraisal" && !primary && (
        <div>
          <button className="btn btn-primary" onClick={() => readyToList.mutate()} disabled={sellers.length === 0}>
            Ready to List
          </button>
          {readyToList.isError && <p className="error-text">{(readyToList.error as ApiError).friendly}</p>}
        </div>
      )}
      {readyToList.isError && data.property.workflowStage === "Appraisal" && primary && (
        <p className="error-text">{(readyToList.error as ApiError).friendly}</p>
      )}
      {goLive.isError && <p className="error-text">{(goLive.error as ApiError).friendly}</p>}
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
    <div className="card stack">
      <div className="inline-form">
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label>
          Type
          <select value={partyType} onChange={(e) => setPartyType(e.target.value as (typeof PARTY_TYPES)[number])}>
            {PARTY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>
      {partyType === "Person" ? (
        <div className="inline-form">
          <label>
            First name
            <input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </label>
          <label>
            Last name
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </label>
        </div>
      ) : (
        <label>
          {partyType} name
          <input value={organisationName} onChange={(e) => setOrganisationName(e.target.value)} />
        </label>
      )}
      <div className="inline-form">
        <label>
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Mobile
          <input value={mobile} onChange={(e) => setMobile(e.target.value)} />
        </label>
      </div>
      <div className="inline-form">
        <button className="btn btn-primary" onClick={submit}>
          Save
        </button>
        <button className="btn btn-link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const COMMISSION_TYPES = ["Percentage", "FlatFee"] as const;

// Real structured agency-agreement terms capture (Phase 5).
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

// One ServiceOrder (e.g. the AML check) plus its own payment attempts —
// shown as a clean cost summary + Confirm & Continue rather than raw
// provider-reference fields (staging brief's Payment UX).
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

// Add-a-stored-method form (Phase 6). Real card capture must happen
// client-side via Stripe Elements/PaymentSheet — this only ever accepts the
// resulting tokenized references, never raw card data.
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

function offerStatusLabel(o: OfferBlock): string {
  return `${formatCents(o.offerPriceCents)} — ${o.status}`;
}

// Offer capture + acceptance (Phase 7).
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

// Transaction lifecycle (Phase 7; Stage D/E/F/H this build) — shown as a
// checklist with upcoming dates, matching the staging brief's Transaction
// Workspace example. Now also carries contract conditions, exchange /
// unconditional (#118), and legal representative capture (#117).
function TransactionBlockView({
  transaction,
  onAction,
  error,
  conditions,
  onAddCondition,
  addConditionError,
  onRescheduleCondition,
  onResolveCondition,
  onExchange,
  onMarkUnconditional,
  unconditionalError,
  solicitors,
  onSaveLegalReps,
}: {
  transaction: TransactionBlock;
  onAction: (action: string, body?: Record<string, unknown>) => void;
  error: string | null;
  conditions: ConditionBlock[];
  onAddCondition: (input: Record<string, unknown>) => void;
  addConditionError: string | null;
  onRescheduleCondition: (conditionId: number, newDueDate: string | null) => void;
  onResolveCondition: (conditionId: number, status: string, notes?: string) => void;
  onExchange: () => void;
  onMarkUnconditional: () => void;
  unconditionalError: string | null;
  solicitors: PartyLink[];
  onSaveLegalReps: (input: Record<string, unknown>) => void;
}) {
  const [settlementDate, setSettlementDate] = useState("");
  const [fundsAmount, setFundsAmount] = useState("");

  return (
    <div className="stack">
      <p>
        {formatCents(transaction.purchasePriceCents)} · <span className="pill">{transaction.status}</span>
      </p>

      <div>
        Contract: {transaction.contractDate ? `signed ${transaction.contractDate}` : "not yet signed"}
        {!transaction.contractDate && (
          <button className="btn btn-small" onClick={() => onAction("contract-signed")} style={{ marginLeft: "0.5rem" }}>
            Mark Contract Signed
          </button>
        )}
      </div>

      <div>
        Finance: {transaction.financeApprovedAt ? `approved ${transaction.financeApprovedAt}` : "not recorded"}
        {!transaction.financeApprovedAt && (
          <button className="btn btn-small" onClick={() => onAction("finance-approved")} style={{ marginLeft: "0.5rem" }}>
            Mark Finance Approved
          </button>
        )}
      </div>

      {/* Stage E (#118) — contract conditions + exchange/unconditional. */}
      <ConditionsBlock
        conditions={conditions}
        onAdd={onAddCondition}
        addError={addConditionError}
        onReschedule={onRescheduleCondition}
        onResolve={onResolveCondition}
      />

      <div>
        Exchange: {transaction.exchangedAt ? `exchanged ${transaction.exchangedAt}` : "not yet exchanged"}
        {!transaction.exchangedAt && (
          <button className="btn btn-small" onClick={onExchange} style={{ marginLeft: "0.5rem" }}>
            Mark Contracts Exchanged
          </button>
        )}
      </div>

      <div>
        Unconditional:{" "}
        {transaction.unconditionalAt
          ? `became unconditional ${transaction.unconditionalAt}`
          : "not yet unconditional"}
        {!transaction.unconditionalAt && (
          <button className="btn btn-small" onClick={onMarkUnconditional} style={{ marginLeft: "0.5rem" }}>
            Mark Unconditional
          </button>
        )}
        {unconditionalError && <p className="error-text">{unconditionalError}</p>}
      </div>

      {/* Stage D/F (#117) — legal representatives. */}
      <LegalRepresentativesForm
        initial={transaction.legalRepresentatives}
        solicitors={solicitors}
        onSave={onSaveLegalReps}
      />

      <div>
        Settlement:{" "}
        {transaction.settlementCompletedAt
          ? `completed ${transaction.settlementCompletedAt}`
          : transaction.settlementDate
            ? `scheduled ${new Date(transaction.settlementDate).toLocaleDateString()}`
            : "not yet scheduled"}
      </div>
      {!transaction.settlementCompletedAt && (
        <div className="inline-form">
          <input type="date" value={settlementDate} onChange={(e) => setSettlementDate(e.target.value)} />
          <button
            className="btn btn-small"
            onClick={() => settlementDate && onAction("settlement-schedule", { settlementDate })}
            disabled={!settlementDate}
          >
            Schedule Settlement
          </button>
          {transaction.settlementDate && (
            <button className="btn btn-small" onClick={() => onAction("settlement-complete")}>
              Mark Settlement Completed
            </button>
          )}
        </div>
      )}

      <div>
        Commission:{" "}
        {transaction.commissionCalculatedAt
          ? `${formatCents(transaction.grossCommissionCents ?? 0)} + ${formatCents(transaction.gstCents ?? 0)} GST`
          : "not yet calculated"}
        {!transaction.commissionCalculatedAt && (
          <button className="btn btn-small" onClick={() => onAction("calculate-commission")} style={{ marginLeft: "0.5rem" }}>
            Calculate Commission
          </button>
        )}
      </div>

      <div className="inline-form">
        <span>Funds received: {formatCents(transaction.fundsReceivedCents)}</span>
        <input value={fundsAmount} onChange={(e) => setFundsAmount(e.target.value)} placeholder="Amount ($)" />
        <button
          className="btn btn-small"
          onClick={() => {
            if (!fundsAmount) return;
            onAction("funds-received", { amountCents: Math.round(Number(fundsAmount) * 100) });
            setFundsAmount("");
          }}
          disabled={!fundsAmount}
        >
          Record Funds Received
        </button>
      </div>

      <div>
        Agent paid: {transaction.agentPaidAt ?? "not yet"}
        {!transaction.agentPaidAt && (
          <button className="btn btn-small" onClick={() => onAction("agent-paid")} style={{ marginLeft: "0.5rem" }}>
            Mark Agent Paid
          </button>
        )}
      </div>

      <div>
        {transaction.status === "Closed" ? (
          `Closed ${transaction.closedAt}`
        ) : (
          <button className="btn btn-primary btn-small" onClick={() => onAction("close")} disabled={transaction.status !== "Settled"}>
            Close Transaction
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

const CONDITION_RESOLUTIONS = ["Satisfied", "Waived", "Failed", "NotApplicable"] as const;

// Stage E (#118) — a condition list with reschedule/resolve actions, plus a
// small add-condition form. Mirrors the offer-conditions free-text field's
// discipline: no invented finance/building-inspection integration, purely
// agent-recorded tracking.
function ConditionsBlock({
  conditions,
  onAdd,
  addError,
  onReschedule,
  onResolve,
}: {
  conditions: ConditionBlock[];
  onAdd: (input: Record<string, unknown>) => void;
  addError: string | null;
  onReschedule: (conditionId: number, newDueDate: string | null) => void;
  onResolve: (conditionId: number, status: string, notes?: string) => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [rescheduleDrafts, setRescheduleDrafts] = useState<Record<number, string>>({});
  const [resolveNotes, setResolveNotes] = useState<Record<number, string>>({});

  const submitAdd = () => {
    if (!description.trim()) return;
    onAdd({ description: description.trim(), dueDate: dueDate || undefined });
    setShowAdd(false);
    setDescription("");
    setDueDate("");
  };

  return (
    <div>
      <h3 style={{ marginBottom: "0.4rem" }}>Contract conditions</h3>
      {conditions.length === 0 ? (
        <p className="muted">No conditions tracked.</p>
      ) : (
        <ul className="item-list">
          {conditions.map((c) => (
            <li key={c.id}>
              <div>
                {c.description}{" "}
                <span className={c.status === "Satisfied" || c.status === "Waived" || c.status === "NotApplicable" ? "pill pill-success" : c.status === "Failed" ? "pill pill-danger" : "pill"}>
                  {c.status}
                </span>
                {c.dueDate && ` · due ${new Date(c.dueDate).toLocaleDateString()}`}
              </div>
              {c.status === "Pending" && (
                <div className="inline-form" style={{ marginTop: "0.3rem" }}>
                  <input
                    type="date"
                    value={rescheduleDrafts[c.id] ?? ""}
                    onChange={(e) => setRescheduleDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                  />
                  <button
                    className="btn btn-small"
                    onClick={() => onReschedule(c.id, rescheduleDrafts[c.id] || null)}
                    disabled={!rescheduleDrafts[c.id]}
                  >
                    Reschedule
                  </button>
                  <select
                    defaultValue=""
                    onChange={(e) => {
                      const status = e.target.value;
                      if (!status) return;
                      onResolve(c.id, status, resolveNotes[c.id] || undefined);
                      e.target.value = "";
                    }}
                  >
                    <option value="" disabled>
                      Resolve as…
                    </option>
                    {CONDITION_RESOLUTIONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <input
                    value={resolveNotes[c.id] ?? ""}
                    onChange={(e) => setResolveNotes((prev) => ({ ...prev, [c.id]: e.target.value }))}
                    placeholder="Note (optional)"
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {!showAdd ? (
        <button className="btn btn-link" onClick={() => setShowAdd(true)}>
          + Add Condition
        </button>
      ) : (
        <div className="inline-form">
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Subject to building & pest inspection" />
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          <button className="btn btn-small" onClick={submitAdd} disabled={!description.trim()}>
            Save
          </button>
          <button className="btn btn-link" onClick={() => setShowAdd(false)}>
            Cancel
          </button>
        </div>
      )}
      {addError && <p className="error-text">{addError}</p>}
    </div>
  );
}

// Stage D/F (#117) — legal representatives, picked from parties already
// linked to the property with role "Solicitor" (reuses the existing
// party-capture UI/flow rather than inventing a second solicitor entry
// path).
function LegalRepresentativesForm({
  initial,
  solicitors,
  onSave,
}: {
  initial: { sellerSolicitorPartyId?: number | null; buyerSolicitorPartyId?: number | null } | null;
  solicitors: PartyLink[];
  onSave: (input: Record<string, unknown>) => void;
}) {
  const [sellerSolicitorPartyId, setSellerSolicitorPartyId] = useState(
    initial?.sellerSolicitorPartyId ? String(initial.sellerSolicitorPartyId) : "",
  );
  const [buyerSolicitorPartyId, setBuyerSolicitorPartyId] = useState(
    initial?.buyerSolicitorPartyId ? String(initial.buyerSolicitorPartyId) : "",
  );

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

// Stage A (#114) — appraisal capture. priceRangeLow/High are numeric
// strings server-side; this form treats them as plain decimal text rather
// than cents, matching that convention.
function AppraisalSection({
  appraisal,
  onStart,
  onSave,
  onFinalise,
  saveError,
  finaliseError,
}: {
  appraisal: AppraisalBlock | null;
  onStart: () => void;
  onSave: (input: Record<string, unknown>) => void;
  onFinalise: () => void;
  saveError: string | null;
  finaliseError: string | null;
}) {
  const [priceRangeLow, setPriceRangeLow] = useState(appraisal?.priceRangeLow ?? "");
  const [priceRangeHigh, setPriceRangeHigh] = useState(appraisal?.priceRangeHigh ?? "");
  const [notes, setNotes] = useState(
    typeof appraisal?.comparableSales === "string" ? (appraisal.comparableSales as string) : "",
  );

  if (!appraisal) {
    return (
      <div>
        <p className="muted">No appraisal started yet.</p>
        <button className="btn btn-secondary" onClick={onStart}>
          Start Appraisal
        </button>
      </div>
    );
  }

  const submit = () => {
    onSave({ priceRangeLow: priceRangeLow || undefined, priceRangeHigh: priceRangeHigh || undefined, comparableSales: notes || undefined });
  };

  return (
    <div className="stack">
      {appraisal.isFinalised ? (
        <p>
          <span className="pill pill-success">Finalised</span> {priceRangeLow && priceRangeHigh ? `${priceRangeLow} – ${priceRangeHigh}` : ""}
        </p>
      ) : (
        <>
          <div className="inline-form">
            <label>
              Price range low ($)
              <input value={priceRangeLow} onChange={(e) => setPriceRangeLow(e.target.value)} />
            </label>
            <label>
              Price range high ($)
              <input value={priceRangeHigh} onChange={(e) => setPriceRangeHigh(e.target.value)} />
            </label>
          </div>
          <label>
            Comparable sales / notes
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Free-text comparable sales notes" />
          </label>
          <div className="inline-form">
            <button className="btn btn-secondary" onClick={submit}>
              Save
            </button>
            <button className="btn btn-primary" onClick={onFinalise} disabled={!priceRangeLow || !priceRangeHigh}>
              Finalise Appraisal
            </button>
          </div>
          {saveError && <p className="error-text">{saveError}</p>}
          {finaliseError && <p className="error-text">{finaliseError}</p>}
        </>
      )}
    </div>
  );
}

// Stage C (#116) — listing preparation fields. Purely descriptive; never
// publishes a listing, orders a supplier, or incurs a cost.
function ListingDetailsForm({
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

// #122 — agent-facing WAE task/reminder + attention-item surface. Plain
// completion/resolution actions; no invented workflow-builder UI.
function TasksAttentionBlock({
  tasks,
  attentionItems,
  onCompleteTask,
  onResolveAttentionItem,
}: {
  tasks: AutomationTaskBlock[];
  attentionItems: AttentionItemBlock[];
  onCompleteTask: (taskId: string) => void;
  onResolveAttentionItem: (itemId: string) => void;
}) {
  return (
    <div className="stack">
      {tasks.length > 0 && (
        <ul className="item-list">
          {tasks.map((t) => (
            <li key={t.id}>
              <span className={t.kind === "REMINDER" ? "pill" : "pill pill-success"}>{t.kind === "REMINDER" ? "Reminder" : "Task"}</span>{" "}
              {t.title}
              {t.dueAt && ` · due ${new Date(t.dueAt).toLocaleDateString()}`}
              {t.assignedRole && ` · ${t.assignedRole}`}
              <button className="btn btn-link" onClick={() => onCompleteTask(t.id)}>
                Mark Complete
              </button>
            </li>
          ))}
        </ul>
      )}
      {attentionItems.length > 0 && (
        <ul className="item-list">
          {attentionItems.map((item) => (
            <li key={item.id}>
              <span className="pill pill-danger">Needs attention</span> {item.reasonCode}
              {item.detail && ` — ${item.detail}`}
              <button className="btn btn-link" onClick={() => onResolveAttentionItem(item.id)}>
                Resolve
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
