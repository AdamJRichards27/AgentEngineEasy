// G-UAT-6 — Grow appraisal start, the shortest status path, and WON / LOST / DEFERRED.
//
// APPRAISAL_STATUS_TRANSITIONS is a hand-mirror of ALLOWED_STATUS_TRANSITIONS
// in apps/api/src/lib/growAppraisals.ts. The web app does not import that
// server module. apps/web/src/lib/__tests__/growAppraisalTransitions.test.ts
// fails if the two maps drift.
//
// The buttons this UI offers are NOT every allowed transition. They are the
// next step on the shortest path that map already permits:
//   DRAFT -> APPOINTMENT_SCHEDULED
//   APPOINTMENT_SCHEDULED -> PRESENTED or FOLLOW_UP
// Record outcome is offered only from PRESENTED or FOLLOW_UP, and only for
// WON / LOST / DEFERRED when the map still allows that outcome.

export const APPRAISAL_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  DRAFT: ["PREPARING", "APPOINTMENT_SCHEDULED", "ARCHIVED"],
  PREPARING: ["READY", "APPOINTMENT_SCHEDULED", "DRAFT", "ARCHIVED"],
  READY: ["SENT", "APPOINTMENT_SCHEDULED", "PREPARING", "ARCHIVED"],
  SENT: ["VIEWED", "APPOINTMENT_SCHEDULED", "PRESENTED", "FOLLOW_UP", "ARCHIVED"],
  VIEWED: ["APPOINTMENT_SCHEDULED", "PRESENTED", "FOLLOW_UP", "ARCHIVED"],
  APPOINTMENT_SCHEDULED: ["PRESENTED", "FOLLOW_UP", "SENT", "ARCHIVED"],
  PRESENTED: ["FOLLOW_UP", "WON", "LOST", "DEFERRED", "ARCHIVED"],
  FOLLOW_UP: ["PRESENTED", "WON", "LOST", "DEFERRED", "ARCHIVED"],
  WON: ["ARCHIVED"],
  LOST: ["ARCHIVED"],
  DEFERRED: ["FOLLOW_UP", "ARCHIVED"],
  ARCHIVED: [],
};

const SHORTEST_APPRAISAL_PATH: Record<string, readonly string[]> = {
  DRAFT: ["APPOINTMENT_SCHEDULED"],
  APPOINTMENT_SCHEDULED: ["PRESENTED", "FOLLOW_UP"],
};

export const APPRAISAL_NEXT_STEP_LABELS: Record<string, string> = {
  APPOINTMENT_SCHEDULED: "Appointment scheduled",
  PRESENTED: "Presented",
  FOLLOW_UP: "Needs follow-up",
};

export const APPRAISAL_OUTCOMES = ["WON", "LOST", "DEFERRED"] as const;
export type AppraisalOutcome = (typeof APPRAISAL_OUTCOMES)[number];

// Hand-mirror of APPRAISAL_OUTCOME_REASONS in packages/db/src/schema/appraisal.ts.
// The column is free text validated by the API, not a Postgres enum.
export const APPRAISAL_OUTCOME_REASONS = [
  ["selected_another_agent", "Selected another agent"],
  ["fee_commission", "Fee or commission"],
  ["pricing_disagreement", "Pricing disagreement"],
  ["marketing_proposal", "Marketing proposal"],
  ["relationship", "Relationship"],
  ["decided_not_to_sell", "Decided not to sell"],
  ["timing_delayed", "Timing delayed"],
  ["unable_to_contact", "Unable to contact"],
  ["other", "Other"],
] as const;

export const LINK_PROPERTY_BEFORE_APPRAISAL = "Link a property to start an appraisal";

export interface GrowAppraisalSummary {
  id: number;
  status: string;
  outcome: string | null;
  propertyId: number;
  propertyAddress: string;
  partyId: number | null;
}

export interface AppraisalPropertyChoice {
  id: number;
  label: string;
}

export function appraisalNextSteps(status: string): string[] {
  const allowed = APPRAISAL_STATUS_TRANSITIONS[status] ?? [];
  const shortest = SHORTEST_APPRAISAL_PATH[status] ?? [];
  return shortest.filter((step) => allowed.includes(step) && APPRAISAL_NEXT_STEP_LABELS[step] !== undefined);
}

export function appraisalOutcomeOptions(status: string): AppraisalOutcome[] {
  if (status !== "PRESENTED" && status !== "FOLLOW_UP") return [];
  const allowed = APPRAISAL_STATUS_TRANSITIONS[status] ?? [];
  return APPRAISAL_OUTCOMES.filter((outcome) => allowed.includes(outcome));
}

export function appraisalStatusLabel(status: string): string {
  switch (status) {
    case "DRAFT":
      return "Draft";
    case "APPOINTMENT_SCHEDULED":
      return "Appointment scheduled";
    case "PRESENTED":
      return "Presented";
    case "FOLLOW_UP":
      return "Needs follow-up";
    case "WON":
      return "Won";
    case "LOST":
      return "Lost";
    case "DEFERRED":
      return "Deferred";
    case "PREPARING":
      return "Preparing";
    case "READY":
      return "Ready";
    case "SENT":
      return "Sent";
    case "VIEWED":
      return "Viewed";
    case "ARCHIVED":
      return "Archived";
    default:
      return status;
  }
}

export function appraisalsForContact(rows: GrowAppraisalSummary[], partyId: number): GrowAppraisalSummary[] {
  return rows.filter((row) => row.partyId === partyId);
}

export function appraisalForProperty(rows: GrowAppraisalSummary[], propertyId: number | null): GrowAppraisalSummary | null {
  if (propertyId === null) return null;
  return rows.find((row) => row.propertyId === propertyId) ?? null;
}

export function appraisalPropertyChoices(
  properties: Array<{ propertyId: number | null; propertyAddress: string | null }>,
): AppraisalPropertyChoice[] {
  const seen = new Set<number>();
  const choices: AppraisalPropertyChoice[] = [];
  for (const property of properties) {
    if (property.propertyId === null || seen.has(property.propertyId)) continue;
    seen.add(property.propertyId);
    const address = property.propertyAddress?.trim();
    choices.push({
      id: property.propertyId,
      label: address && address.length > 0 ? address : `Property ${property.propertyId}`,
    });
  }
  return choices;
}
