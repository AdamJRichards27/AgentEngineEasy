// AI Governance, Authority & Action Control Architecture -- Stage G5.
//
// Action Request + Human Approval Engine. This module owns the
// aiActionRequests state machine end to end:
//
//   PROPOSED -> AWAITING_APPROVAL -> APPROVED -> EXECUTING -> COMPLETED
//                                 \-> REJECTED  \-> EXPIRED  \-> FAILED
//                                 \-> EXPIRED
//
// (PROPOSED is transient: proposeAIAction() always resolves a request to
// either AWAITING_APPROVAL or straight to APPROVED -- an action the Policy
// Engine judged auto-execute-eligible skips the human queue but still gets
// a full, permanent audit row.)
//
// This module never calls a registered action's execute() function -- that
// is the Execution Gateway's job (Stage G6). Keeping "decide/record" and
// "run" in separate modules is what makes the tamper check below possible:
// the Gateway re-verifies against what was actually approved, not against
// whatever the caller claims was approved.
//
// Tamper protection (Part 25): inputPayloadHash is computed once, at
// proposal time, from the policy-validated (parsed) input. Every
// transition that matters -- approval and execution -- re-hashes the
// row's stored inputPayload and refuses to proceed on any mismatch. Since
// nothing in this codebase updates an aiActionRequests row's inputPayload
// after insert, a mismatch can only mean the row was altered outside this
// module (e.g. a direct DB edit) -- exactly the scenario Part 25 requires
// this system to detect and block, not silently trust.
//
// AE GROW Priority 6 Stage D additions (bottom of file): two small query
// helpers (findOpenActionRequestByResource, listAwaitingApprovalForUser)
// used by the Grow follow-up-commitment proposal flow.
//
// AE GROW Priority 6 Stage F4.0 hardening (Project Owner decisions D2/D4):
//   - approve/reject: only the requester (row.userId) or a brokerage
//     administrator, with an allowed role AND the action's required
//     entitlement, checked before any status inspection/transition;
//   - reads: getAIActionRequestForActor() applies the same requester-or-
//     admin rule (others get the not-found answer);
//   - expiry: every transition into EXPIRED is conditional and audited
//     (AI_ACTION_EXPIRED); expired rows never appear as pending or block
//     dedup;
//   - tamper-at-approval rejection is conditional and audited;
//   - stuck EXECUTING rows are recoverable (marked FAILED, never re-run);
//   - CREATE_GROW_COMMITMENT open-resource dedup is backed by a partial
//     unique index, and a lost insert race returns the surviving request.

import { createHash } from "node:crypto";
import { db, aiActionRequests, type AiActionRequest, type InsertAiActionRequest } from "@aee/db";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, type SQL } from "drizzle-orm";
import { logger } from "@aee/events";
import { evaluateAIAction, type PolicyActor, type PolicyDecision } from "./policyEngine.js";
import { getActionDefinition, type AIActionDefinition, type ActorType } from "./actions/registry.js";
import { publishAiActionEvent } from "./actionEvents.js";
import { explainEntitlementDecision } from "../entitlements/resolver.js";
import { BROKERAGE_ADMIN_ROLES } from "../../middlewares/auth.js";

const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForHash(item));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const sorted: Record<string, unknown> = {};
    for (const [key, val] of entries) {
      sorted[key] = canonicalizeForHash(val);
    }
    return sorted;
  }
  return value;
}

// jsonb columns do not preserve object key insertion order across a
// Postgres round-trip, so a naive JSON.stringify() of a value read back
// from the DB can differ byte-for-byte from the stringify() of the same
// logical value computed in-memory at proposal time -- even when nothing
// was tampered with. Canonicalizing (recursively sorting object keys)
// before hashing makes the hash a function of the logical value only,
// independent of key order, so legitimate approve/execute calls are
// never falsely rejected as PAYLOAD_TAMPERED.
export function hashInputPayload(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeForHash(payload ?? null)))
    .digest("hex");
}


// ---------------------------------------------------------------------
// AE GROW Priority 6 Stage F4.0 — governance hardening helpers
// (Project Owner decisions D2/D4). Every human-facing verb below
// (approve / reject / read) and the Execution Gateway's human path share
// these, so "who may touch this request" has exactly one definition.
// ---------------------------------------------------------------------

