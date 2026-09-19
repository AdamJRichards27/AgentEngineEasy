/**
 * AE GROW Priority 6 Stage F4.1 — governed call follow-ups (HTTP level).
 *
 * Like callTranscriptionBoundary.test.ts, this file re-executes itself in an
 * isolated Node process with --experimental-test-module-mocks so messaging,
 * outbox, automation, the AI model gateway, the F3 AI draft gateway, and NBA
 * can be replaced by counting, throwing mocks BEFORE the app is imported.
 */
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import {
  aiActionRequests,
  automationAttentionItems,
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
  parties,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import {
  cleanupBrokerages,
  createBrokerageWithUsers,
  devLogin,
  type DevLoginResult,
} from "./testSupport.js";

const EXPECTED_TESTS = 8;

if (!process.execArgv.includes("--experimental-test-module-mocks")) {
  test("F4.1 governed call follow-ups suite (isolated module-mock process)", async (t) => {
    const childEnv = { ...process.env };
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
    t.diagnostic(output.split("\n").filter((line) => !line.startsWith("{\"timestamp\"")).join("\n"));
    assert.equal(exit, 0, output);
    assert.match(output, new RegExp(`# tests ${EXPECTED_TESTS}\\b`), "every F4.1 route case must actually execute");
    assert.match(output, /# fail 0\b/);
    assert.match(output, /# skipped 0\b/);
  });
} else {
process.env.NODE_ENV = "test";
process.env.OPERATIONAL_ALERTS_ENABLED = "false";
process.env.OPERATIONAL_ALERTS_PROVIDER = "disabled";
process.env.SESSION_SECRET = process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
  ? process.env.SESSION_SECRET : "f4-followups-route-test-secret-0123456789012345";
process.env.ALLOW_DEV_AUTH = "true";
const { installF4ForbiddenCalls } = await import("./support/f4ForbiddenCalls.js");
const forbiddenCalls = await installF4ForbiddenCalls();
// Controllable pass-through around the REAL proposeAIAction, used only by
// the C3 tests to force a mid-loop policy denial or failure. "real" (the
// default for every other test) delegates unchanged.
type ActionRequestsModule = typeof import("../../lib/ai/actionRequests.js");
const proposeControl: { mode: "real" | "denyAfterFirst" | "denyAll" | "throw"; calls: number } = { mode: "real", calls: 0 };
const actionRequestsUrl = new URL("../../lib/ai/actionRequests.ts", import.meta.url).href;
const realActionRequests = await import(actionRequestsUrl) as ActionRequestsModule;
const actionRequestsMock = mock.module(actionRequestsUrl, {
  cache: true,
  namedExports: {
    ...realActionRequests,
    proposeAIAction: async (input: Parameters<ActionRequestsModule["proposeAIAction"]>[0]) => {
      proposeControl.calls += 1;
      if (proposeControl.mode === "throw") throw new Error("synthetic proposal failure");
      if (proposeControl.mode === "denyAll" || (proposeControl.mode === "denyAfterFirst" && proposeControl.calls > 1)) {
        return { request: null, decision: { allowed: false, reason: "ENTITLEMENT_DENIED" } };
      }
      return realActionRequests.proposeAIAction(input);
    },
  },
});
const { proposeCallFollowups, GrowCallFollowupError, setGrowCallFollowupAuditFailureForTests } =
  await import("../../lib/growCallFollowups.js");
const { saveCallTranscriptionReview } = await import("../../lib/telephony/callTranscriptionReview.js");
const { persistApprovedCallSummaryActivity } = await import("../../lib/telephony/callTranscriptionTimeline.js");
const { withdrawRecordingConsent } = await import("../../lib/telephony/consent.js");
const { getRelationshipTimeline } = await import("../../lib/relationshipTimeline.js");

let server: Server;
let baseUrl: string;
let A: Awaited<ReturnType<typeof createBrokerageWithUsers>>;
let B: Awaited<ReturnType<typeof createBrokerageWithUsers>>;
let C: Awaited<ReturnType<typeof createBrokerageWithUsers>>;
let other: DevLoginResult;
let fixtureNumber = 0;

const COMMITMENT_TEXT = "Email the comparable sales report.";
const FOLLOWUP_TEXT = "Check in after the open home on Saturday.";
const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

function followupsUrl(fixture: Fixture, suffix = ""): string {
  return `${baseUrl}/api/grow/calls/${fixture.sessionId}/transcription/${fixture.transcriptionId}/followups${suffix}`;
}

async function post(url: string, cookie: string, body: unknown = {}): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
}

async function grantBrokerage(brokerageId: number, keys: string[]) {
  await db.insert(entitlementGrants).values(keys.map((entitlementKey) => ({
    brokerageId, entitlementKey, granteeType: "brokerage", granteeId: brokerageId, sourceType: "manual", status: "Active",
  })));
  invalidateEntitlementCache(brokerageId);
}

async function createFixture(owner = A.agent, brokerageId = A.brokerageId) {
  fixtureNumber += 1;
  const [party] = await db.insert(parties).values({
    brokerageId, firstName: "Route", lastName: `Followup ${fixtureNumber}`, mobile: "+61400123456",
  }).returning();
  const [consent] = await db.insert(growCallRecordingConsents).values({
    brokerageId, partyId: party!.id, scope: "PER_CALL", status: "ACTIVE", source: "VERBAL_ON_CALL",
    capturedByUserId: owner.user.id, jurisdiction: "AU",
  }).returning();
  const [session] = await db.insert(growCallSessions).values({
    brokerageId, partyId: party!.id, initiatedByUserId: owner.user.id,
    destinationRaw: "+61400123456", destinationNormalized: "+61400123456",
    destinationCountry: "AU", provider: "synthetic", status: "COMPLETED",
    recordingRequested: true, recordingStatus: "PERMITTED_NOT_CAPTURED",
    recordingConsentId: consent!.id, endedAt: new Date(),
  }).returning();
  const storageKey = `f4-route-followup-${session!.id}`;
  const [document] = await db.insert(documents).values({
    brokerageId, logicalOwnerType: "telephony-call", logicalOwnerId: session!.id,
    documentType: "CallRecording", title: "Route followup recording", status: "Generated", objectStorageKey: storageKey,
  }).returning();
  const [version] = await db.insert(documentObjectVersions).values({
    documentId: document!.id, brokerageId, storageObjectKey: storageKey, version: 1,
    originalFilename: "recording.wav", displayFilename: "recording.wav",
    declaredMimeType: "audio/wav", detectedMimeType: "audio/wav", byteSize: 1,
    contentSha256: "0".repeat(64), source: "upload", objectStatus: "Active", uploadedBy: owner.user.id,
  }).returning();
  const [transcription] = await db.insert(growCallTranscriptions).values({
    brokerageId, callSessionId: session!.id, partyId: party!.id,
    recordingReference: version!.id, processingState: "AWAITING_AGENT_REVIEW",
    transcript: "Route machine transcript.", draftSummary: "Route machine summary.",
    draftKeyPoints: [{ id: "kp-1", text: "Route point." }],
    draftCommitments: [{ id: "com-1", text: "Route machine commitment.", dueAt: inDays(2) }],
    draftFollowups: [{ id: "fu-1", text: FOLLOWUP_TEXT }],
  }).returning();
  // Real F3 explicit Save: approval + call_summary Timeline snapshot.
  await saveCallTranscriptionReview({
    brokerageId, callSessionId: session!.id, transcriptionId: transcription!.id,
    actor: { userId: owner.user.id, role: owner.user.role, brokerageId },
    body: { reviewState: [
      { itemType: "TRANSCRIPT", itemId: "transcript", decision: "APPROVED", editedText: "Human transcript." },
      { itemType: "SUMMARY", itemId: "summary", decision: "APPROVED" },
      { itemType: "KEY_POINT", itemId: "kp-1", decision: "APPROVED" },
      { itemType: "COMMITMENT", itemId: "com-1", decision: "APPROVED", editedText: COMMITMENT_TEXT },
      { itemType: "FOLLOWUP", itemId: "fu-1", decision: "APPROVED" },
    ] },
  }, persistApprovedCallSummaryActivity);
  return { partyId: party!.id, consentId: consent!.id, sessionId: session!.id, transcriptionId: transcription!.id, brokerageId };
}
type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function requestsFor(fixture: Fixture) {
  const rows = await db.select().from(aiActionRequests).where(eq(aiActionRequests.brokerageId, fixture.brokerageId));
  return rows.filter((row) => row.resourceId?.startsWith(`transcription:${fixture.transcriptionId}:`));
}

async function sideEffectCounts(brokerageId: number) {
  const count = async (table: typeof communicationMessages | typeof communicationThreads | typeof automationTasks | typeof automationAttentionItems) =>
    (await db.select().from(table as typeof automationTasks).where(eq((table as typeof automationTasks).brokerageId, brokerageId))).length;
  return {
    messages: await count(communicationMessages),
    threads: await count(communicationThreads),
    tasks: await count(automationTasks),
    attention: await count(automationAttentionItems),
  };
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected test server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `F4 followups route ${Date.now()}`);
  B = await createBrokerageWithUsers(baseUrl, `F4 followups route foreign ${Date.now()}`);
  C = await createBrokerageWithUsers(baseUrl, `F4 followups route unentitled ${Date.now()}`);
  other = await devLogin(baseUrl, {
    email: `f4-followups-other-${A.brokerageId}@test.invalid`,
    firstName: "Other", lastName: "Agent", brokerageName: A.admin.user.brokerageName!,
  });
  await grantBrokerage(A.brokerageId, ["grow.calling.transcription", "grow.activities.manage"]);
  await grantBrokerage(B.brokerageId, ["grow.calling.transcription", "grow.activities.manage"]);
  await grantBrokerage(C.brokerageId, ["grow.calling.transcription"]);
});

after(async () => {
  const brokerageIds = [A.brokerageId, B.brokerageId, C.brokerageId];
  await db.delete(growCallTranscriptions).where(inArray(growCallTranscriptions.brokerageId, brokerageIds));
  await db.delete(documentObjectVersions).where(inArray(documentObjectVersions.brokerageId, brokerageIds));
  await db.delete(documents).where(inArray(documents.brokerageId, brokerageIds));
  await cleanupBrokerages(brokerageIds);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  forbiddenCalls.restore();
  actionRequestsMock.restore();
});

async function withProposeMode<T>(mode: typeof proposeControl.mode, run: () => Promise<T>): Promise<T> {
  proposeControl.mode = mode;
  proposeControl.calls = 0;
  try {
    return await run();
  } finally {
    proposeControl.mode = "real";
    setGrowCallFollowupAuditFailureForTests(null);
  }
}

const twoItems = () => ({ items: [
  { itemType: "COMMITMENT", itemId: "com-1", dueAt: inDays(3) },
  { itemType: "FOLLOWUP", itemId: "fu-1", dueAt: inDays(3) },
] });

test("C3: a policy denial after earlier items were proposed says so (403 POLICY_DENIED, {error, code}); a first-item denial says nothing was proposed", async () => {
  const partial = await createFixture();
  const res = await withProposeMode("denyAfterFirst", () => post(followupsUrl(partial, "/propose"), A.agent.cookie, twoItems()));
  assert.equal(res.status, 403);
  const body = await res.json() as Record<string, string>;
  assert.deepEqual(Object.keys(body).sort(), ["code", "error"]);
  assert.equal(body.code, "POLICY_DENIED");
  assert.match(body.error, /after some items had already been proposed/);
  assert.match(body.error, /refresh/i);
  const created = await requestsFor(partial);
  assert.equal(created.length, 1);
  assert.equal(created[0]!.status, "AWAITING_APPROVAL");

  const none = await createFixture();
  const denied = await withProposeMode("denyAll", () => post(followupsUrl(none, "/propose"), A.agent.cookie, twoItems()));
  assert.equal(denied.status, 403);
  const deniedBody = await denied.json() as Record<string, string>;
  assert.equal(deniedBody.code, "POLICY_DENIED");
  assert.match(deniedBody.error, /Nothing was proposed/);
  assert.doesNotMatch(deniedBody.error, /already been proposed/);
  assert.equal((await requestsFor(none)).length, 0);
});

test("C3: AUDIT_INCOMPLETE is only claimed when this call created a proposal; otherwise the original failure is surfaced", async () => {
  const call = (fixture: Fixture) => proposeCallFollowups({
    brokerageId: A.brokerageId,
    actor: { userId: A.agent.user.id, role: A.agent.user.role, brokerageId: A.brokerageId },
    callSessionId: fixture.sessionId, transcriptionId: fixture.transcriptionId, body: twoItems(),
  });

  // Loop throws before anything is created AND the closing audit fails.
  const thrown = await createFixture();
  await withProposeMode("throw", async () => {
    setGrowCallFollowupAuditFailureForTests("grow_call_followup_proposed");
    await assert.rejects(call(thrown), (error: unknown) =>
      !(error instanceof GrowCallFollowupError) && error instanceof Error && error.message === "synthetic proposal failure");
  });
  assert.equal((await requestsFor(thrown)).length, 0);

  // First-item policy denial AND the closing audit fails: POLICY_DENIED, not AUDIT_INCOMPLETE.
  const denied = await createFixture();
  await withProposeMode("denyAll", async () => {
    setGrowCallFollowupAuditFailureForTests("grow_call_followup_proposed");
    await assert.rejects(call(denied), (error: unknown) =>
      error instanceof GrowCallFollowupError && error.code === "POLICY_DENIED" && /Nothing was proposed/.test(error.message));
  });
  assert.equal((await requestsFor(denied)).length, 0);

  // Nothing new (all EXISTING) AND the closing audit fails: AUDIT_FAILURE.
  const existing = await createFixture();
  await call(existing);
  await withProposeMode("real", async () => {
    setGrowCallFollowupAuditFailureForTests("grow_call_followup_proposed");
    await assert.rejects(call(existing), (error: unknown) =>
      error instanceof GrowCallFollowupError && error.code === "AUDIT_FAILURE");
  });
  assert.equal((await requestsFor(existing)).length, 2);

  // Control: one item created, then denied, then the audit fails -> AUDIT_INCOMPLETE is accurate.
  const partial = await createFixture();
  await withProposeMode("denyAfterFirst", async () => {
    setGrowCallFollowupAuditFailureForTests("grow_call_followup_proposed");
    await assert.rejects(call(partial), (error: unknown) =>
      error instanceof GrowCallFollowupError && error.code === "AUDIT_INCOMPLETE");
  });
  assert.equal((await requestsFor(partial)).length, 1);
});

test("HTTP: authenticated owner lists candidates and proposes; human approval + governed execution creates the commitments; no side effects", async () => {
  const fixture = await createFixture();
  const before = await sideEffectCounts(A.brokerageId);

  assert.equal((await fetch(followupsUrl(fixture))).status, 401);
  const listed = await fetch(followupsUrl(fixture), { headers: { cookie: A.agent.cookie } });
  assert.equal(listed.status, 200);
  const listBody = await listed.json() as { partyId: number; candidates: Array<{ itemType: string; itemId: string; text: string; suggestedDueAt: string | null }> };
  assert.equal(listBody.partyId, fixture.partyId);
  assert.deepEqual(listBody.candidates.map((c) => [c.itemType, c.itemId, c.text]), [
    ["COMMITMENT", "com-1", COMMITMENT_TEXT],
    ["FOLLOWUP", "fu-1", FOLLOWUP_TEXT],
  ]);
  assert.ok(listBody.candidates[0]!.suggestedDueAt);
  assert.equal(listBody.candidates[1]!.suggestedDueAt, null);

  const commitmentDue = inDays(5);
  const followupDue = inDays(6);
  const proposed = await post(followupsUrl(fixture, "/propose"), A.agent.cookie, { items: [
    { itemType: "COMMITMENT", itemId: "com-1", dueAt: commitmentDue },
    { itemType: "FOLLOWUP", itemId: "fu-1", dueAt: followupDue },
  ] });
  assert.equal(proposed.status, 201);
  const proposedBody = await proposed.json() as { proposals: Array<{ status: string; actionRequest: { actionRequestId: number; status: string } }> };
  assert.deepEqual(proposedBody.proposals.map((p) => [p.status, p.actionRequest.status]), [
    ["PROPOSED", "AWAITING_APPROVAL"], ["PROPOSED", "AWAITING_APPROVAL"],
  ]);
  const commitmentsBefore = await db.select().from(growCommitments).where(eq(growCommitments.partyId, fixture.partyId));
  assert.equal(commitmentsBefore.length, 0, "no commitment before approval + execution");

  // Replay is idempotent.
  const replay = await post(followupsUrl(fixture, "/propose"), A.agent.cookie, { items: [
    { itemType: "COMMITMENT", itemId: "com-1", dueAt: commitmentDue },
  ] });
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { proposals: Array<{ status: string }> }).proposals[0]!.status, "EXISTING");

  for (const proposal of proposedBody.proposals) {
    const id = proposal.actionRequest.actionRequestId;
    const approve = await post(`${baseUrl}/api/ai/actions/requests/${id}/approve`, A.agent.cookie);
    assert.equal(approve.status, 200, await approve.clone().text());
    const execute = await post(`${baseUrl}/api/ai/actions/requests/${id}/execute`, A.agent.cookie);
    assert.equal(execute.status, 200, await execute.clone().text());
  }
  const commitments = await db.select().from(growCommitments).where(and(
    eq(growCommitments.brokerageId, A.brokerageId), eq(growCommitments.partyId, fixture.partyId),
  ));
  assert.deepEqual(commitments.map((c) => [c.description, c.dueAt.toISOString()]).sort(), [
    [COMMITMENT_TEXT, new Date(commitmentDue).toISOString()],
    [FOLLOWUP_TEXT, new Date(followupDue).toISOString()],
  ].sort());
  const timeline = await getRelationshipTimeline(A.brokerageId, fixture.partyId);
  assert.equal(timeline.filter((event) => event.type === "COMMITMENT_CREATED").length, 2);

  assert.deepEqual(await sideEffectCounts(A.brokerageId), before, "no messages, threads, tasks, or attention items");
  forbiddenCalls.assertUntouched();
});

