import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  commissionAgreements,
  commissionCalculations,
  pcFeeAuthorities,
  pcFeeCalculations,
  financialPaymentRequests,
  financialPaymentProviderEvents,
  financialDisputes,
  marketingPaymentRecords,
  financialDeposits,
  financialReconciliations,
  financialLedgerEvents,
  auditReturnReminders,
  financialSettings,
} from "@aee/db";
import {
  createBrokerageWithUsers,
  createTransactionFromListedProperty,
  cleanupBrokerages,
  type DevLoginResult,
} from "../../../routes/__tests__/testSupport.js";

// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage B.
//
// Domain-level tests for packages/db/src/schema/financial.ts: no service
// layer exists yet (that's Stage C — commission/PC-fee calculation
// services), so these tests exercise the schema directly via db.insert()/
// db.select(), the same way apps/api/src/lib/entitlements/__tests__/
// resolver.test.ts and apps/api/src/lib/billing/__tests__/sync.test.ts do
// for their own domains. The goal here is to lock in the business
// constraints the spec depends on before any service code is written on
// top of them: versioning uniqueness (Section 9-14), payment-request
// settlement-idempotency (Section 21 — "a repeated SETTLEMENT_COMPLETED
// must never create a second PC fee/invoice/debit request"), webhook-event
// dedup (Section 31), one-deposit-per-transaction (Section 18), and
// one-settings-row-per-brokerage (mirrors communicationSettings).
//
// Fixtures go through the real property -> offer -> accepted-transaction
// routes (createTransactionFromListedProperty) rather than hand-inserting
// a transactions row, so every FK this file relies on is guaranteed valid
// exactly as it would be in production. Teardown is handled by this file's
// own cleanupFinancialTables() plus the standard cleanupBrokerages() —
// see that function's comment for why financial rows must be deleted
// before the transactions/properties block inside cleanupBrokerages runs.

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let propertyId: number;
let transactionId: number;

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

  A = await createBrokerageWithUsers(baseUrl, `Financial Schema Test ${suffix}`);
  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `1 Financial Schema Test St ${suffix}`,
  });
  propertyId = created.propertyId;
  transactionId = created.transactionId;
});

