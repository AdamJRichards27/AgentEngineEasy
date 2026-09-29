// R-F22 — LAUNCH_ITEM Pit Crew source.
// Flag off: the eight item actions return the missing-exception 404, write
// no overlay, and do not query campaign_items.
// Flag on: complete sets the overlay to DONE and leaves the campaign item
// status and completed_at unchanged. Cross-brokerage and cross-property
// ids 404 and write nothing. Other source types stay rejected. A caller
// without the Pit Crew role, or without run.access, gets the same refusal
// as for an EXCEPTION action.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { campaignItems, db, entitlementGrants, launchPlans, pitCrewAssignments, pitCrewResponsibilityEvents, setDbQueryObserver } from "@aee/db";
import { PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG } from "../../lib/pitCrew/launchItemSource.js";
import { PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG } from "../../lib/pitCrew/responsibility.js";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { cleanupBrokerages, createBrokerageWithUsers, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const WORK_ITEM_NOT_FOUND = JSON.stringify({ error: "Work item not found in this brokerage." });
const FLAG_OFF: ReadonlyArray<{ label: string; value: string | undefined }> = [
  { label: "unset", value: undefined },
  { label: "empty", value: "" },
  { label: "false", value: "false" },
  { label: "TRUE", value: "TRUE" },
  { label: "1", value: "1" },
];

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; brokerageId: number };
let propertyId: number;
let otherPropertyId: number;
let foreignPropertyId: number;
let launchItemId: string;
let crossPropertyItemId: string;
let foreignItemId: string;
const savedLaunchFlag = process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG];
const savedResponsibilityFlag = process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];

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

async function responseText(res: Response): Promise<{ status: number; contentType: string; text: string }> {
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    text: await res.text(),
  };
}

