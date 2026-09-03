// Agent Engine 2.0 — Exception & Risk Engine (Priority 4, Build
// Instructions §24) — the two named end-to-end scenarios plus engine
// orchestration coverage:
//
//   1. An AT_RISK-severity detection (B07: a live listing missing required
//      address fields) — created by a scheduled sweep, left alone by the
//      event-driven path once the underlying condition is fixed (proving
//      engine.ts's documented "event-driven path deliberately does not
//      auto-resolve" contract), and finally auto-resolved by the next
//      scheduled sweep once it genuinely clears.
//   2. A CRITICAL-severity detection (C13: two offers independently marked
//      Accepted for the same property — a data-integrity condition the
//      normal acceptOffer chokepoint prevents, which is exactly the class
//      of anomaly this rule exists to catch) — created, shown to be
//      un-overridable by a manual "just mark it resolved" (Build
//      Instructions §14's authoritative-evidence guard, demonstrated here
//      against a real detected exception rather than a hand-built one),
//      and auto-resolved once the anomaly is corrected.
//
// Plus: the concurrent-scan guard, per-run summary bookkeeping, and the
// "a throwing rule never stops its siblings or auto-resolves on a failed
// pass" isolation guarantee (Build Instructions §3/§19).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, properties, offers, riskExceptions, riskExceptionTransitions, riskExceptionScanRuns, type RiskException } from "@aee/db";
import { publishDomainEvent, newCorrelationId, type DomainEvent } from "@aee/events";
import { runScheduledScan, handleExceptionDomainEvent, type ScanSummary } from "../engine.js";
import { RISK_RULES, type RiskRule } from "../registry.js";
import { createOrUpdateException, resolveExceptionManually, RiskExceptionError } from "../model.js";
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

  A = await createBrokerageWithUsers(baseUrl, `Exceptions Engine A ${suffix}`);
});

