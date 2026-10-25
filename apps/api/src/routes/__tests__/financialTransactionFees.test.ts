// Owner t179u slice 2 (migration 0040): AE fee schedule versions (D9) and
// transaction fees with Brokerage Administrator approval, written-authority
// Pit Crew drafting (TRANSACTION_FEE grant) and full audit. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, feeScheduleVersions, pitCrewAssignments, riskExceptions, transactionFees, transactions, users } from "@aee/db";
import { cleanupBrokerages, createBrokerageWithUsers, createTransactionFromListedProperty, devLogin, type DevLoginResult } from "./testSupport.js";
import { AMENDMENT_AUTHORITY_REQUIRED, FINANCIAL_RECORD_AMENDED_AUDIT_ACTION } from "../../lib/financialAmendments.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const nameA = `Fees A ${suffix}`;
type Who = DevLoginResult;
let A: { admin: Who; agent: Who; brokerageId: number };
let B: { admin: Who; agent: Who; brokerageId: number };
let admin2: Who;
let crew: Who;
let otherAgent: Who;
let txn: { propertyId: number; transactionId: number };
const DAY = 86_400_000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();

async function call(method: "GET" | "POST", path: string, cookie: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: body !== undefined ? { cookie, "content-type": "application/json" } : { cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  return { status: res.status, raw, json: raw ? (JSON.parse(raw) as Record<string, any>) : {} };
}
async function inA(name: string, role: string) {
  const r = await devLogin(baseUrl, { email: `${name}-${suffix}@example.com`, firstName: name, lastName: "Synthetic", brokerageName: nameA });
  await db.update(users).set({ role }).where(eq(users.id, r.user.id));
  return r;
}
async function assign(t: { propertyId: number; transactionId: number }) {
  const [ex] = await db
    .insert(riskExceptions)
    .values({
      brokerageId: A.brokerageId,
      propertyId: t.propertyId,
      transactionId: t.transactionId,
      ruleId: "fees-test-rule",
      category: "FINANCIAL",
      severity: "MEDIUM",
      status: "OPEN",
      title: `Synthetic fee work ${t.transactionId}`,
      problemDescription: "Synthetic fixture.",
      businessImpact: "Synthetic fixture.",
      detectedCause: "Synthetic fixture.",
      recommendedAction: "Synthetic fixture.",
      resolutionRequirements: "Synthetic fixture.",
      sourceRecordType: "TEST_FIXTURE",
      sourceRecordId: `fees-${t.transactionId}-${suffix}`,
      correlationId: randomUUID(),
      dedupKey: `fees-${t.transactionId}-${suffix}`,
      openDedupKey: `fees-${t.transactionId}-${suffix}`,
    })
    .returning({ id: riskExceptions.id });
  await db.insert(pitCrewAssignments).values({ brokerageId: A.brokerageId, sourceType: "EXCEPTION", sourceRecordId: ex!.id, propertyId: t.propertyId, status: "IN_PROGRESS", assignedToUserId: crew.user.id, version: 1 });
}
const schedule = (who: Who, body: Record<string, unknown>) => call("POST", "/financial/fee-schedules", who.cookie, body);
const fee = (who: Who, body: Record<string, unknown>) => call("POST", "/financial/transaction-fees", who.cookie, { transactionId: txn.transactionId, ...body });

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, nameA);
  B = await createBrokerageWithUsers(baseUrl, `Fees B ${suffix}`);
  admin2 = await inA("admin2", "Brokerage Administrator");
  crew = await inA("crew", "Pit Crew");
  otherAgent = await inA("agent2", "Agent");
  txn = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: `${suffix} Fees St` });
  await assign(txn);
});

