// Agent Engine 2.0 — Property Launch & Campaign Coordination, frontend.
//
// Shared types + display helpers for the Launch panel in
// PropertyWorkspace.tsx, mirroring lib/riskExceptions.ts's own structure
// and header-comment convention exactly: hand-copied from the backend's
// enums/types (packages/db/src/schema/launch.ts,
// apps/api/src/lib/launch/types.ts) and kept in sync with those by hand,
// since the frontend doesn't share a package with the backend. Owner-type
// vocabulary is deliberately NOT re-declared here — Launch reuses
// RISK_EXCEPTION_OWNER_TYPES verbatim (as LAUNCH_OWNER_TYPES) on the
// backend, so the frontend reuses lib/riskExceptions.ts's own
// EXCEPTION_OWNER_TYPES/ownerTypeLabel rather than hand-copying a second
// mirror of the same four values.

export interface MarketReadyBlocker {
  code: string;
  // Server-generated, human-readable already — the UI renders this
  // directly rather than re-deriving copy per blocker code (mirrors how
  // riskExceptions.ts's RiskExceptionRow.problemDescription is rendered
  // as-is, not re-templated client-side).
  message: string;
  refs?: Array<{ recordType: string; recordId: string }>;
}

export interface LaunchPlanRow {
  id: string;
  brokerageId: number;
  propertyId: number;
  workflowId: number | null;
  templateType: string;
  status: string;
  targetLaunchDate: string | null;
  actualLaunchDate: string | null;
  budgetCents: number;
  budgetSpentCents: number;
  budgetSetAt: string | null;
  budgetSetBy: number | null;
  marketReadyEvaluatedAt: string | null;
  marketReadyBlockers: MarketReadyBlocker[];
  marketReadyOverriddenAt: string | null;
  marketReadyOverriddenBy: number | null;
  marketReadyOverrideReason: string | null;
  listingLiveConfirmedAt: string | null;
  listingLiveConfirmedBy: number | null;
  pausedAt: string | null;
  pausedBy: number | null;
  pauseReason: string | null;
  cancelledAt: string | null;
  cancelledBy: number | null;
  cancelReason: string | null;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignItemEvidenceRef {
  label: string;
  url: string;
  attachedAt: string;
  attachedByUserId: number;
}

export interface CampaignItemRow {
  id: string;
  launchPlanId: string;
  propertyId: number;
  brokerageId: number;
  itemType: string;
  title: string;
  description: string | null;
  status: string;
  responsibleOwnerType: string;
  responsibleUserId: number | null;
  vendorName: string | null;
  costCents: number;
  costApprovalRequired: boolean;
  costApprovedAt: string | null;
  costApprovedBy: number | null;
  leadDays: number | null;
  dueAt: string | null;
  completedAt: string | null;
  blockedAt: string | null;
  blockedReason: string | null;
  evidence: CampaignItemEvidenceRef[];
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface PortalDestinationRow {
  id: string;
  launchPlanId: string;
  propertyId: number;
  brokerageId: number;
  portalName: string;
  status: string;
  submittedAt: string | null;
  submittedBy: number | null;
  liveConfirmedAt: string | null;
  liveConfirmedBy: number | null;
  failureReason: string | null;
  listingUrl: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VendorApprovalRow {
  id: string;
  launchPlanId: string;
  campaignItemId: string | null;
  propertyId: number;
  brokerageId: number;
  approvalType: string;
  requestedAmountCents: number;
  approvedAmountCents: number | null;
  status: string;
  requestedBy: number;
  requestedAt: string;
  decidedBy: number | null;
  decidedAt: string | null;
  decisionNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LaunchPlanDetail {
  plan: LaunchPlanRow;
  items: CampaignItemRow[];
  destinations: PortalDestinationRow[];
  approvals: VendorApprovalRow[];
}

export interface PropertyLaunchResponse {
  launch: LaunchPlanDetail | null;
}

// Mirrors packages/db/src/schema/launch.ts's own enum tuples exactly.
export const LAUNCH_TEMPLATE_TYPES = ["STANDARD_PRIVATE_TREATY", "AUCTION", "OFF_MARKET", "CUSTOM"] as const;
export const LAUNCH_PLAN_STATUSES = [
  "PLANNING",
  "CAMPAIGN_PRODUCTION",
  "VENDOR_APPROVAL",
  "MARKET_READY",
  "PORTAL_SUBMISSION",
  "LISTING_LIVE",
  "PAUSED",
  "CANCELLED",
] as const;
export const CAMPAIGN_ITEM_TYPES = ["PHOTOGRAPHY", "FLOOR_PLAN", "COPYWRITING", "SIGNAGE", "BROCHURE", "DIGITAL_AD", "SOCIAL_MEDIA", "VIDEO", "OTHER"] as const;
export const CAMPAIGN_ITEM_STATUSES = ["TO_ORGANISE", "IN_PROGRESS", "AWAITING_APPROVAL", "BLOCKED", "COMPLETE"] as const;
export const VENDOR_APPROVAL_TYPES = ["BUDGET", "VENDOR_SELECTION", "CAMPAIGN_ITEM_COST"] as const;
export const VENDOR_APPROVAL_DECISIONS = ["APPROVED", "REJECTED", "CHANGES_REQUESTED"] as const;

// Any campaign item costing at or above this threshold requires a formal
// vendor approval before Market Ready can pass — mirrors
// apps/api/src/lib/launch/types.ts's LAUNCH_VENDOR_APPROVAL_THRESHOLD_CENTS
// exactly, used here only to hint the "+ Add campaign item" cost field,
// never to gate anything client-side (the server is the sole authority).
export const LAUNCH_VENDOR_APPROVAL_THRESHOLD_CENTS = 50_000;

export function launchStatusLabel(status: string): string {
  switch (status) {
    case "PLANNING":
      return "Planning";
    case "CAMPAIGN_PRODUCTION":
      return "Campaign Production";
    case "VENDOR_APPROVAL":
      return "Vendor Approval";
    case "MARKET_READY":
      return "Market Ready";
    case "PORTAL_SUBMISSION":
      return "Portal Submission";
    case "LISTING_LIVE":
      return "Listing Live";
    case "PAUSED":
      return "Paused";
    case "CANCELLED":
      return "Cancelled";
    default:
      return status;
  }
}

// Same "only three tones, told apart by label text" rule riskExceptions.ts
// documents (see severityPillClass there) — Listing Live is the one clean
// success state, Paused/Cancelled both read as a caution, everything else
// (the in-flight stages) is a plain default pill.
export function launchStatusPillClass(status: string): string {
  if (status === "LISTING_LIVE") return "pill pill-success";
  if (status === "PAUSED" || status === "CANCELLED") return "pill pill-warning";
  return "pill";
}

export function templateTypeLabel(templateType: string): string {
  switch (templateType) {
    case "STANDARD_PRIVATE_TREATY":
      return "Standard Private Treaty";
    case "AUCTION":
      return "Auction";
    case "OFF_MARKET":
      return "Off Market";
    case "CUSTOM":
      return "Custom";
    default:
      return templateType;
  }
}

export function campaignItemTypeLabel(itemType: string): string {
  switch (itemType) {
    case "PHOTOGRAPHY":
      return "Photography";
    case "FLOOR_PLAN":
      return "Floor Plan";
    case "COPYWRITING":
      return "Copywriting";
    case "SIGNAGE":
      return "Signage";
    case "BROCHURE":
      return "Brochure";
    case "DIGITAL_AD":
      return "Digital Ad";
    case "SOCIAL_MEDIA":
      return "Social Media";
    case "VIDEO":
      return "Video";
    case "OTHER":
      return "Other";
    default:
      return itemType;
  }
}

export function campaignItemStatusLabel(status: string): string {
  switch (status) {
    case "TO_ORGANISE":
      return "To Organise";
    case "IN_PROGRESS":
      return "In Progress";
    case "AWAITING_APPROVAL":
      return "Awaiting Approval";
    case "BLOCKED":
      return "Blocked";
    case "COMPLETE":
      return "Complete";
    default:
      return status;
  }
}

export function campaignItemStatusPillClass(status: string): string {
  if (status === "COMPLETE") return "pill pill-success";
  if (status === "BLOCKED") return "pill pill-danger";
  if (status === "AWAITING_APPROVAL") return "pill pill-warning";
  return "pill";
}

export function portalStatusLabel(status: string): string {
  switch (status) {
    case "NOT_STARTED":
      return "Not Started";
    case "READY_TO_SUBMIT":
      return "Ready to Submit";
    case "SUBMITTED":
      return "Submitted";
    case "LIVE":
      return "Live";
    case "FAILED":
      return "Failed";
    case "WITHDRAWN":
      return "Withdrawn";
    default:
      return status;
  }
}

export function portalStatusPillClass(status: string): string {
  if (status === "LIVE") return "pill pill-success";
  if (status === "FAILED") return "pill pill-danger";
  if (status === "SUBMITTED") return "pill pill-warning";
  return "pill";
}

export function vendorApprovalTypeLabel(approvalType: string): string {
  switch (approvalType) {
    case "BUDGET":
      return "Budget";
    case "VENDOR_SELECTION":
      return "Vendor Selection";
    case "CAMPAIGN_ITEM_COST":
      return "Campaign Item Cost";
    default:
      return approvalType;
  }
}

export function vendorApprovalStatusLabel(status: string): string {
  switch (status) {
    case "PENDING":
      return "Pending";
    case "APPROVED":
      return "Approved";
    case "REJECTED":
      return "Rejected";
    case "CHANGES_REQUESTED":
      return "Changes Requested";
    default:
      return status;
  }
}

export function vendorApprovalStatusPillClass(status: string): string {
  if (status === "APPROVED") return "pill pill-success";
  if (status === "REJECTED") return "pill pill-danger";
  if (status === "CHANGES_REQUESTED") return "pill pill-warning";
  return "pill";
}
