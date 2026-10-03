// D6 — a reschedule is read in the brokerage's time zone. The UAT sentence
// "2026-10-03T00:00:00.000Z to 2026-10-04T23:00:00.000Z" is 3 Oct 10:00 am to
// 5 Oct 9:00 am in Australia/Brisbane, not 3 Oct to 4 Oct 11 pm.
import test from "node:test";
import assert from "node:assert/strict";
import {
  commitmentRescheduleSummary,
  formatCommitmentDue,
  isRawRescheduleSummary,
  presentActivitySummary,
} from "../commitmentRescheduleSummary.js";

const PREVIOUS = new Date("2026-10-03T00:00:00.000Z");
const NEXT = new Date("2026-10-04T23:00:00.000Z");
const RAW = "Commitment rescheduled from 2026-10-03T00:00:00.000Z to 2026-10-04T23:00:00.000Z";

test("Brisbane shows the UAT reschedule on the local days, including the time", () => {
  assert.equal(formatCommitmentDue(PREVIOUS, "Australia/Brisbane"), "3 Oct 2026, 10:00 am");
  assert.equal(formatCommitmentDue(NEXT, "Australia/Brisbane"), "5 Oct 2026, 9:00 am");
  assert.equal(
    commitmentRescheduleSummary(PREVIOUS, NEXT, "Australia/Brisbane"),
    "Commitment rescheduled from 3 Oct 2026, 10:00 am to 5 Oct 2026, 9:00 am",
  );
});

test("a stored UTC sentence is presented in the given zone and other summaries stay as written", () => {
  assert.equal(isRawRescheduleSummary(RAW), true);
  assert.equal(
    presentActivitySummary(RAW, "Australia/Brisbane"),
    "Commitment rescheduled from 3 Oct 2026, 10:00 am to 5 Oct 2026, 9:00 am",
  );
  assert.equal(
    presentActivitySummary(RAW, "America/New_York"),
    "Commitment rescheduled from 2 Oct 2026, 8:00 pm to 4 Oct 2026, 7:00 pm",
  );
  const already = "Commitment rescheduled from 3 Oct 2026, 10:00 am to 5 Oct 2026, 9:00 am";
  assert.equal(presentActivitySummary(already, "America/New_York"), already);
  assert.equal(presentActivitySummary("Commitment completed: call Lou", "Australia/Brisbane"), "Commitment completed: call Lou");
  assert.equal(isRawRescheduleSummary("Commitment rescheduled from yesterday to tomorrow"), false);
});

test("midnight in Brisbane is the next local day, and an invalid zone falls back to Brisbane", () => {
  assert.equal(formatCommitmentDue(new Date("2026-10-03T14:00:00.000Z"), "Australia/Brisbane"), "4 Oct 2026, 12:00 am");
  assert.equal(formatCommitmentDue(PREVIOUS, "Not/AZone"), formatCommitmentDue(PREVIOUS, "Australia/Brisbane"));
});
