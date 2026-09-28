// R-F21 — source types outside PIT_CREW_WORK_SOURCE_TYPES are rejected in
// assertSourceRecordOnPropertyInBrokerage with the same not-found response
// as a missing exception. itemParamsSchema stays a non-empty string, so
// this is not a 400. The rejection does not increment
// tenant_isolation_rejection_total, and it does not insert or update a
// pit_crew_assignments row. The caller's own property is used so the
// property check passes and the source-type guard is what answers.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, pitCrewAssignments } from "@aee/db";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
import { cleanupBrokerages, createBrokerageWithUsers, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const WORK_ITEM_NOT_FOUND = JSON.stringify({ error: "Work item not found in this brokerage." });
const KNOWN_FOREIGN_SOURCE_TYPES = ["LAUNCH_ITEM", "AUTOMATION_TASK", "OFFER"] as const;

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const randomSourceType = `rf21-${randomUUID()}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let propertyId: number;

function headers(cookie: string): Record<string, string> {
  return { cookie, "content-type": "application/json" };
}

async function postRaw(path: string, cookie: string, body: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: headers(cookie),
    body: JSON.stringify(body),
  });
}

function isolationSeries(): Array<{ boundary: string; value: number }> {
  const found: Array<{ boundary: string; value: number }> = [];
  for (const line of renderMetricsText().split("\n")) {
    if (!line.startsWith("tenant_isolation_rejection_total{")) continue;
    const match = /^tenant_isolation_rejection_total\{boundary="([^"]*)"\} (\d+)$/.exec(line);
    assert.ok(match, `unparsed metric line: ${line}`);
    found.push({ boundary: match[1], value: Number(match[2]) });
  }
  return found;
}

function assertNoIncrement(): void {
  assert.deepEqual(isolationSeries(), []);
}

async function responseText(res: Response): Promise<{ status: number; contentType: string; text: string }> {
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    text: await res.text(),
  };
}

async function assignmentCount(brokerageId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pitCrewAssignments)
    .where(eq(pitCrewAssignments.brokerageId, brokerageId));
  return Number(row?.n ?? 0);
}

async function keyCount(sourceType: string, sourceRecordId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pitCrewAssignments)
    .where(and(eq(pitCrewAssignments.sourceType, sourceType), eq(pitCrewAssignments.sourceRecordId, sourceRecordId)));
  return Number(row?.n ?? 0);
}

async function assignmentSnapshot(brokerageId: number) {
  return db
    .select({
      id: pitCrewAssignments.id,
      sourceType: pitCrewAssignments.sourceType,
      sourceRecordId: pitCrewAssignments.sourceRecordId,
      status: pitCrewAssignments.status,
      version: pitCrewAssignments.version,
      updatedAt: pitCrewAssignments.updatedAt,
      assignedToUserId: pitCrewAssignments.assignedToUserId,
    })
    .from(pitCrewAssignments)
    .where(eq(pitCrewAssignments.brokerageId, brokerageId))
    .orderBy(asc(pitCrewAssignments.id));
}

type ActionCase = {
  action: string;
  body: Record<string, unknown>;
};

function actionCases(): ActionCase[] {
  const base = { propertyId, expectedVersion: 0 };
  return [
    { action: "claim", body: base },
    { action: "assign", body: { ...base, assigneeUserId: A.agent.user.id } },
    { action: "start", body: base },
    { action: "waiting-on", body: { ...base, waitingOnParty: "Vendor" } },
    { action: "return", body: base },
    { action: "complete", body: base },
    { action: "release", body: base },
    { action: "handoff", body: { ...base, toUserId: A.agent.user.id, note: "cover" } },
  ];
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

  A = await createBrokerageWithUsers(baseUrl, `R-F21 Source Type ${suffix}`);
  const property = await postRaw("/properties", A.agent.cookie, {
    formattedAddress: `${suffix} Source Type St`,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(property.status, 201);
  propertyId = ((await property.json()) as { property: { id: number } }).property.id;
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

describe("R-F21 unknown Pit Crew source types match a missing exception", { concurrency: 1 }, () => {
  for (const actionCase of [
    "claim",
    "assign",
    "start",
    "waiting-on",
    "return",
    "complete",
    "release",
    "handoff",
  ] as const) {
    test(`${actionCase} rejects LAUNCH_ITEM, AUTOMATION_TASK, OFFER, and a random source type like a missing exception`, async () => {
      const { action, body } = actionCases().find((entry) => entry.action === actionCase)!;
      const sourceTypes = [...KNOWN_FOREIGN_SOURCE_TYPES, randomSourceType];

      resetMetricsForTesting();
      const missing = await responseText(
        await postRaw(`/pit-crew/items/EXCEPTION/${randomUUID()}/${action}`, A.admin.cookie, body),
      );
      assert.equal(missing.status, 404);
      assert.match(missing.contentType, /^application\/json/);
      assert.equal(missing.text, WORK_ITEM_NOT_FOUND);
      assertNoIncrement();

      for (const sourceType of sourceTypes) {
        const sourceRecordId = randomUUID();
        const beforeCount = await assignmentCount(A.brokerageId);
        const beforeKey = await keyCount(sourceType, sourceRecordId);
        const beforeRows = await assignmentSnapshot(A.brokerageId);
        assert.equal(beforeKey, 0);

        resetMetricsForTesting();
        const rejected = await responseText(
          await postRaw(
            `/pit-crew/items/${encodeURIComponent(sourceType)}/${sourceRecordId}/${action}`,
            A.admin.cookie,
            body,
          ),
        );

        assert.equal(rejected.status, missing.status, sourceType);
        assert.equal(rejected.contentType, missing.contentType, sourceType);
        assert.equal(rejected.text, missing.text, sourceType);
        assert.equal(await assignmentCount(A.brokerageId), beforeCount, sourceType);
        assert.equal(await keyCount(sourceType, sourceRecordId), 0, sourceType);
        assert.deepEqual(await assignmentSnapshot(A.brokerageId), beforeRows, sourceType);
        assertNoIncrement();
      }
    });
  }
});