async function createProperty(cookie: string, address: string): Promise<number> {
  const property = await postRaw("/properties", cookie, {
    formattedAddress: address,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(property.status, 201, await property.clone().text());
  return ((await property.json()) as { property: { id: number } }).property.id;
}

async function ensurePlan(brokerageId: number, targetPropertyId: number, createdBy: number): Promise<string> {
  const [existing] = await db.select({ id: launchPlans.id }).from(launchPlans).where(eq(launchPlans.propertyId, targetPropertyId));
  if (existing) return existing.id;
  const [plan] = await db
    .insert(launchPlans)
    .values({
      brokerageId,
      propertyId: targetPropertyId,
      templateType: "CUSTOM",
      status: "PLANNING",
      createdBy,
    })
    .returning({ id: launchPlans.id });
  return plan.id;
}

async function insertItem(brokerageId: number, targetPropertyId: number, createdBy: number, title: string): Promise<string> {
  const launchPlanId = await ensurePlan(brokerageId, targetPropertyId, createdBy);
  const [item] = await db
    .insert(campaignItems)
    .values({
      launchPlanId,
      propertyId: targetPropertyId,
      brokerageId,
      itemType: "COPYWRITING",
      title,
      description: "Listing copy",
      status: "TO_ORGANISE",
      responsibleOwnerType: "PIT_CREW",
      costCents: 250000,
      vendorName: "Acme Photos",
    })
    .returning({ id: campaignItems.id });
  return item.id;
}

async function campaignSnapshot(id: string): Promise<{ status: string; completedAt: Date | null }> {
  const [row] = await db
    .select({ status: campaignItems.status, completedAt: campaignItems.completedAt })
    .from(campaignItems)
    .where(eq(campaignItems.id, id));
  assert.ok(row, id);
  return row;
}

async function keyCount(sourceType: string, sourceRecordId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pitCrewAssignments)
    .where(and(eq(pitCrewAssignments.sourceType, sourceType), eq(pitCrewAssignments.sourceRecordId, sourceRecordId)));
  return Number(row?.n ?? 0);
}

type ActionCase = { action: string; body: Record<string, unknown> };

function actionCases(targetPropertyId: number): ActionCase[] {
  const base = { propertyId: targetPropertyId, expectedVersion: 0 };
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

async function setRunAccess(brokerageId: number, active: boolean): Promise<void> {
  await db
    .update(entitlementGrants)
    .set({ status: active ? "Active" : "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(brokerageId);
}

before(async () => {
  delete process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG];
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `R-F22 Launch ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `R-F22 Foreign ${suffix}`);
  propertyId = await createProperty(A.agent.cookie, `${suffix} Launch Item St`);
  otherPropertyId = await createProperty(A.agent.cookie, `${suffix} Other Launch St`);
  foreignPropertyId = await createProperty(B.admin.cookie, `${suffix} Foreign Launch St`);
  launchItemId = await insertItem(A.brokerageId, propertyId, A.admin.user.id, "Book the photographer");
  crossPropertyItemId = await insertItem(A.brokerageId, otherPropertyId, A.admin.user.id, "Other property copy");
  foreignItemId = await insertItem(B.brokerageId, foreignPropertyId, B.admin.user.id, "Foreign brokerage copy");
});

after(async () => {
  if (savedLaunchFlag === undefined) delete process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG];
  else process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG] = savedLaunchFlag;
  if (savedResponsibilityFlag === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
  else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = savedResponsibilityFlag;
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId].filter((id): id is number => id != null));
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

describe("R-F22 LAUNCH_ITEM source stays off unless the flag is the literal true", { concurrency: false }, () => {
  for (const flagCase of FLAG_OFF) {
    test(`flag ${flagCase.label}: item actions match a missing exception, write nothing, and do not query campaign_items`, async () => {
      const before = await campaignSnapshot(launchItemId);
      const beforeKey = await keyCount("LAUNCH_ITEM", launchItemId);
      const statements: string[] = [];
      await withLaunchFlag(flagCase.value, async () => {
        const uninstall = setDbQueryObserver((query) => {
          statements.push(query);
        });
        try {
          const missing = await responseText(
            await postRaw(`/pit-crew/items/EXCEPTION/${randomUUID()}/claim`, A.admin.cookie, {
              propertyId,
              expectedVersion: 0,
            }),
          );
          assert.equal(missing.status, 404);
          assert.match(missing.contentType, /^application\/json/);
          assert.equal(missing.text, WORK_ITEM_NOT_FOUND);

          for (const actionCase of actionCases(propertyId)) {
            const rejected = await responseText(
              await postRaw(`/pit-crew/items/LAUNCH_ITEM/${launchItemId}/${actionCase.action}`, A.admin.cookie, actionCase.body),
            );
            assert.equal(rejected.status, missing.status, actionCase.action);
            assert.equal(rejected.contentType, missing.contentType, actionCase.action);
            assert.equal(rejected.text, missing.text, actionCase.action);
          }

          const workspace = await fetch(`${baseUrl}/api/pit-crew/workspace`, { headers: { cookie: A.admin.cookie } });
          const workspaceText = await workspace.text();
          assert.equal(workspace.status, 200, workspaceText);
          assert.equal(workspaceText.includes("LAUNCH_ITEM"), false);
          assert.equal(workspaceText.includes(launchItemId), false);
        } finally {
          uninstall();
        }
      });
      assert.deepEqual(
        statements.filter((query) => query.includes("campaign_items")),
        [],
      );
      assert.equal(await keyCount("LAUNCH_ITEM", launchItemId), beforeKey);
      const after = await campaignSnapshot(launchItemId);
      assert.equal(after.status, before.status);
      assert.equal(after.completedAt, before.completedAt);
      assert.equal(process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG], savedLaunchFlag);
    });
  }

  test("flag on: complete marks the overlay DONE and leaves the campaign item unchanged", async () => {
    const before = await campaignSnapshot(launchItemId);
    assert.equal(before.status, "TO_ORGANISE");
    assert.equal(before.completedAt, null);
    await withLaunchFlag("true", async () => {
      const claim = await responseText(
        await postRaw(`/pit-crew/items/LAUNCH_ITEM/${launchItemId}/claim`, A.admin.cookie, {
          propertyId,
          expectedVersion: 0,
        }),
      );
      assert.equal(claim.status, 200, claim.text);
      const claimed = JSON.parse(claim.text) as { status: string; version: number };
      assert.equal(claimed.status, "CLAIMED");

      const complete = await responseText(
        await postRaw(`/pit-crew/items/LAUNCH_ITEM/${launchItemId}/complete`, A.admin.cookie, {
          propertyId,
          expectedVersion: claimed.version,
        }),
      );
      assert.equal(complete.status, 200, complete.text);
      const done = JSON.parse(complete.text) as { status: string; completedAt: string | null };
      assert.equal(done.status, "DONE");
      assert.ok(done.completedAt);
    });
    const after = await campaignSnapshot(launchItemId);
    assert.equal(after.status, before.status);
    assert.equal(after.completedAt, before.completedAt);
    const [overlay] = await db
      .select({ status: pitCrewAssignments.status })
      .from(pitCrewAssignments)
      .where(and(eq(pitCrewAssignments.sourceType, "LAUNCH_ITEM"), eq(pitCrewAssignments.sourceRecordId, launchItemId)));
    assert.equal(overlay?.status, "DONE");
  });

  test("flag on: a cross-brokerage campaign item and a cross-property campaign item 404 and write nothing", async () => {
    const foreignBefore = await campaignSnapshot(foreignItemId);
    const crossBefore = await campaignSnapshot(crossPropertyItemId);
    await withLaunchFlag("true", async () => {
      for (const [label, sourceRecordId, before] of [
        ["cross-brokerage", foreignItemId, foreignBefore],
        ["cross-property", crossPropertyItemId, crossBefore],
      ] as const) {
        assert.equal(await keyCount("LAUNCH_ITEM", sourceRecordId), 0, label);
        const rejected = await responseText(
          await postRaw(`/pit-crew/items/LAUNCH_ITEM/${sourceRecordId}/claim`, A.admin.cookie, {
            propertyId,
            expectedVersion: 0,
          }),
        );
        assert.equal(rejected.status, 404, label);
        assert.equal(rejected.text, WORK_ITEM_NOT_FOUND, label);
        assert.equal(await keyCount("LAUNCH_ITEM", sourceRecordId), 0, label);
        const after = await campaignSnapshot(sourceRecordId);
        assert.equal(after.status, before.status, label);
        assert.equal(after.completedAt, before.completedAt, label);
      }
    });
  });

  test("flag on: AUTOMATION_TASK, OFFER, and a random source type are still rejected", async () => {
    const sourceTypes = ["AUTOMATION_TASK", "OFFER", `rf22-${randomUUID()}`] as const;
    await withLaunchFlag("true", async () => {
      for (const sourceType of sourceTypes) {
        const sourceRecordId = randomUUID();
        const statements: string[] = [];
        const uninstall = setDbQueryObserver((query) => {
          statements.push(query);
        });
        try {
          for (const action of ["claim", "complete"] as const) {
            const rejected = await responseText(
              await postRaw(
                `/pit-crew/items/${encodeURIComponent(sourceType)}/${sourceRecordId}/${action}`,
                A.admin.cookie,
                { propertyId, expectedVersion: 0 },
              ),
            );
            assert.equal(rejected.status, 404, sourceType);
            assert.equal(rejected.text, WORK_ITEM_NOT_FOUND, sourceType);
          }
        } finally {
          uninstall();
        }
        assert.equal(await keyCount(sourceType, sourceRecordId), 0, sourceType);
        assert.deepEqual(
          statements.filter((query) => query.includes("campaign_items")),
          [],
          sourceType,
        );
      }
    });
  });

  test("flag on: a caller without the Pit Crew role or without run.access is refused the same way as for an exception", async () => {
    await withLaunchFlag("true", async () => {
      const agentException = await responseText(
        await postRaw(`/pit-crew/items/EXCEPTION/${randomUUID()}/claim`, A.agent.cookie, {
          propertyId,
          expectedVersion: 0,
        }),
      );
      const agentLaunch = await responseText(
        await postRaw(`/pit-crew/items/LAUNCH_ITEM/${launchItemId}/claim`, A.agent.cookie, {
          propertyId,
          expectedVersion: 0,
        }),
      );
      assert.equal(agentException.status, 403);
      assert.equal(agentException.text, JSON.stringify({ error: "Forbidden" }));
      assert.deepEqual(agentLaunch, agentException);
      assert.equal(await keyCount("LAUNCH_ITEM", launchItemId), 1, "the earlier complete left the only overlay");

      await setRunAccess(A.brokerageId, false);
      try {
        const entitledException = await responseText(
          await postRaw(`/pit-crew/items/EXCEPTION/${randomUUID()}/complete`, A.admin.cookie, {
            propertyId,
            expectedVersion: 0,
          }),
        );
        const entitledLaunch = await responseText(
          await postRaw(`/pit-crew/items/LAUNCH_ITEM/${launchItemId}/complete`, A.admin.cookie, {
            propertyId,
            expectedVersion: 0,
          }),
        );
        assert.equal(entitledException.status, 403);
        const body = JSON.parse(entitledException.text) as { error?: string; entitlementKey?: string };
        assert.equal(body.error, "Not entitled");
        assert.equal(body.entitlementKey, "run.access");
        assert.deepEqual(entitledLaunch, entitledException);
      } finally {
        await setRunAccess(A.brokerageId, true);
      }
    });
    const after = await campaignSnapshot(launchItemId);
    assert.equal(after.status, "TO_ORGANISE");
    assert.equal(after.completedAt, null);
  });

  test("LAUNCH_ITEM hand-back is not-found unless both flags are the literal true", async () => {
    const actionItemId = await insertItem(A.brokerageId, propertyId, A.admin.user.id, "Rf28 hand back the photographer");
    const beforeAction = await campaignSnapshot(actionItemId);
    const beforeDone = await campaignSnapshot(launchItemId);
    const handBackBody = {
      propertyId,
      expectedVersion: 0,
      reasonCategory: "WORK_COMPLETE",
      nextAction: "Review the returned condition evidence and confirm the next step.",
    };
    const previous = process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
    try {
      for (const flagCase of FLAG_OFF) {
        if (flagCase.value === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
        else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = flagCase.value;
        await withLaunchFlag("true", async () => {
          const rejected = await responseText(
            await postRaw(`/pit-crew/items/LAUNCH_ITEM/${actionItemId}/hand-back`, A.admin.cookie, handBackBody),
          );
          assert.equal(rejected.status, 404, flagCase.label);
          assert.equal(rejected.text, JSON.stringify({ error: "Not found." }), flagCase.label);
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
            const rejected = await responseText(
              await postRaw(`/pit-crew/items/LAUNCH_ITEM/${actionItemId}/hand-back`, A.admin.cookie, handBackBody),
            );
            assert.equal(rejected.status, 404, flagCase.label);
            assert.equal(rejected.text, WORK_ITEM_NOT_FOUND, flagCase.label);
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
      assert.equal(await keyCount("LAUNCH_ITEM", actionItemId), 0);

      await withLaunchFlag("true", async () => {
        const claim = await responseText(
          await postRaw(`/pit-crew/items/LAUNCH_ITEM/${actionItemId}/claim`, A.admin.cookie, {
            propertyId,
            expectedVersion: 0,
          }),
        );
        assert.equal(claim.status, 200, claim.text);
        const claimed = JSON.parse(claim.text) as { version: number; status: string };
        assert.equal(claimed.status, "CLAIMED");
        const handed = await responseText(
          await postRaw(`/pit-crew/items/LAUNCH_ITEM/${actionItemId}/hand-back`, A.admin.cookie, {
            ...handBackBody,
            expectedVersion: claimed.version,
          }),
        );
        assert.equal(handed.status, 200, handed.text);
        const body = JSON.parse(handed.text) as {
          status: string;
          responsibilityEvent: { kind: string; resultingResponsibility: string; recipientUserId: number; severity: null };
        };
        assert.equal(body.status, "HANDED_BACK");
        assert.equal(body.responsibilityEvent.kind, "HAND_BACK");
        assert.equal(body.responsibilityEvent.resultingResponsibility, "AGENT");
        assert.equal(body.responsibilityEvent.recipientUserId, A.agent.user.id);
        assert.equal(body.responsibilityEvent.severity, null);
        assert.equal(handed.text.includes("Acme Photos"), false);
        assert.equal(handed.text.includes("250000"), false);
      });
    } finally {
      if (previous === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
      else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = previous;
    }
    const afterAction = await campaignSnapshot(actionItemId);
    assert.equal(afterAction.status, beforeAction.status);
    assert.equal(afterAction.completedAt, beforeAction.completedAt);
    const afterDone = await campaignSnapshot(launchItemId);
    assert.equal(afterDone.status, beforeDone.status);
    assert.equal(afterDone.completedAt, beforeDone.completedAt);
    const [doneOverlay] = await db
      .select({ status: pitCrewAssignments.status })
      .from(pitCrewAssignments)
      .where(and(eq(pitCrewAssignments.sourceType, "LAUNCH_ITEM"), eq(pitCrewAssignments.sourceRecordId, launchItemId)));
    assert.equal(doneOverlay?.status, "DONE");
  });
});
