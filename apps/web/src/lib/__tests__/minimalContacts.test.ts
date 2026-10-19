import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Link } from "wouter";
import { GROW_TABS, contactsEmptyMessage, growContactPath, growTabHref } from "../growWorkspace";
import { GROW_CONTACT_ROLES, type GrowContactListItem } from "../growContactList";
import {
  MINIMAL_GROW_SECTIONS,
  MINIMAL_CONTACTS_FULL_HREF,
  minimalGrowSectionFor,
  selectGrowView,
} from "../../minimal/minimalGrowNav";
import { buildMinimalContactRows, minimalContactPropertiesLabel } from "../../minimal/minimalContactsModel";
import { MinimalGrowSections } from "../../minimal/MinimalGrowSections";
import { MinimalContactsView, type MinimalContactsViewProps } from "../../minimal/MinimalContacts";

// WS1 (t69u): the Minimal shell rendered Minimal Today for every /grow address, so
// /grow?tab=contacts, ?tab=opportunities and the rest were unreachable in Minimal.
// These tests lock the route choice, the Grow section nav and the Minimal contact list.

interface El { type?: unknown; props?: Record<string, unknown> & { children?: unknown } }
function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (!node || typeof node !== "object") return "";
  const e = node as El;
  if (typeof e.type === "function" && e.type !== Link) return text(render(e));
  return text(e.props?.children);
}
function render(e: El): unknown {
  return (e.type as (p: unknown) => unknown)(e.props ?? {});
}
function all(node: unknown, pred: (e: El) => boolean): El[] {
  if (Array.isArray(node)) return node.flatMap((c) => all(c, pred));
  if (!node || typeof node !== "object") return [];
  const e = node as El;
  if (typeof e.type === "function" && e.type !== Link) return (pred(e) ? [e] : []).concat(all(render(e), pred));
  return (pred(e) ? [e] : []).concat(all(e.props?.children, pred));
}
const links = (tree: unknown) => all(tree, (e) => e.type === Link);
const hrefs = (tree: unknown) => links(tree).map((e) => String(e.props?.href));

// ── Route choice ────────────────────────────────────────────────────────────
test("classic shell: every /grow address stays classic", () => {
  for (const search of ["", "?tab=today", "?tab=contacts", "?tab=opportunities", "?contact=5"]) {
    assert.equal(selectGrowView(false, search), "classic", search);
  }
});

test("Minimal shell: Today and Contacts are Minimal, every other Grow section stays reachable as classic", () => {
  assert.equal(selectGrowView(true, ""), "minimal-today");
  assert.equal(selectGrowView(true, "?tab=today"), "minimal-today");
  assert.equal(selectGrowView(true, "tab=today"), "minimal-today");
  assert.equal(selectGrowView(true, "?tab=junk"), "minimal-today");
  assert.equal(selectGrowView(true, "?tab=contacts"), "minimal-contacts");
  for (const tab of ["opportunities", "nurture", "performance", "askAE"]) {
    assert.equal(selectGrowView(true, `?tab=${tab}`), "classic", tab);
  }
});

test("Minimal shell: a legacy ?contact= link and ?view=full go to classic", () => {
  assert.equal(selectGrowView(true, "?contact=5"), "classic");
  assert.equal(selectGrowView(true, "?tab=contacts&contact=5"), "classic");
  assert.equal(selectGrowView(true, "?tab=contacts&view=full"), "classic");
  assert.equal(selectGrowView(true, "?view=full"), "classic");
});

// ── Grow section nav ────────────────────────────────────────────────────────
test("Grow sections mirror the classic Grow tabs, in order, with the same addresses", () => {
  assert.deepEqual(
    MINIMAL_GROW_SECTIONS.map((s) => [s.key, s.label, s.href]),
    GROW_TABS.map((t) => [t.key, t.label, growTabHref(t.key)]),
  );
});

test("the current Grow section follows the address", () => {
  assert.equal(minimalGrowSectionFor("/grow", ""), "today");
  assert.equal(minimalGrowSectionFor("/grow", "?tab=contacts"), "contacts");
  assert.equal(minimalGrowSectionFor("/grow/contacts/12", ""), "contacts");
  assert.equal(minimalGrowSectionFor("/grow", "?tab=opportunities"), "opportunities");
});

test("MinimalGrowSections renders one link per section and marks only the current one", () => {
  const tree = MinimalGrowSections({ current: "contacts" });
  const ls = links(tree);
  assert.deepEqual(ls.map((l) => l.props?.href), MINIMAL_GROW_SECTIONS.map((s) => s.href));
  const current = ls.filter((l) => l.props?.["aria-current"] === "page");
  assert.equal(current.length, 1);
  assert.equal(text(current[0]), "Contacts");
  assert.equal((tree as El).props?.["aria-label"], "Grow sections");
});

