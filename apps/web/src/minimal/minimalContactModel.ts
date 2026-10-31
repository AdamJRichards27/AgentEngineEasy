import { contactabilityHeadline, type GrowContactability } from "../lib/contactability";
import type {
  GrowContact360,
  GrowContact360Activity,
  GrowContact360Opportunity,
  GrowContact360Property,
} from "../lib/growContact360";
import { growContactPath } from "../lib/growWorkspace";

// AE Minimal A Contact 360 view model.
// Reads the existing GET /grow/contacts/:partyId payload and only rearranges it. It invents no field:
// there is no notes column or communication-preference column, so notes are the existing "note" activities and
// consent is only the existing contactabilityHeadline wording, read-only (the classic consent panel stays the only place to change it).

export type Contact360Input = Pick<GrowContact360, "roles"> & {
  contact: Pick<GrowContact360["contact"], "id" | "displayName" | "email" | "mobile">;
  properties: Pick<
    GrowContact360Property,
    "relationshipId" | "propertyId" | "propertyAddress" | "relationshipType" | "status" | "isPrimary"
  >[];
  opportunities: Pick<GrowContact360Opportunity, "id" | "status" | "stage" | "opportunityType">[];
  activities: Pick<GrowContact360Activity, "id" | "activityType" | "occurredAt" | "summary">[];
  intelligence: Pick<
    GrowContact360["intelligence"],
    "nextFollowUpAt" | "nextFollowUpDescription" | "daysSinceLastInteraction"
  >;
  /** Optional so a payload without it renders no consent line (never an invented one). */
  contactability?: GrowContactability | null;
};

/** The classic detail keeps this URL; "?view=full" is the explicit way back to it from the Minimal view. */
export const CONTACT360_FULL_VIEW_QUERY = "view=full";

export function selectContact360View(minimalShell: boolean, search: string): "minimal" | "classic" {
  if (!minimalShell) return "classic";
  const params = new URLSearchParams(search);
  return params.get("view") === "full" ? "classic" : "minimal";
}

/** Fixed en-AU (e.g. "25 Oct 2026") so the date never depends on the browser locale (headless/US browsers showed 10/25/2026). */
export function formatContactDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "Unknown date" : new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(d);
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
  /** Read-only restatement of the server's contactability headline, or null when the payload has none. */
  consent: { status: string; label: string; detail: string } | null;
  /** Classic detail with every action and the editable consent panel. */
  fullViewPath: string;
}

const MAX_NOTES = 5;

/** Owner D5: property links open the Run workspace, so they need run.access. Default fails closed. */
export function buildMinimalContactModel(input: Contact360Input, opts: { runAccess?: boolean } = {}): MinimalContactModel {
  const runAccess = opts.runAccess === true;
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
        href: p.propertyId == null || !runAccess ? null : `/properties/${p.propertyId}`,
        primary: p.isPrimary,
      })),
    openOpportunityCount: input.opportunities.filter((o) => o.status === "Open").length,
    notes: input.activities
      .filter((a) => a.activityType === "note")
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, MAX_NOTES)
      .map((a) => ({ id: a.id, occurredAt: a.occurredAt, text: a.summary })),
    consent: input.contactability
      ? (() => {
          const h = contactabilityHeadline(input.contactability);
          return { status: h.status, label: h.label, detail: h.detail };
        })()
      : null,
    fullViewPath: `${growContactPath(input.contact.id)}?${CONTACT360_FULL_VIEW_QUERY}`,
  };
}