after(async () => {
  await cleanupBrokerages([A, B].map((t) => t?.brokerageId).filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("D9: fee schedule from the signed AE agreement; activation by a different administrator; versions retained, never edited", async () => {
  assert.equal((await schedule(A.admin, { adminFeeCents: 49_500, signedAt: inDays(-30), effectiveFrom: inDays(-30) })).json.reason, "SIGNED_AGREEMENT_REQUIRED");
  for (const who of [crew, A.agent]) assert.equal((await schedule(who, { adminFeeCents: 1, signedAgreementRef: "x", signedAt: inDays(-1), effectiveFrom: inDays(-1) })).status, 403);
  const v1 = await schedule(A.admin, { adminFeeCents: 49_500, signedAgreementRef: "AE brokerage agreement v1 (signed)", signedAt: inDays(-30), effectiveFrom: inDays(-30) });
  assert.equal(v1.status, 201, v1.raw);
  assert.equal(v1.json.feeSchedule.status, "DRAFT");
  assert.equal(v1.json.feeSchedule.version, 1);
  const self = await call("POST", `/financial/fee-schedules/${v1.json.feeSchedule.id}/activate`, A.admin.cookie, {});
  assert.equal(self.status, 403);
  assert.equal(self.json.reason, "SEPARATION_OF_DUTIES");
  const act = await call("POST", `/financial/fee-schedules/${v1.json.feeSchedule.id}/activate`, admin2.cookie, {});
  assert.equal(act.status, 200, act.raw);
  assert.equal(act.json.feeSchedule.status, "ACTIVE");
  assert.equal((await call("POST", `/financial/fee-schedules/${v1.json.feeSchedule.id}/activate`, admin2.cookie, {})).json.reason, "FEE_SCHEDULE_NOT_DRAFT");
  // Other brokerage cannot see or activate it.
  assert.equal((await call("POST", `/financial/fee-schedules/${v1.json.feeSchedule.id}/activate`, B.admin.cookie, {})).status, 404);
  const listB = await call("GET", "/financial/fee-schedules", B.admin.cookie);
  assert.ok(!listB.json.feeSchedules.some((s: { id: number }) => s.id === v1.json.feeSchedule.id));
});

test("ADMIN_FEE comes from the active schedule (client cannot set the figure); BA approval with separation of duties; audit before/after", async () => {
  const mismatch = await fee(A.admin, { kind: "ADMIN_FEE", description: "AE administration fee", amountCents: 1 });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.json.reason, "ADMIN_FEE_SCHEDULE_MISMATCH");
  const r = await fee(A.admin, { kind: "ADMIN_FEE", description: "AE administration fee" });
  assert.equal(r.status, 201, r.raw);
  assert.equal(r.json.fee.amountCents, 49_500);
  assert.equal(r.json.fee.gstCents, 4_950);
  assert.equal(r.json.fee.status, "DRAFT");
  assert.ok(r.json.fee.feeScheduleVersionId);
  const self = await call("POST", `/financial/transaction-fees/${r.json.fee.id}/approve`, A.admin.cookie, {});
  assert.equal(self.json.reason, "SEPARATION_OF_DUTIES");
  const ok = await call("POST", `/financial/transaction-fees/${r.json.fee.id}/approve`, admin2.cookie, {});
  assert.equal(ok.status, 200, ok.raw);
  assert.equal(ok.json.fee.status, "APPROVED");
  const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.recordType, "transaction_fee"), eq(auditLogs.recordId, String(r.json.fee.id))));
  assert.ok(audits.some((a) => a.action === FINANCIAL_RECORD_AMENDED_AUDIT_ACTION && JSON.parse(a.updatedValue!).policy === "t179u"));
  assert.ok(audits.some((a) => a.action === "transaction_fee_approved"));
});

test("a new schedule version supersedes the old one; old fees keep their version; a stale draft cannot be approved", async () => {
  const draftOld = await fee(A.admin, { kind: "ADMIN_FEE", description: "AE administration fee (draft under v1)" });
  assert.equal(draftOld.status, 201);
  const v2 = await schedule(admin2, { adminFeeCents: 55_000, signedAgreementRef: "AE brokerage agreement v2 (signed)", signedAt: inDays(-1), effectiveFrom: inDays(-1) });
  assert.equal(v2.json.feeSchedule.version, 2);
  assert.equal((await call("POST", `/financial/fee-schedules/${v2.json.feeSchedule.id}/activate`, A.admin.cookie, {})).status, 200);
  const rows = await db.select().from(feeScheduleVersions).where(eq(feeScheduleVersions.brokerageId, A.brokerageId));
  assert.deepEqual(rows.map((x) => x.status).sort(), ["ACTIVE", "SUPERSEDED"]);
  const stale = await call("POST", `/financial/transaction-fees/${draftOld.json.fee.id}/approve`, admin2.cookie, {});
  assert.equal(stale.status, 409);
  assert.equal(stale.json.reason, "ADMIN_FEE_SCHEDULE_MISMATCH");
  const fresh = await fee(A.admin, { kind: "ADMIN_FEE", description: "AE administration fee" });
  assert.equal(fresh.json.fee.amountCents, 55_000);
  assert.equal(fresh.json.fee.feeScheduleVersionId, v2.json.feeSchedule.id);
  // Agent-specific schedule wins over the brokerage schedule for that agent's transactions.
  const agentSched = await schedule(A.admin, { agentUserId: A.agent.user.id, adminFeeCents: 30_000, adminFeeGstApplicable: false, signedAgreementRef: "AE agent agreement (signed)", signedAt: inDays(-2), effectiveFrom: inDays(-2) });
  await call("POST", `/financial/fee-schedules/${agentSched.json.feeSchedule.id}/activate`, admin2.cookie, {});
  const agentFee = await fee(A.admin, { kind: "ADMIN_FEE", description: "AE administration fee (agent agreement)" });
  assert.equal(agentFee.json.fee.amountCents, 30_000);
  assert.equal(agentFee.json.fee.gstCents, 0);
});

