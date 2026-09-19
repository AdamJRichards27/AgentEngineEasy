import assert from "node:assert/strict";
import test from "node:test";
import { aiSurfaceAvailability, aiSurfaceUnavailableCopy } from "../aiCapability";

// AE GROW Pilot Readiness WP6b P3-b — the Performance tab rendered blank when
// the Business Coach flag was off.

const both = { copilotEnabled: true, businessCoachEnabled: true };
const coachOff = { copilotEnabled: true, businessCoachEnabled: false };
const copilotOff = { copilotEnabled: false, businessCoachEnabled: false };

test("a disabled Grow surface is explained, never blank", () => {
  assert.equal(aiSurfaceAvailability(coachOff, { isGrow: true, isCoach: true }), "unavailable");
  assert.equal(aiSurfaceAvailability(copilotOff, { isGrow: true, isCoach: false }), "unavailable");
});

test("RUN Copilot's embedded panel keeps hiding itself when disabled", () => {
  assert.equal(aiSurfaceAvailability(copilotOff, { isGrow: false, isCoach: false }), "hidden");
});

test("enabled, and not-yet-probed, both render the surface", () => {
  assert.equal(aiSurfaceAvailability(both, { isGrow: true, isCoach: true }), "available");
  assert.equal(aiSurfaceAvailability(both, { isGrow: false, isCoach: false }), "available");
  assert.equal(aiSurfaceAvailability(coachOff, { isGrow: true, isCoach: false }), "available", "Ask AE is gated on copilotEnabled, not the coach flag");
  assert.equal(aiSurfaceAvailability(undefined, { isGrow: true, isCoach: true }), "available", "no flash of 'not enabled' while loading");
});

test("the disabled copy names the surface and points at a Brokerage Administrator", () => {
  const coach = aiSurfaceUnavailableCopy(true);
  assert.equal(coach.title, "Business Coach");
  assert.match(coach.body, /isn’t enabled for this brokerage/);
  assert.match(coach.body, /Brokerage Administrator/);
  const ask = aiSurfaceUnavailableCopy(false);
  assert.equal(ask.title, "Ask AE");
  assert.match(ask.body, /isn’t enabled for this brokerage/);
});
