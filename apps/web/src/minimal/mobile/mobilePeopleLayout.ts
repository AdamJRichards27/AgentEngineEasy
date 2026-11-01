import { GROW_CONTACT_ROLES, type GrowContactListItem, type GrowContactListPage } from "../../lib/growContactList";
import { growListPath } from "../../lib/growListQuery";
import { buildMinimalContactRows } from "../minimalContactsModel";
import { roleLabel } from "./mobileLabels";
import type { MobilePersonRowData } from "./MobilePersonRow";
import { PEOPLE_PAGE_SIZE } from "./mobilePeopleConfig";
import { cleanSearchQuery } from "./mobileSearchModel";

// AE Mobile (CC Task #64, M4): the phone People list, as pure functions. No React, no network, no storage.
// It uses the list the existing People page already reads (GET /grow/contacts: name, organisation and email
// search, a role filter, and cursor paging). It does not search phone numbers, because that endpoint does
// not, and nothing here pretends it does.

export interface PeopleQuery {
  search: string;
  role: string;
  cursor: string | null;
}

/** GET /grow/contacts with the phone page size. Encoding is the existing helper's. */
export function peoplePath(q: PeopleQuery): string {
  const base = growListPath("/grow/contacts", { search: q.search || undefined, role: q.role || undefined, cursor: q.cursor });
  return `${base}${base.includes("?") ? "&" : "?"}limit=${PEOPLE_PAGE_SIZE}`;
}

/** The text typed or carried in ?search=, cleaned the way search cleans it. Empty when there is none. */
export function normaliseSearchParam(raw: string | null | undefined): string {
  return cleanSearchQuery(raw) ?? "";
}

export function roleOptions(): Array<{ value: string; label: string }> {
  return [{ value: "", label: "All roles" }, ...GROW_CONTACT_ROLES.map((r) => ({ value: r, label: roleLabel(r) }))];
}

function isItem(raw: unknown): raw is GrowContactListItem {
  if (typeof raw !== "object" || raw === null) return false;
  const c = raw as Record<string, unknown>;
  return typeof c.id === "number" && Number.isInteger(c.id) && c.id > 0 && typeof c.displayName === "string";
}

function normalise(c: GrowContactListItem): GrowContactListItem {
  return {
    ...c,
    partyType: typeof c.partyType === "string" ? c.partyType : "",
    email: typeof c.email === "string" ? c.email : null,
    mobile: typeof c.mobile === "string" ? c.mobile : null,
    roles: Array.isArray(c.roles) ? c.roles.filter((r): r is string => typeof r === "string") : [],
    relatedPropertyCount: typeof c.relatedPropertyCount === "number" ? c.relatedPropertyCount : 0,
  };
}

/**
 * Rows for every page loaded so far: one per person, in the server's order, the first occurrence winning.
 * The line under the name is the mobile number, or the email when there is none. The linked-property
 * count is left out: the list counts links without applying the agent's own-property rule.
 */
export function buildPeopleRows(pages: ReadonlyArray<GrowContactListPage | undefined>): MobilePersonRowData[] {
  const seen = new Set<number>();
  const items: GrowContactListItem[] = [];
  for (const page of pages) {
    if (!page || !Array.isArray(page.contacts)) continue;
    for (const raw of page.contacts as unknown[]) {
      if (!isItem(raw) || seen.has(raw.id)) continue;
      seen.add(raw.id);
      items.push(normalise(raw));
    }
  }
  const rows = buildMinimalContactRows(items);
  return rows.map((row, i) => ({
    id: row.id,
    href: row.href,
    title: row.title,
    initials: row.initials,
    contactLine: items[i].mobile?.trim() || items[i].email?.trim() || "",
    roleChips: row.roleChips,
    matchedOn: null,
  }));
}

/** The server's total from the newest page, never below the rows shown. */
export function peopleTotal(pages: ReadonlyArray<GrowContactListPage | undefined>, shown: number): number {
  const last = [...pages].reverse().find((p) => p !== undefined);
  const total = last && typeof last.total === "number" && Number.isFinite(last.total) ? last.total : 0;
  return Math.max(total, shown);
}

export function peopleCountLine(shown: number, total: number): string {
  return `Showing ${shown} of ${total} ${total === 1 ? "person" : "people"}`;
}

export function peopleEmptyText(search: string, role: string): string {
  if (search) return `No people match “${search}”. Try a different name, organisation or email.`;
  if (role) return "No people with that role.";
  return "No people yet.";
}
