// Plain-language labels for the R-F42 closure blockers returned on
// GET /transactions/:id and GET /transactions/by-property/:propertyId.
// The strings are the ones collectClosureBlockers already produces.
// An unrecognised line is shown unchanged so a new server blocker is
// still listed. This does not decide whether close is allowed.

export const CLOSE_BLOCKED_REASON = "Close stays unavailable until these are resolved.";

/** Close is Brokerage Administrator only. Everyone else still sees the list. */
export const CLOSE_BLOCKED_REASON_FOR_OTHERS = "Ask an admin to close once these are resolved.";

export function closeBlockedReason(role: string | null | undefined): string {
  return role === "Brokerage Administrator" ? CLOSE_BLOCKED_REASON : CLOSE_BLOCKED_REASON_FOR_OTHERS;
}

/** Stable codes from GET transaction `closureBlockerDetails`. */
export const CLOSURE_BLOCKER_SECTION_IDS = {
  NOT_UNCONDITIONAL: "transaction-unconditional",
  CONDITIONS_PENDING: "transaction-conditions",
  AML_SELLER: "workspace-sellers",
  AML_BUYER: "workspace-parties",
  ATTENTION_OPEN: "workspace-tasks",
  MUST_FINISH_TASKS: "workspace-tasks",
  COMMISSION_NOT_CALCULATED: "transaction-commission",
  FUNDS_NOT_MATCHED: "transaction-funds",
  FINANCIAL_DISPUTE_OPEN: "workspace-financial",
  COMMISSION_DISCREPANCY: "transaction-commission",
  EXCEPTIONS_NEED_OWNER: "workspace-exceptions",
} as const;

export type ClosureBlockerCode = keyof typeof CLOSURE_BLOCKER_SECTION_IDS;

export interface ClosureBlockerDetail {
  code: string;
  message: string;
  count?: number;
  refs?: string[];
}

export function closureBlockerHref(code: string | null | undefined): string | null {
  if (!code || !(code in CLOSURE_BLOCKER_SECTION_IDS)) return null;
  return `#${CLOSURE_BLOCKER_SECTION_IDS[code as ClosureBlockerCode]}`;
}

const FUNDS_STATUS_PLAIN: Record<string, string> = {
  COMMISSION_NOT_CALCULATED: "Funds cannot be checked until commission is calculated.",
  NOT_RECEIVED: "Funds have not been received.",
  PARTIAL: "Funds received are less than the commission due.",
  OVER_RECEIVED: "Funds received are more than the commission due.",
};

function countLine(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural.replace("%n", String(count));
}

function leadingCount(message: string): number | null {
  const match = message.match(/^(\d+)\s/);
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isFinite(count) ? count : null;
}

function plainFromCode(detail: ClosureBlockerDetail): string | null {
  const count = detail.count ?? leadingCount(detail.message);
  switch (detail.code) {
    case "NOT_UNCONDITIONAL":
      return "The contract is not unconditional yet.";
    case "CONDITIONS_PENDING":
      if (count == null) return null;
      return countLine(count, "A contract condition is still pending.", "%n contract conditions are still pending.");
    case "AML_SELLER":
    case "AML_BUYER": {
      if (count == null) return null;
      const who = detail.code === "AML_SELLER" ? "Seller" : "Buyer";
      const noun = detail.code === "AML_SELLER" ? "sellers" : "buyers";
      return countLine(count, `${who} ID verification is not complete.`, `${who} ID verification is not complete for %n ${noun}.`);
    }
    case "ATTENTION_OPEN":
      if (count == null) return null;
      return countLine(count, "An open attention item still needs review.", "%n open attention items still need review.");
    case "MUST_FINISH_TASKS": {
      const tasks = detail.message.match(/^Must-finish task\(s\) still open: (.+)\.$/);
      return tasks ? `These tasks still need to be finished: ${tasks[1]}.` : null;
    }
    case "COMMISSION_NOT_CALCULATED":
      return "Commission has not been calculated.";
    case "FUNDS_NOT_MATCHED": {
      const status = detail.refs?.[0] ?? detail.message.match(/^Funds reconciliation is ([A-Z_]+), not MATCHED\.$/)?.[1];
      if (!status) return null;
      return FUNDS_STATUS_PLAIN[status] ?? "Funds do not match the calculated commission.";
    }
    case "FINANCIAL_DISPUTE_OPEN":
      return "An open financial dispute must be resolved before close.";
    case "COMMISSION_DISCREPANCY":
      return "Commission figures do not match.";
    case "EXCEPTIONS_NEED_OWNER":
      if (count == null) return null;
      return countLine(count, "An open exception needs someone assigned.", "%n open exceptions need someone assigned.");
    default:
      return null;
  }
}

/**
 * Prefer the stable code. An unknown code, or a known code that did not
 * carry enough to word the sentence, falls through to the message regexes.
 */
export function plainClosureBlockerDetail(detail: ClosureBlockerDetail): string {
  return plainFromCode(detail) ?? plainClosureBlocker(detail.message);
}

export interface VisibleClosureBlockerRow {
  message: string;
  plain: string;
  href: string | null;
  code: string | null;
}

/**
 * One row per string blocker. A detail is used only when its message is
 * that string, so a wording change cannot attach the wrong section.
 */
export function visibleClosureBlockerRows(
  status: string,
  closureBlockers: readonly string[] | null | undefined,
  details: readonly ClosureBlockerDetail[] | null | undefined,
): VisibleClosureBlockerRow[] {
  return visibleClosureBlockers(status, closureBlockers).map((message) => {
    const detail = details?.find((row) => row.message === message);
    if (!detail) {
      return { message, plain: plainClosureBlocker(message), href: null, code: null };
    }
    return {
      message,
      plain: plainClosureBlockerDetail(detail),
      href: closureBlockerHref(detail.code),
      code: detail.code,
    };
  });
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
