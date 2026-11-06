import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_INSPECTION_POLICY, evaluateInspectionRequest, resolveInspectionPolicy, INSPECTION_POLICIES } from "../policy.js";

test("default policy is B (Owner t165u); A and C stay configurable; unknown values fall back to B", () => {
  assert.equal(DEFAULT_INSPECTION_POLICY, "B");
  assert.equal(resolveInspectionPolicy(null), "B");
  assert.equal(resolveInspectionPolicy(undefined), "B");
  assert.equal(resolveInspectionPolicy("Z"), "B");
  assert.equal(resolveInspectionPolicy("A"), "A");
  assert.equal(resolveInspectionPolicy("C"), "C");
});

test("full policy matrix A/B/C × OPEN/PRIVATE × qualified/unqualified", () => {
  const expected: Record<string, unknown> = {
    "A|OPEN|true": { allowed: false, code: "INSPECTION_POLICY_OPEN_NOT_ALLOWED" },
    "A|OPEN|false": { allowed: false, code: "INSPECTION_POLICY_OPEN_NOT_ALLOWED" },
    "A|PRIVATE|true": { allowed: true },
    "A|PRIVATE|false": { allowed: false, code: "BUYER_NOT_QUALIFIED" },
    "B|OPEN|true": { allowed: true },
    "B|OPEN|false": { allowed: true },
    "B|PRIVATE|true": { allowed: true },
    "B|PRIVATE|false": { allowed: false, code: "BUYER_NOT_QUALIFIED", alternative: "OPEN" },
    "C|OPEN|true": { allowed: true },
    "C|OPEN|false": { allowed: true },
    "C|PRIVATE|true": { allowed: false, code: "INSPECTION_POLICY_PRIVATE_NOT_ALLOWED", alternative: "OPEN" },
    "C|PRIVATE|false": { allowed: false, code: "INSPECTION_POLICY_PRIVATE_NOT_ALLOWED", alternative: "OPEN" },
  };
  for (const policy of INSPECTION_POLICIES) {
    for (const kind of ["OPEN", "PRIVATE"] as const) {
      for (const q of [true, false]) {
        assert.deepEqual(evaluateInspectionRequest(policy, kind, q), expected[`${policy}|${kind}|${q}`], `${policy}|${kind}|${q}`);
      }
    }
  }
});
