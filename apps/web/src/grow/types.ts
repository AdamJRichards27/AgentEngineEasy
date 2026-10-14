// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

import type { GrowContactability } from "../lib/contactability";
import type { GrowTodayAction } from "../lib/growToday";
import type { GrowOpportunityManualStage } from "@aee/domain";

export interface GrowAccess {
  entitled: boolean;
  entitlements: string[];
  billingProviderName: string;
}
export interface GrowRelationship {
  id: number;
  relationshipType: string;
  role: string | null;
  status: string;
  isPrimary: boolean;
  partyFirstName: string | null;
  partyLastName: string | null;
  partyOrganisationName: string | null;
  propertyAddress: string;
}
export interface GrowActivity {
  id: number;
  activityType: string;
  occurredAt: string;
  summary: string;
}
// Hand-mirrors the row GET /grow/opportunities returns — that route selects the
// whole grow_opportunities row (apps/api/src/routes/grow.ts:383-391), so every
// field below already came down the wire; the previous four-field declaration
// was simply reading less of it than it received.
//
// AE GROW Completion W2-B (E-3): partyId / propertyId / recommendedNextAction /
// nextActionDueAt are read now because the Opportunities tab needs them to be
// something other than a dead end. partyId is NOT NULL and propertyId IS
// nullable in packages/db/src/schema/grow.ts:236-237; `reason` is nullable there
// too, which this mirror previously declared as `string` and rendered as an
// empty cell.
export interface GrowOpportunity {
  id: number;
  opportunityType: string;
  status: string;
  stage: string;
  reason: string | null;
  /** Set when the opportunity was marked Lost. Already on GET /grow/opportunities. */
  lostReason?: string | null;
  partyId: number;
  propertyId: number | null;
  recommendedNextAction: string | null;
  nextActionDueAt: string | null;
  /** Same-brokerage contact name from GET /grow/opportunities. Null when the party join misses. */
  contactName?: string | null;
}
// AE GROW Priority 2 — Contact Intelligence & Relationship Timeline, frontend types.
// Mirrors apps/api/src/routes/contacts.ts's response shape and
// apps/api/src/lib/{relationshipTimeline,contactIntelligence}.ts by hand — same convention
// lib/growToday.ts already established for Priority 1 (the web app doesn't share a package
// with the API). GROW_CONTACT_ROLES / GROW_CONTACT_RELATIONSHIP_TYPES mirror the same-named
// arrays in packages/db/src/schema/contacts.ts; if those ever change, this list needs a
// matching hand-edit (documented here so that dependency is visible).

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
export type GrowContactListPage = {
  contacts: GrowContactListItem[];
  nextCursor?: string | null;
  total?: number;
};
export type GrowRelationshipListPage = {
  relationships: GrowRelationship[];
  nextCursor?: string | null;
  total?: number;
};
export type GrowActivityListPage = {
  activities: GrowActivity[];
  nextCursor?: string | null;
  total?: number;
};
export type GrowOpportunityListPage = {
  opportunities: GrowOpportunity[];
  nextCursor?: string | null;
  total?: number;
};
interface GrowContact360HouseholdRelationship {
  id: number;
  relatedPartyId: number;
  relatedPartyDisplayName: string;
  relationshipType: string;
  note: string | null;
  createdAt: string;
}
interface GrowContact360Property {
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
interface GrowContact360Activity {
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
interface GrowTimelineEvent {
  id: string;
  type: string;
  occurredAt: string;
  summary: string;
  propertyId: number | null;
  propertyLabel: string | null;
  opportunityId: number | null;
}
interface ContactIntelligenceSummary {
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
type CallEligibilityStatus =
  | "Ready to call"
  | "Consent needs review"
  | "Do Not Call check required"
  | "Calling unavailable at this time";
export interface GrowCallFiveGateResult {
  evaluatedAt: string;
  permitted: boolean;
  allPassed: boolean;
  gates: {
    entitlement: { passed: boolean; entitlementKey: string; reason: string; humanReason: string };
    legalPolicy: {
      passed: boolean;
      jurisdiction: string | null;
      policyVersion: string | null;
      reason: string;
      humanReason: string;
    };
    legacyConsentAndDisclosure: {
      passed: boolean;
      consentId: number | null;
      consentJurisdiction: string | null;
      disclosedInCall: boolean;
      confirmedInCall: boolean;
      reason: string;
      humanReason: string;
    };
    adapterCapability: { passed: boolean; provider: string; reason: string; humanReason: string };
    operationalApproval: { passed: boolean; flag: string; reason: string; humanReason: string };
  };
  outboundDecisionId: number | null;
  outboundReasonCode: string | null;
}
export interface GrowCallEligibility {
  eligible: boolean;
  status: CallEligibilityStatus;
  eligibilityStatus?: CallEligibilityStatus;
  reason: string;
  displayNumber: string | null;
  requiresCountryConfirmation: boolean;
  consentDecisionId?: number | null;
  recording: {
    available: boolean;
    permitted: boolean;
    status: "Recording not permitted" | "Recording available";
    statusCode: string;
    reason: string;
    provider: string;
    fiveGateResult: GrowCallFiveGateResult;
  };
}
export interface GrowCallSession {
  id: number;
  partyId: number;
  destinationRaw: string;
  destinationNormalized: string;
  destinationCountry: string;
  provider: string;
  providerCallId: string | null;
  status: string;
  recordingRequested: boolean;
  recordingPermitted: boolean;
  recordingStatus: string;
  confirmedAt: string | null;
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  failureReason: string | null;
  cancelledReason: string | null;
}
export interface GrowCallSessionRead {
  callSession: GrowCallSession;
  recording: {
    available: boolean;
    permitted: boolean;
    status: "Recording not permitted" | "Recording available";
    statusCode: string;
    provider: string;
    fiveGateResult: GrowCallFiveGateResult;
  };
}
export const TERMINAL_CALL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
// ── Follow-ups on an opportunity (AE GROW Completion W2-B, E-3) ───────────
//
// PATCH /grow/opportunities/:id is the one write behind "Create follow-up".
// Grow Today's action card has offered it since Priority 1; the Opportunities
// tab and Contact 360's opportunities table offered nothing at all, so the SAME
// opportunity record was actionable on one screen and inert on the other two.
//
// The fix is deliberately not a second mutation. This hook and
// GrowNextActionForm below are the Today card's own mutation and form, lifted
// out unchanged in behaviour (same route, same method, same body shape, same
// "at least one field or don't submit" rule), and all three surfaces now call
// them. There is exactly one definition of what creating a follow-up means.

export interface GrowNextActionInput {
  nextActionDueAt?: string;
  recommendedNextAction?: string;
}
export type GrowOpportunityLifecycleInput =
  | { stage: GrowOpportunityManualStage }
  | { status: "Lost"; lostReason: string }
  | { status: "Closed" };
// PATCH /grow/contacts/commitments/:id is the one write behind Complete,
// Cancel, and Reschedule. A status change sends { status }. A reschedule
// sends { dueAt } alone — the route rejects a body that names both. Grow
// Today and Contact 360 share this hook so the two surfaces cannot drift.
export type GrowCommitmentPatch =
  | { id: number; status: "Completed" | "Cancelled" }
  | { id: number; dueAt: string };
export interface GrowActionCardProps {
  item: GrowTodayAction;
  canAddNote: boolean;
  canManageOpportunities: boolean;
  canViewContacts: boolean;
  // AE GROW Priority 3 §4.
  canManageContactComms: boolean;
  onAskAE: () => void;
  onViewContact: (partyId: number) => void;
  onEmailContact: (partyId: number) => void;
  onSmsContact: (partyId: number) => void;
}
export type NewContactNotice =
  | { kind: "created"; contactId: number }
  | { kind: "duplicate"; contactId: number }
  | { kind: "error"; message: string };
export interface NewOpportunityInput {
  partyId: number;
  opportunityType: string;
  reason: string;
  propertyId?: number;
}
export const GROW_LIST_SEARCH_DEBOUNCE_MS = 300;
