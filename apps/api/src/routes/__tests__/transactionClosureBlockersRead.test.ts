// Read-only R-F42 closure blockers on the transaction GETs. The list is the
// same one POST /transactions/:id/close returns as 409 blockers once the
// transaction is Settled. The Settled check, the force override, and the
// Brokerage Administrator gate on close are unchanged. No migration.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  entitlementGrants,
  transactions,
  amlVerifications,
  transactionConditions,
  automationAttentionItems,
  automationTasks,
  financialPaymentRequests,
  financialDisputes,
  financialReconciliations,
} from "@aee/db";
import { createOrUpdateException } from "../../lib/exceptions/model.js";
import type { RiskFinding } from "../../lib/exceptions/types.js";
import { getPitCrewWorkspace } from "../../lib/pitCrew/queries.js";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, createTransactionFromListedProperty, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

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
let propertyId: number;
let transactionId: number;

function headers(cookie: string, json = false): Record<string, string> {
  return json ? { cookie, "content-type": "application/json" } : { cookie };
}

async function getJson(path: string, cookie: string) {
  return fetch(`${baseUrl}/api${path}`, { headers: headers(cookie) });
}

async function postJson(path: string, cookie: string, body?: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: headers(cookie, true),
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

interface ClosureDetail {
  code: string;
  message: string;
  count?: number;
  refs?: string[];
}

interface ClosureRead {
  transaction: { id: number; status: string; closedAt: string | null; closureBlockers?: unknown; closureBlockerDetails?: unknown } | null;
  closureBlockers: string[] | null;
  closureBlockerDetails: ClosureDetail[] | null;
}

async function setRunAccess(brokerageId: number, active: boolean): Promise<void> {
  await db
    .update(entitlementGrants)
    .set({ status: active ? "Active" : "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(brokerageId);
}

async function readBoth(cookie: string): Promise<{ byId: ClosureRead; byProperty: ClosureRead }> {
  const byIdRes = await getJson(`/transactions/${transactionId}`, cookie);
  assert.equal(byIdRes.status, 200, "GET /transactions/:id");
  const byPropertyRes = await getJson(`/transactions/by-property/${propertyId}`, cookie);
  assert.equal(byPropertyRes.status, 200, "GET /transactions/by-property/:propertyId");
  return { byId: await bodyOf<ClosureRead>(byIdRes), byProperty: await bodyOf<ClosureRead>(byPropertyRes) };
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

  A = await createBrokerageWithUsers(baseUrl, `Closure blockers A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Closure blockers B ${suffix}`);
  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Closure Blockers St`,
    sellerEmail: `seller-closure-blockers-${suffix}@example.com`,
  });
  propertyId = created.propertyId;
  transactionId = created.transactionId;
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("GET returns the same closure blockers close would report, without closing", async () => {
  const beforeClose = await readBoth(A.agent.cookie);
  assert.deepEqual(beforeClose.byId.closureBlockers, beforeClose.byProperty.closureBlockers);
  const blockers = beforeClose.byId.closureBlockers;
  assert.ok(blockers);
  assert.ok(blockers.includes("The transaction has not become unconditional yet."));
  assert.ok(blockers.includes("Commission has not been calculated."));
  assert.ok(blockers.some((line) => line === "Funds reconciliation is COMMISSION_NOT_CALCULATED, not MATCHED."));
  assert.equal(beforeClose.byId.transaction?.closureBlockers, undefined);
  assert.equal(beforeClose.byId.transaction?.closureBlockerDetails, undefined);
  assert.deepEqual(beforeClose.byId.closureBlockerDetails?.map((detail) => detail.message), blockers);
  assert.deepEqual(beforeClose.byProperty.closureBlockerDetails, beforeClose.byId.closureBlockerDetails);
  assert.notEqual(beforeClose.byId.transaction?.status, "Closed");
  assert.equal(beforeClose.byId.transaction?.closedAt, null);

  const tooEarly = await postJson(`/transactions/${transactionId}/close`, A.admin.cookie);
  assert.equal(tooEarly.status, 400);
  const tooEarlyBody = await bodyOf<{ error?: string; blockers?: unknown }>(tooEarly);
  assert.match(tooEarlyBody.error ?? "", /cannot be closed before settlement is completed/);
  assert.equal(tooEarlyBody.blockers, undefined);

  await db.update(transactions).set({ status: "Settled" }).where(eq(transactions.id, transactionId));

  const settled = await readBoth(A.agent.cookie);
  assert.equal(settled.byId.transaction?.status, "Settled");
  assert.deepEqual(settled.byId.closureBlockers, blockers);
  assert.deepEqual(settled.byProperty.closureBlockers, blockers);

  const blocked = await postJson(`/transactions/${transactionId}/close`, A.admin.cookie);
  assert.equal(blocked.status, 409);
  const blockedBody = await bodyOf<{ error?: string; blockers?: string[]; closureBlockerDetails?: unknown }>(blocked);
  assert.match(blockedBody.error ?? "", /^Transaction cannot be closed:/);
  assert.deepEqual(blockedBody.blockers, blockers);
  assert.equal(blockedBody.closureBlockerDetails, undefined);
  assert.deepEqual(Object.keys(blockedBody).sort(), ["blockers", "error"]);

  const afterRefusal = await readBoth(A.agent.cookie);
  assert.equal(afterRefusal.byId.transaction?.status, "Settled");
  assert.equal(afterRefusal.byId.transaction?.closedAt, null);
  assert.deepEqual(afterRefusal.byId.closureBlockers, blockers);
});

test("another brokerage is 404 and does not receive the blocker list", async () => {
  const byId = await getJson(`/transactions/${transactionId}`, B.agent.cookie);
  assert.equal(byId.status, 404);
  assert.deepEqual(await bodyOf(byId), { error: "Not found" });

  const byProperty = await getJson(`/transactions/by-property/${propertyId}`, B.agent.cookie);
  assert.equal(byProperty.status, 404);
  assert.deepEqual(await bodyOf(byProperty), { error: "Not found" });
});

test("closureBlockerDetails names each code and the close 409 stays the string list", async () => {
  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Closure Detail St`,
    sellerEmail: `seller-closure-detail-${suffix}@example.com`,
  });
  const [row] = await db.select().from(transactions).where(eq(transactions.id, created.transactionId));
  assert.ok(row);
  const sellers = row.sellerPartyIds as number[];
  const buyers = row.buyerPartyIds as number[];
  assert.ok(sellers.length > 0);
  assert.ok(buyers.length > 0);

  await db.insert(transactionConditions).values({
    transactionId: created.transactionId,
    description: "Subject to a second inspection",
    status: "Pending",
  });
  await db
    .update(amlVerifications)
    .set({ status: "Review Required" })
    .where(and(eq(amlVerifications.propertyId, created.propertyId), inArray(amlVerifications.partyId, [...sellers, ...buyers])));
  await db.insert(automationAttentionItems).values({
    brokerageId: A.brokerageId,
    propertyId: created.propertyId,
    transactionId: created.transactionId,
    reasonCode: "OTHER",
    summary: "Needs a human look",
    status: "OPEN",
  });
  const [task] = await db
    .insert(automationTasks)
    .values({
      brokerageId: A.brokerageId,
      propertyId: created.propertyId,
      transactionId: created.transactionId,
      taskKey: "CONFIRM_TRANSACTION_RECORD_COMPLETE",
      kind: "TASK",
      title: "Confirm the transaction record is complete",
      status: "ACTIVE",
    })
    .returning();
  const [paymentRequest] = await db
    .insert(financialPaymentRequests)
    .values({
      brokerageId: A.brokerageId,
      propertyId: created.propertyId,
      transactionId: created.transactionId,
      amountCents: 1000,
      status: "DISPUTED",
    })
    .returning();
  await db.insert(financialDisputes).values({
    brokerageId: A.brokerageId,
    paymentRequestId: paymentRequest.id,
    disputedAmountCents: 1000,
    reason: "Commission figure disputed",
    status: "OPEN",
  });
  await db.insert(financialReconciliations).values({
    brokerageId: A.brokerageId,
    recordType: "LEGACY_TRANSACTION_COMMISSION",
    recordId: String(created.transactionId),
    status: "VARIANCE",
    differenceCents: 100,
  });

  const baseFinding = {
    ruleId: "TEST_RUN_CBX",
    ruleVersion: 1,
    severity: "ATTENTION" as const,
    problemDescription: "Blocks close check.",
    businessImpact: "Close stays blocked.",
    detectedCause: "Test.",
    propertyId: created.propertyId,
    transactionId: created.transactionId,
    dueAt: null,
    escalatesAt: null,
    recommendedAction: "Assign an owner.",
    resolutionRequirements: "An owner is assigned.",
    dismissible: true,
    sourceRecordType: "transaction",
    sourceRecordId: String(created.transactionId),
    recurrenceMode: "REOPEN" as const,
  };
  const unowned = await createOrUpdateException(
    {
      ...baseFinding,
      category: "SETTLEMENT_CLOSURE",
      title: "Unowned settlement exception",
      ownerType: "UNASSIGNED_QUEUE",
      ownerUserId: null,
      dedupKey: `TEST_RUN_CBX:${created.transactionId}:unowned`,
      requiresFinancialEntitlement: false,
    } satisfies RiskFinding,
    A.brokerageId,
    created.propertyId,
    created.transactionId,
    randomUUID(),
    null,
  );
  const owned = await createOrUpdateException(
    {
      ...baseFinding,
      category: "WORKFLOW_OPERATIONAL",
      title: "Owned settlement exception",
      ownerType: "LISTING_AGENT",
      ownerUserId: A.agent.user.id,
      dedupKey: `TEST_RUN_CBX:${created.transactionId}:owned`,
      requiresFinancialEntitlement: false,
    } satisfies RiskFinding,
    A.brokerageId,
    created.propertyId,
    created.transactionId,
    randomUUID(),
    null,
  );
  const financial = await createOrUpdateException(
    {
      ...baseFinding,
      category: "FINANCIAL",
      title: "Financial exception",
      ownerType: "UNASSIGNED_QUEUE",
      ownerUserId: null,
      dedupKey: `TEST_RUN_CBX:${created.transactionId}:financial`,
      requiresFinancialEntitlement: true,
    } satisfies RiskFinding,
    A.brokerageId,
    created.propertyId,
    created.transactionId,
    randomUUID(),
    null,
  );

  async function listedBlocksClose(): Promise<Map<string, boolean>> {
    const res = await getJson(`/exceptions?propertyId=${created.propertyId}&limit=100`, A.admin.cookie);
    assert.equal(res.status, 200);
    const body = await bodyOf<{ exceptions: Array<{ id: string; blocksClose?: boolean }> }>(res);
    return new Map(body.exceptions.map((exception) => [exception.id, exception.blocksClose === true]));
  }

  const beforeSettled = await listedBlocksClose();
  assert.equal(beforeSettled.get(unowned.exception.id), false);
  assert.equal(beforeSettled.get(owned.exception.id), false);
  assert.equal(beforeSettled.get(financial.exception.id), false);

  await db.update(transactions).set({ status: "Settled" }).where(eq(transactions.id, created.transactionId));

  const afterSettled = await listedBlocksClose();
  assert.equal(afterSettled.get(unowned.exception.id), true);
  assert.equal(afterSettled.get(owned.exception.id), false);
  assert.equal(afterSettled.get(financial.exception.id), false);

  const workspace = await getPitCrewWorkspace(A.brokerageId, A.admin.user.id);
  const pitCrewCard = [...workspace.unassignedWork, ...workspace.teamWork, ...workspace.transactionCoordination].find(
    (item) => item.sourceRecordId === unowned.exception.id,
  );
  assert.ok(pitCrewCard);
  assert.equal(pitCrewCard.sourceType, "EXCEPTION");
  assert.equal(pitCrewCard.blocksClose, true);
  assert.equal(workspace.launchCoordination.some((item) => item.sourceType === "LAUNCH_ITEM"), false);
  assert.equal(
    [...workspace.unassignedWork, ...workspace.teamWork, ...workspace.transactionCoordination].some(
      (item) => item.sourceRecordId === owned.exception.id,
    ),
    false,
  );

  const byIdRes = await getJson(`/transactions/${created.transactionId}`, A.agent.cookie);
  const byPropertyRes = await getJson(`/transactions/by-property/${created.propertyId}`, A.agent.cookie);
  assert.equal(byIdRes.status, 200);
  assert.equal(byPropertyRes.status, 200);
  const byId = await bodyOf<ClosureRead>(byIdRes);
  const byProperty = await bodyOf<ClosureRead>(byPropertyRes);
  const blockers = byId.closureBlockers;
  const details = byId.closureBlockerDetails;
  assert.ok(blockers);
  assert.ok(details);
  assert.deepEqual(byProperty.closureBlockers, blockers);
  assert.deepEqual(byProperty.closureBlockerDetails, details);
  assert.deepEqual(details.map((detail) => detail.message), blockers);
  assert.equal(byId.transaction?.closureBlockerDetails, undefined);

  const byCode = new Map(details.map((detail) => [detail.code, detail]));
  assert.deepEqual(
    [...byCode.keys()].sort(),
    [
      "AML_BUYER",
      "AML_SELLER",
      "ATTENTION_OPEN",
      "COMMISSION_DISCREPANCY",
      "COMMISSION_NOT_CALCULATED",
      "CONDITIONS_PENDING",
      "EXCEPTIONS_NEED_OWNER",
      "FINANCIAL_DISPUTE_OPEN",
      "FUNDS_NOT_MATCHED",
      "MUST_FINISH_TASKS",
      "NOT_UNCONDITIONAL",
    ],
  );
  assert.equal(byCode.get("FUNDS_NOT_MATCHED")?.refs?.[0], "COMMISSION_NOT_CALCULATED");
  assert.ok(byCode.get("MUST_FINISH_TASKS")?.refs?.includes(task.id));
  const exceptionRefs = byCode.get("EXCEPTIONS_NEED_OWNER")?.refs ?? [];
  assert.ok(exceptionRefs.includes(unowned.exception.id));
  assert.equal(exceptionRefs.includes(owned.exception.id), false);
  assert.equal(exceptionRefs.includes(financial.exception.id), false);
  assert.ok((byCode.get("CONDITIONS_PENDING")?.count ?? 0) >= 1);
  assert.equal(byCode.get("AML_SELLER")?.count, sellers.length);
  assert.equal(byCode.get("AML_BUYER")?.count, buyers.length);

  const blocked = await postJson(`/transactions/${created.transactionId}/close`, A.admin.cookie);
  assert.equal(blocked.status, 409);
  const blockedBody = await bodyOf<{ error?: string; blockers?: string[]; closureBlockerDetails?: unknown }>(blocked);
  assert.deepEqual(blockedBody.blockers, blockers);
  assert.equal(blockedBody.closureBlockerDetails, undefined);
  assert.deepEqual(Object.keys(blockedBody).sort(), ["blockers", "error"]);

  const stillOpen = await getJson(`/transactions/${created.transactionId}`, A.agent.cookie);
  const stillOpenBody = await bodyOf<ClosureRead>(stillOpen);
  assert.equal(stillOpenBody.transaction?.status, "Settled");
  assert.equal(stillOpenBody.transaction?.closedAt, null);
});

test("missing run.access is 403 and does not return closure blockers", async () => {
  await setRunAccess(A.brokerageId, false);
  try {
    for (const path of [`/transactions/${transactionId}`, `/transactions/by-property/${propertyId}`]) {
      const res = await getJson(path, A.agent.cookie);
      assert.equal(res.status, 403, path);
      const body = await bodyOf<{ error?: string; entitlementKey?: string; closureBlockers?: unknown; transaction?: unknown }>(res);
      assert.equal(body.error, "Not entitled");
      assert.equal(body.entitlementKey, "run.access");
      assert.equal(body.closureBlockers, undefined);
      assert.equal(body.transaction, undefined);
    }
  } finally {
    await setRunAccess(A.brokerageId, true);
  }
});
