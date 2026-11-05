// Owner t275u item 4: ONE server-side duplicate-contact service for every
// contact-creation path (POST /grow/contacts, POST /parties incl. Run Add Person,
// offers with new buyer details, import execute/resolve). Standard:
//   - search existing contacts by name, email and mobile (brokerage scoped);
//   - callers reuse an existing contact (contactId) instead of creating;
//   - a match BLOCKS creation by default (409 DUPLICATE_CONTACT);
//   - a genuine duplicate needs an explicit override { duplicateOverride: { reason } }
//     by an authorised user, recorded in audit_logs (contact_duplicate_override);
//   - visibility/masking: contactId only for callers with contact-read; a Pit Crew
//     caller sees an id only for contacts inside its acting owner's scope.
// No new tables: audit_logs carries the override reason.
import type { Request } from "express";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, parties } from "@aee/db";
import { findDuplicateContact } from "../routes/contacts.js";
import { contactPhoneMatchKey } from "./contactPhoneMatch.js";
import { explainEntitlementDecision } from "./entitlements/resolver.js";
import { logAudit } from "./audit.js";
import { isPitCrew, ownedPartyIds } from "./contactAuthority.js";

export type DuplicateKind = "email" | "phone" | "name";
export interface DuplicateQuery {
  firstName?: string | null;
  lastName?: string | null;
  organisationName?: string | null;
  email?: string | null;
  mobile?: string | null;
}
export interface DuplicateHit { kind: DuplicateKind; partyId: number }
export interface VisibleDuplicate { code: "POTENTIAL_DUPLICATE_CONTACT"; kind: DuplicateKind; contactId?: number }

// Kept as the long-standing 409 code so existing clients (Grow form, Run Add Person,
// phone) keep recognising the duplicate answer.
export const DUPLICATE_CODE = "POTENTIAL_DUPLICATE_CONTACT";
export const OVERRIDE_REASON_REQUIRED = "DUPLICATE_OVERRIDE_REASON_REQUIRED";
export const OVERRIDE_NOT_AUTHORISED = "DUPLICATE_OVERRIDE_NOT_AUTHORISED";
export const OVERRIDE_REASON_MIN = 5;
export const OVERRIDE_REASON_MAX = 500;
/** Roles that may override (Pit Crew only while acting on an owner's authority). */
export const DUPLICATE_OVERRIDE_ROLES = ["Agent", "Brokerage Administrator"] as const;

const clean = (v: string | null | undefined) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").toLowerCase() : "");

/** Email, mobile (existing normalisation) and exact name (case/space-insensitive). */
export async function findContactDuplicates(brokerageId: number, q: DuplicateQuery, excludePartyId: number | null = null): Promise<DuplicateHit[]> {
  const hits: DuplicateHit[] = [];
  const seen = new Set<string>();
  const push = (kind: DuplicateKind, partyId: number) => {
    const k = `${kind}:${partyId}`;
    if (!seen.has(k)) {
      seen.add(k);
      hits.push({ kind, partyId });
    }
  };
  // findDuplicateContact returns a visible id whenever the contact is in this brokerage.
  if (q.email) {
    const e = await findDuplicateContact(brokerageId, "email", q.email, excludePartyId);
    if (e?.contactId) push("email", e.contactId);
  }
  if (q.mobile) {
    const m = await findDuplicateContact(brokerageId, "phone", q.mobile, excludePartyId);
    if (m?.contactId) push("phone", m.contactId);
  }
  const first = clean(q.firstName), last = clean(q.lastName), org = clean(q.organisationName);
  const nameCond =
    first && last
      ? sql`lower(regexp_replace(btrim(coalesce(${parties.firstName}, '')), '\\s+', ' ', 'g')) = ${first} and lower(regexp_replace(btrim(coalesce(${parties.lastName}, '')), '\\s+', ' ', 'g')) = ${last}`
      : !first && !last && org
        ? sql`lower(regexp_replace(btrim(coalesce(${parties.organisationName}, '')), '\\s+', ' ', 'g')) = ${org}`
        : null;
  if (nameCond) {
    const rows = await db
      .select({ id: parties.id, email: parties.email, mobile: parties.mobile })
      .from(parties)
      .where(and(eq(parties.brokerageId, brokerageId), nameCond, excludePartyId === null ? sql`true` : sql`${parties.id} <> ${excludePartyId}`))
      .orderBy(asc(parties.id))
      .limit(10);
    // t275u decision: a same-name record is the same person unless an email or mobile
    // on BOTH records proves otherwise (two different John Smiths with different emails
    // are not duplicates). Email/mobile matches above always count.
    const qEmail = clean(q.email), qPhone = q.mobile ? contactPhoneMatchKey(q.mobile) : null;
    for (const r of rows) {
      const rEmail = clean(r.email), rPhone = r.mobile ? contactPhoneMatchKey(r.mobile) : null;
      if (qEmail && rEmail && qEmail !== rEmail) continue;
      if (qPhone && rPhone && qPhone !== rPhone) continue;
      push("name", r.id);
      if (hits.filter((h) => h.kind === "name").length >= 3) break;
    }
  }
  return hits;
}

