import type { GrowContact360, GrowContact360Commitment, GrowTimelineEvent } from "../../lib/growContact360";
import { callPlan, numbersOf, type CallPlan } from "./mobileCalling";
import { growContactPath } from "../../lib/growWorkspace";
import { CONTACT360_FULL_VIEW_QUERY, formatContactDate } from "../minimalContactModel";
import { roleLabel } from "./mobileLabels";
import { propertyResultHref } from "./mobileSearchModel";
import { linkRoleLabel, type CanonicalContactLink } from "./mobileLinking";
import { buildGrowInterest, growRelationshipText, type GrowInterestRow } from "../../lib/growInterest";
import { HISTORY_VISIBLE, PROPERTY_RELATIONSHIP_LABELS } from "./mobilePeopleConfig";

// AE Mobile (CC Task #64, M4): the phone Contact 360 layout, as one pure function. No React, no network, no
// storage. It reads the payload the existing Contact 360 already reads (GET /grow/contacts/:partyId) and
// arranges it for a phone: who they are, how to call them, the one obvious next step, what is promised,
// where they are linked, and what has happened. It adds no data and no endpoint, and it does not change
// the payload. Anything the phone cannot do with a verified route is a link to the full record.

export type MobileCall = CallPlan;

export type MobileNextStepKind = "commitment" | "opportunity" | "follow-up" | "none";

export interface MobileNextStep {
  kind: MobileNextStepKind;
  title: string;
  detail: string | null;
  /** "Overdue", or the date. Null when there is none. */
  when: string | null;
  overdue: boolean;
  commitmentId: number | null;
  /** The one button for this step. Null when this user has no verified action to offer. */
  primary: { kind: "complete" | "add-commitment" | "full-record"; label: string } | null;
  /** A second, quieter button. Only a commitment can be rescheduled from the phone. */
  secondary: { kind: "reschedule"; label: string } | null;
}

export interface MobileCommitmentRow {
  id: number;
  text: string;
  dueText: string;
  overdue: boolean;
  /** The property it relates to, when one is linked. */
  context: string | null;
}

export interface MobilePropertyLink {
  /** The canonical link id (property_parties) when the row is canonical; otherwise the legacy relationship id, for the list key only. */
  key: number;
  label: string;
  /** "Co-owner", or "Related party · Executor" (legacy); "Seller" (canonical). Never the raw stored value. */
  relationship: string;
  /** The legacy free-text role on its own, or null. Canonical rows carry roleValue instead. */
  role: string | null;
  /** The canonical role (property_parties.role), or null for a legacy row. */
  roleValue: string | null;
  primary: boolean;
  /** The property page, one tap. Null when the link names no property. */
  href: string | null;
  /** True when the row came from property_parties, so a role change or unlink can act on it. A legacy row is display only. */
  canonical: boolean;
  propertyId: number | null;
}

export interface MobileHistoryRow {
  id: string;
  kind: string;
  when: string;
  text: string;
  context: string | null;
}

export interface MobileContactLayout {
  id: number;
  name: string;
  initials: string;
  roleChips: string[];
  call: MobileCall;
  email: string | null;
  nextStep: MobileNextStep;
  /** Open commitments other than the one already shown as the next step, overdue first. */
  commitments: MobileCommitmentRow[];
  /** Every open commitment, the next step included. */
  openCommitmentCount: number;
  closedCommitmentCount: number;
  properties: MobilePropertyLink[];
  /**
   * "legacy": the canonical read is OFF (as shipped); `properties` is the payload's Active Grow links, exactly as before, and there is no interest list.
   * "loading" / "error" / "ready": the canonical read is ON; `properties` is property_parties only.
   */
  propertiesState: "legacy" | "loading" | "error" | "ready";
  /** A plain sentence when the Properties list shows less than there is, or could not be loaded. Null otherwise. */
  propertiesNotice: string | null;
  /** Grow interest & history: Grow's records that are not current property links (only when `propertiesState` is "ready"). */
  interest: GrowInterestRow[];
  /**
   * The two counts, SEPARATE and never added together: the canonical property count (the server's total when it gave one, else the rows shown;
   * null until the canonical list is ready) and the number of Grow rows listed.
   */
  propertiesCount: number | null;
  interestCount: number;
  history: MobileHistoryRow[];
  historyHiddenCount: number;
  fullRecordHref: string;
  /** What this user may do with a verified route. All false without grow.activities.manage. */
  canLog: boolean;
}

