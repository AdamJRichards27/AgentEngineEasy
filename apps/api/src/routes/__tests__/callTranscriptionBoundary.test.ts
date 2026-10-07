/**
 * Stage-F3/F4 boundary enforcement.
 *
 * This suite intentionally observes the real HTTP route, transcription
 * provider seam, draft gateway seam, review transaction, Timeline callback,
 * and reconciliation transaction.  It must stay test-only: no production
 * module is changed here. Only F4 entrypoints are mocked, before F3 imports.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import type { ObjectStorageProvider } from "@aee/integration-object-storage";
import {
  aiActionRequests,
  automationTasks,
  communicationMessages,
  communicationThreads,
  db,
  documentObjectVersions,
  documents,
  entitlementGrants,
  growCallRecordingConsents,
  growCallSessions,
  growCallTranscriptions,
  growCommitments,
  growActivities,
  growConsentDecisions,
  growOpportunitySignals,
  parties,
  workflowChangeProposals,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import {
  cleanupBrokerages,
  createBrokerageWithUsers,
} from "./testSupport.js";

// The ordinary API test command need not acquire an experimental flag.
// Only this test file re-executes in an isolated Node 24 mock-enabled process.
if (!process.execArgv.includes("--experimental-test-module-mocks")) {
  test("F3 runtime boundary suite (isolated module-mock process)", async (t) => {
    const childEnv = { ...process.env };
    // Node otherwise detects a recursive test runner, skips every child test,
    // and exits zero. A zero exit alone must never count as boundary coverage.
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [
      "--experimental-test-module-mocks",
      "--import", fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
      "--test", "--test-reporter=tap", "--test-timeout=120000", fileURLToPath(import.meta.url),
    ], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    t.diagnostic(output);
    assert.equal(exit, 0, output);
    assert.match(output, /# tests 5\b/, "All five runtime cases must actually execute");
    assert.match(output, /# fail 0\b/);
    assert.match(output, /# skipped 0\b/);
  });
} else {
process.env.NODE_ENV = "test";
// Process-local test configuration only; never contact an alert webhook.
process.env.OPERATIONAL_ALERTS_ENABLED = "false";
process.env.OPERATIONAL_ALERTS_PROVIDER = "disabled";
const { installForbiddenCalls } = await import("./support/f3ForbiddenCalls.js");
const forbiddenCalls = await installForbiddenCalls();
// Installing mocks after static imports would leave F3 holding real bindings.
const { setCallTranscriptionDraftGatewayForTests } = await import("../../lib/telephony/callTranscriptionDrafts.js");
const { reconcileAbandonedCallTranscriptions } = await import("../../lib/telephony/callTranscriptionReconciliation.js");
const { runCallTranscriptionReconciliationSweep } = await import("../../lib/telephony/callTranscriptionReconciler.js");
const { setCallTranscriptionProviderForTests } = await import("../../lib/telephony/callTranscriptions.js");
const { storeCallRecording } = await import("../../lib/telephony/recordingStorage.js");
const { setDocumentStorageProviderForTests } = await import("../../lib/documentStorage.js");

process.env.SESSION_SECRET = process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
  ? process.env.SESSION_SECRET : "f3-boundary-test-secret-012345678901234567890";
process.env.ALLOW_DEV_AUTH = "true";

class MemoryStorage implements ObjectStorageProvider {
  private readonly objects = new Map<string, Buffer>();

  async putObject(key: string, content: string | Buffer) {
    this.objects.set(key, Buffer.from(content));
    return { key };
  }
  async getObject(key: string) {
    const content = this.objects.get(key);
    if (!content) throw new Error(`Missing synthetic object ${key}`);
    return Buffer.from(content);
  }
  async headObject(key: string) {
    const content = await this.getObject(key);
    return { key, size: content.length, checksumSha256: createHash("sha256").update(content).digest("hex") };
  }
  async deleteObject(key: string) {
    this.objects.delete(key);
  }
  async createSignedDownload(key: string) {
    return { url: `memory://${key}`, expiresAt: new Date(Date.now() + 60_000) };
  }
  async verifyIntegrity(key: string) {
    const checksum = createHash("sha256").update(await this.getObject(key)).digest("hex");
    return { valid: true, expectedChecksum: checksum, actualChecksum: checksum };
  }
  async checkReadiness() {
    return { ready: true };
  }
}

type BoundaryCounts = {
  commitments: number;
  proposals: number;
  communicationThreads: number;
  communicationMessages: number;
  tasks: number;
  actionRequests: number;
  opportunitySignals: number;
};

let server: Server;
let baseUrl: string;
let brokerageId: number;
let actor: Awaited<ReturnType<typeof createBrokerageWithUsers>>["agent"];
const storage = new MemoryStorage();

async function boundaryCounts(): Promise<BoundaryCounts> {
  const where = (table: { brokerageId: unknown }) => eq(table.brokerageId as never, brokerageId);
  const [
    commitments,
    proposals,
    communicationThreadsRows,
    communicationMessagesRows,
    tasks,
    actionRequests,
    opportunitySignals,
  ] = await Promise.all([
    db.select({ id: growCommitments.id }).from(growCommitments).where(where(growCommitments)),
    db.select({ id: workflowChangeProposals.id }).from(workflowChangeProposals).where(where(workflowChangeProposals)),
    db.select({ id: communicationThreads.id }).from(communicationThreads).where(where(communicationThreads)),
    db.select({ id: communicationMessages.id }).from(communicationMessages).where(where(communicationMessages)),
    db.select({ id: automationTasks.id }).from(automationTasks).where(where(automationTasks)),
    db.select({ id: aiActionRequests.id }).from(aiActionRequests).where(where(aiActionRequests)),
    db.select({ id: growOpportunitySignals.id }).from(growOpportunitySignals).where(where(growOpportunitySignals)),
  ]);
  return {
    commitments: commitments.length,
    proposals: proposals.length,
    communicationThreads: communicationThreadsRows.length,
    communicationMessages: communicationMessagesRows.length,
    tasks: tasks.length,
    actionRequests: actionRequests.length,
    opportunitySignals: opportunitySignals.length,
  };
}

function assertNoBoundaryWrites(before: BoundaryCounts, after: BoundaryCounts): void {
  assert.deepEqual(after, before, "F3 operation crossed an F4 side-effect boundary");
}

type ForbiddenWriteOperation = "insert" | "update" | "delete";
type ForbiddenWriteCounts = Record<ForbiddenWriteOperation, number>;

/**
 * The row-count assertions above are deliberately supplemented by this
 * transaction-aware Drizzle guard.  A forbidden INSERT which is rolled back,
 * swallowed, or never becomes visible to a later SELECT still increments the
 * guard.  This is also the positive-control seam used below; it is not a
 * production patch or a fake database.
 */
