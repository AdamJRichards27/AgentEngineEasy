// AE GROW Priority 6 Stage D — AI-Proposed, Human-Approved Follow-Up
// Actions. Governance and functional tests for the CREATE_GROW_COMMITMENT
// action, following governance.test.ts's own pattern: integration tests
// against a real database, every test creates its own throwaway
// brokerage/user/party fixtures and tears them down in t.after().

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  brokerages,
  users,
  parties,
  properties,
  growOpportunities,
  growCommitments,
  aiActionRequests,
  entitlementGrants,
  subscriptions,
  subscriptionItems,
  type UserRole,
} from "@aee/db";
import { invalidateEntitlementCache, hasEntitlement } from "../../entitlements/resolver.js";
import { ensureCatalogueSeeded, BUNDLE_PRODUCT_CODE } from "../../billing/catalogue.js";
import { applySubscriptionSnapshot } from "../../billing/sync.js";
import { evaluateAIAction, type PolicyActor } from "../policyEngine.js";
import {
  proposeAIAction,
  getAIActionRequest,
  approveAIActionRequest,
  rejectAIActionRequest,
  findOpenActionRequestByResource,
  listAwaitingApprovalForUser,
  getAIActionRequestForActor,
  OPEN_GROW_COMMITMENT_RESOURCE_UNIQUE_INDEX,
} from "../actionRequests.js";
import { executeAIAction, executeAIActionAsSystem } from "../executionGateway.js";
import { isAutoExecuteEligible, riskTierForLevel, AUTHORITY_LEVELS } from "../authority.js";
import { createApprovedGrowCommitment, GrowCommitmentValidationError } from "../../growCommitmentActions.js";
import {
  selectGrowCommitmentCandidate,
  isReasonableCommitmentDueDate,
  proposeGrowCommitmentIfGrounded,
} from "../orchestrator.js";
import type { AiContextPackage, GrowTodayItemView } from "../types.js";

const ACTION_KEY = "CREATE_GROW_COMMITMENT";
const ENTITLEMENT_KEY = "grow.activities.manage";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function createBrokerage(tag: string): Promise<number> {
  const [row] = await db.insert(brokerages).values({ name: `Stage D Test - ${tag} (${randomUUID()})` }).returning();
  return row.id;
}

async function createUser(brokerageId: number, role: UserRole): Promise<number> {
  const suffix = randomUUID();
  const [row] = await db
    .insert(users)
    .values({ authProviderId: `test-${suffix}`, email: `test-${suffix}@example.com`, role, brokerageId, isActive: true })
    .returning();
  return row.id;
}

async function createParty(brokerageId: number, firstName: string): Promise<number> {
  const [row] = await db.insert(parties).values({ brokerageId, partyType: "Person", firstName, lastName: "Fixture" }).returning();
  return row.id;
}

async function createProperty(brokerageId: number, agentId: number): Promise<number> {
  const [row] = await db.insert(properties).values({ brokerageId, agentId, formattedAddress: "1 Test St, Testville" }).returning();
  return row.id;
}

async function createOpportunity(brokerageId: number, partyId: number): Promise<number> {
  const [row] = await db.insert(growOpportunities).values({ brokerageId, partyId, opportunityType: "Listing" }).returning();
  return row.id;
}

async function grantEntitlement(brokerageId: number): Promise<void> {
  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey: ENTITLEMENT_KEY,
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerageId);
}

async function cleanupBrokerage(brokerageId: number): Promise<void> {
  await db.delete(aiActionRequests).where(eq(aiActionRequests.brokerageId, brokerageId));
  await db.delete(growCommitments).where(eq(growCommitments.brokerageId, brokerageId));
  await db.delete(growOpportunities).where(eq(growOpportunities.brokerageId, brokerageId));
  await db.delete(properties).where(eq(properties.brokerageId, brokerageId));
  await db.delete(parties).where(eq(parties.brokerageId, brokerageId));
  // AE GROW Priority 6 Stage D — additive. subscriptionItems/subscriptions
  // rows only ever exist for the one test below (§6, PRO/Scale bundle
  // inheritance) that calls applySubscriptionSnapshot() instead of granting
  // the entitlement manually - this delete is a no-op for every other test
  // in this file, none of which insert either table. subscriptionItems is
  // deleted first since it FKs to subscriptions.
  const brokerageSubscriptions = await db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.brokerageId, brokerageId));
  if (brokerageSubscriptions.length > 0) {
    await db.delete(subscriptionItems).where(inArray(subscriptionItems.subscriptionId, brokerageSubscriptions.map((s) => s.id)));
  }
  await db.delete(subscriptions).where(eq(subscriptions.brokerageId, brokerageId));
  await db.delete(entitlementGrants).where(eq(entitlementGrants.brokerageId, brokerageId));
  await db.delete(users).where(eq(users.brokerageId, brokerageId));
  await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
  invalidateEntitlementCache(brokerageId);
}

function actorOf(id: number, role: UserRole | string, brokerageId: number): PolicyActor {
  return { id, role, brokerageId };
}

function makeCandidate(overrides: Partial<GrowTodayItemView> = {}): GrowTodayItemView {
  return {
    id: "opportunity:1",
    type: "opportunity_no_action_set",
    priority: "KeepWarm",
    partyId: 1,
    contactName: "Fixture Contact",
    propertyId: null,
    propertyLabel: null,
    opportunityId: null,
    appraisalId: null,
    reason: "Fixture reason.",
    recommendedAction: "Fixture recommended action.",
    dueAt: null,
    lastActivityAt: null,
    ...overrides,
  };
}

function makeContext(brokerageId: number, userId: number, grow: AiContextPackage["grow"]): AiContextPackage {
  return {
    requestId: "fixture-request-id",
    brokerageId,
    userId,
    userRole: "Agent",
    tier: "GROW",
    role: "copilot",
    contextType: "grow",
    contextId: null,
    user: { id: userId, firstName: "Fixture", lastName: "Agent", role: "Agent" },
    brokerage: { id: brokerageId, name: "Fixture Brokerage", tier: "GROW" },
    business: { activePropertyCount: 0, upcomingSettlementCount: 0 },
    property: null,
    transaction: null,
    grow,
    pitCrew: null,
    coach: null,
  };
}

