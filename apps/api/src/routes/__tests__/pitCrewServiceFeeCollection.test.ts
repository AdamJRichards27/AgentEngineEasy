// Owner t177u(1) (CC #37): assigned Pit Crew may initiate collection of the AE
// Pit Crew service fee (Financial Engine PC_SUCCESS_FEE) after verified
// settlement, through the existing authority and AE's processor, with every
// gate re-verified server-side and failing closed. Synthetic data only.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  auditLogs,
  commissionAgreements,
  entitlementGrants,
  financialPaymentOutbox,
  financialPaymentRequests,
  pcFeeAuthorities,
  pcFeeCalculations,
  pitCrewAssignments,
  riskExceptions,
  transactions,
  users,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createCommissionAgreement } from "../../lib/financial/agreements.js";
import { createCommissionCalculation } from "../../lib/financial/calculations.js";
import { createPcFeeAuthority } from "../../lib/financial/pcFeeAuthorities.js";
import { createPcFeeCalculation } from "../../lib/financial/pcFeeCalculations.js";
import { ensurePcSuccessFeeRequest } from "../../lib/financial/settlement.js";
import {
  setSettlementStatementLookupForTests,
  type IssuedSettlementStatementRecord,
  type SettlementStatementLookup,
} from "../../lib/settlementStatementGate.js";
import { cleanupBrokerages, createBrokerageWithUsers, createTransactionFromListedProperty, devLogin, type DevLoginResult, forceAuthorityFixture } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

