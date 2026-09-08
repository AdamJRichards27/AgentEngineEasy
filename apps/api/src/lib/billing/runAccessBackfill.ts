import { db, brokerages, entitlementGrants } from "@aee/db";
import { and, eq } from "drizzle-orm";
import { invalidateEntitlementCache } from "../entitlements/resolver.js";

/**
 * AE GROW Priority 0.5 — Workstream 3: non-destructive backfill for the "run.access"
 * entitlement (packages/db/src/schema/billing.ts's ENTITLEMENT_KEYS). Before this phase, every
 * brokerage could use the RUN surface (Pit Crew, Financial) freely - there was no entitlement
 * gate on it at all. Introducing requireEntitlement("run.access") on those routes (see
 * routes/pitCrew.ts, routes/financial.ts) without first granting every EXISTING brokerage that
 * same access would silently lock every current user out of functionality they already had -
 * exactly the "existing Run access would need destructive migration" outcome Priority 0.5's
 * Stop Condition 4 forbids.
 *
 * This closes that gap for brokerages that already existed before run.access was introduced.
 * New brokerages created after this phase get the equivalent grant at creation time instead -
 * see routes/auth.ts's dev-login handler. Idempotent (check-then-insert, same convention as
 * lib/billing/catalogue.ts's ensureCatalogueSeeded) and strictly additive: it only ever inserts
 * a missing Active grant, never revokes anything, and never touches grow.access - Grow access
 * remains purchase-gated exactly as it was before this function existed.
 */
export async function ensureRunAccessBackfilled(): Promise<void> {
  const allBrokerages = await db.select({ id: brokerages.id }).from(brokerages);
  for (const brokerage of allBrokerages) {
    const [existing] = await db
      .select({ id: entitlementGrants.id })
      .from(entitlementGrants)
      .where(and(eq(entitlementGrants.brokerageId, brokerage.id), eq(entitlementGrants.entitlementKey, "run.access")));
    if (existing) continue;
    await db.insert(entitlementGrants).values({
      brokerageId: brokerage.id,
      entitlementKey: "run.access",
      granteeType: "brokerage",
      granteeId: brokerage.id,
      // "migration" matches the sourceType value entitlementGrants.sourceType's own column
      // comment already anticipates (packages/db/src/schema/billing.ts) - this grant exists
      // because of a schema/product-boundary change, not a real purchase event.
      sourceType: "migration",
      status: "Active",
    });
    invalidateEntitlementCache(brokerage.id);
  }
}
