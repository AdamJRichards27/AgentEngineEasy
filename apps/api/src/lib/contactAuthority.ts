// Owner t275u: Pit Crew acts on contact records ONLY on the recorded authority
// of the contact owner (an agent). No new tables (design pass, evidence-t275u):
//   - the authority travels with each request: headers
//       X-AE-On-Behalf-Of: <owner user id>      (the requester / contact owner)
//       X-AE-Authority-Ref: <instruction reference, 3..200 chars>
//   - the owner is validated server-side: exists, same brokerage, an agent role
//     (Agent or Brokerage Administrator), not Pit Crew;
//   - "owns or is assigned the contact" is derived from existing data (see
//     ownedPartyIdsSql): the contact is linked to a property the owner is the
//     agent for, or the owner created a Grow relationship for it, owns a Grow
//     opportunity or appraisal for it, or the contact was recorded for the owner
//     when Pit Crew created it on their authority (audit_logs
//     action contact_owner_recorded, provider_reference "owner:<id>");
//   - every material action is audited in audit_logs with requestedBy (owner),
//     performedBy (Pit Crew user), authorityRef, time (created_at) and before/after.
// Brokerage entitlements alone grant Pit Crew nothing here: the authority is
// required, and the owner (not Pit Crew) must hold the entitlement the route needs.
// Agents and Brokerage Administrators are unaffected (no headers needed, ignored).
import type { NextFunction, Request, Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db, users } from "@aee/db";
import type { AuthedUser } from "../middlewares/auth.js";
import { explainEntitlementDecision } from "./entitlements/resolver.js";
import { logAudit } from "./audit.js";
import { fieldNames, sealedOrWithheld } from "./auditValueVault.js";

function sealedText(v: unknown): string {
  const sealed = sealedOrWithheld(v);
  return typeof sealed === "string" ? sealed : JSON.stringify(sealed);
}

export const PIT_CREW_ROLE = "Pit Crew";
export const CONTACT_OWNER_ROLES = ["Agent", "Brokerage Administrator"] as const;
export const ON_BEHALF_HEADER = "x-ae-on-behalf-of";
export const AUTHORITY_REF_HEADER = "x-ae-authority-ref";

export interface ActingAuthority {
  owner: AuthedUser;
  ownerEmail: string | null;
  authorityRef: string;
  performedBy: AuthedUser;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actingFor?: ActingAuthority;
    }
  }
}

export function isPitCrew(user: { role: string } | null | undefined): boolean {
  return user?.role === PIT_CREW_ROLE;
}

export type AuthorityError = { status: 403; body: { error: string; code: string } };
const refuse = (code: string, error: string): AuthorityError => ({ status: 403, body: { error, code } });

export const AUTHORITY_REQUIRED = "CONTACT_OWNER_AUTHORITY_REQUIRED";
export const AUTHORITY_OWNER_INVALID = "CONTACT_OWNER_AUTHORITY_INVALID";
export const AUTHORITY_OUT_OF_SCOPE = "CONTACT_OWNER_AUTHORITY_OUT_OF_SCOPE";
export const AUTHORITY_OWNER_NOT_ENTITLED = "CONTACT_OWNER_NOT_ENTITLED";

/** Reads and validates the authority headers for a Pit Crew caller. */
export async function resolveAuthority(req: Request): Promise<ActingAuthority | AuthorityError> {
  const user = req.authedUser!;
  const rawOwner = String(req.get(ON_BEHALF_HEADER) ?? "").trim();
  const ref = String(req.get(AUTHORITY_REF_HEADER) ?? "").trim();
  if (!/^\d+$/.test(rawOwner) || ref.length < 3 || ref.length > 200) {
    return refuse(AUTHORITY_REQUIRED, "Pit Crew needs the contact owner's recorded authority (the owning agent and an instruction reference) for this action.");
  }
  const ownerId = Number(rawOwner);
  const [owner] = await db
    .select({ id: users.id, role: users.role, brokerageId: users.brokerageId, email: users.email })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  if (!owner || owner.brokerageId !== user.brokerageId || !(CONTACT_OWNER_ROLES as readonly string[]).includes(owner.role) || owner.id === user.id) {
    return refuse(AUTHORITY_OWNER_INVALID, "The named contact owner must be an agent in this brokerage.");
  }
  return { owner: { id: owner.id, role: owner.role as AuthedUser["role"], brokerageId: owner.brokerageId }, ownerEmail: owner.email ?? null, authorityRef: ref, performedBy: user };
}

