// AI Governance, Authority & Action Control Architecture -- Stage G10.
//
// Security and regression tests for the governance system built in
// Stages G2-G9, covering the explicit test list in Build Instructions
// Part 25/26: permission restriction, org isolation, entitlement
// restriction, restricted-action blocking, approval requirement, approval
// ownership, duplicate execution, tampered payload, prompt injection,
// workflow overwrite prevention, and audit completeness.
//
// Integration tests against a real database, following the same pattern
// as apps/api/src/lib/entitlements/__tests__/*.test.ts: every test creates
// its own throwaway brokerage/user/property fixtures and tears them down
// in t.after(), so tests never interfere with each other or with real data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  brokerages,
  users,
  properties,
  aiActionRequests,
  workflowChangeProposals,
  automationAttentionItems,
  auditLogs,
  type UserRole,
} from "@aee/db";
import { configureEventStore } from "@aee/events";
import type { DomainEvent, EventStore, PublishEventInput } from "@aee/events";
import { evaluateAIAction, type PolicyActor } from "../policyEngine.js";
import {
  proposeAIAction,
  getAIActionRequest,
  getAIActionRequestForActor,
  approveAIActionRequest,
  rejectAIActionRequest,
  hashInputPayload,
  verifyInputPayloadHash,
  LEGACY_UNKEYED_HASH_SUNSET,
  LEGACY_UNKEYED_HASH_WINDOW_MS,
  recoverStuckExecutingActionRequests,
  STUCK_EXECUTING_RECOVERED_MESSAGE,
} from "../actionRequests.js";
import { executeAIAction, executeAIActionAsSystem, LATE_COMPLETION_AFTER_RECOVERY_MESSAGE } from "../executionGateway.js";
import { ACTION_REGISTRY, getActionDefinition } from "../actions/registry.js";
import { classifyActionFailure } from "../../automation/operations.js";
import { assertNoProtectedOperationsRegistered } from "../protectedOperations.js";
import { riskTierForLevel } from "../authority.js";

// ---------------------------------------------------------------------------
// In-memory event store, so "audit completeness" tests can assert on what
// was actually published without needing a real event-store backend.
// ---------------------------------------------------------------------------
class InMemoryEventStore implements EventStore {
  events: DomainEvent[] = [];
  async append(input: PublishEventInput): Promise<DomainEvent> {
    const event = {
      ...input,
      id: randomUUID(),
      recordedAt: new Date(),
      processingStatus: "PROCESSED",
      handlerErrors: null,
      attemptCount: 1,
      eventVersion: input.eventVersion ?? 1,
    } as DomainEvent;
    this.events.push(event);
    return event;
  }
  async updateProcessingStatus(
    id: string,
    status: DomainEvent["processingStatus"],
    handlerErrors: DomainEvent["handlerErrors"],
  ): Promise<void> {
    const event = this.events.find((e) => e.id === id);
    if (event) {
      event.processingStatus = status;
      event.handlerErrors = handlerErrors;
    }
  }
}
const testEventStore = new InMemoryEventStore();
configureEventStore(testEventStore);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
async function createBrokerage(name: string): Promise<number> {
  const [row] = await db.insert(brokerages).values({ name }).returning();
  return row.id;
}

async function createUser(brokerageId: number, role: UserRole): Promise<number> {
  const suffix = randomUUID();
  const [row] = await db
    .insert(users)
    .values({ authProviderId: `test-${suffix}`, email: `test-${suffix}@example.com`, role, brokerageId })
    .returning();
  return row.id;
}

async function createProperty(brokerageId: number, agentId: number): Promise<number> {
  const [row] = await db
    .insert(properties)
    .values({ brokerageId, agentId, formattedAddress: "1 Test St, Testville" })
    .returning();
  return row.id;
}

async function cleanupBrokerage(brokerageId: number): Promise<void> {
  await db.delete(aiActionRequests).where(eq(aiActionRequests.brokerageId, brokerageId));
  // F4.0: REQUEST_ACTION_APPROVAL executions raise an attention item that
  // references the fixture property (non-cascading FK).
  await db.delete(automationAttentionItems).where(eq(automationAttentionItems.brokerageId, brokerageId));
  await db.delete(workflowChangeProposals).where(eq(workflowChangeProposals.brokerageId, brokerageId));
  await db.delete(properties).where(eq(properties.brokerageId, brokerageId));
  // F4.0: late-completion/failure-after-recovery audits are tenant-attributed.
  await db.delete(auditLogs).where(eq(auditLogs.brokerageId, brokerageId));
  await db.delete(users).where(eq(users.brokerageId, brokerageId));
  await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
}

function actorOf(id: number, role: UserRole | string, brokerageId: number): PolicyActor {
  return { id, role, brokerageId };
}

// ---------------------------------------------------------------------------
// 1. Permission restriction (Golden Rule)
// ---------------------------------------------------------------------------
test("Golden Rule: a role outside the action's allowedRoles is denied, even though the action itself is enabled", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - permission restriction");
  t.after(() => cleanupBrokerage(brokerageId));
  const pitCrewId = await createUser(brokerageId, "Pit Crew");

  const decision = await evaluateAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(pitCrewId, "Pit Crew", brokerageId),
    actorType: "USER",
    rawInput: { propertyId: 1, note: "test" },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "ROLE_FORBIDDEN");
});

// ---------------------------------------------------------------------------
// 2. Org (tenant) isolation
// ---------------------------------------------------------------------------
test("org isolation: a request created in one brokerage is invisible when looked up under another brokerage's id", async (t) => {
  const brokerageA = await createBrokerage("Gov Test - tenant A");
  const brokerageB = await createBrokerage("Gov Test - tenant B");
  t.after(() => Promise.all([cleanupBrokerage(brokerageA), cleanupBrokerage(brokerageB)]));

  const agentA = await createUser(brokerageA, "Agent");
  const propertyA = await createProperty(brokerageA, agentA);

  const { request, decision } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentA, "Agent", brokerageA),
    actorType: "USER",
    rawInput: { propertyId: propertyA, note: "tenant isolation test" },
  });
  assert.equal(decision.allowed, true);
  assert.ok(request);

  const seenFromOwnTenant = await getAIActionRequest(request!.id, brokerageA);
  assert.ok(seenFromOwnTenant);

  const seenFromOtherTenant = await getAIActionRequest(request!.id, brokerageB);
  assert.equal(seenFromOtherTenant, null);
});

test("org isolation: execution fails when the proposed resource belongs to a different brokerage than the request", async (t) => {
  const brokerageA = await createBrokerage("Gov Test - cross-tenant resource A");
  const brokerageB = await createBrokerage("Gov Test - cross-tenant resource B");
  t.after(() => Promise.all([cleanupBrokerage(brokerageA), cleanupBrokerage(brokerageB)]));

  const agentA = await createUser(brokerageA, "Agent");
  const agentB = await createUser(brokerageB, "Agent");
  const propertyB = await createProperty(brokerageB, agentB);

  const { request, decision } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentA, "Agent", brokerageA),
    actorType: "USER",
    rawInput: { propertyId: propertyB, note: "should never be written" },
  });
  assert.equal(decision.allowed, true);
  assert.ok(request);
  assert.equal(request!.status, "APPROVED");

  const result = await executeAIAction(request!.id, brokerageA, actorOf(agentA, "Agent", brokerageA));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "EXECUTION_FAILED");
});

