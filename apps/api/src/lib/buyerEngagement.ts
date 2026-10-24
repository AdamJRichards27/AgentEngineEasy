// CC #34 slice B-2 — buyer engagement timeline, Run sources only (spec
// specs/buyer-engagement.md §3/§4; no migration, read-only).
//
// One timeline per (property, buyer party), merged from data Run already
// owns:
//   - property_parties: when the party was linked to the property as Buyer;
//   - offers: each offer this party made on this property (offer_received at
//     created_at, with price and current status), plus its later decisions
//     from audit_logs (offer_accepted / offer_declined / offer_withdrawn /
//     offer_auto_declined), which carry their own timestamps;
//   - transactions on this property whose buyer_party_ids include the party:
//     created, contract signed, exchanged, finance approved, unconditional,
//     settlement scheduled (one event per settlement_scheduled audit row, so
//     a reschedule shows both; the scheduled date is dueAt) and settled.
//
// Confidentiality (Owner t165u: "Offer prices: listing agent and authorised
// brokerage administrators only"): offer terms (price; conditions are never
// included) are shown only to Brokerage Administrators and to the Agent who is
// the property's listing agent (properties.agent_id). Anyone else (another
// Agent, or Pit Crew should Owner BE-Q3 ever admit it to this route) gets the
// same timeline with offerPriceCents omitted and offerTermsVisible: false. The
// route already returns 403 to Pit Crew and 404 to a non-listing Agent; this
// is the second line.
//
// Grow data (grow_activities) is never read here: growHistoryAvailable is
// always false until BE-Q5 / slice B-3. No email, mobile or address of the
// buyer is returned; commission and trust-fund fields are not exposed.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { auditLogs, db, offers, parties, properties, propertyParties, transactions } from "@aee/db";

export const ENGAGEMENT_EVENT_TYPES = [
  "buyer_linked",
  "offer_received",
  "offer_accepted",
  "offer_declined",
  "offer_withdrawn",
  "offer_auto_declined",
  "transaction_created",
  "contract_signed",
  "contract_exchanged",
  "finance_approved",
  "transaction_unconditional",
  "settlement_scheduled",
  "settlement_completed",
] as const;
export type EngagementEventType = (typeof ENGAGEMENT_EVENT_TYPES)[number];

export interface EngagementEvent {
  type: EngagementEventType;
  at: string; // ISO timestamp the event happened
  source: "property_parties" | "offers" | "audit_logs" | "transactions";
  offerId?: number;
  offerPriceCents?: number;
  offerStatus?: string;
  transactionId?: number;
  transactionStatus?: string;
  dueAt?: string; // settlement_scheduled only: the scheduled settlement date
}

export interface BuyerEngagementTimeline {
  propertyId: number;
  propertyAddress: string;
  partyId: number;
  buyerName: string | null;
  linkedAt: string;
  events: EngagementEvent[];
  growHistoryAvailable: false;
  offerTermsVisible: boolean;
}

/** Roles that see every listing's offer prices and conditions. */
export const OFFER_TERMS_ADMIN_ROLES: readonly string[] = ["Brokerage Administrator"];
export interface OfferTermsViewer {
  role: string;
  userId: number;
}
/** Brokerage Administrators, or the Agent who is this listing's agent. Never Pit Crew. */
export function canSeeOfferTerms(viewer: OfferTermsViewer, listingAgentId: number | null | undefined): boolean {
  if (OFFER_TERMS_ADMIN_ROLES.includes(viewer.role)) return true;
  return viewer.role === "Agent" && listingAgentId != null && listingAgentId === viewer.userId;
}

const OFFER_DECISION_ACTIONS = ["offer_accepted", "offer_declined", "offer_withdrawn", "offer_auto_declined"] as const;

// Same-instant events keep a stable, causal order.
const TYPE_ORDER = new Map<EngagementEventType, number>(ENGAGEMENT_EVENT_TYPES.map((t, i) => [t, i]));

const iso = (d: Date): string => d.toISOString();

/**
 * Returns null when the property is not in the caller's brokerage, or the
 * party is not linked to it as a Buyer within that brokerage. Callers answer
 * 404 for null (the tenant check on the property itself happens in the route
 * so the R-F8 metric is counted exactly once).
 */
