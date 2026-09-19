/**
 * AE GROW Priority 6 Stage F4.1 — governed call follow-ups (service level).
 *
 * Fixtures follow the F3 review tests: a real tenant-scoped call session,
 * recording ledger row, and transcription, reviewed through the real F3
 * Save (which writes the canonical call_summary snapshot). Proposals then go
 * through the real Stage D proposeAIAction/approve/execute functions.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  aiActionRequests,
  auditLogs,
  brokerages,
  db,
  documentObjectVersions,
  documents,
  entitlementGrants,
  growCallRecordingConsents,
  growCallSessions,
  growCallTranscriptions,
  growCommitments,
  parties,
  users,
} from "@aee/db";
import { cleanupBrokerages } from "../../routes/__tests__/testSupport.js";
import { saveCallTranscriptionReview, discardCallTranscription } from "../telephony/callTranscriptionReview.js";
import { persistApprovedCallSummaryActivity } from "../telephony/callTranscriptionTimeline.js";
import { withdrawRecordingConsent } from "../telephony/consent.js";
import { approveAIActionRequest } from "../ai/actionRequests.js";
import { executeAIAction } from "../ai/executionGateway.js";
import { getRelationshipTimeline } from "../relationshipTimeline.js";
import { configureEvents } from "../events.js";
import {
  GrowCallFollowupError,
  listCallFollowupCandidates,
  proposeCallFollowups,
  setGrowCallFollowupAuditFailureForTests,
} from "../growCallFollowups.js";

process.env.NODE_ENV = "test";

type User = { id: number; role: string };
let brokerageId: number;
let foreignBrokerageId: number;
let owner: User;
let otherAgent: User;
let admin: User;
let noManage: User;
let noTranscription: User;
let foreignUser: User;
let fixtureNumber = 0;

const actorOf = (user: User, brokerage = brokerageId) => ({ userId: user.id, role: user.role, brokerageId: brokerage });
const policyActorOf = (user: User) => ({ id: user.id, role: user.role, brokerageId });
const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

const APPROVED_COMMITMENT = "Send the vendor the signed appraisal pack.";
const EDITED_FOLLOWUP = "Call back after the auction to discuss pricing.";
const REJECTED_TEXT = "Rejected machine commitment.";

async function createUser(label: string, role: string, brokerage: number): Promise<User> {
  const [user] = await db.insert(users).values({
    authProviderId: `f4-${label}-${brokerage}`, email: `f4-${label}-${brokerage}@test.invalid`,
    firstName: "F4", lastName: label, role, brokerageId: brokerage,
  }).returning();
  return { id: user!.id, role: user!.role };
}

async function grant(brokerage: number, user: User, key: string) {
  await db.insert(entitlementGrants).values({
    brokerageId: brokerage, entitlementKey: key, granteeType: "user", granteeId: user.id,
    sourceType: "manual", status: "Active",
  });
}

async function createFixture(options: {
  review?: "SAVED" | "AWAITING" | "DISCARDED";
  initiator?: User;
  withConsent?: boolean;
} = {}) {
  fixtureNumber += 1;
  const initiator = options.initiator ?? owner;
  const [party] = await db.insert(parties).values({
    brokerageId, firstName: "Followup", lastName: `Fixture ${fixtureNumber}`,
  }).returning();
  const [consent] = await db.insert(growCallRecordingConsents).values({
    brokerageId, partyId: party!.id, scope: "PER_CALL", status: "ACTIVE", source: "VERBAL_ON_CALL",
    capturedByUserId: initiator.id, jurisdiction: "AU",
  }).returning();
  const [session] = await db.insert(growCallSessions).values({
    brokerageId, partyId: party!.id, initiatedByUserId: initiator.id,
    destinationRaw: "+61400111222", destinationNormalized: "+61400111222",
    destinationCountry: "AU", provider: "synthetic", status: "COMPLETED",
    recordingRequested: true, recordingStatus: "PERMITTED_NOT_CAPTURED",
    recordingConsentId: options.withConsent === false ? null : consent!.id,
    endedAt: new Date(),
  }).returning();
  const key = `f4-followup-${brokerageId}-${fixtureNumber}`;
  const [document] = await db.insert(documents).values({
    brokerageId, logicalOwnerType: "telephony-call", logicalOwnerId: session!.id,
    documentType: "CallRecording", title: "Synthetic call recording",
    status: "Generated", objectStorageKey: key,
  }).returning();
  const [version] = await db.insert(documentObjectVersions).values({
    documentId: document!.id, brokerageId, storageObjectKey: key, version: 1,
    originalFilename: "recording.wav", displayFilename: "recording.wav",
    declaredMimeType: "audio/wav", detectedMimeType: "audio/wav", byteSize: 1,
    contentSha256: "0".repeat(64), source: "upload", objectStatus: "Active", uploadedBy: initiator.id,
  }).returning();
  const [transcription] = await db.insert(growCallTranscriptions).values({
    brokerageId, callSessionId: session!.id, partyId: party!.id,
    recordingReference: version!.id, processingState: "AWAITING_AGENT_REVIEW",
    transcript: "Machine transcript.", draftSummary: "Machine summary.",
    draftKeyPoints: [{ id: "kp-1", text: "Machine key point." }],
    draftCommitments: [
      { id: "com-1", text: APPROVED_COMMITMENT, dueAt: inDays(3) },
      { id: "com-2", text: REJECTED_TEXT },
    ],
    draftFollowups: [{ id: "fu-1", text: "Machine follow-up.", dueAt: inDays(7) }],
  }).returning();
  const actor = actorOf(initiator);
  if ((options.review ?? "SAVED") === "SAVED") {
    await saveCallTranscriptionReview({
      brokerageId, callSessionId: session!.id, transcriptionId: transcription!.id, actor,
      body: { reviewState: [
        { itemType: "TRANSCRIPT", itemId: "transcript", decision: "APPROVED", editedText: "Human transcript." },
        { itemType: "SUMMARY", itemId: "summary", decision: "APPROVED" },
        { itemType: "KEY_POINT", itemId: "kp-1", decision: "APPROVED" },
        { itemType: "COMMITMENT", itemId: "com-1", decision: "APPROVED" },
        { itemType: "COMMITMENT", itemId: "com-2", decision: "REJECTED", rejectionReason: "Not said." },
        { itemType: "FOLLOWUP", itemId: "fu-1", decision: "APPROVED", editedText: EDITED_FOLLOWUP },
      ] },
    }, persistApprovedCallSummaryActivity);
  } else if (options.review === "DISCARDED") {
    await discardCallTranscription({
      brokerageId, callSessionId: session!.id, transcriptionId: transcription!.id, actor, body: {},
    });
  }
  return { party: party!, consent: consent!, session: session!, transcription: transcription! };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;
const ids = (fixture: Fixture) => ({ callSessionId: fixture.session.id, transcriptionId: fixture.transcription.id });

function propose(fixture: Fixture, user: User, items: unknown[] | Record<string, unknown>) {
  return proposeCallFollowups({
    brokerageId, actor: actorOf(user), ...ids(fixture),
    body: Array.isArray(items) ? { items } : items,
  });
}

async function requestsFor(fixture: Fixture) {
  const rows = await db.select().from(aiActionRequests).where(eq(aiActionRequests.brokerageId, brokerageId));
  return rows.filter((row) => row.resourceId?.startsWith(`transcription:${fixture.transcription.id}:`));
}

async function followupAudits(fixture: Fixture) {
  return db.select().from(auditLogs).where(and(
    eq(auditLogs.brokerageId, brokerageId),
    eq(auditLogs.recordType, "grow_call_followup"),
    eq(auditLogs.recordId, String(fixture.transcription.id)),
  ));
}

async function commitmentsFor(fixture: Fixture) {
  return db.select().from(growCommitments).where(and(
    eq(growCommitments.brokerageId, brokerageId), eq(growCommitments.partyId, fixture.party.id),
  ));
}

const isCode = (code: string) => (error: unknown) => error instanceof GrowCallFollowupError && error.code === code;

before(async () => {
  configureEvents();
  const [brokerage] = await db.insert(brokerages).values({ name: `F4 followups ${Date.now()}` }).returning();
  brokerageId = brokerage!.id;
  const [foreign] = await db.insert(brokerages).values({ name: `F4 followups foreign ${Date.now()}` }).returning();
  foreignBrokerageId = foreign!.id;
  owner = await createUser("owner", "Agent", brokerageId);
  otherAgent = await createUser("other", "Agent", brokerageId);
  admin = await createUser("admin", "Brokerage Administrator", brokerageId);
  noManage = await createUser("nomanage", "Agent", brokerageId);
  noTranscription = await createUser("notranscription", "Agent", brokerageId);
  foreignUser = await createUser("foreign", "Agent", foreignBrokerageId);
  for (const user of [owner, otherAgent, admin, noManage]) await grant(brokerageId, user, "grow.calling.transcription");
  for (const user of [owner, otherAgent, admin, noTranscription]) await grant(brokerageId, user, "grow.activities.manage");
  await grant(foreignBrokerageId, foreignUser, "grow.calling.transcription");
  await grant(foreignBrokerageId, foreignUser, "grow.activities.manage");
});

after(async () => {
  setGrowCallFollowupAuditFailureForTests(null);
  await db.delete(growCallTranscriptions).where(inArray(growCallTranscriptions.brokerageId, [brokerageId, foreignBrokerageId]));
  await db.delete(documentObjectVersions).where(inArray(documentObjectVersions.brokerageId, [brokerageId, foreignBrokerageId]));
  await db.delete(documents).where(inArray(documents.brokerageId, [brokerageId, foreignBrokerageId]));
  await cleanupBrokerages([brokerageId, foreignBrokerageId]);
});

test("happy path: owner proposes approved COMMITMENT + FOLLOWUP with confirmed dueAt; approval + governed execution creates exactly one commitment each", async () => {
  const fixture = await createFixture();
  const candidates = await listCallFollowupCandidates({ brokerageId, actor: actorOf(owner), ...ids(fixture) });
  assert.equal(candidates.consentBlocked, false);
  assert.deepEqual(candidates.candidates.map((c) => [c.itemType, c.itemId, c.text]), [
    ["COMMITMENT", "com-1", APPROVED_COMMITMENT],
    ["FOLLOWUP", "fu-1", EDITED_FOLLOWUP],
  ], "only approved items, with the edited text where edited");
  assert.ok(candidates.candidates[0]!.suggestedDueAt, "AI dueAt is surfaced as a hint only");
  assert.ok(candidates.candidates.every((c) => c.canPropose && c.existingProposal.visibility === "NONE"));
  assert.equal((await requestsFor(fixture)).length, 0, "listing proposes nothing");

  const commitmentDue = inDays(10);
  const followupDue = inDays(14);
  const result = await propose(fixture, owner, [
    { itemType: "COMMITMENT", itemId: "com-1", dueAt: commitmentDue },
    { itemType: "FOLLOWUP", itemId: "fu-1", dueAt: followupDue },
  ]);
  assert.deepEqual(result.proposals.map((p) => p.status), ["PROPOSED", "PROPOSED"]);
  assert.equal((await commitmentsFor(fixture)).length, 0, "nothing is written to growCommitments before approval + execution");

  const requests = await requestsFor(fixture);
  assert.equal(requests.length, 2);
  for (const [itemType, itemId, text, due] of [
    ["COMMITMENT", "com-1", APPROVED_COMMITMENT, commitmentDue],
    ["FOLLOWUP", "fu-1", EDITED_FOLLOWUP, followupDue],
  ] as const) {
    const request = requests.find((row) => row.resourceId === `transcription:${fixture.transcription.id}:item:${itemType}:${itemId}`);
    assert.ok(request, `${itemType} request`);
    assert.equal(request.actionKey, "CREATE_GROW_COMMITMENT");
    assert.equal(request.status, "AWAITING_APPROVAL");
    assert.equal(request.actorType, "AI");
    assert.equal(request.userId, owner.id);
    assert.equal(request.resourceType, "grow_commitment");
    const payload = request.inputPayload as Record<string, unknown>;
    assert.equal(payload.description, text);
    assert.equal(payload.partyId, fixture.party.id);
    assert.equal(payload.dueAt, new Date(due).toISOString());
    assert.equal(payload.propertyId, null);
    assert.equal(payload.opportunityId, null);
    assert.match(String(payload.evidenceSummary), new RegExp(`callSession:${fixture.session.id} transcription:${fixture.transcription.id} item:${itemType}:${itemId}`));
    assert.doesNotMatch(`${payload.reason} ${payload.evidenceSummary}`, /Machine|transcript\./i);

    const approved = await approveAIActionRequest(request.id, brokerageId, policyActorOf(owner));
    assert.equal(approved.ok, true);
    const executed = await executeAIAction(request.id, brokerageId, policyActorOf(owner));
    assert.equal(executed.ok, true, JSON.stringify(executed));
  }

  const commitments = await commitmentsFor(fixture);
  assert.equal(commitments.length, 2);
  for (const [text, due] of [[APPROVED_COMMITMENT, commitmentDue], [EDITED_FOLLOWUP, followupDue]] as const) {
    const row = commitments.filter((c) => c.description === text);
    assert.equal(row.length, 1);
    assert.equal(row[0]!.brokerageId, brokerageId);
    assert.equal(row[0]!.partyId, fixture.party.id);
    assert.equal(row[0]!.dueAt.toISOString(), new Date(due).toISOString());
  }
  const timeline = await getRelationshipTimeline(brokerageId, fixture.party.id);
  assert.equal(timeline.filter((event) => event.type === "COMMITMENT_CREATED").length, 2);

  // An item whose commitment exists is never proposed again.
  const again = await propose(fixture, owner, [{ itemType: "COMMITMENT", itemId: "com-1", dueAt: inDays(20) }]);
  assert.equal(again.proposals[0]!.status, "EXISTING");
  assert.equal(again.proposals[0]!.actionRequest?.status, "COMPLETED");
  assert.equal((await requestsFor(fixture)).length, 2);
});

test("rejected, SUMMARY, KEY_POINT, TRANSCRIPT, and unknown items are refused; unsaved or discarded reviews are refused", async () => {
  const fixture = await createFixture();
  for (const item of [
    { itemType: "COMMITMENT", itemId: "com-2", dueAt: inDays(2) },
    { itemType: "COMMITMENT", itemId: "does-not-exist", dueAt: inDays(2) },
    { itemType: "FOLLOWUP", itemId: "com-1", dueAt: inDays(2) },
    { itemType: "SUMMARY", itemId: "summary", dueAt: inDays(2) },
    { itemType: "KEY_POINT", itemId: "kp-1", dueAt: inDays(2) },
    { itemType: "TRANSCRIPT", itemId: "transcript", dueAt: inDays(2) },
  ]) {
    await assert.rejects(propose(fixture, owner, [item]), isCode("INVALID_INPUT"), JSON.stringify(item));
  }
  assert.equal((await requestsFor(fixture)).length, 0);

  const awaiting = await createFixture({ review: "AWAITING" });
  await assert.rejects(propose(awaiting, owner, [{ itemType: "COMMITMENT", itemId: "com-1", dueAt: inDays(2) }]), isCode("WRONG_STATE"));
  await assert.rejects(listCallFollowupCandidates({ brokerageId, actor: actorOf(owner), ...ids(awaiting) }), isCode("WRONG_STATE"));
  const discarded = await createFixture({ review: "DISCARDED" });
  await assert.rejects(propose(discarded, owner, [{ itemType: "COMMITMENT", itemId: "com-1", dueAt: inDays(2) }]), isCode("WRONG_STATE"));
  assert.equal((await requestsFor(awaiting)).length + (await requestsFor(discarded)).length, 0);
});

test("the client cannot inject description, partyId, brokerageId, actorType, or other fields; empty, oversized, and duplicate lists are refused", async () => {
  const fixture = await createFixture();
  const base = { itemType: "COMMITMENT", itemId: "com-1", dueAt: inDays(2) };
  for (const extra of [
    { description: "Injected description" }, { partyId: 1 }, { brokerageId: foreignBrokerageId },
    { actorType: "USER" }, { propertyId: 1 }, { reason: "x" },
  ]) {
    await assert.rejects(propose(fixture, owner, [{ ...base, ...extra }]), isCode("INVALID_INPUT"), JSON.stringify(extra));
  }
  await assert.rejects(propose(fixture, owner, { items: [base], partyId: 1 }), isCode("INVALID_INPUT"));
  await assert.rejects(propose(fixture, owner, []), isCode("INVALID_INPUT"));
  await assert.rejects(propose(fixture, owner, Array.from({ length: 21 }, (_, i) => ({ ...base, itemId: `x-${i}` }))), isCode("INVALID_INPUT"));
  await assert.rejects(propose(fixture, owner, [base, base]), isCode("INVALID_INPUT"));
  assert.equal((await requestsFor(fixture)).length, 0);

  // The description is always the approved snapshot text, whatever the client sends.
  await propose(fixture, owner, [base]);
  const [request] = await requestsFor(fixture);
  assert.equal((request!.inputPayload as { description: string }).description, APPROVED_COMMITMENT);
});

test("dueAt must be supplied by the request, valid ISO-8601, and within the ±730-day window; the AI suggestion is never used implicitly", async () => {
  const fixture = await createFixture();
  for (const dueAt of [undefined, null, "", "tomorrow", "2026-13-40", "2026-10-01", inDays(800), inDays(-800)]) {
    const item: Record<string, unknown> = { itemType: "COMMITMENT", itemId: "com-1" };
    if (dueAt !== undefined) item.dueAt = dueAt;
    await assert.rejects(propose(fixture, owner, [item]), isCode("INVALID_INPUT"), String(dueAt));
  }
  assert.equal((await requestsFor(fixture)).length, 0);
  const chosen = inDays(30);
  await propose(fixture, owner, [{ itemType: "COMMITMENT", itemId: "com-1", dueAt: chosen }]);
  const [request] = await requestsFor(fixture);
  const suggested = fixture.transcription.draftCommitments!.find((draft) => draft.id === "com-1")!.dueAt!;
  assert.equal((request!.inputPayload as { dueAt: string }).dueAt, new Date(chosen).toISOString());
  assert.notEqual((request!.inputPayload as { dueAt: string }).dueAt, new Date(suggested).toISOString());
});

test("authority: same-brokerage non-owner denied (audited, nothing created), admin allowed, cross-tenant not found (unaudited), missing entitlements refused", async () => {
  const fixture = await createFixture();
  const item = [{ itemType: "COMMITMENT", itemId: "com-1", dueAt: inDays(5) }];
  await assert.rejects(propose(fixture, otherAgent, item), isCode("ACCESS_DENIED"));
  await assert.rejects(listCallFollowupCandidates({ brokerageId, actor: actorOf(otherAgent), ...ids(fixture) }), isCode("ACCESS_DENIED"));
  assert.equal((await requestsFor(fixture)).length, 0);
  const denied = (await followupAudits(fixture)).filter((row) => row.action === "grow_call_followup_rejected");
  assert.equal(denied.length, 1);
  assert.equal(denied[0]!.userId, otherAgent.id);
  assert.equal(JSON.parse(denied[0]!.updatedValue!).reason, "ACCESS_DENIED");

  await assert.rejects(proposeCallFollowups({
    brokerageId: foreignBrokerageId, actor: actorOf(foreignUser, foreignBrokerageId), ...ids(fixture), body: { items: item },
  }), isCode("NOT_FOUND"));
  const foreignAudits = await db.select().from(auditLogs).where(and(
    eq(auditLogs.brokerageId, foreignBrokerageId), eq(auditLogs.recordType, "grow_call_followup"),
  ));
  assert.equal(foreignAudits.length, 0, "cross-tenant ids are never audited");
  // A spoofed tenant on the actor is refused before any lookup.
  await assert.rejects(proposeCallFollowups({
    brokerageId, actor: actorOf(foreignUser, brokerageId), ...ids(fixture), body: { items: item },
  }), isCode("ACCESS_DENIED"));

  await assert.rejects(propose(fixture, noManage, item), isCode("ENTITLEMENT_REQUIRED"));
  await assert.rejects(propose(fixture, noTranscription, item), isCode("ENTITLEMENT_REQUIRED"));
  assert.equal((await requestsFor(fixture)).length, 0);

  const byAdmin = await propose(fixture, admin, item);
  assert.equal(byAdmin.proposals[0]!.status, "PROPOSED");
  const [request] = await requestsFor(fixture);
  assert.equal(request!.userId, admin.id, "the admin is the human requester");
});

test("consent withdrawn: new proposals are blocked and audited; an existing proposal is untouched and can still be approved and executed", async () => {
  const fixture = await createFixture();
  const existing = await propose(fixture, owner, [{ itemType: "COMMITMENT", itemId: "com-1", dueAt: inDays(4) }]);
  const existingId = existing.proposals[0]!.actionRequest!.actionRequestId;

  await withdrawRecordingConsent({ brokerageId, consentId: fixture.consent.id, withdrawnByUserId: owner.id });
  const listed = await listCallFollowupCandidates({ brokerageId, actor: actorOf(owner), ...ids(fixture) });
  assert.equal(listed.consentBlocked, true);
  assert.ok(listed.candidates.every((c) => c.consentBlocked && !c.canPropose));

  await assert.rejects(
    propose(fixture, owner, [{ itemType: "FOLLOWUP", itemId: "fu-1", dueAt: inDays(4) }]),
    isCode("CONSENT_WITHDRAWN"),
  );
  const requests = await requestsFor(fixture);
  assert.equal(requests.length, 1, "no proposal created after withdrawal");
  const rejected = (await followupAudits(fixture)).filter((row) => row.action === "grow_call_followup_rejected");
  assert.equal(rejected.length, 1);
  assert.equal(JSON.parse(rejected[0]!.updatedValue!).reason, "CONSENT_WITHDRAWN");

  const [stillOpen] = requests;
  assert.equal(stillOpen!.id, existingId);
  assert.equal(stillOpen!.status, "AWAITING_APPROVAL");
  assert.equal((await approveAIActionRequest(existingId, brokerageId, policyActorOf(owner))).ok, true);
  assert.equal((await executeAIAction(existingId, brokerageId, policyActorOf(owner))).ok, true);
  assert.equal((await commitmentsFor(fixture)).length, 1);

  // No resolvable capture consent at all is denied by default.
  const noConsent = await createFixture({ withConsent: false });
  await assert.rejects(
    propose(noConsent, owner, [{ itemType: "COMMITMENT", itemId: "com-1", dueAt: inDays(4) }]),
    isCode("CONSENT_WITHDRAWN"),
  );
  assert.equal((await requestsFor(noConsent)).length, 0);
});

test("dedup: repeat and concurrent proposals leave one open request per item; expiry frees the slot", async () => {
  const fixture = await createFixture();
  const item = [{ itemType: "FOLLOWUP", itemId: "fu-1", dueAt: inDays(6) }];
  const first = await propose(fixture, owner, item);
  const second = await propose(fixture, owner, item);
  assert.equal(first.proposals[0]!.status, "PROPOSED");
  assert.equal(second.proposals[0]!.status, "EXISTING");
  assert.equal(second.proposals[0]!.actionRequest!.actionRequestId, first.proposals[0]!.actionRequest!.actionRequestId);
  assert.equal((await requestsFor(fixture)).length, 1);

  const concurrent = await createFixture();
  const concurrentItem = [{ itemType: "COMMITMENT", itemId: "com-1", dueAt: inDays(6) }];
  const results = await Promise.all(Array.from({ length: 5 }, () => propose(concurrent, owner, concurrentItem)));
  const statuses = results.map((r) => r.proposals[0]!.status);
  assert.equal(statuses.filter((s) => s === "PROPOSED").length, 1, statuses.join(","));
  assert.ok(statuses.every((s) => s === "PROPOSED" || s === "EXISTING"));
  const open = (await requestsFor(concurrent)).filter((row) => row.status === "AWAITING_APPROVAL");
  assert.equal(open.length, 1);

  await db.update(aiActionRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(aiActionRequests.id, open[0]!.id));
  const listed = await listCallFollowupCandidates({ brokerageId, actor: actorOf(owner), ...ids(concurrent) });
  const candidate = listed.candidates.find((c) => c.itemId === "com-1")!;
  assert.equal(candidate.existingProposal.visibility, "NONE");
  assert.equal(candidate.latestProposalStatus, "EXPIRED");
  assert.equal(candidate.canPropose, true);
  const fresh = await propose(concurrent, owner, concurrentItem);
  assert.equal(fresh.proposals[0]!.status, "PROPOSED");
  const rows = await requestsFor(concurrent);
  assert.deepEqual(rows.map((row) => row.status).sort(), ["AWAITING_APPROVAL", "EXPIRED"]);
});

test("visibility: another user's open proposal is reported as ALREADY_PROPOSED without content; admins see the owner's", async () => {
  const fixture = await createFixture();
  const item = [{ itemType: "COMMITMENT", itemId: "com-1", dueAt: inDays(8) }];
  await propose(fixture, admin, item);
  const ownerView = await propose(fixture, owner, item);
  assert.deepEqual(ownerView.proposals[0], { itemType: "COMMITMENT", itemId: "com-1", status: "ALREADY_PROPOSED", actionRequest: null });
  const ownerList = await listCallFollowupCandidates({ brokerageId, actor: actorOf(owner), ...ids(fixture) });
  const ownerCandidate = ownerList.candidates.find((c) => c.itemId === "com-1")!;
  assert.deepEqual(ownerCandidate.existingProposal, { visibility: "ALREADY_PROPOSED" });
  assert.equal(ownerCandidate.latestProposalStatus, null);
  assert.equal(ownerCandidate.canPropose, false);
  assert.equal((await requestsFor(fixture)).length, 1);

  const reverse = await createFixture();
  const reverseItem = [{ itemType: "FOLLOWUP", itemId: "fu-1", dueAt: inDays(8) }];
  await propose(reverse, owner, reverseItem);
  const adminView = await propose(reverse, admin, reverseItem);
  assert.equal(adminView.proposals[0]!.status, "EXISTING");
  assert.equal(adminView.proposals[0]!.actionRequest!.proposedByUserId, owner.id);
});

test("audit: strict ids-only rows bracket every proposal; an outage before proposing creates nothing; an outage after is surfaced and retry is idempotent", async () => {
  const fixture = await createFixture();
  const items = [
    { itemType: "COMMITMENT", itemId: "com-1", dueAt: inDays(9) },
    { itemType: "FOLLOWUP", itemId: "fu-1", dueAt: inDays(9) },
  ];
  const result = await propose(fixture, owner, items);
  const audits = await followupAudits(fixture);
  const requested = audits.filter((row) => row.action === "grow_call_followup_proposal_requested");
  const proposed = audits.filter((row) => row.action === "grow_call_followup_proposed");
  assert.equal(requested.length, 1);
  assert.equal(proposed.length, 1);
  assert.ok(requested[0]!.id < proposed[0]!.id, "requested audit is written before proposing");
  assert.equal(proposed[0]!.userId, owner.id);
  assert.equal(proposed[0]!.providerReference, `call:${fixture.session.id}:transcription:${fixture.transcription.id}`);
  const value = JSON.parse(proposed[0]!.updatedValue!);
  assert.deepEqual(value.outcomes.map((o: { actionRequestId: number }) => o.actionRequestId).sort(),
    result.proposals.map((p) => p.actionRequest!.actionRequestId).sort());
  assert.deepEqual(JSON.parse(requested[0]!.updatedValue!).items.map((i: { resourceId: string }) => i.resourceId), [
    `transcription:${fixture.transcription.id}:item:COMMITMENT:com-1`,
    `transcription:${fixture.transcription.id}:item:FOLLOWUP:fu-1`,
  ]);
  for (const row of audits) {
    assert.doesNotMatch(JSON.stringify(row), /appraisal pack|auction|Machine|transcript\.|Fixture/, "audit carries ids only");
  }

  const outage = await createFixture();
  setGrowCallFollowupAuditFailureForTests("grow_call_followup_proposal_requested");
  try {
    await assert.rejects(propose(outage, owner, items), isCode("AUDIT_FAILURE"));
  } finally {
    setGrowCallFollowupAuditFailureForTests(null);
  }
  assert.equal((await requestsFor(outage)).length, 0, "nothing proposed without the pre-proposal audit");

  const lateOutage = await createFixture();
  setGrowCallFollowupAuditFailureForTests("grow_call_followup_proposed");
  try {
    await assert.rejects(propose(lateOutage, owner, items), isCode("AUDIT_INCOMPLETE"));
  } finally {
    setGrowCallFollowupAuditFailureForTests(null);
  }
  const pending = await requestsFor(lateOutage);
  assert.equal(pending.length, 2);
  assert.ok(pending.every((row) => row.status === "AWAITING_APPROVAL"), "never auto-approved or executed");
  const retry = await propose(lateOutage, owner, items);
  assert.deepEqual(retry.proposals.map((p) => p.status), ["EXISTING", "EXISTING"]);
  assert.equal((await requestsFor(lateOutage)).length, 2);
  const retryAudit = (await followupAudits(lateOutage)).filter((row) => row.action === "grow_call_followup_proposed");
  assert.equal(retryAudit.length, 1);
  assert.deepEqual(
    JSON.parse(retryAudit[0]!.updatedValue!).outcomes.map((o: { actionRequestId: number }) => o.actionRequestId).sort(),
    pending.map((row) => row.id).sort(),
  );
});