type Tenant = { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let server: Server;
let baseUrl: string;
const suffix = Date.now();
const nameX = `SvcFee X ${suffix}`;
let X: Tenant;
let Y: Tenant;
let crew: DevLoginResult;
let crewUnassigned: DevLoginResult;
let otherAgent: DevLoginResult;
const MANDATE_REF = `sandbox-mandate-svcfee-${suffix}`;
let authorityId: number;
// t178u: until S1 exists, these tests stand in an ISSUED statement per transaction
// through the test-only lookup seam (production always returns "none issued").
const statements = new Map<number, IssuedSettlementStatementRecord>();
let statementSeq = 1;
const fixtureLookup: SettlementStatementLookup = async ({ transactionId }) => statements.get(transactionId) ?? null;
function issueStatement(c: { transactionId: number; requestId: number; amountCents: number }, patch: Partial<IssuedSettlementStatementRecord> = {}) {
  statements.set(c.transactionId, {
    statementId: statementSeq++,
    brokerageId: X.brokerageId,
    transactionId: c.transactionId,
    status: "ISSUED",
    issuedAt: new Date(),
    issuedTo: { payerType: "Agent", userId: X.agent.user.id },
    lines: [
      { kind: "COMMISSION", amountCents: 1_600_000 },
      { kind: "PC_SERVICE_FEE", amountCents: c.amountCents, currency: "AUD", paymentRequestId: c.requestId },
    ],
    ...patch,
  });
}

async function call(method: string, path: string, cookie?: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const collect = (txnId: number, cookie: string) => call("POST", `/payments/pit-crew-service-fee/${txnId}/collect`, cookie);
const status = (txnId: number, cookie: string) => call("GET", `/payments/pit-crew-service-fee/${txnId}`, cookie);

async function grantRun(brokerageId: number) {
  const rows = await db.select().from(entitlementGrants).where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  if (rows.length === 0) {
    await db.insert(entitlementGrants).values({ brokerageId, entitlementKey: "run.access", granteeType: "brokerage", granteeId: brokerageId, sourceType: "manual", status: "Active" });
  } else {
    await db.update(entitlementGrants).set({ status: "Active" }).where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  }
  invalidateEntitlementCache(brokerageId);
}

async function assign(who: DevLoginResult, propertyId: number, transactionId: number, tag: string, assignmentStatus = "IN_PROGRESS") {
  const [ex] = await db
    .insert(riskExceptions)
    .values({
      brokerageId: X.brokerageId,
      propertyId,
      transactionId,
      ruleId: "svc-fee-test-rule",
      category: "FINANCIAL",
      severity: "MEDIUM",
      status: "OPEN",
      title: `Synthetic settlement work ${tag}`,
      problemDescription: "Synthetic fixture.",
      businessImpact: "Synthetic fixture.",
      detectedCause: "Synthetic fixture.",
      recommendedAction: "Synthetic fixture.",
      resolutionRequirements: "Synthetic fixture.",
      sourceRecordType: "TEST_FIXTURE",
      sourceRecordId: `svc-fee-${tag}-${suffix}`,
      correlationId: randomUUID(),
      dedupKey: `svc-fee-${tag}-${suffix}`,
      openDedupKey: `svc-fee-${tag}-${suffix}`,
    })
    .returning({ id: riskExceptions.id });
  await db
    .insert(pitCrewAssignments)
    .values({ brokerageId: X.brokerageId, sourceType: "EXCEPTION", sourceRecordId: String(ex!.id), propertyId, status: assignmentStatus, assignedToUserId: who.user.id, version: 1 });
}

/** A settled transaction with an approved agreement, FINALISED commission and PC fee calculations and a CALCULATED PC_SUCCESS_FEE request. */
async function feeChain(tag: string, opts: { settled?: boolean; assignCrew?: boolean; statement?: boolean } = {}) {
  const { propertyId, transactionId } = await createTransactionFromListedProperty(baseUrl, X.agent.cookie, { address: `${suffix} ${tag} Fee St` });
  if (opts.settled !== false) {
    await db.update(transactions).set({ status: "Settled", settlementCompletedAt: new Date() }).where(eq(transactions.id, transactionId));
  }
  const agreement = await createCommissionAgreement({
    brokerageId: X.brokerageId,
    propertyId,
    transactionId,
    method: "PERCENTAGE",
    rateBps: 200,
    createdByUserId: X.admin.user.id,
  });
  await db.update(commissionAgreements).set({ status: "APPROVED", approvedAt: new Date() }).where(eq(commissionAgreements.id, agreement.id));
  const commission = await createCommissionCalculation({
    brokerageId: X.brokerageId,
    propertyId,
    transactionId,
    commissionAgreementId: agreement.id,
    salePriceCentsInput: 80_000_000,
    state: "FINALISED",
  });
  const pcCalc = await createPcFeeCalculation({ brokerageId: X.brokerageId, propertyId, transactionId, pcFeeAuthorityId: authorityId, commissionCalculationId: commission.id, state: "FINALISED" });
  const { paymentRequest } = await ensurePcSuccessFeeRequest({
    transactionId,
    brokerageId: X.brokerageId,
    propertyId,
    pcFeeCalculationId: pcCalc.id,
    payerUserId: X.agent.user.id,
  });
  if (opts.assignCrew !== false) await assign(crew, propertyId, transactionId, tag);
  if (opts.statement !== false) issueStatement({ transactionId, requestId: paymentRequest.id, amountCents: paymentRequest.amountCents });
  return { propertyId, transactionId, requestId: paymentRequest.id, pcCalcId: pcCalc.id, commission, pcCalc };
}
async function request(id: number) {
  const [row] = await db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, id));
  return row!;
}
async function outboxCount(id: number) {
  return (await db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.paymentRequestId, id))).length;
}
async function code(res: Response) {
  return ((await res.json()) as { code: string }).code;
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  X = await createBrokerageWithUsers(baseUrl, nameX);
  Y = await createBrokerageWithUsers(baseUrl, `SvcFee Y ${suffix}`);
  await grantRun(X.brokerageId);
  await grantRun(Y.brokerageId);
  crew = await devLogin(baseUrl, { email: `crew-svcfee-${suffix}@example.com`, firstName: "Crew", lastName: "Synthetic", brokerageName: nameX });
  crewUnassigned = await devLogin(baseUrl, { email: `crew2-svcfee-${suffix}@example.com`, firstName: "Crew2", lastName: "Synthetic", brokerageName: nameX });
  otherAgent = await devLogin(baseUrl, { email: `agent2-svcfee-${suffix}@example.com`, firstName: "Agent2", lastName: "Synthetic", brokerageName: nameX });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, crew.user.id));
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, crewUnassigned.user.id));
  const authority = await createPcFeeAuthority({
    brokerageId: X.brokerageId,
    agentUserId: X.agent.user.id,
    feeBasis: "PERCENTAGE_OF_GCI",
    rateBps: 690,
    gstApplicable: true,
    maximumAmountCents: 1_000_000,
    noticeRequiredDays: 7,
    signedEvidenceRef: "synthetic-signed-authority",
    createdByUserId: X.admin.user.id,
  });
  await db
    .update(pcFeeAuthorities)
    .set({ status: "ACTIVE", mandateProviderRef: MANDATE_REF, mandateProvider: "sandbox", effectiveDate: new Date(Date.now() - 86_400_000) })
    .where(eq(pcFeeAuthorities.id, authority.id));
  authorityId = authority.id;
  setSettlementStatementLookupForTests(fixtureLookup);
});

