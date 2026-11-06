import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// #29 web follow-up — the Pit Crew card's overdue label uses the API's
// item.overdue (source dueAt past, or WAITING_ON past waitingOnExpectedAt),
// not a client-side dueAt-only check. The client clock only chooses wording.

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

type LabelInput = { dueAt: string | null; overdue: boolean; pcStatus: string; waitingOnExpectedAt: string | null };

async function label(input: LabelInput): Promise<string | null> {
  const mod = (await import("../pitCrew")) as Record<string, unknown>;
  assert.equal(typeof mod.pcItemDueLabel, "function", "pcItemDueLabel must be exported from lib/pitCrew");
  return (mod.pcItemDueLabel as (i: LabelInput) => string | null)(input);
}

test("WAITING_ON overdue by expected-at with no dueAt shows an overdue label", async () => {
  const text = await label({ dueAt: null, overdue: true, pcStatus: "WAITING_ON", waitingOnExpectedAt: PAST });
  assert.ok(text && /overdue/i.test(text), `expected an overdue label, got ${String(text)}`);
});

test("WAITING_ON overdue by expected-at with a future dueAt says response overdue and keeps the due date", async () => {
  const text = await label({ dueAt: FUTURE, overdue: true, pcStatus: "WAITING_ON", waitingOnExpectedAt: PAST });
  assert.ok(text && text.startsWith("response overdue"), String(text));
  assert.match(text!, /due /);
});

test("source dueAt overdue keeps the existing 'overdue <date>' wording", async () => {
  const text = await label({ dueAt: PAST, overdue: true, pcStatus: "CLAIMED", waitingOnExpectedAt: null });
  assert.ok(text && text.startsWith("overdue "), String(text));
});

test("not overdue with a dueAt keeps 'due <date>'; no dueAt and not overdue shows nothing", async () => {
  const due = await label({ dueAt: FUTURE, overdue: false, pcStatus: "WAITING_ON", waitingOnExpectedAt: FUTURE });
  assert.ok(due && due.startsWith("due "), String(due));
  assert.equal(await label({ dueAt: null, overdue: false, pcStatus: "WAITING_ON", waitingOnExpectedAt: null }), null);
});

test("the API flag is authoritative: overdue=false never renders overdue, even with a past dueAt", async () => {
  const text = await label({ dueAt: PAST, overdue: false, pcStatus: "IN_PROGRESS", waitingOnExpectedAt: null });
  assert.ok(text && text.startsWith("due "), String(text));
});

test("PitCrewCommandCentre card uses pcItemDueLabel, not isOverdue(item.dueAt)", () => {
  const src = readFileSync(new URL("../../pages/PitCrewCommandCentre.tsx", import.meta.url), "utf8");
  assert.equal(src.includes("isOverdue(item.dueAt)"), false, "card must not use the dueAt-only check");
  assert.ok(src.includes("pcItemDueLabel(item)"), "card must render pcItemDueLabel(item)");
});
