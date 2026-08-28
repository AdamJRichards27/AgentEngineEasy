import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { brokerages, db, entitlementGrants } from "@aee/db";
import { requireEntitlement } from "../entitlement.js";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";

function mockRes() {
  const res: { statusCode: number; body: unknown; status: (c: number) => typeof res; json: (b: unknown) => typeof res } = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

// These exercise requireEntitlement directly as an Express middleware would call it - the same
// server-side gate every protected Grow route uses. A frontend flag can never substitute for
// this: the route simply never runs past this function when it denies.

test("requireEntitlement returns 401 when there is no authenticated user", async () => {
  const middleware = requireEntitlement("grow.access");
  const req = {} as Parameters<typeof middleware>[0];
  const res = mockRes();
  let nextCalled = false;
  await middleware(req, res as never, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("requireEntitlement returns 403 with ENTITLEMENT_MISSING when the brokerage lacks the entitlement", async () => {
  const [brokerage] = await db.insert(brokerages).values({ name: "Stage A Test - middleware denied" }).returning();
  try {
    const middleware = requireEntitlement("grow.access");
    const req = { authedUser: { id: 1, role: "Agent", brokerageId: brokerage.id } } as Parameters<typeof middleware>[0];
    const res = mockRes();
    let nextCalled = false;
    await middleware(req, res as never, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal((res.body as { reason: string }).reason, "ENTITLEMENT_MISSING");
  } finally {
    await db.delete(brokerages).where(eq(brokerages.id, brokerage.id));
  }
});

test("requireEntitlement calls next() when the brokerage has an Active grant", async () => {
  const [brokerage] = await db.insert(brokerages).values({ name: "Stage A Test - middleware granted" }).returning();
  try {
    await db.insert(entitlementGrants).values({
      brokerageId: brokerage.id,
      entitlementKey: "grow.access",
      granteeType: "brokerage",
      granteeId: brokerage.id,
      sourceType: "manual",
      status: "Active",
    });
    invalidateEntitlementCache(brokerage.id);

    const middleware = requireEntitlement("grow.access");
    const req = { authedUser: { id: 1, role: "Agent", brokerageId: brokerage.id } } as Parameters<typeof middleware>[0];
    const res = mockRes();
    let nextCalled = false;
    await middleware(req, res as never, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  } finally {
    await db.delete(entitlementGrants).where(eq(entitlementGrants.brokerageId, brokerage.id));
    await db.delete(brokerages).where(eq(brokerages.id, brokerage.id));
    invalidateEntitlementCache(brokerage.id);
  }
});
