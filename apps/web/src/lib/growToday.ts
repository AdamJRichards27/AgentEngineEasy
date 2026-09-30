// AE GROW Priority 1 — Grow Today, frontend types + display helpers.
// This is the relationship list (GET /grow/today). It is not the RUN Command
// Centre (GET /command-centre). User-facing names and the cross-link live in
// lib/todaySurfaces.ts. Mirrors apps/api/src/lib/growToday.ts by hand (the web
// app doesn't share a package with the API) — the same convention
// apps/web/src/lib/commandCentre.ts already uses for RUN's separate Today screen.
//
// AE GROW Priority 3 — additive only: contactEmail/contactMobile on GrowTodayAction, and the
// "email" / "sms" / "view_contact" GrowTodayActionButton kinds, mirror the exact same additions
// already made to apps/api/src/lib/growToday.ts (see that file's own header comment for the full
// rationale). Priority 1's ranking/priority/threshold/dedup logic is untouched — this is display
// metadata only, consumed by pages/Grow.tsx's GrowActionCard to decide whether to render
// Email/SMS/View Contact buttons.
//
// =====================================================================
// AE GROW "BROKERAGE-WIDE SIGNAL SWEEP" STAGE 3 — the mirror had drifted, and
// this file now carries the explainability + consent display rules.
// =====================================================================
//
// DRIFT FIXED FIRST. This mirror was missing the "appraisal_follow_up" and
// "property_intelligence_signal" action types, the appraisalId field and the
// "view_appraisal" button, all of which the API has been returning since
// Priority 4/5. A hand-maintained mirror that silently lags is worse than no
// mirror, so the whole contract is restated below.
//
// WHAT STAGE 3 ADDS:
//   - partyId is NULLABLE. An observation-derived signal is about a property,
//     not a person, and used to be dropped entirely on the read path.
//   - rankScore + whyItMatters. The card explains itself: a headline, an
//     optional talking point, a caution, and the itemised factors behind the
//     rank. A bare score must never be rendered on its own — see
//     rankExplanationLines() below, which is the only supported way to show
//     the number.
//   - contactability + contactabilityNote. Grow Today WITHHOLDS a suppressed
//     contact's prospecting items server-side, so "do_not_contact" only ever
//     appears on an agent's own dated commitment. canOfferChannel() below is
//     the single place the UI decides whether a channel affordance may be
//     rendered, and it fails closed.
//   - signalSummary, so the screen can say what it is NOT showing rather than
//     pretending the held-back items do not exist.

import { COMMITMENT_LABEL, DUE_FOLLOW_UP_LABEL } from "./growTerms";

export const GROW_TODAY_PRIORITIES = ["DoNow", "DoToday", "KeepWarm"] as const;
export type GrowTodayPriority = (typeof GROW_TODAY_PRIORITIES)[number];

export type GrowTodayActionType =
  | "opportunity_follow_up"
  | "opportunity_no_action_set"
  | "relationship_cold"
  | "appraisal_follow_up"
  | "property_intelligence_signal"
  // F-1 — mirrors the API. An Open growCommitments row due today or overdue.
  | "commitment";

export type GrowTodayContactability = "contactable" | "do_not_contact";

export type GrowTodayActionButton =
  | { action: "add_note" }
  | { action: "view_property"; propertyId: number }
  | { action: "update_next_action"; opportunityId: number }
  | { action: "ask_ae" }
  // AE Grow Priority 3 — additive: rendered only when the contact has that channel on file
  // (email/sms) or unconditionally (view_contact, since partyId is always present).
  | { action: "email"; partyId: number }
  | { action: "sms"; partyId: number }
  | { action: "view_contact"; partyId: number }
  | { action: "view_appraisal"; appraisalId: number };

/** One itemised contribution to a signal's rank, mirroring SignalRankingFactor. */
export interface GrowTodayRankingFactor {
  label: string;
  detail: string;
  points: number;
}