after(async () => {
  setSettlementStatementLookupForTests(null);
  await cleanupBrokerages([X, Y].map((t) => t?.brokerageId).filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t177u(1): Pit Crew service-fee collection after verified settlement", { concurrency: false }, () => {
  test("assigned Pit Crew: status, notice start, notice period enforced, debit scheduled once, then idempotent", async () => {
    const c = await feeChain("happy");
    const s = await status(c.transactionId, crew.cookie);
    assert.equal(s.status, 200, await s.clone().text());
    const view = (await s.json()) as { serviceFee: Record<string, unknown>; collectable: boolean };
    assert.equal(view.collectable, true);
    assert.equal(view.serviceFee.totalFeeCents, c.pcCalc.totalFeeCents);
    assert.equal(view.serviceFee.gstCents, c.pcCalc.gstCents);
    assert.equal(view.serviceFee.capCents, 1_000_000);
    assert.ok(!JSON.stringify(view).includes(MANDATE_REF), "no mandate reference exposed");

    const r1 = await collect(c.transactionId, crew.cookie);
    assert.equal(r1.status, 200, await r1.clone().text());
    assert.equal(((await r1.json()) as { outcome: string }).outcome, "notice_started");
    assert.equal((await request(c.requestId)).status, "NOTICE_SENT");

    const r2 = await collect(c.transactionId, crew.cookie);
    assert.equal(r2.status, 409);
    assert.equal(await code(r2), "SERVICE_FEE_NOTICE_PERIOD_RUNNING");
    assert.equal(await outboxCount(c.requestId), 0, "no debit before the notice period elapses");

    await db.update(financialPaymentRequests).set({ noticeSentAt: new Date(Date.now() - 8 * 86_400_000) }).where(eq(financialPaymentRequests.id, c.requestId));
    const r3 = await collect(c.transactionId, crew.cookie);
    assert.equal(r3.status, 200, await r3.clone().text());
    assert.equal(((await r3.json()) as { outcome: string }).outcome, "debit_scheduled");
    const after = await request(c.requestId);
    assert.equal(after.status, "DEBIT_SCHEDULED");
    assert.equal(after.amountCents, c.pcCalc.totalFeeCents);
    assert.equal(await outboxCount(c.requestId), 1);

    for (let i = 0; i < 2; i++) {
      const again = await collect(c.transactionId, crew.cookie);
      assert.equal(again.status, 200);
      assert.equal(((await again.json()) as { outcome: string }).outcome, "already_in_progress");
    }
    assert.equal(await outboxCount(c.requestId), 1, "duplicate-debit protection: still one SCHEDULE_DEBIT");

    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.userId, crew.user.id), eq(auditLogs.recordId, String(c.transactionId))));
    const outcomes = rows.map((r) => JSON.parse(r.updatedValue ?? "{}").outcome ?? JSON.parse(r.updatedValue ?? "{}").code);
    assert.ok(outcomes.includes("notice_started") && outcomes.includes("debit_scheduled") && outcomes.includes("already_in_progress"));
    assert.ok(rows.some((r) => r.action === "pit_crew_service_fee_collection_failed" && JSON.parse(r.updatedValue!).code === "SERVICE_FEE_NOTICE_PERIOD_RUNNING"));
    const scheduled = rows.find((r) => JSON.parse(r.updatedValue ?? "{}").outcome === "debit_scheduled")!;
    const v = JSON.parse(scheduled.updatedValue!);
    assert.equal(v.callerRole, "Pit Crew");
    assert.equal(v.totalFeeCents, c.pcCalc.totalFeeCents);
    assert.equal(v.statusBefore, "NOTICE_SENT");
    assert.equal(v.statusAfter, "DEBIT_SCHEDULED");
    assert.ok(Array.isArray(v.pitCrewAssignmentIds) && v.pitCrewAssignmentIds.length === 1);
    for (const r of rows) assert.ok(!JSON.stringify(r).includes(MANDATE_REF), "no mandate reference in audit");
  });

  test("settlement not recorded complete: 409 SETTLEMENT_NOT_VERIFIED, nothing changes", async () => {
    const c = await feeChain("unsettled", { settled: false });
    const r = await collect(c.transactionId, crew.cookie);
    assert.equal(r.status, 409);
    assert.equal(await code(r), "SETTLEMENT_NOT_VERIFIED");
    // status flag alone (without settlement_completed_at) is not enough
    await db.update(transactions).set({ status: "Settled" }).where(eq(transactions.id, c.transactionId));
    assert.equal(await code(await collect(c.transactionId, crew.cookie)), "SETTLEMENT_NOT_VERIFIED");
    assert.equal((await request(c.requestId)).status, "CALCULATED");
  });

  test("Pit Crew without an active assignment on the transaction: 403", async () => {
    const c = await feeChain("unassigned", { assignCrew: false });
    const r = await collect(c.transactionId, crewUnassigned.cookie);
    assert.equal(r.status, 403);
    assert.equal(await code(r), "PIT_CREW_NOT_ASSIGNED");
    await assign(crewUnassigned, c.propertyId, c.transactionId, "done", "DONE");
    assert.equal((await collect(c.transactionId, crewUnassigned.cookie)).status, 403, "a DONE assignment is not active");
    assert.equal((await status(c.transactionId, crewUnassigned.cookie)).status, 403);
    assert.equal((await request(c.requestId)).status, "CALCULATED");
  });

  test("fee must match the agreed terms: tampered amount, tampered calculation, disputed fee all fail closed", async () => {
    const a = await feeChain("tamper-amount");
    await db.update(financialPaymentRequests).set({ amountCents: a.pcCalc.totalFeeCents + 1 }).where(eq(financialPaymentRequests.id, a.requestId));
    assert.equal(await code(await collect(a.transactionId, crew.cookie)), "SERVICE_FEE_NOT_VERIFIED");

    const b = await feeChain("tamper-calc");
    await db
      .update(pcFeeCalculations)
      .set({ grossFeeCents: b.pcCalc.grossFeeCents + 100, totalFeeCents: b.pcCalc.totalFeeCents + 110 })
      .where(eq(pcFeeCalculations.id, b.pcCalcId));
    await db.update(financialPaymentRequests).set({ amountCents: b.pcCalc.totalFeeCents + 110 }).where(eq(financialPaymentRequests.id, b.requestId));
    assert.equal(await code(await collect(b.transactionId, crew.cookie)), "SERVICE_FEE_NOT_VERIFIED", "recomputed from the authority terms");

    const d = await feeChain("disputed");
    await db.update(pcFeeCalculations).set({ isDisputed: true }).where(eq(pcFeeCalculations.id, d.pcCalcId));
    assert.equal(await code(await collect(d.transactionId, crew.cookie)), "SERVICE_FEE_NOT_VERIFIED");
    for (const c of [a, b, d]) assert.equal((await request(c.requestId)).status, "CALCULATED");
  });

  test("fee cap: the authority's maximum is applied and verified", async () => {
    await forceAuthorityFixture(authorityId, { maximumAmountCents: 50_000 });
    try {
      const c = await feeChain("capped");
      assert.equal(c.pcCalc.grossFeeCents, 50_000, "computed fee capped");
      assert.equal(c.pcCalc.gstCents, 5_000);
      assert.equal((await collect(c.transactionId, crew.cookie)).status, 200);
      // A later, lower cap means the stored fee no longer matches the terms -> refuse.
      const d = await feeChain("cap-lowered");
      await forceAuthorityFixture(authorityId, { maximumAmountCents: 40_000 });
      assert.equal(await code(await collect(d.transactionId, crew.cookie)), "SERVICE_FEE_NOT_VERIFIED");
    } finally {
      await forceAuthorityFixture(authorityId, { maximumAmountCents: 1_000_000 });
    }
  });

  test("authority must be valid and cover the charge: expired, revoked, no mandate, wrong payer all fail closed", async () => {
    const c = await feeChain("authority");
    const restore = { status: "ACTIVE", expiresAt: null, revokedAt: null, mandateProviderRef: MANDATE_REF, agentUserId: X.agent.user.id } as const;
    const cases: Array<[string, Partial<typeof pcFeeAuthorities.$inferInsert>]> = [
      ["expired", { expiresAt: new Date(Date.now() - 1000) }],
      ["revoked", { status: "REVOKED", revokedAt: new Date() }],
      ["no mandate", { mandateProviderRef: null }],
      ["not yet effective", { effectiveDate: new Date(Date.now() + 86_400_000) }],
    ];
    for (const [label, patch] of cases) {
      await forceAuthorityFixture(authorityId, patch);
      const r = await collect(c.transactionId, crew.cookie);
      assert.equal(r.status, 409, label);
      assert.equal(await code(r), "SERVICE_FEE_AUTHORITY_INVALID", label);
      await forceAuthorityFixture(authorityId, { ...restore, effectiveDate: new Date(Date.now() - 86_400_000) });
    }
    await db.update(financialPaymentRequests).set({ payerUserId: otherAgent.user.id }).where(eq(financialPaymentRequests.id, c.requestId));
    assert.equal(await code(await collect(c.transactionId, crew.cookie)), "SERVICE_FEE_AUTHORITY_INVALID", "payer must be the authority's agent");
    assert.equal((await request(c.requestId)).status, "CALCULATED");
  });

  test("recovery stays with administrators: FAILED / DISPUTED / REVERSED refused; PAID is a no-op", async () => {
    for (const st of ["FAILED", "DISPUTED", "REVERSED", "WAIVED", "WRITTEN_OFF"]) {
      const c = await feeChain(`recovery-${st}`);
      await db.update(financialPaymentRequests).set({ status: st }).where(eq(financialPaymentRequests.id, c.requestId));
      const r = await collect(c.transactionId, crew.cookie);
      assert.equal(r.status, 409, st);
      assert.equal(await code(r), "SERVICE_FEE_NOT_COLLECTABLE", st);
      assert.equal(await outboxCount(c.requestId), 0);
    }
    const p = await feeChain("paid");
    await db.update(financialPaymentRequests).set({ status: "PAID", paidAt: new Date() }).where(eq(financialPaymentRequests.id, p.requestId));
    const r = await collect(p.transactionId, crew.cookie);
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { outcome: string }).outcome, "already_paid");
    assert.equal(await outboxCount(p.requestId), 0);
  });

  test("who: Brokerage Administrator allowed; listing agent, other agent and other brokerage get 404", async () => {
    const c = await feeChain("who");
    for (const who of [X.agent, otherAgent, Y.admin, Y.agent]) {
      const r = await collect(c.transactionId, who.cookie);
      assert.equal(r.status, 404);
      assert.deepEqual(await r.json(), { error: "Not found", code: "SERVICE_FEE_NOT_FOUND" });
    }
    assert.equal((await request(c.requestId)).status, "CALCULATED");
    const ba = await collect(c.transactionId, X.admin.cookie);
    assert.equal(ba.status, 200);
    assert.equal(((await ba.json()) as { outcome: string }).outcome, "notice_started");
  });

  test("only the service fee: Pit Crew stay 403 on saved-card charges and on the administrator payment-request routes", async () => {
    const c = await feeChain("other-routes");
    const so = await call("POST", `/payments/service-orders/999999991/charge`, crew.cookie);
    assert.ok(so.status === 404 || so.status === 403);
    for (const path of [
      `/financial/payment-requests/${c.requestId}/notice-sent`,
      `/financial/payment-requests/${c.requestId}/schedule-debit`,
      `/financial/payment-requests/${c.requestId}/cancel-debit`,
      `/financial/payment-requests/${c.requestId}/reverse`,
      `/financial/settlement/ensure-pc-success-fee`,
      `/financial/ops/dispatch-outbox`,
    ]) {
      const r = await call("POST", path, crew.cookie, { reason: "x", transactionId: c.transactionId, pcFeeCalculationId: c.pcCalcId });
      assert.equal(r.status, 403, path);
    }
    assert.equal((await request(c.requestId)).status, "CALCULATED");
  });
});