export async function getBuyerEngagementTimeline(input: {
  brokerageId: number;
  propertyId: number;
  partyId: number;
  viewer: OfferTermsViewer;
}): Promise<BuyerEngagementTimeline | null> {
  const [link] = await db
    .select({
      linkedAt: propertyParties.createdAt,
      firstName: parties.firstName,
      lastName: parties.lastName,
      organisationName: parties.organisationName,
      propertyAddress: properties.formattedAddress,
      listingAgentId: properties.agentId,
    })
    .from(propertyParties)
    .innerJoin(properties, eq(propertyParties.propertyId, properties.id))
    .innerJoin(parties, and(eq(propertyParties.partyId, parties.id), eq(parties.brokerageId, input.brokerageId)))
    .where(
      and(
        eq(propertyParties.propertyId, input.propertyId),
        eq(propertyParties.partyId, input.partyId),
        eq(propertyParties.role, "Buyer"),
        eq(properties.brokerageId, input.brokerageId),
      ),
    )
    .orderBy(asc(propertyParties.createdAt))
    .limit(1);
  if (!link) return null;
  const offerTermsVisible = canSeeOfferTerms(input.viewer, link.listingAgentId);

  const events: EngagementEvent[] = [{ type: "buyer_linked", at: iso(link.linkedAt), source: "property_parties" }];

  const offerRows = await db
    .select({ id: offers.id, priceCents: offers.offerPriceCents, status: offers.status, createdAt: offers.createdAt })
    .from(offers)
    .where(and(eq(offers.propertyId, input.propertyId), eq(offers.buyerPartyId, input.partyId)));
  for (const o of offerRows) {
    events.push({ type: "offer_received", at: iso(o.createdAt), source: "offers", offerId: o.id, ...(offerTermsVisible ? { offerPriceCents: o.priceCents } : {}), offerStatus: o.status });
  }

  if (offerRows.length > 0) {
    const decisions = await db
      .select({ action: auditLogs.action, recordId: auditLogs.recordId, createdAt: auditLogs.createdAt })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.recordType, "offer"),
          eq(auditLogs.propertyId, input.propertyId),
          inArray(auditLogs.action, [...OFFER_DECISION_ACTIONS]),
          inArray(auditLogs.recordId, offerRows.map((o) => String(o.id))),
        ),
      );
    for (const d of decisions) {
      events.push({ type: d.action as EngagementEventType, at: iso(d.createdAt), source: "audit_logs", offerId: Number(d.recordId) });
    }
  }

  const txRows = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.propertyId, input.propertyId), sql`${transactions.buyerPartyIds} @> ${JSON.stringify([input.partyId])}::jsonb`));
  for (const t of txRows) {
    const base = { source: "transactions" as const, transactionId: t.id, transactionStatus: t.status };
    events.push({ type: "transaction_created", at: iso(t.createdAt), ...base, offerId: t.acceptedOfferId ?? undefined });
    if (t.contractDate) events.push({ type: "contract_signed", at: iso(t.contractDate), ...base });
    if (t.exchangedAt) events.push({ type: "contract_exchanged", at: iso(t.exchangedAt), ...base });
    if (t.financeApprovedAt) events.push({ type: "finance_approved", at: iso(t.financeApprovedAt), ...base });
    if (t.unconditionalAt) events.push({ type: "transaction_unconditional", at: iso(t.unconditionalAt), ...base });
    if (t.settlementCompletedAt) events.push({ type: "settlement_completed", at: iso(t.settlementCompletedAt), ...base });
  }
  if (txRows.length > 0) {
    const byId = new Map(txRows.map((t) => [String(t.id), t]));
    const scheduled = await db
      .select({ recordId: auditLogs.recordId, updatedValue: auditLogs.updatedValue, createdAt: auditLogs.createdAt })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.recordType, "transaction"),
          eq(auditLogs.propertyId, input.propertyId),
          eq(auditLogs.action, "settlement_scheduled"),
          inArray(auditLogs.recordId, [...byId.keys()]),
        ),
      );
    for (const row of scheduled) {
      const t = byId.get(row.recordId)!;
      const due = row.updatedValue && !Number.isNaN(Date.parse(row.updatedValue)) ? new Date(row.updatedValue).toISOString() : undefined;
      events.push({ type: "settlement_scheduled", at: iso(row.createdAt), source: "audit_logs", transactionId: t.id, transactionStatus: t.status, dueAt: due });
    }
  }

  // offer_accepted's audit row is written after the accept transaction
  // commits, so it can trail transaction_created by milliseconds. Status
  // change and transaction are one atomic write (lib/transactions.ts
  // acceptOffer), so the accept is reported at the transaction's created_at.
  const acceptedAt = new Map(txRows.filter((t) => t.acceptedOfferId !== null).map((t) => [t.acceptedOfferId as number, iso(t.createdAt)]));
  for (const e of events) {
    if (e.type === "offer_accepted" && e.offerId !== undefined && acceptedAt.has(e.offerId)) e.at = acceptedAt.get(e.offerId)!;
  }

  events.sort(
    (a, b) =>
      a.at.localeCompare(b.at) ||
      (TYPE_ORDER.get(a.type) ?? 99) - (TYPE_ORDER.get(b.type) ?? 99) ||
      (a.offerId ?? 0) - (b.offerId ?? 0),
  );

  const personName = [link.firstName, link.lastName].filter((p) => p && p.trim()).join(" ");
  return {
    propertyId: input.propertyId,
    propertyAddress: link.propertyAddress,
    partyId: input.partyId,
    buyerName: personName || link.organisationName || null,
    linkedAt: iso(link.linkedAt),
    events,
    growHistoryAvailable: false,
    offerTermsVisible,
  };
}