// ---------------------------------------------------------------------------
// 3. Entitlement restriction -- out of scope for the current 3 demo actions
// ---------------------------------------------------------------------------
test(
  "entitlement restriction: no currently registered action requires a paid entitlement",
  { skip: "Per Part 24 (small demonstration set only), none of the 3 registered actions set requiredEntitlementKey. The routing to explainEntitlementDecision()/requireEntitlement() is implemented in policyEngine.ts and covered directly by apps/api/src/lib/entitlements/__tests__; this placeholder documents the gap rather than fabricating an entitlement-gated demo action out of scope." },
  async () => {},
);

// ---------------------------------------------------------------------------
// 4. Restricted-action blocking
// ---------------------------------------------------------------------------
test("restricted-action blocking: a RESTRICTED-tier (riskLevel 4) action fails the registry startup self-check", () => {
  assert.throws(
    () => assertNoProtectedOperationsRegistered([{ actionKey: "SOME_DEMO_ACTION", riskLevel: 4 }]),
    /RESTRICTED/,
  );
});

test("restricted-action blocking: an actionKey matching a protected-operation fragment fails the registry startup self-check", () => {
  assert.throws(
    () => assertNoProtectedOperationsRegistered([{ actionKey: "CHANGE_USER_ROLE", riskLevel: 0 }]),
    /forbidden fragment/,
  );
});

test("restricted-action blocking: riskTierForLevel(4) resolves to RESTRICTED", () => {
  assert.equal(riskTierForLevel(4), "RESTRICTED");
});

// ---------------------------------------------------------------------------
// 4b. Outbound messaging is denied by RULE, not by absence of the feature
// (AE GROW W2-C, B-1).
//
// Before W2-C the denylist covered AML/ledger/entitlement/SQL and friends but
// no messaging fragment at all, so an action registered as e.g.
// "SEND_SMS_TO_CONTACT" with riskLevel 0 passed this self-check and would have
// become automation-invokable the moment a provider was wired up. Each name
// below is the shape a plausible future action would actually take -- the
// point is that the author does not have to remember to set a high riskLevel,
// because the NAME alone is refused.
// ---------------------------------------------------------------------------
const MESSAGING_ACTION_KEYS_THAT_MUST_BE_REFUSED = [
  "SEND_SMS_TO_CONTACT",
  "SMS_VENDOR_DISPATCH",
  "EMAIL_VENDOR_UPDATE",
  "MESSAGE_BUYER_AGENT",
  "NOTIFY_SELLER_OF_OFFER",
  "DIAL_CONTACT_NUMBER",
];

for (const actionKey of MESSAGING_ACTION_KEYS_THAT_MUST_BE_REFUSED) {
  test(`outbound messaging denylist: "${actionKey}" at riskLevel 0 crashes the registry startup self-check`, () => {
    assert.throws(
      () => assertNoProtectedOperationsRegistered([{ actionKey, riskLevel: 0 }]),
      /forbidden fragment/,
      "a send-shaped actionKey must be refused on its NAME, whatever riskLevel its author set",
    );
  });
}

// ---------------------------------------------------------------------------
// 4c. The denylist's KNOWN FALSE POSITIVE, pinned as a contract rather than
// left as a surprise (W2-C remediation).
//
// The fragments match as substrings of the whole key, so a draft-for-review
// action named DRAFT_EMAIL_FOR_REVIEW is refused even though drafting for a
// human is exactly the alternative this module recommends. That behaviour is
// DELIBERATE and was re-confirmed under review: see the long comment in
// protectedOperations.ts for why classification by an author-supplied field
// would be weaker than a name tripwire the author cannot influence. These
// tests exist so the trade is visible and cannot be "fixed" by accident.
// ---------------------------------------------------------------------------
test("the denylist refuses DRAFT_EMAIL_FOR_REVIEW — a known, deliberate false positive", () => {
  assert.throws(
    () => assertNoProtectedOperationsRegistered([{ actionKey: "DRAFT_EMAIL_FOR_REVIEW", riskLevel: 0 }]),
    /forbidden fragment "EMAIL"/,
    "matching is by substring and deliberately does not special-case DRAFT_ — loosening it is a security change, not a cleanup",
  );
});

/** The refusal message for one action key. Fails the test if it is not refused at all. */
function refusalMessageFor(actionKey: string): string {
  try {
    assertNoProtectedOperationsRegistered([{ actionKey, riskLevel: 0 }]);
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail(`"${actionKey}" was expected to be refused by the startup self-check, but was allowed`);
}

test("a messaging refusal names the sanctioned Communications path and a usable alternative name", () => {
  // The P3 this closes: the old message told an engineer the action must
  // never be registered and stopped there, naming no way forward.
  const message = refusalMessageFor("SEND_SMS_TO_CONTACT");

  assert.match(message, /Communications/, "the human-decision path must be named");
  assert.match(message, /DRAFT/, "and drafting for a human must be named as the alternative shape");
  assert.match(
    message,
    /DRAFT_CONTACT_OUTREACH_FOR_REVIEW/,
    "including a concrete key that actually passes this check, since the obvious DRAFT_EMAIL_FOR_REVIEW does not",
  );
});

test("the alternative the error message recommends genuinely passes the check", () => {
  // An error message that suggests a name which is itself refused would be
  // worse than saying nothing. This asserts the recommendation is real.
  assert.doesNotThrow(() =>
    assertNoProtectedOperationsRegistered([{ actionKey: "DRAFT_CONTACT_OUTREACH_FOR_REVIEW", riskLevel: 0 }]),
  );
});

test("a NON-messaging refusal does not offer the Communications path", () => {
  // Pointing an entitlement-escalation attempt at the Communications surface
  // would be nonsense, and a message that says something irrelevant trains
  // people to stop reading it.
  const message = refusalMessageFor("CHANGE_USER_ROLE");

  assert.match(message, /forbidden fragment/);
  assert.ok(!/Communications/.test(message), "guidance must be specific to the category that matched");
});

test("outbound messaging denylist: every currently registered action still passes the startup self-check", () => {
  const registered = Object.values(ACTION_REGISTRY);
  assert.equal(registered.length, 9, "update this test deliberately when the registered action set changes");
  // The real call actions/registry.ts makes at module load. If the messaging
  // fragments false-positived on a legitimate action key, importing the
  // registry at the top of this file would already have crashed the suite --
  // this asserts it explicitly so the reason is obvious rather than implicit.
  assert.doesNotThrow(() => assertNoProtectedOperationsRegistered(registered));
});

// ---------------------------------------------------------------------------
// 5. Approval requirement
// ---------------------------------------------------------------------------
test("approval requirement: a SYSTEM_CHANGE action always requires human approval", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - approval requirement (system change)");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");

  const { request, decision } = await proposeAIAction({
    actionKey: "WORKFLOW_VERSION_ACTIVATE",
    actor: actorOf(adminId, "Brokerage Administrator", brokerageId),
    actorType: "USER",
    rawInput: { proposalId: 999999 },
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
  assert.equal(request!.status, "AWAITING_APPROVAL");
});

test("approval requirement: a LOW-risk EXECUTE action is auto-execute-eligible and skips the human queue", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - approval requirement (auto)");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { request, decision } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, note: "auto-eligible test" },
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, false);
  assert.equal(request!.status, "APPROVED");
});