function installForbiddenWriteGuard(): {
  counts: ForbiddenWriteCounts;
  restore: () => void;
} {
  const forbiddenTables = new Set<object>([
    growCommitments,
    workflowChangeProposals,
    communicationThreads,
    communicationMessages,
    automationTasks,
    aiActionRequests,
    growOpportunitySignals,
  ]);
  const counts: ForbiddenWriteCounts = { insert: 0, update: 0, delete: 0 };
  const originalInsert = db.insert.bind(db);
  const originalUpdate = db.update.bind(db);
  const originalDelete = db.delete.bind(db);
  const originalTransaction = db.transaction.bind(db);
  const check = (operation: ForbiddenWriteOperation, table: unknown): void => {
    if (!forbiddenTables.has(table as object)) return;
    counts[operation] += 1;
    throw new Error(`F4 boundary write attempted: ${operation}`);
  };
  const wrapExecutor = (executor: unknown): unknown => new Proxy(executor as object, {
    get(target, property, receiver) {
      if (property === "insert" || property === "update" || property === "delete") {
        const operation = property as ForbiddenWriteOperation;
        return (table: unknown) => {
          check(operation, table);
          return (target as Record<string, (arg: unknown) => unknown>)[operation]!.call(target, table);
        };
      }
      if (property === "transaction") {
        return (callback: (tx: unknown) => unknown) =>
          (target as { transaction(callback: (tx: unknown) => unknown): unknown })
            .transaction((nested) => callback(wrapExecutor(nested)));
      }
      return Reflect.get(target, property, receiver);
    },
  });
  (db as unknown as { insert: typeof db.insert }).insert = ((table: unknown) => {
    check("insert", table);
    return originalInsert(table as never);
  }) as typeof db.insert;
  (db as unknown as { update: typeof db.update }).update = ((table: unknown) => {
    check("update", table);
    return originalUpdate(table as never);
  }) as typeof db.update;
  (db as unknown as { delete: typeof db.delete }).delete = ((table: unknown) => {
    check("delete", table);
    return originalDelete(table as never);
  }) as typeof db.delete;
  (db as unknown as { transaction: typeof db.transaction }).transaction = ((callback: unknown, ...args: unknown[]) =>
    originalTransaction(
      async (tx: unknown) => (callback as (executor: unknown) => Promise<unknown>)(wrapExecutor(tx)),
      ...(args as never[]),
    )) as typeof db.transaction;
  return {
    counts,
    restore: () => {
      (db as unknown as { insert: typeof db.insert }).insert = originalInsert;
      (db as unknown as { update: typeof db.update }).update = originalUpdate;
      (db as unknown as { delete: typeof db.delete }).delete = originalDelete;
      (db as unknown as { transaction: typeof db.transaction }).transaction = originalTransaction;
    },
  };
}

