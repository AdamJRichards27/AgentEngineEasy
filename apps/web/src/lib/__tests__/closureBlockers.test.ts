// Plain language for the R-F42 closure blocker strings the transaction
// read already returns. Display and the Close button are covered in
// transactionPanelActions.behavior.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOSE_BLOCKED_REASON,
  CLOSE_BLOCKED_REASON_FOR_OTHERS,
  CLOSURE_BLOCKER_SECTION_IDS,
  closeBlockedReason,
  closeTransactionDisabled,
  closureBlockerHref,
  plainClosureBlocker,
  plainClosureBlockerDetail,
  visibleClosureBlockerRows,
  visibleClosureBlockers,
  type ClosureBlockerDetail,
} from "../closureBlockers.ts";
import { showBlocksClosePill } from "../riskExceptions.ts";

test("each R-F42 blocker is one plain sentence", () => {
  const cases: Array<[string, string]> = [
    ["The transaction has not become unconditional yet.", "The contract is not unconditional yet."],
    ["1 contract condition(s) are still Pending.", "A contract condition is still pending."],
    ["2 contract condition(s) are still Pending.", "2 contract conditions are still pending."],
    ["AML/CTF verification is not complete for 1 seller party.", "Seller ID verification is not complete."],
    ["AML/CTF verification is not complete for 2 seller parties.", "Seller ID verification is not complete for 2 sellers."],
    ["AML/CTF verification is not complete for 1 buyer party.", "Buyer ID verification is not complete."],
    ["AML/CTF verification is not complete for 3 buyer parties.", "Buyer ID verification is not complete for 3 buyers."],
    ["1 open attention item(s) require review.", "An open attention item still needs review."],
    ["4 open attention item(s) require review.", "4 open attention items still need review."],
    [
      "Must-finish task(s) still open: Confirm the transaction record is complete; Record the retention closure check.",
      "These tasks still need to be finished: Confirm the transaction record is complete; Record the retention closure check.",
    ],
    ["Commission has not been calculated.", "Commission has not been calculated."],
    [
      "Funds reconciliation is COMMISSION_NOT_CALCULATED, not MATCHED.",
      "Funds cannot be checked until commission is calculated.",
    ],
    ["Funds reconciliation is NOT_RECEIVED, not MATCHED.", "Funds have not been received."],
    ["Funds reconciliation is PARTIAL, not MATCHED.", "Funds received are less than the commission due."],
    ["Funds reconciliation is OVER_RECEIVED, not MATCHED.", "Funds received are more than the commission due."],
    ["Funds reconciliation is OTHER, not MATCHED.", "Funds do not match the calculated commission."],
    ["An open financial dispute (FIN02) must be resolved before close.", "An open financial dispute must be resolved before close."],
    [
      "Commission does not reconcile between the transaction record and the Financial Engine.",
      "Commission figures do not match.",
    ],
    ["1 open non-financial exception(s) need an assigned owner.", "An open exception needs someone assigned."],
    ["2 open non-financial exception(s) need an assigned owner.", "2 open exceptions need someone assigned."],
    ["A blocker the panel has not seen before.", "A blocker the panel has not seen before."],
  ];

  for (const [blocker, plain] of cases) {
    assert.equal(plainClosureBlocker(blocker), plain);
  }
});

test("Close is disabled while blockers exist, and a missing list does not invent any", () => {
  assert.equal(closeTransactionDisabled("Settled", ["Commission has not been calculated."]), true);
  assert.equal(closeTransactionDisabled("Settled", []), false);
  assert.equal(closeTransactionDisabled("Settled", null), false);
  assert.equal(closeTransactionDisabled("Settled", undefined), false);
  assert.equal(closeTransactionDisabled("UnderContract", []), true);
  assert.equal(closeTransactionDisabled("Closed", []), true);

  assert.deepEqual(visibleClosureBlockers("Settled", ["Commission has not been calculated."]), ["Commission has not been calculated."]);
  assert.deepEqual(visibleClosureBlockers("UnderContract", ["Commission has not been calculated."]), ["Commission has not been calculated."]);
  assert.deepEqual(visibleClosureBlockers("Closed", ["Commission has not been calculated."]), []);
  assert.deepEqual(visibleClosureBlockers("Settled", []), []);
  assert.deepEqual(visibleClosureBlockers("Settled", null), []);
});

