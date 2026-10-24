import { randomBytes } from "node:crypto";
import { eq, and, isNull, desc } from "drizzle-orm";
import { db, offers, offerShareLinks, parties, propertyParties, properties } from "@aee/db";
import type { Offer } from "@aee/db";
import { publishDomainEvent, currentCorrelationId, logger } from "@aee/events";
import { logAudit } from "./audit.js";

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
  // M3: the creation token is also the offer's first share link (no expiry,
  // same as before M3). offers.share_token keeps the original value.
  await db.insert(offerShareLinks).values({ offerId: offer.id, token: offer.shareToken!, issuedByUserId: input.userId });

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
  const offer = await resolveShareToken(shareToken);
  if (!offer) return null;
  const [property] = await db.select().from(properties).where(eq(properties.id, offer.propertyId));
  return {
    status: offer.status,
    offerPriceCents: offer.offerPriceCents,
    propertyAddress: property?.formattedAddress ?? "",
    createdAt: offer.createdAt,
  };
}

// ---------------------------------------------------------------------------
// M3 revocable offer links (Owner t165u; migration 0037 offer_share_links).
// ---------------------------------------------------------------------------

/**
 * A public token is live when its offer_share_links row is neither revoked nor
 * expired. Legacy fallback: a token found only in offers.share_token is live
 * when that offer has no link rows at all (e.g. written by pre-M3 code during
 * a rollout window). Revoked, expired and unknown tokens all answer null, so
 * the public route returns the same 404 for each (no oracle).
 */
async function resolveShareToken(token: string, now: Date = new Date()): Promise<Offer | null> {
  const [link] = await db.select().from(offerShareLinks).where(eq(offerShareLinks.token, token));
  if (link) {
    if (link.revokedAt) return null;
    if (link.expiresAt && link.expiresAt.getTime() <= now.getTime()) return null;
    const [offer] = await db.select().from(offers).where(eq(offers.id, link.offerId));
    return offer ?? null;
  }
  const [offer] = await db.select().from(offers).where(eq(offers.shareToken, token));
  if (!offer) return null;
  const [anyLink] = await db.select({ id: offerShareLinks.id }).from(offerShareLinks).where(eq(offerShareLinks.offerId, offer.id)).limit(1);
  return anyLink ? null : offer;
}

export interface ShareLinkStatus {
  offerId: number;
  active: boolean;
  activeIssuedAt: Date | null;
  activeExpiresAt: Date | null;
  lastRevokedAt: Date | null;
  linksIssued: number;
}

/** Status only; never returns a token. */
export async function getShareLinkStatus(offerId: number, now: Date = new Date()): Promise<ShareLinkStatus> {
  const rows = await db.select().from(offerShareLinks).where(eq(offerShareLinks.offerId, offerId)).orderBy(desc(offerShareLinks.issuedAt), desc(offerShareLinks.id));
  const live = rows.find((r) => !r.revokedAt && (!r.expiresAt || r.expiresAt.getTime() > now.getTime())) ?? null;
  const revoked = rows.filter((r) => r.revokedAt).map((r) => r.revokedAt!.getTime());
  return {
    offerId,
    active: live !== null,
    activeIssuedAt: live?.issuedAt ?? null,
    activeExpiresAt: live?.expiresAt ?? null,
    lastRevokedAt: revoked.length ? new Date(Math.max(...revoked)) : null,
    linksIssued: rows.length,
  };
}

async function revokeActiveLinks(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  offerId: number,
  userId: number,
  reason: "revoked" | "reissued",
): Promise<number> {
  const revoked = await tx
    .update(offerShareLinks)
    .set({ revokedAt: new Date(), revokedByUserId: userId, revokeReason: reason })
    .where(and(eq(offerShareLinks.offerId, offerId), isNull(offerShareLinks.revokedAt)))
    .returning({ id: offerShareLinks.id });
  return revoked.length;
}

/** Revokes every unrevoked link of the offer. Idempotent (0 when none). Audited. */
export async function revokeOfferShareLinks(input: { offerId: number; userId: number; brokerageId: number; propertyId: number }): Promise<{ revoked: number }> {
  const revoked = await db.transaction((tx) => revokeActiveLinks(tx, input.offerId, input.userId, "revoked"));
  await logAudit({
    brokerageId: input.brokerageId,
    userId: input.userId,
    action: "offer_share_link_revoked",
    recordType: "offer",
    recordId: String(input.offerId),
    propertyId: input.propertyId,
    updatedValue: JSON.stringify({ revoked }),
  });
  return { revoked };
}

export const SHARE_LINK_MAX_EXPIRY_DAYS = 90;

/**
 * Revokes the current link(s) (reason "reissued", rows kept) and issues a new
 * token, returned once to the caller. expiresInDays is optional: no expiry
 * unless asked for (the default expiry is an open Owner detail, BE-Q1).
 * The token value is never written to the audit log.
 */
export async function reissueOfferShareLink(input: {
  offerId: number;
  userId: number;
  brokerageId: number;
  propertyId: number;
  expiresInDays?: number;
}): Promise<{ shareToken: string; issuedAt: Date; expiresAt: Date | null; revokedPrevious: number }> {
  const token = randomBytes(16).toString("hex");
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
  const result = await db.transaction(async (tx) => {
    const revokedPrevious = await revokeActiveLinks(tx, input.offerId, input.userId, "reissued");
    const [row] = await tx.insert(offerShareLinks).values({ offerId: input.offerId, token, issuedByUserId: input.userId, expiresAt }).returning();
    return { revokedPrevious, row };
  });
  await logAudit({
    brokerageId: input.brokerageId,
    userId: input.userId,
    action: "offer_share_link_reissued",
    recordType: "offer",
    recordId: String(input.offerId),
    propertyId: input.propertyId,
    updatedValue: JSON.stringify({ revokedPrevious: result.revokedPrevious, expiresAt: expiresAt?.toISOString() ?? null }),
  });
  return { shareToken: token, issuedAt: result.row.issuedAt, expiresAt, revokedPrevious: result.revokedPrevious };
}
