import { test } from "node:test";
import assert from "node:assert/strict";
import { Link } from "wouter";
import { SearchPageView, type SearchPageViewProps } from "../../minimal/mobile/SearchPageView";
import { MobileSearchBar } from "../../minimal/mobile/MobileSearchBar";
import { MobilePersonRow, matchNote } from "../../minimal/mobile/MobilePersonRow";
import { MobilePropertyRow } from "../../minimal/mobile/MobilePropertyRow";
import { mobilePermissions } from "../../minimal/mobile/mobilePermissions";
import { buildSearchResults, mobileSearchOptions, planSearch, type SearchLegOutcome, type SearchOptions } from "../../minimal/mobile/mobileSearchModel";
import { buildSearchScreen, type SearchSuggestions } from "../../minimal/mobile/mobileSearchScreen";
import type { GrowContactListPage } from "../growContactList";
import { all, hrefs, links, text, type El } from "./mobileTreeHelpers";

// AE Mobile (CC Task #64, M2): the phone Search screen and its rows, as drawn.

const BOTH: SearchOptions = mobileSearchOptions(mobilePermissions(["grow.access", "grow.contacts.read"], "Agent"));
const ok = <T>(data: T): SearchLegOutcome<T> => ({ status: "ok", data });
const contact = (id: number, displayName: string, extra: Record<string, unknown> = {}) => ({ id, displayName, partyType: "Person", email: null, mobile: null, roles: ["Seller"], relatedPropertyCount: 0, ...extra });
const property = (id: number, formattedAddress: string, extra: Record<string, unknown> = {}) => ({ id, formattedAddress, suburb: "Paddington", state: "QLD", postcode: "4064", workflowStage: "Appraisal", listingStatus: "Not Listed", ...extra });
const page = (contacts: unknown[], total?: number): GrowContactListPage => ({ contacts: contacts as GrowContactListPage["contacts"], total: total ?? contacts.length, nextCursor: null });

function view(over: Partial<SearchPageViewProps> & { typed?: string; committed?: string; contacts?: SearchLegOutcome<GrowContactListPage>; properties?: SearchLegOutcome<{ properties: unknown[] }>; suggestions?: SearchSuggestions } = {}) {
  const typed = over.typed ?? "";
  const committed = over.committed ?? typed;
  const plan = planSearch(committed, BOTH);
  const results = buildSearchResults({ plan, contacts: over.contacts, properties: over.properties });
  const screen = buildSearchScreen({ input: typed, committed, plan, results, suggestions: over.suggestions ?? { today: [], recent: [] }, phoneSearchSupported: false, canAddContact: true, canAddProperty: true });
  const props: SearchPageViewProps = {
    input: typed, placeholder: "Name, email or address", screen,
    addContactHref: "/grow?tab=contacts&view=full", addPropertyHref: "/properties",
    onInput: () => {}, onClear: () => {}, onBack: () => {}, onRetry: () => {}, onOpen: () => {},
    ...over,
  };
  return SearchPageView(props);
}

test("the field: a labelled search input, focused on arrival, 16 px text via its class, with a status line", () => {
  const tree = view();
  const input = all(tree, (e) => e.type === "input")[0];
  assert.equal(input.props?.type, "search");
  assert.equal(input.props?.["aria-label"], "Search people or properties");
  assert.equal(input.props?.placeholder, "Name, email or address");
  assert.equal(input.props?.autoFocus, true);
  assert.equal(input.props?.autoComplete, "off");
  const status = all(tree, (e) => e.props?.role === "status")[0];
  assert.equal(status.props?.["aria-live"], "polite");
});

test("the page has a heading, so the shell can announce it and move focus to it", () => {
  const headings = all(view(), (e) => e.type === "h1");
  assert.equal(headings.length, 1);
  assert.equal(text(headings[0]), "Search");
  assert.equal(headings[0].props?.className, "am-sr-only", "the existing screen-reader-only class");
});

