import assert from "node:assert/strict";
import test from "node:test";

// growToday.ts imports @aee/db, which refuses to load unless DATABASE_URL is
// set. This file never queries. A placeholder is used only when the runner
// has not already supplied one, and nothing here connects to it.
process.env.DATABASE_URL ??= "postgres://127.0.0.1:1/aee_e2_unused";

const { appraisalFollowUpAvailableActions } = await import("../growToday.js");

// E-2 — Rule E's action list. view_appraisal was already the primary action
// and the only path to the appraisal; the card never also offered the
// property it belongs to. These tests pin the list itself, including the
// null-property case that must not invent a view_property button.

const anchored = {
  id: 9,
  propertyId: 44,
  partyId: 3,
  partyEmail: "ana@example.com",
  partyMobile: "0400000000",
};

test("E-2: a Rule E card keeps view_appraisal first and adds view_property when the appraisal has a property", () => {
  const actions = appraisalFollowUpAvailableActions(anchored, false);

  assert.deepEqual(actions[0], { action: "view_appraisal", appraisalId: 9 });
  assert.ok(
    actions.some((b) => b.action === "view_property" && "propertyId" in b && b.propertyId === 44),
    "view_property carries the appraisal's property id",
  );
  const appraisalAt = actions.findIndex((b) => b.action === "view_appraisal");
  const propertyAt = actions.findIndex((b) => b.action === "view_property");
  assert.ok(appraisalAt === 0 && propertyAt > appraisalAt, "view_appraisal stays the primary action");

  assert.ok(actions.some((b) => b.action === "email" && "partyId" in b && b.partyId === 3));
  assert.ok(actions.some((b) => b.action === "sms" && "partyId" in b && b.partyId === 3));
  assert.ok(actions.some((b) => b.action === "view_contact" && "partyId" in b && b.partyId === 3));
  assert.ok(actions.some((b) => b.action === "ask_ae"));
});

test("E-2: a Rule E card with no property does not emit view_property", () => {
  const actions = appraisalFollowUpAvailableActions({ ...anchored, propertyId: null, partyEmail: null, partyMobile: null }, false);

  assert.deepEqual(actions[0], { action: "view_appraisal", appraisalId: 9 });
  assert.equal(
    actions.some((b) => b.action === "view_property"),
    false,
    "no property means no view_property button — never one whose id is null",
  );
  assert.equal(JSON.stringify(actions).includes("null"), false);
  assert.ok(actions.some((b) => b.action === "view_contact"));
  assert.equal(actions.some((b) => b.action === "email" || b.action === "sms"), false);
});

test("E-2: do-not-contact still strips outreach and keeps both view actions", () => {
  const actions = appraisalFollowUpAvailableActions(anchored, true);

  assert.equal(actions[0]?.action, "view_appraisal");
  assert.ok(actions.some((b) => b.action === "view_property" && "propertyId" in b && b.propertyId === 44));
  assert.equal(actions.some((b) => b.action === "email" || b.action === "sms"), false);
  assert.ok(actions.some((b) => b.action === "view_contact"));
  assert.ok(actions.some((b) => b.action === "ask_ae"));
});
