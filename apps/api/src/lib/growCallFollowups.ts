// AE GROW Priority 6 Stage F4.1 — Governed call follow-ups.
//
// Turns human-approved F3 call-review items (COMMITMENT / FOLLOWUP) into
// Stage D CREATE_GROW_COMMITMENT proposals, and nothing more:
//
//   F3 human-approved item -> human-confirmed due date (this request)
//     -> proposeAIAction(CREATE_GROW_COMMITMENT, actorType "AI")
//     -> explicit human approval -> governed execution (existing gateway)
//
// This module never approves, executes, sends, schedules, or calls a model,
// and never writes growCommitments. The only server-trusted inputs are the
// tenant-scoped call session, transcription, and the canonical approved
// call_summary Timeline snapshot written by F3's explicit review Save. The
// client supplies only (itemType, itemId, dueAt) triples: the commitment
// description is always the exact approved snapshot text, the contact is
// always the call's own party, and the due date is only ever the one the
// human supplied in this request (an AI draft dueAt is a read-only hint).
//
// Boundary: F3 modules (lib/telephony/callTranscription*.ts,
// routes/growCalls.ts) must never import this file; this file does not
// import any of them either — it reads the F3 tables directly.
//
// Consent (Project Owner decision D5, F4 only): new proposals are refused
// when the capture consent associated with the call (the session's retained
// recordingConsentId) is withdrawn or cannot be resolved in this brokerage
// for this party. Existing proposals are never cancelled here.
//
// Provenance (D3): no new columns. The action request's resourceId
// (`transcription:<id>:item:<type>:<itemId>`) plus its reason/evidence
// fields (ids only) and the strict audit rows below are the provenance.

import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  aiActionRequests,
  db,
  growActivities,
  growCallRecordingConsents,
  growCallTranscriptions,
  parties,
  users,
  type AiActionRequest,
  type CallTranscriptionDraftItem,
  type GrowCallSession,
  type GrowCallTranscription,
} from "@aee/db";
import { logAudit } from "./audit.js";
import { logger } from "@aee/events";
import { summarizeErrorCause } from "./errorCause.js";
import { explainEntitlementDecision } from "./entitlements/resolver.js";
import {
  canActorAccessActionRequest,
  findOpenActionRequestByResource,
  proposeAIAction,
  STUCK_EXECUTING_RECOVERED_MESSAGE,
} from "./ai/actionRequests.js";
import { LATE_COMPLETION_AFTER_RECOVERY_MESSAGE } from "./ai/executionGateway.js";
import { isReasonableCommitmentDueDate } from "./ai/orchestrator.js";
import type { PolicyActor } from "./ai/policyEngine.js";
import {
  getCallSessionForBrokerage,
  GrowCallSessionAuthorizationError,
  GrowCallSessionNotFoundError,
} from "./telephony/callSessions.js";

export const GROW_CALL_FOLLOWUP_ACTION_KEY = "CREATE_GROW_COMMITMENT";
export const MAX_FOLLOWUP_PROPOSALS_PER_REQUEST = 20;
const MAX_ITEM_ID_LENGTH = 128;
// Mirrors CREATE_GROW_COMMITMENT's description bound (actions/registry.ts).
const MAX_DESCRIPTION_LENGTH = 2000;
const AUDIT_RECORD_TYPE = "grow_call_followup";

export type GrowCallFollowupItemType = "COMMITMENT" | "FOLLOWUP";

export type GrowCallFollowupErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "ACCESS_DENIED"
  | "ENTITLEMENT_REQUIRED"
  | "WRONG_STATE"
  | "CONSENT_WITHDRAWN"
  | "POLICY_DENIED"
  | "AUDIT_FAILURE"
  | "AUDIT_INCOMPLETE";

export class GrowCallFollowupError extends Error {
  constructor(readonly code: GrowCallFollowupErrorCode, message: string) {
    super(message);
    this.name = "GrowCallFollowupError";
  }
}

export type GrowCallFollowupActor = { userId: number; role: string; brokerageId: number };

// ---------------------------------------------------------------------
// Test-only strict-audit outage seam (same shape as F3's, but owned here so
// this module never imports an F3 file).
// ---------------------------------------------------------------------
let testAuditFailureAction: string | null = null;

