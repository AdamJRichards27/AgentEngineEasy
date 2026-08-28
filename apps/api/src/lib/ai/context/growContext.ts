import type { GrowContext } from "../types.js";

// Placeholder interface only, per the Build Instructions' explicit stop point:
// architect the shape a future Grow module will populate, do not build Grow
// itself. Always returns null in this build - see the completion report's
// GROW READINESS section for what a real implementation would need to change.
export async function buildGrowContext(_brokerageId: number): Promise<GrowContext | null> {
  return null;
}
