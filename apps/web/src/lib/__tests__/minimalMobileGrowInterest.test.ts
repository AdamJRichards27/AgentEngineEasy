import { test } from "node:test";
import assert from "node:assert/strict";
import { GROW_INTEREST_NOTE, GROW_INTEREST_TITLE, buildGrowInterest, growInterestKind, matchedNoteText, matchesCanonicalLink } from "../../minimal/mobile/mobileGrowInterest";
import { propertyRelationshipText } from "../../minimal/mobile/mobileContactLayout";
import { PROPERTY_RELATIONSHIP_LABELS } from "../../minimal/mobile/mobilePeopleConfig";
import type { GrowContact360 } from "../growContact360";

// "Grow interest & history": what Grow recorded that is NOT a current property link. Every row is labelled so it is never read as current ownership;
// a Grow row is left out only when it is the same fact as a canonical link above, and then it is counted and said, never hidden.

type Rel = GrowContact360["properties"][number];
const TYPES = Object.keys(PROPERTY_RELATIONSHIP_LABELS);
const rel = (id: number, relationshipType: string, o: Partial<Rel> = {}): Rel => ({ relationshipId: id, propertyId: 2, propertyAddress: "2 Test Street, Paddington QLD 4064", relationshipType, role: null, status: "Active", isPrimary: false, validFrom: "2026-01-01", validTo: null, ...o }) as Rel;
const href = (id: number) => `/grow/properties/${id}`;
const build = (rows: Rel[], canonical: { propertyId: number; role: string }[] = []) => buildGrowInterest(rows, canonical, propertyRelationshipText, href);

test("the section title and note are the agreed words (desktop and phone use the same)", () => {
  assert.equal(GROW_INTEREST_TITLE, "Grow interest & history");
  assert.match(GROW_INTEREST_NOTE, /not current property links/);
});

test("the server knows 17 relationship types and every one is classified", () => {
  assert.equal(TYPES.length, 17);
  for (const t of TYPES) assert.ok(["record", "interest", "review", "past"].includes(growInterestKind("Active", t)), t);
});

test("kind: past statuses are always Past; pending review is To review; Active depends on the type; nothing is ever 'current'", () => {
  for (const t of TYPES) {
    for (const past of ["Historical", "Inactive", "Ended", "Merged"]) assert.equal(growInterestKind(past, t), "past", `${t} ${past}`);
    assert.equal(growInterestKind("PendingReview", t), "review", `${t} PendingReview`);
  }
  assert.equal(growInterestKind("Active", "former_owner"), "past", "a former owner is past even when the row is Active");
  assert.equal(growInterestKind("Active", "unknown_pending_review"), "review");
  for (const t of ["owner", "co_owner", "occupier", "tenant", "landlord", "buyer", "seller", "vendor"]) assert.equal(growInterestKind("Active", t), "record", `${t} sounds current, so it is labelled a Grow record`);
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

test("nothing is lost: every Grow row is either listed or counted as matched, for every type, status and property combination", () => {
  const rows: Rel[] = [];
  let id = 1;
  for (const t of TYPES) for (const status of ["Active", "Historical", "PendingReview"]) for (const propertyId of [2, 3, null]) rows.push(rel(id++, t, { status, propertyId, propertyAddress: propertyId === null ? null : `${propertyId} Test Street` }));
  for (const canonical of [[], [{ propertyId: 2, role: "Owner" }, { propertyId: 3, role: "Buyer" }]]) {
    const r = build(rows, canonical);
    assert.equal(r.rows.length + r.matchedCount, rows.length, "listed + matched = every row");
    assert.equal(new Set(r.rows.map((x) => x.key)).size, r.rows.length, "no row listed twice");
  }
  assert.equal(build(rows, []).matchedCount, 0, "with no canonical links nothing is left out");
});

test("a Grow row that duplicates a canonical link is left out, counted and said; a different fact at the same property is kept", () => {
  const r = build([rel(1, "buyer"), rel(2, "seller"), rel(3, "prospective_buyer", { propertyId: 5 })], [{ propertyId: 2, role: "Buyer" }]);
  assert.deepEqual(r.rows.map((x) => x.key), [2, 3]);
  assert.equal(r.matchedCount, 1);
  assert.equal(matchedNoteText(r.matchedCount), "1 Grow record matches a property listed above, so it is not repeated here.");
  assert.equal(matchedNoteText(3), "3 Grow records match properties listed above, so they are not repeated here.");
  assert.equal(matchedNoteText(0), null);
});

test("every row is labelled so it cannot be read as a current property link; free-text roles survive; order groups Grow records, interest, review, past", () => {
  const r = build([
    rel(1, "former_owner", { status: "Historical" }),
    rel(2, "related_party", { role: "Executor", propertyId: 8 }),
    rel(3, "owner", { propertyId: 9 }),
    rel(4, "referrer", { propertyId: null, propertyAddress: null }),
    rel(5, "unknown_pending_review", { status: "PendingReview" }),
  ]);
  assert.deepEqual(r.rows.map((x) => [x.key, x.kindLabel]), [[3, "Grow record"], [2, "Interest"], [4, "Interest"], [5, "To review"], [1, "Past"]]);
  assert.equal(r.rows.find((x) => x.key === 2)?.relationship, "Related party · Executor");
  const person = r.rows.find((x) => x.key === 4)!;
  assert.deepEqual([person.label, person.href], ["Not linked to a property", null], "a person-level row is kept, with no property link");
  assert.equal(r.rows.find((x) => x.key === 3)?.href, "/grow/properties/9");
  for (const row of r.rows) assert.match(row.kindLabel, /^(Grow record|Interest|To review|Past)$/);
});