// ---------------------------------------------------------------------------
// 6. Approval ownership
// ---------------------------------------------------------------------------
test("approval ownership: only a role that could perform the action manually may approve it", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - approval ownership");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");

  const { request } = await proposeAIAction({
    actionKey: "WORKFLOW_VERSION_ACTIVATE",
    actor: actorOf(adminId, "Brokerage Administrator", brokerageId),
    actorType: "USER",
    rawInput: { proposalId: 999999 },
  });
  assert.ok(request);

  // F4.0 D3: a same-brokerage user who is neither the requester nor an
  // admin is refused at the access check first, with the same NOT_FOUND a
  // missing id gets (no ROLE_FORBIDDEN existence oracle).
  const deniedApproval = await approveAIActionRequest(request!.id, brokerageId, actorOf(agentId, "Agent", brokerageId));
  assert.equal(deniedApproval.ok, false);
  assert.equal(deniedApproval.reason, "NOT_FOUND");

  // The requester themself, whose role no longer allows the action (e.g.
  // demoted since proposing), still gets the Golden Rule's role denial.
  const demotedRequester = await approveAIActionRequest(request!.id, brokerageId, actorOf(adminId, "Agent", brokerageId));
  assert.equal(demotedRequester.ok, false);
  assert.equal(demotedRequester.reason, "APPROVER_ROLE_FORBIDDEN");

  const stillWaiting = await getAIActionRequest(request!.id, brokerageId);
  assert.equal(stillWaiting!.status, "AWAITING_APPROVAL");
});

// ---------------------------------------------------------------------------
// 7. No duplicate execution
// ---------------------------------------------------------------------------
test("duplicate execution is prevented: a second execute call on an already-executed request is refused", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - duplicate execution");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { request } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, note: "duplicate execution test" },
  });
  assert.ok(request);

  const first = await executeAIAction(request!.id, brokerageId, actorOf(agentId, "Agent", brokerageId));
  assert.equal(first.ok, true);
  assert.equal(first.request?.status, "COMPLETED");

  const second = await executeAIAction(request!.id, brokerageId, actorOf(agentId, "Agent", brokerageId));
  assert.equal(second.ok, false);
  assert.equal(second.reason, "WRONG_STATUS");
});

// ---------------------------------------------------------------------------
// 8. Tampered payload
// ---------------------------------------------------------------------------
test("tamper protection: a payload altered after proposal is rejected at approval time, not silently approved", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - tamper at approval");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");

  const { request } = await proposeAIAction({
    actionKey: "WORKFLOW_VERSION_ACTIVATE",
    actor: actorOf(adminId, "Brokerage Administrator", brokerageId),
    actorType: "USER",
    rawInput: { proposalId: 999999 },
  });
  assert.ok(request);
  assert.equal(hashInputPayload(request!.inputPayload), request!.inputPayloadHash);

  await db.update(aiActionRequests).set({ inputPayload: { proposalId: 1 } }).where(eq(aiActionRequests.id, request!.id));

  const approval = await approveAIActionRequest(request!.id, brokerageId, actorOf(adminId, "Brokerage Administrator", brokerageId));
  assert.equal(approval.ok, false);
  assert.equal(approval.reason, "PAYLOAD_TAMPERED");

  const after = await getAIActionRequest(request!.id, brokerageId);
  assert.equal(after!.status, "REJECTED");
});

test("tamper protection: a payload altered after auto-approval is rejected at execution time, not silently executed", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - tamper at execution");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { request } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, note: "original note" },
  });
  assert.ok(request);
  assert.equal(request!.status, "APPROVED");

  await db.update(aiActionRequests).set({ inputPayload: { propertyId, note: "tampered note" } }).where(eq(aiActionRequests.id, request!.id));

  const result = await executeAIAction(request!.id, brokerageId, actorOf(agentId, "Agent", brokerageId));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "PAYLOAD_TAMPERED");

  const after = await getAIActionRequest(request!.id, brokerageId);
  assert.equal(after!.status, "FAILED");
});

// ---------------------------------------------------------------------------
// 8b. Keyed (v2) tamper hash — AE GROW Pilot Readiness WP2b
// ---------------------------------------------------------------------------
function sortKeysForTest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysForTest);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sortKeysForTest(v)]));
  }
  return value;
}
// What an attacker WITHOUT the server key can compute: the old, unkeyed format.
function plainSha256ForTest(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortKeysForTest(payload ?? null))).digest("hex");
}

test("WP2b keyed hash: v2-prefixed HMAC, differs from plain SHA-256, key-order independent, and bound to the server key", () => {
  const payload = { propertyId: 7, note: "hello", nested: { b: 2, a: [1, { z: 1, y: 2 }] } };
  const hash = hashInputPayload(payload);
  assert.match(hash, /^v2:[0-9a-f]{64}$/);
  assert.notEqual(hash.slice(3), plainSha256ForTest(payload), "the keyed hash must not equal the unkeyed SHA-256");
  assert.equal(hashInputPayload({ nested: { a: [1, { y: 2, z: 1 }], b: 2 }, note: "hello", propertyId: 7 }), hash);
  assert.notEqual(hashInputPayload({ ...payload, note: "hello!" }), hash);

  const previous = process.env.AI_ACTION_PAYLOAD_HMAC_KEY;
  try {
    process.env.AI_ACTION_PAYLOAD_HMAC_KEY = "wp2b-explicit-test-only-payload-hmac-key-0123456789";
    const explicitKeyHash = hashInputPayload(payload);
    assert.match(explicitKeyHash, /^v2:[0-9a-f]{64}$/);
    assert.notEqual(explicitKeyHash, hash, "the explicit key takes precedence over the SESSION_SECRET-derived key");
    process.env.AI_ACTION_PAYLOAD_HMAC_KEY = "too-short";
    assert.throws(() => hashInputPayload(payload), /AI_ACTION_PAYLOAD_HMAC_KEY must contain at least 32 bytes/);
  } finally {
    if (previous === undefined) delete process.env.AI_ACTION_PAYLOAD_HMAC_KEY;
    else process.env.AI_ACTION_PAYLOAD_HMAC_KEY = previous;
  }
  assert.equal(hashInputPayload(payload), hash);
});