test("Minimal Today and Contact 360 render the Grow section nav", () => {
  const today = readFileSync(new URL("../../minimal/MinimalToday.tsx", import.meta.url), "utf8");
  assert.match(today, /<MinimalGrowSections current="today" \/>/);
  const c360 = readFileSync(new URL("../../minimal/MinimalContact360.tsx", import.meta.url), "utf8");
  assert.match(c360, /<MinimalGrowSections current="contacts" \/>/);
});

// ── Roles list stays in step with the schema and the classic filter ────────
test("GROW_CONTACT_ROLES matches packages/db and the classic Grow role filter", () => {
  const listIn = (src: string) => {
    const m = /GROW_CONTACT_ROLES\s*=\s*\[([\s\S]*?)\]/.exec(src);
    assert.ok(m, "GROW_CONTACT_ROLES array not found");
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  };
  const schema = readFileSync(new URL("../../../../../packages/db/src/schema/contacts.ts", import.meta.url), "utf8");
  const classic = readFileSync(new URL("../../pages/Grow.tsx", import.meta.url), "utf8");
  assert.deepEqual([...GROW_CONTACT_ROLES], listIn(schema));
  assert.deepEqual([...GROW_CONTACT_ROLES], listIn(classic));
});

// ── Contact rows (pure) ─────────────────────────────────────────────────────
const ada: GrowContactListItem = {
  id: 7, displayName: "Ada Allow", partyType: "Person", email: "ada@example.com", mobile: "0400 000 001",
  roles: ["Buyer", "PastClient"], relatedPropertyCount: 2,
};
const blank: GrowContactListItem = {
  id: 8, displayName: "   ", partyType: "Organisation", email: null, mobile: null, roles: [], relatedPropertyCount: 0,
};

test("contact rows only rearrange the list payload", () => {
  const [a, b] = buildMinimalContactRows([ada, blank]);
  assert.deepEqual(a, {
    id: 7, href: growContactPath(7), title: "Ada Allow", initials: "AA",
    contactLine: "ada@example.com · 0400 000 001", roleChips: ["Buyer", "PastClient"],
    propertiesLabel: "2 linked properties", partyType: "Person",
  });
  assert.equal(b.title, "Unnamed contact");
  assert.equal(b.initials, "?");
  assert.equal(b.contactLine, "No email or mobile recorded");
  assert.deepEqual(b.roleChips, []);
  assert.equal(b.propertiesLabel, "No linked properties");
});

test("linked-property label is singular for one and never guesses for a missing count", () => {
  assert.equal(minimalContactPropertiesLabel(1), "1 linked property");
  assert.equal(minimalContactPropertiesLabel(0), "No linked properties");
  assert.equal(minimalContactPropertiesLabel(undefined as unknown as number), "No linked properties");
});

// ── Contacts view (presentational) ──────────────────────────────────────────
function props(over: Partial<MinimalContactsViewProps> = {}): MinimalContactsViewProps {
  return {
    state: "ready", rows: buildMinimalContactRows([ada, blank]), total: 2, search: "", role: "",
    committedSearch: "", errorMessage: null, errorReference: null, hasMore: false, loadingMore: false, moreError: null,
    onSearchText: () => {}, onSubmitSearch: () => {}, onRole: () => {}, onRetry: () => {}, onLoadMore: () => {},
    ...over,
  };
}

test("ready: each contact links to its Contact 360, with the Grow nav, add and import links", () => {
  const tree = MinimalContactsView(props());
  const h = hrefs(tree);
  assert.ok(h.includes("/grow/contacts/7"));
  assert.ok(h.includes("/grow/contacts/8"));
  assert.ok(h.includes(MINIMAL_CONTACTS_FULL_HREF), "add a contact goes to the full contacts workspace");
  assert.equal(MINIMAL_CONTACTS_FULL_HREF, "/grow?tab=contacts&view=full");
  assert.ok(h.includes("/grow/import"));
  for (const s of MINIMAL_GROW_SECTIONS) assert.ok(h.includes(s.href), s.href);
  const body = text(tree);
  assert.match(body, /Ada Allow/);
  assert.match(body, /Showing 2 of 2 contacts/);
  assert.equal(all(tree, (e) => e.type === "button" && /Load more/.test(text(e))).length, 0);
});

