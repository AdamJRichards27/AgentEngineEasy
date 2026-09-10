// AE GROW Priority 0.5 — Workstream 2: Grow-first main navigation, single central definition.
//
// Product hierarchy: GROW (find the business) -> RUN (deliver the business) -> SCALE (manage
// the business, not yet built — see docs/AE_GROW_PRIORITY_0_5_FOUNDATION_REPORT.md). Grow is
// deliberately always first in buildProductNavLinks' returned order below, per that report's
// mandatory "Grow must be the #1 product selection" requirement — a deliberate product decision,
// not cosmetic menu ordering — so it is centralised here rather than re-derived (and potentially
// reordered by accident) in App.tsx or any future navigation surface.
//
// Role vs entitlement — do not confuse these (see the Priority 0.5 task's own "Mandatory
// principle"): ROLE answers "what is this user allowed to do" (Pit Crew link only for Pit
// Crew/Brokerage Administrator, Financial only for Brokerage Administrator — unchanged from
// before this phase). ENTITLEMENT answers "which AE products has this brokerage purchased."
//
// Grow is NOT role- or entitlement-hidden by this file: every role could already reach /grow
// before this phase, and the backend does not yet enforce grow.access on Grow's existing routes
// (true before this phase, unchanged by it — Workstream 3 only introduced run.access
// enforcement on the RUN surface). Hiding the Grow link here based on entitlement, with no
// matching backend gate, would be exactly the "product gating relies solely on frontend hiding"
// outcome Priority 0.5's Stop Condition 3 forbids. This file therefore only controls ORDERING
// and the post-login LANDING route — both UX-only, with no security implication either way.
export interface NavLink {
  path: string;
  label: string;
}

export interface NavContext {
  role: string | undefined;
  entitlements: string[];
}

export function hasEntitlement(ctx: NavContext, key: string): boolean {
  return ctx.entitlements.includes(key);
}

// Central ordering: Grow first, then every existing RUN link in its established order (Home,
// Today, Properties, Exceptions, Communications, Financial*, Pit Crew*), Settings last. No Scale
// entries — Scale does not exist yet (Priority 0.5 explicitly forbids building it) and no
// placeholder link is added for it. Role gates for Financial/Pit Crew are a straight extraction
// of App.tsx's pre-existing canSeeFinancial/canSeePitCrew checks — not a behaviour change.
export function buildProductNavLinks(ctx: NavContext): NavLink[] {
  const canSeePitCrew = ctx.role === "Pit Crew" || ctx.role === "Brokerage Administrator";
  const canSeeFinancial = ctx.role === "Brokerage Administrator";
  return [
    { path: "/grow", label: "Grow" },
    { path: "/", label: "Home" },
    { path: "/today", label: "Today" },
    { path: "/properties", label: "Properties" },
    { path: "/exceptions", label: "Exceptions" },
    { path: "/communications", label: "Communications" },
    ...(canSeeFinancial ? [{ path: "/financial", label: "Financial" }] : []),
    ...(canSeePitCrew ? [{ path: "/pit-crew", label: "Pit Crew" }] : []),
    { path: "/settings", label: "Settings" },
  ];
}

// Entitlement-aware post-login landing (Priority 0.5 Workstream 2's "Default Post-Login
// Experience"):
//   - Grow-only customer: lands directly in Grow.
//   - Grow + Run customer: Grow remains first commercially, so they land in Grow too — never
//     forced through Run first merely because Run functionality exists.
//   - Run-only legacy/customer configuration (the common case today via the run.access
//     backfill — see apps/api/src/lib/billing/runAccessBackfill.ts): falls back to "/",
//     unchanged from this app's pre-existing behaviour. This is the safe fallback both Stop
//     Condition 7 and the task's own "Run-only legacy/customer configuration" rule require — no
//     existing user's landing experience regresses.
//   - Pit Crew: deliberately NOT routed into Grow merely because Grow is commercially first —
//     see the role check below. Preserves genuine Pit Crew operational routing (Stop
//     Condition 7). Brokerage Administrator is unaffected by this exception: their product
//     experience still depends on brokerage entitlements, per the task's own "Brokerage
//     Administrator" landing rule.
export function resolveLandingRoute(ctx: NavContext): "/grow" | "/" {
  if (ctx.role === "Pit Crew") return "/";
  return hasEntitlement(ctx, "grow.access") ? "/grow" : "/";
}
