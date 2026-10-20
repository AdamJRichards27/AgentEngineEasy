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
