import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CALL_LOG_NOTE,
  buildFormRequest,
  callLogRequest,
  commitmentRequest,
  completeRequest,
  formDefinition,
  initialForm,
  localToIso,
  noteRequest,
  rescheduleRequest,
  toLocalInputValue,
} from "../../minimal/mobile/mobileContactForms";
import { CONTACT_TEXT_MAX } from "../../minimal/mobile/mobilePeopleConfig";

// AE Mobile (CC Task #64, M4): the only requests the phone Contact 360 may send, each a route that exists.

const NOW = new Date("2026-11-02T09:00:00Z");
const ok = (r: ReturnType<typeof noteRequest>) => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; request: { path: string; method: string; body: Record<string, unknown> } }).request;
};
const bad = (r: ReturnType<typeof noteRequest>) => {
  assert.equal(r.ok, false);
  return (r as { ok: false; error: string }).error;
};

test("a note posts to /grow/activities with exactly the classic body", () => {
  const req = ok(noteRequest(12, "  Called back, wants to wait until March.  ", NOW));
  assert.equal(req.path, "/grow/activities");
  assert.equal(req.method, "POST");
  assert.deepEqual(req.body, { activityType: "note", summary: "Called back, wants to wait until March.", partyId: 12 }, "no occurredAt: the server stamps it, so a fast phone clock cannot get a note refused");
});

test("a call or meeting log carries its time, and is never in the future", () => {
  const req = ok(callLogRequest(12, "meeting", "2026-11-02T08:30", "Met at the property", NOW));
  assert.deepEqual(Object.keys(req.body).sort(), ["activityType", "occurredAt", "partyId", "summary"]);
  assert.equal(req.body.activityType, "meeting");
  assert.equal(req.body.occurredAt, new Date("2026-11-02T08:30").toISOString());
  assert.match(bad(callLogRequest(12, "call", "2026-11-09T08:30", "x", NOW)), /already passed.*commitment/);
  assert.equal(ok(callLogRequest(12, "call", "2026-11-02T09:00", "just now", NOW)).body.activityType, "call");
});

test("only a call, a meeting or a note can be logged by hand", () => {
  for (const type of ["email", "sms", "call_summary", "appraisal", "system_event", "task_completion", ""]) {
    assert.match(bad(callLogRequest(12, type, "2026-11-02T08:30", "x", NOW)), /call or a meeting/, type);
  }
});

test("a commitment posts to the contact's commitments route, with an ISO due time", () => {
  const req = ok(commitmentRequest(12, "Send comparable sales", "2026-11-03T14:00"));
  assert.equal(req.path, "/grow/contacts/12/commitments");
  assert.equal(req.method, "POST");
  assert.deepEqual(req.body, { description: "Send comparable sales", dueAt: new Date("2026-11-03T14:00").toISOString() });
  assert.equal(ok(commitmentRequest(12, "Overdue is a normal state", "2020-01-01T09:00")).body.dueAt, new Date("2020-01-01T09:00").toISOString(), "a past due time is allowed");
});

test("a reschedule is its own body, and completing is its own body: never combined", () => {
  const reschedule = ok(rescheduleRequest(9, "2026-11-05T10:15"));
  assert.equal(reschedule.path, "/grow/contacts/commitments/9");
  assert.equal(reschedule.method, "PATCH");
  assert.deepEqual(Object.keys(reschedule.body), ["dueAt"]);
  const done = completeRequest(9);
  assert.equal(done.path, "/grow/contacts/commitments/9");
  assert.equal(done.method, "PATCH");
  assert.deepEqual(done.body, { status: "Completed" });
  assert.equal("dueAt" in done.body, false);
});

test("no request ever names a brokerage, a user or a role", () => {
  const all = [
    ok(noteRequest(12, "x", NOW)), ok(callLogRequest(12, "call", "2026-11-02T08:30", "x", NOW)),
    ok(commitmentRequest(12, "x", "2026-11-03T14:00")), ok(rescheduleRequest(9, "2026-11-05T10:15")), completeRequest(9),
  ];
  for (const r of all) assert.doesNotMatch(JSON.stringify(r), /brokerage|userId|role|responsibleUser/i);
});

