import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEARCH_CONTACT_REQUEST_LIMIT,
  SEARCH_DEBOUNCE_MS,
  SEARCH_GROUP_DISPLAY_CAP,
  SEARCH_MAX_QUERY_LENGTH,
  SEARCH_MESSAGES,
  buildSearchResults,
  classifySearchQuery,
  cleanSearchQuery,
  createSearchSequencer,
  legOutcomeFromError,
  planSearch,
  propertyResultHref,
  type SearchLegOutcome,
  type SearchOptions,
  type SearchPlan,
  type SearchResults,
} from "../../minimal/mobile/mobileSearchModel";
import { buildMinimalPropertyCards, growSafeHref } from "../../minimal/properties/minimalPropertiesModel";
import type { GrowContactListPage } from "../../lib/growContactList";

// AE Mobile (CC Task #64, M1): unified People + Properties search, v1.

const BOTH: SearchOptions = { canSearchContacts: true, canSearchProperties: true };
const CONTACTS_ONLY: SearchOptions = { canSearchContacts: true, canSearchProperties: false };
const PROPERTIES_ONLY: SearchOptions = { canSearchContacts: false, canSearchProperties: true };
const NEITHER: SearchOptions = { canSearchContacts: false, canSearchProperties: false };
const BOTH_PHONE: SearchOptions = { ...BOTH, phoneSearchSupported: true };

function contact(id: number, displayName: string, extra: Record<string, unknown> = {}) {
  return { id, displayName, partyType: "Person", email: null, mobile: null, roles: [], relatedPropertyCount: 0, ...extra };
}
function property(id: number, formattedAddress: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    formattedAddress,
    suburb: "Paddington",
    state: "QLD",
    postcode: "4064",
    workflowStage: "Appraisal",
    listingStatus: "Not Listed",
    ...extra,
  };
}
function page(contacts: unknown[], total?: number): GrowContactListPage {
  return { contacts: contacts as GrowContactListPage["contacts"], total: total ?? contacts.length, nextCursor: null };
}
const ok = <T>(data: T): SearchLegOutcome<T> => ({ status: "ok", data });
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function results(
  plan: SearchPlan,
  contacts?: SearchLegOutcome<GrowContactListPage>,
  properties?: SearchLegOutcome<{ properties: unknown[] }>,
  hasGrowAccess = true,
): SearchResults {
  return buildSearchResults({ plan, contacts, properties, hasGrowAccess });
}

test("constants match the existing conventions", () => {
  assert.equal(SEARCH_DEBOUNCE_MS, 300);
  assert.equal(SEARCH_MAX_QUERY_LENGTH, 100);
  assert.equal(SEARCH_CONTACT_REQUEST_LIMIT, 8);
  assert.equal(SEARCH_GROUP_DISPLAY_CAP, 5);
});

// ── cleaning and classification ──────────────────────────────────────────

test("cleanSearchQuery trims, collapses spaces, strips control characters, caps length", () => {
  assert.equal(cleanSearchQuery("  Sam   Seller  "), "Sam Seller");
  assert.equal(cleanSearchQuery("a\u0000b\tc\nd"), "a b c d");
  assert.equal(cleanSearchQuery("   "), null);
  assert.equal(cleanSearchQuery(""), null);
  assert.equal(cleanSearchQuery(undefined), null);
  assert.equal(cleanSearchQuery(42), null);
  assert.equal(cleanSearchQuery("x".repeat(250))?.length, SEARCH_MAX_QUERY_LENGTH);
  const cut = cleanSearchQuery("a".repeat(99) + "😀😀")!;
  assert.ok(cut.length <= SEARCH_MAX_QUERY_LENGTH);
  assert.doesNotMatch(cut, /[\ud800-\udbff]$/, "never ends on half a character");
});

test("classifySearchQuery", () => {
  const cases: Array<[string, string]> = [
    ["sam@example.com", "email"],
    ["sam@", "email"],
    ["0412 345 678", "phone"],
    ["+61 412 345 678", "phone"],
    ["(07) 5555 1234", "phone"],
    ["07-5555-1234", "phone"],
    ["4000", "four-digits"],
    ["123", "text"],
    ["12", "text"],
    ["Smith", "text"],
    ["UAT1-Sam Seller", "text"],
    ["120 Given Terrace", "text"],
    ["Unit 4 / 12 Smith St", "text"],
    ["+61", "text"],
  ];
  for (const [query, kind] of cases) assert.equal(classifySearchQuery(query), kind, query);
});

// ── the plan ──────────────────────────────────────────────────────────────

