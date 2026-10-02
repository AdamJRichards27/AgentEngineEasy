import assert from "node:assert/strict";
import test from "node:test";
import { normalizePersonName, PERSON_NAME_MAX_LENGTH } from "../personName.js";

test("person names trim and reject blank values", () => {
  assert.deepEqual(normalizePersonName("  Ada  ", "First name"), { ok: true, value: "Ada" });
  assert.deepEqual(normalizePersonName("   ", "First name"), { ok: false, error: "First name is required." });
  assert.deepEqual(normalizePersonName("", "Last name"), { ok: false, error: "Last name is required." });
  assert.deepEqual(normalizePersonName(undefined, "Last name"), { ok: false, error: "Last name is required." });
});

test("person names reject values over the length limit", () => {
  const over = "A".repeat(PERSON_NAME_MAX_LENGTH + 1);
  const atLimit = "B".repeat(PERSON_NAME_MAX_LENGTH);
  assert.equal(normalizePersonName(over, "First name").ok, false);
  assert.deepEqual(normalizePersonName(atLimit, "First name"), { ok: true, value: atLimit });
});
