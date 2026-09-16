// AE GROW Priority 6 Stage F1 — §7, §22 call-session state machine tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidCallSessionTransition,
  assertValidCallSessionTransition,
  CallSessionTransitionError,
  TERMINAL_CALL_SESSION_STATUSES,
  isValidRecordingTransition,
  assertValidRecordingTransition,
  RecordingStateTransitionError,
} from "../stateMachine.js";

test("the full happy-path lifecycle is a chain of valid transitions", () => {
  const happyPath: Array<[string, string]> = [
    ["DRAFT", "READY"],
    ["READY", "DIAL_REQUESTED"],
    ["DIAL_REQUESTED", "RINGING"],
    ["RINGING", "CONNECTED"],
    ["CONNECTED", "COMPLETED"],
  ];
  for (const [from, to] of happyPath) {
    assert.equal(isValidCallSessionTransition(from, to), true, `${from} -> ${to} should be valid`);
  }
});

test("cancellation is valid from every non-terminal, non-CONNECTED state", () => {
  for (const from of ["DRAFT", "READY", "DIAL_REQUESTED", "RINGING"]) {
    assert.equal(isValidCallSessionTransition(from, "CANCELLED"), true, `${from} -> CANCELLED should be valid`);
  }
});

test("CONNECTED cannot be cancelled — only COMPLETED or FAILED", () => {
  assert.equal(isValidCallSessionTransition("CONNECTED", "CANCELLED"), false);
  assert.equal(isValidCallSessionTransition("CONNECTED", "COMPLETED"), true);
  assert.equal(isValidCallSessionTransition("CONNECTED", "FAILED"), true);
});

test("terminal states accept no further transitions", () => {
  for (const terminal of TERMINAL_CALL_SESSION_STATUSES) {
    for (const target of ["DRAFT", "READY", "DIAL_REQUESTED", "RINGING", "CONNECTED", "COMPLETED", "FAILED", "CANCELLED"]) {
      assert.equal(isValidCallSessionTransition(terminal, target), false, `${terminal} -> ${target} must be invalid`);
    }
  }
});

test("invalid transitions are rejected — including skipping states and moving backwards", () => {
  assert.equal(isValidCallSessionTransition("DRAFT", "CONNECTED"), false, "cannot skip straight to CONNECTED");
  assert.equal(isValidCallSessionTransition("RINGING", "DRAFT"), false, "cannot move backwards");
  assert.equal(isValidCallSessionTransition("READY", "RINGING"), false, "cannot skip DIAL_REQUESTED");
});

test("assertValidCallSessionTransition throws a typed error naming both states on an invalid transition", () => {
  assert.throws(
    () => assertValidCallSessionTransition("DRAFT", "CONNECTED"),
    (err: unknown) => err instanceof CallSessionTransitionError && err.from === "DRAFT" && err.to === "CONNECTED",
  );
});

test("assertValidCallSessionTransition does not throw on a valid transition", () => {
  assert.doesNotThrow(() => assertValidCallSessionTransition("DRAFT", "READY"));
});

test("recording sub-state is orthogonal and requires in-call disclosure before confirmation", () => {
  assert.equal(isValidRecordingTransition("DISCLOSURE_REQUIRED", "DISCLOSED"), true);
  assert.equal(isValidRecordingTransition("DISCLOSED", "CONFIRMED"), true);
  assert.equal(isValidRecordingTransition("DISCLOSURE_REQUIRED", "CONFIRMED"), false);
  assert.equal(isValidRecordingTransition("CONFIRMED", "UNRECORDED"), true);
  assert.equal(isValidRecordingTransition("UNRECORDED", "CONNECTED"), false);
});

test("recording sub-state transition errors identify both recording states", () => {
  assert.throws(
    () => assertValidRecordingTransition("DISCLOSURE_REQUIRED", "CONFIRMED"),
    (err: unknown) =>
      err instanceof RecordingStateTransitionError &&
      err.from === "DISCLOSURE_REQUIRED" &&
      err.to === "CONFIRMED",
  );
});
