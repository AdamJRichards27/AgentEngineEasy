import type { GrowContactListItem, GrowContactListPage } from "../../lib/growContactList";
import { growListPath, listSearchEmptyMessage } from "../../lib/growListQuery";
import { buildMinimalContactRows } from "../minimalContactsModel";
import { propertyLocationLine } from "../properties/minimalPropertiesModel";
import type { MobilePermissions } from "./mobilePermissions";

// AE Mobile (CC Task #64, M1): unified People + Properties search, v1.
// Pure logic: no React, no network, no storage, no logging. M2 sends the
// requests this plan describes and feeds the responses back in.
//
// v1 uses existing APIs only:
//   GET /grow/contacts?search=&limit=   (grow.contacts.read; name, organisation, email)
//   GET /properties?q=                  (address, suburb, state, postcode; not paged)
// The server decides every match and every permission. Nothing here widens
// either: no request carries a brokerage, user or role (the session supplies
// tenancy), and a request the user is not permitted to make is never planned.
//
// Phone search is planned but stays OFF until the contacts API supports it:
// `phoneSearchSupported` defaults to false. Do not assume it is available.

export const SEARCH_DEBOUNCE_MS = 300; // matches the existing property list search
export const SEARCH_MAX_QUERY_LENGTH = 100; // matches the cap GET /properties applies
export const SEARCH_MIN_CONTACT_CHARS = 2;
export const SEARCH_MIN_PROPERTY_CHARS = 3; // GET /properties is not paged, so avoid 1 and 2 letter queries
export const SEARCH_PHONE_MIN_DIGITS = 5;
export const SEARCH_CONTACT_REQUEST_LIMIT = 8;
export const SEARCH_GROUP_DISPLAY_CAP = 5;

export const SEARCH_MESSAGES = {
  tooShort: "Keep typing to search.",
  phoneUnsupported: "Phone search isn't available yet. Search by name or email.",
  unavailable: "That search isn't available for your account.",
  error: "Search isn't working right now. Try again in a moment.",
  partial: "Some results couldn't be loaded.",
} as const;

// ── Query cleaning and classification ─────────────────────────────────────

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/** Trimmed, single-spaced, control-free, capped at SEARCH_MAX_QUERY_LENGTH. Null when nothing is left. */
export function cleanSearchQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  if (text.length > SEARCH_MAX_QUERY_LENGTH) {
    text = text.slice(0, SEARCH_MAX_QUERY_LENGTH);
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1); // never end on half a character
    text = text.trim();
  }
  return text.length > 0 ? text : null;
}

export type SearchQueryKind = "email" | "phone" | "four-digits" | "text";

const PHONE_CHARS = /^[+\d\s().-]+$/;

export function classifySearchQuery(query: string): SearchQueryKind {
  if (query.includes("@")) return "email";
  if (/^\d{4}$/.test(query)) return "four-digits"; // a postcode, or the end of a phone number
  if (PHONE_CHARS.test(query) && query.replace(/\D/g, "").length >= SEARCH_PHONE_MIN_DIGITS) return "phone";
  return "text";
}

// ── The plan: which requests to send ──────────────────────────────────────

// t217u: options are derived from mobilePermissions() (the same helper as the nav) and
// can only be built by mobileSearchOptions(): the brand below has no exported key, so a
// hand-written object literal does not type-check.
declare const SEARCH_OPTIONS_BRAND: unique symbol;

export interface SearchOptions {
  /** mobilePermissions().searchContacts (grow.contacts.read). */
  readonly canSearchContacts: boolean;
  /** mobilePermissions().searchProperties. */
  readonly canSearchProperties: boolean;
  /** mobilePermissions().run. False: Run-only property fields are never copied into results. */
  readonly runData: boolean;
  /** Leave false until GET /grow/contacts searches phone numbers. */
  readonly phoneSearchSupported: boolean;
  readonly [SEARCH_OPTIONS_BRAND]: true;
}

export interface SearchOptionsExtra {
  /** Narrow to one source (e.g. a People-only search box). Can only remove a source, never add one. */
  only?: "contacts" | "properties";
  phoneSearchSupported?: boolean;
}

export function mobileSearchOptions(permissions: MobilePermissions, extra: SearchOptionsExtra = {}): SearchOptions {
  return {
    canSearchContacts: permissions.searchContacts === true && extra.only !== "properties",
    canSearchProperties: permissions.searchProperties === true && extra.only !== "contacts",
    runData: permissions.run === true,
    phoneSearchSupported: extra.phoneSearchSupported === true,
  } as SearchOptions;
}

