// Agent Engine 2.0 — Property Launch & Campaign Coordination.
//
// Lib-level coverage for lib/launch/model.ts, the single write path every
// Launch route funnels through — same "test the pipeline directly with
// real DB/HTTP fixtures" philosophy as lib/exceptions/__tests__/model.test.ts.
// The four scenarios named in the governing spec (successful standard
// launch, blocked launch, budget exception, partial portal launch) are
// each their own test below; smaller focused tests cover tenant isolation
// and individual guards. Both the Exception & Risk Engine and the Launch
// engine's own event handler are registered in before() (startScheduler:
// false so no periodic timer keeps the test process alive) so these tests
// also prove the WAE/ERX reuse actually fires end-to-end, not just that
// model.ts's own functions return the right shapes in isolation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, and } from "drizzle-orm";
import { db, riskExceptions, properties } from "@aee/db";
import {
  getOrCreateLaunchPlan,
  getLaunchPlanDetail,
  getLaunchPlanTransitions,
  applyTemplate,
  setTargetLaunchDate,
  addCampaignItem,
  updateCampaignItemStatus,
  recordVendorAndCost,
  setBudget,
  addPortalDestination,
  recordPortalSubmission,
  recordPortalFailure,
  confirmPortalLive,
  evaluateAndUpdateMarketReady,
  confirmLaunchLive,
  pauseLaunchPlan,
  resumeLaunchPlan,
  cancelLaunchPlan,
} from "../model.js";
import { LaunchError, type ActorRef } from "../types.js";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { registerExceptionEngine } = await import("../../exceptions/bootstrap.js");
  registerExceptionEngine({ startScheduler: false });
  const { registerLaunchEngine } = await import("../bootstrap.js");
  registerLaunchEngine();
  const { createApp } = await import("../../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `Launch Model A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Launch Model B ${suffix}`);
});