test("blank and over-long text is refused with a plain sentence", () => {
  assert.match(bad(noteRequest(12, "   ", NOW)), /can't be blank/);
  assert.match(bad(commitmentRequest(12, "", "2026-11-03T14:00")), /can't be blank/);
  assert.match(bad(callLogRequest(12, "call", "2026-11-02T08:30", "  ", NOW)), /can't be blank/);
  assert.match(bad(noteRequest(12, "x".repeat(CONTACT_TEXT_MAX + 1), NOW)), /2000 characters or fewer/);
  assert.equal(CONTACT_TEXT_MAX, 2000);
  assert.equal(ok(noteRequest(12, "x".repeat(CONTACT_TEXT_MAX), NOW)).body.summary, "x".repeat(CONTACT_TEXT_MAX));
});

test("a bad time is refused, and a datetime-local value becomes one ISO instant", () => {
  for (const value of ["", "tomorrow", "2026-13-40T99:99", "2026-11-03", "2026-11-03 14:00"]) {
    assert.equal(localToIso(value), null, value);
  }
  assert.equal(localToIso("2026-11-03T14:00"), new Date("2026-11-03T14:00").toISOString());
  assert.equal(localToIso("2026-11-03T14:00:30"), new Date("2026-11-03T14:00:30").toISOString());
  assert.match(bad(commitmentRequest(12, "x", "soon")), /when it is due/);
  assert.match(bad(rescheduleRequest(9, "")), /new due time/);
  assert.equal(toLocalInputValue(new Date("2026-03-05T07:08")), "2026-03-05T07:08");
});

test("the forms say what they do, and the call log never claims a call is placed or recorded", () => {
  assert.match(CALL_LOG_NOTE, /already had/);
  assert.match(CALL_LOG_NOTE, /does not place or record the call/);
  const call = formDefinition("call");
  assert.equal(call.note, CALL_LOG_NOTE);
  assert.deepEqual(call.fields.map((f) => f.name), ["type", "occurredAt", "summary"]);
  assert.deepEqual(call.fields[0].options?.map((o) => o.value), ["call", "meeting"]);
  assert.deepEqual(formDefinition("note").fields.map((f) => f.name), ["summary"]);
  assert.deepEqual(formDefinition("commitment").fields.map((f) => f.name), ["description", "dueAt"]);
  assert.deepEqual(formDefinition("reschedule").fields.map((f) => f.name), ["dueAt"]);
  for (const kind of ["note", "call", "commitment", "reschedule"] as const) {
    const text = JSON.stringify(formDefinition(kind));
    assert.doesNotMatch(text, /is recorded|will be recorded|we record|recording/i, kind);
  }
});

test("initialForm starts sensibly, and buildFormRequest follows whichever form is open", () => {
  const call = initialForm("call", NOW);
  assert.equal(call.values.type, "call");
  assert.equal(call.values.occurredAt, toLocalInputValue(NOW));
  const commitment = initialForm("commitment", NOW);
  assert.equal(commitment.values.dueAt, toLocalInputValue(new Date(NOW.getTime() + 24 * 60 * 60 * 1000)));
  const resched = initialForm("reschedule", NOW, 9);
  assert.equal(resched.commitmentId, 9);

  const note = { ...initialForm("note", NOW), values: { summary: "Hello" } };
  assert.equal(ok(buildFormRequest(note, 12, NOW)).body.activityType, "note");
  assert.equal(ok(buildFormRequest({ ...call, values: { ...call.values, summary: "Spoke" } }, 12, NOW)).path, "/grow/activities");
  assert.equal(ok(buildFormRequest({ ...commitment, values: { ...commitment.values, description: "Send it" } }, 12, NOW)).path, "/grow/contacts/12/commitments");
  assert.equal(ok(buildFormRequest(resched, 12, NOW)).path, "/grow/contacts/commitments/9");
  assert.match(bad(buildFormRequest({ ...resched, commitmentId: null }, 12, NOW)), /Choose a commitment/);
  assert.match(bad(buildFormRequest(initialForm("note", NOW), 12, NOW)), /can't be blank/);
});