test("text query plans both requests with the exact paths", () => {
  const plan = planSearch("Smith", BOTH);
  assert.equal(plan.query, "Smith");
  assert.equal(plan.kind, "text");
  assert.deepEqual(plan.contacts, { leg: "contacts", path: "/grow/contacts?search=Smith&limit=8" });
  assert.deepEqual(plan.properties, { leg: "properties", path: "/properties?q=Smith" });
  assert.equal(plan.hint, null);
  const spaced = planSearch("12 Given Tce", BOTH);
  assert.equal(spaced.contacts?.path, "/grow/contacts?search=12+Given+Tce&limit=8");
  assert.equal(spaced.properties?.path, "/properties?q=12+Given+Tce");
});

test("empty or blank query plans nothing and has no hint", () => {
  for (const raw of ["", "   ", null, undefined]) {
    assert.deepEqual(planSearch(raw, BOTH), { query: null, kind: null, contacts: null, properties: null, hint: null });
  }
});

test("a request the user is not permitted to make is never planned", () => {
  const contactsOnly = planSearch("Smith", CONTACTS_ONLY);
  assert.ok(contactsOnly.contacts);
  assert.equal(contactsOnly.properties, null);
  const propertiesOnly = planSearch("Smith", PROPERTIES_ONLY);
  assert.equal(propertiesOnly.contacts, null);
  assert.ok(propertiesOnly.properties);
  const neither = planSearch("Smith", NEITHER);
  assert.equal(neither.contacts, null);
  assert.equal(neither.properties, null);
  assert.equal(neither.hint, "unavailable");
});

test("minimum lengths: contacts from 2 characters, properties from 3", () => {
  const one = planSearch("S", BOTH);
  assert.equal(one.contacts, null);
  assert.equal(one.properties, null);
  assert.equal(one.hint, "too-short");
  const two = planSearch("Sm", BOTH);
  assert.ok(two.contacts);
  assert.equal(two.properties, null);
  assert.equal(two.hint, null);
  const three = planSearch("Smi", BOTH);
  assert.ok(three.contacts);
  assert.ok(three.properties);
  const twoPropertiesOnly = planSearch("Sm", PROPERTIES_ONLY);
  assert.equal(twoPropertiesOnly.properties, null);
  assert.equal(twoPropertiesOnly.hint, "too-short");
});

test("email goes to contacts only", () => {
  const plan = planSearch("sam@example.com", BOTH);
  assert.ok(plan.contacts);
  assert.equal(plan.properties, null);
  assert.equal(plan.contacts?.path, "/grow/contacts?search=sam%40example.com&limit=8");
  const propsOnly = planSearch("sam@example.com", PROPERTIES_ONLY);
  assert.equal(propsOnly.contacts, null);
  assert.equal(propsOnly.properties, null);
  assert.equal(propsOnly.hint, "unavailable");
});

test("phone search stays off by default and says so plainly", () => {
  const off = planSearch("0412 345 678", BOTH);
  assert.equal(off.kind, "phone");
  assert.equal(off.contacts, null);
  assert.equal(off.properties, null);
  assert.equal(off.hint, "phone-unsupported");
  const on = planSearch("0412 345 678", BOTH_PHONE);
  assert.equal(on.contacts?.path, "/grow/contacts?search=0412+345+678&limit=8");
  assert.equal(on.properties, null);
  assert.equal(on.hint, null);
  const propsOnly = planSearch("0412 345 678", { ...PROPERTIES_ONLY, phoneSearchSupported: true });
  assert.equal(propsOnly.hint, "unavailable");
});

test("four digits search properties as a postcode, and contacts too once phone search exists", () => {
  const off = planSearch("4000", BOTH);
  assert.equal(off.contacts, null);
  assert.equal(off.properties?.path, "/properties?q=4000");
  assert.equal(off.hint, null);
  const on = planSearch("4000", BOTH_PHONE);
  assert.ok(on.contacts);
  assert.ok(on.properties);
  const contactsOnlyOff = planSearch("4000", CONTACTS_ONLY);
  assert.equal(contactsOnlyOff.hint, "phone-unsupported");
});

