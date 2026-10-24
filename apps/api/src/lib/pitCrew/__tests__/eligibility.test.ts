// Pit Crew D1/D2 eligibility scaffolding (Owner t165u). Only decided rules
// produce ELIGIBLE / NOT_ELIGIBLE; everything else must stay UNDETERMINED.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePitCrewEligibility, PIT_CREW_SERVICE_CATEGORIES } from "../eligibility.js";

test("emerging agent: pre-listing support requires a confirmed appointment", () => {
  assert.deepEqual(evaluatePitCrewEligibility({ agentClass: "EMERGING", category: "PRE_LISTING", hasConfirmedAppointment: true }), {
    decision: "ELIGIBLE",
    reason: "EMERGING_CONFIRMED_APPOINTMENT",
  });
  assert.deepEqual(evaluatePitCrewEligibility({ agentClass: "EMERGING", category: "PRE_LISTING", hasConfirmedAppointment: false }), {
    decision: "NOT_ELIGIBLE",
    reason: "EMERGING_NO_CONFIRMED_APPOINTMENT",
  });
});

test("emerging agent: general administration and speculative seller opportunities are excluded, appointment or not", () => {
  for (const category of ["GENERAL_ADMINISTRATION", "SPECULATIVE_SELLER_OPPORTUNITY"] as const) {
    for (const hasConfirmedAppointment of [true, false]) {
      assert.deepEqual(evaluatePitCrewEligibility({ agentClass: "EMERGING", category, hasConfirmedAppointment }), {
        decision: "NOT_ELIGIBLE",
        reason: "OWNER_EXCLUDED_CATEGORY",
      });
    }
  }
});

test("open policy stays UNDETERMINED with the matrix item id, never guessed", () => {
  const cases: Array<[Parameters<typeof evaluatePitCrewEligibility>[0], string[]]> = [
    [{ agentClass: "EMERGING", category: "OTHER", hasConfirmedAppointment: true }, ["D2.3"]],
    [{ agentClass: "PERFORMING", category: "PRE_LISTING", hasConfirmedAppointment: false }, ["D1.5"]],
    [{ agentClass: "PERFORMING", category: "GENERAL_ADMINISTRATION", hasConfirmedAppointment: false }, ["D1.6"]],
    [{ agentClass: "PERFORMING", category: "SPECULATIVE_SELLER_OPPORTUNITY", hasConfirmedAppointment: true }, ["D1.6"]],
    [{ agentClass: "PERFORMING", category: "OTHER", hasConfirmedAppointment: false }, ["D2.3"]],
    [{ agentClass: null, category: "PRE_LISTING", hasConfirmedAppointment: true }, ["D1.7", "D1.8"]],
  ];
  for (const [input, openItems] of cases) {
    assert.deepEqual(evaluatePitCrewEligibility(input), { decision: "UNDETERMINED", openItems }, JSON.stringify(input));
  }
});

test("exhaustive: ELIGIBLE only for emerging + pre-listing + confirmed appointment", () => {
  for (const agentClass of ["EMERGING", "PERFORMING", null] as const) {
    for (const category of PIT_CREW_SERVICE_CATEGORIES) {
      for (const hasConfirmedAppointment of [true, false]) {
        const r = evaluatePitCrewEligibility({ agentClass, category, hasConfirmedAppointment });
        const expectEligible = agentClass === "EMERGING" && category === "PRE_LISTING" && hasConfirmedAppointment;
        assert.equal(r.decision === "ELIGIBLE", expectEligible, JSON.stringify({ agentClass, category, hasConfirmedAppointment }));
      }
    }
  }
});