test("WP2b tamper at approval: an attacker without the key who swaps the payload and recomputes plain SHA-256 is rejected", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - WP2b keyless forgery at approval");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const admin = actorOf(adminId, "Brokerage Administrator", brokerageId);

  const { request } = await proposeAIAction({ actionKey: "WORKFLOW_VERSION_ACTIVATE", actor: admin, actorType: "USER", rawInput: { proposalId: 515151 } });
  assert.ok(request);
  assert.match(request!.inputPayloadHash, /^v2:/);
  const forgedPayload = { proposalId: 1 };
  await db.update(aiActionRequests).set({ inputPayload: forgedPayload, inputPayloadHash: plainSha256ForTest(forgedPayload) }).where(eq(aiActionRequests.id, request!.id));

  const approval = await approveAIActionRequest(request!.id, brokerageId, admin);
  assert.equal(approval.ok, false);
  assert.equal(approval.reason, "PAYLOAD_TAMPERED");
  assert.equal((await getAIActionRequest(request!.id, brokerageId))!.status, "REJECTED");
});

test("WP2b tamper at execution: keyless forgeries (plain SHA-256, or plain SHA-256 dressed as v2) are rejected by the Execution Gateway", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - WP2b keyless forgery at execution");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const agent = actorOf(agentId, "Agent", brokerageId);

  for (const format of ["plain", "v2-prefixed-plain"] as const) {
    const { request } = await proposeAIAction({ actionKey: "PROPERTY_NOTE_ADD", actor: agent, actorType: "USER", rawInput: { propertyId, note: `original ${format}` } });
    assert.equal(request!.status, "APPROVED");
    const forgedPayload = { propertyId, note: `forged ${format}` };
    const forgedHash = format === "plain" ? plainSha256ForTest(forgedPayload) : `v2:${plainSha256ForTest(forgedPayload)}`;
    await db.update(aiActionRequests).set({ inputPayload: forgedPayload, inputPayloadHash: forgedHash }).where(eq(aiActionRequests.id, request!.id));

    const result = await executeAIAction(request!.id, brokerageId, agent);
    assert.equal(result.ok, false, format);
    assert.equal(result.reason, "PAYLOAD_TAMPERED", format);
    assert.equal((await getAIActionRequest(request!.id, brokerageId))!.status, "FAILED", format);
  }
});

test("WP2b legacy window: the unkeyed-hash sunset is measured from module load and is short (<= 48h), not a fixed calendar date months away", () => {
  // The legacy path is a deploy-window convenience, not a security control
  // (see actionRequests.ts's comment): it must close itself shortly after
  // deploy. A regression to a hard-coded far-future date would show up here.
  assert.equal(LEGACY_UNKEYED_HASH_WINDOW_MS, 48 * 60 * 60 * 1000);
  const remainingMs = LEGACY_UNKEYED_HASH_SUNSET.getTime() - Date.now();
  assert.ok(remainingMs > 0, "the window must still be open in the process that just loaded the module");
  assert.ok(
    remainingMs <= LEGACY_UNKEYED_HASH_WINDOW_MS,
    `the sunset must be within ${LEGACY_UNKEYED_HASH_WINDOW_MS}ms of module load, got ${remainingMs}ms`,
  );
  // Action requests expire in 24h, so the window must still outlast any real
  // legacy row — otherwise a legitimate pending row would be rejected.
  assert.ok(remainingMs > 24 * 60 * 60 * 1000, "the window must outlast a legacy row's own 24h expiry");
});

test("WP2b legacy compatibility: an unprefixed SHA-256 row created before the upgrade still approves/executes; the same hash on a post-upgrade row or outside the module-load window does not verify", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - WP2b legacy hash");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const agent = actorOf(agentId, "Agent", brokerageId);

  const { request } = await proposeAIAction({ actionKey: "PROPERTY_NOTE_ADD", actor: agent, actorType: "USER", rawInput: { propertyId, note: "legacy row" } });
  assert.equal(request!.status, "APPROVED");
  const legacyHash = plainSha256ForTest(request!.inputPayload);
  // Simulate a row written by the previous release: unkeyed hash, created
  // before this process (and therefore this module) started.
  const legacyCreatedAt = new Date(Date.now() - 60 * 60 * 1000);
  await db.update(aiActionRequests).set({ inputPayloadHash: legacyHash, createdAt: legacyCreatedAt }).where(eq(aiActionRequests.id, request!.id));
  const legacyRow = (await getAIActionRequest(request!.id, brokerageId))!;

  const beforeSunset = new Date(LEGACY_UNKEYED_HASH_SUNSET.getTime() - 1);
  assert.equal(verifyInputPayloadHash(legacyRow, beforeSunset), true, "inside the window a genuine legacy row still verifies");
  assert.equal(verifyInputPayloadHash(legacyRow, new Date()), true, "and it verifies right now, during the deploy window");
  assert.equal(verifyInputPayloadHash(legacyRow, LEGACY_UNKEYED_HASH_SUNSET), false, "the legacy path is dead at the sunset");
  assert.equal(
    verifyInputPayloadHash(legacyRow, new Date(LEGACY_UNKEYED_HASH_SUNSET.getTime() + 60 * 60 * 1000)),
    false,
    "and stays dead afterwards, however old the row claims to be",
  );
  assert.equal(verifyInputPayloadHash({ ...legacyRow, createdAt: new Date(Date.now() + 1_000) }, beforeSunset), false, "an unprefixed hash on a row created after the upgrade is a forgery");
  assert.equal(verifyInputPayloadHash({ ...legacyRow, inputPayload: { propertyId, note: "changed" } }, beforeSunset), false);
  assert.equal(verifyInputPayloadHash({ ...legacyRow, inputPayloadHash: "v3:" + legacyHash }, beforeSunset), false, "unknown hash versions fail closed");

  // End-to-end through the real Execution Gateway (wall clock). The window is
  // measured from module load, so in this process it is open by construction;
  // the branch is kept so the assertion stays honest if that ever changes.
  const result = await executeAIAction(request!.id, brokerageId, agent);
  if (Date.now() < LEGACY_UNKEYED_HASH_SUNSET.getTime()) {
    assert.equal(result.ok, true, `legacy row should still execute, got ${result.reason}`);
    assert.equal(result.request?.status, "COMPLETED");
  } else {
    assert.equal(result.reason, "PAYLOAD_TAMPERED");
  }
});

// ---------------------------------------------------------------------------
// 9. Prompt-injection-style input cannot grant authority
// ---------------------------------------------------------------------------
test("context security: unrecognised fields in the input (e.g. an injected role/authority claim) are stripped, never interpreted", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - injected fields");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const decision = await evaluateAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: {
      propertyId,
      note: "legitimate note",
      role: "Brokerage Administrator",
      allowedRoles: ["Brokerage Administrator"],
      authorityLevel: 5,
      bypassApproval: true,
    },
  });

  assert.equal(decision.allowed, true);
  const parsed = decision.parsedInput as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "role"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "authorityLevel"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "bypassApproval"), false);
});

test("context security: a malformed/injected actor role string is compared literally and denied, never specially interpreted", async () => {
  const decision = await evaluateAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: { id: 1, role: "Agent' OR '1'='1", brokerageId: 1 },
    actorType: "USER",
    rawInput: { propertyId: 1, note: "x" },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "ROLE_FORBIDDEN");
});

