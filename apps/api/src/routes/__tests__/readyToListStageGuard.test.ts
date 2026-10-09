// R-F31 — POST /properties/:id/ready-to-list may advance workflowStage only
// from a pre-listing stage (Appraisal, which is also where Grow's run
// handoff leaves the property). A second call at Ready to List is a 200
// replay with no new audit row. Every later stage is a 400 and changes
// nothing. Cross-brokerage stays the existing 404.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  WORKFLOW_STAGES,
  amlVerifications,
  auditLogs,
  db,
  documentPackages,
  domainEvents,
  properties,
  workflows,
} from "@aee/db";
import {
  createBrokerageWithUsers,
  cleanupBrokerages,
  type DevLoginResult,
} from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const READY_TO_LIST_STAGE = "Ready to List";
const AUDIT_ACTION = "PROPERTY_READY_TO_LIST";
const LATER_STAGES = WORKFLOW_STAGES.slice(WORKFLOW_STAGES.indexOf(READY_TO_LIST_STAGE) + 1);

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let propertyId: number;

function headers(cookie: string) {
  return { "content-type": "application/json", cookie };
}

async function postReadyToList(cookie: string, id: number) {
  return fetch(`${baseUrl}/api/properties/${id}/ready-to-list`, {
    method: "POST",
    headers: headers(cookie),
  });
}