// Statuses in which a request still represents live, pending work. Shared
// by the dedup lookup, the pending listing, and (for CREATE_GROW_COMMITMENT)
// the partial unique index ai_action_requests_open_grow_commitment_resource_uidx
// (packages/db/src/schema/ai.ts) — keep the three in sync.
const OPEN_ACTION_REQUEST_STATUSES = ["AWAITING_APPROVAL", "APPROVED", "EXECUTING"] as const;

// Statuses that expiresAt applies to. EXECUTING is deliberately excluded:
// once a request has been claimed for execution its side effects may
// already be in flight, so it can only leave EXECUTING through the
// Gateway itself or recoverStuckExecutingActionRequests() below.
const EXPIRABLE_ACTION_REQUEST_STATUSES = ["AWAITING_APPROVAL", "APPROVED"] as const;
type ExpirableStatus = (typeof EXPIRABLE_ACTION_REQUEST_STATUSES)[number];

// Must match the uniqueIndex name in packages/db/src/schema/ai.ts.
export const OPEN_GROW_COMMITMENT_RESOURCE_UNIQUE_INDEX = "ai_action_requests_open_grow_commitment_resource_uidx";

// Reuses the canonical admin-role definition (middlewares/auth.ts) rather
// than restating it — same import lib/telephony/callSessions.ts and
// lib/ai/tools/registry.ts already use.
export function isBrokerageAdminActor(actor: PolicyActor): boolean {
  return BROKERAGE_ADMIN_ROLES.some((role) => role === actor.role);
}

// D2/D4: a request (including its inputPayload) is visible to, and may be
// approved/rejected by, only the human it was proposed on behalf of
// (row.userId) or an authorised administrator of the same brokerage —
// never merely any user who shares the brokerage.
export function canActorAccessActionRequest(row: AiActionRequest, actor: PolicyActor): boolean {
  if (row.brokerageId !== actor.brokerageId) return false;
  return row.userId === actor.id || isBrokerageAdminActor(actor);
}

// Re-checks the definition's required entitlement for the given human
// through the one authoritative resolver (same call policyEngine.ts makes
// for the requester, so cache/invalidation semantics are identical).
// Fails closed on any resolver error.
export async function actorHoldsActionEntitlement(
  definition: Pick<AIActionDefinition<unknown>, "actionKey" | "requiredEntitlementKey">,
  actor: PolicyActor,
): Promise<boolean> {
  if (!definition.requiredEntitlementKey) return true;
  try {
    const decision = await explainEntitlementDecision(
      { id: actor.id, role: actor.role, brokerageId: actor.brokerageId },
      definition.requiredEntitlementKey,
    );
    return decision.allowed === true;
  } catch (err) {
    logger.error("ai_action_actor_entitlement_check_failed_closed", {
      actionKey: definition.actionKey,
      userId: actor.id,
      error: err,
    });
    return false;
  }
}

function isExpired(row: Pick<AiActionRequest, "expiresAt">, now: Date = new Date()): boolean {
  return row.expiresAt !== null && row.expiresAt.getTime() < now.getTime();
}

function notExpiredCondition(now: Date): SQL {
  return or(isNull(aiActionRequests.expiresAt), gte(aiActionRequests.expiresAt, now))!;
}

// Single, audited, conditional transition into EXPIRED. Only the caller
// whose UPDATE ... WHERE status = <fromStatus> actually matches publishes
// AI_ACTION_EXPIRED, so a concurrent approve/execute/expire can never
// double-audit or overwrite a newer status.
export async function transitionActionRequestToExpired(
  row: AiActionRequest,
  fromStatus: ExpirableStatus,
): Promise<AiActionRequest | null> {
  const [updated] = await db
    .update(aiActionRequests)
    .set({ status: "EXPIRED", updatedAt: new Date() })
    .where(and(eq(aiActionRequests.id, row.id), eq(aiActionRequests.status, fromStatus)))
    .returning();
  if (!updated) return null;
  await publishAiActionEvent(updated, "AI_ACTION_EXPIRED", {
    previousStatus: fromStatus,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  });
  return updated;
}

