// Product navigation is defined here rather than being re-derived in App.tsx. This keeps the
// information architecture and the existing role gates in one small, testable module.
//
// A navigation destination must be a real route or an existing tab state. In particular, Grow's
// tabs are not promoted to new top-level wouter routes: they are deep links to /grow with the
// tab query parameter that GrowWorkspace owns.
//
// Role vs entitlement remains deliberately separate. Grow's existing /grow entry point is
// visible to every role (the page itself explains the locked state when Grow is not active), while
// Pit Crew and Financial retain their pre-existing role gates. The Grow import page is an
// additional shortcut only for a brokerage that has Grow access plus at least one of the actual
// import permissions (review or execute).
export interface NavLink {
  path: string;
  label: string;
  /**
   * Optional hint for consumers that need to distinguish a plain page link from a tab deep link.
   * It is metadata only; `path` remains the canonical href.
   */
  kind?: "page" | "grow-tab";
}

export interface NavContext {
  role: string | undefined;
  entitlements: string[];
}

export type NavGroupId = "today" | "grow" | "run" | "support" | "system";

export interface NavGroup {
  id: NavGroupId;
  label: string;
  /** The links shown in this group, in deliberate product order. */
  links: NavLink[];
  /** Today is intentionally a standalone destination, not a Run child. */
  standalone?: boolean;
}

export interface QuickAction {
  label: string;
  path: string;
  description: string;
}

export function hasEntitlement(ctx: NavContext, key: string): boolean {
  return ctx.entitlements.includes(key);
}

function canUseImportShortcut(ctx: NavContext): boolean {
  return (
    hasEntitlement(ctx, "grow.access") &&
    (hasEntitlement(ctx, "grow.import.review") || hasEntitlement(ctx, "grow.import.execute"))
  );
}

const growTabLinks: NavLink[] = [
  { path: "/grow?tab=today", label: "Today", kind: "grow-tab" },
  { path: "/grow?tab=opportunities", label: "Opportunities", kind: "grow-tab" },
  { path: "/grow?tab=contacts", label: "Contacts", kind: "grow-tab" },
  { path: "/grow?tab=nurture", label: "Nurture", kind: "grow-tab" },
  { path: "/grow?tab=performance", label: "Performance", kind: "grow-tab" },
  { path: "/grow?tab=askAE", label: "Ask AE", kind: "grow-tab" },
];

/**
 * Build the grouped sidebar destinations.
 *
 * Today is intentionally first and standalone. Home remains a real, directly-addressable deep
 * link under Run; it is not replaced by a redirect to Today. The two role gates below are the
 * exact gates that existed before the grouped navigation was introduced.
 */
export function buildProductNavGroups(ctx: NavContext): NavGroup[] {
  const canSeePitCrew = ctx.role === "Pit Crew" || ctx.role === "Brokerage Administrator";
  const canSeeFinancial = ctx.role === "Brokerage Administrator";
  return [
    {
      id: "today",
      label: "Today",
      standalone: true,
      links: [{ path: "/today", label: "Today", kind: "page" }],
    },
    {
      id: "grow",
      label: "Grow",
      links: [
        ...growTabLinks,
        { path: "/communications", label: "Communications", kind: "page" },
        ...(canUseImportShortcut(ctx)
          ? [{ path: "/grow/import", label: "Import contacts & properties", kind: "page" as const }]
          : []),
      ],
    },
    {
      id: "run",
      label: "Run",
      links: [
        { path: "/", label: "Home", kind: "page" },
        { path: "/properties", label: "Properties", kind: "page" },
        { path: "/exceptions", label: "Exceptions", kind: "page" },
        ...(canSeeFinancial ? [{ path: "/financial", label: "Financial", kind: "page" as const }] : []),
      ],
    },
    {
      id: "support",
      label: "Support",
      links: canSeePitCrew ? [{ path: "/pit-crew", label: "Pit Crew", kind: "page" }] : [],
    },
    {
      id: "system",
      label: "System Settings",
      links: [{ path: "/settings", label: "Settings", kind: "page" }],
    },
  ];
}

/**
 * Compatibility helper for callers that need all destinations as one list. App.tsx renders
 * `buildProductNavGroups` so the grouping is retained in the UI; this helper intentionally does
 * not add any routes beyond those groups.
 */
export function buildProductNavLinks(ctx: NavContext): NavLink[] {
  return buildProductNavGroups(ctx).flatMap((group) => group.links);
}

// Entitlement-aware post-login landing:
//   - Grow-entitled users land directly in Grow.
//   - Everyone else uses the Today command centre as the safe default.
//   - Pit Crew keeps the pre-existing Home landing exception.
// Home remains a deep link in Run and is never removed or redirected.
export function resolveLandingRoute(ctx: NavContext): "/" | "/today" | "/grow" {
  if (ctx.role === "Pit Crew") return "/";
  return hasEntitlement(ctx, "grow.access") ? "/grow" : "/today";
}

/**
 * Quick actions are intentionally conservative: each item opens a route that already exists.
 * There is no standalone create-contact or create-opportunity screen in this build, so neither
 * is represented here. Start Property comes first as the primary existing creation workflow.
 */
export function buildQuickActions(ctx: NavContext): QuickAction[] {
  return [
    {
      label: "Start Property",
      path: "/properties/start",
      description: "Create a property from an address",
    },
    ...(hasEntitlement(ctx, "grow.access") && hasEntitlement(ctx, "grow.import.execute")
      ? [
          {
            label: "Import contacts & properties",
            path: "/grow/import",
            description: "Bring existing records into Grow",
          },
        ]
      : []),
  ];
}