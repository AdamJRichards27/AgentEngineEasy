// AE GROW Pilot Readiness WP6a (D7) — Ask AE / Business Coach must not
// re-propose a follow-up that has already been created.
//
// proposeGrowCommitmentIfGrounded() deduplicated against
// findOpenActionRequestByResource(), which by design only sees OPEN requests
// (AWAITING_APPROVAL / APPROVED / EXECUTING). Once the agent approved a
// proposal and the Execution Gateway ran it, the request moved to COMPLETED
// and the commitment existed — but it had also left the set the dedup check
// looks at, so the very next question re-derived the same Grow Today candidate
// and proposed the identical follow-up again.
//
// The dedup must widen to COMPLETED only: a request that was rejected,
// expired, cancelled or failed represents a follow-up that was NOT created,
// and must still allow a fresh proposal.
//
// Fixture conventions (throwaway brokerage per test, torn down in t.after())
// follow lib/ai/__tests__/growCommitmentAction.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  brokerages,
  users,
  parties,
  growCommitments,
  aiActionRequests,
  entitlementGrants,
  type UserRole,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../entitlements/resolver.js";
import type { PolicyActor } from "../policyEngine.js";
import { approveAIActionRequest, rejectAIActionRequest } from "../actionRequests.js";
import { executeAIAction } from "../executionGateway.js";
import { proposeGrowCommitmentIfGrounded } from "../orchestrator.js";
import type { AiContextPackage, GrowTodayItemView } from "../types.js";

const ACTION_KEY = "CREATE_GROW_COMMITMENT";
const ENTITLEMENT_KEY = "grow.activities.manage";

async function createBrokerage(tag: string): Promise<number> {
  const [row] = await db.insert(brokerages).values({ name: `WP6a D7 - ${tag} (${randomUUID()})` }).returning();
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
  await db.delete(parties).where(eq(parties.brokerageId, brokerageId));
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
    dueCommitments: [],
    appraisalFollowUps: [],
    activeSignals: [],
    opportunityPipeline: [],
    recentActivity: [],
    ...overrides,
  };
}

/** One throwaway brokerage, entitled agent, party and a grounded Grow Today candidate. */
async function scenario(tag: string) {
  const brokerageId = await createBrokerage(tag);
  const agentId = await createUser(brokerageId, "Agent");
  await grantEntitlement(brokerageId);
  const partyId = await createParty(brokerageId, "Sarah");
  const dueAt = new Date().toISOString();
  const context = makeContext(
    brokerageId,
    agentId,
    emptyGrowContext({ focusedItem: makeCandidate({ partyId, contactName: "Sarah", dueAt }) }),
  );
  return { brokerageId, agentId, partyId, context, actor: actorOf(agentId, "Agent", brokerageId) };
}

async function requestsFor(brokerageId: number) {
  return db
    .select()
    .from(aiActionRequests)
    .where(and(eq(aiActionRequests.brokerageId, brokerageId), eq(aiActionRequests.actionKey, ACTION_KEY)));
}

// ---------------------------------------------------------------------
// The defect.
// ---------------------------------------------------------------------

test("after approve + execute, asking again proposes nothing new", async (t) => {
  const { brokerageId, partyId, context, actor } = await scenario("completed-dedup");
  t.after(() => cleanupBrokerage(brokerageId));

  const proposal = await proposeGrowCommitmentIfGrounded(context, actor, null);
  assert.ok(proposal, "the first ask must propose the follow-up");

  assert.equal((await approveAIActionRequest(proposal!.actionRequestId, brokerageId, actor)).ok, true);
  const executed = await executeAIAction(proposal!.actionRequestId, brokerageId, actor);
  assert.equal(executed.ok, true);
  assert.equal(executed.request?.status, "COMPLETED", "the request must really be COMPLETED, not merely approved");

  const commitments = await db.select().from(growCommitments).where(eq(growCommitments.partyId, partyId));
  assert.equal(commitments.length, 1, "the commitment now exists — which is exactly why it must not be proposed again");

  // The next Ask AE / Business Coach question re-derives the same candidate.
  const repeat = await proposeGrowCommitmentIfGrounded(context, actor, null);
  assert.equal(repeat, undefined, "a follow-up that has already been created must not be proposed a second time");

  // And asking repeatedly does not accumulate anything either.
  assert.equal(await proposeGrowCommitmentIfGrounded(context, actor, null), undefined);

  const rows = await requestsFor(brokerageId);
  assert.equal(rows.length, 1, "no new action request may be created once the commitment exists");
  assert.equal(rows[0]!.status, "COMPLETED");

  const commitmentsAfter = await db.select().from(growCommitments).where(eq(growCommitments.partyId, partyId));
  assert.equal(commitmentsAfter.length, 1, "and certainly no second commitment");
});

