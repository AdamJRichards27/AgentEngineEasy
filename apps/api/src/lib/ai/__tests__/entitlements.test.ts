import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { brokerages, db, entitlementGrants } from "@aee/db";
import { invalidateEntitlementCache } from "../../entitlements/resolver.js";
import { isRoleEntitled, resolveBrokerageTier, TIER_CAPABILITIES } from "../entitlements.js";

// AE GROW Priority 0.5 — Workstream 4: resolveBrokerageTier is no longer a hardcoded stub - it
// derives its answer from the real entitlement resolver (lib/entitlements/resolver.ts), the same
// one that gates every Grow and RUN route (see routes/pitCrew.ts, routes/financial.ts,
// middlewares/entitlement.ts). These tests mirror
// lib/entitlements/__tests__/resolver.test.ts's own createTestBrokerage/cleanupBrokerage pattern
// rather than mocking the resolver, so a real divergence between the AI tier path and the real
// entitlement path would show up here as a genuine failing assertion, not something a mock could
// paper over.

async function createTestBrokerage(name: string): Promise<number> {
  const [row] = await db.insert(brokerages).values({ name }).returning();
  return row.id;
}

async function cleanupBrokerage(brokerageId: number): Promise<void> {
  await db.delete(entitlementGrants).where(eq(entitlementGrants.brokerageId, brokerageId));
  await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
  invalidateEntitlementCache(brokerageId);
}

async function grant(brokerageId: number, entitlementKey: string): Promise<void> {
  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey,
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerageId);
}

test("resolveBrokerageTier: a brokerage with no entitlement grants at all resolves to STARTER (no-divergence baseline matching the old hardcoded default)", async (t) => {
  const brokerageId = await createTestBrokerage("AI Tier Test - no grants");
  t.after(() => cleanupBrokerage(brokerageId));
  assert.equal(await resolveBrokerageTier(brokerageId), "STARTER");
});

test("resolveBrokerageTier: run.access only (the Starter/RUN product) resolves to STARTER", async (t) => {
  const brokerageId = await createTestBrokerage("AI Tier Test - run.access only");
  t.after(() => cleanupBrokerage(brokerageId));
  await grant(brokerageId, "run.access");
  assert.equal(await resolveBrokerageTier(brokerageId), "STARTER");
});

test("resolveBrokerageTier: grow.access only (the standalone Grow product) resolves to GROW", async (t) => {
  const brokerageId = await createTestBrokerage("AI Tier Test - grow.access only");
  t.after(() => cleanupBrokerage(brokerageId));
  await grant(brokerageId, "grow.access");
  assert.equal(await resolveBrokerageTier(brokerageId), "GROW");
});

test("resolveBrokerageTier: grow.access AND run.access (the Pro + Grow bundle product) resolves to PRO", async (t) => {
  const brokerageId = await createTestBrokerage("AI Tier Test - bundle");
  t.after(() => cleanupBrokerage(brokerageId));
  await grant(brokerageId, "grow.access");
  await grant(brokerageId, "run.access");
  assert.equal(await resolveBrokerageTier(brokerageId), "PRO");
});

test("resolveBrokerageTier: a Revoked grow.access grant is not counted, matching resolver.ts's own fail-closed handling", async (t) => {
  const brokerageId = await createTestBrokerage("AI Tier Test - revoked grow grant");
  t.after(() => cleanupBrokerage(brokerageId));
  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey: "grow.access",
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "subscription",
    status: "Revoked",
  });
  invalidateEntitlementCache(brokerageId);
  assert.equal(await resolveBrokerageTier(brokerageId), "STARTER");
});

test("STARTER tier is entitled to copilot but not to any other role", () => {
  assert.equal(isRoleEntitled("STARTER", "copilot"), true);
  assert.equal(isRoleEntitled("STARTER", "proactive_intelligence"), false);
  assert.equal(isRoleEntitled("STARTER", "business_coach"), false);
  assert.equal(isRoleEntitled("STARTER", "workflow_ai"), false);
  assert.equal(isRoleEntitled("STARTER", "pitcrew_ai"), false);
});

test("PRO tier is entitled to every role", () => {
  for (const role of Object.keys(TIER_CAPABILITIES.PRO.roles)) {
    assert.equal(isRoleEntitled("PRO", role as keyof typeof TIER_CAPABILITIES.PRO.roles), true);
  }
});

test("GROW tier sits strictly between STARTER and PRO", () => {
  assert.equal(isRoleEntitled("GROW", "copilot"), true);
  assert.equal(isRoleEntitled("GROW", "business_coach"), true);
  assert.equal(isRoleEntitled("GROW", "workflow_ai"), false);
  assert.equal(isRoleEntitled("GROW", "pitcrew_ai"), false);
});
