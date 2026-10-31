import { and, eq } from "drizzle-orm";
import {
  db,
  entitlementDefinitions,
  entitlementGrants,
  prices,
  productEntitlements,
  products,
  subscriptionItems,
  subscriptions,
  type EntitlementKey,
} from "@aee/db";
import { currentCorrelationId, publishDomainEvent, logger, type AgentEngineEasyEventType } from "@aee/events";
import type { NormalizedSubscriptionSnapshot } from "@aee/integration-billing";
import { invalidateEntitlementCache } from "../entitlements/resolver.js";

export interface SubscriptionSyncSource {
  actorType: "USER" | "SYSTEM" | "INTEGRATION";
  actorId: number | null;
  label: string; // e.g. "api:billing:checkout" or "api:billing:webhook"
}

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["Trialing", "Active"]);

/**
 * The single code path that turns a normalized billing-provider subscription snapshot into
 * subscription/subscriptionItem rows, entitlement grants, and domain events. Both the mock
 * eager-checkout flow and the real Stripe webhook handler call this SAME function, so
 * subscription -> entitlement resolution logic is never duplicated between the two triggers,
 * and a payment status change produces the same predictable outcome regardless of source
 * (Build Brief acceptance criteria: "predictable grant resolution on payment change").
 */
export async function applySubscriptionSnapshot(
  snapshot: NormalizedSubscriptionSnapshot,
  source: SubscriptionSyncSource,
): Promise<void> {
  const [product] = await db.select().from(products).where(eq(products.code, snapshot.productCode)).limit(1);
  if (!product) {
    logger.warn("apply_subscription_snapshot_unknown_product_code", { productCode: snapshot.productCode, brokerageId: snapshot.brokerageId, subscriptionRef: snapshot.subscriptionRef });
    return;
  }

  const [price] = await db
    .select()
    .from(prices)
    .where(and(eq(prices.productId, product.id), eq(prices.status, "Active")))
    .limit(1);

  const correlationId = currentCorrelationId();
  const shouldBeActive = ACTIVE_SUBSCRIPTION_STATUSES.has(snapshot.status);
  const isTerminal = snapshot.status === "Cancelled" || snapshot.status === "Ended";

  const [existingSubscription] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.billingSubscriptionRef, snapshot.subscriptionRef))
    .limit(1);

  let subscriptionId: number;
  const isNewSubscription = !existingSubscription;
  // t222u: trials expire on their RECORDED end date, independently of provider notifications. A
  // snapshot that reports a trial end stores it; one that omits it keeps the stored value (fail closed).
  // While Trialing, every subscription grant carries endsAt = trialEndsAt and the resolver
  // (grantIsCurrentlyActive) stops honouring it at that instant: no scheduler, no webhook needed.
  const trialEndsAt: Date | null =
    snapshot.trialEnd !== undefined ? snapshot.trialEnd : (existingSubscription?.trialEndsAt ?? null);
  const grantEndsAt: Date | null = snapshot.status === "Trialing" ? trialEndsAt : null;

  if (existingSubscription) {
    subscriptionId = existingSubscription.id;
    await db
      .update(subscriptions)
      .set({
        status: snapshot.status,
        currentPeriodStart: snapshot.currentPeriodStart,
        currentPeriodEnd: snapshot.currentPeriodEnd,
        cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
        cancelledAt: isTerminal ? (existingSubscription.cancelledAt ?? new Date()) : existingSubscription.cancelledAt,
        billingCustomerRef: snapshot.customerRef,
        trialEndsAt,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, subscriptionId));
  } else {
    const [inserted] = await db
      .insert(subscriptions)
      .values({
        brokerageId: snapshot.brokerageId,
        subscriberType: "brokerage",
        subscriberId: snapshot.brokerageId,
        billingCustomerRef: snapshot.customerRef,
        billingSubscriptionRef: snapshot.subscriptionRef,
        status: snapshot.status,
        currentPeriodStart: snapshot.currentPeriodStart,
        currentPeriodEnd: snapshot.currentPeriodEnd,
        cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
        trialEndsAt,
      })
      .returning();
    subscriptionId = inserted.id;
  }

  await safePublish(
    {
      eventType: isNewSubscription ? "SUBSCRIPTION_CREATED" : "SUBSCRIPTION_UPDATED",
      brokerageId: snapshot.brokerageId,
      idempotencyKey: `subscription:${snapshot.subscriptionRef}:${snapshot.status}:${(snapshot.currentPeriodEnd ?? new Date(0)).getTime()}`,
      payload: { subscriptionId, productCode: snapshot.productCode, status: snapshot.status, cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd },
    },
    source,
    correlationId,
  );

  if (!isNewSubscription && isTerminal) {
    await safePublish(
      {
        eventType: "SUBSCRIPTION_CANCELLED",
        brokerageId: snapshot.brokerageId,
        idempotencyKey: `subscription-cancelled:${snapshot.subscriptionRef}`,
        payload: { subscriptionId, productCode: snapshot.productCode },
      },
      source,
      correlationId,
    );
  }

  if (!price) {
    // subscriptionItems.priceId is NOT NULL - without a seeded Active price for this product we
    // cannot safely write a line item, so we record the subscription (above, for audit/billing
    // history) but deliberately skip item + entitlement sync rather than insert broken data.
    logger.warn("apply_subscription_snapshot_no_active_price", { productCode: snapshot.productCode, subscriptionId, brokerageId: snapshot.brokerageId });
    await invalidateEntitlementCache(snapshot.brokerageId);
    return;
  }

  const [existingItem] = await db
    .select()
    .from(subscriptionItems)
    .where(and(eq(subscriptionItems.subscriptionId, subscriptionId), eq(subscriptionItems.productId, product.id)))
    .limit(1);

  if (existingItem) {
    await db
      .update(subscriptionItems)
      .set({ status: shouldBeActive ? "Active" : "Cancelled", priceId: price.id })
      .where(eq(subscriptionItems.id, existingItem.id));
  } else {
    await db.insert(subscriptionItems).values({
      subscriptionId,
      productId: product.id,
      priceId: price.id,
      quantity: 1,
      status: shouldBeActive ? "Active" : "Cancelled",
    });
  }

  const grantedDefinitions = await db
    .select({
      entitlementKey: entitlementDefinitions.key,
      limitValue: productEntitlements.limitValue,
    })
    .from(productEntitlements)
    .innerJoin(entitlementDefinitions, eq(productEntitlements.entitlementDefinitionId, entitlementDefinitions.id))
    .where(and(eq(productEntitlements.productId, product.id), eq(productEntitlements.enabled, true)));

  for (const def of grantedDefinitions) {
    const entitlementKey = def.entitlementKey as EntitlementKey;
    const [existingGrant] = await db
      .select()
      .from(entitlementGrants)
      .where(
        and(
          eq(entitlementGrants.brokerageId, snapshot.brokerageId),
          eq(entitlementGrants.entitlementKey, entitlementKey),
          eq(entitlementGrants.sourceType, "subscription"),
          eq(entitlementGrants.sourceId, subscriptionId),
        ),
      )
      .limit(1);

    if (shouldBeActive) {
      const endsAtChanged = !!existingGrant && (existingGrant.endsAt?.getTime() ?? null) !== (grantEndsAt?.getTime() ?? null);
      if (existingGrant && existingGrant.status === "Active" && endsAtChanged) {
        // Trial end moved, or the trial converted to Active (end cleared). Not a new grant: no event.
        await db
          .update(entitlementGrants)
          .set({ endsAt: grantEndsAt, updatedAt: new Date() })
          .where(eq(entitlementGrants.id, existingGrant.id));
      } else if (!existingGrant || existingGrant.status !== "Active") {
        if (existingGrant) {
          await db
            .update(entitlementGrants)
            .set({ status: "Active", startsAt: new Date(), endsAt: grantEndsAt, limitValue: def.limitValue, updatedAt: new Date() })
            .where(eq(entitlementGrants.id, existingGrant.id));
        } else {
          await db.insert(entitlementGrants).values({
            brokerageId: snapshot.brokerageId,
            entitlementKey,
            granteeType: "brokerage",
            granteeId: snapshot.brokerageId,
            sourceType: "subscription",
            sourceId: subscriptionId,
            status: "Active",
            endsAt: grantEndsAt,
            limitValue: def.limitValue,
          });
        }
        await safePublish(
          {
            eventType: "ENTITLEMENT_GRANTED",
            brokerageId: snapshot.brokerageId,
            idempotencyKey: `entitlement-granted:${entitlementKey}:subscription:${subscriptionId}:${snapshot.status}`,
            payload: { entitlementKey, subscriptionId },
          },
          source,
          correlationId,
        );
        if (entitlementKey === "grow.access") {
          await safePublish(
            {
              eventType: "GROW_ACCESS_ACTIVATED",
              brokerageId: snapshot.brokerageId,
              idempotencyKey: `grow-access-activated:subscription:${subscriptionId}:${snapshot.status}`,
              payload: { subscriptionId },
            },
            source,
            correlationId,
          );
        }
      }
    } else if (existingGrant && existingGrant.status === "Active") {
      await db
        .update(entitlementGrants)
        .set({ status: "Revoked", endsAt: new Date(), updatedAt: new Date() })
        .where(eq(entitlementGrants.id, existingGrant.id));
      await safePublish(
        {
          eventType: "ENTITLEMENT_REVOKED",
          brokerageId: snapshot.brokerageId,
          idempotencyKey: `entitlement-revoked:${entitlementKey}:subscription:${subscriptionId}:${snapshot.status}`,
          payload: { entitlementKey, subscriptionId },
        },
        source,
        correlationId,
      );
      if (entitlementKey === "grow.access") {
        await safePublish(
          {
            eventType: "GROW_ACCESS_SUSPENDED",
            brokerageId: snapshot.brokerageId,
            idempotencyKey: `grow-access-suspended:subscription:${subscriptionId}:${snapshot.status}`,
            payload: { subscriptionId },
          },
          source,
          correlationId,
        );
      }
    }
  }

  await invalidateEntitlementCache(snapshot.brokerageId);
}

async function safePublish(
  event: {
    eventType: AgentEngineEasyEventType;
    brokerageId: number;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  },
  source: SubscriptionSyncSource,
  correlationId: string,
): Promise<void> {
  try {
    await publishDomainEvent({
      eventType: event.eventType,
      occurredAt: new Date(),
      propertyId: null,
      transactionId: null,
      partyId: null,
      brokerageId: event.brokerageId,
      agentId: source.actorId,
      actorType: source.actorType,
      actorId: source.actorId,
      source: source.label,
      correlationId,
      causationId: null,
      idempotencyKey: event.idempotencyKey,
      payload: event.payload,
      metadata: {},
    });
  } catch (err) {
    logger.error("publish_domain_event_failed", { eventType: event.eventType, brokerageId: event.brokerageId, error: err });
  }
}