export interface SearchRequest {
  leg: "contacts" | "properties";
  path: string;
}

export type SearchHint = "too-short" | "phone-unsupported" | "unavailable";

export interface SearchPlan {
  /** The cleaned query, or null when there is nothing to search. */
  query: string | null;
  kind: SearchQueryKind | null;
  contacts: SearchRequest | null;
  properties: SearchRequest | null;
  /** Why no request was planned, for a non-empty query. */
  hint: SearchHint | null;
  /** Copied from the options: whether Run-only property fields may appear in results. */
  runData: boolean;
}

export function contactsSearchPath(query: string): string {
  return `${growListPath("/grow/contacts", { search: query })}&limit=${SEARCH_CONTACT_REQUEST_LIMIT}`;
}

export function propertiesSearchPath(query: string): string {
  return `/properties?${new URLSearchParams({ q: query }).toString()}`;
}

export function planSearch(raw: unknown, options: SearchOptions): SearchPlan {
  const query = cleanSearchQuery(raw);
  const runData = options.runData === true;
  if (query === null) return { query: null, kind: null, contacts: null, properties: null, hint: null, runData };
  const kind = classifySearchQuery(query);
  const phoneOk = options.phoneSearchSupported === true;

  let wantContacts: boolean;
  let wantProperties: boolean;
  switch (kind) {
    case "email":
      wantContacts = true;
      wantProperties = false;
      break;
    case "phone":
      wantContacts = phoneOk;
      wantProperties = false;
      break;
    case "four-digits":
      wantContacts = phoneOk;
      wantProperties = true;
      break;
    default:
      wantContacts = query.length >= SEARCH_MIN_CONTACT_CHARS;
      wantProperties = query.length >= SEARCH_MIN_PROPERTY_CHARS;
  }

  const contacts: SearchRequest | null =
    wantContacts && options.canSearchContacts ? { leg: "contacts", path: contactsSearchPath(query) } : null;
  const properties: SearchRequest | null =
    wantProperties && options.canSearchProperties ? { leg: "properties", path: propertiesSearchPath(query) } : null;

  let hint: SearchHint | null = null;
  if (contacts === null && properties === null) {
    if (kind === "text") {
      hint = options.canSearchContacts || options.canSearchProperties ? "too-short" : "unavailable";
    } else if ((kind === "phone" || kind === "four-digits") && !phoneOk && options.canSearchContacts) {
      hint = "phone-unsupported";
    } else {
      hint = "unavailable";
    }
  }
  return { query, kind, contacts, properties, hint, runData };
}

// ── Results ───────────────────────────────────────────────────────────────

export type SearchLegOutcome<T> =
  | { status: "pending" }
  | { status: "cancelled" }
  | { status: "forbidden" }
  | { status: "error" }
  | { status: "ok"; data: T };

/** Reads an apiFetch failure structurally (ApiError.status), without importing the API module. */
export function legOutcomeFromError(error: unknown): { status: "cancelled" } | { status: "forbidden" } | { status: "error" } {
  if (typeof error === "object" && error !== null) {
    const e = error as { name?: unknown; status?: unknown };
    if (e.name === "AbortError") return { status: "cancelled" };
    if (e.status === 403) return { status: "forbidden" };
  }
  return { status: "error" };
}

export interface SearchPerson {
  id: number;
  href: string;
  title: string;
  initials: string;
  contactLine: string;
  roleChips: string[];
  /** What the query matched, judged in the browser for display only. The server decides the match. */
  matchedOn: "name" | "email" | "phone" | null;
}

export interface SearchProperty {
  id: number;
  href: string;
  address: string;
  location: string;
  /** Run-only (workflow stage). Present only when the plan allows Run data. */
  stage?: string;
  /** Run-only (listing status). Present only when the plan allows Run data. */
  listingStatus?: string;
}

export interface SearchGroup<T> {
  items: T[];
  /** People: the server's total. Properties: rows returned. */
  total: number;
  hiddenCount: number;
}

export type SearchState = "idle" | "hint" | "loading" | "results" | "empty" | "error" | "unavailable";

export interface SearchResults {
  state: SearchState;
  people: SearchGroup<SearchPerson> | null;
  properties: SearchGroup<SearchProperty> | null;
  /** True when one request failed and the other succeeded. */
  partial: boolean;
  message: string | null;
}

export interface SearchResultsInput {
  plan: SearchPlan;
  contacts?: SearchLegOutcome<GrowContactListPage>;
  properties?: SearchLegOutcome<{ properties: unknown[] }>;
}

