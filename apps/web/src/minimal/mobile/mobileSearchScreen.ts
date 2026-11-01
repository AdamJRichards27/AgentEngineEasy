import type { GrowTodaySummary } from "../../lib/growToday";
import { growContactPath } from "../../lib/growWorkspace";
import { cleanSearchQuery, SEARCH_MESSAGES } from "./mobileSearchModel";
import type { SearchLegOutcome, SearchPerson, SearchPlan, SearchProperty, SearchResults } from "./mobileSearchModel";
import { RECENT_LIMIT, TODAY_SUGGESTION_LIMIT, searchHintLine } from "./mobileSearchConfig";

// AE Mobile (CC Task #64, M2): everything the Search screen decides, as pure functions. No React,
// no network, no storage. The hook feeds it; SearchPageView draws it. The search model (M1) decides
// what to ask the API and how to rank; this file decides what the screen says and in what order.

export interface SearchSuggestion {
  key: string;
  title: string;
  subtitle: string;
  href: string;
}

export interface SearchSuggestions {
  /** Up to 3 people already on Today. Read from the cached Today query, so no new request. */
  today: SearchSuggestion[];
  /** The last few results opened from search in this visit. */
  recent: SearchSuggestion[];
}

export type SearchGroupKey = "people" | "properties";

export interface SearchScreenGroup {
  key: SearchGroupKey;
  title: string;
  people: SearchPerson[];
  properties: SearchProperty[];
  /** "Showing 5 of 23 people. Type more to narrow.", or null when everything fits. */
  overflow: string | null;
}

export type SearchScreenMode = "suggestions" | "results" | "message";

export interface SearchScreen {
  mode: SearchScreenMode;
  /** The one line under the field. Read aloud as a status. */
  statusLine: string;
  groups: SearchScreenGroup[];
  suggestions: SearchSuggestions;
  hintLine: string;
  showTryAgain: boolean;
  /** Links on a no-results page. Each only when the user may use it. */
  emptyActions: { addContact: boolean; addProperty: boolean };
}

