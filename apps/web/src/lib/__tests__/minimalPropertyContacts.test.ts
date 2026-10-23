import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appraisalCandidates,
  buildLinkedContacts,
  contactSearchPath,
  isAlreadyLinked,
  linkContactBody,
  linkFailureText,
  LINK_ALREADY_EXISTS,
  LINK_FORBIDDEN,
  LINK_INVALID,
  LINK_NOT_FOUND,
  PROPERTY_PARTY_ROLES,
} from "../../minimal/properties/minimalPropertyContactsModel";

const rows = [
  { linkId: 1, role: "Seller", party: { id: 7, firstName: "Ana", lastName: "Synthetic", email: "ana@example.test", mobile: null } },
  { linkId: 2, role: "Other", party: { id: 7, firstName: "Ana", lastName: "Synthetic" } },
  { linkId: 3, role: "Buyer", party: { id: 9, organisationName: "Acme Trust" } },
  { linkId: 4, role: "Seller", party: null },
];

test("linked contacts: names, role labels, null party skipped", () => {
  const linked = buildLinkedContacts(rows);
  assert.equal(linked.length, 3);
  assert.equal(linked[0].name, "Ana Synthetic");
  assert.equal(linked[0].roleLabel, "Seller / owner");
  assert.equal(linked[0].detail, "ana@example.test");
  assert.equal(linked[2].name, "Acme Trust");
  assert.equal(linked[0].contactHref, "/grow/contacts/7");
});

test("duplicate guard is per contact + role", () => {
  const linked = buildLinkedContacts(rows);
  assert.equal(isAlreadyLinked(linked, 7, "Seller"), true);
  assert.equal(isAlreadyLinked(linked, 7, "Buyer"), false);
  assert.equal(isAlreadyLinked(linked, 9, "Buyer"), true);
});

test("appraisal candidates are one per contact", () => {
  assert.deepEqual(appraisalCandidates(buildLinkedContacts(rows)).map((c) => c.partyId), [7, 9]);
});

test("link body carries the chosen role; no default role exists", () => {
  assert.deepEqual(linkContactBody(5, 7, "Buyer"), { propertyId: 5, partyId: 7, role: "Buyer" });
  assert.ok(!PROPERTY_PARTY_ROLES.includes("Owner" as never));
});

test("failure text by status", () => {
  assert.equal(linkFailureText({ status: 409, code: "PROPERTY_PARTY_LINK_EXISTS" }, "x"), LINK_ALREADY_EXISTS);
  assert.equal(linkFailureText({ status: 404 }, "x"), LINK_NOT_FOUND);
  assert.equal(linkFailureText({ status: 403 }, "x"), LINK_FORBIDDEN);
  assert.equal(linkFailureText({ status: 400 }, "x"), LINK_INVALID);
  assert.equal(linkFailureText({ status: 500 }, "x"), "x");
  assert.equal(linkFailureText(null, "x"), "x");
});

test("search path encodes the query", () => {
  assert.equal(contactSearchPath(" a b@c "), "/grow/contacts?search=a%20b%40c&limit=20");
});