function emptyGrowContext(overrides: Partial<NonNullable<AiContextPackage["grow"]>> = {}): NonNullable<AiContextPackage["grow"]> {
  return {
    generatedAt: new Date().toISOString(),
    hasAnyGrowData: true,
    counts: { priorityActions: 0, followUpsDue: 0, openOpportunities: 0, contactsNeedingAttention: 0 },
    relationshipBreakdown: [],
    todayItems: [],
    focusedItem: null,
    dueFollowUps: [],
    appraisalFollowUps: [],
    activeSignals: [],
    opportunityPipeline: [],
    recentActivity: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Policy: actorType, entitlement, and the always-requires-approval
//    guarantee.
// ---------------------------------------------------------------------------

test("CREATE_GROW_COMMITMENT policy: actorType 'USER' is forbidden - this action can only be proposed by the orchestrator's own internal 'AI' actorType", async (t) => {
  const brokerageId = await createBrokerage("actor-type-forbidden");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");

  const decision = await evaluateAIAction({
    actionKey: ACTION_KEY,
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { partyId, description: "Follow up", dueAt: new Date().toISOString(), reason: "test" },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "ACTOR_TYPE_FORBIDDEN");
});

test("CREATE_GROW_COMMITMENT policy: missing grow.activities.manage entitlement denies, even with actorType 'AI' and a valid role", async (t) => {
  const brokerageId = await createBrokerage("entitlement-denied");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const partyId = await createParty(brokerageId, "Sarah");

  const decision = await evaluateAIAction({
    actionKey: ACTION_KEY,
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "AI",
    rawInput: { partyId, description: "Follow up", dueAt: new Date().toISOString(), reason: "test" },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "ENTITLEMENT_DENIED");
});

test("CREATE_GROW_COMMITMENT policy: with the entitlement granted and actorType 'AI', a valid proposal is allowed and always requires human approval", async (t) => {
  const brokerageId = await createBrokerage("allowed-requires-approval");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");

  const { request, decision } = await proposeAIAction({
    actionKey: ACTION_KEY,
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "AI",
    rawInput: { partyId, description: "Follow up with Sarah", dueAt: new Date().toISOString(), reason: "Overdue appraisal follow-up" },
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
  assert.ok(request);
  assert.equal(request!.status, "AWAITING_APPROVAL");
});

test("CREATE_GROW_COMMITMENT is never auto-execute-eligible - authorityLevel EXECUTE + riskLevel 2 (MEDIUM) guarantees human approval by construction", () => {
  assert.equal(riskTierForLevel(2), "MEDIUM");
  assert.equal(isAutoExecuteEligible(AUTHORITY_LEVELS.EXECUTE, "MEDIUM"), false);
});

test("CREATE_GROW_COMMITMENT policy: a structurally invalid payload (missing partyId) is rejected before it ever reaches the domain function", async (t) => {
  const brokerageId = await createBrokerage("invalid-input");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);

  const decision = await evaluateAIAction({
    actionKey: ACTION_KEY,
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "AI",
    rawInput: { description: "Follow up", dueAt: new Date().toISOString(), reason: "test" },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "INPUT_SCHEMA_INVALID");
});

// ---------------------------------------------------------------------------
// 2. Domain function: createApprovedGrowCommitment.
// ---------------------------------------------------------------------------

test("createApprovedGrowCommitment: creates a real growCommitments row scoped to the caller's brokerage", async (t) => {
  const brokerageId = await createBrokerage("domain-happy-path");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const partyId = await createParty(brokerageId, "Sarah");
  const dueAt = new Date().toISOString();

  const commitment = await createApprovedGrowCommitment({
    brokerageId,
    createdBy: agentId,
    partyId,
    description: "Follow up with Sarah",
    dueAt,
  });

  assert.equal(commitment.brokerageId, brokerageId);
  assert.equal(commitment.partyId, partyId);
  assert.equal(commitment.status, "Open");
  assert.equal(commitment.propertyId, null);
  assert.equal(commitment.opportunityId, null);

  const [row] = await db.select().from(growCommitments).where(eq(growCommitments.id, commitment.id));
  assert.ok(row);
});

test("createApprovedGrowCommitment: rejects a party that belongs to a different brokerage", async (t) => {
  const brokerageA = await createBrokerage("domain-cross-tenant-party-a");
  const brokerageB = await createBrokerage("domain-cross-tenant-party-b");
  t.after(() => Promise.all([cleanupBrokerage(brokerageA), cleanupBrokerage(brokerageB)]));
  const agentA = await createUser(brokerageA, "Agent");
  const partyB = await createParty(brokerageB, "Foreign");

  await assert.rejects(
    () =>
      createApprovedGrowCommitment({
        brokerageId: brokerageA,
        createdBy: agentA,
        partyId: partyB,
        description: "Should never be created",
        dueAt: new Date().toISOString(),
      }),
    GrowCommitmentValidationError,
  );

  const rows = await db.select().from(growCommitments).where(eq(growCommitments.brokerageId, brokerageA));
  assert.equal(rows.length, 0);
});

test("createApprovedGrowCommitment: rejects a property that belongs to a different brokerage", async (t) => {
  const brokerageA = await createBrokerage("domain-cross-tenant-property-a");
  const brokerageB = await createBrokerage("domain-cross-tenant-property-b");
  t.after(() => Promise.all([cleanupBrokerage(brokerageA), cleanupBrokerage(brokerageB)]));
  const agentA = await createUser(brokerageA, "Agent");
  const partyA = await createParty(brokerageA, "Sarah");
  const agentB = await createUser(brokerageB, "Agent");
  const propertyB = await createProperty(brokerageB, agentB);

  await assert.rejects(
    () =>
      createApprovedGrowCommitment({
        brokerageId: brokerageA,
        createdBy: agentA,
        partyId: partyA,
        description: "Should never be created",
        dueAt: new Date().toISOString(),
        propertyId: propertyB,
      }),
    GrowCommitmentValidationError,
  );
});

test("createApprovedGrowCommitment: rejects an opportunity that exists in the same brokerage but belongs to a different contact", async (t) => {
  const brokerageId = await createBrokerage("domain-opportunity-mismatch");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const partyA = await createParty(brokerageId, "Sarah");
  const partyB = await createParty(brokerageId, "Other Contact");
  const opportunityForB = await createOpportunity(brokerageId, partyB);

  await assert.rejects(
    () =>
      createApprovedGrowCommitment({
        brokerageId,
        createdBy: agentId,
        partyId: partyA,
        description: "Should never be created",
        dueAt: new Date().toISOString(),
        opportunityId: opportunityForB,
      }),
    (err: unknown) => {
      assert.ok(err instanceof GrowCommitmentValidationError);
      assert.match((err as Error).message, /does not belong to this contact/);
      return true;
    },
  );
});

test("createApprovedGrowCommitment: accepts a valid property and opportunity that both belong to the same contact and brokerage", async (t) => {
  const brokerageId = await createBrokerage("domain-valid-relations");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const partyId = await createParty(brokerageId, "Sarah");
  const propertyId = await createProperty(brokerageId, agentId);
  const opportunityId = await createOpportunity(brokerageId, partyId);

  const commitment = await createApprovedGrowCommitment({
    brokerageId,
    createdBy: agentId,
    partyId,
    description: "Prepare appraisal for Sarah",
    dueAt: new Date().toISOString(),
    propertyId,
    opportunityId,
  });

  assert.equal(commitment.propertyId, propertyId);
  assert.equal(commitment.opportunityId, opportunityId);
});

// ---------------------------------------------------------------------------
// 3. End-to-end governance: approval requirement, no double execution,
//    tamper protection, rejection.
// ---------------------------------------------------------------------------

test("end-to-end: execution before approval is refused (WRONG_STATUS), and approval then execution creates exactly one commitment", async (t) => {
  const brokerageId = await createBrokerage("e2e-approve-execute");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");
  const actor = actorOf(agentId, "Agent", brokerageId);

  const { request } = await proposeAIAction({
    actionKey: ACTION_KEY,
    actor,
    actorType: "AI",
    rawInput: { partyId, description: "Follow up with Sarah", dueAt: new Date().toISOString(), reason: "Overdue" },
  });
  assert.ok(request);
  assert.equal(request!.status, "AWAITING_APPROVAL");

  const premature = await executeAIAction(request!.id, brokerageId, actor);
  assert.equal(premature.ok, false);
  assert.equal(premature.reason, "WRONG_STATUS");

  const approval = await approveAIActionRequest(request!.id, brokerageId, actor);
  assert.equal(approval.ok, true);

  const executed = await executeAIAction(request!.id, brokerageId, actor);
  assert.equal(executed.ok, true);
  assert.equal(executed.request?.status, "COMPLETED");

  const commitments = await db.select().from(growCommitments).where(eq(growCommitments.partyId, partyId));
  assert.equal(commitments.length, 1);

  const second = await executeAIAction(request!.id, brokerageId, actor);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "WRONG_STATUS");

  const commitmentsAfterRetry = await db.select().from(growCommitments).where(eq(growCommitments.partyId, partyId));
  assert.equal(commitmentsAfterRetry.length, 1, "a duplicate execute must never create a second commitment");
});

test("end-to-end: rejection prevents execution and creates no commitment", async (t) => {
  const brokerageId = await createBrokerage("e2e-rejection");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");
  const actor = actorOf(agentId, "Agent", brokerageId);

  const { request } = await proposeAIAction({
    actionKey: ACTION_KEY,
    actor,
    actorType: "AI",
    rawInput: { partyId, description: "Follow up with Sarah", dueAt: new Date().toISOString(), reason: "Overdue" },
  });
  assert.ok(request);

  const rejection = await rejectAIActionRequest(request!.id, brokerageId, actor, "Not relevant right now");
  assert.equal(rejection.ok, true);

  const afterRejection = await getAIActionRequest(request!.id, brokerageId);
  assert.equal(afterRejection!.status, "REJECTED");

  const executeAttempt = await executeAIAction(request!.id, brokerageId, actor);
  assert.equal(executeAttempt.ok, false);

  const commitments = await db.select().from(growCommitments).where(eq(growCommitments.partyId, partyId));
  assert.equal(commitments.length, 0);
});

test("end-to-end: a payload altered after proposal is rejected at approval time, not silently approved", async (t) => {
  const brokerageId = await createBrokerage("e2e-tamper");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");
  const otherPartyId = await createParty(brokerageId, "SomeoneElse");
  const actor = actorOf(agentId, "Agent", brokerageId);

  const { request } = await proposeAIAction({
    actionKey: ACTION_KEY,
    actor,
    actorType: "AI",
    rawInput: { partyId, description: "Follow up with Sarah", dueAt: new Date().toISOString(), reason: "Overdue" },
  });
  assert.ok(request);

  await db
    .update(aiActionRequests)
    .set({ inputPayload: { ...(request!.inputPayload as Record<string, unknown>), partyId: otherPartyId } })
    .where(eq(aiActionRequests.id, request!.id));

  const approval = await approveAIActionRequest(request!.id, brokerageId, actor);
  assert.equal(approval.ok, false);
  assert.equal(approval.reason, "PAYLOAD_TAMPERED");

  const after = await getAIActionRequest(request!.id, brokerageId);
  assert.equal(after!.status, "REJECTED");
});

// ---------------------------------------------------------------------------
// 4. Orchestrator helpers: selectGrowCommitmentCandidate,
//    isReasonableCommitmentDueDate, proposeGrowCommitmentIfGrounded.
// ---------------------------------------------------------------------------

test("selectGrowCommitmentCandidate: null grow context, or no qualifying item, returns null (insufficient evidence stays ordinary text)", () => {
  assert.equal(selectGrowCommitmentCandidate(makeContext(1, 1, null)), null);
  assert.equal(selectGrowCommitmentCandidate(makeContext(1, 1, emptyGrowContext())), null);
  // A focused item with no dueAt is not concrete enough to ground a
  // dated commitment on.
  assert.equal(
    selectGrowCommitmentCandidate(makeContext(1, 1, emptyGrowContext({ focusedItem: makeCandidate({ dueAt: null }) }))),
    null,
  );
});

test("selectGrowCommitmentCandidate: priority order is focusedItem, then dueFollowUps[0], then appraisalFollowUps[0]", () => {
  const focused = makeCandidate({ id: "focused", dueAt: new Date().toISOString() });
  const dueFollowUp = makeCandidate({ id: "due", dueAt: new Date().toISOString() });
  const appraisalFollowUp = makeCandidate({ id: "appraisal", dueAt: new Date().toISOString() });

  assert.equal(
    selectGrowCommitmentCandidate(makeContext(1, 1, emptyGrowContext({ focusedItem: focused, dueFollowUps: [dueFollowUp] })))?.id,
    "focused",
  );
  assert.equal(
    selectGrowCommitmentCandidate(makeContext(1, 1, emptyGrowContext({ focusedItem: null, dueFollowUps: [dueFollowUp], appraisalFollowUps: [appraisalFollowUp] })))?.id,
    "due",
  );
  assert.equal(
    selectGrowCommitmentCandidate(makeContext(1, 1, emptyGrowContext({ focusedItem: null, dueFollowUps: [], appraisalFollowUps: [appraisalFollowUp] })))?.id,
    "appraisal",
  );
});

test("isReasonableCommitmentDueDate: a legitimately OVERDUE date within the sanity bound is NOT rejected - Grow Today surfacing an overdue follow-up is the expected case this feature exists to help with", () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const tenDaysOverdue = new Date("2026-06-05T00:00:00.000Z");
  assert.equal(isReasonableCommitmentDueDate(tenDaysOverdue, now), true);
});

test("isReasonableCommitmentDueDate: rejects a date far outside the sanity bound in either direction", () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const wayOverdue = new Date("2020-01-01T00:00:00.000Z");
  const wayInTheFuture = new Date("2035-01-01T00:00:00.000Z");
  assert.equal(isReasonableCommitmentDueDate(wayOverdue, now), false);
  assert.equal(isReasonableCommitmentDueDate(wayInTheFuture, now), false);
});

test("proposeGrowCommitmentIfGrounded: creates a real, tenant-scoped AWAITING_APPROVAL proposal from a grounded Grow Today candidate", async (t) => {
  const brokerageId = await createBrokerage("propose-grounded");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");

  const candidate = makeCandidate({
    partyId,
    contactName: "Sarah",
    dueAt: new Date().toISOString(),
    reason: "Appraisal follow-up due",
    recommendedAction: "Call Sarah about her appraisal",
  });
  const context = makeContext(brokerageId, agentId, emptyGrowContext({ focusedItem: candidate }));
  const actor = actorOf(agentId, "Agent", brokerageId);

  const summary = await proposeGrowCommitmentIfGrounded(context, actor, null);
  assert.ok(summary);
  assert.equal(summary!.actionKey, "CREATE_GROW_COMMITMENT");
  assert.equal(summary!.partyId, partyId);
  assert.equal(summary!.contactName, "Sarah");
  assert.equal(summary!.status, "AWAITING_APPROVAL");
  assert.equal(summary!.reviewUrl, "/grow");

  const stored = await getAIActionRequest(summary!.actionRequestId, brokerageId);
  assert.ok(stored);
  assert.equal(stored!.actorType, "AI");
  assert.equal(stored!.status, "AWAITING_APPROVAL");
});

test("proposeGrowCommitmentIfGrounded: a repeat call for the same contact and due date deduplicates instead of creating a second proposal", async (t) => {
  const brokerageId = await createBrokerage("propose-dedup");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");
  const dueAt = new Date().toISOString();

  const candidate = makeCandidate({ partyId, contactName: "Sarah", dueAt });
  const context = makeContext(brokerageId, agentId, emptyGrowContext({ focusedItem: candidate }));
  const actor = actorOf(agentId, "Agent", brokerageId);

  const first = await proposeGrowCommitmentIfGrounded(context, actor, null);
  const second = await proposeGrowCommitmentIfGrounded(context, actor, null);

  assert.ok(first);
  assert.ok(second);
  assert.equal(first!.actionRequestId, second!.actionRequestId, "a repeat call must return the SAME already-open proposal, not create a new one");

  const rows = await db
    .select()
    .from(aiActionRequests)
    .where(and(eq(aiActionRequests.brokerageId, brokerageId), eq(aiActionRequests.actionKey, ACTION_KEY)));
  assert.equal(rows.length, 1, "exactly one action request must exist for this contact+due-date, regardless of how many times it was asked about");
});

test("proposeGrowCommitmentIfGrounded: no grounded candidate returns undefined and creates no action request", async (t) => {
  const brokerageId = await createBrokerage("propose-no-candidate");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);

  const context = makeContext(brokerageId, agentId, emptyGrowContext());
  const actor = actorOf(agentId, "Agent", brokerageId);

  const summary = await proposeGrowCommitmentIfGrounded(context, actor, null);
  assert.equal(summary, undefined);

  const rows = await db.select().from(aiActionRequests).where(eq(aiActionRequests.brokerageId, brokerageId));
  assert.equal(rows.length, 0);
});

// ---------------------------------------------------------------------------
// 5. Tenant isolation for the new "list my pending proposals" read helper.
// ---------------------------------------------------------------------------

test("listAwaitingApprovalForUser: a proposal created in one brokerage is invisible to a user in another brokerage", async (t) => {
  const brokerageA = await createBrokerage("list-tenant-a");
  const brokerageB = await createBrokerage("list-tenant-b");
  t.after(() => Promise.all([cleanupBrokerage(brokerageA), cleanupBrokerage(brokerageB)]));
  const agentA = await createUser(brokerageA, "Agent");
  const agentB = await createUser(brokerageB, "Agent");
  await grantEntitlement(brokerageA);
  const partyA = await createParty(brokerageA, "Sarah");

  await proposeAIAction({
    actionKey: ACTION_KEY,
    actor: actorOf(agentA, "Agent", brokerageA),
    actorType: "AI",
    rawInput: { partyId: partyA, description: "Follow up with Sarah", dueAt: new Date().toISOString(), reason: "Overdue" },
  });

  const forOwner = await listAwaitingApprovalForUser(ACTION_KEY, brokerageA, agentA);
  assert.equal(forOwner.length, 1);

  const forOtherTenant = await listAwaitingApprovalForUser(ACTION_KEY, brokerageB, agentB);
  assert.equal(forOtherTenant.length, 0);

  const forOwnerUnderWrongBrokerage = await listAwaitingApprovalForUser(ACTION_KEY, brokerageB, agentA);
  assert.equal(forOwnerUnderWrongBrokerage.length, 0, "the same user id under a different brokerageId must see nothing");
});

test("findOpenActionRequestByResource: only matches AWAITING_APPROVAL/APPROVED/EXECUTING, never a rejected request", async (t) => {
  const brokerageId = await createBrokerage("find-open-excludes-rejected");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");
  const actor = actorOf(agentId, "Agent", brokerageId);
  const resourceId = `party:${partyId}:due:2026-06-15`;

  const { request } = await proposeAIAction({
    actionKey: ACTION_KEY,
    actor,
    actorType: "AI",
    rawInput: { partyId, description: "Follow up with Sarah", dueAt: new Date("2026-06-15T00:00:00.000Z").toISOString(), reason: "Overdue" },
    resourceId,
  });
  assert.ok(request);

  const beforeRejection = await findOpenActionRequestByResource(ACTION_KEY, brokerageId, resourceId);
  assert.ok(beforeRejection);

  await rejectAIActionRequest(request!.id, brokerageId, actor, "not needed");

  const afterRejection = await findOpenActionRequestByResource(ACTION_KEY, brokerageId, resourceId);
  assert.equal(afterRejection, null, "a rejected request must never be treated as 'still open' for dedup purposes");
});

// ---------------------------------------------------------------------------
// 6. Concurrency, expiry, cross-tenant execution, entitlement inheritance
//    and revocation, approver authority ("AI self-approval"), and replay -
//    the remaining security-test-matrix scenarios not yet covered above.
// ---------------------------------------------------------------------------

test("approveAIActionRequest: two concurrent approval attempts race safely - exactly one succeeds, never both", async (t) => {
  const brokerageId = await createBrokerage("concurrent-approval");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");
  const actor = actorOf(agentId, "Agent", brokerageId);

  const { request } = await proposeAIAction({
    actionKey: ACTION_KEY,
    actor,
    actorType: "AI",
    rawInput: { partyId, description: "Follow up with Sarah", dueAt: new Date().toISOString(), reason: "Overdue" },
  });
  assert.ok(request);

  const [first, second] = await Promise.all([
    approveAIActionRequest(request!.id, brokerageId, actor),
    approveAIActionRequest(request!.id, brokerageId, actor),
  ]);

  const succeeded = [first, second].filter((r) => r.ok);
  assert.equal(succeeded.length, 1, "exactly one of the two concurrent approval attempts must succeed");

  const final = await getAIActionRequest(request!.id, brokerageId);
  assert.equal(final!.status, "APPROVED");
});

test("approveAIActionRequest: an expired proposal cannot be approved and flips to EXPIRED, not silently approved", async (t) => {
  const brokerageId = await createBrokerage("expiry-blocks-approval");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");
  const actor = actorOf(agentId, "Agent", brokerageId);

  const { request } = await proposeAIAction({
    actionKey: ACTION_KEY,
    actor,
    actorType: "AI",
    rawInput: { partyId, description: "Follow up with Sarah", dueAt: new Date().toISOString(), reason: "Overdue" },
  });
  assert.ok(request);

  await db.update(aiActionRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(aiActionRequests.id, request!.id));

  const approval = await approveAIActionRequest(request!.id, brokerageId, actor);
  assert.equal(approval.ok, false);
  assert.equal(approval.reason, "EXPIRED");

  const after = await getAIActionRequest(request!.id, brokerageId);
  assert.equal(after!.status, "EXPIRED");

  const stillCannotApprove = await approveAIActionRequest(request!.id, brokerageId, actor);
  assert.equal(stillCannotApprove.ok, false);
  assert.equal(stillCannotApprove.reason, "WRONG_STATUS", "once flipped to EXPIRED, a second approval attempt is a status mismatch, not another EXPIRED result");
});

test("executeAIAction: a proposal that expires after approval but before execution cannot be executed, and creates no commitment", async (t) => {
  const brokerageId = await createBrokerage("expiry-blocks-execution");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");
  const actor = actorOf(agentId, "Agent", brokerageId);

  const { request } = await proposeAIAction({
    actionKey: ACTION_KEY,
    actor,
    actorType: "AI",
    rawInput: { partyId, description: "Follow up with Sarah", dueAt: new Date().toISOString(), reason: "Overdue" },
  });
  assert.ok(request);

  const approval = await approveAIActionRequest(request!.id, brokerageId, actor);
  assert.equal(approval.ok, true);

  await db.update(aiActionRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(aiActionRequests.id, request!.id));

  const execution = await executeAIAction(request!.id, brokerageId, actor);
  assert.equal(execution.ok, false);
  assert.equal(execution.reason, "EXPIRED");

  const commitments = await db.select().from(growCommitments).where(eq(growCommitments.partyId, partyId));
  assert.equal(commitments.length, 0, "an execution blocked by expiry must never create a commitment");
});

test("cross-tenant: approve/reject/execute against a foreign brokerage's request id all return NOT_FOUND, never a status that would disclose the request exists", async (t) => {
  const brokerageA = await createBrokerage("cross-tenant-action-a");
  const brokerageB = await createBrokerage("cross-tenant-action-b");
  t.after(() => Promise.all([cleanupBrokerage(brokerageA), cleanupBrokerage(brokerageB)]));
  const agentA = await createUser(brokerageA, "Agent");
  const agentB = await createUser(brokerageB, "Agent");
  await grantEntitlement(brokerageA);
  await grantEntitlement(brokerageB);
  const partyA = await createParty(brokerageA, "Sarah");
  const actorA = actorOf(agentA, "Agent", brokerageA);
  const actorB = actorOf(agentB, "Agent", brokerageB);

  const { request } = await proposeAIAction({
    actionKey: ACTION_KEY,
    actor: actorA,
    actorType: "AI",
    rawInput: { partyId: partyA, description: "Follow up with Sarah", dueAt: new Date().toISOString(), reason: "Overdue" },
  });
  assert.ok(request);

  const foreignApprove = await approveAIActionRequest(request!.id, brokerageB, actorB);
  assert.equal(foreignApprove.ok, false);
  assert.equal(foreignApprove.reason, "NOT_FOUND");

  const foreignReject = await rejectAIActionRequest(request!.id, brokerageB, actorB, "not mine");
  assert.equal(foreignReject.ok, false);
  assert.equal(foreignReject.reason, "NOT_FOUND");

  const foreignExecute = await executeAIAction(request!.id, brokerageB, actorB);
  assert.equal(foreignExecute.ok, false);
  assert.equal(foreignExecute.reason, "NOT_FOUND");

  // None of the foreign attempts above altered the request - its real
  // owner can still approve it afterwards.
  const legitimateApprove = await approveAIActionRequest(request!.id, brokerageA, actorA);
  assert.equal(legitimateApprove.ok, true);
});

test("PRO/Scale bundle subscription grants grow.activities.manage via the real subscription mechanism (applySubscriptionSnapshot), not a manual grant", async (t) => {
  const brokerageId = await createBrokerage("pro-bundle-inheritance");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const partyId = await createParty(brokerageId, "Sarah");
  const actor = actorOf(agentId, "Agent", brokerageId);

  await ensureCatalogueSeeded();
  await applySubscriptionSnapshot(
    {
      subscriptionRef: `test-sub-bundle-${brokerageId}`,
      customerRef: `test-cus-bundle-${brokerageId}`,
      status: "Active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: false,
      productCode: BUNDLE_PRODUCT_CODE,
      brokerageId,
    },
    { actorType: "SYSTEM", actorId: null, label: "test:stage-d-pro-bundle" },
  );

  assert.equal(await hasEntitlement(actor, ENTITLEMENT_KEY), true);

  const [grant] = await db
    .select()
    .from(entitlementGrants)
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, ENTITLEMENT_KEY)));
  assert.ok(grant);
  assert.equal(grant.sourceType, "subscription", "the grant must be attributed to the subscription, not a manual override, for this to be a genuine inheritance test");

  const { request, decision } = await proposeAIAction({
    actionKey: ACTION_KEY,
    actor,
    actorType: "AI",
    rawInput: { partyId, description: "Follow up with Sarah", dueAt: new Date().toISOString(), reason: "Overdue" },
  });
  assert.equal(decision.allowed, true);
  assert.ok(request);
});