describe("t178u(1): statement-first, collection is held until an itemised statement is issued to the payer", { concurrency: false }, () => {
  async function noticeElapsed(requestId: number) {
    await db
      .update(financialPaymentRequests)
      .set({ status: "NOTICE_SENT", noticeSentAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(financialPaymentRequests.id, requestId));
  }

  test("production lookup (no statement record exists yet): collect is 409 SETTLEMENT_STATEMENT_NOT_ISSUED, before any outbox or provider step; audited value-free; preview still works", async () => {
    setSettlementStatementLookupForTests(null);
    try {
      const c = await feeChain("hold-default");
      const r = await collect(c.transactionId, crew.cookie);
      assert.equal(r.status, 409);
      assert.equal(await code(r), "SETTLEMENT_STATEMENT_NOT_ISSUED");
      assert.equal((await request(c.requestId)).status, "CALCULATED", "no notice started");

      // Even with the notice period elapsed (the step that schedules the debit), nothing is queued.
      await noticeElapsed(c.requestId);
      for (let i = 0; i < 3; i++) assert.equal(await code(await collect(c.transactionId, crew.cookie)), "SETTLEMENT_STATEMENT_NOT_ISSUED");
      assert.equal(await outboxCount(c.requestId), 0, "no SCHEDULE_DEBIT outbox row, so no provider call");
      assert.equal((await request(c.requestId)).status, "NOTICE_SENT");
      // Brokerage Administrators are held too.
      assert.equal(await code(await collect(c.transactionId, X.admin.cookie)), "SETTLEMENT_STATEMENT_NOT_ISSUED");
      // Already-paid requests do not report through the gate either.
      const p = await feeChain("hold-paid");
      await db.update(financialPaymentRequests).set({ status: "PAID", paidAt: new Date() }).where(eq(financialPaymentRequests.id, p.requestId));
      assert.equal(await code(await collect(p.transactionId, crew.cookie)), "SETTLEMENT_STATEMENT_NOT_ISSUED");

      const s = await status(c.transactionId, crew.cookie);
      assert.equal(s.status, 200);
      const view = (await s.json()) as { serviceFee: { totalFeeCents: number }; collectable: boolean; settlementStatement: { issued: boolean; code?: string } };
      assert.equal(view.collectable, false);
      assert.deepEqual(view.settlementStatement, { issued: false, code: "SETTLEMENT_STATEMENT_NOT_ISSUED" });
      assert.equal(view.serviceFee.totalFeeCents, c.pcCalc.totalFeeCents);

      const rows = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "pit_crew_service_fee_collection_failed"), eq(auditLogs.recordId, String(c.transactionId))));
      assert.ok(rows.length >= 4);
      for (const row of rows) {
        const v = JSON.parse(row.updatedValue!);
        assert.deepEqual(Object.keys(v).sort(), ["callerRole", "code", "outcome", "policy"], "value-free");
        assert.equal(v.code, "SETTLEMENT_STATEMENT_NOT_ISSUED");
        assert.ok(!JSON.stringify(row).includes(String(c.pcCalc.totalFeeCents)));
      }
    } finally {
      setSettlementStatementLookupForTests(fixtureLookup);
    }
  });

  test("statement must be ISSUED, for this transaction and brokerage, to the authorised payer, with exactly one PC_SERVICE_FEE line equal to the request", async () => {
    const c = await feeChain("gate-cases", { statement: false });
    const base = { transactionId: c.transactionId, requestId: c.requestId, amountCents: c.pcCalc.totalFeeCents };
    const cases: Array<[string, Partial<IssuedSettlementStatementRecord>, string]> = [
      ["draft", { status: "DRAFT" }, "SETTLEMENT_STATEMENT_NOT_ISSUED"],
      ["superseded", { status: "SUPERSEDED" }, "SETTLEMENT_STATEMENT_NOT_ISSUED"],
      ["no issue date", { issuedAt: null }, "SETTLEMENT_STATEMENT_NOT_ISSUED"],
      ["other transaction", { transactionId: c.transactionId + 1_000_000 }, "SETTLEMENT_STATEMENT_NOT_ISSUED"],
      ["other brokerage", { brokerageId: Y.brokerageId }, "SETTLEMENT_STATEMENT_NOT_ISSUED"],
      ["issued to another agent", { issuedTo: { payerType: "Agent", userId: otherAgent.user.id } }, "SETTLEMENT_STATEMENT_PAYER_MISMATCH"],
      ["issued to the brokerage", { issuedTo: { payerType: "Brokerage", brokerageId: X.brokerageId } }, "SETTLEMENT_STATEMENT_PAYER_MISMATCH"],
      ["no fee line", { lines: [{ kind: "COMMISSION", amountCents: 1 }] }, "SETTLEMENT_STATEMENT_FEE_MISMATCH"],
      ["fee line differs", { lines: [{ kind: "PC_SERVICE_FEE", amountCents: c.pcCalc.totalFeeCents - 1 }] }, "SETTLEMENT_STATEMENT_FEE_MISMATCH"],
      [
        "two fee lines",
        { lines: [{ kind: "PC_SERVICE_FEE", amountCents: c.pcCalc.totalFeeCents }, { kind: "PC_SERVICE_FEE", amountCents: c.pcCalc.totalFeeCents }] },
        "SETTLEMENT_STATEMENT_FEE_MISMATCH",
      ],
      ["fee line for another request", { lines: [{ kind: "PC_SERVICE_FEE", amountCents: c.pcCalc.totalFeeCents, paymentRequestId: c.requestId + 1 }] }, "SETTLEMENT_STATEMENT_FEE_MISMATCH"],
      ["fee line in another currency", { lines: [{ kind: "PC_SERVICE_FEE", amountCents: c.pcCalc.totalFeeCents, currency: "NZD" }] }, "SETTLEMENT_STATEMENT_FEE_MISMATCH"],
    ];
    await noticeElapsed(c.requestId);
    for (const [label, patch, expected] of cases) {
      issueStatement(base, patch);
      const r = await collect(c.transactionId, crew.cookie);
      assert.equal(r.status, 409, label);
      assert.equal(await code(r), expected, label);
    }
    statements.delete(c.transactionId);
    assert.equal(await code(await collect(c.transactionId, crew.cookie)), "SETTLEMENT_STATEMENT_NOT_ISSUED", "no statement");
    setSettlementStatementLookupForTests(async () => {
      throw new Error("lookup failure");
    });
    try {
      assert.equal(await code(await collect(c.transactionId, crew.cookie)), "SETTLEMENT_STATEMENT_NOT_ISSUED", "lookup error fails closed");
    } finally {
      setSettlementStatementLookupForTests(fixtureLookup);
    }
    assert.equal(await outboxCount(c.requestId), 0, "nothing queued by any refused call");
    assert.equal((await request(c.requestId)).status, "NOTICE_SENT");

    // A matching statement unblocks exactly one debit, even under concurrent calls.
    issueStatement(base);
    const results = await Promise.all([0, 1, 2, 3].map(() => collect(c.transactionId, crew.cookie)));
    assert.ok(results.every((r) => r.status === 200 || r.status === 202 || r.status === 409), results.map((r) => r.status).join(","));
    assert.equal(await outboxCount(c.requestId), 1, "one SCHEDULE_DEBIT only");
    assert.equal((await request(c.requestId)).status, "DEBIT_SCHEDULED");
    const ok = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "pit_crew_service_fee_collection"), eq(auditLogs.recordId, String(c.transactionId))));
    assert.ok(ok.some((r) => JSON.parse(r.updatedValue!).settlementStatementId === statements.get(c.transactionId)!.statementId));
  });

  test("the test seam cannot be used outside NODE_ENV=test", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.throws(() => setSettlementStatementLookupForTests(fixtureLookup), /test-only/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
