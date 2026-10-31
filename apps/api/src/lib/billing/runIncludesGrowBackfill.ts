import { and, eq, inArray } from "drizzle-orm";
import { db, entitlementDefinitions, entitlementGrants, productEntitlements, products, subscriptionItems, subscriptions } from "@aee/db";
import { invalidateEntitlementCache } from "../entitlements/resolver.js";
import { STARTER_PRODUCT_CODE } from "./catalogue.js";

/**
 * RUN-INCLUDES-GROW backfill (Owner decision t220u, 2026-10-31). A Run (Starter) subscription now carries
 * every grow.* key in the catalogue (lib/billing/catalogue.ts). Subscriptions synced BEFORE that change hold
 * only the grants their product had then (run.access). This tops them up through the SAME subscription model
 * applySubscriptionSnapshot uses: each missing grant is inserted as sourceType "subscription" with sourceId =
 * the subscription id, so a later Cancelled/Ended snapshot revokes it exactly like the original grants.
 *
 * Scope: only subscriptions in Trialing/Active (ACTIVE_SUBSCRIPTION_STATUSES in sync.ts) with an Active
 * Starter subscription item. A Trialing subscription whose trialEndsAt has passed is skipped and reported.
 * The migration run.access grant (no subscription) is never touched: unsubscribed brokerages get no Grow.
 * Additive and idempotent: a (subscription, key) pair with ANY existing grant row is left alone, nothing is
 * revoked, updated or deleted. dryRun reports the plan and writes nothing. No schema change.
 */
export interface BackfillRow { brokerageId: number; subscriptionId: number; entitlementKey: string }
export interface BackfillResult {
  dryRun: boolean;
  subscriptionsChecked: number;
  planned: BackfillRow[];
  inserted: BackfillRow[];
  skippedLapsedTrials: { brokerageId: number; subscriptionId: number; trialEndsAt: string }[];
}

export async function backfillRunSubscriptionEntitlements(opts: { dryRun: boolean; now?: Date }): Promise<BackfillResult> {
  const now = opts.now ?? new Date();
  const result: BackfillResult = { dryRun: opts.dryRun, subscriptionsChecked: 0, planned: [], inserted: [], skippedLapsedTrials: [] };
  const [starter] = await db.select({ id: products.id }).from(products).where(eq(products.code, STARTER_PRODUCT_CODE)).limit(1);
  if (!starter) return result;

  const defs = await db
    .select({ key: entitlementDefinitions.key, limitValue: productEntitlements.limitValue })
    .from(productEntitlements)
    .innerJoin(entitlementDefinitions, eq(productEntitlements.entitlementDefinitionId, entitlementDefinitions.id))
    .where(and(eq(productEntitlements.productId, starter.id), eq(productEntitlements.enabled, true)));

  const subs = await db
    .selectDistinct({ id: subscriptions.id, brokerageId: subscriptions.brokerageId, status: subscriptions.status, trialEndsAt: subscriptions.trialEndsAt })
    .from(subscriptions)
    .innerJoin(subscriptionItems, eq(subscriptionItems.subscriptionId, subscriptions.id))
    .where(and(eq(subscriptionItems.productId, starter.id), eq(subscriptionItems.status, "Active"), inArray(subscriptions.status, ["Trialing", "Active"])));

  for (const sub of subs.sort((a, b) => a.id - b.id)) {
    result.subscriptionsChecked += 1;
    if (sub.status === "Trialing" && sub.trialEndsAt && new Date(sub.trialEndsAt) < now) {
      result.skippedLapsedTrials.push({ brokerageId: sub.brokerageId, subscriptionId: sub.id, trialEndsAt: new Date(sub.trialEndsAt).toISOString() });
      continue;
    }
    const existing = await db
      .select({ key: entitlementGrants.entitlementKey })
      .from(entitlementGrants)
      .where(and(eq(entitlementGrants.brokerageId, sub.brokerageId), eq(entitlementGrants.sourceType, "subscription"), eq(entitlementGrants.sourceId, sub.id)));
    const have = new Set(existing.map((e) => e.key));
    let changed = false;
    for (const def of defs) {
      if (have.has(def.key)) continue;
      const row = { brokerageId: sub.brokerageId, subscriptionId: sub.id, entitlementKey: def.key };
      result.planned.push(row);
      if (opts.dryRun) continue;
      await db.insert(entitlementGrants).values({
        brokerageId: sub.brokerageId,
        entitlementKey: def.key,
        granteeType: "brokerage",
        granteeId: sub.brokerageId,
        sourceType: "subscription",
        sourceId: sub.id,
        status: "Active",
        limitValue: def.limitValue,
      });
      result.inserted.push(row);
      changed = true;
    }
    if (changed) invalidateEntitlementCache(sub.brokerageId);
  }
  return result;
}