/**
 * AE GROW COMPLETION PROGRAM W2-A — mirrors GrowTodayRelatedSignal. A signal
 * AE holds for this contact that did NOT become the card, carried on the card
 * that did so the evidence is visible rather than silently dropped.
 *
 * OPTIONAL ON THIS SIDE, DELIBERATELY. The API always sends it, but this
 * mirror is hand-maintained and this file already commits to not crashing on
 * an older API response (see signalWithholdingNotice's own test).
 */
export interface GrowTodayRelatedSignal {
  signalId: number;
  signalType: string;
  title: string;
  explanation: string;
  confidenceBand: string;
  confidenceBandLabel: string;
  rankScore: number;
  relationship: "consolidated_into_this_card" | "withheld_by_daily_cap";
}

/**
 * Mirrors GrowTodayWhyItMatters.
 *
 * W2-A — NO LONGER SIGNAL-ONLY, and the two band fields are NULLABLE because
 * of it. A Rule D cold-contact card now carries an explanation too (it has to:
 * when a cap withholds a contact's signal, this card is what the agent is left
 * with), and a cold-contact card is a date comparison rather than a scored
 * inference, so it has no confidence band. rankSummaryLine() below keys off
 * exactly that null to keep a bare "priority N/100" off such a card.
 */
export interface GrowTodayWhyItMatters {
  headline: string;
  talkingPoint: string | null;
  caution: string;
  confidenceBand: string | null;
  confidenceBandLabel: string | null;
  factors: GrowTodayRankingFactor[];
  relatedSignals?: GrowTodayRelatedSignal[];
}

export interface GrowTodayAction {
  id: string;
  type: GrowTodayActionType;
  priority: GrowTodayPriority;
  /** Null on a signal that is anchored to a property with no linked contact. */
  partyId: number | null;
  contactName: string;
  // AE Grow Priority 3 — additive: lets the frontend decide whether to render an Email/SMS
  // action without a second lookup. Stage 3: the API forces both to null when contactability
  // is "do_not_contact", so a channel affordance is impossible to render for such a contact
  // even if this file's own guard were removed.
  contactEmail: string | null;
  contactMobile: string | null;
  relationshipType: string | null;
  propertyId: number | null;
  propertyLabel: string | null;
  opportunityId: number | null;
  appraisalId: number | null;
  /** F-1 — the growCommitments row. Null on every other card kind. */
  commitmentId: number | null;
  reason: string;
  recommendedAction: string;
  dueAt: string | null;
  lastActivityAt: string | null;
  availableActions: GrowTodayActionButton[];
  rankScore: number;
  confidenceBand: string | null;
  contactability: GrowTodayContactability;
  contactabilityNote: string | null;
  whyItMatters: GrowTodayWhyItMatters | null;
}

export interface GrowTodaySignalSummary {
  surfaced: number;
  emergingSurfaced: number;
  emergingWithheld: number;
  withheldDoNotContact: number;
  /**
   * W2-A — the three fields below are OPTIONAL on this side on purpose. The
   * API always sends them, but this mirror has drifted behind the API twice
   * before (see this file's header), and the failure mode for a display
   * helper reading a field an older server did not send must be "say nothing
   * about it", never "throw while rendering the day".
   */
  /** Signals folded into a stronger sibling's card for the same contact. */
  consolidatedIntoStrongerSignal?: number;
  /** Cards of any rule dropped by the server's total priority-action cap. */
  withheldByActionCap?: number;
  /** Plain-language statements of what the server's reads were bounded by. */
  limitations?: string[];
}

/**
 * G-UAT-7 — mirrors GrowTodayFirstRun. The API always sends it. Optional
 * here so an older Today payload still renders: a missing block hides the
 * checklist rather than throwing.
 */
