// Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7). Pure-function
// coverage for types.ts: the status transition table (Section 9), the
// dedup/prioritisation comparator (Sections 10-11), and the PC-relevance
// predicate (Section 6/10). No DB, no server -- everything here is a plain
// function of its inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PIT_CREW_ITEM_STATUSES,
  isValidPitCrewTransition,
  comparePcWorkItems,
  comparePcWaitingOnItems,
  isPcWorkItemOverdue,
  isPitCrewRelevantOwnerType,
  type PcWorkItem,
  type PitCrewItemStatus,
} from "../types.js";

test("isValidPitCrewTransition allows every documented edge", () => {
  assert.equal(isValidPitCrewTransition("UNCLAIMED", "CLAIMED"), true);
  assert.equal(isValidPitCrewTransition("CLAIMED", "IN_PROGRESS"), true);
  assert.equal(isValidPitCrewTransition("CLAIMED", "WAITING_ON"), true);
  assert.equal(isValidPitCrewTransition("CLAIMED", "DONE"), true);
  assert.equal(isValidPitCrewTransition("CLAIMED", "UNCLAIMED"), true);
  assert.equal(isValidPitCrewTransition("IN_PROGRESS", "WAITING_ON"), true);
  assert.equal(isValidPitCrewTransition("IN_PROGRESS", "DONE"), true);
  assert.equal(isValidPitCrewTransition("IN_PROGRESS", "UNCLAIMED"), true);
  assert.equal(isValidPitCrewTransition("WAITING_ON", "IN_PROGRESS"), true);
  assert.equal(isValidPitCrewTransition("WAITING_ON", "DONE"), true);
  assert.equal(isValidPitCrewTransition("WAITING_ON", "UNCLAIMED"), true);
  assert.equal(isValidPitCrewTransition("CLAIMED", "HANDED_BACK"), true);
  assert.equal(isValidPitCrewTransition("CLAIMED", "ESCALATED"), true);
  assert.equal(isValidPitCrewTransition("IN_PROGRESS", "HANDED_BACK"), true);
  assert.equal(isValidPitCrewTransition("IN_PROGRESS", "ESCALATED"), true);
  assert.equal(isValidPitCrewTransition("WAITING_ON", "HANDED_BACK"), true);
  assert.equal(isValidPitCrewTransition("WAITING_ON", "ESCALATED"), true);
  assert.equal(isValidPitCrewTransition("HANDED_BACK", "CLAIMED"), true);
  assert.equal(isValidPitCrewTransition("ESCALATED", "IN_PROGRESS"), true);
});

test("isValidPitCrewTransition rejects everything not explicitly listed", () => {
  assert.equal(isValidPitCrewTransition("DONE", "CLAIMED"), false);
  assert.equal(isValidPitCrewTransition("DONE", "IN_PROGRESS"), false);
  assert.equal(isValidPitCrewTransition("DONE", "UNCLAIMED"), false);
  assert.equal(isValidPitCrewTransition("UNCLAIMED", "IN_PROGRESS"), false);
  assert.equal(isValidPitCrewTransition("UNCLAIMED", "WAITING_ON"), false);
  assert.equal(isValidPitCrewTransition("UNCLAIMED", "DONE"), false);
  assert.equal(isValidPitCrewTransition("CLAIMED", "CLAIMED"), false);
  assert.equal(isValidPitCrewTransition("UNCLAIMED", "HANDED_BACK"), false);
  assert.equal(isValidPitCrewTransition("UNCLAIMED", "ESCALATED"), false);
  assert.equal(isValidPitCrewTransition("DONE", "HANDED_BACK"), false);
  assert.equal(isValidPitCrewTransition("DONE", "ESCALATED"), false);
  assert.equal(isValidPitCrewTransition("HANDED_BACK", "ESCALATED"), false);
  assert.equal(isValidPitCrewTransition("HANDED_BACK", "DONE"), false);
  assert.equal(isValidPitCrewTransition("HANDED_BACK", "IN_PROGRESS"), false);
  assert.equal(isValidPitCrewTransition("HANDED_BACK", "WAITING_ON"), false);
  assert.equal(isValidPitCrewTransition("HANDED_BACK", "UNCLAIMED"), false);
  assert.equal(isValidPitCrewTransition("ESCALATED", "HANDED_BACK"), false);
  assert.equal(isValidPitCrewTransition("ESCALATED", "DONE"), false);
  assert.equal(isValidPitCrewTransition("ESCALATED", "CLAIMED"), false);
  assert.equal(isValidPitCrewTransition("ESCALATED", "UNCLAIMED"), false);
  assert.equal(isValidPitCrewTransition("ESCALATED", "WAITING_ON"), false);
  assert.equal(isValidPitCrewTransition("ESCALATED", "ESCALATED"), false);
});

