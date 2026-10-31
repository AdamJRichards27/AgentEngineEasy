// Owner t225u (31 Oct 2026): a MANUAL listing launch (POST /properties/:id/launch) does NOT need an
// accepted AE proposal (listings may be won outside AE). It needs the property's agency agreement to
// be fully signed (AGENCY_AGREEMENT_SIGNED) and the compliance checks complete: at least one seller
// AML verification and every one of them "Complete". The automatic (system) activation path keeps
// the t223u rule: accepted proposal AND fully signed agreement.
import { and, eq } from "drizzle-orm";
import { db, amlVerifications, properties } from "@aee/db";
import { agencyAgreementFullySigned } from "../proposalAcceptance.js";

export type ManualLaunchBlocker = "AGENCY_AGREEMENT_NOT_SIGNED" | "AML_NOT_STARTED" | "AML_NOT_COMPLETE";

export async function manualLaunchBlockers(propertyId: number, brokerageId: number): Promise<ManualLaunchBlocker[]> {
  const blockers: ManualLaunchBlocker[] = [];
  if (!(await agencyAgreementFullySigned(propertyId, brokerageId))) blockers.push("AGENCY_AGREEMENT_NOT_SIGNED");
  const aml = await db.select({ status: amlVerifications.status }).from(amlVerifications)
    .innerJoin(properties, eq(properties.id, amlVerifications.propertyId))
    .where(and(eq(amlVerifications.propertyId, propertyId), eq(properties.brokerageId, brokerageId)));
  if (aml.length === 0) blockers.push("AML_NOT_STARTED");
  else if (aml.some((v) => v.status !== "Complete")) blockers.push("AML_NOT_COMPLETE");
  return blockers;
}
