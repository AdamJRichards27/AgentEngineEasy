import { buildProductNavLinks, type NavContext, type NavLink } from "../lib/productNav";

// AE Minimal A sidebar and mobile bar links (Owner D5): Run is linked subject
// to permissions. Every Run surface is shown only with the exact run.access
// entitlement, on top of the product nav's own role rules (Financial, Pit
// Crew). Fails closed: no entitlement list means no Run links. Access is
// still enforced server-side by requireEntitlement("run.access"); this only
// stops the shell offering screens the brokerage has not got.

export const RUN_ACCESS = "run.access";

/**
 * Run screens, hidden without run.access (Owner D5). UI gating only: exceptions,
 * financial and pit-crew APIs enforce run.access, but GET/POST /properties and
 * /home/summary do not today (server follow-up, outside WS1).
 */
export const MINIMAL_RUN_PATHS: readonly string[] = [
  "/",
  "/today",
  "/properties",
  "/properties/start",
  "/exceptions",
  "/financial",
  "/pit-crew",
];

export function minimalHasRunAccess(entitlements: readonly string[] | null | undefined): boolean {
  return Array.isArray(entitlements) && entitlements.includes(RUN_ACCESS);
}

export function buildMinimalNavLinks(ctx: NavContext): NavLink[] {
  const links = [...buildProductNavLinks(ctx), { path: "/properties/start", label: "Start property" }];
  if (minimalHasRunAccess(ctx.entitlements)) return links;
  return links.filter((link) => !MINIMAL_RUN_PATHS.includes(link.path));
}

/**
 * Classic sidebar (App.tsx) gets the same Owner D5 rule: without run.access the
 * Run links and the Start Property button are not offered. UI gating only;
 * the server-side Run route restrictions land separately and must follow this.
 */
export function buildClassicNavLinks(ctx: NavContext): NavLink[] {
  const links = buildProductNavLinks(ctx);
  if (minimalHasRunAccess(ctx.entitlements)) return links;
  return links.filter((link) => !MINIMAL_RUN_PATHS.includes(link.path));
}

/**
 * Owner D5 for in-page links: true when a link target is a Run screen, i.e. one
 * of MINIMAL_RUN_PATHS or a sub-path of /properties (the property workspace).
 */
