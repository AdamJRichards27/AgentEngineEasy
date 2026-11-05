import { test } from "node:test";
import assert from "node:assert/strict";
import { GROW_RELATIONSHIP_TYPE_LABELS, growRelationshipText, ALSO_LISTED_LABEL, GROW_INTEREST_NOTE, GROW_INTEREST_TITLE, buildGrowInterest, growInterestKind, isUnknownRelationshipType, matchesCanonicalLink } from "../growInterest";
import type { GrowContact360 } from "../growContact360";

// "Grow interest & history" (revision 2, the Owner's decisions): every Grow row stays visible; a row that is the same fact as a property under
// Properties carries "Also listed under Properties" and KEEPS its original Grow classification; unknown types are To review; former owner is
// Past; pending review has priority; every row is labelled so it is never read as current ownership.

type Rel = GrowContact360["properties"][number];
const KNOWN = Object.keys(GROW_RELATIONSHIP_TYPE_LABELS);
const rel = (id: number, relationshipType: string, o: Partial<Rel> = {}): Rel => ({ relationshipId: id, propertyId: 2, propertyAddress: "2 Test Street, Paddington QLD 4064", relationshipType, role: null, status: "Active", isPrimary: false, validFrom: "2026-01-01", validTo: null, ...o }) as Rel;
const href = (id: number) => `/grow/properties/${id}`;
const build = (rows: Rel[], canonical: { propertyId: number; role: string }[] = []) => buildGrowInterest(rows, canonical, growRelationshipText, href);
const UNKNOWN = ["mystery_type", "", "OWNER", "future_new_type"];

test("the agreed words: title, note and the 'Also listed under Properties' label", () => {
  assert.equal(GROW_INTEREST_TITLE, "Grow interest & history");
  assert.match(GROW_INTEREST_NOTE, /not current property links/);
  assert.equal(ALSO_LISTED_LABEL, "Also listed under Properties");
});

test("the server knows 17 relationship types; anything else, and unknown_pending_review, is an unknown type", () => {
  assert.equal(KNOWN.length, 17);
  for (const t of KNOWN) assert.equal(isUnknownRelationshipType(t), t === "unknown_pending_review", t);
  for (const t of UNKNOWN) assert.equal(isUnknownRelationshipType(t), true, JSON.stringify(t));
});

test("PRECEDENCE 1: pending review takes priority over everything, for every type, known or unknown", () => {
  for (const t of [...KNOWN, ...UNKNOWN]) assert.equal(growInterestKind("PendingReview", t), "review", `PendingReview ${JSON.stringify(t)}`);
  assert.equal(growInterestKind("PendingReview", "former_owner"), "review", "even a former owner: pending review wins over Past");
});

test("PRECEDENCE 2: an unknown relationship type displays as To review, whatever the status", () => {
  for (const t of [...UNKNOWN, "unknown_pending_review"]) for (const status of ["Active", "Historical", "Ended", "Merged"]) assert.equal(growInterestKind(status, t), "review", `${JSON.stringify(t)} ${status}`);
});

test("PRECEDENCE 3 and 4: a known type that is not Active is Past; a former owner is Past, Active or not", () => {
  for (const t of KNOWN.filter((k) => k !== "unknown_pending_review")) for (const past of ["Historical", "Inactive", "Ended", "Merged"]) assert.equal(growInterestKind(past, t), "past", `${t} ${past}`);
  assert.equal(growInterestKind("Active", "former_owner"), "past");
  assert.equal(growInterestKind("Historical", "former_owner"), "past");
});

test("PRECEDENCE 5 and 6: Active, known: types that sound current are Grow records; the rest are Interest", () => {
  for (const t of ["owner", "co_owner", "occupier", "tenant", "landlord", "buyer", "seller", "vendor"]) assert.equal(growInterestKind("Active", t), "record", t);
  for (const t of ["prospective_buyer", "prospective_seller", "appraisal_contact", "investor", "developer", "referrer", "related_party"]) assert.equal(growInterestKind("Active", t), "interest", t);
});

test("matching is deliberately narrow: only an Active row, the same property, and owner, tenant, landlord or buyer equal to the canonical role", () => {
  const canonical = [{ propertyId: 2, role: "Buyer" }, { propertyId: 3, role: "Owner" }, { propertyId: 4, role: "Seller" }];
  assert.equal(matchesCanonicalLink(rel(1, "buyer"), canonical), true);
  assert.equal(matchesCanonicalLink(rel(1, "owner", { propertyId: 3 }), canonical), true);
  const notMatches: Array<[string, Rel]> = [
    ["different role at the same property", rel(1, "seller")],
    ["seller is never an automatic match, even with a canonical Seller", rel(1, "seller", { propertyId: 4 })],
    ["co_owner", rel(1, "co_owner", { propertyId: 3 })],
    ["occupier", rel(1, "occupier", { propertyId: 2 })],
    ["vendor", rel(1, "vendor", { propertyId: 4 })],
    ["a different property", rel(1, "buyer", { propertyId: 9 })],
    ["Historical", rel(1, "buyer", { status: "Historical" })],
    ["PendingReview", rel(1, "buyer", { status: "PendingReview" })],
    ["person-level (no property)", rel(1, "buyer", { propertyId: null, propertyAddress: null })],
    ["a prospecting type", rel(1, "prospective_buyer")],
  ];
  for (const [why, r] of notMatches) assert.equal(matchesCanonicalLink(r, canonical), false, why);
  assert.equal(matchesCanonicalLink(rel(1, "buyer"), [{ propertyId: 2, role: " buyer " }]), true, "role comparison ignores case and spaces");
});

