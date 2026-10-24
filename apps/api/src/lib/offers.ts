import { randomBytes } from "node:crypto";
import { eq, and, asc, desc, sql, type SQL } from "drizzle-orm";
import { db, offers, parties, propertyParties, properties } from "@aee/db";
import type { Offer } from "@aee/db";
import { publishDomainEvent, currentCorrelationId, logger } from "@aee/events";
import { logAudit } from "./audit.js";
import { visibleRequiredPropertySql } from "./propertyVisibility.js";

/**
 * Offer capture (Build Brief — Phase 7, ARCHITECTURE.md §10). Offers are
 * agent-entered (a buyer submits an offer to the agent by phone/email/in
 * person, as is normal in AU real estate practice — there's no public
 * self-serve submission form here); `shareToken` exists so the agent can
 * hand the buyer a link to check their offer's status without an account
 * (see getOfferByShareToken below), matching the offers.shareToken schema
 * comment ("public buyer-facing link, no sign-in required").
 *
 * A buyer who isn't already a captured Party is created inline from the
 * minimum contact fields — same "enter once" pattern as routes/parties.ts —
 * so `offers.buyerPartyId` is always populated at creation, never deferred.
 */
export async function createOffer(input: {
  propertyId: number;
  offerPriceCents: number;
  conditions?: Record<string, unknown>;
  buyerPartyId?: number;
  buyer?: { firstName?: string; lastName?: string; email?: string; mobile?: string };
  userId: number;
  brokerageId: number;
}): Promise<Offer> {
  const [property] = await db.select().from(properties).where(eq(properties.id, input.propertyId));
  if (!property) {
    throw new Error(`Property ${input.propertyId} not found`);
  }
  // Offers can only be recorded while the property is live and not already
  // under an accepted offer — this build assumes one active Transaction per
  // property at a time (see the comment on refreshTransactionSteps).
  // Capturing backup offers alongside an existing contract is real future
  // scope, not silently allowed here.
  if (property.workflowStage !== "Listed") {
    throw new Error(
      property.workflowStage === "Under Offer" ||
        property.workflowStage === "Contract" ||
        property.workflowStage === "Settlement" ||
        property.workflowStage === "Closed"
        ? "This property already has an accepted offer."
        : "The property must be Listed (go live) before an offer can be recorded.",
    );
  }

  let buyerPartyId = input.buyerPartyId ?? null;

  if (!buyerPartyId) {
    if (!input.buyer || (!input.buyer.firstName && !input.buyer.lastName)) {
      throw new Error("A buyerPartyId or buyer contact details are required to record an offer.");
    }
    const [party] = await db
      .insert(parties)
      .values({
        brokerageId: input.brokerageId,
        partyType: "Person",
        firstName: input.buyer.firstName,
        lastName: input.buyer.lastName,
        email: input.buyer.email,
        mobile: input.buyer.mobile,
      })
      .returning();
    buyerPartyId = party.id;
  }

  // Link the buyer to the property if not already linked (idempotent —
  // matches how a Seller party is only ever linked once per property).
  const [existingLink] = await db
    .select()
    .from(propertyParties)
    .where(
      and(
        eq(propertyParties.propertyId, input.propertyId),
        eq(propertyParties.partyId, buyerPartyId),
        eq(propertyParties.role, "Buyer"),
      ),
    );
  if (!existingLink) {
    await db.insert(propertyParties).values({ propertyId: input.propertyId, partyId: buyerPartyId, role: "Buyer" });
  }

  const [offer] = await db
    .insert(offers)
    .values({
      propertyId: input.propertyId,
      buyerPartyId,
      offerPriceCents: input.offerPriceCents,
      conditions: input.conditions ?? null,
      status: "Received",
      shareToken: randomBytes(16).toString("hex"),
    })
    .returning();

  await logAudit({
    brokerageId: input.brokerageId,
    userId: input.userId,
    action: "offer_received",
    recordType: "offer",
    recordId: String(offer.id),
    propertyId: input.propertyId,
  });

  try {
    await publishDomainEvent({
      eventType: "OFFER_RECEIVED",
      occurredAt: new Date(),
      propertyId: input.propertyId,
      transactionId: null,
      partyId: buyerPartyId,
      brokerageId: input.brokerageId,
      agentId: input.userId,
      actorType: "USER",
      actorId: input.userId,
      source: "api:offers:create",
      correlationId: currentCorrelationId(),
      causationId: null,
      idempotencyKey: `offer-received:${offer.id}`,
      payload: { offerId: offer.id, offerPriceCents: offer.offerPriceCents },
      metadata: {},
    });
  } catch (err) {
    logger.error("publish_domain_event_failed", {
      eventType: "OFFER_RECEIVED",
      propertyId: input.propertyId,
      partyId: buyerPartyId,
      offerId: offer.id,
      error: err,
    });
  }

  return offer;
}