test("revoking the entitlement between approval and execution denies execution at the mandatory pre-execution policy re-check, and creates no commitment", async (t) => {
  const brokerageId = await createBrokerage("revoked-mid-flight");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");
  const actor = actorOf(agentId, "Agent", brokerageId);

  const { request } = await proposeAIAction({
    actionKey: ACTION_KEY,
    actor,
    actorType: "AI",
    rawInput: { partyId, description: "Follow up with Sarah", dueAt: new Date().toISOString(), reason: "Overdue" },
  });
  assert.ok(request);

  const approval = await approveAIActionRequest(request!.id, brokerageId, actor);
  assert.equal(approval.ok, true);

  // Revoke the entitlement the way a real revocation appears to the
  // resolver - flip the grant's own status, never delete the row.
  await db
    .update(entitlementGrants)
    .set({ status: "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, ENTITLEMENT_KEY)));
  invalidateEntitlementCache(brokerageId);

  const execution = await executeAIAction(request!.id, brokerageId, actor);
  assert.equal(execution.ok, false);
  assert.equal(execution.reason, "POLICY_DENIED");
  assert.equal(execution.policyReason, "ENTITLEMENT_DENIED");

  const after = await getAIActionRequest(request!.id, brokerageId);
  assert.equal(after!.status, "FAILED");

  const commitments = await db.select().from(growCommitments).where(eq(growCommitments.partyId, partyId));
  assert.equal(commitments.length, 0);
});

test("approveAIActionRequest enforces the Golden Rule on the approver too, standing in for an AI self-approval attempt - a role that could never create commitments manually cannot approve this proposal either", async (t) => {
  const brokerageId = await createBrokerage("approver-role-forbidden");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");

  const { request } = await proposeAIAction({
    actionKey: ACTION_KEY,
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "AI",
    rawInput: { partyId, description: "Follow up with Sarah", dueAt: new Date().toISOString(), reason: "Overdue" },
  });
  assert.ok(request);

  // No human role is ever "AI" - this stands in for an AI actor attempting
  // to approve its own proposal directly against approveAIActionRequest(),
  // bypassing the fact that routes/ai-actions.ts never accepts actorType
  // "AI" from a client in the first place (see that file's own header
  // comment). If this call succeeded, AI self-approval would be possible;
  // it must not.
  const impossibleApprover = actorOf(agentId, "AI", brokerageId);
  const approval = await approveAIActionRequest(request!.id, brokerageId, impossibleApprover);
  assert.equal(approval.ok, false);
  assert.equal(approval.reason, "APPROVER_ROLE_FORBIDDEN");

  const after = await getAIActionRequest(request!.id, brokerageId);
  assert.equal(after!.status, "AWAITING_APPROVAL", "a forbidden approval attempt must not change the request's status");
});

test("rejectAIActionRequest: a request that has already been approved can no longer be rejected", async (t) => {
  const brokerageId = await createBrokerage("reject-after-approved");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");
  const actor = actorOf(agentId, "Agent", brokerageId);

  const { request } = await proposeAIAction({
    actionKey: ACTION_KEY,
    actor,
    actorType: "AI",
    rawInput: { partyId, description: "Follow up with Sarah", dueAt: new Date().toISOString(), reason: "Overdue" },
  });
  assert.ok(request);

  const approval = await approveAIActionRequest(request!.id, brokerageId, actor);
  assert.equal(approval.ok, true);

  const rejection = await rejectAIActionRequest(request!.id, brokerageId, actor, "changed my mind");
  assert.equal(rejection.ok, false);
  assert.equal(rejection.reason, "WRONG_STATUS");

  const after = await getAIActionRequest(request!.id, brokerageId);
  assert.equal(after!.status, "APPROVED", "an already-approved request must remain APPROVED, not flip to REJECTED via a late reject call");
});

test("approveAIActionRequest: replaying approval against an already-APPROVED request is refused as a status mismatch, not processed as a second approval", async (t) => {
  const brokerageId = await createBrokerage("replay-approval");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");
  const actor = actorOf(agentId, "Agent", brokerageId);

  const { request } = await proposeAIAction({
    actionKey: ACTION_KEY,
    actor,
    actorType: "AI",
    rawInput: { partyId, description: "Follow up with Sarah", dueAt: new Date().toISOString(), reason: "Overdue" },
  });
  assert.ok(request);

  const first = await approveAIActionRequest(request!.id, brokerageId, actor);
  assert.equal(first.ok, true);

  const replay = await approveAIActionRequest(request!.id, brokerageId, actor);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "WRONG_STATUS");
});

// ---------------------------------------------------------------------------
// AE GROW Priority 6 Stage F4.0 — governance hardening (D2/D4) for the
// CREATE_GROW_COMMITMENT flow.
// ---------------------------------------------------------------------------

async function grantUserEntitlement(brokerageId: number, userId: number): Promise<void> {
  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey: ENTITLEMENT_KEY,
    granteeType: "user",
    granteeId: userId,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerageId);
}