export interface ActionRequestScope {
  brokerageId: number;
  actionKey?: string;
  resourceId?: string;
  userId?: number;
}

function scopeConditions(scope: ActionRequestScope): SQL[] {
  const conditions: SQL[] = [eq(aiActionRequests.brokerageId, scope.brokerageId)];
  if (scope.actionKey !== undefined) conditions.push(eq(aiActionRequests.actionKey, scope.actionKey));
  if (scope.resourceId !== undefined) conditions.push(eq(aiActionRequests.resourceId, scope.resourceId));
  if (scope.userId !== undefined) conditions.push(eq(aiActionRequests.userId, scope.userId));
  return conditions;
}

// Tenant-scoped sweep: flips every AWAITING_APPROVAL/APPROVED request in
// scope whose expiresAt has passed to EXPIRED (conditional per status,
// audited per row). Called before dedup lookups, pending listings, and
// resource-keyed proposal inserts so an expired-but-never-touched row can
// neither be shown as pending nor block a fresh proposal.
export async function expireStaleOpenActionRequests(scope: ActionRequestScope, now: Date = new Date()): Promise<AiActionRequest[]> {
  const expired: AiActionRequest[] = [];
  for (const fromStatus of EXPIRABLE_ACTION_REQUEST_STATUSES) {
    const rows = await db
      .update(aiActionRequests)
      .set({ status: "EXPIRED", updatedAt: new Date() })
      .where(
        and(
          ...scopeConditions(scope),
          eq(aiActionRequests.status, fromStatus),
          isNotNull(aiActionRequests.expiresAt),
          lt(aiActionRequests.expiresAt, now),
        ),
      )
      .returning();
    for (const row of rows) {
      await publishAiActionEvent(row, "AI_ACTION_EXPIRED", {
        previousStatus: fromStatus,
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      });
      expired.push(row);
    }
  }
  return expired;
}

// ---------------------------------------------------------------------
// Stuck-EXECUTING recovery. The Execution Gateway claims a request with a
// conditional APPROVED -> EXECUTING update and then calls execute(); a
// process crash between the claim and the COMPLETED/FAILED write would
// otherwise leave the row EXECUTING forever — blocking dedup (and the
// partial unique index) for its resource permanently. This recovery never
// re-executes anything: whether the side effect happened is unknowable
// from here, so the row is marked FAILED with an explicit reason for
// manual investigation, and AI_ACTION_FAILED is published as the audit.
//
// The error message deliberately carries the STUCK_EXECUTING_RECOVERED
// token, which lib/automation/operations.ts's TERMINAL_TECHNICAL_PATTERN
// classifies as terminal, so an automation action linked to a recovered
// request can never be auto-retried into a second execution either.
//
// Invoked (scoped, bounded) from: proposeAIAction() before a resource-
// keyed insert, findOpenActionRequestByResource(), and
// getAIActionRequestForActor() (GET /ai/actions/requests/:id). There is
// no AI-action scheduler in this codebase; this function is exported so an
// operator/scheduler can also run it unscoped.
// ---------------------------------------------------------------------

export const DEFAULT_STUCK_EXECUTING_THRESHOLD_MS = 15 * 60_000; // mirrors automation's DEFAULT_STALE_RUNNING_THRESHOLD_MS
export const MIN_STUCK_EXECUTING_THRESHOLD_MS = 60_000;
const MAX_STUCK_EXECUTING_BATCH = 500;
export const STUCK_EXECUTING_RECOVERED_MESSAGE =
  "STUCK_EXECUTING_RECOVERED: execution was claimed but never recorded a result (process interrupted). " +
  "Outcome unknown; marked FAILED for manual investigation and never retried automatically.";

export interface StuckExecutingScope {
  brokerageId?: number;
  requestId?: number;
  actionKey?: string;
  resourceId?: string;
  limit?: number;
}