/** Masking: ids only with contact-read; Pit Crew only within its acting owner's contacts. */
export async function visibleDuplicates(req: Request, hits: DuplicateHit[]): Promise<VisibleDuplicate[]> {
  if (hits.length === 0) return [];
  const user = req.authedUser!;
  let allowed: (id: number) => boolean = () => false;
  if (isPitCrew(user)) {
    if (req.actingFor) {
      const ownerRead = await explainEntitlementDecision(req.actingFor.owner, "grow.contacts.read").then((d) => d.allowed).catch(() => false);
      if (ownerRead) {
        const owned = new Set(await ownedPartyIds(user.brokerageId, req.actingFor.owner.id));
        allowed = (id) => owned.has(id);
      }
    }
  } else {
    const canRead = await explainEntitlementDecision(user, "grow.contacts.read").then((d) => d.allowed).catch(() => false);
    if (canRead) allowed = () => true;
  }
  return hits.map((h) => (allowed(h.partyId) ? { code: DUPLICATE_CODE, kind: h.kind, contactId: h.partyId } : { code: DUPLICATE_CODE, kind: h.kind }));
}

export function readOverride(body: unknown): { requested: boolean; reason: string | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  const o = b.duplicateOverride;
  const legacy = b.confirmDuplicate === true || b.confirmNewContact === true;
  if (o && typeof o === "object" && !Array.isArray(o)) {
    const r = (o as Record<string, unknown>).reason;
    return { requested: true, reason: typeof r === "string" ? r.trim() : null };
  }
  return { requested: legacy, reason: null };
}

export type DuplicateGate =
  | { ok: true; overridden: false }
  | { ok: true; overridden: true; reason: string; hits: DuplicateHit[] }
  | { ok: false; status: 409 | 403 | 400; body: Record<string, unknown> };

/**
 * The single decision used by every creation path. Call BEFORE inserting.
 * When ok && overridden, call auditDuplicateOverride after the insert.
 */
export async function gateNewContact(req: Request, q: DuplicateQuery, path: string): Promise<DuplicateGate> {
  const user = req.authedUser!;
  const hits = await findContactDuplicates(user.brokerageId, q);
  if (hits.length === 0) return { ok: true, overridden: false };
  const visible = await visibleDuplicates(req, hits);
  const override = readOverride(req.body);
  const roleOk = (DUPLICATE_OVERRIDE_ROLES as readonly string[]).includes(user.role) || (isPitCrew(user) && !!req.actingFor);
  const firstVisible = visible.find((v) => v.contactId !== undefined);
  // Legacy fields (kind, contactId only when visible, canConfirm) kept for existing clients;
  // overriding now needs duplicateOverride.reason (reasonRequired).
  const base = {
    code: DUPLICATE_CODE,
    kind: visible[0]?.kind,
    ...(firstVisible ? { contactId: firstVisible.contactId } : {}),
    matches: visible,
    warnings: visible,
    path,
    canOverride: roleOk,
    canConfirm: roleOk,
    reasonRequired: true,
  };
  if (!override.requested) {
    const lead = hits[0].kind === "email" ? "A contact with this email already exists." : hits[0].kind === "phone" ? "A contact with this phone number already exists." : "A contact with this name already exists.";
    return { ok: false, status: 409, body: { error: `${lead} Use the existing contact, or override with a reason if this is a genuinely different person.`, ...base } };
  }
  if (!roleOk) return { ok: false, status: 403, body: { error: "You are not authorised to override a duplicate contact.", code: OVERRIDE_NOT_AUTHORISED } };
  if (!override.reason || override.reason.length < OVERRIDE_REASON_MIN || override.reason.length > OVERRIDE_REASON_MAX) {
    return { ok: false, status: 409, body: { error: `Creating a duplicate needs a reason (${OVERRIDE_REASON_MIN}-${OVERRIDE_REASON_MAX} characters).`, ...base, code: OVERRIDE_REASON_REQUIRED } };
  }
  return { ok: true, overridden: true, reason: override.reason, hits };
}

export async function auditDuplicateOverride(req: Request, gate: DuplicateGate, createdPartyId: number, path: string, propertyId?: number | null): Promise<void> {
  if (!gate.ok || !gate.overridden) return;
  const user = req.authedUser!;
  await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: "contact_duplicate_override",
    recordType: "party",
    recordId: String(createdPartyId),
    propertyId: propertyId ?? null,
    updatedValue: JSON.stringify({
      path,
      reason: gate.reason,
      matchedPartyIds: gate.hits.map((h) => h.partyId),
      matchedKinds: [...new Set(gate.hits.map((h) => h.kind))],
      requestedBy: { userId: req.actingFor?.owner.id ?? user.id },
      performedBy: { userId: user.id, role: user.role },
      authorityRef: req.actingFor?.authorityRef ?? null,
    }),
    providerReference: req.actingFor ? `owner:${req.actingFor.owner.id}` : undefined,
  });
}