test("input validation: a structurally invalid payload is rejected before it ever reaches a domain function", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - invalid input");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");

  const decision = await evaluateAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId: "not-a-number", note: 12345 },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "INPUT_SCHEMA_INVALID");
});

// ---------------------------------------------------------------------------
// 10. Workflow overwrite prevention
// ---------------------------------------------------------------------------
test("workflow overwrite prevention: activating a new version supersedes the old one instead of overwriting it", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - workflow overwrite prevention");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const admin = actorOf(adminId, "Brokerage Administrator", brokerageId);

  async function proposeAndActivateVersion(reason: string): Promise<number> {
    const propose = await proposeAIAction({
      actionKey: "WORKFLOW_CHANGE_PROPOSE",
      actor: admin,
      actorType: "USER",
      rawInput: {
        propertyId: null,
        workflowType: "ReadyToList",
        proposedSteps: [{ stepKey: "step1", label: "Step One", sequence: 1 }],
        changeReason: reason,
      },
    });
    assert.ok(propose.request);
    const proposeExec = await executeAIAction(propose.request!.id, brokerageId, admin);
    assert.equal(proposeExec.ok, true);
    const proposalId = (proposeExec.result as { id: number }).id;

    const activate = await proposeAIAction({
      actionKey: "WORKFLOW_VERSION_ACTIVATE",
      actor: admin,
      actorType: "USER",
      rawInput: { proposalId },
    });
    assert.ok(activate.request);
    const approval = await approveAIActionRequest(activate.request!.id, brokerageId, admin);
    assert.equal(approval.ok, true);
    const activateExec = await executeAIAction(activate.request!.id, brokerageId, admin);
    assert.equal(activateExec.ok, true);
    return proposalId;
  }

  const firstProposalId = await proposeAndActivateVersion("first version");
  const [firstAfterFirstActivation] = await db.select().from(workflowChangeProposals).where(eq(workflowChangeProposals.id, firstProposalId));
  assert.equal(firstAfterFirstActivation.status, "ACTIVE");

  const secondProposalId = await proposeAndActivateVersion("second version, supersedes the first");
  const [firstAfterSecondActivation] = await db.select().from(workflowChangeProposals).where(eq(workflowChangeProposals.id, firstProposalId));
  const [secondAfterSecondActivation] = await db.select().from(workflowChangeProposals).where(eq(workflowChangeProposals.id, secondProposalId));

  assert.equal(firstAfterSecondActivation.status, "SUPERSEDED");
  assert.equal(secondAfterSecondActivation.status, "ACTIVE");
  assert.notEqual(firstProposalId, secondProposalId);
});

// ---------------------------------------------------------------------------
// 11. Audit completeness
// ---------------------------------------------------------------------------
test("audit completeness: every lifecycle transition of an approval-required action publishes its own event", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - audit completeness (approval path)");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const admin = actorOf(adminId, "Brokerage Administrator", brokerageId);
  const eventsBefore = testEventStore.events.length;

  const { request } = await proposeAIAction({
    actionKey: "WORKFLOW_VERSION_ACTIVATE",
    actor: admin,
    actorType: "USER",
    rawInput: { proposalId: 999999 },
  });
  assert.ok(request);

  const rejection = await rejectAIActionRequest(request!.id, brokerageId, admin, "test rejection for audit trail coverage");
  assert.equal(rejection.ok, true);

  const publishedForThisRequest = testEventStore.events
    .slice(eventsBefore)
    .filter((e) => (e.metadata as Record<string, unknown>).requestId === request!.id)
    .map((e) => e.eventType);

  assert.ok(publishedForThisRequest.includes("AI_ACTION_PROPOSED"));
  assert.ok(publishedForThisRequest.includes("AI_ACTION_APPROVAL_REQUIRED"));
  assert.ok(publishedForThisRequest.includes("AI_ACTION_REJECTED"));
});

test("audit completeness: every lifecycle transition of an auto-approved action publishes its own event", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - audit completeness (auto path)");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const eventsBefore = testEventStore.events.length;

  const { request } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, note: "audit trail coverage" },
  });
  assert.ok(request);

  const exec = await executeAIAction(request!.id, brokerageId, actorOf(agentId, "Agent", brokerageId));
  assert.equal(exec.ok, true);

  const publishedForThisRequest = testEventStore.events
    .slice(eventsBefore)
    .filter((e) => (e.metadata as Record<string, unknown>).requestId === request!.id)
    .map((e) => e.eventType);

  assert.ok(publishedForThisRequest.includes("AI_ACTION_PROPOSED"));
  assert.ok(!publishedForThisRequest.includes("AI_ACTION_APPROVAL_REQUIRED"));
  assert.ok(publishedForThisRequest.includes("AI_ACTION_EXECUTED"));
});

// ---------------------------------------------------------------------------
// 12. AE GROW Priority 6 Stage F4.0 — governance hardening (D2/D4)
// ---------------------------------------------------------------------------

function eventsForRequest(requestId: number, since: number): DomainEvent[] {
  return testEventStore.events.slice(since).filter((e) => (e.metadata as Record<string, unknown>).requestId === requestId);
}

// Temporarily wraps a registered action's execute() so a test can count
// (or interleave with) real executions, always restoring the original.
async function withWrappedExecute<T>(
  actionKey: string,
  wrap: (original: (...args: any[]) => Promise<unknown>) => (...args: any[]) => Promise<unknown>,
  body: () => Promise<T>,
): Promise<T> {
  const definition = getActionDefinition(actionKey)!;
  const original = definition.execute;
  definition.execute = wrap(original) as typeof definition.execute;
  try {
    return await body();
  } finally {
    definition.execute = original;
  }
}

test("F4.0 access: a same-brokerage colleague who is neither the requester nor an admin cannot read, approve, reject, or execute the request", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - F4.0 colleague denied");
  t.after(() => cleanupBrokerage(brokerageId));
  const requesterId = await createUser(brokerageId, "Agent");
  const colleagueId = await createUser(brokerageId, "Agent");
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const propertyId = await createProperty(brokerageId, requesterId);
  const requester = actorOf(requesterId, "Agent", brokerageId);
  const colleague = actorOf(colleagueId, "Agent", brokerageId);

  const awaiting = await proposeAIAction({
    actionKey: "REQUEST_ACTION_APPROVAL",
    actor: requester,
    actorType: "USER",
    rawInput: { propertyId, protectedActionKey: "PUBLISH_LISTING", reason: "F4.0 colleague test" },
  });
  assert.equal(awaiting.request!.status, "AWAITING_APPROVAL");
  const id = awaiting.request!.id;

  assert.equal(await getAIActionRequestForActor(id, colleague), null, "colleague must not be able to read the payload");
  assert.equal((await approveAIActionRequest(id, brokerageId, colleague)).reason, "NOT_FOUND");
  assert.equal((await rejectAIActionRequest(id, brokerageId, colleague, "not mine")).reason, "NOT_FOUND");

  assert.ok(await getAIActionRequestForActor(id, requester), "requester can read");
  assert.ok(await getAIActionRequestForActor(id, actorOf(adminId, "Brokerage Administrator", brokerageId)), "admin can read");
  assert.equal((await getAIActionRequest(id, brokerageId))!.status, "AWAITING_APPROVAL", "denied attempts never change state");

  // Auto-approved request: a colleague cannot execute it either, and the
  // attempt leaves it APPROVED (no markFailed on an authority denial).
  const auto = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: requester,
    actorType: "USER",
    rawInput: { propertyId, note: "F4.0 auto-approved" },
  });
  const denied = await executeAIAction(auto.request!.id, brokerageId, colleague);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "NOT_FOUND");
  assert.equal((await getAIActionRequest(auto.request!.id, brokerageId))!.status, "APPROVED");
});

