// D3 — include, exclude, and dedupe. One function, isMeaningfulActivity,
// plus lastMeaningfulContactAt for the recency timestamp those rows produce.
import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_DURATION_INVALID,
  ACTIVITY_FIELDS_REQUIRED,
  ACTIVITY_OUTCOME_INVALID,
  ACTIVITY_SUMMARY_INVALID,
  ACTIVITY_TYPE_NOT_ALLOWED,
  ACTIVITY_TYPE_NOT_MANUAL,
  GROW_ACTIVITY_TYPES,
  MANUAL_LOG_ACTIVITY_TYPES,
  OCCURRED_AT_INVALID,
  OCCURRED_AT_OUT_OF_RANGE,
  POSTABLE_MANUAL_ACTIVITY_TYPES,
  isMeaningfulActivity,
  lastMeaningfulContactAt,
  parseActivityOccurredAt,
  parseActivitySummary,
  parseOptionalDurationMinutes,
  parseOptionalOutcome,
  parsePostedActivityType,
  selectMeaningfulActivities,
  type MeaningfulActivityInput,
} from "../meaningfulActivity.js";

const at = (iso: string) => new Date(iso);

function activity(overrides: MeaningfulActivityInput): MeaningfulActivityInput {
  return { kind: "grow_activity", occurredAt: at("2026-03-01T00:00:00.000Z"), ...overrides };
}

test("posted activity types are the existing domain allow-list, case-insensitive", () => {
  for (const activityType of GROW_ACTIVITY_TYPES) {
    const parsed = parsePostedActivityType(activityType.toUpperCase());
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.activityType, activityType);
  }
  const rejected = parsePostedActivityType("phone");
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, ACTIVITY_TYPE_NOT_ALLOWED);
});

test("hand-logged posts are calls, meetings, and the existing note write", () => {
  assert.deepEqual(POSTABLE_MANUAL_ACTIVITY_TYPES, ["call", "meeting", "note"]);
  assert.deepEqual(POSTABLE_MANUAL_ACTIVITY_TYPES, [...MANUAL_LOG_ACTIVITY_TYPES, "note"]);
  assert.equal(ACTIVITY_TYPE_NOT_MANUAL, "ACTIVITY_TYPE_NOT_MANUAL");
  assert.notEqual(ACTIVITY_TYPE_NOT_MANUAL, ACTIVITY_TYPE_NOT_ALLOWED);
  for (const activityType of POSTABLE_MANUAL_ACTIVITY_TYPES) {
    const parsed = parsePostedActivityType(activityType.toUpperCase());
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.activityType, activityType);
  }
  const unknown = parsePostedActivityType("phone");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, ACTIVITY_TYPE_NOT_ALLOWED);
  const known = parsePostedActivityType("SYSTEM_EVENT");
  assert.equal(known.ok, true);
  if (known.ok) assert.equal(known.activityType, "system_event");
});

test("summary, duration, outcome, and occurred-at reject the cases the route must 400", () => {
  assert.equal(parseActivitySummary("  ").ok, false);
  const empty = parseActivitySummary("");
  if (!empty.ok) assert.equal(empty.code, ACTIVITY_FIELDS_REQUIRED);
  const long = parseActivitySummary("x".repeat(2001));
  if (!long.ok) assert.equal(long.code, ACTIVITY_SUMMARY_INVALID);
  const kept = parseActivitySummary("  Called Pat  ");
  if (kept.ok) assert.equal(kept.summary, "Called Pat");

  const duration = parseOptionalDurationMinutes(1.5);
  if (!duration.ok) assert.equal(duration.code, ACTIVITY_DURATION_INVALID);
  assert.deepEqual(parseOptionalDurationMinutes(undefined), { ok: true, durationMinutes: null });
  assert.deepEqual(parseOptionalDurationMinutes(15), { ok: true, durationMinutes: 15 });

  const outcome = parseOptionalOutcome("y".repeat(201));
  if (!outcome.ok) assert.equal(outcome.code, ACTIVITY_OUTCOME_INVALID);

  const now = at("2026-06-01T00:00:00.000Z");
  const bad = parseActivityOccurredAt("yesterday", now);
  if (!bad.ok) assert.equal(bad.code, OCCURRED_AT_INVALID);
  const future = parseActivityOccurredAt("2026-06-01T00:06:00.000Z", now);
  if (!future.ok) assert.equal(future.code, OCCURRED_AT_OUT_OF_RANGE);
  const skew = parseActivityOccurredAt("2026-06-01T00:04:00.000Z", now);
  assert.equal(skew.ok, true);
  const ancient = parseActivityOccurredAt("1800-01-01T00:00:00.000Z", now);
  if (!ancient.ok) assert.equal(ancient.code, OCCURRED_AT_OUT_OF_RANGE);
});