const HINT_MESSAGES: Record<SearchHint, string> = {
  "too-short": SEARCH_MESSAGES.tooShort,
  "phone-unsupported": SEARCH_MESSAGES.phoneUnsupported,
  unavailable: SEARCH_MESSAGES.unavailable,
};

export function buildSearchResults(input: SearchResultsInput): SearchResults {
  const { plan } = input;
  const base: SearchResults = { state: "idle", people: null, properties: null, partial: false, message: null };
  if (plan.query === null) return base;
  if (plan.contacts === null && plan.properties === null) {
    return { ...base, state: "hint", message: HINT_MESSAGES[plan.hint ?? "too-short"] };
  }

  let pending = 0;
  let ok = 0;
  let errors = 0;
  let people: SearchGroup<SearchPerson> | null = null;
  let properties: SearchGroup<SearchProperty> | null = null;

  if (plan.contacts !== null) {
    const outcome = input.contacts ?? { status: "pending" as const };
    if (outcome.status === "pending" || outcome.status === "cancelled") pending += 1;
    else if (outcome.status === "forbidden") {
      /* hidden: not an error */
    } else if (outcome.status === "error") errors += 1;
    else if (!Array.isArray(outcome.data?.contacts)) errors += 1;
    else {
      people = buildPeopleGroup(outcome.data, plan.query);
      ok += 1;
    }
  }

  if (plan.properties !== null) {
    const outcome = input.properties ?? { status: "pending" as const };
    if (outcome.status === "pending" || outcome.status === "cancelled") pending += 1;
    else if (outcome.status === "forbidden") {
      /* hidden: not an error */
    } else if (outcome.status === "error") errors += 1;
    else if (!Array.isArray(outcome.data?.properties)) errors += 1;
    else {
      properties = buildPropertiesGroup(outcome.data.properties, plan.query, plan.runData === true);
      ok += 1;
    }
  }

  const partial = errors > 0 && ok > 0;
  if (pending > 0) return { state: "loading", people, properties, partial: false, message: null };
  if (ok === 0) {
    return errors > 0
      ? { state: "error", people: null, properties: null, partial: false, message: SEARCH_MESSAGES.error }
      : { state: "unavailable", people: null, properties: null, partial: false, message: SEARCH_MESSAGES.unavailable };
  }
  const shown = (people?.items.length ?? 0) + (properties?.items.length ?? 0);
  if (shown === 0) {
    const noun = people && properties ? "people or properties" : people ? "people" : "properties";
    return { state: "empty", people, properties, partial, message: listSearchEmptyMessage(plan.query, noun, "") };
  }
  return { state: "results", people, properties, partial, message: partial ? SEARCH_MESSAGES.partial : null };
}

// ── Matching and ranking (display only; the server decides what matches) ──

/** Lowercase, accent-free, punctuation reduced to spaces. Keeps letters, digits, @ and . */
function normaliseForMatch(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}@.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 1 exact, 2 starts with, 3 a word starts with, 4 contains, 0 no match. */
function matchTier(value: string, query: string): number {
  if (value.length === 0 || query.length === 0) return 0;
  if (value === query) return 1;
  if (value.startsWith(query)) return 2;
  if (` ${value}`.includes(` ${query}`)) return 3;
  if (value.includes(query)) return 4;
  return 0;
}

/** National digits, so 0412 345 678 and +61 412 345 678 compare equal. */
function nationalDigits(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("61") && digits.length > 9) return digits.slice(2);
  if (digits.startsWith("0")) return digits.slice(1);
  return digits;
}

const UNMATCHED_RANK = 9;

function dedupeById<T extends { id: number }>(rows: readonly T[]): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// ── People ────────────────────────────────────────────────────────────────

function readContact(raw: unknown): GrowContactListItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (!isPositiveId(c.id) || typeof c.displayName !== "string") return null;
  return {
    id: c.id,
    displayName: c.displayName,
    partyType: typeof c.partyType === "string" ? c.partyType : "",
    email: textOrNull(c.email),
    mobile: textOrNull(c.mobile),
    roles: Array.isArray(c.roles) ? c.roles.filter((r): r is string => typeof r === "string") : [],
    relatedPropertyCount: typeof c.relatedPropertyCount === "number" ? c.relatedPropertyCount : 0,
  };
}

