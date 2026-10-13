// G-12 — the grow boundary of tenant_isolation_rejection_total.
// A brokerage-scoped load cannot tell a missing id from one in another
// brokerage. On a miss only, one existence lookup (never on the success
// path) checks whether that id belongs to another brokerage and, if so,
// increments once with boundary "grow". The lookup selects no brokerage
// id and no other tenant's columns. Callers still answer exactly as they
// did before. A missing row does not increment, and the other brokerage's
// id is not logged or returned.

import { and, eq, ne } from "drizzle-orm";
import {
  db,
  appraisalComparableSales,
  appraisalMarketCompetition,
  appraisals,
  growCallRecordingConsents,
  growCallSessions,
  growCallTranscriptions,
  growCommitments,
  growContactRelationships,
  growContactRoles,
  growOpportunities,
  growRelationships,
  parties,
  properties,
  users,
} from "@aee/db";
import { incrementCounter } from "@aee/events";

function isPositiveIntegerId(id: number): boolean {
  return Number.isInteger(id) && id > 0;
}

function noteGrowRejection(found: { id: number } | undefined): void {
  if (found) incrementCounter("tenant_isolation_rejection_total", { boundary: "grow" });
}

export async function noteGrowPartyIsolationRejection(partyId: number, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(partyId)) return;
  const [elsewhere] = await db
    .select({ id: parties.id })
    .from(parties)
    .where(and(eq(parties.id, partyId), ne(parties.brokerageId, brokerageId)))
    .limit(1);
  noteGrowRejection(elsewhere);
}

export async function noteGrowPropertyIsolationRejection(propertyId: number, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(propertyId)) return;
  const [elsewhere] = await db
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, propertyId), ne(properties.brokerageId, brokerageId)))
    .limit(1);
  noteGrowRejection(elsewhere);
}

export async function noteGrowUserIsolationRejection(userId: number, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(userId)) return;
  const [elsewhere] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), ne(users.brokerageId, brokerageId)))
    .limit(1);
  noteGrowRejection(elsewhere);
}

export async function noteGrowRelationshipIsolationRejection(id: number, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(id)) return;
  const [elsewhere] = await db
    .select({ id: growRelationships.id })
    .from(growRelationships)
    .where(and(eq(growRelationships.id, id), ne(growRelationships.brokerageId, brokerageId)))
    .limit(1);
  noteGrowRejection(elsewhere);
}

export async function noteGrowOpportunityIsolationRejection(id: number, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(id)) return;
  const [elsewhere] = await db
    .select({ id: growOpportunities.id })
    .from(growOpportunities)
    .where(and(eq(growOpportunities.id, id), ne(growOpportunities.brokerageId, brokerageId)))
    .limit(1);
  noteGrowRejection(elsewhere);
}

export async function noteGrowContactRelationshipIsolationRejection(id: number, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(id)) return;
  const [elsewhere] = await db
    .select({ id: growContactRelationships.id })
    .from(growContactRelationships)
    .where(and(eq(growContactRelationships.id, id), ne(growContactRelationships.brokerageId, brokerageId)))
    .limit(1);
  noteGrowRejection(elsewhere);
}

/** Role assignments are keyed by party + role, not by a route id of their own. */
export async function noteGrowContactRoleIsolationRejection(partyId: number, role: string, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(partyId) || role.length === 0) return;
  const [elsewhere] = await db
    .select({ id: growContactRoles.id })
    .from(growContactRoles)
    .where(and(eq(growContactRoles.partyId, partyId), eq(growContactRoles.role, role), ne(growContactRoles.brokerageId, brokerageId)))
    .limit(1);
  noteGrowRejection(elsewhere);
}

export async function noteGrowCommitmentIsolationRejection(id: number, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(id)) return;
  const [elsewhere] = await db
    .select({ id: growCommitments.id })
    .from(growCommitments)
    .where(and(eq(growCommitments.id, id), ne(growCommitments.brokerageId, brokerageId)))
    .limit(1);
  noteGrowRejection(elsewhere);
}

/** The row exists in another brokerage. appraisals.brokerage_id matches the
 * linked property under appraisals_property_brokerage_fk, so the direct
 * inequality is the same "elsewhere" check. The property join stays. */
export async function noteGrowAppraisalIsolationRejection(appraisalId: number, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(appraisalId)) return;
  const [elsewhere] = await db
    .select({ id: appraisals.id })
    .from(appraisals)
    .innerJoin(properties, eq(properties.id, appraisals.propertyId))
    .where(and(eq(appraisals.id, appraisalId), ne(appraisals.brokerageId, brokerageId)))
    .limit(1);
  noteGrowRejection(elsewhere);
}

export async function noteGrowComparableSaleIsolationRejection(saleId: number, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(saleId)) return;
  const [elsewhere] = await db
    .select({ id: appraisalComparableSales.id })
    .from(appraisalComparableSales)
    .innerJoin(appraisals, eq(appraisals.id, appraisalComparableSales.appraisalId))
    .innerJoin(properties, eq(properties.id, appraisals.propertyId))
    .where(and(eq(appraisalComparableSales.id, saleId), ne(properties.brokerageId, brokerageId)))
    .limit(1);
  noteGrowRejection(elsewhere);
}

export async function noteGrowMarketCompetitionIsolationRejection(itemId: number, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(itemId)) return;
  const [elsewhere] = await db
    .select({ id: appraisalMarketCompetition.id })
    .from(appraisalMarketCompetition)
    .innerJoin(appraisals, eq(appraisals.id, appraisalMarketCompetition.appraisalId))
    .innerJoin(properties, eq(properties.id, appraisals.propertyId))
    .where(and(eq(appraisalMarketCompetition.id, itemId), ne(properties.brokerageId, brokerageId)))
    .limit(1);
  noteGrowRejection(elsewhere);
}

export async function noteGrowCallSessionIsolationRejection(callSessionId: number, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(callSessionId)) return;
  const [elsewhere] = await db
    .select({ id: growCallSessions.id })
    .from(growCallSessions)
    .where(and(eq(growCallSessions.id, callSessionId), ne(growCallSessions.brokerageId, brokerageId)))
    .limit(1);
  noteGrowRejection(elsewhere);
}

export async function noteGrowCallTranscriptionIsolationRejection(transcriptionId: number, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(transcriptionId)) return;
  const [elsewhere] = await db
    .select({ id: growCallTranscriptions.id })
    .from(growCallTranscriptions)
    .where(and(eq(growCallTranscriptions.id, transcriptionId), ne(growCallTranscriptions.brokerageId, brokerageId)))
    .limit(1);
  noteGrowRejection(elsewhere);
}

export async function noteGrowRecordingConsentIsolationRejection(consentId: number, brokerageId: number): Promise<void> {
  if (!isPositiveIntegerId(consentId)) return;
  const [elsewhere] = await db
    .select({ id: growCallRecordingConsents.id })
    .from(growCallRecordingConsents)
    .where(and(eq(growCallRecordingConsents.id, consentId), ne(growCallRecordingConsents.brokerageId, brokerageId)))
    .limit(1);
  noteGrowRejection(elsewhere);
}
