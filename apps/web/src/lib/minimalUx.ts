import { useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "./api";
import { navLinkIsActive } from "./productNav";

// Client reading of the server session payload. The shell renders only when
// the server says this user is eligible AND the resolved variant is minimal.
// A missing field, a forged variant, or eligibility false all stay on classic.

export type MinimalUxVariant = "classic" | "minimal";

export interface MinimalUxState {
  eligible: boolean;
  variant: MinimalUxVariant;
}

const CLASSIC: MinimalUxState = { eligible: false, variant: "classic" };

export function readMinimalUx(
  data: { ux?: { eligible?: unknown; variant?: unknown } } | null | undefined,
): MinimalUxState {
  const eligible = data?.ux?.eligible === true;
  if (!eligible) return CLASSIC;
  return { eligible: true, variant: data?.ux?.variant === "minimal" ? "minimal" : "classic" };
}

export function shouldRenderMinimalShell(state: MinimalUxState): boolean {
  return state.eligible && state.variant === "minimal";
}

export function shouldOfferMinimalView(state: MinimalUxState): boolean {
  return state.eligible && state.variant === "classic";
}

export function useMinimalUx(): MinimalUxState {
  const query = useQuery<{ ux?: { eligible?: unknown; variant?: unknown } } | null, ApiError>({
    queryKey: ["session"],
    queryFn: () => apiFetch("/auth/me"),
    retry: false,
  });
  return readMinimalUx(query.data);
}

export async function selectMinimalUxVariant(variant: MinimalUxVariant): Promise<void> {
  await apiFetch("/auth/ux-view", { method: "POST", body: JSON.stringify({ variant }) });
}

export function formatMinimalHeaderDate(now: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("weekday")}, ${part("day")} ${part("month")} ${part("year")}`;
}

export function minimalBreadcrumb(
  location: string,
  links: readonly { path: string; label: string }[],
): { section: string; page: string } {
  const path = location.split("?")[0]?.split("#")[0] || "/";
  const grow = path === "/grow" || path.startsWith("/grow/");
  const section = grow ? "Grow" : "Agent Engine";
  if (path.startsWith("/grow/appraisals")) return { section, page: "Appraisals" };
  if (path.startsWith("/grow/import")) return { section, page: "Import" };
  if (path === "/grow/opportunities" || path.startsWith("/grow/opportunities/")) return { section, page: "Opportunities" };
  if (/^\/grow\/contacts\/[^/]+$/.test(path)) return { section, page: "Contact" };
  if (path === "/properties/start") return { section: "Agent Engine", page: "Start property" };
  if (path.startsWith("/properties/")) return { section: "Agent Engine", page: "Property" };
  if (path.startsWith("/settings/")) return { section: "Agent Engine", page: "Settings" };
  const exact = links.find((link) => link.path === path);
  if (exact) return { section: exact.path === "/grow" || exact.path.startsWith("/grow/") ? "Grow" : "Agent Engine", page: exact.label };
  if (path === "/") return { section: "Agent Engine", page: "Home" };
  return { section, page: "Page" };
}

export function minimalNavIsCurrent(location: string, linkPath: string): boolean {
  return navLinkIsActive(location, linkPath);
}