test("Pit Crew: blocked without a TRANSACTION_FEE grant; with grant + assignment drafts fees and new versions (DRAFT only); approval stays BA", async () => {
  const none = await fee(crew, { kind: "SETTLEMENT_FEE", description: "Settlement agent fee", amountCents: 22_000, gstCents: 2_200 });
  assert.equal(none.status, 403);
  assert.equal(none.json.reason, AMENDMENT_AUTHORITY_REQUIRED);
  assert.equal((await call("POST", "/financial/transaction-fees", crew.cookie, {})).status, 403);
  const g = await call("POST", "/financial-amendment-authorities", A.agent.cookie, {
    transactionId: txn.transactionId,
    granteeUserId: crew.user.id,
    scope: "TRANSACTION_FEE",
    evidenceNote: "Listing agent's written instruction: record settlement fee",
    expiresAt: inDays(5),
  });
  assert.equal(g.status, 201, g.raw);
  const r = await fee(crew, { kind: "SETTLEMENT_FEE", description: "Settlement agent fee", amountCents: 22_000, gstCents: 2_200 });
  assert.equal(r.status, 201, r.raw);
  assert.equal(r.json.fee.status, "DRAFT");
  assert.equal((await call("POST", `/financial/transaction-fees/${r.json.fee.id}/approve`, crew.cookie, {})).status, 403);
  assert.equal((await call("POST", `/financial/transaction-fees/${r.json.fee.id}/approve`, A.admin.cookie, {})).status, 200);
  // New version superseding the approved one.
  const v2 = await fee(crew, { kind: "SETTLEMENT_FEE", description: "Settlement agent fee (corrected)", amountCents: 24_000, gstCents: 2_400, supersedesId: r.json.fee.id });
  assert.equal(v2.status, 201, v2.raw);
  assert.equal(v2.json.fee.version, 2);
  const [audit] = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, FINANCIAL_RECORD_AMENDED_AUDIT_ACTION), eq(auditLogs.recordType, "transaction_fee"), eq(auditLogs.recordId, String(v2.json.fee.id))));
  const v = JSON.parse(audit!.updatedValue!);
  assert.equal(v.authorityId, g.json.authority.id);
  assert.equal(v.authorisedByUserId, A.agent.user.id);
  assert.equal(JSON.parse(audit!.previousValue!).amountCents, 22_000);
  assert.equal(v.after.amountCents, 24_000);
  assert.equal((await call("POST", `/financial/transaction-fees/${v2.json.fee.id}/approve`, admin2.cookie, {})).status, 200);
  const [old] = await db.select().from(transactionFees).where(eq(transactionFees.id, r.json.fee.id));
  assert.equal(old!.status, "SUPERSEDED");
  // Cannot supersede a superseded fee, or change kind.
  assert.equal((await fee(crew, { kind: "SETTLEMENT_FEE", description: "x", amountCents: 1, supersedesId: r.json.fee.id })).json.reason, "FEE_NOT_SUPERSEDABLE");
  // Pit Crew cannot cancel.
  assert.equal((await call("POST", `/financial/transaction-fees/${v2.json.fee.id}/cancel`, crew.cookie, { reason: "x" })).status, 403);
  // Negative only for ADJUSTMENT.
  assert.equal((await fee(crew, { kind: "DEDUCTION", description: "x", amountCents: -5 })).json.reason, "AMOUNT_NEGATIVE");
  assert.equal((await fee(crew, { kind: "ADJUSTMENT", description: "Credit for agreed rebate", amountCents: -5_000 })).status, 201);
});

