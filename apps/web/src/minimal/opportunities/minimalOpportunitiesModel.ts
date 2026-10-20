import {
  GROW_OPPORTUNITY_LOST_REASON_MAX,
  GROW_OPPORTUNITY_MANUAL_STAGES,
  OPPORTUNITY_ACTIVE_APPRAISAL,
  OPPORTUNITY_CONVERTED_LOCKED,
  OPPORTUNITY_REOPEN_UNSUPPORTED,
  type GrowOpportunityManualStage,
} from "@aee/domain";
import { appraisalWorkspacePath, formatAppraisalDate } from "../../lib/appraisalUi";

// AE Minimal A — Opportunities. Owner decision D3: the existing Grow pipeline
// keeps the name "Opportunities" and is re-skinned; the prototype's map is
// renamed "Market Activity" and deferred (D10: needs a licensed market feed
// and map provider). Reads GET /grow/opportunities; writes only the existing
// PATCH /grow/opportunities/:id/lifecycle (#187).

export interface MinimalOpportunityRow {
  id: number;
  partyId: number;
  propertyId: number | null;
  opportunityType: string;
  status: string;
  stage: string;
  reason: string | null;
  nextActionDueAt: string | null;
  recommendedNextAction: string | null;
  convertedAppraisalId: number | null;
  contactName: string | null;
}

export interface PipelineColumnDef {
  key: string;
  label: string;
  closed: boolean;
}

export const MINIMAL_PIPELINE_COLUMNS: readonly PipelineColumnDef[] = [
  { key: "New", label: "New", closed: false },
  { key: "Contacted", label: "Contacted", closed: false },
  { key: "Qualified", label: "Qualified", closed: false },
  { key: "AppraisalBooked", label: "Appraisal booked", closed: false },
  { key: "Converted", label: "Converted", closed: true },
  { key: "Lost", label: "Lost", closed: true },
  { key: "Closed", label: "Closed", closed: true },
];

const TYPE_LABELS: Record<string, string> = {
  Listing: "Listing",
  Appraisal: "Appraisal",
  PropertyManagement: "Property management",
  Other: "Other",
};

export interface PipelineCard {
  id: number;
  contactName: string;
  contactHref: string;
  typeLabel: string;
  reason: string | null;
  nextAction: string | null;
  appraisalHref: string | null;
  propertyHref: string | null;
}

export interface PipelineColumn extends PipelineColumnDef {
  count: number;
  cards: PipelineCard[];
}

/** Status decides closed outcomes first; open rows go by stored stage. */
export function pipelineColumnKey(row: Pick<MinimalOpportunityRow, "status" | "stage">): string {
  if (row.status === "Lost" || row.stage === "Lost") return "Lost";
  if (row.status === "Closed") return "Closed";
  if (row.status === "Converted" || row.stage === "Converted") return "Converted";
  return MINIMAL_PIPELINE_COLUMNS.some((c) => c.key === row.stage && !c.closed) ? row.stage : "New";
}

function nextActionLabel(row: MinimalOpportunityRow): string | null {
  const due = formatAppraisalDate(row.nextActionDueAt);
  const what = row.recommendedNextAction?.trim() || null;
  if (what && due) return `${what} · ${due}`;
  if (due) return `Next action · ${due}`;
  return what;
}

export function buildPipelineBoard(rows: MinimalOpportunityRow[]): PipelineColumn[] {
  const byKey = new Map<string, PipelineCard[]>(MINIMAL_PIPELINE_COLUMNS.map((c) => [c.key, []]));
  for (const row of rows) {
    byKey.get(pipelineColumnKey(row))!.push({
      id: row.id,
      contactName: row.contactName?.trim() || "Unnamed contact",
      contactHref: `/grow/contacts/${row.partyId}`,
      typeLabel: TYPE_LABELS[row.opportunityType] ?? row.opportunityType,
      reason: row.reason?.trim() || null,
      nextAction: nextActionLabel(row),
      appraisalHref: row.convertedAppraisalId != null ? appraisalWorkspacePath(row.convertedAppraisalId) : null,
      propertyHref: row.propertyId != null ? `/properties/${row.propertyId}` : null,
    });
  }
  return MINIMAL_PIPELINE_COLUMNS.map((c) => {
    const cards = byKey.get(c.key)!;
    return { ...c, count: cards.length, cards };
  });
}

