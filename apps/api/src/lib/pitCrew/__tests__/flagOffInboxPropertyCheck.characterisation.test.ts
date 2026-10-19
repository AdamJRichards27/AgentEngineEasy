// P-02: CHARACTERISATION TESTS ONLY. They pin CURRENT (possibly wrong) behaviour; nothing here is a fix.
//
// Gap (R-F25 follow-up; P01-PIT-CREW-SLICES.md "Rejected or deferred": "R-F25 flag-off inbox has no exception property
// match (queries.ts:667-674 vs flag-on :776)"; QUEUE P-02: "flag-off listExceptionResponsibilityInbox with no exception
// property check"). With PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED not the literal "true", listResponsibilityItemsForRecipient
// uses listExceptionResponsibilityInbox, whose risk_exceptions inner join checks source type, id and brokerage but NOT
// risk_exceptions.property_id = pit_crew_responsibility_events.property_id. The flag-on join does check it.
//
// HOW TO READ THIS FILE
// - Tests named "[P-02 GAP]" pin the gap. They are expected to FLIP when an Owner-approved fix lands: each one says
//   "CURRENT:" (what it asserts now) and "INTENDED (likely):" (what the fix would assert). Search for P02_GAP.
// - Tests named "[P-02 LOCK]" pin neighbouring behaviour that a fix must NOT change (brokerage scope, the matching
//   control row). They should stay green after the fix.
// - Mismatched rows are inserted directly: no application write path can produce them today (hand-back/escalate run
//   assertSourceRecordOnPropertyInBrokerage, which requires the exception on the request property, and nothing updates
//   risk_exceptions.property_id). So in production the gap needs data drift (manual fix-up, import, legacy rows).
// - Flags: PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED is set to "true" IN THIS TEST PROCESS ONLY (the inbox refuses
//   otherwise), exactly as responsibilityInbox.test.ts and launchItemInbox.test.ts do, and restored afterwards.
//   PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED is deleted for the whole file (that is the "flag-off" in "flag-off inbox").
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  entitlementGrants,
  pitCrewAssignments,
  pitCrewResponsibilityEvents,
  riskExceptions,
  setDbQueryObserver,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../entitlements/resolver.js";