export function setGrowCallFollowupAuditFailureForTests(action: string | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Test audit seam is unavailable outside tests.");
  testAuditFailureAction = action;
}

// ---------------------------------------------------------------------
// Request body (the route validates with this same strict schema).
// ---------------------------------------------------------------------
export const proposeCallFollowupsBodySchema = z.object({
  items: z.array(z.object({
    itemType: z.enum(["COMMITMENT", "FOLLOWUP"]),
    itemId: z.string().min(1).max(MAX_ITEM_ID_LENGTH),
    dueAt: z.string().datetime({ offset: true }),
  }).strict()).min(1).max(MAX_FOLLOWUP_PROPOSALS_PER_REQUEST),
}).strict();

export type ProposeCallFollowupItemInput = z.infer<typeof proposeCallFollowupsBodySchema>["items"][number];

export function buildCallFollowupResourceId(transcriptionId: number, itemType: GrowCallFollowupItemType, itemId: string): string {
  return `transcription:${transcriptionId}:item:${itemType}:${itemId}`;
}

const RESOURCE_ID_PATTERN = /^transcription:(\d+):item:(COMMITMENT|FOLLOWUP):(.+)$/;

/** Ids-only provenance parsed back out of a server-built resourceId. */
export function parseCallFollowupResourceId(resourceId: string | null): {
  source: "call_review";
  transcriptionId: number;
  itemType: GrowCallFollowupItemType;
  itemId: string;
} | null {
  if (!resourceId) return null;
  const match = RESOURCE_ID_PATTERN.exec(resourceId);
  if (!match) return null;
  const transcriptionId = Number(match[1]);
  if (!Number.isSafeInteger(transcriptionId) || transcriptionId <= 0) return null;
  return { source: "call_review", transcriptionId, itemType: match[2] as GrowCallFollowupItemType, itemId: match[3]! };
}

// ---------------------------------------------------------------------
// Authorisation + source resolution
// ---------------------------------------------------------------------

function policyActor(actor: GrowCallFollowupActor): PolicyActor {
  return { id: actor.userId, role: actor.role, brokerageId: actor.brokerageId };
}

async function assertFollowupActor(actor: GrowCallFollowupActor, brokerageId: number): Promise<void> {
  if (!actor || !Number.isSafeInteger(actor.userId) || actor.userId <= 0 ||
      !Number.isSafeInteger(actor.brokerageId) || actor.brokerageId <= 0 ||
      typeof actor.role !== "string" || !actor.role.trim() || actor.brokerageId !== brokerageId) {
    throw new GrowCallFollowupError("ACCESS_DENIED", "The actor is not authorized.");
  }
  // Re-resolve the human from the server-side user record: brokerage and
  // role must match the authenticated session exactly.
  const [user] = await db.select({ id: users.id, role: users.role, brokerageId: users.brokerageId })
    .from(users).where(eq(users.id, actor.userId)).limit(1);
  if (!user || user.brokerageId !== actor.brokerageId || user.role !== actor.role) {
    throw new GrowCallFollowupError("ACCESS_DENIED", "The actor is not authorized.");
  }
  for (const key of ["grow.calling.transcription", "grow.activities.manage"] as const) {
    const decision = await explainEntitlementDecision({ id: user.id, role: user.role, brokerageId: user.brokerageId }, key);
    if (decision.allowed !== true) {
      throw new GrowCallFollowupError("ENTITLEMENT_REQUIRED", `Call follow-ups require the ${key} entitlement.`);
    }
  }
}

type ApprovedItem = { itemType: GrowCallFollowupItemType; itemId: string; text: string };

type FollowupSource = {
  session: GrowCallSession;
  transcription: GrowCallTranscription;
  approvedItems: ApprovedItem[];
};

function isApprovedItemArray(value: unknown): value is Array<{ id: string; text: string }> {
  return Array.isArray(value) && value.every((item) =>
    item !== null && typeof item === "object" &&
    typeof (item as { id?: unknown }).id === "string" &&
    typeof (item as { text?: unknown }).text === "string");
}

