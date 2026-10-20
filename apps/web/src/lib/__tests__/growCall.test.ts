import { test } from "node:test";
import assert from "node:assert/strict";
import { recordingGateName, sandboxCallStatusLabel, TERMINAL_CALL_STATUSES } from "../growCall";

test("sandboxCallStatusLabel maps each sandbox status and defaults to preparing", () => {
  assert.equal(sandboxCallStatusLabel("READY"), "Ready to confirm");
  assert.equal(sandboxCallStatusLabel("DIAL_REQUESTED"), "Sandbox dial requested");
  assert.equal(sandboxCallStatusLabel("RINGING"), "Sandbox ringing");
  assert.equal(sandboxCallStatusLabel("CONNECTED"), "Connected in sandbox");
  assert.equal(sandboxCallStatusLabel("COMPLETED"), "Sandbox call completed");
  assert.equal(sandboxCallStatusLabel("FAILED"), "Sandbox call failed");
  assert.equal(sandboxCallStatusLabel("CANCELLED"), "Sandbox call cancelled");
  assert.equal(sandboxCallStatusLabel("SOMETHING_NEW"), "Preparing sandbox call");
});

test("TERMINAL_CALL_STATUSES is exactly completed, failed, cancelled", () => {
  assert.deepEqual([...TERMINAL_CALL_STATUSES].sort(), ["CANCELLED", "COMPLETED", "FAILED"]);
});

test("recordingGateName title-cases camelCase gate keys", () => {
  assert.equal(recordingGateName("legalPolicy"), "Legal Policy");
  assert.equal(recordingGateName("legacyConsentAndDisclosure"), "Legacy Consent And Disclosure");
  assert.equal(recordingGateName("entitlement"), "Entitlement");
});
