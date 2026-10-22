import {
  type AppraisalListRow,
  appraisalIsTerminal,
  appraisalMatchesSearch,
  appraisalNextStepSummary,
  appraisalWorkspacePath,
  formatAppraisalDate,
} from "../../lib/appraisalUi";
import { appraisalStatusLabel } from "../../lib/growAppraisals";
import { builderPath } from "../appraisal/appraisalBuilderModel";

// AB-4: AE Minimal A Appraisals list (UX a49f7717). Pure model over the
// existing GET /grow/appraisals/pipeline rows (already brokerage- and
// visibility-scoped by the API). No new route, no migration.

export type MinimalAppraisalsTab = "active" | "finished";

export interface MinimalAppraisalRow {
  id: number;
  address: string;
  contact: string;
  owner: string | null;
  statusLabel: string;
  nextStep: string | null;
  followUp: string | null;
  followUpOverdue: boolean;
  /** Active → resume in the builder; finished → read-only workspace. */
  href: string;
  actionLabel: "Continue" | "Open";
}

export interface MinimalAppraisalsModel {
  tab: MinimalAppraisalsTab;
  rows: MinimalAppraisalRow[];
  counts: { active: number; finished: number };
}

function time(value: string | null | undefined): number {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : 0;
}

export function buildMinimalAppraisals(
  rows: AppraisalListRow[],
  opts: { tab: MinimalAppraisalsTab; search?: string; now?: Date },
): MinimalAppraisalsModel {
  const now = (opts.now ?? new Date()).getTime();
  const search = opts.search?.trim() ?? "";
  const matched = search ? rows.filter((r) => appraisalMatchesSearch(r, search)) : rows;
  const active = matched.filter((r) => !appraisalIsTerminal(r));
  const finished = matched.filter((r) => appraisalIsTerminal(r));
  const source = opts.tab === "active" ? active : finished;
  const sorted = [...source].sort((a, b) => {
    if (opts.tab === "active") {
      // Earliest follow-up first; no follow-up after; then most recently updated.
      const fa = a.followUpAt ? time(a.followUpAt) : Infinity;
      const fb = b.followUpAt ? time(b.followUpAt) : Infinity;
      if (fa !== fb) return fa - fb;
    }
    return time(b.updatedAt) - time(a.updatedAt) || b.id - a.id;
  });
  return {
    tab: opts.tab,
    counts: { active: active.length, finished: finished.length },
    rows: sorted.map((r) => {
      const terminal = appraisalIsTerminal(r);
      return {
        id: r.id,
        address: r.propertyAddress,
        contact: r.partyDisplayName?.trim() || "No contact linked",
        owner: r.ownerName,
        statusLabel: appraisalStatusLabel(r.status),
        nextStep: terminal ? null : appraisalNextStepSummary(r.status),
        followUp: terminal ? null : formatAppraisalDate(r.followUpAt ?? null),
        followUpOverdue: !terminal && !!r.followUpAt && time(r.followUpAt) < now,
        href: terminal ? appraisalWorkspacePath(r.id) : builderPath(r.id),
        actionLabel: terminal ? "Open" : "Continue",
      };
    }),
  };
}

/** Route selector: "?view=full" keeps the classic pipeline reachable (same convention as Properties/Contact 360). */
export function selectAppraisalsView(minimalShell: boolean, search = ""): "minimal" | "classic" {
  if (!minimalShell) return "classic";
  return new URLSearchParams(search).get("view") === "full" ? "classic" : "minimal";
}
