// AE GROW Priority 1 — Daily Command Centre, frontend types + display helpers.
// Mirrors apps/api/src/lib/growToday.ts by hand (the web app doesn't share a package with the
// API) — the same convention apps/web/src/lib/commandCentre.ts already uses for RUN's
// structurally analogous "Today" surface.
//
// AE GROW Priority 3 — additive only: contactEmail/contactMobile on GrowTodayAction, and the
// "email" / "sms" / "view_contact" GrowTodayActionButton kinds, mirror the exact same additions
// already made to apps/api/src/lib/growToday.ts (see that file's own header comment for the full
// rationale). Priority 1's ranking/priority/threshold/dedup logic is untouched — this is display
// metadata only, consumed by pages/Grow.tsx's GrowActionCard to decide whether to render
// Email/SMS/View Contact buttons.

export const GROW_TODAY_PRIORITIES = ["DoNow", "DoToday", "KeepWarm"] as const;
export type GrowTodayPriority = (typeof GROW_TODAY_PRIORITIES)[number];

export type GrowTodayActionButton =
  | { action: "add_note" }
  | { action: "view_property"; propertyId: number }
  | { action: "update_next_action"; opportunityId: number }
  | { action: "ask_ae" }
  // AE Grow Priority 3 — additive: rendered only when the contact has that channel on file
  // (email/sms) or unconditionally (view_contact, since partyId is always present).
  | { action: "email"; partyId: number }
  | { action: "sms"; partyId: number }
  | { action: "view_contact"; partyId: number };

export interface GrowTodayAction {
  id: string;
  type: "opportunity_follow_up" | "opportunity_no_action_set" | "relationship_cold";
  priority: GrowTodayPriority;
  partyId: number;
  contactName: string;
  // AE Grow Priority 3 — additive: lets the frontend decide whether to render an Email/SMS
  // action without a second lookup.
  contactEmail: string | null;
  contactMobile: string | null;
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

export type GrowTodayBucketTone = "urgent" | "standard" | "quiet";

export interface GrowTodayBucketPresentation {
  label: string;
  count: number;
  tone: GrowTodayBucketTone;
  isEmpty: boolean;
  description: string;
  emptyText: string;
}

/**
 * Presentation metadata for the three existing, ranked Today buckets.
 *
 * This deliberately accepts a count rather than action data: it cannot alter
 * ranking, filtering, or item contents, and gives the UI a deterministic way
 * to emphasize non-empty urgent buckets while keeping zero buckets quiet.
 */
export function growTodayBucketPresentation(
  priority: GrowTodayPriority,
  count: number,
): GrowTodayBucketPresentation {
  const isEmpty = count === 0;

  switch (priority) {
    case "DoNow":
      return {
        label: "Do Now",
        count,
        tone: isEmpty ? "quiet" : "urgent",
        isEmpty,
        description: "Highest-priority actions that need attention now.",
        emptyText: "No actions need immediate attention.",
      };
    case "DoToday":
      return {
        label: "Do Today",
        count,
        tone: isEmpty ? "quiet" : "urgent",
        isEmpty,
        description: "Actions to complete today.",
        emptyText: "No actions are due today.",
      };
    case "KeepWarm":
      return {
        label: "Keep Warm",
        count,
        tone: isEmpty ? "quiet" : "standard",
        isEmpty,
        description: "Relationships to keep moving with a timely follow-up.",
        emptyText: "No relationships need a keep-warm follow-up.",
      };
    default:
      return {
        label: priority,
        count,
        tone: isEmpty ? "quiet" : "standard",
        isEmpty,
        description: "Prioritized Grow actions.",
        emptyText: "No actions in this bucket.",
      };
  }
}

export function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function formatGeneratedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}