test("F4.0 execute: only the approver or a brokerage admin may execute an approval-required request - the requester who did not approve it is refused", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - F4.0 executor must be approver");
  t.after(() => cleanupBrokerage(brokerageId));
  const requesterId = await createUser(brokerageId, "Agent");
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const propertyId = await createProperty(brokerageId, requesterId);
  const requester = actorOf(requesterId, "Agent", brokerageId);
  const admin = actorOf(adminId, "Brokerage Administrator", brokerageId);

  const { request } = await proposeAIAction({
    actionKey: "REQUEST_ACTION_APPROVAL",
    actor: requester,
    actorType: "USER",
    rawInput: { propertyId, protectedActionKey: "ENGAGE_SUPPLIER", reason: "F4.0 approver test" },
  });
  const approval = await approveAIActionRequest(request!.id, brokerageId, admin);
  assert.equal(approval.ok, true, "a brokerage admin may approve another user's request");
  assert.equal(approval.request!.approvedByUserId, adminId);

  const byRequester = await executeAIAction(request!.id, brokerageId, requester);
  assert.equal(byRequester.ok, false);
  assert.equal(byRequester.reason, "EXECUTOR_NOT_AUTHORISED");
  assert.equal((await getAIActionRequest(request!.id, brokerageId))!.status, "APPROVED");

  const byAdmin = await executeAIAction(request!.id, brokerageId, admin);
  assert.equal(byAdmin.ok, true, JSON.stringify(byAdmin));
  assert.equal(byAdmin.request!.status, "COMPLETED");
});

test("F4.0 execute: an approval-required request that is APPROVED without a recorded approver is never executable by a human", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - F4.0 approval missing");
  t.after(() => cleanupBrokerage(brokerageId));
  const requesterId = await createUser(brokerageId, "Agent");
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const propertyId = await createProperty(brokerageId, requesterId);

  const { request } = await proposeAIAction({
    actionKey: "REQUEST_ACTION_APPROVAL",
    actor: actorOf(requesterId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, protectedActionKey: "PUBLISH_LISTING", reason: "forged approval" },
  });
  // Simulate a direct DB edit that skipped approveAIActionRequest().
  await db.update(aiActionRequests).set({ status: "APPROVED" }).where(eq(aiActionRequests.id, request!.id));

  const result = await executeAIAction(request!.id, brokerageId, actorOf(adminId, "Brokerage Administrator", brokerageId));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "APPROVAL_MISSING");
  assert.equal((await getAIActionRequest(request!.id, brokerageId))!.status, "APPROVED");
});

test("F4.0 tamper at approval: the request is REJECTED (conditionally) and the rejection is audited as AI_ACTION_BLOCKED", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - F4.0 tamper audited");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const admin = actorOf(adminId, "Brokerage Administrator", brokerageId);
  const since = testEventStore.events.length;

  const { request } = await proposeAIAction({ actionKey: "WORKFLOW_VERSION_ACTIVATE", actor: admin, actorType: "USER", rawInput: { proposalId: 424242 } });
  await db.update(aiActionRequests).set({ inputPayload: { proposalId: 1 } }).where(eq(aiActionRequests.id, request!.id));

  const approval = await approveAIActionRequest(request!.id, brokerageId, admin);
  assert.equal(approval.reason, "PAYLOAD_TAMPERED");
  assert.equal((await getAIActionRequest(request!.id, brokerageId))!.status, "REJECTED");

  const blocked = eventsForRequest(request!.id, since).filter((e) => e.eventType === "AI_ACTION_BLOCKED");
  assert.equal(blocked.length, 1);
  assert.equal((blocked[0].payload as Record<string, unknown>).reason, "PAYLOAD_TAMPERED");
  assert.equal((blocked[0].payload as Record<string, unknown>).stage, "APPROVAL");
  assert.equal((blocked[0].metadata as Record<string, unknown>).status, "REJECTED");
});

test("F4.0 expiry: AWAITING_APPROVAL -> EXPIRED at approval and APPROVED -> EXPIRED at execution are both audited exactly once", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - F4.0 expiry audited");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const agent = actorOf(agentId, "Agent", brokerageId);
  const since = testEventStore.events.length;

  const awaiting = await proposeAIAction({
    actionKey: "REQUEST_ACTION_APPROVAL",
    actor: agent,
    actorType: "USER",
    rawInput: { propertyId, protectedActionKey: "PUBLISH_LISTING", reason: "expiry" },
  });
  await db.update(aiActionRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(aiActionRequests.id, awaiting.request!.id));
  assert.equal((await approveAIActionRequest(awaiting.request!.id, brokerageId, agent)).reason, "EXPIRED");
  assert.equal((await approveAIActionRequest(awaiting.request!.id, brokerageId, agent)).reason, "WRONG_STATUS");
  const expiredAwaiting = eventsForRequest(awaiting.request!.id, since).filter((e) => e.eventType === "AI_ACTION_EXPIRED");
  assert.equal(expiredAwaiting.length, 1);
  assert.equal((expiredAwaiting[0].payload as Record<string, unknown>).previousStatus, "AWAITING_APPROVAL");

  const auto = await proposeAIAction({ actionKey: "PROPERTY_NOTE_ADD", actor: agent, actorType: "USER", rawInput: { propertyId, note: "expiry" } });
  await db.update(aiActionRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(aiActionRequests.id, auto.request!.id));
  const exec = await executeAIAction(auto.request!.id, brokerageId, agent);
  assert.equal(exec.reason, "EXPIRED");
  assert.equal((await getAIActionRequest(auto.request!.id, brokerageId))!.status, "EXPIRED");
  const expiredApproved = eventsForRequest(auto.request!.id, since).filter((e) => e.eventType === "AI_ACTION_EXPIRED");
  assert.equal(expiredApproved.length, 1);
  assert.equal((expiredApproved[0].payload as Record<string, unknown>).previousStatus, "APPROVED");
});

