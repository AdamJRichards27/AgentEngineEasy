import { useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AskAgentEngine } from "../components/AskAgentEngine";
import { PropertyAppraisalSummary } from "../components/PropertyAppraisalSummary";
import { apiFetch, apiErrorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { transactionPanelActionVisibility } from "../lib/transactionPanelActions";
import { closeBlockedReason, closeTransactionDisabled, visibleClosureBlockerRows, type ClosureBlockerDetail } from "../lib/closureBlockers";
import { fundsReconciliationLabel, type FundsReconciliationView } from "../lib/fundsReconciliation";
import {
  type PropertyExceptionsResponse,
  type RiskExceptionRow,
  severityLabel,
  severityPillClass,
  statusLabel,
  categoryLabel,
  formatDueDate,
  isOverdue,
  EXCEPTION_OWNER_TYPES,
  ownerTypeLabel,
} from "../lib/riskExceptions";
// Agent Engine 2.0 — Property Launch & Campaign Coordination. Mirrors
// riskExceptions.ts's own "shared types + display helpers" module
// immediately above — see lib/launchPlan.ts's own header comment for why
// LAUNCH_OWNER_TYPES isn't re-imported from there too (it's
// EXCEPTION_OWNER_TYPES verbatim, reused from the import above instead).
import {
  type PropertyLaunchResponse,
  type LaunchPlanDetail,
  LAUNCH_TEMPLATE_TYPES,
  CAMPAIGN_ITEM_TYPES,
  CAMPAIGN_ITEM_STATUSES,
  VENDOR_APPROVAL_TYPES,
  launchStatusLabel,
  launchStatusPillClass,
  templateTypeLabel,
  campaignItemTypeLabel,
  campaignItemStatusLabel,
  campaignItemStatusPillClass,
  portalStatusLabel,
  portalStatusPillClass,
  vendorApprovalTypeLabel,
  vendorApprovalStatusLabel,
  vendorApprovalStatusPillClass,
} from "../lib/launchPlan";
import { CommunicationsSection } from "../components/CommunicationsSection";
import { FinancialSummarySection } from "../components/FinancialSummarySection";
// AE GROW Priority 5 Remediation — Property Intelligence. Reused, unmodified, from the Property
// Workspace's own perspective (anchor="property"); Contact 360 (Grow.tsx) embeds the same
// component with anchor="contact". See that component's own header comment for why this is a
// shared panel rather than a second bespoke screen.
import { PropertyIntelligencePanel } from "../components/PropertyIntelligencePanel";

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
  /** Omitted by the server unless the viewer is the listing agent or a
   * Brokerage Administrator (Owner t165u); offerTermsVisible is then false. */
  offerPriceCents?: number;
  offerTermsVisible?: boolean;
  status: string;
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

// #131-#134 — the unified Timeline read-model (apps/api/src/lib/timeline.ts),
// served from its own GET /properties/:id/timeline endpoint rather than
// embedded in the workspace response, so a Timeline-only refresh doesn't
// require refetching the whole workspace. A SENSITIVE entry's label is
// already redacted server-side for a non-Brokerage-Administrator viewer
// (detail is simply absent then) — the frontend never re-derives that.
interface TimelineItem {
  id: string;
  propertyId: number;
  entryType: string;
  category: "Property" | "Party" | "AML" | "Appraisal" | "Listing" | "Document" | "Offer" | "Transaction" | "Task" | "Compliance";
  occurredAt: string;
  actor: { type: string; userId: number | null; label: string } | null;
  label: string;
  sensitivity: "STANDARD" | "SENSITIVE";
  detail?: Record<string, unknown>;
  source: "domain_event" | "audit_log";
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

// #131-#134 — Timeline category pill. Compliance carries the redacted
// financial milestones (commission/funds/agent-paid) alongside payment
// audit entries, so it gets the same warning tone the rest of the app
// already uses for "needs attention" (amlPillClass, above) rather than a
// plain default pill.
function timelineCategoryPillClass(category: TimelineItem["category"]): string {
  if (category === "Compliance") return "pill pill-warning";
  if (category === "Offer" || category === "Transaction") return "pill pill-success";
  return "pill";
}

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
  if (o.offerTermsVisible === false || o.offerPriceCents === undefined) return `Price restricted — ${o.status}`;
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
  fundsReconciliation,
  closureBlockers,
  closureBlockerDetails,
  viewerRole,
  onAction,
  error,
  conditions,
  settlementConditions,
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
  fundsReconciliation: FundsReconciliationView | null;
  /** R-F42 blockers from the transaction read. Null when the read omitted them. */
  closureBlockers: readonly string[] | null;
  closureBlockerDetails: readonly ClosureBlockerDetail[] | null;
  viewerRole: string | null | undefined;
  onAction: (action: string, body?: Record<string, unknown>) => void;
  error: string | null;
  conditions: ConditionBlock[];
  /** null while GET /transactions/:id/conditions has not returned. An empty list is loaded. */
  settlementConditions: ReadonlyArray<{ status: string }> | null;
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
  // R-F32 — offer a control only when R-F30 would accept the write.
  // R-F35a — settlement completion, funds received, and commission
  // calculation stay hidden unless the signed-in role is Brokerage
  // Administrator. Milestone text stays visible either way. `error` stays
  // below so a stale click still shows the server message, including a 403.
  // R-F38 — Mark Settlement Completed stays on screen for an administrator
  // and is disabled until the contract is unconditional. settlementConditions
  // is the existing conditions GET; null means it has not loaded.
  const actions = transactionPanelActionVisibility(transaction, viewerRole, settlementConditions);
  const closeBlockers = visibleClosureBlockerRows(transaction.status, closureBlockers, closureBlockerDetails);
  const closeDisabled = closeTransactionDisabled(transaction.status, closureBlockers);

  return (
    <div className="stack">
      <p>
        {formatCents(transaction.purchasePriceCents)} · <span className="pill">{transaction.status}</span>
      </p>
      {actions.closedNote && <p className="muted">{actions.closedNote}</p>}

      <div>
        Contract: {transaction.contractDate ? `signed ${transaction.contractDate}` : "not yet signed"}
        {actions.markContractSigned && (
          <button className="btn btn-small" onClick={() => onAction("contract-signed")} style={{ marginLeft: "0.5rem" }}>
            Mark Contract Signed
          </button>
        )}
      </div>

      <div>
        Finance: {transaction.financeApprovedAt ? `approved ${transaction.financeApprovedAt}` : "not recorded"}
        {actions.markFinanceApproved && (
          <button className="btn btn-small" onClick={() => onAction("finance-approved")} style={{ marginLeft: "0.5rem" }}>
            Mark Finance Approved
          </button>
        )}
      </div>

      {/* Stage E (#118) — contract conditions + exchange/unconditional. */}
      <ConditionsBlock
        conditions={conditions}
        editable={actions.editConditions}
        onAdd={onAddCondition}
        addError={addConditionError}
        onReschedule={onRescheduleCondition}
        onResolve={onResolveCondition}
      />

      <div>
        Exchange: {transaction.exchangedAt ? `exchanged ${transaction.exchangedAt}` : "not yet exchanged"}
        {actions.markExchange && (
          <button className="btn btn-small" onClick={onExchange} style={{ marginLeft: "0.5rem" }}>
            Mark Contracts Exchanged
          </button>
        )}
      </div>

      <div id="transaction-unconditional">
        Unconditional:{" "}
        {transaction.unconditionalAt
          ? `became unconditional ${transaction.unconditionalAt}`
          : "not yet unconditional"}
        {actions.markUnconditional && (
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
        editable={actions.editLegalRepresentatives}
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
      {(actions.scheduleSettlement || actions.completeSettlement) && (
        <div className="inline-form">
          {actions.scheduleSettlement && (
            <>
              <input type="date" value={settlementDate} onChange={(e) => setSettlementDate(e.target.value)} />
              <button
                className="btn btn-small"
                onClick={() => settlementDate && onAction("settlement-schedule", { settlementDate })}
                disabled={!settlementDate}
              >
                Schedule Settlement
              </button>
            </>
          )}
          {actions.completeSettlement && (
            <button
              className="btn btn-small"
              onClick={() => {
                if (actions.completeSettlementReason) return;
                onAction("settlement-complete");
              }}
              disabled={actions.completeSettlementReason !== null}
            >
              Mark Settlement Completed
            </button>
          )}
        </div>
      )}
      {actions.completeSettlementReason && <p className="muted">{actions.completeSettlementReason}</p>}

      <div id="transaction-commission">
        Commission:{" "}
        {transaction.commissionCalculatedAt
          ? `${formatCents(transaction.grossCommissionCents ?? 0)} + ${formatCents(transaction.gstCents ?? 0)} GST`
          : "not yet calculated"}
        {actions.calculateCommission && (
          <button className="btn btn-small" onClick={() => onAction("calculate-commission")} style={{ marginLeft: "0.5rem" }}>
            Calculate Commission
          </button>
        )}
      </div>

      <div className="inline-form" id="transaction-funds">
        <span>Funds received: {formatCents(transaction.fundsReceivedCents)}</span>
        {actions.recordFundsReceived && (
          <>
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
          </>
        )}
      </div>
      {fundsReconciliation && <div>{fundsReconciliationLabel(fundsReconciliation)}</div>}

      <div>
        Agent paid: {transaction.agentPaidAt ?? "not yet"}
        {actions.markAgentPaid && (
          <button className="btn btn-small" onClick={() => onAction("agent-paid")} style={{ marginLeft: "0.5rem" }}>
            Mark Agent Paid
          </button>
        )}
      </div>

      {closeBlockers.length > 0 && (
        <div>
          <p className="muted">{closeBlockedReason(viewerRole)}</p>
          <ul className="item-list">
            {closeBlockers.map((blocker, index) => (
              <li key={`${index}-${blocker.message}`}>
                {blocker.href ? <a href={blocker.href}>{blocker.plain}</a> : blocker.plain}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        {transaction.status === "Closed" ? (
          `Closed ${transaction.closedAt}`
        ) : (
          <button
            className="btn btn-primary btn-small"
            onClick={() => {
              if (closeDisabled) return;
              onAction("close");
            }}
            disabled={closeDisabled}
          >
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
  editable,
  onAdd,
  addError,
  onReschedule,
  onResolve,
}: {
  conditions: ConditionBlock[];
  editable: boolean;
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
    <div id="transaction-conditions">
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
              {editable && c.status === "Pending" && (
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
      {editable && !showAdd ? (
        <button className="btn btn-link" onClick={() => setShowAdd(true)}>
          + Add Condition
        </button>
      ) : editable ? (
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
      ) : null}
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

// #145 — Exception & Risk Engine property panel (§16-18). One row per
// exception, collapsed detail behind "View Details" (same convention as
// the AML exception block above), with only the lifecycle actions valid
// for that exception's *current* status ever rendered — this UI narrows
// which button appears, but never which transition the server accepts;
// model.ts re-checks the status itself either way (Build Instructions
// §19/§21).
function ExceptionsBlock({
  exceptions,
  onAcknowledge,
  onStartRemediation,
  onMarkAwaitingExternal,
  onResolve,
  onDismiss,
  onReassign,
}: {
  exceptions: RiskExceptionRow[];
  onAcknowledge: (id: string) => void;
  onStartRemediation: (id: string) => void;
  onMarkAwaitingExternal: (id: string, note: string) => void;
  onResolve: (id: string, note: string) => void;
  onDismiss: (id: string, reason: string) => void;
  onReassign: (id: string, ownerType: string, reason: string) => void;
}) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [reassignOwnerType, setReassignOwnerType] = useState<Record<string, string>>({});
  const [reassignReason, setReassignReason] = useState<Record<string, string>>({});

  return (
    <ul className="item-list">
      {exceptions.map((e) => {
        const closed = e.status === "RESOLVED" || e.status === "DISMISSED";
        const canStartRemediation = e.status === "ACKNOWLEDGED" || e.status === "REOPENED";
        const canResolveOrDismiss = e.status === "IN_PROGRESS" || e.status === "AWAITING_EXTERNAL";
        return (
          <li key={e.id}>
            <div>
              <span className={severityPillClass(e.severity)}>{severityLabel(e.severity)}</span>{" "}
              <span className="pill">{statusLabel(e.status)}</span>{" "}
              <strong>{e.title}</strong>
              {e.dueAt && (
                <span className={isOverdue(e.dueAt) && !closed ? "pill pill-danger" : "muted"} style={{ marginLeft: "0.5rem" }}>
                  {isOverdue(e.dueAt) && !closed ? "Overdue " : "Due "}
                  {formatDueDate(e.dueAt)}
                </span>
              )}
            </div>
            <p className="muted" style={{ marginBottom: "0.4rem" }}>
              {categoryLabel(e.category)} · {e.problemDescription}
            </p>

            {e.status === "OPEN" && (
              <button className="btn btn-small" onClick={() => onAcknowledge(e.id)}>
                Acknowledge
              </button>
            )}
            {canStartRemediation && (
              <button className="btn btn-small" onClick={() => onStartRemediation(e.id)}>
                Start Remediation
              </button>
            )}

            <details style={{ marginTop: "0.5rem" }}>
              <summary className="muted">View Details</summary>
              <p className="muted">Business impact: {e.businessImpact}</p>
              <p className="muted">Recommended action: {e.recommendedAction}</p>
              {e.resolutionRequirements && <p className="muted">To resolve: {e.resolutionRequirements}</p>}
              {e.occurrenceCount > 1 && <p className="muted">Detected {e.occurrenceCount} times, most recently {formatDueDate(e.lastDetectedAt)}.</p>}

              {closed ? (
                <p className="muted">
                  {e.status === "RESOLVED"
                    ? `Resolved${e.resolutionMethod ? ` (${e.resolutionMethod === "AUTO" ? "automatically" : "manually"})` : ""}${e.resolvedAt ? ` on ${formatDueDate(e.resolvedAt)}` : ""}.`
                    : `Dismissed${e.dismissalReason ? `: ${e.dismissalReason}` : "."}`}
                </p>
              ) : (
                <>
                  {canResolveOrDismiss && (
                    <div className="stack">
                      <input
                        value={notes[e.id] ?? ""}
                        onChange={(ev) => setNotes((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                        placeholder="Resolution note (required)"
                      />
                      <button
                        className="btn btn-small"
                        onClick={() => onResolve(e.id, (notes[e.id] ?? "").trim())}
                        disabled={!(notes[e.id] ?? "").trim()}
                      >
                        Mark Resolved
                      </button>
                      <button
                        className="btn btn-small"
                        onClick={() => onMarkAwaitingExternal(e.id, (notes[e.id] ?? "").trim())}
                        disabled={!(notes[e.id] ?? "").trim()}
                      >
                        Awaiting External Action
                      </button>
                      {e.dismissible && (
                        <>
                          <input
                            value={reasons[e.id] ?? ""}
                            onChange={(ev) => setReasons((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                            placeholder="Dismissal reason (required)"
                          />
                          <button
                            className="btn btn-small btn-danger"
                            onClick={() => onDismiss(e.id, (reasons[e.id] ?? "").trim())}
                            disabled={!(reasons[e.id] ?? "").trim()}
                          >
                            Dismiss
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  <div className="inline-form" style={{ marginTop: "0.5rem" }}>
                    <select
                      value={reassignOwnerType[e.id] ?? ""}
                      onChange={(ev) => setReassignOwnerType((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                    >
                      <option value="">Reassign to…</option>
                      <option value="LISTING_AGENT">Listing Agent</option>
                      <option value="TRANSACTION_OWNER">Transaction Owner</option>
                      <option value="BROKERAGE_ADMINISTRATOR">Brokerage Administrator</option>
                      <option value="PIT_CREW">Pit Crew</option>
                      <option value="UNASSIGNED_QUEUE">Unassigned Queue</option>
                    </select>
                    <input
                      value={reassignReason[e.id] ?? ""}
                      onChange={(ev) => setReassignReason((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                      placeholder="Reason for reassignment"
                    />
                    <button
                      className="btn btn-small"
                      onClick={() => {
                        onReassign(e.id, reassignOwnerType[e.id]!, (reassignReason[e.id] ?? "").trim());
                        setReassignOwnerType((prev) => ({ ...prev, [e.id]: "" }));
                        setReassignReason((prev) => ({ ...prev, [e.id]: "" }));
                      }}
                      disabled={!reassignOwnerType[e.id] || !(reassignReason[e.id] ?? "").trim()}
                    >
                      Reassign
                    </button>
                  </div>
                </>
              )}
            </details>
          </li>
        );
      })}
    </ul>
  );
}

// Agent Engine 2.0 — Property Launch & Campaign Coordination. The full
// operational surface behind the "Launch — Campaign & Portals" details
// section: template + target date, campaign items (status/responsibility/
// vendor+cost/evidence), budget, vendor approvals, portal destinations,
// Market Ready, Listing Live, and pause/resume/cancel. `onAction` is a
// single path-plus-body dispatcher (mirrors TransactionBlockView's own
// `onAction` prop below) rather than one callback per endpoint — Launch's
// HTTP surface is too wide (~20 routes) for that to stay readable.
// `errorFor`/`pendingPath` let each individual control show only its own
// in-flight/error state, the same scoping transactionAction's own
// `variables?.action === "unconditional"` check already does for a single
// control further down this file.
function LaunchBlock({
  detail,
  onAction,
  pendingPath,
  errorFor,
}: {
  detail: LaunchPlanDetail;
  onAction: (path: string, body?: Record<string, unknown>) => void;
  pendingPath: string | null;
  errorFor: (path: string) => string | null;
}) {
  const { plan, items, destinations, approvals } = detail;

  const [targetDate, setTargetDate] = useState("");
  const [newItemType, setNewItemType] = useState<(typeof CAMPAIGN_ITEM_TYPES)[number]>("PHOTOGRAPHY");
  const [newItemTitle, setNewItemTitle] = useState("");
  const [itemStatusChoice, setItemStatusChoice] = useState<Record<string, string>>({});
  const [itemBlockedReason, setItemBlockedReason] = useState<Record<string, string>>({});
  const [itemVendorName, setItemVendorName] = useState<Record<string, string>>({});
  const [itemCostDollars, setItemCostDollars] = useState<Record<string, string>>({});
  const [itemOwnerType, setItemOwnerType] = useState<Record<string, string>>({});
  const [itemEvidenceLabel, setItemEvidenceLabel] = useState<Record<string, string>>({});
  const [itemEvidenceUrl, setItemEvidenceUrl] = useState<Record<string, string>>({});
  const [budgetDollars, setBudgetDollars] = useState("");
  const [approvalDecisionAmount, setApprovalDecisionAmount] = useState<Record<string, string>>({});
  const [approvalDecisionNotes, setApprovalDecisionNotes] = useState<Record<string, string>>({});
  const [approvalRequestType, setApprovalRequestType] = useState<(typeof VENDOR_APPROVAL_TYPES)[number]>("BUDGET");
  const [approvalRequestItem, setApprovalRequestItem] = useState("");
  const [approvalRequestAmount, setApprovalRequestAmount] = useState("");
  const [newPortalName, setNewPortalName] = useState("");
  const [portalUrlInput, setPortalUrlInput] = useState<Record<string, string>>({});
  const [portalFailReason, setPortalFailReason] = useState<Record<string, string>>({});
  const [overrideReason, setOverrideReason] = useState("");
  const [pauseReason, setPauseReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");

  const marketReady = plan.marketReadyEvaluatedAt !== null && plan.marketReadyBlockers.length === 0;
  const canPauseOrCancel = plan.status !== "CANCELLED" && plan.status !== "LISTING_LIVE" && plan.status !== "PAUSED";

  return (
    <div className="stack">
      <div>
        <span className={launchStatusPillClass(plan.status)}>{launchStatusLabel(plan.status)}</span>{" "}
        {plan.status === "PAUSED" && plan.pauseReason && <span className="muted">— {plan.pauseReason}</span>}
        {plan.status === "CANCELLED" && plan.cancelReason && <span className="muted">— {plan.cancelReason}</span>}
        {plan.status === "LISTING_LIVE" && plan.actualLaunchDate && <span className="muted"> — went live {formatDueDate(plan.actualLaunchDate)}</span>}
      </div>

      {plan.status === "PAUSED" && (
        <div>
          <button className="btn btn-small" onClick={() => onAction(`/launch/${plan.id}/resume`)} disabled={pendingPath === `/launch/${plan.id}/resume`}>
            Resume Launch
          </button>
          {errorFor(`/launch/${plan.id}/resume`) && <p className="error-text">{errorFor(`/launch/${plan.id}/resume`)}</p>}
        </div>
      )}

      {canPauseOrCancel && (
        <details>
          <summary className="muted">Pause or cancel this launch</summary>
          <div className="inline-form" style={{ marginTop: "0.5rem" }}>
            <input value={pauseReason} onChange={(e) => setPauseReason(e.target.value)} placeholder="Reason to pause (required)" />
            <button
              className="btn btn-small"
              onClick={() => {
                onAction(`/launch/${plan.id}/pause`, { reason: pauseReason.trim() });
                setPauseReason("");
              }}
              disabled={!pauseReason.trim() || pendingPath === `/launch/${plan.id}/pause`}
            >
              Pause
            </button>
          </div>
          {errorFor(`/launch/${plan.id}/pause`) && <p className="error-text">{errorFor(`/launch/${plan.id}/pause`)}</p>}
          <div className="inline-form" style={{ marginTop: "0.5rem" }}>
            <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Reason to cancel (required)" />
            <button
              className="btn btn-small btn-danger"
              onClick={() => {
                onAction(`/launch/${plan.id}/cancel`, { reason: cancelReason.trim() });
                setCancelReason("");
              }}
              disabled={!cancelReason.trim() || pendingPath === `/launch/${plan.id}/cancel`}
            >
              Cancel Launch
            </button>
          </div>
          {errorFor(`/launch/${plan.id}/cancel`) && <p className="error-text">{errorFor(`/launch/${plan.id}/cancel`)}</p>}
        </details>
      )}

      <div>
        <h3>Campaign template</h3>
        <p className="muted">
          {templateTypeLabel(plan.templateType)}
          {items.length === 0 ? " — no campaign items yet." : ""}
        </p>
        {items.length === 0 && (
          <>
            <div className="inline-form">
              {LAUNCH_TEMPLATE_TYPES.filter((t) => t !== "CUSTOM").map((t) => (
                <button
                  key={t}
                  className="btn btn-small"
                  onClick={() => onAction(`/launch/${plan.id}/template`, { templateType: t })}
                  disabled={pendingPath === `/launch/${plan.id}/template`}
                >
                  Apply {templateTypeLabel(t)}
                </button>
              ))}
            </div>
            {errorFor(`/launch/${plan.id}/template`) && <p className="error-text">{errorFor(`/launch/${plan.id}/template`)}</p>}
            <p className="muted">Or build a custom campaign by adding items directly below.</p>
          </>
        )}
      </div>

      <div>
        <h3>Target launch date</h3>
        <p className="muted">{plan.targetLaunchDate ? formatDueDate(plan.targetLaunchDate) : "Not set"}</p>
        <div className="inline-form">
          <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
          <button
            className="btn btn-small"
            onClick={() => onAction(`/launch/${plan.id}/target-date`, { targetLaunchDate: targetDate })}
            disabled={!targetDate || pendingPath === `/launch/${plan.id}/target-date`}
          >
            Set Date
          </button>
        </div>
        {errorFor(`/launch/${plan.id}/target-date`) && <p className="error-text">{errorFor(`/launch/${plan.id}/target-date`)}</p>}
      </div>

      <div>
        <h3>Campaign items</h3>
        {items.length === 0 ? (
          <p className="muted">No campaign items yet.</p>
        ) : (
          <ul className="item-list">
            {items.map((item) => {
              const statusPath = `/launch/campaign-items/${item.id}/status`;
              const responsibilityPath = `/launch/campaign-items/${item.id}/responsibility`;
              const vendorCostPath = `/launch/campaign-items/${item.id}/vendor-cost`;
              const evidencePath = `/launch/campaign-items/${item.id}/evidence`;
              const chosenStatus = itemStatusChoice[item.id] ?? item.status;
              return (
                <li key={item.id}>
                  <div>
                    <span className={campaignItemStatusPillClass(item.status)}>{campaignItemStatusLabel(item.status)}</span>{" "}
                    <strong>{item.title}</strong> <span className="muted">({campaignItemTypeLabel(item.itemType)})</span>
                    {item.dueAt && (
                      <span className={isOverdue(item.dueAt) && item.status !== "COMPLETE" ? "pill pill-danger" : "muted"} style={{ marginLeft: "0.5rem" }}>
                        {isOverdue(item.dueAt) && item.status !== "COMPLETE" ? "Overdue " : "Due "}
                        {formatDueDate(item.dueAt)}
                      </span>
                    )}
                  </div>
                  <p className="muted" style={{ marginBottom: "0.4rem" }}>
                    {ownerTypeLabel(item.responsibleOwnerType)}
                    {item.vendorName && ` · ${item.vendorName}`}
                    {item.costCents > 0 && ` · ${formatCents(item.costCents)}`}
                    {item.blockedReason && ` · Blocked: ${item.blockedReason}`}
                  </p>

                  <div className="inline-form">
                    <select value={chosenStatus} onChange={(e) => setItemStatusChoice((prev) => ({ ...prev, [item.id]: e.target.value }))}>
                      {CAMPAIGN_ITEM_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {campaignItemStatusLabel(s)}
                        </option>
                      ))}
                    </select>
                    {chosenStatus === "BLOCKED" && (
                      <input
                        value={itemBlockedReason[item.id] ?? ""}
                        onChange={(e) => setItemBlockedReason((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        placeholder="Reason (required)"
                      />
                    )}
                    <button
                      className="btn btn-small"
                      onClick={() =>
                        onAction(statusPath, {
                          status: chosenStatus,
                          blockedReason: chosenStatus === "BLOCKED" ? (itemBlockedReason[item.id] ?? "").trim() : undefined,
                        })
                      }
                      disabled={
                        chosenStatus === item.status || (chosenStatus === "BLOCKED" && !(itemBlockedReason[item.id] ?? "").trim()) || pendingPath === statusPath
                      }
                    >
                      Update Status
                    </button>
                  </div>
                  {errorFor(statusPath) && <p className="error-text">{errorFor(statusPath)}</p>}

                  <details style={{ marginTop: "0.5rem" }}>
                    <summary className="muted">View Details</summary>

                    <div className="inline-form" style={{ marginTop: "0.5rem" }}>
                      <select
                        value={itemOwnerType[item.id] ?? item.responsibleOwnerType}
                        onChange={(e) => setItemOwnerType((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      >
                        {EXCEPTION_OWNER_TYPES.map((o) => (
                          <option key={o} value={o}>
                            {ownerTypeLabel(o)}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn btn-small"
                        onClick={() => onAction(responsibilityPath, { ownerType: itemOwnerType[item.id] ?? item.responsibleOwnerType, ownerUserId: null })}
                        disabled={pendingPath === responsibilityPath}
                      >
                        Reassign
                      </button>
                    </div>
                    {errorFor(responsibilityPath) && <p className="error-text">{errorFor(responsibilityPath)}</p>}

                    <div className="inline-form" style={{ marginTop: "0.5rem" }}>
                      <input
                        value={itemVendorName[item.id] ?? item.vendorName ?? ""}
                        onChange={(e) => setItemVendorName((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        placeholder="Vendor name"
                      />
                      <input
                        value={itemCostDollars[item.id] ?? (item.costCents ? (item.costCents / 100).toFixed(2) : "")}
                        onChange={(e) => setItemCostDollars((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        placeholder="Cost ($)"
                      />
                      <button
                        className="btn btn-small"
                        onClick={() =>
                          onAction(vendorCostPath, {
                            vendorName: (itemVendorName[item.id] ?? item.vendorName ?? "").trim() || null,
                            costCents: Math.round(Number(itemCostDollars[item.id] ?? (item.costCents / 100).toFixed(2)) * 100),
                          })
                        }
                        disabled={pendingPath === vendorCostPath}
                      >
                        Save Vendor & Cost
                      </button>
                    </div>
                    {errorFor(vendorCostPath) && <p className="error-text">{errorFor(vendorCostPath)}</p>}

                    {item.evidence.length > 0 && (
                      <ul className="plain">
                        {item.evidence.map((e, i) => (
                          <li key={i}>
                            <a href={e.url} target="_blank" rel="noreferrer">
                              {e.label}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="inline-form" style={{ marginTop: "0.5rem" }}>
                      <input
                        value={itemEvidenceLabel[item.id] ?? ""}
                        onChange={(e) => setItemEvidenceLabel((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        placeholder="Evidence label (e.g. Signed brochure proof)"
                      />
                      <input
                        value={itemEvidenceUrl[item.id] ?? ""}
                        onChange={(e) => setItemEvidenceUrl((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        placeholder="URL"
                      />
                      <button
                        className="btn btn-small"
                        onClick={() => {
                          onAction(evidencePath, { label: (itemEvidenceLabel[item.id] ?? "").trim(), url: (itemEvidenceUrl[item.id] ?? "").trim() });
                          setItemEvidenceLabel((prev) => ({ ...prev, [item.id]: "" }));
                          setItemEvidenceUrl((prev) => ({ ...prev, [item.id]: "" }));
                        }}
                        disabled={!(itemEvidenceLabel[item.id] ?? "").trim() || !(itemEvidenceUrl[item.id] ?? "").trim() || pendingPath === evidencePath}
                      >
                        Attach Evidence
                      </button>
                    </div>
                    {errorFor(evidencePath) && <p className="error-text">{errorFor(evidencePath)}</p>}
                  </details>
                </li>
              );
            })}
          </ul>
        )}

        <details style={{ marginTop: "0.5rem" }}>
          <summary className="muted">+ Add campaign item</summary>
          <div className="inline-form" style={{ marginTop: "0.5rem" }}>
            <select value={newItemType} onChange={(e) => setNewItemType(e.target.value as (typeof CAMPAIGN_ITEM_TYPES)[number])}>
              {CAMPAIGN_ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {campaignItemTypeLabel(t)}
                </option>
              ))}
            </select>
            <input value={newItemTitle} onChange={(e) => setNewItemTitle(e.target.value)} placeholder="Title" />
            <button
              className="btn btn-small"
              onClick={() => {
                onAction(`/launch/${plan.id}/campaign-items`, { itemType: newItemType, title: newItemTitle.trim() });
                setNewItemTitle("");
              }}
              disabled={!newItemTitle.trim() || pendingPath === `/launch/${plan.id}/campaign-items`}
            >
              Add Item
            </button>
          </div>
          {errorFor(`/launch/${plan.id}/campaign-items`) && <p className="error-text">{errorFor(`/launch/${plan.id}/campaign-items`)}</p>}
        </details>
      </div>

      <div>
        <h3>Budget</h3>
        <p className={plan.budgetCents > 0 && plan.budgetSpentCents > plan.budgetCents ? "error-text" : "muted"}>
          {formatCents(plan.budgetSpentCents)} spent of {plan.budgetCents > 0 ? formatCents(plan.budgetCents) : "no budget set"}
        </p>
        <div className="inline-form">
          <input value={budgetDollars} onChange={(e) => setBudgetDollars(e.target.value)} placeholder="Budget ($)" />
          <button
            className="btn btn-small"
            onClick={() => onAction(`/launch/${plan.id}/budget`, { budgetCents: Math.round(Number(budgetDollars || "0") * 100) })}
            disabled={!budgetDollars || pendingPath === `/launch/${plan.id}/budget`}
          >
            Set Budget
          </button>
        </div>
        {errorFor(`/launch/${plan.id}/budget`) && <p className="error-text">{errorFor(`/launch/${plan.id}/budget`)}</p>}
        <p className="muted">Setting the budget and deciding an approval both require a Brokerage Administrator.</p>
      </div>

      <div>
        <h3>Vendor & budget approvals</h3>
        {approvals.length === 0 ? (
          <p className="muted">No approvals requested yet.</p>
        ) : (
          <ul className="item-list">
            {approvals.map((a) => {
              const decidePath = `/launch/vendor-approvals/${a.id}/decide`;
              const pendingDecision = a.status === "PENDING" || a.status === "CHANGES_REQUESTED";
              return (
                <li key={a.id}>
                  <div>
                    <span className={vendorApprovalStatusPillClass(a.status)}>{vendorApprovalStatusLabel(a.status)}</span>{" "}
                    <strong>{vendorApprovalTypeLabel(a.approvalType)}</strong> — {formatCents(a.requestedAmountCents)}
                  </div>
                  {a.decisionNotes && <p className="muted">{a.decisionNotes}</p>}
                  {pendingDecision && (
                    <div className="stack">
                      <input
                        value={approvalDecisionAmount[a.id] ?? (a.requestedAmountCents / 100).toFixed(2)}
                        onChange={(e) => setApprovalDecisionAmount((prev) => ({ ...prev, [a.id]: e.target.value }))}
                        placeholder="Approved amount ($)"
                      />
                      <input
                        value={approvalDecisionNotes[a.id] ?? ""}
                        onChange={(e) => setApprovalDecisionNotes((prev) => ({ ...prev, [a.id]: e.target.value }))}
                        placeholder="Decision notes"
                      />
                      <div className="inline-form">
                        <button
                          className="btn btn-small"
                          onClick={() =>
                            onAction(decidePath, {
                              decision: "APPROVED",
                              approvedAmountCents: Math.round(Number(approvalDecisionAmount[a.id] ?? (a.requestedAmountCents / 100).toFixed(2)) * 100),
                              decisionNotes: (approvalDecisionNotes[a.id] ?? "").trim() || null,
                            })
                          }
                          disabled={pendingPath === decidePath}
                        >
                          Approve
                        </button>
                        <button
                          className="btn btn-small"
                          onClick={() => onAction(decidePath, { decision: "CHANGES_REQUESTED", decisionNotes: (approvalDecisionNotes[a.id] ?? "").trim() || null })}
                          disabled={pendingPath === decidePath}
                        >
                          Request Changes
                        </button>
                        <button
                          className="btn btn-small btn-danger"
                          onClick={() => onAction(decidePath, { decision: "REJECTED", decisionNotes: (approvalDecisionNotes[a.id] ?? "").trim() || null })}
                          disabled={pendingPath === decidePath}
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  )}
                  {errorFor(decidePath) && <p className="error-text">{errorFor(decidePath)}</p>}
                </li>
              );
            })}
          </ul>
        )}

        <details style={{ marginTop: "0.5rem" }}>
          <summary className="muted">+ Request an approval</summary>
          <div className="inline-form" style={{ marginTop: "0.5rem" }}>
            <select value={approvalRequestType} onChange={(e) => setApprovalRequestType(e.target.value as (typeof VENDOR_APPROVAL_TYPES)[number])}>
              {VENDOR_APPROVAL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {vendorApprovalTypeLabel(t)}
                </option>
              ))}
            </select>
            {approvalRequestType === "CAMPAIGN_ITEM_COST" && (
              <select value={approvalRequestItem} onChange={(e) => setApprovalRequestItem(e.target.value)}>
                <option value="">Select campaign item…</option>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            )}
            <input value={approvalRequestAmount} onChange={(e) => setApprovalRequestAmount(e.target.value)} placeholder="Amount ($)" />
            <button
              className="btn btn-small"
              onClick={() => {
                onAction(`/launch/${plan.id}/vendor-approvals`, {
                  approvalType: approvalRequestType,
                  campaignItemId: approvalRequestType === "CAMPAIGN_ITEM_COST" ? approvalRequestItem || null : null,
                  requestedAmountCents: Math.round(Number(approvalRequestAmount || "0") * 100),
                });
                setApprovalRequestAmount("");
              }}
              disabled={!approvalRequestAmount || (approvalRequestType === "CAMPAIGN_ITEM_COST" && !approvalRequestItem) || pendingPath === `/launch/${plan.id}/vendor-approvals`}
            >
              Request Approval
            </button>
          </div>
          {errorFor(`/launch/${plan.id}/vendor-approvals`) && <p className="error-text">{errorFor(`/launch/${plan.id}/vendor-approvals`)}</p>}
        </details>
      </div>

      <div>
        <h3>Portal destinations</h3>
        {destinations.length === 0 ? (
          <p className="muted">No portal destinations added yet.</p>
        ) : (
          <ul className="item-list">
            {destinations.map((d) => {
              const submitPath = `/launch/portal-destinations/${d.id}/submit`;
              const failPath = `/launch/portal-destinations/${d.id}/fail`;
              const livePath = `/launch/portal-destinations/${d.id}/live`;
              return (
                <li key={d.id}>
                  <div>
                    <span className={portalStatusPillClass(d.status)}>{portalStatusLabel(d.status)}</span> <strong>{d.portalName}</strong>
                  </div>
                  {d.listingUrl && (
                    <p className="muted">
                      <a href={d.listingUrl} target="_blank" rel="noreferrer">
                        {d.listingUrl}
                      </a>
                    </p>
                  )}
                  {d.failureReason && <p className="muted">Failure: {d.failureReason}</p>}

                  {(d.status === "NOT_STARTED" || d.status === "READY_TO_SUBMIT" || d.status === "FAILED") && (
                    <div className="inline-form">
                      <input
                        value={portalUrlInput[d.id] ?? ""}
                        onChange={(e) => setPortalUrlInput((prev) => ({ ...prev, [d.id]: e.target.value }))}
                        placeholder="Listing URL (optional)"
                      />
                      <button
                        className="btn btn-small"
                        onClick={() => onAction(submitPath, { listingUrl: (portalUrlInput[d.id] ?? "").trim() || undefined })}
                        disabled={pendingPath === submitPath}
                      >
                        Mark Submitted
                      </button>
                    </div>
                  )}
                  {errorFor(submitPath) && <p className="error-text">{errorFor(submitPath)}</p>}

                  {d.status === "SUBMITTED" && (
                    <>
                      <div className="inline-form">
                        <input
                          value={portalUrlInput[d.id] ?? ""}
                          onChange={(e) => setPortalUrlInput((prev) => ({ ...prev, [d.id]: e.target.value }))}
                          placeholder="Listing URL (optional)"
                        />
                        <button
                          className="btn btn-small"
                          onClick={() => onAction(livePath, { listingUrl: (portalUrlInput[d.id] ?? "").trim() || undefined })}
                          disabled={pendingPath === livePath}
                        >
                          Confirm Live
                        </button>
                      </div>
                      {errorFor(livePath) && <p className="error-text">{errorFor(livePath)}</p>}
                      <div className="inline-form">
                        <input
                          value={portalFailReason[d.id] ?? ""}
                          onChange={(e) => setPortalFailReason((prev) => ({ ...prev, [d.id]: e.target.value }))}
                          placeholder="Failure reason (required)"
                        />
                        <button
                          className="btn btn-small btn-danger"
                          onClick={() => {
                            onAction(failPath, { failureReason: (portalFailReason[d.id] ?? "").trim() });
                            setPortalFailReason((prev) => ({ ...prev, [d.id]: "" }));
                          }}
                          disabled={!(portalFailReason[d.id] ?? "").trim() || pendingPath === failPath}
                        >
                          Mark Failed
                        </button>
                      </div>
                      {errorFor(failPath) && <p className="error-text">{errorFor(failPath)}</p>}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="inline-form" style={{ marginTop: "0.5rem" }}>
          <input value={newPortalName} onChange={(e) => setNewPortalName(e.target.value)} placeholder="Portal name (e.g. realestate.com.au)" />
          <button
            className="btn btn-small"
            onClick={() => {
              onAction(`/launch/${plan.id}/portal-destinations`, { portalName: newPortalName.trim() });
              setNewPortalName("");
            }}
            disabled={!newPortalName.trim() || pendingPath === `/launch/${plan.id}/portal-destinations`}
          >
            + Add Portal Destination
          </button>
        </div>
        {errorFor(`/launch/${plan.id}/portal-destinations`) && <p className="error-text">{errorFor(`/launch/${plan.id}/portal-destinations`)}</p>}
      </div>

      <div>
        <h3>Market Ready</h3>
        {marketReady ? (
          <p className="pill pill-success">Ready</p>
        ) : (
          <>
            <p className="muted">Not yet ready:</p>
            <ul className="plain">
              {plan.marketReadyBlockers.map((b, i) => (
                <li key={i} className="muted">
                  {b.message}
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="inline-form">
          <button className="btn btn-small" onClick={() => onAction(`/launch/${plan.id}/market-ready/evaluate`)} disabled={pendingPath === `/launch/${plan.id}/market-ready/evaluate`}>
            Re-evaluate
          </button>
        </div>
        {errorFor(`/launch/${plan.id}/market-ready/evaluate`) && <p className="error-text">{errorFor(`/launch/${plan.id}/market-ready/evaluate`)}</p>}

        {plan.marketReadyOverriddenAt ? (
          <p className="muted">Overridden: {plan.marketReadyOverrideReason}</p>
        ) : (
          !marketReady && (
            <details style={{ marginTop: "0.5rem" }}>
              <summary className="muted">Override Market Ready</summary>
              <div className="inline-form" style={{ marginTop: "0.5rem" }}>
                <input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Reason (required)" />
                <button
                  className="btn btn-small"
                  onClick={() => {
                    onAction(`/launch/${plan.id}/market-ready/override`, { reason: overrideReason.trim() });
                    setOverrideReason("");
                  }}
                  disabled={!overrideReason.trim() || pendingPath === `/launch/${plan.id}/market-ready/override`}
                >
                  Override
                </button>
              </div>
              {errorFor(`/launch/${plan.id}/market-ready/override`) && <p className="error-text">{errorFor(`/launch/${plan.id}/market-ready/override`)}</p>}
            </details>
          )
        )}
      </div>

      {plan.status !== "LISTING_LIVE" && plan.status !== "CANCELLED" && (
        <div>
          <h3>Listing Live</h3>
          <button className="btn btn-primary" onClick={() => onAction(`/launch/${plan.id}/confirm-live`)} disabled={pendingPath === `/launch/${plan.id}/confirm-live`}>
            Confirm Listing Live
          </button>
          {errorFor(`/launch/${plan.id}/confirm-live`) && <p className="error-text">{errorFor(`/launch/${plan.id}/confirm-live`)}</p>}
        </div>
      )}
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
