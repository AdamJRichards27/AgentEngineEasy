import { test } from "node:test";
import assert from "node:assert/strict";
import { mobilePermissions } from "../../minimal/mobile/mobilePermissions";
import { buildSearchResults, legOutcomeFromError, mobileSearchOptions, planSearch, type SearchLegOutcome, type SearchOptions } from "../../minimal/mobile/mobileSearchModel";
import { RECENT_LIMIT, TODAY_SUGGESTION_LIMIT } from "../../minimal/mobile/mobileSearchConfig";
import { addRecent, buildSearchScreen, outcomeOf, propertiesFirst, todaySuggestions, type SearchSuggestions } from "../../minimal/mobile/mobileSearchScreen";
import type { GrowContactListPage } from "../growContactList";
import type { GrowTodaySummary } from "../growToday";

// AE Mobile (CC Task #64, M2): what the Search screen says, in what order, and when.

const BOTH: SearchOptions = mobileSearchOptions(mobilePermissions(["grow.access", "grow.contacts.read"], "Agent"));
const NO_SUGGESTIONS: SearchSuggestions = { today: [], recent: [] };

function contact(id: number, displayName: string, extra: Record<string, unknown> = {}) {
  return { id, displayName, partyType: "Person", email: null, mobile: null, roles: ["Seller"], relatedPropertyCount: 0, ...extra };
}
function property(id: number, formattedAddress: string, extra: Record<string, unknown> = {}) {
  return { id, formattedAddress, suburb: "Paddington", state: "QLD", postcode: "4064", workflowStage: "Appraisal", listingStatus: "Not Listed", ...extra };
}
const ok = <T>(data: T): SearchLegOutcome<T> => ({ status: "ok", data });
const page = (contacts: unknown[], total?: number): GrowContactListPage => ({ contacts: contacts as GrowContactListPage["contacts"], total: total ?? contacts.length, nextCursor: null });

function screenFor(
  typed: string,
  committed: string,
  contacts?: SearchLegOutcome<GrowContactListPage>,
  properties?: SearchLegOutcome<{ properties: unknown[] }>,
  options: SearchOptions = BOTH,
  extra: { canAddContact?: boolean; canAddProperty?: boolean; suggestions?: SearchSuggestions } = {},
) {
  const plan = planSearch(committed, options);
  const results = buildSearchResults({ plan, contacts, properties });
  return buildSearchScreen({
    input: typed,
    committed,
    plan,
    results,
    suggestions: extra.suggestions ?? NO_SUGGESTIONS,
    phoneSearchSupported: false,
    canAddContact: extra.canAddContact ?? true,
    canAddProperty: extra.canAddProperty ?? true,
  });
}

test("an empty box shows the suggestions and no status", () => {
  const s = screenFor("", "");
  assert.equal(s.mode, "suggestions");
  assert.equal(s.statusLine, "");
  assert.deepEqual(s.groups, []);
  assert.equal(s.hintLine, "Try a name, an email, an address, a suburb or a postcode.");
  assert.equal(screenFor("   ", "").mode, "suggestions", "blank counts as empty");
});

test("too short and phone-number hints, in plain words", () => {
  const short = screenFor("S", "S");
  assert.equal(short.mode, "message");
  assert.equal(short.statusLine, "Keep typing to search.");
  const phone = screenFor("0412 345 678", "0412 345 678");
  assert.equal(phone.statusLine, "Phone search isn't available yet. Search by name or email.");
  assert.equal(phone.showTryAgain, false);
});

test("typing: says Searching and keeps the previous results on screen", () => {
  const fresh = screenFor("smi", "smith", ok(page([contact(1, "Smith")])), ok({ properties: [] }));
  assert.equal(fresh.statusLine, "Searching…");
  assert.equal(fresh.mode, "results");
  assert.equal(fresh.groups[0].people[0].title, "Smith");
  const none = screenFor("sm", "", undefined, undefined);
  assert.equal(none.statusLine, "Searching…");
  assert.equal(none.mode, "message");
});

test("a request still running says Searching, and finished results show meanwhile", () => {
  const s = screenFor("smith", "smith", ok(page([contact(1, "Smith")])), { status: "pending" });
  assert.equal(s.statusLine, "Searching…");
  assert.equal(s.groups.length, 1);
});

