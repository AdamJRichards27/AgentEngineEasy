// R-F22 — getPitCrewWorkspace includes relevant open campaign items only
// while PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED is the literal "true".
// While it is not, the payload has no LAUNCH_ITEM and campaign_items is
// not queried. LISTING_AGENT with no overlay stays out. A launch-campaign
// exception stays in the Launch section either way.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { campaignItems, db, launchPlans, setDbQueryObserver, users } from "@aee/db";
import { createOrUpdateException, newCorrelationId } from "../../exceptions/model.js";
import type { RiskFinding } from "../../exceptions/types.js";
import { claimWorkItem } from "../assignment.js";
import { PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG, isPitCrewLaunchItemSourceEnabled } from "../launchItemSource.js";
import { getPitCrewTeam, getPitCrewWorkspace } from "../queries.js";
import type { PcWorkItem, PcWorkspace } from "../types.js";
import { cleanupBrokerages, createBrokerageWithUsers, devLogin, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const FLAG_OFF: ReadonlyArray<{ label: string; value: string | undefined }> = [
  { label: "unset", value: undefined },
  { label: "empty", value: "" },
  { label: "false", value: "false" },
  { label: "TRUE", value: "TRUE" },
  { label: "1", value: "1" },
];

const COST_SENTINEL = "991337";
const VENDOR_SENTINEL = "Rf22 Vendor Sentinel";

let server: Server;
let baseUrl: string;
let admin: DevLoginResult;
let agent: DevLoginResult;
let pitCrewMember: DevLoginResult;
let brokerageId: number;
let propertyId: number;
let pitCrewItemId: string;
let queueItemId: string;
let agentItemId: string;
let completeItemId: string;
let claimedAgentItemId: string;
let capacityItemId: string;
let exceptionId: string;
let fixtureCounter = 0;

function listed(workspace: PcWorkspace): PcWorkItem[] {
  return [
    ...workspace.myWork,
    ...workspace.unassignedWork,
    ...workspace.teamWork,
    ...workspace.launchCoordination,
    ...workspace.transactionCoordination,
    ...workspace.waitingOn,
    ...workspace.completedToday,
    ...workspace.handedBack,
    ...workspace.escalated,
  ];
}

async function withFlag(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG];
  if (value === undefined) delete process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG];
  else process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG];
    else process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG] = previous;
  }
}

