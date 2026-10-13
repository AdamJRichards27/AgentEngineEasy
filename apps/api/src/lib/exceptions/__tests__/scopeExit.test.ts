// Scope-exit policy for the scheduled scan (PR A).
//
// Before closure, a still-true condition stays one open row across repeated
// scans. An in-scope clear is CONDITION_SATISFIED. After closure, an ordinary
// rule (D15) is NO_LONGER_APPLICABLE — never recorded as the condition
// having cleared — while FINANCIAL, AML/CTF and F32 stay open with the same
// owner and brokerage. A repeat scan does not duplicate rows or reopen a
// resolution. Brokerage B is never touched by brokerage A's scan.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  db,
  financialPaymentRequests,
  financialReconciliations,
  properties,
  riskExceptions,
  riskExceptionTransitions,
  transactionConditions,
  transactions,
  type RiskException,
} from "@aee/db";
import { runScheduledScan, type ScanSummary } from "../engine.js";
import { createOrUpdateException, newCorrelationId, reassignOwner } from "../model.js";
import { listBrokerageExceptions } from "../queries.js";
import {
  RISK_RULES,
  assertPinnedScopeExitPolicies,
  detectScopeExit,
  effectiveScopeExitPolicy,
  isPinnedScopeExitRule,
  type RiskRule,
  type ScopeObservation,
} from "../registry.js";
import type { RiskFinding } from "../types.js";
import { getPitCrewWorkspace } from "../../pitCrew/queries.js";
import { createBrokerageWithUsers, createTransactionFromListedProperty, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const D15 = "D15_CONTRACT_MISSING_LEGAL_REPRESENTATIVES";
const E23 = "E23_24_BUYER_AML_INCOMPLETE";
const F32 = "F32_CLOSURE_BLOCKED_BY_UNRESOLVED_CONDITION";
const FIN05 = "FIN05_RECONCILIATION_VARIANCE_UNRESOLVED";

test("pinned scope-exit rules are KEEP_OPEN at startup, and a SUPERSEDE or omitted policy fails the import assertion", () => {
  assert.doesNotThrow(() => assertPinnedScopeExitPolicies(RISK_RULES));
  for (const rule of RISK_RULES) {
    if (!isPinnedScopeExitRule(rule)) continue;
    assert.equal(rule.scopeExitPolicy, "KEEP_OPEN", rule.ruleId);
  }
  const b08 = RISK_RULES.find((rule) => rule.ruleId === "B08_LISTING_LIVE_MISSING_CAMPAIGN_INFO");
  assert.ok(b08);
  assert.equal(b08.version, 2);
  assert.equal(b08.stageRange, undefined, "B08's marketing window is its own hook, not a generic stage range");
  assert.equal(b08.scopeExitPolicy, undefined);
  assert.equal(typeof b08.resolutionEvidenceWhenAbsent, "function");

  for (const bad of [
    { ruleId: "FIN05_RECONCILIATION_VARIANCE_UNRESOLVED", category: "FINANCIAL", scopeExitPolicy: "NO_LONGER_APPLICABLE" as const },
    { ruleId: "E23_24_BUYER_AML_INCOMPLETE", category: "AML_CTF" },
    { ruleId: "FUTURE_COMPLIANCE", category: "COMPLIANCE", scopeExitPolicy: "NO_LONGER_APPLICABLE" as const },
    { ruleId: "FUTURE_SECURITY", category: "SECURITY", scopeExitPolicy: "NO_LONGER_APPLICABLE" as const },
    { ruleId: "F32_CLOSURE_BLOCKED_BY_UNRESOLVED_CONDITION", category: "SETTLEMENT_CLOSURE", scopeExitPolicy: "NO_LONGER_APPLICABLE" as const },
    { ruleId: "F33_CLOSURE_ATTEMPTED_PREMATURELY", category: "SETTLEMENT_CLOSURE" },
    { ruleId: "F34_CLOSED_TRANSACTION_HAS_ACTIVE_BLOCKER", category: "SETTLEMENT_CLOSURE", scopeExitPolicy: "NO_LONGER_APPLICABLE" as const },
  ]) {
    assert.throws(() => assertPinnedScopeExitPolicies([bad]), /KEEP_OPEN/);
  }
});

test("detectScopeExit distinguishes an in-scope clear from a closed transaction or a stage exit", () => {
  const openTxn: ScopeObservation = {
    transactionId: 10,
    transactionPresent: true,
    closedAt: null,
    propertyPresent: true,
    workflowStage: "Listed",
  };
  const closedTxn: ScopeObservation = { ...openTxn, closedAt: new Date("2026-10-01T00:00:00.000Z") };
  const laterStage: ScopeObservation = { ...openTxn, transactionId: null, transactionPresent: true, workflowStage: "Under Contract" };
  const ordinary: RiskRule = {
    ruleId: "D15_CONTRACT_MISSING_LEGAL_REPRESENTATIVES",
    version: 1,
    category: "CONTRACT_CONDITIONS",
    name: "n/a",
    description: "n/a",
    triggerEventTypes: [],
    stageRange: ["Listed"],
    async scanBrokerage() {
      return [];
    },
  };
  assert.equal(detectScopeExit(ordinary, openTxn), null);
  assert.equal(effectiveScopeExitPolicy(ordinary), "NO_LONGER_APPLICABLE");
  assert.equal(detectScopeExit(ordinary, closedTxn), "TRANSACTION_CLOSED");
  assert.equal(detectScopeExit(ordinary, laterStage), "STAGE_EXIT");

  const financial: RiskRule = {
    ...ordinary,
    ruleId: "FIN05_RECONCILIATION_VARIANCE_UNRESOLVED",
    category: "FINANCIAL",
    scopeExitPolicy: "KEEP_OPEN",
    transactionCloseScope: "STAYS",
    stageRange: undefined,
  };
  assert.equal(detectScopeExit(financial, closedTxn), null, "a financial rule that still scans closed transactions is not out of scope merely because closedAt is set");
  assert.equal(effectiveScopeExitPolicy(financial), "KEEP_OPEN");

  const droppedFinancial: RiskRule = { ...financial, transactionCloseScope: "LEAVES" };
  assert.equal(detectScopeExit(droppedFinancial, closedTxn), "TRANSACTION_CLOSED");
  assert.equal(effectiveScopeExitPolicy({ ...droppedFinancial, scopeExitPolicy: "NO_LONGER_APPLICABLE" }), "KEEP_OPEN");
});

describe("scheduled scan scope exit", { concurrency: false, timeout: 300_000 }, () => {
  let server: Server;
  let baseUrl: string;
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
  let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

  let d15A: Fixture;
  let d15Clear: Fixture;
  let d15B: Fixture;
  let f32: Fixture;
  // E23 shares d15A's open contract (settlement date cleared). FIN05 shares f32's transaction.
  let e23: Fixture;
  let fin: Fixture;

  before(async () => {
    const { configureEvents } = await import("../../events.js");
    configureEvents();
    const { createApp } = await import("../../../app.js");
    const app = createApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    baseUrlHolder.url = baseUrl;

    A = await createBrokerageWithUsers(baseUrl, `Scope Exit A ${suffix}`);
    B = await createBrokerageWithUsers(baseUrl, `Scope Exit B ${suffix}`);

    d15A = await openContract(A, `1 Scope D15 A ${suffix}`);
    e23 = d15A;
    await db.update(transactions).set({ settlementDate: null, updatedAt: new Date() }).where(eq(transactions.id, e23.transactionId));
    d15Clear = await openContract(A, `1 Scope D15 Clear ${suffix}`);
    d15B = await openContract(B, `1 Scope D15 B ${suffix}`);
    f32 = await openContract(A, `1 Scope F32 ${suffix}`);
    fin = f32;
    await db
      .update(transactions)
      .set({
        contractDate: null,
        settlementCompletedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        closedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, f32.transactionId));
    await db.insert(transactionConditions).values({
      transactionId: f32.transactionId,
      description: "Building and pest inspection",
      status: "Pending",
    });
    const [request] = await db
      .insert(financialPaymentRequests)
      .values({
        brokerageId: A.brokerageId,
        propertyId: fin.propertyId,
        transactionId: fin.transactionId,
        amountCents: 150000,
        currency: "AUD",
        idempotencyKey: `scope-exit-fin05-${suffix}`,
      })
      .returning();
    await db.insert(financialReconciliations).values({
      brokerageId: A.brokerageId,
      recordType: "financial_payment_request",
      recordId: String(request!.id),
      status: "VARIANCE",
      expectedAmountCents: 150000,
      reportedAmountCents: 100000,
      source: "scope-exit-test",
    });
  });

  after(async () => {
    const ids = [A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number");
    await cleanupBrokerages(ids);
    if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  test("before closure, repeated scans keep one open row and do not resolve a still-true condition", async () => {
    await scan([A.brokerageId, B.brokerageId]);
    await scan([A.brokerageId, B.brokerageId]);

    for (const fixture of [d15A, d15Clear, d15B]) {
      const rows = await rowsFor(fixture.brokerageId, D15, fixture.transactionId);
      assert.equal(rows.length, 1, `expected one open D15 for transaction ${fixture.transactionId}`);
      assert.ok(["OPEN", "REOPENED"].includes(rows[0]!.status));
      assert.equal(rows[0]!.brokerageId, fixture.brokerageId);
      assert.equal(resolvedCount(await transitionsFor(rows[0]!.id)), 0);
    }

    const aml = await rowsFor(A.brokerageId, E23, e23.transactionId);
    if (aml.length !== 1) {
      const [txn] = await db.select().from(transactions).where(eq(transactions.id, e23.transactionId));
      assert.fail(`expected one E23 row, found ${aml.length}; contractDate=${txn?.contractDate?.toISOString() ?? "null"} settlementDate=${txn?.settlementDate?.toISOString() ?? "null"} closedAt=${txn?.closedAt?.toISOString() ?? "null"} buyers=${JSON.stringify(txn?.buyerPartyIds)}`);
    }
    assert.equal(aml[0]!.status, "OPEN");

    const closure = await rowsFor(A.brokerageId, F32, f32.transactionId);
    assert.equal(closure.length, 1, "expected F32 to open while settlement is complete, the transaction is open, and a condition is pending");
    assert.equal(closure[0]!.status, "OPEN");

    const financial = await rowsFor(A.brokerageId, FIN05, fin.transactionId);
    assert.equal(financial.length, 1, "expected FIN05 to open on the unresolved variance");
    assert.equal(financial[0]!.status, "OPEN");
    assert.equal(financial[0]!.brokerageId, A.brokerageId);
  });

  test("an in-scope clear records CONDITION_SATISFIED and a repeat scan does not duplicate it", async () => {
    const [before] = await rowsFor(A.brokerageId, D15, d15Clear.transactionId);
    assert.ok(before);
    await db
      .update(transactions)
      .set({
        legalRepresentatives: {
          sellerSolicitorPartyId: d15Clear.sellerPartyId,
          buyerSolicitorPartyId: d15Clear.sellerPartyId,
        },
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, d15Clear.transactionId));

    await scan([A.brokerageId]);
    const resolved = await rowsFor(A.brokerageId, D15, d15Clear.transactionId);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]!.id, before!.id);
    assert.equal(resolved[0]!.status, "RESOLVED");
    assert.equal(resolved[0]!.resolutionMethod, "AUTO");
    assert.equal(resolved[0]!.resolvedByUserId, null);
    assert.equal(resolved[0]!.brokerageId, A.brokerageId);
    assert.equal(resolved[0]!.ownerType, before!.ownerType);
    assert.equal(resolved[0]!.ownerUserId, before!.ownerUserId);
    const evidence = evidenceOf(resolved[0]!);
    assert.equal(evidence.kind, "CONDITION_SATISFIED");
    assert.notEqual(evidence.kind, "NO_LONGER_APPLICABLE");
    assert.equal(evidence.ruleCode, D15);
    assert.equal(evidence.ruleVersion, 1);
    assert.equal(evidence.record.scope, "IN_SCOPE");
    assert.equal(evidence.record.brokerageId, A.brokerageId);
    assert.equal(evidence.record.transactionId, d15Clear.transactionId);
    assert.equal(evidence.record.closedAt, null);
    const transitions = await transitionsFor(resolved[0]!.id);
    assert.equal(transitions.filter((row) => row.transitionType === "OPENED").length, 1);
    assert.equal(resolvedCount(transitions), 1);
    assert.equal(transitions.find((row) => row.transitionType === "RESOLVED")?.actorType, "SYSTEM");
    assert.equal(await autoResolveAudits(resolved[0]!.id), 1);

    await scan([A.brokerageId]);
    const again = await rowsFor(A.brokerageId, D15, d15Clear.transactionId);
    assert.equal(again.length, 1);
    assert.equal(again[0]!.id, before!.id);
    assert.equal(again[0]!.status, "RESOLVED");
    assert.equal(resolvedCount(await transitionsFor(again[0]!.id)), 1);
    assert.equal(await autoResolveAudits(again[0]!.id), 1);
  });

  test("after closure, ordinary rules are NO_LONGER_APPLICABLE and pinned rules stay open, owned, and visible; a repeat scan is idempotent and tenant-isolated", async () => {
    const d15Before = (await rowsFor(A.brokerageId, D15, d15A.transactionId))[0]!;
    const e23Before = (await rowsFor(A.brokerageId, E23, e23.transactionId))[0]!;
    const f32Before = (await rowsFor(A.brokerageId, F32, f32.transactionId))[0]!;
    const finBefore = (await rowsFor(A.brokerageId, FIN05, fin.transactionId))[0]!;
    const tenantBefore = (await rowsFor(B.brokerageId, D15, d15B.transactionId))[0]!;
    assert.ok(["OPEN", "REOPENED"].includes(d15Before.status));
    assert.equal(tenantBefore.status, "OPEN");

    const actor = { id: A.admin.user.id, role: A.admin.user.role };
    await reassignOwner(e23Before.id, A.brokerageId, actor, "UNASSIGNED_QUEUE", null, "Keep Pit Crew visibility across close.");

    const closedAt = new Date();
    for (const transactionId of [d15A.transactionId, f32.transactionId]) {
      await db
        .update(transactions)
        .set({ closedAt, status: "Closed", updatedAt: new Date() })
        .where(eq(transactions.id, transactionId));
    }
    const [closedTxn] = await db.select({ closedAt: transactions.closedAt }).from(transactions).where(eq(transactions.id, d15A.transactionId));

    await scan([A.brokerageId]);

    const d15After = await rowsFor(A.brokerageId, D15, d15A.transactionId);
    assert.equal(d15After.length, 1, "scope exit must not insert a second D15 row");
    assert.equal(d15After[0]!.id, d15Before.id, "the original row is kept");
    assert.equal(d15After[0]!.status, "RESOLVED");
    assert.equal(d15After[0]!.resolutionMethod, "AUTO");
    assert.equal(d15After[0]!.resolvedByUserId, null);
    assert.equal(d15After[0]!.brokerageId, A.brokerageId);
    assert.equal(d15After[0]!.ownerType, d15Before.ownerType);
    assert.equal(d15After[0]!.ownerUserId, d15Before.ownerUserId);
    const d15Evidence = evidenceOf(d15After[0]!);
    assert.equal(d15Evidence.kind, "NO_LONGER_APPLICABLE");
    assert.notEqual(d15Evidence.kind, "CONDITION_SATISFIED");
    assert.equal(d15Evidence.ruleCode, D15);
    assert.equal(d15Evidence.ruleVersion, 1);
    assert.equal(d15Evidence.record.scope, "TRANSACTION_CLOSED");
    assert.equal(d15Evidence.record.brokerageId, A.brokerageId);
    assert.equal(d15Evidence.record.propertyId, d15A.propertyId);
    assert.equal(d15Evidence.record.transactionId, d15A.transactionId);
    assert.equal(d15Evidence.record.closedAt, closedTxn!.closedAt!.toISOString());
    assert.equal(d15Evidence.record.dedupKey, d15Before.dedupKey);
    const d15Transitions = await transitionsFor(d15After[0]!.id);
    assert.equal(d15Transitions.filter((row) => row.transitionType === "OPENED").length, 1);
    assert.equal(resolvedCount(d15Transitions), 1);
    const resolvedTransition = d15Transitions.find((row) => row.transitionType === "RESOLVED");
    assert.equal(resolvedTransition?.actorType, "SYSTEM");
    assert.equal(resolvedTransition?.actorUserId, null);
    assert.equal(resolvedTransition?.brokerageId, A.brokerageId);
    assert.equal(await autoResolveAudits(d15After[0]!.id), 1);

    const e23After = (await rowsFor(A.brokerageId, E23, e23.transactionId))[0]!;
    assert.equal(e23After.id, e23Before.id);
    assert.equal(e23After.status, "OPEN");
    assert.equal(e23After.ownerType, "UNASSIGNED_QUEUE");
    assert.equal(e23After.ownerUserId, null);
    assert.equal(e23After.brokerageId, A.brokerageId);
    assert.equal(e23After.resolutionEvidence, null);
    assert.equal(resolvedCount(await transitionsFor(e23After.id)), 0);
    assert.ok((await transitionsFor(e23After.id)).some((row) => row.transitionType === "OWNER_ASSIGNED"));

    const f32After = (await rowsFor(A.brokerageId, F32, f32.transactionId))[0]!;
    assert.equal(f32After.id, f32Before.id);
    assert.equal(f32After.status, "OPEN");
    assert.equal(f32After.ownerType, f32Before.ownerType);
    assert.equal(f32After.ownerUserId, f32Before.ownerUserId);
    assert.equal(f32After.brokerageId, A.brokerageId);
    assert.equal(resolvedCount(await transitionsFor(f32After.id)), 0);

    const finAfter = (await rowsFor(A.brokerageId, FIN05, fin.transactionId))[0]!;
    assert.equal(finAfter.id, finBefore.id);
    assert.equal(finAfter.status, "OPEN");
    assert.equal(finAfter.ownerType, finBefore.ownerType);
    assert.equal(finAfter.ownerUserId, finBefore.ownerUserId);
    assert.equal(finAfter.brokerageId, A.brokerageId);
    assert.equal(resolvedCount(await transitionsFor(finAfter.id)), 0);

    const openPage = await listBrokerageExceptions(A.brokerageId, true, null, {
      status: ["OPEN", "REOPENED", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_EXTERNAL"],
      limit: 500,
      offset: 0,
    });
    const openIds = new Set(openPage.exceptions.map((row) => row.id));
    assert.equal(openIds.has(d15After[0]!.id), false);
    assert.equal(openIds.has(e23After.id), true);
    assert.equal(openIds.has(f32After.id), true);
    assert.equal(openIds.has(finAfter.id), true);

    const workspace = await getPitCrewWorkspace(A.brokerageId, A.admin.user.id);
    const pitCrewIds = new Set(workspace.unassignedWork.map((item) => item.sourceRecordId));
    assert.equal(pitCrewIds.has(e23After.id), true, "an unresolved AML exception stays visible to Pit Crew after close");
    assert.equal(pitCrewIds.has(d15After[0]!.id), false);

    const tenantAfter = (await rowsFor(B.brokerageId, D15, d15B.transactionId))[0]!;
    assert.equal(tenantAfter.id, tenantBefore.id);
    assert.equal(tenantAfter.status, "OPEN");
    assert.equal(tenantAfter.brokerageId, B.brokerageId);
    assert.equal(tenantAfter.ownerUserId, tenantBefore.ownerUserId);
    assert.equal(resolvedCount(await transitionsFor(tenantAfter.id)), 0);

    await scan([A.brokerageId]);

    const d15Repeat = await rowsFor(A.brokerageId, D15, d15A.transactionId);
    assert.equal(d15Repeat.length, 1);
    assert.equal(d15Repeat[0]!.status, "RESOLVED");
    assert.equal(resolvedCount(await transitionsFor(d15Repeat[0]!.id)), 1);
    assert.equal(await autoResolveAudits(d15Repeat[0]!.id), 1);
    for (const [ruleId, fixture, id] of [
      [E23, e23, e23After.id],
      [F32, f32, f32After.id],
      [FIN05, fin, finAfter.id],
    ] as const) {
      const rows = await rowsFor(A.brokerageId, ruleId, fixture.transactionId);
      assert.equal(rows.length, 1, ruleId);
      assert.equal(rows[0]!.id, id);
      assert.equal(rows[0]!.status, "OPEN");
      assert.equal(resolvedCount(await transitionsFor(rows[0]!.id)), 0);
    }
    const tenantRepeat = (await rowsFor(B.brokerageId, D15, d15B.transactionId))[0]!;
    assert.equal(tenantRepeat.status, "OPEN");
    assert.equal(tenantRepeat.id, tenantBefore.id);
  });

  test("a stage exit is NO_LONGER_APPLICABLE for an ordinary rule and stays open for financial, compliance, and security rules", async () => {
    const propertyId = await createProperty(A.agent.cookie, `1 Scope Stage ${suffix}`);
    await db.update(properties).set({ workflowStage: "Listed" }).where(eq(properties.id, propertyId));

    const ordinaryId = `TEST_STAGE_EXIT_${suffix}`;
    const financialId = `TEST_STAGE_FIN_${suffix}`;
    const complianceId = `TEST_STAGE_COMPLIANCE_${suffix}`;
    const securityId = `TEST_STAGE_SECURITY_${suffix}`;
    const rules: RiskRule[] = [
      syntheticRule(ordinaryId, "LISTING", "NO_LONGER_APPLICABLE"),
      syntheticRule(financialId, "FINANCIAL", "KEEP_OPEN"),
      syntheticRule(complianceId, "COMPLIANCE", "KEEP_OPEN"),
      syntheticRule(securityId, "SECURITY", "KEEP_OPEN"),
    ];
    RISK_RULES.push(...rules);
    try {
      const ordinary = await createOrUpdateException(
        findingFor(ordinaryId, A.brokerageId, propertyId, null),
        A.brokerageId,
        propertyId,
        null,
        newCorrelationId(),
        null,
      );
      const financial = await createOrUpdateException(
        findingFor(financialId, A.brokerageId, propertyId, fin.transactionId, "FINANCIAL"),
        A.brokerageId,
        propertyId,
        fin.transactionId,
        newCorrelationId(),
        null,
      );
      const compliance = await createOrUpdateException(
        findingFor(complianceId, A.brokerageId, propertyId, null, "COMPLIANCE"),
        A.brokerageId,
        propertyId,
        null,
        newCorrelationId(),
        null,
      );
      const security = await createOrUpdateException(
        findingFor(securityId, A.brokerageId, propertyId, null, "SECURITY"),
        A.brokerageId,
        propertyId,
        null,
        newCorrelationId(),
        null,
      );
      await db.update(properties).set({ workflowStage: "Under Contract" }).where(eq(properties.id, propertyId));

      await scan([A.brokerageId]);
      await scan([A.brokerageId]);

      const ordinaryRow = await fetchException(ordinary.exception.id);
      assert.equal(ordinaryRow.status, "RESOLVED");
      const ordinaryEvidence = evidenceOf(ordinaryRow);
      assert.equal(ordinaryEvidence.kind, "NO_LONGER_APPLICABLE");
      assert.notEqual(ordinaryEvidence.kind, "CONDITION_SATISFIED");
      assert.equal(ordinaryEvidence.ruleCode, ordinaryId);
      assert.equal(ordinaryEvidence.ruleVersion, 2);
      assert.equal(ordinaryEvidence.record.scope, "STAGE_EXIT");
      assert.equal(ordinaryEvidence.record.workflowStage, "Under Contract");
      assert.equal(ordinaryEvidence.record.brokerageId, A.brokerageId);
      assert.equal(resolvedCount(await transitionsFor(ordinaryRow.id)), 1);
      assert.equal((await transitionsFor(ordinaryRow.id)).find((row) => row.transitionType === "RESOLVED")?.actorType, "SYSTEM");

      const financialRow = await fetchException(financial.exception.id);
      assert.equal(financialRow.status, "OPEN");
      assert.equal(financialRow.ownerType, financial.exception.ownerType);
      assert.equal(financialRow.ownerUserId, financial.exception.ownerUserId);
      assert.equal(financialRow.brokerageId, A.brokerageId);
      assert.equal(resolvedCount(await transitionsFor(financialRow.id)), 0);

      const complianceRow = await fetchException(compliance.exception.id);
      assert.equal(complianceRow.status, "OPEN");
      assert.equal(complianceRow.brokerageId, A.brokerageId);
      assert.equal(resolvedCount(await transitionsFor(complianceRow.id)), 0);

      const securityRow = await fetchException(security.exception.id);
      assert.equal(securityRow.status, "OPEN");
      assert.equal(securityRow.brokerageId, A.brokerageId);
      assert.equal(securityRow.ownerUserId, security.exception.ownerUserId);
      assert.equal(resolvedCount(await transitionsFor(securityRow.id)), 0);
    } finally {
      for (const rule of rules) {
        const index = RISK_RULES.indexOf(rule);
        if (index >= 0) RISK_RULES.splice(index, 1);
      }
    }
  });

  async function scan(brokerageIds: number[]): Promise<ScanSummary> {
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = await runScheduledScan("MANUAL", { brokerageIds });
      if (result.ok) return result.summary;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("runScheduledScan did not succeed after retries");
  }

  async function createProperty(cookie: string, address: string): Promise<number> {
    const res = await fetch(`${baseUrl}/api/properties`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
    });
    if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { property: { id: number } };
    return body.property.id;
  }
});

interface Fixture {
  brokerageId: number;
  propertyId: number;
  transactionId: number;
  sellerPartyId: number;
}

async function openContract(
  tenant: { agent: DevLoginResult; brokerageId: number },
  address: string,
): Promise<Fixture> {
  const created = await createTransactionFromListedProperty(baseUrlHolder.url, tenant.agent.cookie, { address });
  await db
    .update(transactions)
    .set({ contractDate: new Date("2026-06-01T00:00:00.000Z"), legalRepresentatives: null, closedAt: null, updatedAt: new Date() })
    .where(eq(transactions.id, created.transactionId));
  return {
    brokerageId: tenant.brokerageId,
    propertyId: created.propertyId,
    transactionId: created.transactionId,
    sellerPartyId: created.sellerPartyId,
  };
}

// openContract is called from before(), which runs after baseUrl is assigned.
// A holder avoids passing baseUrl through every helper while the server is starting.
const baseUrlHolder: { url: string } = { url: "" };

async function rowsFor(brokerageId: number, ruleId: string, transactionId: number): Promise<RiskException[]> {
  return db
    .select()
    .from(riskExceptions)
    .where(and(eq(riskExceptions.brokerageId, brokerageId), eq(riskExceptions.ruleId, ruleId), eq(riskExceptions.transactionId, transactionId)));
}

async function transitionsFor(exceptionId: string) {
  return db.select().from(riskExceptionTransitions).where(eq(riskExceptionTransitions.exceptionId, exceptionId));
}

function resolvedCount(rows: Array<{ transitionType: string }>): number {
  return rows.filter((row) => row.transitionType === "RESOLVED").length;
}

async function autoResolveAudits(exceptionId: string): Promise<number> {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.recordType, "risk_exception"), eq(auditLogs.recordId, exceptionId), eq(auditLogs.action, "risk_exception_auto_resolved")));
  assert.ok(rows.every((row) => row.userId == null));
  return rows.length;
}

