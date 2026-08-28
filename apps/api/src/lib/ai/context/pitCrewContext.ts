import type { PitCrewContext } from "../types.js";

// Placeholder interface only (see growContext.ts for the same pattern). The AML
// route already exposes GET /aml/service-orders-by-property/:propertyId, which a
// real Pit Crew AI build would read from here; this build leaves it unread.
export async function buildPitCrewContext(_brokerageId: number): Promise<PitCrewContext | null> {
  return null;
}
