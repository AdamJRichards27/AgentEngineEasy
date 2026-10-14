// Moved unchanged from PropertyWorkspace.tsx so a later shell can reuse this panel.

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
export interface PartyLink {
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
export interface ServiceOrderBlock {
  id: number;
  propertyId: number;
  serviceType: string;
  provider: string;
  customerPriceCents: number;
  gstCents: number;
  paymentStatus: string;
  status: string;
}
export interface PaymentMethodBlock {
  id: number;
  payerType: string;
  payerId: number;
  provider: string;
  label: string | null;
  isDefault: boolean;
}
export interface PaymentBlock {
  id: number;
  status: string;
  amountCents: number;
  receiptUrl: string | null;
  failureReason: string | null;
}
export interface OfferBlock {
  id: number;
  propertyId: number;
  buyerPartyId: number | null;
  offerPriceCents: number;
  status: string;
  shareToken: string | null;
  createdAt: string;
}
export interface TransactionBlock {
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
export interface TimelineItem {
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
export interface ConditionBlock {
  id: number;
  transactionId: number;
  description: string;
  dueDate: string | null;
  status: string;
  notes: string | null;
  resolvedAt: string | null;
}
// #122 — agent-facing WAE task/attention-item visibility.
export interface AutomationTaskBlock {
  id: string;
  kind: "TASK" | "REMINDER";
  title: string;
  detail: string | null;
  assignedRole: string | null;
  dueAt: string | null;
  status: string;
}
export interface AttentionItemBlock {
  id: string;
  reasonCode: string;
  detail: string | null;
  status: string;
}
export interface WorkspaceResponse {
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
export const ROLES = ["Seller", "Buyer", "Solicitor", "PowerOfAttorney", "Other"] as const;
export const PARTY_TYPES = ["Person", "Organisation", "Trust", "Estate", "Other"] as const;
export function partyName(p: PartyLink["party"]): string {
  if (!p) return "—";
  return p.organisationName || `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || "—";
}
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return isToday ? `Today ${time}` : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}
// Clean, agent-facing AML status copy (staging brief's AML Status UX) —
// never the raw provider outcome/status string.
export function amlStatusCopy(status: string): string {
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
export function amlPillClass(status: string): string {
  if (status === "Complete") return "pill pill-success";
  if (status === "Review Required" || status === "Failed") return "pill pill-danger";
  return "pill";
}
// Clean document status copy (staging brief's Document UX) — Draft/Generated
// are implementation detail, not something an agent needs to parse.
export function documentStatusCopy(status: string): string {
  if (status === "Signed") return "Signed";
  if (status === "Generated") return "Ready";
  return "Preparing";
}
// #131-#134 — Timeline category pill. Compliance carries the redacted
// financial milestones (commission/funds/agent-paid) alongside payment
// audit entries, so it gets the same warning tone the rest of the app
// already uses for "needs attention" (amlPillClass, above) rather than a
// plain default pill.
export function timelineCategoryPillClass(category: TimelineItem["category"]): string {
  if (category === "Compliance") return "pill pill-warning";
  if (category === "Offer" || category === "Transaction") return "pill pill-success";
  return "pill";
}
