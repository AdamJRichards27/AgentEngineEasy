import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { brokerages, db, entitlementGrants, subscriptionItems, subscriptions } from "@aee/db";
import { ensureCatalogueSeeded, GROW_PRODUCT_CODE } from "../catalogue.js";
import { applySubscriptionSnapshot } from "../sync.js";
import { hasEntitlement, invalidateEntitlementCache } from "../../entitlements/resolver.js";

const SOURCE = { actorType: "SYSTEM" as const, actorId: null, label: "test:sync" };

async function createTestBrokerage(name: string): Promise<number> {
  const [row] = await db.insert(brokerages).values({ name }).returning();
  return row.id;
}

async function cleanupBrokerage(brokerageId: number): Promise<void> {
  const subs = await db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.brokerageId, brokerageId));
  for (const s of subs) {
    await db.delete(subscriptionItems).where(eq(subscriptionItems.subscriptionId, s.id));
  }
  await db.delete(subscriptions).where(eq(subscriptions.brokerageId, brokerageId));
  await db.delete(entitlementGrants).where(eq(entitlementGrants.brokerageId, brokerageId));
  await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
  invalidateEntitlementCache(brokerageId);
}

test("applySubscriptionSnapshot: an Active grow snapshot creates a subscription and grants grow.access", async (t) => {
  await ensureCatalogueSeeded();
  const brokerageId = await createTestBrokerage("Stage A Test - sync active");
  t.after(() => cleanupBrokerage(brokerageId));

  const ref = `test-sub-active-${brokerageId}`;
  await applySubscriptionSnapshot(
    {
      subscriptionRef: ref,
      customerRef: `test-cus-${brokerageId}`,
      status: "Active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: false,
      productCode: GROW_PRODUCT_CODE,
      brokerageId,
    },
    SOURCE,
  );

  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.billingSubscriptionRef, ref)).limit(1);
  assert.ok(sub, "subscription row should be created");
  assert.equal(sub.status, "Active");
  assert.equal(await hasEntitlement({ id: 1, role: "Agent", brokerageId }, "grow.access"), true);
});

test("applySubscriptionSnapshot is idempotent: re-applying the same snapshot never creates a second subscription row", async (t) => {
  await ensureCatalogueSeeded();
  const brokerageId = await createTestBrokerage("Stage A Test - sync idempotent");
  t.after(() => cleanupBrokerage(brokerageId));

  const snapshot = {
    subscriptionRef: `test-sub-idempotent-${brokerageId}`,
    customerRef: `test-cus-${brokerageId}`,
    status: "Active" as const,
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    cancelAtPeriodEnd: false,
    productCode: GROW_PRODUCT_CODE,
    brokerageId,
  };

  await applySubscriptionSnapshot(snapshot, SOURCE);
  await applySubscriptionSnapshot(snapshot, SOURCE);
  await applySubscriptionSnapshot(snapshot, SOURCE);

  const rows = await db.select().from(subscriptions).where(eq(subscriptions.billingSubscriptionRef, snapshot.subscriptionRef));
  assert.equal(rows.length, 1, "re-applying an identical snapshot must upsert, never insert a second row");
});

test("applySubscriptionSnapshot: a Cancelled snapshot revokes grow.access without deleting the subscription row", async (t) => {
  await ensureCatalogueSeeded();
  const brokerageId = await createTestBrokerage("Stage A Test - sync cancel");
  t.after(() => cleanupBrokerage(brokerageId));

  const ref = `test-sub-cancel-${brokerageId}`;
  const base = {
    subscriptionRef: ref,
    customerRef: `test-cus-${brokerageId}`,
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    productCode: GROW_PRODUCT_CODE,
    brokerageId,
  };

  await applySubscriptionSnapshot({ ...base, status: "Active", cancelAtPeriodEnd: false }, SOURCE);
  assert.equal(await hasEntitlement({ id: 1, role: "Agent", brokerageId }, "grow.access"), true);

  await applySubscriptionSnapshot({ ...base, status: "Cancelled", cancelAtPeriodEnd: false }, SOURCE);

  assert.equal(
    await hasEntitlement({ id: 1, role: "Agent", brokerageId }, "grow.access"),
    false,
    "cancellation must revoke active use",
  );

  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.billingSubscriptionRef, ref)).limit(1);
  assert.ok(sub, "the subscription row itself must never be deleted on cancellation - only revoked");
  assert.equal(sub.status, "Cancelled");
});

test("applySubscriptionSnapshot: an unknown product code is ignored, never silently granting access", async (t) => {
  const brokerageId = await createTestBrokerage("Stage A Test - unknown product");
  t.after(() => cleanupBrokerage(brokerageId));

  await applySubscriptionSnapshot(
    {
      subscriptionRef: `test-sub-unknown-${brokerageId}`,
      customerRef: `test-cus-${brokerageId}`,
      status: "Active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(),
      cancelAtPeriodEnd: false,
      productCode: "does-not-exist",
      brokerageId,
    },
    SOURCE,
  );

  const rows = await db.select().from(subscriptions).where(eq(subscriptions.brokerageId, brokerageId));
  assert.equal(rows.length, 0, "an unrecognized product code must not create any subscription state");
});
