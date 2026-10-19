import { growTabLabel, growWorkspaceEntryState } from "../lib/growWorkspace";

// AE Minimal A accessibility helpers (WS1). Pure, so they test without a DOM.
// In a client-routed app a link click changes the page without moving focus,
// so a keyboard or screen-reader user stays on the old link. After each route
// change the shell moves focus to the new page's <h1> (or the main region)
// and announces the page politely. The first render is left alone so a
// fresh load or refresh does not steal focus.

/** Path plus the Grow section: other query parameters (view, compose, search) are not a new page. */
export function minimalRouteKey(pathname: string, search: string): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const tab = params.get("tab");
  return tab ? `${pathname}?tab=${tab}` : pathname;
}

export function shouldMoveMinimalFocus(previousKey: string | null, nextKey: string): boolean {
  return previousKey !== null && previousKey !== nextKey;
}

interface FocusableLike {
  focus: (options?: { preventScroll?: boolean }) => void;
  hasAttribute: (name: string) => boolean;
  setAttribute: (name: string, value: string) => void;
}
interface DocLike {
  getElementById: (id: string) => FocusableLike | null;
  querySelector: (selector: string) => FocusableLike | null;
}

export const MINIMAL_MAIN_ID = "ae-main-workspace";

export function focusMinimalMain(doc: DocLike): "heading" | "main" | "none" {
  const heading = doc.querySelector(`#${MINIMAL_MAIN_ID} h1`);
  if (heading) {
    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading.focus();
    return "heading";
  }
  const main = doc.getElementById(MINIMAL_MAIN_ID);
  if (main) {
    main.focus();
    return "main";
  }
  return "none";
}

interface ReadyDocLike {
  querySelector: (selector: string) => { getClientRects?: () => ArrayLike<unknown>; isConnected?: boolean } | null;
}

/** The new page has rendered: no Suspense loading line in main, and a visible <h1>. */
export function minimalPageReady(doc: ReadyDocLike): boolean {
  if (doc.querySelector(`#${MINIMAL_MAIN_ID} .app-loading`)) return false;
  const heading = doc.querySelector(`#${MINIMAL_MAIN_ID} h1`);
  if (!heading || heading.isConnected === false) return false;
  return typeof heading.getClientRects === "function" ? heading.getClientRects().length > 0 : false;
}

/** Breadcrumb page and announcement: on /grow, the Grow section rather than "Grow" again. */
export function minimalPageLabel(pathname: string, search: string, crumbPage: string): string {
  if (pathname !== "/grow") return crumbPage;
  return growTabLabel(growWorkspaceEntryState(search).tab);
}
