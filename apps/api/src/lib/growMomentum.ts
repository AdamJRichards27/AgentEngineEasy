// CC #5 / SPEC-01 — My Momentum phase 1. Private, per-agent score derived on
// read from existing authoritative rows. No writes, no new tables, no
// leaderboard or comparison of any kind. Pure scoring here; the route in
// routes/growMomentum.ts fetches the agent's own rows and calls scoreMomentum.

export const MOMENTUM_FLAG_ENV = "GROW_MOMENTUM_ENABLED";

/** Only the exact word "true" (any case) turns it on — same parser as AE_MINIMAL_UX_ENABLED. */
export function isMomentumEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[MOMENTUM_FLAG_ENV];
  return typeof raw === "string" && raw.toLowerCase() === "true";
}

/** Versioned rules. Weights are PROPOSED for Owner tuning; results always report the version used. */
export const MOMENTUM_RULES_V1 = {
  version: "momentum-v1",
  connectedConversation: { points: 6, maxPerContactPerDay: 2 },
  personalisedOutreach: { points: 1, maxPerDay: 10, maxPerContactPerWeek: 3 },
  opportunityIdentified: { points: 10, perContactWindowDays: 7 },
  appraisalBooked: { points: 15 },
  appraisalCompleted: { points: 25 },
  milestoneBands: [100, 250, 500, 1000] as readonly number[],
} as const;

export type MomentumCategoryKey =
  | "connectedConversation"
  | "twoWayExchange"
  | "personalisedOutreach"
  | "opportunityIdentified"
  | "appraisalBooked"
  | "appraisalCompleted"
  | "listingLinked"
  | "saleLinked";

export interface MomentumActivity {
  id: number;
  partyId: number | null;
  activityType: string;
  occurredAt: Date;
  /** call ↔ call_summary share a sourceId (call session); used for dedupe. */
  sourceId: string | null;
  source: string;
}

export interface MomentumOpportunity {
  id: number;
  partyId: number | null;
  createdAt: Date;
}

export interface MomentumAppraisal {
  id: number;
  createdAt: Date;
  completedAt: Date | null;
}

export interface MomentumInput {
  activities: MomentumActivity[];
  opportunities: MomentumOpportunity[];
  appraisals: MomentumAppraisal[];
  start: Date;
  end: Date;
  timeZone: string;
}

export interface MomentumCategory {
  key: MomentumCategoryKey;
  label: string;
  count: number;
  points: number;
  /** false = no authoritative source wired yet in phase 1; always 0. */
  sourced: boolean;
}

export interface MomentumScore {
  rulesVersion: string;
  score: number;
  categories: MomentumCategory[];
  funnel: { contacts: number; conversations: number; opportunities: number; appraisals: number; listings: number | null; sales: number | null };
  excludedCount: number;
}

const CONVERSATION_TYPES = new Set(["call", "call_summary", "meeting"]);
const OUTREACH_TYPES = new Set(["email", "sms"]);
/** Bulk, imported or automated writers never earn points. */
const AUTOMATED_SOURCES = new Set(["import", "imported", "bulk", "campaign", "system", "automation"]);

