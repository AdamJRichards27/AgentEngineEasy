// Owner t173u — Pit Crew financial permissions (PR #271, CC #34).
//
//   VIEW: assigned authorised Pit Crew may view settlement financials (t172u).
//   AMEND: Pit Crew may amend financial terms, commission calculations,
//     marketing charges and transaction financial records ONLY with
//     documented authority from the listing agent or brokerage owner; every
//     amendment records who authorised it, who performed it, when, and the
//     before/after values.
//   PROHIBITED: bank/trust accounts; initiating, approving, executing or
//     releasing payments; transferring, withdrawing or disbursing funds;
//     independently authorising changes to commission, fees or obligations.
//
// Design check (t173u A) found no existing record of a specific grant, so
// Owner t174u APPROVED a narrowly scoped grant table (migration 0038,
// financial_amendment_authorities): transaction-specific, documented,
// limited to amendments that exist today (AGENCY_TERMS, CAMPAIGN_ITEM_COST),
// optionally narrowed to one record, revocable and expiring. Brokerage
// Administrator is the brokerage's authorised approval role (t174u; no
// "brokerage owner" role). A Pit Crew amendment is allowed ONLY with a live
// grant (unexpired, unrevoked) matching the property, scope and target AND an
// active Pit Crew assignment on the grant's transaction. The server looks the
// grant up; client-sent authority fields are never read. Grants never reach
// payment, debit, refund, release, disbursement or authority routes.
//
// The Brokerage Administrator and the property's listing agent amend on
// their own authority (authoriser = performer).

import type { Response } from "express";
import {
  auditLogs,
  db,
  financialAmendmentAuthorities,
  FINANCIAL_AMENDMENT_SCOPE_TARGET_TYPE,
  properties,
  type AgencyAgreementTerms,
  type FinancialAmendmentScope,
} from "@aee/db";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { logAudit, type AuditLogInput } from "./audit.js";
import { BROKERAGE_ADMIN_ROLES, PIT_CREW_ROLES, type AuthedUser } from "../middlewares/auth.js";
import {
  activePitCrewAssignmentsForProperty,
  activePitCrewAssignmentsForTransaction,
  type PitCrewTransactionAssignment,
} from "./transactionPriceAccess.js";

export const FINANCIAL_RECORD_AMENDED_AUDIT_ACTION = "financial_record_amended";
export const FINANCIAL_AMENDMENT_DENIED_AUDIT_ACTION = "financial_amendment_denied";
export const PROPERTY_FINANCIALS_VIEWED_AUDIT_ACTION = "property_financials_viewed";
export const AMENDMENT_AUTHORITY_REQUIRED = "FINANCIAL_AMENDMENT_AUTHORITY_REQUIRED";

export type AmendmentAuthorityBasis = "brokerage_admin" | "listing_agent";
export type AmendmentBasis = AmendmentAuthorityBasis | "documented_authority";

/**
 * Longest grant a grantor may issue, in days. Default 30 (Owner-confirmable
 * default, t174u); configurable with FINANCIAL_AMENDMENT_AUTHORITY_MAX_DAYS
 * (1–90).
 */
export function maxAuthorityGrantDays(): number {
  const n = Number(process.env.FINANCIAL_AMENDMENT_AUTHORITY_MAX_DAYS);
  return Number.isInteger(n) && n >= 1 && n <= 90 ? n : 30;
}

export interface PropertyFinancialScope {
  propertyId: number;
  brokerageId: number;
  listingAgentId: number | null;
}

/** Tenant check + listing agent. `null` = not in the caller's brokerage (callers answer 404). */
export async function loadPropertyFinancialScope(user: AuthedUser, propertyId: number): Promise<PropertyFinancialScope | null> {
  const [row] = await db
    .select({ agentId: properties.agentId })
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.brokerageId, user.brokerageId)));
  if (!row) return null;
  return { propertyId, brokerageId: user.brokerageId, listingAgentId: row.agentId ?? null };
}

export function isListingAgent(user: AuthedUser, scope: PropertyFinancialScope): boolean {
  return user.role === "Agent" && scope.listingAgentId != null && scope.listingAgentId === user.id;
}

/** An Agent who is not the listing agent: the own-property rule answers 404. */
export function hiddenAgent(user: AuthedUser, scope: PropertyFinancialScope): boolean {
  return user.role === "Agent" && !isListingAgent(user, scope);
}

export type PropertyFinancialView =
  | { visible: true; basis: AmendmentAuthorityBasis | "pit_crew_assignment"; assignments: PitCrewTransactionAssignment[] }
  | { visible: false };

