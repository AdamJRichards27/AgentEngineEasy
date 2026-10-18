// Moved unchanged from PropertyWorkspace.tsx so a later shell can reuse this panel.

import { useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AskAgentEngine } from "../components/AskAgentEngine";
import { PropertyAppraisalSummary } from "../components/PropertyAppraisalSummary";
import { apiFetch, apiErrorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { transactionPanelActionVisibility } from "../lib/transactionPanelActions";
import type { ClosureBlockerDetail } from "../lib/closureBlockers";
import type { FundsReconciliationView } from "../lib/fundsReconciliation";
import { type PropertyExceptionsResponse, severityLabel, formatDueDate } from "../lib/riskExceptions";
// Agent Engine 2.0 — Property Launch & Campaign Coordination. Mirrors
// riskExceptions.ts's own "shared types + display helpers" module
// immediately above — see lib/launchPlan.ts's own header comment for why
// LAUNCH_OWNER_TYPES isn't re-imported from there too (it's
// EXCEPTION_OWNER_TYPES verbatim, reused from the import above instead).
import { type PropertyLaunchResponse, launchStatusLabel, launchStatusPillClass } from "../lib/launchPlan";
import { CommunicationsSection } from "../components/CommunicationsSection";
import { FinancialSummarySection } from "../components/FinancialSummarySection";
// AE GROW Priority 5 Remediation — Property Intelligence. Reused, unmodified, from the Property
// Workspace's own perspective (anchor="property"); Contact 360 (Grow.tsx) embeds the same
// component with anchor="contact". See that component's own header comment for why this is a
// shared panel rather than a second bespoke screen.
import { PropertyIntelligencePanel } from "../components/PropertyIntelligencePanel";
import { AddPartyForm } from "./AddPartyForm";
import { AgencyTermsForm } from "./AgencyTermsForm";
import { ExceptionsBlock } from "./ExceptionsBlock";
import { LaunchBlock } from "./LaunchBlock";
import { ListingDetailsForm } from "./ListingDetailsForm";
import { OffersBlock } from "./OffersBlock";
import { PaymentMethodsBlock } from "./PaymentMethodsBlock";
import { ServiceOrderRow } from "./ServiceOrderRow";
import { TasksAttentionBlock } from "./TasksAttentionBlock";
import { TransactionBlockView } from "./TransactionBlockView";
import type {
  ServiceOrderBlock,
  PaymentMethodBlock,
  OfferBlock,
  TransactionBlock,
  TimelineItem,
  ConditionBlock,
  AutomationTaskBlock,
  AttentionItemBlock,
  WorkspaceResponse,
} from "./types";
import {
  partyName,
  formatWhen,
  amlStatusCopy,
  amlPillClass,
  documentStatusCopy,
  timelineCategoryPillClass,
} from "./types";

// The Property Action Screen (Build Brief §13 / ARCHITECTURE.md §4) — the
// screen the whole build orients around. Answers "what needs to happen
// next?" with one primary action up top, then a compact People/Timeline
// view, then everything else tucked behind progressive-disclosure sections
// (staging brief: "avoid tabs... prioritise the current action").
export default function PropertyWorkspace({ params }: { params: { id: string } }) {
  const propertyId = Number(params.id);
  const queryClient = useQueryClient();
  const { user } = useSession();
  const [showAddParty, setShowAddParty] = useState(false);
  const [reviewNotes, setReviewNotes] = useState("");
  const [exceptionNotes, setExceptionNotes] = useState<Record<number, string>>({});

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["property-workspace", propertyId],
    queryFn: () => apiFetch<WorkspaceResponse>(`/properties/${propertyId}/workspace`),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["property-workspace", propertyId] });

  // One refresh for the closure list and the Close button. Every action that
  // can clear a blocker (and funds / agent paid, which can finish a task)
  // uses this instead of invalidating only its own list.
  const invalidateCloseState = () => {
    queryClient.invalidateQueries({ queryKey: ["transaction", propertyId] });
    queryClient.invalidateQueries({ queryKey: ["tasks", propertyId] });
    queryClient.invalidateQueries({ queryKey: ["property-exceptions", propertyId] });
    queryClient.invalidateQueries({ queryKey: ["conditions"] });
    queryClient.invalidateQueries({ queryKey: ["property-workspace", propertyId] });
  };

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
    onSuccess: invalidateCloseState,
  });

  const resolveAmlException = useMutation({
    mutationFn: ({ verificationId, notes }: { verificationId: number; notes: string }) =>
      apiFetch(`/aml/${verificationId}/resolve-exception`, { method: "POST", body: JSON.stringify({ notes }) }),
    onSuccess: (_data, variables) => {
      setExceptionNotes((prev) => ({ ...prev, [variables.verificationId]: "" }));
      invalidateCloseState();
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
    onSuccess: invalidateCloseState,
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
    queryFn: () =>
      apiFetch<{
        transaction: TransactionBlock | null;
        fundsReconciliation: FundsReconciliationView | null;
        closureBlockers: string[] | null;
        closureBlockerDetails: ClosureBlockerDetail[] | null;
      }>(`/transactions/by-property/${propertyId}`),
  });
  const invalidateTransaction = () => queryClient.invalidateQueries({ queryKey: ["transaction", propertyId] });

  // #131-#134 — Property Timeline, its own query so re-running an action
  // elsewhere (offers, transactions, documents, AML) only has to invalidate
  // this key rather than the whole workspace, and vice versa.
  const { data: timelineData } = useQuery({
    queryKey: ["property-timeline", propertyId],
    queryFn: () => apiFetch<{ timeline: TimelineItem[] }>(`/properties/${propertyId}/timeline`),
  });

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
    onSuccess: invalidateCloseState,
  });

  // Stage A (#114) — Appraisals. Additive/independent of workflowStage; an
  // unstarted appraisal shows as null and never blocks anything else.
  const startAppraisal = useMutation({
    mutationFn: () => apiFetch(`/appraisals/by-property/${propertyId}/start`, { method: "POST" }),
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
  const addCondition = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch(`/transactions/${transactionData!.transaction!.id}/conditions`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: invalidateCloseState,
  });
  const rescheduleCondition = useMutation({
    mutationFn: ({ conditionId, newDueDate }: { conditionId: number; newDueDate: string | null }) =>
      apiFetch(`/transactions/conditions/${conditionId}/reschedule`, { method: "POST", body: JSON.stringify({ newDueDate }) }),
    onSuccess: invalidateCloseState,
  });
  const resolveConditionMut = useMutation({
    mutationFn: ({ conditionId, status, notes }: { conditionId: number; status: string; notes?: string }) =>
      apiFetch(`/transactions/conditions/${conditionId}/resolve`, { method: "POST", body: JSON.stringify({ status, notes }) }),
    onSuccess: invalidateCloseState,
  });

  // #122 — agent-facing WAE task/attention-item visibility.
  const { data: tasksData } = useQuery({
    queryKey: ["tasks", propertyId],
    queryFn: () => apiFetch<{ tasks: AutomationTaskBlock[]; attentionItems: AttentionItemBlock[] }>(`/tasks/by-property/${propertyId}`),
  });
  const completeTask = useMutation({
    mutationFn: (taskId: string) => apiFetch(`/tasks/${taskId}/complete`, { method: "POST" }),
    onSuccess: invalidateCloseState,
  });
  const resolveAttentionItemMut = useMutation({
    mutationFn: (itemId: string) => apiFetch(`/tasks/attention-items/${itemId}/resolve`, { method: "POST" }),
    onSuccess: invalidateCloseState,
  });

  // #145 — property-level Exception & Risk Engine panel (§16-18). This
  // panel only ever displays what GET /properties/:id/exceptions returns
  // and calls the same lifecycle routes every other client would — the
  // engine (never this UI) is the sole place a transition is decided;
  // model.ts re-validates the current status server-side regardless of
  // what state this panel shows (Build Instructions §19).
  const { data: exceptionsData } = useQuery({
    queryKey: ["property-exceptions", propertyId],
    queryFn: () => apiFetch<PropertyExceptionsResponse>(`/properties/${propertyId}/exceptions`),
  });
  const acknowledgeExceptionMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/exceptions/${id}/acknowledge`, { method: "POST" }),
    onSuccess: invalidateCloseState,
  });
  const startRemediationMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/exceptions/${id}/start-remediation`, { method: "POST" }),
    onSuccess: invalidateCloseState,
  });
  const awaitingExternalMut = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      apiFetch(`/exceptions/${id}/awaiting-external`, { method: "POST", body: JSON.stringify({ note }) }),
    onSuccess: invalidateCloseState,
  });
  const resolveExceptionMut = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      apiFetch(`/exceptions/${id}/resolve`, { method: "POST", body: JSON.stringify({ note }) }),
    onSuccess: invalidateCloseState,
  });
  const dismissExceptionMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiFetch(`/exceptions/${id}/dismiss`, { method: "POST", body: JSON.stringify({ reason }) }),
    onSuccess: invalidateCloseState,
  });
  const reassignExceptionMut = useMutation({
    mutationFn: ({ id, ownerType, reason }: { id: string; ownerType: string; reason: string }) =>
      apiFetch(`/exceptions/${id}/reassign`, { method: "POST", body: JSON.stringify({ ownerType, ownerUserId: null, reason }) }),
    onSuccess: invalidateCloseState,
  });

  // Agent Engine 2.0 — Property Launch & Campaign Coordination. `launch`
  // is null (not an error) until AGENCY_AGREEMENT_SIGNED auto-proposes a
  // plan (lib/launch/bootstrap.ts) — same "only show what applies"
  // contract as offers/transaction above. One generic path-plus-body
  // action mutation for the whole Launch surface, mirroring
  // transactionAction's own dispatch pattern above, rather than ~20
  // near-identical useMutation hooks for each Launch endpoint.
  const { data: launchData } = useQuery({
    queryKey: ["property-launch", propertyId],
    queryFn: () => apiFetch<PropertyLaunchResponse>(`/properties/${propertyId}/launch`),
  });
  const invalidateLaunch = () => queryClient.invalidateQueries({ queryKey: ["property-launch", propertyId] });

  const launchAction = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: Record<string, unknown> }) =>
      apiFetch(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined }),
    onSuccess: invalidateLaunch,
  });
  const launchErrorFor = (path: string): string | null =>
    launchAction.isError && launchAction.variables?.path === path
      ? apiErrorMessage(launchAction.error, "Couldn't update the launch plan. Try again.")
      : null;
  const launchPendingPath = launchAction.isPending ? (launchAction.variables?.path ?? null) : null;

  const [preview, setPreview] = useState<{ documentId: number; content: string } | null>(null);
  const previewDocument = async (documentId: number) => {
    const res = await fetch(`/api/documents/${documentId}/content`, { credentials: "include" });
    const content = res.ok ? await res.text() : "Could not load this document right now.";
    setPreview({ documentId, content });
  };

  if (isLoading || !data) {
    if (isError) return <p className="error-text">{apiErrorMessage(error, "Couldn't load this property. Try again.")}</p>;
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
    // R-F32 — the Next step slot uses the same R-F30 visibility as the
    // Transaction panel. Settled or Closed cannot gain a contract date,
    // and Closed cannot record finance approval.
    const panelActions = transactionPanelActionVisibility(transaction, user?.role);
    if (panelActions.closed) {
      primary = { title: "Transaction closed", description: "There's nothing further to action on this property." };
    } else if (panelActions.markContractSigned) {
      primary = {
        title: "Prepare Contract",
        action: (
          <button className="btn btn-primary" onClick={() => transactionAction.mutate({ transactionId: transaction.id, action: "contract-signed" })}>
            Mark Contract Signed
          </button>
        ),
      };
    } else if (panelActions.markFinanceApproved) {
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

      {/* AE GROW Priority 5 Remediation — Property Intelligence. Extends this existing Property
          Workspace view rather than adding a second property screen, per the remediation
          objective's own instruction. Placed immediately under the header so it reads as a
          concise decision-support summary of this property, not a raw provider-data dump; the
          panel independently gates itself on grow.propertyIntelligence.read via
          useEntitlements() and renders nothing (not even a placeholder) when the viewer lacks
          it, so no wiring is needed here beyond mounting it. */}
      <PropertyIntelligencePanel anchor="property" propertyId={propertyId} />

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

      {/* #145 — Exception & Risk Engine (§16-18). Shown above Tasks &
          Attention: an open exception is the more authoritative signal
          (deterministic rule + authoritative evidence, Build Instructions
          §19) rather than a WAE-derived reminder, so it leads. Only
          rendered once there's something to show — an empty engine result
          adds no visual weight to a property with nothing open. */}
      {exceptionsData && exceptionsData.exceptions.length > 0 && (
        <section className="card" id="workspace-exceptions">
          <h2>Exceptions</h2>
          <p className="muted">
            {exceptionsData.summary.openCount} open
            {exceptionsData.summary.highestSeverity && ` · highest severity: ${severityLabel(exceptionsData.summary.highestSeverity)}`}
          </p>
          <ExceptionsBlock
            exceptions={exceptionsData.exceptions}
            onAcknowledge={(id) => acknowledgeExceptionMut.mutate(id)}
            onStartRemediation={(id) => startRemediationMut.mutate(id)}
            onMarkAwaitingExternal={(id, note) => awaitingExternalMut.mutate({ id, note })}
            onResolve={(id, note) => resolveExceptionMut.mutate({ id, note })}
            onDismiss={(id, reason) => dismissExceptionMut.mutate({ id, reason })}
            onReassign={(id, ownerType, reason) => reassignExceptionMut.mutate({ id, ownerType, reason })}
          />
        </section>
      )}

      {/* #122 — agent-facing WAE task/reminder + attention-item
          visibility. Shown up top, next to the primary action, since these
          are exactly the kind of "what needs to happen" items the primary
          action slot can't always capture (WAE-originated, not
          workflow-stage-derived). */}
      {(activeTasks.length > 0 || openAttentionItems.length > 0) && (
        <section className="card" id="workspace-tasks">
          <h2>Tasks & Attention</h2>
          <TasksAttentionBlock
            tasks={activeTasks}
            attentionItems={openAttentionItems}
            onCompleteTask={(id) => completeTask.mutate(id)}
            onResolveAttentionItem={(id) => resolveAttentionItemMut.mutate(id)}
          />
        </section>
      )}

      {/* Agent Engine 2.0 -- Communications Hub (Priority 8, Section 32):
          the property-centred communication record -- WHO needs to hear
          WHAT, from WHOM, by WHEN, and did it happen. Self-contained (owns
          its own data fetching) so it drops in here without adding more
          state to this already-large component -- see
          components/CommunicationsSection.tsx. */}
      <CommunicationsSection propertyId={propertyId} />

      {/* Sellers — the property-workspace example in the staging brief
          shows the seller list front and centre, not tucked away. */}
      <section className="card" id="workspace-sellers">
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

        <div id="workspace-parties">
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
        </div>

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
            createError={createOffer.isError ? apiErrorMessage(createOffer.error, "Couldn't record that offer. Try again.") : null}
            onAccept={(id) => acceptOffer.mutate(id)}
            acceptError={acceptOffer.isError ? apiErrorMessage(acceptOffer.error, "Couldn't accept that offer. Try again.") : null}
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
            fundsReconciliation={transactionData?.fundsReconciliation ?? null}
            closureBlockers={transactionData?.closureBlockers ?? null}
            closureBlockerDetails={transactionData?.closureBlockerDetails ?? null}
            viewerRole={user?.role}
            onAction={(action, body) => transactionAction.mutate({ transactionId: transaction.id, action, body })}
            error={transactionAction.isError ? apiErrorMessage(transactionAction.error, "Couldn't update the transaction. Try again.") : null}
            conditions={conditionsData?.conditions ?? []}
            settlementConditions={conditionsData ? conditionsData.conditions : null}
            onAddCondition={(input) => addCondition.mutate(input)}
            addConditionError={addCondition.isError ? apiErrorMessage(addCondition.error, "Couldn't add that condition. Try again.") : null}
            onRescheduleCondition={(conditionId, newDueDate) => rescheduleCondition.mutate({ conditionId, newDueDate })}
            onResolveCondition={(conditionId, status, notes) => resolveConditionMut.mutate({ conditionId, status, notes })}
            onExchange={() => transactionAction.mutate({ transactionId: transaction.id, action: "exchange" })}
            onMarkUnconditional={() => transactionAction.mutate({ transactionId: transaction.id, action: "unconditional" })}
            unconditionalError={
              transactionAction.isError && transactionAction.variables?.action === "unconditional"
                ? apiErrorMessage(transactionAction.error, "Couldn't mark this unconditional. Try again.")
                : null
            }
            solicitors={solicitors}
            onSaveLegalReps={(input) => transactionAction.mutate({ transactionId: transaction.id, action: "legal-representatives", body: input })}
          />
        </section>
      )}

      {/* Agent Engine 2.0 — Property Launch & Campaign Coordination. Only
          rendered once a Launch Plan exists (auto-proposed on
          AGENCY_AGREEMENT_SIGNED) — same "empty engine result adds no
          visual weight" discipline the Exceptions section above already
          follows. A Market Ready blocker is never a second warning system:
          Launch's own risk conditions (category LAUNCH_CAMPAIGN) already
          surface through the Exceptions panel above like any other
          exception — this card is purely Launch's own compact status
          summary. Full campaign/vendor/portal management lives in the
          "Launch — Campaign & Portals" details section further down. */}
      {launchData?.launch && (
        <section className="card">
          <h2>Launch</h2>
          <p className="muted">
            <span className={launchStatusPillClass(launchData.launch.plan.status)}>{launchStatusLabel(launchData.launch.plan.status)}</span>
            {launchData.launch.plan.targetLaunchDate && ` · Target ${formatDueDate(launchData.launch.plan.targetLaunchDate)}`}
          </p>
          {launchData.launch.plan.status === "LISTING_LIVE" ? (
            <p className="muted">Listing is live.</p>
          ) : launchData.launch.plan.status === "CANCELLED" ? (
            <p className="muted">This launch was cancelled.</p>
          ) : launchData.launch.plan.marketReadyBlockers.length > 0 ? (
            <p className="muted">
              Not yet Market Ready — {launchData.launch.plan.marketReadyBlockers[0].message}
              {launchData.launch.plan.marketReadyBlockers.length > 1 && ` (+${launchData.launch.plan.marketReadyBlockers.length - 1} more)`}
            </p>
          ) : (
            <p className="muted">Market Ready.</p>
          )}
        </section>
      )}

      {/* Timeline (#131-#134) — the unified read-model over domainEvents +
          a curated auditLogs allow-list (apps/api/src/lib/timeline.ts):
          every real milestone appears exactly once, in order, with
          commission/funds/agent-paid figures already redacted server-side
          for anyone who isn't a Brokerage Administrator. */}
      {timelineData && timelineData.timeline.length > 0 && (
        <details className="section" open>
          <summary>Timeline</summary>
          <ul className="timeline">
            {timelineData.timeline.map((t) => (
              <li key={t.id}>
                <span className="when">{formatWhen(t.occurredAt)}</span>
                <span className={timelineCategoryPillClass(t.category)} style={{ marginRight: "0.5rem" }}>
                  {t.category}
                </span>
                {t.label}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Everything below is detail, not the current action — tucked
          behind progressive disclosure (staging brief: "avoid tabs unless
          genuinely required"). */}

      {/* Agent Engine 2.0 — Property Launch & Campaign Coordination. The
          full operational surface (template, target date, campaign items,
          budget, vendor approvals, portal destinations, Market Ready,
          Listing Live, pause/resume/cancel) — everything the compact
          Launch card above only summarises. */}
      {launchData?.launch && (
        <details className="section">
          <summary>Launch — Campaign & Portals</summary>
          <LaunchBlock
            detail={launchData.launch}
            onAction={(path, body) => launchAction.mutate({ path, body })}
            pendingPath={launchPendingPath}
            errorFor={launchErrorFor}
          />
        </details>
      )}

      {/* Stage A (#114) — Appraisal. Independent of workflowStage; purely
          additive valuation capture, never a blocker to any other stage. */}
      <details className="section">
        <summary>Appraisal</summary>
        <PropertyAppraisalSummary
          appraisal={data.appraisal}
          onStart={() => startAppraisal.mutate()}
          startError={startAppraisal.isError ? apiErrorMessage(startAppraisal.error, "Couldn't start this appraisal. Try again.") : null}
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
          error={saveListingDetails.isError ? apiErrorMessage(saveListingDetails.error, "Couldn't save the listing details. Try again.") : null}
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
          {populatePackage.isError && <p className="error-text">{apiErrorMessage(populatePackage.error, "Couldn't prepare those documents. Try again.")}</p>}
          {sendForSignature.isError && <p className="error-text">{apiErrorMessage(sendForSignature.error, "Couldn't send documents for signature. Try again.")}</p>}

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
          error={addPaymentMethod.isError ? apiErrorMessage(addPaymentMethod.error, "Couldn't add that payment method. Try again.") : null}
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
                  chargeError={
                    chargeServiceOrder.isError && chargeServiceOrder.variables === so.id
                      ? apiErrorMessage(chargeServiceOrder.error, "Couldn't charge that service order. Try again.")
                      : null
                  }
                  onRefund={(paymentId) => refundPayment.mutate({ paymentId, serviceOrderId: so.id })}
                  refundError={refundPayment.isError ? apiErrorMessage(refundPayment.error, "Couldn't refund that payment. Try again.") : null}
                />
              ))}
            </ul>
          </>
        )}
      </details>

      {/* Agent Engine 2.0 — Financial Transaction Engine (Priority 9,
          Stage G, Section 28). Self-gates on Brokerage Administrator
          internally (this component's own header comment explains why) —
          see components/FinancialSummarySection.tsx. */}
      <div id="workspace-financial">
        <FinancialSummarySection propertyId={propertyId} />
      </div>

      {/* Ready to List / Go Live fallback controls — normally reached via
          the primary action above; kept here too so nothing is lost if the
          primary action logic doesn't match a given state. */}
      {data.property.workflowStage === "Appraisal" && !primary && (
        <div>
          <button className="btn btn-primary" onClick={() => readyToList.mutate()} disabled={sellers.length === 0}>
            Ready to List
          </button>
          {readyToList.isError && <p className="error-text">{apiErrorMessage(readyToList.error, "Couldn't mark this ready to list. Try again.")}</p>}
        </div>
      )}
      {readyToList.isError && data.property.workflowStage === "Appraisal" && primary && (
        <p className="error-text">{apiErrorMessage(readyToList.error, "Couldn't mark this ready to list. Try again.")}</p>
      )}
      {goLive.isError && <p className="error-text">{apiErrorMessage(goLive.error, "Couldn't take this listing live. Try again.")}</p>}
    </div>
  );
}