async function revokeUserEntitlement(brokerageId: number, userId: number): Promise<void> {
  await db
    .update(entitlementGrants)
    .set({ status: "Revoked" })
    .where(
      and(
        eq(entitlementGrants.brokerageId, brokerageId),
        eq(entitlementGrants.entitlementKey, ENTITLEMENT_KEY),
        eq(entitlementGrants.granteeType, "user"),
        eq(entitlementGrants.granteeId, userId),
      ),
    );
  invalidateEntitlementCache(brokerageId);
}

function commitmentInput(partyId: number, description = "Follow up with Sarah") {
  return { partyId, description, dueAt: new Date().toISOString(), reason: "Overdue" };
}

test("F4.0: a same-brokerage colleague (not requester, not admin) cannot read, list, approve, reject, or execute a proposal; an entitled admin can approve and execute it, and the requester who did not approve it cannot execute", async (t) => {
  const brokerageId = await createBrokerage("f4-colleague-matrix");
  t.after(() => cleanupBrokerage(brokerageId));
  const requesterId = await createUser(brokerageId, "Agent");
  const colleagueId = await createUser(brokerageId, "Agent");
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");
  const requester = actorOf(requesterId, "Agent", brokerageId);
  const colleague = actorOf(colleagueId, "Agent", brokerageId);
  const admin = actorOf(adminId, "Brokerage Administrator", brokerageId);

  const { request } = await proposeAIAction({ actionKey: ACTION_KEY, actor: requester, actorType: "AI", rawInput: commitmentInput(partyId) });
  assert.ok(request);

  assert.equal(await getAIActionRequestForActor(request!.id, colleague), null);
  assert.equal((await listAwaitingApprovalForUser(ACTION_KEY, brokerageId, colleagueId)).length, 0);
  assert.equal((await approveAIActionRequest(request!.id, brokerageId, colleague)).reason, "NOT_FOUND");
  assert.equal((await rejectAIActionRequest(request!.id, brokerageId, colleague, "not mine")).reason, "NOT_FOUND");
  assert.equal((await getAIActionRequest(request!.id, brokerageId))!.status, "AWAITING_APPROVAL");

  const approval = await approveAIActionRequest(request!.id, brokerageId, admin);
  assert.equal(approval.ok, true);

  assert.equal((await executeAIAction(request!.id, brokerageId, colleague)).reason, "NOT_FOUND");
  assert.equal((await executeAIAction(request!.id, brokerageId, requester)).reason, "EXECUTOR_NOT_AUTHORISED");
  assert.equal((await getAIActionRequest(request!.id, brokerageId))!.status, "APPROVED", "denied executors never change state");

  const executed = await executeAIAction(request!.id, brokerageId, admin);
  assert.equal(executed.ok, true, JSON.stringify(executed));
  const commitments = await db.select().from(growCommitments).where(eq(growCommitments.partyId, partyId));
  assert.equal(commitments.length, 1);
});