async function createProperty(address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: agent.cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

async function ensurePlan(targetPropertyId: number): Promise<string> {
  const [existing] = await db.select({ id: launchPlans.id }).from(launchPlans).where(eq(launchPlans.propertyId, targetPropertyId));
  if (existing) return existing.id;
  const [plan] = await db
    .insert(launchPlans)
    .values({
      brokerageId,
      propertyId: targetPropertyId,
      templateType: "CUSTOM",
      status: "PLANNING",
      createdBy: admin.user.id,
    })
    .returning({ id: launchPlans.id });
  return plan.id;
}

async function insertItem(input: {
  title: string;
  ownerType: string;
  status?: string;
  dueAt?: Date | null;
  completedAt?: Date | null;
  responsibleUserId?: number | null;
}): Promise<string> {
  const launchPlanId = await ensurePlan(propertyId);
  const [item] = await db
    .insert(campaignItems)
    .values({
      launchPlanId,
      propertyId,
      brokerageId,
      itemType: "PHOTOGRAPHY",
      title: input.title,
      description: "Saturday photography booking",
      status: input.status ?? "TO_ORGANISE",
      responsibleOwnerType: input.ownerType,
      responsibleUserId: input.responsibleUserId ?? null,
      dueAt: input.dueAt ?? null,
      completedAt: input.completedAt ?? null,
      costCents: Number(COST_SENTINEL),
      vendorName: VENDOR_SENTINEL,
    })
    .returning({ id: campaignItems.id });
  return item.id;
}

before(async () => {
  delete process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG];
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { createApp } = await import("../../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const created = await createBrokerageWithUsers(baseUrl, `R-F22 Workspace ${Date.now()}`);
  admin = created.admin;
  agent = created.agent;
  brokerageId = created.brokerageId;
  propertyId = await createProperty(`${Date.now()} Launch Workspace St`);
  pitCrewMember = await devLogin(baseUrl, {
    email: `pitcrew-rf22-${brokerageId}@example.com`,
    firstName: "Pit",
    lastName: "Crew",
    brokerageName: created.admin.user.brokerageName!,
  });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrewMember.user.id));

  pitCrewItemId = await insertItem({ title: "Book the photographer", ownerType: "PIT_CREW", status: "IN_PROGRESS", dueAt: null });
  queueItemId = await insertItem({
    title: "Queue the floor plan",
    ownerType: "UNASSIGNED_QUEUE",
    status: "BLOCKED",
    dueAt: new Date(Date.now() + 120 * 24 * 60 * 60 * 1000),
  });
  agentItemId = await insertItem({ title: "Agent schedules the sign", ownerType: "LISTING_AGENT", responsibleUserId: agent.user.id });
  completeItemId = await insertItem({
    title: "Finished brochure",
    ownerType: "PIT_CREW",
    status: "COMPLETE",
    completedAt: new Date(),
  });
  claimedAgentItemId = await insertItem({ title: "Agent asked Pit Crew", ownerType: "LISTING_AGENT", responsibleUserId: agent.user.id });
  capacityItemId = await insertItem({ title: "Capacity copywriting", ownerType: "PIT_CREW", status: "TO_ORGANISE" });

  fixtureCounter += 1;
  const finding: RiskFinding = {
    ruleId: "TEST_PITCREW_LAUNCH_RULE",
    ruleVersion: 1,
    category: "LAUNCH_CAMPAIGN",
    severity: "ATTENTION",
    title: `Launch exception ${fixtureCounter}`,
    problemDescription: "A launch exception.",
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
    dedupKey: `TEST_PITCREW_LAUNCH_RULE:${brokerageId}:${fixtureCounter}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
  };
  const result = await createOrUpdateException(finding, brokerageId, propertyId, null, newCorrelationId(), null);
  exceptionId = result.exception.id;
});

after(async () => {
  delete process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG];
  if (brokerageId) await cleanupBrokerages([brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

describe("R-F22 launch items in the Pit Crew workspace", { concurrency: false }, () => {
  for (const flagCase of FLAG_OFF) {
    test(`flag ${flagCase.label}: workspace has no campaign item and does not query campaign_items`, async () => {
      const statements: string[] = [];
      await withFlag(flagCase.value, async () => {
        assert.equal(isPitCrewLaunchItemSourceEnabled(), false);
        const uninstall = setDbQueryObserver((query) => {
          statements.push(query);
        });
        try {
          const workspace = await getPitCrewWorkspace(brokerageId, pitCrewMember.user.id);
          assert.equal(listed(workspace).some((item) => item.sourceType === "LAUNCH_ITEM"), false);
          assert.equal(listed(workspace).some((item) => item.sourceRecordId === pitCrewItemId), false);
          const exception = workspace.launchCoordination.find((item) => item.sourceRecordId === exceptionId);
          assert.ok(exception, "launch-campaign exception stays in the Launch section");
          assert.equal(exception.sourceType, "EXCEPTION");
        } finally {
          uninstall();
        }
      });
      assert.deepEqual(
        statements.filter((query) => query.includes("campaign_items")),
        [],
      );
    });
  }

  test("flag on: relevant open campaign items are information launch-campaign cards, and agent-owned rows without an overlay are absent", async () => {
    await withFlag("true", async () => {
      const workspace = await getPitCrewWorkspace(brokerageId, pitCrewMember.user.id);
      const encoded = JSON.stringify(workspace);
      assert.equal(encoded.includes(COST_SENTINEL), false);
      assert.equal(encoded.includes(VENDOR_SENTINEL), false);

      const photographer = workspace.launchCoordination.find((item) => item.sourceRecordId === pitCrewItemId);
      assert.ok(photographer, "PIT_CREW campaign item is in the Launch section");
      assert.equal(photographer.sourceType, "LAUNCH_ITEM");
      assert.equal(photographer.severity, "INFORMATION");
      assert.equal(photographer.category, "LAUNCH_CAMPAIGN");
      assert.equal(photographer.exceptionStatus, "IN_PROGRESS");
      assert.equal(photographer.title, "Book the photographer");
      assert.equal(photographer.description, "Saturday photography booking");
      assert.equal(photographer.ownerType, "PIT_CREW");
      assert.equal(photographer.overdue, false);
      assert.equal(photographer.dueAt, null);
      assert.ok(workspace.unassignedWork.some((item) => item.sourceRecordId === pitCrewItemId));

      const floorPlan = workspace.launchCoordination.find((item) => item.sourceRecordId === queueItemId);
      assert.ok(floorPlan, "UNASSIGNED_QUEUE campaign item is in the Launch section");
      assert.equal(floorPlan.severity, "INFORMATION");
      assert.equal(floorPlan.category, "LAUNCH_CAMPAIGN");
      assert.equal(floorPlan.exceptionStatus, "BLOCKED");
      assert.ok(floorPlan.dueAt);

      assert.equal(listed(workspace).some((item) => item.sourceRecordId === agentItemId), false);
      assert.equal(listed(workspace).some((item) => item.sourceRecordId === completeItemId), false);

      const exception = workspace.launchCoordination.find((item) => item.sourceRecordId === exceptionId);
      assert.ok(exception, "launch-campaign exception is still shown beside campaign items");
      assert.equal(exception.sourceType, "EXCEPTION");
      assert.equal(exception.category, "LAUNCH_CAMPAIGN");
    });
  });

  test("flag on: a LISTING_AGENT campaign item appears once an overlay exists, and a claim counts toward team capacity", async () => {
    await withFlag("true", async () => {
      const before = await getPitCrewTeam(brokerageId);
      const start = before.find((member) => member.userId === pitCrewMember.user.id)?.activeItemCount ?? 0;

      await claimWorkItem({
        brokerageId,
        propertyId,
        sourceType: "LAUNCH_ITEM",
        sourceRecordId: claimedAgentItemId,
        expectedVersion: 0,
        actorUserId: pitCrewMember.user.id,
      });
      await claimWorkItem({
        brokerageId,
        propertyId,
        sourceType: "LAUNCH_ITEM",
        sourceRecordId: capacityItemId,
        expectedVersion: 0,
        actorUserId: pitCrewMember.user.id,
      });

      const workspace = await getPitCrewWorkspace(brokerageId, pitCrewMember.user.id);
      const asked = workspace.myWork.find((item) => item.sourceRecordId === claimedAgentItemId);
      assert.ok(asked, "overlay makes a LISTING_AGENT campaign item visible");
      assert.equal(asked.sourceType, "LAUNCH_ITEM");
      assert.equal(asked.ownerType, "LISTING_AGENT");
      assert.equal(asked.severity, "INFORMATION");
      assert.equal(asked.category, "LAUNCH_CAMPAIGN");
      assert.equal(asked.pcStatus, "CLAIMED");
      assert.ok(workspace.launchCoordination.some((item) => item.sourceRecordId === claimedAgentItemId));

      const after = await getPitCrewTeam(brokerageId);
      const member = after.find((row) => row.userId === pitCrewMember.user.id);
      assert.ok(member);
      assert.equal(member.activeItemCount, start + 2);

      const [source] = await db
        .select({ status: campaignItems.status, completedAt: campaignItems.completedAt })
        .from(campaignItems)
        .where(eq(campaignItems.id, capacityItemId));
      assert.equal(source?.status, "TO_ORGANISE");
      assert.equal(source?.completedAt, null);
    });
  });
});