/** SQL: party ids the owner owns or is assigned, in the brokerage (existing tables only). */
export function ownedPartyIdsSql(brokerageId: number, ownerId: number) {
  return sql`(
    select pp.party_id from property_parties pp join properties p on p.id = pp.property_id
      where p.brokerage_id = ${brokerageId} and p.agent_id = ${ownerId}
    union select gr.party_id from grow_relationships gr where gr.brokerage_id = ${brokerageId} and gr.created_by = ${ownerId}
    union select go.party_id from grow_opportunities go where go.brokerage_id = ${brokerageId} and go.owner_user_id = ${ownerId}
    union select a.party_id from appraisals a where a.brokerage_id = ${brokerageId} and a.owner_user_id = ${ownerId} and a.party_id is not null
    union select (al.record_id)::int from audit_logs al
      where al.brokerage_id = ${brokerageId} and al.action = 'contact_owner_recorded' and al.record_type = 'party'
        and al.provider_reference = ${`owner:${ownerId}`}
  )`;
}

export async function ownedPartyIds(brokerageId: number, ownerId: number): Promise<number[]> {
  const rows = (await db.execute(sql`select party_id from ${ownedPartyIdsSql(brokerageId, ownerId)} as owned(party_id)`)).rows as { party_id: number }[];
  return rows.map((r) => Number(r.party_id));
}

export async function ownerOwnsParties(brokerageId: number, ownerId: number, partyIds: number[]): Promise<boolean> {
  if (partyIds.length === 0) return true;
  const owned = new Set(await ownedPartyIds(brokerageId, ownerId));
  return partyIds.every((id) => owned.has(id));
}

export async function ownerIsPropertyAgent(brokerageId: number, ownerId: number, propertyId: number): Promise<boolean> {
  const rows = (await db.execute(sql`select 1 from properties where id = ${propertyId} and brokerage_id = ${brokerageId} and agent_id = ${ownerId}`)).rows;
  return rows.length > 0;
}

export const outOfScope = (): AuthorityError => refuse(AUTHORITY_OUT_OF_SCOPE, "That contact or property is outside the named owner's contacts.");

/**
 * Route middleware. Non-Pit-Crew callers: exactly `requireEntitlement(key)`-style
 * behaviour is left to the existing middleware that follows (pass `key` only for
 * Pit Crew). Pit Crew: valid authority required, and the OWNER must hold `key`
 * (when given). On success sets req.actingFor.
 */
export function requirePitCrewAuthority(ownerEntitlementKey?: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.authedUser;
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (!isPitCrew(user)) return next();
    const a = await resolveAuthority(req);
    if ("status" in a) {
      res.status(a.status).json(a.body);
      return;
    }
    if (ownerEntitlementKey) {
      const d = await explainEntitlementDecision(a.owner, ownerEntitlementKey).catch(() => ({ allowed: false }));
      if (!d.allowed) {
        res.status(403).json({ error: "The named contact owner does not have access to this action.", code: AUTHORITY_OWNER_NOT_ENTITLED, entitlementKey: ownerEntitlementKey });
        return;
      }
    }
    req.actingFor = a;
    next();
  };
}

/**
 * For routes that keep an entitlement gate: agents and admins go through the
 * normal middleware; Pit Crew is evaluated on the owner's entitlement instead.
 */
export function entitlementOrAuthority(key: string, normal: (req: Request, res: Response, next: NextFunction) => unknown) {
  const pc = requirePitCrewAuthority(key);
  return (req: Request, res: Response, next: NextFunction) => (isPitCrew(req.authedUser) ? pc(req, res, next) : normal(req, res, next));
}

/**
 * Reads keep their existing access (t275u scope: authority governs CHANGES, imports and
 * exports). A Pit Crew read that names an owner is evaluated and scoped as that owner.
 */
export function readWithOptionalAuthority(key: string, normal: (req: Request, res: Response, next: NextFunction) => unknown) {
  const pc = requirePitCrewAuthority(key);
  return (req: Request, res: Response, next: NextFunction) =>
    isPitCrew(req.authedUser) && req.get(ON_BEHALF_HEADER) ? pc(req, res, next) : normal(req, res, next);
}

