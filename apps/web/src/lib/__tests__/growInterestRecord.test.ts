import assert from "node:assert/strict";
import test from "node:test";
import { canRecordGrowInterest, growInterestBody, growInterestErrorText, GROW_INTEREST_DUPLICATE_TEXT, GROW_INTEREST_PATH } from "../growInterestRecord";

const has = (keys: string[]) => (k: string) => keys.includes(k);

test("t274u item 3: Record Grow interest posts one Grow relationship only (never /parties)", () => {
  assert.equal(GROW_INTEREST_PATH, "/grow/relationships");
  assert.deepEqual(growInterestBody(5, 9, "prospective_seller"), { partyId: 5, propertyId: 9, relationshipType: "prospective_seller", sourceType: "manual" });
  assert.deepEqual(growInterestBody(5, null, "prospective_buyer"), { partyId: 5, relationshipType: "prospective_buyer", sourceType: "manual" });
  assert.equal("role" in growInterestBody(5, 9, "owner"), false, "no canonical role field");
});

test("t274u item 3: visibility mirrors the server — grow.relationships.manage, never Pit Crew", () => {
  assert.equal(canRecordGrowInterest(has(["grow.relationships.manage"]), "Agent"), true);
  assert.equal(canRecordGrowInterest(has(["grow.relationships.manage"]), "Pit Crew"), false);
  assert.equal(canRecordGrowInterest(has(["run.access"]), "Agent"), false);
});

test("t274u item 3: duplicate (409) reads as already recorded", () => {
  assert.equal(growInterestErrorText(409, "x"), GROW_INTEREST_DUPLICATE_TEXT);
  assert.equal(growInterestErrorText(500, "x"), "x");
});
