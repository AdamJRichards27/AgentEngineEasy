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

/** Audit one authority-backed action: requester, performer, time (row created_at), before/after. */
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
    previousValue: input.before === undefined ? undefined : JSON.stringify(input.before),
    updatedValue: JSON.stringify({
      after: input.after ?? null,
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
 * t275u: sending or issuing a proposal or agreement is an agent authorisation. Agent and
 * Brokerage Administrator hold it; Pit Crew never does, whatever authority it carries.
 */
export const SEND_AUTHORISATION_ROLES: readonly string[] = ["Agent", "Brokerage Administrator"];
export function requireSendAuthorisation() {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.authedUser;
    if (!user || !SEND_AUTHORISATION_ROLES.includes(user.role)) {
      res.status(403).json({
        error: "Sending needs agent authorisation. Return it to the agent for review and sending.",
        code: "SEND_AUTHORISATION_REQUIRED",
      });
      return;
    }
    next();
  };
}
