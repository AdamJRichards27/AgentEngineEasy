// Owner t170u + t171u — confidential transaction financials (review P2).
//
// t170u: Pit Crew sees the agreed contract purchase price only where assigned
//   to the transaction and required for their duties; brokerage isolation,
//   transaction-level permissions, access logging; no price in unrestricted
//   transaction responses.
// t171u: the same safeguard covers every field that reveals the price
//   directly or by derivation (deposit, commission + GST, funds received and
//   the funds reconciliation); access needs BOTH an active assignment AND the
//   right duty (lib/pitCrewDuties.ts, PENDING OWNER CONFIRMATION); logging
//   stays fail-closed and never records a value.
//
// No migration, no schema change. Who sees which group
// (lib/pitCrewDuties.ts TRANSACTION_FINANCIAL_GROUP_FIELDS):
//   - Brokerage Administrator: all groups.
//   - The Agent who is the property's listing agent (properties.agent_id):
//     all groups.
//   - Pit Crew: only the groups their duties allow, and only through an
//     ACTIVE assignment ON THIS TRANSACTION. Unassigned Pit Crew: none.
//   - Anyone else who reaches this module: none. Callers have already
//     answered 404 for another brokerage and, on the transaction routes, for
//     an Agent who is not the listing agent.
// A hidden group's keys are OMITTED (never nulled), and
// `financialVisibility` says which groups were withheld.
// `purchasePriceVisible` stays as the t170u alias of
// financialVisibility.purchasePrice.
//
// "Assigned to the transaction", from existing data only: an ACTIVE
// pit_crew_assignments row (CLAIMED, IN_PROGRESS or WAITING_ON) assigned to
// this user, in this brokerage, on this property, with source EXCEPTION, whose
// risk_exceptions row (same brokerage and property) names this transaction.
// The duty is derived from that exception's category (pitCrewDuties.ts).
//
// Access log: each Pit Crew reveal of at least one group writes audit_logs
// `transaction_purchase_price_viewed` (name kept from t170u) with role,
// basis, assignment ids, duties, the revealed field CATEGORIES and the
// surface. Never a value. Strict: an audit failure withholds every group.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, pitCrewAssignments, properties, riskExceptions, type Transaction } from "@aee/db";
import { logAudit } from "./audit.js";
import { BROKERAGE_ADMIN_ROLES, PIT_CREW_ROLES, type AuthedUser } from "../middlewares/auth.js";
import {
  ALL_FINANCIALS_VISIBLE,
  NO_FINANCIALS_VISIBLE,
  TRANSACTION_FINANCIAL_GROUPS,
  TRANSACTION_FINANCIAL_GROUP_FIELDS,
  dutyForAssignment,
  financialVisibilityForDuties,
  type FinancialVisibility,
  type PitCrewDuty,
} from "./pitCrewDuties.js";

export const PURCHASE_PRICE_VIEWED_AUDIT_ACTION = "transaction_purchase_price_viewed";

/** Pit Crew statuses that mean "this user is currently working the item". */
export const ACTIVE_PIT_CREW_ASSIGNMENT_STATUSES = ["CLAIMED", "IN_PROGRESS", "WAITING_ON"] as const;

export type FinancialAccessBasis = "brokerage_admin" | "listing_agent" | "pit_crew_assignment";

export type TransactionView = Partial<Transaction> &
  Pick<Transaction, "id" | "propertyId" | "status"> & {
    financialVisibility: FinancialVisibility;
    purchasePriceVisible: boolean;
  };

/** Pure: omit (not null) every key of every hidden group. */
export function toTransactionView(transaction: Transaction, visibility: FinancialVisibility | boolean): TransactionView {
  const vis: FinancialVisibility =
    typeof visibility === "boolean" ? (visibility ? { ...ALL_FINANCIALS_VISIBLE } : { ...NO_FINANCIALS_VISIBLE }) : { ...visibility };
  const out: Record<string, unknown> = { ...transaction };
  for (const group of TRANSACTION_FINANCIAL_GROUPS) {
    if (vis[group]) continue;
    for (const key of TRANSACTION_FINANCIAL_GROUP_FIELDS[group]) delete out[key];
  }
  out.financialVisibility = vis;
  out.purchasePriceVisible = vis.purchasePrice;
  return out as TransactionView;
}

export interface PitCrewTransactionAssignment {
  assignmentId: number;
  exceptionCategory: string;
  duty: PitCrewDuty | null;
}

/** The caller's active Pit Crew assignments on this transaction, with duties. */
export async function activePitCrewAssignmentsForTransaction(
  user: Pick<AuthedUser, "id" | "brokerageId">,
  transaction: Pick<Transaction, "id" | "propertyId">,
): Promise<PitCrewTransactionAssignment[]> {
  const rows = await db
    .select({ id: pitCrewAssignments.id, sourceType: pitCrewAssignments.sourceType, category: riskExceptions.category })
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
  return rows.map((r) => ({ assignmentId: r.id, exceptionCategory: r.category, duty: dutyForAssignment(r.sourceType, r.category) }));
}

export interface TransactionFinancialAccess {
  visibility: FinancialVisibility;
  basis: FinancialAccessBasis | null;
  assignments: PitCrewTransactionAssignment[];
}

/** Decides only; does not log. `listingAgentId` is properties.agent_id. */
export async function resolveTransactionFinancialAccess(
  user: AuthedUser,
  transaction: Pick<Transaction, "id" | "propertyId">,
  listingAgentId: number | null | undefined,
): Promise<TransactionFinancialAccess> {
  if (BROKERAGE_ADMIN_ROLES.includes(user.role)) return { visibility: { ...ALL_FINANCIALS_VISIBLE }, basis: "brokerage_admin", assignments: [] };
  if (user.role === "Agent" && listingAgentId != null && listingAgentId === user.id) {
    return { visibility: { ...ALL_FINANCIALS_VISIBLE }, basis: "listing_agent", assignments: [] };
  }
  if (PIT_CREW_ROLES.includes(user.role)) {
    const assignments = await activePitCrewAssignmentsForTransaction(user, transaction);
    if (assignments.length > 0) {
      return { visibility: financialVisibilityForDuties(assignments.map((a) => a.duty)), basis: "pit_crew_assignment", assignments };
    }
  }
  return { visibility: { ...NO_FINANCIALS_VISIBLE }, basis: null, assignments: [] };
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
  const revealed = TRANSACTION_FINANCIAL_GROUPS.filter((g) => access.visibility[g]);
  if (revealed.length === 0) return toTransactionView(transaction, false);
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
            duties: [...new Set(access.assignments.map((a) => a.duty).filter((d): d is PitCrewDuty => d !== null))],
            fieldCategories: revealed,
            dutyMapStatus: "PENDING_OWNER_CONFIRMATION",
            surface,
          }),
        },
        { strict: true },
      );
    } catch {
      return toTransactionView(transaction, false);
    }
  }
  return toTransactionView(transaction, access.visibility);
}
