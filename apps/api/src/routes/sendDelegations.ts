// Owner t276u/t277u: delegations expire after 30 days; the owning agent may renew (POST
// /send-delegations/renew) an unrevoked delegation. An agent explicitly records (or revokes) a delegation of final-send authority
// for ONE proposal (appraisal) or document package to a named colleague. Only the owning
// agent may delegate; the delegate must be an Agent or Brokerage Administrator in the same
// brokerage (never Pit Crew, never self). Stored as audit_logs rows (no schema).
import { Router } from "express";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db, users } from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { logAudit } from "../lib/audit.js";
import { activeSendDelegation, holdsAuthorisedAgentRole, SEND_DELEGATE_ROLES, SEND_DELEGATION_TTL_DAYS, sendRecordOwner } from "../lib/contactAuthority.js";

export const sendDelegationsRouter = Router();

const body = z.object({
  recordType: z.enum(["appraisal", "document_package"]),
  recordId: z.number().int().positive(),
  delegateUserId: z.number().int().positive(),
  reason: z.string().trim().min(5).max(500).optional(),
});

async function handle(action: "send_authority_delegated" | "send_authority_revoked", req: import("express").Request, res: import("express").Response, renew = false) {
  const user = req.authedUser!;
  const parsed = body.safeParse(req.body);
  if (!parsed.success || (action === "send_authority_delegated" && !parsed.data.reason)) {
    res.status(400).json({ error: "recordType, recordId, delegateUserId and (to delegate) a reason of 5-500 characters are required.", code: "SEND_DELEGATION_INVALID" });
    return;
  }
  const { recordType, recordId, delegateUserId, reason } = parsed.data;
  const owner = await sendRecordOwner(user.brokerageId, recordType, recordId);
  if (owner === null) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!holdsAuthorisedAgentRole(user) || owner !== user.id) {
    res.status(403).json({ error: "Only the owning agent can delegate or revoke sending for this record.", code: "SEND_DELEGATION_OWNER_ONLY" });
    return;
  }
  const [delegate] = await db.select({ id: users.id, role: users.role }).from(users).where(and(eq(users.id, delegateUserId), eq(users.brokerageId, user.brokerageId))).limit(1);
  if (!delegate || delegate.id === user.id || !SEND_DELEGATE_ROLES.includes(delegate.role)) {
    res.status(422).json({ error: "The delegate must be another agent or a brokerage administrator in this brokerage (never Pit Crew).", code: "SEND_DELEGATE_INVALID" });
    return;
  }
  let renewedFrom: number | null = null;
  if (renew) {
    // Renewal: only an existing (active or expired, not revoked) delegation by this owner.
    const prior = (await db.execute(sql`select id, action from audit_logs where brokerage_id = ${user.brokerageId} and record_type = ${recordType} and record_id = ${String(recordId)} and provider_reference = ${`delegate:${delegate.id}`} and action in ('send_authority_delegated','send_authority_revoked') order by created_at desc, id desc limit 1`)).rows as { id: number; action: string }[];
    if (!prior[0] || prior[0].action !== "send_authority_delegated") {
      res.status(409).json({ error: "There is no delegation to renew (it was never made or was revoked). Record a new delegation instead.", code: "SEND_DELEGATION_NOT_RENEWABLE" });
      return;
    }
    renewedFrom = Number(prior[0].id);
  }
  const auditId = await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action,
    recordType,
    recordId: String(recordId),
    updatedValue: JSON.stringify({ delegatedBy: { userId: user.id }, delegate: { userId: delegate.id, role: delegate.role }, reason: reason ?? null, renewedFrom, expiresAt: action === "send_authority_delegated" ? new Date(Date.now() + SEND_DELEGATION_TTL_DAYS * 86_400_000).toISOString() : null }),
    providerReference: `delegate:${delegate.id}`,
  }, { strict: true });
  res.status(action === "send_authority_delegated" ? 201 : 200).json({ auditId, recordType, recordId, delegateUserId: delegate.id, active: action === "send_authority_delegated", renewedFrom, expiresAt: action === "send_authority_delegated" ? new Date(Date.now() + SEND_DELEGATION_TTL_DAYS * 86_400_000).toISOString() : null });
}

sendDelegationsRouter.post("/send-delegations", requireAuth, (req, res) => void handle("send_authority_delegated", req, res));
sendDelegationsRouter.post("/send-delegations/renew", requireAuth, (req, res) => void handle("send_authority_delegated", req, res, true));
sendDelegationsRouter.post("/send-delegations/revoke", requireAuth, (req, res) => void handle("send_authority_revoked", req, res));
sendDelegationsRouter.get("/send-delegations/check", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const recordType = req.query.recordType === "document_package" ? "document_package" : "appraisal";
  const recordId = Number(req.query.recordId);
  if (!Number.isInteger(recordId) || recordId <= 0) {
    res.status(400).json({ error: "recordId required" });
    return;
  }
  const d = await activeSendDelegation(user.brokerageId, recordType, recordId, user.id);
  res.json({ recordType, recordId, canSend: user.role === "Agent" || d !== null, delegated: d !== null, delegationExpiresAt: d?.expiresAt ?? null });
});
