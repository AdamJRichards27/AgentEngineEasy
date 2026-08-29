import { eq, and } from "drizzle-orm";
import { db, amlVerifications, parties, properties, serviceOrders, AML_STATUSES } from "@aee/db";
import type { AmlVerification } from "@aee/db";
import { publishDomainEvent, newCorrelationId } from "@aee/events";
import { createAMLProvider, type AMLWebhookResult } from "@aee/integration-aml";
import { refreshReadyToListSteps } from "./workflowSteps.js";

const amlProvider = createAMLProvider();

// Placeholder pricing pending a real vendor contract — Phase 6 ("Payments")
// is what actually charges a stored payment method for this ServiceOrder;
// Phase 4 only records what the check costs and what it's billed at, so the
// audit trail and workspace UI have something real to show ahead of that.
const AML_WHOLESALE_COST_CENTS = Number(process.env.AML_WHOLESALE_COST_CENTS ?? 1500);
const AML_CUSTOMER_PRICE_CENTS = Number(process.env.AML_CUSTOMER_PRICE_CENTS ?? 2500);

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
 * request. Retry-after-failure is a deliberately separate path — see
 * retryAmlVerification() below — so this function's idempotency guarantee
 * never gets confused with "start over".
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

  const providerName = process.env.AML_PROVIDER ?? "mock";

  // Billing container (Section 11 / Phase 4) — one ServiceOrder per AML
  // verification, created alongside it so cost/price are recorded from the
  // moment the check is ordered, not bolted on later.
  const [serviceOrder] = await db
    .insert(serviceOrders)
    .values({
      propertyId: input.propertyId,
      partyId: input.partyId,
      serviceType: "AmlVerification",
      provider: providerName,
      providerReference,
      wholesaleCostCents: AML_WHOLESALE_COST_CENTS,
      customerPriceCents: AML_CUSTOMER_PRICE_CENTS,
      gstCents: Math.round(AML_CUSTOMER_PRICE_CENTS / 11), // AU GST-inclusive placeholder — real invoicing rules land with Phase 6
      paymentStatus: "Pending", // no charge attempt yet — Phase 6 wires up actual charging
      status: "Ordered",
    })
    .returning();

  const [verification] = await db
    .insert(amlVerifications)
    .values({
      propertyId: input.propertyId,
      partyId: input.partyId,
      provider: providerName,
      providerReference,
      verificationType,
      status: "Awaiting Seller",
      serviceOrderId: serviceOrder.id,
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
      payload: { verificationId: verification.id, providerReference, serviceOrderId: serviceOrder.id },
      metadata: {},
    });
  } catch (err) {
    console.error("publishDomainEvent(AML_REQUESTED) failed", err);
  }

  return { verification, created: true };
}

function mapOutcomeToStatus(result: AMLWebhookResult): (typeof AML_STATUSES)[number] {
  if (result.reviewRequired) return "Review Required";
  if (result.outcome === "VERIFIED") return "Complete";
  if (result.outcome === "PARTIALLY_VERIFIED") return "Review Required";
  return "Failed";
}

function serviceOrderStatusFor(status: (typeof AML_STATUSES)[number]): "InProgress" | "Completed" | "Failed" {
  if (status === "Complete") return "Completed";
  if (status === "Failed") return "Failed";
  return "InProgress";
}

export interface ProcessAmlWebhookResult {
  processed: boolean;
  reason?: "invalid_signature" | "verification_not_found" | "duplicate_delivery";
  verification?: AmlVerification;
}

/**
 * AML webhook processing (Phase 4). `rawBody` must be the exact bytes the
 * provider signed (a Buffer, ideally) — verifying against a re-serialised
 * copy of the parsed JSON is a common source of false signature-mismatch
 * failures, since key order/whitespace can differ from the original.
 *
 * Idempotency here isn't "ignore every webhook after the first" — a
 * provider can legitimately re-fire with a *changed* outcome (e.g. a
 * Review Required case gets cleared on the provider's side days later).
 * Only an exact repeat of the currently-stored outcome is treated as a
 * duplicate delivery and skipped.
 */
