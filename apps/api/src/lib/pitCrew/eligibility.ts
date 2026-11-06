// Pit Crew D1/D2 eligibility scaffolding (Owner t165u). Pure, no I/O, not
// wired into any enforcement path. It encodes ONLY decided policy; every case
// that depends on an open Owner decision returns UNDETERMINED with the open
// item id from evidence PITCREW-D1-D4-MATRIX-t165u.md. Do not turn an
// UNDETERMINED into ELIGIBLE/NOT_ELIGIBLE without an Owner decision.
//
// Decided (quotes):
// - "Preserve the approved hybrid emerging/performing agent eligibility model."
// - "For emerging agents, pre-listing support requires a confirmed appraisal or
//   listing presentation appointment."
// - "General administration and speculative seller opportunities are excluded."

export const PIT_CREW_AGENT_CLASSES = ["PERFORMING", "EMERGING"] as const;
export type PitCrewAgentClass = (typeof PIT_CREW_AGENT_CLASSES)[number];

/** Categories named by the Owner as excluded (t165u). The full list is open (D2.2). */
export const PIT_CREW_OWNER_EXCLUDED_CATEGORIES = ["GENERAL_ADMINISTRATION", "SPECULATIVE_SELLER_OPPORTUNITY"] as const;

export const PIT_CREW_SERVICE_CATEGORIES = [
  "PRE_LISTING",
  ...PIT_CREW_OWNER_EXCLUDED_CATEGORIES,
  // Everything else is "OTHER" until the covered list (D2.3) is decided.
  "OTHER",
] as const;
export type PitCrewServiceCategory = (typeof PIT_CREW_SERVICE_CATEGORIES)[number];

export type PitCrewEligibilityReason =
  | "OWNER_EXCLUDED_CATEGORY"
  | "EMERGING_NO_CONFIRMED_APPOINTMENT"
  | "EMERGING_CONFIRMED_APPOINTMENT";

/** Open matrix items an UNDETERMINED result is waiting on. */
export type PitCrewOpenItem = "D1.5" | "D1.6" | "D1.7" | "D1.8" | "D2.3";

export type PitCrewEligibilityResult =
  | { decision: "ELIGIBLE"; reason: PitCrewEligibilityReason }
  | { decision: "NOT_ELIGIBLE"; reason: PitCrewEligibilityReason }
  | { decision: "UNDETERMINED"; openItems: PitCrewOpenItem[] };

export interface PitCrewEligibilityInput {
  /** null = not classified (classification rules D1.7/D1.8 are open). */
  agentClass: PitCrewAgentClass | null;
  category: PitCrewServiceCategory;
  /**
   * Whether a confirmed appraisal or listing-presentation appointment exists.
   * What counts and where it is read from is open (D1.9); the caller decides.
   */
  hasConfirmedAppointment: boolean;
}

export function evaluatePitCrewEligibility(input: PitCrewEligibilityInput): PitCrewEligibilityResult {
  const excluded = (PIT_CREW_OWNER_EXCLUDED_CATEGORIES as readonly string[]).includes(input.category);

  if (input.agentClass === "EMERGING") {
    if (excluded) return { decision: "NOT_ELIGIBLE", reason: "OWNER_EXCLUDED_CATEGORY" };
    if (input.category === "PRE_LISTING") {
      return input.hasConfirmedAppointment
        ? { decision: "ELIGIBLE", reason: "EMERGING_CONFIRMED_APPOINTMENT" }
        : { decision: "NOT_ELIGIBLE", reason: "EMERGING_NO_CONFIRMED_APPOINTMENT" };
    }
    return { decision: "UNDETERMINED", openItems: ["D2.3"] };
  }

  if (input.agentClass === "PERFORMING") {
    // Whether the exclusions and the appointment condition also bind
    // performing agents is not stated (D1.5, D1.6).
    if (excluded) return { decision: "UNDETERMINED", openItems: ["D1.6"] };
    if (input.category === "PRE_LISTING") return { decision: "UNDETERMINED", openItems: ["D1.5"] };
    return { decision: "UNDETERMINED", openItems: ["D2.3"] };
  }

  // Unclassified agent: which class applies is open.
  return { decision: "UNDETERMINED", openItems: ["D1.7", "D1.8"] };
}
