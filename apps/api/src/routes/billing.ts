import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  billingWebhookEvents,
  db,
  prices,
  products,
  subscriptionItems,
  subscriptions,
} from "@aee/db";
import { MockBillingProvider } from "@aee/integration-billing";
import { BROKERAGE_ADMIN_ROLES, requireAuth, requireRole } from "../middlewares/auth.js";
import { logAudit } from "../lib/audit.js";
import { getBillingProvider } from "../lib/billing/gateway.js";
import { applySubscriptionSnapshot } from "../lib/billing/sync.js";
import { resolveEntitlements } from "../lib/entitlements/resolver.js";

export const billingRouter = Router();

// Discovery: the seeded product/price catalogue for the Grow upgrade UI. No pricing here is
// hard-coded in permission logic - this route only reads the seeded `products`/`prices` rows.
billingRouter.get("/catalogue", requireAuth, async (_req, res) => {
  const rows = await db
    .select({
      productId: products.id,
      code: products.code,
      name: products.name,
      description: products.description,
      priceId: prices.id,
      amountCents: prices.amountCents,
      currency: prices.currency,
      billingInterval: prices.billingInterval,
    })
    .from(products)
    .leftJoin(prices, and(eq(prices.productId, products.id), eq(prices.status, "Active")))
    .where(eq(products.status, "Active"));
  res.json({ products: rows });
});

// Current brokerage's subscription + resolved entitlement keys - drives the billing admin
// screen and the Grow shell's locked-nav rendering. UX convenience only: every protected Grow
// route still re-checks server-side via requireEntitlement regardless of what this returns.
billingRouter.get("/subscription", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const [subscription] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.brokerageId, user.brokerageId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  const entitlements = await resolveEntitlements(user);
  res.json({ subscription: subscription ?? null, entitlements: Array.from(entitlements) });
});

// Checkout: Brokerage Administrators only start or change billing for their brokerage.
billingRouter.post("/checkout", requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const user = req.authedUser!;
  const productCode = typeof req.body?.productCode === "string" ? req.body.productCode : "grow";
  const [product] = await db.select().from(products).where(eq(products.code, productCode)).limit(1);
  if (!product) {
    res.status(404).json({ error: "Unknown product" });
    return;
  }

  const provider = getBillingProvider();
  const session = await provider.createCheckoutSession({
    brokerageId: user.brokerageId,
    productCode,
    customerEmail: typeof req.body?.customerEmail === "string" ? req.body.customerEmail : "",
    successUrl: typeof req.body?.successUrl === "string" ? req.body.successUrl : "/grow?checkout=success",
    cancelUrl: typeof req.body?.cancelUrl === "string" ? req.body.cancelUrl : "/grow?checkout=cancelled",
  });

  // The Mock provider activates its subscription synchronously (no redirect/webhook round trip
  // to simulate) - apply it through the SAME sync path a real Stripe webhook uses, so mock and
  // live billing can never diverge in behavior.
  if (provider.name === "mock") {
    const snapshot = (provider as MockBillingProvider).getEagerSubscription(session.sessionRef);
    if (snapshot) {
      await applySubscriptionSnapshot(snapshot, {
        actorType: "USER",
        actorId: user.id,
        label: "api:billing:checkout:mock",
      });
    }
  }

  await logAudit({
    userId: user.id,
    action: "billing_checkout_started",
    recordType: "subscription",
    recordId: session.sessionRef,
    providerReference: session.sessionRef,
  });

  res.json(session);
});

