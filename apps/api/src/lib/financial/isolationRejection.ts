// R-F10 — the financial boundary of tenant_isolation_rejection_total.
// A brokerage-scoped load cannot tell a missing id from one in another
// brokerage. On a miss only, one existence lookup (never on the success
// path) checks whether that id belongs to another brokerage and, if so,
// increments once. The lookup selects no brokerage id and no other
// tenant's columns. Callers still answer exactly as they did before.
// Same rule as routes/properties.ts and routes/parties.ts: a missing row
// does not increment, and the other brokerage's id is not logged or returned.

import { and, eq, ne } from "drizzle-orm";
import {
  db,
  commissionAgreements,
  financialPaymentRequests,
  pcFeeAuthorities,
  properties,
  users,
} from "@aee/db";
import { incrementCounter } from "@aee/events";

function isPositiveIntegerId(id: number): boolean {
  return Number.isInteger(id) && id > 0;
}

function noteFinancialRejection(found: { id: number } | undefined): void {
  if (found) incrementCounter("tenant_isolation_rejection_total", { boundary: "financial" });
}

export async function noteFinancialPropertyIsolationRejection(propertyId: number, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(propertyId)) return;
  const [elsewhere] = await db
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, propertyId), ne(properties.brokerageId, brokerageId)));
  noteFinancialRejection(elsewhere);
}

export async function noteFinancialCommissionAgreementIsolationRejection(id: number, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(id)) return;
  const [elsewhere] = await db
    .select({ id: commissionAgreements.id })
    .from(commissionAgreements)
    .where(and(eq(commissionAgreements.id, id), ne(commissionAgreements.brokerageId, brokerageId)));
  noteFinancialRejection(elsewhere);
}

export async function noteFinancialPcFeeAuthorityIsolationRejection(id: number, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(id)) return;
  const [elsewhere] = await db
    .select({ id: pcFeeAuthorities.id })
    .from(pcFeeAuthorities)
    .where(and(eq(pcFeeAuthorities.id, id), ne(pcFeeAuthorities.brokerageId, brokerageId)));
  noteFinancialRejection(elsewhere);
}

export async function noteFinancialPaymentRequestIsolationRejection(id: number, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(id)) return;
  const [elsewhere] = await db
    .select({ id: financialPaymentRequests.id })
    .from(financialPaymentRequests)
    .where(and(eq(financialPaymentRequests.id, id), ne(financialPaymentRequests.brokerageId, brokerageId)));
  noteFinancialRejection(elsewhere);
}

export async function noteFinancialUserIsolationRejection(userId: number, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(userId)) return;
  const [elsewhere] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), ne(users.brokerageId, brokerageId)));
  noteFinancialRejection(elsewhere);
}
