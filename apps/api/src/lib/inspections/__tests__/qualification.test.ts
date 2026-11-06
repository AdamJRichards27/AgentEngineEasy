import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateBuyerQualification, type BuyerQualificationFacts } from "../qualification.js";

const now = new Date("2026-10-24T00:00:00Z");
const good: BuyerQualificationFacts = {
  mobileConfirmed: true,
  emailConfirmed: true,
  nameMatchesParty: true,
  timeframeMonths: 3,
  inspectedComparableOrAttendedOpenHome: true,
  financePosition: "PRE_APPROVAL",
  financeSightedAt: new Date("2026-10-20T00:00:00Z"),
  requirementsRecorded: true,
  requirementsRelevantToListing: true,
  assessedAt: new Date("2026-10-20T00:00:00Z"),
};
const ev = (f: Partial<BuyerQualificationFacts>, validForDays = 90) => evaluateBuyerQualification({ ...good, ...f }, { now, validForDays });

test("standard model: all four criteria pass -> qualified", () => {
  assert.deepEqual(ev({}), { qualified: true, failures: [] });
  assert.deepEqual(ev({ financePosition: "PROOF_OF_FUNDS" }), { qualified: true, failures: [] });
  assert.deepEqual(ev({ timeframeMonths: 6 }), { qualified: true, failures: [] });
});

test("Q1: mobile AND email confirmed AND name matches", () => {
  for (const f of [{ mobileConfirmed: false }, { emailConfirmed: false }, { nameMatchesParty: false }]) {
    assert.deepEqual(ev(f).failures, ["Q1_CONTACT_NOT_VERIFIED"], JSON.stringify(f));
  }
});

test("Q2: timeframe <= 6 months AND comparable inspection/open home", () => {
  for (const f of [{ timeframeMonths: 7 }, { timeframeMonths: null }, { timeframeMonths: -1 }, { inspectedComparableOrAttendedOpenHome: false }]) {
    assert.deepEqual(ev(f).failures, ["Q2_NOT_READY"], JSON.stringify(f));
  }
});

test("Q3: pre-approval or proof of funds must be sighted; arranging/unknown never qualifies", () => {
  for (const f of [{ financePosition: "ARRANGING" as const }, { financePosition: "UNKNOWN" as const }, { financeSightedAt: null }]) {
    assert.deepEqual(ev(f).failures, ["Q3_FINANCE_NOT_SIGHTED"], JSON.stringify(f));
  }
});

test("Q4: requirements recorded and relevant", () => {
  assert.deepEqual(ev({ requirementsRecorded: false }).failures, ["Q4_REQUIREMENTS_NOT_RELEVANT"]);
  assert.deepEqual(ev({ requirementsRelevantToListing: false }).failures, ["Q4_REQUIREMENTS_NOT_RELEVANT"]);
});

test("validity period is caller-supplied (open decision): no built-in default, expiry reported", () => {
  assert.deepEqual(ev({}, 3).failures, ["EXPIRED"]);
  assert.deepEqual(ev({}, 4).failures, []);
  assert.throws(() => evaluateBuyerQualification(good, { now, validForDays: 0 }));
  assert.throws(() => evaluateBuyerQualification(good, { now, validForDays: 1.5 }));
});

test("all failures are reported together", () => {
  assert.deepEqual(ev({ emailConfirmed: false, timeframeMonths: 12, financePosition: "ARRANGING", requirementsRecorded: false }, 1).failures, [
    "Q1_CONTACT_NOT_VERIFIED",
    "Q2_NOT_READY",
    "Q3_FINANCE_NOT_SIGHTED",
    "Q4_REQUIREMENTS_NOT_RELEVANT",
    "EXPIRED",
  ]);
});