test("HTTP: strict body rejects injected description/partyId/brokerageId/actorType and malformed items with 400 {error, code}", async () => {
  const fixture = await createFixture();
  const base = { itemType: "COMMITMENT", itemId: "com-1", dueAt: inDays(3) };
  const bodies: unknown[] = [
    { items: [{ ...base, description: "Injected" }] },
    { items: [{ ...base, partyId: fixture.partyId }] },
    { items: [{ ...base, brokerageId: B.brokerageId }] },
    { items: [{ ...base, actorType: "USER" }] },
    { items: [base], description: "Injected" },
    { items: [base], brokerageId: B.brokerageId },
    { items: [] },
    { items: [{ itemType: "SUMMARY", itemId: "summary", dueAt: inDays(3) }] },
    { items: [{ itemType: "KEY_POINT", itemId: "kp-1", dueAt: inDays(3) }] },
    { items: [{ itemType: "COMMITMENT", itemId: "com-1" }] },
    { items: [{ ...base, dueAt: "next week" }] },
    {},
  ];
  for (const body of bodies) {
    const res = await post(followupsUrl(fixture, "/propose"), A.agent.cookie, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const payload = await res.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ["code", "error"]);
    assert.equal(payload.code, "INVALID_INPUT");
  }
  // Server-side validation: unknown item and out-of-window due date.
  for (const items of [
    [{ itemType: "COMMITMENT", itemId: "nope", dueAt: inDays(3) }],
    [{ ...base, dueAt: inDays(1000) }],
  ]) {
    const res = await post(followupsUrl(fixture, "/propose"), A.agent.cookie, { items });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "INVALID_INPUT");
  }
  assert.equal((await requestsFor(fixture)).length, 0);
});

