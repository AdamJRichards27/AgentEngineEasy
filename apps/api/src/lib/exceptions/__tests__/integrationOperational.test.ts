// Agent Engine 2.0 — Exception & Risk Engine (Priority 4) — AE Step 5
// remediation, Proof D (Workflow and Risk).
//
// End-to-end through the REAL outbox and the REAL exception engine — no
// shortcuts: enqueue a command on a genuinely ACTIVE connection -> dispatch
// it against a mock adapter deliberately configured to fail
// TRANSIENT_PROVIDER_ERROR -> retry per the outbox's own backoff/maxAttempts
// policy -> exhaust retries and dead-letter -> the Exception & Risk Engine's
// scheduled sweep (rules/integrationOperational.ts's H01) turns that into a
// real risk exception (problem/cause/owner/severity/deadline/recommended
// action/resolution path/related integration command/provider/connection/
// correlation id) -> severity escalates from AT_RISK to CRITICAL once 24h
// unresolved -> a successful, authorised replay (the same
// replayDeadLetteredCommand an admin's HTTP action uses) resolves the
// command, and the next sweep auto-resolves the risk exception from that
// authoritative evidence (never from silence).
//
// Reuses commsProof.ts's own "communication_message" source-record resolver
// (registered via bootstrapIntegrationsForTesting -> registerCommsIntegrationHandlers)
// rather than inventing a new domain record just for this test — H01 itself
// is deliberately generic across every domain proof's outbox traffic (see
// that rule's own header comment), so proving it against a comms SMS
// command exercises exactly the same generic path a portal or payment
// command would.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, integrationOutbox, integrationOutboxAttempts, riskExceptions } from "@aee/db";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";
import { bootstrapIntegrationsForTesting, createActiveMockSmsConnection } from "../../integrations/__tests__/testHelpers.js";
import { enqueueCommand, dispatchCommand, mintIdempotencyKey, replayDeadLetteredCommand } from "../../integrations/outbox.js";
import { listDeadLettersForBrokerage } from "../../integrations/deadLetters.js";
import { INTEGRATION_CAPABILITIES } from "../../integrations/types.js";
import { createThread, createDraftMessage } from "../../communications/messages.js";
import { registerExceptionEngine } from "../bootstrap.js";
import { runScheduledScan, type ScanSummary } from "../engine.js";
import { dismissException, acknowledgeException, RiskExceptionError } from "../model.js";
import { INTEGRATION_OPERATIONAL_RULES } from "../rules/integrationOperational.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const H01_RULE_ID = INTEGRATION_OPERATIONAL_RULES[0].ruleId;

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  registerExceptionEngine({ startScheduler: false });
  await bootstrapIntegrationsForTesting();
  const { createApp } = await import("../../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `Integrations Risk Proof D A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Integrations Risk Proof D B ${suffix}`);
});

