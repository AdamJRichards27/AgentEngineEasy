// AE GROW Pilot Readiness WP6b — pure logic behind AskAgentEngine's feature
// flag / entitlement gate (GET /ai/capabilities).
//
// The defect this exists to fix (WP6b P3-b): when businessCoachEnabled is
// false, AskAgentEngine returned null, so Grow's Performance *tab* rendered a
// completely blank page — the agent clicked a tab and got nothing, with no way
// to tell that apart from a broken screen. A Grow tab is a destination of its
// own and must always say something; RUN Copilot's embedded panel (on a
// property/transaction record) is an optional extra on a page that is already
// full of content, so hiding it there stays exactly as it was.

export type AiSurfaceAvailability = "available" | "hidden" | "unavailable";

export interface AiCapabilitiesLike {
  copilotEnabled: boolean;
  businessCoachEnabled: boolean;
}

export interface AiSurface {
  isGrow: boolean;
  isCoach: boolean;
}

/**
 * `undefined` capabilities means the probe hasn't returned yet — the surface
 * renders as before rather than flashing a "not enabled" message at every
 * agent on every load.
 */
export function aiSurfaceAvailability(capabilities: AiCapabilitiesLike | undefined, surface: AiSurface): AiSurfaceAvailability {
  if (capabilities === undefined) return "available";
  const enabled = surface.isCoach ? capabilities.businessCoachEnabled : capabilities.copilotEnabled;
  if (enabled) return "available";
  return surface.isGrow ? "unavailable" : "hidden";
}

/** What a Grow surface says when its own feature flag is off. */
export function aiSurfaceUnavailableCopy(isCoach: boolean): { title: string; body: string } {
  return isCoach
    ? {
        title: "Business Coach",
        body: "The AI Business Coach isn’t enabled for this brokerage, so there’s nothing to show here. Ask a Brokerage Administrator to enable it if you believe this is wrong — the rest of Grow is unaffected.",
      }
    : {
        title: "Ask AE",
        body: "Ask AE isn’t enabled for this brokerage, so there’s nothing to show here. Ask a Brokerage Administrator to enable it if you believe this is wrong — the rest of Grow is unaffected.",
      };
}