function draftGatewayResponse(payload: unknown) {
  return {
    response: {
      provider: "test",
      model: "test",
      text: JSON.stringify(payload),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
      latencyMs: 1,
    },
    usedFallback: false,
  };
}

const draftPayload = {
  draft_summary: "Buyer will send the signed offer.",
  draft_key_points: ["Buyer is preparing an offer."],
  draft_commitments: [{ text: "Send the signed offer.", dueAt: "2035-01-02T00:00:00.000Z" }],
  draft_followups: [{ text: "Check for the signed offer." }],
};

function fiveGateEvidence(consentId: number, decisionId: number): string {
  return JSON.stringify({
    evaluatedAt: new Date().toISOString(),
    requested: true,
    allPassed: true,
    outboundDecisionId: decisionId,
    outboundReasonCode: "OK",
    gates: {
      entitlement: { passed: true, entitlementKey: "grow.calling.recording", reason: "TEST", humanReason: "Test" },
      legalPolicy: { passed: true, jurisdiction: "AU", policyVersion: null, reason: "TEST", humanReason: "Test" },
      legacyConsentAndDisclosure: {
        passed: true, consentId, consentJurisdiction: "AU",
        disclosedInCall: true, confirmedInCall: true, reason: "TEST", humanReason: "Test",
      },
      adapterCapability: { passed: true, provider: "synthetic", reason: "TEST", humanReason: "Test" },
      operationalApproval: { passed: true, flag: "LIVE_RECORDING_APPROVED", reason: "TEST", humanReason: "Test" },
    },
  });
}

async function createRecordingFixture(): Promise<{
  sessionId: number;
  partyId: number;
  recordingReference: number;
}> {
  const [party] = await db.insert(parties).values({
    brokerageId, firstName: "Boundary", lastName: "Tester", mobile: "+61400000000",
  }).returning();
  assert.ok(party);
  const [consent] = await db.insert(growCallRecordingConsents).values({
    brokerageId, partyId: party.id, scope: "PER_CALL", status: "ACTIVE",
    source: "VERBAL_ON_CALL", jurisdiction: "AU", capturedByUserId: actor.user.id,
  }).returning();
  assert.ok(consent);
  const [session] = await db.insert(growCallSessions).values({
    brokerageId, partyId: party.id, initiatedByUserId: actor.user.id,
    destinationRaw: "+61400000000", destinationNormalized: "+61400000000",
    destinationCountry: "AU", provider: "synthetic", status: "CONNECTED",
    recordingRequested: true, recordingPermitted: true,
    recordingStatus: "PERMITTED_NOT_CAPTURED", recordingConsentId: consent.id,
  }).returning();
  assert.ok(session);
  const [decision] = await db.insert(growConsentDecisions).values({
    brokerageId, partyId: party.id, channel: "PHONE_CALL", decision: "ELIGIBLE",
    reasonCode: "OK", reasonCodes: [], decidedByUserId: actor.user.id,
    jurisdiction: "AU",
    evidence: { request: { brokerageId, partyId: party.id, channel: "PHONE_CALL", purpose: "PHONE_CALL", scope: "OUTBOUND" } },
  }).returning();
  assert.ok(decision);
  await db.insert((await import("@aee/db")).auditLogs).values([
    {
      brokerageId, userId: actor.user.id, action: "grow_call_recording_confirmation_received",
      recordType: "grow_call_session", recordId: String(session.id),
      updatedValue: "CONFIRMED",
    },
    {
      brokerageId, userId: actor.user.id, action: "grow_call_recording_enabled",
      recordType: "grow_call_session", recordId: String(session.id),
      updatedValue: fiveGateEvidence(consent.id, decision.id),
    },
  ]);
  const recording = await storeCallRecording({
    brokerageId,
    callSessionId: session.id,
    actor: { userId: actor.user.id, role: actor.user.role, brokerageId },
    actorUserId: actor.user.id,
    captureEvidence: {
      trustedByServer: true,
      source: "server-telephony-provider",
      captureId: `boundary-${session.id}`,
      provider: "synthetic",
      capturedAt: new Date(),
      providerRecordingId: `provider-recording-${session.id}`,
      providerEventId: `provider-event-${session.id}`,
      providerEventVerified: true,
    },
    bytes: Buffer.from("synthetic recording bytes"),
    declaredMimeType: "text/plain",
    originalFilename: `boundary-${session.id}.txt`,
  });
  return { sessionId: session.id, partyId: party.id, recordingReference: recording.version.id };
}