after(async () => {
  const ids = [A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number");
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function actorOf(login: DevLoginResult) {
  return { id: login.user.id, role: login.user.role };
}

/** A real communication_message, tied to a real property, that H01's registered resolver can resolve — mirrors commsProof.test.ts's own draftSmsMessage helper. */
async function draftSmsMessage(brokerageId: number, cookie: string, senderUserId: number) {
  const { propertyId } = await createListedProperty(baseUrl, cookie, { address: `1 Risk Proof D Rd ${suffix}-${Math.floor(Math.random() * 100000)}` });
  const thread = await createThread({ brokerageId, propertyId, subject: "Proof D test thread", createdByUserId: senderUserId });
  const message = await createDraftMessage({
    threadId: thread.id,
    brokerageId,
    propertyId,
    channel: "SMS",
    classification: "TRANSACTIONAL",
    bodyText: "This is an automated test SMS used to drive an integration command to dead-letter.",
    recipientDestination: "+61400000001",
    recipientDisplayName: "Test Recipient",
    senderUserId,
    createdByUserId: senderUserId,
  });
  return { propertyId, message };
}

// Retries a scheduled scan when it's transiently refused because another
// scan (from a concurrently-running test file against the same shared test
// database) currently holds the scan_runs lock — a real, correct outcome
// under concurrent test execution, not a bug in the engine under test
// (mirrors exceptions/__tests__/engine.test.ts's own scanOrRetry helper).
async function scanOrRetry(trigger: "SCHEDULED" | "MANUAL" = "MANUAL"): Promise<ScanSummary> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await runScheduledScan(trigger);
    if (result.ok) return result.summary;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("runScheduledScan did not succeed after retries — another scan kept the lock held throughout");
}

async function findH01Exception(brokerageId: number, outboxCommandId: string) {
  const [row] = await db
    .select()
    .from(riskExceptions)
    .where(and(eq(riskExceptions.brokerageId, brokerageId), eq(riskExceptions.ruleId, H01_RULE_ID), eq(riskExceptions.sourceRecordId, outboxCommandId)));
  return row ?? null;
}

async function countH01Exceptions(brokerageId: number, outboxCommandId: string): Promise<number> {
  const rows = await db
    .select()
    .from(riskExceptions)
    .where(and(eq(riskExceptions.brokerageId, brokerageId), eq(riskExceptions.ruleId, H01_RULE_ID), eq(riskExceptions.sourceRecordId, outboxCommandId)));
  return rows.length;
}

test("Proof D: dead-lettered integration command creates a risk exception at AT_RISK (never premature CRITICAL), escalates to CRITICAL after 24h unresolved, and a successful authorised replay resolves it while preserving the historical failure record", async () => {
  const actor = actorOf(A.admin);
  const { connection } = await createActiveMockSmsConnection(A.brokerageId, actor);
  const { propertyId, message } = await draftSmsMessage(A.brokerageId, A.admin.cookie, A.admin.user.id);

  // __failUntilAttempt: 6 — fails TRANSIENT on attempts 1-5 (maxAttempts
  // defaults to 5, so attempt 5 exhausts the retry budget and dead-letters
  // deterministically), then SUCCEEDS on attempt 6 — see adapters/mockSms.ts's
  // own header comment: "Proof D's retry-to-dead-letter scenario drives this
  // past maxAttempts to force a genuine dead-letter deterministically." A
  // single payload this way proves both halves of the 14-step scenario: the
  // dead-letter (attempts 1-5) and the later successful recovery (replay,
  // attempt 6) — a real change in outcome, not a canned "replay always
  // succeeds" stub.
  const command = await enqueueCommand({
    brokerageId: A.brokerageId,
    connectionId: connection.id,
    capability: INTEGRATION_CAPABILITIES.COMMS_SEND_SMS,
    commandPayload: { to: message.recipientDestination, bodyText: message.bodyText, __failUntilAttempt: 6 },
    idempotencyKey: mintIdempotencyKey(`proofd-main-${suffix}`),
    sourceRecordType: "communication_message",
    sourceRecordId: String(message.id),
  });

  let last = await dispatchCommand(command.id);
  assert.equal(last.status, "RETRY_SCHEDULED");
  for (let i = 0; i < 3; i++) {
    last = await dispatchCommand(command.id);
    assert.equal(last.status, "RETRY_SCHEDULED", `attempt ${i + 2} should still be retrying`);
  }
  last = await dispatchCommand(command.id);
  assert.equal(last.status, "DEAD_LETTERED");
  assert.equal(last.attempts, 5);

  const attemptsAfterDeadLetter = await db.select().from(integrationOutboxAttempts).where(eq(integrationOutboxAttempts.outboxId, command.id));
  assert.equal(attemptsAfterDeadLetter.length, 5, "every dispatch attempt, including the ones that failed, is preserved in the attempt history");

  // --- Dead-letter -> risk exception, no premature CRITICAL. ---
  await scanOrRetry();
  const opened = await findH01Exception(A.brokerageId, command.id);
  assert.ok(opened, "expected the H01 rule to open a risk exception for the dead-lettered command");
  assert.equal(opened!.status, "OPEN");
  assert.equal(opened!.severity, "AT_RISK", "a single, just-now dead-lettered command must never read as CRITICAL");
  assert.equal(opened!.category, "WORKFLOW_OPERATIONAL");
  assert.equal(opened!.propertyId, propertyId);
  assert.equal(opened!.transactionId, null);
  assert.equal(opened!.ownerType, "LISTING_AGENT");
  assert.equal(opened!.ownerUserId, A.admin.user.id);
  assert.equal(opened!.dismissible, false);
  assert.equal(opened!.sourceRecordType, "integration_outbox");
  assert.equal(opened!.sourceRecordId, command.id);
  const metadata = opened!.metadata as Record<string, unknown> | null;
  assert.equal(metadata?.integrationOutboxId, command.id);
  assert.equal(metadata?.integrationConnectionId, connection.id);
  assert.equal(metadata?.integrationCapability, INTEGRATION_CAPABILITIES.COMMS_SEND_SMS);
  assert.equal(metadata?.integrationSourceRecordType, "communication_message");
  assert.equal(metadata?.integrationSourceRecordId, String(message.id));

  // --- Backdate the dead-letter moment by >24h and rescan: escalates. ---
  const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await db.update(integrationOutbox).set({ updatedAt: twentyFiveHoursAgo }).where(eq(integrationOutbox.id, command.id));
  await scanOrRetry();
  const escalated = await findH01Exception(A.brokerageId, command.id);
  assert.ok(escalated);
  assert.equal(escalated!.id, opened!.id, "the SAME exception row escalates — this is a severity change, not a new occurrence");
  assert.equal(escalated!.severity, "CRITICAL");
  assert.equal(escalated!.status, "OPEN");

  // dismissible: false must be enforced even on a CRITICAL, already-escalated row.
  await assert.rejects(
    () => dismissException(escalated!.id, A.brokerageId, actor, "trying to wave this away"),
    (err: unknown) => err instanceof RiskExceptionError && err.reason === "NOT_DISMISSIBLE",
  );

  // --- Successful, authorised replay (the exact function the admin HTTP
  // action calls) — attempt 6 succeeds for real, not a stub. ---
  const deadLetters = await listDeadLettersForBrokerage(A.brokerageId);
  const letter = deadLetters.find((d) => d.sourceId === command.id);
  assert.ok(letter, "expected a dead letter record for the command");
  const replayed = await replayDeadLetteredCommand(letter!.id, A.brokerageId, actor);
  assert.equal(replayed.status, "SENT");
  assert.equal(replayed.attempts, 6);

  const attemptsAfterReplay = await db.select().from(integrationOutboxAttempts).where(eq(integrationOutboxAttempts.outboxId, command.id));
  assert.equal(attemptsAfterReplay.length, 6, "the recovery attempt is appended to history — the 5 prior failures are never erased or overwritten");

  // --- Next sweep: the command is no longer DEAD_LETTERED, so H01's
  // scanBrokerage no longer reports it -> authoritative evidence the
  // condition cleared -> auto-resolved (never inferred from silence alone —
  // engine.ts only ever does this after a scan that itself succeeded). ---
  await scanOrRetry();
  const resolved = await findH01Exception(A.brokerageId, command.id);
  assert.ok(resolved);
  assert.equal(resolved!.id, opened!.id);
  assert.equal(resolved!.status, "RESOLVED");
  assert.equal(resolved!.resolutionMethod, "AUTO");
  const evidence = resolved!.resolutionEvidence as Record<string, unknown> | null;
  assert.equal(evidence?.kind, "RULE_CONDITION_CLEARED");
  assert.equal(evidence?.ruleId, H01_RULE_ID);
});

test("no duplicate risk exception across repeated scan passes for the same still-dead-lettered command", async () => {
  const actor = actorOf(A.admin);
  const { connection } = await createActiveMockSmsConnection(A.brokerageId, actor);
  const { message } = await draftSmsMessage(A.brokerageId, A.admin.cookie, A.admin.user.id);

  const command = await enqueueCommand({
    brokerageId: A.brokerageId,
    connectionId: connection.id,
    capability: INTEGRATION_CAPABILITIES.COMMS_SEND_SMS,
    commandPayload: { to: message.recipientDestination, bodyText: message.bodyText, __forcePermanentRejection: true },
    idempotencyKey: mintIdempotencyKey(`proofd-dup-${suffix}`),
    sourceRecordType: "communication_message",
    sourceRecordId: String(message.id),
  });
  const dispatched = await dispatchCommand(command.id);
  assert.equal(dispatched.status, "DEAD_LETTERED");

  await scanOrRetry();
  const afterFirstScan = await findH01Exception(A.brokerageId, command.id);
  assert.ok(afterFirstScan);
  assert.equal(await countH01Exceptions(A.brokerageId, command.id), 1);
  const occurrenceCountAfterFirst = afterFirstScan!.occurrenceCount;

  await scanOrRetry();
  await scanOrRetry();
  assert.equal(await countH01Exceptions(A.brokerageId, command.id), 1, "re-detecting the same still-open condition must update the existing row, never insert a second one");
  const afterMoreScans = await findH01Exception(A.brokerageId, command.id);
  assert.equal(afterMoreScans!.id, afterFirstScan!.id);
  assert.ok(afterMoreScans!.occurrenceCount >= occurrenceCountAfterFirst, "occurrence count reflects repeated re-detection");
  assert.equal(afterMoreScans!.status, "OPEN");
});

test("a dead-lettered command whose sourceRecordType has no registered resolver is skipped, never guessed at", async () => {
  const actor = actorOf(A.admin);
  const { connection } = await createActiveMockSmsConnection(A.brokerageId, actor);

  const command = await enqueueCommand({
    brokerageId: A.brokerageId,
    connectionId: connection.id,
    capability: INTEGRATION_CAPABILITIES.COMMS_SEND_SMS,
    commandPayload: { __forcePermanentRejection: true },
    idempotencyKey: mintIdempotencyKey(`proofd-unregistered-${suffix}`),
    sourceRecordType: "some_unregistered_record_type",
    sourceRecordId: "does-not-matter",
  });
  const dispatched = await dispatchCommand(command.id);
  assert.equal(dispatched.status, "DEAD_LETTERED");

  const findings = await INTEGRATION_OPERATIONAL_RULES[0].scanBrokerage(A.brokerageId, new Date());
  assert.ok(
    !findings.some((f) => f.sourceRecordId === command.id),
    "a dead-lettered command with an unresolvable sourceRecordType must never produce a finding",
  );

  await scanOrRetry();
  assert.equal(await countH01Exceptions(A.brokerageId, command.id), 0);
});

test("a command that is not DEAD_LETTERED (e.g. SENT) produces no risk exception", async () => {
  const actor = actorOf(A.admin);
  const { connection } = await createActiveMockSmsConnection(A.brokerageId, actor);
  const { message } = await draftSmsMessage(A.brokerageId, A.admin.cookie, A.admin.user.id);

  const command = await enqueueCommand({
    brokerageId: A.brokerageId,
    connectionId: connection.id,
    capability: INTEGRATION_CAPABILITIES.COMMS_SEND_SMS,
    commandPayload: { to: message.recipientDestination, bodyText: message.bodyText },
    idempotencyKey: mintIdempotencyKey(`proofd-sent-${suffix}`),
    sourceRecordType: "communication_message",
    sourceRecordId: String(message.id),
  });
  const dispatched = await dispatchCommand(command.id);
  assert.equal(dispatched.status, "SENT");

  await scanOrRetry();
  assert.equal(await countH01Exceptions(A.brokerageId, command.id), 0);
});

test("cross-tenant: a dead-lettered command's risk exception belongs to its own brokerage and is invisible/inaccessible from another brokerage", async () => {
  const actorB = actorOf(B.admin);
  const { connection } = await createActiveMockSmsConnection(B.brokerageId, actorB);
  const { message } = await draftSmsMessage(B.brokerageId, B.admin.cookie, B.admin.user.id);

  const command = await enqueueCommand({
    brokerageId: B.brokerageId,
    connectionId: connection.id,
    capability: INTEGRATION_CAPABILITIES.COMMS_SEND_SMS,
    commandPayload: { to: message.recipientDestination, bodyText: message.bodyText, __forcePermanentRejection: true },
    idempotencyKey: mintIdempotencyKey(`proofd-tenant-${suffix}`),
    sourceRecordType: "communication_message",
    sourceRecordId: String(message.id),
  });
  const dispatched = await dispatchCommand(command.id);
  assert.equal(dispatched.status, "DEAD_LETTERED");

  await scanOrRetry();
  const exceptionInB = await findH01Exception(B.brokerageId, command.id);
  assert.ok(exceptionInB);
  assert.equal(exceptionInB!.brokerageId, B.brokerageId);

  // Brokerage A cannot even discover this exception exists, let alone act on it.
  await assert.rejects(
    () => acknowledgeException(exceptionInB!.id, A.brokerageId, actorOf(A.admin)),
    (err: unknown) => err instanceof RiskExceptionError && err.reason === "NOT_FOUND",
  );
  assert.equal(await countH01Exceptions(A.brokerageId, command.id), 0);
});

test("a low-authority (Agent) user cannot replay a dead-letter through the admin HTTP route", async () => {
  const actor = actorOf(A.admin);
  const { connection } = await createActiveMockSmsConnection(A.brokerageId, actor);
  const { message } = await draftSmsMessage(A.brokerageId, A.admin.cookie, A.admin.user.id);

  const command = await enqueueCommand({
    brokerageId: A.brokerageId,
    connectionId: connection.id,
    capability: INTEGRATION_CAPABILITIES.COMMS_SEND_SMS,
    commandPayload: { to: message.recipientDestination, bodyText: message.bodyText, __forcePermanentRejection: true },
    idempotencyKey: mintIdempotencyKey(`proofd-rbac-${suffix}`),
    sourceRecordType: "communication_message",
    sourceRecordId: String(message.id),
  });
  const dispatched = await dispatchCommand(command.id);
  assert.equal(dispatched.status, "DEAD_LETTERED");

  const deadLetters = await listDeadLettersForBrokerage(A.brokerageId);
  const letter = deadLetters.find((d) => d.sourceId === command.id);
  assert.ok(letter);

  const res = await fetch(`${baseUrl}/api/integrations/dead-letters/${letter!.id}/replay`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
  });
  assert.equal(res.status, 403, "the entire integrations router is gated to BROKERAGE_ADMIN_ROLES — an Agent must never be able to replay a dead-letter");

  const [stillDeadLettered] = await db.select().from(integrationOutbox).where(eq(integrationOutbox.id, command.id));
  assert.equal(stillDeadLettered.status, "DEAD_LETTERED", "the refused request must not have had any effect");
});