export interface SearchScreenInput {
  /** What is typed in the field right now. */
  input: string;
  /** The search the results belong to: the typed text as it stood after the pause. */
  committed: string;
  plan: SearchPlan;
  results: SearchResults;
  suggestions: SearchSuggestions;
  phoneSearchSupported: boolean;
  canAddContact: boolean;
  canAddProperty: boolean;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** People first, unless the query starts with a number ("12 Given") or is a 4-digit postcode. */
export function propertiesFirst(plan: SearchPlan): boolean {
  if (plan.query === null) return false;
  if (plan.kind === "four-digits") return true;
  return plan.kind === "text" && /^\d/.test(plan.query);
}

export function buildSearchScreen(input: SearchScreenInput): SearchScreen {
  const hintLine = searchHintLine(input.phoneSearchSupported);
  const base = {
    suggestions: input.suggestions,
    hintLine,
    showTryAgain: false,
    emptyActions: { addContact: false, addProperty: false },
  };
  const typed = cleanSearchQuery(input.input);
  if (typed === null) return { ...base, mode: "suggestions", statusLine: "", groups: [] };

  const searchedFor = cleanSearchQuery(input.committed);
  const waiting = typed !== searchedFor;
  const { results } = input;

  const groups: SearchScreenGroup[] = [];
  if (results.people && results.people.items.length > 0) {
    const g = results.people;
    groups.push({
      key: "people",
      title: "People",
      people: g.items,
      properties: [],
      overflow: g.hiddenCount > 0 ? `Showing ${g.items.length} of ${g.total} people. Type more to narrow.` : null,
    });
  }
  if (results.properties && results.properties.items.length > 0) {
    const g = results.properties;
    groups.push({
      key: "properties",
      title: "Properties",
      people: [],
      properties: g.items,
      overflow: g.hiddenCount > 0 ? `Showing ${g.items.length} of ${g.total} properties. Type more to narrow.` : null,
    });
  }
  if (propertiesFirst(input.plan)) groups.sort((a, b) => (a.key === "properties" ? -1 : 0) - (b.key === "properties" ? -1 : 0));

  // Typing, or a request still running: say so, and keep whatever finished results are on screen.
  if (waiting || results.state === "loading") {
    return { ...base, mode: groups.length > 0 ? "results" : "message", statusLine: "Searching…", groups };
  }
  switch (results.state) {
    case "idle":
      return { ...base, mode: "suggestions", statusLine: "", groups: [] };
    case "hint":
      return { ...base, mode: "message", statusLine: results.message ?? SEARCH_MESSAGES.tooShort, groups: [] };
    case "unavailable":
      return { ...base, mode: "message", statusLine: results.message ?? SEARCH_MESSAGES.unavailable, groups: [] };
    case "error":
      return { ...base, mode: "message", statusLine: results.message ?? SEARCH_MESSAGES.error, groups: [], showTryAgain: true };
    case "empty":
      return {
        ...base,
        mode: "message",
        statusLine: results.message ?? "No results",
        groups: [],
        showTryAgain: results.partial,
        emptyActions: { addContact: input.canAddContact, addProperty: input.canAddProperty },
      };
    default: {
      const counts: string[] = [];
      // Only groups that have something: "1 person", never "1 person, 0 properties".
      if (results.people && results.people.total > 0) counts.push(plural(results.people.total, "person", "people"));
      if (results.properties && results.properties.total > 0) counts.push(plural(results.properties.total, "property", "properties"));
      const line = results.partial ? SEARCH_MESSAGES.partial : counts.join(", ");
      return { ...base, mode: "results", statusLine: line, groups, showTryAgain: results.partial };
    }
  }
}

// ── From react-query to the model ─────────────────────────────────────────

/** The few react-query fields the screen needs. A real query result satisfies it. */
export interface QueryLike<T> {
  status: "pending" | "error" | "success";
  data: T | undefined;
  error: unknown;
}

/**
 * Turns one request into the outcome the M1 model reads. `undefined` when the request was never
 * planned (no permission, or too short), so the model ignores it.
 */
export function outcomeOf<T>(planned: boolean, query: QueryLike<T>, legOutcomeFromError: (e: unknown) => SearchLegOutcome<T>): SearchLegOutcome<T> | undefined {
  if (!planned) return undefined;
  if (query.status === "success" && query.data !== undefined) return { status: "ok", data: query.data };
  if (query.status === "error") return legOutcomeFromError(query.error);
  return { status: "pending" };
}

// ── Suggestions ───────────────────────────────────────────────────────────

/** Up to three different people from the day's priority actions. Skips signals with no contact. */
export function todaySuggestions(summary: GrowTodaySummary | undefined, limit: number = TODAY_SUGGESTION_LIMIT): SearchSuggestion[] {
  if (!summary || !Array.isArray(summary.priorityActions)) return [];
  const seen = new Set<number>();
  const out: SearchSuggestion[] = [];
  for (const action of summary.priorityActions) {
    if (action.partyId === null || seen.has(action.partyId)) continue;
    const name = action.contactName.trim();
    if (name.length === 0) continue;
    seen.add(action.partyId);
    const line = [action.contactMobile, action.contactEmail].find((v) => typeof v === "string" && v.trim().length > 0) ?? "";
    out.push({ key: `today-${action.partyId}`, title: name, subtitle: line, href: growContactPath(action.partyId) });
    if (out.length >= limit) break;
  }
  return out;
}

/** Newest first, one entry per address, at most RECENT_LIMIT. */
export function addRecent(list: readonly SearchSuggestion[], item: SearchSuggestion, limit: number = RECENT_LIMIT): SearchSuggestion[] {
  return [item, ...list.filter((entry) => entry.href !== item.href)].slice(0, limit);
}