function draftsFor(row: GrowCallTranscription, itemType: GrowCallFollowupItemType): CallTranscriptionDraftItem[] {
  return (itemType === "COMMITMENT" ? row.draftCommitments : row.draftFollowups) ?? [];
}

/**
 * Canonical approved items = the saved call_summary Timeline snapshot for
 * this transcription (the exact text the human approved at Save), kept only
 * where the persisted review_state also records an APPROVED decision for
 * the same item and resolves to the same text. Anything inconsistent is
 * excluded (fail closed), never repaired.
 */
function resolveApprovedItems(row: GrowCallTranscription, details: Record<string, unknown>): ApprovedItem[] {
  const content = details.approvedContent as Record<string, unknown> | undefined;
  if (!content || typeof content !== "object") return [];
  const reviews = Array.isArray(row.reviewState) ? row.reviewState : [];
  const result: ApprovedItem[] = [];
  for (const [itemType, key] of [["COMMITMENT", "commitments"], ["FOLLOWUP", "followups"]] as const) {
    const entries = content[key];
    if (!isApprovedItemArray(entries)) continue;
    for (const entry of entries) {
      const review = reviews.find((candidate) =>
        candidate.itemType === itemType && candidate.itemId === entry.id);
      if (!review || review.decision !== "APPROVED") continue;
      const reviewedText = review.editedText ?? draftsFor(row, itemType).find((draft) => draft.id === entry.id)?.text;
      if (reviewedText !== entry.text) continue;
      result.push({ itemType, itemId: entry.id, text: entry.text });
    }
  }
  return result;
}

async function loadFollowupSource(input: {
  brokerageId: number;
  callSessionId: number;
  transcriptionId: number;
  actor: GrowCallFollowupActor;
}): Promise<FollowupSource> {
  let session: GrowCallSession;
  try {
    session = await getCallSessionForBrokerage(input.brokerageId, input.callSessionId, {
      id: input.actor.userId,
      role: input.actor.role,
    });
  } catch (error) {
    if (error instanceof GrowCallSessionNotFoundError) {
      throw new GrowCallFollowupError("NOT_FOUND", "Call session not found.");
    }
    if (error instanceof GrowCallSessionAuthorizationError) {
      throw new GrowCallFollowupError("ACCESS_DENIED", error.message);
    }
    throw error;
  }
  const [transcription] = await db.select().from(growCallTranscriptions).where(and(
    eq(growCallTranscriptions.id, input.transcriptionId),
    eq(growCallTranscriptions.callSessionId, session.id),
    eq(growCallTranscriptions.brokerageId, input.brokerageId),
  )).limit(1);
  if (!transcription || transcription.partyId !== session.partyId) {
    throw new GrowCallFollowupError("NOT_FOUND", "Transcription not found.");
  }
  const [party] = await db.select({ id: parties.id }).from(parties).where(and(
    eq(parties.id, transcription.partyId),
    eq(parties.brokerageId, input.brokerageId),
  )).limit(1);
  if (!party) throw new GrowCallFollowupError("NOT_FOUND", "Transcription contact is not in this brokerage.");

  if ((transcription.processingState !== "APPROVED" && transcription.processingState !== "PARTIALLY_APPROVED") ||
      transcription.approvedBy === null || transcription.approvedAt === null) {
    throw new GrowCallFollowupError("WRONG_STATE", "Follow-ups require a saved (approved) call review.");
  }

  const snapshots = await db.select({ details: growActivities.details }).from(growActivities).where(and(
    eq(growActivities.brokerageId, input.brokerageId),
    eq(growActivities.partyId, transcription.partyId),
    eq(growActivities.activityType, "call_summary"),
    eq(growActivities.source, "grow_call_transcriptions"),
    eq(growActivities.sourceId, String(transcription.id)),
  )).limit(2);
  const details = snapshots.length === 1 ? snapshots[0]!.details as Record<string, unknown> | null : null;
  if (!details || typeof details !== "object" ||
      details.transcriptionId !== transcription.id ||
      details.callSessionId !== session.id ||
      details.partyId !== transcription.partyId) {
    throw new GrowCallFollowupError("WRONG_STATE", "The approved call summary snapshot is unavailable.");
  }
  return { session, transcription, approvedItems: resolveApprovedItems(transcription, details) };
}