test("HTTP authority: non-owner 403, admin allowed, cross-tenant 404, missing entitlements 403", async () => {
  const fixture = await createFixture();
  const items = { items: [{ itemType: "FOLLOWUP", itemId: "fu-1", dueAt: inDays(4) }] };

  const denied = await post(followupsUrl(fixture, "/propose"), other.cookie, items);
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "You are not authorised to access or mutate this call session.", code: "ACCESS_DENIED" });
  assert.equal((await fetch(followupsUrl(fixture), { headers: { cookie: other.cookie } })).status, 403);
  assert.equal((await requestsFor(fixture)).length, 0);

  const foreign = await post(followupsUrl(fixture, "/propose"), B.admin.cookie, items);
  assert.equal(foreign.status, 404);
  assert.equal(((await foreign.json()) as { code: string }).code, "NOT_FOUND");
  assert.equal((await fetch(followupsUrl(fixture), { headers: { cookie: B.agent.cookie } })).status, 404);

  // C holds grow.calling.transcription but not grow.activities.manage.
  const cFixture = await createFixture(C.agent, C.brokerageId);
  assert.equal((await post(followupsUrl(cFixture, "/propose"), C.agent.cookie, items)).status, 403);
  assert.equal((await fetch(followupsUrl(cFixture), { headers: { cookie: C.agent.cookie } })).status, 403);
  // ...and with grow.activities.manage but no grow.calling.transcription.
  await db.delete(entitlementGrants).where(eq(entitlementGrants.brokerageId, C.brokerageId));
  await grantBrokerage(C.brokerageId, ["grow.activities.manage"]);
  assert.equal((await post(followupsUrl(cFixture, "/propose"), C.agent.cookie, items)).status, 403);
  assert.equal((await requestsFor(cFixture)).length, 0);

  const byAdmin = await post(followupsUrl(fixture, "/propose"), A.admin.cookie, items);
  assert.equal(byAdmin.status, 201);
  // The owner now sees the admin's proposal only as ALREADY_PROPOSED.
  const ownerView = await post(followupsUrl(fixture, "/propose"), A.agent.cookie, items);
  assert.equal(ownerView.status, 200);
  assert.deepEqual(((await ownerView.json()) as { proposals: unknown[] }).proposals, [
    { itemType: "FOLLOWUP", itemId: "fu-1", status: "ALREADY_PROPOSED", actionRequest: null },
  ]);
  forbiddenCalls.assertUntouched();
});