function transcriptionUrl(sessionId: number, suffix = ""): string {
  return `${baseUrl}/api/grow/calls/${sessionId}/transcription${suffix}`;
}

async function startTranscription(fixture: Awaited<ReturnType<typeof createRecordingFixture>>) {
  return fetch(transcriptionUrl(fixture.sessionId), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: actor.cookie },
    body: JSON.stringify({ recordingReference: fixture.recordingReference }),
  });
}

async function expectJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as T;
}

before(async () => {
  setDocumentStorageProviderForTests(storage);
  process.env.DOCUMENT_STORAGE_RETENTION_CLASSES = "legal-pending";
  process.env.AI_ENABLED = "true";
  process.env.AI_GROW_CALL_SUMMARY_ENABLED = "true";
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unexpected test server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const accounts = await createBrokerageWithUsers(baseUrl, `F3 Boundary ${Date.now()}`);
  brokerageId = accounts.brokerageId;
  actor = accounts.agent;
  await db.insert(entitlementGrants).values(["grow.calling.recording", "grow.calling.transcription"].map((entitlementKey) => ({
    brokerageId, entitlementKey,
    granteeType: "brokerage", granteeId: brokerageId,
    sourceType: "manual", status: "Active",
  })));
  invalidateEntitlementCache(brokerageId);
});