export interface GrowTodayFirstRun {
  contact: boolean;
  propertyLink: boolean;
  activity: boolean;
  commitment: boolean;
  opportunity: boolean;
  appraisal: boolean;
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
  signalSummary: GrowTodaySignalSummary;
  firstRun?: GrowTodayFirstRun;
}

/**
 * G-6 — a due follow-up (opportunity next action or appraisal follow-up) and
 * an Open commitment are different records, so each card says which one it is.
 * Cold contacts, signals, and opportunities with no next action are neither.
 */
export function actionTypeLabel(type: GrowTodayActionType): string | null {
  if (type === "commitment") return COMMITMENT_LABEL;
  if (type === "opportunity_follow_up" || type === "appraisal_follow_up") return DUE_FOLLOW_UP_LABEL;
  return null;
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

/* ---------------------------------------------------------------------
 * Stage 3 — consent display. ONE function decides whether a contact channel
 * may be offered, and it fails closed.
 * -----------------------------------------------------------------*/

/**
 * Whether the UI may render an Email/SMS affordance for this card.
 *
 * Three conditions, ALL required: the action must not be marked
 * do_not_contact, it must have a real contact to act on, and the channel must
 * actually be on file. The server already withholds prospecting items for a
 * suppressed contact and nulls their contact fields, so this is the third
 * independent guard rather than the only one — but it is the one the
 * rendering code calls, and it is written so that an unrecognised
 * contactability value is treated as "not contactable".
 */
export function canOfferChannel(action: GrowTodayAction, channel: "email" | "sms"): boolean {
  if (action.contactability !== "contactable") return false;
  if (action.partyId === null) return false;
  const value = channel === "email" ? action.contactEmail : action.contactMobile;
  if (value === null || value.trim() === "") return false;
  return action.availableActions.some((b) => b.action === channel);
}

/** Whether a contact-anchored affordance (add note, view contact) is meaningful at all. */
export function hasLinkedContact(action: GrowTodayAction): boolean {
  return action.partyId !== null;
}

/**
 * The banner a do-not-contact card shows, or null. Deliberately returns the
 * server's own note verbatim when present rather than re-wording a consent
 * decision in the frontend, with a fixed fallback so a card can never be
 * marked do_not_contact and still render silently.
 */
export function contactabilityNotice(action: GrowTodayAction): string | null {
  if (action.contactability === "contactable") return null;
  return (
    action.contactabilityNote ??
    "This contact must not be contacted. Review the contact record before taking any action."
  );
}

/* ---------------------------------------------------------------------
 * Stage 3 — explainability display.
 * -----------------------------------------------------------------*/

/**
 * The lines that make the rank score legible. Returns [] when there is
 * nothing to explain, which is the signal to render NOTHING — in particular,
 * never to render the bare number on its own. A score without its factors is
 * not an explanation, and this function is the only supported way to get it
 * onto the screen.
 */
export function rankExplanationLines(action: GrowTodayAction): string[] {
  if (action.whyItMatters === null) return [];
  const lines = action.whyItMatters.factors
    .filter((f) => f.points !== 0)
    .map((f) => `${f.points > 0 ? "+" : "−"}${Math.abs(f.points)} · ${f.label} — ${f.detail}`);

  // W2-A — THE EVIDENCE AE DID NOT MAKE THE CARD OUT OF, on the card it did
  // make. Rendered HERE, in the existing explanation block, rather than behind
  // a new component nobody has wired up yet: a consolidated or withheld signal
  // that exists in the API response but appears nowhere on the screen is
  // indistinguishable, to the agent, from one that was thrown away.
  //
  // No points on these lines. A related signal contributed nothing to THIS
  // card's score — it is a separate piece of evidence about the same person,
  // and showing it with a "+N" would imply it had been added in.
  for (const related of action.whyItMatters.relatedSignals ?? []) {
    const why =
      related.relationship === "consolidated_into_this_card"
        ? "also on file for this contact; AE showed the stronger of the two"
        : "also on file for this contact; held back by today's limit";
    lines.push(`${related.title} (${related.confidenceBandLabel}) — ${why}. ${related.explanation}`);
  }
  return lines;
}

/**
 * The one-line "how strongly does AE hold this" summary shown next to the
 * band. Never a percentage and never a probability: the score orders a list,
 * it does not predict a sale.
 *
 * W2-A — RETURNS NULL FOR A CARD WITH NO CONFIDENCE BAND, which is the guard
 * that stops a Rule D cold-contact card from displaying a priority score.
 * Rule D cards started carrying a whyItMatters so they could explain
 * themselves when a cap withholds a contact's signal; this function used to
 * render "priority N/100" for ANY non-null whyItMatters, so without this check
 * a plain "no contact recorded for 240 days" threshold rule would have begun
 * presenting itself to agents as a scored inference. It is not one, and a
 * rank that orders a list is not a number an agent should be reading off a
 * card that has no evidence behind it.
 */
export function rankSummaryLine(action: GrowTodayAction): string | null {
  if (action.whyItMatters === null) return null;
  if (action.whyItMatters.confidenceBandLabel === null || action.whyItMatters.confidenceBand === null) return null;
  return `${action.whyItMatters.confidenceBandLabel} · priority ${action.rankScore}/100 (ranking only — not a prediction that this contact is selling)`;
}

/**
 * What Today is deliberately NOT showing, in one sentence, or null when it is
 * showing everything. Keeping this honest is the point: a capped or withheld
 * item must never just vanish.
 */
export function signalWithholdingNotice(summary: GrowTodaySignalSummary | undefined): string | null {
  if (!summary) return null;
  const parts: string[] = [];
  if (summary.emergingWithheld > 0) {
    parts.push(
      `${summary.emergingWithheld} more early ${summary.emergingWithheld === 1 ? "signal is" : "signals are"} held back to keep today readable`,
    );
  }
  if (summary.withheldDoNotContact > 0) {
    parts.push(
      `${summary.withheldDoNotContact} ${summary.withheldDoNotContact === 1 ? "signal is" : "signals are"} withheld because the contact must not be contacted`,
    );
  }
  // W2-A — consolidation is reported alongside the withholding reasons
  // because from the agent's side it has the same shape: something AE knows
  // is not on the screen as its own card. It is phrased differently because it
  // is a different thing — the evidence IS on the screen, folded into the card
  // for that same contact, and the "why it matters" block lists it.
  const consolidated = summary.consolidatedIntoStrongerSignal ?? 0;
  if (consolidated > 0) {
    parts.push(
      `${consolidated} ${consolidated === 1 ? "signal was" : "signals were"} merged into a stronger signal for the same contact, so nobody appears twice`,
    );
  }
  const cappedActions = summary.withheldByActionCap ?? 0;
  if (cappedActions > 0) {
    parts.push(
      `${cappedActions} lower-priority ${cappedActions === 1 ? "item is" : "items are"} not shown because today's list is capped`,
    );
  }
  const limitations = summary.limitations ?? [];
  if (parts.length === 0 && limitations.length === 0) return null;

  const sentences: string[] = [];
  if (parts.length > 0) {
    sentences.push(`${parts.join("; ")}. ${parts.length === 1 ? "It is" : "They are"} still visible on the contact and property records.`);
  }
  // Stated verbatim, never summarised into a count: the server wrote each of
  // these to name a specific bound and where the full list lives, and
  // compressing that back into "some things are hidden" would throw away the
  // only part an agent can act on.
  sentences.push(...limitations);
  return sentences.join(" ");
}

/**
 * Card heading suffix for a signal with no linked contact, so the agent is
 * never left wondering why the contact actions are missing.
 */
export function unlinkedContactNotice(action: GrowTodayAction): string | null {
  if (action.partyId !== null) return null;
  return "No contact is linked to this signal yet — review it on the property record.";
}