export interface MobileContactOptions {
  now: Date;
  /** grow.activities.manage: may add notes, log calls, add and update commitments. */
  canLog: boolean;
  expandedHistory?: boolean;
  /**
   * The contact's property links from property_parties (GET /parties/by-contact/:id), once the backend supports it. When given they ARE
   * the property list, and the Grow-table links in the contact payload are not shown: the two are never merged. Null or omitted: the
   * payload's links are shown as they come, read-only.
   */
  canonicalLinks?: readonly CanonicalContactLink[] | null;
  /** The canonical read is ON and the response is not here yet / failed. Ignored when `canonicalLinks` is given. */
  canonicalStatus?: "loading" | "error" | null;
  /** What the by-contact response said about itself (truncated, total, unreadable rows). */
  canonicalMeta?: { truncated: boolean; total: number | null; skipped: number } | null;
}

/** The sentence under Properties when it shows less than there is. */
export function propertiesNoticeText(shown: number, meta: { truncated: boolean; total: number | null; skipped: number } | null | undefined): string | null {
  if (!meta) return null;
  const parts: string[] = [];
  if (meta.total !== null && meta.total > shown) parts.push(`Showing ${shown} of ${meta.total} property links.`);
  else if (meta.truncated) parts.push(`Showing the first ${shown} property links.`);
  if (meta.skipped > 0) parts.push(`${meta.skipped} ${meta.skipped === 1 ? "link" : "links"} couldn't be shown.`);
  return parts.length === 0 ? null : `${parts.join(" ")} Open the full record to see all of them.`;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p.length > 0);
  return parts.slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join("") || "?";
}

