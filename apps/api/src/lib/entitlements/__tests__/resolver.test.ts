import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { brokerages, db, entitlementGrants } from "@aee/db";
import {
  explainEntitlementDecision,
  hasEntitlement,
  invalidateEntitlementCache,
  resolveEntitlements,
} from "../resolver.js";

async function createTestBrokerage(name: string): Promise<number> {
  const [row] = await db.insert(brokerages).values({ name }).returning();
  return row.id;
}

async function cleanupBrokerage(brokerageId: number): Promise<void> {
  await db.delete(entitlementGrants).where(eq(entitlementGrants.brokerageId, brokerageId));
  await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
  invalidateEntitlementCache(brokerageId);
}

test("explainEntitlementDecision denies with NOT_AUTHENTICATED when there is no actor", async () => {
  const decision = await explainEntitlementDecision(null, "grow.access");
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "NOT_AUTHENTICATED");
});

test("explainEntitlementDecision denies with TENANT_CONTEXT_REQUIRED when the actor has no brokerage", async () => {
  const decision = await explainEntitlementDecision({ id: 1, role: "Agent", brokerageId: 0 }, "grow.access");
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "TENANT_CONTEXT_REQUIRED");
});

test("resolveEntitlements is an empty set for a brokerage with no grants at all", async (t) => {
  const brokerageId = await createTestBrokerage("Stage A Test - empty brokerage");
  t.after(() => cleanupBrokerage(brokerageId));

  const entitlements = await resolveEntitlements({ id: 1, role: "Agent", brokerageId });
  assert.equal(entitlements.size, 0);
});

test("an Active brokerage-level grant is visible via hasEntitlement, and never leaks across tenants", async (t) => {
  const brokerageA = await createTestBrokerage("Stage A Test - tenant A");
  const brokerageB = await createTestBrokerage("Stage A Test - tenant B");
  t.after(() => Promise.all([cleanupBrokerage(brokerageA), cleanupBrokerage(brokerageB)]));

  await db.insert(entitlementGrants).values({
    brokerageId: brokerageA,
    entitlementKey: "grow.access",
    granteeType: "brokerage",
    granteeId: brokerageA,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerageA);

  assert.equal(await hasEntitlement({ id: 1, role: "Agent", brokerageId: brokerageA }, "grow.access"), true);
  assert.equal(
    await hasEntitlement({ id: 2, role: "Agent", brokerageId: brokerageB }, "grow.access"),
    false,
    "a grant on brokerage A must never be visible when resolving for brokerage B",
  );
});

test("a Revoked grant sourced from a subscription denies with SUBSCRIPTION_INACTIVE, not a bare ENTITLEMENT_MISSING", async (t) => {
  const brokerageId = await createTestBrokerage("Stage A Test - revoked subscription grant");
  t.after(() => cleanupBrokerage(brokerageId));

  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey: "grow.access",
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "subscription",
    sourceId: 999999,
    status: "Revoked",
  });
  invalidateEntitlementCache(brokerageId);

  const decision = await explainEntitlementDecision({ id: 1, role: "Agent", brokerageId }, "grow.access");
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "SUBSCRIPTION_INACTIVE");
});

test("an expired grant denies with ENTITLEMENT_EXPIRED", async (t) => {
  const brokerageId = await createTestBrokerage("Stage A Test - expired grant");
  t.after(() => cleanupBrokerage(brokerageId));

  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey: "grow.access",
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "manual",
    status: "Active",
    endsAt: new Date(Date.now() - 60_000),
  });
  invalidateEntitlementCache(brokerageId);

  const decision = await explainEntitlementDecision({ id: 1, role: "Agent", brokerageId }, "grow.access");
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "ENTITLEMENT_EXPIRED");
});

test("office/team grantee types fail closed - Stage A has no tenancy table to resolve membership against", async (t) => {
  const brokerageId = await createTestBrokerage("Stage A Test - office grant fails closed");
  t.after(() => cleanupBrokerage(brokerageId));

  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey: "grow.access",
    granteeType: "office",
    granteeId: 1,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerageId);

  const decision = await explainEntitlementDecision({ id: 1, role: "Agent", brokerageId }, "grow.access");
  assert.equal(decision.allowed, false, "an unresolvable office-level grant must never be treated as granted");
});
