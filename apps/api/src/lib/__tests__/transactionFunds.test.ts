// R-F37 — every funds-reconciliation status and the cent boundaries.
// Pure: no database, no route, no writer.
import test from "node:test";
import assert from "node:assert/strict";
import { computeFundsReconciliation } from "../transactionFunds.js";

const CALCULATED_AT = new Date("2026-10-01T00:00:00.000Z");

// Same integer formulas calculateCommission uses (GST 10% = 1000 bps).
// Flat fee $1,500.00 → gross 150000, GST 15000, expected 165000.
const FLAT_GROSS = 150_000;
const FLAT_GST = Math.round((FLAT_GROSS * 1000) / 10000);
const FLAT_EXPECTED = FLAT_GROSS + FLAT_GST;

// Rate 2.50% of an $800,000.00 purchase → gross 2_000_000, GST 200_000.
const RATE_PRICE = 80_000_000;
const RATE_BPS = 250;
const RATE_GROSS = Math.round((RATE_PRICE * RATE_BPS) / 10000);
const RATE_GST = Math.round((RATE_GROSS * 1000) / 10000);
const RATE_EXPECTED = RATE_GROSS + RATE_GST;

test("commission not calculated reports received cents and leaves expected and variance null", () => {
  assert.deepEqual(
    computeFundsReconciliation({
      grossCommissionCents: null,
      gstCents: null,
      commissionCalculatedAt: null,
      fundsReceivedCents: 0,
    }),
    {
      status: "COMMISSION_NOT_CALCULATED",
      expectedCents: null,
      receivedCents: 0,
      varianceCents: null,
    },
  );
});

test("commission not calculated still reports funds already received", () => {
  assert.deepEqual(
    computeFundsReconciliation({
      grossCommissionCents: FLAT_GROSS,
      gstCents: FLAT_GST,
      commissionCalculatedAt: null,
      fundsReceivedCents: 100,
    }),
    {
      status: "COMMISSION_NOT_CALCULATED",
      expectedCents: null,
      receivedCents: 100,
      varianceCents: null,
    },
  );
});

test("nothing received against a calculated flat fee is NOT_RECEIVED", () => {
  assert.equal(FLAT_EXPECTED, 165_000);
  assert.deepEqual(
    computeFundsReconciliation({
      grossCommissionCents: FLAT_GROSS,
      gstCents: FLAT_GST,
      commissionCalculatedAt: CALCULATED_AT,
      fundsReceivedCents: 0,
    }),
    {
      status: "NOT_RECEIVED",
      expectedCents: FLAT_EXPECTED,
      receivedCents: 0,
      varianceCents: -FLAT_EXPECTED,
    },
  );
});

test("an exact flat-fee match, including a zero commission, is MATCHED", () => {
  assert.deepEqual(
    computeFundsReconciliation({
      grossCommissionCents: FLAT_GROSS,
      gstCents: FLAT_GST,
      commissionCalculatedAt: CALCULATED_AT,
      fundsReceivedCents: FLAT_EXPECTED,
    }),
    {
      status: "MATCHED",
      expectedCents: FLAT_EXPECTED,
      receivedCents: FLAT_EXPECTED,
      varianceCents: 0,
    },
  );
  assert.deepEqual(
    computeFundsReconciliation({
      grossCommissionCents: 0,
      gstCents: 0,
      commissionCalculatedAt: CALCULATED_AT,
      fundsReceivedCents: 0,
    }).status,
    "MATCHED",
  );
});

test("one cent short of a calculated rate commission is PARTIAL", () => {
  assert.equal(RATE_GROSS, 2_000_000);
  assert.equal(RATE_GST, 200_000);
  assert.equal(RATE_EXPECTED, 2_200_000);
  assert.deepEqual(
    computeFundsReconciliation({
      grossCommissionCents: RATE_GROSS,
      gstCents: RATE_GST,
      commissionCalculatedAt: CALCULATED_AT,
      fundsReceivedCents: RATE_EXPECTED - 1,
    }),
    {
      status: "PARTIAL",
      expectedCents: RATE_EXPECTED,
      receivedCents: RATE_EXPECTED - 1,
      varianceCents: -1,
    },
  );
});

test("one cent over a calculated commission is OVER_RECEIVED", () => {
  assert.deepEqual(
    computeFundsReconciliation({
      grossCommissionCents: FLAT_GROSS,
      gstCents: FLAT_GST,
      commissionCalculatedAt: CALCULATED_AT,
      fundsReceivedCents: FLAT_EXPECTED + 1,
    }),
    {
      status: "OVER_RECEIVED",
      expectedCents: FLAT_EXPECTED,
      receivedCents: FLAT_EXPECTED + 1,
      varianceCents: 1,
    },
  );
});

test("a one-cent expected amount with nothing received stays NOT_RECEIVED", () => {
  assert.deepEqual(
    computeFundsReconciliation({
      grossCommissionCents: 1,
      gstCents: 0,
      commissionCalculatedAt: CALCULATED_AT,
      fundsReceivedCents: 0,
    }),
    {
      status: "NOT_RECEIVED",
      expectedCents: 1,
      receivedCents: 0,
      varianceCents: -1,
    },
  );
});

test("null gross and gst after calculation are integer zeros", () => {
  assert.deepEqual(
    computeFundsReconciliation({
      grossCommissionCents: null,
      gstCents: null,
      commissionCalculatedAt: CALCULATED_AT,
      fundsReceivedCents: 1,
    }),
    {
      status: "OVER_RECEIVED",
      expectedCents: 0,
      receivedCents: 1,
      varianceCents: 1,
    },
  );
});
