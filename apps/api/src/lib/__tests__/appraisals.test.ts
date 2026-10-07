// Run Transaction Vertical Slice (#124) — Stage A: Appraisals
// (apps/api/src/lib/appraisals.ts). appraisals had zero route/lib
// references anywhere in the codebase before this build (schema-only,
// unreachable) — these tests prove the new lib functions actually work
// end to end: creation is idempotent, editing is blocked once finalised,
// finalising requires a price range and is itself idempotent, and both
// APPRAISAL_CREATED / APPRAISAL_COMPLETED (pre-existing in the event
// registry with zero publishers before this) are now genuinely emitted —
// exactly once each, even across repeated calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { AppraisalPricingLockedError } from "../appraisalFinaliseGuard.js";
import { getOrCreateAppraisal, updateAppraisal, finaliseAppraisal, getAppraisalByProperty } from "../appraisals.js";
import { createBrokerageWithUsers, cleanupBrokerages, getDomainEventsForProperty, type DevLoginResult } from "../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageAName = `Run Vertical Slice Appraisals A ${suffix}`;
const brokerageBName = `Run Vertical Slice Appraisals B ${suffix}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let propertyIdA: number;
let propertyIdB: number;

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, brokerageAName);
  B = await createBrokerageWithUsers(baseUrl, brokerageBName);
  propertyIdA = await createProperty(A.agent.cookie, "1 Appraisal Test Ave");
  propertyIdB = await createProperty(B.agent.cookie, "2 Appraisal Cross Tenant Rd");
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("getOrCreateAppraisal creates once, is idempotent on a second call, and publishes APPRAISAL_CREATED exactly once", async () => {
  const first = await getOrCreateAppraisal({ propertyId: propertyIdA, userId: A.agent.user.id, brokerageId: A.brokerageId });
  assert.equal(first.created, true);
  assert.equal(first.appraisal.propertyId, propertyIdA);
  assert.equal(first.appraisal.isFinalised, false);

  const second = await getOrCreateAppraisal({ propertyId: propertyIdA, userId: A.agent.user.id, brokerageId: A.brokerageId });
  assert.equal(second.created, false);
  assert.equal(second.appraisal.id, first.appraisal.id, "a second start must reuse the same in-progress appraisal, not create a sibling");

  const events = await getDomainEventsForProperty(propertyIdA, "APPRAISAL_CREATED");
  assert.equal(events.length, 1, "APPRAISAL_CREATED must be published exactly once even though getOrCreateAppraisal was called twice");
});

test("getOrCreateAppraisal rejects a property that does not belong to the caller's brokerage", async () => {
  await assert.rejects(
    () => getOrCreateAppraisal({ propertyId: propertyIdB, userId: A.agent.user.id, brokerageId: A.brokerageId }),
    /not found/i,
  );
});

test("updateAppraisal saves price range and comparable sales, and refuses further edits once finalised", async () => {
  const updated = await updateAppraisal({
    propertyId: propertyIdA,
    userId: A.agent.user.id,
    brokerageId: A.brokerageId,
    priceRangeLow: "750000",
    priceRangeHigh: "820000",
    comparableSales: "12 Nearby St sold $790,000 (3 months ago)",
  });
  assert.equal(updated.priceRangeLow, "750000.00");
  assert.equal(updated.priceRangeHigh, "820000.00");
  assert.equal(updated.comparableSales, "12 Nearby St sold $790,000 (3 months ago)");

  const finalised = await finaliseAppraisal({ propertyId: propertyIdA, userId: A.agent.user.id, brokerageId: A.brokerageId });
  assert.equal(finalised.isFinalised, true);
  assert.ok(finalised.finalisedSnapshot, "finalising must capture an immutable snapshot");

  await assert.rejects(
    () =>
      updateAppraisal({
        propertyId: propertyIdA,
        userId: A.agent.user.id,
        brokerageId: A.brokerageId,
        priceRangeLow: "999999",
      }),
    (err: unknown) => {
      assert.ok(err instanceof AppraisalPricingLockedError);
      assert.equal(err.code, "APPRAISAL_PRICING_LOCKED");
      assert.match(err.message, /already finalised/i);
      return true;
    },
  );
});

test("finaliseAppraisal is idempotent and publishes APPRAISAL_COMPLETED exactly once even though it was reached twice", async () => {
  // The previous test already finalised propertyIdA's appraisal once;
  // finalising again here must be a pure no-op.
  const again = await finaliseAppraisal({ propertyId: propertyIdA, userId: A.agent.user.id, brokerageId: A.brokerageId });
  assert.equal(again.isFinalised, true);

  const events = await getDomainEventsForProperty(propertyIdA, "APPRAISAL_COMPLETED");
  assert.equal(events.length, 1, "APPRAISAL_COMPLETED must be published exactly once despite finaliseAppraisal being called twice");
});

test("finaliseAppraisal refuses to finalise without a price range, and getAppraisalByProperty is null before one is started", async () => {
  assert.equal(await getAppraisalByProperty(propertyIdB), null);

  await getOrCreateAppraisal({ propertyId: propertyIdB, userId: B.agent.user.id, brokerageId: B.brokerageId });
  await assert.rejects(
    () => finaliseAppraisal({ propertyId: propertyIdB, userId: B.agent.user.id, brokerageId: B.brokerageId }),
    /price range is required/i,
  );
});