import { createOrUpdateException, newCorrelationId } from "../../exceptions/model.js";
import type { RiskFinding } from "../../exceptions/types.js";
import { PitCrewPropertyMismatchError } from "../assignment.js";
import { PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG, isPitCrewLaunchItemSourceEnabled } from "../launchItemSource.js";
import { listResponsibilityItemsForRecipient } from "../queries.js";
import { PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG, acknowledgeEscalation, reclaimHandedBack } from "../responsibility.js";
import type { ResponsibilityInbox, ResponsibilityInboxItem } from "../types.js";
import { cleanupBrokerages, createBrokerageWithUsers, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

/** Marker the future fix flips: every [P-02 GAP] test asserts against this documented current behaviour. */
const P02_GAP = "P-02 characterises the flag-off inbox with no exception property check (R-F25)";

const MISMATCH_TITLE = "P02-exception-on-the-OTHER-property-7d1e";
const MISMATCH_ROLE_TITLE = "P02-role-escalation-other-property-7d1e";
const MISMATCH_ASSIGNMENT_TITLE = "P02-assignment-on-exception-property-7d1e";
const FIN_AGENT_TITLE = "P02-financial-agent-7d1e 445566";
const FIN_ADMIN_TITLE = "P02-financial-admin-7d1e 778899";
const CONTROL_TITLE = "P02-control-same-property-7d1e";
const FOREIGN_TITLE = "P02-foreign-brokerage-exception-7d1e";
const FOREIGN_EVENT_PROPERTY_TITLE = "P02-event-on-foreign-property-7d1e";

let server: Server;
let baseUrl: string;
let admin: DevLoginResult;
let agent: DevLoginResult;
let foreignAdmin: DevLoginResult;
let brokerageId: number;
let otherBrokerageId: number;
let eventPropertyId: number; // P1: where the responsibility event (and the overlay) say the work is
let exceptionPropertyId: number; // P2: same brokerage, where the exception actually is
let foreignPropertyId: number; // PB: brokerage B
let eventPropertyAddress: string;
let savedResponsibilityFlag: string | undefined;
let savedLaunchFlag: string | undefined;
let counter = 0;

const ids: Record<string, string> = {};

function finding(targetPropertyId: number, targetBrokerageId: number, overrides: Partial<RiskFinding>): RiskFinding {
  counter += 1;
  return {
    ruleId: "TEST_P02_INBOX_PROPERTY_RULE",
    ruleVersion: 1,
    category: "WORKFLOW_OPERATIONAL",
    severity: "ATTENTION",
    title: `P02 finding ${counter}`,
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
    dedupKey: `TEST_P02_INBOX_PROPERTY_RULE:${targetBrokerageId}:P02_${counter}_${Date.now()}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
    ...overrides,
  };
}

async function createException(targetBrokerageId: number, targetPropertyId: number, overrides: Partial<RiskFinding>): Promise<string> {
  const result = await createOrUpdateException(finding(targetPropertyId, targetBrokerageId, overrides), targetBrokerageId, targetPropertyId, null, newCorrelationId(), null);
  return result.exception.id;
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

/** Direct fixture insert (see header): an EXCEPTION overlay plus one open event, in brokerage A unless stated. */
async function insertResponsibility(input: {
  exceptionId: string;
  assignmentPropertyId: number;
  eventPropertyId: number;
  kind: "HAND_BACK" | "ESCALATION";
  recipient: { userId: number } | { role: string };
}): Promise<number> {
  const status = input.kind === "HAND_BACK" ? "HANDED_BACK" : "ESCALATED";
  const [assignment] = await db
    .insert(pitCrewAssignments)
    .values({
      brokerageId,
      sourceType: "EXCEPTION",
      sourceRecordId: input.exceptionId,
      propertyId: input.assignmentPropertyId,
      status,
      assignedToUserId: admin.user.id,
      version: 2,
    })
    .returning({ id: pitCrewAssignments.id });
  await db.insert(pitCrewResponsibilityEvents).values({
    brokerageId,
    assignmentId: assignment.id,
    propertyId: input.eventPropertyId,
    kind: input.kind,
    reasonCategory: input.kind === "HAND_BACK" ? "WORK_COMPLETE" : "MISSING_AUTHORITY",
    ...(input.kind === "ESCALATION" ? { severity: "ATTENTION" } : {}),
    note: "P02 fixture note.",
    nextAction: "P02 fixture next action.",
    originatingUserId: admin.user.id,
    ...("userId" in input.recipient ? { recipientUserId: input.recipient.userId } : { recipientRole: input.recipient.role }),
    resultingResponsibility: input.kind === "HAND_BACK" ? "AGENT" : "BROKERAGE_ADMINISTRATOR",
    status: "OPEN",
  });
  return assignment.id;
}

const find = (inbox: ResponsibilityInbox, exceptionId: string): ResponsibilityInboxItem | undefined =>
  inbox.items.find((item) => item.sourceRecordId === exceptionId);
const agentInbox = () => listResponsibilityItemsForRecipient(brokerageId, agent.user.id, "Agent");
const adminInbox = () => listResponsibilityItemsForRecipient(brokerageId, admin.user.id, "Brokerage Administrator");

before(async () => {
  savedResponsibilityFlag = process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
  savedLaunchFlag = process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG];
  process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = "true";
  delete process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG];

  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { createApp } = await import("../../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const stamp = Date.now();
  const a = await createBrokerageWithUsers(baseUrl, `P02 Inbox A ${stamp}`);
  admin = a.admin;
  agent = a.agent;
  brokerageId = a.brokerageId;
  const b = await createBrokerageWithUsers(baseUrl, `P02 Inbox B ${stamp}`);
  foreignAdmin = b.admin;
  otherBrokerageId = b.brokerageId;

  eventPropertyAddress = `${stamp} P02 Event Property St`;
  eventPropertyId = await createProperty(agent.cookie, eventPropertyAddress);
  exceptionPropertyId = await createProperty(agent.cookie, `${stamp} P02 Exception Property St`);
  foreignPropertyId = await createProperty(foreignAdmin.cookie, `${stamp} P02 Foreign Property St`);

  ids.mismatch = await createException(brokerageId, exceptionPropertyId, { title: MISMATCH_TITLE });
  ids.mismatchRole = await createException(brokerageId, exceptionPropertyId, { title: MISMATCH_ROLE_TITLE });
  ids.mismatchAssignment = await createException(brokerageId, exceptionPropertyId, { title: MISMATCH_ASSIGNMENT_TITLE });
  ids.finAgent = await createException(brokerageId, exceptionPropertyId, { title: FIN_AGENT_TITLE, category: "FINANCIAL", requiresFinancialEntitlement: true });
  ids.finAdmin = await createException(brokerageId, exceptionPropertyId, { title: FIN_ADMIN_TITLE, category: "FINANCIAL", requiresFinancialEntitlement: true });
  ids.control = await createException(brokerageId, eventPropertyId, { title: CONTROL_TITLE });
  ids.foreign = await createException(otherBrokerageId, foreignPropertyId, { title: FOREIGN_TITLE });
  ids.foreignEventProperty = await createException(brokerageId, exceptionPropertyId, { title: FOREIGN_EVENT_PROPERTY_TITLE });

  // Event and overlay on P1, exception on P2 (same brokerage): the gap.
  await insertResponsibility({ exceptionId: ids.mismatch, assignmentPropertyId: eventPropertyId, eventPropertyId, kind: "HAND_BACK", recipient: { userId: agent.user.id } });
  await insertResponsibility({ exceptionId: ids.mismatchRole, assignmentPropertyId: eventPropertyId, eventPropertyId, kind: "ESCALATION", recipient: { role: "Brokerage Administrator" } });
  await insertResponsibility({ exceptionId: ids.finAgent, assignmentPropertyId: eventPropertyId, eventPropertyId, kind: "HAND_BACK", recipient: { userId: agent.user.id } });
  await insertResponsibility({ exceptionId: ids.finAdmin, assignmentPropertyId: eventPropertyId, eventPropertyId, kind: "ESCALATION", recipient: { role: "Brokerage Administrator" } });
  // Overlay on P2 (agrees with the exception) but the event on P1.
  await insertResponsibility({ exceptionId: ids.mismatchAssignment, assignmentPropertyId: exceptionPropertyId, eventPropertyId, kind: "HAND_BACK", recipient: { userId: agent.user.id } });
  // Control: everything on P1.
  await insertResponsibility({ exceptionId: ids.control, assignmentPropertyId: eventPropertyId, eventPropertyId, kind: "HAND_BACK", recipient: { userId: agent.user.id } });
  // Scope locks: exception in brokerage B; event pointing at brokerage B's property.
  await insertResponsibility({ exceptionId: ids.foreign, assignmentPropertyId: eventPropertyId, eventPropertyId, kind: "HAND_BACK", recipient: { userId: agent.user.id } });
  await insertResponsibility({ exceptionId: ids.foreignEventProperty, assignmentPropertyId: exceptionPropertyId, eventPropertyId: foreignPropertyId, kind: "HAND_BACK", recipient: { userId: agent.user.id } });
});

after(async () => {
  if (savedResponsibilityFlag === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
  else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = savedResponsibilityFlag;
  if (savedLaunchFlag === undefined) delete process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG];
  else process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG] = savedLaunchFlag;
  await cleanupBrokerages([brokerageId, otherBrokerageId].filter((id) => id != null));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("P-02 characterisation: flag-off responsibility inbox, exception property check (R-F25)", { concurrency: false }, () => {
  test("[P-02 LOCK] fixtures: the launch-item flag is off for this file and the mismatch is real", async () => {
    assert.equal(isPitCrewLaunchItemSourceEnabled(), false);
    const [row] = await db.select({ propertyId: riskExceptions.propertyId, brokerageId: riskExceptions.brokerageId }).from(riskExceptions).where(eq(riskExceptions.id, ids.mismatch));
    assert.equal(row.brokerageId, brokerageId);
    assert.equal(row.propertyId, exceptionPropertyId);
    assert.notEqual(exceptionPropertyId, eventPropertyId);
  });

  test("[P-02 GAP] user-recipient hand-back: an exception on another property is listed under the event's property", async () => {
    // CURRENT: listed. propertyId, propertyAddress and deepLink are the EVENT's property (P1); the title is the
    // exception's, which lives on P2. INTENDED (likely): excluded, as the flag-on inbox does, and the title not returned.
    const item = find(await agentInbox(), ids.mismatch);
    assert.ok(item, P02_GAP);
    assert.equal(item.sourceType, "EXCEPTION");
    assert.equal(item.title, MISMATCH_TITLE);
    assert.equal(item.propertyId, eventPropertyId);
    assert.equal(item.propertyAddress, eventPropertyAddress);
    assert.equal(item.deepLink, `/properties/${eventPropertyId}`);
    assert.notEqual(item.propertyId, exceptionPropertyId);
    assert.equal(item.kind, "HAND_BACK");
    assert.equal(item.assignmentStatus, "HANDED_BACK");
  });

  test("[P-02 GAP] role-recipient escalation: the Brokerage Administrator sees the mismatched row too", async () => {
    // CURRENT: listed for the role recipient. INTENDED (likely): excluded.
    const item = find(await adminInbox(), ids.mismatchRole);
    assert.ok(item, P02_GAP);
    assert.equal(item.kind, "ESCALATION");
    assert.equal(item.title, MISMATCH_ROLE_TITLE);
    assert.equal(item.propertyId, eventPropertyId);
    assert.equal(item.recipientRole, "Brokerage Administrator");
  });

  test("[P-02 GAP] overlay property is not compared either: overlay on the exception's property, event on another", async () => {
    // CURRENT: listed under the event's property even though overlay and exception agree on P2.
    // INTENDED (likely): excluded (the fix compares the exception to the EVENT, as the flag-on join does).
    const [overlay] = await db.select({ propertyId: pitCrewAssignments.propertyId }).from(pitCrewAssignments).where(eq(pitCrewAssignments.sourceRecordId, ids.mismatchAssignment));
    assert.equal(overlay.propertyId, exceptionPropertyId);
    const item = find(await agentInbox(), ids.mismatchAssignment);
    assert.ok(item, P02_GAP);
    assert.equal(item.propertyId, eventPropertyId);
    assert.equal(item.title, MISMATCH_ASSIGNMENT_TITLE);
  });

  test("[P-02 GAP] financial masking still applies to mismatched rows: Agent gets null, Brokerage Administrator gets the raw title", async () => {
    // CURRENT: both rows listed; listedExceptionTitle masks for the Agent and not for the admin.
    // INTENDED (likely): both rows excluded, so neither the masked placeholder nor the raw title appears.
    const agentItem = find(await agentInbox(), ids.finAgent);
    assert.ok(agentItem, P02_GAP);
    assert.equal(agentItem.title, null);
    assert.equal(JSON.stringify(await agentInbox()).includes(FIN_AGENT_TITLE), false);
    const adminItem = find(await adminInbox(), ids.finAdmin);
    assert.ok(adminItem, P02_GAP);
    assert.equal(adminItem.title, FIN_ADMIN_TITLE);
    assert.equal(adminItem.propertyId, eventPropertyId);
  });

  test("[P-02 GAP] the flag-off inbox SQL has no risk_exceptions.property_id = event.property_id condition", async () => {
    // CURRENT: the condition is absent from every statement the flag-off read runs, and campaign_items is not queried.
    // INTENDED (likely): present on the risk_exceptions join, as in listResponsibilityInboxIncludingLaunchItems.
    const condition = /"risk_exceptions"\."property_id"\s*=\s*"pit_crew_responsibility_events"\."property_id"/;
    // Self-check: the regex matches the SQL drizzle generates for exactly that condition, so its absence means something.
    const probe = db
      .select({ id: pitCrewResponsibilityEvents.id })
      .from(pitCrewResponsibilityEvents)
      .innerJoin(riskExceptions, and(sql`true`, eq(riskExceptions.propertyId, pitCrewResponsibilityEvents.propertyId)))
      .toSQL().sql;
    assert.match(probe, condition);

    const statements: string[] = [];
    const uninstall = setDbQueryObserver((query) => statements.push(query));
    try {
      await agentInbox();
    } finally {
      uninstall();
    }
    const inboxStatements = statements.filter((q) => q.includes("pit_crew_responsibility_events"));
    assert.ok(inboxStatements.length >= 1);
    assert.equal(inboxStatements.some((q) => condition.test(q)), false, P02_GAP);
    assert.equal(statements.some((q) => q.includes("campaign_items")), false);
  });

  test("[P-02 GAP] the listed row cannot be acted on: reclaim refuses with the event's property AND with the exception's property", async () => {
    // CURRENT: the inbox offers a row that every responsibility action rejects with the work-item 404, so it stays
    // OPEN until someone fixes the data. INTENDED (likely): the row is not listed, so nothing un-actionable is offered.
    // (The refusals themselves are correct isolation behaviour and should stay.)
    const [before] = await db.select().from(pitCrewAssignments).where(eq(pitCrewAssignments.sourceRecordId, ids.mismatch));
    for (const propertyId of [eventPropertyId, exceptionPropertyId]) {
      await assert.rejects(
        reclaimHandedBack({ brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId: ids.mismatch, expectedVersion: before.version, actorUserId: admin.user.id, actorEmail: admin.user.email }),
        (err: unknown) => err instanceof PitCrewPropertyMismatchError && err.message === "Work item not found in this brokerage.",
      );
    }
    const [after] = await db.select().from(pitCrewAssignments).where(eq(pitCrewAssignments.sourceRecordId, ids.mismatch));
    assert.deepEqual(after, before);
    assert.ok(find(await agentInbox(), ids.mismatch), P02_GAP);
  });

  test("[P-02 LOCK] acknowledge refuses the mismatched escalation (the action-side isolation a fix must keep)", async () => {
    // CURRENT and INTENDED: acknowledge 404s and the event stays OPEN. Today the same row IS listed for the admin
    // (role-recipient GAP test above), so the admin is offered an action that cannot succeed.
    const [overlay] = await db.select().from(pitCrewAssignments).where(eq(pitCrewAssignments.sourceRecordId, ids.mismatchRole));
    await assert.rejects(
      acknowledgeEscalation({ brokerageId, propertyId: eventPropertyId, sourceType: "EXCEPTION", sourceRecordId: ids.mismatchRole, expectedVersion: overlay.version, actorUserId: admin.user.id, actorEmail: admin.user.email }),
      (err: unknown) => err instanceof PitCrewPropertyMismatchError,
    );
    const [event] = await db.select({ status: pitCrewResponsibilityEvents.status }).from(pitCrewResponsibilityEvents).where(eq(pitCrewResponsibilityEvents.assignmentId, overlay.id));
    assert.equal(event.status, "OPEN");
  });

  test("[P-02 GAP] over HTTP: GET /api/pit-crew/responsibility-inbox returns the mismatched row to the Agent", async () => {
    // CURRENT: 200 with the row, deep-linking to the event's property. INTENDED (likely): 200 without the row.
    await db.update(entitlementGrants).set({ status: "Active" }).where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
    invalidateEntitlementCache(brokerageId);
    const res = await fetch(`${baseUrl}/api/pit-crew/responsibility-inbox`, { headers: { cookie: agent.cookie } });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const body = JSON.parse(text) as ResponsibilityInbox;
    const item = find(body, ids.mismatch);
    assert.ok(item, P02_GAP);
    assert.equal(item.deepLink, `/properties/${eventPropertyId}`);
    assert.equal(item.title, MISMATCH_TITLE);
  });

  test("[P-02 LOCK] control: an exception on the event's own property is listed (must stay listed after a fix)", async () => {
    const item = find(await agentInbox(), ids.control);
    assert.ok(item);
    assert.equal(item.title, CONTROL_TITLE);
    assert.equal(item.propertyId, eventPropertyId);
  });

  test("[P-02 LOCK] cross-brokerage: an exception in brokerage B is excluded from A's inbox, title absent", async () => {
    const inbox = await agentInbox();
    assert.equal(find(inbox, ids.foreign), undefined);
    assert.equal(JSON.stringify(inbox).includes(FOREIGN_TITLE), false);
  });

  test("[P-02 LOCK] cross-brokerage: an event that points at brokerage B's property is excluded", async () => {
    const inbox = await agentInbox();
    assert.equal(find(inbox, ids.foreignEventProperty), undefined);
    assert.equal(JSON.stringify(inbox).includes(FOREIGN_EVENT_PROPERTY_TITLE), false);
  });

  test("[P-02 LOCK] cross-brokerage: brokerage B's admin sees none of A's rows (mismatched or not)", async () => {
    const inbox = await listResponsibilityItemsForRecipient(otherBrokerageId, foreignAdmin.user.id, "Brokerage Administrator");
    const encoded = JSON.stringify(inbox);
    for (const id of Object.values(ids)) assert.equal(find(inbox, id), undefined, id);
    for (const title of [MISMATCH_TITLE, MISMATCH_ROLE_TITLE, FIN_ADMIN_TITLE, CONTROL_TITLE]) assert.equal(encoded.includes(title), false, title);
  });

  test("[P-02 GAP] summary of what A's Agent sees today (the three GAP rows flip to absent on a fix; the rest stay)", async () => {
    const inbox = await agentInbox();
    const present = (id: string) => find(inbox, id) !== undefined;
    assert.deepEqual(
      {
        mismatch: present(ids.mismatch), // GAP: true today, false after a fix
        mismatchAssignment: present(ids.mismatchAssignment), // GAP: true today, false after a fix
        finAgent: present(ids.finAgent), // GAP: true today, false after a fix
        control: present(ids.control), // stays true
        foreign: present(ids.foreign), // stays false
        foreignEventProperty: present(ids.foreignEventProperty), // stays false
      },
      { mismatch: true, mismatchAssignment: true, finAgent: true, control: true, foreign: false, foreignEventProperty: false },
    );
  });
});