export interface OpportunityActions {
  stages: GrowOpportunityManualStage[];
  canMarkLost: boolean;
  canClose: boolean;
  lockedReason: string | null;
}

/** Mirrors packages/domain growOpportunityLifecycle (the server re-checks). */
export function opportunityActions(row: Pick<MinimalOpportunityRow, "status" | "stage">): OpportunityActions {
  if (row.status === "Lost" || row.status === "Closed" || row.stage === "Lost") {
    return { stages: [], canMarkLost: false, canClose: false, lockedReason: OPPORTUNITY_REOPEN_UNSUPPORTED };
  }
  if (row.status === "Converted" || row.stage === "Converted") {
    return { stages: [], canMarkLost: false, canClose: false, lockedReason: OPPORTUNITY_CONVERTED_LOCKED };
  }
  if (row.stage === "AppraisalBooked") {
    return { stages: [], canMarkLost: false, canClose: false, lockedReason: OPPORTUNITY_ACTIVE_APPRAISAL };
  }
  return {
    stages: GROW_OPPORTUNITY_MANUAL_STAGES.filter((s) => s !== row.stage),
    canMarkLost: true,
    canClose: true,
    lockedReason: null,
  };
}

export type LifecycleCommand =
  | { kind: "stage"; stage: GrowOpportunityManualStage }
  | { kind: "lost"; lostReason: string }
  | { kind: "close" };

export type LifecycleBody =
  | { stage: GrowOpportunityManualStage }
  | { status: "Lost"; lostReason: string }
  | { status: "Closed" };

export function lifecycleBody(command: LifecycleCommand): { ok: true; body: LifecycleBody } | { ok: false; error: string } {
  if (command.kind === "stage") return { ok: true, body: { stage: command.stage } };
  if (command.kind === "close") return { ok: true, body: { status: "Closed" } };
  const lostReason = command.lostReason.trim();
  if (!lostReason) return { ok: false, error: "Say why this opportunity was lost." };
  if (lostReason.length > GROW_OPPORTUNITY_LOST_REASON_MAX) {
    return { ok: false, error: `Keep the reason to ${GROW_OPPORTUNITY_LOST_REASON_MAX} characters or fewer.` };
  }
  return { ok: true, body: { status: "Lost", lostReason } };
}

export const MARKET_ACTIVITY_DEFERRED = {
  title: "Market Activity",
  body: "Market Activity is deferred. It needs a licensed market-data feed and map provider, which are not connected. Your pipeline below uses only AE records.",
} as const;

export const MINIMAL_OPPORTUNITIES_PAGE_LIMIT = 100;

/** Route selector for WS3 (proposed path /grow/opportunities; "?view=full" falls back to classic). */
export function selectOpportunitiesView(minimalShell: boolean, search = ""): "minimal" | "classic" {
  if (!minimalShell) return "classic";
  return new URLSearchParams(search).get("view") === "full" ? "classic" : "minimal";
}

/** Sentence for the board's polite live region after a lifecycle change succeeds. */
export function lifecycleAnnouncement(contactName: string | null | undefined, command: LifecycleCommand): string {
  const who = contactName?.trim() || "Unnamed contact";
  if (command.kind === "stage") {
    const label = MINIMAL_PIPELINE_COLUMNS.find((c) => c.key === command.stage)?.label ?? command.stage;
    return `${who} moved to ${label}.`;
  }
  return command.kind === "lost" ? `${who} marked lost.` : `${who} closed.`;
}

/** The classic opportunities list, reached from the Minimal page (?view=full is the classic escape). */
export const MINIMAL_OPPORTUNITIES_CLASSIC_HREF = "/grow/opportunities?view=full";