test("search and role filter are labelled, and the role list is the schema list", () => {
  const tree = MinimalContactsView(props());
  const input = all(tree, (e) => e.type === "input")[0];
  assert.equal(input.props?.["aria-label"], "Search contacts");
  assert.equal(input.props?.type, "search");
  const options = all(tree, (e) => e.type === "option").map((o) => String(o.props?.value));
  assert.deepEqual(options, ["", ...GROW_CONTACT_ROLES]);
});

test("loading, error and empty states never show rows", () => {
  const loading = MinimalContactsView(props({ state: "loading" }));
  assert.match(text(loading), /Loading contacts…/);
  assert.equal(hrefs(loading).filter((x) => x.startsWith("/grow/contacts/")).length, 0);

  let retried = 0;
  const error = MinimalContactsView(props({ state: "error", errorMessage: "Couldn't load contacts.", errorReference: "Reference: 1a2b3c4d", onRetry: () => { retried++; } }));
  const alert = all(error, (e) => e.props?.role === "alert");
  assert.equal(alert.length, 1);
  assert.match(text(alert[0]), /Couldn't load contacts\./);
  assert.match(text(alert[0]), /Reference: 1a2b3c4d/);
  const retry = all(error, (e) => e.type === "button" && text(e) === "Try again")[0];
  (retry.props?.onClick as () => void)();
  assert.equal(retried, 1);

  const empty = MinimalContactsView(props({ state: "empty", rows: [], total: 0, committedSearch: "zed", role: "Buyer" }));
  assert.match(text(empty), new RegExp(contactsEmptyMessage("zed", "Buyer").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("more pages: Load more calls back, shows progress and a page error", () => {
  let more = 0;
  const tree = MinimalContactsView(props({ hasMore: true, total: 40, onLoadMore: () => { more++; } }));
  const btn = all(tree, (e) => e.type === "button" && /Load more/.test(text(e)))[0];
  (btn.props?.onClick as () => void)();
  assert.equal(more, 1);
  const busy = MinimalContactsView(props({ hasMore: true, loadingMore: true }));
  const busyBtn = all(busy, (e) => e.type === "button" && /Loading more/.test(text(e)))[0];
  assert.equal(busyBtn.props?.disabled, true);
  const failed = MinimalContactsView(props({ hasMore: true, moreError: "Couldn't load more contacts." }));
  assert.match(text(all(failed, (e) => e.props?.role === "alert")[0]), /Couldn't load more contacts\./);
});

test("the Contacts screen fetches only GET /grow/contacts under the classic cache key", () => {
  const src = readFileSync(new URL("../../minimal/MinimalContacts.tsx", import.meta.url), "utf8");
  assert.match(src, /queryKey: \["grow-contacts", committedSearch, role\]/);
  const calls = [...src.matchAll(/apiFetch(?:<[^>]+>)?\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 1);
  for (const c of calls) assert.match(c, /growListPath\("\/grow\/contacts"/);
  assert.doesNotMatch(src, /method:\s*"(POST|PATCH|PUT|DELETE)"/);
  assert.doesNotMatch(src, /localStorage|sessionStorage/);
});

// ── Mobile bottom bar (shell foundation) ───────────────────────────────────
// MinimalShell renders the mobile bar as <Link> anchors, but minimal.css only
// styled `.am-mobile-nav button`, and a 4-column grid wrapped 7–9 links onto
// several rows. Lock: anchors are styled, one scrollable row, 44px targets.
test("mobile bottom bar styles its links as one row of 44px touch targets", () => {
  const css = readFileSync(new URL("../../minimal/minimal.css", import.meta.url), "utf8");
  const mobile = css.slice(css.indexOf("@media (max-width: 760px)"));
  const anchorRule = /\.ae-minimal \.am-mobile-nav a \{([^}]*)\}/.exec(mobile);
  assert.ok(anchorRule, "`.am-mobile-nav a` must be styled inside the 760px media query");
  assert.match(anchorRule[1], /min-height:\s*44px/);
  assert.match(mobile, /\.ae-minimal \.am-mobile-nav a\.is-current \{/);
  const bar = /\.ae-minimal \.am-mobile-nav \{ position: fixed;([^}]*)\}/.exec(mobile);
  assert.ok(bar);
  assert.match(bar[1], /grid-auto-flow:\s*column/);
  assert.match(bar[1], /overflow-x:\s*auto/);
  assert.doesNotMatch(bar[1], /repeat\(4,\s*1fr\)/);
});

test("the Contacts header actions stay visible on mobile", () => {
  const src = readFileSync(new URL("../../minimal/MinimalContacts.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /am-review-button/, "am-review-button is display:none under 760px");
});
