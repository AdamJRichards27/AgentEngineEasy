// Agent Engine 2.0 — Financial Transaction Engine Verification (Step 2,
// Integration Readiness Program) — COHERENCE-001 remediation tests.
//
// Section 8 of the verification brief lists 14 required coherence
// remediation test scenarios. This file covers every one of them against
// legacyReconciliation.ts's real implementation (the brief's Section 7
// "safe fallback" — see that module's own header comment for why the
// "preferred" full backfill was rejected as unsafe). Two scenarios are
// necessarily out of scope for an automated `node:test` suite and are
// covered elsewhere instead, noted at the point they would otherwise
// appear below:
//
//   - Scenario 12 ("UI shows one coherent financial explanation") is a
//     rendering concern verified by code inspection of
//     FinancialSummarySection.tsx's legacyCommission branch and by the
//     manual vertical-slice walkthrough (Section 27 Scenario E), not by
//     a server-side test.
//
// One additional scenario beyond the original 14 was added later, for
// FIN-001 (Step 3 integration-readiness brief, Section 4): a genuine
// concurrent-request test (Promise.all, not the sequential "run twice"
// scenario 5/9 below) — see its own comment at the point it appears below
// for why it exists and what it can and cannot prove without a live
// database in the environment that runs it.
//
// Same fixture shape and harness as this directory's sibling files
// (agreements.test.ts, settlement.test.ts): a real database, a real
// property/transaction created through the actual API routes via
// testSupport.ts, then moved to a Settled/Closed legacy state by a direct
// DB write — mirrors settlement.test.ts's own precedent of inserting
// commissionAgreements rows directly to set up a fixture state the normal
// write path doesn't produce on its own. This is a TEST FIXTURE
// convenience only; it does not touch any production code path (compare
// RISK-001's C13 fixture repair, which uses the identical justification
// for its own direct DB insert of an anomalous offer).
//
// THIS SUITE COULD NOT BE EXECUTED IN THE Financial Transaction Engine
// Verification (Step 2) SESSION THAT AUTHORED IT: that session had no
// database connection, no local git checkout, and no way to run `pnpm
// test` (see docs/FINANCIAL_TRANSACTION_ENGINE_VERIFICATION.md, Automated
// Test Results, for the full explanation). It is written to the same
// standard and conventions as the rest of this directory and is intended
// to be run — and, if anything here doesn't compile or pass first try,
// fixed — as the very next step once a real environment is available.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, and } from "drizzle-orm";
import { db, transactions, commissionAgreements, financialReconciliations, financialLedgerEvents, pcFeeCalculations, financialPaymentRequests } from "@aee/db";
import { createBrokerageWithUsers, createTransactionFromListedProperty, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";
import {
  getLegacyCommissionContext,
  reconcileLegacyCommission,
  findTransactionsNeedingLegacyReconciliation,
  runLegacyCommissionReconciliationBackfill,
  LEGACY_RECONCILIATION_SOURCE,
  LEGACY_RECONCILIATION_RECORD_TYPE,
} from "../legacyReconciliation.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let otherBrokerage: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

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

  A = await createBrokerageWithUsers(baseUrl, `Financial Legacy Reconciliation Test ${suffix}`);
  otherBrokerage = await createBrokerageWithUsers(baseUrl, `Financial Legacy Reconciliation Other Test ${suffix}`);
});