test("F4.0 stuck EXECUTING: recovery marks only stale EXECUTING rows FAILED with an audit event, never re-executes, and is classified terminal for automation", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - F4.0 stuck executing");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const agent = actorOf(agentId, "Agent", brokerageId);
  const since = testEventStore.events.length;

  const stale = await proposeAIAction({ actionKey: "PROPERTY_NOTE_ADD", actor: agent, actorType: "USER", rawInput: { propertyId, note: "stale" } });
  const fresh = await proposeAIAction({ actionKey: "PROPERTY_NOTE_ADD", actor: agent, actorType: "USER", rawInput: { propertyId, note: "fresh" } });
  await db
    .update(aiActionRequests)
    .set({ status: "EXECUTING", updatedAt: new Date(Date.now() - 60 * 60_000) })
    .where(eq(aiActionRequests.id, stale.request!.id));
  await db.update(aiActionRequests).set({ status: "EXECUTING", updatedAt: new Date() }).where(eq(aiActionRequests.id, fresh.request!.id));

  await assert.rejects(() => recoverStuckExecutingActionRequests(0), RangeError, "an unbounded (zero) threshold is refused");

  let executeCalls = 0;
  const recovered = await withWrappedExecute(
    "PROPERTY_NOTE_ADD",
    (original) => async (...args) => {
      executeCalls += 1;
      return original(...args);
    },
    async () => {
      const rows = await recoverStuckExecutingActionRequests(15 * 60_000, { brokerageId });
      // Neither a retry of execution nor any other verb can resurrect it.
      const again = await executeAIAction(stale.request!.id, brokerageId, agent);
      assert.equal(again.reason, "WRONG_STATUS");
      return rows;
    },
  );
  assert.equal(executeCalls, 0, "recovery must never call execute()");
  assert.deepEqual(recovered.map((r) => r.id), [stale.request!.id]);

  const staleAfter = await getAIActionRequest(stale.request!.id, brokerageId);
  assert.equal(staleAfter!.status, "FAILED");
  assert.equal(staleAfter!.errorMessage, STUCK_EXECUTING_RECOVERED_MESSAGE);
  assert.equal((await getAIActionRequest(fresh.request!.id, brokerageId))!.status, "EXECUTING", "an in-flight execution is never touched");

  const failedEvents = eventsForRequest(stale.request!.id, since).filter((e) => e.eventType === "AI_ACTION_FAILED");
  assert.equal(failedEvents.length, 1);
  assert.equal((failedEvents[0].payload as Record<string, unknown>).reason, "STUCK_EXECUTING_RECOVERED");

  assert.equal(classifyActionFailure({ authorityDecision: "ALLOW", errorMessage: STUCK_EXECUTING_RECOVERED_MESSAGE }), "TERMINAL_TECHNICAL");

  // Reading the request lazily recovers a stale EXECUTING row too.
  await db
    .update(aiActionRequests)
    .set({ status: "EXECUTING", updatedAt: new Date(Date.now() - 60 * 60_000) })
    .where(eq(aiActionRequests.id, fresh.request!.id));
  const viaRead = await getAIActionRequestForActor(fresh.request!.id, agent);
  assert.equal(viaRead!.status, "FAILED");
});

test("F4.0 markFailed is conditional: an execution error never overwrites a status another actor already recorded", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - F4.0 conditional markFailed");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const agent = actorOf(agentId, "Agent", brokerageId);
  const since = testEventStore.events.length;

  const { request } = await proposeAIAction({ actionKey: "PROPERTY_NOTE_ADD", actor: agent, actorType: "USER", rawInput: { propertyId, note: "race" } });

  const result = await withWrappedExecute(
    "PROPERTY_NOTE_ADD",
    () => async () => {
      // While this execution is in flight, the stuck-EXECUTING recovery
      // (e.g. another process judging it abandoned) fails the row first.
      await db
        .update(aiActionRequests)
        .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
        .where(eq(aiActionRequests.id, request!.id));
      await recoverStuckExecutingActionRequests(15 * 60_000, { requestId: request!.id });
      throw new Error("simulated late execution error");
    },
    () => executeAIAction(request!.id, brokerageId, agent),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "EXECUTION_FAILED");

  const after = await getAIActionRequest(request!.id, brokerageId);
  assert.equal(after!.status, "FAILED");
  assert.equal(after!.errorMessage, STUCK_EXECUTING_RECOVERED_MESSAGE, "the late error must not overwrite the recovery's record");
  const failedEvents = eventsForRequest(request!.id, since).filter((e) => e.eventType === "AI_ACTION_FAILED");
  assert.equal(failedEvents.length, 1, "exactly one FAILED audit event, from the transition that actually happened");
});

test("F4.0 system path: executeAIActionAsSystem runs a risk-0 SYSTEM request but refuses non-SYSTEM requests and anything requiring human approval", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - F4.0 system path");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const propertyId = await createProperty(brokerageId, adminId);
  const admin = actorOf(adminId, "Brokerage Administrator", brokerageId);

  // USER-originated, auto-approved: not the system's to run.
  const userAuto = await proposeAIAction({ actionKey: "PROPERTY_NOTE_ADD", actor: admin, actorType: "USER", rawInput: { propertyId, note: "user" } });
  const refusedUser = await executeAIActionAsSystem(userAuto.request!.id, brokerageId);
  assert.equal(refusedUser.reason, "SYSTEM_PATH_FORBIDDEN");
  assert.equal((await getAIActionRequest(userAuto.request!.id, brokerageId))!.status, "APPROVED");

  // SYSTEM-originated but approval-required, even after a human approved it.
  const systemGated = await proposeAIAction({
    actionKey: "REQUEST_ACTION_APPROVAL",
    actor: admin,
    actorType: "SYSTEM",
    rawInput: { propertyId, protectedActionKey: "PUBLISH_LISTING", reason: "system gated" },
  });
  assert.equal(systemGated.request!.status, "AWAITING_APPROVAL");
  assert.equal((await executeAIActionAsSystem(systemGated.request!.id, brokerageId)).reason, "SYSTEM_PATH_FORBIDDEN");
  assert.equal((await approveAIActionRequest(systemGated.request!.id, brokerageId, admin)).ok, true);
  const refusedGated = await executeAIActionAsSystem(systemGated.request!.id, brokerageId);
  assert.equal(refusedGated.reason, "SYSTEM_PATH_FORBIDDEN");
  assert.equal((await getAIActionRequest(systemGated.request!.id, brokerageId))!.status, "APPROVED", "refusal never changes state");

  // A SYSTEM row whose stored risk no longer satisfies the authority
  // formula (e.g. edited in the DB) is refused even though requiresApproval=false.
  const forged = await proposeAIAction({ actionKey: "PROPERTY_NOTE_ADD", actor: admin, actorType: "SYSTEM", rawInput: { propertyId, note: "forged risk" } });
  await db.update(aiActionRequests).set({ riskLevel: 2 }).where(eq(aiActionRequests.id, forged.request!.id));
  assert.equal((await executeAIActionAsSystem(forged.request!.id, brokerageId)).reason, "SYSTEM_PATH_FORBIDDEN");

  // The legitimate case still works.
  const systemAuto = await proposeAIAction({ actionKey: "PROPERTY_NOTE_ADD", actor: admin, actorType: "SYSTEM", rawInput: { propertyId, note: "system" } });
  const ran = await executeAIActionAsSystem(systemAuto.request!.id, brokerageId);
  assert.equal(ran.ok, true, JSON.stringify(ran));
  assert.equal(ran.request!.status, "COMPLETED");

  assert.equal(classifyActionFailure({ authorityDecision: "ALLOW", errorMessage: "SYSTEM_PATH_FORBIDDEN" }), "VALIDATION_OR_POLICY");
});

