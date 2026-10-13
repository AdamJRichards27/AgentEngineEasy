// Plain language for the R-F42 closure blocker strings the transaction
// read already returns. Display and the Close button are covered in
// transactionPanelActions.behavior.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { closeTransactionDisabled, plainClosureBlocker, visibleClosureBlockers } from "../closureBlockers.ts";

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