after(async () => {
  const ids = [A?.brokerageId, otherBrokerage?.brokerageId].filter((id): id is number => typeof id === "number");
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

/**
 * Creates a real property + transaction through the actual API (same
 * chokepoint every other Stage D/E test uses), then force-moves it to a
 * closed legacy state with a flat commission figure — the exact shape a
 * transaction that settled before the Financial Transaction Engine
 * existed in this workspace would have. TEST-ONLY: no production route
 * writes grossCommissionCents/gstCents directly like this.
 */
async function createClosedLegacyTransaction(
  cookie: string,
  opts: { addressSuffix: string; status?: "Settled" | "Closed"; grossCommissionCents?: number | null; gstCents?: number | null },
): Promise<{ propertyId: number; transactionId: number }> {
  const created = await createTransactionFromListedProperty(baseUrl, cookie, { address: `1 Legacy Commission Test St ${opts.addressSuffix}` });
  await db
    .update(transactions)
    .set({
      status: opts.status ?? "Closed",
      grossCommissionCents: opts.grossCommissionCents === undefined ? 1_760_000 : opts.grossCommissionCents,
      gstCents: opts.gstCents === undefined ? 176_000 : opts.gstCents,
      commissionCalculatedAt: opts.grossCommissionCents === null ? null : new Date("2024-03-15T00:00:00Z"),
    })
    .where(eq(transactions.id, created.transactionId));
  return { propertyId: created.propertyId, transactionId: created.transactionId };
}

// Section 8, scenario 1.
describe("reconcileLegacyCommission — historical closed transaction with legacy commission, no Financial Engine record", () => {
  test("creates an UNRECONCILED financialReconciliations row preserving the original amounts", async () => {
    const { propertyId, transactionId } = await createClosedLegacyTransaction(A.agent.cookie, { addressSuffix: "1" });

    const result = await reconcileLegacyCommission({ transactionId, brokerageId: A.brokerageId, propertyId, actorUserId: A.admin.user.id });

    assert.equal(result.created, true);
    assert.equal(result.dryRun, false);
    assert.ok(result.reconciliation);
    assert.equal(result.reconciliation!.recordType, LEGACY_RECONCILIATION_RECORD_TYPE);
    assert.equal(result.reconciliation!.recordId, String(transactionId));
    assert.equal(result.reconciliation!.reportedAmountCents, 1_760_000, "must preserve the original legacy amount exactly (Section 7 point 6)");
    assert.equal(result.reconciliation!.expectedAmountCents, null, "nothing was ever 'expected' under Financial Engine rules for a pre-existing legacy record");
    assert.equal(result.reconciliation!.status, "UNRECONCILED");
    assert.equal(result.reconciliation!.source, LEGACY_RECONCILIATION_SOURCE);
  });
});

// Section 8, scenario 2.
describe("reconcileLegacyCommission — historical transaction with no commission data", () => {
  test("is a no-op: no legacy context, nothing created", async () => {
    const { propertyId, transactionId } = await createClosedLegacyTransaction(A.agent.cookie, { addressSuffix: "2", grossCommissionCents: null, gstCents: null });

    const context = await getLegacyCommissionContext(transactionId, A.brokerageId);
    assert.equal(context, null);

    const result = await reconcileLegacyCommission({ transactionId, brokerageId: A.brokerageId, propertyId });
    assert.equal(result.created, false);
    assert.equal(result.reconciliation, null);
    assert.match(result.skippedReason ?? "", /No eligible legacy commission/);
  });
});

// Section 8, scenario 3.
describe("reconcileLegacyCommission — historical transaction with ambiguous (missing) GST data", () => {
  test("preserves gstCents as null rather than fabricating a GST figure", async () => {
    const { propertyId, transactionId } = await createClosedLegacyTransaction(A.agent.cookie, { addressSuffix: "3", gstCents: null });

    const context = await getLegacyCommissionContext(transactionId, A.brokerageId);
    assert.ok(context);
    assert.equal(context!.gstCents, null);

    const result = await reconcileLegacyCommission({ transactionId, brokerageId: A.brokerageId, propertyId });
    assert.equal(result.created, true);
    assert.equal(result.reconciliation!.reportedAmountCents, 1_760_000);
    assert.doesNotMatch(result.reconciliation!.notes ?? "", /GST/, "must not mention a GST figure it never had");
  });
});

// Section 8, scenario 4.
describe("reconcileLegacyCommission — transaction already containing a Financial Engine calculation", () => {
  test("skips (does not create a redundant legacy reconciliation) when a commissionAgreement already exists", async () => {
    const { propertyId, transactionId } = await createClosedLegacyTransaction(A.agent.cookie, { addressSuffix: "4" });
    await db.insert(commissionAgreements).values({ brokerageId: A.brokerageId, propertyId, transactionId, version: 1, method: "PERCENTAGE", rateBps: 220, status: "APPROVED" });

    const result = await reconcileLegacyCommission({ transactionId, brokerageId: A.brokerageId, propertyId });
    assert.equal(result.created, false);
    assert.equal(result.reconciliation, null);
    assert.match(result.skippedReason ?? "", /Financial Engine commission agreement already exists/);

    const rows = await db.select().from(financialReconciliations).where(eq(financialReconciliations.recordId, String(transactionId)));
    assert.equal(rows.length, 0);
  });
});

// Section 8, scenarios 5 and 9 (rerun idempotency / no duplicate snapshot).
describe("reconcileLegacyCommission — run twice", () => {
  test("the second call returns the same row and creates no duplicate", async () => {
    const { propertyId, transactionId } = await createClosedLegacyTransaction(A.agent.cookie, { addressSuffix: "5" });

    const first = await reconcileLegacyCommission({ transactionId, brokerageId: A.brokerageId, propertyId });
    assert.equal(first.created, true);

    const second = await reconcileLegacyCommission({ transactionId, brokerageId: A.brokerageId, propertyId });
    assert.equal(second.created, false);
    assert.equal(second.reconciliation!.id, first.reconciliation!.id);
    assert.match(second.skippedReason ?? "", /Already flagged/);

    const rows = await db.select().from(financialReconciliations).where(eq(financialReconciliations.recordId, String(transactionId)));
    assert.equal(rows.length, 1, "exactly one reconciliation row must exist however many times this is called");
  });
});

// FIN-001 (Step 3 integration-readiness brief, Section 4) — NOT one of the
// original Section 8 scenarios. The "run twice" test above calls
// reconcileLegacyCommission SEQUENTIALLY (await, then await again), which
// only exercises the SELECT-before-INSERT check on its own — it can never
// observe the actual race the SELECT-before-INSERT idiom is vulnerable to.
// This test instead fires two calls concurrently (Promise.all) for the
// same (brokerageId, transactionId) so both SELECTs can genuinely run
// before either INSERT commits.
//
// A single-process run often serialises overlapping writes closely enough
// that the race is hard to hit, so a green result is not proof the
// conflict path executed. The test asserts the property that must hold
// regardless of timing (exactly one reconciliation row, and every returned
// result points at that same row).
// financial_reconciliations_legacy_commission_unique_idx is created by
// migration 0009_flimsy_norrin_radd (see schema/financial.ts) and is the
// database race guard. This test remains the regression guard if that
// index is dropped.
describe("reconcileLegacyCommission — concurrent requests for the same transaction (FIN-001)", () => {
  test("two simultaneous calls create exactly one reconciliation row between them", async () => {
    const { propertyId, transactionId } = await createClosedLegacyTransaction(A.agent.cookie, { addressSuffix: "14" });

    const [first, second] = await Promise.all([
      reconcileLegacyCommission({ transactionId, brokerageId: A.brokerageId, propertyId, actorUserId: A.admin.user.id }),
      reconcileLegacyCommission({ transactionId, brokerageId: A.brokerageId, propertyId, actorUserId: A.admin.user.id }),
    ]);

    const rows = await db.select().from(financialReconciliations).where(eq(financialReconciliations.recordId, String(transactionId)));
    assert.equal(rows.length, 1, "a concurrent double-submit must never create two reconciliation rows for the same transaction");

    // Exactly one of the two calls did the creating; the other observed it
    // (either via its own SELECT finding the winner's row, or via the
    // onConflictDoNothing + re-select race-loser path, which migration
    // 0009 makes the active race guard) — both outcomes are correct,
    // "both created" is not.
    assert.notEqual(first.created, second.created, "exactly one of the two concurrent calls must report created:true");
    const winner = first.created ? first : second;
    const loser = first.created ? second : first;
    assert.ok(winner.reconciliation);
    assert.ok(loser.reconciliation);
    assert.equal(loser.reconciliation!.id, winner.reconciliation!.id, "the losing call must resolve to the same row the winner created, never a duplicate");

    const ledgerRows = await db
      .select()
      .from(financialLedgerEvents)
      .where(and(eq(financialLedgerEvents.transactionId, transactionId), eq(financialLedgerEvents.eventType, "LEGACY_COMMISSION_FLAGGED_FOR_RECONCILIATION")));
    assert.equal(ledgerRows.length, 1, "exactly one ledger event must be recorded, matching the single reconciliation row");
  });
});

// Section 8, scenario 6.
describe("reconcileLegacyCommission — legacy record with a manual adjustment already applied", () => {
  test("a rerun does not reset a manually reconciled record back to UNRECONCILED", async () => {
    const { propertyId, transactionId } = await createClosedLegacyTransaction(A.agent.cookie, { addressSuffix: "6" });
    const first = await reconcileLegacyCommission({ transactionId, brokerageId: A.brokerageId, propertyId });
    assert.ok(first.reconciliation);

    // Simulates a Brokerage Administrator manually resolving the queue item
    // (Section 18's reconciliation UI, outside this remediation's scope) —
    // a direct DB write here stands in for that action, same fixture
    // convention as the rest of this file.
    await db
      .update(financialReconciliations)
      .set({ status: "RECONCILED", reconciledByUserId: A.admin.user.id, reconciledAt: new Date(), notes: "Manually confirmed against the original agency agreement PDF." })
      .where(eq(financialReconciliations.id, first.reconciliation!.id));

    const second = await reconcileLegacyCommission({ transactionId, brokerageId: A.brokerageId, propertyId });
    assert.equal(second.created, false);
    assert.equal(second.reconciliation!.status, "RECONCILED", "must not overwrite a manual reconciliation — corrections are additive, never destructive (Section 18)");
  });
});

// Section 8, scenario 7.
describe("reconcileLegacyCommission — multi-tenant isolation", () => {
  test("a transaction cannot be reconciled under a different brokerage's id", async () => {
    const { transactionId } = await createClosedLegacyTransaction(A.agent.cookie, { addressSuffix: "7" });

    const crossTenantContext = await getLegacyCommissionContext(transactionId, otherBrokerage.brokerageId);
    assert.equal(crossTenantContext, null, "a transaction must not be readable as legacy-commission-eligible under a foreign brokerageId");
  });
});

// Section 8, scenario 8.
describe("reconcileLegacyCommission — dry run", () => {
  test("dryRun reports a preview and writes nothing", async () => {
    const { propertyId, transactionId } = await createClosedLegacyTransaction(A.agent.cookie, { addressSuffix: "8" });

    const result = await reconcileLegacyCommission({ transactionId, brokerageId: A.brokerageId, propertyId, dryRun: true });
    assert.equal(result.created, false);
    assert.equal(result.dryRun, true);
    assert.equal(result.reconciliation, null);
    assert.ok(result.preview);
    assert.equal(result.preview!.grossCommissionCents, 1_760_000);

    const rows = await db.select().from(financialReconciliations).where(eq(financialReconciliations.recordId, String(transactionId)));
    assert.equal(rows.length, 0, "dry-run must not write a row");
  });
});

// Section 8, scenarios 10 and 11.
describe("reconcileLegacyCommission — never fabricates a PC fee, invoice or debit request", () => {
  test("no pcFeeCalculations or financialPaymentRequests rows are created as a side effect", async () => {
    const { propertyId, transactionId } = await createClosedLegacyTransaction(A.agent.cookie, { addressSuffix: "9" });

    await reconcileLegacyCommission({ transactionId, brokerageId: A.brokerageId, propertyId });

    const feeCalcRows = await db.select().from(pcFeeCalculations).where(eq(pcFeeCalculations.transactionId, transactionId));
    assert.equal(feeCalcRows.length, 0, "no PC fee may be created without a verified service agreement (Section 8 point 10)");

    const paymentRequestRows = await db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.transactionId, transactionId));
    assert.equal(paymentRequestRows.length, 0, "no debit/payment request may be created for a legacy transaction (Section 8 point 11)");
  });
});