export async function recoverStuckExecutingActionRequests(
  olderThanMs: number = DEFAULT_STUCK_EXECUTING_THRESHOLD_MS,
  scope: StuckExecutingScope = {},
): Promise<AiActionRequest[]> {
  if (!Number.isFinite(olderThanMs) || olderThanMs < MIN_STUCK_EXECUTING_THRESHOLD_MS) {
    throw new RangeError(`olderThanMs must be at least ${MIN_STUCK_EXECUTING_THRESHOLD_MS}ms`);
  }
  const limit = Math.min(Math.max(Math.trunc(scope.limit ?? 100), 1), MAX_STUCK_EXECUTING_BATCH);
  const cutoff = new Date(Date.now() - olderThanMs);

  const conditions: SQL[] = [eq(aiActionRequests.status, "EXECUTING"), lt(aiActionRequests.updatedAt, cutoff)];
  if (scope.brokerageId !== undefined) conditions.push(eq(aiActionRequests.brokerageId, scope.brokerageId));
  if (scope.requestId !== undefined) conditions.push(eq(aiActionRequests.id, scope.requestId));
  if (scope.actionKey !== undefined) conditions.push(eq(aiActionRequests.actionKey, scope.actionKey));
  if (scope.resourceId !== undefined) conditions.push(eq(aiActionRequests.resourceId, scope.resourceId));

  const candidates = await db
    .select({ id: aiActionRequests.id })
    .from(aiActionRequests)
    .where(and(...conditions))
    .orderBy(asc(aiActionRequests.updatedAt))
    .limit(limit);
  if (candidates.length === 0) return [];

  // Conditional on BOTH status and the same staleness cutoff, so a row the
  // Gateway finished (or re-claimed) between the SELECT and this UPDATE is
  // never overwritten.
  const recovered = await db
    .update(aiActionRequests)
    .set({ status: "FAILED", errorMessage: STUCK_EXECUTING_RECOVERED_MESSAGE, updatedAt: new Date() })
    .where(
      and(
        inArray(
          aiActionRequests.id,
          candidates.map((c) => c.id),
        ),
        eq(aiActionRequests.status, "EXECUTING"),
        lt(aiActionRequests.updatedAt, cutoff),
      ),
    )
    .returning();

  for (const row of recovered) {
    logger.warn("ai_action_stuck_executing_recovered", { requestId: row.id, actionKey: row.actionKey, brokerageId: row.brokerageId });
    await publishAiActionEvent(row, "AI_ACTION_FAILED", {
      reason: "STUCK_EXECUTING_RECOVERED",
      errorMessage: STUCK_EXECUTING_RECOVERED_MESSAGE,
    });
  }
  return recovered;
}

// ---------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------

export interface ProposeAIActionInput {
  actionKey: string;
  actor: PolicyActor;
  actorType: ActorType;
  rawInput: unknown;
  resourceId?: string | null;
  interactionId?: number | null;
  sessionId?: string | null;
  conversationId?: string | null;
}

export interface ProposeAIActionResult {
  request: AiActionRequest | null;
  decision: PolicyDecision;
  // True when a concurrent proposal for the same open resource slot won
  // the race (partial unique index) and the existing open request was
  // returned instead of a new one.
  deduplicated?: boolean;
}

function isOpenResourceUniqueViolation(err: unknown): boolean {
  const candidates = [err, (err as { cause?: unknown } | null)?.cause];
  return candidates.some((candidate) => {
    const pgErr = candidate as { code?: string; constraint?: string } | null | undefined;
    return pgErr?.code === "23505" && pgErr.constraint === OPEN_GROW_COMMITMENT_RESOURCE_UNIQUE_INDEX;
  });
}

async function selectOpenActionRequestByResource(
  actionKey: string,
  brokerageId: number,
  resourceId: string,
  now: Date,
): Promise<AiActionRequest | null> {
  const [row] = await db
    .select()
    .from(aiActionRequests)
    .where(
      and(
        eq(aiActionRequests.actionKey, actionKey),
        eq(aiActionRequests.brokerageId, brokerageId),
        eq(aiActionRequests.resourceId, resourceId),
        inArray(aiActionRequests.status, [...OPEN_ACTION_REQUEST_STATUSES]),
        // EXECUTING is never expiry-filtered (see EXPIRABLE_ACTION_REQUEST_STATUSES).
        or(eq(aiActionRequests.status, "EXECUTING"), notExpiredCondition(now)),
      ),
    )
    .orderBy(desc(aiActionRequests.createdAt))
    .limit(1);
  return row ?? null;
}