export async function processAmlWebhook(
  rawBody: Buffer | string,
  signature: string,
  payload: unknown,
): Promise<ProcessAmlWebhookResult> {
  if (!amlProvider.verifyWebhookSignature(rawBody, signature)) {
    return { processed: false, reason: "invalid_signature" };
  }

  const result = amlProvider.parseWebhook(payload);

  const [verification] = await db
    .select()
    .from(amlVerifications)
    .where(eq(amlVerifications.providerReference, result.providerReference));
  if (!verification) {
    return { processed: false, reason: "verification_not_found" };
  }

  const newStatus = mapOutcomeToStatus(result);
  const isRepeatOfCurrentOutcome =
    verification.status === newStatus &&
    verification.outcome === result.outcome &&
    verification.reviewRequired === result.reviewRequired;
  if (isRepeatOfCurrentOutcome && verification.completedAt) {
    return { processed: false, reason: "duplicate_delivery", verification };
  }

  const [updated] = await db
    .update(amlVerifications)
    .set({
      status: newStatus,
      outcome: result.outcome,
      riskLevel: result.riskLevel ?? null,
      reviewRequired: result.reviewRequired,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(amlVerifications.id, verification.id))
    .returning();

  if (updated.serviceOrderId) {
    await db
      .update(serviceOrders)
      .set({
        status: serviceOrderStatusFor(newStatus),
        completedAt: newStatus === "Complete" || newStatus === "Failed" ? new Date() : null,
      })
      .where(eq(serviceOrders.id, updated.serviceOrderId));
  }

  const [property] = await db.select().from(properties).where(eq(properties.id, updated.propertyId));

  try {
    await publishDomainEvent({
      eventType: "AML_COMPLETED",
      occurredAt: new Date(),
      propertyId: updated.propertyId,
      transactionId: null,
      partyId: updated.partyId,
      brokerageId: property?.brokerageId ?? null,
      agentId: property?.agentId ?? null,
      actorType: "INTEGRATION",
      actorId: null,
      source: `webhook:aml:${updated.provider}`,
      correlationId: newCorrelationId(),
      causationId: null,
      idempotencyKey: `aml-completed:${updated.id}:${newStatus}`,
      payload: { verificationId: updated.id, outcome: result.outcome, riskLevel: result.riskLevel ?? null, reviewRequired: result.reviewRequired },
      metadata: {},
    });
  } catch (err) {
    console.error("publishDomainEvent(AML_COMPLETED) failed", err);
  }

  await refreshReadyToListSteps(updated.propertyId).catch((err) =>
    console.error("refreshReadyToListSteps failed", err),
  );

  return { processed: true, verification: updated };
}

/**
 * Retry a Failed (or still-unresolved Review Required) verification —
 * distinct from initiateAmlIfNeeded's idempotent "don't order twice"
 * guarantee: this is an explicit agent action to re-run the same check,
 * reusing the same AmlVerification row (and ServiceOrder) rather than
 * creating a second one, so (propertyId, partyId) still maps to exactly
 * one verification row.
 */
export async function retryAmlVerification(verificationId: number): Promise<AmlVerification> {
  const [verification] = await db.select().from(amlVerifications).where(eq(amlVerifications.id, verificationId));
  if (!verification) {
    throw new Error(`AmlVerification ${verificationId} not found`);
  }
  if (verification.status !== "Failed" && verification.status !== "Review Required") {
    throw new Error(`AmlVerification ${verificationId} is not in a retryable state (status: ${verification.status})`);
  }

  const [party] = await db.select().from(parties).where(eq(parties.id, verification.partyId));
  if (!party) {
    throw new Error(`Party ${verification.partyId} not found`);
  }

  const { providerReference } = await amlProvider.requestVerification({
    propertyId: verification.propertyId,
    partyId: verification.partyId,
    verificationType: verification.verificationType,
    partyDetails: {
      firstName: party.firstName ?? undefined,
      middleName: party.middleName ?? undefined,
      lastName: party.lastName ?? undefined,
      email: party.email ?? undefined,
      mobile: party.mobile ?? undefined,
      residentialAddress: party.residentialAddress ?? undefined,
    },
  });

  const [updated] = await db
    .update(amlVerifications)
    .set({
      providerReference,
      status: "Awaiting Seller",
      outcome: null,
      riskLevel: null,
      reviewRequired: false,
      completedAt: null,
      requestedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(amlVerifications.id, verificationId))
    .returning();

  if (updated.serviceOrderId) {
    await db
      .update(serviceOrders)
      .set({ status: "InProgress", completedAt: null, providerReference })
      .where(eq(serviceOrders.id, updated.serviceOrderId));
  }

  await refreshReadyToListSteps(updated.propertyId).catch((err) =>
    console.error("refreshReadyToListSteps failed", err),
  );

  return updated;
}

/**
 * Records a human compliance decision against a Review Required or Failed
 * verification (Phase 4 "exceptions"). This is NOT the system reinterpreting
 * a failed identity check as verified — it's an audit trail for a decision
 * made by a Brokerage Administrator alongside the system (e.g. after
 * reviewing evidence directly with the AML provider), mirroring the
 * ownership review-not-block pattern already used elsewhere. Mandatory,
 * non-empty notes are enforced at the route layer so this can never be a
 * silent one-click bypass.
 */
export async function resolveAmlException(input: {
  verificationId: number;
  userId: number;
  notes: string;
}): Promise<AmlVerification> {
  const [verification] = await db.select().from(amlVerifications).where(eq(amlVerifications.id, input.verificationId));
  if (!verification) {
    throw new Error(`AmlVerification ${input.verificationId} not found`);
  }
  if (verification.status !== "Failed" && verification.status !== "Review Required") {
    throw new Error(`AmlVerification ${input.verificationId} has no exception to resolve (status: ${verification.status})`);
  }

  const [updated] = await db
    .update(amlVerifications)
    .set({
      status: "Complete",
      reviewRequired: false,
      exceptionResolvedBy: input.userId,
      exceptionResolvedAt: new Date(),
      exceptionNotes: input.notes,
      updatedAt: new Date(),
    })
    .where(eq(amlVerifications.id, input.verificationId))
    .returning();

  await refreshReadyToListSteps(updated.propertyId).catch((err) =>
    console.error("refreshReadyToListSteps failed", err),
  );

  return updated;
}