after(async () => {
  const ids = [A?.brokerageId].filter((id): id is number => typeof id === "number");
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

// Retries a scheduled scan when it's transiently refused because another
// scan (from a concurrently-running test file against the same shared test
// database) currently holds the scan_runs lock — a real, correct outcome
// under concurrent test execution, not a bug in the engine under test.
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

async function publishTriggeringEvent(input: { eventType: DomainEvent["eventType"]; propertyId: number; transactionId?: number | null }): Promise<DomainEvent> {
  return publishDomainEvent({
    eventType: input.eventType,
    occurredAt: new Date(),
    propertyId: input.propertyId,
    transactionId: input.transactionId ?? null,
    partyId: null,
    brokerageId: A.brokerageId,
    agentId: A.agent.user.id,
    actorType: "USER",
    actorId: A.agent.user.id,
    source: "test:exceptions-engine",
    correlationId: newCorrelationId(),
    causationId: null,
    idempotencyKey: `test-exceptions-engine:${randomUUID()}`,
    payload: { propertyId: input.propertyId },
    metadata: {},
  });
}

// ---------------------------------------------------------------------
// Scenario 1 — AT_RISK: B07_LISTING_LIVE_MISSING_REQUIRED_INFO.
// ---------------------------------------------------------------------

test("AT_RISK scenario: a live listing missing required address fields is detected by a scheduled sweep, left open by the event-driven path once fixed, and auto-resolved by the next sweep", async () => {
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: "1 At Risk Scenario Rd" });

  // Break the condition B07 checks directly at the data layer — real
  // listed properties always have suburb/state/postcode set by the time
  // they go live, so this simulates the data-integrity gap the rule exists
  // to catch (Build Instructions §10).
  await db.update(properties).set({ suburb: null }).where(eq(properties.id, propertyId));

  const firstScan = await scanOrRetry("MANUAL");
  assert.ok(firstScan.exceptionsCreated >= 1 || firstScan.exceptionsUpdated >= 1);

  // Filtered by ruleId, not just propertyId: a freshly listed property
  // (created outside the Stage C "Listing preparation" flow) also
  // legitimately trips B08_LISTING_LIVE_MISSING_CAMPAIGN_INFO for missing
  // salesMethod/priceDisplay/campaign dates — a real, independent finding,
  // not a bug in this fixture — so more than one exception can exist for
  // this property and row order is not guaranteed without ORDER BY.
  const propertyRows = await db.select().from(riskExceptions).where(eq(riskExceptions.propertyId, propertyId));
  const detected = propertyRows.find((r) => r.ruleId === "B07_LISTING_LIVE_MISSING_REQUIRED_INFO");
  assert.ok(detected, "expected a B07 risk exception to have been created for this property");
  assert.equal(detected!.severity, "AT_RISK");
  assert.equal(detected!.dismissible, false);
  assert.ok(["OPEN", "REOPENED"].includes(detected!.status));

  // Fix the condition, but only exercise the event-driven path directly
  // (never the scheduled sweep) — engine.ts's own module comment documents
  // that this path deliberately does NOT auto-resolve, leaving that solely
  // to the scheduled sweep's full-pass evidence. Prove it: the exception
  // must still be open immediately afterward.
  await db.update(properties).set({ suburb: "Testville" }).where(eq(properties.id, propertyId));
  const event = await publishTriggeringEvent({ eventType: "LISTING_LIVE", propertyId });
  await handleExceptionDomainEvent(event);

  const stillOpen = await fetchException(detected!.id);
  assert.ok(["OPEN", "REOPENED", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_EXTERNAL"].includes(stillOpen.status), "the event-driven path must never auto-resolve");

  // Now the scheduled sweep runs its full pass and genuinely observes the
  // condition is gone — this IS authoritative evidence (Build Instructions
  // §3), so it auto-resolves.
  await scanOrRetry("MANUAL");
  const resolved = await fetchException(detected!.id);
  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.resolutionMethod, "AUTO");
  assert.deepEqual(resolved.resolutionEvidence, { kind: "RULE_CONDITION_CLEARED", ruleId: "B07_LISTING_LIVE_MISSING_REQUIRED_INFO", ruleVersion: 1 });
});

// ---------------------------------------------------------------------
// Scenario 2 — CRITICAL: C13_MULTIPLE_OFFERS_ACCEPTED_FOR_PROPERTY.
// ---------------------------------------------------------------------

test("CRITICAL scenario: two offers independently marked Accepted for one property is detected, cannot be manually overridden, and auto-resolves once corrected", async () => {
  const { propertyId, offerId: firstOfferId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: "1 Critical Scenario Rd" });

  // Insert the second "Accepted" offer directly at the data layer rather
  // than through POST /api/offers/by-property/:id. By this point the
  // property has already moved out of "Listed" (the first offer's
  // acceptance advanced its workflowStage), so the real route's own guard
  // — "Offers can only be recorded while the property is live and not
  // already under an accepted offer" (src/lib/offers.ts) — correctly
  // refuses a second offer there, the same way POST /offers/:id/accept
  // auto-declines sibling offers. Both of those app-level chokepoints
  // exist to prevent exactly this state, which is exactly what makes it a
  // data-integrity anomaly outside the app's normal write paths — the
  // class of condition C13 exists to catch — so this fixture simulates it
  // with a direct DB write for both offer creation and its Accepted
  // status, standing in for that gap (Build Instructions §10).
  const [secondOffer] = await db
    .insert(offers)
    .values({ propertyId, offerPriceCents: 81000000, status: "Accepted" })
    .returning();
  const secondOfferId = secondOffer!.id;

  await scanOrRetry("MANUAL");

  const rows = await db.select().from(riskExceptions).where(eq(riskExceptions.propertyId, propertyId));
  const critical = rows.find((r) => r.ruleId === "C13_MULTIPLE_OFFERS_ACCEPTED_FOR_PROPERTY");
  assert.ok(critical, "expected a C13 exception for this property");
  assert.equal(critical!.severity, "CRITICAL");
  assert.equal(critical!.dismissible, false);
  const offerIdMeta = String((critical!.metadata as Record<string, unknown> | null)?.offerId ?? "");
  assert.ok(offerIdMeta.includes(String(firstOfferId)));
  assert.ok(offerIdMeta.includes(String(secondOfferId)));

  // §14: a CRITICAL, non-dismissible exception can never be closed by a
  // human just asserting it's fine — only by correcting the underlying
  // record through its authorised pathway.
  await assert.rejects(
    () => resolveExceptionManually(critical!.id, A.brokerageId, { id: A.admin.user.id, role: A.admin.user.role }, "Looks fine to me"),
    (err: unknown) => {
      assert.ok(err instanceof RiskExceptionError);
      assert.equal((err as RiskExceptionError).reason, "REQUIRES_AUTHORITATIVE_EVIDENCE");
      return true;
    },
  );

  // Correct the anomaly through a direct data fix (standing in for the
  // authorised pathway — decline the erroneous duplicate) and confirm the
  // next sweep auto-resolves it from real, re-derived evidence.
  await db.update(offers).set({ status: "Declined" }).where(eq(offers.id, secondOfferId));
  await scanOrRetry("MANUAL");
  const resolved = await fetchException(critical!.id);
  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.resolutionMethod, "AUTO");
});

