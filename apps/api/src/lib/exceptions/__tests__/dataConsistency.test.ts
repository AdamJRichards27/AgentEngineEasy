// Agent Engine 2.0 — Exception & Risk Engine (Priority 4) — Part B Stage 4.
//
// End-to-end coverage for the two DATA_CONSISTENCY rules that close Part B
// Stage 2's Finding 3 (Transaction workflow projection drift) and Finding 4
// (property AML status summary drift): each scenario drives a real
// property/transaction through the normal app routes, simulates the exact
// crash-window/best-effort-catch gap those findings describe with a direct
// DB write (the same "outside the app's normal write paths" precedent
// engine.test.ts's own C13 scenario and amlCtf.ts's rules already use for
// data-integrity anomalies), confirms detection, exercises the real
// operator-facing remediation HTTP route, and confirms the next scheduled
// sweep auto-resolves it from genuinely re-derived evidence.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, and } from "drizzle-orm";
import { db, properties, transactions, amlVerifications, riskExceptions, type RiskException } from "@aee/db";
import { runScheduledScan, type ScanSummary } from "../engine.js";
import { createBrokerageWithUsers, createListedProperty, createTransactionFromListedProperty, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

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

  A = await createBrokerageWithUsers(baseUrl, `Data Consistency ${suffix}`);
});

after(async () => {
  const ids = [A?.brokerageId].filter((id): id is number => typeof id === "number");
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

// Retries a scheduled scan when it's transiently refused because another
// scan (from a concurrently-running test file against the same shared test
// database) currently holds the scan_runs lock — same precedent as
// engine.test.ts's own scanOrRetry.
async function scanOrRetry(trigger: "SCHEDULED" | "MANUAL" = "MANUAL"): Promise<ScanSummary> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await runScheduledScan(trigger);
    if (result.ok) return result.summary;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("runScheduledScan did not succeed after retries — another scan kept the lock held throughout");
}

async function fetchException(id: string): Promise<RiskException> {
  const [row] = await db.select().from(riskExceptions).where(eq(riskExceptions.id, id));
  if (!row) throw new Error(`exception ${id} not found`);
  return row;
}

// ---------------------------------------------------------------------
// DC01 — Transaction workflow projection drift.
// ---------------------------------------------------------------------

test("DC01: a transaction whose contract was signed without its properties.workflowStage write landing is detected, remediated via the resync route, and auto-resolves", async () => {
  const { propertyId, transactionId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: "1 DC01 Scenario Rd" });

  // acceptOffer already moved this property to "Under Offer" atomically.
  // Simulate the exact Finding 3 crash window recordContractSigned leaves
  // open: the transactions write (status -> UnderContract, contractDate
  // set) lands, but the separate properties.workflowStage write that
  // should follow it never commits — standing in for a crash between the
  // two statements, the same way engine.test.ts's own C13 scenario uses a
  // direct DB write to simulate a state the app's normal chokepoints
  // otherwise prevent.
  const contractDate = new Date();
  await db.update(transactions).set({ status: "UnderContract", contractDate, updatedAt: new Date() }).where(eq(transactions.id, transactionId));

  const firstScan = await scanOrRetry("MANUAL");
  assert.ok(firstScan.exceptionsCreated >= 1 || firstScan.exceptionsUpdated >= 1);

  const propertyRows = await db.select().from(riskExceptions).where(eq(riskExceptions.propertyId, propertyId));
  const detected = propertyRows.find((r) => r.ruleId === "DC01_TRANSACTION_PROJECTION_DRIFT");
  assert.ok(detected, "expected a DC01 risk exception to have been created for this property");
  assert.equal(detected!.severity, "AT_RISK");
  assert.equal(detected!.dismissible, false);
  assert.ok(["OPEN", "REOPENED"].includes(detected!.status));
  const metadata = detected!.metadata as Record<string, unknown> | null;
  assert.equal(metadata?.expectedWorkflowStage, "Contract");
  assert.equal(metadata?.actualWorkflowStage, "Under Offer");

  const [propertyBeforeFix] = await db.select().from(properties).where(eq(properties.id, propertyId));
  assert.equal(propertyBeforeFix.workflowStage, "Under Offer", "sanity check: the simulated crash window left workflowStage stale");

  // Remediate through the real operator-facing route (Brokerage
  // Administrator gated, per routes/transactions.ts).
  const resyncRes = await fetch(`${baseUrl}/api/transactions/${transactionId}/resync-projection`, {
    method: "POST",
    headers: { cookie: A.admin.cookie },
  });
  assert.equal(resyncRes.status, 200, `resync-projection failed: ${await resyncRes.text()}`);
  const { property: resyncedProperty } = (await resyncRes.json()) as { property: { workflowStage: string } };
  assert.equal(resyncedProperty.workflowStage, "Contract");

  await scanOrRetry("MANUAL");
  const resolved = await fetchException(detected!.id);
  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.resolutionMethod, "AUTO");
});

