// Owner t170u + t172u — confidential transaction financials (review P2).
//
// t172u (supersedes the t171u duty-based restriction, whose code-level duty
// map lib/pitCrewDuties.ts has been removed): "Authorised Pit Crew personnel
// assigned to a transaction must be able to view all financial information
// necessary to accurately administer and reconcile settlement." Safeguards:
// visible only to authorised Pit Crew assigned to the relevant transaction;
// logged and brokerage-isolated; unassigned Pit Crew and unauthorised agents
// cannot access; viewing does not authorise changing fees, approving
// payments or disbursing funds (this module only shapes READ responses; it
// grants no write).
//
// No migration, no schema change, no extra permission framework. Who sees
// the confidential groups (TRANSACTION_FINANCIAL_GROUP_FIELDS):
//   - Brokerage Administrator: all.
//   - The Agent who is the property's listing agent (properties.agent_id): all.
//   - Pit Crew (role Pit Crew; the routes already require run.access and the
//     same brokerage) with an ACTIVE assignment ON THIS TRANSACTION: all.
//   - Everyone else who reaches this module (unassigned Pit Crew; a Pit Crew
//     member whose assignment is DONE, HANDED_BACK, ESCALATED or UNCLAIMED,
//     or on another transaction): none. Callers have already answered 404 for
//     another brokerage and, on the transaction routes, for an Agent who is
//     not the listing agent.
// A hidden group's keys are OMITTED (never nulled); `financialVisibility`
// says which groups were withheld; `purchasePriceVisible` is the t170u alias.
//
// "Assigned to the transaction" (unchanged since t170u, existing data only):
// an ACTIVE pit_crew_assignments row (CLAIMED, IN_PROGRESS or WAITING_ON)
// assigned to this user, in this brokerage, on this property, with source
// EXCEPTION (the only writable Pit Crew source, R-F21), whose risk_exceptions
// row (same brokerage and property) names this transaction. Any exception
// category counts. Whether assignment through every category is "authorised"
// work is the Owner's open D2.3 question; no gate is added for it.
//
// Access log: each Pit Crew reveal writes audit_logs
// `transaction_purchase_price_viewed` (name kept from t170u) with role,
// basis, assignment ids, the exception categories behind them, the revealed
// field CATEGORIES and the surface. Never a value. Strict: an audit failure
// withholds every group.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, pitCrewAssignments, properties, riskExceptions, type Transaction } from "@aee/db";
import { logAudit } from "./audit.js";
import { BROKERAGE_ADMIN_ROLES, PIT_CREW_ROLES, type AuthedUser } from "../middlewares/auth.js";

export const PURCHASE_PRICE_VIEWED_AUDIT_ACTION = "transaction_purchase_price_viewed";

/** Pit Crew statuses that mean "this user is currently working the item". */
export const ACTIVE_PIT_CREW_ASSIGNMENT_STATUSES = ["CLAIMED", "IN_PROGRESS", "WAITING_ON"] as const;

/** Confidential transaction financial field groups (t171u inventory, t172u list). */
export const TRANSACTION_FINANCIAL_GROUPS = ["purchasePrice", "deposit", "commission", "funds"] as const;
export type TransactionFinancialGroup = (typeof TRANSACTION_FINANCIAL_GROUPS)[number];

/**
 * Transaction-row keys per group. `funds` also covers the derived
 * `fundsReconciliation` (expected = commission + GST), which the transaction
 * routes drop when `funds` is hidden.
 */
export const TRANSACTION_FINANCIAL_GROUP_FIELDS = {
  purchasePrice: ["purchasePriceCents"],
  deposit: ["depositCents"],
  commission: ["grossCommissionCents", "gstCents"],
  funds: ["fundsReceivedCents"],
} as const satisfies Record<TransactionFinancialGroup, readonly (keyof Transaction)[]>;

export type FinancialVisibility = Record<TransactionFinancialGroup, boolean>;
const ALL: FinancialVisibility = Object.freeze({ purchasePrice: true, deposit: true, commission: true, funds: true });
const NONE: FinancialVisibility = Object.freeze({ purchasePrice: false, deposit: false, commission: false, funds: false });

export type FinancialAccessBasis = "brokerage_admin" | "listing_agent" | "pit_crew_assignment";

export type TransactionView = Partial<Transaction> &
  Pick<Transaction, "id" | "propertyId" | "status"> & {
    financialVisibility: FinancialVisibility;
    purchasePriceVisible: boolean;
  };