/** Audit one authority-backed action: requester, performer, time (row created_at), before/after (encrypted). */
export async function auditAuthorityAction(
  req: Request,
  input: { action: string; recordType: string; recordId: string | number; propertyId?: number | null; before?: unknown; after?: unknown },
): Promise<void> {
  const a = req.actingFor;
  const user = req.authedUser!;
  await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: input.action,
    recordType: input.recordType,
    recordId: String(input.recordId),
    propertyId: input.propertyId ?? null,
    // t276u: values encrypted at rest (lib/auditValueVault.ts); metadata stays readable.
    previousValue: input.before === undefined || input.before === null ? undefined : sealedText(input.before),
    updatedValue: JSON.stringify({
      after: sealedOrWithheld(input.after),
      fields: [...new Set([...fieldNames(input.before), ...fieldNames(input.after)])].sort(),
      requestedBy: a ? { userId: a.owner.id } : { userId: user.id },
      performedBy: { userId: user.id, role: user.role },
      authorityRef: a?.authorityRef ?? null,
    }),
    providerReference: a ? `owner:${a.owner.id}` : undefined,
  });
}

/** A contact Pit Crew created on an owner's authority is recorded as that owner's. */
export async function recordContactOwner(req: Request, partyId: number): Promise<void> {
  // The owner of a new contact is the agent it was created for: the named owner when Pit
  // Crew acts on authority, otherwise the creating agent / administrator. (Ownership is
  // never transferred by Pit Crew: there is no route that rewrites this record.)
  const a = req.actingFor;
  const user = req.authedUser!;
  const ownerId = a ? a.owner.id : (CONTACT_OWNER_ROLES as readonly string[]).includes(user.role) ? user.id : null;
  if (ownerId === null) return;
  await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: "contact_owner_recorded",
    recordType: "party",
    recordId: String(partyId),
    updatedValue: JSON.stringify({ requestedBy: { userId: ownerId }, performedBy: { userId: user.id }, authorityRef: a?.authorityRef ?? null }),
    providerReference: `owner:${ownerId}`,
  });
}

/** Pit Crew check for a set of parties and (optionally) a property; agents pass through. */
export async function pitCrewScopeRefusal(req: Request, scope: { partyIds?: number[]; propertyId?: number | null }): Promise<AuthorityError | null> {
  if (!isPitCrew(req.authedUser)) return null;
  const a = req.actingFor;
  if (!a) return refuse(AUTHORITY_REQUIRED, "Pit Crew needs the contact owner's recorded authority for this action.");
  const b = req.authedUser!.brokerageId;
  if (scope.propertyId != null && !(await ownerIsPropertyAgent(b, a.owner.id, scope.propertyId))) return outOfScope();
  if (scope.partyIds && !(await ownerOwnsParties(b, a.owner.id, scope.partyIds))) return outOfScope();
  return null;
}


/**
 * Owner t276u: final sending of a proposal (appraisal) or a listing agreement / document
 * package is an AGENT authorisation. Brokerage Administrators keep oversight and review but
 * cannot send by role. t277u: an administrator who also holds an authorised Agent role
 * (holdsAuthorisedAgentRole) sends their own records as the Agent. Anyone else may send only on a delegation the owning agent has
 * explicitly recorded for that one record (audit_logs action send_authority_delegated,
 * provider_reference "delegate:<userId>", latest delegated/revoked event wins). Pit Crew never
 * sends, delegated or not. No schema: delegations live in audit_logs.
 */
export const SEND_AUTHORISATION_ROLES: readonly string[] = ["Agent"];
export const SEND_DELEGATE_ROLES: readonly string[] = ["Agent", "Brokerage Administrator"];
export type SendRecordType = "appraisal" | "document_package";

/** The agent who owns the record (appraisal owner / listing agent of the package's property). */
export async function sendRecordOwner(brokerageId: number, recordType: SendRecordType, recordId: number): Promise<number | null> {
  const rows = (
    recordType === "appraisal"
      ? await db.execute(sql`select owner_user_id as owner from appraisals where id = ${recordId} and brokerage_id = ${brokerageId}`)
      : await db.execute(sql`select p.agent_id as owner from document_packages dp join properties p on p.id = dp.property_id where dp.id = ${recordId} and p.brokerage_id = ${brokerageId}`)
  ).rows as { owner: number | null }[];
  return rows[0]?.owner == null ? null : Number(rows[0].owner);
}

/** t277u: a recorded delegation is valid for 30 days from when it was made (or last renewed). */
export const SEND_DELEGATION_TTL_DAYS = 30;

/**
 * Latest recorded delegation for (record, delegate). Valid only when it is the latest
 * delegated/revoked event, it was made by the record's CURRENT owner (ownership change
 * invalidates it) and it is under 30 days old (renewal writes a fresh delegated row).
 */