test("F4.0: an approver or rejector without grow.activities.manage is denied (ENTITLEMENT_DENIED) and the proposal stays AWAITING_APPROVAL", async (t) => {
  const brokerageId = await createBrokerage("f4-approver-entitlement");
  t.after(() => cleanupBrokerage(brokerageId));
  const requesterId = await createUser(brokerageId, "Agent");
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  await grantUserEntitlement(brokerageId, requesterId); // the admin holds NO grant
  const partyId = await createParty(brokerageId, "Sarah");
  const requester = actorOf(requesterId, "Agent", brokerageId);
  const admin = actorOf(adminId, "Brokerage Administrator", brokerageId);

  const { request } = await proposeAIAction({ actionKey: ACTION_KEY, actor: requester, actorType: "AI", rawInput: commitmentInput(partyId) });
  assert.ok(request);

  assert.equal((await approveAIActionRequest(request!.id, brokerageId, admin)).reason, "ENTITLEMENT_DENIED");
  assert.equal((await rejectAIActionRequest(request!.id, brokerageId, admin, "no")).reason, "ENTITLEMENT_DENIED");
  assert.equal((await getAIActionRequest(request!.id, brokerageId))!.status, "AWAITING_APPROVAL");

  // The requester's own entitlement lapses: they can no longer decide it either.
  await revokeUserEntitlement(brokerageId, requesterId);
  assert.equal((await approveAIActionRequest(request!.id, brokerageId, requester)).reason, "ENTITLEMENT_DENIED");
  assert.equal((await rejectAIActionRequest(request!.id, brokerageId, requester, "no")).reason, "ENTITLEMENT_DENIED");
  assert.equal((await getAIActionRequest(request!.id, brokerageId))!.status, "AWAITING_APPROVAL");
});