test("typing calls back with the text; Clear shows only when there is text, and clears", () => {
  const seen: string[] = [];
  let cleared = 0;
  const empty = view({ onInput: (t) => seen.push(t), onClear: () => { cleared++; } });
  assert.equal(all(empty, (e) => e.props?.["aria-label"] === "Clear search").length, 0);
  (all(empty, (e) => e.type === "input")[0].props?.onChange as (e: { target: { value: string } }) => void)({ target: { value: "ma" } });
  assert.deepEqual(seen, ["ma"]);
  const typed = view({ typed: "ma", onClear: () => { cleared++; } });
  const clear = all(typed, (e) => e.props?.["aria-label"] === "Clear search")[0];
  (clear.props?.onClick as () => void)();
  assert.equal(cleared, 1);
});

test("Back is a labelled button", () => {
  let back = 0;
  const tree = view({ onBack: () => { back++; } });
  const btn = all(tree, (e) => e.type === "button" && e.props?.["aria-label"] === "Back")[0];
  (btn.props?.onClick as () => void)();
  assert.equal(back, 1);
});

test("an empty box shows the suggestion groups that have content, then the hint", () => {
  const suggestions: SearchSuggestions = {
    today: [{ key: "today-1", title: "Maya Okafor", subtitle: "0491 570 156", href: "/grow/contacts/1" }],
    recent: [{ key: "property-4", title: "3 Wattle Lane", subtitle: "Property", href: "/grow/properties/4" }],
  };
  const tree = view({ suggestions });
  const body = text(tree);
  assert.match(body, /On your list today/);
  assert.match(body, /Maya Okafor/);
  assert.match(body, /Opened recently/);
  assert.match(body, /3 Wattle Lane/);
  assert.match(body, /Try a name, an email, an address, a suburb or a postcode\./);
  assert.deepEqual(hrefs(tree), ["/grow/contacts/1", "/grow/properties/4"]);
  const none = text(view());
  assert.doesNotMatch(none, /On your list today|Opened recently/);
});

test("opening a suggestion or result tells the container what was opened", () => {
  const opened: Array<{ title: string; href: string }> = [];
  const suggestions: SearchSuggestions = { today: [{ key: "t1", title: "Maya Okafor", subtitle: "", href: "/grow/contacts/1" }], recent: [] };
  const tree = view({ suggestions, onOpen: (i) => opened.push({ title: i.title, href: i.href }) });
  (links(tree)[0].props?.onClick as () => void)();
  assert.deepEqual(opened, [{ title: "Maya Okafor", href: "/grow/contacts/1" }]);

  const results = view({ typed: "maya", contacts: ok(page([contact(1, "Maya Okafor")])), properties: ok({ properties: [property(9, "9 Maya Street")] }), onOpen: (i) => opened.push({ title: i.title, href: i.href }) });
  for (const l of links(results)) (l.props?.onClick as () => void)();
  assert.deepEqual(opened.slice(1), [
    { title: "Maya Okafor", href: "/grow/contacts/1" },
    { title: "9 Maya Street", href: "/grow/properties/9" },
  ]);
});

test("results: People then Properties, whole rows are links, roles in plain words, match note, +n", () => {
  const tree = view({
    typed: "sam",
    contacts: ok(page([
      contact(1, "Sam Seller", { roles: ["Seller", "PastClient"], mobile: "0491 570 156" }),
      contact(2, "Unrelated", { email: "sam.x@example.com", roles: ["AppraisalProspect"] }),
    ])),
    properties: ok({ properties: [property(7, "7 Samson Street")] }),
  });
  const body = text(tree);
  assert.ok(body.indexOf("People") < body.indexOf("Properties"));
  assert.match(body, /Sam Seller/);
  assert.match(body, /Seller/);
  assert.match(body, /\+1/);
  assert.match(body, /Appraisal prospect/, "PascalCase role shown as plain words");
  assert.doesNotMatch(body, /AppraisalProspect|PastClient/);
  assert.match(body, /Matched on email/);
  assert.match(body, /7 Samson Street/);
  assert.match(body, /Paddington QLD 4064/);
  assert.deepEqual(hrefs(tree), ["/grow/contacts/1", "/grow/contacts/2", "/grow/properties/7"]);
});