test("F4.0 cross-tenant: approve/reject/execute/read against another brokerage's request id all behave as not found", async (t) => {
  const brokerageA = await createBrokerage("Gov Test - F4.0 cross-tenant A");
  const brokerageB = await createBrokerage("Gov Test - F4.0 cross-tenant B");
  t.after(() => Promise.all([cleanupBrokerage(brokerageA), cleanupBrokerage(brokerageB)]));
  const agentA = await createUser(brokerageA, "Agent");
  const adminB = await createUser(brokerageB, "Brokerage Administrator");
  const propertyA = await createProperty(brokerageA, agentA);
  const foreignAdmin = actorOf(adminB, "Brokerage Administrator", brokerageB);

  const { request } = await proposeAIAction({
    actionKey: "REQUEST_ACTION_APPROVAL",
    actor: actorOf(agentA, "Agent", brokerageA),
    actorType: "USER",
    rawInput: { propertyId: propertyA, protectedActionKey: "PUBLISH_LISTING", reason: "cross tenant" },
  });
  assert.equal(await getAIActionRequestForActor(request!.id, foreignAdmin), null);
  assert.equal((await approveAIActionRequest(request!.id, brokerageB, foreignAdmin)).reason, "NOT_FOUND");
  assert.equal((await rejectAIActionRequest(request!.id, brokerageB, foreignAdmin, "x")).reason, "NOT_FOUND");
  assert.equal((await executeAIAction(request!.id, brokerageB, foreignAdmin)).reason, "NOT_FOUND");
  assert.equal((await executeAIActionAsSystem(request!.id, brokerageB)).reason, "NOT_FOUND");
  assert.equal((await getAIActionRequest(request!.id, brokerageA))!.status, "AWAITING_APPROVAL");
});

test("F4.0 D2 late completion: if recovery fails the row while execute() is in flight and execute() then succeeds, the row stays FAILED, no AI_ACTION_EXECUTED is published, and the late completion is audited and reported", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - F4.0 D2 late completion");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const agent = actorOf(agentId, "Agent", brokerageId);
  const since = testEventStore.events.length;

  const { request } = await proposeAIAction({ actionKey: "PROPERTY_NOTE_ADD", actor: agent, actorType: "USER", rawInput: { propertyId, note: "late" } });

  let executeCalls = 0;
  const result = await withWrappedExecute(
    "PROPERTY_NOTE_ADD",
    (original) => async (...args) => {
      executeCalls += 1;
      // Another process judges this execution abandoned and recovers it...
      await db
        .update(aiActionRequests)
        .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
        .where(eq(aiActionRequests.id, request!.id));
      await recoverStuckExecutingActionRequests(15 * 60_000, { requestId: request!.id });
      // ...and then the real side effect completes anyway.
      return original(...args);
    },
    () => executeAIAction(request!.id, brokerageId, agent),
  );

  assert.equal(executeCalls, 1, "never re-executed");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "COMPLETED_AFTER_RECOVERY");
  assert.equal(result.sideEffectApplied, true);
  assert.deepEqual(result.result, { propertyId });

  const after = await getAIActionRequest(request!.id, brokerageId);
  assert.equal(after!.status, "FAILED", "a late success must not flip a recovered row back to COMPLETED");
  assert.equal(after!.errorMessage, LATE_COMPLETION_AFTER_RECOVERY_MESSAGE);
  assert.deepEqual(after!.executionResult, { propertyId });
  assert.equal(classifyActionFailure({ authorityDecision: "ALLOW", errorMessage: LATE_COMPLETION_AFTER_RECOVERY_MESSAGE }), "TERMINAL_TECHNICAL");

  const types = eventsForRequest(request!.id, since).map((e) => e.eventType);
  assert.ok(!types.includes("AI_ACTION_EXECUTED"), "the audit trail must not claim both FAILED and EXECUTED");
  assert.equal(types.filter((type) => type === "AI_ACTION_FAILED").length, 1);

  const audit = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.recordType, "ai_action_request"), eq(auditLogs.recordId, String(request!.id))));
  const lateCompletion = audit.find((row) => row.action === "ai_action_late_completion_after_recovery");
  assert.ok(lateCompletion, "late completion must be audited");
  assert.equal(lateCompletion.brokerageId, request!.brokerageId, "late completion audit must be tenant-attributed");
  await db.delete(auditLogs).where(and(eq(auditLogs.recordType, "ai_action_request"), eq(auditLogs.recordId, String(request!.id))));
});

test("F4.0 D6: a human cannot execute a request stored as requiresApproval=false when its action (as stored or as currently registered) requires approval and no approver is recorded", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - F4.0 D6 stale requiresApproval");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const propertyId = await createProperty(brokerageId, agentId);
  const agent = actorOf(agentId, "Agent", brokerageId);
  const admin = actorOf(adminId, "Brokerage Administrator", brokerageId);

  // (a) Row edited to look auto-approved for an approval-required action.
  const gated = await proposeAIAction({
    actionKey: "REQUEST_ACTION_APPROVAL",
    actor: agent,
    actorType: "USER",
    rawInput: { propertyId, protectedActionKey: "PUBLISH_LISTING", reason: "D6" },
  });
  await db.update(aiActionRequests).set({ status: "APPROVED", requiresApproval: false }).where(eq(aiActionRequests.id, gated.request!.id));
  for (const caller of [agent, admin]) {
    const refused = await executeAIAction(gated.request!.id, brokerageId, caller);
    assert.equal(refused.reason, "APPROVAL_MISSING");
  }
  assert.equal((await getAIActionRequest(gated.request!.id, brokerageId))!.status, "APPROVED", "refusal never changes state");

  // (b) Genuinely auto-approved row, but the action's CURRENT registered
  // policy has since been tightened so it now requires approval.
  const auto = await proposeAIAction({ actionKey: "PROPERTY_NOTE_ADD", actor: agent, actorType: "USER", rawInput: { propertyId, note: "D6" } });
  assert.equal(auto.request!.requiresApproval, false);
  const definition = getActionDefinition("PROPERTY_NOTE_ADD")!;
  const originalRisk = definition.riskLevel;
  definition.riskLevel = 2;
  try {
    const refused = await executeAIAction(auto.request!.id, brokerageId, agent);
    assert.equal(refused.reason, "APPROVAL_MISSING");
  } finally {
    definition.riskLevel = originalRisk;
  }
  assert.equal((await getAIActionRequest(auto.request!.id, brokerageId))!.status, "APPROVED");
  // With the policy back as registered, the requester can execute it.
  assert.equal((await executeAIAction(auto.request!.id, brokerageId, agent)).ok, true);
});
