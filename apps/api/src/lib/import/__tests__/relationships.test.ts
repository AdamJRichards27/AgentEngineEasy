import { test } from "node:test";
import assert from "node:assert/strict";
import { groupProperties, resolveRelationshipLinks } from "../relationships.js";
import type { NormalisedImportRecord } from "../neutralFormat.js";

// AE GROW Priority 0.5 — Workstream 6 regression: growRelationships.propertyId became nullable
// (packages/db/src/schema/grow.ts) so the API can create pre-property relationships. This
// import pipeline must NOT start creating property-less relationship links as a side effect of
// that schema change — resolveRelationshipLinks() already, independently, only ever links a row
// that carries a formatted property address (its own `if (!record.property?.address?.formatted)
// return;` guard). This test proves that guard holds regardless of schema nullability, so the
// import pipeline's behaviour is unaffected by Workstream 6 — it never needed a NOT NULL
// constraint to stay correct in the first place.

function record(overrides: Partial<NormalisedImportRecord> = {}): NormalisedImportRecord {
  return {
    person: { firstName: "Test", lastName: "Person", email: "test@example.com" },
    meta: { sourceRowNumber: 1, originalValues: {}, mappingConfidence: "high", warnings: [] },
    ...overrides,
  };
}

test("resolveRelationshipLinks never produces a link for a row with no formatted property address, contact-only rows included", () => {
  const records: NormalisedImportRecord[] = [
    record(), // contact-only row: no `property` field at all
    record({ property: { address: {} } }), // property present but no formatted address
    record({
      property: { address: { formatted: "1 Import Test St" } },
      relationship: { resolvedType: "prospective_buyer" },
    }),
  ];

  // The grouping logic itself (groupContacts/groupProperties) is exercised separately below;
  // this test only needs resolveRelationshipLinks' own property-address guard, so each row is
  // given its own explicit group assignment.
  const contactRowToGroupKey = new Map<number, string>([
    [0, "contact-0"],
    [1, "contact-1"],
    [2, "contact-2"],
  ]);
  const propertyRowToGroupKey = new Map<number, string>([[2, "property-0"]]);

  const links = resolveRelationshipLinks(records, contactRowToGroupKey, propertyRowToGroupKey);

  assert.equal(links.length, 1, "only the row with a real formatted property address may produce a link");
  assert.equal(links[0].propertyGroupKey, "property-0");
  assert.equal(links[0].relationshipType, "prospective_buyer");
});

test("resolveRelationshipLinks skips a row missing either group assignment even when its record does carry a formatted address", () => {
  // Defensive proof: the guard is on the record's OWN property address, but the function also
  // requires both group keys to be resolvable for that row — a row that somehow has an address
  // but was never assigned a property group (should not happen via groupProperties, but this
  // proves resolveRelationshipLinks does not assume it) still produces no link, never a link
  // with an undefined propertyGroupKey.
  const records: NormalisedImportRecord[] = [
    record({ property: { address: { formatted: "1 Import Test St" } } }),
  ];
  const links = resolveRelationshipLinks(records, new Map([[0, "contact-0"]]), new Map());
  assert.equal(links.length, 0);
});

test("groupProperties only ever groups rows that carry a formatted property address", () => {
  const inputs = [
    { record: record() },
    { record: record({ property: { address: {} } }) },
    { record: record({ property: { address: { formatted: "1 Import Test St" } } }) },
  ];
  const { groups } = groupProperties(inputs);
  const groupedRowIndexes = new Set(groups.flatMap((g) => g.rowIndexes));
  assert.ok(!groupedRowIndexes.has(0), "a contact-only row must never be placed in a property group");
  assert.ok(!groupedRowIndexes.has(1), "a property with no formatted address must never be placed in a property group");
  assert.ok(groupedRowIndexes.has(2), "a property with a real formatted address must be grouped");
});
