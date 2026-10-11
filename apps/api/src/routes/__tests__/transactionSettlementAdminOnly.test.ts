// R-F35a — settlement completion, funds received, and commission calculation
// (normal and force) are Brokerage Administrator only at the route.
// Same HTTP harness as runTransactionLifecycleGuards.test.ts. The gate sits
// after requiresRunAccess and requireTransactionAccess. A same-brokerage
// refusal is 403 and writes one denial audit row. Another brokerage is 404
// and writes nothing, so the audit log cannot confirm that transaction exists.
import { test, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { auditLogs, db, transactions, users } from "@aee/db";
import { logger } from "@aee/events";
import {
  createBrokerageWithUsers,
  createTransactionFromListedProperty,
  cleanupBrokerages,
  devLogin,
  getDomainEventsForProperty,
  type DevLoginResult,
} from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const SUCCESS_ACTIONS = ["settlement_completed", "commission_calculated", "funds_received"] as const;
const DENIAL_ACTIONS = [
  "settlement_complete_denied",
  "funds_received_denied",
  "commission_calculation_denied",
  "commission_calculation_force_denied",
] as const;
const MILESTONE_EVENTS = ["SETTLEMENT_COMPLETED", "COMMISSION_CALCULATED", "FUNDS_RECEIVED"] as const;

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageAName = `R-F35a Settlement A ${suffix}`;
const brokerageBName = `R-F35a Settlement B ${suffix}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let pitCrew: DevLoginResult;
let propertyId: number;
let transactionId: number;

function headers(cookie: string) {
  return { "content-type": "application/json", cookie };
}

async function postJson(path: string, cookie: string, body?: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: headers(cookie),
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

async function loadTransaction(id: number) {
  const [row] = await db.select().from(transactions).where(eq(transactions.id, id));
  if (!row) throw new Error(`transaction ${id} missing`);
  return row;
}

async function transactionAudits(id: number) {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.recordType, "transaction"), eq(auditLogs.recordId, String(id))));
  return rows.sort((a, b) => a.id - b.id);
}

async function denialAudits(id: number) {
  const rows = await transactionAudits(id);
  return rows.filter((row) => (DENIAL_ACTIONS as readonly string[]).includes(row.action));
}

async function brokerageDenialIds(brokerageId: number): Promise<number[]> {
  const rows = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eq(auditLogs.brokerageId, brokerageId), inArray(auditLogs.action, [...DENIAL_ACTIONS])));
  return rows.map((row) => row.id).sort((a, b) => a - b);
}

function expectedDenialAction(label: string): (typeof DENIAL_ACTIONS)[number] {
  switch (label) {
    case "settlement-complete":
      return "settlement_complete_denied";
    case "funds-received":
      return "funds_received_denied";
    case "calculate-commission":
      return "commission_calculation_denied";
    case "calculate-commission force":
      return "commission_calculation_force_denied";
    default:
      throw new Error(`unexpected attempt ${label}`);
  }
}

function assertDenialRow(
  row: Awaited<ReturnType<typeof denialAudits>>[number],
  expected: { userId: number; role: string; brokerageId: number; transactionId: number; action: string },
): void {
  assert.equal(row.userId, expected.userId);
  assert.equal(row.brokerageId, expected.brokerageId);
  assert.equal(row.recordType, "transaction");
  assert.equal(row.recordId, String(expected.transactionId));
  assert.equal(row.action, expected.action);
  assert.ok(row.createdAt instanceof Date);
  assert.ok(Date.now() - row.createdAt.getTime() < 60_000);
  assert.equal(row.userEmail, null);
  assert.equal(row.previousValue, null);
  assert.equal(row.providerReference, null);
  assert.equal(row.propertyId, null);
  const detail = JSON.parse(row.updatedValue ?? "") as { actorRole: string; reason: string };
  assert.deepEqual(detail, { actorRole: expected.role, reason: "ROLE_NOT_PERMITTED" });
  const stored = `${row.action} ${row.updatedValue ?? ""} ${row.previousValue ?? ""} ${row.userEmail ?? ""}`;
  assert.doesNotMatch(stored, /amountCents|password|account|secret|authorization|cookie/i);
  assert.equal(stored.includes("100"), false);
  assert.equal(stored.includes("250000"), false);
}

async function successAuditIds(id: number): Promise<number[]> {
  const rows = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.recordType, "transaction"),
        eq(auditLogs.recordId, String(id)),
        inArray(auditLogs.action, [...SUCCESS_ACTIONS]),
      ),
    );
  return rows.map((row) => row.id).sort((a, b) => a - b);
}

async function milestoneEventIds(id: number): Promise<string[]> {
  const rows = await getDomainEventsForProperty(id);
  return rows
    .filter((row) => (MILESTONE_EVENTS as readonly string[]).includes(row.eventType))
    .map((row) => row.id)
    .sort();
}

type Attempt = { label: string; path: string; body?: unknown };

function attemptsFor(id: number): Attempt[] {
  return [
    { label: "settlement-complete", path: `/transactions/${id}/settlement-complete` },
    { label: "funds-received", path: `/transactions/${id}/funds-received`, body: { amountCents: 100 } },
    { label: "calculate-commission", path: `/transactions/${id}/calculate-commission`, body: {} },
    { label: "calculate-commission force", path: `/transactions/${id}/calculate-commission`, body: { force: true } },
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

  A = await createBrokerageWithUsers(baseUrl, brokerageAName);
  B = await createBrokerageWithUsers(baseUrl, brokerageBName);
  const pitLogin = await devLogin(baseUrl, {
    email: `pit-${suffix}@example.com`,
    firstName: "Pit",
    lastName: "Crew",
    brokerageName: brokerageAName,
  });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitLogin.user.id));
  pitCrew = { cookie: pitLogin.cookie, user: { ...pitLogin.user, role: "Pit Crew", brokerageId: A.brokerageId } };

  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `1 Admin Gate St ${suffix}`,
    settlementDate: "2027-04-01",
  });
  propertyId = created.propertyId;
  transactionId = created.transactionId;
  const signed = await postJson(`/transactions/${transactionId}/contract-signed`, A.agent.cookie);
  if (signed.status !== 200) throw new Error(`contract-signed failed: ${signed.status} ${await signed.text()}`);
  const scheduled = await postJson(`/transactions/${transactionId}/settlement-schedule`, A.agent.cookie, {
    settlementDate: "2027-04-01",
  });
  if (scheduled.status !== 200) throw new Error(`settlement-schedule failed: ${scheduled.status} ${await scheduled.text()}`);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("Agent and Pit Crew are forbidden from settlement completion, funds received, and commission calculation, with one denial audit and no transaction change", async () => {
  const [pitRow] = await db.select().from(users).where(eq(users.id, pitCrew.user.id));
  assert.equal(pitRow.role, "Pit Crew");
  assert.equal(A.agent.user.role, "Agent");

  const ready = await loadTransaction(transactionId);
  assert.equal(ready.status, "SettlementScheduled");
  assert.ok(ready.contractDate);
  assert.ok(ready.settlementDate);
  assert.equal(ready.settlementCompletedAt, null);
  assert.equal(ready.commissionCalculatedAt, null);
  assert.equal(ready.fundsReceivedCents, 0);
  const auditsBefore = await successAuditIds(transactionId);
  const eventsBefore = await milestoneEventIds(propertyId);
  assert.deepEqual(auditsBefore, []);
  const seenDenialIds = new Set((await denialAudits(transactionId)).map((row) => row.id));

  for (const caller of [
    { role: "Agent", userId: A.agent.user.id, cookie: A.agent.cookie },
    { role: "Pit Crew", userId: pitCrew.user.id, cookie: pitCrew.cookie },
  ]) {
    for (const attempt of attemptsFor(transactionId)) {
      const res = await postJson(attempt.path, caller.cookie, attempt.body);
      const text = await res.text();
      assert.equal(res.status, 403, `${caller.role} ${attempt.label}: ${text}`);
      assert.deepEqual(JSON.parse(text), { error: "Forbidden" }, `${caller.role} ${attempt.label}`);

      const added = (await denialAudits(transactionId)).filter((row) => !seenDenialIds.has(row.id));
      assert.equal(added.length, 1, `${caller.role} ${attempt.label} must write exactly one denial audit`);
      assertDenialRow(added[0]!, {
        userId: caller.userId,
        role: caller.role,
        brokerageId: A.brokerageId,
        transactionId,
        action: expectedDenialAction(attempt.label),
      });
      seenDenialIds.add(added[0]!.id);
      assert.deepEqual(await loadTransaction(transactionId), ready);
      assert.deepEqual(await successAuditIds(transactionId), auditsBefore);
    }
  }

  assert.equal(seenDenialIds.size, 8);
  assert.deepEqual(await loadTransaction(transactionId), ready);
  assert.deepEqual(await successAuditIds(transactionId), auditsBefore);
  assert.deepEqual(await milestoneEventIds(propertyId), eventsBefore);
});

test("another brokerage still receives 404 before the role check and writes no denial audit", async () => {
  const before = await loadTransaction(transactionId);
  const auditsBefore = await transactionAudits(transactionId);
  const successBefore = await successAuditIds(transactionId);
  const eventsBefore = await milestoneEventIds(propertyId);
  const foreignDenialsBefore = await brokerageDenialIds(B.brokerageId);

  for (const caller of [
    { role: "Brokerage Administrator", cookie: B.admin.cookie },
    { role: "Agent", cookie: B.agent.cookie },
  ]) {
    for (const attempt of attemptsFor(transactionId)) {
      const res = await postJson(attempt.path, caller.cookie, attempt.body);
      const text = await res.text();
      assert.equal(res.status, 404, `${caller.role} ${attempt.label}: ${text}`);
      assert.deepEqual(JSON.parse(text), { error: "Not found" }, `${caller.role} ${attempt.label}`);
    }
  }

  assert.deepEqual(await loadTransaction(transactionId), before);
  assert.deepEqual(await transactionAudits(transactionId), auditsBefore);
  assert.deepEqual(await successAuditIds(transactionId), successBefore);
  assert.deepEqual(await brokerageDenialIds(B.brokerageId), foreignDenialsBefore);
  assert.ok(
    (await transactionAudits(transactionId)).every((row) => row.brokerageId !== B.brokerageId && row.userId !== B.admin.user.id && row.userId !== B.agent.user.id),
  );
  assert.deepEqual(await milestoneEventIds(propertyId), eventsBefore);
});

test("a Brokerage Administrator still passes every settlement prerequisite, then can complete settlement, calculate commission, and record funds", async () => {
  assert.equal(A.admin.user.role, "Brokerage Administrator");

  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `2 Admin Success St ${suffix}`,
    settlementDate: "2027-05-01",
  });
  const id = created.transactionId;
  const ownedPropertyId = created.propertyId;

  const unsigned = await loadTransaction(id);
  assert.equal(unsigned.contractDate, null);
  assert.ok(unsigned.settlementDate, "the accepted offer already carried a settlement date");
  const unsignedAudits = await successAuditIds(id);

  const blockedByContract = await postJson(`/transactions/${id}/settlement-complete`, A.admin.cookie);
  assert.equal(blockedByContract.status, 400);
  assert.deepEqual(await bodyOf<{ error: string }>(blockedByContract), {
    error: `Transaction ${id} cannot complete settlement before the contract is signed.`,
  });
  assert.deepEqual(await loadTransaction(id), unsigned);
  assert.deepEqual(await successAuditIds(id), unsignedAudits);

  await db.update(transactions).set({ settlementDate: null }).where(eq(transactions.id, id));
  const undated = await loadTransaction(id);
  const blockedByDate = await postJson(`/transactions/${id}/settlement-complete`, A.admin.cookie);
  assert.equal(blockedByDate.status, 400);
  assert.deepEqual(await bodyOf<{ error: string }>(blockedByDate), {
    error: `Transaction ${id} has no settlement date scheduled yet.`,
  });
  assert.deepEqual(await loadTransaction(id), undated);

  const signed = await postJson(`/transactions/${id}/contract-signed`, A.agent.cookie);
  assert.equal(signed.status, 200, await signed.text());
  const signedRow = await loadTransaction(id);
  assert.equal(signedRow.settlementDate, null);
  const stillBlocked = await postJson(`/transactions/${id}/settlement-complete`, A.admin.cookie);
  assert.equal(stillBlocked.status, 400);
  assert.deepEqual(await bodyOf<{ error: string }>(stillBlocked), {
    error: `Transaction ${id} has no settlement date scheduled yet.`,
  });
  assert.deepEqual(await loadTransaction(id), signedRow);
  assert.deepEqual(await successAuditIds(id), unsignedAudits);

  const calculated = await postJson(`/transactions/${id}/calculate-commission`, A.admin.cookie, {});
  assert.equal(calculated.status, 200, await calculated.clone().text());
  const calculatedBody = await bodyOf<{
    transaction: { grossCommissionCents: number | null; gstCents: number | null; commissionCalculatedAt: string | null };
  }>(calculated);
  assert.ok(calculatedBody.transaction.grossCommissionCents && calculatedBody.transaction.grossCommissionCents > 0);
  assert.ok(calculatedBody.transaction.gstCents && calculatedBody.transaction.gstCents > 0);
  assert.ok(calculatedBody.transaction.commissionCalculatedAt);
  const afterNormal = await loadTransaction(id);
  const commissionAuditsAfterNormal = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.recordId, String(id)), eq(auditLogs.action, "commission_calculated")));
  assert.equal(commissionAuditsAfterNormal.length, 1);
  assert.equal(commissionAuditsAfterNormal[0]?.userId, A.admin.user.id);

  const recalculated = await postJson(`/transactions/${id}/calculate-commission`, A.admin.cookie, {});
  assert.equal(recalculated.status, 200, await recalculated.text());
  assert.deepEqual(await loadTransaction(id), afterNormal);
  const commissionAuditsAfterRepeat = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eq(auditLogs.recordId, String(id)), eq(auditLogs.action, "commission_calculated")));
  assert.equal(commissionAuditsAfterRepeat.length, 1);

  const forced = await postJson(`/transactions/${id}/calculate-commission`, A.admin.cookie, { force: true });
  assert.equal(forced.status, 200, await forced.text());
  const afterForce = await loadTransaction(id);
  assert.equal(afterForce.grossCommissionCents, afterNormal.grossCommissionCents);
  assert.equal(afterForce.gstCents, afterNormal.gstCents);
  assert.ok(afterForce.commissionCalculatedAt);
  const commissionAuditsAfterForce = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.recordId, String(id)), eq(auditLogs.action, "commission_calculated")));
  assert.equal(commissionAuditsAfterForce.length, 2);
  assert.ok(commissionAuditsAfterForce.every((row) => row.userId === A.admin.user.id));

  const scheduled = await postJson(`/transactions/${id}/settlement-schedule`, A.agent.cookie, {
    settlementDate: "2027-05-20",
  });
  assert.equal(scheduled.status, 200, await scheduled.text());

  await db.update(transactions).set({ unconditionalAt: new Date() }).where(eq(transactions.id, id));

  const completed = await postJson(`/transactions/${id}/settlement-complete`, A.admin.cookie);
  assert.equal(completed.status, 200, await completed.clone().text());
  const completedBody = await bodyOf<{
    transaction: { status: string; grossCommissionCents: number | null; settlementCompletedAt: string | null };
  }>(completed);
  assert.equal(completedBody.transaction.status, "Settled");
  assert.ok(completedBody.transaction.settlementCompletedAt);
  assert.equal(completedBody.transaction.grossCommissionCents, afterNormal.grossCommissionCents);
  const settled = await loadTransaction(id);
  assert.equal(settled.status, "Settled");
  assert.ok(settled.settlementCompletedAt);
  const settlementAudits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.recordId, String(id)), eq(auditLogs.action, "settlement_completed")));
  assert.equal(settlementAudits.length, 1);
  assert.equal(settlementAudits[0]?.userId, A.admin.user.id);
  const commissionAuditsAfterSettlement = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eq(auditLogs.recordId, String(id)), eq(auditLogs.action, "commission_calculated")));
  assert.equal(
    commissionAuditsAfterSettlement.length,
    2,
    "completeSettlement still calls calculateCommission; an existing calculation stays a no-op",
  );

  const funds = await postJson(`/transactions/${id}/funds-received`, A.admin.cookie, { amountCents: 250000 });
  assert.equal(funds.status, 200, await funds.clone().text());
  const fundsBody = await bodyOf<{ transaction: { fundsReceivedCents: number } }>(funds);
  assert.equal(fundsBody.transaction.fundsReceivedCents, 250000);
  const funded = await loadTransaction(id);
  assert.equal(funded.fundsReceivedCents, 250000);
  assert.ok(funded.fundsReceivedAt);
  const fundsAudits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.recordId, String(id)), eq(auditLogs.action, "funds_received")));
  assert.equal(fundsAudits.length, 1);
  assert.equal(fundsAudits[0]?.userId, A.admin.user.id);
  assert.equal(fundsAudits[0]?.updatedValue, "250000");

  const auto = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `3 Auto Commission St ${suffix}`,
    conditionsText: "",
    settlementDate: "2027-06-01",
  });
  const autoSigned = await postJson(`/transactions/${auto.transactionId}/contract-signed`, A.agent.cookie);
  assert.equal(autoSigned.status, 200, await autoSigned.text());
  const autoScheduled = await postJson(`/transactions/${auto.transactionId}/settlement-schedule`, A.agent.cookie, {
    settlementDate: "2027-06-01",
  });
  assert.equal(autoScheduled.status, 200, await autoScheduled.text());
  await db.update(transactions).set({ unconditionalAt: new Date() }).where(eq(transactions.id, auto.transactionId));
  const autoCompleted = await postJson(`/transactions/${auto.transactionId}/settlement-complete`, A.admin.cookie);
  assert.equal(autoCompleted.status, 200, await autoCompleted.clone().text());
  const autoBody = await bodyOf<{ transaction: { status: string; grossCommissionCents: number | null } }>(autoCompleted);
  assert.equal(autoBody.transaction.status, "Settled");
  assert.ok(autoBody.transaction.grossCommissionCents && autoBody.transaction.grossCommissionCents > 0);
  const autoCommissionAudits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.recordId, String(auto.transactionId)), eq(auditLogs.action, "commission_calculated")));
  assert.equal(autoCommissionAudits.length, 1);
  assert.equal(autoCommissionAudits[0]?.userId, A.admin.user.id);
  assert.equal((await getDomainEventsForProperty(ownedPropertyId, "SETTLEMENT_COMPLETED")).length, 1);
  assert.equal((await getDomainEventsForProperty(auto.propertyId, "COMMISSION_CALCULATED")).length, 1);
  assert.equal((await getDomainEventsForProperty(auto.propertyId, "SETTLEMENT_COMPLETED")).length, 1);
  assert.deepEqual(await denialAudits(id), []);
  assert.deepEqual(await denialAudits(auto.transactionId), []);
});

test("a failed denial audit still returns 403 and changes nothing", async (t: TestContext) => {
  const beforeRow = await loadTransaction(transactionId);
  const auditsBefore = await transactionAudits(transactionId);
  const eventsBefore = await milestoneEventIds(propertyId);
  const seen: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const originalError = logger.error.bind(logger);
  t.mock.method(logger, "error", (message: string, fields?: Record<string, unknown>) => {
    seen.push({ message, fields });
    originalError(message, fields);
  });

  const originalInsert = db.insert.bind(db);
  t.mock.method(db, "insert", ((table: unknown) => {
    const builder = originalInsert(table as Parameters<typeof originalInsert>[0]);
    if (table === auditLogs) {
      const originalValues = builder.values.bind(builder);
      t.mock.method(builder, "values", (input: { action?: string }) => {
        if (typeof input?.action === "string" && input.action.endsWith("_denied")) {
          throw new Error("denial audit insert failed");
        }
        return originalValues(input as never);
      });
    }
    return builder;
  }) as typeof db.insert);

  for (const attempt of attemptsFor(transactionId)) {
    const res = await postJson(attempt.path, A.agent.cookie, attempt.body);
    const text = await res.text();
    assert.equal(res.status, 403, `${attempt.label}: ${text}`);
    assert.deepEqual(JSON.parse(text), { error: "Forbidden" });
  }

  assert.deepEqual(await loadTransaction(transactionId), beforeRow);
  assert.deepEqual(await transactionAudits(transactionId), auditsBefore);
  assert.deepEqual(await milestoneEventIds(propertyId), eventsBefore);
  const failures = seen.filter((entry) => entry.message === "log_audit_failed");
  assert.equal(failures.length, attemptsFor(transactionId).length);
  for (const failure of failures) {
    const fields = failure.fields ?? {};
    assert.equal(typeof fields.action, "string");
    assert.match(String(fields.action), /_denied$/);
    assert.equal(fields.recordId, String(transactionId));
    assert.equal(fields.brokerageId, A.brokerageId);
    assert.equal(fields.userId, A.agent.user.id);
    assert.equal("updatedValue" in fields, false);
    assert.equal("amountCents" in fields, false);
    assert.equal(JSON.stringify(fields).includes("password"), false);
  }
});