after(async () => {
  setCallTranscriptionProviderForTests(null);
  setCallTranscriptionDraftGatewayForTests(null);
  setDocumentStorageProviderForTests(null);
  forbiddenCalls.restore();
  await db.delete(growCallTranscriptions).where(eq(growCallTranscriptions.brokerageId, brokerageId));
  await db.delete(documentObjectVersions).where(eq(documentObjectVersions.brokerageId, brokerageId));
  await db.delete(documents).where(eq(documents.brokerageId, brokerageId));
  await cleanupBrokerages([brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

let writeGuard: ReturnType<typeof installForbiddenWriteGuard>;
beforeEach(() => {
  forbiddenCalls.assertUntouched();
  writeGuard = installForbiddenWriteGuard();
});
afterEach(() => {
  try {
    forbiddenCalls.assertUntouched();
    assert.deepEqual(writeGuard.counts, { insert: 0, update: 0, delete: 0 },
      "F3 attempted an F4 write (even if swallowed or rolled back)");
  } finally {
    writeGuard.restore();
  }
});

test("the full recording → transcript → draft → partial Save → Timeline pipeline stays outside F4", async () => {
  let providerCalls = 0;
  let draftCalls = 0;
  setCallTranscriptionProviderForTests({
    name: "mock",
    async transcribe() {
      providerCalls += 1;
      return { provider: "mock", transcript: "Synthetic boundary transcript.", durationSeconds: null, latencyMs: 1 };
    },
  });
  setCallTranscriptionDraftGatewayForTests(async () => {
    draftCalls += 1;
    return draftGatewayResponse(draftPayload);
  });
  const fixture = await createRecordingFixture();
  const before = await boundaryCounts();

  const created = await startTranscription(fixture);
  const createdBody = await expectJson<{
    transcription: {
      id: number; processingState: string;
      transcript: string | null;
      recordingReference: number | null;
      draftKeyPoints: Array<{ id: string }>;
      draftCommitments: Array<{ id: string }>;
      draftFollowups: Array<{ id: string }>;
    };
  }>(created);
  assert.equal(createdBody.transcription.processingState, "AWAITING_AGENT_REVIEW");
  assert.equal(createdBody.transcription.transcript, "Synthetic boundary transcript.");
  assert.equal(createdBody.transcription.recordingReference, fixture.recordingReference);
  assert.equal(providerCalls, 1);
  assert.equal(draftCalls, 1);
  assertNoBoundaryWrites(before, await boundaryCounts());
  forbiddenCalls.assertUntouched();

  const timelineBefore = await db.select({ id: growActivities.id }).from(growActivities)
    .where(and(eq(growActivities.brokerageId, brokerageId), eq(growActivities.activityType, "call_summary")));
  assert.equal(timelineBefore.length, 0);
  const reviewState = [
    { itemType: "TRANSCRIPT", itemId: "transcript", decision: "APPROVED", editedText: "Human transcript." },
    { itemType: "SUMMARY", itemId: "summary", decision: "APPROVED", editedText: "Human summary." },
    { itemType: "KEY_POINT", itemId: createdBody.transcription.draftKeyPoints[0]!.id, decision: "REJECTED" },
    // Approving actionable-looking text must still create only passive history.
    { itemType: "COMMITMENT", itemId: createdBody.transcription.draftCommitments[0]!.id, decision: "APPROVED" },
    { itemType: "FOLLOWUP", itemId: createdBody.transcription.draftFollowups[0]!.id, decision: "APPROVED" },
  ];
  const saved = await fetch(transcriptionUrl(fixture.sessionId, `/${createdBody.transcription.id}/review`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: actor.cookie },
    body: JSON.stringify({ reviewState }),
  });
  const savedBody = await expectJson<{
    transcription: { id: number; processingState: string; transcript: string | null; recordingReference: number | null };
  }>(saved);
  assert.equal(savedBody.transcription.processingState, "PARTIALLY_APPROVED");
  assert.equal(savedBody.transcription.transcript, null);
  assert.equal(savedBody.transcription.recordingReference, null);
  assert.doesNotMatch(JSON.stringify(savedBody), /Synthetic boundary transcript|Human transcript/);
  const [finished] = await db.select().from(growCallTranscriptions)
    .where(eq(growCallTranscriptions.id, createdBody.transcription.id));
  assert.equal(finished?.transcript, null);
  assert.equal(finished?.recordingReference, null);
  assert.equal(finished?.recordingContentSha256?.length, 64);
  assert.equal(finished?.retentionAudit?.purgeMigrationId, "forward-review-save");
  assert.equal(finished?.retentionAudit?.providerId, "mock");
  const [recordingStillStored] = await db.select().from(documentObjectVersions)
    .where(eq(documentObjectVersions.id, fixture.recordingReference));
  assert.equal(recordingStillStored?.objectStatus, "Active");
  assertNoBoundaryWrites(before, await boundaryCounts());
  forbiddenCalls.assertUntouched();
  const timelineAfter = await db.select({ id: growActivities.id }).from(growActivities)
    .where(and(eq(growActivities.brokerageId, brokerageId), eq(growActivities.activityType, "call_summary")));
  assert.equal(timelineAfter.length, 1, "Save must write exactly one passive Timeline activity");
  const [savedActivity] = await db.select().from(growActivities).where(eq(growActivities.id, timelineAfter[0]!.id));
  assert.doesNotMatch(JSON.stringify(savedActivity), /Synthetic boundary transcript|Human transcript/);
  const replay = await startTranscription(fixture);
  const replayBody = await expectJson<{ transcription: { id: number; transcript: string | null } }>(replay);
  assert.equal(replayBody.transcription.id, createdBody.transcription.id);
  assert.equal(replayBody.transcription.transcript, null);
  const sessionRows = await db.select().from(growCallTranscriptions)
    .where(eq(growCallTranscriptions.callSessionId, fixture.sessionId));
  assert.equal(sessionRows.length, 1);
});

test("discard and reconciliation are terminal F3 operations with no F4 side effects", async () => {
  setCallTranscriptionProviderForTests({
    name: "mock",
    async transcribe() {
      return { provider: "mock", transcript: "Discard boundary transcript.", durationSeconds: null, latencyMs: 1 };
    },
  });
  const discardFixture = await createRecordingFixture();
  const beforeDiscard = await boundaryCounts();
  const created = await startTranscription(discardFixture);
  const createdBody = await expectJson<{ transcription: { id: number } }>(created);
  const discarded = await fetch(transcriptionUrl(discardFixture.sessionId, `/${createdBody.transcription.id}/discard`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: actor.cookie },
    body: "{}",
  });
  assert.equal(discarded.status, 200, await discarded.text());
  assertNoBoundaryWrites(beforeDiscard, await boundaryCounts());
  forbiddenCalls.assertUntouched();

  const reconciliationFixture = await createRecordingFixture();
  const reconciliationCreated = await startTranscription(reconciliationFixture);
  const reconciliationBody = await expectJson<{ transcription: { id: number } }>(reconciliationCreated);
  await db.update(growCallTranscriptions).set({
    processingState: "TRANSCRIBING",
    updatedAt: new Date(Date.now() - 60 * 60 * 1_000),
  }).where(eq(growCallTranscriptions.id, reconciliationBody.transcription.id));
  const beforeReconcile = await boundaryCounts();
  const result = await reconcileAbandonedCallTranscriptions({
    now: new Date(),
    staleAfterMs: 120_000,
    batchSize: 100,
    // Scoped to this file's tenant so this aggressive (2-minute) sweep never
    // fails another concurrently-running test file's in-flight rows.
    brokerageId,
  });
  assert.equal(result.scanned >= 1, true);
  assertNoBoundaryWrites(beforeReconcile, await boundaryCounts());
  const [row] = await db.select({ processingState: growCallTranscriptions.processingState })
    .from(growCallTranscriptions)
    .where(eq(growCallTranscriptions.id, reconciliationBody.transcription.id));
  assert.equal(row?.processingState, "FAILED");
  forbiddenCalls.assertUntouched();

  // Exercise the scheduled job entrypoint too, on an actual abandoned row.
  await db.update(growCallTranscriptions).set({
    processingState: "TRANSCRIBING", updatedAt: new Date(Date.now() - 60 * 60 * 1_000),
  }).where(eq(growCallTranscriptions.id, reconciliationBody.transcription.id));
  const swept = await runCallTranscriptionReconciliationSweep();
  assert.ok(swept && swept.failedAbandoned >= 1);
  assertNoBoundaryWrites(beforeReconcile, await boundaryCounts());
  forbiddenCalls.assertUntouched();
});

test("negative controls catch every actual forbidden export, including a swallowed call", async () => {
  for (const probe of forbiddenCalls.probes) {
    // Equivalent to adding this forbidden import/call inside F3 generation,
    // Save, discard, or reconciliation. No production implementation executes.
    await assert.rejects(() => probe.invoke(), /F4 forbidden call/);
    assert.equal(forbiddenCalls.calls.length, 1, probe.name);
    assert.throws(() => forbiddenCalls.assertUntouched(), /F3 invoked an F4-owned function/);
    forbiddenCalls.resetForNegativeControl();
  }
});

test("negative controls catch root, transaction, and nested-transaction write attempts before persistence", async () => {
  const before = await boundaryCounts();
  for (const table of [growCommitments, workflowChangeProposals, aiActionRequests,
    communicationThreads, communicationMessages, automationTasks, growOpportunitySignals]) {
    for (const operation of ["insert", "update", "delete"] as const) {
      const attempt = (executor: unknown) =>
        (executor as Record<ForbiddenWriteOperation, (table: unknown) => unknown>)[operation](table);
      for (const depth of [0, 1, 2]) {
        if (depth === 0) assert.throws(() => attempt(db), /F4 boundary write attempted/);
        else await assert.rejects(db.transaction(async (tx) => {
          if (depth === 1) attempt(tx);
          else await tx.transaction(async (nested) => { attempt(nested); });
        }), /F4 boundary write attempted/);
        // The write has thrown/rolled back; our zero-attempt assertion MUST
        // still fail. A final-row-count-only test would miss this violation.
        assert.equal(writeGuard.counts[operation], 1);
        assert.throws(() => assert.deepEqual(writeGuard.counts, { insert: 0, update: 0, delete: 0 }));
        writeGuard.counts[operation] = 0;
      }
    }
  }
  assertNoBoundaryWrites(before, await boundaryCounts());
});

test("the boundary assertion is non-vacuous for every forbidden category", () => {
  const before: BoundaryCounts = {
    commitments: 0, proposals: 0, communicationThreads: 0,
    communicationMessages: 0, tasks: 0, actionRequests: 0, opportunitySignals: 0,
  };
  for (const category of Object.keys(before) as Array<keyof BoundaryCounts>) {
    const after = { ...before, [category]: 1 };
    assert.throws(() => assertNoBoundaryWrites(before, after), /F4 side-effect boundary/);
  }
});
}