/** Offer withdraw/decline already hold the offer row, not the tenant. One property lookup supplies the brokerage the property row already stores. */
async function brokerageIdForProperty(propertyId: number): Promise<number | undefined> {
  const [property] = await db
    .select({ brokerageId: properties.brokerageId })
    .from(properties)
    .where(eq(properties.id, propertyId));
  return property?.brokerageId;
}

// #34 slice 1 — Offer Centre read. Offers across one brokerage's properties,
// tenant-scoped by properties.brokerage_id in the WHERE clause, so another
// brokerage's rows are never read. Selects an explicit column list: never
// share_token, never buyer email/mobile/address. Read-only.
export const OFFER_CENTRE_STATUSES = ["Received", "Accepted", "Declined", "Withdrawn"] as const;
export type OfferCentreStatus = (typeof OFFER_CENTRE_STATUSES)[number];

export interface OfferCentreRow {
  id: number;
  propertyId: number;
  propertyAddress: string;
  buyerPartyId: number | null;
  buyerName: string | null;
  offerPriceCents: number;
  status: string;
  conditions: unknown;
  createdAt: Date;
}

export async function listOffersForBrokerage(input: {
  brokerageId: number;
  status?: OfferCentreStatus;
  propertyId?: number;
  /** Owner t165u: own-property scope from restrictedPropertyIdsFor. null is
   * brokerage-wide (Brokerage Administrator); an Agent gets only properties
   * they are the listing agent for, so offer prices reach the listing agent
   * and brokerage administrators only. */
  restrictTo: number[] | null;
  limit: number;
  offset: number;
}): Promise<{ offers: OfferCentreRow[]; total: number }> {
  const filters: SQL[] = [eq(properties.brokerageId, input.brokerageId)];
  if (input.status) filters.push(eq(offers.status, input.status));
  if (input.propertyId !== undefined) filters.push(eq(offers.propertyId, input.propertyId));
  const scope = visibleRequiredPropertySql(offers.propertyId, input.restrictTo);
  if (scope) filters.push(scope);
  const where = and(...filters);
  // Received first (still to act on), then Accepted, Declined, Withdrawn;
  // any unexpected status value sorts last.
  const statusRank = sql<number>`case ${offers.status} when 'Received' then 0 when 'Accepted' then 1 when 'Declined' then 2 when 'Withdrawn' then 3 else 4 end`;

  const rows = await db
    .select({
      id: offers.id,
      propertyId: offers.propertyId,
      propertyAddress: properties.formattedAddress,
      buyerPartyId: offers.buyerPartyId,
      buyerFirstName: parties.firstName,
      buyerLastName: parties.lastName,
      buyerOrganisationName: parties.organisationName,
      offerPriceCents: offers.offerPriceCents,
      status: offers.status,
      conditions: offers.conditions,
      createdAt: offers.createdAt,
    })
    .from(offers)
    .innerJoin(properties, eq(offers.propertyId, properties.id))
    // The buyer party must be in the same brokerage, so a mis-linked party
    // id can never surface another tenant's name.
    .leftJoin(parties, and(eq(offers.buyerPartyId, parties.id), eq(parties.brokerageId, input.brokerageId)))
    .where(where)
    .orderBy(asc(statusRank), desc(offers.offerPriceCents), desc(offers.id))
    .limit(input.limit)
    .offset(input.offset);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(offers)
    .innerJoin(properties, eq(offers.propertyId, properties.id))
    .where(where);

  return {
    offers: rows.map((row) => {
      const personName = [row.buyerFirstName, row.buyerLastName].filter((part) => part && part.trim()).join(" ");
      return {
        id: row.id,
        propertyId: row.propertyId,
        propertyAddress: row.propertyAddress,
        buyerPartyId: row.buyerPartyId,
        buyerName: personName || row.buyerOrganisationName || null,
        offerPriceCents: row.offerPriceCents,
        status: row.status,
        conditions: row.conditions,
        createdAt: row.createdAt,
      };
    }),
    total: count,
  };
}

// #34 slice 3 — buyer list (Buyer Engagement start). property_parties rows
// with role "Buyer" across one brokerage. Both joins are brokerage-scoped:
// the property must be the caller's, and so must the party, so a mis-linked
// party from another brokerage is never listed. Names only: no email,
// mobile, residential address, or entity details. Read-only.
export interface BuyerListRow {
  linkId: number;
  partyId: number;
  buyerName: string | null;
  propertyId: number;
  propertyAddress: string;
  linkedAt: Date;
  /** Offers by this buyer party on this linked property (#34 slice 5). */
  offerCount: number;
}