function localDay(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function inWindow(d: Date, start: Date, end: Date): boolean {
  return d.getTime() >= start.getTime() && d.getTime() < end.getTime();
}

/** Deterministic: same rows + same rules version → same result (order-independent). */
export function scoreMomentum(input: MomentumInput): MomentumScore {
  const R = MOMENTUM_RULES_V1;
  const tz = input.timeZone;
  const acts = input.activities
    .filter((a) => inWindow(a.occurredAt, input.start, input.end))
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id - b.id);

  let excluded = 0;
  const conversationKeys = new Set<string>();
  const convPerContactDay = new Map<string, number>();
  const outreachPerDay = new Map<string, number>();
  const outreachPerContact = new Map<string, number>();
  const contacts = new Set<number>();
  let conversations = 0;
  let outreach = 0;

  for (const a of acts) {
    if (AUTOMATED_SOURCES.has(a.source.toLowerCase())) {
      excluded++;
      continue;
    }
    const day = localDay(a.occurredAt, tz);
    const contactKey = a.partyId == null ? `none:${a.id}` : String(a.partyId);
    if (CONVERSATION_TYPES.has(a.activityType)) {
      // call ↔ call_summary for the same session count once.
      const dedupe = a.sourceId ? `src:${a.sourceId}` : `id:${a.id}`;
      if (conversationKeys.has(dedupe)) {
        excluded++;
        continue;
      }
      conversationKeys.add(dedupe);
      const k = `${contactKey}|${day}`;
      const n = convPerContactDay.get(k) ?? 0;
      if (n >= R.connectedConversation.maxPerContactPerDay) {
        excluded++;
        continue;
      }
      convPerContactDay.set(k, n + 1);
      conversations++;
      if (a.partyId != null) contacts.add(a.partyId);
    } else if (OUTREACH_TYPES.has(a.activityType)) {
      const dayN = outreachPerDay.get(day) ?? 0;
      const weekKey = `${contactKey}|${weekOf(a.occurredAt, input.start)}`;
      const cN = outreachPerContact.get(weekKey) ?? 0;
      if (dayN >= R.personalisedOutreach.maxPerDay || cN >= R.personalisedOutreach.maxPerContactPerWeek) {
        excluded++;
        continue;
      }
      outreachPerDay.set(day, dayN + 1);
      outreachPerContact.set(weekKey, cN + 1);
      outreach++;
      if (a.partyId != null) contacts.add(a.partyId);
    } else {
      // notes, task completions, system events, campaign responses, appraisal-type rows (counted from appraisals) …
      excluded++;
    }
  }

  const opps = input.opportunities
    .filter((o) => inWindow(o.createdAt, input.start, input.end))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
  const lastOppByContact = new Map<number, number>();
  let opportunities = 0;
  const windowMs = R.opportunityIdentified.perContactWindowDays * 86_400_000;
  for (const o of opps) {
    if (o.partyId != null) {
      const last = lastOppByContact.get(o.partyId);
      if (last != null && o.createdAt.getTime() - last < windowMs) {
        excluded++;
        continue;
      }
      lastOppByContact.set(o.partyId, o.createdAt.getTime());
    }
    opportunities++;
  }

  const seenAppraisals = new Set<number>();
  let booked = 0;
  let completed = 0;
  for (const a of input.appraisals) {
    if (seenAppraisals.has(a.id)) continue;
    seenAppraisals.add(a.id);
    if (inWindow(a.createdAt, input.start, input.end)) booked++;
    if (a.completedAt && inWindow(a.completedAt, input.start, input.end)) completed++;
  }

  const categories: MomentumCategory[] = [
    { key: "connectedConversation", label: "Conversations", count: conversations, points: conversations * R.connectedConversation.points, sourced: true },
    { key: "twoWayExchange", label: "Replies received", count: 0, points: 0, sourced: false },
    { key: "personalisedOutreach", label: "Personal outreach", count: outreach, points: outreach * R.personalisedOutreach.points, sourced: true },
    { key: "opportunityIdentified", label: "Opportunities identified", count: opportunities, points: opportunities * R.opportunityIdentified.points, sourced: true },
    { key: "appraisalBooked", label: "Appraisals booked", count: booked, points: booked * R.appraisalBooked.points, sourced: true },
    { key: "appraisalCompleted", label: "Appraisals completed", count: completed, points: completed * R.appraisalCompleted.points, sourced: true },
    { key: "listingLinked", label: "Listings", count: 0, points: 0, sourced: false },
    { key: "saleLinked", label: "Sales", count: 0, points: 0, sourced: false },
  ];
  return {
    rulesVersion: R.version,
    score: categories.reduce((s, c) => s + c.points, 0),
    categories,
    funnel: { contacts: contacts.size, conversations, opportunities, appraisals: booked, listings: null, sales: null },
    excludedCount: excluded,
  };
}

function weekOf(d: Date, anchor: Date): number {
  return Math.floor((d.getTime() - anchor.getTime()) / (7 * 86_400_000));
}

/** Next fixed, code-defined milestone band (phase 1 has no stored personal goals). */
export function nextMilestone(score: number): number | null {
  return MOMENTUM_RULES_V1.milestoneBands.find((b) => b > score) ?? null;
}

/** Monday 00:00 in timeZone, as a UTC instant, for the week containing `now`. */
export function weekStart(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  const localMidnightAsUtc = Date.UTC(+get("year"), +get("month") - 1, +get("day"));
  const offsetMs = Date.UTC(+get("year"), +get("month") - 1, +get("day"), +get("hour"), +get("minute"), +get("second")) - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(localMidnightAsUtc - dow * 86_400_000 - offsetMs);
}

export function monthStart(now: Date, timeZone: string): Date {
  const ws = weekStart(now, timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const day = +parts.find((p) => p.type === "day")!.value;
  // offset of local midnight today, derived from week start's offset (same zone; AU/Brisbane has no DST)
  const todayLocalMidnight = new Date(now.getTime() - ((now.getTime() - ws.getTime()) % 86_400_000));
  return new Date(todayLocalMidnight.getTime() - (day - 1) * 86_400_000);
}
