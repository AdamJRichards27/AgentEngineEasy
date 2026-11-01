import { growTabHref } from "../../lib/growWorkspace";
import type { MinimalTodayCard, MinimalTodayModel, MinimalTodaySetupStep } from "../minimalTodayModel";
import type { MarketCardData, MomentumCardData } from "../momentum/MinimalTodayInsightCardsView";
import { MOBILE_MARKET_HREF, MOBILE_MOMENTUM_HREF, TODAY_SIGNAL_LIMIT, TODAY_VISIBLE_ROWS } from "./mobileTodayConfig";

// AE Mobile (CC Task #64, M3): the phone Today layout, as one pure function. No React, no network,
// no storage. It reads the model the existing Today already builds (buildMinimalTodayModel, from
// GET /grow/today) and arranges it for a phone. It adds no data, no endpoint and no wording of its
// own beyond layout labels. It changes nothing in the model.
//
// What it does with the existing model:
//   - keeps the one next action (hero) and says what to do once, not twice;
//   - merges "Coming up" into the one list, so there is no second place to look;
//   - splits that list into Overdue and Today, overdue first, with commitments among them;
//   - keeps contact warnings visible, and puts "why this" and the ranking line behind a disclosure;
//   - drops the four counts, the queue line, the agenda summary and the Run cross-link, because each
//     repeats something already on the screen or is one tap away in More;
//   - offers My Momentum, Market Activity and (only when verified) Ask AE as three quiet shortcuts.

export type MobileTodayState = "ready" | "caught-up" | "no-data";

export interface MobileTodayRow {
  id: string;
  name: string;
  initials: string;
  /** What to do: the recommended action, or the reason when there is none. Said once. */
  action: string;
  /** The property, when there is one. */
  context: string | null;
  /** "Commitment" or "Due follow-up" (the product's own names), or null. */
  kind: string | null;
  when: string;
  overdue: boolean;
  /** The record to open. Null when the server offered none the user may use. */
  href: string | null;
  actionLabel: string | null;
  /** A contact-consent warning. Always visible, never behind a disclosure. */
  warning: string | null;
}

export interface MobileTodayWhy {
  label: string;
  text: string;
}

export interface MobileTodayHero extends MobileTodayRow {
  /** The server's reason, only when it says something the action does not. */
  reason: string | null;
  why: MobileTodayWhy[];
  notes: string[];
}

export interface MobileTodayGroup {
  key: "overdue" | "today";
  title: string;
  rows: MobileTodayRow[];
}

export interface MobileTodayShortcut {
  key: "momentum" | "ask-ae" | "market";
  label: string;
  subtitle: string | null;
  href: string;
}

export interface MobileTodayLayout {
  state: MobileTodayState;
  hero: MobileTodayHero | null;
  groups: MobileTodayGroup[];
  /** Rows in the list in total, shown or not. */
  totalRows: number;
  /** Rows held back until "Show all". */
  hiddenCount: number;
  signals: MobileTodayRow[];
  signalsNote: string | null;
  shortcuts: MobileTodayShortcut[];
  setupSteps: MinimalTodaySetupStep[];
}

export interface MobileTodayExtras {
  /** From the same cached query the Today cards use. Null when the API did not answer. */
  momentum: MomentumCardData | null;
  market: MarketCardData | null;
  /** Leave false until Ask AE's routing is verified. */
  askAeAvailable: boolean;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p.length > 0);
  return parts.slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join("") || "?";
}

function same(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return x.length > 0 && y.length > 0 && (x === y || x.includes(y) || y.includes(x));
}

function toRow(card: MinimalTodayCard): MobileTodayRow {
  return {
    id: card.id,
    name: card.title,
    initials: initialsOf(card.title),
    action: card.nextStep ?? (card.reason.trim() || "Review this record"),
    context: card.propertyLabel,
    kind: card.kindLabel,
    when: card.whenLabel,
    overdue: card.overdue,
    href: card.destination?.href ?? null,
    actionLabel: card.destination?.label ?? null,
    warning: card.contactabilityNote,
  };
}

function toHero(card: MinimalTodayCard): MobileTodayHero {
  const row = toRow(card);
  const why: MobileTodayWhy[] = [];
  if (card.whyItMatters && !same(card.whyItMatters, row.action)) why.push({ label: "Why it matters", text: card.whyItMatters });
  if (card.rankLine) why.push({ label: "Ranking", text: card.rankLine });
  return {
    ...row,
    reason: card.reason.trim().length > 0 && !same(card.reason, row.action) && !(card.whyItMatters && same(card.reason, card.whyItMatters)) ? card.reason : null,
    why,
    notes: card.unlinkedNote ? [card.unlinkedNote] : [],
  };
}

export function buildMobileTodayLayout(model: MinimalTodayModel, extras: MobileTodayExtras, expanded = false): MobileTodayLayout {
  // One list: "Also on your day" plus "Coming up", overdue first, order otherwise unchanged.
  const agenda = model.comingUp ? [...model.alsoOnYourDay, model.comingUp] : model.alsoOnYourDay;
  const rows = agenda.map(toRow);
  const ordered = [...rows.filter((r) => r.overdue), ...rows.filter((r) => !r.overdue)];
  const shown = expanded ? ordered : ordered.slice(0, TODAY_VISIBLE_ROWS);

  const groups: MobileTodayGroup[] = [];
  const overdue = shown.filter((r) => r.overdue);
  const later = shown.filter((r) => !r.overdue);
  if (overdue.length > 0) groups.push({ key: "overdue", title: "Overdue", rows: overdue });
  if (later.length > 0) groups.push({ key: "today", title: "Today", rows: later });

  const shortcuts: MobileTodayShortcut[] = [];
  if (extras.momentum) {
    const change = extras.momentum.changeLabel.trim();
    shortcuts.push({
      key: "momentum",
      label: "My Momentum",
      subtitle: `${extras.momentum.score} pts this week${change ? ` · ${change}` : ""}`,
      href: MOBILE_MOMENTUM_HREF,
    });
  }
  if (extras.askAeAvailable) shortcuts.push({ key: "ask-ae", label: "Ask AE", subtitle: null, href: growTabHref("askAE") });
  if (extras.market) {
    shortcuts.push({ key: "market", label: "Market Activity", subtitle: `${extras.market.total} this week`, href: MOBILE_MARKET_HREF });
  }

  return {
    state: model.noGrowData ? "no-data" : model.caughtUp ? "caught-up" : "ready",
    hero: model.hero ? toHero(model.hero) : null,
    groups,
    totalRows: ordered.length,
    hiddenCount: ordered.length - shown.length,
    signals: model.signals.slice(0, TODAY_SIGNAL_LIMIT).map(toRow),
    signalsNote: model.withholding,
    shortcuts,
    setupSteps: model.setupSteps,
  };
}
