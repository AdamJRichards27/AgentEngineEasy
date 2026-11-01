import { BUSINESS_COACH_HREF, type MobileNav } from "./mobileNavModel";

// AE Mobile (CC Task #64, M2): the Business Coach entry in More, only where it works. The navigation model offers it with the
// grow.ai.use entitlement. Found in the real app: an entitled brokerage can still have the coach switched off for the deployment
// (GET /ai/capabilities businessCoachEnabled), and the tab then says "isn't enabled for this brokerage": a menu item that leads
// nowhere. So the phone lists it only when the capability probe says it is on. Fails closed: unknown, loading or failed hides it.
// Pure: no React, no network. The probe is the same query AskAgentEngine already runs, so it is shared, not repeated.

export function applyCoachAvailability(nav: MobileNav, coachEnabled: boolean): MobileNav {
  if (coachEnabled) return nav;
  const keep = (i: { href: string }) => i.href !== BUSINESS_COACH_HREF;
  const moreGroups = nav.moreGroups.map((g) => ({ ...g, items: g.items.filter(keep) })).filter((g) => g.items.length > 0);
  return { ...nav, more: nav.more.filter(keep), moreGroups };
}