test("F4.0: the executor's own entitlement is re-checked - revoking the approving admin's grant between approval and execution denies that admin, creates no commitment, and leaves the request APPROVED", async (t) => {
  const brokerageId = await createBrokerage("f4-executor-entitlement");
  t.after(() => cleanupBrokerage(brokerageId));
  const requesterId = await createUser(brokerageId, "Agent");
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  await grantUserEntitlement(brokerageId, requesterId);
  await grantUserEntitlement(brokerageId, adminId);
  const partyId = await createParty(brokerageId, "Sarah");
  const admin = actorOf(adminId, "Brokerage Administrator", brokerageId);

  const { request } = await proposeAIAction({
    actionKey: ACTION_KEY,
    actor: actorOf(requesterId, "Agent", brokerageId),
    actorType: "AI",
    rawInput: commitmentInput(partyId),
  });
  assert.equal((await approveAIActionRequest(request!.id, brokerageId, admin)).ok, true);

  await revokeUserEntitlement(brokerageId, adminId);
  const execution = await executeAIAction(request!.id, brokerageId, admin);
  assert.equal(execution.ok, false);
  assert.equal(execution.reason, "ENTITLEMENT_DENIED");
  assert.equal((await getAIActionRequest(request!.id, brokerageId))!.status, "APPROVED");
  const commitments = await db.select().from(growCommitments).where(eq(growCommitments.partyId, partyId));
  assert.equal(commitments.length, 0);
});

