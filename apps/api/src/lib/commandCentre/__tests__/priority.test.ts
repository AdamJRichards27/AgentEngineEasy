import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { priorityFor, compareItems, sectionsFor, ownerLabel } from "../queries.js";
import type { ActionItem, CommandCentreSection } from "../types.js";

/** Minimal valid ActionItem fixture -- callers override only what a test cares about. */
function item(overrides: Partial<ActionItem> & { id: string }): ActionItem {
  return {
    sourceType: "OFFER",
    sourceRecordId: "1",
    propertyId: 1,
    propertyAddress: "1 Test St",
    brokerageId: 1,
    agentId: null,
    title: "Test item",
    description: "Test description",
    category: "OFFERS",
    severity: null,
    status: "OPEN",
    accountableOwnerType: "LISTING_AGENT",
    accountableOwnerUserId: null,
    performingParty: "Agent",
    waitingOnParty: null,
    dueAt: null,
    timeZone: "Australia/Brisbane",
    overdue: false,
    recommendedAction: "Review.",
    deepLink: "/properties/1",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    completedAt: null,
    priority: "P4",
    sections: [],
    ...overrides,
  };
}

describe("priorityFor -- deterministic P0-P4 tiering, explicit factors only (no AI/productivity score)", () => {
  test("an item whose only section is completedToday is always P4, regardless of severity", () => {
    assert.equal(priorityFor(item({ id: "a", sections: ["completedToday"], severity: "CRITICAL" })), "P4");
    assert.equal(priorityFor(item({ id: "a", sections: ["completedToday"], severity: null })), "P4");
  });

  test("CRITICAL severity is always P0, even outside the overdue section", () => {
    assert.equal(priorityFor(item({ id: "a", sections: ["today"], severity: "CRITICAL" })), "P0");
  });

  test("overdue with any non-null severity is P0", () => {
    assert.equal(priorityFor(item({ id: "a", sections: ["overdue"], severity: "ATTENTION" })), "P0");
    assert.equal(priorityFor(item({ id: "a", sections: ["overdue"], severity: "INFORMATION" })), "P0");
  });

  test("AT_RISK severity is P1", () => {
    assert.equal(priorityFor(item({ id: "a", sections: ["today"], severity: "AT_RISK" })), "P1");
  });

  test("overdue with no severity (e.g. a plain operational milestone, not an exception) is P1", () => {
    assert.equal(priorityFor(item({ id: "a", sections: ["overdue"], severity: null })), "P1");
  });

  test("waitingOn with no severity is P1", () => {
    assert.equal(priorityFor(item({ id: "a", sections: ["waitingOn"], severity: null })), "P1");
  });

  test("today with no severity is P2", () => {
    assert.equal(priorityFor(item({ id: "a", sections: ["today"], severity: null })), "P2");
  });

  test("comingUp with no severity is P3", () => {
    assert.equal(priorityFor(item({ id: "a", sections: ["comingUp"], severity: null })), "P3");
  });

  test("no matching sections falls through to P4", () => {
    assert.equal(priorityFor(item({ id: "a", sections: [], severity: null })), "P4");
  });

  test("completedToday combined with another section is not the terminal-P4 case -- it falls through to the section's own tier", () => {
    assert.equal(priorityFor(item({ id: "a", sections: ["completedToday", "overdue"], severity: null })), "P1");
  });
});

describe("compareItems -- deterministic ordering: priority, then severity, then due date, then id", () => {
  test("lower priority tier (P0) always sorts before a higher one (P1), regardless of other fields", () => {
    const p0 = item({ id: "z", sections: ["overdue"], severity: "CRITICAL" });
    const p1 = item({ id: "a", sections: ["today"], severity: "AT_RISK" });
    assert.ok(compareItems(p0, p1) < 0);
    assert.ok(compareItems(p1, p0) > 0);
  });

  test("within the same priority, severity breaks the tie: CRITICAL < AT_RISK < ATTENTION < INFORMATION < none", () => {
    const critical = item({ id: "c", sections: ["today"], severity: "CRITICAL", priority: "P2" });
    const atRisk = item({ id: "c", sections: ["today"], severity: "AT_RISK", priority: "P2" });
    const attention = item({ id: "c", sections: ["today"], severity: "ATTENTION", priority: "P2" });
    const information = item({ id: "c", sections: ["today"], severity: "INFORMATION", priority: "P2" });
    const none = item({ id: "c", sections: ["today"], severity: null, priority: "P2" });
    const ordered = [none, information, atRisk, critical, attention];
    ordered.sort(compareItems);
    assert.deepEqual(
      ordered.map((i) => i.severity),
      ["CRITICAL", "AT_RISK", "ATTENTION", "INFORMATION", null],
    );
  });

  test("within the same priority and severity, the earlier due date sorts first and a null due date sorts last", () => {
    const later = item({ id: "x", priority: "P2", severity: null, dueAt: "2026-09-05T00:00:00.000Z" });
    const earlier = item({ id: "y", priority: "P2", severity: null, dueAt: "2026-09-01T00:00:00.000Z" });
    const noDueDate = item({ id: "z", priority: "P2", severity: null, dueAt: null });
    const ordered = [noDueDate, later, earlier];
    ordered.sort(compareItems);
    assert.deepEqual(
      ordered.map((i) => i.id),
      ["y", "x", "z"],
    );
  });

  test("when priority, severity and due date all tie, ordering falls back to a stable lexicographic id compare", () => {
    const b = item({ id: "b", priority: "P3", severity: null, dueAt: null });
    const a = item({ id: "a", priority: "P3", severity: null, dueAt: null });
    assert.ok(compareItems(a, b) < 0);
    assert.ok(compareItems(b, a) > 0);
    assert.equal(compareItems(a, a), 0);
  });
});

describe("sectionsFor / ownerLabel", () => {
  test("sectionsFor wraps a single section kind in its own array", () => {
    const result: CommandCentreSection[] = sectionsFor("overdue");
    assert.deepEqual(result, ["overdue"]);
  });

  test("ownerLabel translates known owner types to their display label and passes unknown ones through", () => {
    assert.equal(ownerLabel("LISTING_AGENT"), "Agent");
    assert.equal(ownerLabel("TRANSACTION_OWNER"), "Agent");
    assert.equal(ownerLabel("BROKERAGE_ADMINISTRATOR"), "Brokerage Administrator");
    assert.equal(ownerLabel("PIT_CREW"), "Pit Crew");
    assert.equal(ownerLabel("UNASSIGNED_QUEUE"), "Unassigned");
    assert.equal(ownerLabel("SOMETHING_UNKNOWN"), "SOMETHING_UNKNOWN");
  });
});
