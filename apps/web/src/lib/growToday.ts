// AE GROW Priority 1 — Daily Command Centre, frontend types + display helpers.
// Mirrors apps/api/src/lib/growToday.ts by hand (the web app doesn't share a package with the
// API) — the same convention apps/web/src/lib/commandCentre.ts already uses for RUN's
// structurally analogous "Today" surface.

export const GROW_TODAY_PRIORITIES = ["DoNow", "DoToday", "KeepWarm"] as const;
export type GrowTodayPriority = (typeof GROW_TODAY_PRIORITIES)[number];

export type GrowTodayActionButton =
  | { action: "add_note" }
  | { action: "view_property"; propertyId: number }
  | { action: "update_next_action"; opportunityId: number }
  | { action: "ask_ae" };

export interface GrowTodayAction {
  id: string;
  type: "opportunity_follow_up" | "opportunity_no_action_set" | "relationship_cold";
  priority: GrowTodayPriority;
  partyId: number;
  contactName: string;
  relationshipType: string | null;
  propertyId: number | null;
  propertyLabel: string | null;
  opportunityId: number | null;
  reason: string;
  recommendedAction: string;
  dueAt: string | null;
  lastActivityAt: string | null;
  availableActions: GrowTodayActionButton[];
}

export interface GrowTodaySummary {
  generatedAt: string;
  hasAnyGrowData: boolean;
  counts: {
    priorityActions: number;
    followUpsDue: number;
    openOpportunities: number;
    contactsNeedingAttention: number;
  };
  priorityActions: GrowTodayAction[];
}

export function priorityLabel(priority: GrowTodayPriority): string {
  switch (priority) {
    case "DoNow":
      return "Do Now";
    case "DoToday":
      return "Do Today";
    case "KeepWarm":
      return "Keep Warm";
    default:
      return priority;
  }
}

// Same three-tone convention lib/commandCentre.ts's priorityPillClass already uses: urgent =
// danger, due soon = warning, everything else = neutral. The pill's text label (never colour
// alone) is what actually conveys urgency — that label is always rendered alongside the pill in
// Grow.tsx.
export function priorityPillClass(priority: GrowTodayPriority): string {
  if (priority === "DoNow") return "pill pill-danger";
  if (priority === "DoToday") return "pill pill-warning";
  return "pill";
}

export function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function formatGeneratedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}