export async function proposeAIAction(input: ProposeAIActionInput): Promise<ProposeAIActionResult> {
  const decision = await evaluateAIAction({
    actionKey: input.actionKey,
    actor: input.actor,
    actorType: input.actorType,
    rawInput: input.rawInput,
  });

  if (!decision.allowed) {
    return { request: null, decision };
  }

  // Re-fetch the definition for fields the policy decision deliberately
  // does not carry (resourceType, the human-readable summariser). Cheap:
  // this is an in-memory registry lookup, not a second DB round trip.
  const definition = getActionDefinition(input.actionKey);
  if (!definition) {
    return { request: null, decision: { ...decision, allowed: false, reason: "ACTION_NOT_FOUND" } };
  }

  const resourceId = input.resourceId ?? null;
  if (resourceId !== null) {
    // Free the open-resource slot held by any expired or stuck request for
    // this exact resource (both transitions audited + conditional) before
    // inserting, so the partial unique index only ever rejects a genuinely
    // live duplicate.
    await expireStaleOpenActionRequests({ brokerageId: input.actor.brokerageId, actionKey: input.actionKey, resourceId });
    await recoverStuckExecutingActionRequests(DEFAULT_STUCK_EXECUTING_THRESHOLD_MS, {
      brokerageId: input.actor.brokerageId,
      actionKey: input.actionKey,
      resourceId,
    });
  }

  const inputPayloadHash = hashInputPayload(decision.parsedInput);
  const now = new Date();

  const values: InsertAiActionRequest = {
    brokerageId: input.actor.brokerageId,
    userId: input.actor.id,
    actorType: input.actorType,
    interactionId: input.interactionId ?? null,
    sessionId: input.sessionId ?? null,
    conversationId: input.conversationId ?? null,
    actionKey: input.actionKey,
    actionDefinitionVersion: definition.version,
    authorityLevel: decision.authorityLevel!,
    riskLevel: decision.riskLevel!,
    policyVersion: 1,
    resourceType: definition.resourceType,
    resourceId,
    inputPayload: decision.parsedInput as InsertAiActionRequest["inputPayload"],
    inputPayloadHash,
    proposedChanges: null,
    humanReadableSummary: definition.summarize(decision.parsedInput),
    status: decision.requiresApproval ? "AWAITING_APPROVAL" : "APPROVED",
    requiresApproval: decision.requiresApproval,
    expiresAt: new Date(now.getTime() + DEFAULT_EXPIRY_MS),
  };

  let row: AiActionRequest;
  try {
    [row] = await db.insert(aiActionRequests).values(values).returning();
  } catch (err) {
    // A concurrent proposal for the same open resource slot won the race:
    // return the surviving open request instead of failing or creating a
    // second one. No PROPOSED event is published for the loser — nothing
    // new was created.
    if (resourceId !== null && isOpenResourceUniqueViolation(err)) {
      const existing = await selectOpenActionRequestByResource(input.actionKey, input.actor.brokerageId, resourceId, new Date());
      if (existing) return { request: existing, decision, deduplicated: true };
    }
    throw err;
  }

  await publishAiActionEvent(row, "AI_ACTION_PROPOSED", { humanReadableSummary: row.humanReadableSummary });
  if (row.status === "AWAITING_APPROVAL") {
    await publishAiActionEvent(row, "AI_ACTION_APPROVAL_REQUIRED", { humanReadableSummary: row.humanReadableSummary });
  }

  return { request: row, decision };
}

// Tenant-scoped raw lookup. Internal/system use only (the Gateway, the
// automation engine's recovery, tests): it applies NO per-user access
// rule. Human-facing reads must use getAIActionRequestForActor().
export async function getAIActionRequest(id: number, brokerageId: number): Promise<AiActionRequest | null> {
  const [row] = await db
    .select()
    .from(aiActionRequests)
    .where(and(eq(aiActionRequests.id, id), eq(aiActionRequests.brokerageId, brokerageId)));
  return row ?? null;
}