test("paths round-trip any query and carry no id, brokerage or role", () => {
  const tricky = ["a&b=c", "50%_off", "x#y", "O'Brien \"Q\"", "Zoë Müller", "日本語", "a+b", "100% real"];
  for (const query of tricky) {
    const plan = planSearch(query, BOTH);
    const contactsUrl = new URL(plan.contacts!.path, "http://example.test");
    const propertiesUrl = new URL(plan.properties!.path, "http://example.test");
    assert.equal(contactsUrl.pathname, "/grow/contacts");
    assert.equal(propertiesUrl.pathname, "/properties");
    assert.equal(contactsUrl.searchParams.get("search"), cleanSearchQuery(query), query);
    assert.equal(propertiesUrl.searchParams.get("q"), cleanSearchQuery(query), query);
    assert.deepEqual([...contactsUrl.searchParams.keys()].sort(), ["limit", "search"]);
    assert.deepEqual([...propertiesUrl.searchParams.keys()], ["q"]);
    assert.equal(contactsUrl.hash, "");
    assert.equal(propertiesUrl.hash, "");
  }
});

// ── results: merge, ranking, caps ─────────────────────────────────────────

test("people are grouped, de-duplicated and ranked: exact, starts with, word starts with, contains", () => {
  const plan = planSearch("smith", CONTACTS_ONLY);
  const out = results(
    plan,
    ok(
      page([
        contact(1, "Blacksmith"),
        contact(2, "Jane Smithson"),
        contact(3, "John Smith"),
        contact(4, "Smith & Co", { partyType: "Organisation" }),
        contact(5, "Smith"),
        contact(5, "Smith (duplicate row)"),
      ]),
    ),
  );
  assert.equal(out.state, "results");
  assert.deepEqual(out.people?.items.map((p) => p.id), [5, 4, 2, 3, 1]);
  assert.equal(out.properties, null);
});

test("ties keep the server order", () => {
  const out = results(planSearch("jo", CONTACTS_ONLY), ok(page([contact(9, "Jo Z"), contact(3, "Jo A"), contact(7, "Jo M")])));
  assert.deepEqual(out.people?.items.map((p) => p.id), [9, 3, 7]);
});

test("each group shows at most five rows, with the server's total and the hidden count", () => {
  const many = Array.from({ length: 8 }, (_, i) => contact(i + 1, `Smith ${i + 1}`));
  const out = results(planSearch("smith", BOTH), ok(page(many, 23)), ok({ properties: [] }));
  assert.equal(out.people?.items.length, SEARCH_GROUP_DISPLAY_CAP);
  assert.equal(out.people?.total, 23);
  assert.equal(out.people?.hiddenCount, 18);
  const smallTotal = results(planSearch("smith", CONTACTS_ONLY), ok(page(many, 3)));
  assert.equal(smallTotal.people?.total, 8, "total is never below the rows returned");
  const props = Array.from({ length: 7 }, (_, i) => property(i + 1, `${i + 1} Smith Street`));
  const propOut = results(planSearch("smith", PROPERTIES_ONLY), undefined, ok({ properties: props }));
  assert.equal(propOut.properties?.items.length, 5);
  assert.equal(propOut.properties?.total, 7);
  assert.equal(propOut.properties?.hiddenCount, 2);
});

test("matchedOn: name, email, phone, or nothing", () => {
  const people = [
    contact(1, "Sam Seller", { email: "x@y.com" }),
    contact(2, "Unrelated Name", { email: "sam.seller@example.com" }),
    contact(3, "Another Person", { mobile: "+61412345678" }),
    contact(4, "Org Pty Ltd", { partyType: "Organisation" }),
  ];
  const byName = results(planSearch("sam", CONTACTS_ONLY), ok(page(people)));
  const find = (out: SearchResults, id: number) => out.people!.items.find((p) => p.id === id)!;
  assert.equal(find(byName, 1).matchedOn, "name");
  assert.equal(find(byName, 2).matchedOn, "email");
  assert.equal(find(byName, 4).matchedOn, null);
  const byPhone = results(planSearch("0412 345 678", { ...CONTACTS_ONLY, phoneSearchSupported: true }), ok(page(people)));
  assert.equal(find(byPhone, 3).matchedOn, "phone", "0412 345 678 matches a stored +61412345678");
  const partial = results(planSearch("345 678", { ...CONTACTS_ONLY, phoneSearchSupported: true }), ok(page(people)));
  assert.equal(partial.state === "results" ? find(partial, 3).matchedOn : "none", "phone");
});

test("people rows carry only display fields: no property count or party type", () => {
  const out = results(planSearch("sam", CONTACTS_ONLY), ok(page([contact(1, "Sam Seller", { relatedPropertyCount: 4, partyType: "Person", roles: ["Seller"] })])));
  assert.deepEqual(Object.keys(out.people!.items[0]).sort(), ["contactLine", "href", "id", "initials", "matchedOn", "roleChips", "title"]);
  assert.deepEqual(out.people!.items[0].roleChips, ["Seller"]);
  assert.equal(out.people!.items[0].href, "/grow/contacts/1");
});