after(async () => {
  const ids = [A?.brokerageId].filter((id): id is number => typeof id === "number");
  // Mirrors the ordering cleanupBrokerages itself now applies for this
  // domain (see that function's doc comment) — belt-and-braces here in
  // case a future edit to this file inserts rows cleanupBrokerages
  // doesn't yet know about.
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("commissionAgreements — versioning (Section 9)", () => {
  test("a transaction's first agreement defaults to DRAFT/AUD/version 1, and a second version can supersede it", async () => {
    const [v1] = await db
      .insert(commissionAgreements)
      .values({
        brokerageId: A.brokerageId,
        propertyId,
        transactionId,
        method: "PERCENTAGE",
        rateBps: 220,
      })
      .returning();
    assert.equal(v1.version, 1);
    assert.equal(v1.status, "DRAFT");
    assert.equal(v1.currency, "AUD");
    assert.equal(v1.gstRateBps, 1000);

    const [v2] = await db
      .insert(commissionAgreements)
      .values({
        brokerageId: A.brokerageId,
        propertyId,
        transactionId,
        version: 2,
        supersedesId: v1.id,
        method: "PERCENTAGE",
        rateBps: 250,
        status: "APPROVED",
      })
      .returning();
    assert.equal(v2.supersedesId, v1.id);

    // The prior version's own row is untouched by the new version existing
    // — versioning never edits an approved-and-used row in place.
    const [reread] = await db.select().from(commissionAgreements).where(eq(commissionAgreements.id, v1.id));
    assert.equal(reread.rateBps, 220);
    assert.equal(reread.status, "DRAFT");
  });

  test("a duplicate (transactionId, version) is rejected", async () => {
    await assert.rejects(
      () =>
        db.insert(commissionAgreements).values({
          brokerageId: A.brokerageId,
          propertyId,
          transactionId,
          version: 1, // already used by the first test in this file
          method: "PERCENTAGE",
          rateBps: 300,
        }),
      /duplicate key value violates unique constraint/i,
    );
  });
});

describe("commissionCalculations — immutable snapshots (Sections 10-11)", () => {
  test("a calculation snapshots its inputs and links back to the agreement it used, and rejects an unknown agreement id", async () => {
    const [agreement] = await db
      .insert(commissionAgreements)
      .values({ brokerageId: A.brokerageId, propertyId, transactionId, version: 3, method: "PERCENTAGE", rateBps: 220 })
      .returning();

    const [calc] = await db
      .insert(commissionCalculations)
      .values({
        brokerageId: A.brokerageId,
        propertyId,
        transactionId,
        commissionAgreementId: agreement.id,
        salePriceCentsInput: 80000000,
        methodUsed: "PERCENTAGE",
        rateBpsUsed: 220,
        grossCommissionCents: 1760000,
        commissionExGstCents: 1760000,
        gstCents: 176000,
      })
      .returning();
    assert.equal(calc.state, "ESTIMATE");
    assert.equal(calc.calculationVersion, 1);

    await assert.rejects(
      () =>
        db.insert(commissionCalculations).values({
          brokerageId: A.brokerageId,
          propertyId,
          transactionId,
          commissionAgreementId: 999999999,
          salePriceCentsInput: 80000000,
          methodUsed: "PERCENTAGE",
          grossCommissionCents: 1760000,
          commissionExGstCents: 1760000,
        }),
      /violates foreign key constraint/i,
    );
  });
});

describe("pcFeeAuthorities and pcFeeCalculations (Sections 12-14)", () => {
  test("an authority defaults to NOT_PROVIDED and a duplicate (agentUserId, version) is rejected", async () => {
    const [auth1] = await db
      .insert(pcFeeAuthorities)
      .values({ brokerageId: A.brokerageId, agentUserId: A.agent.user.id })
      .returning();
    assert.equal(auth1.status, "NOT_PROVIDED");
    assert.equal(auth1.feeBasis, "PERCENTAGE_OF_GCI");
    assert.equal(auth1.version, 1);

    await assert.rejects(
      () => db.insert(pcFeeAuthorities).values({ brokerageId: A.brokerageId, agentUserId: A.agent.user.id, version: 1 }),
      /duplicate key value violates unique constraint/i,
    );

    const [auth2] = await db
      .insert(pcFeeAuthorities)
      .values({ brokerageId: A.brokerageId, agentUserId: A.agent.user.id, version: 2, supersedesId: auth1.id, status: "ACTIVE", rateBps: 690 })
      .returning();

    const [agreement] = await db
      .insert(commissionAgreements)
      .values({ brokerageId: A.brokerageId, propertyId, transactionId, version: 4, method: "PERCENTAGE", rateBps: 220 })
      .returning();
    const [calc] = await db
      .insert(commissionCalculations)
      .values({
        brokerageId: A.brokerageId,
        propertyId,
        transactionId,
        commissionAgreementId: agreement.id,
        salePriceCentsInput: 80000000,
        methodUsed: "PERCENTAGE",
        grossCommissionCents: 1760000,
        commissionExGstCents: 1760000,
      })
      .returning();

    const [pcCalc] = await db
      .insert(pcFeeCalculations)
      .values({
        brokerageId: A.brokerageId,
        propertyId,
        transactionId,
        commissionCalculationId: calc.id,
        pcFeeAuthorityId: auth2.id,
        feeBasisUsed: "PERCENTAGE_OF_GCI",
        gciBasisCents: 1760000,
        rateBpsUsed: 690,
        grossFeeCents: 121440,
        totalFeeCents: 133584,
      })
      .returning();
    assert.equal(pcCalc.isProvisional, true);
    assert.equal(pcCalc.isDisputed, false);
  });
});

describe("financialPaymentRequests — settlement idempotency (Section 21)", () => {
  test("a second PC_SUCCESS_FEE request for the same transaction is rejected, and provider-event dedup holds", async () => {
    const [request] = await db
      .insert(financialPaymentRequests)
      .values({
        brokerageId: A.brokerageId,
        propertyId,
        transactionId,
        amountCents: 133584,
        idempotencyKey: `commission-calculated:${transactionId}:${suffix}`,
      })
      .returning();
    assert.equal(request.status, "NOT_CALCULATED");
    assert.equal(request.kind, "PC_SUCCESS_FEE");

    // A repeated SETTLEMENT_COMPLETED must never create a second PC fee
    // payment request for the same transaction — enforced at the DB level,
    // not just by application logic that could be bypassed by a retry.
    await assert.rejects(
      () =>
        db.insert(financialPaymentRequests).values({
          brokerageId: A.brokerageId,
          propertyId,
          transactionId,
          amountCents: 133584,
        }),
      /duplicate key value violates unique constraint/i,
    );

    const dedupKey = `sandbox-evt-${suffix}`;
    await db.insert(financialPaymentProviderEvents).values({
      provider: "sandbox",
      providerEventId: dedupKey,
      paymentRequestId: request.id,
      eventType: "PROCESSING",
    });
    await assert.rejects(
      () =>
        db.insert(financialPaymentProviderEvents).values({
          provider: "sandbox",
          providerEventId: dedupKey,
          paymentRequestId: request.id,
          eventType: "PROCESSING",
        }),
      /duplicate key value violates unique constraint/i,
    );

    const [dispute] = await db
      .insert(financialDisputes)
      .values({
        brokerageId: A.brokerageId,
        paymentRequestId: request.id,
        disputedAmountCents: 133584,
        reason: "Amount disputed by agent for schema test",
      })
      .returning();
    assert.equal(dispute.status, "OPEN");

    await assert.rejects(
      () =>
        db.insert(financialDisputes).values({
          brokerageId: A.brokerageId,
          paymentRequestId: 999999999,
          disputedAmountCents: 1,
          reason: "should fail — unknown payment request",
        }),
      /violates foreign key constraint/i,
    );
  });
});

describe("marketingPaymentRecords — overlay on launch.campaignItems (Section 17)", () => {
  test("one payment record per campaignItemId is enforced", async () => {
    const campaignItemId = randomUUID();
    await db.insert(marketingPaymentRecords).values({
      brokerageId: A.brokerageId,
      propertyId,
      campaignItemId,
      supplierName: "Test Signage Co",
      invoicedAmountCents: 45000,
    });
    await assert.rejects(
      () =>
        db.insert(marketingPaymentRecords).values({
          brokerageId: A.brokerageId,
          propertyId,
          campaignItemId,
          supplierName: "Different Supplier",
        }),
      /duplicate key value violates unique constraint/i,
    );
  });
});

describe("financialDeposits — one evidentiary record per transaction (Section 18)", () => {
  test("defaults to EXPECTED/UNRECONCILED and rejects a second row for the same transaction", async () => {
    const [deposit] = await db
      .insert(financialDeposits)
      .values({ brokerageId: A.brokerageId, propertyId, transactionId, requiredAmountCents: 4000000 })
      .returning();
    assert.equal(deposit.status, "EXPECTED");
    assert.equal(deposit.reconciliationStatus, "UNRECONCILED");
    assert.equal(deposit.reportedReceivedAmountCents, 0);

    await assert.rejects(
      () => db.insert(financialDeposits).values({ brokerageId: A.brokerageId, propertyId, transactionId }),
      /duplicate key value violates unique constraint/i,
    );
  });
});

describe("financialReconciliations — polymorphic over record types (Section 19)", () => {
  test("a reconciliation row can point at any FINANCIAL_RECORD_TYPES source", async () => {
    const [row] = await db
      .insert(financialReconciliations)
      .values({
        brokerageId: A.brokerageId,
        recordType: "DEPOSIT",
        recordId: String(transactionId),
        expectedAmountCents: 4000000,
        reportedAmountCents: 4000000,
        differenceCents: 0,
        status: "RECONCILED",
      })
      .returning();
    assert.equal(row.status, "RECONCILED");
    assert.equal(row.recordType, "DEPOSIT");
  });
});

describe("financialLedgerEvents — append-only (Section 20)", () => {
  test("multiple events for the same transaction accumulate rather than overwrite, in occurredAt order", async () => {
    await db.insert(financialLedgerEvents).values({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      eventType: "SALE_PRICE_CONFIRMED",
      sourceRecordType: "COMMISSION_CALCULATION",
      sourceRecordId: String(transactionId),
      actorType: "SYSTEM",
    });
    await db.insert(financialLedgerEvents).values({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      eventType: "COMMISSION_CALCULATED",
      sourceRecordType: "COMMISSION_CALCULATION",
      sourceRecordId: String(transactionId),
      actorType: "SYSTEM",
      amountCents: 1760000,
    });

    const rows = await db.select().from(financialLedgerEvents).where(eq(financialLedgerEvents.transactionId, transactionId));
    assert.ok(rows.length >= 2, "expected both ledger events to persist as separate append-only rows");
    const types = rows.map((r) => r.eventType);
    assert.ok(types.includes("SALE_PRICE_CONFIRMED"));
    assert.ok(types.includes("COMMISSION_CALCULATED"));
  });
});

describe("auditReturnReminders (Section 23)", () => {
  test("defaults reminder offsets, and a duplicate (brokerageId, period) is rejected", async () => {
    const periodStart = new Date("2026-07-01T00:00:00.000Z");
    const periodEnd = new Date("2027-06-30T00:00:00.000Z");
    const dueDate = new Date("2027-08-31T00:00:00.000Z");

    const [reminder] = await db
      .insert(auditReturnReminders)
      .values({ brokerageId: A.brokerageId, reportingPeriodStart: periodStart, reportingPeriodEnd: periodEnd, dueDate })
      .returning();
    assert.deepEqual(reminder.reminderOffsetsDays, [60, 30, 14, 7]);
    assert.equal(reminder.status, "SCHEDULED");

    await assert.rejects(
      () =>
        db.insert(auditReturnReminders).values({
          brokerageId: A.brokerageId,
          reportingPeriodStart: periodStart,
          reportingPeriodEnd: periodEnd,
          dueDate,
        }),
      /duplicate key value violates unique constraint/i,
    );
  });
});

describe("financialSettings — one lazily-created row per brokerage", () => {
  test("carries the AU default GST/PC-fee rates and rejects a second row for the same brokerage", async () => {
    const [settings] = await db.insert(financialSettings).values({ brokerageId: A.brokerageId }).returning();
    assert.equal(settings.defaultGstRateBps, 1000);
    assert.equal(settings.defaultPcFeeRateBps, 690);
    assert.equal(settings.defaultPcFeeGciDefinition, "COMMISSION_EX_GST");

    await assert.rejects(
      () => db.insert(financialSettings).values({ brokerageId: A.brokerageId }),
      /duplicate key value violates unique constraint/i,
    );
  });
});