test("HTTP consent withdrawn: 409 CONSENT_WITHDRAWN and no new proposal; the earlier proposal is still approvable", async () => {
  const fixture = await createFixture();
  const first = await post(followupsUrl(fixture, "/propose"), A.agent.cookie, {
    items: [{ itemType: "COMMITMENT", itemId: "com-1", dueAt: inDays(4) }],
  });
  assert.equal(first.status, 201);
  const firstId = ((await first.json()) as { proposals: Array<{ actionRequest: { actionRequestId: number } }> })
    .proposals[0]!.actionRequest.actionRequestId;
  await withdrawRecordingConsent({ brokerageId: A.brokerageId, consentId: fixture.consentId, withdrawnByUserId: A.agent.user.id });

  const blocked = await post(followupsUrl(fixture, "/propose"), A.agent.cookie, {
    items: [{ itemType: "FOLLOWUP", itemId: "fu-1", dueAt: inDays(4) }],
  });
  assert.equal(blocked.status, 409);
  assert.equal(((await blocked.json()) as { code: string }).code, "CONSENT_WITHDRAWN");
  const listed = await fetch(followupsUrl(fixture), { headers: { cookie: A.agent.cookie } });
  assert.equal(((await listed.json()) as { consentBlocked: boolean }).consentBlocked, true);
  const requests = await requestsFor(fixture);
  assert.deepEqual(requests.map((row) => [row.id, row.status]), [[firstId, "AWAITING_APPROVAL"]]);
  assert.equal((await post(`${baseUrl}/api/ai/actions/requests/${firstId}/approve`, A.agent.cookie)).status, 200);
  assert.equal((await post(`${baseUrl}/api/ai/actions/requests/${firstId}/execute`, A.agent.cookie)).status, 200);
});