test("F4.0 expiry: an expired proposal is transitioned to EXPIRED, excluded from the pending list and from dedup, and a new proposal for the same resource can then be created", async (t) => {
  const brokerageId = await createBrokerage("f4-expiry-dedup");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");
  const actor = actorOf(agentId, "Agent", brokerageId);
  const resourceId = `party:${partyId}:due:2026-01-01`;

  const first = await proposeAIAction({ actionKey: ACTION_KEY, actor, actorType: "AI", rawInput: commitmentInput(partyId), resourceId });
  assert.ok(first.request);
  assert.equal((await findOpenActionRequestByResource(ACTION_KEY, brokerageId, resourceId))!.id, first.request!.id);

  await db.update(aiActionRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(aiActionRequests.id, first.request!.id));

  const pending = await listAwaitingApprovalForUser(ACTION_KEY, brokerageId, agentId);
  assert.equal(pending.length, 0, "an expired proposal must never be listed as pending");
  assert.equal(await findOpenActionRequestByResource(ACTION_KEY, brokerageId, resourceId), null, "an expired proposal must never block dedup");
  assert.equal((await getAIActionRequest(first.request!.id, brokerageId))!.status, "EXPIRED");

  const second = await proposeAIAction({ actionKey: ACTION_KEY, actor, actorType: "AI", rawInput: commitmentInput(partyId), resourceId });
  assert.ok(second.request);
  assert.notEqual(second.request!.id, first.request!.id);
  assert.equal(second.deduplicated, undefined);
  assert.equal((await findOpenActionRequestByResource(ACTION_KEY, brokerageId, resourceId))!.id, second.request!.id);
});

