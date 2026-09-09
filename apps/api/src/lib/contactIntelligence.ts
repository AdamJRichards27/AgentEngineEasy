import { eq } from "drizzle-orm";
import { db, growActivities, growCommitments, growContactRoles, growOpportunities, growRelationships } from "@aee/db";

// AE GROW Priority 2 — Contact Intelligence Summary (§9).
//
// Everything here is a deterministic read over data the agent (or Grow's existing entry/import
// flows) already recorded — plain counts, most-recent/earliest timestamps, and day-count
// arithmetic. Nothing here is generative AI, and nothing here is predictive: nothing computes
// or reads a seller-probability, an AI Opportunity Score, predicted intent, or a mortgage/equity
// assumption. growOpportunities.confidenceScore/scoreExplanation are deliberately never read,
// exactly as AE GROW Priority 1's getGrowTodaySummary() (lib/growToday.ts) already established
// for the same reason — an Opportunity Score engine remains out of scope for this priority.

export interface ContactIntelligenceSummary {
  roles: string[];
  relatedPropertyCount: number;
  mostRecentInteractionAt: string | null;
  daysSinceLastInteraction: number | null;
  nextFollowUpAt: string | null;
  nextFollowUpDescription: string | null;
  activeOpportunityCount: number;
  recentActivityCount: number;
  outstandingCommitmentCount: number;
  relationshipAgeDays: number | null;
}

function daysSince(date: Date): number {
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000)));
}

// A contact is "recently active" within this window for the recentActivityCount headline figure
// — a documented, adjustable constant (matching lib/growToday.ts's COLD_CONTACT_THRESHOLD_DAYS
// pattern), not a magic number buried in the logic below.
const RECENT_ACTIVITY_WINDOW_DAYS = 30;

export async function getContactIntelligenceSummary(
  brokerageId: number,
  partyId: number,
): Promise<ContactIntelligenceSummary> {
  const [roleRows, relationshipRows, activityRows, opportunityRows, commitmentRows] = await Promise.all([
    db.select().from(growContactRoles).where(eq(growContactRoles.partyId, partyId)),
    db.select().from(growRelationships).where(eq(growRelationships.partyId, partyId)),
    db.select().from(growActivities).where(eq(growActivities.partyId, partyId)),
    db.select().from(growOpportunities).where(eq(growOpportunities.partyId, partyId)),
    db.select().from(growCommitments).where(eq(growCommitments.partyId, partyId)),
  ]);

  // Tenant isolation: every query above filtered by partyId alone. A row belonging to another
  // brokerage cannot exist for this partyId in practice (partyId itself is tenant-scoped and
  // validated by the caller before this function runs), but as a second line of defence every
  // row is still filtered by brokerageId here before being counted.
  const roles = roleRows.filter((r) => r.brokerageId === brokerageId);
  const relationships = relationshipRows.filter((r) => r.brokerageId === brokerageId);
  const activities = activityRows.filter((a) => a.brokerageId === brokerageId);
  const opportunities = opportunityRows.filter((o) => o.brokerageId === brokerageId);
  const commitments = commitmentRows.filter((c) => c.brokerageId === brokerageId);

  const relatedPropertyIds = new Set<number>();
  for (const r of relationships) if (r.propertyId) relatedPropertyIds.add(r.propertyId);

  const interactionTimestamps: Date[] = activities.map((a) => a.occurredAt);
  const mostRecentInteraction = interactionTimestamps.length > 0
    ? interactionTimestamps.reduce((latest, d) => (d > latest ? d : latest))
    : null;

  const openCommitments = commitments.filter((c) => c.status === "Open");
  const nextFollowUp = openCommitments.length > 0
    ? openCommitments.reduce((soonest, c) => (c.dueAt < soonest.dueAt ? c : soonest))
    : null;

  const activeOpportunityCount = opportunities.filter((o) => o.status === "Open").length;

  const recentActivityCount = activities.filter((a) => daysSince(a.occurredAt) <= RECENT_ACTIVITY_WINDOW_DAYS).length;

  const ageCandidates: Date[] = [
    ...relationships.map((r) => r.validFrom),
    ...activities.map((a) => a.occurredAt),
    ...opportunities.map((o) => o.createdAt),
  ];
  const earliestKnownAt = ageCandidates.length > 0
    ? ageCandidates.reduce((earliest, d) => (d < earliest ? d : earliest))
    : null;

  return {
    roles: roles.map((r) => r.role),
    relatedPropertyCount: relatedPropertyIds.size,
    mostRecentInteractionAt: mostRecentInteraction ? mostRecentInteraction.toISOString() : null,
    daysSinceLastInteraction: mostRecentInteraction ? daysSince(mostRecentInteraction) : null,
    nextFollowUpAt: nextFollowUp ? nextFollowUp.dueAt.toISOString() : null,
    nextFollowUpDescription: nextFollowUp ? nextFollowUp.description : null,
    activeOpportunityCount,
    recentActivityCount,
    outstandingCommitmentCount: openCommitments.length,
    relationshipAgeDays: earliestKnownAt ? daysSince(earliestKnownAt) : null,
  };
}