test("no results: the message, and Add links to the existing screens", () => {
  const tree = view({ typed: "zzz", contacts: ok(page([])), properties: ok({ properties: [] }) });
  assert.match(text(tree), /No people or properties match “zzz”\./);
  assert.deepEqual(hrefs(tree), ["/grow?tab=contacts&view=full", "/properties"]);
  const labels = links(tree).map((l) => text(l));
  assert.deepEqual(labels, ["Add a contact", "Add a property"]);
});

test("everything failed: Try again calls back, and the typed text is untouched", () => {
  let retried = 0;
  const tree = view({ typed: "smith", contacts: { status: "error" }, properties: { status: "error" }, onRetry: () => { retried++; } });
  assert.match(text(tree), /Search isn't working right now\. Try again in a moment\./);
  const btn = all(tree, (e) => e.type === "button" && text(e) === "Try again")[0];
  (btn.props?.onClick as () => void)();
  assert.equal(retried, 1);
  assert.equal(all(tree, (e) => e.type === "input")[0].props?.value, "smith");
});

test("phone number typed while unsupported: plain hint, no results, no Try again", () => {
  const tree = view({ typed: "0491 570 156" });
  assert.match(text(tree), /Phone search isn't available yet\. Search by name or email\./);
  assert.equal(all(tree, (e) => e.type === "button" && text(e) === "Try again").length, 0);
});

test("property data minimisation: ownership data never reaches the screen", () => {
  const tree = view({
    typed: "given",
    properties: ok({ properties: [property(7, "7 Given Terrace", { ownershipData: { owners: [{ name: "SECRET OWNER" }] }, brokerageId: 99, placeId: "abc" })] }),
  });
  const everything = JSON.stringify(text(tree)) + JSON.stringify(hrefs(tree));
  for (const secret of ["SECRET", "ownership", "brokerageId", "placeId"]) assert.equal(everything.includes(secret), false, secret);
});

test("the word Performance never appears", () => {
  assert.doesNotMatch(text(view({ typed: "sam", contacts: ok(page([contact(1, "Sam")])) })), /performance/i);
});

test("the Today search bar is a link to /search, labelled, with no field of its own", () => {
  const tree = MobileSearchBar();
  assert.equal((tree as El).type, Link);
  assert.equal((tree as El).props?.href, "/search");
  assert.equal((tree as El).props?.["aria-label"], "Search people or properties");
  assert.equal(all(tree, (e) => e.type === "input").length, 0);
  assert.match(text(tree), /Search people or properties/);
});

test("rows: one link each, a human role label, and no property count", () => {
  const person = MobilePersonRow({ person: { id: 1, href: "/grow/contacts/1", title: "Sam", initials: "S", contactLine: "sam@example.com", roleChips: ["PropertyOwner"], matchedOn: "name" } });
  assert.equal((person as El).type, Link);
  assert.equal(text(person).includes("Property owner"), true);
  assert.equal(/linked propert/i.test(text(person)), false);
  assert.equal(matchNote("phone"), "Matched on mobile");
  assert.equal(matchNote("name"), null);
  assert.equal(matchNote(null), null);
  const noRole = MobilePersonRow({ person: { id: 2, href: "/grow/contacts/2", title: "Org", initials: "O", contactLine: "", roleChips: [] } });
  assert.equal(all(noRole, (e) => e.props?.className === "mob-chip").length, 0);
  const prop = MobilePropertyRow({ property: { id: 3, href: "/grow/properties/3", address: "3 Wattle Lane", location: "Indooroopilly QLD 4068", stage: "Appraisal" } });
  assert.equal((prop as El).type, Link);
  assert.match(text(prop), /3 Wattle Lane/);
  assert.match(text(prop), /Appraisal/);
});