/**
 * D5: the capture consent is the session's retained recordingConsentId,
 * resolved in this brokerage for this call's party. Missing, unresolvable,
 * WITHDRAWN, or withdrawnAt-set all block new proposals (deny by default).
 */
async function isCaptureConsentWithdrawn(session: GrowCallSession): Promise<boolean> {
  if (session.recordingConsentId === null) return true;
  const [consent] = await db.select({
    status: growCallRecordingConsents.status,
    withdrawnAt: growCallRecordingConsents.withdrawnAt,
  }).from(growCallRecordingConsents).where(and(
    eq(growCallRecordingConsents.id, session.recordingConsentId),
    eq(growCallRecordingConsents.brokerageId, session.brokerageId),
    eq(growCallRecordingConsents.partyId, session.partyId),
  )).limit(1);
  if (!consent) return true;
  return consent.status === "WITHDRAWN" || consent.withdrawnAt !== null;
}

function validSuggestedDueAt(row: GrowCallTranscription, itemType: GrowCallFollowupItemType, itemId: string): string | null {
  const raw = draftsFor(row, itemType).find((draft) => draft.id === itemId)?.dueAt;
  if (typeof raw !== "string") return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()) || !isReasonableCommitmentDueDate(parsed, new Date())) return null;
  return parsed.toISOString();
}

// ---------------------------------------------------------------------
// Existing-proposal projection (F4.0 D1/D2: content only for requester/admin)
// ---------------------------------------------------------------------

export type FollowupActionRequestSummary = {
  actionRequestId: number;
  status: string;
  dueAt: string | null;
  description: string | null;
  proposedByUserId: number;
  createdAt: string;
  expiresAt: string | null;
  // True when this request's side effect ran or may have run: COMPLETED,
  // executedAt set (e.g. a late completion after stuck-EXECUTING recovery
  // left the row FAILED), or a stuck-EXECUTING recovery marker (outcome
  // unknown). Such an item is never proposed again.
  commitmentMayExist: boolean;
};

// Latest-status value reported for an item whose commitment may already
// exist even though its request row is not COMPLETED.
export const COMMITMENT_MAY_EXIST_STATUS = "COMMITMENT_MAY_EXIST";

const SIDE_EFFECT_MARKER_MESSAGES = [STUCK_EXECUTING_RECOVERED_MESSAGE, LATE_COMPLETION_AFTER_RECOVERY_MESSAGE];

export function actionRequestSideEffectMayHaveRun(
  request: Pick<AiActionRequest, "status" | "executedAt" | "errorMessage">,
): boolean {
  return request.status === "COMPLETED" || request.executedAt !== null ||
    (request.errorMessage !== null && SIDE_EFFECT_MARKER_MESSAGES.includes(request.errorMessage));
}

export type FollowupExistingProposal =
  | { visibility: "NONE" }
  | { visibility: "VISIBLE"; actionRequest: FollowupActionRequestSummary }
  | { visibility: "ALREADY_PROPOSED" };

export function summarizeFollowupActionRequest(request: AiActionRequest): FollowupActionRequestSummary {
  const payload = (request.inputPayload ?? {}) as { dueAt?: unknown; description?: unknown };
  return {
    actionRequestId: request.id,
    status: request.status,
    dueAt: typeof payload.dueAt === "string" ? payload.dueAt : null,
    description: typeof payload.description === "string" ? payload.description : null,
    proposedByUserId: request.userId,
    createdAt: request.createdAt.toISOString(),
    expiresAt: request.expiresAt ? request.expiresAt.toISOString() : null,
    commitmentMayExist: actionRequestSideEffectMayHaveRun(request),
  };
}

function projectExisting(request: AiActionRequest | null, actor: PolicyActor): FollowupExistingProposal {
  if (!request) return { visibility: "NONE" };
  if (!canActorAccessActionRequest(request, actor)) return { visibility: "ALREADY_PROPOSED" };
  return { visibility: "VISIBLE", actionRequest: summarizeFollowupActionRequest(request) };
}