/** Pure: all groups or none (t172u); keys of hidden groups are omitted. */
export function toTransactionView(transaction: Transaction, visible: boolean): TransactionView {
  const vis: FinancialVisibility = { ...(visible ? ALL : NONE) };
  const out: Record<string, unknown> = { ...transaction };
  if (!visible) {
    for (const group of TRANSACTION_FINANCIAL_GROUPS) for (const key of TRANSACTION_FINANCIAL_GROUP_FIELDS[group]) delete out[key];
  }
  out.financialVisibility = vis;
  out.purchasePriceVisible = vis.purchasePrice;
  return out as TransactionView;
}

export interface PitCrewTransactionAssignment {
  assignmentId: number;
  exceptionCategory: string;
}

/** The caller's active Pit Crew assignments on this transaction. */
export async function activePitCrewAssignmentsForTransaction(
  user: Pick<AuthedUser, "id" | "brokerageId">,
  transaction: Pick<Transaction, "id" | "propertyId">,
): Promise<PitCrewTransactionAssignment[]> {
  const rows = await db
    .select({ id: pitCrewAssignments.id, category: riskExceptions.category })
    .from(pitCrewAssignments)
    .innerJoin(
      riskExceptions,
      and(
        eq(pitCrewAssignments.sourceType, "EXCEPTION"),
        sql`${pitCrewAssignments.sourceRecordId} = ${riskExceptions.id}::text`,
        eq(riskExceptions.brokerageId, pitCrewAssignments.brokerageId),
        eq(riskExceptions.propertyId, pitCrewAssignments.propertyId),
      ),
    )
    .where(
      and(
        eq(pitCrewAssignments.brokerageId, user.brokerageId),
        eq(pitCrewAssignments.assignedToUserId, user.id),
        eq(pitCrewAssignments.propertyId, transaction.propertyId),
        inArray(pitCrewAssignments.status, [...ACTIVE_PIT_CREW_ASSIGNMENT_STATUSES]),
        eq(riskExceptions.transactionId, transaction.id),
      ),
    )
    .orderBy(pitCrewAssignments.id);
  return rows.map((r) => ({ assignmentId: r.id, exceptionCategory: r.category }));
}

export interface TransactionFinancialAccess {
  visible: boolean;
  basis: FinancialAccessBasis | null;
  assignments: PitCrewTransactionAssignment[];
}

/** Decides only; does not log. `listingAgentId` is properties.agent_id. */
export async function resolveTransactionFinancialAccess(
  user: AuthedUser,
  transaction: Pick<Transaction, "id" | "propertyId">,
  listingAgentId: number | null | undefined,
): Promise<TransactionFinancialAccess> {
  if (BROKERAGE_ADMIN_ROLES.includes(user.role)) return { visible: true, basis: "brokerage_admin", assignments: [] };
  if (user.role === "Agent" && listingAgentId != null && listingAgentId === user.id) {
    return { visible: true, basis: "listing_agent", assignments: [] };
  }
  if (PIT_CREW_ROLES.includes(user.role)) {
    const assignments = await activePitCrewAssignmentsForTransaction(user, transaction);
    if (assignments.length > 0) return { visible: true, basis: "pit_crew_assignment", assignments };
  }
  return { visible: false, basis: null, assignments: [] };
}

/**
 * The only way a transaction row should leave the API for a signed-in
 * caller. Loads the listing agent, decides, writes the access log for a
 * Pit Crew reveal (strict: an audit failure withholds every group), and
 * returns the shaped view. `surface` names the route for the log.
 */
export async function transactionViewFor(user: AuthedUser, transaction: Transaction, surface: string): Promise<TransactionView> {
  const [property] = await db
    .select({ agentId: properties.agentId, brokerageId: properties.brokerageId })
    .from(properties)
    .where(eq(properties.id, transaction.propertyId));
  // Defence in depth: callers already 404 another brokerage.
  if (!property || property.brokerageId !== user.brokerageId) return toTransactionView(transaction, false);
  const access = await resolveTransactionFinancialAccess(user, transaction, property.agentId);
  if (!access.visible) return toTransactionView(transaction, false);
  if (access.basis === "pit_crew_assignment") {
    try {
      await logAudit(
        {
          brokerageId: user.brokerageId,
          userId: user.id,
          action: PURCHASE_PRICE_VIEWED_AUDIT_ACTION,
          recordType: "transaction",
          recordId: String(transaction.id),
          propertyId: transaction.propertyId,
          updatedValue: JSON.stringify({
            actorRole: user.role,
            basis: access.basis,
            pitCrewAssignmentIds: access.assignments.map((a) => a.assignmentId),
            exceptionCategories: [...new Set(access.assignments.map((a) => a.exceptionCategory))],
            fieldCategories: [...TRANSACTION_FINANCIAL_GROUPS],
            policy: "t172u",
            surface,
          }),
        },
        { strict: true },
      );
    } catch {
      return toTransactionView(transaction, false);
    }
  }
  return toTransactionView(transaction, true);
}