export async function listBuyersForBrokerage(input: {
  brokerageId: number;
  propertyId?: number;
  /** Same own-property scope as listOffersForBrokerage (buyer identity is
   * need-to-know for the listing's agent and brokerage administrators). */
  restrictTo: number[] | null;
  limit: number;
  offset: number;
}): Promise<{ buyers: BuyerListRow[]; total: number }> {
  const filters: SQL[] = [eq(properties.brokerageId, input.brokerageId), eq(propertyParties.role, "Buyer")];
  if (input.propertyId !== undefined) filters.push(eq(propertyParties.propertyId, input.propertyId));
  const scope = visibleRequiredPropertySql(propertyParties.propertyId, input.restrictTo);
  if (scope) filters.push(scope);
  const where = and(...filters);
  const partyJoin = and(eq(propertyParties.partyId, parties.id), eq(parties.brokerageId, input.brokerageId));

  const rows = await db
    .select({
      linkId: propertyParties.id,
      partyId: propertyParties.partyId,
      firstName: parties.firstName,
      lastName: parties.lastName,
      organisationName: parties.organisationName,
      propertyId: propertyParties.propertyId,
      propertyAddress: properties.formattedAddress,
      linkedAt: propertyParties.createdAt,
      // Scoped through the link's own property, which the WHERE clause
      // already restricts to the caller's brokerage.
      offerCount: sql<number>`(select count(*)::int from ${offers} where ${offers.buyerPartyId} = ${propertyParties.partyId} and ${offers.propertyId} = ${propertyParties.propertyId})`,
    })
    .from(propertyParties)
    .innerJoin(properties, eq(propertyParties.propertyId, properties.id))
    .innerJoin(parties, partyJoin)
    .where(where)
    .orderBy(desc(propertyParties.createdAt), desc(propertyParties.id))
    .limit(input.limit)
    .offset(input.offset);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(propertyParties)
    .innerJoin(properties, eq(propertyParties.propertyId, properties.id))
    .innerJoin(parties, partyJoin)
    .where(where);

  return {
    buyers: rows.map((row) => {
      const personName = [row.firstName, row.lastName].filter((part) => part && part.trim()).join(" ");
      return {
        linkId: row.linkId,
        partyId: row.partyId,
        buyerName: personName || row.organisationName || null,
        propertyId: row.propertyId,
        propertyAddress: row.propertyAddress,
        linkedAt: row.linkedAt,
        offerCount: row.offerCount,
      };
    }),
    total: count,
  };
}

export async function listOffersForProperty(propertyId: number): Promise<Offer[]> {
  return db.select().from(offers).where(eq(offers.propertyId, propertyId));
}

/** Buyer withdrew, or the agent is retracting an offer they entered in error. */
export async function withdrawOffer(offerId: number, userId: number): Promise<Offer> {
  const [offer] = await db.select().from(offers).where(eq(offers.id, offerId));
  if (!offer) throw new Error(`Offer ${offerId} not found`);
  if (offer.status !== "Received") {
    throw new Error(`Offer ${offerId} cannot be withdrawn from status ${offer.status}`);
  }
  const [updated] = await db.update(offers).set({ status: "Withdrawn" }).where(eq(offers.id, offerId)).returning();
  await logAudit({
    brokerageId: await brokerageIdForProperty(offer.propertyId),
    userId,
    action: "offer_withdrawn",
    recordType: "offer",
    recordId: String(offerId),
    propertyId: offer.propertyId,
  });
  return updated;
}

/** Seller (via the agent) declined this offer without accepting another. */
export async function declineOffer(offerId: number, userId: number): Promise<Offer> {
  const [offer] = await db.select().from(offers).where(eq(offers.id, offerId));
  if (!offer) throw new Error(`Offer ${offerId} not found`);
  if (offer.status !== "Received") {
    throw new Error(`Offer ${offerId} cannot be declined from status ${offer.status}`);
  }
  const [updated] = await db.update(offers).set({ status: "Declined" }).where(eq(offers.id, offerId)).returning();
  await logAudit({
    brokerageId: await brokerageIdForProperty(offer.propertyId),
    userId,
    action: "offer_declined",
    recordType: "offer",
    recordId: String(offerId),
    propertyId: offer.propertyId,
  });
  return updated;
}

// Public, unauthenticated lookup (offers.shareToken) — deliberately returns
// only the minimum a buyer needs to see their own offer's status, never
// other buyers' offers or internal ids.
export async function getOfferByShareToken(
  shareToken: string,
): Promise<{ status: string; offerPriceCents: number; propertyAddress: string; createdAt: Date } | null> {
  const [offer] = await db.select().from(offers).where(eq(offers.shareToken, shareToken));
  if (!offer) return null;
  const [property] = await db.select().from(properties).where(eq(properties.id, offer.propertyId));
  return {
    status: offer.status,
    offerPriceCents: offer.offerPriceCents,
    propertyAddress: property?.formattedAddress ?? "",
    createdAt: offer.createdAt,
  };
}