export async function activeSendDelegation(
  brokerageId: number,
  recordType: SendRecordType,
  recordId: number,
  delegateId: number,
  now: Date = new Date(),
): Promise<{ auditId: number; delegatorId: number; expiresAt: Date } | null> {
  const owner = await sendRecordOwner(brokerageId, recordType, recordId);
  if (owner === null) return null;
  const rows = (
    await db.execute(sql`select id, action, user_id, created_at from audit_logs
      where brokerage_id = ${brokerageId} and record_type = ${recordType} and record_id = ${String(recordId)}
        and provider_reference = ${`delegate:${delegateId}`} and action in ('send_authority_delegated','send_authority_revoked')
      order by created_at desc, id desc limit 1`)
  ).rows as { id: number; action: string; user_id: number; created_at: Date | string }[];
  const r = rows[0];
  if (!r || r.action !== "send_authority_delegated" || Number(r.user_id) !== owner) return null;
  const expiresAt = new Date(new Date(r.created_at).getTime() + SEND_DELEGATION_TTL_DAYS * 86_400_000);
  if (expiresAt.getTime() <= now.getTime()) return null;
  return { auditId: Number(r.id), delegatorId: owner, expiresAt };
}

/**
 * t277u dual roles: a Brokerage Administrator who also holds an authorised Agent role may send
 * their OWN records as the Agent. users.role is single-valued, so the Agent role of an
 * administrator is authorised explicitly in deploy config AE_ADMIN_AGENT_ROLE_USER_IDS
 * (comma-separated user ids; empty by default). See SCHEMA-NEEDS.md for the first-class design.
 */
export function holdsAuthorisedAgentRole(user: { id: number; role: string }): boolean {
  if (user.role === "Agent") return true;
  if (user.role !== "Brokerage Administrator") return false;
  return String(process.env.AE_ADMIN_AGENT_ROLE_USER_IDS ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .includes(user.id);
}

export const SEND_AUTHORISATION_REQUIRED = "SEND_AUTHORISATION_REQUIRED";
export function requireSendAuthorisation(recordType: SendRecordType, param: string, entitlementKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = req.authedUser;
    const refuseSend = (reason: string) =>
      res.status(403).json({
        error:
          reason === "ADMIN_REVIEW_ONLY"
            ? "Administrators can review this but not send it. The agent sends it, or records a delegation to you first."
            : "Sending needs agent authorisation. Return it to the agent for review and sending.",
        code: SEND_AUTHORISATION_REQUIRED,
        reason,
      });
    if (!user) return refuseSend("ROLE");
    if (isPitCrew(user)) return refuseSend("PIT_CREW");
    if (SEND_AUTHORISATION_ROLES.includes(user.role)) return next();
    // Not entitled to the product at all: let the route's own entitlement gate answer (403 with its key).
    const entitled = await explainEntitlementDecision(user, entitlementKey as never).then((d) => d.allowed).catch(() => false);
    if (!entitled) return next();
    const id = Number(req.params[param]);
    // A malformed id is not a send: let the route answer its own 400.
    if (!/^\d+$/.test(String(req.params[param] ?? "")) || id <= 0 || id > 2_147_483_647) return next();
    // t277u: an administrator who ALSO holds an authorised Agent role sends their own records
    // as the Agent. An administrator-only user needs a valid recorded delegation.
    if (holdsAuthorisedAgentRole(user) && (await sendRecordOwner(user.brokerageId, recordType, id).catch(() => null)) === user.id) {
      await logAudit({ brokerageId: user.brokerageId, userId: user.id, action: "send_as_agent_dual_role", recordType, recordId: String(id), updatedValue: JSON.stringify({ performedBy: { userId: user.id, role: user.role }, actingRole: "Agent" }) });
      return next();
    }
    if (Number.isInteger(id) && id > 0 && SEND_DELEGATE_ROLES.includes(user.role)) {
      const d = await activeSendDelegation(user.brokerageId, recordType, id, user.id).catch(() => null);
      if (d) {
        await logAudit({
          brokerageId: user.brokerageId,
          userId: user.id,
          action: "send_on_delegated_authority",
          recordType,
          recordId: String(id),
          updatedValue: JSON.stringify({ delegatedBy: { userId: d.delegatorId }, delegationAuditId: d.auditId, delegationExpiresAt: d.expiresAt.toISOString(), performedBy: { userId: user.id, role: user.role } }),
          providerReference: `delegation:${d.auditId}`,
        });
        return next();
      }
    }
    return refuseSend(user.role === "Brokerage Administrator" ? "ADMIN_REVIEW_ONLY" : "ROLE");
  };
}
