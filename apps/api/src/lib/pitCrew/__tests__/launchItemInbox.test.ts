// R-F24 / R-F25 — inbox title for a LAUNCH_ITEM responsibility row, and the
// property match on that join.
// While PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED is not the literal "true",
// exception inbox rows are unchanged and campaign_items is not queried.
// While it is, a fixture LAUNCH_ITEM event (inserted directly, not via
// hand-back) is titled with campaign_items.title when the campaign item is
// in the caller's brokerage and on the event's property. A campaign item in
// another brokerage is absent. A campaign item in the same brokerage on a
// different property than the event is excluded, and its title is absent.
// cost_cents and vendor_name are not in the payload. Hand-back and escalate
// return 404 unless both responsibility flags are the literal "true", and
// then they succeed without writing campaign_items. A COMPLETE campaign
// item is absent from the flag-on inbox. A BLOCKED one stays.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import { campaignItems, db, launchPlans, pitCrewAssignments, pitCrewResponsibilityEvents, setDbQueryObserver } from "@aee/db";
import { createOrUpdateException, newCorrelationId } from "../../exceptions/model.js";
import { listedExceptionTitle } from "../../exceptions/queries.js";
import type { RiskFinding } from "../../exceptions/types.js";
import { claimWorkItem } from "../assignment.js";
import { PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG, isPitCrewLaunchItemSourceEnabled } from "../launchItemSource.js";
import { listResponsibilityItemsForRecipient } from "../queries.js";
import { PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG, escalateWorkItem, handBackWorkItem } from "../responsibility.js";
import type { ResponsibilityInbox, ResponsibilityInboxItem } from "../types.js";
import { cleanupBrokerages, createBrokerageWithUsers, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

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

const COST_SENTINEL = 88133741;
const VENDOR_SENTINEL = "Rf24-Vendor-Sentinel-9f3c";
const DESCRIPTION_SENTINEL = "Rf24-Description-Sentinel-9f3c";
const FOREIGN_COST_SENTINEL = 77220019;
const FOREIGN_VENDOR_SENTINEL = "Rf24-Foreign-Vendor-Sentinel-2ab7";
const LAUNCH_TITLE = "Book the Saturday photographer";
const FOREIGN_TITLE = "Foreign brokerage floor plan";
const MISMATCH_TITLE = "Rf25-Mismatch-Property-Title-4c8e";
const ORDINARY_TITLE = "RF24 ordinary exception";
const AGENT_FINANCIAL_TITLE = "RF24 agent financial 771199";
const ADMIN_FINANCIAL_TITLE = "RF24 admin financial 661188";
const LAUNCH_NOTE = "The photographer is booked.";
const LAUNCH_NEXT = "Confirm the Saturday shoot time.";
const WORK_ITEM_NOT_FOUND = JSON.stringify({ error: "Work item not found in this brokerage." });

let server: Server;
let baseUrl: string;
let admin: DevLoginResult;
let agent: DevLoginResult;
let foreignAdmin: DevLoginResult;
let brokerageId: number;
let otherBrokerageId: number;
let propertyId: number;
let mismatchPropertyId: number;
let foreignPropertyId: number;
let ordinaryExceptionId: string;
let agentFinancialExceptionId: string;
let adminFinancialExceptionId: string;
let launchItemId: string;
let foreignItemId: string;
let mismatchItemId: string;
let launchAssignmentId: number;
let savedResponsibilityFlag: string | undefined;
let savedLaunchFlag: string | undefined;
let fixtureCounter = 0;

function exceptionItems(inbox: ResponsibilityInbox): ResponsibilityInboxItem[] {
  return inbox.items.filter((item) => item.sourceType === "EXCEPTION");
}

async function withLaunchFlag(value: string | undefined, run: () => Promise<void>): Promise<void> {
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

function finding(targetPropertyId: number, targetBrokerageId: number, overrides: Partial<RiskFinding>): RiskFinding {
  fixtureCounter += 1;
  return {
    ruleId: "TEST_PITCREW_INBOX_LAUNCH_RULE",
    ruleVersion: 1,
    category: "WORKFLOW_OPERATIONAL",
    severity: "ATTENTION",
    title: `Inbox launch finding ${fixtureCounter}`,
    problemDescription: "A test problem.",
    businessImpact: "Test impact.",
    detectedCause: "Test cause.",
    ownerType: "PIT_CREW",
    ownerUserId: null,
    propertyId: targetPropertyId,
    transactionId: null,
    dueAt: null,
    escalatesAt: null,
    recommendedAction: "Do the test thing.",
    resolutionRequirements: "The test condition clears.",
    dismissible: true,
    sourceRecordType: "property",
    sourceRecordId: String(targetPropertyId),
    dedupKey: `TEST_PITCREW_INBOX_LAUNCH_RULE:${targetBrokerageId}:${fixtureCounter}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
    ...overrides,
  };
}

async function createException(targetBrokerageId: number, targetPropertyId: number, overrides: Partial<RiskFinding>): Promise<string> {
  const result = await createOrUpdateException(
    finding(targetPropertyId, targetBrokerageId, overrides),
    targetBrokerageId,
    targetPropertyId,
    null,
    newCorrelationId(),
    null,
  );
  return result.exception.id;
}

async function ensurePlan(targetBrokerageId: number, targetPropertyId: number, createdBy: number): Promise<string> {
  const [existing] = await db.select({ id: launchPlans.id }).from(launchPlans).where(eq(launchPlans.propertyId, targetPropertyId));
  if (existing) return existing.id;
  const [plan] = await db
    .insert(launchPlans)
    .values({
      brokerageId: targetBrokerageId,
      propertyId: targetPropertyId,
      templateType: "CUSTOM",
      status: "PLANNING",
      createdBy,
    })
    .returning({ id: launchPlans.id });
  return plan.id;
}

async function insertCampaignItem(input: {
  targetBrokerageId: number;
  targetPropertyId: number;
  createdBy: number;
  title: string;
  costCents: number;
  vendorName: string;
  status?: string;
}): Promise<string> {
  const launchPlanId = await ensurePlan(input.targetBrokerageId, input.targetPropertyId, input.createdBy);
  const [item] = await db
    .insert(campaignItems)
    .values({
      launchPlanId,
      propertyId: input.targetPropertyId,
      brokerageId: input.targetBrokerageId,
      itemType: "PHOTOGRAPHY",
      title: input.title,
      description: DESCRIPTION_SENTINEL,
      status: input.status ?? "TO_ORGANISE",
      responsibleOwnerType: "PIT_CREW",
      costCents: input.costCents,
      vendorName: input.vendorName,
    })
    .returning({ id: campaignItems.id });
  return item.id;
}

async function insertLaunchResponsibility(sourceRecordId: string, eventPropertyId = propertyId): Promise<number> {
  const [assignment] = await db
    .insert(pitCrewAssignments)
    .values({
      brokerageId,
      sourceType: "LAUNCH_ITEM",
      sourceRecordId,
      propertyId: eventPropertyId,
      status: "HANDED_BACK",
      assignedToUserId: admin.user.id,
      version: 2,
    })
    .returning({ id: pitCrewAssignments.id });
  await db.insert(pitCrewResponsibilityEvents).values({
    brokerageId,
    assignmentId: assignment.id,
    propertyId: eventPropertyId,
    kind: "HAND_BACK",
    reasonCategory: "WORK_COMPLETE",
    note: LAUNCH_NOTE,
    nextAction: LAUNCH_NEXT,
    originatingUserId: admin.user.id,
    recipientUserId: agent.user.id,
    resultingResponsibility: "AGENT",
    status: "OPEN",
  });
  return assignment.id;
}

async function readInboxes(): Promise<{ agentInbox: ResponsibilityInbox; adminInbox: ResponsibilityInbox }> {
  const agentInbox = await listResponsibilityItemsForRecipient(brokerageId, agent.user.id, "Agent");
  const adminInbox = await listResponsibilityItemsForRecipient(brokerageId, admin.user.id, "Brokerage Administrator");
  return { agentInbox, adminInbox };
}

before(async () => {
  savedResponsibilityFlag = process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
  savedLaunchFlag = process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG];
  process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = "true";
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

  const created = await createBrokerageWithUsers(baseUrl, `R-F24 Inbox ${Date.now()}`);
  admin = created.admin;
  agent = created.agent;
  brokerageId = created.brokerageId;
  const foreign = await createBrokerageWithUsers(baseUrl, `R-F24 Foreign ${Date.now()}`);
  foreignAdmin = foreign.admin;
  otherBrokerageId = foreign.brokerageId;

  propertyId = await createProperty(agent.cookie, `${Date.now()} Inbox Launch St`);
  mismatchPropertyId = await createProperty(agent.cookie, `${Date.now()} Inbox Mismatch St`);
  foreignPropertyId = await createProperty(foreignAdmin.cookie, `${Date.now()} Foreign Launch St`);

  ordinaryExceptionId = await createException(brokerageId, propertyId, { title: ORDINARY_TITLE });
  agentFinancialExceptionId = await createException(brokerageId, propertyId, {
    title: AGENT_FINANCIAL_TITLE,
    requiresFinancialEntitlement: true,
    category: "FINANCIAL",
  });
  adminFinancialExceptionId = await createException(brokerageId, propertyId, {
    title: ADMIN_FINANCIAL_TITLE,
    requiresFinancialEntitlement: true,
    category: "FINANCIAL",
  });

  const actor = (sourceRecordId: string, expectedVersion: number) => ({
    brokerageId,
    propertyId,
    sourceType: "EXCEPTION" as const,
    sourceRecordId,
    expectedVersion,
    actorUserId: admin.user.id,
    actorEmail: admin.user.email,
  });

  const ordinaryClaim = await claimWorkItem(actor(ordinaryExceptionId, 0));
  await handBackWorkItem({
    ...actor(ordinaryExceptionId, ordinaryClaim.version),
    reasonCategory: "WORK_COMPLETE",
    nextAction: "Review the ordinary exception.",
    recipientUserId: agent.user.id,
  });
  const agentFinancialClaim = await claimWorkItem(actor(agentFinancialExceptionId, 0));
  await handBackWorkItem({
    ...actor(agentFinancialExceptionId, agentFinancialClaim.version),
    reasonCategory: "INFORMATION_RETURNED",
    nextAction: "Review the financial exception.",
    recipientUserId: agent.user.id,
  });
  const adminFinancialClaim = await claimWorkItem(actor(adminFinancialExceptionId, 0));
  await escalateWorkItem({
    ...actor(adminFinancialExceptionId, adminFinancialClaim.version),
    reasonCategory: "MISSING_AUTHORITY",
    severity: "ATTENTION",
    note: "Outside Pit Crew authority.",
    nextAction: "Decide the financial next step.",
  });

  launchItemId = await insertCampaignItem({
    targetBrokerageId: brokerageId,
    targetPropertyId: propertyId,
    createdBy: admin.user.id,
    title: LAUNCH_TITLE,
    costCents: COST_SENTINEL,
    vendorName: VENDOR_SENTINEL,
  });
  foreignItemId = await insertCampaignItem({
    targetBrokerageId: otherBrokerageId,
    targetPropertyId: foreignPropertyId,
    createdBy: foreignAdmin.user.id,
    title: FOREIGN_TITLE,
    costCents: FOREIGN_COST_SENTINEL,
    vendorName: FOREIGN_VENDOR_SENTINEL,
  });
  mismatchItemId = await insertCampaignItem({
    targetBrokerageId: brokerageId,
    targetPropertyId: mismatchPropertyId,
    createdBy: admin.user.id,
    title: MISMATCH_TITLE,
    costCents: COST_SENTINEL,
    vendorName: VENDOR_SENTINEL,
  });
  launchAssignmentId = await insertLaunchResponsibility(launchItemId);
  await insertLaunchResponsibility(foreignItemId);
  // Event stays on propertyId. The campaign item is on mismatchPropertyId.
  await insertLaunchResponsibility(mismatchItemId, propertyId);
});

after(async () => {
  if (savedResponsibilityFlag === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
  else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = savedResponsibilityFlag;
  if (savedLaunchFlag === undefined) delete process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG];
  else process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG] = savedLaunchFlag;
  if (brokerageId || otherBrokerageId) await cleanupBrokerages([brokerageId, otherBrokerageId].filter((id) => id != null));
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

describe("R-F24 launch item inbox title", { concurrency: false }, () => {
  test("queries.ts does not name campaign item cost or vendor columns", () => {
    const source = readFileSync(new URL("../queries.ts", import.meta.url), "utf8");
    assert.equal(source.includes("costCents"), false);
    assert.equal(source.includes("vendorName"), false);
  });

  test("flag off: exception inbox rows are unchanged and campaign_items is not read", async () => {
    let baselineAgent: ResponsibilityInboxItem[] | undefined;
    let baselineAdmin: ResponsibilityInboxItem[] | undefined;
    for (const flagCase of FLAG_OFF) {
      const statements: string[] = [];
      await withLaunchFlag(flagCase.value, async () => {
        assert.equal(isPitCrewLaunchItemSourceEnabled(), false);
        const uninstall = setDbQueryObserver((query) => {
          statements.push(query);
        });
        try {
          const { agentInbox, adminInbox } = await readInboxes();
          assert.equal(agentInbox.items.some((item) => item.sourceRecordId === launchItemId), false, flagCase.label);
          assert.equal(agentInbox.items.some((item) => item.sourceRecordId === foreignItemId), false, flagCase.label);
          assert.equal(agentInbox.items.some((item) => item.sourceRecordId === mismatchItemId), false, flagCase.label);
          assert.equal(JSON.stringify({ agentInbox, adminInbox }).includes(MISMATCH_TITLE), false, flagCase.label);
          assert.equal(adminInbox.items.some((item) => item.sourceType === "LAUNCH_ITEM"), false, flagCase.label);
          assert.equal(agentInbox.items.every((item) => item.sourceType === "EXCEPTION"), true, flagCase.label);
          const ordinary = agentInbox.items.find((item) => item.sourceRecordId === ordinaryExceptionId);
          const hidden = agentInbox.items.find((item) => item.sourceRecordId === agentFinancialExceptionId);
          assert.ok(ordinary, flagCase.label);
          assert.equal(ordinary.title, ORDINARY_TITLE);
          assert.ok(hidden, flagCase.label);
          assert.equal(hidden.title, listedExceptionTitle({ title: AGENT_FINANCIAL_TITLE, requiresFinancialEntitlement: true }, false));
          assert.equal(hidden.title, null);
          const adminItem = adminInbox.items.find((item) => item.sourceRecordId === adminFinancialExceptionId);
          assert.ok(adminItem, flagCase.label);
          assert.equal(adminItem.title, ADMIN_FINANCIAL_TITLE);
          assert.equal(adminItem.sourceType, "EXCEPTION");
          if (!baselineAgent) {
            baselineAgent = agentInbox.items;
            baselineAdmin = adminInbox.items;
          } else {
            assert.deepEqual(agentInbox.items, baselineAgent, flagCase.label);
            assert.deepEqual(adminInbox.items, baselineAdmin, flagCase.label);
          }
        } finally {
          uninstall();
        }
      });
      assert.deepEqual(
        statements.filter((query) => query.includes("campaign_items")),
        [],
        flagCase.label,
      );
      // R-F25: the flag-off exception join now carries the flag-on property condition too.
      assert.equal(
        statements.some((query) => query.includes('"risk_exceptions"."property_id" = "pit_crew_responsibility_events"."property_id"')),
        true,
        flagCase.label,
      );
    }
  });

  test("flag on: inbox title is the campaign item title, another brokerage is hidden, and cost and vendor are absent", async () => {
    const statements: string[] = [];
    let agentInbox: ResponsibilityInbox | undefined;
    let adminInbox: ResponsibilityInbox | undefined;
    await withLaunchFlag("true", async () => {
      assert.equal(isPitCrewLaunchItemSourceEnabled(), true);
      const uninstall = setDbQueryObserver((query) => {
        statements.push(query);
      });
      try {
        const read = await readInboxes();
        agentInbox = read.agentInbox;
        adminInbox = read.adminInbox;
      } finally {
        uninstall();
      }
    });
    assert.ok(agentInbox && adminInbox);

    const launchQueries = statements.filter((query) => query.includes("campaign_items"));
    assert.ok(launchQueries.length > 0, "flag-on inbox reads campaign_items");
    for (const query of launchQueries) {
      assert.equal(query.includes("cost_cents"), false, query);
      assert.equal(query.includes("vendor_name"), false, query);
      assert.equal(
        query.includes('"campaign_items"."property_id" = "pit_crew_responsibility_events"."property_id"'),
        true,
        query,
      );
      assert.equal(
        query.includes('"risk_exceptions"."property_id" = "pit_crew_responsibility_events"."property_id"'),
        true,
        query,
      );
    }

    const encoded = JSON.stringify({ agentInbox, adminInbox });
    assert.equal(encoded.includes(String(COST_SENTINEL)), false);
    assert.equal(encoded.includes(VENDOR_SENTINEL), false);
    assert.equal(encoded.includes(DESCRIPTION_SENTINEL), false);
    assert.equal(encoded.includes(String(FOREIGN_COST_SENTINEL)), false);
    assert.equal(encoded.includes(FOREIGN_VENDOR_SENTINEL), false);
    assert.equal(encoded.includes(FOREIGN_TITLE), false);
    assert.equal(encoded.includes(MISMATCH_TITLE), false);
    assert.equal(encoded.includes(AGENT_FINANCIAL_TITLE), false);

    const launch = agentInbox.items.find((item) => item.sourceRecordId === launchItemId);
    assert.ok(launch, "own-brokerage launch item is in the agent inbox");
    assert.equal(launch.sourceType, "LAUNCH_ITEM");
    assert.equal(launch.title, LAUNCH_TITLE);
    assert.equal(launch.note, LAUNCH_NOTE);
    assert.equal(launch.nextAction, LAUNCH_NEXT);
    assert.equal(launch.kind, "HAND_BACK");
    assert.equal(launch.propertyId, propertyId);
    assert.equal(agentInbox.items.some((item) => item.sourceRecordId === foreignItemId), false);
    assert.equal(adminInbox.items.some((item) => item.sourceRecordId === foreignItemId), false);
    assert.equal(agentInbox.items.some((item) => item.sourceRecordId === mismatchItemId), false);
    assert.equal(adminInbox.items.some((item) => item.sourceRecordId === mismatchItemId), false);
    assert.equal(adminInbox.items.some((item) => item.sourceType === "LAUNCH_ITEM"), false);

    const ordinary = agentInbox.items.find((item) => item.sourceRecordId === ordinaryExceptionId);
    const hidden = agentInbox.items.find((item) => item.sourceRecordId === agentFinancialExceptionId);
    assert.ok(ordinary && hidden);
    assert.equal(ordinary.sourceType, "EXCEPTION");
    assert.equal(ordinary.title, ORDINARY_TITLE);
    assert.equal(hidden.title, null);
    assert.equal(hidden.sourceType, "EXCEPTION");
    const adminItem = adminInbox.items.find((item) => item.sourceRecordId === adminFinancialExceptionId);
    assert.ok(adminItem);
    assert.equal(adminItem.title, listedExceptionTitle({ title: ADMIN_FINANCIAL_TITLE, requiresFinancialEntitlement: true }, true));
    assert.equal(adminItem.title, ADMIN_FINANCIAL_TITLE);
    assert.equal(adminItem.sourceType, "EXCEPTION");

    const offStatements: string[] = [];
    let offAgent: ResponsibilityInboxItem[] | undefined;
    let offAdmin: ResponsibilityInboxItem[] | undefined;
    await withLaunchFlag(undefined, async () => {
      const uninstall = setDbQueryObserver((query) => {
        offStatements.push(query);
      });
      try {
        const off = await readInboxes();
        offAgent = off.agentInbox.items;
        offAdmin = off.adminInbox.items;
      } finally {
        uninstall();
      }
    });
    assert.deepEqual(offStatements.filter((query) => query.includes("campaign_items")), []);
    assert.deepEqual(exceptionItems(agentInbox), offAgent);
    assert.deepEqual(adminInbox.items, offAdmin);
  });

  test("flag on: same property is shown, a different property is excluded, and another brokerage stays hidden", async () => {
    const [mismatchItem] = await db
      .select({ propertyId: campaignItems.propertyId, brokerageId: campaignItems.brokerageId })
      .from(campaignItems)
      .where(eq(campaignItems.id, mismatchItemId));
    assert.equal(mismatchItem.brokerageId, brokerageId);
    assert.equal(mismatchItem.propertyId, mismatchPropertyId);
    assert.notEqual(mismatchPropertyId, propertyId);

    let agentInbox: ResponsibilityInbox | undefined;
    let adminInbox: ResponsibilityInbox | undefined;
    await withLaunchFlag("true", async () => {
      assert.equal(isPitCrewLaunchItemSourceEnabled(), true);
      const read = await readInboxes();
      agentInbox = read.agentInbox;
      adminInbox = read.adminInbox;
    });
    assert.ok(agentInbox && adminInbox);

    const sameProperty = agentInbox.items.find((item) => item.sourceRecordId === launchItemId);
    assert.ok(sameProperty);
    assert.equal(sameProperty.sourceType, "LAUNCH_ITEM");
    assert.equal(sameProperty.title, LAUNCH_TITLE);
    assert.equal(sameProperty.propertyId, propertyId);

    assert.equal(agentInbox.items.some((item) => item.sourceRecordId === mismatchItemId), false);
    assert.equal(adminInbox.items.some((item) => item.sourceRecordId === mismatchItemId), false);
    assert.equal(agentInbox.items.some((item) => item.sourceRecordId === foreignItemId), false);
    assert.equal(adminInbox.items.some((item) => item.sourceRecordId === foreignItemId), false);

    const encoded = JSON.stringify({ agentInbox, adminInbox });
    assert.equal(encoded.includes(MISMATCH_TITLE), false);
    assert.equal(encoded.includes(FOREIGN_TITLE), false);
    assert.equal(encoded.includes(LAUNCH_TITLE), true);
  });

  test("flag on and flag off both exclude an exception on a different property (R-F25); flag off does not read campaign_items", async () => {
    const mismatchExceptionTitle = "Rf25 exception on the other property 4c8e";
    const mismatchExceptionId = await createException(brokerageId, mismatchPropertyId, { title: mismatchExceptionTitle });
    const [assignment] = await db
      .insert(pitCrewAssignments)
      .values({
        brokerageId,
        sourceType: "EXCEPTION",
        sourceRecordId: mismatchExceptionId,
        propertyId,
        status: "HANDED_BACK",
        assignedToUserId: admin.user.id,
        version: 2,
      })
      .returning({ id: pitCrewAssignments.id });
    await db.insert(pitCrewResponsibilityEvents).values({
      brokerageId,
      assignmentId: assignment.id,
      propertyId,
      kind: "HAND_BACK",
      reasonCategory: "WORK_COMPLETE",
      note: "Exception property does not match the event.",
      nextAction: "Leave this row out of the flag-on inbox.",
      originatingUserId: admin.user.id,
      recipientUserId: agent.user.id,
      resultingResponsibility: "AGENT",
      status: "OPEN",
    });

    await withLaunchFlag("true", async () => {
      const { agentInbox, adminInbox } = await readInboxes();
      const encoded = JSON.stringify({ agentInbox, adminInbox });
      assert.equal(agentInbox.items.some((item) => item.sourceRecordId === mismatchExceptionId), false);
      assert.equal(adminInbox.items.some((item) => item.sourceRecordId === mismatchExceptionId), false);
      assert.equal(encoded.includes(mismatchExceptionTitle), false);
    });

    const statements: string[] = [];
    await withLaunchFlag(undefined, async () => {
      const uninstall = setDbQueryObserver((query) => {
        statements.push(query);
      });
      try {
        // R-F25: the flag-off exception join now applies the flag-on property rule, so the row is hidden here too.
        const { agentInbox, adminInbox } = await readInboxes();
        assert.equal(agentInbox.items.some((item) => item.sourceRecordId === mismatchExceptionId), false);
        assert.equal(adminInbox.items.some((item) => item.sourceRecordId === mismatchExceptionId), false);
        assert.equal(JSON.stringify({ agentInbox, adminInbox }).includes(mismatchExceptionTitle), false);
      } finally {
        uninstall();
      }
    });
    assert.deepEqual(
      statements.filter((query) => query.includes("campaign_items")),
      [],
    );
  });

  test("flag on excludes a COMPLETE campaign item and still shows a BLOCKED one", async () => {
    const completeTitle = "Rf28 complete campaign item 3e91";
    const blockedTitle = "Rf28 blocked campaign item 3e91";
    const completeId = await insertCampaignItem({
      targetBrokerageId: brokerageId,
      targetPropertyId: propertyId,
      createdBy: admin.user.id,
      title: completeTitle,
      costCents: COST_SENTINEL,
      vendorName: VENDOR_SENTINEL,
      status: "COMPLETE",
    });
    const blockedId = await insertCampaignItem({
      targetBrokerageId: brokerageId,
      targetPropertyId: propertyId,
      createdBy: admin.user.id,
      title: blockedTitle,
      costCents: COST_SENTINEL,
      vendorName: VENDOR_SENTINEL,
      status: "BLOCKED",
    });
    await insertLaunchResponsibility(completeId);
    await insertLaunchResponsibility(blockedId);

    await withLaunchFlag("true", async () => {
      const { agentInbox, adminInbox } = await readInboxes();
      const encoded = JSON.stringify({ agentInbox, adminInbox });
      assert.equal(agentInbox.items.some((item) => item.sourceRecordId === completeId), false);
      assert.equal(adminInbox.items.some((item) => item.sourceRecordId === completeId), false);
      assert.equal(encoded.includes(completeTitle), false);
      const blocked = agentInbox.items.find((item) => item.sourceRecordId === blockedId);
      assert.ok(blocked);
      assert.equal(blocked.sourceType, "LAUNCH_ITEM");
      assert.equal(blocked.title, blockedTitle);
      assert.equal(blocked.propertyId, propertyId);
      assert.equal(encoded.includes(String(COST_SENTINEL)), false);
      assert.equal(encoded.includes(VENDOR_SENTINEL), false);
    });

    const statements: string[] = [];
    await withLaunchFlag(undefined, async () => {
      const uninstall = setDbQueryObserver((query) => {
        statements.push(query);
      });
      try {
        const { agentInbox } = await readInboxes();
        assert.equal(agentInbox.items.some((item) => item.sourceRecordId === completeId), false);
        assert.equal(agentInbox.items.some((item) => item.sourceRecordId === blockedId), false);
        assert.equal(agentInbox.items.some((item) => item.sourceType === "LAUNCH_ITEM"), false);
      } finally {
        uninstall();
      }
    });
    assert.deepEqual(
      statements.filter((query) => query.includes("campaign_items")),
      [],
    );
  });

  test("LAUNCH_ITEM hand-back and escalate 404 unless both flags are on, then succeed without writing the campaign item", async () => {
    const handBackId = await insertCampaignItem({
      targetBrokerageId: brokerageId,
      targetPropertyId: propertyId,
      createdBy: admin.user.id,
      title: "Rf28 hand back photographer",
      costCents: COST_SENTINEL,
      vendorName: VENDOR_SENTINEL,
    });
    const escalateId = await insertCampaignItem({
      targetBrokerageId: brokerageId,
      targetPropertyId: propertyId,
      createdBy: admin.user.id,
      title: "Rf28 escalate photographer",
      costCents: COST_SENTINEL,
      vendorName: VENDOR_SENTINEL,
    });
    const [beforeHandBack] = await db.select().from(campaignItems).where(eq(campaignItems.id, handBackId));
    const [beforeEscalate] = await db.select().from(campaignItems).where(eq(campaignItems.id, escalateId));
    const [beforeFixtureEvents] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pitCrewResponsibilityEvents)
      .where(eq(pitCrewResponsibilityEvents.assignmentId, launchAssignmentId));

    const cases = [
      {
        action: "hand-back",
        sourceRecordId: handBackId,
        body: {
          propertyId,
          expectedVersion: 0,
          reasonCategory: "WORK_COMPLETE",
          nextAction: "Confirm the Saturday shoot time.",
        },
      },
      {
        action: "escalate",
        sourceRecordId: escalateId,
        body: {
          propertyId,
          expectedVersion: 0,
          reasonCategory: "MISSING_AUTHORITY",
          severity: "ATTENTION",
          note: "Outside Pit Crew authority.",
          nextAction: "Decide the next step.",
        },
      },
    ];

    const previousResponsibility = process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
    try {
      for (const flagCase of FLAG_OFF) {
        if (flagCase.value === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
        else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = flagCase.value;
        await withLaunchFlag("true", async () => {
          for (const actionCase of cases) {
            const res = await fetch(`${baseUrl}/api/pit-crew/items/LAUNCH_ITEM/${actionCase.sourceRecordId}/${actionCase.action}`, {
              method: "POST",
              headers: { cookie: admin.cookie, "content-type": "application/json" },
              body: JSON.stringify(actionCase.body),
            });
            const text = await res.text();
            assert.equal(res.status, 404, `${flagCase.label} ${actionCase.action} ${text}`);
            assert.equal(text, JSON.stringify({ error: "Not found." }), `${flagCase.label} ${actionCase.action}`);
          }
        });
      }

      process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = "true";
      for (const flagCase of FLAG_OFF) {
        const statements: string[] = [];
        await withLaunchFlag(flagCase.value, async () => {
          const uninstall = setDbQueryObserver((query) => {
            statements.push(query);
          });
          try {
            for (const actionCase of cases) {
              const res = await fetch(`${baseUrl}/api/pit-crew/items/LAUNCH_ITEM/${actionCase.sourceRecordId}/${actionCase.action}`, {
                method: "POST",
                headers: { cookie: admin.cookie, "content-type": "application/json" },
                body: JSON.stringify(actionCase.body),
              });
              const text = await res.text();
              assert.equal(res.status, 404, `${flagCase.label} ${actionCase.action} ${text}`);
              assert.equal(text, WORK_ITEM_NOT_FOUND, `${flagCase.label} ${actionCase.action}`);
            }
          } finally {
            uninstall();
          }
        });
        assert.deepEqual(
          statements.filter((query) => query.includes("campaign_items")),
          [],
          flagCase.label,
        );
      }

      await withLaunchFlag("true", async () => {
        const handClaim = await claimWorkItem({
          brokerageId,
          propertyId,
          sourceType: "LAUNCH_ITEM",
          sourceRecordId: handBackId,
          expectedVersion: 0,
          actorUserId: admin.user.id,
          actorEmail: admin.user.email,
        });
        const escalateClaim = await claimWorkItem({
          brokerageId,
          propertyId,
          sourceType: "LAUNCH_ITEM",
          sourceRecordId: escalateId,
          expectedVersion: 0,
          actorUserId: admin.user.id,
          actorEmail: admin.user.email,
        });
        const handed = await fetch(`${baseUrl}/api/pit-crew/items/LAUNCH_ITEM/${handBackId}/hand-back`, {
          method: "POST",
          headers: { cookie: admin.cookie, "content-type": "application/json" },
          body: JSON.stringify({ ...cases[0].body, expectedVersion: handClaim.version }),
        });
        const handedText = await handed.text();
        assert.equal(handed.status, 200, handedText);
        const handedBody = JSON.parse(handedText) as {
          status: string;
          responsibilityEvent: { kind: string; resultingResponsibility: string; recipientUserId: number; severity: null };
        };
        assert.equal(handedBody.status, "HANDED_BACK");
        assert.equal(handedBody.responsibilityEvent.kind, "HAND_BACK");
        assert.equal(handedBody.responsibilityEvent.resultingResponsibility, "AGENT");
        assert.equal(handedBody.responsibilityEvent.recipientUserId, agent.user.id);
        assert.equal(handedBody.responsibilityEvent.severity, null);
        assert.equal(handedText.includes(String(COST_SENTINEL)), false);
        assert.equal(handedText.includes(VENDOR_SENTINEL), false);

        const escalated = await fetch(`${baseUrl}/api/pit-crew/items/LAUNCH_ITEM/${escalateId}/escalate`, {
          method: "POST",
          headers: { cookie: admin.cookie, "content-type": "application/json" },
          body: JSON.stringify({ ...cases[1].body, expectedVersion: escalateClaim.version }),
        });
        const escalatedText = await escalated.text();
        assert.equal(escalated.status, 200, escalatedText);
        const escalatedBody = JSON.parse(escalatedText) as {
          status: string;
          assignedToUserId: number;
          responsibilityEvent: { kind: string; resultingResponsibility: string; recipientUserId: number | null; recipientRole: string };
        };
        assert.equal(escalatedBody.status, "ESCALATED");
        assert.equal(escalatedBody.assignedToUserId, admin.user.id);
        assert.equal(escalatedBody.responsibilityEvent.kind, "ESCALATION");
        assert.equal(escalatedBody.responsibilityEvent.resultingResponsibility, "BROKERAGE_ADMINISTRATOR");
        assert.equal(escalatedBody.responsibilityEvent.recipientUserId, null);
        assert.equal(escalatedBody.responsibilityEvent.recipientRole, "Brokerage Administrator");
        assert.equal(escalatedText.includes(String(COST_SENTINEL)), false);
        assert.equal(escalatedText.includes(VENDOR_SENTINEL), false);
      });
    } finally {
      if (previousResponsibility === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
      else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = previousResponsibility;
    }

    const [afterHandBack] = await db.select().from(campaignItems).where(eq(campaignItems.id, handBackId));
    const [afterEscalate] = await db.select().from(campaignItems).where(eq(campaignItems.id, escalateId));
    assert.deepEqual(afterHandBack, beforeHandBack);
    assert.deepEqual(afterEscalate, beforeEscalate);
    const [afterFixtureEvents] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pitCrewResponsibilityEvents)
      .where(eq(pitCrewResponsibilityEvents.assignmentId, launchAssignmentId));
    assert.equal(Number(afterFixtureEvents?.n ?? 0), Number(beforeFixtureEvents?.n ?? 0));
  });
});