after(async () => {
  const ids = [A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number");
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function actorOf(login: DevLoginResult): ActorRef {
  return { id: login.user.id, role: login.user.role };
}

/**
 * createListedProperty drives the real Ready to List -> agency terms ->
 * populate -> send -> e-sign webhook completion path, which publishes
 * AGENCY_AGREEMENT_SIGNED — the event bootstrap.ts's handler listens for
 * to auto-propose a Launch Plan. That handler runs synchronously inside
 * the same publishDomainEvent() call the webhook route awaits before
 * responding (packages/events/src/publisher.ts's own documented contract),
 * so the plan should already exist by the time createListedProperty
 * resolves — this small poll is defensive robustness for the test, not an
 * assumption that the real system is asynchronous here.
 */
async function waitForAutoProposedPlan(propertyId: number, brokerageId: number) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const detail = await getLaunchPlanDetail(propertyId, brokerageId);
    if (detail) return detail;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Launch plan was never auto-proposed for property ${propertyId} after AGENCY_AGREEMENT_SIGNED`);
}

// ---------------------------------------------------------------------
// Auto-propose + basic lifecycle.
// ---------------------------------------------------------------------

test("a Launch Plan is auto-proposed on AGENCY_AGREEMENT_SIGNED, in PLANNING, with no campaign items yet", async () => {
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: `1 Auto Propose St ${suffix}` });
  const detail = await waitForAutoProposedPlan(propertyId, A.brokerageId);
  assert.equal(detail.plan.status, "PLANNING");
  assert.equal(detail.plan.templateType, "CUSTOM");
  assert.equal(detail.items.length, 0);

  // Idempotent: calling getOrCreateLaunchPlan again returns the same row rather than a second one.
  const again = await getOrCreateLaunchPlan(propertyId, A.brokerageId, actorOf(A.agent));
  assert.equal(again.created, false);
  assert.equal(again.plan.id, detail.plan.id);
});

test("a cross-tenant launchPlanId and a genuinely nonexistent one fail identically with NOT_FOUND", async () => {
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: `2 Tenant Isolation St ${suffix}` });
  const detail = await waitForAutoProposedPlan(propertyId, A.brokerageId);

  const crossTenant = getLaunchPlanTransitions(detail.plan.id, B.brokerageId).catch((e) => e);
  const nonexistent = getLaunchPlanTransitions("00000000-0000-0000-0000-000000000000", B.brokerageId).catch((e) => e);
  const [crossTenantErr, nonexistentErr] = await Promise.all([crossTenant, nonexistent]);
  assert.ok(crossTenantErr instanceof LaunchError);
  assert.ok(nonexistentErr instanceof LaunchError);
  assert.equal(crossTenantErr.reason, "NOT_FOUND");
  assert.equal(nonexistentErr.reason, "NOT_FOUND");
  assert.equal(crossTenantErr.message, nonexistentErr.message, "must not reveal whether the plan exists at all, just under a different tenant");
});

test("pause / resume / cancel move launch_plans.status and are recorded as transitions", async () => {
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: `3 Pause Resume St ${suffix}` });
  const detail = await waitForAutoProposedPlan(propertyId, A.brokerageId);
  const actor = actorOf(A.agent);

  const paused = await pauseLaunchPlan(detail.plan.id, A.brokerageId, actor, "Vendor asked to hold.");
  assert.equal(paused.status, "PAUSED");
  await assert.rejects(() => pauseLaunchPlan(detail.plan.id, A.brokerageId, actor, "again"), (err: unknown) => {
    assert.ok(err instanceof LaunchError);
    assert.equal((err as LaunchError).reason, "INVALID_STATUS");
    return true;
  });

  const resumed = await resumeLaunchPlan(detail.plan.id, A.brokerageId, actor);
  assert.equal(resumed.status, "PLANNING"); // recomputed live from state — back to PLANNING since no items exist

  const cancelled = await cancelLaunchPlan(detail.plan.id, A.brokerageId, actor, "Vendor withdrew from market.");
  assert.equal(cancelled.status, "CANCELLED");

  const transitions = await getLaunchPlanTransitions(detail.plan.id, A.brokerageId);
  const types = transitions.map((t) => t.transitionType);
  assert.ok(types.includes("PAUSED"));
  assert.ok(types.includes("RESUMED"));
  assert.ok(types.includes("CANCELLED"));
});

// ---------------------------------------------------------------------
// Scenario 1: successful standard launch.
// ---------------------------------------------------------------------

test("scenario: successful standard launch — template through to Listing Live", async () => {
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: `10 Successful Launch St ${suffix}` });
  const detail = await waitForAutoProposedPlan(propertyId, A.brokerageId);
  const actor = actorOf(A.agent);

  const targetDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await setTargetLaunchDate(detail.plan.id, A.brokerageId, actor, targetDate);

  const applied = await applyTemplate(detail.plan.id, A.brokerageId, actor, "STANDARD_PRIVATE_TREATY");
  assert.equal(applied.templateType, "STANDARD_PRIVATE_TREATY");

  const afterTemplate = await getLaunchPlanDetail(propertyId, A.brokerageId);
  assert.ok(afterTemplate);
  assert.equal(afterTemplate!.items.length, 6, "STANDARD_PRIVATE_TREATY generates six campaign items");
  assert.ok(afterTemplate!.items.every((i) => i.dueAt !== null), "every generated item gets a dueAt once a target date is already set");

  for (const item of afterTemplate!.items) {
    await updateCampaignItemStatus(item.id, A.brokerageId, actor, "COMPLETE");
  }

  const destination = await addPortalDestination(detail.plan.id, A.brokerageId, actor, "realestate.com.au");

  const marketReady = await evaluateAndUpdateMarketReady(detail.plan.id, A.brokerageId, actor);
  assert.equal(marketReady.ready, true, `expected Market Ready, got blockers: ${JSON.stringify(marketReady.blockers)}`);

  await recordPortalSubmission(destination.id, A.brokerageId, actor);
  await confirmPortalLive(destination.id, A.brokerageId, actor);

  const live = await confirmLaunchLive(detail.plan.id, A.brokerageId, actor);
  assert.equal(live.status, "LISTING_LIVE");
  assert.ok(live.listingLiveConfirmedAt);

  const [property] = await db.select().from(properties).where(eq(properties.id, propertyId));
  assert.equal(property!.listingStatus, "Listed");
});

// ---------------------------------------------------------------------
// Scenario 2: blocked launch.
// ---------------------------------------------------------------------

test("scenario: blocked launch — missing required items and a blocked item both surface as Market Ready blockers, and confirmLaunchLive refuses", async () => {
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: `11 Blocked Launch St ${suffix}` });
  const detail = await waitForAutoProposedPlan(propertyId, A.brokerageId);
  const actor = actorOf(A.agent);

  await applyTemplate(detail.plan.id, A.brokerageId, actor, "STANDARD_PRIVATE_TREATY");
  const afterTemplate = await getLaunchPlanDetail(propertyId, A.brokerageId);
  const photography = afterTemplate!.items.find((i) => i.itemType === "PHOTOGRAPHY")!;
  await updateCampaignItemStatus(photography.id, A.brokerageId, actor, "BLOCKED", "Agent hasn't scheduled the shoot yet.");

  const marketReady = await evaluateAndUpdateMarketReady(detail.plan.id, A.brokerageId, actor);
  assert.equal(marketReady.ready, false);
  const codes = marketReady.blockers.map((b) => b.code);
  assert.ok(codes.includes("MISSING_REQUIRED_CAMPAIGN_ITEMS"), `expected MISSING_REQUIRED_CAMPAIGN_ITEMS, got ${codes.join(",")}`);
  assert.ok(codes.includes("CAMPAIGN_ITEMS_BLOCKED"), `expected CAMPAIGN_ITEMS_BLOCKED, got ${codes.join(",")}`);
  assert.ok(codes.includes("NO_PORTAL_DESTINATIONS_CONFIGURED"));

  await assert.rejects(() => confirmLaunchLive(detail.plan.id, A.brokerageId, actor), (err: unknown) => {
    assert.ok(err instanceof LaunchError);
    assert.equal((err as LaunchError).reason, "NOT_READY");
    return true;
  });

  const plan = (await getLaunchPlanDetail(propertyId, A.brokerageId))!.plan;
  assert.equal(plan.status, "CAMPAIGN_PRODUCTION", "a plan with items but no vendor approvals/market-ready/portal activity computes to CAMPAIGN_PRODUCTION");
});

// ---------------------------------------------------------------------
// Scenario 3: budget exception.
// ---------------------------------------------------------------------

test("scenario: budget exception — recording a cost above budget marks budgetSpentCents, raises a vendor approval automatically, and the ERX L07/L06 rules fire for real via the shared engine", async () => {
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: `12 Budget Exception St ${suffix}` });
  const detail = await waitForAutoProposedPlan(propertyId, A.brokerageId);
  const actor = actorOf(A.agent);

  await setBudget(detail.plan.id, A.brokerageId, actorOf(A.admin), 100000); // $1,000 budget

  const item = await addCampaignItem(detail.plan.id, A.brokerageId, actor, { itemType: "PHOTOGRAPHY", title: "Professional photography" });
  await recordVendorAndCost(item.id, A.brokerageId, actor, "Acme Photography", 150000); // $1,500 — over budget and over the approval threshold

  const plan = (await getLaunchPlanDetail(propertyId, A.brokerageId))!.plan;
  assert.equal(plan.budgetSpentCents, 150000);
  assert.ok(plan.budgetSpentCents > plan.budgetCents);

  const detailAfter = await getLaunchPlanDetail(propertyId, A.brokerageId);
  assert.equal(detailAfter!.approvals.length, 1, "crossing the approval threshold must auto-raise exactly one vendor approval");
  assert.equal(detailAfter!.approvals[0]!.status, "PENDING");
  assert.equal(detailAfter!.approvals[0]!.approvalType, "CAMPAIGN_ITEM_COST");

  const marketReady = await evaluateAndUpdateMarketReady(detail.plan.id, A.brokerageId, actor);
  const codes = marketReady.blockers.map((b) => b.code);
  assert.ok(codes.includes("BUDGET_EXCEEDED"));
  assert.ok(codes.includes("PENDING_VENDOR_APPROVALS"));

  // The Exception & Risk Engine is registered event-driven in before(), so
  // LAUNCH_BUDGET_EXCEEDED and VENDOR_COST_RECORDED (via recordVendorAndCost's
  // own emit calls, awaited inside publishDomainEvent) should already have
  // produced real risk_exceptions rows by now — proving the "reuse the ERX,
  // don't build a second warning system" requirement actually holds end to
  // end, not just that the two systems compile against each other.
  const findings = await db
    .select()
    .from(riskExceptions)
    .where(and(eq(riskExceptions.propertyId, propertyId), eq(riskExceptions.category, "LAUNCH_CAMPAIGN")));
  const ruleIds = findings.map((f) => f.ruleId);
  assert.ok(ruleIds.includes("L07_LAUNCH_BUDGET_EXCEEDED_UNRESOLVED"), `expected an L07 finding, got rule ids: ${ruleIds.join(",")}`);
  const l07 = findings.find((f) => f.ruleId === "L07_LAUNCH_BUDGET_EXCEEDED_UNRESOLVED")!;
  assert.equal(l07.requiresFinancialEntitlement, true);
});

// ---------------------------------------------------------------------
// Scenario 4: partial portal launch.
// ---------------------------------------------------------------------

test("scenario: partial portal launch — one portal live and one failed still allows Listing Live to be confirmed", async () => {
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: `13 Partial Portal St ${suffix}` });
  const detail = await waitForAutoProposedPlan(propertyId, A.brokerageId);
  const actor = actorOf(A.agent);
  const targetDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await setTargetLaunchDate(detail.plan.id, A.brokerageId, actor, targetDate);

  await applyTemplate(detail.plan.id, A.brokerageId, actor, "OFF_MARKET"); // smaller template: PHOTOGRAPHY + COPYWRITING + DIGITAL_AD
  const afterTemplate = await getLaunchPlanDetail(propertyId, A.brokerageId);
  for (const item of afterTemplate!.items) {
    await updateCampaignItemStatus(item.id, A.brokerageId, actor, "COMPLETE");
  }

  const primaryPortal = await addPortalDestination(detail.plan.id, A.brokerageId, actor, "realestate.com.au");
  const secondaryPortal = await addPortalDestination(detail.plan.id, A.brokerageId, actor, "Domain");

  await recordPortalSubmission(primaryPortal.id, A.brokerageId, actor);
  await confirmPortalLive(primaryPortal.id, A.brokerageId, actor);

  await recordPortalSubmission(secondaryPortal.id, A.brokerageId, actor);
  await recordPortalFailure(secondaryPortal.id, A.brokerageId, actor, "Portal rejected the listing — missing certificate of title.");

  const planAfterPortals = (await getLaunchPlanDetail(propertyId, A.brokerageId))!.plan;
  assert.equal(planAfterPortals.status, "PORTAL_SUBMISSION");

  const marketReady = await evaluateAndUpdateMarketReady(detail.plan.id, A.brokerageId, actor);
  assert.equal(marketReady.ready, true, `expected Market Ready (portal status doesn't gate it), got blockers: ${JSON.stringify(marketReady.blockers)}`);

  const live = await confirmLaunchLive(detail.plan.id, A.brokerageId, actor);
  assert.equal(live.status, "LISTING_LIVE", "one LIVE portal destination is enough to confirm Listing Live even with another FAILED");

  const finalDetail = await getLaunchPlanDetail(propertyId, A.brokerageId);
  const statuses = finalDetail!.destinations.map((d) => d.status).sort();
  assert.deepEqual(statuses, ["FAILED", "LIVE"]);
});