/** t172u view rule at property level: admin, listing agent, Pit Crew assigned on the property. */
export async function resolvePropertyFinancialView(user: AuthedUser, scope: PropertyFinancialScope): Promise<PropertyFinancialView> {
  if (BROKERAGE_ADMIN_ROLES.includes(user.role)) return { visible: true, basis: "brokerage_admin", assignments: [] };
  if (isListingAgent(user, scope)) return { visible: true, basis: "listing_agent", assignments: [] };
  if (PIT_CREW_ROLES.includes(user.role)) {
    const assignments = await activePitCrewAssignmentsForProperty(user, scope.propertyId);
    if (assignments.length > 0) return { visible: true, basis: "pit_crew_assignment", assignments };
  }
  return { visible: false };
}

/**
 * Value-free, strict access log for a Pit Crew reveal of property-level
 * financials. Returns false if the log could not be written (caller withholds).
 */
export async function logPitCrewPropertyFinancialView(
  user: AuthedUser,
  scope: PropertyFinancialScope,
  view: PropertyFinancialView,
  recordType: string,
  fieldCategories: string[],
  surface: string,
): Promise<boolean> {
  if (!view.visible || view.basis !== "pit_crew_assignment") return true;
  try {
    await logAudit(
      {
        brokerageId: user.brokerageId,
        userId: user.id,
        action: PROPERTY_FINANCIALS_VIEWED_AUDIT_ACTION,
        recordType,
        recordId: String(scope.propertyId),
        propertyId: scope.propertyId,
        updatedValue: JSON.stringify({
          actorRole: user.role,
          basis: view.basis,
          pitCrewAssignmentIds: view.assignments.map((a) => a.assignmentId),
          exceptionCategories: [...new Set(view.assignments.map((a) => a.exceptionCategory))],
          fieldCategories,
          policy: "t172u",
          surface,
        }),
      },
      { strict: true },
    );
    return true;
  } catch {
    return false;
  }
}

export type AmendmentAuthority =
  | {
      allowed: true;
      basis: AmendmentBasis;
      authorisedByUserId: number;
      authorisedByRole: string;
      authorityId?: number;
      authorityTransactionId?: number;
      evidenceDocumentId?: number | null;
      evidenceNote?: string | null;
      pitCrewAssignmentIds?: number[];
    }
  | { allowed: false };

export interface AmendmentTarget {
  scope: FinancialAmendmentScope;
  /** The specific record being amended, when it already exists. */
  recordId: string | null;
}

/**
 * Server-side only; nothing from the request body is read.
 * - Brokerage Administrator / listing agent: own authority.
 * - Pit Crew: a live grant (unrevoked, unexpired) for this property and
 *   scope, untargeted or targeting this record, whose transaction this user
 *   holds an active Pit Crew assignment on. Oldest matching grant wins.
 * - Anyone else: denied.
 */
export async function resolveAmendmentAuthority(
  user: AuthedUser,
  scope: PropertyFinancialScope,
  target: AmendmentTarget,
): Promise<AmendmentAuthority> {
  if (BROKERAGE_ADMIN_ROLES.includes(user.role)) {
    return { allowed: true, basis: "brokerage_admin", authorisedByUserId: user.id, authorisedByRole: user.role };
  }
  if (isListingAgent(user, scope)) {
    return { allowed: true, basis: "listing_agent", authorisedByUserId: user.id, authorisedByRole: user.role };
  }
  if (!PIT_CREW_ROLES.includes(user.role)) return { allowed: false };
  const targetType = FINANCIAL_AMENDMENT_SCOPE_TARGET_TYPE[target.scope];
  const grants = await db
    .select()
    .from(financialAmendmentAuthorities)
    .where(
      and(
        eq(financialAmendmentAuthorities.brokerageId, user.brokerageId),
        eq(financialAmendmentAuthorities.propertyId, scope.propertyId),
        eq(financialAmendmentAuthorities.granteeUserId, user.id),
        eq(financialAmendmentAuthorities.scope, target.scope),
        isNull(financialAmendmentAuthorities.revokedAt),
        gt(financialAmendmentAuthorities.expiresAt, sql`now()`),
        target.recordId === null
          ? isNull(financialAmendmentAuthorities.targetRecordId)
          : or(
              isNull(financialAmendmentAuthorities.targetRecordId),
              and(eq(financialAmendmentAuthorities.targetRecordType, targetType), eq(financialAmendmentAuthorities.targetRecordId, target.recordId)),
            ),
      ),
    )
    .orderBy(financialAmendmentAuthorities.id);
  for (const grant of grants) {
    const assignments = await activePitCrewAssignmentsForTransaction(user, { id: grant.transactionId, propertyId: grant.propertyId });
    if (assignments.length === 0) continue;
    return {
      allowed: true,
      basis: "documented_authority",
      authorisedByUserId: grant.grantedByUserId,
      authorisedByRole: grant.grantedByRole,
      authorityId: grant.id,
      authorityTransactionId: grant.transactionId,
      evidenceDocumentId: grant.evidenceDocumentId,
      evidenceNote: grant.evidenceNote,
      pitCrewAssignmentIds: assignments.map((a) => a.assignmentId),
    };
  }
  return { allowed: false };
}

