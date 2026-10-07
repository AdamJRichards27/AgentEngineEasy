import assert from "node:assert/strict";
import test from "node:test";
import {
  appraisalHistory,
  appraisalMatchesSearch,
  appraisalMatchesStage,
  appraisalOwnerChoices,
  appraisalReadOnlyMessage,
  appraisalWorkspacePath,
  canFilterAppraisalsByOwner,
  filterAppraisalPipeline,
  formatAppraisalDate,
  formatAppraisalDateTime,
  type AppraisalListRow,
} from "../appraisalUi.ts";

function row(overrides: Partial<AppraisalListRow> = {}): AppraisalListRow {
  return {
    id: 1,
    status: "DRAFT",
    outcome: null,
    propertyId: 10,
    propertyAddress: "77 Appraisal St",
    partyId: 3,
    partyDisplayName: "Lou Smith",
    ownerUserId: 4,
    ownerName: "Sam Agent",
    isFinalised: false,
    ...overrides,
  };
}

const rows = [
  row(),
  row({ id: 2, status: "WON", outcome: "WON", propertyAddress: "2 Won St", partyDisplayName: "Mo Jones", ownerUserId: 5, ownerName: "Alex Admin" }),
  row({ id: 3, status: "LOST", outcome: "LOST", propertyAddress: "3 Lost St", partyDisplayName: "Pat Lost" }),
  row({ id: 4, status: "DEFERRED", outcome: "DEFERRED", propertyAddress: "4 Later St", partyDisplayName: "Dee Later" }),
  row({ id: 5, status: "ARCHIVED", outcome: null, propertyAddress: "5 Old St", partyDisplayName: "Arch Old" }),
  row({ id: 6, status: "DRAFT", outcome: null, isFinalised: true, propertyAddress: "6 Final St", partyDisplayName: "Fin Al" }),
];

test("stage filters keep open, won, lost, deferred, archived, and finalised apart", () => {
  assert.deepEqual(filterAppraisalPipeline(rows, { stage: "open", search: "", ownerUserId: null }).map((item) => item.id), [1]);
  assert.deepEqual(filterAppraisalPipeline(rows, { stage: "won", search: "", ownerUserId: null }).map((item) => item.id), [2]);
  assert.deepEqual(filterAppraisalPipeline(rows, { stage: "lost", search: "", ownerUserId: null }).map((item) => item.id), [3]);
  assert.deepEqual(filterAppraisalPipeline(rows, { stage: "deferred", search: "", ownerUserId: null }).map((item) => item.id), [4]);
  assert.deepEqual(filterAppraisalPipeline(rows, { stage: "archived", search: "", ownerUserId: null }).map((item) => item.id), [5]);
  assert.deepEqual(filterAppraisalPipeline(rows, { stage: "finalised", search: "", ownerUserId: null }).map((item) => item.id), [6]);
  assert.equal(appraisalMatchesStage(rows[0], "open"), true);
  assert.equal(appraisalMatchesStage(rows[5], "open"), false);
});

test("search matches property or contact and ignores case", () => {
  assert.equal(appraisalMatchesSearch(rows[0], "appraisal"), true);
  assert.equal(appraisalMatchesSearch(rows[0], "LOU"), true);
  assert.equal(appraisalMatchesSearch(rows[0], "mo jones"), false);
  assert.deepEqual(
    filterAppraisalPipeline(rows, { stage: "all", search: "  later  ", ownerUserId: null }).map((item) => item.id),
    [4],
  );
});

test("owner choices and the owner filter stay inside the rows the caller can already see", () => {
  assert.equal(canFilterAppraisalsByOwner("Agent"), false);
  assert.equal(canFilterAppraisalsByOwner(undefined), false);
  assert.equal(canFilterAppraisalsByOwner("Brokerage Administrator"), true);
  assert.equal(canFilterAppraisalsByOwner("Pit Crew"), true);
  assert.deepEqual(
    appraisalOwnerChoices(rows).map((owner) => owner.label),
    ["Alex Admin", "Sam Agent"],
  );
  assert.deepEqual(
    filterAppraisalPipeline(rows, { stage: "all", search: "", ownerUserId: 5 }).map((item) => item.id),
    [2],
  );
});

test("terminal and finalised appraisals are read-only, and dates are Brisbane-local", () => {
  assert.equal(appraisalReadOnlyMessage(rows[0]), null);
  assert.match(appraisalReadOnlyMessage(rows[1]) ?? "", /finished and cannot be changed/);
  assert.match(appraisalReadOnlyMessage(rows[4]) ?? "", /finished and cannot be changed/);
  assert.match(appraisalReadOnlyMessage(rows[5]) ?? "", /finalised and cannot be changed/);
  assert.equal(formatAppraisalDate("2026-10-06T00:00:00.000Z"), "6 Oct 2026");
  assert.match(formatAppraisalDateTime("2026-10-06T00:00:00.000Z") ?? "", /6 Oct 2026/);
  assert.match(formatAppraisalDateTime("2026-10-06T00:00:00.000Z") ?? "", /10:00/);
  assert.equal(appraisalWorkspacePath(8), "/grow/appraisals/8");
});

test("history uses the appraisal record and appraisal timeline entries", () => {
  const history = appraisalHistory(
    {
      createdAt: "2026-10-06T00:00:00.000Z",
      updatedAt: "2026-10-06T01:00:00.000Z",
      outcome: "WON",
      outcomeAt: "2026-10-06T03:00:00.000Z",
      isFinalised: true,
      finalisedSnapshot: { finalisedAt: "2026-10-06T04:00:00.000Z" },
    },
    [
      { occurredAt: "2026-10-06T02:00:00.000Z", label: "Appraisal created", category: "Appraisal" },
      { occurredAt: "2026-10-06T05:00:00.000Z", label: "Offer received", category: "Offer" },
    ],
  );
  assert.deepEqual(
    history.map((item) => item.label),
    ["Finalised", "Outcome recorded: Won", "Appraisal created", "Updated", "Appraisal started"],
  );
});