async function bodyOf<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got ${res.status}: ${text}`);
  }
}

async function setStage(stage: string) {
  await db.update(properties).set({ workflowStage: stage }).where(eq(properties.id, propertyId));
}

async function loadProperty() {
  const [property] = await db.select().from(properties).where(eq(properties.id, propertyId));
  assert.ok(property);
  return property;
}

async function relatedIds() {
  const audits = await db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.propertyId, propertyId));
  const workflowRows = await db.select({ id: workflows.id }).from(workflows).where(eq(workflows.propertyId, propertyId));
  const packages = await db
    .select({ id: documentPackages.id })
    .from(documentPackages)
    .where(eq(documentPackages.propertyId, propertyId));
  const aml = await db
    .select({ id: amlVerifications.id })
    .from(amlVerifications)
    .where(eq(amlVerifications.propertyId, propertyId));
  const events = await db.select({ id: domainEvents.id }).from(domainEvents).where(eq(domainEvents.propertyId, propertyId));
  const sortNumbers = (ids: number[]) => ids.sort((a, b) => a - b);
  const sortStrings = (ids: string[]) => ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    auditIds: sortNumbers(audits.map((row) => row.id)),
    workflowIds: sortNumbers(workflowRows.map((row) => row.id)),
    packageIds: sortNumbers(packages.map((row) => row.id)),
    amlIds: sortNumbers(aml.map((row) => row.id)),
    eventIds: sortStrings(events.map((row) => row.id)),
  };
}

async function readyToListAudits() {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.propertyId, propertyId), eq(auditLogs.action, AUDIT_ACTION)));
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `Ready To List Guard A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Ready To List Guard B ${suffix}`);

  const propRes = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: headers(A.agent.cookie),
    body: JSON.stringify({
      formattedAddress: "1 Ready To List Guard St",
      state: "NSW",
      suburb: "Testville",
      postcode: "2000",
    }),
  });
  assert.equal(propRes.status, 201);
  const { property } = await bodyOf<{ property: { id: number; workflowStage: string } }>(propRes);
  propertyId = property.id;
  assert.equal(property.workflowStage, "Appraisal");

  const partyRes = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: headers(A.agent.cookie),
    body: JSON.stringify({
      propertyId,
      role: "Seller",
      firstName: "Sam",
      lastName: "Seller",
      email: `rtl-guard-${suffix}@example.com`,
    }),
  });
  assert.equal(partyRes.status, 201);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("R-F31: a property in another brokerage is still 404 and is not moved", async () => {
  const before = await loadProperty();
  const beforeIds = await relatedIds();
  const res = await postReadyToList(B.agent.cookie, propertyId);
  assert.deepEqual(await bodyOf(res), { error: "Not found" });
  assert.equal(res.status, 404);
  assert.deepEqual(await loadProperty(), before);
  assert.deepEqual(await relatedIds(), beforeIds);
});

test("R-F31: each later stage refuses with a plain 400 and changes nothing", async () => {
  assert.ok(LATER_STAGES.length >= 5, "Listed, Under Offer, Contract, Settlement, and Closed must all be covered");
  for (const stage of LATER_STAGES) {
    await setStage(stage);
    const before = await loadProperty();
    const beforeIds = await relatedIds();
    assert.equal(before.workflowStage, stage);

    const res = await postReadyToList(A.agent.cookie, propertyId);
    const body = await bodyOf<{ error: string }>(res);
    assert.equal(res.status, 400);
    assert.deepEqual(body, {
      error: `Ready to List cannot move a property that is already at ${stage}.`,
    });
    assert.deepEqual(await loadProperty(), before);
    assert.deepEqual(await relatedIds(), beforeIds);
    assert.equal((await readyToListAudits()).length, 0);
  }
});

test("R-F31: Appraisal advances to Ready to List and writes one audit row", async () => {
  await setStage("Appraisal");
  const beforeIds = await relatedIds();
  const res = await postReadyToList(A.agent.cookie, propertyId);
  assert.equal(res.status, 200);
  const body = await bodyOf<{ workflow: { id: number }; documentPackage: { id: number } }>(res);
  assert.equal(typeof body.workflow.id, "number");
  assert.equal(typeof body.documentPackage.id, "number");

  const property = await loadProperty();
  assert.equal(property.workflowStage, READY_TO_LIST_STAGE);

  const audits = await readyToListAudits();
  assert.equal(audits.length, 1);
  const audit = audits[0]!;
  assert.equal(audit.action, AUDIT_ACTION);
  assert.equal(audit.brokerageId, A.brokerageId);
  assert.equal(audit.userId, A.agent.user.id);
  assert.equal(audit.propertyId, propertyId);
  assert.equal(audit.recordType, "property");
  assert.equal(audit.recordId, String(propertyId));
  assert.equal(audit.previousValue, "Appraisal");
  assert.equal(audit.updatedValue, READY_TO_LIST_STAGE);
  assert.equal((await relatedIds()).auditIds.length, beforeIds.auditIds.length + 1);
});

test("R-F31: replaying Ready to List is 200 and writes no new audit row", async () => {
  const before = await loadProperty();
  assert.equal(before.workflowStage, READY_TO_LIST_STAGE);
  const beforeAudits = await readyToListAudits();
  assert.equal(beforeAudits.length, 1);
  const beforeIds = await relatedIds();

  const res = await postReadyToList(A.agent.cookie, propertyId);
  assert.equal(res.status, 200);
  const body = await bodyOf<{ workflow: { id: number }; documentPackage: { id: number } }>(res);
  assert.equal(typeof body.workflow.id, "number");
  assert.equal(typeof body.documentPackage.id, "number");

  const after = await loadProperty();
  assert.equal(after.workflowStage, READY_TO_LIST_STAGE);
  const audits = await readyToListAudits();
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.id, beforeAudits[0]!.id);
  const afterIds = await relatedIds();
  assert.deepEqual(afterIds.auditIds, beforeIds.auditIds);
  assert.deepEqual(afterIds.workflowIds, beforeIds.workflowIds);
  assert.deepEqual(afterIds.packageIds, beforeIds.packageIds);
  assert.deepEqual(afterIds.amlIds, beforeIds.amlIds);
  assert.deepEqual(afterIds.eventIds, beforeIds.eventIds);
});

test("R-F31: after Ready to List, each later stage still refuses and stays put", async () => {
  for (const stage of LATER_STAGES) {
    await setStage(stage);
    const before = await loadProperty();
    const beforeIds = await relatedIds();
    const beforeAudits = await readyToListAudits();

    const res = await postReadyToList(A.agent.cookie, propertyId);
    assert.equal(res.status, 400);
    assert.deepEqual(await bodyOf(res), {
      error: `Ready to List cannot move a property that is already at ${stage}.`,
    });
    assert.deepEqual(await loadProperty(), before);
    assert.deepEqual(await relatedIds(), beforeIds);
    assert.equal((await readyToListAudits()).length, beforeAudits.length);
    assert.notEqual((await loadProperty()).workflowStage, READY_TO_LIST_STAGE);
  }
});

test("R-F31: a later-stage property in another brokerage is still 404", async () => {
  await setStage("Listed");
  const before = await loadProperty();
  const beforeIds = await relatedIds();
  const res = await postReadyToList(B.agent.cookie, propertyId);
  assert.equal(res.status, 404);
  assert.deepEqual(await bodyOf(res), { error: "Not found" });
  assert.deepEqual(await loadProperty(), before);
  assert.deepEqual(await relatedIds(), beforeIds);
});