async function latestRequestForResource(brokerageId: number, resourceId: string): Promise<AiActionRequest | null> {
  const [row] = await db.select().from(aiActionRequests).where(and(
    eq(aiActionRequests.brokerageId, brokerageId),
    eq(aiActionRequests.actionKey, GROW_CALL_FOLLOWUP_ACTION_KEY),
    eq(aiActionRequests.resourceId, resourceId),
  )).orderBy(desc(aiActionRequests.createdAt), desc(aiActionRequests.id)).limit(1);
  return row ?? null;
}

// The most recent request for this item whose side effect ran or may have
// run (see actionRequestSideEffectMayHaveRun), in any status.
async function sideEffectRequestForResource(brokerageId: number, resourceId: string): Promise<AiActionRequest | null> {
  const [row] = await db.select().from(aiActionRequests).where(and(
    eq(aiActionRequests.brokerageId, brokerageId),
    eq(aiActionRequests.actionKey, GROW_CALL_FOLLOWUP_ACTION_KEY),
    eq(aiActionRequests.resourceId, resourceId),
    or(
      eq(aiActionRequests.status, "COMPLETED"),
      isNotNull(aiActionRequests.executedAt),
      inArray(aiActionRequests.errorMessage, SIDE_EFFECT_MARKER_MESSAGES),
    ),
  )).orderBy(desc(aiActionRequests.createdAt), desc(aiActionRequests.id)).limit(1);
  return row ?? null;
}

// The item's governing request: an open one (expired rows are transitioned
// first, audited, by the existing helper), else any request whose side
// effect ran or may have run — COMPLETED, or FAILED after a late completion
// / stuck-EXECUTING recovery. An item whose commitment already exists, or
// may exist, is never proposed a second time.
async function blockingRequestForResource(brokerageId: number, resourceId: string): Promise<AiActionRequest | null> {
  const open = await findOpenActionRequestByResource(GROW_CALL_FOLLOWUP_ACTION_KEY, brokerageId, resourceId);
  if (open) return open;
  return sideEffectRequestForResource(brokerageId, resourceId);
}

// ---------------------------------------------------------------------
// Strict audit (ids only; never approved/transcript text)
// ---------------------------------------------------------------------

type FollowupAuditAction =
  | "grow_call_followup_proposal_requested"
  | "grow_call_followup_proposed"
  | "grow_call_followup_rejected";

async function strictFollowupAudit(input: {
  action: FollowupAuditAction;
  brokerageId: number;
  actorUserId: number;
  callSessionId: number;
  transcriptionId: number;
  value: Record<string, unknown>;
  failureCode: "AUDIT_FAILURE" | "AUDIT_INCOMPLETE";
}): Promise<void> {
  try {
    if (process.env.NODE_ENV === "test" && testAuditFailureAction === input.action) {
      throw new Error("synthetic strict audit outage");
    }
    await logAudit({
      brokerageId: input.brokerageId,
      userId: input.actorUserId,
      action: input.action,
      recordType: AUDIT_RECORD_TYPE,
      recordId: String(input.transcriptionId),
      providerReference: `call:${input.callSessionId}:transcription:${input.transcriptionId}`,
      updatedValue: JSON.stringify({
        callSessionId: input.callSessionId,
        transcriptionId: input.transcriptionId,
        ...input.value,
      }),
    }, { strict: true });
  } catch (err) {
    // WP2a: log the underlying cause (ids only — never transcript or
    // proposal text) before the unchanged typed fail-closed error.
    logger.error("grow_call_followup_strict_audit_failed", {
      action: input.action,
      brokerageId: input.brokerageId,
      callSessionId: input.callSessionId,
      transcriptionId: input.transcriptionId,
      failureCode: input.failureCode,
      ...summarizeErrorCause(err),
    });
    throw new GrowCallFollowupError(
      input.failureCode,
      input.failureCode === "AUDIT_FAILURE"
        ? "The call follow-up audit could not be recorded; no new proposal was created."
        : "Follow-up proposals were created and await human approval, but the completion audit could not be recorded. " +
          "Retry the same request: it is idempotent and records the audit.",
    );
  }
}

/**
 * Strict rejection audit, only once the call session has been resolved in
 * the actor's own brokerage (never for cross-tenant or unresolved ids).
 */