// ---------------------------------------------------------------------
// Dedup must not be widened past the one case that was wrong.
// ---------------------------------------------------------------------

test("a rejected proposal still allows a fresh one — the follow-up was never created", async (t) => {
  const { brokerageId, context, actor } = await scenario("rejected-reproposes");
  t.after(() => cleanupBrokerage(brokerageId));

  const first = await proposeGrowCommitmentIfGrounded(context, actor, null);
  assert.ok(first);
  assert.equal((await rejectAIActionRequest(first!.actionRequestId, brokerageId, actor, "Not now")).ok, true);

  const second = await proposeGrowCommitmentIfGrounded(context, actor, null);
  assert.ok(second, "declining a proposal must not permanently suppress the follow-up");
  assert.notEqual(second!.actionRequestId, first!.actionRequestId, "the fresh proposal must be a new request, not the rejected one");

  const rows = await requestsFor(brokerageId);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.status).sort(),
    ["AWAITING_APPROVAL", "REJECTED"],
  );
});

test("an expired proposal still allows a fresh one", async (t) => {
  const { brokerageId, context, actor } = await scenario("expired-reproposes");
  t.after(() => cleanupBrokerage(brokerageId));

  const first = await proposeGrowCommitmentIfGrounded(context, actor, null);
  assert.ok(first);
  await db
    .update(aiActionRequests)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(aiActionRequests.id, first!.actionRequestId));

  const second = await proposeGrowCommitmentIfGrounded(context, actor, null);
  assert.ok(second, "an expired proposal was never actioned, so the follow-up is still outstanding");
  assert.notEqual(second!.actionRequestId, first!.actionRequestId);

  const [expired] = await db.select().from(aiActionRequests).where(eq(aiActionRequests.id, first!.actionRequestId));
  assert.equal(expired!.status, "EXPIRED");
});

test("an open proposal is still surfaced rather than duplicated", async (t) => {
  // The pre-existing OPEN dedup must be untouched by the COMPLETED check.
  const { brokerageId, context, actor } = await scenario("open-unchanged");
  t.after(() => cleanupBrokerage(brokerageId));

  const first = await proposeGrowCommitmentIfGrounded(context, actor, null);
  const second = await proposeGrowCommitmentIfGrounded(context, actor, null);
  assert.ok(first);
  assert.ok(second);
  assert.equal(second!.actionRequestId, first!.actionRequestId);
  assert.equal((await requestsFor(brokerageId)).length, 1);
});

test("the COMPLETED check is scoped to the same resource — a different contact is unaffected", async (t) => {
  const { brokerageId, agentId, context, actor } = await scenario("other-resource");
  t.after(() => cleanupBrokerage(brokerageId));

  const proposal = await proposeGrowCommitmentIfGrounded(context, actor, null);
  assert.ok(proposal);
  assert.equal((await approveAIActionRequest(proposal!.actionRequestId, brokerageId, actor)).ok, true);
  assert.equal((await executeAIAction(proposal!.actionRequestId, brokerageId, actor)).ok, true);

  // A different contact in the same brokerage, same due date: an entirely
  // different resourceId, and therefore still proposable.
  const otherPartyId = await createParty(brokerageId, "Daniel");
  const otherContext = makeContext(
    brokerageId,
    agentId,
    emptyGrowContext({ focusedItem: makeCandidate({ partyId: otherPartyId, contactName: "Daniel", dueAt: new Date().toISOString() }) }),
  );
  const other = await proposeGrowCommitmentIfGrounded(otherContext, actor, null);
  assert.ok(other, "completing one contact's follow-up must not suppress another contact's");
  assert.equal(other!.partyId, otherPartyId);
});

test("the COMPLETED check is tenant-scoped — another brokerage's completed request never suppresses a proposal", async (t) => {
  const a = await scenario("tenant-a");
  const b = await scenario("tenant-b");
  t.after(() => Promise.all([cleanupBrokerage(a.brokerageId), cleanupBrokerage(b.brokerageId)]));

  const proposalA = await proposeGrowCommitmentIfGrounded(a.context, a.actor, null);
  assert.ok(proposalA);
  assert.equal((await approveAIActionRequest(proposalA!.actionRequestId, a.brokerageId, a.actor)).ok, true);
  assert.equal((await executeAIAction(proposalA!.actionRequestId, a.brokerageId, a.actor)).ok, true);

  const proposalB = await proposeGrowCommitmentIfGrounded(b.context, b.actor, null);
  assert.ok(proposalB, "Brokerage B must be completely unaffected by Brokerage A's completed request");
});
