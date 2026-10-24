import { ApiError } from "../../lib/api";

// AE Minimal A — My Momentum (CC #5). Client-side mirror of the response of
// GET /grow/momentum from draft PR #248 (apps/api/src/routes/growMomentum.ts
// @4ff8dabb). Mirrored, not imported, so this branch does not stack on #248.
// Private: the API only ever returns the signed-in agent's own rows. There is
// no leaderboard and no comparison with anyone else, and this UI adds none.
// The API answers 404 while GROW_MOMENTUM_ENABLED is not "true"; the UI then
// shows nothing at all.

export type MomentumPeriod = "week" | "month";

export type MomentumCategoryKey =
  | "connectedConversation"
  | "twoWayExchange"
  | "personalisedOutreach"
  | "opportunityIdentified"
  | "appraisalBooked"
  | "appraisalCompleted"
  | "listingLinked"
  | "saleLinked";

export interface MomentumCategoryDto {
  key: MomentumCategoryKey | string;
  label: string;
  count: number;
  points: number;
  /** false = no authoritative source wired yet (phase 1); the API always sends 0. */
  sourced: boolean;
}

export interface MomentumResponse {
  rulesVersion: string;
  private: true;
  period: MomentumPeriod;
  timeZone: string;
  start: string;
  end: string;
  score: number;
  previousScore: number;
  change: number;
  nextMilestone: number | null;
  categories: MomentumCategoryDto[];
  funnel: { contacts: number; conversations: number; opportunities: number; appraisals: number; listings: number | null; sales: number | null };
  trend: { start: string; score: number }[];
  streakDays: number;
  nextBestActions: unknown[];
  truncated: boolean;
}

export const MINIMAL_MOMENTUM_HREF = "/grow/momentum";
export const NOT_YET_AVAILABLE = "Not yet available";

export function momentumQueryPath(period: MomentumPeriod): string {
  return `/grow/momentum?period=${period}`;
}

export function parseMomentumPeriod(search: string): MomentumPeriod {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("period") === "month" ? "month" : "week";
}

/**
 * Feature gate read from the API itself: 404 (flag off, the route does not
 * exist) and 403 (no grow.access) both mean "this feature is not here" and the
 * UI hides it. Anything else is a real error the user can retry.
 */
export function isFeatureHiddenError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 403);
}

/** Shape check so a stray 200 from something else is never rendered as Momentum. */
export function isMomentumResponse(x: unknown): x is MomentumResponse {
  const r = x as Partial<MomentumResponse> | null;
  return !!r && typeof r === "object" && r.private === true && typeof r.score === "number" && Array.isArray(r.categories) && Array.isArray(r.trend);
}

export interface MomentumCategoryRow {
  key: string;
  label: string;
  /** "12 · 72 pts", or NOT_YET_AVAILABLE for sourced:false. Never a number for unsourced rows. */
  value: string;
  available: boolean;
}

export interface MomentumFunnelRow {
  label: string;
  value: string;
  available: boolean;
}

export interface MinimalMomentumModel {
  periodLabel: string;
  rangeLabel: string;
  score: number;
  changeLabel: string;
  changeTone: "up" | "down" | "flat";
  milestoneLabel: string;
  streakLabel: string;
  categories: MomentumCategoryRow[];
  funnel: MomentumFunnelRow[];
  trend: { label: string; score: number; current: boolean }[];
  rulesVersion: string;
  truncatedNote: string | null;
  /** True when every sourced category is 0: show the empty state, still with the not-yet-available rows. */
  empty: boolean;
}

function fmtDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", timeZone }).format(new Date(iso));
}

function fmtMonth(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", { month: "short", year: "numeric", timeZone }).format(new Date(iso));
}

export function momentumChange(change: number, period: MomentumPeriod): { label: string; tone: "up" | "down" | "flat" } {
  const last = period === "week" ? "last week" : "last month";
  if (change > 0) return { label: `+${change} on ${last}`, tone: "up" };
  if (change < 0) return { label: `${change} on ${last}`, tone: "down" };
  return { label: `Same as ${last}`, tone: "flat" };
}

export function buildMomentumModel(r: MomentumResponse): MinimalMomentumModel {
  const tz = r.timeZone || "Australia/Brisbane";
  const change = momentumChange(r.change, r.period);
  // end is exclusive; show the last day of the period.
  const lastDay = new Date(new Date(r.end).getTime() - 1).toISOString();
  const categories = r.categories.map((c) => ({
    key: String(c.key),
    label: c.label,
    value: c.sourced ? `${c.count} · ${c.points} pts` : NOT_YET_AVAILABLE,
    available: c.sourced === true,
  }));
  const f = r.funnel;
  const num = (label: string, v: number | null): MomentumFunnelRow =>
    v == null ? { label, value: NOT_YET_AVAILABLE, available: false } : { label, value: String(v), available: true };
  const funnel = [
    num("Contacts reached", f.contacts),
    num("Conversations", f.conversations),
    num("Opportunities", f.opportunities),
    num("Appraisals", f.appraisals),
    num("Listings", f.listings),
    num("Sales", f.sales),
  ];
  const trend = r.trend.map((t, i) => ({
    label: r.period === "week" ? `Week of ${fmtDay(t.start, tz)}` : fmtMonth(t.start, tz),
    score: t.score,
    current: i === r.trend.length - 1,
  }));
  return {
    periodLabel: r.period === "week" ? "This week" : "This month",
    rangeLabel: `${fmtDay(r.start, tz)} – ${fmtDay(lastDay, tz)}`,
    score: r.score,
    changeLabel: change.label,
    changeTone: change.tone,
    milestoneLabel: r.nextMilestone == null ? "Every milestone reached" : `${r.nextMilestone - r.score} pts to ${r.nextMilestone}`,
    streakLabel: r.streakDays === 1 ? "1 day" : `${r.streakDays} days`,
    categories,
    funnel,
    trend,
    rulesVersion: r.rulesVersion,
    truncatedNote: r.truncated ? "Very busy period: only your first 2,000 records were counted, so the score may be low." : null,
    empty: r.categories.filter((c) => c.sourced).every((c) => c.count === 0),
  };
}

/** Route selector: Minimal shell only. Classic has no Momentum screen, so it falls back to /grow. */
export function selectMomentumView(minimalShell: boolean): "minimal" | "classic" {
  return minimalShell ? "minimal" : "classic";
}