// Cancel: Brokerage Administrators only. Default is at-period-end (grace period - the
// subscription stays Active/usable and entitlements are untouched here; the eventual expiry
// runs through the same applySubscriptionSnapshot path via a future webhook or sync pass).
// Immediate cancellation (atPeriodEnd: false) revokes entitlements now, but NEVER deletes any
// Grow data - applySubscriptionSnapshot only flips entitlement grant status to Revoked.
billingRouter.post("/cancel", requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const user = req.authedUser!;
  const [subscription] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.brokerageId, user.brokerageId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  if (!subscription) {
    res.status(404).json({ error: "No subscription to cancel" });
    return;
  }
  const subscriptionRef = subscription.billingSubscriptionRef;
  if (!subscriptionRef) {
    res.status(500).json({ error: "Subscription is missing its billing provider reference" });
    return;
  }

  const atPeriodEnd = req.body?.atPeriodEnd !== false;
  const provider = getBillingProvider();
  await provider.cancelSubscription(subscriptionRef, { atPeriodEnd });

  if (atPeriodEnd) {
    await db
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: true, updatedAt: new Date() })
      .where(eq(subscriptions.id, subscription.id));
  } else {
    const [item] = await db
      .select({ productCode: products.code })
      .from(subscriptionItems)
      .innerJoin(products, eq(subscriptionItems.productId, products.id))
      .where(eq(subscriptionItems.subscriptionId, subscription.id))
      .limit(1);
    await applySubscriptionSnapshot(
      {
        subscriptionRef,
        customerRef: subscription.billingCustomerRef ?? "",
        status: "Cancelled",
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: false,
        productCode: item?.productCode ?? "",
        brokerageId: subscription.brokerageId,
      },
      { actorType: "USER", actorId: user.id, label: "api:billing:cancel:immediate" },
    );
  }

  await logAudit({
    userId: user.id,
    action: "billing_cancel_requested",
    recordType: "subscription",
    recordId: String(subscription.id),
  });

  res.json({ ok: true, atPeriodEnd });
});

// Inbound provider webhook - unauthenticated by design, authenticity comes entirely from
// verifyWebhookSignature() against req.rawBody (the exact bytes, captured in app.ts). Idempotent
// on (provider, providerEventId) and tolerant of repeated/out-of-order delivery, matching the
// existing AML/payments webhook pattern in this codebase.
billingRouter.post("/webhook", async (req, res) => {
  const provider = getBillingProvider();
  const signature = req.header("stripe-signature") ?? req.header("x-webhook-signature") ?? undefined;
  const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));

  if (!provider.verifyWebhookSignature(rawBody, signature)) {
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }

  const event = provider.parseWebhook(rawBody);

  const [existing] = await db
    .select()
    .from(billingWebhookEvents)
    .where(
      and(eq(billingWebhookEvents.provider, provider.name), eq(billingWebhookEvents.providerEventId, event.providerEventId)),
    )
    .limit(1);

  if (existing && existing.status === "Processed") {
    res.status(200).json({ received: true, processed: false, reason: "already_processed" });
    return;
  }

  const [row] = existing
    ? await db
        .update(billingWebhookEvents)
        .set({ eventType: event.eventType, payload: req.body ?? {} })
        .where(eq(billingWebhookEvents.id, existing.id))
        .returning()
    : await db
        .insert(billingWebhookEvents)
        .values({
          provider: provider.name,
          providerEventId: event.providerEventId,
          eventType: event.eventType,
          payload: req.body ?? {},
        })
        .returning();

  try {
    if (event.subscription) {
      await applySubscriptionSnapshot(event.subscription, {
        actorType: "SYSTEM",
        actorId: null,
        label: `api:billing:webhook:${provider.name}`,
      });
    }
    await db
      .update(billingWebhookEvents)
      .set({ status: "Processed", processedAt: new Date() })
      .where(eq(billingWebhookEvents.id, row.id));
    res.status(200).json({ received: true, processed: true });
  } catch (err) {
    console.error("billing webhook processing failed", err);
    await db
      .update(billingWebhookEvents)
      .set({ status: "Failed", error: String(err) })
      .where(eq(billingWebhookEvents.id, row.id));
    // Still 200 - we don't want the provider hammering retries into a failure loop. The row is
    // marked Failed for operator follow-up instead.
    res.status(200).json({ received: true, processed: false, reason: "processing_error" });
  }
});
