// PC-A (P-01): getPitCrewWorkspace's assignee-name lookup and
// getPitCrewTeam's active-item count are scoped to the caller's brokerage.
// Writes already check brokerage membership (assertUserInBrokerage), so a
// cross-tenant assignee or overlay only arises from data drift: a user moved
// between brokerages, or a legacy/manual row. These tests simulate that
// drift with direct updates/inserts. Pit Crew feature flags stay off.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, pitCrewAssignments, users } from "@aee/db";
import { createOrUpdateException, newCorrelationId } from "../../exceptions/model.js";
import type { RiskFinding } from "../../exceptions/types.js";
import { getPitCrewWorkspace, getPitCrewTeam } from "../queries.js";
import { claimWorkItem } from "../assignment.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
let brokerageA: number;
let brokerageB: number;
let propertyA: number;
let propertyB: number;
let pitCrewA: DevLoginResult;
let fixtureCounter = 0;

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "QLD", suburb: "Testville", postcode: "4000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

async function createException(brokerageId: number, propertyId: number): Promise<string> {
  fixtureCounter += 1;
  const finding: RiskFinding = {
    ruleId: "TEST_PITCREW_TENANT_SCOPE_RULE",
    ruleVersion: 1,
    category: "WORKFLOW_OPERATIONAL",
    severity: "ATTENTION",
    title: `Tenant scope finding ${fixtureCounter}`,
    problemDescription: "A test problem.",
    businessImpact: "Test impact.",
    detectedCause: "Test cause.",
    ownerType: "PIT_CREW",
    ownerUserId: null,
    propertyId,
    transactionId: null,
    dueAt: null,
    escalatesAt: null,
    recommendedAction: "Do the test thing.",
    resolutionRequirements: "The test condition clears.",
    dismissible: true,
    sourceRecordType: "property",
    sourceRecordId: String(propertyId),
    dedupKey: `TEST_PITCREW_TENANT_SCOPE_RULE:${brokerageId}:PCA_${fixtureCounter}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
  };
  const result = await createOrUpdateException(finding, brokerageId, propertyId, null, newCorrelationId(), null);
  return result.exception.id;
}

async function pitCrewUser(brokerageName: string, email: string, firstName: string, lastName: string): Promise<DevLoginResult> {
  const login = await devLogin(baseUrl, { email, firstName, lastName, brokerageName });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, login.user.id));
  return login;
}

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

  const stamp = Date.now();
  const a = await createBrokerageWithUsers(baseUrl, `PCA Tenant A ${stamp}`);
  const b = await createBrokerageWithUsers(baseUrl, `PCA Tenant B ${stamp}`);
  brokerageA = a.brokerageId;
  brokerageB = b.brokerageId;
  propertyA = await createProperty(a.agent.cookie, "1 Tenant A St");
  propertyB = await createProperty(b.agent.cookie, "1 Tenant B St");
  pitCrewA = await pitCrewUser(a.admin.user.brokerageName!, `pca-crew-a-${stamp}@example.com`, "Pat", "Alpha");
});

after(async () => {
  await cleanupBrokerages([brokerageA, brokerageB]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("PC-A lock: an in-brokerage assignee keeps their 'First Last' name in the workspace", async () => {
  const exceptionId = await createException(brokerageA, propertyA);
  await claimWorkItem({
    brokerageId: brokerageA, propertyId: propertyA, sourceType: "EXCEPTION", sourceRecordId: exceptionId,
    expectedVersion: 0, actorUserId: pitCrewA.user.id,
  });
  const workspace = await getPitCrewWorkspace(brokerageA, pitCrewA.user.id);
  const item = workspace.teamWork.find((i) => i.sourceRecordId === exceptionId);
  assert.ok(item, "expected the claimed item in teamWork");
  assert.equal(item!.assignedToUserId, pitCrewA.user.id);
  assert.equal(item!.assignedToName, "Pat Alpha");
});

test("PC-A: an assignee who now belongs to another brokerage is not named in this brokerage's workspace", async () => {
  const stamp = Date.now();
  const drifting = await pitCrewUser(
    pitCrewA.user.brokerageName!,
    `pca-crew-drift-${stamp}@example.com`,
    "UNIQUE_DRIFT_FIRST",
    "UNIQUE_DRIFT_LAST",
  );
  assert.equal(drifting.user.brokerageId, brokerageA, "fixture: the user starts in brokerage A");
  const exceptionId = await createException(brokerageA, propertyA);
  await claimWorkItem({
    brokerageId: brokerageA, propertyId: propertyA, sourceType: "EXCEPTION", sourceRecordId: exceptionId,
    expectedVersion: 0, actorUserId: drifting.user.id,
  });
  // Simulated drift: the assignee is moved to brokerage B after claiming.
  await db.update(users).set({ brokerageId: brokerageB }).where(eq(users.id, drifting.user.id));

  const workspace = await getPitCrewWorkspace(brokerageA, pitCrewA.user.id);
  const item = workspace.teamWork.find((i) => i.sourceRecordId === exceptionId);
  assert.ok(item, "expected the item in brokerage A's teamWork");
  assert.equal(item!.assignedToUserId, drifting.user.id, "the stored assignee id is reported as-is, not rewritten");
  assert.equal(item!.assignedToName, null, "another brokerage's user name must not be returned");
  assert.equal(JSON.stringify(workspace).includes("UNIQUE_DRIFT_FIRST"), false);
});

test("PC-A lock: an in-brokerage claim still counts toward the member's active items", async () => {
  const before = (await getPitCrewTeam(brokerageA)).find((m) => m.userId === pitCrewA.user.id);
  assert.ok(before, "expected the Pit Crew member in brokerage A's roster");
  const exceptionId = await createException(brokerageA, propertyA);
  await claimWorkItem({
    brokerageId: brokerageA, propertyId: propertyA, sourceType: "EXCEPTION", sourceRecordId: exceptionId,
    expectedVersion: 0, actorUserId: pitCrewA.user.id,
  });
  const after = (await getPitCrewTeam(brokerageA)).find((m) => m.userId === pitCrewA.user.id);
  assert.equal(after!.activeItemCount, before!.activeItemCount + 1);
});

test("PC-A: getPitCrewTeam does not count an active overlay stamped with another brokerage", async () => {
  const before = (await getPitCrewTeam(brokerageA)).find((m) => m.userId === pitCrewA.user.id);
  assert.ok(before, "expected the Pit Crew member in brokerage A's roster");
  const foreignExceptionId = await createException(brokerageB, propertyB);
  // Legacy/manual row: a brokerage-B overlay whose assignee id is a brokerage-A member.
  await db.insert(pitCrewAssignments).values({
    brokerageId: brokerageB,
    sourceType: "EXCEPTION",
    sourceRecordId: foreignExceptionId,
    propertyId: propertyB,
    status: "IN_PROGRESS",
    assignedToUserId: pitCrewA.user.id,
    claimedAt: new Date(),
    version: 2,
  });
  const after = (await getPitCrewTeam(brokerageA)).find((m) => m.userId === pitCrewA.user.id);
  assert.equal(after!.activeItemCount, before!.activeItemCount, "brokerage B's overlay must not count toward brokerage A's capacity");
});
