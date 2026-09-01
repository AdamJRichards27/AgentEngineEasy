// Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7). DB-backed
// coverage for queries.ts: sourcing from listBrokerageExceptions (Section
// 22's "tested read interface" instead of the unmerged Command Centre),
// the PC-relevance filter, workspace bucketing (Sections 7/10/27), and the
// workload/capacity signal (Section 15 -- a live count, never a speed or
// completion metric).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, users } from "@aee/db";
import { createOrUpdateException, newCorrelationId } from "../../exceptions/model.js";
import type { RiskFinding } from "../../exceptions/types.js";
import { getPitCrewWorkspace, getPitCrewTeam } from "../queries.js";
import { claimWorkItem } from "../assignment.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

// devLogin() below requires ALLOW_DEV_AUTH=true. Most suites in this repo
// set this themselves at module load (see e.g. transactionConditions.test.ts)
// rather than relying on an ambient value that may not be set, and this
// suite should too.
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
let admin: DevLoginResult;
let agent: DevLoginResult;
let pitCrewMember: DevLoginResult;
let brokerageId: number;
let propertyId: number;
let fixtureCounter = 0;

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

function buildFinding(overrides: Partial<RiskFinding> = {}): RiskFinding {
  fixtureCounter += 1;
  return {
    ruleId: "TEST_PITCREW_QUERIES_RULE",
    ruleVersion: 1,
    category: "WORKFLOW_OPERATIONAL",
    severity: "ATTENTION",
    title: `Test PC finding ${fixtureCounter}`,
    problemDescription: "A test problem.",
    businessImpact: "Test impact.",
    detectedCause: "Test cause.",
    ownerType: "UNASSIGNED_QUEUE",
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
    dedupKey: `TEST_PITCREW_QUERIES_RULE:${brokerageId}:QUERIES_SCOPE_${fixtureCounter}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
    ...overrides,
  };
}

async function createException(overrides: Partial<RiskFinding> = {}): Promise<string> {
  const finding = buildFinding(overrides);
  const result = await createOrUpdateException(finding, brokerageId, propertyId, null, newCorrelationId(), null);
  return result.exception.id;
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

  const created = await createBrokerageWithUsers(baseUrl, `PitCrew Queries ${Date.now()}`);
  admin = created.admin;
  agent = created.agent;
  brokerageId = created.brokerageId;
  propertyId = await createProperty(agent.cookie, "1 Queries Test St");

  pitCrewMember = await devLogin(baseUrl, {
    email: `pitcrew-${brokerageId}@example.com`, firstName: "Pit", lastName: "Crew", brokerageName: created.admin.user.brokerageName!,
  });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrewMember.user.id));
});

after(async () => {
  await cleanupBrokerages([brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("getPitCrewWorkspace surfaces an UNASSIGNED_QUEUE exception as unclaimed unassigned work", async () => {
  const exceptionId = await createException({ ownerType: "UNASSIGNED_QUEUE", severity: "AT_RISK" });
  const workspace = await getPitCrewWorkspace(brokerageId, pitCrewMember.user.id);
  const item = workspace.unassignedWork.find((i) => i.sourceRecordId === exceptionId);
  assert.ok(item, "expected the new exception in unassignedWork");
  assert.equal(item!.pcStatus, "UNCLAIMED");
  assert.equal(item!.severity, "AT_RISK");
  assert.equal(item!.version, 0, "never-touched item should carry the sentinel version");
  assert.ok(workspace.summary.unassignedCount >= 1);
});

test("an AGENT-owned exception with no Pit Crew overlay is not PC-relevant", async () => {
  const exceptionId = await createException({ ownerType: "LISTING_AGENT", ownerUserId: agent.user.id });
  const workspace = await getPitCrewWorkspace(brokerageId, pitCrewMember.user.id);
  const inAnyBucket = [
    ...workspace.unassignedWork, ...workspace.myWork, ...workspace.teamWork,
    ...workspace.waitingOn, ...workspace.completedToday,
  ].some((i) => i.sourceRecordId === exceptionId);
  assert.equal(inAnyBucket, false, "an untouched agent-owned exception should not appear in any PC bucket");
});

test("claiming an item moves it from unassignedWork into myWork, and out of unassignedWork", async () => {
  const exceptionId = await createException({ ownerType: "PIT_CREW" });
  const before2 = await getPitCrewWorkspace(brokerageId, pitCrewMember.user.id);
  assert.ok(before2.unassignedWork.some((i) => i.sourceRecordId === exceptionId));

  await claimWorkItem({
    brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId: exceptionId,
    expectedVersion: 0, actorUserId: pitCrewMember.user.id,
  });

  const after2 = await getPitCrewWorkspace(brokerageId, pitCrewMember.user.id);
  assert.equal(after2.unassignedWork.some((i) => i.sourceRecordId === exceptionId), false);
  const mine = after2.myWork.find((i) => i.sourceRecordId === exceptionId);
  assert.ok(mine, "expected the claimed item in myWork");
  assert.equal(mine!.pcStatus, "CLAIMED");
  assert.equal(mine!.assignedToUserId, pitCrewMember.user.id);
  // teamWork is "everyone's open PC-relevant work", so a claimed item still
  // belongs there too (Section 7: Team Work is a superset view).
  assert.ok(after2.teamWork.some((i) => i.sourceRecordId === exceptionId));
});

test("getPitCrewTeam reports a live count of claimed/in-progress/waiting-on items, not history", async () => {
  const teamBefore = await getPitCrewTeam(brokerageId);
  const memberBefore = teamBefore.find((m) => m.userId === pitCrewMember.user.id);
  assert.ok(memberBefore, "expected the Pit Crew member in the team roster");
  const startCount = memberBefore!.activeItemCount;

  const exceptionId = await createException({ ownerType: "PIT_CREW" });
  await claimWorkItem({
    brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId: exceptionId,
    expectedVersion: 0, actorUserId: pitCrewMember.user.id,
  });

  const teamAfter = await getPitCrewTeam(brokerageId);
  const memberAfter = teamAfter.find((m) => m.userId === pitCrewMember.user.id);
  assert.equal(memberAfter!.activeItemCount, startCount + 1);

  // An agent (not Pit Crew, and not active-in-brokerage-as-PC) never appears
  // in the roster at all -- this is a team capacity view, not a user list.
  assert.equal(teamAfter.some((m) => m.userId === agent.user.id), false);
});