test("D3 includes a logged or completed call, a meeting, a sent or received email or SMS, an appraisal, and a call summary", () => {
  const included: MeaningfulActivityInput[] = [
    activity({ id: 1, activityType: "call", source: "manual" }),
    activity({ id: 2, activityType: "call", source: "grow_calls", details: { status: "COMPLETED" } }),
    activity({ id: 3, activityType: "call", source: "grow_calls" }),
    activity({ id: 4, activityType: "meeting" }),
    activity({ id: 5, activityType: "email", details: { status: "SENT" } }),
    activity({ id: 6, activityType: "email", details: { status: "DELIVERED" } }),
    activity({ id: 7, activityType: "email" }),
    activity({ id: 8, activityType: "sms", details: { status: "RECEIVED" } }),
    activity({ id: 9, activityType: "appraisal" }),
    activity({ id: 10, activityType: "call_summary" }),
  ];
  for (const row of included) {
    assert.equal(isMeaningfulActivity(row), true, JSON.stringify(row));
  }
});

test("D3 excludes notes, system events, reschedules, task edits, failed sends, and calls that never connected", () => {
  const excluded: MeaningfulActivityInput[] = [
    activity({ id: 1, activityType: "note" }),
    activity({ id: 2, activityType: "system_event" }),
    activity({ id: 3, activityType: "system_event", details: { kind: "commitment_rescheduled" } }),
    activity({ id: 4, activityType: "meeting", details: { kind: "reschedule" } }),
    activity({ id: 5, activityType: "task_completion" }),
    activity({ id: 6, activityType: "call", details: { kind: "task_edit" } }),
    activity({ id: 7, activityType: "campaign_response" }),
    activity({ id: 8, activityType: "property_enquiry" }),
    activity({ id: 9, activityType: "offer_related" }),
    activity({ id: 10, activityType: "email", details: { status: "FAILED" } }),
    activity({ id: 11, activityType: "email", details: { status: "DRAFT" } }),
    activity({ id: 12, activityType: "sms", details: { status: "BLOCKED_BY_CONSENT" } }),
    activity({ id: 13, activityType: "call", source: "grow_calls", details: { status: "NO_ANSWER" } }),
    activity({ id: 14, activityType: "call", source: "grow_calls", details: { status: "ATTEMPTED" } }),
    activity({ id: 15, activityType: "call", source: "grow_calls", details: { status: "MISSED" } }),
  ];
  for (const row of excluded) {
    assert.equal(isMeaningfulActivity(row), false, JSON.stringify(row));
  }
});

test("a qualifying Hub message counts, and a draft or internal note does not", () => {
  const sent = activity({
    id: 9,
    kind: "hub_message",
    channel: "EMAIL",
    direction: "OUTBOUND",
    status: "SENT",
    occurredAt: at("2026-04-02T00:00:00.000Z"),
  });
  const delivered = activity({
    id: 10,
    kind: "hub_message",
    channel: "SMS",
    direction: "OUTBOUND",
    status: "DELIVERED",
  });
  const received = activity({
    id: 11,
    kind: "hub_message",
    channel: "PHONE_CALL",
    direction: "INBOUND",
    status: "RECEIVED",
  });
  const draft = activity({
    id: 12,
    kind: "hub_message",
    channel: "EMAIL",
    direction: "OUTBOUND",
    status: "DRAFT",
  });
  const internal = activity({
    id: 13,
    kind: "hub_message",
    channel: "INTERNAL_NOTE",
    direction: "OUTBOUND",
    status: "SENT",
  });
  assert.equal(isMeaningfulActivity(sent), true);
  assert.equal(isMeaningfulActivity(delivered), true);
  assert.equal(isMeaningfulActivity(received), true);
  assert.equal(isMeaningfulActivity(draft), false);
  assert.equal(isMeaningfulActivity(internal), false);
});