test("pending-commitments ?partyId returns only the caller's own, non-expired proposals for that contact", async () => {
  const one = await createFixture();
  const two = await createFixture();
  for (const fixture of [one, two]) {
    const res = await post(followupsUrl(fixture, "/propose"), A.agent.cookie, { items: [
      { itemType: "COMMITMENT", itemId: "com-1", dueAt: inDays(3) },
      { itemType: "FOLLOWUP", itemId: "fu-1", dueAt: inDays(3) },
    ] });
    assert.equal(res.status, 201);
  }
  const pendingUrl = (partyId: unknown) => `${baseUrl}/api/grow/ai-actions/pending-commitments?partyId=${partyId}`;
  type Pending = { proposals: Array<{ id: number; input: { partyId: number }; provenance: { source: string; transcriptionId: number; itemType: string; itemId: string } | null }> };
  const list = async (cookie: string, partyId: unknown) => {
    const res = await fetch(pendingUrl(partyId), { headers: { cookie } });
    assert.equal(res.status, 200);
    return (await res.json()) as Pending;
  };

  const own = await list(A.agent.cookie, one.partyId);
  assert.equal(own.proposals.length, 2);
  assert.ok(own.proposals.every((p) => p.input.partyId === one.partyId));
  assert.deepEqual(own.proposals.map((p) => p.provenance).sort((a, b) => a!.itemType.localeCompare(b!.itemType)), [
    { source: "call_review", transcriptionId: one.transcriptionId, itemType: "COMMITMENT", itemId: "com-1" },
    { source: "call_review", transcriptionId: one.transcriptionId, itemType: "FOLLOWUP", itemId: "fu-1" },
  ]);
  assert.equal((await list(A.admin.cookie, one.partyId)).proposals.length, 0, "only the caller's own requests");
  assert.equal((await list(other.cookie, one.partyId)).proposals.length, 0);
  assert.equal((await list(B.agent.cookie, one.partyId)).proposals.length, 0, "never cross-tenant");
  assert.equal((await list(A.agent.cookie, 999_999_999)).proposals.length, 0);

  const [expire] = own.proposals;
  await db.update(aiActionRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(aiActionRequests.id, expire!.id));
  assert.equal((await list(A.agent.cookie, one.partyId)).proposals.length, 1, "expired proposals are excluded");
  assert.equal((await list(A.agent.cookie, two.partyId)).proposals.length, 2);

  for (const bad of ["abc", "0", "-1", "1.5"]) {
    const res = await fetch(pendingUrl(bad), { headers: { cookie: A.agent.cookie } });
    assert.equal(res.status, 400, bad);
  }
  const unfiltered = await fetch(`${baseUrl}/api/grow/ai-actions/pending-commitments`, { headers: { cookie: A.agent.cookie } });
  assert.ok(((await unfiltered.json()) as Pending).proposals.length >= 3);
});

test("negative control: the forbidden-call mocks are live and would catch a messaging, automation, or AI call", async () => {
  forbiddenCalls.assertUntouched();
  for (const probe of forbiddenCalls.probes) {
    await assert.rejects(async () => probe.invoke(), /F4\.1 forbidden call/, probe.name);
  }
  assert.equal(forbiddenCalls.calls.length, forbiddenCalls.probes.length);
  forbiddenCalls.resetForNegativeControl();
});
}
