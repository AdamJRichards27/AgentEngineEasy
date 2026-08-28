// AI Governance, Authority & Action Control Architecture -- Stage G5.
//
// Action Request + Human Approval Engine. This module owns the
// aiActionRequests state machine end to end:
//
//   PROPOSED -> AWAITING_APPROVAL -> APPROVED -> EXECUTING -> COMPLETED
//                                 \-> REJECTED               \-> FAILED
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

import { createHash } from "node:crypto";
import { db, aiActionRequests, type AiActionRequest, type InsertAiActionRequest } from "@aee/db";
import { and, eq } from "drizzle-orm";
import { evaluateAIAction, type PolicyActor, type PolicyDecision } from "./policyEngine.js";
import { getActionDefinition, type ActorType } from "./actions/registry.js";
import { publishAiActionEvent } from "./actionEvents.js";

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
    resourceId: input.resourceId ?? null,
    inputPayload: decision.parsedInput as InsertAiActionRequest["inputPayload"],
    inputPayloadHash,
    proposedChanges: null,
    humanReadableSummary: definition.summarize(decision.parsedInput),
    status: decision.requiresApproval ? "AWAITING_APPROVAL" : "APPROVED",
    requiresApproval: decision.requiresApproval,
    expiresAt: new Date(now.getTime() + DEFAULT_EXPIRY_MS),
  };

  const [row] = await db.insert(aiActionRequests).values(values).returning();

  await publishAiActionEvent(row, "AI_ACTION_PROPOSED", { humanReadableSummary: row.humanReadableSummary });
  if (row.status === "AWAITING_APPROVAL") {
    await publishAiActionEvent(row, "AI_ACTION_APPROVAL_REQUIRED", { humanReadableSummary: row.humanReadableSummary });
  }

  return { request: row, decision };
}

export async function getAIActionRequest(id: number, brokerageId: number): Promise<AiActionRequest | null> {
  const [row] = await db
    .select()
    .from(aiActionRequests)
    .where(and(eq(aiActionRequests.id, id), eq(aiActionRequests.brokerageId, brokerageId)));
  return row ?? null;
}

export type ApprovalDenialReason =
  | "NOT_FOUND"
  | "WRONG_STATUS"
  | "EXPIRED"
  | "APPROVER_ROLE_FORBIDDEN"
  | "PAYLOAD_TAMPERED";

export interface ApprovalResult {
  ok: boolean;
  reason?: ApprovalDenialReason;
  request?: AiActionRequest;
}

async function verifyNotTampered(row: AiActionRequest): Promise<boolean> {
  return hashInputPayload(row.inputPayload) === row.inputPayloadHash;
}

export async function approveAIActionRequest(id: number, brokerageId: number, approver: PolicyActor): Promise<ApprovalResult> {
  const row = await getAIActionRequest(id, brokerageId);
  if (!row) return { ok: false, reason: "NOT_FOUND" };
  if (row.status !== "AWAITING_APPROVAL") return { ok: false, reason: "WRONG_STATUS", request: row };

  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    await db.update(aiActionRequests).set({ status: "EXPIRED", updatedAt: new Date() }).where(eq(aiActionRequests.id, row.id));
    return { ok: false, reason: "EXPIRED" };
  }

  if (!(await verifyNotTampered(row))) {
    await db
      .update(aiActionRequests)
      .set({ status: "REJECTED", rejectionReason: "Input payload failed tamper check at approval time.", rejectedAt: new Date(), updatedAt: new Date() })
      .where(eq(aiActionRequests.id, row.id));
    return { ok: false, reason: "PAYLOAD_TAMPERED" };
  }

  // Golden Rule applies to the approver too: only a role that could
  // perform this action manually may approve it for the AI.
  const definition = getActionDefinition(row.actionKey);
  if (!definition || !definition.allowedRoles.some((role) => role === approver.role)) {
    return { ok: false, reason: "APPROVER_ROLE_FORBIDDEN" };
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
  if (row.status !== "AWAITING_APPROVAL") return { ok: false, reason: "WRONG_STATUS", request: row };

  const [updated] = await db
    .update(aiActionRequests)
    .set({ status: "REJECTED", rejectedByUserId: rejector.id, rejectedAt: new Date(), rejectionReason: reason, updatedAt: new Date() })
    .where(and(eq(aiActionRequests.id, row.id), eq(aiActionRequests.status, "AWAITING_APPROVAL")))
    .returning();

  if (!updated) return { ok: false, reason: "WRONG_STATUS" };
  await publishAiActionEvent(updated, "AI_ACTION_REJECTED", { rejectedByUserId: rejector.id, reason });
  return { ok: true, request: updated };
}
