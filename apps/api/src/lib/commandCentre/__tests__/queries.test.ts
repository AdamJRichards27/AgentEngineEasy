import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { db, transactionConditions, riskExceptions, type UserRole } from "@aee/db";
import { getCommandCentre } from "../queries.js";
import type { ActionItem } from "../types.js";
import { canViewFinancials, restrictedPropertyIdsFor } from "../../../routes/exceptions.js";
import {
  createBrokerageWithUsers,
  createTransactionFromListedProperty,
  devLogin,
  cleanupBrokerages,
  type DevLoginResult,
} from "../../../routes/__tests__/testSupport.js";

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
let agent2: DevLoginResult;

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { registerExceptionEngine } = await import("../../exceptions/bootstrap.js");
  registerExceptionEngine({ startScheduler: false });
  const { registerLaunchEngine } = await import("../../launch/bootstrap.js");
  registerLaunchEngine();
  const { createApp } = await import("../../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `Command Centre A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Command Centre B ${suffix}`);
  // A second Agent in A's brokerage (dev-login only makes the *first* user in a
  // brokerage a Brokerage Administrator -- every later one is an Agent), so agent
  // scoping can be tested between two agents who both belong to brokerage A.
  agent2 = await devLogin(baseUrl, {
    email: `cc-agent2-${suffix}@example.com`,
    firstName: "Second",
    lastName: "Agent",
    brokerageName: `Command Centre A ${suffix}`,
  });
});