test("F4.0 expiry: proposing directly for a resource whose open request has expired (but was never transitioned) frees the slot instead of hitting the unique index", async (t) => {
  const brokerageId = await createBrokerage("f4-expiry-insert");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");
  const actor = actorOf(agentId, "Agent", brokerageId);
  const resourceId = `party:${partyId}:due:2026-02-02`;

  const first = await proposeAIAction({ actionKey: ACTION_KEY, actor, actorType: "AI", rawInput: commitmentInput(partyId), resourceId });
  await db.update(aiActionRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(aiActionRequests.id, first.request!.id));

  const second = await proposeAIAction({ actionKey: ACTION_KEY, actor, actorType: "AI", rawInput: commitmentInput(partyId), resourceId });
  assert.ok(second.request);
  assert.notEqual(second.request!.id, first.request!.id);
  assert.equal((await getAIActionRequest(first.request!.id, brokerageId))!.status, "EXPIRED");
});

test("F4.0 dedup: concurrent proposals for the same resource produce exactly one open request (DB-level partial unique index), every caller gets that request back", async (t) => {
  const brokerageId = await createBrokerage("f4-concurrent-dedup");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");
  const actor = actorOf(agentId, "Agent", brokerageId);
  const resourceId = `party:${partyId}:due:2026-03-03`;

  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      proposeAIAction({ actionKey: ACTION_KEY, actor, actorType: "AI", rawInput: commitmentInput(partyId), resourceId }),
    ),
  );
  const ids = new Set(results.map((r) => r.request?.id));
  assert.equal(ids.size, 1, "every concurrent caller must resolve to the same single open request");
  assert.ok(results.every((r) => r.request !== null));
  // proposeAIAction() itself does no pre-insert lookup, so every loser of
  // the race genuinely hit the unique index and was resolved to the winner.
  assert.equal(results.filter((r) => r.deduplicated === true).length, results.length - 1);

  const open = await db
    .select()
    .from(aiActionRequests)
    .where(and(eq(aiActionRequests.brokerageId, brokerageId), eq(aiActionRequests.resourceId, resourceId)));
  assert.equal(open.length, 1);

  // The index itself (not just the application check) rejects a second
  // open row for the same slot.
  const { id: _id, createdAt: _c, updatedAt: _u, ...clone } = open[0];
  await assert.rejects(
    () => db.insert(aiActionRequests).values(clone),
    (err: any) => {
      const pgErr = err?.cause ?? err;
      assert.equal(pgErr?.code, "23505");
      assert.equal(pgErr?.constraint, OPEN_GROW_COMMITMENT_RESOURCE_UNIQUE_INDEX);
      return true;
    },
  );
  // ...but a closed (REJECTED) row for the same slot is allowed.
  await db.insert(aiActionRequests).values({ ...clone, status: "REJECTED" });
});

test("F4.0 system path: executeAIActionAsSystem refuses an approved CREATE_GROW_COMMITMENT (AI-originated, human-approval-required) and creates no commitment", async (t) => {
  const brokerageId = await createBrokerage("f4-system-path-refuses-grow");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");
  const actor = actorOf(agentId, "Agent", brokerageId);

  const { request } = await proposeAIAction({ actionKey: ACTION_KEY, actor, actorType: "AI", rawInput: commitmentInput(partyId) });
  assert.equal((await executeAIActionAsSystem(request!.id, brokerageId)).reason, "SYSTEM_PATH_FORBIDDEN");
  assert.equal((await approveAIActionRequest(request!.id, brokerageId, actor)).ok, true);
  assert.equal((await executeAIActionAsSystem(request!.id, brokerageId)).reason, "SYSTEM_PATH_FORBIDDEN");

  // Even relabelled as SYSTEM in the DB it stays approval-required, so still refused.
  await db.update(aiActionRequests).set({ actorType: "SYSTEM" }).where(eq(aiActionRequests.id, request!.id));
  assert.equal((await executeAIActionAsSystem(request!.id, brokerageId)).reason, "SYSTEM_PATH_FORBIDDEN");

  assert.equal((await getAIActionRequest(request!.id, brokerageId))!.status, "APPROVED");
  const commitments = await db.select().from(growCommitments).where(eq(growCommitments.partyId, partyId));
  assert.equal(commitments.length, 0);
});
