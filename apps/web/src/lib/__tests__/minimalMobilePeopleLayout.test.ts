import { test } from "node:test";
import assert from "node:assert/strict";
import { GROW_CONTACT_ROLES, type GrowContactListPage } from "../growContactList";
import { PEOPLE_PAGE_SIZE } from "../../minimal/mobile/mobilePeopleConfig";
import { buildPeopleRows, normaliseSearchParam, peopleCountLine, peopleEmptyText, peoplePath, peopleTotal, roleOptions } from "../../minimal/mobile/mobilePeopleLayout";

// AE Mobile (CC Task #64, M4): the phone People list, from the existing GET /grow/contacts payload.

const item = (id: number, displayName: string, o: Record<string, unknown> = {}) => ({ id, displayName, partyType: "Person", email: null, mobile: null, roles: [], relatedPropertyCount: 0, ...o });
const page = (contacts: unknown[], total?: number, nextCursor: string | null = null): GrowContactListPage => ({ contacts: contacts as GrowContactListPage["contacts"], total: total ?? contacts.length, nextCursor });

test("the request is the existing contacts list with a phone page size and the existing encoding", () => {
  assert.equal(PEOPLE_PAGE_SIZE, 25);
  assert.equal(peoplePath({ search: "", role: "", cursor: null }), "/grow/contacts?limit=25");
  assert.equal(peoplePath({ search: "maya", role: "", cursor: null }), "/grow/contacts?search=maya&limit=25");
  assert.equal(peoplePath({ search: "O'Brien & Co", role: "Seller", cursor: "abc=" }), "/grow/contacts?search=O%27Brien+%26+Co&role=Seller&cursor=abc%3D&limit=25");
  for (const q of ["a&b=c", "50%_off", "Zoë"]) {
    const url = new URL(peoplePath({ search: q, role: "", cursor: null }), "http://x.test");
    assert.equal(url.searchParams.get("search"), q);
    assert.deepEqual([...url.searchParams.keys()].sort(), ["limit", "search"]);
  }
  assert.doesNotMatch(peoplePath({ search: "x", role: "Seller", cursor: "c" }), /brokerage|user|phone|mobile=/i);
});

test("rows: one per person across pages, the mobile number first, else the email, never a property count", () => {
  const rows = buildPeopleRows([
    page([item(1, "Maya Okafor", { mobile: "0491 570 156", email: "m@example.com", roles: ["Seller", "PastClient"], relatedPropertyCount: 4 }), item(2, "Daniel Reyes", { email: "d@example.com" })], 4, "c1"),
    page([item(2, "Daniel again"), item(3, "Org Pty", { partyType: "Organisation" })], 4),
  ]);
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3], "de-duplicated, first wins");
  assert.equal(rows[0].contactLine, "0491 570 156");
  assert.equal(rows[1].contactLine, "d@example.com");
  assert.equal(rows[2].contactLine, "");
  assert.deepEqual(rows[0].roleChips, ["Seller", "PastClient"], "stored values; the row draws them in plain words");
  assert.equal(rows[0].href, "/grow/contacts/1");
  assert.equal(rows[0].initials, "MO");
  assert.doesNotMatch(JSON.stringify(rows), /relatedPropertyCount|linked propert/i);
});

test("rows ignore malformed entries and survive missing fields", () => {
  const rows = buildPeopleRows([undefined, page([null, "x", { id: "7", displayName: "Bad" }, { id: 8 }, item(9, "Good", { roles: undefined, email: undefined, mobile: 5 })])]);
  assert.deepEqual(rows.map((r) => r.id), [9]);
  assert.deepEqual(rows[0].roleChips, []);
  assert.equal(rows[0].contactLine, "");
  assert.deepEqual(buildPeopleRows([]), []);
  assert.deepEqual(buildPeopleRows([{} as GrowContactListPage]), []);
});

test("total, count line and empty text", () => {
  assert.equal(peopleTotal([page([item(1, "A")], 140, "c")], 25), 140);
  assert.equal(peopleTotal([page([item(1, "A")], 3)], 25), 25, "never below the rows shown");
  assert.equal(peopleTotal([], 0), 0);
  assert.equal(peopleCountLine(25, 140), "Showing 25 of 140 people");
  assert.equal(peopleCountLine(1, 1), "Showing 1 of 1 person");
  assert.equal(peopleEmptyText("zzz", ""), "No people match “zzz”. Try a different name, organisation or email.");
  assert.equal(peopleEmptyText("", "Seller"), "No people with that role.");
  assert.equal(peopleEmptyText("", ""), "No people yet.");
});

test("the role filter lists every stored role once, in plain words", () => {
  const options = roleOptions();
  assert.deepEqual(options[0], { value: "", label: "All roles" });
  assert.deepEqual(options.slice(1).map((o) => o.value), [...GROW_CONTACT_ROLES]);
  assert.equal(options.find((o) => o.value === "PastClient")?.label, "Past client");
  assert.equal(options.find((o) => o.value === "AppraisalProspect")?.label, "Appraisal prospect");
  assert.equal(options.length, GROW_CONTACT_ROLES.length + 1);
});

test("the ?search= value is cleaned like a typed search", () => {
  assert.equal(normaliseSearchParam("  Maya   Okafor "), "Maya Okafor");
  assert.equal(normaliseSearchParam(null), "");
  assert.equal(normaliseSearchParam(undefined), "");
  assert.equal(normaliseSearchParam("x".repeat(250)).length, 100);
});