test("every status has a transition table entry (no silently-terminal gaps)", () => {
  for (const status of PIT_CREW_ITEM_STATUSES) {
    for (const target of PIT_CREW_ITEM_STATUSES) {
      // Should never throw, and DONE should be the only status with zero
      // outbound edges (Section 9: PC work is closed, not deleted).
      const ok = isValidPitCrewTransition(status, target);
      assert.equal(typeof ok, "boolean");
    }
  }
  const outboundFromDone = PIT_CREW_ITEM_STATUSES.filter((t) => isValidPitCrewTransition("DONE", t));
  assert.deepEqual(outboundFromDone, []);
  const terminal = PIT_CREW_ITEM_STATUSES.filter((status) =>
    PIT_CREW_ITEM_STATUSES.every((target) => !isValidPitCrewTransition(status, target)),
  );
  assert.deepEqual(terminal, ["DONE"]);
});

function buildItem(overrides: Partial<PcWorkItem> = {}): PcWorkItem {
  return {
    sourceType: "EXCEPTION",
    sourceRecordId: "1",
    propertyId: 1,
    propertyAddress: "1 Test St",
    brokerageId: 1,
    title: "Test item",
    description: "Test",
    category: "LISTING",
    severity: "ATTENTION",
    exceptionStatus: "OPEN",
    ownerType: "PIT_CREW",
    ownerUserId: null,
    ownerName: null,
    dueAt: null,
    overdue: false,
    recommendedAction: "Do the thing",
    deepLink: "/properties/1",
    detectedAt: new Date().toISOString(),
    pcStatus: "UNCLAIMED" as PitCrewItemStatus,
    assignedToUserId: null,
    assignedToName: null,
    claimedAt: null,
    waitingOnParty: null,
    waitingOnNote: null,
    waitingOnSince: null,
    waitingOnExpectedAt: null,
    handoffFromUserId: null,
    handoffToUserId: null,
    handoffNote: null,
    handoffAt: null,
    completedAt: null,
    version: 0,
    ...overrides,
  };
}

test("comparePcWorkItems ranks CRITICAL before AT_RISK before ATTENTION before INFORMATION", () => {
  const critical = buildItem({ sourceRecordId: "c", severity: "CRITICAL" });
  const atRisk = buildItem({ sourceRecordId: "r", severity: "AT_RISK" });
  const attention = buildItem({ sourceRecordId: "a", severity: "ATTENTION" });
  const information = buildItem({ sourceRecordId: "i", severity: "INFORMATION" });
  const sorted = [information, attention, critical, atRisk].sort(comparePcWorkItems);
  assert.deepEqual(sorted.map((i) => i.sourceRecordId), ["c", "r", "a", "i"]);
});

test("comparePcWorkItems breaks ties within a severity by earliest dueAt first", () => {
  const later = buildItem({ sourceRecordId: "later", severity: "AT_RISK", dueAt: "2026-12-31T00:00:00.000Z" });
  const sooner = buildItem({ sourceRecordId: "sooner", severity: "AT_RISK", dueAt: "2026-01-01T00:00:00.000Z" });
  const noDue = buildItem({ sourceRecordId: "none", severity: "AT_RISK", dueAt: null });
  const sorted = [noDue, later, sooner].sort(comparePcWorkItems);
  assert.deepEqual(sorted.map((i) => i.sourceRecordId), ["sooner", "later", "none"]);
});

