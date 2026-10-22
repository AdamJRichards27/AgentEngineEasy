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
