import { randomBytes } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db, offers, parties, propertyParties, properties } from "@aee/db";
import type { Offer } from "@aee/db";
import { publishDomainEvent, currentCorrelationId, logger } from "@aee/events";
import { logAudit } from "./audit.js";

/**
 * CC #34 / Owner direction t113u D8: an offer leaves `Received` exactly once.
 * Accept, decline and withdraw are conditional on the row still being
 * Received; the request that finds it already moved on gets this error,
 * which routes/offers.ts answers as 409 { code: "OFFER_STATUS_CONFLICT" }.
 */
export class OfferStatusConflictError extends Error {
  readonly code = "OFFER_STATUS_CONFLICT" as const;
  constructor(
    readonly offerId: number,
    readonly action: "accept" | "decline" | "withdraw",
    readonly currentStatus: string,
  ) {
    super(
      `Offer ${offerId} can no longer be ${action === "accept" ? "accepted" : action === "decline" ? "declined" : "withdrawn"}: it is already ${currentStatus}.`,
    );
    this.name = "OfferStatusConflictError";
  }
}

/** Moves an offer out of Received only if it is still Received (no lost update). */
async function transitionFromReceived(
  offerId: number,
  to: "Declined" | "Withdrawn",
  action: "decline" | "withdraw",
): Promise<Offer> {
  const [updated] = await db
    .update(offers)
    .set({ status: to })
    .where(and(eq(offers.id, offerId), eq(offers.status, "Received")))
    .returning();
  if (updated) return updated;
  const [current] = await db.select({ status: offers.status }).from(offers).where(eq(offers.id, offerId));
  if (!current) throw new Error(`Offer ${offerId} not found`);
  throw new OfferStatusConflictError(offerId, action, current.status);
}

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

export async function listOffersForProperty(propertyId: number): Promise<Offer[]> {
  return db.select().from(offers).where(eq(offers.propertyId, propertyId));
}

/** Buyer withdrew, or the agent is retracting an offer they entered in error. */
export async function withdrawOffer(offerId: number, userId: number): Promise<Offer> {
  const updated = await transitionFromReceived(offerId, "Withdrawn", "withdraw");
  const offer = updated;
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
  const updated = await transitionFromReceived(offerId, "Declined", "decline");
  const offer = updated;
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

/**
 * CC #34 / decisions pack BE-Q1 (Owner direction t113u D8: revocable, audited
 * buyer links, no silent replacement). `shareToken` is the unauthenticated
 * buyer status link. Authenticated offer reads and offer-mutation responses
 * return this view instead of the raw row, so other users in the brokerage
 * can no longer collect every buyer's link. The token itself is unchanged
 * (no rotation, links already sent keep working); POST create still returns
 * it once to the user who recorded the offer. Explicit issue/revoke routes
 * need the offer_share_links migration and wait for Owner approval.
 */
export type OfferView = Omit<Offer, "shareToken">;

export function toOfferView(offer: Offer): OfferView {
  const { shareToken: _shareToken, ...view } = offer;
  return view;
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
