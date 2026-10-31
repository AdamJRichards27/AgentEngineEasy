import type { NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, documentPackages, properties } from "@aee/db";
import { resolveEntitlements } from "./entitlements/resolver.js";
import { BROKERAGE_ADMIN_ROLES, type AuthedUser } from "../middlewares/auth.js";
import { propertyHiddenFromCaller } from "./propertyVisibility.js";

/**
 * PROPOSAL / AGENCY-AGREEMENT BOUNDARY (Owner t221u, 2026-10-31).
 *
 * A Grow proposal (appraisal) is not a legally binding agency agreement. Agency-agreement work
 * (terms, package creation via ready-to-list, template population, send for signature) is Run:
 * the routes already require run.access; this module adds the role rule on top.
 *
 * Write authority ("written authority" for the agreement): a Brokerage Administrator of the
 * property's brokerage, or the Agent who is the property's agent (properties.agent_id). Pit Crew
 * may read (whole-tenant visibility, lib/propertyVisibility.ts) but never creates, generates or
 * executes an agreement. Order of answers matches every other tenant check: missing, other
 * brokerage, or hidden from an own-property-scoped Agent => "not_found" (404, no existence leak);
 * visible but the role lacks authority => "forbidden" (403).
 */
export type AgreementAuthority = "ok" | "not_found" | "forbidden";

export async function agreementReadAuthority(user: AuthedUser, propertyId: number): Promise<AgreementAuthority> {
  const [p] = await db.select({ id: properties.id }).from(properties).where(and(eq(properties.id, propertyId), eq(properties.brokerageId, user.brokerageId)));
  if (!p) return "not_found";
  if (await propertyHiddenFromCaller(user, propertyId)) return "not_found";
  return "ok";
}

export async function agreementWriteAuthority(user: AuthedUser, propertyId: number): Promise<AgreementAuthority> {
  const [p] = await db
    .select({ id: properties.id, agentId: properties.agentId })
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.brokerageId, user.brokerageId)));
  if (!p) return "not_found";
  if (await propertyHiddenFromCaller(user, propertyId)) return "not_found";
  if (BROKERAGE_ADMIN_ROLES.includes(user.role)) return "ok";
  if (user.role === "Agent" && p.agentId === user.id) return "ok";
  return "forbidden";
}

/** The property a document package belongs to, inside the caller's brokerage; null when not found. */
export async function propertyIdForPackage(packageId: number, brokerageId: number): Promise<number | null> {
  const [pkg] = await db
    .select({ propertyId: documentPackages.propertyId })
    .from(documentPackages)
    .innerJoin(properties, eq(properties.id, documentPackages.propertyId))
    .where(and(eq(documentPackages.id, packageId), eq(properties.brokerageId, brokerageId)));
  return pkg?.propertyId ?? null;
}

/** Answers 404/403 itself and returns false when the caller may not proceed. */
export async function answerAgreementAuthority(res: Response, decision: AgreementAuthority): Promise<boolean> {
  if (decision === "not_found") {
    res.status(404).json({ error: "Not found" });
    return false;
  }
  if (decision === "forbidden") {
    res.status(403).json({
      error: "Only a Brokerage Administrator or the property's agent may prepare, generate or execute an agency agreement.",
      code: "AGENCY_AGREEMENT_ROLE_REQUIRED",
    });
    return false;
  }
  return true;
}

/** True when the caller's brokerage holds run.access (used to strip agreement data from shared reads). */
export async function callerHasRunAccess(user: AuthedUser): Promise<boolean> {
  return (await resolveEntitlements(user)).has("run.access");
}

/**
 * Agency-agreement fields. A proposal may carry a proposed fee (commissionRatePercent /
 * commissionProposal) and marketing recommendations, but never the agreement itself: its terms
 * (routes/documents.ts agencyTermsSchema), a package, signers or a signing instruction.
 */
export const AGENCY_AGREEMENT_FIELD_KEYS: readonly string[] = [
  "agencyAgreement",
  "agencyAgreementTerms",
  "agencyAgreementId",
  "agreementTerms",
  "agreement",
  "commissionType",
  "commissionRateBps",
  "flatFeeCents",
  "marketingFeeCents",
  "agreementTermDays",
  "documentPackage",
  "documentPackageId",
  "signers",
  "signatureRequest",
  "sendForSignature",
];

/** Rejects (400) a proposal write whose body carries any agency-agreement field. Nothing is written. */
export function rejectAgencyAgreementFields(req: Request, res: Response, next: NextFunction): void {
  const body = req.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const found = AGENCY_AGREEMENT_FIELD_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(body, k));
    if (found.length > 0) {
      res.status(400).json({
        error: "A proposal cannot include an agency agreement. Prepare the agency agreement separately in Run.",
        code: "AGENCY_AGREEMENT_NOT_IN_PROPOSAL",
        fields: found,
      });
      return;
    }
  }
  next();
}