test("results: counts line, grouped, People first", () => {
  const s = screenFor("smith", "smith", ok(page([contact(1, "Smith"), contact(2, "John Smith")], 2)), ok({ properties: [property(7, "9 Smith Street")] }));
  assert.equal(s.mode, "results");
  assert.equal(s.statusLine, "2 people, 1 property");
  assert.deepEqual(s.groups.map((g) => g.key), ["people", "properties"]);
  assert.equal(s.groups[0].title, "People");
  assert.equal(s.groups[1].properties[0].address, "9 Smith Street");
});

test("the counts line leaves out a group with nothing in it", () => {
  const peopleOnly = screenFor("maya", "maya", ok(page([contact(1, "Maya Okafor")])), ok({ properties: [] }));
  assert.equal(peopleOnly.statusLine, "1 person");
  const propertiesOnly = screenFor("maya", "maya", ok(page([])), ok({ properties: [property(1, "1 Maya Street")] }));
  assert.equal(propertiesOnly.statusLine, "1 property");
});

test("Properties first when the query starts with a number or is a 4-digit postcode", () => {
  const rows = ok({ properties: [property(1, "12 Given Terrace")] });
  const people = ok(page([contact(1, "Given Name")]));
  const numeric = screenFor("12 given", "12 given", people, rows);
  assert.deepEqual(numeric.groups.map((g) => g.key), ["properties", "people"]);
  const postcode = screenFor("4064", "4064", undefined, rows);
  assert.deepEqual(postcode.groups.map((g) => g.key), ["properties"]);
  assert.equal(propertiesFirst(planSearch("12 given", BOTH)), true);
  assert.equal(propertiesFirst(planSearch("4064", BOTH)), true);
  assert.equal(propertiesFirst(planSearch("smith", BOTH)), false);
  assert.equal(propertiesFirst(planSearch("", BOTH)), false);
  assert.equal(propertiesFirst(planSearch("sam@example.com", BOTH)), false);
});

test("overflow notes show the server total for people and the count returned for properties", () => {
  const many = Array.from({ length: 8 }, (_, i) => contact(i + 1, `Smith ${i + 1}`));
  const props = Array.from({ length: 7 }, (_, i) => property(i + 1, `${i + 1} Smith Street`));
  const s = screenFor("smith", "smith", ok(page(many, 23)), ok({ properties: props }));
  assert.equal(s.groups[0].overflow, "Showing 5 of 23 people. Type more to narrow.");
  assert.equal(s.groups[1].overflow, "Showing 5 of 7 properties. Type more to narrow.");
  const fits = screenFor("smith", "smith", ok(page([contact(1, "Smith")])), ok({ properties: [] }));
  assert.equal(fits.groups[0].overflow, null);
});

test("no results: message, and Add links only where allowed", () => {
  const empty = screenFor("zzz", "zzz", ok(page([])), ok({ properties: [] }));
  assert.equal(empty.mode, "message");
  assert.equal(empty.statusLine, "No people or properties match “zzz”.");
  assert.deepEqual(empty.emptyActions, { addContact: true, addProperty: true });
  const limited = screenFor("zzz", "zzz", ok(page([])), ok({ properties: [] }), BOTH, { canAddContact: false, canAddProperty: true });
  assert.deepEqual(limited.emptyActions, { addContact: false, addProperty: true });
  assert.deepEqual(screenFor("smith", "smith", ok(page([contact(1, "Smith")])), ok({ properties: [] })).emptyActions, { addContact: false, addProperty: false });
});

test("failures: everything failed offers Try again; one failed keeps the other and offers it too; forbidden is not an error", () => {
  const failed = screenFor("smith", "smith", { status: "error" }, { status: "error" });
  assert.equal(failed.statusLine, "Search isn't working right now. Try again in a moment.");
  assert.equal(failed.showTryAgain, true);
  assert.deepEqual(failed.groups, []);
  const partial = screenFor("smith", "smith", { status: "error" }, ok({ properties: [property(1, "1 Smith St")] }));
  assert.equal(partial.statusLine, "Some results couldn't be loaded.");
  assert.equal(partial.showTryAgain, true);
  assert.equal(partial.groups.length, 1);
  const hidden = screenFor("smith", "smith", { status: "forbidden" }, ok({ properties: [property(1, "1 Smith St")] }));
  assert.equal(hidden.showTryAgain, false);
  assert.equal(hidden.statusLine, "1 property");
  const unavailable = screenFor("smith", "smith", { status: "forbidden" }, { status: "forbidden" });
  assert.equal(unavailable.statusLine, "That search isn't available for your account.");
  assert.equal(unavailable.showTryAgain, false);
});

