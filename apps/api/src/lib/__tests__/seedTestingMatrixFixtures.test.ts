// t273u: the testing seed carries the people the acceptance matrix names
// (G04: Hana, Gus, Iris) and one contact covering every Contact 360
// Grow-interest case, so testers no longer substitute contacts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MATRIX_CONSENT_FIXTURES, MATRIX_GROW_FIXTURE, MATRIX_GROW_FIXTURE_ROWS, SCENARIOS } from "../../scripts/seedTestingEnv.js";

test("G04 consent fixtures are named as in the matrix, with distinct fictional (07) 5550 numbers", () => {
  assert.deepEqual(MATRIX_CONSENT_FIXTURES.map((f) => [f.first, f.state]), [["Hana", "express"], ["Gus", "withdrawn"], ["Iris", "register"]]);
  const all = [...SCENARIOS.map((s) => s.mobile), ...MATRIX_CONSENT_FIXTURES.map((f) => f.mobile), MATRIX_GROW_FIXTURE.mobile];
  assert.equal(new Set(all).size, all.length, "no fixture reuses a scenario number");
  for (const f of MATRIX_CONSENT_FIXTURES) assert.match(f.mobile, /^\(07\) 5550 9\d{3}$/);
});

test("the Grow fixture covers matched, unknown+Historical, former owner, pending review and plain interest", () => {
  const rows = MATRIX_GROW_FIXTURE_ROWS;
  assert.ok(rows.some((r) => r.property === 0 && r.relationshipType === "buyer" && r.status === "Active"), "matches the canonical Buyer link");
  assert.ok(rows.some((r) => r.status === "Historical" && !["owner", "tenant", "landlord", "buyer", "former_owner", "prospective_seller"].includes(r.relationshipType)), "unknown type, Historical");
  assert.ok(rows.some((r) => r.relationshipType === "former_owner"));
  assert.ok(rows.some((r) => r.status === "PendingReview"));
  assert.ok(rows.some((r) => r.relationshipType === "prospective_seller" && r.status === "Active"));
});