// Human-facing read (GET /ai/actions/requests/:id). Returns null — the
// same result as a genuinely missing or cross-tenant id — unless the
// viewer is the requester or a brokerage administrator, so a same-brokerage
// colleague can neither read the proposal payload nor learn it exists.
// Also lazily recovers this one row if it is stuck in EXECUTING.
export async function getAIActionRequestForActor(id: number, actor: PolicyActor): Promise<AiActionRequest | null> {
  const row = await getAIActionRequest(id, actor.brokerageId);
  if (!row || !canActorAccessActionRequest(row, actor)) return null;
  if (row.status === "EXECUTING") {
    const [recovered] = await recoverStuckExecutingActionRequests(DEFAULT_STUCK_EXECUTING_THRESHOLD_MS, {
      brokerageId: actor.brokerageId,
      requestId: row.id,
      limit: 1,
    });
    if (recovered) return recovered;
  }
  return row;
}

// ---------------------------------------------------------------------
// Approval / rejection
// ---------------------------------------------------------------------

export type ApprovalDenialReason =
  | "NOT_FOUND"
  | "WRONG_STATUS"
  | "EXPIRED"
  | "APPROVER_ROLE_FORBIDDEN"
  | "REJECTOR_ROLE_FORBIDDEN"
  | "ENTITLEMENT_DENIED"
  | "PAYLOAD_TAMPERED";

export interface ApprovalResult {
  ok: boolean;
  reason?: ApprovalDenialReason;
  request?: AiActionRequest;
}

async function verifyNotTampered(row: AiActionRequest): Promise<boolean> {
  return hashInputPayload(row.inputPayload) === row.inputPayloadHash;
}

// Shared D2/D4 authority check for approve and reject. Runs BEFORE any
// status inspection or state transition, so an unauthorised caller can
// neither change the request (expire/tamper-reject it) nor receive the
// row back in a WRONG_STATUS response.
async function authorizeDecisionMaker(
  row: AiActionRequest,
  actor: PolicyActor,
  roleForbiddenReason: "APPROVER_ROLE_FORBIDDEN" | "REJECTOR_ROLE_FORBIDDEN",
): Promise<ApprovalDenialReason | null> {
  // Golden Rule applies to the approver/rejector too: only a role that
  // could perform this action manually may decide it for the AI.
  const definition = getActionDefinition(row.actionKey);
  if (!definition || !definition.allowedRoles.some((role) => role === actor.role)) {
    return roleForbiddenReason;
  }
  // Only the human the request was proposed on behalf of, or an
  // authorised brokerage administrator. Anyone else gets the same answer
  // as a missing id.
  if (!canActorAccessActionRequest(row, actor)) {
    return "NOT_FOUND";
  }
  // The decision-maker must hold the action's required entitlement right
  // now (e.g. grow.activities.manage for CREATE_GROW_COMMITMENT).
  if (!(await actorHoldsActionEntitlement(definition, actor))) {
    return "ENTITLEMENT_DENIED";
  }
  return null;
}

export async function approveAIActionRequest(id: number, brokerageId: number, approver: PolicyActor): Promise<ApprovalResult> {
  const row = await getAIActionRequest(id, brokerageId);
  if (!row) return { ok: false, reason: "NOT_FOUND" };

  const denial = await authorizeDecisionMaker(row, approver, "APPROVER_ROLE_FORBIDDEN");
  if (denial) return { ok: false, reason: denial };

  if (row.status !== "AWAITING_APPROVAL") return { ok: false, reason: "WRONG_STATUS", request: row };

  if (isExpired(row)) {
    await transitionActionRequestToExpired(row, "AWAITING_APPROVAL");
    return { ok: false, reason: "EXPIRED" };
  }

  if (!(await verifyNotTampered(row))) {
    const [rejected] = await db
      .update(aiActionRequests)
      .set({ status: "REJECTED", rejectionReason: "Input payload failed tamper check at approval time.", rejectedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(aiActionRequests.id, row.id), eq(aiActionRequests.status, "AWAITING_APPROVAL")))
      .returning();
    if (rejected) {
      await publishAiActionEvent(rejected, "AI_ACTION_BLOCKED", { reason: "PAYLOAD_TAMPERED", stage: "APPROVAL", attemptedByUserId: approver.id });
    }
    return { ok: false, reason: "PAYLOAD_TAMPERED" };
  }

  // Conditional UPDATE guards against a concurrent double-approval racing
  // this one -- only the first caller sees rowCount 1 / a returned row.
  const [updated] = await db
    .update(aiActionRequests)
    .set({ status: "APPROVED", approvedByUserId: approver.id, approvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(aiActionRequests.id, row.id), eq(aiActionRequests.status, "AWAITING_APPROVAL")))
    .returning();

  if (!updated) return { ok: false, reason: "WRONG_STATUS" };
  await publishAiActionEvent(updated, "AI_ACTION_APPROVED", { approvedByUserId: approver.id });
  return { ok: true, request: updated };
}