function humanise(type: string): string {
  const spaced = type.replace(/_/g, " ").trim();
  return spaced.length === 0 ? "Event" : spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** Moved to the shared helper (lib/growInterest.ts); kept under its old name so every existing caller is unchanged. */
export const propertyRelationshipText = growRelationshipText;


function dueText(c: GrowContact360Commitment, overdue: boolean): string {
  const date = formatContactDate(c.dueAt);
  return overdue ? `Overdue · was due ${date}` : `Due ${date}`;
}

function isOverdue(dueAt: string, now: Date): boolean {
  const t = new Date(dueAt).getTime();
  return !Number.isNaN(t) && t < now.getTime();
}

function chooseNextStep(data: GrowContact360, open: MobileCommitmentRow[], canLog: boolean, now: Date): MobileNextStep {
  const first = open[0];
  if (first) {
    return {
      kind: "commitment",
      title: first.text,
      detail: first.context,
      when: first.overdue ? "Overdue" : first.dueText.replace(/^Due /, ""),
      overdue: first.overdue,
      commitmentId: first.id,
      primary: canLog ? { kind: "complete", label: "Mark done" } : null,
      secondary: canLog ? { kind: "reschedule", label: "Reschedule" } : null,
    };
  }
  const opp = data.opportunities
    .filter((o) => o.status === "Open" && (o.recommendedNextAction || o.nextActionDueAt))
    .sort((a, b) => (a.nextActionDueAt ?? "9999").localeCompare(b.nextActionDueAt ?? "9999"))[0];
  if (opp) {
    return {
      kind: "opportunity",
      title: opp.recommendedNextAction?.trim() || "Follow up",
      detail: null,
      when: opp.nextActionDueAt ? (isOverdue(opp.nextActionDueAt, now) ? "Overdue" : formatContactDate(opp.nextActionDueAt)) : null,
      overdue: opp.nextActionDueAt ? isOverdue(opp.nextActionDueAt, now) : false,
      commitmentId: null,
      primary: { kind: "full-record", label: "Open the full record to update it" },
      secondary: null,
    };
  }
  const intel = data.intelligence;
  if (intel.nextFollowUpAt) {
    return {
      kind: "follow-up",
      title: intel.nextFollowUpDescription?.trim() || "Follow up",
      detail: null,
      when: formatContactDate(intel.nextFollowUpAt),
      overdue: false,
      commitmentId: null,
      primary: null,
      secondary: null,
    };
  }
  return {
    kind: "none",
    title: "No next step set",
    detail: null,
    when: null,
    overdue: false,
    commitmentId: null,
    primary: canLog ? { kind: "add-commitment", label: "Add a commitment" } : null,
    secondary: null,
  };
}

export function buildMobileContactLayout(data: GrowContact360, options: MobileContactOptions): MobileContactLayout {
  const { now, canLog } = options;
  const name = data.contact.displayName.trim() || "Unnamed contact";
  const propertyLabelById = new Map<number, string>();
  for (const p of data.properties) if (p.propertyId !== null && p.propertyAddress) propertyLabelById.set(p.propertyId, p.propertyAddress);

  const openRows: MobileCommitmentRow[] = data.commitments
    .filter((c) => c.status === "Open")
    .map((c) => {
      const overdue = isOverdue(c.dueAt, now);
      return {
        id: c.id,
        text: c.description.trim() || "Commitment",
        dueText: dueText(c, overdue),
        overdue,
        context: c.propertyId !== null ? (propertyLabelById.get(c.propertyId) ?? null) : null,
        dueAt: c.dueAt,
      };
    })
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.dueAt.localeCompare(b.dueAt))
    .map(({ dueAt: _dueAt, ...row }) => row);

  const timeline: GrowTimelineEvent[] = [...data.timeline].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const history = timeline.map((e) => ({ id: e.id, kind: humanise(e.type), when: formatContactDate(e.occurredAt), text: e.summary, context: e.propertyLabel }));
  const shown = options.expandedHistory ? history : history.slice(0, HISTORY_VISIBLE);

  const call = callPlan(numbersOf(data.contact), name);
  const nextStep = chooseNextStep(data, openRows, canLog, now);
  // PROPERTIES = property_parties only once the canonical read is on; until then (as shipped) the payload's Active Grow links, unchanged.
  const canonical = options.canonicalLinks ?? null;
  const propertiesState: MobileContactLayout["propertiesState"] = canonical ? "ready" : options.canonicalStatus === "loading" ? "loading" : options.canonicalStatus === "error" ? "error" : "legacy";
  const canonicalRows: MobilePropertyLink[] = (canonical ?? []).map((l) => ({
    key: l.linkId,
    label: l.address,
    relationship: linkRoleLabel(l.role),
    role: null,
    roleValue: l.role,
    primary: l.isPrimary,
    href: propertyResultHref(l.propertyId),
    canonical: true,
    propertyId: l.propertyId,
  }));
  const legacyRows: MobilePropertyLink[] = data.properties
    .filter((p) => p.status === "Active")
    .map((p) => ({
      key: p.relationshipId,
      label: p.propertyAddress ?? "Not linked to a property",
      relationship: propertyRelationshipText(p.relationshipType, p.role),
      role: p.role !== null && p.role.trim().length > 0 ? p.role.trim() : null,
      roleValue: null,
      primary: p.isPrimary,
      href: p.propertyId === null ? null : propertyResultHref(p.propertyId),
      canonical: false,
      propertyId: p.propertyId,
    }));
  const propertiesList = propertiesState === "legacy" ? legacyRows : propertiesState === "ready" ? canonicalRows : [];
  const interest = propertiesState === "ready" && canonical ? buildGrowInterest(data.properties, canonical, propertyRelationshipText, propertyResultHref) : { rows: [], alsoListedCount: 0 };
  const propertiesNotice =
    propertiesState === "ready" ? propertiesNoticeText(canonicalRows.length, options.canonicalMeta) : propertiesState === "error" ? "Couldn't load this contact's property links." : propertiesState === "loading" ? "Loading property links…" : null;
  return {
    id: data.contact.id,
    name,
    initials: initialsOf(name),
    roleChips: data.roles.map(roleLabel),
    call,
    email: data.contact.email && data.contact.email.trim().length > 0 ? data.contact.email.trim() : null,
    nextStep,
    commitments: openRows.filter((r) => r.id !== nextStep.commitmentId),
    openCommitmentCount: openRows.length,
    closedCommitmentCount: data.commitments.filter((c) => c.status !== "Open").length,
    properties: propertiesList,
    propertiesState,
    propertiesNotice,
    interest: interest.rows,
    propertiesCount: propertiesState === "ready" ? Math.max(options.canonicalMeta?.total ?? 0, canonicalRows.length) : null,
    interestCount: interest.rows.length,
    history: shown,
    historyHiddenCount: history.length - shown.length,
    fullRecordHref: `${growContactPath(data.contact.id)}?${CONTACT360_FULL_VIEW_QUERY}`,
    canLog,
  };
}
