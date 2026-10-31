// AB-4: AE Minimal Appraisals list model and route selector.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AppraisalListRow } from "../appraisalUi";
import { buildMinimalAppraisals, selectAppraisalsView } from "../../minimal/appraisals/minimalAppraisalsModel";

const row = (id: number, over: Partial<AppraisalListRow> = {}): AppraisalListRow => ({
  id,
  status: "PREPARING",
  outcome: null,
  propertyId: id * 10,
  propertyAddress: `${id} Test St, Brisbane`,
  partyId: id,
  partyDisplayName: `Contact ${id}`,
  ownerUserId: 1,
  ownerName: "Agent One",
  followUpAt: null,
  updatedAt: "2026-10-20T00:00:00Z",
  ...over,
});

const now = new Date("2026-10-22T06:00:00Z");

test("active tab: builder link, earliest follow-up first, overdue flagged", () => {
  const m = buildMinimalAppraisals(
    [
      row(1),
      row(2, { followUpAt: "2026-10-25T00:00:00Z" }),
      row(3, { followUpAt: "2026-10-21T00:00:00Z" }),
      row(4, { status: "WON" }),
    ],
    { tab: "active", now },
  );
  assert.deepEqual(m.counts, { active: 3, finished: 1 });
  assert.deepEqual(m.rows.map((r) => r.id), [3, 2, 1]);
  assert.equal(m.rows[0].followUpOverdue, true);
  assert.equal(m.rows[1].followUpOverdue, false);
  assert.equal(m.rows[0].href, "/grow/appraisals/3/build");
  assert.equal(m.rows[0].actionLabel, "Continue");
});

test("finished tab: read-only workspace link, no next step or follow-up", () => {
  const m = buildMinimalAppraisals([row(1), row(4, { status: "WON", followUpAt: "2026-10-01T00:00:00Z" })], { tab: "finished", now });
  assert.equal(m.rows.length, 1);
  assert.equal(m.rows[0].href, "/grow/appraisals/4");
  assert.equal(m.rows[0].actionLabel, "Open");
  assert.equal(m.rows[0].nextStep, null);
  assert.equal(m.rows[0].followUp, null);
  assert.equal(m.rows[0].followUpOverdue, false);
});

test("search filters both tabs and counts; missing contact is labelled", () => {
  const m = buildMinimalAppraisals([row(1), row(2, { partyDisplayName: null, propertyAddress: "9 Other Rd" })], {
    tab: "active",
    search: "other",
    now,
  });
  assert.deepEqual(m.counts, { active: 1, finished: 0 });
  assert.equal(m.rows[0].contact, "No contact linked");
});

test("route selector: flag off or ?view=full → classic", () => {
  assert.equal(selectAppraisalsView(false), "classic");
  assert.equal(selectAppraisalsView(true, "?view=full"), "classic");
  assert.equal(selectAppraisalsView(true, ""), "minimal");
});

test("App.tsx routes /grow/appraisals through the selector, after /:id/build and /:id", () => {
  const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
  const build = app.indexOf('path="/grow/appraisals/:id/build"');
  const byId = app.indexOf('path="/grow/appraisals/:id"');
  const list = app.indexOf('path="/grow/appraisals">');
  assert.ok(build > 0 && byId > build && list > byId);
  assert.match(app, /selectAppraisalsView\(minimalShell, search\) === "minimal" \? <MinimalAppraisals \/> : <GrowAppraisals \/>/);
});
