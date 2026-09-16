import { test } from "node:test";
import assert from "node:assert/strict";
import { allRecordingGatesPassed } from "../recordingGates.js";

const passingGates = {
  entitlement: { passed: true },
  legalPolicy: { passed: true },
  legacyConsentAndDisclosure: { passed: true },
  adapterCapability: { passed: true },
  operationalApproval: { passed: true },
};

test("recording gate conjunction passes only when all five gates pass", () => {
  assert.equal(Object.keys(passingGates).length, 5);
  assert.equal(allRecordingGatesPassed(passingGates), true);
});

for (const gateName of Object.keys(passingGates)) {
  test(`recording gate independently denies when ${gateName} is false`, () => {
    const gates = Object.fromEntries(
      Object.entries(passingGates).map(([name, gate]) => [name, { passed: name === gateName ? false : gate.passed }]),
    );
    assert.equal(allRecordingGatesPassed(gates), false);
  });
}