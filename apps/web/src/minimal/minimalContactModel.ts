import { growContactPath } from "../lib/growWorkspace";

// AE Minimal A Contact 360 view model (local prototype, not wired into any route).
// Reads the existing GET /grow/contacts/:partyId payload and only rearranges it. It invents no field:
// there is no notes column or communication-preference column, so notes are the existing "note" activities and
// consent is NOT summarised here (the existing consent panel stays the only consent surface).

export interface Contact360Input {
  contact: { id: number; displayName: string; email: string | null; mobile: string | null };
  roles: string[];
  properties: { relationshipId: number; propertyId: number | null; propertyAddress: string | null; relationshipType: string; status: string; isPrimary: boolean }[];
  opportunities: { id: number; status: string; stage: string; opportunityType: string }[];
  activities: { id: number; activityType: string; occurredAt: string; summary: string }[];
  intelligence: { nextFollowUpAt: string | null; nextFollowUpDescription: string | null; daysSinceLastInteraction: number | null };
}

export interface MinimalContactModel {
  id: number;
  title: string;
  initials: string;
  path: string;
  roleChips: string[];
  email: string | null;
  mobile: string | null;
  followUp: { label: string; dueAt: string } | null;
  lastTouchLabel: string;
  properties: { key: number; label: string; relationship: string; href: string | null; primary: boolean }[];
  openOpportunityCount: number;
  notes: { id: number; occurredAt: string; text: string }[];
}

const MAX_NOTES = 5;

export function buildMinimalContactModel(input: Contact360Input): MinimalContactModel {
  const name = input.contact.displayName.trim() || "Unnamed contact";
  const days = input.intelligence.daysSinceLastInteraction;
  return {
    id: input.contact.id,
    title: name,
    initials: name.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "?",
    path: growContactPath(input.contact.id),
    roleChips: [...input.roles],
    email: input.contact.email,
    mobile: input.contact.mobile,
    followUp: input.intelligence.nextFollowUpAt
      ? { label: input.intelligence.nextFollowUpDescription ?? "Follow up", dueAt: input.intelligence.nextFollowUpAt }
      : null,
    lastTouchLabel: days == null ? "No interaction recorded" : days === 0 ? "Today" : days === 1 ? "1 day ago" : `${days} days ago`,
    properties: input.properties
      .filter((p) => p.status === "Active")
      .map((p) => ({
        key: p.relationshipId,
        label: p.propertyAddress ?? "Not linked to a property",
        relationship: p.relationshipType,
        href: p.propertyId == null ? null : `/properties/${p.propertyId}`,
        primary: p.isPrimary,
      })),
    openOpportunityCount: input.opportunities.filter((o) => o.status === "Open").length,
    notes: input.activities
      .filter((a) => a.activityType === "note")
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, MAX_NOTES)
      .map((a) => ({ id: a.id, occurredAt: a.occurredAt, text: a.summary })),
  };
}