async function fetchException(id: string): Promise<RiskException> {
  const [row] = await db.select().from(riskExceptions).where(eq(riskExceptions.id, id));
  if (!row) throw new Error(`exception ${id} not found`);
  return row;
}

function evidenceOf(row: RiskException): {
  kind: string;
  ruleCode: string;
  ruleVersion: number;
  record: {
    scope: string;
    brokerageId: number;
    propertyId: number;
    transactionId: number | null;
    closedAt: string | null;
    workflowStage: string | null;
    dedupKey: string;
  };
} {
  return row.resolutionEvidence as never;
}

function syntheticRule(ruleId: string, category: string, policy: "KEEP_OPEN" | "NO_LONGER_APPLICABLE"): RiskRule {
  return {
    ruleId,
    version: 2,
    category: category as RiskRule["category"],
    scopeExitPolicy: policy,
    stageRange: ["Listed"],
    name: ruleId,
    description: "Synthetic scope-exit rule",
    triggerEventTypes: [],
    async scanBrokerage() {
      return [];
    },
  };
}

function findingFor(
  ruleId: string,
  brokerageId: number,
  propertyId: number,
  transactionId: number | null,
  category: string = "LISTING",
): RiskFinding {
  return {
    ruleId,
    ruleVersion: 2,
    category: category as RiskFinding["category"],
    severity: "ATTENTION",
    title: ruleId,
    problemDescription: "n/a",
    businessImpact: "n/a",
    detectedCause: "n/a",
    ownerType: "TRANSACTION_OWNER",
    ownerUserId: null,
    propertyId,
    transactionId,
    dueAt: null,
    escalatesAt: null,
    recommendedAction: "n/a",
    resolutionRequirements: "n/a",
    dismissible: false,
    sourceRecordType: "property",
    sourceRecordId: String(propertyId),
    dedupKey: `${ruleId}:${brokerageId}:${propertyId}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: category === "FINANCIAL",
  };
}