// Section 8, scenario 13.
describe("reconcileLegacyCommission — reconciled source is visible in history", () => {
  test("records a LEGACY_COMMISSION_FLAGGED_FOR_RECONCILIATION ledger event traceable back to the reconciliation row", async () => {
    const { propertyId, transactionId } = await createClosedLegacyTransaction(A.agent.cookie, { addressSuffix: "10" });

    const result = await reconcileLegacyCommission({ transactionId, brokerageId: A.brokerageId, propertyId, actorUserId: A.admin.user.id });
    assert.ok(result.reconciliation);

    const ledgerRows = await db
      .select()
      .from(financialLedgerEvents)
      .where(and(eq(financialLedgerEvents.transactionId, transactionId), eq(financialLedgerEvents.eventType, "LEGACY_COMMISSION_FLAGGED_FOR_RECONCILIATION")));
    assert.equal(ledgerRows.length, 1);
    assert.equal(ledgerRows[0].sourceRecordType, LEGACY_RECONCILIATION_RECORD_TYPE);
    assert.equal(ledgerRows[0].sourceRecordId, String(result.reconciliation!.id));
    assert.equal(ledgerRows[0].actorUserId, A.admin.user.id);
  });
});

// Section 8, scenario 14.
describe("reconcileLegacyCommission — uncertain records are flagged for manual review, never auto-resolved", () => {
  test("the created record is UNRECONCILED with guidance notes, not auto-RECONCILED", async () => {
    const { propertyId, transactionId } = await createClosedLegacyTransaction(A.agent.cookie, { addressSuffix: "11" });

    const result = await reconcileLegacyCommission({ transactionId, brokerageId: A.brokerageId, propertyId });
    assert.equal(result.reconciliation!.status, "UNRECONCILED");
    assert.match(result.reconciliation!.notes ?? "", /Resolve by drafting and approving a real commission agreement/);
    assert.match(result.reconciliation!.notes ?? "", /none was fabricated/);
  });
});

