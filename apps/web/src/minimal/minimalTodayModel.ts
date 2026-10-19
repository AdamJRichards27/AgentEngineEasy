import { appraisalWorkspacePath } from "../lib/appraisalUi";
import {
  growFirstRunIncomplete,
  growFirstRunSteps,
  type GrowFirstRunStep,
} from "../lib/growFirstRun";
import {
  actionTypeLabel,
  contactabilityNotice,
  formatWhen,
  priorityLabel,
  rankSummaryLine,
  signalWithholdingNotice,
  unlinkedContactNotice,
  type GrowTodayAction,
  type GrowTodayActionButton,
  type GrowTodaySummary,
} from "../lib/growToday";
import { DUE_TODAY_COUNT_LABEL } from "../lib/growTerms";
import { growContactPath } from "../lib/growWorkspace";

// AE Minimal A Today, read from GET /grow/today. The view model only
// rearranges that payload. It does not invent a price band, a momentum
// score, or a channel action the server did not already offer as navigation.

export interface MinimalTodayLink {
  href: string;
  label: string;
}

export interface MinimalTodayCard {
  id: string;
  title: string;
  propertyLabel: string | null;
  reason: string;
  whyItMatters: string | null;
  nextStep: string | null;
  priority: GrowTodayAction["priority"];
  priorityText: string;
  whenLabel: string;
  overdue: boolean;
  kindLabel: string | null;
  destination: MinimalTodayLink | null;
  contactabilityNote: string | null;
  rankLine: string | null;
  unlinkedNote: string | null;
}

export interface MinimalTodayCount {
  label: string;
  value: number;
}

export interface MinimalTodaySetupStep {
  id: GrowFirstRunStep["id"];
  title: string;
  hint: string;
  href: "/grow/import" | null;
}

export interface MinimalTodayModel {
  queueLabel: string | null;
  hero: MinimalTodayCard | null;
  alsoOnYourDay: MinimalTodayCard[];
  agendaSummary: string;
  signals: MinimalTodayCard[];
  comingUp: MinimalTodayCard | null;
  counts: MinimalTodayCount[];
  withholding: string | null;
  noGrowData: boolean;
  caughtUp: boolean;
  setupSteps: MinimalTodaySetupStep[];
}

const NAVIGATION_ORDER: GrowTodayActionButton["action"][] = [
  "view_contact",
  "view_appraisal",
  "view_property",
];

export function minimalTodayDestination(
  action: GrowTodayAction,
  prefer?: "view_contact" | "view_appraisal" | "view_property",
): MinimalTodayLink | null {
  const order = prefer
    ? [prefer, ...NAVIGATION_ORDER.filter((kind) => kind !== prefer)]
    : NAVIGATION_ORDER;
  for (const kind of order) {
    const button = action.availableActions.find((item) => item.action === kind);
    if (!button) continue;
    if (button.action === "view_contact") {
      return { href: growContactPath(button.partyId), label: "Open contact" };
    }
    if (button.action === "view_appraisal") {
      return { href: appraisalWorkspacePath(button.appraisalId), label: "Open appraisal" };
    }
    if (button.action === "view_property") {
      return { href: `/properties/${button.propertyId}`, label: "Open property" };
    }
  }
  return null;
}

function card(action: GrowTodayAction, now: Date, prefer?: "view_contact" | "view_appraisal" | "view_property"): MinimalTodayCard {
  const due = action.dueAt ? new Date(action.dueAt) : null;
  const overdue = due !== null && !Number.isNaN(due.getTime()) && due.getTime() < now.getTime();
  const nextStep = action.recommendedAction.trim();
  const why = action.whyItMatters?.headline.trim() ?? "";
  return {
    id: action.id,
    title: action.contactName.trim() || "Untitled record",
    propertyLabel: action.propertyLabel,
    reason: action.reason,
    whyItMatters: why.length > 0 ? why : null,
    nextStep: nextStep.length > 0 ? nextStep : null,
    priority: action.priority,
    priorityText: priorityLabel(action.priority),
    whenLabel: overdue ? "Overdue" : (formatWhen(action.dueAt) ?? "No date"),
    overdue,
    kindLabel: actionTypeLabel(action.type),
    destination: minimalTodayDestination(action, prefer),
    contactabilityNote: contactabilityNotice(action),
    rankLine: rankSummaryLine(action),
    unlinkedNote: unlinkedContactNotice(action),
  };
}

function agendaSummary(items: MinimalTodayCard[]): string {
  if (items.length === 0) return "Nothing else is queued";
  const overdue = items.filter((item) => item.overdue).length;
  const more = `${items.length} more on today's list`;
  if (overdue === 0) return more;
  return `${more} · ${overdue} overdue`;
}

function setupSteps(
  summary: GrowTodaySummary,
  hasEntitlement: (key: string) => boolean,
): MinimalTodaySetupStep[] {
  if (!summary.firstRun || !growFirstRunIncomplete(summary.firstRun)) return [];
  return growFirstRunSteps(summary.firstRun, hasEntitlement)
    .filter((step) => !step.done)
    .map((step) => ({
      id: step.id,
      title: step.title,
      hint: step.hint,
      href: step.importHref,
    }));
}

export function buildMinimalTodayModel(
  summary: GrowTodaySummary,
  now: Date,
  hasEntitlement: (key: string) => boolean = () => false,
): MinimalTodayModel {
  const actions = summary.priorityActions;
  const heroAction = actions[0] ?? null;
  const rest = heroAction ? actions.slice(1) : [];
  const signals = rest.filter((action) => action.type === "property_intelligence_signal").map((action) => card(action, now));
  const comingUpAction = rest.find((action) => action.type === "appraisal_follow_up") ?? null;
  const also = rest
    .filter((action) => action.type !== "property_intelligence_signal" && action !== comingUpAction)
    .map((action) => card(action, now));
  return {
    queueLabel:
      actions.length === 0
        ? null
        : actions.length === 1
          ? "1 priority action"
          : `1 of ${actions.length} priority actions`,
    hero: heroAction ? card(heroAction, now) : null,
    alsoOnYourDay: also,
    agendaSummary: agendaSummary(also),
    signals,
    comingUp: comingUpAction ? card(comingUpAction, now, "view_appraisal") : null,
    counts: [
      { label: "Priority actions", value: summary.counts.priorityActions },
      { label: DUE_TODAY_COUNT_LABEL, value: summary.counts.followUpsDue },
      { label: "Open opportunities", value: summary.counts.openOpportunities },
      { label: "Contacts needing attention", value: summary.counts.contactsNeedingAttention },
    ],
    withholding: signalWithholdingNotice(summary.signalSummary),
    noGrowData: !summary.hasAnyGrowData,
    caughtUp: summary.hasAnyGrowData && actions.length === 0,
    setupSteps: setupSteps(summary, hasEntitlement),
  };
}

/** "19 Oct, 7:00 pm": fixed en-AU so the time never follows the browser locale. Browser time zone, as classic. */
export function formatMinimalAsOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(d);
}
