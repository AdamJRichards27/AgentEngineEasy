// Grow appraisal list and workspace. Filters run on the rows
// GET /grow/appraisals/pipeline already returned for this caller.
// That route applies the Agent / Administrator / Pit Crew property
// scope. Nothing here asks for a wider set.

import {
  APPRAISAL_NEXT_STEP_LABELS,
  APPRAISAL_OUTCOME_REASONS,
  appraisalNextSteps,
  appraisalStatusLabel,
} from "./growAppraisals";

export const APPRAISAL_TIME_ZONE = "Australia/Brisbane";

export const APPRAISAL_PIPELINE_STAGES = ["open", "won", "lost", "deferred", "archived", "finalised"] as const;
export type AppraisalPipelineStage = (typeof APPRAISAL_PIPELINE_STAGES)[number];
export type AppraisalPipelineStageFilter = AppraisalPipelineStage | "all";

export const APPRAISAL_STAGE_LABELS: Record<AppraisalPipelineStageFilter, string> = {
  all: "All",
  open: "Open",
  won: "Won",
  lost: "Lost",
  deferred: "Deferred",
  archived: "Archived",
  finalised: "Finalised",
};

const TERMINAL_STATUSES = new Set(["WON", "LOST", "DEFERRED", "ARCHIVED"]);

export interface AppraisalListRow {
  id: number;
  status: string;
  outcome: string | null;
  propertyId: number;
  propertyAddress: string;
  partyId: number | null;
  partyDisplayName: string | null;
  ownerUserId: number | null;
  ownerName: string | null;
  followUpAt?: string | null;
  updatedAt?: string | null;
  isFinalised?: boolean;
}

export function appraisalWorkspacePath(appraisalId: number): string {
  return `/grow/appraisals/${appraisalId}`;
}

export function appraisalContactPath(partyId: number): string {
  return `/grow?contact=${partyId}`;
}

/** Brokerage Administrator and Pit Crew see every property. An Agent does not, so the owner control stays hidden. */
export function canFilterAppraisalsByOwner(role: string | undefined): boolean {
  return role === "Brokerage Administrator" || role === "Pit Crew";
}

export function appraisalIsFinalised(row: { isFinalised?: boolean }): boolean {
  return row.isFinalised === true;
}

export function appraisalIsTerminal(row: { status: string }): boolean {
  return TERMINAL_STATUSES.has(row.status);
}

/** Finished and finalised appraisals stay readable and accept no further edits. */
export function appraisalReadOnlyMessage(row: { status: string; isFinalised?: boolean }): string | null {
  if (appraisalIsFinalised(row)) return "This appraisal is finalised and cannot be changed.";
  if (appraisalIsTerminal(row)) return "This appraisal is finished and cannot be changed.";
  return null;
}

export function appraisalMatchesStage(row: AppraisalListRow, stage: AppraisalPipelineStageFilter): boolean {
  if (stage === "all") return true;
  if (stage === "finalised") return appraisalIsFinalised(row);
  if (stage === "archived") return row.status === "ARCHIVED";
  if (stage === "won") return row.status === "WON" || row.outcome === "WON";
  if (stage === "lost") return row.status === "LOST" || row.outcome === "LOST";
  if (stage === "deferred") return row.status === "DEFERRED" || row.outcome === "DEFERRED";
  return !appraisalIsTerminal(row) && !appraisalIsFinalised(row);
}

export function appraisalMatchesSearch(row: AppraisalListRow, search: string): boolean {
  const term = search.trim().toLowerCase();
  if (term.length === 0) return true;
  const property = row.propertyAddress.toLowerCase();
  const contact = (row.partyDisplayName ?? "").toLowerCase();
  return property.includes(term) || contact.includes(term);
}