test("missing fields render as the existing builders do", () => {
  const out = results(planSearch("zz", CONTACTS_ONLY), ok(page([contact(1, ""), contact(2, "Zed", { roles: undefined, email: undefined })])));
  const unnamed = out.people!.items.find((p) => p.id === 1)!;
  assert.equal(unnamed.title, "Unnamed contact");
  assert.equal(unnamed.initials, "?");
  assert.equal(unnamed.contactLine, "No email or mobile recorded");
  assert.deepEqual(out.people!.items.find((p) => p.id === 2)!.roleChips, []);
  const prop = results(planSearch("main", PROPERTIES_ONLY), undefined, ok({ properties: [property(1, "1 Main St", { suburb: null, state: null, postcode: null })] }));
  assert.equal(prop.properties!.items[0].location, "Location not recorded");
});

test("malformed rows are skipped, not trusted", () => {
  const out = results(
    planSearch("sam", BOTH),
    ok(page([null, "x", { id: "7", displayName: "Bad id" }, { id: 8 }, contact(9, "Sam Good")])),
    ok({ properties: [null, { id: 1 }, { id: 2, formattedAddress: "   " }, { id: -3, formattedAddress: "1 Neg St" }, property(4, "4 Sam St")] }),
  );
  assert.deepEqual(out.people!.items.map((p) => p.id), [9]);
  assert.deepEqual(out.properties!.items.map((p) => p.id), [4]);
});

test("property results copy an allow-list of fields only: ownership data never gets through", () => {
  const row = property(7, "7 Given Terrace", {
    ownershipData: { owners: [{ name: "SECRET OWNER" }] },
    ownershipReviewNotes: "SECRET NOTE",
    brokerageId: 99,
    agentId: 5,
    placeId: "abc",
  });
  const out = results(planSearch("given", PROPERTIES_ONLY), undefined, ok({ properties: [row] }));
  assert.deepEqual(Object.keys(out.properties!.items[0]).sort(), ["address", "href", "id", "listingStatus", "location", "stage"]);
  const serialised = JSON.stringify(out);
  for (const secret of ["SECRET", "ownership", "brokerageId", "agentId", "placeId"]) {
    assert.equal(serialised.includes(secret), false, secret);
  }
});

test("property links match the existing Minimal property cards", () => {
  const row = property(7, "7 Given Terrace");
  const card = buildMinimalPropertyCards([{ ...row } as never], [], [])[0];
  const out = results(planSearch("given", PROPERTIES_ONLY), undefined, ok({ properties: [row] }), true);
  assert.equal(out.properties!.items[0].href, card.href);
  assert.equal(out.properties!.items[0].location, card.location);
  assert.equal(propertyResultHref(7, true), "/grow/properties/7");
  assert.equal(propertyResultHref(7, false), "/properties/7");
  assert.equal(propertyResultHref(7, false), growSafeHref("/properties/7", true));
  const runOnly = results(planSearch("given", PROPERTIES_ONLY), undefined, ok({ properties: [row] }), false);
  assert.equal(runOnly.properties!.items[0].href, "/properties/7");
});

test("properties rank on address, suburb and postcode", () => {
  const rows = [
    property(1, "9 Other Road", { suburb: "Toowong", postcode: "4066" }),
    property(2, "4000 Anywhere Ave", { suburb: "Elsewhere", postcode: "4101" }),
    property(3, "5 Some Street", { suburb: "Brisbane", postcode: "4000" }),
  ];
  const out = results(planSearch("4000", PROPERTIES_ONLY), undefined, ok({ properties: rows }));
  assert.deepEqual(out.properties!.items.map((p) => p.id), [3, 2, 1], "exact postcode first, then address start, then unmatched");
});

// ── outcomes and states ───────────────────────────────────────────────────

test("idle and hint states", () => {
  assert.equal(results(planSearch("", BOTH)).state, "idle");
  const short = results(planSearch("S", BOTH));
  assert.equal(short.state, "hint");
  assert.equal(short.message, SEARCH_MESSAGES.tooShort);
  const phone = results(planSearch("0412 345 678", BOTH));
  assert.equal(phone.state, "hint");
  assert.equal(phone.message, SEARCH_MESSAGES.phoneUnsupported);
  const none = results(planSearch("Smith", NEITHER));
  assert.equal(none.message, SEARCH_MESSAGES.unavailable);
});