function buildPeopleGroup(page: GrowContactListPage, query: string): SearchGroup<SearchPerson> {
  const contacts = dedupeById(
    page.contacts.map(readContact).filter((c): c is GrowContactListItem => c !== null),
  );
  // Reuse the existing row builder for title, initials, contact line, role chips and link.
  // Its linked-property label is deliberately not carried over: the contacts list counts
  // linked properties without applying the agent own-property rule.
  const rows = buildMinimalContactRows(contacts);
  const q = normaliseForMatch(query);
  const queryDigits = nationalDigits(query);

  const ranked = contacts.map((contact, index) => {
    const name = matchTier(normaliseForMatch(contact.displayName), q);
    const email = contact.email ? matchTier(normaliseForMatch(contact.email), q) : 0;
    const phone =
      queryDigits.length >= 4 && contact.mobile !== null && nationalDigits(contact.mobile).includes(queryDigits);
    let matchedOn: SearchPerson["matchedOn"] = null;
    let rank = UNMATCHED_RANK;
    if (name > 0) {
      matchedOn = "name";
      rank = name;
    } else if (email > 0) {
      matchedOn = "email";
      rank = email;
    } else if (phone) {
      matchedOn = "phone";
      rank = 4;
    }
    const row = rows[index];
    const person: SearchPerson = {
      id: row.id,
      href: row.href,
      title: row.title,
      initials: row.initials,
      contactLine: row.contactLine,
      roleChips: row.roleChips,
      matchedOn,
    };
    return { person, rank, index };
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);

  const items = ranked.slice(0, SEARCH_GROUP_DISPLAY_CAP).map((entry) => entry.person);
  const serverTotal = typeof page.total === "number" && Number.isFinite(page.total) ? page.total : 0;
  const total = Math.max(serverTotal, contacts.length);
  return { items, total, hiddenCount: Math.max(0, total - items.length) };
}

// ── Properties ────────────────────────────────────────────────────────────

interface ReadProperty {
  id: number;
  formattedAddress: string;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  workflowStage: string;
  listingStatus: string;
}

/**
 * Explicit allow-list. GET /properties returns whole property records, including
 * ownership data; only these fields are ever copied, so nothing else can reach a screen.
 */
function readProperty(raw: unknown): ReadProperty | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (!isPositiveId(p.id)) return null;
  if (typeof p.formattedAddress !== "string" || p.formattedAddress.trim().length === 0) return null;
  return {
    id: p.id,
    formattedAddress: p.formattedAddress.trim(),
    suburb: textOrNull(p.suburb),
    state: textOrNull(p.state),
    postcode: textOrNull(p.postcode),
    workflowStage: typeof p.workflowStage === "string" ? p.workflowStage : "",
    listingStatus: typeof p.listingStatus === "string" ? p.listingStatus : "",
  };
}

/** Same destination as the existing Minimal property cards for Grow users; the Run workspace otherwise. */
export function propertyResultHref(id: number): string {
  // t217u: Grow is always visible, so every user opens the Grow property detail;
  // it offers "Open in Run" itself when the user has Run.
  return `/grow/properties/${id}`;
}

function buildPropertiesGroup(rawRows: readonly unknown[], query: string, runData: boolean): SearchGroup<SearchProperty> {
  const rows = dedupeById(rawRows.map(readProperty).filter((p): p is ReadProperty => p !== null));
  const q = normaliseForMatch(query);
  const ranked = rows.map((row, index) => {
    const tiers = [row.formattedAddress, row.suburb ?? "", row.postcode ?? "", row.state ?? ""]
      .map((value) => matchTier(normaliseForMatch(value), q))
      .filter((tier) => tier > 0);
    const rank = tiers.length > 0 ? Math.min(...tiers) : UNMATCHED_RANK;
    const property: SearchProperty = {
      id: row.id,
      href: propertyResultHref(row.id),
      address: row.formattedAddress,
      location: propertyLocationLine(row),
      // t217u: Run-only fields are copied only with Run access (run.access AND a role).
      ...(runData ? { stage: row.workflowStage, listingStatus: row.listingStatus } : {}),
    };
    return { property, rank, index };
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  const items = ranked.slice(0, SEARCH_GROUP_DISPLAY_CAP).map((entry) => entry.property);
  return { items, total: rows.length, hiddenCount: Math.max(0, rows.length - items.length) };
}

// ── Out-of-order responses ────────────────────────────────────────────────

export interface SearchSequencer {
  /** Call when a search starts. Returns the token that search must present with its results. */
  next(): number;
  /** True only for the most recent search. Results from any other token are dropped. */
  isCurrent(token: number): boolean;
  /** Drops everything in flight, for example when the search closes. */
  invalidate(): void;
}

export function createSearchSequencer(): SearchSequencer {
  let latest = 0;
  return {
    next() {
      latest += 1;
      return latest;
    },
    isCurrent(token: number) {
      return token === latest;
    },
    invalidate() {
      latest += 1;
    },
  };
}
