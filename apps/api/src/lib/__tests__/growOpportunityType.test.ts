import assert from "node:assert/strict";
import test from "node:test";
import {
  CLASSIFIED_OPPORTUNITY_TYPES,
  GROW_OPPORTUNITY_LIST_TYPE_FILTER_LABELS,
  GROW_OPPORTUNITY_LIST_TYPE_FILTERS,
  GROW_OPPORTUNITY_TYPES,
  PROPERTY_MANAGEMENT_OPPORTUNITY_TYPE,
  SELLER_SIDE_OPPORTUNITY_TYPES,
  classifyGrowOpportunityType,
  parseGrowOpportunityListTypeFilter,
  type GrowOpportunityTypeGroup,
} from "@aee/domain";

const EXPECTED_GROUP: Record<(typeof GROW_OPPORTUNITY_TYPES)[number], GrowOpportunityTypeGroup> = {
  Listing: "seller_side",
  Appraisal: "seller_side",
  PropertyManagement: "property_management",
  Other: "other",
};

test("every stored opportunity type classifies once, and unknown values stay other", () => {
  assert.deepEqual([...GROW_OPPORTUNITY_TYPES], ["Listing", "Appraisal", "PropertyManagement", "Other"]);
  assert.deepEqual(
    Object.keys(EXPECTED_GROUP).sort(),
    [...GROW_OPPORTUNITY_TYPES].sort(),
  );

  for (const type of GROW_OPPORTUNITY_TYPES) {
    assert.equal(classifyGrowOpportunityType(type), EXPECTED_GROUP[type], type);
  }

  assert.deepEqual(
    [...SELLER_SIDE_OPPORTUNITY_TYPES],
    GROW_OPPORTUNITY_TYPES.filter((type) => classifyGrowOpportunityType(type) === "seller_side"),
  );
  assert.equal(PROPERTY_MANAGEMENT_OPPORTUNITY_TYPE, "PropertyManagement");
  assert.equal(classifyGrowOpportunityType(PROPERTY_MANAGEMENT_OPPORTUNITY_TYPE), "property_management");
  assert.equal(
    (SELLER_SIDE_OPPORTUNITY_TYPES as readonly string[]).includes(PROPERTY_MANAGEMENT_OPPORTUNITY_TYPE),
    false,
  );
  assert.equal((SELLER_SIDE_OPPORTUNITY_TYPES as readonly string[]).includes("Other"), false);
  assert.deepEqual(
    [...CLASSIFIED_OPPORTUNITY_TYPES],
    GROW_OPPORTUNITY_TYPES.filter((type) => classifyGrowOpportunityType(type) !== "other"),
  );
  assert.equal((CLASSIFIED_OPPORTUNITY_TYPES as readonly string[]).includes("Other"), false);

  for (const value of [null, undefined, "", "General", "Property Management", "listing", "Seller", "seller_side"]) {
    assert.equal(classifyGrowOpportunityType(value), "other", JSON.stringify(value));
  }
});

test("the list filter accepts only the four groups and labels them for the screen", () => {
  assert.deepEqual([...GROW_OPPORTUNITY_LIST_TYPE_FILTERS], ["all", "seller_side", "property_management", "other"]);
  assert.deepEqual(GROW_OPPORTUNITY_LIST_TYPE_FILTER_LABELS, {
    all: "All",
    seller_side: "Seller-side (Listing + Appraisal)",
    property_management: "Property Management",
    other: "Other",
  });
  assert.deepEqual(parseGrowOpportunityListTypeFilter(undefined), { ok: true, filter: "all" });
  for (const filter of GROW_OPPORTUNITY_LIST_TYPE_FILTERS) {
    assert.deepEqual(parseGrowOpportunityListTypeFilter(filter), { ok: true, filter });
  }
  for (const raw of ["", "Listing", "Appraisal", "PropertyManagement", "Other", "seller", "SELLER_SIDE", " property_management", ["seller_side"], 1, null]) {
    const parsed = parseGrowOpportunityListTypeFilter(raw);
    assert.equal(parsed.ok, false, JSON.stringify(raw));
    if (!parsed.ok) assert.equal(parsed.error, "type must be one of all, seller_side, property_management, other");
  }
});