test("MATCHING RECORDS STAY VISIBLE: every Grow row is listed, for every type, status and property combination, with or without canonical links", () => {
  const rows: Rel[] = [];
  let id = 1;
  for (const t of [...KNOWN, ...UNKNOWN]) for (const status of ["Active", "Historical", "PendingReview", "Ended"]) for (const propertyId of [2, 3, null]) rows.push(rel(id++, t, { status, propertyId, propertyAddress: propertyId === null ? null : `${propertyId} Test Street` }));
  for (const canonical of [[], [{ propertyId: 2, role: "Owner" }, { propertyId: 3, role: "Buyer" }]]) {
    const r = build(rows, canonical);
    assert.equal(r.rows.length, rows.length, "NOTHING is left out");
    assert.equal(new Set(r.rows.map((x) => x.key)).size, rows.length, "no row listed twice");
    assert.equal(r.alsoListedCount, rows.filter((x) => matchesCanonicalLink(x, canonical)).length);
    assert.equal(r.rows.filter((x) => x.alsoListed).length, r.alsoListedCount);
  }
  assert.equal(build(rows, []).alsoListedCount, 0, "with no canonical links nothing carries the label");
});

test("a matching record is SHOWN with the 'Also listed under Properties' label; a different fact at the same property is not labelled", () => {
  const r = build([rel(1, "buyer"), rel(2, "seller"), rel(3, "prospective_buyer", { propertyId: 5 })], [{ propertyId: 2, role: "Buyer" }]);
  assert.deepEqual(r.rows.map((x) => [x.key, x.alsoListed]), [[1, true], [2, false], [3, false]]);
  assert.equal(r.alsoListedCount, 1);
});

test("ORIGINAL GROW CLASSIFICATION IS PRESERVED: matching changes the label only, never the kind, the words or the order", () => {
  const rows: Rel[] = [];
  let id = 1;
  for (const t of KNOWN) for (const status of ["Active", "Historical", "PendingReview"]) rows.push(rel(id++, t, { status, role: t === "related_party" ? "Executor" : null }));
  const canonical = [{ propertyId: 2, role: "Owner" }, { propertyId: 2, role: "Tenant" }, { propertyId: 2, role: "Landlord" }, { propertyId: 2, role: "Buyer" }];
  const without = build(rows, []);
  const withLinks = build(rows, canonical);
  assert.ok(withLinks.alsoListedCount > 0);
  assert.deepEqual(withLinks.rows.map((x) => [x.key, x.kind, x.kindLabel, x.relationship, x.label, x.href]), without.rows.map((x) => [x.key, x.kind, x.kindLabel, x.relationship, x.label, x.href]));
  const buyer = withLinks.rows.find((x) => x.alsoListed && x.relationship === "Buyer");
  assert.equal(buyer?.kindLabel, "Grow record", "the Grow Buyer that is also a canonical Buyer is still a Grow record");
});

test("every row is labelled so it cannot be read as a current property link; free-text roles survive; order groups Grow records, interest, review, past", () => {
  const r = build([
    rel(1, "former_owner", { status: "Historical" }),
    rel(2, "related_party", { role: "Executor", propertyId: 8 }),
    rel(3, "owner", { propertyId: 9 }),
    rel(4, "referrer", { propertyId: null, propertyAddress: null }),
    rel(5, "unknown_pending_review", { status: "PendingReview" }),
    rel(6, "mystery_type", { propertyId: 7 }),
  ]);
  assert.deepEqual(r.rows.map((x) => [x.key, x.kindLabel]), [[3, "Grow record"], [2, "Interest"], [4, "Interest"], [5, "To review"], [6, "To review"], [1, "Past"]]);
  assert.equal(r.rows.find((x) => x.key === 2)?.relationship, "Related party · Executor");
  assert.match(r.rows.find((x) => x.key === 6)?.relationship ?? "", /Mystery type/, "an unknown type is humanised, never shown as a stored value");
  const person = r.rows.find((x) => x.key === 4)!;
  assert.deepEqual([person.label, person.href], ["Not linked to a property", null], "a person-level row is kept, with no property link");
  assert.equal(r.rows.find((x) => x.key === 3)?.href, "/grow/properties/9");
  for (const row of r.rows) assert.match(row.kindLabel, /^(Grow record|Interest|To review|Past)$/);
});