async function rejectAudited(
  context: { brokerageId: number; actorUserId: number; callSessionId: number; transcriptionId: number },
  error: GrowCallFollowupError,
  items?: Array<{ itemType: string; itemId: string }>,
): Promise<never> {
  await strictFollowupAudit({
    action: "grow_call_followup_rejected",
    ...context,
    value: { reason: error.code, ...(items ? { items: items.map(({ itemType, itemId }) => ({ itemType, itemId })) } : {}) },
    failureCode: "AUDIT_FAILURE",
  });
  throw error;
}

async function loadSourceAudited(input: {
  brokerageId: number;
  callSessionId: number;
  transcriptionId: number;
  actor: GrowCallFollowupActor;
}, items?: Array<{ itemType: string; itemId: string }>): Promise<FollowupSource> {
  try {
    return await loadFollowupSource(input);
  } catch (error) {
    // NOT_FOUND covers cross-tenant and unresolved ids: never audited.
    if (error instanceof GrowCallFollowupError && error.code !== "NOT_FOUND") {
      return rejectAudited({
        brokerageId: input.brokerageId,
        actorUserId: input.actor.userId,
        callSessionId: input.callSessionId,
        transcriptionId: input.transcriptionId,
      }, error, items);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

export type CallFollowupCandidate = {
  itemType: GrowCallFollowupItemType;
  itemId: string;
  text: string;
  // Hint only (from the AI draft); never used unless the human submits it.
  suggestedDueAt: string | null;
  consentBlocked: boolean;
  existingProposal: FollowupExistingProposal;
  // Status of the most recent (possibly closed, e.g. EXPIRED/REJECTED)
  // proposal for this item, only when visible to the actor.
  latestProposalStatus: string | null;
  canPropose: boolean;
};

export async function listCallFollowupCandidates(input: {
  brokerageId: number;
  actor: GrowCallFollowupActor;
  callSessionId: number;
  transcriptionId: number;
}): Promise<{ callSessionId: number; transcriptionId: number; partyId: number; consentBlocked: boolean; candidates: CallFollowupCandidate[] }> {
  await assertFollowupActor(input.actor, input.brokerageId);
  const source = await loadFollowupSource(input);
  const consentBlocked = await isCaptureConsentWithdrawn(source.session);
  const actor = policyActor(input.actor);
  const candidates: CallFollowupCandidate[] = [];
  for (const item of source.approvedItems) {
    const resourceId = buildCallFollowupResourceId(source.transcription.id, item.itemType, item.itemId);
    const blocking = await blockingRequestForResource(input.brokerageId, resourceId);
    const latest = blocking ?? await latestRequestForResource(input.brokerageId, resourceId);
    candidates.push({
      itemType: item.itemType,
      itemId: item.itemId,
      text: item.text,
      suggestedDueAt: validSuggestedDueAt(source.transcription, item.itemType, item.itemId),
      consentBlocked,
      existingProposal: projectExisting(blocking, actor),
      latestProposalStatus: latest && canActorAccessActionRequest(latest, actor)
        ? (latest.status !== "COMPLETED" && actionRequestSideEffectMayHaveRun(latest) ? COMMITMENT_MAY_EXIST_STATUS : latest.status)
        : null,
      canPropose: !consentBlocked && blocking === null,
    });
  }
  return {
    callSessionId: source.session.id,
    transcriptionId: source.transcription.id,
    partyId: source.transcription.partyId,
    consentBlocked,
    candidates,
  };
}

export type CallFollowupProposalOutcome = {
  itemType: GrowCallFollowupItemType;
  itemId: string;
  status: "PROPOSED" | "EXISTING" | "ALREADY_PROPOSED";
  actionRequest: FollowupActionRequestSummary | null;
};

function policyDeniedError(reason: string, createdAny: boolean): GrowCallFollowupError {
  return new GrowCallFollowupError("POLICY_DENIED", createdAny
    ? `A follow-up proposal was denied by policy (${reason}) after some items had already been proposed. ` +
      "Those proposals await human approval; refresh to see which items were proposed."
    : `The follow-up proposal was denied by policy (${reason}). Nothing was proposed.`);
}

/**
 * Audit ordering: proposeAIAction() cannot join a caller transaction, so
 *   1. every validation runs first (nothing proposed on any failure);
 *   2. a strict `grow_call_followup_proposal_requested` audit (ids and the
 *      deterministic resourceIds) is written BEFORE any proposal — if it
 *      fails, the call aborts with AUDIT_FAILURE and nothing is proposed;
 *   3. each item is proposed (or resolved to its existing open request);
 *   4. a strict `grow_call_followup_proposed` audit records the outcomes and
 *      actionRequestIds. If THIS write fails, the proposals already exist:
 *      they are AWAITING_APPROVAL (never auto-executed), expire in 24h, and
 *      are already referenced by step 2's resourceIds. The caller receives
 *      AUDIT_INCOMPLETE; retrying the same request is idempotent (dedup
 *      returns the same requests) and writes both audits again. If this
 *      call created no proposal, AUDIT_INCOMPLETE is never claimed: the
 *      original loop failure / policy denial is surfaced, else AUDIT_FAILURE.
 *   A policy denial after earlier items were proposed says so (POLICY_DENIED,
 *   "refresh to see which items were proposed"); the {error, code} body
 *   shape is kept, so the created outcomes are not returned inline.
 */
export async function proposeCallFollowups(input: {
  brokerageId: number;
  actor: GrowCallFollowupActor;
  callSessionId: number;
  transcriptionId: number;
  body: unknown;
}): Promise<{ proposals: CallFollowupProposalOutcome[] }> {
  await assertFollowupActor(input.actor, input.brokerageId);
  const parsed = proposeCallFollowupsBodySchema.safeParse(input.body);
  const rawItems = Array.isArray((input.body as { items?: unknown } | null)?.items)
    ? ((input.body as { items: unknown[] }).items)
      .filter((item): item is { itemType: string; itemId: string } =>
        !!item && typeof item === "object" &&
        typeof (item as { itemType?: unknown }).itemType === "string" &&
        typeof (item as { itemId?: unknown }).itemId === "string" &&
        (item as { itemId: string }).itemId.length <= MAX_ITEM_ID_LENGTH)
      .slice(0, MAX_FOLLOWUP_PROPOSALS_PER_REQUEST)
    : undefined;

  const source = await loadSourceAudited(input, rawItems);
  const auditContext = {
    brokerageId: input.brokerageId,
    actorUserId: input.actor.userId,
    callSessionId: source.session.id,
    transcriptionId: source.transcription.id,
  };

  if (!parsed.success) {
    return rejectAudited(auditContext, new GrowCallFollowupError("INVALID_INPUT",
      "Body must be { items: [{ itemType, itemId, dueAt }] } with 1-20 COMMITMENT/FOLLOWUP items and ISO-8601 due dates."), rawItems);
  }
  const items = parsed.data.items;

  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.itemType}:${item.itemId}`;
    if (seen.has(key)) {
      return rejectAudited(auditContext, new GrowCallFollowupError("INVALID_INPUT", "Duplicate follow-up item."), items);
    }
    seen.add(key);
  }

  if (await isCaptureConsentWithdrawn(source.session)) {
    return rejectAudited(auditContext, new GrowCallFollowupError("CONSENT_WITHDRAWN",
      "Recording consent for this call has been withdrawn; new follow-up proposals cannot be created."), items);
  }

  const now = new Date();
  const prepared: Array<{ item: ProposeCallFollowupItemInput & { itemType: GrowCallFollowupItemType }; description: string; dueAt: string; resourceId: string }> = [];
  for (const item of items) {
    const approved = source.approvedItems.find((candidate) =>
      candidate.itemType === item.itemType && candidate.itemId === item.itemId);
    if (!approved) {
      return rejectAudited(auditContext, new GrowCallFollowupError("INVALID_INPUT",
        "Every item must be an approved commitment or follow-up from this call review."), items);
    }
    const description = approved.text.trim();
    if (description.length < 1 || description.length > MAX_DESCRIPTION_LENGTH) {
      return rejectAudited(auditContext, new GrowCallFollowupError("INVALID_INPUT",
        `An approved item's text must be 1-${MAX_DESCRIPTION_LENGTH} characters to become a commitment.`), items);
    }
    const due = new Date(item.dueAt);
    if (Number.isNaN(due.getTime()) || !isReasonableCommitmentDueDate(due, now)) {
      return rejectAudited(auditContext, new GrowCallFollowupError("INVALID_INPUT",
        "dueAt must be a valid date within 730 days of today."), items);
    }
    prepared.push({
      item,
      description,
      dueAt: due.toISOString(),
      resourceId: buildCallFollowupResourceId(source.transcription.id, item.itemType, item.itemId),
    });
  }

  await strictFollowupAudit({
    action: "grow_call_followup_proposal_requested",
    ...auditContext,
    value: {
      partyId: source.transcription.partyId,
      items: prepared.map(({ item, resourceId }) => ({ itemType: item.itemType, itemId: item.itemId, resourceId })),
    },
    failureCode: "AUDIT_FAILURE",
  });

  const actor = policyActor(input.actor);
  const outcomes: Array<CallFollowupProposalOutcome & { actionRequestId: number | null }> = [];
  let policyDenial: string | null = null;
  let failure: unknown = null;
  try {
    for (const { item, description, dueAt, resourceId } of prepared) {
      const blocking = await blockingRequestForResource(input.brokerageId, resourceId);
      if (blocking) {
        const visible = canActorAccessActionRequest(blocking, actor);
        outcomes.push({
          itemType: item.itemType,
          itemId: item.itemId,
          status: visible ? "EXISTING" : "ALREADY_PROPOSED",
          actionRequest: visible ? summarizeFollowupActionRequest(blocking) : null,
          actionRequestId: visible ? blocking.id : null,
        });
        continue;
      }
      const { request, decision, deduplicated } = await proposeAIAction({
        actionKey: GROW_CALL_FOLLOWUP_ACTION_KEY,
        actor,
        actorType: "AI",
        resourceId,
        interactionId: null,
        rawInput: {
          partyId: source.transcription.partyId,
          description,
          dueAt,
          propertyId: null,
          opportunityId: null,
          reason: item.itemType === "COMMITMENT"
            ? "Commitment approved in call review"
            : "Follow-up approved in call review",
          evidenceSummary:
            `callSession:${source.session.id} transcription:${source.transcription.id} item:${item.itemType}:${item.itemId}`,
          originatingInteractionId: null,
          dedupeKey: resourceId,
        },
      });
      if (!decision.allowed) {
        policyDenial = decision.reason;
        break;
      }
      if (deduplicated) {
        outcomes.push({
          itemType: item.itemType,
          itemId: item.itemId,
          status: request ? "EXISTING" : "ALREADY_PROPOSED",
          actionRequest: request ? summarizeFollowupActionRequest(request) : null,
          actionRequestId: request?.id ?? null,
        });
        continue;
      }
      if (!request) throw new Error("proposeAIAction returned no request for an allowed proposal.");
      outcomes.push({
        itemType: item.itemType,
        itemId: item.itemId,
        status: "PROPOSED",
        actionRequest: summarizeFollowupActionRequest(request),
        actionRequestId: request.id,
      });
    }
  } catch (error) {
    failure = error;
  }

  // AUDIT_INCOMPLETE ("proposals were created") is only accurate when this
  // call actually created at least one proposal. Otherwise the original
  // failure/denial is surfaced, or AUDIT_FAILURE when nothing new was
  // created and the only problem is the audit write.
  const createdAny = outcomes.some((outcome) => outcome.status === "PROPOSED");
  try {
    await strictFollowupAudit({
      action: "grow_call_followup_proposed",
      ...auditContext,
      value: {
        partyId: source.transcription.partyId,
        outcomes: outcomes.map(({ itemType, itemId, status, actionRequestId }) => ({ itemType, itemId, status, actionRequestId })),
        ...(policyDenial ? { policyDenial } : {}),
        ...(failure ? { failed: true } : {}),
      },
      failureCode: createdAny ? "AUDIT_INCOMPLETE" : "AUDIT_FAILURE",
    });
  } catch (auditError) {
    if (!createdAny && failure) throw failure;
    if (!createdAny && policyDenial) throw policyDeniedError(policyDenial, false);
    throw auditError;
  }

  if (failure) throw failure;
  if (policyDenial) throw policyDeniedError(policyDenial, createdAny);
  return { proposals: outcomes.map(({ actionRequestId: _id, ...outcome }) => outcome) };
}
