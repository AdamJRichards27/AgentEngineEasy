// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation —
// Domain Integration Proof A (Property Launch).
//
// End-to-end through the REAL outbox, adapter, webhook gateway, and
// Launch's own service boundary — no shortcuts. Proves: mock portal
// connection -> queue publication -> outbox/adapter processing -> mock
// status webhook -> update via recordPortalSubmission/confirmPortalLive
// (Launch's own functions, never a duplicate write path) -> duplicate-
// webhook protection -> out-of-order protection -> Market Ready/
// Listing-Live approval controls cannot be bypassed by any mock portal event.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, launchPlans, portalDestinations } from "@aee/db";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";
import { bootstrapIntegrationsForTesting, createActiveMockPortalConnection } from "./testHelpers.js";
import { publishListingToMockPortal, LAUNCH_PORTAL_WEBHOOK_EVENT_TYPE } from "../launchProof.js";
import { MOCK_PORTAL_PROVIDER_ID } from "../adapters/mockPortal.js";
import { processInboundWebhook } from "../webhooks.js";
import { getOrCreateLaunchPlan, addPortalDestination } from "../../launch/model.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
// devLogin() below requires ALLOW_DEV_AUTH=true. Most suites in this repo
// set this themselves at module load (see e.g. transactionConditions.test.ts)
// rather than relying on an ambient value that may not be set, and this
// suite should too.
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { createApp } = await import("../../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  await bootstrapIntegrationsForTesting();
  A = await createBrokerageWithUsers(baseUrl, `Integrations Launch Proof ${suffix}`);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId].filter((id): id is number => typeof id === "number"));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("Proof A: publish -> outbox/adapter -> mock status webhook -> Launch service boundary update, with duplicate/out-of-order protection and no Market Ready bypass", async () => {
  const actor = { id: A.admin.user.id, role: A.admin.user.role };

  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: `1 Integration Proof Rd ${suffix}` });
  const { plan } = await getOrCreateLaunchPlan(propertyId, A.brokerageId, actor);
  const destination = await addPortalDestination(plan.id, A.brokerageId, actor, "Mock Property Portal (Sandbox)");
  assert.equal(destination.status, "NOT_STARTED");

  const { connection } = await createActiveMockPortalConnection(A.brokerageId, actor);

  // --- Outbound: publish through the real outbox/adapter path. ---
  const publishResult = await publishListingToMockPortal(destination.id, A.brokerageId, connection.id, actor);
  assert.equal(publishResult.outboxStatus, "SENT");

  const [afterSubmit] = await db.select().from(portalDestinations).where(eq(portalDestinations.id, destination.id));
  assert.equal(afterSubmit.status, "SUBMITTED", "recordPortalSubmission (Launch's own service boundary) must have applied the effect");

  // --- Inbound: a signed mock "listing live" status webhook. ---
  const liveResult = await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_PORTAL_PROVIDER_ID,
    providerEventId: `evt-live-${suffix}`,
    eventType: LAUNCH_PORTAL_WEBHOOK_EVENT_TYPE,
    payload: { portalDestinationId: destination.id, status: "LIVE", listingUrl: "https://example.test/mock-listing" },
    signatureValid: true,
  });
  assert.equal(liveResult.status, "PROCESSED");

  const [afterLive] = await db.select().from(portalDestinations).where(eq(portalDestinations.id, destination.id));
  assert.equal(afterLive.status, "LIVE", "confirmPortalLive (Launch's own service boundary) must have applied the effect");
  assert.equal(afterLive.listingUrl, "https://example.test/mock-listing");

  // --- Market Ready / Listing Live bypass check (Section 14). ---
  const [planAfterWebhook] = await db.select().from(launchPlans).where(eq(launchPlans.id, plan.id));
  assert.notEqual(planAfterWebhook.status, "LISTING_LIVE", "a mock portal webhook must never itself flip the property-level LISTING_LIVE status");
  assert.equal(planAfterWebhook.listingLiveConfirmedAt, null, "confirmLaunchLive's own gate (Market Ready + evaluateListingLive) was never called by the webhook path");

  // --- Duplicate webhook protection. ---
  const duplicateResult = await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_PORTAL_PROVIDER_ID,
    providerEventId: `evt-live-${suffix}`, // same providerEventId — a genuine redelivery
    eventType: LAUNCH_PORTAL_WEBHOOK_EVENT_TYPE,
    payload: { portalDestinationId: destination.id, status: "LIVE", listingUrl: "https://example.test/mock-listing" },
    signatureValid: true,
  });
  assert.equal(duplicateResult.status, "DUPLICATE");

  // --- Out-of-order protection: a stale "SUBMITTED" event arriving after LIVE must not regress state. ---
  const staleResult = await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_PORTAL_PROVIDER_ID,
    providerEventId: `evt-stale-submitted-${suffix}`, // a DIFFERENT event id — not a duplicate, a genuinely later delivery of an earlier state
    eventType: LAUNCH_PORTAL_WEBHOOK_EVENT_TYPE,
    payload: { portalDestinationId: destination.id, status: "SUBMITTED" },
    signatureValid: true,
  });
  assert.equal(staleResult.status, "PROCESSED"); // recorded, but...
  const [afterStale] = await db.select().from(portalDestinations).where(eq(portalDestinations.id, destination.id));
  assert.equal(afterStale.status, "LIVE", "a stale/out-of-order SUBMITTED event must never regress an already-LIVE destination");
});