test("loading while a planned request has no answer yet; cancelled counts as still waiting", () => {
  const plan = planSearch("smith", BOTH);
  assert.equal(results(plan).state, "loading");
  const partial = results(plan, ok(page([contact(1, "Smith")])), { status: "pending" });
  assert.equal(partial.state, "loading");
  assert.equal(partial.people?.items.length, 1, "finished results show while the other request is in flight");
  assert.equal(results(plan, { status: "cancelled" }, ok({ properties: [] })).state, "loading");
});

test("a 403 hides that section and is not an error", () => {
  const plan = planSearch("smith", BOTH);
  const out = results(plan, { status: "forbidden" }, ok({ properties: [property(1, "1 Smith St")] }));
  assert.equal(out.state, "results");
  assert.equal(out.people, null);
  assert.equal(out.properties?.items.length, 1);
  assert.equal(out.partial, false);
  const both = results(plan, { status: "forbidden" }, { status: "forbidden" });
  assert.equal(both.state, "unavailable");
  assert.equal(both.message, SEARCH_MESSAGES.unavailable);
});

test("one failed request never hides the other's results", () => {
  const plan = planSearch("smith", BOTH);
  const out = results(plan, { status: "error" }, ok({ properties: [property(1, "1 Smith St")] }));
  assert.equal(out.state, "results");
  assert.equal(out.partial, true);
  assert.equal(out.message, SEARCH_MESSAGES.partial);
  assert.equal(out.properties?.items.length, 1);
  const bothFail = results(plan, { status: "error" }, { status: "error" });
  assert.equal(bothFail.state, "error");
  assert.equal(bothFail.message, SEARCH_MESSAGES.error);
  const forbiddenPlusError = results(plan, { status: "forbidden" }, { status: "error" });
  assert.equal(forbiddenPlusError.state, "error");
});

test("a malformed success payload counts as an error, not as no results", () => {
  const plan = planSearch("smith", BOTH);
  const out = results(plan, ok({} as GrowContactListPage), ok({ properties: "nope" as unknown as unknown[] }));
  assert.equal(out.state, "error");
});

test("no results uses the existing empty-message wording", () => {
  const both = results(planSearch("zzz", BOTH), ok(page([])), ok({ properties: [] }));
  assert.equal(both.state, "empty");
  assert.equal(both.message, "No people or properties match “zzz”.");
  const peopleOnly = results(planSearch("zz", CONTACTS_ONLY), ok(page([])));
  assert.equal(peopleOnly.message, "No people match “zz”.");
  const propsOnly = results(planSearch("zzz", PROPERTIES_ONLY), undefined, ok({ properties: [] }));
  assert.equal(propsOnly.message, "No properties match “zzz”.");
});

test("legOutcomeFromError reads an ApiError structurally", () => {
  assert.deepEqual(legOutcomeFromError({ status: 403, friendly: "x" }), { status: "forbidden" });
  assert.deepEqual(legOutcomeFromError({ name: "AbortError" }), { status: "cancelled" });
  assert.deepEqual(legOutcomeFromError({ status: 500 }), { status: "error" });
  assert.deepEqual(legOutcomeFromError({ status: 0 }), { status: "error" });
  assert.deepEqual(legOutcomeFromError(new Error("boom")), { status: "error" });
  assert.deepEqual(legOutcomeFromError(null), { status: "error" });
  assert.deepEqual(legOutcomeFromError("403"), { status: "error" });
});

test("the sequencer drops out-of-order and invalidated results", () => {
  const seq = createSearchSequencer();
  const first = seq.next();
  const second = seq.next();
  assert.equal(seq.isCurrent(first), false, "an older search that finishes late is dropped");
  assert.equal(seq.isCurrent(second), true);
  seq.invalidate();
  assert.equal(seq.isCurrent(second), false, "closing the search drops what is in flight");
  const third = seq.next();
  assert.equal(seq.isCurrent(third), true);
  const other = createSearchSequencer();
  assert.equal(other.isCurrent(third), false, "sequencers are independent");
});

test("pure: frozen inputs are never mutated", () => {
  const plan = deepFreeze(planSearch("smith", BOTH));
  const contacts = deepFreeze(ok(page([contact(1, "Smith"), contact(2, "Smithson", { roles: ["Seller"] })], 9)));
  const props = deepFreeze(ok({ properties: [property(1, "1 Smith St", { ownershipData: { a: 1 } })] }));
  assert.doesNotThrow(() => buildSearchResults({ plan, contacts, properties: props, hasGrowAccess: true }));
});
