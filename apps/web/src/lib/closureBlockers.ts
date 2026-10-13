// Plain-language labels for the R-F42 closure blockers returned on
// GET /transactions/:id and GET /transactions/by-property/:propertyId.
// The strings are the ones collectClosureBlockers already produces.
// An unrecognised line is shown unchanged so a new server blocker is
// still listed. This does not decide whether close is allowed.

export const CLOSE_BLOCKED_REASON = "Close stays unavailable until these are resolved.";

const FUNDS_STATUS_PLAIN: Record<string, string> = {
  COMMISSION_NOT_CALCULATED: "Funds cannot be checked until commission is calculated.",
  NOT_RECEIVED: "Funds have not been received.",
  PARTIAL: "Funds received are less than the commission due.",
  OVER_RECEIVED: "Funds received are more than the commission due.",
};

function countLine(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural.replace("%n", String(count));
}

/** One API blocker, in the wording the Transaction panel shows. */
export function plainClosureBlocker(blocker: string): string {
  if (blocker === "The transaction has not become unconditional yet.") {
    return "The contract is not unconditional yet.";
  }

  const conditions = blocker.match(/^(\d+) contract condition\(s\) are still Pending\.$/);
  if (conditions) {
    const count = Number(conditions[1]);
    return countLine(count, "A contract condition is still pending.", "%n contract conditions are still pending.");
  }

  const identity = blocker.match(/^AML\/CTF verification is not complete for (\d+) (seller|buyer) part(?:y|ies)\.$/);
  if (identity) {
    const count = Number(identity[1]);
    const who = identity[2] === "seller" ? "Seller" : "Buyer";
    const noun = identity[2] === "seller" ? "sellers" : "buyers";
    return countLine(count, `${who} ID verification is not complete.`, `${who} ID verification is not complete for %n ${noun}.`);
  }

  const attention = blocker.match(/^(\d+) open attention item\(s\) require review\.$/);
  if (attention) {
    const count = Number(attention[1]);
    return countLine(count, "An open attention item still needs review.", "%n open attention items still need review.");
  }

  const tasks = blocker.match(/^Must-finish task\(s\) still open: (.+)\.$/);
  if (tasks) return `These tasks still need to be finished: ${tasks[1]}.`;

  if (blocker === "Commission has not been calculated.") return blocker;

  const funds = blocker.match(/^Funds reconciliation is ([A-Z_]+), not MATCHED\.$/);
  if (funds) return FUNDS_STATUS_PLAIN[funds[1]] ?? "Funds do not match the calculated commission.";

  if (blocker === "An open financial dispute (FIN02) must be resolved before close.") {
    return "An open financial dispute must be resolved before close.";
  }

  if (blocker === "Commission does not reconcile between the transaction record and the Financial Engine.") {
    return "Commission figures do not match.";
  }

  const owners = blocker.match(/^(\d+) open non-financial exception\(s\) need an assigned owner\.$/);
  if (owners) {
    const count = Number(owners[1]);
    return countLine(count, "An open exception needs someone assigned.", "%n open exceptions need someone assigned.");
  }

  return blocker;
}

/**
 * Close stays disabled until the transaction is Settled and the read
 * returned no blockers. A missing list does not invent blockers.
 */
export function closeTransactionDisabled(status: string, closureBlockers: readonly string[] | null | undefined): boolean {
  return status !== "Settled" || (closureBlockers?.length ?? 0) > 0;
}

/** Blockers to list beside Close. A closed transaction does not list them. */
export function visibleClosureBlockers(status: string, closureBlockers: readonly string[] | null | undefined): readonly string[] {
  if (status === "Closed" || !closureBlockers || closureBlockers.length === 0) return [];
  return closureBlockers;
}
