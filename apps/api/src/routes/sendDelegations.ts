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
import { isPitCrew } from "../lib/contactAuthority.js";
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
    const prior = (await db.execute(sql`select id, action, user_id from audit_logs where brokerage_id = ${user.brokerageId} and record_type = ${recordType} and record_id = ${String(recordId)} and provider_reference = ${`delegate:${delegate.id}`} and action in ('send_authority_delegated','send_authority_revoked') order by created_at desc, id desc limit 1`)).rows as { id: number; action: string; user_id: number }[];
    if (!prior[0] || prior[0].action !== "send_authority_delegated" || Number(prior[0].user_id) !== owner) {
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

// t280u: delegation status for one record. Owner (an authorised Agent who owns the record):
// every delegate with state and the eligible delegates. Brokerage Administrator: oversight
// view (no eligible list, cannot manage). Any other Agent: only their own delegation row.
// Pit Crew: 403. A record outside the caller's brokerage: 404.
type DelegationState = "active" | "expired" | "revoked" | "invalidated";
sendDelegationsRouter.get("/send-delegations", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  if (isPitCrew(user)) {
    res.status(403).json({ error: "Pit Crew cannot view or use send delegations.", code: "SEND_DELEGATION_READ_FORBIDDEN", reason: "PIT_CREW" });
    return;
  }
  const recordType = req.query.recordType;
  const recordId = Number(req.query.recordId);
  if ((recordType !== "appraisal" && recordType !== "document_package") || !/^\d+$/.test(String(req.query.recordId ?? "")) || recordId <= 0 || recordId > 2_147_483_647) {
    res.status(400).json({ error: "recordType (appraisal | document_package) and a positive recordId are required.", code: "SEND_DELEGATION_INVALID" });
    return;
  }
  const owner = await sendRecordOwner(user.brokerageId, recordType, recordId);
  if (owner === null) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const isOwner = holdsAuthorisedAgentRole(user) && owner === user.id;
  const isAdmin = user.role === "Brokerage Administrator";
  if (!isOwner && !isAdmin && user.role !== "Agent") {
    res.status(403).json({ error: "You cannot view delegations for this record.", code: "SEND_DELEGATION_READ_FORBIDDEN", reason: "ROLE" });
    return;
  }
  const rows = (
    await db.execute(sql`select id, action, user_id, provider_reference, updated_value, created_at from audit_logs
      where brokerage_id = ${user.brokerageId} and record_type = ${recordType} and record_id = ${String(recordId)}
        and action in ('send_authority_delegated','send_authority_revoked') and provider_reference like 'delegate:%'
      order by created_at desc, id desc`)
  ).rows as { id: number; action: string; user_id: number; provider_reference: string; updated_value: string | null; created_at: Date | string }[];
  const latest = new Map<number, typeof rows>();
  for (const r of rows) {
    const d = Number(r.provider_reference.slice("delegate:".length));
    if (!latest.has(d)) latest.set(d, []);
    latest.get(d)!.push(r);
  }
  const people = new Map(
    (await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, role: users.role, isActive: users.isActive }).from(users).where(eq(users.brokerageId, user.brokerageId))).map((u) => [u.id, u]),
  );
  const nameOf = (id: number) => {
    const u = people.get(id);
    return u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || null : null;
  };
  const now = Date.now();
  const delegations = [...latest.entries()]
    .filter(([delegateId]) => isOwner || isAdmin || delegateId === user.id)
    .map(([delegateId, events]) => {
      const last = events[0];
      const lastGrant = events.find((e) => e.action === "send_authority_delegated") ?? null;
      const meta = lastGrant?.updated_value ? (JSON.parse(lastGrant.updated_value) as { reason?: string | null; renewedFrom?: number | null }) : {};
      const grantedAt = lastGrant ? new Date(lastGrant.created_at) : null;
      const expiresAt = grantedAt ? new Date(grantedAt.getTime() + SEND_DELEGATION_TTL_DAYS * 86_400_000) : null;
      let state: DelegationState;
      if (last.action === "send_authority_revoked") state = "revoked";
      else if (Number(last.user_id) !== owner) state = "invalidated";
      else if (expiresAt!.getTime() <= now) state = "expired";
      else state = "active";
      return {
        delegateUserId: delegateId,
        delegateName: nameOf(delegateId),
        delegateRole: people.get(delegateId)?.role ?? null,
        state,
        reason: meta.reason ?? null,
        grantedByUserId: lastGrant ? Number(lastGrant.user_id) : null,
        grantedAt: grantedAt?.toISOString() ?? null,
        expiresAt: expiresAt?.toISOString() ?? null,
        renewedFrom: meta.renewedFrom ?? null,
        renewalCount: Math.max(0, (() => { const cut = events.findIndex((x) => x.action === "send_authority_revoked"); return (cut === -1 ? events : events.slice(0, cut)).filter((e) => e.action === "send_authority_delegated").length - 1; })()),
        revokedAt: last.action === "send_authority_revoked" ? new Date(last.created_at).toISOString() : null,
        revokedByUserId: last.action === "send_authority_revoked" ? Number(last.user_id) : null,
        invalidatedByOwnershipChange: state === "invalidated",
        renewable: isOwner && (state === "active" || state === "expired"),
        revocable: isOwner && (state === "active" || state === "expired"),
      };
    });
  const eligibleDelegates = isOwner
    ? [...people.values()]
        .filter((u) => u.id !== user.id && u.isActive && SEND_DELEGATE_ROLES.includes(u.role))
        .map((u) => ({ userId: u.id, name: nameOf(u.id), role: u.role }))
    : [];
  res.setHeader("Cache-Control", "no-store");
  res.json({ recordType, recordId, ownerUserId: owner, viewer: isOwner ? "owner" : isAdmin ? "admin" : "delegate", canManage: isOwner, ttlDays: SEND_DELEGATION_TTL_DAYS, delegations, eligibleDelegates });
});