export function isRunPath(href: string): boolean {
  const path = href.split(/[?#]/)[0] || "/";
  if (MINIMAL_RUN_PATHS.includes(path)) return true;
  return path.startsWith("/properties/");
}

/**
 * Whether an in-page link may be offered. Run targets need the exact run.access
 * entitlement and fail closed while entitlements are still loading.
 */
export function runLinkAllowed(href: string, entitlements: readonly string[] | null | undefined, loading: boolean): boolean {
  if (!isRunPath(href)) return true;
  return !loading && minimalHasRunAccess(entitlements);
}

// ── AE Minimal v1.0 V1: grouped sidebar (Owner t457u) ───────────────────────
// Three labelled groups (Grow, Operations, Workspace) in one primary nav. Gates
// are unchanged: the shell is still AE_MINIMAL_UX_ENABLED + allowlist, Run items
// need run.access, role rules come from buildProductNavLinks, and Market
// Activity / My Momentum only show when their (flag-gated) APIs answer.

export type MinimalSidebarItem =
  | { kind: "link"; key: string; path: string; href: string; label: string; children?: MinimalSidebarItem[] }
  | { kind: "soon"; key: string; label: string; icon: string; children?: MinimalSidebarItem[] };

export interface MinimalSidebarGroup {
  key: "grow" | "operations" | "workspace";
  label: string;
  items: MinimalSidebarItem[];
}

export interface MinimalSidebarContext extends NavContext {
  /** True only when the cached Market Activity query has succeeded. */
  marketActivityAvailable: boolean;
  /** True only when the cached My Momentum query has succeeded. */
  momentumAvailable: boolean;
}

export const GROW_ACCESS = "grow.access";

/** Label for non-clickable placeholders (Owner t147u). */
export const MINIMAL_COMING_SOON = "Coming Soon";

export const MINIMAL_MARKETING_SOON: readonly string[] = ["Overview", "Email", "SMS", "Social"];

/** V7 (Owner t457u): Marketing pages for grow.access users. Sample previews only, nothing is sent. */
export const MINIMAL_MARKETING_LINKS: readonly { label: string; href: string }[] = [
  { label: "Overview", href: "/grow/marketing/overview" },
  { label: "Email", href: "/grow/marketing/email" },
  { label: "SMS", href: "/grow/marketing/sms" },
  { label: "Social", href: "/grow/marketing/social" },
];

function link(path: string, label: string, href: string = path): MinimalSidebarItem {
  return { kind: "link", key: href, path, href, label };
}

/** Marketing: V7 sample pages with grow.access, Coming Soon placeholders otherwise (CC #54). */
export function buildMinimalSidebar(ctx: MinimalSidebarContext): MinimalSidebarGroup[] {
  const run = minimalHasRunAccess(ctx.entitlements);
  const product = buildProductNavLinks(ctx).map((l) => l.path);
  const grow: MinimalSidebarItem[] = [
    link("/grow", "Today"),
    link("/grow", "Relationships", "/grow?tab=contacts"),
    link("/grow/opportunities", "Opportunities"),
    link("/grow/appraisals", "Appraisals"),
  ];
  if (ctx.marketActivityAvailable) grow.push(link("/grow/market-activity", "Market Activity"));
  if (ctx.momentumAvailable) grow.push(link("/grow/momentum", "My Momentum"));
  // Owner t147u (D5 revised): Properties is a Grow surface for Grow-entitled users
  // (property records, intelligence, appraisals). Run-only operations inside it stay
  // gated on run.access (operation-level), and the server keeps enforcing both.
  if (run || ctx.entitlements.includes(GROW_ACCESS)) grow.push(link("/properties", "Properties"));
  // V7: Marketing pages need grow.access; without it the placeholder stays.
  if (ctx.entitlements.includes(GROW_ACCESS)) {
    grow.push({
      kind: "link",
      key: "marketing",
      path: "/grow/marketing",
      href: "/grow/marketing",
      label: "Marketing",
      children: MINIMAL_MARKETING_LINKS.map((l) => link(l.href, l.label)),
    });
  } else {
    grow.push({
      kind: "soon",
      key: "marketing",
      label: "Marketing",
      icon: "marketing",
      children: MINIMAL_MARKETING_SOON.map((label) => ({ kind: "soon" as const, key: `marketing-${label.toLowerCase()}`, label, icon: "dot" })),
    });
  }

  const operations: MinimalSidebarItem[] = [];
  if (run) {
    operations.push(link("/", "Run home"), link("/today", "Run today"), link("/exceptions", "Exceptions"));
    if (product.includes("/financial")) operations.push(link("/financial", "Financial"));
    operations.push(link("/properties/start", "Start property"));
    if (product.includes("/pit-crew")) operations.push(link("/pit-crew", "Pit Crew"));
  } else {
    operations.push({ kind: "soon", key: "run-soon", label: "Run", icon: "/" });
    operations.push({ kind: "soon", key: "pit-crew-soon", label: "Pit Crew", icon: "/pit-crew" });
  }

  return [
    { key: "grow", label: "Grow", items: grow },
    { key: "operations", label: "Operations", items: operations },
    { key: "workspace", label: "Workspace", items: [link("/communications", "Communications"), link("/settings", "Settings")] },
  ];
}

/** Flat list of clickable sidebar links (breadcrumb and mobile bar). */
export function minimalSidebarLinks(groups: readonly MinimalSidebarGroup[]): { path: string; href: string; label: string }[] {
  const out: { path: string; href: string; label: string }[] = [];
  const walk = (items: readonly MinimalSidebarItem[]) => {
    for (const item of items) {
      if (item.kind === "link") out.push({ path: item.path, href: item.href, label: item.label });
      if (item.children) walk(item.children);
    }
  };
  for (const g of groups) walk(g.items);
  return out;
}

/**
 * Minimal-specific active matcher. Today is active only on /grow itself (not on
 * the contacts tab); Relationships on /grow?tab=contacts and Contact 360;
 * Opportunities also on /grow/opportunities/:id; Properties on the Grow property
 * detail (/grow/properties/:id, Owner t148u) and /properties/:id.
 */
export function minimalSidebarIsCurrent(location: string, search: string, href: string): boolean {
  const path = location.split("?")[0].split("#")[0] || "/";
  const tab = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("tab");
  switch (href) {
    case "/grow":
      return path === "/grow" && (tab === null || tab === "today");
    case "/grow?tab=contacts":
      return (path === "/grow" && tab === "contacts") || /^\/grow\/contacts\/[^/]+\/?$/.test(path);
    case "/grow/opportunities":
      return /^\/grow\/opportunities(\/[^/]+)?\/?$/.test(path);
    case "/grow/appraisals":
      return /^\/grow\/appraisals(\/.*)?$/.test(path);
    case "/properties":
      return (
        path === "/properties" ||
        (path.startsWith("/properties/") && path !== "/properties/start") ||
        /^\/grow\/properties\/[^/]+\/?$/.test(path)
      );
    case "/settings":
      return path === "/settings" || path.startsWith("/settings/");
    default:
      return path === href;
  }
}
