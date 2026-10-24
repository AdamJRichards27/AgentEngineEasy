// Owner t170u — Pit Crew transaction purchase-price access (review P2).
//
//   2. "Allow Pit Crew access to the agreed contract purchase price only
//      where the user is assigned to the transaction and the information is
//      required for their duties."
//   3. "Enforce brokerage isolation, transaction-level permissions and
//      access logging."
//   4. "Do not expose purchase prices through unrestricted transaction API
//      responses."
//
// No migration, no schema change. Who may see `purchasePriceCents`:
//   - Brokerage Administrator (same "authorised Brokerage Administrators"
//     rule as offer terms, lib/offers.ts canSeeOfferTerms);
//   - the Agent who is the property's listing agent (properties.agent_id);
//   - a Pit Crew user who is ASSIGNED to this transaction (below). Every such
//     reveal is written to the existing audit log first; if that write fails
//     the price is withheld (fail closed).
// Everyone else in the brokerage gets the transaction with the price key
// omitted and `purchasePriceVisible: false`. Callers have already answered
// 404 for another brokerage (and, on the transaction routes, for an Agent
// who is not the listing agent), so this module never sees those callers.
//
// "Assigned to the transaction", from existing data only: an ACTIVE
// pit_crew_assignments row (status CLAIMED, IN_PROGRESS or WAITING_ON)
// assigned to this user, in this brokerage, on this property, whose source
// is an EXCEPTION (the only Pit Crew work source writable today — R-F21
// allow-list, lib/pitCrew/types.ts) and whose risk_exceptions row names this
// transaction (risk_exceptions.transaction_id) in the same brokerage.
// DONE, HANDED_BACK, ESCALATED and UNCLAIMED rows do not count. If another
// Pit Crew source type that names a transaction is ever made writable
// (e.g. SETTLEMENT_MILESTONE / CONTRACT_MILESTONE), it needs its own branch
// here; it does not fall through.
//
// "Required for their duties": per-duty scoping waits on the Owner's open
// D1–D4 service-list decision. Until then, assignment to the transaction is
// the gate; no duty taxonomy is invented here.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, pitCrewAssignments, properties, riskExceptions, type Transaction } from "@aee/db";
import { logAudit } from "./audit.js";
import { BROKERAGE_ADMIN_ROLES, PIT_CREW_ROLES, type AuthedUser } from "../middlewares/auth.js";

export const PURCHASE_PRICE_VIEWED_AUDIT_ACTION = "transaction_purchase_price_viewed";

/** Pit Crew statuses that mean "this user is currently working the item". */
export const ACTIVE_PIT_CREW_ASSIGNMENT_STATUSES = ["CLAIMED", "IN_PROGRESS", "WAITING_ON"] as const;

export type PurchasePriceBasis = "brokerage_admin" | "listing_agent" | "pit_crew_assignment";

export type FullTransactionView = Transaction & { purchasePriceVisible: true };
export type RedactedTransactionView = Omit<Transaction, "purchasePriceCents"> & { purchasePriceVisible: false };
export type TransactionView = FullTransactionView | RedactedTransactionView;

/** Pure: omit (not null) the price so a client cannot read it as a real 0. */
export function toTransactionView(transaction: Transaction, priceVisible: boolean): TransactionView {
  if (priceVisible) return { ...transaction, purchasePriceVisible: true };
  const { purchasePriceCents: _price, ...redacted } = transaction;
  return { ...redacted, purchasePriceVisible: false };
}

/**
 * The id of the caller's active Pit Crew assignment on this transaction, or
 * null. Every predicate is brokerage-scoped on both sides of the join.
 */
export async function activePitCrewAssignmentIdForTransaction(
  user: Pick<AuthedUser, "id" | "brokerageId">,
  transaction: Pick<Transaction, "id" | "propertyId">,
): Promise<number | null> {
  const rows = await db
    .select({ id: pitCrewAssignments.id })
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
    .limit(1);
  return rows[0]?.id ?? null;
}

export interface PurchasePriceAccess {
  visible: boolean;
  basis: PurchasePriceBasis | null;
  assignmentId: number | null;
}

/** Decides only; does not log. `listingAgentId` is properties.agent_id. */
export async function resolvePurchasePriceAccess(
  user: AuthedUser,
  transaction: Pick<Transaction, "id" | "propertyId">,
  listingAgentId: number | null | undefined,
): Promise<PurchasePriceAccess> {
  if (BROKERAGE_ADMIN_ROLES.includes(user.role)) return { visible: true, basis: "brokerage_admin", assignmentId: null };
  if (user.role === "Agent" && listingAgentId != null && listingAgentId === user.id) {
    return { visible: true, basis: "listing_agent", assignmentId: null };
  }
  if (PIT_CREW_ROLES.includes(user.role)) {
    const assignmentId = await activePitCrewAssignmentIdForTransaction(user, transaction);
    if (assignmentId !== null) return { visible: true, basis: "pit_crew_assignment", assignmentId };
  }
  return { visible: false, basis: null, assignmentId: null };
}

/**
 * The only way a transaction row should leave the API for a signed-in
 * caller. Loads the listing agent, decides, writes the access log for a
 * Pit Crew reveal (strict: an audit failure withholds the price), and
 * returns the shaped view. `surface` names the route for the log; the price
 * itself is never logged.
 */
export async function transactionViewFor(user: AuthedUser, transaction: Transaction, surface: string): Promise<TransactionView> {
  const [property] = await db
    .select({ agentId: properties.agentId, brokerageId: properties.brokerageId })
    .from(properties)
    .where(eq(properties.id, transaction.propertyId));
  // Defence in depth: callers already 404 another brokerage.
  if (!property || property.brokerageId !== user.brokerageId) return toTransactionView(transaction, false);
  const access = await resolvePurchasePriceAccess(user, transaction, property.agentId);
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
            pitCrewAssignmentId: access.assignmentId,
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