// The backfill scan + report (Section 7's numbered list, adapted to the
// safe-fallback content) — dry-run vs a real run, and scoping to eligible
// transactions only.
describe("runLegacyCommissionReconciliationBackfill", () => {
  test("dry-run reports would_create rows and writes nothing; a real run then creates them idempotently", async () => {
    const eligible = await createClosedLegacyTransaction(A.agent.cookie, { addressSuffix: "12" });
    // An ineligible sibling: still open, so it must never appear in the scan.
    const open = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: `1 Legacy Commission Test St 13` });

    const candidates = await findTransactionsNeedingLegacyReconciliation(A.brokerageId);
    const candidateIds = candidates.map((c) => c.transactionId);
    assert.ok(candidateIds.includes(eligible.transactionId));
    assert.ok(!candidateIds.includes(open.transactionId), "an in-progress transaction must not be scanned as needing legacy reconciliation");

    const dryRunReport = await runLegacyCommissionReconciliationBackfill(A.brokerageId, { dryRun: true });
    assert.equal(dryRunReport.dryRun, true);
    assert.equal(dryRunReport.created, 0);
    const dryRunRows = await db.select().from(financialReconciliations).where(eq(financialReconciliations.brokerageId, A.brokerageId));
    assert.equal(dryRunRows.filter((r) => r.recordId === String(eligible.transactionId)).length, 0);

    const realReport = await runLegacyCommissionReconciliationBackfill(A.brokerageId, { dryRun: false, actorUserId: A.admin.user.id });
    assert.ok(realReport.created >= 1);
    assert.ok(realReport.rows.some((r) => r.transactionId === eligible.transactionId && r.outcome === "created"));

    // Safe to rerun (Section 7 point 10): a second real run must report the
    // same transaction as already flagged, not create a second row.
    const rerunReport = await runLegacyCommissionReconciliationBackfill(A.brokerageId, { dryRun: false });
    assert.ok(rerunReport.rows.some((r) => r.transactionId === eligible.transactionId && r.outcome === "already_flagged"));
  });
});
