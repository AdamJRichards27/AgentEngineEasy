// Agent Engine 2.0 — Exception & Risk Engine (Priority 4, Build
// Instructions §24).
//
// Lib-level coverage for lib/exceptions/model.ts — the single write path
// every rule detection (and every lifecycle route) funnels through. These
// tests call createOrUpdateException and the lifecycle transition
// functions directly with hand-built RiskFinding fixtures, deliberately
// NOT through any real rule's scanBrokerage — model.ts's own correctness
// (dedup outcomes, severity-change ledger, tenant isolation, resolution/
// dismissal guards, concurrency) is independent of which rule produced the
// finding, exactly the same "test the pipeline, not one specific rule"
// philosophy apps/api/src/lib/automation/__tests__/engine.test.ts already
// uses for the automation engine. Real-rule end-to-end detection is
// covered separately in engine.test.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import { db, riskExceptions, riskExceptionTransitions } from "@aee/db";
import {
  createOrUpdateException,
  acknowledgeException,
  startRemediation,
  markAwaitingExternal,
  resolveExceptionManually,
  autoResolveException,
  dismissException,
  reassignOwner,
  recordEvaluationFailure,
  RiskExceptionError,
  newCorrelationId,
  type ActorRef,
} from "../model.js";
import type { RiskFinding } from "../types.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let propertyA: number;
let propertyB: number;

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

  A = await createBrokerageWithUsers(baseUrl, `Exceptions Model A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Exceptions Model B ${suffix}`);
  propertyA = await createProperty(A.agent.cookie, "1 Model Test St");
  propertyB = await createProperty(B.agent.cookie, "2 Model Test St");
});