test("isPitCrewRelevantOwnerType is true only for PIT_CREW and UNASSIGNED_QUEUE", () => {
  assert.equal(isPitCrewRelevantOwnerType("PIT_CREW"), true);
  assert.equal(isPitCrewRelevantOwnerType("UNASSIGNED_QUEUE"), true);
  assert.equal(isPitCrewRelevantOwnerType("AGENT"), false);
  assert.equal(isPitCrewRelevantOwnerType("BROKERAGE_ADMIN"), false);
  assert.equal(isPitCrewRelevantOwnerType("SYSTEM"), false);
});

// #29 — WAITING_ON expected-at overdue rule (pure).
test("isPcWorkItemOverdue: source dueAt rule is unchanged", () => {
  const now = new Date("2026-10-19T00:00:00Z");
  const past = new Date("2026-10-18T23:00:00Z");
  const future = new Date("2026-10-19T01:00:00Z");
  assert.equal(isPcWorkItemOverdue({ dueAt: past, pcStatus: "CLAIMED", waitingOnExpectedAt: null }, now), true);
  assert.equal(isPcWorkItemOverdue({ dueAt: future, pcStatus: "CLAIMED", waitingOnExpectedAt: null }, now), false);
  assert.equal(isPcWorkItemOverdue({ dueAt: null, pcStatus: "IN_PROGRESS", waitingOnExpectedAt: null }, now), false);
  assert.equal(isPcWorkItemOverdue({ dueAt: now, pcStatus: "CLAIMED", waitingOnExpectedAt: null }, now), false, "strictly before now");
});

test("isPcWorkItemOverdue: WAITING_ON past expected-at is overdue; future, equal, or null is not", () => {
  const now = new Date("2026-10-19T00:00:00Z");
  const past = new Date("2026-10-18T23:59:59Z");
  const future = new Date("2026-10-19T00:00:01Z");
  assert.equal(isPcWorkItemOverdue({ dueAt: null, pcStatus: "WAITING_ON", waitingOnExpectedAt: past }, now), true);
  assert.equal(isPcWorkItemOverdue({ dueAt: null, pcStatus: "WAITING_ON", waitingOnExpectedAt: future }, now), false);
  assert.equal(isPcWorkItemOverdue({ dueAt: null, pcStatus: "WAITING_ON", waitingOnExpectedAt: now }, now), false);
  assert.equal(isPcWorkItemOverdue({ dueAt: null, pcStatus: "WAITING_ON", waitingOnExpectedAt: null }, now), false);
});

test("isPcWorkItemOverdue: a stale expected-at on a non-WAITING_ON status does not count", () => {
  const now = new Date("2026-10-19T00:00:00Z");
  const past = new Date("2026-10-18T00:00:00Z");
  for (const pcStatus of ["UNCLAIMED", "CLAIMED", "IN_PROGRESS", "DONE", "HANDED_BACK", "ESCALATED"] as PitCrewItemStatus[]) {
    assert.equal(isPcWorkItemOverdue({ dueAt: null, pcStatus, waitingOnExpectedAt: past }, now), false, pcStatus);
  }
});

test("comparePcWaitingOnItems: overdue first, then the shared severity/dueAt order", () => {
  const base = { dueAt: null, overdue: false } as Partial<PcWorkItem>;
  const critical = { ...base, severity: "CRITICAL", sourceRecordId: "c" } as PcWorkItem;
  const attentionOverdue = { ...base, severity: "ATTENTION", overdue: true, sourceRecordId: "a" } as PcWorkItem;
  const infoOverdue = { ...base, severity: "INFORMATION", overdue: true, sourceRecordId: "i" } as PcWorkItem;
  const sorted = [critical, infoOverdue, attentionOverdue].sort(comparePcWaitingOnItems).map((i) => i.sourceRecordId);
  assert.deepEqual(sorted, ["a", "i", "c"]);
  // comparePcWorkItems itself is unchanged: severity still wins there.
  assert.deepEqual([attentionOverdue, critical].sort(comparePcWorkItems).map((i) => i.sourceRecordId), ["c", "a"]);
});