after(async () => {
  const ids = [A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number");
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

/** Builds the same (actor, opts) shape the real /api/command-centre route builds for `login`. */
async function actorAndOptsFor(login: DevLoginResult, now: Date) {
  const authedUser = { id: login.user.id, role: login.user.role as UserRole, brokerageId: login.user.brokerageId };
  const restrictToPropertyIds = await restrictedPropertyIdsFor(authedUser);
  return {
    actor: { id: authedUser.id, role: authedUser.role, brokerageId: authedUser.brokerageId, firstName: login.user.firstName },
    opts: { now, canViewFinancials: canViewFinancials(authedUser), restrictToPropertyIds },
  };
}

/**
 * Flattens every section into one list, deduplicated by id. `now` is an
 * intentional cross-cutting priority view (P0/P1 items regardless of
 * section), so a single item can legitimately appear in both `now` and e.g.
 * `today` -- this helper collapses that back down for "does this source
 * appear anywhere, and how many distinct rows" assertions.
 */
function allItems(result: Awaited<ReturnType<typeof getCommandCentre>>): ActionItem[] {
  const combined = [
    ...result.now,
    ...result.today,
    ...result.overdue,
    ...result.waitingOn,
    ...result.comingUp,
    ...result.completedToday,
  ];
  const seen = new Set<string>();
  return combined.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

describe("getCommandCentre -- scoping, dedup, and cross-tenant isolation", () => {
  let propertyId: number;
  let transactionId: number;
  let conditionId: number;
  let now: Date;

  before(async () => {
    now = new Date();
    const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
      address: `1 Command Centre Test St ${suffix}`,
    });
    propertyId = created.propertyId;
    transactionId = created.transactionId;
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const [cond] = await db
      .insert(transactionConditions)
      .values({
        transactionId,
        description: `Building and pest inspection ${suffix}`,
        dueDate: twoDaysAgo,
        status: "Pending",
      })
      .returning();
    conditionId = cond.id;
  });

  test("the owning agent sees their overdue contract condition as an action item", async () => {
    const { actor, opts } = await actorAndOptsFor(A.agent, now);
    const result = await getCommandCentre(actor, opts);
    const found = result.overdue.find((i) => i.sourceRecordId === String(conditionId));
    assert.ok(found, "expected the overdue condition to appear for its owning agent");
    assert.equal(found!.sourceType, "CONTRACT_MILESTONE");
    assert.equal(found!.propertyId, propertyId);
    assert.equal(found!.id, `CONTRACT_MILESTONE:${conditionId}`);
  });

  test("a different agent in the same brokerage, who does not own the property, does not see it", async () => {
    const { actor, opts } = await actorAndOptsFor(agent2, now);
    const result = await getCommandCentre(actor, opts);
    const leaked = allItems(result).some((i) => i.sourceRecordId === String(conditionId) && i.sourceType === "CONTRACT_MILESTONE");
    assert.equal(leaked, false, "a peer agent must not see another agent's property-scoped item");
  });

  test("the brokerage administrator sees it, since an administrator's scope is the whole brokerage", async () => {
    const { actor, opts } = await actorAndOptsFor(A.admin, now);
    const result = await getCommandCentre(actor, opts);
    const found = result.overdue.find((i) => i.sourceRecordId === String(conditionId));
    assert.ok(found, "expected the brokerage administrator to see every agent's items");
  });

  test("D9: an administrator's active property names the listing agent, and a peer agent still cannot see it", async () => {
    const admin = await actorAndOptsFor(A.admin, now);
    const adminResult = await getCommandCentre(admin.actor, admin.opts);
    const seenByAdmin = adminResult.activeProperties.find((p) => p.propertyId === propertyId);
    assert.ok(seenByAdmin, "expected the administrator to see the agent's active property");
    assert.equal(seenByAdmin.responsibleAgentId, A.agent.user.id);
    assert.equal(seenByAdmin.responsibleAgentName, "Agent User");
    assert.notEqual(seenByAdmin.responsibleAgentId, admin.actor.id);

    const owner = await actorAndOptsFor(A.agent, now);
    const ownerResult = await getCommandCentre(owner.actor, owner.opts);
    const seenByOwner = ownerResult.activeProperties.find((p) => p.propertyId === propertyId);
    assert.ok(seenByOwner);
    assert.equal(seenByOwner.responsibleAgentId, owner.actor.id);
    assert.equal(seenByOwner.responsibleAgentName, "Agent User");

    const peer = await actorAndOptsFor(agent2, now);
    const peerResult = await getCommandCentre(peer.actor, peer.opts);
    assert.equal(
      peerResult.activeProperties.some((p) => p.propertyId === propertyId),
      false,
      "a peer agent must not gain this property from the name lookup",
    );
  });

  test("an administrator of a different brokerage never sees it, regardless of role", async () => {
    const { actor, opts } = await actorAndOptsFor(B.admin, now);
    const result = await getCommandCentre(actor, opts);
    const leaked = allItems(result).some((i) => i.sourceRecordId === String(conditionId));
    assert.equal(leaked, false, "cross-tenant data must never leak, even to an administrator");
  });

  test("once the Exception & Risk Engine has raised an exception for this condition, dedup suppresses the plain condition item -- only the exception's own action item survives", async () => {
    const [exc] = await db
      .insert(riskExceptions)
      .values({
        brokerageId: A.brokerageId,
        propertyId,
        transactionId,
        ruleId: "TEST-DEDUP-1",
        category: "CONTRACT_CONDITIONS",
        severity: "AT_RISK",
        title: "Overdue contract condition (test)",
        problemDescription: "Test-inserted exception standing in for a real rule evaluation.",
        businessImpact: "Settlement could be delayed.",
        detectedCause: "Condition due date has passed without resolution.",
        recommendedAction: 'Confirm the condition is satisfied, waived, or update its status.',
        resolutionRequirements: "Condition status changes away from Pending.",
        sourceRecordType: "transactionConditions",
        sourceRecordId: String(conditionId),
        correlationId: crypto.randomUUID(),
        dedupKey: `cc-test-dedup-${suffix}`,
        openDedupKey: `cc-test-dedup-${suffix}`,
        metadata: { conditionId },
      })
      .returning();

    const { actor, opts } = await actorAndOptsFor(A.agent, now);
    const result = await getCommandCentre(actor, opts);
    const matching = allItems(result).filter(
      (i) => i.sourceRecordId === String(conditionId) || i.id === `EXCEPTION:${exc.id}`,
    );
    assert.equal(
      matching.length,
      1,
      `expected exactly one deduplicated action item for this source, got: ${JSON.stringify(matching.map((i) => i.id))}`,
    );
    assert.equal(matching[0].sourceType, "EXCEPTION");
    assert.equal(matching[0].id, `EXCEPTION:${exc.id}`);
    assert.equal(matching[0].severity, "AT_RISK");
  });
});

describe("getCommandCentre -- empty state", () => {
  test("an agent with no properties gets an empty, well-formed response rather than an error", async () => {
    const now = new Date();
    const { actor, opts } = await actorAndOptsFor(agent2, now);
    const result = await getCommandCentre(actor, opts);

    assert.deepEqual(
      Object.keys(result).sort(),
      [
        "activeProperties",
        "agent",
        "comingUp",
        "completedToday",
        "generatedAt",
        "now",
        "overdue",
        "pitCrew",
        "summary",
        "timeZone",
        "timeZoneSource",
        "today",
        "waitingOn",
      ].sort(),
    );
    assert.equal(result.timeZone, "Australia/Brisbane");
    assert.equal(result.timeZoneSource, "fallback");
    assert.equal(result.agent.id, agent2.user.id);
    assert.equal(result.agent.firstName, "Second");
    assert.deepEqual(result.activeProperties, []);
    assert.deepEqual(result.overdue, []);
    assert.deepEqual(result.today, []);
    assert.deepEqual(result.comingUp, []);
    assert.equal(result.summary.critical, 0);
    assert.equal(result.summary.overdue, 0);
  });
});