/**
 * Inside the amendment's DB transaction: lock the grant row and confirm it is
 * still live, so a concurrent revoke or an expiry between the check and the
 * write rolls the amendment back (fail closed). No-op for own-authority.
 */
export async function lockLiveAuthority(
  tx: { execute: typeof db.execute },
  authority: Extract<AmendmentAuthority, { allowed: true }>,
): Promise<void> {
  if (authority.authorityId === undefined) return;
  const res = await tx.execute(
    sql`select id from financial_amendment_authorities where id = ${authority.authorityId} and revoked_at is null and expires_at > now() for update`,
  );
  if (res.rows.length !== 1) throw new Error("financial amendment authority is no longer live");
}

/** 403 with a stable reason, plus a best-effort, value-free denial row. */
export async function denyFinancialAmendment(
  res: Response,
  user: AuthedUser,
  scope: PropertyFinancialScope,
  recordType: string,
  recordId: string,
  surface: string,
): Promise<void> {
  await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: FINANCIAL_AMENDMENT_DENIED_AUDIT_ACTION,
    recordType,
    recordId,
    propertyId: scope.propertyId,
    updatedValue: JSON.stringify({ actorRole: user.role, reason: AMENDMENT_AUTHORITY_REQUIRED, policy: "t173u", surface }),
  });
  res.status(403).json({
    error: "Changing financial terms needs a live documented authority from the listing agent or a Brokerage Administrator, and an active assignment on that transaction.",
    reason: AMENDMENT_AUTHORITY_REQUIRED,
  });
}

/**
 * The amendment audit row (Owner t173u E): authoriser, performer, timestamp
 * and before/after values. Values ARE recorded here by Owner direction
 * (unlike view logs). The action is not a Property Timeline entry type, so
 * the values never surface on the timeline.
 */
export function amendmentAuditInput(args: {
  user: AuthedUser;
  authority: Extract<AmendmentAuthority, { allowed: true }>;
  scope: PropertyFinancialScope;
  recordType: string;
  recordId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  surface: string;
}): AuditLogInput {
  return {
    brokerageId: args.user.brokerageId,
    userId: args.user.id,
    action: FINANCIAL_RECORD_AMENDED_AUDIT_ACTION,
    recordType: args.recordType,
    recordId: args.recordId,
    propertyId: args.scope.propertyId,
    previousValue: JSON.stringify(args.before),
    updatedValue: JSON.stringify({
      after: args.after,
      authorisedByUserId: args.authority.authorisedByUserId,
      authorisedByRole: args.authority.authorisedByRole,
      authorityBasis: args.authority.basis,
      authorityId: args.authority.authorityId ?? null,
      authorityTransactionId: args.authority.authorityTransactionId ?? null,
      evidenceDocumentId: args.authority.evidenceDocumentId ?? null,
      evidenceNote: args.authority.evidenceNote ?? null,
      pitCrewAssignmentIds: args.authority.pitCrewAssignmentIds ?? [],
      performedByUserId: args.user.id,
      performedByRole: args.user.role,
      performedAt: new Date().toISOString(),
      policy: "t173u",
      surface: args.surface,
    }),
  };
}

/** A transaction-owned audit writer: the amendment and its audit row commit or roll back together. */
export function auditWriterFor(tx: { insert: typeof db.insert }): (input: AuditLogInput) => Promise<void> {
  return async (input) => {
    await tx.insert(auditLogs).values(input);
  };
}

/** Financial keys withheld from callers outside the t172u view rule. */
export const AGENCY_TERMS_FINANCIAL_KEYS = ["commissionRateBps", "flatFeeCents", "marketingFeeCents"] as const;

/**
 * Owner t172u/t173u read rule for agency-agreement terms: listing agent,
 * Brokerage Administrator, and Pit Crew with an active assignment on the
 * property see the figures (a Pit Crew reveal is logged, value-free, strict).
 * Anyone else who can see the property gets the row with the figures
 * OMITTED and `termsVisible: false`, so "terms captured" stays visible.
 */
export async function agencyTermsViewFor(
  user: AuthedUser,
  scope: PropertyFinancialScope,
  terms: AgencyAgreementTerms | null,
  surface: string,
): Promise<(Partial<AgencyAgreementTerms> & { termsVisible: boolean }) | null> {
  if (!terms) return null;
  const view = await resolvePropertyFinancialView(user, scope);
  const logged = view.visible && (await logPitCrewPropertyFinancialView(user, scope, view, "agency_agreement_terms", ["agencyAgreementFees"], surface));
  if (view.visible && logged) return { ...terms, termsVisible: true };
  const out: Record<string, unknown> = { ...terms };
  for (const k of AGENCY_TERMS_FINANCIAL_KEYS) delete out[k];
  out.termsVisible = false;
  return out as Partial<AgencyAgreementTerms> & { termsVisible: boolean };
}