export function filterAppraisalPipeline(
  rows: AppraisalListRow[],
  input: { stage: AppraisalPipelineStageFilter; search: string; ownerUserId: number | null },
): AppraisalListRow[] {
  return rows.filter((row) => {
    if (!appraisalMatchesStage(row, input.stage)) return false;
    if (!appraisalMatchesSearch(row, input.search)) return false;
    if (input.ownerUserId !== null && row.ownerUserId !== input.ownerUserId) return false;
    return true;
  });
}

export interface AppraisalOwnerChoice {
  id: number;
  label: string;
}

export function appraisalOwnerChoices(rows: AppraisalListRow[]): AppraisalOwnerChoice[] {
  const labels = new Map<number, string>();
  for (const row of rows) {
    if (row.ownerUserId === null || labels.has(row.ownerUserId)) continue;
    const name = row.ownerName?.trim();
    labels.set(row.ownerUserId, name && name.length > 0 ? name : `Owner ${row.ownerUserId}`);
  }
  return [...labels.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, "en-AU"));
}

export function appraisalNextStepSummary(status: string): string {
  const steps = appraisalNextSteps(status);
  if (steps.length === 0) return "No next step";
  return steps.map((step) => APPRAISAL_NEXT_STEP_LABELS[step] ?? appraisalStatusLabel(step)).join(" or ");
}

export function appraisalOutcomeReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const match = APPRAISAL_OUTCOME_REASONS.find(([value]) => value === reason);
  return match ? match[1] : reason;
}

export function formatAppraisalDate(value: string | Date | null | undefined): string | null {
  const date = appraisalDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: APPRAISAL_TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function formatAppraisalDateTime(value: string | Date | null | undefined): string | null {
  const date = appraisalDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: APPRAISAL_TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatAppraisalMoney(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) return null;
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  }).format(amount);
}

function appraisalDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface AppraisalHistoryItem {
  at: string;
  label: string;
}

export interface AppraisalHistorySource {
  createdAt?: string | null;
  appointmentAt?: string | null;
  sentAt?: string | null;
  viewedAt?: string | null;
  presentationAt?: string | null;
  followUpAt?: string | null;
  outcomeAt?: string | null;
  outcome?: string | null;
  updatedAt?: string | null;
  isFinalised?: boolean;
  finalisedSnapshot?: unknown;
}

export interface AppraisalTimelineEntry {
  occurredAt: string;
  label: string;
  category: string;
}

export function appraisalHistory(record: AppraisalHistorySource, timeline: AppraisalTimelineEntry[] = []): AppraisalHistoryItem[] {
  const items: AppraisalHistoryItem[] = [];
  const push = (at: string | null | undefined, label: string) => {
    if (!at || !appraisalDate(at)) return;
    items.push({ at, label });
  };

  push(record.createdAt, "Appraisal started");
  push(record.appointmentAt, "Appointment");
  push(record.sentAt, "Sent");
  push(record.viewedAt, "Viewed");
  push(record.presentationAt, "Presented");
  push(record.followUpAt, "Follow-up");
  if (record.outcomeAt) {
    const outcome = record.outcome ? appraisalStatusLabel(record.outcome) : "Outcome";
    push(record.outcomeAt, `Outcome recorded: ${outcome}`);
  }
  push(finalisedAt(record), "Finalised");
  if (record.updatedAt && record.updatedAt !== record.createdAt) push(record.updatedAt, "Updated");

  for (const entry of timeline) {
    if (entry.category !== "Appraisal") continue;
    push(entry.occurredAt, entry.label);
  }

  const seen = new Set<string>();
  return items
    .filter((item) => {
      const key = `${item.at}|${item.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const left = appraisalDate(a.at)?.getTime() ?? 0;
      const right = appraisalDate(b.at)?.getTime() ?? 0;
      return right - left;
    });
}

function finalisedAt(record: AppraisalHistorySource): string | null {
  if (!record.isFinalised || !record.finalisedSnapshot || typeof record.finalisedSnapshot !== "object") return null;
  const value = (record.finalisedSnapshot as { finalisedAt?: unknown }).finalisedAt;
  return typeof value === "string" ? value : null;
}
