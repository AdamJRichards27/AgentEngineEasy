import { CONTACT_TEXT_MAX } from "./mobilePeopleConfig";

// AE Mobile (CC Task #64, M4): the requests the phone Contact 360 may send, as pure builders. No React,
// no network, no storage. Each one is a route that already exists, with the body the existing classic
// Contact 360 already sends:
//
//   POST  /grow/activities                       note, call or meeting     (grow.activities.manage)
//   POST  /grow/contacts/:partyId/commitments    add a commitment          (grow.activities.manage)
//   PATCH /grow/contacts/commitments/:id         { status: "Completed" }   (grow.activities.manage)
//   PATCH /grow/contacts/commitments/:id         { dueAt }  to reschedule  (grow.activities.manage)
//
// Nothing else is built here on purpose. Email and SMS, consent, editing a contact, setting a due
// follow-up on an opportunity, and cancelling a commitment have no phone form: the screen links to the
// full record for them instead of offering a button that does not work. No call is placed or recorded.

export type ContactWriteRequest = {
  path: string;
  method: "POST" | "PATCH";
  body: Record<string, unknown>;
};

export type ContactFormKind = "note" | "call" | "commitment" | "reschedule";

export interface ContactFormState {
  kind: ContactFormKind;
  /** Set for "reschedule". */
  commitmentId: number | null;
  /** Everything the person has typed or chosen, by field name. */
  values: Record<string, string>;
}

export type BuildResult = { ok: true; request: ContactWriteRequest } | { ok: false; error: string };

export interface ContactFormField {
  name: string;
  label: string;
  type: "textarea" | "datetime" | "select";
  options?: Array<{ value: string; label: string }>;
  hint?: string;
}

export interface ContactFormDefinition {
  title: string;
  /** A plain-language line shown above the fields, or null. */
  note: string | null;
  submitLabel: string;
  fields: ContactFormField[];
}

/** "2026-11-02T09:30" as a datetime-local field holds it, for the given instant, in local time. */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A datetime-local value is local wall time. The server wants one instant, so it is sent as ISO with its zone. */
export function localToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value.trim())) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const CALL_LOG_NOTE =
  "This records a call or meeting you already had. AE does not place or record the call itself.";

export function formDefinition(kind: ContactFormKind): ContactFormDefinition {
  switch (kind) {
    case "note":
      return {
        title: "Add a note",
        note: null,
        submitLabel: "Save note",
        fields: [{ name: "summary", label: "Note", type: "textarea", hint: "What would you want to remember?" }],
      };
    case "call":
      return {
        title: "Log a call or meeting",
        note: CALL_LOG_NOTE,
        submitLabel: "Save",
        fields: [
          { name: "type", label: "What happened", type: "select", options: [{ value: "call", label: "A call" }, { value: "meeting", label: "A meeting" }] },
          { name: "occurredAt", label: "When", type: "datetime" },
          { name: "summary", label: "What was said", type: "textarea", hint: "A short summary" },
        ],
      };
    case "commitment":
      return {
        title: "Add a commitment",
        note: "A commitment is a promise you have made to this person.",
        submitLabel: "Save commitment",
        fields: [
          { name: "description", label: "What you promised", type: "textarea", hint: "For example: send comparable sales" },
          { name: "dueAt", label: "Due", type: "datetime" },
        ],
      };
    default:
      return {
        title: "Reschedule",
        note: null,
        submitLabel: "Save new time",
        fields: [{ name: "dueAt", label: "New due time", type: "datetime" }],
      };
  }
}

export function initialForm(kind: ContactFormKind, now: Date, commitmentId: number | null = null): ContactFormState {
  const values: Record<string, string> = {};
  for (const field of formDefinition(kind).fields) {
    if (field.type === "select") values[field.name] = field.options?.[0]?.value ?? "";
    else if (field.name === "occurredAt") values[field.name] = toLocalInputValue(now);
    else if (field.name === "dueAt") values[field.name] = toLocalInputValue(new Date(now.getTime() + 24 * 60 * 60 * 1000));
    else values[field.name] = "";
  }
  return { kind, commitmentId, values };
}

function readText(value: string | undefined, what: string): { ok: true; text: string } | { ok: false; error: string } {
  const text = (value ?? "").trim();
  if (text.length === 0) return { ok: false, error: `${what} can't be blank.` };
  if (text.length > CONTACT_TEXT_MAX) return { ok: false, error: `${what} must be ${CONTACT_TEXT_MAX} characters or fewer.` };
  return { ok: true, text };
}

// A note carries no time of its own: the server stamps it. POST /grow/activities refuses an occurredAt more than
// five minutes in the future, so a phone whose clock runs fast would have its notes rejected if it sent one.
export function noteRequest(partyId: number, summary: string, _now: Date): BuildResult {
  const text = readText(summary, "A note");
  if (!text.ok) return text;
  return {
    ok: true,
    request: { path: "/grow/activities", method: "POST", body: { activityType: "note", summary: text.text, partyId } },
  };
}

export function callLogRequest(partyId: number, type: string, occurredAtLocal: string, summary: string, now: Date): BuildResult {
  if (type !== "call" && type !== "meeting") return { ok: false, error: "Choose a call or a meeting." };
  const text = readText(summary, "A summary");
  if (!text.ok) return text;
  const at = localToIso(occurredAtLocal);
  if (at === null) return { ok: false, error: "Choose when it happened." };
  // The server allows five minutes of clock skew; one minute here keeps a phone that is slightly fast inside it.
  if (new Date(at).getTime() > now.getTime() + 60_000) {
    return { ok: false, error: "Choose a time that has already passed. To plan something for later, add a commitment." };
  }
  return { ok: true, request: { path: "/grow/activities", method: "POST", body: { activityType: type, summary: text.text, occurredAt: at, partyId } } };
}

export function commitmentRequest(partyId: number, description: string, dueAtLocal: string): BuildResult {
  const text = readText(description, "A commitment");
  if (!text.ok) return text;
  const due = localToIso(dueAtLocal);
  if (due === null) return { ok: false, error: "Choose when it is due." };
  return { ok: true, request: { path: `/grow/contacts/${partyId}/commitments`, method: "POST", body: { description: text.text, dueAt: due } } };
}

export function rescheduleRequest(commitmentId: number, dueAtLocal: string): BuildResult {
  const due = localToIso(dueAtLocal);
  if (due === null) return { ok: false, error: "Choose the new due time." };
  // A reschedule is a body of its own: the server rejects dueAt and status together.
  return { ok: true, request: { path: `/grow/contacts/commitments/${commitmentId}`, method: "PATCH", body: { dueAt: due } } };
}

export function completeRequest(commitmentId: number): ContactWriteRequest {
  return { path: `/grow/contacts/commitments/${commitmentId}`, method: "PATCH", body: { status: "Completed" } };
}

/** Builds the request for whichever form is open, or says what is wrong with it. */
export function buildFormRequest(form: ContactFormState, partyId: number, now: Date): BuildResult {
  const v = form.values;
  switch (form.kind) {
    case "note":
      return noteRequest(partyId, v.summary ?? "", now);
    case "call":
      return callLogRequest(partyId, v.type ?? "", v.occurredAt ?? "", v.summary ?? "", now);
    case "commitment":
      return commitmentRequest(partyId, v.description ?? "", v.dueAt ?? "");
    default:
      if (form.commitmentId === null) return { ok: false, error: "Choose a commitment to reschedule." };
      return rescheduleRequest(form.commitmentId, v.dueAt ?? "");
  }
}