test("a call and its call_summary are one interaction, and the call is the one that counts", () => {
  const call = activity({
    id: 1,
    activityType: "call",
    source: "grow_calls",
    sourceId: "session-7",
    occurredAt: at("2026-04-01T10:00:00.000Z"),
    details: { callSessionId: "session-7", status: "COMPLETED" },
  });
  const summary = activity({
    id: 2,
    activityType: "call_summary",
    occurredAt: at("2026-04-01T11:00:00.000Z"),
    details: { callSessionId: "session-7" },
  });
  assert.equal(isMeaningfulActivity(summary, [call]), false);
  assert.equal(isMeaningfulActivity(call, [summary]), true);
  assert.equal(selectMeaningfulActivities([call, summary]).length, 1);
  const latest = lastMeaningfulContactAt([summary, call, activity({ id: 3, activityType: "note", occurredAt: at("2026-05-01T00:00:00.000Z") })]);
  assert.equal(latest?.toISOString(), "2026-04-01T10:00:00.000Z");
});

test("a call logged with source grow_calls dedupes against a summary that names that session", () => {
  const call = activity({
    id: 4,
    activityType: "call",
    source: "grow_calls",
    sourceId: "session-9",
    occurredAt: at("2026-04-03T10:00:00.000Z"),
  });
  const summary = activity({
    id: 5,
    activityType: "call_summary",
    occurredAt: at("2026-04-03T12:00:00.000Z"),
    details: { callSessionId: "session-9" },
  });
  assert.deepEqual(
    selectMeaningfulActivities([summary, call]).map((row) => row.id),
    [4],
  );
});

test("a Hub message and the grow activity that mirrors it count once", () => {
  const hub = activity({
    id: 20,
    kind: "hub_message",
    channel: "EMAIL",
    direction: "OUTBOUND",
    status: "DELIVERED",
    providerMessageId: "prov-1",
    occurredAt: at("2026-04-04T09:00:00.000Z"),
  });
  const mirror = activity({
    id: 21,
    activityType: "email",
    occurredAt: at("2026-04-04T09:05:00.000Z"),
    details: { communicationMessageId: 20, providerMessageId: "prov-1", status: "DELIVERED" },
  });
  const byMessageId = activity({
    id: 22,
    activityType: "sms",
    occurredAt: at("2026-04-04T09:06:00.000Z"),
    details: { messageId: "20", status: "SENT" },
  });
  const kept = selectMeaningfulActivities([mirror, byMessageId, hub]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.kind, "hub_message");
  assert.equal(lastMeaningfulContactAt([mirror, hub])?.toISOString(), "2026-04-04T09:00:00.000Z");
});

test("a reschedule does not move recency, and a later logged call does", () => {
  const call = activity({
    id: 1,
    activityType: "call",
    source: "manual",
    occurredAt: at("2026-01-01T00:00:00.000Z"),
  });
  const note = activity({ id: 2, activityType: "note", occurredAt: at("2026-03-01T00:00:00.000Z") });
  const reschedule = activity({
    id: 3,
    activityType: "system_event",
    occurredAt: at("2026-03-02T00:00:00.000Z"),
    details: { kind: "commitment_rescheduled" },
  });
  assert.equal(lastMeaningfulContactAt([call, note, reschedule])?.toISOString(), "2026-01-01T00:00:00.000Z");
  const logged = activity({
    id: 4,
    activityType: "call",
    source: "manual",
    occurredAt: at("2026-03-20T00:00:00.000Z"),
  });
  assert.equal(lastMeaningfulContactAt([call, note, reschedule, logged])?.toISOString(), "2026-03-20T00:00:00.000Z");
});
