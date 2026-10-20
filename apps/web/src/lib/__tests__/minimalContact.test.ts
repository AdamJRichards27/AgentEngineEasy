import assert from "node:assert/strict";
import test from "node:test";
import { buildMinimalContactModel, type Contact360Input } from "../../minimal/minimalContactModel";

const base: Contact360Input = {
  contact: { id: 9, displayName: "Ada Allow", email: "ada@example.com", mobile: null },
  roles: ["Buyer", "PastClient"],
  properties: [
    { relationshipId: 1, propertyId: 3, propertyAddress: "18 Campbell St", relationshipType: "Owner", status: "Active", isPrimary: true },
    { relationshipId: 2, propertyId: 4, propertyAddress: "2 Old Rd", relationshipType: "Owner", status: "Historical", isPrimary: false },
    { relationshipId: 3, propertyId: null, propertyAddress: null, relationshipType: "Prospect", status: "Active", isPrimary: false },
  ],
  opportunities: [
    { id: 1, status: "Open", stage: "New", opportunityType: "Listing" },
    { id: 2, status: "Lost", stage: "New", opportunityType: "Listing" },
  ],
  activities: [
    { id: 1, activityType: "call", occurredAt: "2026-10-01T00:00:00Z", summary: "Called" },
    { id: 2, activityType: "note", occurredAt: "2026-10-02T00:00:00Z", summary: "older note" },
    { id: 3, activityType: "note", occurredAt: "2026-10-03T00:00:00Z", summary: "newer note" },
  ],
  intelligence: { nextFollowUpAt: null, nextFollowUpDescription: null, daysSinceLastInteraction: null },
};

test("model only rearranges the Contact 360 payload", () => {
  const m = buildMinimalContactModel(base);
  assert.equal(m.title, "Ada Allow");
  assert.equal(m.initials, "AA");
  assert.deepEqual(m.roleChips, ["Buyer", "PastClient"]);
  assert.equal(m.openOpportunityCount, 1);
  assert.equal(m.lastTouchLabel, "No interaction recorded");
  assert.equal(m.followUp, null);
});

test("only Active property links; unlinked row has no href", () => {
  const m = buildMinimalContactModel(base);
  assert.equal(m.properties.length, 2);
  assert.equal(m.properties[0].href, "/properties/3");
  assert.equal(m.properties[1].href, null);
  assert.equal(m.properties[1].label, "Not linked to a property");
});

test("notes are note-type activities, newest first, capped at 5", () => {
  const m = buildMinimalContactModel(base);
  assert.deepEqual(m.notes.map((n) => n.text), ["newer note", "older note"]);
  const many = { ...base, activities: Array.from({ length: 9 }, (_, i) => ({ id: i, activityType: "note", occurredAt: `2026-10-0${i + 1}T00:00:00Z`, summary: `n${i}` })) };
  assert.equal(buildMinimalContactModel(many).notes.length, 5);
});

test("follow-up and last touch labels", () => {
  const m = buildMinimalContactModel({ ...base, intelligence: { nextFollowUpAt: "2026-10-20T00:00:00Z", nextFollowUpDescription: null, daysSinceLastInteraction: 1 } });
  assert.deepEqual(m.followUp, { label: "Follow up", dueAt: "2026-10-20T00:00:00Z" });
  assert.equal(m.lastTouchLabel, "1 day ago");
});

test("open opportunity count uses the classic Contact 360 lifecycle rule (Open at a Lost or Converted stage is not open)", () => {
  const m = buildMinimalContactModel({
    ...base,
    opportunities: [
      { id: 1, status: "Open", stage: "New", opportunityType: "Listing" },
      { id: 2, status: "Open", stage: "Lost", opportunityType: "Listing" },
      { id: 3, status: "Open", stage: "Converted", opportunityType: "Listing" },
    ],
  });
  assert.equal(m.openOpportunityCount, 1);
});