test("a user with no search permission is told so, not shown a broken screen", () => {
  const s = screenFor("smith", "smith", undefined, undefined, { canSearchContacts: false, canSearchProperties: false });
  assert.equal(s.statusLine, "That search isn't available for your account.");
  assert.equal(s.mode, "message");
});

test("outcomeOf: never planned, pending, success, failure", () => {
  const q = <T>(status: "pending" | "error" | "success", data?: T, error?: unknown) => ({ status, data, error });
  assert.equal(outcomeOf(false, q("success", 1), legOutcomeFromError as never), undefined);
  assert.deepEqual(outcomeOf(true, q("pending"), legOutcomeFromError as never), { status: "pending" });
  assert.deepEqual(outcomeOf(true, q("success", { a: 1 }), legOutcomeFromError as never), { status: "ok", data: { a: 1 } });
  assert.deepEqual(outcomeOf(true, q("success"), legOutcomeFromError as never), { status: "pending" }, "success without data is not an answer");
  assert.deepEqual(outcomeOf(true, q("error", undefined, { status: 403 }), legOutcomeFromError as never), { status: "forbidden" });
  assert.deepEqual(outcomeOf(true, q("error", undefined, { status: 500 }), legOutcomeFromError as never), { status: "error" });
  assert.deepEqual(outcomeOf(true, q("error", undefined, { name: "AbortError" }), legOutcomeFromError as never), { status: "cancelled" });
});

function summary(actions: Array<Record<string, unknown>>): GrowTodaySummary {
  const full = actions.map((a, i) => ({ id: `a${i}`, type: "opportunity_follow_up", priority: "DoNow", partyId: null, contactName: "", contactEmail: null, contactMobile: null, propertyLabel: null, reason: "", recommendedAction: "", dueAt: null, ...a }));
  return { generatedAt: "2026-11-02T00:00:00Z", hasAnyGrowData: true, priorityActions: full as GrowTodaySummary["priorityActions"] };
}

test("todaySuggestions: up to three different people, skipping signals with no contact", () => {
  const s = todaySuggestions(
    summary([
      { partyId: null, contactName: "Signal only" },
      { partyId: 5, contactName: "Olivia Brandt", contactMobile: "0491 570 110", contactEmail: "o@example.com" },
      { partyId: 5, contactName: "Olivia Brandt" },
      { partyId: 3, contactName: "Priya Nair", contactEmail: "p@example.com" },
      { partyId: 2, contactName: "Daniel Reyes" },
      { partyId: 4, contactName: "Tom Hargreaves" },
    ]),
  );
  assert.equal(TODAY_SUGGESTION_LIMIT, 3);
  assert.deepEqual(s.map((x) => x.title), ["Olivia Brandt", "Priya Nair", "Daniel Reyes"]);
  assert.equal(s[0].href, "/grow/contacts/5");
  assert.equal(s[0].subtitle, "0491 570 110", "mobile preferred");
  assert.equal(s[1].subtitle, "p@example.com", "email when there is no mobile");
  assert.equal(s[2].subtitle, "");
  assert.deepEqual(todaySuggestions(undefined), []);
  assert.deepEqual(todaySuggestions({ ...summary([]), priorityActions: undefined as never }), []);
  assert.deepEqual(todaySuggestions(summary([{ partyId: 9, contactName: "   " }])), []);
});

test("addRecent: newest first, one per address, at most five", () => {
  const item = (n: number) => ({ key: `k${n}`, title: `T${n}`, subtitle: "Person", href: `/grow/contacts/${n}` });
  let list = [] as ReturnType<typeof item>[];
  for (let n = 1; n <= 7; n++) list = addRecent(list, item(n));
  assert.equal(RECENT_LIMIT, 5);
  assert.deepEqual(list.map((x) => x.title), ["T7", "T6", "T5", "T4", "T3"]);
  list = addRecent(list, item(4));
  assert.deepEqual(list.map((x) => x.title), ["T4", "T7", "T6", "T5", "T3"]);
  const frozen = Object.freeze([item(1)]);
  assert.doesNotThrow(() => addRecent(frozen, item(2)));
});
