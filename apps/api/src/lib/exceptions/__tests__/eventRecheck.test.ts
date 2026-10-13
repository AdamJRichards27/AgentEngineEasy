// Event-triggered record rechecks (PR C).
//
// A legal-representative write, a transaction or settlement event, a
// campaign/marketing event, and transaction closure recheck only the
// relevant rules for that record. Repeated events do not add a second
// exception or a second SYSTEM audit. The scheduled scan remains the
// fallback for a sibling the event did not touch. Closing the transaction
// records NO_LONGER_APPLICABLE for an ordinary rule and leaves financial,
// AML, compliance, and security rows open. B08 is not part of this path.
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
  launchPlans,
  properties,
  riskExceptions,
  riskExceptionTransitions,
  transactions,
  type RiskException,
} from "@aee/db";
import { publishDomainEvent, newCorrelationId, type DomainEvent } from "@aee/events";
import { runScheduledScan, recheckExceptionsForRecord, immediateRecheckKindForEvent, type ScanSummary } from "../engine.js";
import { registerExceptionEngine } from "../bootstrap.js";
import { createOrUpdateException, RiskExceptionError } from "../model.js";
import { listBrokerageExceptions } from "../queries.js";
import { RISK_RULES, type RiskRule } from "../registry.js";
import type { RiskFinding } from "../types.js";
import { recordLegalRepresentatives } from "../../transactions.js";
import { createBrokerageWithUsers, createTransactionFromListedProperty, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const D15 = "D15_CONTRACT_MISSING_LEGAL_REPRESENTATIVES";
const E23 = "E23_24_BUYER_AML_INCOMPLETE";
const E27 = "E27_BUYER_AML_APPROACHING_SETTLEMENT";
const FIN05 = "FIN05_RECONCILIATION_VARIANCE_UNRESOLVED";
const L01 = "L01_LAUNCH_PLAN_TARGET_DATE_NOT_SET";
const B08 = "B08_LISTING_LIVE_MISSING_CAMPAIGN_INFO";

test("LISTING_LIVE is not an immediate recheck, and B08 is unchanged", () => {
  assert.equal(immediateRecheckKindForEvent("LISTING_LIVE"), null);
  assert.equal(immediateRecheckKindForEvent("CONTRACT_SIGNED"), "TRANSACTION_LIFECYCLE");
  assert.equal(immediateRecheckKindForEvent("SETTLEMENT_SCHEDULED"), "TRANSACTION_LIFECYCLE");
  assert.equal(immediateRecheckKindForEvent("LAUNCH_TARGET_DATE_CHANGED"), "CAMPAIGN_MARKETING");
  assert.equal(immediateRecheckKindForEvent("MARKETING_INVOICE_RECORDED"), "CAMPAIGN_MARKETING");
  assert.equal(immediateRecheckKindForEvent("TRANSACTION_CLOSED"), "TRANSACTION_CLOSURE");
  const b08 = RISK_RULES.find((rule) => rule.ruleId === B08);
  assert.ok(b08);
  assert.deepEqual(b08.triggerEventTypes, ["LISTING_LIVE"]);
  assert.equal(b08.stageRange, undefined);
  assert.equal(b08.scopeExitPolicy, undefined);
});

describe("event-triggered exception rechecks", { concurrency: false, timeout: 300_000 }, () => {
  let server: Server;
  let baseUrl: string;
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
  let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
  let affected: Fixture;
  let sibling: Fixture;
  let otherTenant: Fixture;
  let campaignA: number;
  let campaignB: number;

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

    A = await createBrokerageWithUsers(baseUrl, `Event Recheck A ${suffix}`);
    B = await createBrokerageWithUsers(baseUrl, `Event Recheck B ${suffix}`);
    affected = await openContract(A, `1 Event Recheck A ${suffix}`);
    sibling = await openContract(A, `1 Event Recheck Sibling ${suffix}`);
    otherTenant = await openContract(B, `1 Event Recheck B ${suffix}`);
    campaignA = await createBareProperty(A.agent.cookie, `1 Event Campaign A ${suffix}`);
    campaignB = await createBareProperty(A.agent.cookie, `1 Event Campaign B ${suffix}`);

    const [request] = await db
      .insert(financialPaymentRequests)
      .values({
        brokerageId: A.brokerageId,
        propertyId: affected.propertyId,
        transactionId: affected.transactionId,
        amountCents: 150000,
        currency: "AUD",
        idempotencyKey: `event-recheck-fin05-${suffix}`,
      })
      .returning();
    await db.insert(financialReconciliations).values({
      brokerageId: A.brokerageId,
      recordType: "financial_payment_request",
      recordId: String(request!.id),
      status: "VARIANCE",
      expectedAmountCents: 150000,
      reportedAmountCents: 100000,
      source: "event-recheck-test",
    });

    // Register after the fixtures exist so their own offer events do not
    // pre-seed exceptions. The sweep is the fallback, not a second writer
    // during setup.
    registerExceptionEngine({ startScheduler: false });
  });

  after(async () => {
    const ids = [A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number");
    await cleanupBrokerages(ids);
    if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  test("a contract event rechecks only the affected transaction, and a repeat does not duplicate the row or the audit", async () => {
    await publish({ eventType: "CONTRACT_SIGNED", brokerageId: A.brokerageId, propertyId: affected.propertyId, transactionId: affected.transactionId, actorId: A.agent.user.id });
    await publish({ eventType: "CONTRACT_SIGNED", brokerageId: A.brokerageId, propertyId: affected.propertyId, transactionId: affected.transactionId, actorId: A.agent.user.id });

    const rows = await rowsFor(A.brokerageId, D15, affected.transactionId);
    assert.equal(rows.length, 1);
    assert.ok(["OPEN", "REOPENED"].includes(rows[0]!.status));
    assert.equal(rows[0]!.brokerageId, A.brokerageId);
    assert.equal(await audits(rows[0]!.id, "risk_exception_opened"), 1);
    assert.equal(resolvedCount(await transitionsFor(rows[0]!.id)), 0);
    assert.equal((await rowsFor(A.brokerageId, D15, sibling.transactionId)).length, 0);
    assert.equal((await rowsFor(B.brokerageId, D15, otherTenant.transactionId)).length, 0);

    const aml = await rowsFor(A.brokerageId, E23, affected.transactionId);
    assert.equal(aml.length, 1, "buyer AML is part of the transaction-event rule set");
    assert.equal(await audits(aml[0]!.id, "risk_exception_opened"), 1);
  });

  test("the scheduled scan is still the fallback for a record the event did not touch", async () => {
    await scan([A.brokerageId, B.brokerageId]);
    const siblingRows = await rowsFor(A.brokerageId, D15, sibling.transactionId);
    assert.equal(siblingRows.length, 1);
    assert.equal(siblingRows[0]!.status, "OPEN");
    const affectedRows = await rowsFor(A.brokerageId, D15, affected.transactionId);
    assert.equal(affectedRows.length, 1, "the fallback sweep must not insert a second D15 for the record the event already opened");
    const other = await rowsFor(B.brokerageId, D15, otherTenant.transactionId);
    assert.equal(other.length, 1);
    assert.equal(other[0]!.brokerageId, B.brokerageId);
    const financial = await rowsFor(A.brokerageId, FIN05, affected.transactionId);
    assert.equal(financial.length, 1);
    assert.equal(financial[0]!.requiresFinancialEntitlement, true);
  });

  test("recording legal representatives resolves D15 as CONDITION_SATISFIED, and repeating the write does not duplicate history", async () => {
    const [before] = await rowsFor(A.brokerageId, D15, sibling.transactionId);
    assert.ok(before);
    await recordLegalRepresentatives({
      transactionId: sibling.transactionId,
      userId: A.agent.user.id,
      brokerageId: A.brokerageId,
      sellerSolicitorPartyId: sibling.sellerPartyId,
      buyerSolicitorPartyId: sibling.sellerPartyId,
    });
    await recordLegalRepresentatives({
      transactionId: sibling.transactionId,
      userId: A.agent.user.id,
      brokerageId: A.brokerageId,
      sellerSolicitorPartyId: sibling.sellerPartyId,
      buyerSolicitorPartyId: sibling.sellerPartyId,
    });

    const resolved = await rowsFor(A.brokerageId, D15, sibling.transactionId);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]!.id, before!.id);
    assert.equal(resolved[0]!.status, "RESOLVED");
    assert.equal(resolved[0]!.resolutionMethod, "AUTO");
    assert.equal(resolved[0]!.resolvedByUserId, null);
    assert.equal(resolved[0]!.brokerageId, A.brokerageId);
    assert.equal(resolved[0]!.ownerUserId, before!.ownerUserId);
    const evidence = evidenceOf(resolved[0]!);
    assert.equal(evidence.kind, "CONDITION_SATISFIED");
    assert.equal(evidence.ruleCode, D15);
    assert.equal(evidence.ruleVersion, 1);
    assert.equal(evidence.record.scope, "IN_SCOPE");
    assert.equal(evidence.record.transactionId, sibling.transactionId);
    assert.equal(evidence.record.closedAt, null);
    assert.equal(resolvedCount(await transitionsFor(resolved[0]!.id)), 1);
    assert.equal((await transitionsFor(resolved[0]!.id)).find((row) => row.transitionType === "RESOLVED")?.actorType, "SYSTEM");
    assert.equal(await audits(resolved[0]!.id, "risk_exception_auto_resolved"), 1);

    const stillAffected = await rowsFor(A.brokerageId, D15, affected.transactionId);
    assert.equal(stillAffected.length, 1);
    assert.equal(stillAffected[0]!.status, "OPEN");

    await recordLegalRepresentatives({
      transactionId: sibling.transactionId,
      userId: A.agent.user.id,
      brokerageId: A.brokerageId,
      sellerSolicitorPartyId: null,
      buyerSolicitorPartyId: null,
    });
    const reopened = await rowsFor(A.brokerageId, D15, sibling.transactionId);
    assert.equal(reopened.length, 1);
    assert.equal(reopened[0]!.id, before!.id);
    assert.equal(reopened[0]!.status, "REOPENED");
    assert.equal(await audits(reopened[0]!.id, "risk_exception_opened"), 1);
    assert.equal(await audits(reopened[0]!.id, "risk_exception_reopened"), 1);
  });

  test("a settlement milestone opens the approaching-AML exception immediately", async () => {
    assert.equal((await rowsFor(A.brokerageId, E27, affected.transactionId)).length, 0);
    const settlementDate = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    await db.update(transactions).set({ settlementDate, updatedAt: new Date() }).where(eq(transactions.id, affected.transactionId));
    await publish({
      eventType: "SETTLEMENT_SCHEDULED",
      brokerageId: A.brokerageId,
      propertyId: affected.propertyId,
      transactionId: affected.transactionId,
      actorId: A.agent.user.id,
    });
    await publish({
      eventType: "SETTLEMENT_SCHEDULED",
      brokerageId: A.brokerageId,
      propertyId: affected.propertyId,
      transactionId: affected.transactionId,
      actorId: A.agent.user.id,
    });

    const approaching = await rowsFor(A.brokerageId, E27, affected.transactionId);
    assert.equal(approaching.length, 1);
    assert.equal(approaching[0]!.status, "OPEN");
    assert.equal(approaching[0]!.brokerageId, A.brokerageId);
    assert.equal(await audits(approaching[0]!.id, "risk_exception_opened"), 1);

    const early = await rowsFor(A.brokerageId, E23, affected.transactionId);
    assert.equal(early.length, 1);
    assert.equal(early[0]!.status, "RESOLVED");
    assert.equal(evidenceOf(early[0]!).kind, "CONDITION_SATISFIED");
    assert.equal(await audits(early[0]!.id, "risk_exception_auto_resolved"), 1);
    assert.equal((await rowsFor(A.brokerageId, E27, sibling.transactionId)).length, 0);
  });

  test("a campaign change rechecks that property only, and does not clear B08", async () => {
    const createdAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await db.insert(launchPlans).values([
      {
        brokerageId: A.brokerageId,
        propertyId: campaignA,
        templateType: "CUSTOM",
        status: "PLANNING",
        createdBy: A.agent.user.id,
        createdAt,
        updatedAt: createdAt,
      },
      {
        brokerageId: A.brokerageId,
        propertyId: campaignB,
        templateType: "CUSTOM",
        status: "PLANNING",
        createdBy: A.agent.user.id,
        createdAt,
        updatedAt: createdAt,
      },
    ]);
    await publish({ eventType: "LAUNCH_PLAN_CREATED", brokerageId: A.brokerageId, propertyId: campaignA, transactionId: null, actorId: A.agent.user.id });
    await publish({ eventType: "LAUNCH_PLAN_CREATED", brokerageId: A.brokerageId, propertyId: campaignA, transactionId: null, actorId: A.agent.user.id });
    const opened = await propertyRows(A.brokerageId, L01, campaignA);
    assert.equal(opened.length, 1);
    assert.equal(opened[0]!.status, "OPEN");
    assert.equal(await audits(opened[0]!.id, "risk_exception_opened"), 1);
    assert.equal((await propertyRows(A.brokerageId, L01, campaignB)).length, 0);

    await publish({ eventType: "LAUNCH_PLAN_CREATED", brokerageId: A.brokerageId, propertyId: campaignB, transactionId: null, actorId: A.agent.user.id });
    const farTarget = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.update(launchPlans).set({ targetLaunchDate: farTarget, updatedAt: new Date() }).where(eq(launchPlans.propertyId, campaignA));
    await publish({ eventType: "LAUNCH_TARGET_DATE_CHANGED", brokerageId: A.brokerageId, propertyId: campaignA, transactionId: null, actorId: A.agent.user.id });
    await publish({ eventType: "LAUNCH_TARGET_DATE_CHANGED", brokerageId: A.brokerageId, propertyId: campaignA, transactionId: null, actorId: A.agent.user.id });

    const cleared = await propertyRows(A.brokerageId, L01, campaignA);
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0]!.id, opened[0]!.id);
    assert.equal(cleared[0]!.status, "RESOLVED");
    assert.equal(evidenceOf(cleared[0]!).kind, "CONDITION_SATISFIED");
    assert.equal(evidenceOf(cleared[0]!).ruleCode, L01);
    assert.equal(await audits(cleared[0]!.id, "risk_exception_auto_resolved"), 1);
    const untouched = await propertyRows(A.brokerageId, L01, campaignB);
    assert.equal(untouched.length, 1);
    assert.equal(untouched[0]!.status, "OPEN");

    const [b08Before] = await db
      .select()
      .from(riskExceptions)
      .where(and(eq(riskExceptions.brokerageId, A.brokerageId), eq(riskExceptions.propertyId, affected.propertyId), eq(riskExceptions.ruleId, B08)));
    assert.ok(b08Before, "the fallback sweep opens B08 when campaign fields are missing");
    await db
      .update(properties)
      .set({
        salesMethod: "Private Treaty",
        priceDisplay: "Offers over",
        campaignStartDate: new Date("2026-11-01T00:00:00.000Z"),
        campaignEndDate: new Date("2026-12-01T00:00:00.000Z"),
        updatedAt: new Date(),
      })
      .where(eq(properties.id, affected.propertyId));
    await publish({ eventType: "CAMPAIGN_ITEM_ADDED", brokerageId: A.brokerageId, propertyId: affected.propertyId, transactionId: affected.transactionId, actorId: A.agent.user.id });
    const b08After = await fetchException(b08Before.id);
    assert.equal(b08After.status, b08Before.status);
    assert.equal(b08After.resolutionEvidence, null);
    assert.equal(await audits(b08After.id, "risk_exception_auto_resolved"), 0);
  });

  test("closure resolves an ordinary rule as NO_LONGER_APPLICABLE and keeps financial, AML, compliance, and security rows open", async () => {
    const d15Before = (await rowsFor(A.brokerageId, D15, affected.transactionId))[0]!;
    const amlBefore = (await rowsFor(A.brokerageId, E27, affected.transactionId))[0]!;
    const finBefore = (await rowsFor(A.brokerageId, FIN05, affected.transactionId))[0]!;
    const tenantBefore = (await rowsFor(B.brokerageId, D15, otherTenant.transactionId))[0]!;
    assert.equal(d15Before.status, "OPEN");
    assert.equal(amlBefore.status, "OPEN");
    assert.equal(finBefore.status, "OPEN");
    assert.equal(tenantBefore.status, "OPEN");

    await assert.rejects(
      () =>
        recheckExceptionsForRecord({
          brokerageId: B.brokerageId,
          propertyId: affected.propertyId,
          transactionId: affected.transactionId,
          kind: "TRANSACTION_CLOSURE",
        }),
      (err: unknown) => err instanceof RiskExceptionError && (err as RiskExceptionError).reason === "NOT_FOUND",
    );
    assert.equal((await fetchException(d15Before.id)).status, "OPEN");
    assert.equal((await fetchException(tenantBefore.id)).status, "OPEN");

    const complianceId = `TEST_EVENT_COMPLIANCE_${suffix}`;
    const securityId = `TEST_EVENT_SECURITY_${suffix}`;
    const rules: RiskRule[] = [syntheticRule(complianceId, "COMPLIANCE"), syntheticRule(securityId, "SECURITY")];
    RISK_RULES.push(...rules);
    try {
      const compliance = await createOrUpdateException(
        findingFor(complianceId, A.brokerageId, affected.propertyId, affected.transactionId, "COMPLIANCE"),
        A.brokerageId,
        affected.propertyId,
        affected.transactionId,
        newCorrelationId(),
        null,
      );
      const security = await createOrUpdateException(
        findingFor(securityId, A.brokerageId, affected.propertyId, affected.transactionId, "SECURITY"),
        A.brokerageId,
        affected.propertyId,
        affected.transactionId,
        newCorrelationId(),
        null,
      );

      const closedAt = new Date();
      await db.update(transactions).set({ status: "Closed", closedAt, updatedAt: new Date() }).where(eq(transactions.id, affected.transactionId));
      await db.update(properties).set({ workflowStage: "Closed", updatedAt: new Date() }).where(eq(properties.id, affected.propertyId));
      await publish({
        eventType: "TRANSACTION_CLOSED",
        brokerageId: A.brokerageId,
        propertyId: affected.propertyId,
        transactionId: affected.transactionId,
        actorId: A.agent.user.id,
      });
      await publish({
        eventType: "TRANSACTION_CLOSED",
        brokerageId: A.brokerageId,
        propertyId: affected.propertyId,
        transactionId: affected.transactionId,
        actorId: A.agent.user.id,
      });

      const d15After = await fetchException(d15Before.id);
      assert.equal(d15After.status, "RESOLVED");
      assert.equal(d15After.resolutionMethod, "AUTO");
      assert.equal(d15After.resolvedByUserId, null);
      assert.equal(d15After.brokerageId, A.brokerageId);
      assert.equal(d15After.ownerUserId, d15Before.ownerUserId);
      const d15Evidence = evidenceOf(d15After);
      assert.equal(d15Evidence.kind, "NO_LONGER_APPLICABLE");
      assert.notEqual(d15Evidence.kind, "CONDITION_SATISFIED");
      assert.equal(d15Evidence.ruleCode, D15);
      assert.equal(d15Evidence.record.scope, "TRANSACTION_CLOSED");
      assert.equal(d15Evidence.record.brokerageId, A.brokerageId);
      assert.equal(d15Evidence.record.transactionId, affected.transactionId);
      assert.equal(resolvedCount(await transitionsFor(d15After.id)), 1);
      assert.equal((await transitionsFor(d15After.id)).find((row) => row.transitionType === "RESOLVED")?.actorType, "SYSTEM");
      assert.equal(await audits(d15After.id, "risk_exception_auto_resolved"), 1);

      for (const row of [amlBefore, finBefore, compliance.exception, security.exception]) {
        const after = await fetchException(row.id);
        assert.equal(after.status, "OPEN", row.ruleId);
        assert.equal(after.brokerageId, A.brokerageId);
        assert.equal(after.ownerUserId, row.ownerUserId);
        assert.equal(after.resolutionEvidence, null);
        assert.equal(resolvedCount(await transitionsFor(after.id)), 0);
        assert.equal(await audits(after.id, "risk_exception_auto_resolved"), 0);
      }
      assert.equal((await fetchException(finBefore.id)).requiresFinancialEntitlement, true);

      const hidden = await listBrokerageExceptions(A.brokerageId, false, [affected.propertyId], {
        status: ["OPEN", "REOPENED", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_EXTERNAL"],
        limit: 100,
        offset: 0,
      });
      const hiddenIds = new Set(hidden.exceptions.map((row) => row.id));
      assert.equal(hiddenIds.has(finBefore.id), false);
      assert.equal(hiddenIds.has(amlBefore.id), true);

      const tenantAfter = await fetchException(tenantBefore.id);
      assert.equal(tenantAfter.status, "OPEN");
      assert.equal(tenantAfter.brokerageId, B.brokerageId);
      const siblingAfter = (await rowsFor(A.brokerageId, D15, sibling.transactionId))[0]!;
      assert.equal(siblingAfter.status, "REOPENED");
      assert.equal(siblingAfter.brokerageId, A.brokerageId);
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

  async function createBareProperty(cookie: string, address: string): Promise<number> {
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

async function openContract(tenant: { agent: DevLoginResult; brokerageId: number }, address: string): Promise<Fixture> {
  const created = await createTransactionFromListedProperty(baseUrlHolder.url, tenant.agent.cookie, { address });
  await db
    .update(transactions)
    .set({
      contractDate: new Date("2026-06-01T00:00:00.000Z"),
      settlementDate: null,
      legalRepresentatives: null,
      closedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, created.transactionId));
  return {
    brokerageId: tenant.brokerageId,
    propertyId: created.propertyId,
    transactionId: created.transactionId,
    sellerPartyId: created.sellerPartyId,
  };
}

const baseUrlHolder: { url: string } = { url: "" };

async function publish(input: {
  eventType: DomainEvent["eventType"];
  brokerageId: number;
  propertyId: number;
  transactionId: number | null;
  actorId: number;
}): Promise<void> {
  await publishDomainEvent({
    eventType: input.eventType,
    occurredAt: new Date(),
    propertyId: input.propertyId,
    transactionId: input.transactionId,
    partyId: null,
    brokerageId: input.brokerageId,
    agentId: input.actorId,
    actorType: "USER",
    actorId: input.actorId,
    source: "test:exception-event-recheck",
    correlationId: newCorrelationId(),
    causationId: null,
    idempotencyKey: `event-recheck:${randomUUID()}`,
    payload: {},
    metadata: {},
  });
}

async function rowsFor(brokerageId: number, ruleId: string, transactionId: number): Promise<RiskException[]> {
  return db
    .select()
    .from(riskExceptions)
    .where(and(eq(riskExceptions.brokerageId, brokerageId), eq(riskExceptions.ruleId, ruleId), eq(riskExceptions.transactionId, transactionId)));
}

async function propertyRows(brokerageId: number, ruleId: string, propertyId: number): Promise<RiskException[]> {
  return db
    .select()
    .from(riskExceptions)
    .where(and(eq(riskExceptions.brokerageId, brokerageId), eq(riskExceptions.ruleId, ruleId), eq(riskExceptions.propertyId, propertyId)));
}

async function transitionsFor(exceptionId: string) {
  return db.select().from(riskExceptionTransitions).where(eq(riskExceptionTransitions.exceptionId, exceptionId));
}

function resolvedCount(rows: Array<{ transitionType: string }>): number {
  return rows.filter((row) => row.transitionType === "RESOLVED").length;
}

async function audits(exceptionId: string, action: string): Promise<number> {
  const rows = await db
    .select({ id: auditLogs.id, userId: auditLogs.userId })
    .from(auditLogs)
    .where(and(eq(auditLogs.recordType, "risk_exception"), eq(auditLogs.recordId, exceptionId), eq(auditLogs.action, action)));
  if (action === "risk_exception_auto_resolved") assert.ok(rows.every((row) => row.userId == null));
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
  record: { scope: string; brokerageId: number; propertyId: number; transactionId: number | null; closedAt: string | null };
} {
  return row.resolutionEvidence as never;
}

function syntheticRule(ruleId: string, category: "COMPLIANCE" | "SECURITY"): RiskRule {
  return {
    ruleId,
    version: 1,
    category: category as RiskRule["category"],
    scopeExitPolicy: "KEEP_OPEN",
    name: ruleId,
    description: "Synthetic pinned rule for the closure recheck",
    triggerEventTypes: [],
    async scanBrokerage() {
      return [];
    },
  };
}

function findingFor(ruleId: string, brokerageId: number, propertyId: number, transactionId: number, category: "COMPLIANCE" | "SECURITY"): RiskFinding {
  return {
    ruleId,
    ruleVersion: 1,
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
    sourceRecordType: "transaction",
    sourceRecordId: String(transactionId),
    dedupKey: `${ruleId}:${brokerageId}:${transactionId}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
  };
}
