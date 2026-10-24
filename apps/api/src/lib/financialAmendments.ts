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
// Design check (t173u A): the schema has NO record of a specific grant from a
// specific listing agent or Brokerage Administrator to a specific Pit Crew
// member for a specific transaction/record and change. pc_fee_authorities is
// an agent's debit mandate to the platform; commission_agreements.approved_by
// is the Brokerage Administrator's own approval; vendor_approvals is a
// seller-side launch spend decision (Brokerage Administrator decides);
// documents hold files, not grants; audit_logs is an append-only trail with
// no grant, scope, expiry or revocation semantics. There is also no
// "brokerage owner" role (roles: Agent, Brokerage Administrator, Pit Crew;
// platform_owners is the platform operator, not a brokerage owner).
// So documented authority cannot be verified server-side without new schema,
// and Pit Crew amendments FAIL CLOSED (403). A client-sent authority flag or
// "authorised by" id is never read. The proposed grant table is in the PR.
//
// Who may amend today: the Brokerage Administrator and the property's
// listing agent, acting on their own authority (authoriser = performer).

import type { Response } from "express";
import { auditLogs, db, properties, type AgencyAgreementTerms } from "@aee/db";
import { and, eq } from "drizzle-orm";
import { logAudit, type AuditLogInput } from "./audit.js";
import { BROKERAGE_ADMIN_ROLES, PIT_CREW_ROLES, type AuthedUser } from "../middlewares/auth.js";
import { activePitCrewAssignmentsForProperty, type PitCrewTransactionAssignment } from "./transactionPriceAccess.js";

export const FINANCIAL_RECORD_AMENDED_AUDIT_ACTION = "financial_record_amended";
export const FINANCIAL_AMENDMENT_DENIED_AUDIT_ACTION = "financial_amendment_denied";
export const PROPERTY_FINANCIALS_VIEWED_AUDIT_ACTION = "property_financials_viewed";
export const AMENDMENT_AUTHORITY_REQUIRED = "FINANCIAL_AMENDMENT_AUTHORITY_REQUIRED";

export type AmendmentAuthorityBasis = "brokerage_admin" | "listing_agent";

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
  | { allowed: true; basis: AmendmentAuthorityBasis; authorisedByUserId: number; authorisedByRole: string }
  | { allowed: false };

/**
 * Server-side only. Brokerage Administrator or listing agent amend on their
 * own authority. Pit Crew: no verifiable documented-authority record exists
 * (see header), so always denied. Nothing from the request body is read.
 */
export function resolveAmendmentAuthority(user: AuthedUser, scope: PropertyFinancialScope): AmendmentAuthority {
  if (BROKERAGE_ADMIN_ROLES.includes(user.role)) {
    return { allowed: true, basis: "brokerage_admin", authorisedByUserId: user.id, authorisedByRole: user.role };
  }
  if (isListingAgent(user, scope)) {
    return { allowed: true, basis: "listing_agent", authorisedByUserId: user.id, authorisedByRole: user.role };
  }
  return { allowed: false };
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
    error: "Changing financial terms needs documented authority from the listing agent or a Brokerage Administrator.",
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