test("a targeted TRANSACTION_FEE grant covers only that fee; completion ends the grant (D7); reads: BA, listing agent, assigned Pit Crew only", async () => {
  const t2 = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: `${suffix} Fees Two St` });
  await assign(t2);
  const base = await call("POST", "/financial/transaction-fees", A.admin.cookie, { transactionId: t2.transactionId, kind: "DEDUCTION", description: "Bank fee", amountCents: 3_000 });
  await call("POST", `/financial/transaction-fees/${base.json.fee.id}/approve`, admin2.cookie, {});
  const g = await call("POST", "/financial-amendment-authorities", A.admin.cookie, {
    transactionId: t2.transactionId,
    granteeUserId: crew.user.id,
    scope: "TRANSACTION_FEE",
    targetRecordId: String(base.json.fee.id),
    evidenceNote: "Administrator's written instruction for this fee",
    expiresAt: inDays(5),
  });
  assert.equal(g.status, 201, g.raw);
  const badTarget = await call("POST", "/financial-amendment-authorities", A.admin.cookie, {
    transactionId: t2.transactionId,
    granteeUserId: crew.user.id,
    scope: "TRANSACTION_FEE",
    targetRecordId: "999999999",
    evidenceNote: "x",
    expiresAt: inDays(5),
  });
  assert.equal(badTarget.json.reason, "TARGET_NOT_ON_TRANSACTION");
  // Untargeted new fee: not covered.
  assert.equal((await call("POST", "/financial/transaction-fees", crew.cookie, { transactionId: t2.transactionId, kind: "DEDUCTION", description: "x", amountCents: 1 })).status, 403);
  const v2 = await call("POST", "/financial/transaction-fees", crew.cookie, { transactionId: t2.transactionId, kind: "DEDUCTION", description: "Bank fee (corrected)", amountCents: 2_500, supersedesId: base.json.fee.id });
  assert.equal(v2.status, 201, v2.raw);

  for (const who of [A.admin, A.agent, crew]) assert.equal((await call("GET", `/financial/transaction-fees?transactionId=${t2.transactionId}`, who.cookie)).status, 200);
  for (const who of [otherAgent, B.admin, B.agent]) assert.equal((await call("GET", `/financial/transaction-fees?transactionId=${t2.transactionId}`, who.cookie)).status, 404);

  await db.update(transactions).set({ status: "Closed", closedAt: new Date() }).where(eq(transactions.id, t2.transactionId));
  assert.equal(
    (await call("POST", "/financial/transaction-fees", crew.cookie, { transactionId: t2.transactionId, kind: "DEDUCTION", description: "x", amountCents: 1, supersedesId: v2.json.fee.id })).status,
    403,
  );
  // Listing agent and other brokerages cannot write fees.
  assert.equal((await fee(A.agent, { kind: "DEDUCTION", description: "x", amountCents: 1 })).status, 403);
  assert.ok([403, 404].includes((await fee(B.admin, { kind: "DEDUCTION", description: "x", amountCents: 1 })).status));
});

test("0040 DB constraints: ADMIN_FEE needs a schedule; one ACTIVE schedule per party; approver differs from creator", async () => {
  const violates = (name: string) => (err: unknown) => {
    const e = err as { cause?: { constraint?: string }; constraint?: string };
    assert.equal(e.cause?.constraint ?? e.constraint, name);
    return true;
  };
  // Control: a valid row inserts.
  await db.insert(transactionFees).values({ brokerageId: A.brokerageId, propertyId: txn.propertyId, transactionId: txn.transactionId, kind: "DEDUCTION", description: "control", amountCents: 1, createdByUserId: A.admin.user.id });
  await assert.rejects(
    db.insert(transactionFees).values({ brokerageId: A.brokerageId, propertyId: txn.propertyId, transactionId: txn.transactionId, kind: "ADMIN_FEE", description: "x", amountCents: 1, createdByUserId: A.admin.user.id }),
    violates("transaction_fees_schedule_check"),
  );
  await assert.rejects(
    db.insert(transactionFees).values({ brokerageId: A.brokerageId, propertyId: txn.propertyId, transactionId: txn.transactionId, kind: "DEDUCTION", description: "x", amountCents: 1, status: "APPROVED", createdByUserId: A.admin.user.id, approvedByUserId: A.admin.user.id, approvedAt: new Date() }),
    violates("transaction_fees_duties_check"),
  );
  const [active] = await db.select().from(feeScheduleVersions).where(and(eq(feeScheduleVersions.brokerageId, A.brokerageId), eq(feeScheduleVersions.status, "ACTIVE")));
  await assert.rejects(
    db.insert(feeScheduleVersions).values({ ...active!, id: undefined, version: 99, createdAt: undefined } as never),
    violates("fee_schedule_versions_one_active_uq"),
  );
});