export async function rejectAIActionRequest(
  id: number,
  brokerageId: number,
  rejector: PolicyActor,
  reason: string,
): Promise<ApprovalResult> {
  const row = await getAIActionRequest(id, brokerageId);
  if (!row) return { ok: false, reason: "NOT_FOUND" };

  const denial = await authorizeDecisionMaker(row, rejector, "REJECTOR_ROLE_FORBIDDEN");
  if (denial) return { ok: false, reason: denial };

  if (row.status !== "AWAITING_APPROVAL") return { ok: false, reason: "WRONG_STATUS", request: row };

  if (isExpired(row)) {
    await transitionActionRequestToExpired(row, "AWAITING_APPROVAL");
    return { ok: false, reason: "EXPIRED" };
  }

  const [updated] = await db
    .update(aiActionRequests)
    .set({ status: "REJECTED", rejectedByUserId: rejector.id, rejectedAt: new Date(), rejectionReason: reason, updatedAt: new Date() })
    .where(and(eq(aiActionRequests.id, row.id), eq(aiActionRequests.status, "AWAITING_APPROVAL")))
    .returning();

  if (!updated) return { ok: false, reason: "WRONG_STATUS" };
  await publishAiActionEvent(updated, "AI_ACTION_REJECTED", { rejectedByUserId: rejector.id, reason });
  return { ok: true, request: updated };
}

// ---------------------------------------------------------------------
// AE GROW Priority 6 Stage D — query helpers (hardened in F4.0: both now
// transition expired rows first and never return an expired request).
// ---------------------------------------------------------------------

// Finds an existing, still-open (not rejected/failed/expired/completed)
// request for the same action + brokerage + resourceId, so a caller can
// avoid creating a second, duplicate proposal for the same underlying
// follow-up while one is already pending review or in flight. Expired
// AWAITING_APPROVAL/APPROVED rows in scope are transitioned to EXPIRED
// (audited) and stuck EXECUTING rows are recovered first, so neither can
// block a fresh proposal. orchestrator.ts's Grow follow-up-commitment flow
// skips proposing a new one when this returns a row, using a deterministic
// resourceId derived from the source Grow Today item and due date (never a
// client- or model-supplied value).
export async function findOpenActionRequestByResource(
  actionKey: string,
  brokerageId: number,
  resourceId: string,
): Promise<AiActionRequest | null> {
  const now = new Date();
  await expireStaleOpenActionRequests({ brokerageId, actionKey, resourceId }, now);
  await recoverStuckExecutingActionRequests(DEFAULT_STUCK_EXECUTING_THRESHOLD_MS, { brokerageId, actionKey, resourceId });
  return selectOpenActionRequestByResource(actionKey, brokerageId, resourceId, now);
}

// Backs the "list current user's pending Grow proposals" read surface
// (routes/growAiActions.ts). Deliberately scoped to one specific
// actionKey, one brokerage, and one user — never a generic "list every
// request" query, matching the Stage D specification's prohibition on a
// generic, unscoped action-request listing surface. Expired proposals are
// transitioned (audited) and excluded.
export async function listAwaitingApprovalForUser(
  actionKey: string,
  brokerageId: number,
  userId: number,
): Promise<AiActionRequest[]> {
  const now = new Date();
  await expireStaleOpenActionRequests({ brokerageId, actionKey, userId }, now);
  return db
    .select()
    .from(aiActionRequests)
    .where(
      and(
        eq(aiActionRequests.actionKey, actionKey),
        eq(aiActionRequests.brokerageId, brokerageId),
        eq(aiActionRequests.userId, userId),
        eq(aiActionRequests.status, "AWAITING_APPROVAL"),
        notExpiredCondition(now),
      ),
    )
    .orderBy(desc(aiActionRequests.createdAt));
}