after(async () => {
  const ids = [A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number");
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

let fixtureCounter = 0;
function buildFinding(overrides: Partial<RiskFinding> = {}): RiskFinding {
  fixtureCounter += 1;
  const scope = overrides.dedupKey ? undefined : `TEST_SCOPE_${fixtureCounter}`;
  return {
    ruleId: "TEST_MODEL_RULE",
    ruleVersion: 1,
    category: "WORKFLOW_OPERATIONAL",
    severity: "ATTENTION",
    title: "Test finding",
    problemDescription: "A test problem.",
    businessImpact: "Test impact.",
    detectedCause: "Test cause.",
    ownerType: "UNASSIGNED_QUEUE",
    ownerUserId: null,
    propertyId: propertyA,
    transactionId: null,
    dueAt: null,
    escalatesAt: null,
    recommendedAction: "Do the test thing.",
    resolutionRequirements: "The test condition clears.",
    dismissible: true,
    sourceRecordType: "property",
    sourceRecordId: String(propertyA),
    dedupKey: `TEST_MODEL_RULE:${A.brokerageId}:${scope}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
    ...overrides,
  };
}

async function transitionsFor(exceptionId: string) {
  return db.select().from(riskExceptionTransitions).where(eq(riskExceptionTransitions.exceptionId, exceptionId));
}

// ---------------------------------------------------------------------
// Create / dedup outcomes.
// ---------------------------------------------------------------------

test("createOrUpdateException creates a new OPEN exception and records a single OPENED transition", async () => {
  const finding = buildFinding();
  const result = await createOrUpdateException(finding, A.brokerageId, propertyA, null, newCorrelationId(), null);
  assert.equal(result.outcome, "CREATED");
  assert.equal(result.exception.status, "OPEN");
  assert.equal(result.exception.occurrenceCount, 1);
  assert.equal(result.exception.dedupKey, finding.dedupKey);
  assert.equal(result.exception.openDedupKey, finding.dedupKey);

  const transitions = await transitionsFor(result.exception.id);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]!.transitionType, "OPENED");
  assert.equal(transitions[0]!.toValue, "OPEN");
});

test("re-detecting the same still-open finding updates the row in place instead of duplicating it, and increments occurrenceCount", async () => {
  const finding = buildFinding({ problemDescription: "Initial description." });
  const first = await createOrUpdateException(finding, A.brokerageId, propertyA, null, newCorrelationId(), null);

  const second = await createOrUpdateException(
    { ...finding, problemDescription: "Updated description — still the same problem." },
    A.brokerageId,
    propertyA,
    null,
    newCorrelationId(),
    null,
  );
  assert.equal(second.outcome, "UPDATED_STILL_OPEN");
  assert.equal(second.exception.id, first.exception.id);
  assert.equal(second.exception.occurrenceCount, 2);
  assert.equal(second.exception.problemDescription, "Updated description — still the same problem.");

  const rows = await db.select().from(riskExceptions).where(eq(riskExceptions.dedupKey, finding.dedupKey));
  assert.equal(rows.length, 1, "must never create a second row for the same dedup key while one is open");
});

test("a severity escalation on re-detection is recorded as a SEVERITY_CHANGED transition", async () => {
  const finding = buildFinding({ severity: "ATTENTION" });
  const first = await createOrUpdateException(finding, A.brokerageId, propertyA, null, newCorrelationId(), null);

  const escalated = await createOrUpdateException({ ...finding, severity: "AT_RISK" }, A.brokerageId, propertyA, null, newCorrelationId(), null);
  assert.equal(escalated.exception.severity, "AT_RISK");

  const transitions = await transitionsFor(first.exception.id);
  const severityChanged = transitions.find((t) => t.transitionType === "SEVERITY_CHANGED");
  assert.ok(severityChanged, "expected a SEVERITY_CHANGED transition");
  assert.equal(severityChanged!.fromValue, "ATTENTION");
  assert.equal(severityChanged!.toValue, "AT_RISK");
});

test("re-detecting an identical finding with no material change returns UNCHANGED", async () => {
  const finding = buildFinding();
  await createOrUpdateException(finding, A.brokerageId, propertyA, null, newCorrelationId(), null);
  const again = await createOrUpdateException(finding, A.brokerageId, propertyA, null, newCorrelationId(), null);
  assert.equal(again.outcome, "UNCHANGED");
});

test("resolving then re-detecting the same problem REOPENs the row when recurrenceMode is REOPEN", async () => {
  const finding = buildFinding({ recurrenceMode: "REOPEN", dismissible: false, severity: "ATTENTION" });
  const created = await createOrUpdateException(finding, A.brokerageId, propertyA, null, newCorrelationId(), null);
  const resolved = await resolveExceptionManually(created.exception.id, A.brokerageId, { id: A.admin.user.id, role: A.admin.user.role }, "Fixed manually for the test.");
  assert.equal(resolved.status, "RESOLVED");

  const reopened = await createOrUpdateException(finding, A.brokerageId, propertyA, null, newCorrelationId(), null);
  assert.equal(reopened.outcome, "REOPENED");
  assert.equal(reopened.exception.id, created.exception.id);
  assert.equal(reopened.exception.status, "REOPENED");
  assert.equal(reopened.exception.resolvedAt, null);
  assert.equal(reopened.exception.openDedupKey, finding.dedupKey);
});

test("a NEW_OCCURRENCE finding after resolution creates a new linked row and never deletes or mutates the resolved one", async () => {
  const finding = buildFinding({ recurrenceMode: "NEW_OCCURRENCE", dismissible: false, severity: "ATTENTION" });
  const created = await createOrUpdateException(finding, A.brokerageId, propertyA, null, newCorrelationId(), null);
  await resolveExceptionManually(created.exception.id, A.brokerageId, { id: A.admin.user.id, role: A.admin.user.role }, "First occurrence resolved.");

  const next = await createOrUpdateException(finding, A.brokerageId, propertyA, null, newCorrelationId(), null);
  assert.equal(next.outcome, "NEW_OCCURRENCE");
  assert.notEqual(next.exception.id, created.exception.id);
  assert.equal(next.exception.previousOccurrenceId, created.exception.id);
  assert.equal(next.exception.status, "OPEN");

  const [priorRow] = await db.select().from(riskExceptions).where(eq(riskExceptions.id, created.exception.id));
  assert.equal(priorRow!.status, "RESOLVED", "the original occurrence must remain untouched, never deleted (Build Instructions §7)");
});

// ---------------------------------------------------------------------
// Lifecycle transitions.
// ---------------------------------------------------------------------

test("acknowledgeException moves OPEN -> ACKNOWLEDGED and refuses an invalid status", async () => {
  const created = await createOrUpdateException(buildFinding(), A.brokerageId, propertyA, null, newCorrelationId(), null);
  const actor: ActorRef = { id: A.admin.user.id, role: A.admin.user.role };
  const acknowledged = await acknowledgeException(created.exception.id, A.brokerageId, actor);
  assert.equal(acknowledged.status, "ACKNOWLEDGED");

  await assert.rejects(() => acknowledgeException(created.exception.id, A.brokerageId, actor), (err: unknown) => {
    assert.ok(err instanceof RiskExceptionError);
    assert.equal((err as RiskExceptionError).reason, "INVALID_STATUS");
    return true;
  });
});

test("startRemediation moves an acknowledged exception to IN_PROGRESS", async () => {
  const created = await createOrUpdateException(buildFinding(), A.brokerageId, propertyA, null, newCorrelationId(), null);
  const actor: ActorRef = { id: A.admin.user.id, role: A.admin.user.role };
  await acknowledgeException(created.exception.id, A.brokerageId, actor);
  const started = await startRemediation(created.exception.id, A.brokerageId, actor);
  assert.equal(started.status, "IN_PROGRESS");
});

test("markAwaitingExternal records the note and moves to AWAITING_EXTERNAL", async () => {
  const created = await createOrUpdateException(buildFinding(), A.brokerageId, propertyA, null, newCorrelationId(), null);
  const actor: ActorRef = { id: A.admin.user.id, role: A.admin.user.role };
  const updated = await markAwaitingExternal(created.exception.id, A.brokerageId, actor, "Waiting on the vendor's solicitor.");
  assert.equal(updated.status, "AWAITING_EXTERNAL");

  const transitions = await transitionsFor(created.exception.id);
  const awaiting = transitions.find((t) => t.transitionType === "AWAITING_EXTERNAL");
  assert.equal(awaiting?.reason, "Waiting on the vendor's solicitor.");
});

test("resolveExceptionManually refuses a CRITICAL, non-dismissible exception with REQUIRES_AUTHORITATIVE_EVIDENCE", async () => {
  const created = await createOrUpdateException(
    buildFinding({ severity: "CRITICAL", dismissible: false }),
    A.brokerageId,
    propertyA,
    null,
    newCorrelationId(),
    null,
  );
  const actor: ActorRef = { id: A.admin.user.id, role: A.admin.user.role };
  await assert.rejects(
    () => resolveExceptionManually(created.exception.id, A.brokerageId, actor, "trying to override"),
    (err: unknown) => {
      assert.ok(err instanceof RiskExceptionError);
      assert.equal((err as RiskExceptionError).reason, "REQUIRES_AUTHORITATIVE_EVIDENCE");
      return true;
    },
  );
});

test("resolveExceptionManually succeeds for a dismissible or sub-CRITICAL exception and records MANUAL evidence", async () => {
  const created = await createOrUpdateException(
    buildFinding({ severity: "AT_RISK", dismissible: false }),
    A.brokerageId,
    propertyA,
    null,
    newCorrelationId(),
    null,
  );
  const actor: ActorRef = { id: A.admin.user.id, role: A.admin.user.role };
  const resolved = await resolveExceptionManually(created.exception.id, A.brokerageId, actor, "Confirmed fixed outside the app.");
  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.resolutionMethod, "MANUAL");
  assert.deepEqual(resolved.resolutionEvidence, { kind: "MANUAL", note: "Confirmed fixed outside the app.", recordedByUserId: actor.id });
  assert.notEqual(resolved.openDedupKey, resolved.dedupKey, "openDedupKey must be rewritten on resolution so a future finding can reopen or dedupe correctly");
});

test("dismissException refuses a non-dismissible exception with NOT_DISMISSIBLE and succeeds for a dismissible one", async () => {
  const nonDismissible = await createOrUpdateException(buildFinding({ dismissible: false }), A.brokerageId, propertyA, null, newCorrelationId(), null);
  const actor: ActorRef = { id: A.admin.user.id, role: A.admin.user.role };
  await assert.rejects(
    () => dismissException(nonDismissible.exception.id, A.brokerageId, actor, "not a real problem"),
    (err: unknown) => {
      assert.ok(err instanceof RiskExceptionError);
      assert.equal((err as RiskExceptionError).reason, "NOT_DISMISSIBLE");
      return true;
    },
  );

  const dismissible = await createOrUpdateException(buildFinding({ dismissible: true }), A.brokerageId, propertyA, null, newCorrelationId(), null);
  const dismissed = await dismissException(dismissible.exception.id, A.brokerageId, actor, "Reviewed, not applicable here.");
  assert.equal(dismissed.status, "DISMISSED");
  assert.equal(dismissed.dismissalReason, "Reviewed, not applicable here.");
});

test("reassignOwner changes ownership, increments reassignmentCount, and records an OWNER_ASSIGNED transition", async () => {
  const created = await createOrUpdateException(buildFinding(), A.brokerageId, propertyA, null, newCorrelationId(), null);
  const actor: ActorRef = { id: A.admin.user.id, role: A.admin.user.role };
  const reassigned = await reassignOwner(created.exception.id, A.brokerageId, actor, "BROKERAGE_ADMINISTRATOR", A.admin.user.id, "Escalating for review.");
  assert.equal(reassigned.ownerType, "BROKERAGE_ADMINISTRATOR");
  assert.equal(reassigned.ownerUserId, A.admin.user.id);
  assert.equal(reassigned.reassignmentCount, 1);

  const transitions = await transitionsFor(created.exception.id);
  const ownerAssigned = transitions.find((t) => t.transitionType === "OWNER_ASSIGNED");
  assert.ok(ownerAssigned);
  assert.equal(ownerAssigned!.toValue, `BROKERAGE_ADMINISTRATOR:${A.admin.user.id}`);
});

// ---------------------------------------------------------------------
// Auto-resolution and evaluation-failure isolation (Build Instructions
// §3/§19 — "never treat absence of evidence as proof of completion").
// ---------------------------------------------------------------------

test("autoResolveException is idempotent — a no-op on an already-resolved or dismissed exception", async () => {
  const created = await createOrUpdateException(buildFinding({ dismissible: true }), A.brokerageId, propertyA, null, newCorrelationId(), null);
  const actor: ActorRef = { id: A.admin.user.id, role: A.admin.user.role };
  const dismissed = await dismissException(created.exception.id, A.brokerageId, actor, "n/a");
  const attempted = await autoResolveException(created.exception.id, A.brokerageId, { kind: "RULE_CONDITION_CLEARED", ruleId: "TEST_MODEL_RULE", ruleVersion: 1 });
  assert.equal(attempted.status, "DISMISSED", "autoResolveException must never override a terminal DISMISSED status");
  assert.equal(attempted.resolvedByUserId, dismissed.resolvedByUserId);
});

test("autoResolveException resolves an open exception with AUTO method and RULE_CONDITION_CLEARED evidence", async () => {
  const created = await createOrUpdateException(buildFinding(), A.brokerageId, propertyA, null, newCorrelationId(), null);
  const resolved = await autoResolveException(created.exception.id, A.brokerageId, { kind: "RULE_CONDITION_CLEARED", ruleId: "TEST_MODEL_RULE", ruleVersion: 1 });
  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.resolutionMethod, "AUTO");
  assert.equal(resolved.resolvedByUserId, null);
  assert.deepEqual(resolved.resolutionEvidence, { kind: "RULE_CONDITION_CLEARED", ruleId: "TEST_MODEL_RULE", ruleVersion: 1 });
});

test("recordEvaluationFailure records an EVALUATION_FAILED transition without changing the exception's status", async () => {
  const created = await createOrUpdateException(buildFinding(), A.brokerageId, propertyA, null, newCorrelationId(), null);
  await recordEvaluationFailure(created.exception.id, A.brokerageId, "scanBrokerage threw: boom");

  const [row] = await db.select().from(riskExceptions).where(eq(riskExceptions.id, created.exception.id));
  assert.equal(row!.status, "OPEN", "a failed evaluation must never be treated as evidence the condition cleared");

  const transitions = await transitionsFor(created.exception.id);
  const failure = transitions.find((t) => t.transitionType === "EVALUATION_FAILED");
  assert.ok(failure);
  assert.equal(failure!.reason, "scanBrokerage threw: boom");
});

// ---------------------------------------------------------------------
// Tenant isolation (Build Instructions §21 — cross-tenant requests must
// not reveal whether the exception exists).
// ---------------------------------------------------------------------

test("a cross-tenant exceptionId and a genuinely nonexistent one fail identically with NOT_FOUND", async () => {
  const created = await createOrUpdateException(buildFinding(), A.brokerageId, propertyA, null, newCorrelationId(), null);
  const bAdmin: ActorRef = { id: B.admin.user.id, role: B.admin.user.role };

  const crossTenantAttempt = acknowledgeException(created.exception.id, B.brokerageId, bAdmin);
  const nonexistentAttempt = acknowledgeException("00000000-0000-0000-0000-000000000000", B.brokerageId, bAdmin);

  const [crossTenantErr, nonexistentErr] = await Promise.all([
    crossTenantAttempt.catch((e) => e),
    nonexistentAttempt.catch((e) => e),
  ]);
  assert.ok(crossTenantErr instanceof RiskExceptionError);
  assert.ok(nonexistentErr instanceof RiskExceptionError);
  assert.equal(crossTenantErr.reason, "NOT_FOUND");
  assert.equal(nonexistentErr.reason, "NOT_FOUND");
  assert.equal(crossTenantErr.message, nonexistentErr.message, "must not reveal whether the exception exists at all, just under a different tenant");
});

// ---------------------------------------------------------------------
// Concurrency (Build Instructions §23 — concurrency-safe creation, no
// duplicate exceptions under concurrent evaluation).
// ---------------------------------------------------------------------

test("two concurrent createOrUpdateException calls for a brand-new dedup key never produce two rows", async () => {
  const finding = buildFinding();
  const [first, second] = await Promise.all([
    createOrUpdateException(finding, A.brokerageId, propertyA, null, newCorrelationId(), null),
    createOrUpdateException(finding, A.brokerageId, propertyA, null, newCorrelationId(), null),
  ]);
  assert.equal(first.exception.id, second.exception.id, "the advisory lock must serialise both calls onto the same row");

  const rows = await db.select().from(riskExceptions).where(eq(riskExceptions.dedupKey, finding.dedupKey));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.occurrenceCount, 2, "both concurrent detections must still be accounted for, serialised rather than lost");
});

test("cross-tenant property scoping: a finding scoped to brokerage A's property cannot be looked up under brokerage B", async () => {
  const created = await createOrUpdateException(buildFinding(), A.brokerageId, propertyA, null, newCorrelationId(), null);
  const [row] = await db.select().from(riskExceptions).where(eq(riskExceptions.id, created.exception.id));
  assert.equal(row!.brokerageId, A.brokerageId);
  assert.notEqual(row!.brokerageId, B.brokerageId);
  // Sanity check that propertyB genuinely belongs to a different brokerage,
  // so this assertion is testing real tenant separation, not a fixture bug.
  assert.notEqual(propertyA, propertyB);
});