test("a known code is worded before the message is parsed", () => {
  const cases: ClosureBlockerDetail[] = [
    { code: "NOT_UNCONDITIONAL", message: "The transaction has not become unconditional yet." },
    { code: "CONDITIONS_PENDING", message: "1 contract condition(s) are still Pending.", count: 1 },
    { code: "CONDITIONS_PENDING", message: "2 contract condition(s) are still Pending.", count: 2 },
    { code: "AML_SELLER", message: "AML/CTF verification is not complete for 1 seller party.", count: 1 },
    { code: "AML_BUYER", message: "AML/CTF verification is not complete for 3 buyer parties.", count: 3 },
    { code: "ATTENTION_OPEN", message: "4 open attention item(s) require review.", count: 4 },
    {
      code: "MUST_FINISH_TASKS",
      message: "Must-finish task(s) still open: Confirm the transaction record is complete.",
      refs: ["task-1"],
    },
    { code: "COMMISSION_NOT_CALCULATED", message: "Commission has not been calculated." },
    {
      code: "FUNDS_NOT_MATCHED",
      message: "Funds reconciliation is NOT_RECEIVED, not MATCHED.",
      refs: ["NOT_RECEIVED"],
    },
    { code: "FINANCIAL_DISPUTE_OPEN", message: "An open financial dispute (FIN02) must be resolved before close." },
    {
      code: "COMMISSION_DISCREPANCY",
      message: "Commission does not reconcile between the transaction record and the Financial Engine.",
    },
    { code: "EXCEPTIONS_NEED_OWNER", message: "2 open non-financial exception(s) need an assigned owner.", count: 2, refs: ["ex-1", "ex-2"] },
  ];

  for (const detail of cases) {
    assert.equal(plainClosureBlockerDetail(detail), plainClosureBlocker(detail.message), detail.code);
    assert.equal(closureBlockerHref(detail.code), `#${CLOSURE_BLOCKER_SECTION_IDS[detail.code as keyof typeof CLOSURE_BLOCKER_SECTION_IDS]}`);
  }
});

test("an unknown code falls back to the message, and a mismatched detail is not linked", () => {
  const unknown = { code: "FUTURE_BLOCKER", message: "A blocker the panel has not seen before." };
  assert.equal(plainClosureBlockerDetail(unknown), "A blocker the panel has not seen before.");
  assert.equal(closureBlockerHref(unknown.code), null);
  assert.equal(closureBlockerHref(undefined), null);

  const knownMessage = { code: "FUTURE_BLOCKER", message: "Commission has not been calculated." };
  assert.equal(plainClosureBlockerDetail(knownMessage), "Commission has not been calculated.");

  const rows = visibleClosureBlockerRows(
    "Settled",
    ["Commission has not been calculated.", "A blocker the panel has not seen before."],
    [{ code: "COMMISSION_NOT_CALCULATED", message: "Commission has not been calculated." }, unknown],
  );
  assert.equal(rows[0]?.href, "#transaction-commission");
  assert.equal(rows[0]?.plain, "Commission has not been calculated.");
  assert.equal(rows[1]?.href, null);
  assert.equal(rows[1]?.plain, "A blocker the panel has not seen before.");

  const ignored = visibleClosureBlockerRows("Settled", ["Commission has not been calculated."], [
    { code: "FUNDS_NOT_MATCHED", message: "Funds reconciliation is NOT_RECEIVED, not MATCHED.", refs: ["NOT_RECEIVED"] },
  ]);
  assert.equal(ignored[0]?.href, null);
  assert.equal(ignored[0]?.code, null);
  assert.deepEqual(visibleClosureBlockerRows("Closed", ["Commission has not been calculated."], []), []);
});

test("Close copy asks a non-admin to involve an administrator", () => {
  assert.equal(closeBlockedReason("Brokerage Administrator"), CLOSE_BLOCKED_REASON);
  assert.equal(closeBlockedReason("Agent"), CLOSE_BLOCKED_REASON_FOR_OTHERS);
  assert.equal(closeBlockedReason("Pit Crew"), CLOSE_BLOCKED_REASON_FOR_OTHERS);
  assert.equal(closeBlockedReason(null), CLOSE_BLOCKED_REASON_FOR_OTHERS);
});

test("Blocks close is only the server flag on an exception", () => {
  assert.equal(showBlocksClosePill({ blocksClose: true }), true);
  assert.equal(showBlocksClosePill({ sourceType: "EXCEPTION", blocksClose: true }), true);
  assert.equal(showBlocksClosePill({ sourceType: "EXCEPTION", blocksClose: false }), false);
  assert.equal(showBlocksClosePill({ sourceType: "EXCEPTION" }), false);
  assert.equal(showBlocksClosePill({ sourceType: "LAUNCH_ITEM", blocksClose: true }), false);
  assert.equal(showBlocksClosePill({}), false);
});
