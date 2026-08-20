import { eq, and } from "drizzle-orm";
import { db, amlVerifications, parties } from "@aee/db";
import type { AmlVerification } from "@aee/db";
import { publishDomainEvent, newCorrelationId } from "@aee/events";
import { createAMLProvider } from "@aee/integration-aml";

const amlProvider = createAMLProvider();

export interface InitiateAmlResult {
  verification: AmlVerification;
  created: boolean;
}

/**
 * Idempotent AML initiation — this is the one place that ever calls
 * AMLProvider.requestVerification(). One AMLVerification row per
 * (propertyId, partyId): if one already exists in any status, it's
 * returned as-is instead of ordering again. This is what makes "no double
 * AML orders" (a critical, non-optional requirement per the build brief)
 * true regardless of whether this gets called from Ready to List, from a
 * seller added after Ready to List already ran, or from a direct AML
 * request. Retry-after-failure is explicitly Phase 4 ("exceptions") scope,
 * not handled here.
 */
export async function initiateAmlIfNeeded(input: {
  propertyId: number;
  partyId: number;
  verificationType?: string;
  userId: number;
  brokerageId: number;
}): Promise<InitiateAmlResult> {
  const [existing] = await db
    .select()
    .from(amlVerifications)
    .where(and(eq(amlVerifications.propertyId, input.propertyId), eq(amlVerifications.partyId, input.partyId)));
  if (existing) {
    return { verification: existing, created: false };
  }

  const [party] = await db.select().from(parties).where(eq(parties.id, input.partyId));
  if (!party) {
    throw new Error(`Party ${input.partyId} not found`);
  }

  const verificationType = input.verificationType ?? "Individual";

  const { providerReference } = await amlProvider.requestVerification({
    propertyId: input.propertyId,
    partyId: input.partyId,
    verificationType,
    partyDetails: {
      firstName: party.firstName ?? undefined,
      middleName: party.middleName ?? undefined,
      lastName: party.lastName ?? undefined,
      email: party.email ?? undefined,
      mobile: party.mobile ?? undefined,
      residentialAddress: party.residentialAddress ?? undefined,
    },
  });

  const [verification] = await db
    .insert(amlVerifications)
    .values({
      propertyId: input.propertyId,
      partyId: input.partyId,
      provider: process.env.AML_PROVIDER ?? "mock",
      providerReference,
      verificationType,
      status: "Awaiting Seller",
      requestedAt: new Date(),
      createdBy: input.userId,
    })
    .returning();

  try {
    await publishDomainEvent({
      eventType: "AML_REQUESTED",
      occurredAt: new Date(),
      propertyId: input.propertyId,
      transactionId: null,
      partyId: input.partyId,
      brokerageId: input.brokerageId,
      agentId: input.userId,
      actorType: "USER",
      actorId: input.userId,
      source: "api:aml:initiate",
      correlationId: newCorrelationId(),
      causationId: null,
      idempotencyKey: `aml-requested:${verification.id}`,
      payload: { verificationId: verification.id, providerReference },
      metadata: {},
    });
  } catch (err) {
    console.error("publishDomainEvent(AML_REQUESTED) failed", err);
  }

  return { verification, created: true };
}
