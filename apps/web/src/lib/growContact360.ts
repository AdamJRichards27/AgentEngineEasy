// Contact 360 payload types for GET /grow/contacts/:partyId. Pure type module (moved verbatim from pages/Grow.tsx).
// Shared by the classic Grow page and the AE Minimal Contact 360 view.
import type { GrowContactability } from "./contactability";


export interface GrowContact360HouseholdRelationship {
  id: number;
  relatedPartyId: number;
  relatedPartyDisplayName: string;
  relationshipType: string;
  note: string | null;
  createdAt: string;
}

export interface GrowContact360Property {
  relationshipId: number;
  propertyId: number | null;
  propertyAddress: string | null;
  relationshipType: string;
  role: string | null;
  status: string;
  isPrimary: boolean;
  validFrom: string;
  validTo: string | null;
}

export interface GrowContact360Opportunity {
  id: number;
  opportunityType: string;
  status: string;
  stage: string;
  reason: string | null;
  /** Present on Contact 360 once the contact read includes the stored lost reason. */
  lostReason?: string | null;
  nextActionDueAt: string | null;
  recommendedNextAction: string | null;
  propertyId: number | null;
}

export interface GrowContact360Activity {
  id: number;
  activityType: string;
  occurredAt: string;
  summary: string;
  propertyId: number | null;
  opportunityId: number | null;
}

export interface GrowContact360Commitment {
  id: number;
  description: string;
  dueAt: string;
  status: string;
  propertyId: number | null;
  opportunityId: number | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export interface GrowTimelineEvent {
  id: string;
  type: string;
  occurredAt: string;
  summary: string;
  propertyId: number | null;
  propertyLabel: string | null;
  opportunityId: number | null;
}

export interface ContactIntelligenceSummary {
  roles: string[];
  relatedPropertyCount: number;
  mostRecentInteractionAt: string | null;
  daysSinceLastInteraction: number | null;
  nextFollowUpAt: string | null;
  nextFollowUpDescription: string | null;
  activeOpportunityCount: number;
  recentActivityCount: number;
  outstandingCommitmentCount: number;
  relationshipAgeDays: number | null;
}

export interface GrowContact360 {
  contact: {
    id: number;
    partyType: string;
    firstName: string | null;
    middleName: string | null;
    lastName: string | null;
    organisationName: string | null;
    displayName: string;
    email: string | null;
    mobile: string | null;
    residentialAddress: string | null;
    createdAt: string;
    updatedAt: string;
  };
  assignedAgentUserId: number | null;
  roles: string[];
  householdRelationships: GrowContact360HouseholdRelationship[];
  properties: GrowContact360Property[];
  opportunities: GrowContact360Opportunity[];
  activities: GrowContact360Activity[];
  commitments: GrowContact360Commitment[];
  timeline: GrowTimelineEvent[];
  intelligence: ContactIntelligenceSummary;
  // AE GROW Completion W3-A (A-6) — consent/DNC/suppression read model. Its
  // own shape is hand-mirrored in lib/contactability.ts, alongside the display
  // rules, rather than restated here.
  contactability: GrowContactability;
}

/** Open lifecycle: still Open and not at a terminal stage. (Moved verbatim from pages/Grow.tsx.) */
export function opportunityLifecycleOpen(status: string, stage: string): boolean {
  return status === "Open" && stage !== "Lost" && stage !== "Converted";
}

/** Status cell for a Lost row names the stored lost reason. Other statuses stay as they are. */
export function opportunityStatusLabel(status: string, lostReason: string | null | undefined): string {
  if (status !== "Lost") return status;
  const reason = typeof lostReason === "string" ? lostReason.trim() : "";
  return reason.length > 0 ? `Lost: ${reason}` : "Lost";
}

// Property-link options and list/property shapes shared by Grow and Contact 360 forms (moved verbatim from pages/Grow.tsx, PR4).
// Hand-mirror of GROW_RELATIONSHIP_TYPES (packages/db/src/schema/grow.ts).
// These are property links (POST /grow/relationships). They are not the
// household types above (POST /grow/contacts/:partyId/relationships).
export const GROW_PROPERTY_RELATIONSHIP_OPTIONS = [
  ["owner", "Owner"],
  ["co_owner", "Co-owner"],
  ["former_owner", "Former owner"],
  ["occupier", "Occupier"],
  ["tenant", "Tenant"],
  ["landlord", "Landlord"],
  ["buyer", "Buyer"],
  ["prospective_buyer", "Prospective buyer"],
  ["seller", "Seller"],
  ["prospective_seller", "Future seller"],
  ["appraisal_contact", "Appraisal contact"],
  ["vendor", "Vendor"],
  ["investor", "Investor"],
  ["developer", "Developer"],
  ["referrer", "Referrer"],
  ["related_party", "Related party"],
  ["unknown_pending_review", "Unknown, pending review"],
] as const;

export interface LinkableProperty {
  id: number;
  formattedAddress: string;
}

export interface GrowContactListItem {
  id: number;
  displayName: string;
  partyType: string;
  email: string | null;
  mobile: string | null;
  roles: string[];
  relatedPropertyCount: number;
}

export interface GrowAccess {
  entitled: boolean;
  entitlements: string[];
  billingProviderName: string;
}

export function growActivityTypeLabel(activityType: string): string {
  if (activityType === "call_summary") return "Call summary";
  return activityType.replace(/_/g, " ");
}

export const GROW_CONTACT_ROLES = [
  "Prospect",
  "PastClient",
  "CurrentClient",
  "Seller",
  "Buyer",
  "Landlord",
  "Tenant",
  "Investor",
  "PropertyOwner",
  "AppraisalProspect",
  "ReferralSource",
  "ProfessionalPartner",
  "Other",
] as const;

export const GROW_CONTACT_RELATIONSHIP_TYPES = [
  "spouse_partner",
  "family",
  "co_owner",
  "business_partner",
  "related_contact",
  "other",
] as const;

export type GrowContactListPage = {
  contacts: GrowContactListItem[];
  nextCursor?: string | null;
  total?: number;
};

// PATCH /grow/contacts/commitments/:id is the one write behind Complete,
// Cancel, and Reschedule. A status change sends { status }. A reschedule
// sends { dueAt } alone — the route rejects a body that names both. Grow
// Today and Contact 360 share this hook so the two surfaces cannot drift.
export type GrowCommitmentPatch =
  | { id: number; status: "Completed" | "Cancelled" }
  | { id: number; dueAt: string };