// ---------------------------------------------------------------------
// Scan orchestration.
// ---------------------------------------------------------------------

test("runScheduledScan refuses to start a second sweep while one is already RUNNING and not stale", async () => {
  const [fakeRun] = await db.insert(riskExceptionScanRuns).values({ status: "RUNNING", trigger: "MANUAL" }).returning();
  try {
    const result = await runScheduledScan("MANUAL");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.skippedReason, new RegExp(fakeRun!.id));
    }
  } finally {
    await db.update(riskExceptionScanRuns).set({ status: "COMPLETED", completedAt: new Date() }).where(eq(riskExceptionScanRuns.id, fakeRun!.id));
  }
});

test("a completed scan run records its summary counts and evaluates every registered rule at least once", async () => {
  const summary = await scanOrRetry("MANUAL");
  assert.ok(summary.brokeragesScanned >= 1);
  assert.ok(summary.rulesEvaluated >= RISK_RULES.length);

  const [row] = await db.select().from(riskExceptionScanRuns).where(eq(riskExceptionScanRuns.id, summary.scanRunId));
  assert.ok(row);
  assert.equal(row!.status, "COMPLETED");
  assert.equal(row!.rulesEvaluated, summary.rulesEvaluated);
});

test("a rule that throws during a scheduled scan does not stop sibling rules, records EVALUATION_FAILED, and never auto-resolves that rule's already-open exceptions from a failed pass", async () => {
  const propertyId = await createProperty(A.agent.cookie, "1 Throwing Rule Isolation Rd");
  const throwingRuleId = `TEST_THROWING_RULE_${Date.now()}`;

  const preexisting = await createOrUpdateException(
    {
      ruleId: throwingRuleId,
      ruleVersion: 1,
      category: "WORKFLOW_OPERATIONAL",
      severity: "ATTENTION",
      title: "Fixture for throwing-rule isolation test",
      problemDescription: "n/a",
      businessImpact: "n/a",
      detectedCause: "n/a",
      ownerType: "UNASSIGNED_QUEUE",
      ownerUserId: null,
      propertyId,
      transactionId: null,
      dueAt: null,
      escalatesAt: null,
      recommendedAction: "n/a",
      resolutionRequirements: "n/a",
      dismissible: true,
      sourceRecordType: "property",
      sourceRecordId: String(propertyId),
      dedupKey: `${throwingRuleId}:${A.brokerageId}:fixture`,
      recurrenceMode: "REOPEN",
      requiresFinancialEntitlement: false,
    },
    A.brokerageId,
    propertyId,
    null,
    newCorrelationId(),
    null,
  );

  const throwingRule: RiskRule = {
    ruleId: throwingRuleId,
    version: 1,
    category: "WORKFLOW_OPERATIONAL",
    name: "Test throwing rule",
    description: "Always throws — used to test evaluation-failure isolation.",
    triggerEventTypes: [],
    async scanBrokerage() {
      throw new Error("synthetic failure for engine.test.ts");
    },
  };
  RISK_RULES.push(throwingRule);
  try {
    const summary = await scanOrRetry("MANUAL");
    assert.ok(summary.errors >= 1, "the throwing rule must be counted as an evaluation error");
    assert.ok(summary.rulesEvaluated >= RISK_RULES.length, "the loop must not stop early when one rule throws");

    const row = await fetchException(preexisting.exception.id);
    assert.equal(row.status, "OPEN", "a failed evaluation must never auto-resolve this rule's open exceptions");

    const transitions = await db.select().from(riskExceptionTransitions).where(eq(riskExceptionTransitions.exceptionId, preexisting.exception.id));
    assert.ok(transitions.some((t) => t.transitionType === "EVALUATION_FAILED"));
  } finally {
    const idx = RISK_RULES.indexOf(throwingRule);
    if (idx >= 0) RISK_RULES.splice(idx, 1);
  }
});