// ---------------------------------------------------------------------
// DC02 — Property AML status summary drift.
// ---------------------------------------------------------------------

test("DC02: a seller AML verification that regresses to Review Required without refreshReadyToListSteps committing is detected as CRITICAL, remediated via the resync route, and auto-resolves", async () => {
  const { propertyId, sellerPartyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: "1 DC02 Scenario Rd" });

  const [propertyAfterGoLive] = await db.select().from(properties).where(eq(properties.id, propertyId));
  assert.equal(propertyAfterGoLive.amlStatusSummary, "Complete", "sanity check: go-live's own AML webhook flow already verified this seller");

  // Simulate the exact Finding 4 gap: the seller's amlVerifications row
  // regresses (e.g. a provider re-review) but the
  // refreshReadyToListSteps(...).catch(...) call that should follow never
  // committed — standing in for the best-effort refresh silently failing,
  // via a direct DB write outside the app's normal aml.ts webhook path
  // (same simulate-the-gap precedent as DC01's test above).
  await db.update(amlVerifications).set({ status: "Review Required", reviewRequired: true, updatedAt: new Date() }).where(and(eq(amlVerifications.propertyId, propertyId), eq(amlVerifications.partyId, sellerPartyId)));

  await scanOrRetry("MANUAL");

  const propertyRows = await db.select().from(riskExceptions).where(eq(riskExceptions.propertyId, propertyId));
  const detected = propertyRows.find((r) => r.ruleId === "DC02_AML_STATUS_SUMMARY_DRIFT");
  assert.ok(detected, "expected a DC02 risk exception to have been created for this property");
  assert.equal(detected!.severity, "CRITICAL", "a stale Complete masking a real Review Required flag must be CRITICAL");
  assert.equal(detected!.dismissible, false);
  const metadata = detected!.metadata as Record<string, unknown> | null;
  assert.equal(metadata?.expectedAmlStatusSummary, "Review Required");
  assert.equal(metadata?.actualAmlStatusSummary, "Complete");

  const [propertyBeforeFix] = await db.select().from(properties).where(eq(properties.id, propertyId));
  assert.equal(propertyBeforeFix.amlStatusSummary, "Complete", "sanity check: the simulated failure left amlStatusSummary stale");

  const resyncRes = await fetch(`${baseUrl}/api/properties/${propertyId}/resync-aml-summary`, {
    method: "POST",
    headers: { cookie: A.admin.cookie },
  });
  assert.equal(resyncRes.status, 200, `resync-aml-summary failed: ${await resyncRes.text()}`);
  const { property: resyncedProperty } = (await resyncRes.json()) as { property: { amlStatusSummary: string } };
  assert.equal(resyncedProperty.amlStatusSummary, "Review Required");

  await scanOrRetry("MANUAL");
  const resolved = await fetchException(detected!.id);
  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.resolutionMethod, "AUTO");
});
